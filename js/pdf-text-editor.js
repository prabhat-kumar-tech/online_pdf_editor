/**
 * pdf-text-editor.js — annotation layer editing: add text, replace existing text, move, resize, style.
 *
 * Object model (stored in PDFEditor.doc.objects[pageId], saved in undo snapshots):
 *   { id, type:"text"|"rect", page, text, x, y, w, h, fontFamily, fontSize, color,
 *     bold, italic, underline, align, opacity, rotation, autoWidth, sourceKey? }
 * Coordinates are DISPLAY space in PDF points (origin top-left of the rotated page, y down);
 * (x, y, w, h) is the unrotated box, rotated clockwise by `rotation` degrees about its centre.
 * The annotation layer is itself laid out in points and scaled by CSS (see pdf-viewer.js), so
 * zooming never changes these numbers.
 *
 * How "editing existing text" works (and its honest limits): PDF text is positioned glyphs in
 * embedded fonts, not an editable string. Clicking a text run creates (1) a cover rectangle in
 * the sampled background colour over the original run and (2) a text box with the same string,
 * size and sampled colour. On export both are drawn on top of the page. The original glyphs stay in
 * the file underneath (hidden by the cover), and replacement text uses a standard PDF font.
 */
"use strict";

const PDFTextEditor = {
    mode: "select",                 // "select" | "add"
    defaults: null,
    selection: [],                  // ids; the last one is the "primary"
    editing: null,                  // object currently being typed into
    _els: new Map(),                // objectId -> element
    _transient: new Map(),          // objectId -> { isNew, original, x0, y0, coverId, startText }
    _drag: null,
    _nudgeTimer: null,

    PLAIN: (() => {
        const d = document.createElement("div");
        d.setAttribute("contenteditable", "plaintext-only");
        return d.contentEditable === "plaintext-only";
    })(),

    FONT_STACK: {
        "Arial": 'Arial, Helvetica, "Liberation Sans", sans-serif',
        "Times New Roman": '"Times New Roman", Times, "Liberation Serif", serif',
        "Courier New": '"Courier New", Courier, "Liberation Mono", monospace'
    },

    init() {
        this.defaults = {
            fontFamily: APP_CONFIG.defaultFont, fontSize: APP_CONFIG.defaultFontSize, color: APP_CONFIG.defaultTextColor,
            bold: false, italic: false, underline: false, align: "left", opacity: 1
        };
        this.tb = document.getElementById("float-toolbar");
        this._initToolbar();

        Events.on("viewer:page-built", ({ pageEl, page }) => this._mountPage(pageEl, page));
        Events.on("viewer:page-rendered", ({ pageEl, page }) => this._maybeBuildHits(pageEl, page));
        Events.on("viewer:zoom", () => this.positionToolbar());
        window.addEventListener("resize", Utils.throttle(() => this.positionToolbar(), 100));
        document.getElementById("pane-scroll").addEventListener("scroll", Utils.throttle(() => this.positionToolbar(), 50), { passive: true });

        // Clicking empty page area deselects (the add-mode and hit-box handlers call preventDefault first).
        document.getElementById("pane-scroll").addEventListener("pointerdown", e => {
            if (AppState.currentTool !== "editor" || e.defaultPrevented || this.mode === "add") return;
            if (e.target.closest(".annot, .hit, .float-toolbar")) return;
            this.select([]);
        });
        document.getElementById("btn-banner-close").addEventListener("click", () => { document.getElementById("editor-banner").hidden = true; });
    },

    /* ============================================================ object store */
    _objects() { return PDFEditor.doc?.objects || {}; },
    _list(pageId) { const o = this._objects(); return (o[pageId] ||= []); },
    _find(id) {
        for (const list of Object.values(this._objects())) {
            const hit = list.find(o => o.id === id);
            if (hit) return hit;
        }
        return null;
    },
    _primary() { return this.selection.length ? this._find(this.selection[this.selection.length - 1]) : null; },

    /* ============================================================ rendering */
    _mountPage(pageEl, page) {
        const layer = pageEl.querySelector(".annot-layer");
        layer.addEventListener("pointerdown", e => {
            if (e.target !== layer || this.mode !== "add" || AppState.currentTool !== "editor") return;
            e.preventDefault();
            const pt = this._ptFromEvent(e, layer);
            this.addTextAt(pageEl.dataset.pageId, pt.x, pt.y);
        });
        this._renderInto(layer, page.id);
    },

    _renderInto(layer, pageId) {
        layer.replaceChildren();
        for (const obj of this._list(pageId)) {
            const el = this._createEl(obj);
            this._els.set(obj.id, el);
            layer.append(el);
        }
    },

    renderPageObjects(pageId) {
        const pageEl = PDFViewer.getPageEl(pageId);
        if (!pageEl) return;
        this._renderInto(pageEl.querySelector(".annot-layer"), pageId);
        this._paintSelection();
    },

    /** Rebuild every page's objects (after undo/redo/page changes). */
    renderAll() {
        const doc = PDFEditor.doc;
        this.editing = null;
        this._transient.clear();
        this._els.clear();
        if (!doc) return;
        for (const page of doc.pages) {
            this.renderPageObjects(page.id);
            const el = PDFViewer.getPageEl(page.id);
            if (el) el._hitsRot = null;
        }
        const alive = this.selection.filter(id => this._find(id));
        this.selection = alive;
        AppState.set({ selectedObject: alive[alive.length - 1] || null });
        this._paintSelection();
        this._rebuildAllHits();
        this.syncToolbar();
        this.positionToolbar();
    },

    _createEl(obj) {
        const el = Utils.h("div", { class: `annot annot-${obj.type}`, dataset: { objId: obj.id } });
        if (obj.type === "text") {
            const content = Utils.h("div", { class: "annot-content", spellcheck: "false", "aria-label": "Text box", role: "textbox", "aria-multiline": "true" });
            content.textContent = obj.text;
            el.append(content);
            el._content = content;
            content.addEventListener("input", () => {
                obj.text = this._readText(content);
                this._measure(obj, el);
                this.positionToolbar();
            });
            content.addEventListener("keydown", e => {
                e.stopPropagation();
                if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) { e.preventDefault(); this.finishEditing(); el.focus(); }
            });
            content.addEventListener("paste", e => {
                e.preventDefault();
                document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
            });
            content.addEventListener("blur", () => setTimeout(() => {
                if (this.editing === obj && !this.tb.contains(document.activeElement)) this.finishEditing();
            }, 0));
            el.tabIndex = 0;
            el.addEventListener("dblclick", () => { if (AppState.currentTool === "editor") this.startEditing(obj); });
        }
        if (obj.type === "image") {
            el.append(Utils.h("img", { src: PDFEditor.imageUrl(obj.imageId), alt: "Image", draggable: "false" }));
        }
        el.append(Utils.h("span", { class: "annot-handle", "aria-hidden": "true" }));
        el.addEventListener("pointerdown", e => this._onObjectDown(e, obj, el));
        this._applyStyle(obj, el);
        return el;
    },

    _applyStyle(obj, el) {
        const s = el.style;
        s.left = `${obj.x}px`;
        s.top = `${obj.y}px`;
        s.transform = `rotate(${obj.rotation || 0}deg)`;
        s.opacity = String(obj.opacity ?? 1);
        if (obj.type === "rect" || obj.type === "image") {
            s.width = `${obj.w}px`; s.height = `${obj.h}px`;
            if (obj.type === "rect") s.background = obj.color;
            return;
        }
        s.fontFamily = this.FONT_STACK[obj.fontFamily] || this.FONT_STACK.Arial;
        s.fontSize = `${obj.fontSize}px`;
        s.color = obj.color;
        s.fontWeight = obj.bold ? "700" : "400";
        s.fontStyle = obj.italic ? "italic" : "normal";
        s.textDecoration = obj.underline ? "underline" : "none";
        s.textAlign = obj.align;
        el.classList.toggle("fixed-width", !obj.autoWidth);
        s.width = obj.autoWidth ? "max-content" : `${obj.w}px`;
    },

    /** Read the laid-out size back from the DOM (layout sizes are unaffected by zoom/rotation transforms). */
    _measure(obj, el) {
        if (obj.type !== "text") return;
        const w = el.offsetWidth, h = el.offsetHeight;
        if (w > 0) obj.w = w;
        if (h > 0) obj.h = h;
    },

    _readText(content) { return content.innerText.replace(/\n$/, ""); },

    _ptFromEvent(e, layer) {
        const r = layer.getBoundingClientRect();
        const s = r.width / (layer.offsetWidth || 1);       // current css scale of the layer
        return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s };
    },

    _scaleOf(el) {
        const layer = el.parentElement;
        return layer.getBoundingClientRect().width / (layer.offsetWidth || 1);
    },

    /* ============================================================ modes */
    setMode(mode) {
        this.mode = mode;
        PDFViewer.els.pages.classList.toggle("adding", mode === "add");
        document.getElementById("btn-tool-addtext").setAttribute("aria-pressed", String(mode === "add"));
        document.getElementById("btn-tool-select").setAttribute("aria-pressed", String(mode !== "add"));
        if (mode === "add") { this.select([]); }
        this.syncToolbar();
        this.positionToolbar();
    },

    /** Menu / button: arm "click to place text" on the editor tool. */
    armAddText() {
        if (!PDFEditor.doc) { Toast.info("Open a PDF first."); return; }
        if (AppState.currentTool !== "editor") App.openTool("editor");
        this.setMode("add");
        Toast.info("Click on the page where the text should go.", { duration: 2500 });
    },

    /** PDFEditor.addText(options) entry: place text at (x, y) on a page, or at the middle of the current page. */
    addText(options = {}) {
        const doc = PDFEditor.doc;
        if (!doc) return null;
        if (AppState.currentTool !== "editor") App.openTool("editor");
        const page = doc.pages[AppState.currentPage - 1] || doc.pages[0];
        const { w, h } = PDFEditor.displaySize(page);
        return this.addTextAt(options.pageId || page.id, options.x ?? w / 4, options.y ?? h / 3, options);
    },

    addTextAt(pageId, x, y, opts = {}) {
        const d = { ...this.defaults, ...opts };
        const obj = {
            id: Utils.uid("obj"), type: "text", page: pageId, text: opts.text ?? "",
            x, y: y - d.fontSize * 0.6, w: 20, h: d.fontSize * 1.2, rotation: 0, autoWidth: true,
            fontFamily: d.fontFamily, fontSize: d.fontSize, color: d.color, bold: d.bold, italic: d.italic,
            underline: d.underline, align: d.align, opacity: d.opacity
        };
        this._list(pageId).push(obj);
        this._transient.set(obj.id, { isNew: true });
        this.renderPageObjects(pageId);
        this.setMode("select");
        this.select([obj.id]);
        this.startEditing(obj);
        return obj;
    },

    /* ============================================================ highlight, images, signatures */
    /** Size of a text object as it will lay out (canvas metrics; used for programmatic text such as stamps). */
    measureObject(obj) {
        const ctx = (this._mctx ||= document.createElement("canvas").getContext("2d"));
        ctx.font = `${obj.italic ? "italic " : ""}${obj.bold ? 700 : 400} ${obj.fontSize}px ${this.FONT_STACK[obj.fontFamily] || this.FONT_STACK.Arial}`;
        const lines = String(obj.text).split("\n");
        return { w: Math.max(...lines.map(l => ctx.measureText(l).width)), h: lines.length * obj.fontSize * 1.2 };
    },

    _currentPage() { return PDFEditor.doc.pages[AppState.currentPage - 1] || PDFEditor.doc.pages[0]; },

    /** A semi-transparent yellow box to move/resize over text (colour and opacity via the floating toolbar). */
    addHighlight() {
        if (!PDFEditor.doc) { Toast.info("Open a PDF first."); return; }
        if (AppState.currentTool !== "editor") App.openTool("editor");
        const page = this._currentPage(), { w } = PDFEditor.displaySize(page);
        const obj = { id: Utils.uid("obj"), type: "rect", page: page.id, x: w * 0.2, y: 120, w: Math.min(220, w * 0.6), h: 20, rotation: 0, color: "#fde047", opacity: 0.45 };
        this._list(page.id).push(obj);
        PDFEditor.commit("Add highlight");
        this.renderPageObjects(page.id);
        this.select([obj.id]);
        Toast.info("Drag the box over the text and resize it with the corner handle.", { duration: 3500 });
    },

    /** Draw a signature or upload an image, then place it on the current page. */
    async openSignatureDialog() {
        if (!PDFEditor.doc) { Toast.info("Open a PDF first."); return; }
        if (AppState.currentTool !== "editor") App.openTool("editor");
        const canvas = Utils.h("canvas", { class: "sig-canvas", "aria-label": "Draw your signature here" });
        const dpr = 2, W = 460, H = 180;
        canvas.width = W * dpr; canvas.height = H * dpr;
        const ctx = canvas.getContext("2d");
        ctx.scale(dpr, dpr); ctx.lineWidth = 2.6; ctx.lineCap = ctx.lineJoin = "round";
        let drawing = false, drawn = false, last = null;
        const pos = e => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * W / r.width, y: (e.clientY - r.top) * H / r.height }; };
        canvas.addEventListener("pointerdown", e => {
            drawing = true; last = pos(e); canvas.setPointerCapture(e.pointerId);
            ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(last.x + 0.01, last.y); ctx.stroke(); drawn = true;
        });
        canvas.addEventListener("pointermove", e => {
            if (!drawing) return;
            const p = pos(e);
            ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p;
        });
        ["pointerup", "pointercancel"].forEach(t => canvas.addEventListener(t, () => { drawing = false; }));
        const color = Utils.h("select", { class: "input input-sm", "aria-label": "Pen colour" },
            [["#111827", "Black"], ["#1d4ed8", "Blue"], ["#b91c1c", "Red"]].map(([v, t]) => Utils.h("option", { value: v, text: t })));
        color.addEventListener("change", () => { ctx.strokeStyle = color.value; });
        ctx.strokeStyle = color.value;
        const content = Utils.h("div", { class: "stack" },
            Utils.h("p", { class: "muted", text: "Draw with your mouse, finger or pen — or upload an image (a PNG with a transparent background works best)." }),
            canvas,
            Utils.h("div", { class: "inline" },
                color,
                Utils.h("button", { type: "button", class: "btn btn-sm", text: "Clear", onclick: () => { ctx.clearRect(0, 0, W, H); drawn = false; } }),
                Utils.h("button", {
                    type: "button", class: "btn btn-sm", text: "Upload image…", onclick: async () => {
                        const [file] = FileManager.filter(await FileManager.pickFiles({ kinds: ["image"] }), ["image"]);
                        if (file) Modal.close(file);
                    }
                })));
        const result = await Modal.open({
            title: "Add signature or image", content, size: "lg",
            actions: [{ label: "Cancel", value: null }, { label: "Add to page", value: "draw", variant: "primary" }]
        });
        if (!result) return;
        try {
            if (result === "draw") {
                if (!drawn) { Toast.warning("Draw your signature first."); return; }
                await this._placeImage(await this._trimmedPng(canvas));
            } else {
                await this._placeImage(await this._fileToPng(result));
            }
        } catch (err) { UI.showError(err instanceof AppError ? err : new AppError("Unable to add image", "The image could not be read.")); }
    },

    async _trimmedPng(canvas) {
        const { width: w, height: h } = canvas, data = canvas.getContext("2d").getImageData(0, 0, w, h).data;
        let x0 = w, y0 = h, x1 = 0, y1 = 0;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            if (data[(y * w + x) * 4 + 3] > 8) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
        }
        const pad = 6, sx = Math.max(0, x0 - pad), sy = Math.max(0, y0 - pad);
        const sw = Math.min(w - sx, x1 - x0 + 2 * pad), sh = Math.min(h - sy, y1 - y0 + 2 * pad);
        const out = document.createElement("canvas"); out.width = sw; out.height = sh;
        out.getContext("2d").drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
        return this._canvasPng(out);
    },

    /** Any supported image -> PNG bytes (max 1600 px side so memory stays small). */
    async _fileToPng(file) {
        const url = FileManager.createUrl(file, "tmp");
        try {
            const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("decode")); i.src = url; });
            const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
            const c = document.createElement("canvas");
            c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
            c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
            return this._canvasPng(c);
        } finally { FileManager.revokeUrl(url); }
    },

    async _canvasPng(canvas) {
        const blob = await new Promise(r => canvas.toBlob(r, "image/png"));
        const out = { bytes: new Uint8Array(await blob.arrayBuffer()), w: canvas.width, h: canvas.height };
        canvas.width = canvas.height = 0;
        return out;
    },

    _placeImage({ bytes, w, h }) {
        const page = this._currentPage(), size = PDFEditor.displaySize(page);
        const imageId = PDFEditor.addImage(bytes);
        const ow = Math.min(200, size.w * 0.4), oh = ow * h / w;
        const obj = { id: Utils.uid("obj"), type: "image", page: page.id, imageId, aspect: w / h, x: (size.w - ow) / 2, y: (size.h - oh) / 3, w: ow, h: oh, rotation: 0, opacity: 1 };
        this._list(page.id).push(obj);
        PDFEditor.commit("Add image");
        this.renderPageObjects(page.id);
        this.select([obj.id]);
    },

    /* ============================================================ editing existing text */
    _maybeBuildHits(pageEl, page) {
        if (AppState.currentTool !== "editor") return;
        if (pageEl._hitsRot === PDFEditor.totalRotation(page)) return;
        this._buildHits(pageEl, page);
    },

    _rebuildAllHits() {
        if (AppState.currentTool !== "editor") return;
        for (const [id, el] of PDFViewer.pageEls) {
            const page = PDFEditor.getPage(id);
            if (page && el.classList.contains("rendered")) this._buildHits(el, page);
        }
    },

    /** Clickable boxes over each existing text run (from PDF.js text content). */
    async _buildHits(pageEl, page) {
        if (page.blank) { pageEl._hitsRot = PDFEditor.totalRotation(page); return; }
        const R = PDFEditor.totalRotation(page);
        pageEl._hitsRot = R;
        const content = await PDFEditor.getTextContent(page);
        if (pageEl._hitsRot !== R) return;
        const layer = pageEl.querySelector(".sel-layer");
        const consumed = new Set(this._list(page.id).filter(o => o.sourceKey).map(o => o.sourceKey));
        const frag = document.createDocumentFragment();
        content.items.forEach((item, i) => {
            if (!item.str || !item.str.trim() || !(item.width > 0)) return;
            const key = `${page.id}:${i}`;
            if (consumed.has(key)) return;
            const g = this._itemGeom(item, page, R);
            const hit = Utils.h("div", { class: "hit", dataset: { key } });
            hit.style.cssText = `left:${g.cx - g.w / 2}px;top:${g.cy - g.h / 2}px;width:${g.w}px;height:${g.h}px;transform:rotate(${g.angle}deg)`;
            hit.addEventListener("pointerdown", e => {
                e.preventDefault();
                this._editExisting(pageEl, page, content, item, key, g);
            });
            frag.append(hit);
        });
        layer.replaceChildren(frag);
    },

    /**
     * Geometry of a PDF.js text run in display space.
     * item.transform = [a b c d e f] in USER space; (e,f) = baseline start, (a,b) = text direction.
     * Box convention matches .annot-text: line box 1.2*fs tall, baseline 0.946*fs below its top,
     * so the box centre is 0.346*fs above the baseline (towards the "up" vector v).
     */
    _itemGeom(item, page, R) {
        const [a, b, c, d, e, f] = item.transform;
        const fs = Math.hypot(a, b) || Math.hypot(c, d) || 10;
        const ux = a / fs, uy = b / fs;            // along the text
        const vx = -uy, vy = ux;                   // "up" for the text
        const w = item.width;
        const centerUser = { x: e + ux * w / 2 + vx * 0.346 * fs, y: f + uy * w / 2 + vy * 0.346 * fs };
        const C = Utils.userToDisplay(centerUser.x, centerUser.y, page.geom, R);
        const O = Utils.userToDisplay(e, f, page.geom, R);
        const O2 = Utils.userToDisplay(e + ux, f + uy, page.geom, R);
        const angle = Math.round(Math.atan2(O2.y - O.y, O2.x - O.x) * 1800 / Math.PI) / 10;
        return { fs, w, h: fs * 1.2, cx: C.x, cy: C.y, angle };
    },

    _editExisting(pageEl, page, content, item, key, g) {
        this.finishEditing();
        const style = content.styles?.[item.fontName]?.fontFamily || "";
        const fontFamily = /mono/i.test(style) ? "Courier New" : /serif/i.test(style) && !/sans/i.test(style) ? "Times New Roman" : "Arial";
        const colors = this._sampleColors(pageEl, g);

        const rect = {
            id: Utils.uid("obj"), type: "rect", page: page.id, sourceKey: key,
            x: g.cx - (g.w + 2) / 2, y: g.cy - (g.h * 0.92) / 2, w: g.w + 2, h: g.h * 0.92,
            rotation: g.angle, color: colors.bg, opacity: 1
        };
        const text = {
            id: Utils.uid("obj"), type: "text", page: page.id, sourceKey: key, text: item.str,
            x: g.cx - g.w / 2, y: g.cy - g.h / 2, w: g.w, h: g.h, rotation: g.angle, autoWidth: true,
            fontFamily, fontSize: Math.round(g.fs * 10) / 10, color: colors.fg, bold: false, italic: false,
            underline: false, align: "left", opacity: 1
        };
        const list = this._list(page.id);
        list.push(rect, text);
        this._transient.set(text.id, { original: item.str, x0: text.x, y0: text.y, coverId: rect.id });
        this.renderPageObjects(page.id);
        this._buildHits(pageEl, page);
        this.select([text.id]);
        this.startEditing(text, { selectAll: true });
    },

    /** Estimate background (most common border colour) and ink colour (pixel farthest from it). */
    _sampleColors(pageEl, g) {
        const fallback = { bg: "#ffffff", fg: "#000000" };
        const canvas = pageEl.querySelector("canvas");
        if (!canvas.width) return fallback;
        const k = canvas.width / (parseFloat(pageEl.style.getPropertyValue("--pw")) || 1);
        const rot = ((g.angle % 180) + 180) % 180;
        const swap = Math.abs(rot - 90) < 45;
        const bw = swap ? g.h : g.w, bh = swap ? g.w : g.h;
        const x = Math.max(0, Math.floor((g.cx - bw / 2) * k)), y = Math.max(0, Math.floor((g.cy - bh / 2) * k));
        const w = Math.min(canvas.width - x, Math.ceil(bw * k)), h = Math.min(canvas.height - y, Math.ceil(bh * k));
        if (w < 2 || h < 2) return fallback;
        let data;
        try { data = canvas.getContext("2d").getImageData(x, y, w, h).data; } catch (_) { return fallback; }

        const counts = new Map();
        const tally = (px, py) => {
            const i = (py * w + px) * 4;
            const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
            const e = counts.get(key) || { n: 0, r: data[i], g: data[i + 1], b: data[i + 2] };
            e.n++; counts.set(key, e);
        };
        for (let px = 0; px < w; px++) { tally(px, 0); tally(px, h - 1); }
        for (let py = 0; py < h; py++) { tally(0, py); tally(w - 1, py); }
        const bg = [...counts.values()].sort((a, b) => b.n - a.n)[0];
        let best = 0, fg = null;
        for (let i = 0; i < data.length; i += 4) {
            const d = Math.abs(data[i] - bg.r) + Math.abs(data[i + 1] - bg.g) + Math.abs(data[i + 2] - bg.b);
            if (d > best) { best = d; fg = [data[i], data[i + 1], data[i + 2]]; }
        }
        const bgHex = Utils.rgbToHex(bg.r, bg.g, bg.b);
        const dark = (bg.r + bg.g + bg.b) / 3 < 128;
        const fgHex = best >= 150 && fg ? Utils.rgbToHex(...fg) : dark ? "#ffffff" : "#000000";
        return { bg: bgHex, fg: fgHex };
    },

    /* ============================================================ typing */
    startEditing(obj, { selectAll = false } = {}) {
        if (obj.type !== "text") return;
        if (this.editing && this.editing !== obj) this.finishEditing();
        const el = this._els.get(obj.id);
        if (!el) return;
        this.editing = obj;
        const t = this._transient.get(obj.id) || {};
        t.startText = obj.text;
        this._transient.set(obj.id, t);
        el.classList.add("editing");
        el._content.contentEditable = this.PLAIN ? "plaintext-only" : "true";
        setTimeout(() => {
            if (this.editing !== obj || !el.isConnected) return;   // finished or re-rendered meanwhile
            el._content.focus();
            const range = document.createRange();
            range.selectNodeContents(el._content);
            if (!selectAll) range.collapse(false);
            const sel = window.getSelection();
            sel.removeAllRanges(); sel.addRange(range);
        }, 0);
    },

    finishEditing() {
        const obj = this.editing;
        if (!obj) return;
        this.editing = null;
        const el = this._els.get(obj.id);
        const t = this._transient.get(obj.id) || {};
        if (el) {
            obj.text = this._readText(el._content);
            this._measure(obj, el);
            el.classList.remove("editing");
            el._content.contentEditable = "false";
            window.getSelection()?.removeAllRanges();
        }
        this._transient.delete(obj.id);
        const empty = !obj.text.trim();
        const pageId = obj.page;

        if (t.coverId) {                                           // replacement of an existing run
            const unchanged = obj.text === t.original && obj.x === t.x0 && obj.y === t.y0;
            if (unchanged) {                                       // user only looked: revert silently
                this._removeObjects([obj.id, t.coverId]);
                this.selection = [];
                AppState.set({ selectedObject: null });
            } else if (empty) {
                this._removeObjects([obj.id]);                     // text deleted, cover stays
                PDFEditor.commit("Delete text");
            } else PDFEditor.commit("Edit text");
        } else if (empty) {
            this._removeObjects([obj.id]);
            if (!t.isNew) PDFEditor.commit("Delete text");
        } else if (t.isNew) PDFEditor.commit("Add text");
        else if (obj.text !== t.startText) PDFEditor.commit("Edit text");

        this.renderPageObjects(pageId);
        const pageEl = PDFViewer.getPageEl(pageId);
        if (pageEl) { pageEl._hitsRot = null; this._rebuildHitsFor(pageEl); }
        this.selection = this.selection.filter(id => this._find(id));
        AppState.set({ selectedObject: this.selection[this.selection.length - 1] || null });
        this._paintSelection();
        this.syncToolbar();
        this.positionToolbar();
    },

    _rebuildHitsFor(pageEl) {
        const page = PDFEditor.getPage(pageEl.dataset.pageId);
        if (page && AppState.currentTool === "editor" && pageEl.classList.contains("rendered")) this._buildHits(pageEl, page);
    },

    _removeObjects(ids) {
        const set = new Set(ids);
        for (const [pageId, list] of Object.entries(this._objects())) {
            const next = list.filter(o => !set.has(o.id));
            if (next.length !== list.length) PDFEditor.doc.objects[pageId] = next;
        }
        ids.forEach(id => { this._els.get(id)?.remove(); this._els.delete(id); this._transient.delete(id); });
    },

    /* ============================================================ selection */
    select(ids) {
        if (this.editing && !ids.includes(this.editing.id)) this.finishEditing();
        this.selection = ids;
        AppState.set({ selectedObject: ids[ids.length - 1] || null });
        this._paintSelection();
        this.syncToolbar();
        this.positionToolbar();
    },

    _paintSelection() {
        const sel = new Set(this.selection);
        for (const [id, el] of this._els) {
            el.classList.toggle("selected", sel.has(id));
            el.classList.toggle("single", sel.has(id) && this.selection.length === 1);
        }
    },

    selectAll() {
        if (this.editing) { document.execCommand("selectAll"); return; }
        const page = PDFEditor.doc?.pages[AppState.currentPage - 1];
        if (!page) return;
        this.select(this._list(page.id).map(o => o.id));
    },

    deleteSelected() {
        if (!this.selection.length) { Toast.info("Nothing selected. Click an object first."); return false; }
        if (this.editing) this.finishEditing();
        const ids = [...this.selection];
        const pages = new Set(ids.map(id => this._find(id)?.page).filter(Boolean));
        this._removeObjects(ids);
        this.selection = [];
        AppState.set({ selectedObject: null });
        PDFEditor.commit(ids.length > 1 ? "Delete objects" : "Delete object");
        pages.forEach(pid => {
            this.renderPageObjects(pid);
            const el = PDFViewer.getPageEl(pid);
            if (el) { el._hitsRot = null; this._rebuildHitsFor(el); }
        });
        this.syncToolbar();
        this.positionToolbar();
        return true;
    },

    /* ============================================================ pointer: select, move, resize */
    _onObjectDown(e, obj, el) {
        if (AppState.currentTool !== "editor" || e.button !== 0) return;
        if (this.editing === obj && e.target.closest(".annot-content")) return;   // let the caret move
        e.preventDefault();
        if (this.mode === "add") this.setMode("select");

        if (e.target.classList.contains("annot-handle")) { this._startResize(e, obj, el); return; }

        const additive = e.shiftKey || e.ctrlKey || e.metaKey;
        if (additive) {
            this.select(this.selection.includes(obj.id) ? this.selection.filter(i => i !== obj.id) : [...this.selection, obj.id]);
        } else if (!this.selection.includes(obj.id)) {
            this.select([obj.id]);
        }
        if (!this.selection.includes(obj.id)) return;

        const ids = [...this.selection];
        this._drag = {
            startX: e.clientX, startY: e.clientY, scale: this._scaleOf(el), moved: false,
            origins: new Map(ids.map(id => { const o = this._find(id); return [id, { x: o.x, y: o.y }]; }))
        };
        el.setPointerCapture(e.pointerId);
        const move = ev => {
            const d = this._drag;
            if (!d) return;
            const dx = (ev.clientX - d.startX) / d.scale, dy = (ev.clientY - d.startY) / d.scale;
            if (!d.moved && Math.hypot(dx, dy) * d.scale < 3) return;
            d.moved = true;
            for (const [id, o0] of d.origins) {
                const o = this._find(id), node = this._els.get(id);
                if (!o || !node) continue;
                o.x = o0.x + dx; o.y = o0.y + dy;
                node.style.left = `${o.x}px`; node.style.top = `${o.y}px`;
            }
            this.positionToolbar();
        };
        const up = () => {
            el.removeEventListener("pointermove", move);
            el.removeEventListener("pointerup", up);
            el.removeEventListener("pointercancel", up);
            const moved = this._drag?.moved;
            this._drag = null;
            if (moved) PDFEditor.commit("Move");
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", up);
    },

    /** Resize from the bottom-right handle. The drag delta is rotated into the box's own axes. */
    _startResize(e, obj, el) {
        const scale = this._scaleOf(el);
        const th = (obj.rotation || 0) * Math.PI / 180, cos = Math.cos(th), sin = Math.sin(th);
        const start = { x: e.clientX, y: e.clientY, w: obj.w, h: obj.h, cx: obj.x + obj.w / 2, cy: obj.y + obj.h / 2 };
        el.setPointerCapture(e.pointerId);
        let changed = false;
        const move = ev => {
            const dx = (ev.clientX - start.x) / scale, dy = (ev.clientY - start.y) / scale;
            const lx = dx * cos + dy * sin, ly = -dx * sin + dy * cos;        // into local (unrotated) axes
            const minW = obj.type === "text" ? Math.max(10, obj.fontSize) : 4;
            obj.w = Math.max(minW, start.w + lx);
            if (obj.type === "rect") obj.h = Math.max(4, start.h + ly);
            else if (obj.type === "image") obj.h = obj.w / (obj.aspect || 1);   // keep proportions
            else obj.autoWidth = false;
            this._applyStyle(obj, el);
            this._measure(obj, el);                                           // text height follows its wrapping
            const dw = obj.w - start.w, dh = obj.h - start.h;
            // keep the top-left corner visually fixed: shift the centre along the rotated axes
            const ncx = start.cx + (dw / 2) * cos - (dh / 2) * sin;
            const ncy = start.cy + (dw / 2) * sin + (dh / 2) * cos;
            obj.x = ncx - obj.w / 2; obj.y = ncy - obj.h / 2;
            this._applyStyle(obj, el);
            changed = true;
            this.positionToolbar();
        };
        const up = () => {
            el.removeEventListener("pointermove", move);
            el.removeEventListener("pointerup", up);
            el.removeEventListener("pointercancel", up);
            if (changed) PDFEditor.commit("Resize");
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", up);
    },

    /* ============================================================ keyboard (called by app.js) */
    /** @returns {boolean} true if the key was handled */
    onKey(e) {
        if (AppState.currentTool !== "editor" || this.editing) return false;
        if (e.key === "Escape") {
            if (this.mode === "add") { this.setMode("select"); return true; }
            if (this.selection.length) { this.select([]); return true; }
            return false;
        }
        if (!this.selection.length) return false;
        if (e.key === "Delete" || e.key === "Backspace") { this.deleteSelected(); return true; }
        if (e.key === "Enter" && this.selection.length === 1) {
            const o = this._primary();
            if (o?.type === "text") { this.startEditing(o); return true; }
        }
        const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
        if (arrows) {
            const step = e.shiftKey ? 10 : 1;
            for (const id of this.selection) {
                const o = this._find(id), el = this._els.get(id);
                if (!o || !el) continue;
                o.x += arrows[0] * step; o.y += arrows[1] * step;
                el.style.left = `${o.x}px`; el.style.top = `${o.y}px`;
            }
            this.positionToolbar();
            clearTimeout(this._nudgeTimer);
            this._nudgeTimer = setTimeout(() => PDFEditor.commit("Move"), 400);
            return true;
        }
        return false;
    },

    /* ============================================================ floating toolbar */
    _initToolbar() {
        const $ = id => document.getElementById(id);
        const font = $("ft-font");
        APP_CONFIG.fonts.forEach(f => font.append(Utils.h("option", { value: f, text: f })));
        APP_CONFIG.fontSizes.forEach(s => $("ft-sizes").append(Utils.h("option", { value: s })));

        // Keep text focus/selection when clicking buttons (inputs/selects still take focus normally).
        this.tb.addEventListener("mousedown", e => {
            if (!e.target.closest("input, select, label")) e.preventDefault();
        });

        font.addEventListener("change", () => this.applyStyle({ fontFamily: font.value }));
        $("ft-size").addEventListener("input", e => {
            const v = Number(e.target.value);
            if (v >= 4 && v <= 300) this.applyStyle({ fontSize: v }, { commit: false });
        });
        $("ft-size").addEventListener("change", () => this.applyStyle({ fontSize: Utils.clamp(Number($("ft-size").value) || 12, 4, 300) }));
        const toggle = (id, key) => $(id).addEventListener("click", () => {
            const cur = (this._primary() || this.defaults)[key];
            this.applyStyle({ [key]: !cur });
        });
        toggle("ft-bold", "bold"); toggle("ft-italic", "italic"); toggle("ft-underline", "underline");
        $("ft-color").addEventListener("input", e => this.applyStyle({ color: e.target.value }, { commit: false }));
        $("ft-color").addEventListener("change", e => this.applyStyle({ color: e.target.value }));
        this.tb.querySelectorAll("[data-align]").forEach(b => b.addEventListener("click", () => this.applyStyle({ align: b.dataset.align })));
        $("ft-opacity").addEventListener("input", e => {
            $("ft-opacity-val").textContent = `${e.target.value}%`;
            this.applyStyle({ opacity: Number(e.target.value) / 100 }, { commit: false });
        });
        $("ft-opacity").addEventListener("change", e => this.applyStyle({ opacity: Number(e.target.value) / 100 }));
        $("ft-delete").addEventListener("click", () => this.deleteSelected());
    },

    /** Apply a style patch to the selection (or only the defaults when nothing is selected). */
    applyStyle(patch, { commit = true } = {}) {
        const targets = this.selection.map(id => this._find(id)).filter(Boolean);
        if (!targets.length || targets.some(o => o.type === "text")) Object.assign(this.defaults, patch);
        for (const o of targets) {
            const allowed = o.type === "rect" ? ["color", "opacity"] : o.type === "image" ? ["opacity"] : Object.keys(patch);
            for (const k of allowed) if (k in patch) o[k] = patch[k];
            const el = this._els.get(o.id);
            if (el) { this._applyStyle(o, el); this._measure(o, el); }
        }
        this.syncToolbar(true);
        this.positionToolbar();
        if (commit && targets.length) PDFEditor.commit("Format");
    },

    syncToolbar(keepFocus = false) {
        const $ = id => document.getElementById(id);
        const obj = this._primary();
        const src = obj && obj.type === "text" ? obj : (obj ? { ...this.defaults, color: obj.color || "#000000", opacity: obj.opacity } : this.defaults);
        this.tb.querySelectorAll('[data-for="text"]').forEach(g => { g.hidden = !!obj && obj.type !== "text"; });
        this.tb.querySelectorAll('[data-for="fill"]').forEach(g => { g.hidden = obj?.type === "image"; });
        const font = $("ft-font");
        if (![...font.options].some(o => o.value === src.fontFamily)) font.append(Utils.h("option", { value: src.fontFamily, text: src.fontFamily }));
        font.value = src.fontFamily;
        if (!(keepFocus && document.activeElement === $("ft-size"))) $("ft-size").value = String(Math.round(src.fontSize * 10) / 10);
        $("ft-bold").setAttribute("aria-pressed", String(!!src.bold));
        $("ft-italic").setAttribute("aria-pressed", String(!!src.italic));
        $("ft-underline").setAttribute("aria-pressed", String(!!src.underline));
        $("ft-color").value = /^#[0-9a-f]{6}$/i.test(src.color) ? src.color : "#000000";
        this.tb.querySelectorAll("[data-align]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.align === src.align)));
        $("ft-opacity").value = String(Math.round((src.opacity ?? 1) * 100));
        $("ft-opacity-val").textContent = `${Math.round((src.opacity ?? 1) * 100)}%`;
    },

    /** The toolbar floats above the selection (or below it near the top edge) and never takes layout space. */
    positionToolbar() {
        const tb = this.tb;
        const show = AppState.currentTool === "editor" && (this.selection.length > 0 || this.mode === "add");
        tb.hidden = !show;
        if (!show) return;
        const ws = PDFViewer.els.workspace.getBoundingClientRect();
        const primary = this._primary();
        const el = primary && this._els.get(primary.id);
        tb.style.left = "8px";                       // measure at its widest (shrink-to-fit depends on `left`)
        const tbw = tb.offsetWidth, tbh = tb.offsetHeight;
        let left, top;
        if (el) {
            const r = el.getBoundingClientRect();
            if (r.bottom < ws.top + 40 || r.top > ws.bottom) { tb.hidden = true; return; }   // scrolled out of view
            left = r.left - ws.left;
            top = r.top - ws.top - tbh - 8;
            if (top < 48) top = r.bottom - ws.top + 8;                                       // keep clear of the main toolbar
        } else {
            left = (ws.width - tbw) / 2;
            top = 56;
        }
        tb.style.left = `${Utils.clamp(left, 8, Math.max(8, ws.width - tbw - 8))}px`;
        tb.style.top = `${Utils.clamp(top, 48, Math.max(48, ws.height - tbh - 8))}px`;
    },

    /* ============================================================ tool lifecycle */
    onToolChange(tool) {
        if (tool !== "editor") {
            this.finishEditing();
            this.selection = [];
            AppState.set({ selectedObject: null });
            this._paintSelection();
            this.setMode("select");
            this.tb.hidden = true;
            return;
        }
        this._rebuildAllHits();
        this.syncToolbar();
        this.positionToolbar();
        this._checkScanned();
    },

    async _checkScanned() {
        const banner = document.getElementById("editor-banner");
        const doc = PDFEditor.doc;
        if (!doc || doc._bannerDismissed) { banner.hidden = true; return; }
        const scanned = await PDFEditor.detectScanned();
        banner.hidden = !scanned;
        if (scanned) doc._bannerDismissed = true;
    },

    reset() {
        this.editing = null;
        this.selection = [];
        this._els.clear();
        this._transient.clear();
        this._drag = null;
        clearTimeout(this._nudgeTimer);
        this.tb.hidden = true;
        document.getElementById("editor-banner").hidden = true;
        AppState.set({ selectedObject: null });
    },
    cleanup() { this.reset(); },
    destroy() { this.reset(); }
};
