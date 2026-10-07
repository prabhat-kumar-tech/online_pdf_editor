/**
 * pdf-merge.js — merge several PDFs into one (pdf-lib).
 *
 * Public API:  PDFMerge.addFiles(files) · removeFile(index) · moveFile(from, to) · merge()
 * Files are kept as File handles and only read again at merge time, so large PDFs
 * are not held in memory while the user arranges them.
 */
"use strict";

const PDFMerge = {
    items: [],      // { id, file, pages, thumb:HTMLCanvasElement|null }
    _result: null,  // { bytes:Uint8Array, name }
    _dragFrom: -1,

    init() {
        UI.bindDropzone(document.getElementById("dz-merge"), {
            kinds: ["pdf"], multiple: true, onFiles: files => this.addFiles(files)
        });
        UI.register({
            "merge-add": async () => {
                const files = await FileManager.pickFiles({ kinds: ["pdf"], multiple: true });
                if (files.length) this.addFiles(files);
            },
            "merge-clear": () => this.reset(),
            "merge-run": () => this.merge(),
            "merge-open": () => this._open(),
            "merge-download": () => this._download(),
            "merge-reset": () => this.reset()
        });
    },

    async addFiles(files) {
        const accepted = FileManager.filter(files, ["pdf"], { alreadyHave: this.items.length });
        if (!accepted.length) return;
        this._result = null;
        for (const file of accepted) {
            try {
                const loaded = await this._load(file);
                if (!loaded) continue;                               // password prompt cancelled
                const item = { id: Utils.uid("m"), file, pages: loaded.pdf.numPages, thumb: null, bytes: loaded.bytes };
                this.items.push(item);
                this.render();
                // The preview is cosmetic: render it in the background so reading never waits on painting.
                this._thumb(loaded.pdf).then(canvas => { item.thumb = canvas; this.render(); }).finally(() => loaded.pdf.destroy());
            } catch (err) {
                const info = Utils.describeError(err);
                Toast.error(`“${file.name}”: ${err instanceof AppError ? err.message : info.message}`);
            }
        }
        this.render();
    },

    /** Open one file with PDF.js, asking for a password when needed. `bytes` is set only for unlocked (decrypted) copies. */
    async _load(file) {
        let bytes = await FileManager.readBytes(file), unlocked = false;
        for (;;) {
            const r = await UI.withProgress("Reading PDF…", async () => {
                try { return { pdf: await PDFTools.openPdfJs(bytes) }; }
                catch (err) { if (PDFSecurity.isPasswordError(err)) return { locked: true }; throw err; }
            });
            if (r.locked) {
                const out = await PDFSecurity.unlockWithPrompt(bytes, file.name);
                if (!out) return null;
                bytes = out; unlocked = true;
                continue;
            }
            return { pdf: r.pdf, bytes: unlocked ? bytes : null };
        }
    },

    async _thumb(pdf) {
        try {
            const page = await pdf.getPage(1);
            const base = page.getViewport({ scale: 1 });
            const scale = 96 * Math.min(window.devicePixelRatio || 1, 2) / base.width;
            const vp = page.getViewport({ scale });
            const canvas = document.createElement("canvas");
            canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
            await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
            page.cleanup();
            return canvas;
        } catch (_) { return null; }
    },

    removeFile(index) {
        const [item] = this.items.splice(index, 1);
        if (item?.thumb) item.thumb.width = 0;
        this.render();
    },

    moveFile(from, to) {
        if (from === to || to < 0 || to >= this.items.length || from < 0) return;
        const [item] = this.items.splice(from, 1);
        this.items.splice(to, 0, item);
        this.render();
    },

    render() {
        const hasItems = this.items.length > 0;
        document.getElementById("merge-panel").hidden = !hasItems;
        document.getElementById("dz-merge").hidden = hasItems || !!this._result;
        document.getElementById("merge-result").hidden = !this._result;
        if (this._result) document.getElementById("merge-panel").hidden = true;

        const list = document.getElementById("merge-list");
        list.replaceChildren(...this.items.map((item, i) => this._card(item, i)));

        const pages = this.items.reduce((s, it) => s + it.pages, 0);
        const size = this.items.reduce((s, it) => s + it.file.size, 0);
        document.getElementById("merge-summary").textContent = hasItems
            ? `${this.items.length} file${this.items.length === 1 ? "" : "s"} · ${pages} pages · ${Utils.formatBytes(size)}`
            : "";
        document.getElementById("btn-merge-run").disabled = this.items.length < 2;
        document.getElementById("btn-merge-run").title = this.items.length < 2 ? "Add at least two PDFs" : "";
    },

    _card(item, i) {
        const btn = (icon, label, fn, disabled) => Utils.h("button", {
            type: "button", class: "btn btn-sm", disabled, "aria-label": `${label}: ${item.file.name}`, onclick: fn
        }, Utils.icon(icon), Utils.h("span", { text: label }));
        const li = Utils.h("li", { class: "file-card", draggable: "true" },
            Utils.h("span", { class: "grip", "aria-hidden": "true" }, Utils.icon("grip")),
            Utils.h("div", { class: "file-thumb" }, item.thumb || Utils.icon("file")),
            Utils.h("div", { class: "file-info" },
                Utils.h("strong", { class: "file-name", text: item.file.name, title: item.file.name }),
                Utils.h("span", { class: "muted", text: `${item.pages} page${item.pages === 1 ? "" : "s"} · ${Utils.formatBytes(item.file.size)} · PDF` }),
                Utils.h("span", { class: "file-status ok" }, Utils.icon("check"), "Ready")),
            Utils.h("div", { class: "file-actions" },
                btn("chev-up", "Move up", () => this.moveFile(i, i - 1), i === 0),
                btn("chev-down", "Move down", () => this.moveFile(i, i + 1), i === this.items.length - 1),
                btn("trash", "Remove", () => this.removeFile(i)))
        );
        li.addEventListener("dragstart", e => { this._dragFrom = i; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(i)); li.classList.add("dragging"); });
        li.addEventListener("dragover", e => { if (this._dragFrom >= 0) { e.preventDefault(); li.classList.add("drop-target"); } });
        li.addEventListener("dragleave", () => li.classList.remove("drop-target"));
        li.addEventListener("dragend", () => { this._dragFrom = -1; li.classList.remove("dragging"); });
        li.addEventListener("drop", e => {
            e.preventDefault();
            const from = this._dragFrom;
            this._dragFrom = -1;
            if (from >= 0) this.moveFile(from, i);
        });
        return li;
    },

    async merge() {
        if (this.items.length < 2) { Toast.warning("Add at least two PDF files to merge."); return; }
        let name = Utils.sanitizeFilename(document.getElementById("merge-filename").value) || "merged.pdf";
        if (!name.toLowerCase().endsWith(".pdf")) name += ".pdf";
        try {
            const bytes = await UI.withProgress("Merging PDFs…", update =>
                PDFTools.merge(this.items.map(it => () => it.bytes ? Promise.resolve(it.bytes) : FileManager.readBytes(it.file)), update), { determinate: true });
            this._result = { bytes, name };
            const pages = this.items.reduce((s, it) => s + it.pages, 0);
            document.getElementById("merge-result-info").textContent =
                `${name} · ${pages} pages · ${Utils.formatBytes(bytes.length)}`;
            this.render();
            Toast.success("PDFs merged.");
        } catch (err) {
            UI.showError(err, { actionLabel: "Try Another File", onAction: () => UI.run("merge-add") });
        }
    },

    async _open() {
        if (!this._result) return;
        const { bytes, name } = this._result;
        if (await PDFEditor.openBytes(bytes.slice(), name)) App.openTool("viewer");
    },

    _download() {
        if (!this._result) return;
        FileManager.saveBlobAs(new Blob([this._result.bytes], { type: "application/pdf" }), this._result.name, { title: "Download merged PDF" });
    },

    reset() {
        this.items.forEach(it => { if (it.thumb) it.thumb.width = 0; });
        this.items = [];
        this._result = null;
        document.getElementById("merge-filename").value = "merged.pdf";
        this.render();
    },
    cleanup() { this._result = null; },
    destroy() { this.reset(); }
};
