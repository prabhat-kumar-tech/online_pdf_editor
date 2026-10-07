/**
 * pdf-export-tools.js — turn the open document into other formats:
 *   PDF -> images (PNG / JPG, one file per page, optional .zip)
 *   PDF -> plain text (shown in a box, copy or download)
 * Both work on the *current* document including edits, so what you see is what you export.
 */
"use strict";

const PDFExportTools = {
    init() {
        UI.register({
            "toimg-run": () => this.exportImages(),
            "totext-run": () => this.extractText(),
            "totext-copy": () => this.copyText(),
            "totext-download": () => this.downloadText()
        });
        Events.on("tool:shown", ({ tool }) => {
            const doc = PDFEditor.doc;
            if (!doc || (tool !== "toimg" && tool !== "totext")) return;
            const n = doc.pages.length;
            document.getElementById(tool === "toimg" ? "toimg-info" : "totext-info").textContent = `${doc.name} · ${n} page${n === 1 ? "" : "s"}`;
            if (tool === "totext") { document.getElementById("tt-output").value = ""; this._toggleTextButtons(false); }
        });
    },

    _indexes(inputId) {
        const doc = PDFEditor.doc, text = document.getElementById(inputId).value.trim();
        return text ? Utils.parseRanges(text, doc.pages.length) : doc.pages.map((_, i) => i);
    },

    /** Build the current document (with edits) and open it with PDF.js. Caller must destroy() the result. */
    async _renderable(ids, update) {
        PDFTextEditor.finishEditing();
        const { bytes } = await PDFTools.buildPdf(PDFEditor.doc, { pageIds: ids, onProgress: (f, t) => update?.(f * 0.3, t) });
        return PDFTools.openPdfJs(bytes);
    },

    /* ------------------------------------------------------------ PDF -> images */
    async exportImages() {
        const doc = PDFEditor.doc;
        if (!doc) return;
        let indexes;
        try { indexes = this._indexes("toimg-pages"); } catch (err) { Toast.error(err.message); return; }
        const fmt = document.getElementById("toimg-format").value;           // png | jpeg
        const dpi = Number(document.getElementById("toimg-dpi").value);
        const ext = fmt === "png" ? "png" : "jpg";
        const base = Utils.baseName(doc.name);

        try {
            const files = await UI.withProgress("Rendering pages…", async update => {
                const pdf = await this._renderable(indexes.map(i => doc.pages[i].id), update);
                const out = [];
                try {
                    for (let n = 1; n <= pdf.numPages; n++) {
                        const page = await pdf.getPage(n);
                        const base1 = page.getViewport({ scale: 1 });
                        let scale = dpi / 72;
                        if (base1.width * base1.height * scale * scale > Utils.maxCanvasPixels()) {
                            scale = Math.sqrt(Utils.maxCanvasPixels() / (base1.width * base1.height));
                        }
                        const vp = page.getViewport({ scale });
                        const canvas = document.createElement("canvas");
                        canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
                        const ctx = canvas.getContext("2d");
                        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
                        await page.render({ canvasContext: ctx, viewport: vp }).promise;
                        const blob = await new Promise(r => canvas.toBlob(r, `image/${fmt}`, 0.92));
                        canvas.width = canvas.height = 0;
                        if (!blob) throw new AppError("Not enough memory", "A page was too large to render. Choose a lower resolution.");
                        out.push({ name: `${base}_page_${indexes[n - 1] + 1}.${ext}`, bytes: new Uint8Array(await blob.arrayBuffer()), blob });
                        page.cleanup();
                        update(0.3 + 0.7 * n / pdf.numPages, `Page ${n} of ${pdf.numPages}`);
                    }
                } finally { pdf.destroy(); }
                return out;
            }, { determinate: true });

            if (files.length === 1) {
                await FileManager.saveBlobAs(files[0].blob, files[0].name, { title: "Save image", ext });
            } else if (typeof JSZip !== "undefined") {
                const zip = await UI.withProgress("Creating .zip…", () => PDFTools.zip(files));
                await FileManager.saveBlobAs(zip, `${base}_images.zip`, { title: "Save images", ext: "zip" });
            } else {
                Toast.info("Downloading images one by one. Your browser may ask to allow multiple downloads.");
                for (const f of files) { FileManager.downloadBlob(f.blob, f.name); await Utils.sleep(350); }
            }
            Toast.success(`Exported ${files.length} image${files.length === 1 ? "" : "s"}.`);
        } catch (err) {
            UI.showError(err);
        }
    },

    /* ------------------------------------------------------------ PDF -> text */
    _text: "",

    async extractText() {
        const doc = PDFEditor.doc;
        if (!doc) return;
        try {
            const result = await UI.withProgress("Extracting text…", async update => {
                const pdf = await this._renderable(doc.pages.map(p => p.id), update);
                const parts = [];
                let chars = 0;
                try {
                    for (let n = 1; n <= pdf.numPages; n++) {
                        const page = await pdf.getPage(n);
                        const content = await page.getTextContent();
                        const lines = [];
                        let line = "", lastY = null;
                        for (const item of content.items) {
                            const y = item.transform[5];
                            if (lastY !== null && Math.abs(y - lastY) > 2) { lines.push(line); line = ""; }
                            line += item.str; lastY = y;
                            if (item.hasEOL) { lines.push(line); line = ""; lastY = null; }
                        }
                        if (line) lines.push(line);
                        const text = lines.map(l => l.replace(/\s+$/, "")).join("\n").trim();
                        chars += text.length;
                        parts.push(`--- Page ${n} ---\n${text}`);
                        page.cleanup();
                        update(0.3 + 0.7 * n / pdf.numPages, `Page ${n} of ${pdf.numPages}`);
                    }
                } finally { pdf.destroy(); }
                return { text: parts.join("\n\n"), chars };
            }, { determinate: true });

            this._text = result.text;
            const box = document.getElementById("tt-output");
            const info = document.getElementById("totext-info");
            if (!result.chars) {
                box.value = "";
                info.textContent = "No selectable text found. This PDF looks scanned or image-only; there is no OCR in this app.";
                this._toggleTextButtons(false);
                Toast.warning("No text found in this document.");
            } else {
                box.value = result.text;
                info.textContent = `${result.chars.toLocaleString()} characters from ${doc.pages.length} page${doc.pages.length === 1 ? "" : "s"}.`;
                this._toggleTextButtons(true);
            }
        } catch (err) {
            UI.showError(err);
        }
    },

    _toggleTextButtons(on) {
        document.querySelectorAll('[data-action="totext-copy"],[data-action="totext-download"]').forEach(b => { b.disabled = !on; });
    },

    async copyText() {
        const box = document.getElementById("tt-output");
        if (!box.value) return;
        try {
            await navigator.clipboard.writeText(box.value);
        } catch (_) {                       // clipboard API unavailable (e.g. insecure context)
            box.select();
            document.execCommand("copy");
        }
        Toast.success("Text copied to the clipboard.");
    },

    downloadText() {
        const text = document.getElementById("tt-output").value;
        if (!text) return;
        FileManager.saveBlobAs(new Blob([text], { type: "text/plain;charset=utf-8" }), `${Utils.baseName(PDFEditor.doc.name)}.txt`, { title: "Download text", ext: "txt" });
    },

    reset() { this._text = ""; },
    cleanup() { this._text = ""; },
    destroy() { this.reset(); }
};
