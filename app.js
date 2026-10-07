/**
 * app.js — application bootstrap, tool routing, global commands and keyboard shortcuts.
 *
 * Startup:  config.js (already loaded) -> theme -> UI -> load libraries -> initialise modules
 *           -> register commands -> show the home screen.
 */
"use strict";

const App = {
    STANDALONE: ["home", "merge", "images", "compress"],
    engineReady: false,

    LEAD: {
        viewer: "Open a PDF to read it with thumbnails, zoom and selectable text.",
        editor: "Open a PDF to add text or replace visible text.",
        organize: "Open a PDF to reorder, rotate, duplicate or delete pages.",
        split: "Open a PDF to split it into several files.",
        rotate: "Open a PDF to rotate its pages.",
        delete: "Open a PDF to delete pages.",
        extract: "Open a PDF to extract pages into a new file.",
        watermark: "Open a PDF to add a text watermark.",
        numbers: "Open a PDF to add page numbers.",
        toimg: "Open a PDF to save its pages as images.",
        totext: "Open a PDF to extract its text.",
        protect: "Open a PDF to protect it with a password."
    },

    /* ------------------------------------------------------------ startup */
    async start() {
        Theme.init();
        UI.init();
        this._registerCommands();
        this._bindKeyboard();
        this._bindDrops();

        for (const mod of [PDFEditor, PDFViewer, PDFTextEditor, PDFPages, PDFMerge, ImageToPDF, PDFCompress, PDFStamp, PDFExportTools, PDFSecurity, Tour]) mod.init();

        UI.bindDropzone(document.getElementById("dz-home"), { kinds: ["pdf", "image"], multiple: true, onFiles: f => this.routeFiles(f) });
        UI.bindDropzone(document.getElementById("dz-doc"), { kinds: ["pdf"], multiple: false, onFiles: f => this.openPdfFile(f[0]) });

        window.addEventListener("beforeunload", e => {
            if (AppState.isDirty) { e.preventDefault(); e.returnValue = ""; }
        });

        this.openTool("home");
        await this.loadLibraries();
        Tour.maybeStart();                       // first visit only (remembered in localStorage)
    },

    /* ------------------------------------------------------------ libraries */
    _loadScript(url) {
        return new Promise((resolve, reject) => {
            const s = Utils.h("script", { src: url });
            s.async = true;
            s.onload = () => resolve();
            s.onerror = () => { s.remove(); reject(new Error(`Failed to load ${url}`)); };
            document.head.append(s);
        });
    },

    async _loadFirst(urls) {
        for (const url of urls) {
            try { await this._loadScript(url); return url; } catch (err) { Logger.warn(err.message); }
        }
        throw new Error("All sources failed");
    },

    /** Browsers refuse cross-origin Workers, so the worker script is fetched and run from a blob URL. */
    async _setupPdfWorker(urls) {
        for (const url of urls) {
            try {
                const res = await fetch(url);
                if (!res.ok) throw new Error(res.status);
                const blob = new Blob([await res.text()], { type: "text/javascript" });
                pdfjsLib.GlobalWorkerOptions.workerSrc = FileManager.createUrl(blob, "worker");
                return;
            } catch (err) { Logger.warn("Worker fetch failed", url, err); }
        }
        pdfjsLib.GlobalWorkerOptions.workerSrc = urls[0];
    },

    async loadLibraries() {
        const libs = APP_CONFIG.libs;
        try {
            await Promise.all([this._loadFirst(libs.pdfjs.scripts), this._loadFirst(libs.pdfLib.scripts)]);
            if (typeof pdfjsLib === "undefined" || typeof PDFLib === "undefined") throw new Error("Library globals missing");
            await this._setupPdfWorker(libs.pdfjs.workers);
            this.engineReady = true;
            Logger.info("PDF engine ready");
        } catch (err) {
            Logger.error("Library load failed", err);
            this.showEngineError();
            return;
        }
        // Optional: only needed to bundle split files into a .zip.
        this._loadFirst(libs.jszip.scripts).catch(() => Logger.warn("JSZip unavailable; split falls back to separate downloads."));
    },

    showEngineError() {
        UI.showError({
            title: "PDF Engine unavailable",
            message: "Please check your internet connection or verify the configured library source (APP_CONFIG.libs in config.js)."
        }, { actionLabel: "Retry", onAction: () => location.reload() });
    },

    /** Gate for anything that needs PDF.js / pdf-lib. */
    ensureEngine() {
        if (this.engineReady) return true;
        this.showEngineError();
        return false;
    },

    /* ------------------------------------------------------------ routing */
    openTool(tool) {
        const isDocTool = UI.DOC_TOOLS.includes(tool);
        if (!isDocTool && !this.STANDALONE.includes(tool)) return;
        if (tool !== "home" && !this.ensureEngine()) return;

        AppState.set({ currentTool: tool });
        UI.applyToolVisibility(tool);

        if (!isDocTool) {
            UI.showView(tool);
            PDFTextEditor.onToolChange(tool);
        } else {
            UI.showView("doc");
            const hasDoc = !!PDFEditor.doc;
            document.getElementById("doc-empty").hidden = hasDoc;
            document.getElementById("doc-workspace").hidden = !hasDoc;
            document.getElementById("doc-empty-lead").textContent = this.LEAD[tool];
            if (hasDoc) {
                PDFViewer.setTool(tool);
                if (UI.SCROLL_TOOLS.includes(tool)) PDFViewer.onShown();
                else if (tool === "split" || UI.ORGANIZER_TOOLS.includes(tool)) PDFPages.onShown(tool);
                PDFTextEditor.onToolChange(tool);
                Events.emit("tool:shown", { tool });
            } else {
                PDFTextEditor.onToolChange(tool);
            }
        }
        UI.collapseSidebarIfNarrow();
        UI.refresh();
        UI.setStatus(this._statusFor(tool));
    },

    _statusFor(tool) {
        const names = { home: "Home", merge: "Merge PDF", images: "Image to PDF", compress: "Compress PDF", viewer: "PDF Viewer", editor: "Edit PDF", organize: "Organize Pages", split: "Split PDF", rotate: "Rotate Pages", delete: "Delete Pages", extract: "Extract Pages", watermark: "Watermark", numbers: "Page Numbers", toimg: "PDF to Images", totext: "Extract Text", protect: "Protect PDF" };
        return `Tool: ${names[tool]}`;
    },

    /** Called by PDFEditor after a document finished loading. */
    onDocumentOpened() {
        const tool = AppState.currentTool;
        this.openTool(UI.DOC_TOOLS.includes(tool) ? tool : "viewer");
        UI.setStatus(`Opened ${PDFEditor.doc.name} — ${PDFEditor.doc.pages.length} page${PDFEditor.doc.pages.length === 1 ? "" : "s"}`);
    },

    async openPdfFile(file) {
        if (!file || !this.ensureEngine()) return;
        await PDFEditor.open(file);
    },

    /** Decide what to do with dropped / picked files based on their type. */
    async routeFiles(files) {
        if (!this.ensureEngine()) return;
        const list = Array.from(files);
        const pdfs = list.filter(f => FileManager.classify(f) === "pdf");
        const imgs = list.filter(f => FileManager.classify(f) === "image");
        const bad = list.length - pdfs.length - imgs.length;
        if (bad) Toast.error(`${bad} unsupported file${bad === 1 ? "" : "s"} ignored. Use PDF, JPG, PNG or WEBP.`);
        if (pdfs.length && imgs.length) Toast.warning("PDFs and images were dropped together. Opening the PDFs; add images from Image to PDF.");
        if (pdfs.length > 1) { this.openTool("merge"); PDFMerge.addFiles(pdfs); }
        else if (pdfs.length === 1) await this.openPdfFile(pdfs[0]);
        else if (imgs.length) { this.openTool("images"); ImageToPDF.addImages(imgs); }
    },

    /** Files dropped anywhere outside a dropzone are handled according to the current tool. */
    _bindDrops() {
        window.addEventListener("drop", e => {
            const files = Array.from(e.dataTransfer?.files || []);
            if (!files.length || Modal.isOpen) return;
            e.preventDefault();
            const tool = AppState.currentTool;
            if (tool === "merge") PDFMerge.addFiles(files);
            else if (tool === "images") ImageToPDF.addImages(files);
            else if (tool === "compress") PDFCompress.setFile(files);
            else this.routeFiles(files);
        });
    },

    /* ------------------------------------------------------------ commands */
    _inScroll() { return !!PDFEditor.doc && UI.SCROLL_TOOLS.includes(AppState.currentTool); },

    _registerCommands() {
        const needDoc = fn => (...a) => { if (PDFEditor.doc) fn(...a); };
        const scrollOnly = fn => (...a) => { if (this._inScroll()) fn(...a); };
        UI.register({
            "open-tool": el => this.openTool(el.dataset.tool),
            "go-home": () => this.openTool("home"),
            "open-pdf": async () => {
                if (!this.ensureEngine()) return;
                const [file] = await FileManager.pickFiles({ kinds: ["pdf"] });
                if (file) this.openPdfFile(file);
            },
            "open-images": async () => {
                if (!this.ensureEngine()) return;
                this.openTool("images");
                const files = await FileManager.pickFiles({ kinds: ["image"], multiple: true });
                if (files.length) ImageToPDF.addImages(files);
            },
            "new-doc": async () => {
                if (!this.ensureEngine()) return;
                if (await PDFEditor.newDocument()) this.openTool("editor");
            },
            "save": needDoc(() => PDFEditor.save()),
            "save-as": needDoc(() => PDFEditor.save({ saveAs: true })),
            "download": needDoc(() => PDFEditor.save()),
            "close-doc": needDoc(() => PDFEditor.close()),
            "undo": needDoc(() => PDFEditor.undo()),
            "redo": needDoc(() => PDFEditor.redo()),
            "add-text": needDoc(() => PDFTextEditor.armAddText()),
            "add-signature": needDoc(() => PDFTextEditor.openSignatureDialog()),
            "add-highlight": needDoc(() => PDFTextEditor.addHighlight()),
            "select-tool": () => PDFTextEditor.setMode("select"),
            "delete": needDoc(() => PDFEditor.deleteSelected()),
            "select-all": needDoc(() => PDFEditor.selectAll()),
            "zoom-in": scrollOnly(() => PDFViewer.zoomIn()),
            "zoom-out": scrollOnly(() => PDFViewer.zoomOut()),
            "zoom-reset": scrollOnly(() => PDFViewer.resetZoom()),
            "fit-page": scrollOnly(() => PDFViewer.fitPage()),
            "fit-width": scrollOnly(() => PDFViewer.fitWidth()),
            "page-prev": scrollOnly(() => PDFViewer.prevPage()),
            "page-next": scrollOnly(() => PDFViewer.nextPage()),
            "toggle-thumbs": scrollOnly(() => PDFViewer.toggleThumbs()),
            "fullscreen": needDoc(() => PDFViewer.toggleFullscreen()),
            "rotate-page-cw": needDoc(() => PDFEditor.rotateCurrentPage(90)),
            "rotate-page-ccw": needDoc(() => PDFEditor.rotateCurrentPage(-90)),
            "cycle-theme": () => Theme.cycle(),
            "show-shortcuts": () => this.showShortcuts(),
            "show-privacy": () => this.showPrivacy(),
            "show-about": () => this.showAbout(),
            "show-version": () => Modal.alert({ title: "Version", message: `${APP_CONFIG.appName} version ${APP_CONFIG.version}`, icon: "info" })
        });
    },

    /* ------------------------------------------------------------ keyboard */
    _bindKeyboard() {
        document.addEventListener("keydown", e => {
            if (Modal.isOpen || Tour.active || e.isComposing) return;
            const mod = e.ctrlKey || e.metaKey;
            const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
            const inField = !!e.target.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
            const hasDoc = !!PDFEditor.doc;

            if (mod && key === "o") { e.preventDefault(); UI.run("open-pdf"); return; }
            if (mod && key === "s") { e.preventDefault(); if (hasDoc) UI.run(e.shiftKey ? "save-as" : "save"); return; }
            if (mod && (key === "z" || key === "y")) {
                if (inField || !hasDoc) return;            // let the browser undo typing inside fields
                e.preventDefault();
                if (key === "y" || e.shiftKey) PDFEditor.redo(); else PDFEditor.undo();
                return;
            }
            if (mod && this._inScroll() && ["+", "=", "-", "_", "0"].includes(key)) {
                e.preventDefault();
                if (key === "0") PDFViewer.resetZoom();
                else if (key === "-" || key === "_") PDFViewer.zoomOut();
                else PDFViewer.zoomIn();
                return;
            }
            if (mod || inField || e.defaultPrevented) return;

            if (PDFTextEditor.onKey(e)) { e.preventDefault(); return; }
            if ((key === "Delete") && hasDoc && UI.ORGANIZER_TOOLS.includes(AppState.currentTool) && AppState.selectedPages.length) {
                e.preventDefault();
                PDFPages.remove(PDFPages.selectedIds());
            }
        });
    },

    /* ------------------------------------------------------------ dialogs */
    showShortcuts() {
        const rows = [
            ["Ctrl + O", "Open PDF"], ["Ctrl + S", "Save PDF"], ["Ctrl + Shift + S", "Save As"],
            ["Ctrl + Z", "Undo"], ["Ctrl + Y / Ctrl + Shift + Z", "Redo"],
            ["Ctrl + + / Ctrl + -", "Zoom in / out"], ["Ctrl + 0", "Reset zoom"], ["Ctrl + mouse wheel", "Zoom"],
            ["Delete", "Delete selected object or page"], ["Escape", "Cancel the current action / leave text editing"],
            ["Enter", "Edit the selected text box"], ["Arrow keys", "Nudge selected object (Shift = 10×)"],
            ["Shift / Ctrl + click", "Select several objects or pages"], ["Ctrl + ← / →", "Move the focused page (Organize)"]
        ];
        const table = Utils.h("table", { class: "shortcut-table" }, Utils.h("tbody", {},
            rows.map(([k, d]) => Utils.h("tr", {}, Utils.h("td", {}, Utils.h("kbd", { text: k })), Utils.h("td", { text: d })))));
        Modal.open({ title: "Keyboard Shortcuts", content: table, size: "lg" });
    },

    showPrivacy() {
        Modal.open({
            title: "🔒 Local Processing", icon: "lock",
            content: Utils.h("div", { class: "stack" },
                Utils.h("p", { text: "Your files stay on your device." }),
                Utils.h("p", { text: "PDF processing happens locally in your browser. Documents are never uploaded to a server — there is no server component." }),
                Utils.h("p", { class: "muted", text: "The only network requests are server files. Closing the tab discards everything held in memory." }))
        });
    },

    showAbout() {
        Modal.open({
            title: `About ${APP_CONFIG.appName}`, icon: "info",
            content: Utils.h("div", { class: "stack" },
                Utils.h("p", { text: `${APP_CONFIG.appName} ${APP_CONFIG.version} — ${APP_CONFIG.tagline}.` }),
                Utils.h("div", { class: "about-credit" },
                    Utils.h("p", {}, Utils.h("strong", { text: "Developed By: " }), APP_CONFIG.developer.name),
                    Utils.h("p", {}, Utils.h("strong", { text: "Email: " }),
                        Utils.h("a", { href: `mailto:${APP_CONFIG.developer.email}`, text: APP_CONFIG.developer.email }))))
        });
    }
};

document.addEventListener("DOMContentLoaded", () => {
    App.start().catch(err => {
        Logger.error("Startup failed", err);
        UI.showError(new AppError("Unable to start", "The application failed to start. Please reload the page."), { actionLabel: "Reload", onAction: () => location.reload() });
    });
});
