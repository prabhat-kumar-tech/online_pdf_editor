/**
 * pdf-tools.js — PDF processing built on pdf-lib (writing) and PDF.js (reading/rasterizing).
 * Pure logic: no DOM access except canvases for rasterizing.
 *
 * Export pipeline:   Original PDF bytes  ->  document model (pages + objects)  ->  new PDF bytes.
 * The user's original file is never modified; every export builds a fresh document
 * (or re-saves a private copy when nothing but annotations changed).
 */
"use strict";

const PDFTools = {
    /* ------------------------------------------------------------ opening */
    /** PDF.js document from bytes (copy: PDF.js transfers the buffer to its worker). */
    async openPdfJs(bytes) {
        const cfg = APP_CONFIG.libs.pdfjs;
        try {
            return await pdfjsLib.getDocument({
                data: bytes.slice(),
                cMapUrl: cfg.cMapUrl, cMapPacked: true,
                standardFontDataUrl: cfg.standardFontDataUrl,
                isEvalSupported: false // never compile code derived from untrusted PDFs
            }).promise;
        } catch (err) {
            const info = Utils.describeError(err);
            throw new AppError(info.title, info.message, err);
        }
    },

    /** pdf-lib document from bytes, with friendly errors. */
    async openPdfLib(bytes) {
        try {
            return await PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
        } catch (err) {
            const info = Utils.describeError(err);
            throw new AppError(info.title, info.message, err);
        }
    },

    /* ------------------------------------------------------------ export */
    /**
     * Build a PDF from the document model.
     * @param {object} doc  PDFEditor.doc
     * @param {{pageIds?:string[], withObjects?:boolean, onProgress?:(f:number,t?:string)=>void}} opts
     * @returns {Promise<{bytes:Uint8Array, warnings:string[]}>}
     */
    async buildPdf(doc, { pageIds = null, withObjects = true, onProgress = () => {} } = {}) {
        const { PDFDocument, degrees } = PDFLib;
        const byId = new Map(doc.pages.map(p => [p.id, p]));
        const pages = pageIds ? pageIds.map(id => byId.get(id)).filter(Boolean) : doc.pages;
        if (!pages.length) throw new AppError("Empty document", "There are no pages to export.");

        const warnings = new Set();
        const srcDocs = new Map();
        const loadSrc = async i => {
            if (!srcDocs.has(i)) srcDocs.set(i, await this.openPdfLib(doc.sources[i].bytes));
            return srcDocs.get(i);
        };

        // When pages are untouched (same order, single source) re-save the original so that
        // form fields, bookmarks and metadata are kept. Otherwise copy pages into a new document.
        const identity = !pageIds && doc.sources.length >= 1
            && pages.every((p, i) => !p.blank && p.src === 0 && p.idx === i)
            && pages.length === doc.sources[0].pdf.numPages;

        let out, outPages;
        if (identity) {
            onProgress(0.1, "Preparing");
            out = await loadSrc(0);
            outPages = out.getPages();
        } else {
            out = await PDFDocument.create();
            // Copy per source in ONE call so shared fonts/images are not duplicated.
            const wanted = new Map(); // srcIndex -> [page entries]
            pages.forEach(p => { if (!p.blank) { if (!wanted.has(p.src)) wanted.set(p.src, []); wanted.get(p.src).push(p); } });
            const copies = new Map(); // page entry -> PDFPage (as array slot, so duplicates stay distinct)
            let done = 0;
            for (const [src, list] of wanted) {
                const srcDoc = await loadSrc(src);
                const copied = await out.copyPages(srcDoc, list.map(p => p.idx));
                list.forEach((p, i) => copies.set(p, copied[i]));
                onProgress(0.1 + 0.4 * (++done / wanted.size), "Copying pages");
            }
            outPages = pages.map(p => {
                if (p.blank) return out.addPage([p.geom.w, p.geom.h]);
                return out.addPage(copies.get(p));
            });
        }

        const fontCache = new Map();
        for (let i = 0; i < pages.length; i++) {
            const page = pages[i], outPage = outPages[i];
            outPage.setRotation(degrees(PDFEditor.totalRotation(page)));
            if (withObjects) {
                for (const obj of doc.objects[page.id] || []) {
                    await this._drawObject(out, outPage, page, obj, fontCache, warnings);
                }
            }
            if (i % 5 === 0) { onProgress(0.5 + 0.45 * (i / pages.length), "Writing pages"); await Utils.sleep(0); }
        }

        out.setProducer(APP_CONFIG.appName);
        const bytes = await out.save({ useObjectStreams: APP_CONFIG.enableCompression });
        onProgress(1);
        return { bytes, warnings: [...warnings] };
    },

    /** Pick one of the 12 PDF standard fonts. Only these are embedded (no font files needed). */
    async _font(out, cache, obj) {
        const { StandardFonts } = PDFLib;
        const family = /times/i.test(obj.fontFamily) ? "Times" : /courier|mono/i.test(obj.fontFamily) ? "Courier" : "Helvetica";
        const b = !!obj.bold, i = !!obj.italic;
        const names = {
            Helvetica: ["Helvetica", "HelveticaBold", "HelveticaOblique", "HelveticaBoldOblique"],
            Times: ["TimesRoman", "TimesRomanBold", "TimesRomanItalic", "TimesRomanBoldItalic"],
            Courier: ["Courier", "CourierBold", "CourierOblique", "CourierBoldOblique"]
        }[family];
        const key = names[(b ? 1 : 0) + (i ? 2 : 0)];
        if (!cache.has(key)) {
            const font = await out.embedFont(StandardFonts[key]);
            font._ok = new Map();
            cache.set(key, font);
        }
        return cache.get(key);
    },

    /** Replace characters the standard (WinAnsi) fonts cannot encode with "?" and report them. */
    _encodable(font, text, warnings) {
        let out = "";
        for (const ch of text.replace(/\t/g, "    ")) {
            let ok = font._ok.get(ch);
            if (ok === undefined) {
                try { font.widthOfTextAtSize(ch, 1); ok = true; } catch (_) { ok = false; }
                font._ok.set(ch, ok);
            }
            if (ok) out += ch; else { out += "?"; warnings.add(ch); }
        }
        return out;
    },

    _wrap(font, size, text, maxWidth) {
        const lines = [];
        for (const para of text.split("\n")) {
            if (!maxWidth) { lines.push(para); continue; }
            let line = "";
            for (let word of para.split(" ")) {
                const attempt = line ? `${line} ${word}` : word;
                if (font.widthOfTextAtSize(attempt, size) <= maxWidth) { line = attempt; continue; }
                if (line) lines.push(line);
                // a single word wider than the box is broken by characters
                while (word.length > 1 && font.widthOfTextAtSize(word, size) > maxWidth) {
                    let n = word.length - 1;
                    while (n > 1 && font.widthOfTextAtSize(word.slice(0, n), size) > maxWidth) n--;
                    lines.push(word.slice(0, n));
                    word = word.slice(n);
                }
                line = word;
            }
            lines.push(line);
        }
        return lines;
    },

    /**
     * Draw one annotation object onto an output page.
     *
     * Objects live in DISPLAY space: points, origin top-left, y down, as the page is shown after
     * rotation R. A box is (x, y, w, h) rotated by obj.rotation (clockwise) around its centre.
     * pdf-lib draws in USER space (origin bottom-left, y up, unrotated), so:
     *   1. take a point in the box's local frame (relative to the centre, y down),
     *   2. rotate it by obj.rotation and add the centre -> display point,
     *   3. Utils.displayToUser() -> PDF user point,
     *   4. text/rect angle in user space (counter-clockwise, pdf-lib convention) = R - obj.rotation.
     */
    async _drawObject(out, outPage, page, obj, fontCache, warnings) {
        const { rgb, degrees } = PDFLib;
        const R = PDFEditor.totalRotation(page);
        const geom = page.geom;
        const theta = (obj.rotation || 0) * Math.PI / 180;
        const cos = Math.cos(theta), sin = Math.sin(theta);
        const cx = obj.x + obj.w / 2, cy = obj.y + obj.h / 2;
        const toUser = (lx, ly) => Utils.displayToUser(cx + lx * cos - ly * sin, cy + lx * sin + ly * cos, geom, R);
        const angle = R - (obj.rotation || 0);
        const c = Utils.hexToRgb01(obj.color);
        const color = rgb(c.r, c.g, c.b);
        const opacity = Utils.clamp(obj.opacity ?? 1, 0, 1);

        if (obj.type === "rect") {
            const p = toUser(-obj.w / 2, obj.h / 2); // bottom-left corner of the box in display terms
            outPage.drawRectangle({ x: p.x, y: p.y, width: obj.w, height: obj.h, rotate: degrees(angle), color, opacity, borderWidth: 0 });
            return;
        }
        if (obj.type === "image") {
            const key = `img:${obj.imageId}`;
            if (!fontCache.has(key)) fontCache.set(key, await out.embedPng(PDFEditor.doc.images[obj.imageId]));
            const p = toUser(-obj.w / 2, obj.h / 2);
            outPage.drawImage(fontCache.get(key), { x: p.x, y: p.y, width: obj.w, height: obj.h, rotate: degrees(angle), opacity });
            return;
        }
        if (obj.type !== "text" || !obj.text) return;

        const font = await this._font(out, fontCache, obj);
        const size = obj.fontSize;
        const text = obj.text.split("\n").map(l => this._encodable(font, l, warnings)).join("\n");
        const lines = this._wrap(font, size, text, obj.autoWidth ? 0 : obj.w);
        const lineHeight = size * 1.2;      // must match line-height in style.css (.annot-text)
        const baseline = size * 0.946;      // distance from top of a line box to its baseline
        lines.forEach((line, i) => {
            if (!line) return;
            const lw = font.widthOfTextAtSize(line, size);
            const lx = obj.align === "center" ? -lw / 2 : obj.align === "right" ? obj.w / 2 - lw : -obj.w / 2;
            const ly = -obj.h / 2 + baseline + i * lineHeight;
            const p = toUser(lx, ly);
            outPage.drawText(line, { x: p.x, y: p.y, size, font, color, opacity, rotate: degrees(angle) });
            if (obj.underline) {
                const a = toUser(lx, ly + size * 0.12), b = toUser(lx + lw, ly + size * 0.12);
                outPage.drawLine({ start: a, end: b, thickness: Math.max(0.5, size / 16), color, opacity });
            }
        });
    },

    /* ------------------------------------------------------------ split / extract */
    /** @returns {Promise<Array<{name:string, bytes:Uint8Array}>>} */
    async splitGroups(doc, groups, namer, onProgress = () => {}) {
        const results = [];
        for (let i = 0; i < groups.length; i++) {
            const ids = groups[i].map(idx => doc.pages[idx].id);
            const { bytes } = await this.buildPdf(doc, { pageIds: ids });
            results.push({ name: namer(i, groups[i]), bytes });
            onProgress((i + 1) / groups.length, `File ${i + 1} of ${groups.length}`);
        }
        return results;
    },

    async zip(files) {
        const zip = new JSZip();
        files.forEach(f => zip.file(f.name, f.bytes));
        return zip.generateAsync({ type: "blob", compression: "STORE" });
    },

    /* ------------------------------------------------------------ merge */
    /** @param {Uint8Array[]|(()=>Promise<Uint8Array>)[]} sources */
    async merge(loaders, onProgress = () => {}) {
        const out = await PDFLib.PDFDocument.create();
        for (let i = 0; i < loaders.length; i++) {
            const bytes = await loaders[i]();
            const src = await this.openPdfLib(bytes);
            const copied = await out.copyPages(src, src.getPageIndices());
            copied.forEach(p => out.addPage(p));
            onProgress((i + 1) / loaders.length, `File ${i + 1} of ${loaders.length}`);
            await Utils.sleep(0);
        }
        out.setProducer(APP_CONFIG.appName);
        return out.save({ useObjectStreams: APP_CONFIG.enableCompression });
    },

    /* ------------------------------------------------------------ compress */
    PRESETS: { low: { dpi: 72, quality: 0.5 }, medium: { dpi: 110, quality: 0.65 }, high: { dpi: 150, quality: 0.8 } },

    /**
     * Map a user-facing compression level (0–200 %) to render settings.
     * 0 % = best quality / largest file, 100 % = balanced, 200 % = smallest file.
     */
    levelToSettings(percent) {
        const p = Utils.clamp(Math.round(percent), 0, 200);
        return { dpi: Math.round(Utils.clamp(160 - 0.6 * p, 40, 160)), quality: Math.round(Utils.clamp(0.92 - 0.0042 * p, 0.1, 0.92) * 100) / 100 };
    },

    /**
     * Lossless levels (1–200 %). Nothing visible ever changes — higher levels just apply more
     * thorough optimisation, so how much smaller the file gets depends on what the PDF contains.
     */
    losslessTier(percent) {
        const p = Utils.clamp(Math.round(percent), 1, 200);
        if (p <= 50) return { tier: 1, name: "Light", info: "Re-saves with compressed object streams." };
        if (p <= 100) return { tier: 2, name: "Standard", info: "Object streams, plus re-compression of internal data (level 6) and removal of unused resources." };
        if (p <= 150) return { tier: 3, name: "Strong", info: "Everything in Standard with maximum re-compression (level 9), and removal of document metadata (title, author, XMP)." };
        return { tier: 4, name: "Maximum", info: "Everything in Strong, plus removal of embedded page thumbnails and editor-private data." };
    },

    /** Lossless: smaller file, identical pages, text and images. */
    async compressLossless(bytes, percent = 100) {
        const { tier } = this.losslessTier(percent);
        const { PDFName } = PDFLib;
        const doc = await this.openPdfLib(bytes);
        if (tier >= 3) {                                   // metadata
            doc.catalog.delete(PDFName.of("Metadata"));
            doc.setTitle(""); doc.setAuthor(""); doc.setSubject(""); doc.setKeywords([]); doc.setCreator("");
        }
        if (tier >= 4) {                                   // thumbnails and application-private data
            doc.catalog.delete(PDFName.of("PieceInfo"));
            for (const page of doc.getPages()) { page.node.delete(PDFName.of("Thumb")); page.node.delete(PDFName.of("PieceInfo")); }
        }
        let out = await doc.save({ useObjectStreams: true });
        if (tier >= 2) {                                   // qpdf: stronger Flate re-compression, unused resources
            try {
                const better = await PDFSecurity._run(out, [
                    "--object-streams=generate", "--recompress-flate", `--compression-level=${tier >= 3 ? 9 : 6}`, "--remove-unreferenced-resources=yes"
                ]);
                if (better && better.length < out.length) out = better;
            } catch (err) {
                Logger.warn("qpdf optimisation unavailable", err);
                Toast.warning("The advanced optimisation engine could not be loaded; only basic optimisation was applied.");
            }
        }
        return out;
    },

    /** Lossy: render every page to a JPEG and rebuild. Text becomes pixels. */
    async compressRaster(bytes, level, onProgress = () => {}) {
        const { dpi, quality } = typeof level === "number" ? this.levelToSettings(level) : (this.PRESETS[level] || this.PRESETS.medium);
        const pdf = await this.openPdfJs(bytes);
        const out = await PDFLib.PDFDocument.create();
        try {
            for (let n = 1; n <= pdf.numPages; n++) {
                const page = await pdf.getPage(n);
                const base = page.getViewport({ scale: 1 });
                let scale = dpi / 72;
                if (base.width * scale * base.height * scale > Utils.maxCanvasPixels()) {
                    scale = Math.sqrt(Utils.maxCanvasPixels() / (base.width * base.height));
                }
                const vp = page.getViewport({ scale });
                const canvas = document.createElement("canvas");
                canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
                const ctx = canvas.getContext("2d");
                ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
                await page.render({ canvasContext: ctx, viewport: vp }).promise;
                const blob = await new Promise(r => canvas.toBlob(r, "image/jpeg", quality));
                canvas.width = canvas.height = 0;
                const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
                const outPage = out.addPage([base.width, base.height]);
                outPage.drawImage(img, { x: 0, y: 0, width: base.width, height: base.height });
                page.cleanup();
                onProgress(n / pdf.numPages, `Page ${n} of ${pdf.numPages}`);
            }
        } finally {
            pdf.destroy();
        }
        out.setProducer(APP_CONFIG.appName);
        return out.save({ useObjectStreams: true });
    }
};
