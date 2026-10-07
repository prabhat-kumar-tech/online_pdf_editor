/**
 * image-to-pdf.js — turn JPG / PNG / WEBP images into a PDF, entirely in the browser.
 *
 * Public API:  ImageToPDF.addImages(files) · reorder(from, to) · generate(options)
 *
 * Embedding strategy (keeps files small and quality high):
 *  - Untouched JPEG / PNG at "High" quality are embedded byte-for-byte (lossless pass-through).
 *  - Anything that needs pixels changed (rotation, crop for Fill/Original, WEBP, lower quality,
 *    EXIF-rotated photos) is redrawn on a canvas first. Images with alpha stay PNG so
 *    transparency survives; others become JPEG.
 */
"use strict";

const ImageToPDF = {
    items: [],          // { id, file, url, w, h, rotation, alpha }
    _result: null,      // { bytes, name }
    _dragFrom: -1,

    PAGE_SIZES: { A4: [595.28, 841.89], A3: [841.89, 1190.55], Letter: [612, 792], Legal: [612, 1008] },
    MAX_SIDE: { low: 1600, medium: 2800, high: Infinity },
    JPEG_QUALITY: { low: 0.6, medium: 0.78, high: 0.92 },

    init() {
        UI.bindDropzone(document.getElementById("dz-images"), {
            kinds: ["image"], multiple: true, onFiles: files => this.addImages(files)
        });
        UI.register({
            "img-add": async () => {
                const files = await FileManager.pickFiles({ kinds: ["image"], multiple: true });
                if (files.length) this.addImages(files);
            },
            "img-clear": () => this.reset(),
            "img-run": () => this.generate(),
            "img-preview": () => this._preview(),
            "img-download": () => this._download(),
            "img-reset": () => this.reset()
        });
        const byId = id => document.getElementById(id);
        const syncFields = () => {
            byId("field-custom-size").hidden = byId("opt-pagesize").value !== "Custom";
            byId("field-custom-margin").hidden = byId("opt-margin").value !== "custom";
            byId("opt-orientation").disabled = byId("opt-pagesize").value === "Original";
        };
        ["opt-pagesize", "opt-margin"].forEach(id => byId(id).addEventListener("change", syncFields));
        byId("img-form").addEventListener("submit", e => e.preventDefault());
        byId("opt-pagesize").value = APP_CONFIG.defaultPageSize;
        syncFields();
    },

    /* ------------------------------------------------------------ list management */
    async addImages(files) {
        const accepted = FileManager.filter(files, ["image"], { alreadyHave: this.items.length });
        if (!accepted.length) return;
        this._result = null;
        await UI.withProgress("Loading images…", async update => {
            let done = 0;
            for (const file of accepted) {
                const url = FileManager.createUrl(file, "images");
                try {
                    const img = await this._decode(url);
                    this.items.push({
                        id: Utils.uid("img"), file, url, w: img.naturalWidth, h: img.naturalHeight,
                        rotation: 0, alpha: file.type !== "image/jpeg"
                    });
                } catch (err) {
                    FileManager.revokeUrl(url);
                    Toast.error(`“${file.name}” could not be decoded. The image may be corrupted or unsupported.`);
                }
                update(++done / accepted.length, `Image ${done} of ${accepted.length}`);
            }
        }, { determinate: true });
        this.render();
    },

    _decode(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => (img.naturalWidth ? resolve(img) : reject(new Error("empty image")));
            img.onerror = () => reject(new Error("decode failed"));
            img.src = url;
        });
    },

    removeImage(index) {
        const [item] = this.items.splice(index, 1);
        if (item) FileManager.revokeUrl(item.url);
        this.render();
    },

    rotateImage(index) {
        const item = this.items[index];
        if (!item) return;
        item.rotation = (item.rotation + 90) % 360;
        this.render();
    },

    reorder(from, to) {
        if (from === to || from < 0 || to < 0 || from >= this.items.length || to >= this.items.length) return;
        const [item] = this.items.splice(from, 1);
        this.items.splice(to, 0, item);
        this.render();
    },

    render() {
        const has = this.items.length > 0;
        document.getElementById("dz-images").hidden = has || !!this._result;
        document.getElementById("img-panel").hidden = !has || !!this._result;
        document.getElementById("img-result").hidden = !this._result;
        document.getElementById("img-grid").replaceChildren(...this.items.map((it, i) => this._card(it, i)));
        const size = this.items.reduce((s, it) => s + it.file.size, 0);
        document.getElementById("img-summary").textContent = has
            ? `${this.items.length} image${this.items.length === 1 ? "" : "s"} · ${Utils.formatBytes(size)} · ${this.items.length} page${this.items.length === 1 ? "" : "s"}`
            : "";
    },

    _card(item, i) {
        const btn = (icon, label, fn, disabled = false) => Utils.h("button", {
            type: "button", class: "icon-btn icon-btn-sm", "data-tip": label, disabled,
            "aria-label": `${label}: ${item.file.name}`, draggable: "false", onclick: fn
        }, Utils.icon(icon));
        const li = Utils.h("li", { class: "img-card", draggable: "true", "aria-label": `Image ${i + 1}: ${item.file.name}` },
            Utils.h("div", { class: "img-thumb" },
                Utils.h("img", { src: item.url, alt: item.file.name, draggable: "false", style: { transform: `rotate(${item.rotation}deg)` } }),
                Utils.h("span", { class: "img-index", text: String(i + 1) })),
            Utils.h("div", { class: "img-name", text: item.file.name, title: item.file.name }),
            Utils.h("div", { class: "img-actions" },
                btn("chev-left", "Move earlier", () => this.reorder(i, i - 1), i === 0),
                btn("chev-right", "Move later", () => this.reorder(i, i + 1), i === this.items.length - 1),
                btn("rotate-cw", "Rotate clockwise", () => this.rotateImage(i)),
                btn("eye", "Preview", () => this._previewOne(item)),
                btn("trash", "Remove", () => this.removeImage(i)))
        );
        li.addEventListener("dragstart", e => { this._dragFrom = i; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(i)); li.classList.add("dragging"); });
        li.addEventListener("dragover", e => { if (this._dragFrom >= 0) { e.preventDefault(); li.classList.add("drop-target"); } });
        li.addEventListener("dragleave", () => li.classList.remove("drop-target"));
        li.addEventListener("dragend", () => { this._dragFrom = -1; li.classList.remove("dragging"); });
        li.addEventListener("drop", e => {
            e.preventDefault();
            const from = this._dragFrom;
            this._dragFrom = -1;
            if (from >= 0) this.reorder(from, i);
        });
        return li;
    },

    _previewOne(item) {
        Modal.open({
            title: item.file.name, size: "lg",
            content: Utils.h("div", { class: "preview-box" },
                Utils.h("img", { src: item.url, alt: item.file.name, style: { transform: `rotate(${item.rotation}deg)` } })),
        });
    },

    /* ------------------------------------------------------------ generation */
    readOptions() {
        const v = id => document.getElementById(id).value;
        return {
            pageSize: v("opt-pagesize"), customW: Number(v("opt-custom-w")), customH: Number(v("opt-custom-h")),
            orientation: v("opt-orientation"), fit: v("opt-fit"), margin: v("opt-margin"),
            marginCustom: Number(v("opt-margin-custom")), quality: v("opt-quality"), background: v("opt-bg")
        };
    },

    _marginPt(o) {
        const mm = 72 / 25.4;
        switch (o.margin) {
            case "none": return 0;
            case "small": return 10;
            case "large": return 40;
            case "custom": return Utils.clamp(o.marginCustom || 0, 0, 100) * mm;
            default: return APP_CONFIG.defaultMargin;
        }
    },

    async generate(options = this.readOptions()) {
        if (!this.items.length) { Toast.warning("Add at least one image first."); return; }
        if (options.pageSize === "Custom" && !(options.customW >= 20 && options.customH >= 20)) {
            Toast.error("Enter a custom page size of at least 20 × 20 mm."); return;
        }
        try {
            const bytes = await UI.withProgress("Creating PDF…", async update => {
                const out = await PDFLib.PDFDocument.create();
                for (let i = 0; i < this.items.length; i++) {
                    await this._addPage(out, this.items[i], options);
                    update((i + 1) / this.items.length, `Image ${i + 1} of ${this.items.length}`);
                    await Utils.sleep(0); // let the progress bar paint
                }
                out.setProducer(APP_CONFIG.appName);
                return out.save({ useObjectStreams: APP_CONFIG.enableCompression });
            }, { determinate: true });
            this._result = { bytes, name: "images.pdf" };
            document.getElementById("img-result-info").textContent =
                `${this.items.length} page${this.items.length === 1 ? "" : "s"} · ${Utils.formatBytes(bytes.length)}`;
            this.render();
            Toast.success("PDF created.");
            return bytes;
        } catch (err) {
            UI.showError(err.userFacing || err instanceof AppError ? err : new AppError(
                "Unable to create PDF", "One of the images could not be converted. Try removing it, or choose a lower quality."), {});
            Logger.error("Image to PDF failed", err);
        }
    },

    async _addPage(out, item, o) {
        const rot = item.rotation;
        const swap = rot % 180 !== 0;
        const effW = swap ? item.h : item.w, effH = swap ? item.w : item.h;   // size after user rotation (image px)
        const ptPerPx = 72 / APP_CONFIG.imageDpi;
        const m = this._marginPt(o);

        // --- page size in points
        let pw, ph;
        if (o.pageSize === "Original") {
            pw = effW * ptPerPx + 2 * m; ph = effH * ptPerPx + 2 * m;
        } else {
            [pw, ph] = o.pageSize === "Custom" ? [o.customW * 72 / 25.4, o.customH * 72 / 25.4] : this.PAGE_SIZES[o.pageSize];
            const landscape = o.orientation === "landscape" || (o.orientation === "auto" && effW > effH);
            if (landscape !== pw > ph) [pw, ph] = [ph, pw];
        }
        const aw = Math.max(1, pw - 2 * m), ah = Math.max(1, ph - 2 * m);

        // --- scale (pt per image px) and visible region
        const s = o.fit === "fill" ? Math.max(aw / effW, ah / effH)
            : o.fit === "original" ? ptPerPx
            : Math.min(aw / effW, ah / effH);
        const drawW = Math.min(effW * s, aw), drawH = Math.min(effH * s, ah);
        const vw = drawW / s, vh = drawH / s;                // image px that remain visible
        const sx = (effW - vw) / 2, sy = (effH - vh) / 2;    // centred crop
        const cropped = vw < effW - 0.5 || vh < effH - 0.5;

        const exifFix = await this._needsExifFix(item.file);
        const direct = !rot && !cropped && !exifFix && o.quality === "high"
            && (item.file.type === "image/jpeg" || item.file.type === "image/png");

        let embedded;
        if (direct) {
            const bytes = await FileManager.readBytes(item.file);
            embedded = item.file.type === "image/png" ? await out.embedPng(bytes) : await out.embedJpg(bytes);
        } else {
            embedded = await this._embedViaCanvas(out, item, { effW, effH, sx, sy, vw, vh, quality: o.quality });
        }

        const page = out.addPage([pw, ph]);
        if (o.background === "white") {
            page.drawRectangle({ x: 0, y: 0, width: pw, height: ph, color: PDFLib.rgb(1, 1, 1) });
        }
        page.drawImage(embedded, { x: m + (aw - drawW) / 2, y: ph - m - (ah - drawH) / 2 - drawH, width: drawW, height: drawH });
    },

    async _embedViaCanvas(out, item, { effW, effH, sx, sy, vw, vh, quality }) {
        const img = await this._decode(item.url);
        const maxSide = this.MAX_SIDE[quality];
        let sd = Math.min(1, maxSide / Math.max(vw, vh));
        sd = Math.min(sd, Math.sqrt(Utils.maxCanvasPixels() / (vw * vh)));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(vw * sd));
        canvas.height = Math.max(1, Math.round(vh * sd));
        const ctx = canvas.getContext("2d");
        if (!item.alpha) { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); }
        ctx.imageSmoothingQuality = "high";
        ctx.save();
        ctx.scale(canvas.width / vw, canvas.height / vh);
        ctx.translate(-sx, -sy);                                       // work in "rotated image" pixel space
        ctx.translate(effW / 2, effH / 2);
        ctx.rotate(item.rotation * Math.PI / 180);
        ctx.drawImage(img, -item.w / 2, -item.h / 2);
        ctx.restore();

        const mime = item.alpha ? "image/png" : "image/jpeg";
        const blob = await new Promise(r => canvas.toBlob(r, mime, this.JPEG_QUALITY[quality]));
        canvas.width = canvas.height = 0;
        if (!blob) throw new AppError("Not enough memory", "The browser could not convert one of the images. Try Low or Medium quality.");
        const bytes = new Uint8Array(await blob.arrayBuffer());
        return item.alpha ? out.embedPng(bytes) : out.embedJpg(bytes);
    },

    /** True for JPEGs with an EXIF orientation other than "normal" (raw embedding would show them sideways). */
    async _needsExifFix(file) {
        if (file.type !== "image/jpeg") return false;
        try {
            const view = new DataView(await file.slice(0, 65536).arrayBuffer());
            if (view.getUint16(0) !== 0xFFD8) return false;
            let off = 2;
            while (off + 4 < view.byteLength) {
                const marker = view.getUint16(off), len = view.getUint16(off + 2);
                if (marker === 0xFFE1) {
                    if (view.getUint32(off + 4) !== 0x45786966) return false; // "Exif"
                    const tiff = off + 10, little = view.getUint16(tiff) === 0x4949;
                    const ifd = tiff + view.getUint32(tiff + 4, little);
                    const count = view.getUint16(ifd, little);
                    for (let i = 0; i < count; i++) {
                        const entry = ifd + 2 + i * 12;
                        if (view.getUint16(entry, little) === 0x0112) return view.getUint16(entry + 8, little) !== 1;
                    }
                    return false;
                }
                if ((marker & 0xFF00) !== 0xFF00) break;
                off += 2 + len;
            }
            return false;
        } catch (_) { return true; } // can't tell: use the canvas path, which honours EXIF
    },

    /* ------------------------------------------------------------ result */
    async _preview() {
        if (!this._result) return;
        if (await PDFEditor.openBytes(this._result.bytes.slice(), this._result.name)) App.openTool("viewer");
    },

    _download() {
        if (!this._result) return;
        FileManager.saveBlobAs(new Blob([this._result.bytes], { type: "application/pdf" }), this._result.name, { title: "Download PDF" });
    },

    reset() {
        this.items.forEach(it => FileManager.revokeUrl(it.url));
        this.items = [];
        this._result = null;
        this.render();
    },
    cleanup() { FileManager.revokeOwner("images"); },
    destroy() { this.reset(); }
};
