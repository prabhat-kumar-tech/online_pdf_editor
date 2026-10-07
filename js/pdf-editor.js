/**
 * pdf-editor.js — the open document: loading, the document model, history glue, save/export.
 *
 * Data flow:   Original PDF bytes  ->  document model  ->  new PDF bytes (export)
 *
 * doc = {
 *   name,
 *   sources: [{ id, name, bytes:Uint8Array, pdf:PDFDocumentProxy }]   // originals, never modified
 *   pages:   [{ id, src, idx, rot, native, blank, geom:{x0,y0,w,h} }]  // order + user rotation
 *   objects: { [pageId]: [annotation objects] }                         // see pdf-text-editor.js
 * }
 * Only `pages` and `objects` change while editing; they are what undo/redo snapshots capture.
 *
 * Public API:  PDFEditor.open(file) · save() · addText(options) · deleteSelected() · undo() · redo()
 */
"use strict";

const PDFEditor = {
    doc: null,
    _textCache: new Map(),
    _scanned: null,
    _pageMap: new Map(),
    _pageMapFor: null,
    _imageUrls: new Map(), // imageId -> object URL (for display); bytes live in doc.images

    init() {
        PDFHistory.init({
            capture: () => JSON.stringify({ pages: this.doc.pages, objects: this.doc.objects }),
            restore: snap => this._restore(snap)
        });
    },

    /* ------------------------------------------------------------ model helpers */
    /** Total clockwise rotation of a page as displayed/exported: native /Rotate + user rotation. */
    totalRotation(page) { return (((page.native || 0) + (page.rot || 0)) % 360 + 360) % 360; },

    /** Page size in points as displayed (after rotation). */
    displaySize(page) {
        const { w, h } = page.geom;
        const r = this.totalRotation(page);
        return r === 90 || r === 270 ? { w: h, h: w } : { w, h };
    },

    /** O(1) page lookup (a Map rebuilt whenever the page list changes), so very large documents stay fast. */
    getPage(id) {
        const pages = this.doc?.pages;
        if (!pages) return null;
        if (this._pageMapFor !== pages || this._pageMap.size !== pages.length) {
            this._pageMap = new Map(pages.map(p => [p.id, p]));
            this._pageMapFor = pages;
        }
        return this._pageMap.get(id) || null;
    },

    /** Register PNG bytes used by image/signature objects. Kept outside undo snapshots (objects only hold the id). */
    addImage(bytes) {
        const id = Utils.uid("im");
        (this.doc.images ||= {})[id] = bytes;
        this._imageUrls.set(id, FileManager.createUrl(new Blob([bytes], { type: "image/png" }), "doc-images"));
        return id;
    },
    imageUrl(id) { return this._imageUrls.get(id) || ""; },

    getPdfPage(page) { return this.doc.sources[page.src].pdf.getPage(page.idx + 1); },

    /** PDF.js text content of a page (cached per source page). */
    async getTextContent(page) {
        const key = `${page.src}:${page.idx}`;
        if (!this._textCache.has(key)) {
            const proxy = await this.getPdfPage(page);
            this._textCache.set(key, await proxy.getTextContent());
        }
        return this._textCache.get(key);
    },

    /** True when the first pages contain no text at all (scanned / image-only / outlined text). */
    async detectScanned() {
        if (this._scanned !== null) return this._scanned;
        const pages = this.doc.pages.filter(p => !p.blank).slice(0, 5);
        if (!pages.length) return (this._scanned = false);
        let chars = 0;
        for (const p of pages) {
            const c = await this.getTextContent(p);
            chars += c.items.reduce((n, i) => n + (i.str || "").trim().length, 0);
        }
        return (this._scanned = chars === 0);
    },

    /* ------------------------------------------------------------ opening */
    /** Open a user-selected File. Returns true on success. */
    async open(file) {
        const check = FileManager.validate(file, ["pdf"]);
        if (!check.ok) {
            UI.showError({ title: "Unable to open PDF", message: check.reason },
                { actionLabel: "Try Another File", onAction: () => UI.run("open-pdf") });
            return false;
        }
        if (APP_CONFIG.largeFileWarnMB > 0 && file.size > APP_CONFIG.largeFileWarnMB * 1024 * 1024) {
            Toast.warning(`Large file (${Utils.formatBytes(file.size)}). Opening may take a moment.`);
        }
        try {
            return await this.openBytes(await FileManager.readBytes(file), file.name);
        } catch (err) {
            UI.showError(err, { actionLabel: "Try Another File", onAction: () => UI.run("open-pdf") });
            return false;
        }
    },

    async openBytes(bytes, name) {
        if (!(await this.confirmClose())) return false;
        let data = bytes;
        try {
            for (;;) {
                const res = await UI.withProgress("Opening PDF…", async update => {
                    let pdf;
                    try { pdf = await PDFTools.openPdfJs(data); }
                    catch (err) { if (PDFSecurity.isPasswordError(err)) return { locked: true }; throw err; }
                    try {
                        const pages = await this._buildPages(pdf, 0, update);
                        return { doc: { name, sources: [{ id: Utils.uid("src"), name, bytes: data, pdf }], pages, objects: {} } };
                    } catch (err) { pdf.destroy(); throw err; }
                }, { determinate: true });
                if (res.locked) {                         // password needed: ask (no overlay showing), decrypt a copy, retry
                    const unlocked = await PDFSecurity.unlockWithPrompt(data, name);
                    if (!unlocked) return false;
                    data = unlocked;
                    continue;
                }
                this._install(res.doc, data.length);
                return true;
            }
        } catch (err) {
            UI.showError(err, { actionLabel: "Try Another File", onAction: () => UI.run("open-pdf") });
            return false;
        }
    },

    /** Read geometry of every page. Pages are sized up-front so the viewer can lay out placeholders. */
    async _buildPages(pdf, srcIndex, update) {
        const total = pdf.numPages;
        if (!total) throw new AppError("Empty document", "This PDF has no pages.");
        const pages = [];
        for (let n = 1; n <= total; n++) {
            const p = await pdf.getPage(n);
            const v = p.view; // visible box [x0, y0, x1, y1] in user space
            pages.push({
                id: Utils.uid("pg"), src: srcIndex, idx: n - 1, rot: 0, blank: false,
                native: ((p.rotate % 360) + 360) % 360,
                geom: { x0: Math.min(v[0], v[2]), y0: Math.min(v[1], v[3]), w: Math.abs(v[2] - v[0]) || 595, h: Math.abs(v[3] - v[1]) || 842 }
            });
            p.cleanup();
            if (n % 10 === 0) { update?.(n / total, "Reading pages"); await Utils.sleep(0); }
        }
        return pages;
    },

    async newDocument() {
        if (!(await this.confirmClose())) return false;
        const [w, h] = ImageToPDF.PAGE_SIZES.A4;
        this._install({
            name: "Untitled.pdf", sources: [], objects: {},
            pages: [{ id: Utils.uid("pg"), src: -1, idx: 0, rot: 0, native: 0, blank: true, geom: { x0: 0, y0: 0, w, h } }]
        }, 0);
        return true;
    },

    _install(doc, size) {
        this.reset();
        this.doc = doc;
        AppState.set({
            currentFile: { name: doc.name, size }, pdfDocument: doc, totalPages: doc.pages.length,
            currentPage: 1, selectedPages: [], selectedObject: null, zoom: APP_CONFIG.defaultZoom
        });
        PDFHistory.pushState("Open");
        PDFHistory.markSaved();
        PDFViewer.syncPages();
        PDFTextEditor.renderAll();
        PDFPages._stale = true;
        App.onDocumentOpened();
    },

    /** Pages of another PDF, registered as an extra source (used by Organize > Insert from PDF). */
    async loadPagesFromFile(file, bytes) {
        bytes ||= await FileManager.readBytes(file);
        const pdf = await PDFTools.openPdfJs(bytes);
        try {
            const srcIndex = this.doc.sources.length;
            const pages = await this._buildPages(pdf, srcIndex);
            this.doc.sources.push({ id: Utils.uid("src"), name: file.name, bytes, pdf });
            return pages;
        } catch (err) { pdf.destroy(); throw err; }
    },

    /* ------------------------------------------------------------ history glue */
    /** Record an undo step after an edit. */
    commit(label) { PDFHistory.pushState(label); },

    /** Page list changed: record history and refresh every view. */
    pagesChanged(label) {
        PDFHistory.pushState(label);
        this.syncViews();
    },

    syncViews() {
        PDFViewer.syncPages();
        PDFTextEditor.renderAll();
        PDFPages.render();
        UI.refresh();
    },

    _restore(snap) {
        const s = JSON.parse(snap);
        this.doc.pages = s.pages;
        this.doc.objects = s.objects;
        this.syncViews();
    },

    undo() {
        if (!this.doc) return;
        if (PDFTextEditor.editing) PDFTextEditor.finishEditing();
        if (!PDFHistory.undo()) Toast.info("Nothing to undo.", { duration: 1500 });
    },

    redo() {
        if (!this.doc) return;
        if (PDFTextEditor.editing) PDFTextEditor.finishEditing();
        if (!PDFHistory.redo()) Toast.info("Nothing to redo.", { duration: 1500 });
    },

    /* ------------------------------------------------------------ editing facade */
    addText(options) { return PDFTextEditor.addText(options); },

    deleteSelected() {
        if (UI.ORGANIZER_TOOLS.includes(AppState.currentTool)) PDFPages.remove(PDFPages.selectedIds());
        else PDFTextEditor.deleteSelected();
    },

    selectAll() {
        if (UI.ORGANIZER_TOOLS.includes(AppState.currentTool)) PDFPages.selectAll();
        else PDFTextEditor.selectAll();
    },

    rotateCurrentPage(delta) {
        const page = this.doc?.pages[AppState.currentPage - 1];
        if (page) PDFPages.rotate([page.id], delta);
    },

    /* ------------------------------------------------------------ save / close */
    /** Export a new PDF (original is untouched) and download it. Returns true if saved. */
    async save({ saveAs = false } = {}) {
        const doc = this.doc;
        if (!doc) return false;
        PDFTextEditor.finishEditing();
        const base = Utils.baseName(doc.name);
        const name = await FileManager.promptFilename(saveAs ? `${base}_edited.pdf` : `${base}.pdf`, {
            title: saveAs ? "Save PDF As" : "Save PDF", confirmLabel: "Save"
        });
        if (!name) return false;
        try {
            const { bytes, warnings } = await UI.withProgress("Exporting PDF…", p => PDFTools.buildPdf(doc, { onProgress: p }), { determinate: true });
            FileManager.downloadBlob(new Blob([bytes], { type: "application/pdf" }), name);
            doc.name = name;
            AppState.set({ currentFile: { ...AppState.currentFile, name } });
            PDFHistory.markSaved();
            if (warnings.length) {
                Toast.warning(`Characters not available in the standard PDF fonts were replaced with “?”: ${warnings.slice(0, 8).join(" ")}`, { duration: 9000 });
            }
            Toast.success(`Saved ${name} (${Utils.formatBytes(bytes.length)}).`);
            return true;
        } catch (err) {
            Logger.error("Export failed", err);
            UI.showError(err instanceof AppError ? err : new AppError("Unable to export PDF",
                "The PDF could not be generated. The source file may use features that are not supported."));
            return false;
        }
    },

    /** Ask what to do with unsaved changes. Returns true when it is safe to replace/close the document. */
    async confirmClose() {
        if (!this.doc || !AppState.isDirty) return true;
        const choice = await Modal.unsaved({ name: this.doc.name });
        if (choice === "cancel") return false;
        if (choice === "save") return this.save();
        return true;
    },

    async close() {
        if (!this.doc) return true;
        if (!(await this.confirmClose())) return false;
        this.reset();
        App.openTool("home");
        return true;
    },

    /* ------------------------------------------------------------ lifecycle */
    /** Release the current document and everything that depends on it. */
    reset() {
        PDFTextEditor.reset();
        PDFPages.reset();
        PDFViewer.reset();
        if (this.doc) {
            for (const s of this.doc.sources) { try { s.pdf.destroy(); } catch (_) { /* already gone */ } s.bytes = null; }
        }
        this.doc = null;
        this._textCache.clear();
        this._scanned = null;
        FileManager.revokeOwner("doc-images");
        this._imageUrls.clear();
        PDFHistory.clear();
        AppState.set({ currentFile: null, pdfDocument: null, totalPages: 0, currentPage: 1, selectedPages: [], selectedObject: null, isDirty: false });
    },

    cleanup() { this._textCache.clear(); },
    destroy() { this.reset(); }
};
