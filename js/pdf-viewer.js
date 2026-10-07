/**
 * pdf-viewer.js — continuous-scroll page viewer and thumbnail renderer (PDF.js).
 *
 * Each page element contains synchronized layers, bottom to top:
 *   canvas      PDF render (re-rendered at the right resolution after zoom, debounced)
 *   .text-layer PDF.js text layer (selectable/copyable text)
 *   .sel-layer  hit boxes for existing text (used by the text editor)
 *   .annot-layer user-added objects (text boxes, cover rectangles)
 *
 * The three overlay layers are laid out in PDF points and scaled with ONE css variable (--s),
 * so a zoom change moves/scales all of them together without touching their contents.
 *   --s = zoom * PX_PER_PT,  page size = (--pw, --ph) points.
 *
 * Pages are rendered lazily (IntersectionObserver) and their canvases are released when they
 * scroll far away, so large documents stay light.
 */
"use strict";

const PDFViewer = {
    els: {},
    pageEls: new Map(),   // pageId -> element
    fitMode: null,        // null | "width" | "page"
    _io: null,
    _thumbIO: null,
    _thumbQueue: [],
    _thumbActive: 0,
    _thumbCache: new Map(),
    _needsInitialFit: true,

    init() {
        this.els = {
            workspace: document.getElementById("doc-workspace"),
            scroller: document.getElementById("pane-scroll"),
            pages: document.getElementById("pdf-pages"),
            thumbList: document.getElementById("thumb-list"),
            panel: document.getElementById("thumb-panel")
        };
        const { scroller, pages } = this.els;

        this._io = new IntersectionObserver(entries => {
            for (const entry of entries) {
                const el = entry.target;
                el._visible = entry.isIntersecting;
                if (entry.isIntersecting) this.renderPageEl(el);
                else this.releasePageEl(el);
            }
        }, { root: scroller, rootMargin: "800px 0px" });

        this._thumbIO = new IntersectionObserver(entries => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                this._thumbIO.unobserve(entry.target);
                this._thumbQueue.push(entry.target._job);
            }
            this._pumpThumbs();
        }, { rootMargin: "300px" });

        scroller.addEventListener("scroll", Utils.throttle(() => this.updateCurrentPage(), 80), { passive: true });
        // Ctrl + wheel zooms the document instead of the browser page.
        scroller.addEventListener("wheel", e => {
            if (!e.ctrlKey) return;
            e.preventDefault();
            this.setZoom(AppState.zoom + (e.deltaY < 0 ? 1 : -1) * APP_CONFIG.zoomStep);
        }, { passive: false });

        if ("ResizeObserver" in window) {
            new ResizeObserver(Utils.debounce(() => { if (this.fitMode) this.applyFit(); }, 120)).observe(scroller);
        }
        document.addEventListener("fullscreenchange", () => setTimeout(() => this.fitMode && this.applyFit(), 100));
        document.getElementById("page-input").addEventListener("change", e => {
            this.goToPage(Number(e.target.value) || 1);
        });
        this.applyScale();
        pages.dataset.tool = "viewer";
        if (window.matchMedia("(max-width: 700px)").matches) this.els.panel.classList.add("collapsed"); // thumbnails are opt-in on phones
    },

    /* ----------------------------------------------------------- geometry */
    scale() { return AppState.zoom * Utils.PX_PER_PT; },

    applyScale() { this.els.pages.style.setProperty("--s", String(this.scale())); },

    /** Setting that decides which interactions the page layers allow ("viewer" | "editor" | ...). */
    setTool(tool) { this.els.pages.dataset.tool = tool; },

    /* ----------------------------------------------------------- page list */
    /** Rebuild the page list from PDFEditor.doc, re-using existing page elements. */
    syncPages() {
        const doc = PDFEditor.doc;
        if (!doc) { this.reset(); return; }
        const container = this.els.pages;
        const old = this.pageEls;
        const next = new Map();
        const frag = document.createDocumentFragment();
        const rerender = [];

        doc.pages.forEach((page, i) => {
            let el = old.get(page.id);
            const rot = PDFEditor.totalRotation(page);
            if (el && el._rot !== rot) { this.releasePageEl(el); rerender.push(el); }  // rotation changed
            if (!el) el = this.createPageEl(page);
            this.layoutPageEl(el, page, i);
            frag.append(el);
            next.set(page.id, el);
            old.delete(page.id);
        });
        for (const el of old.values()) this.destroyPageEl(el);        // pages that were deleted
        container.replaceChildren(frag);
        this.pageEls = next;
        // The observer only fires on visibility *changes*, so re-render rotated pages that are on screen.
        rerender.forEach(el => { if (el._visible) this.renderPageEl(el); });

        const total = doc.pages.length;
        AppState.set({ totalPages: total, currentPage: Utils.clamp(AppState.currentPage, 1, Math.max(total, 1)) });
        this.buildThumbs();
        this.highlightThumb(AppState.currentPage);
        Events.emit("viewer:pages-synced");
    },

    createPageEl(page) {
        const el = Utils.h("div", { class: "pdf-page", dataset: { pageId: page.id } },
            Utils.h("canvas", { class: "page-canvas" }),
            Utils.h("div", { class: "text-layer textLayer pt-layer" }),
            Utils.h("div", { class: "sel-layer pt-layer" }),
            Utils.h("div", { class: "annot-layer pt-layer" }),
            Utils.h("span", { class: "page-badge", "aria-hidden": "true" }));
        el._token = 0; el._visible = false; el._rot = null; el._task = null; el._textDone = false; el._px = 0;
        this._io.observe(el);
        Events.emit("viewer:page-built", { pageEl: el, page });
        return el;
    },

    layoutPageEl(el, page, index) {
        const { w, h } = PDFEditor.displaySize(page);
        el.style.setProperty("--pw", String(w));
        el.style.setProperty("--ph", String(h));
        el._rot = PDFEditor.totalRotation(page);
        el.dataset.index = String(index);
        el.querySelector(".page-badge").textContent = String(index + 1);
        el.setAttribute("aria-label", `Page ${index + 1}`);
    },

    destroyPageEl(el) {
        this._io.unobserve(el);
        el._token++;
        el._task?.cancel();
        const canvas = el.querySelector("canvas");
        canvas.width = canvas.height = 0;
        el.remove();
    },

    /** Free the heavy parts (bitmap, text DOM) of a page that is far off-screen. */
    releasePageEl(el) {
        el._token++;
        el._task?.cancel();
        el._task = null;
        const canvas = el.querySelector("canvas");
        canvas.width = canvas.height = 0;
        el.classList.remove("rendered");
        el.querySelector(".text-layer").replaceChildren();
        el._textDone = false;
        el._px = 0;
    },

    /* ----------------------------------------------------------- rendering */
    async renderPageEl(el) {
        const page = PDFEditor.getPage(el.dataset.pageId);
        if (!page) return;
        const token = ++el._token;
        const rot = PDFEditor.totalRotation(page);
        const { w, h } = PDFEditor.displaySize(page);
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        let px = this.scale() * dpr;                                   // bitmap pixels per point
        if (w * px * h * px > Utils.maxCanvasPixels()) px = Math.sqrt(Utils.maxCanvasPixels() / (w * h));
        const canvas = el.querySelector("canvas");

        try {
            const off = document.createElement("canvas");              // draw off-screen, swap when done (no flicker)
            off.width = Math.max(1, Math.floor(w * px));
            off.height = Math.max(1, Math.floor(h * px));
            const ctx = off.getContext("2d");
            let proxy = null;
            if (page.blank) {
                ctx.fillStyle = "#fff";
                ctx.fillRect(0, 0, off.width, off.height);
            } else {
                proxy = await PDFEditor.getPdfPage(page);
                if (token !== el._token) return;
                const viewport = proxy.getViewport({ scale: px, rotation: rot });
                el._task?.cancel();
                el._task = proxy.render({ canvasContext: ctx, viewport });
                await el._task.promise;
            }
            if (token !== el._token) return;
            canvas.width = off.width;
            canvas.height = off.height;
            canvas.getContext("2d").drawImage(off, 0, 0);
            off.width = off.height = 0;
            el._px = px;
            el.classList.add("rendered");

            if (proxy && !el._textDone) await this._buildTextLayer(el, page, proxy, rot, token);
            Events.emit("viewer:page-rendered", { pageEl: el, page, canvas });
        } catch (err) {
            if (err?.name === "RenderingCancelledException") return;
            Logger.error("Page render failed", err);
            el.classList.add("render-error");
        }
    },

    async _buildTextLayer(el, page, proxy, rot, token) {
        const layer = el.querySelector(".text-layer");
        const content = await PDFEditor.getTextContent(page);
        if (token !== el._token) return;
        layer.replaceChildren();
        // Rendered once at scale 1 (points); the --s transform scales it together with everything else.
        const viewport = proxy.getViewport({ scale: 1, rotation: rot });
        const task = pdfjsLib.renderTextLayer({ textContentSource: content, container: layer, viewport, textDivs: [] });
        await task.promise;
        el._textDone = true;
    },

    _rerenderSoon: null, // set in constructor-like block below

    _rerenderVisible() {
        const needed = this.scale() * Math.min(window.devicePixelRatio || 1, 2);
        for (const el of this.pageEls.values()) {
            if (el._visible && el.classList.contains("rendered") && Math.abs(el._px - needed) / needed > 0.12) {
                this.renderPageEl(el);
            }
        }
    },

    /** Re-render one page (e.g. after its rotation changed). */
    refreshPage(pageId) {
        const el = this.pageEls.get(pageId);
        if (el) { this.releasePageEl(el); if (el._visible) this.renderPageEl(el); }
    },

    /* ----------------------------------------------------------- zoom */
    setZoom(zoom, { fit = null } = {}) {
        const z = Math.round(Utils.clamp(zoom, APP_CONFIG.minZoom, APP_CONFIG.maxZoom) * 1000) / 1000;
        const { scroller } = this.els;
        this.fitMode = fit;
        // Keep the vertical centre of the view stable across the zoom.
        const ratio = scroller.scrollHeight ? (scroller.scrollTop + scroller.clientHeight / 2) / scroller.scrollHeight : 0;
        AppState.set({ zoom: z });
        this.applyScale();
        if (scroller.scrollHeight && scroller.clientHeight) {
            scroller.scrollTop = ratio * scroller.scrollHeight - scroller.clientHeight / 2;
        }
        this._rerenderSoon();
        Events.emit("viewer:zoom", { zoom: z });
    },

    zoomIn() { this.setZoom(AppState.zoom + APP_CONFIG.zoomStep); },
    zoomOut() { this.setZoom(AppState.zoom - APP_CONFIG.zoomStep); },
    resetZoom() { this.setZoom(APP_CONFIG.defaultZoom); },
    fitWidth() { this.setZoom(this._fitZoom("width"), { fit: "width" }); },
    fitPage() { this.setZoom(this._fitZoom("page"), { fit: "page" }); },

    applyFit() { if (this.fitMode) this.setZoom(this._fitZoom(this.fitMode), { fit: this.fitMode }); },

    _fitZoom(mode) {
        const doc = PDFEditor.doc;
        const { scroller } = this.els;
        if (!doc || !scroller.clientWidth) return AppState.zoom;
        const availW = scroller.clientWidth - 48, availH = scroller.clientHeight - 48;
        if (mode === "width") {
            const maxW = doc.pages.reduce((m, p) => Math.max(m, PDFEditor.displaySize(p).w), 0);   // no spread: works for any page count
            return availW / (maxW * Utils.PX_PER_PT);
        }
        const page = doc.pages[AppState.currentPage - 1] || doc.pages[0];
        const { w, h } = PDFEditor.displaySize(page);
        return Math.min(availW / (w * Utils.PX_PER_PT), availH / (h * Utils.PX_PER_PT));
    },

    /** Called whenever the scroll workspace becomes visible. */
    onShown() {
        if (this._needsInitialFit && PDFEditor.doc && this.els.scroller.clientWidth) {
            this._needsInitialFit = false;
            this.setZoom(Math.min(APP_CONFIG.defaultZoom, this._fitZoom("width")), { keepCenter: false });
        }
        this._io.takeRecords(); // IntersectionObserver re-reports visibility on its own
        this.updateCurrentPage();
    },

    /* ----------------------------------------------------------- navigation */
    updateCurrentPage() {
        const { scroller, pages } = this.els;
        const kids = pages.children;
        if (!kids.length || !scroller.clientHeight) return;
        const y = scroller.scrollTop - pages.offsetTop + scroller.clientHeight * 0.35;
        let lo = 0, hi = kids.length - 1;
        while (lo < hi) {                                   // last page whose top <= y
            const mid = (lo + hi + 1) >> 1;
            if (kids[mid].offsetTop <= y) lo = mid; else hi = mid - 1;
        }
        const n = lo + 1;
        if (n !== AppState.currentPage) {
            AppState.set({ currentPage: n });
            this.highlightThumb(n);
        }
    },

    goToPage(n) {
        const total = AppState.totalPages;
        if (!total) return;
        n = Utils.clamp(Math.round(n), 1, total);
        const el = this.els.pages.children[n - 1];
        if (el) this.els.scroller.scrollTop = el.offsetTop + this.els.pages.offsetTop - 16;
        AppState.set({ currentPage: n });
        this.highlightThumb(n);
        document.getElementById("page-input").value = String(n);
    },

    nextPage() { this.goToPage(AppState.currentPage + 1); },
    prevPage() { this.goToPage(AppState.currentPage - 1); },

    toggleThumbs() { this.els.panel.classList.toggle("collapsed"); },

    toggleFullscreen() {
        const el = this.els.workspace;
        if (!el.requestFullscreen) { Toast.info("Fullscreen is not supported in this browser."); return; }
        if (document.fullscreenElement) document.exitFullscreen();
        else el.requestFullscreen().catch(() => Toast.warning("Could not enter fullscreen."));
    },

    getPageEl(pageId) { return this.pageEls.get(pageId) || null; },

    /* ----------------------------------------------------------- thumbnails */
    buildThumbs() {
        const doc = PDFEditor.doc;
        const list = this.els.thumbList;
        list.replaceChildren();
        if (!doc) return;
        doc.pages.forEach((page, i) => {
            const canvas = Utils.h("canvas");
            this.observeThumb(canvas, page, 110);
            list.append(Utils.h("button", {
                type: "button", class: "thumb-item", dataset: { page: i + 1 },
                "aria-label": `Go to page ${i + 1}`, onclick: () => this.goToPage(i + 1)
            }, canvas, Utils.h("span", { text: String(i + 1) })));
        });
    },

    highlightThumb(n) {
        const list = this.els.thumbList;
        let active = null;
        for (const btn of list.children) {
            const on = Number(btn.dataset.page) === n;
            btn.classList.toggle("active", on);
            if (on) { btn.setAttribute("aria-current", "true"); active = btn; } else btn.removeAttribute("aria-current");
        }
        if (active && list.offsetParent) {
            const top = active.offsetTop, bottom = top + active.offsetHeight;
            if (top < list.scrollTop) list.scrollTop = top - 8;
            else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight + 8;
        }
    },

    /** Reserve the right size immediately and render the bitmap when the canvas scrolls into view. */
    observeThumb(canvas, page, maxW) {
        const { w, h } = PDFEditor.displaySize(page);
        canvas.style.width = `${maxW}px`;
        canvas.style.height = `${Math.round(maxW * h / w)}px`;
        canvas.width = canvas.height = 1;      // placeholder: no bitmap memory until it scrolls into view
        canvas._job = () => this.renderThumb(page, canvas, maxW);
        this._thumbIO.observe(canvas);
    },

    async renderThumb(page, canvas, maxW) {
        if (!canvas.isConnected) return;
        const { w, h } = PDFEditor.displaySize(page);
        const rot = PDFEditor.totalRotation(page);
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const pxW = Math.round(maxW * dpr), pxH = Math.round(pxW * h / w);
        const key = page.blank ? `blank:${w}x${h}` : `${page.src}:${page.idx}:${rot}`;
        canvas.width = pxW; canvas.height = pxH;
        const ctx = canvas.getContext("2d");
        const cached = this._thumbCache.get(key);
        if (cached && cached.width === pxW) { ctx.drawImage(cached, 0, 0); return; }

        if (page.blank) {
            ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, pxW, pxH);
        } else {
            const proxy = await PDFEditor.getPdfPage(page);
            if (!canvas.isConnected) return;
            const viewport = proxy.getViewport({ scale: pxW / w, rotation: rot });
            await proxy.render({ canvasContext: ctx, viewport }).promise;
        }
        const copy = document.createElement("canvas");
        copy.width = pxW; copy.height = pxH;
        copy.getContext("2d").drawImage(canvas, 0, 0);
        this._thumbCache.set(key, copy);
        if (this._thumbCache.size > Math.max(400, (PDFEditor.doc?.pages.length || 0) * 2)) {   // scales with the document
            const oldest = this._thumbCache.keys().next().value;
            this._thumbCache.get(oldest).width = 0;
            this._thumbCache.delete(oldest);
        }
    },

    _pumpThumbs() {
        while (this._thumbActive < 2 && this._thumbQueue.length) {
            const job = this._thumbQueue.shift();
            this._thumbActive++;
            Promise.resolve().then(job)
                .catch(err => Logger.warn("Thumbnail failed", err))
                .finally(() => { this._thumbActive--; this._pumpThumbs(); });
        }
    },

    /* ----------------------------------------------------------- lifecycle */
    /** Drop every page and thumbnail (document closed). */
    reset() {
        for (const el of this.pageEls.values()) this.destroyPageEl(el);
        this.pageEls.clear();
        this.els.pages.replaceChildren();
        this.els.thumbList.replaceChildren();
        this._thumbQueue.length = 0;
        for (const c of this._thumbCache.values()) c.width = 0;
        this._thumbCache.clear();
        this.fitMode = null;
        this._needsInitialFit = true;
        this.els.scroller.scrollTop = 0;
    },

    cleanup() { this.reset(); },

    destroy() {
        this.reset();
        this._io?.disconnect();
        this._thumbIO?.disconnect();
    }
};
PDFViewer._rerenderSoon = Utils.debounce(() => PDFViewer._rerenderVisible(), 180);
