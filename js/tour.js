/**
 * tour.js — first-run guided tour (spotlight + step cards).
 *
 * Shown automatically the first time someone opens the app; the fact that it was seen is stored in
 * the browser (localStorage key "tourSeen", only the string "1" — no personal data). It can be
 * replayed any time from Help > Take a Tour. If storage is blocked, the tour simply shows once per
 * page load instead of failing.
 */
"use strict";

const Tour = {
    STORAGE_KEY: "tourSeen",
    active: false,
    _index: 0,
    _steps: [],
    _els: null,
    _prevFocus: null,
    _seenInMemory: false,

    /** Steps are built lazily so the app name comes from config.js. A missing target = centred step. */
    _buildSteps() {
        return [
            { title: `Welcome to ${APP_CONFIG.appName}`, text: "A 30-second tour of the main controls. Everything runs in your browser — your files never leave your device." },
            { target: "#sidebar", title: "All your tools", text: "Pick a tool here: Viewer, Merge, Organize, Edit PDF, Extract Text, Image to PDF, PDF to Images, Split, Rotate, Delete, Compress, Protect PDF (password), Watermark and Page Numbers." },
            { target: "#dz-home", title: "Open or drop files", text: "Drop a PDF to open it, or click to choose one. Drop images to turn them into a PDF, or several PDFs to merge them." },
            { target: ".tool-grid", title: "Tool cards", text: "Every tool is also a card with a short description. Click one to start; tools that need a document ask you to open a PDF first." },
            { target: ".menubar", title: "Menus", text: "File: open, save, close. Edit: undo, redo, add text. View: zoom, fit, fullscreen. Help: shortcuts, privacy and this tour. Handy keys: Ctrl+O open, Ctrl+S save, Ctrl+Z undo." },
            { target: "#btn-privacy", title: "Private by design", text: "Processing happens locally. Click this badge any time to read how your files are handled." },
            { target: "#btn-theme", title: "Light, dark or system", text: "Switch the theme here. Your choice is remembered in this browser." },
            { target: "#btn-contact", title: "Questions or feedback?", text: "ContactMe opens an email to the developer." },
            { title: "You're ready", text: "Open a PDF to begin. In Edit PDF you can click existing text to replace it, or use Add Text, Sign / Image and Highlight. Retake this tour from Help → Take a Tour." }
        ];
    },

    init() {
        UI.register({ "start-tour": () => this.start({ manual: true }) });
        window.addEventListener("resize", Utils.throttle(() => { if (this.active) this._render(); }, 100));
    },

    hasSeen() {
        if (this._seenInMemory) return true;
        if (!APP_CONFIG.enableLocalStorage) return false;
        try { return localStorage.getItem(this.STORAGE_KEY) === "1"; } catch (_) { return false; }
    },

    _markSeen() {
        this._seenInMemory = true;
        if (!APP_CONFIG.enableLocalStorage) return;
        try { localStorage.setItem(this.STORAGE_KEY, "1"); } catch (_) { /* storage blocked: shown once per load */ }
    },

    /** Called at startup: show the tour only to first-time visitors. */
    maybeStart() {
        if (new URLSearchParams(location.search).get("tour") === "0") return;   // ?tour=0 skips it (demos, screenshots)
        if (this.hasSeen() || this.active) return;
        setTimeout(() => { if (!Modal.isOpen && !AppState.busy) this.start(); }, 700);
    },

    start({ manual = false } = {}) {
        if (this.active) return;
        if (manual) Modal.closeAll();
        App.openTool("home");                       // the home screen contains every spotlight target
        this._steps = this._buildSteps();
        this._index = 0;
        this.active = true;
        this._prevFocus = document.activeElement;
        this._build();
        this._render();
    },

    _build() {
        const spot = Utils.h("div", { class: "tour-spot", "aria-hidden": "true" });
        const title = Utils.h("h2", { id: "tour-title" });
        const text = Utils.h("p", { id: "tour-text" });
        const count = Utils.h("span", { class: "tour-count" });
        const dots = Utils.h("div", { class: "tour-dots", "aria-hidden": "true" });
        const skip = Utils.h("button", { type: "button", class: "btn btn-ghost btn-sm", text: "Skip tour", onclick: () => this.end() });
        const back = Utils.h("button", { type: "button", class: "btn btn-sm", text: "Back", onclick: () => this._go(-1) });
        const next = Utils.h("button", { type: "button", class: "btn btn-primary btn-sm", onclick: () => this._go(1) });
        const card = Utils.h("div", { class: "tour-card", role: "dialog", "aria-modal": "true", "aria-labelledby": "tour-title", "aria-describedby": "tour-text", tabindex: "-1" },
            Utils.h("div", { class: "tour-head" }, count, dots), title, text,
            Utils.h("div", { class: "tour-actions" }, skip, Utils.h("span", { class: "grow" }), back, next));
        const root = Utils.h("div", { class: "tour-root" }, spot, card);
        document.body.append(root);
        this._els = { root, spot, card, title, text, count, dots, back, next, skip };
        this._onKey = e => {
            if (!this.active) return;
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.end(); }
            else if (e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); this._go(1); }
            else if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); this._go(-1); }
            else if (e.key === "Tab") {                       // keep focus inside the card
                const f = [skip, back, next].filter(b => !b.disabled && b.offsetParent !== null);
                const i = f.indexOf(document.activeElement);
                if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
                else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
                else if (i === -1) { e.preventDefault(); f[0].focus(); }
            }
        };
        document.addEventListener("keydown", this._onKey, true);
    },

    _visible(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
    },

    /** Move to another step, skipping steps whose target is not visible (e.g. hidden on small screens). */
    _go(delta) {
        let i = this._index + delta;
        while (i >= 0 && i < this._steps.length && this._steps[i].target && !this._visible(document.querySelector(this._steps[i].target))) i += delta;
        if (i >= this._steps.length) { this.end(); return; }
        if (i < 0) return;
        this._index = i;
        this._render();
    },

    _render() {
        const step = this._steps[this._index], e = this._els;
        const last = this._index === this._steps.length - 1;
        e.title.textContent = step.title;
        e.text.textContent = step.text;
        e.count.textContent = `Step ${this._index + 1} of ${this._steps.length}`;
        e.dots.replaceChildren(...this._steps.map((_, i) => Utils.h("i", { class: i === this._index ? "on" : "" })));
        e.next.textContent = last ? "Finish" : this._index === 0 ? "Start tour" : "Next";
        e.back.disabled = this._index === 0;
        e.skip.hidden = last;

        const target = step.target ? document.querySelector(step.target) : null;
        const vw = window.innerWidth, vh = window.innerHeight, pad = 6;
        let rect = null;
        if (target && this._visible(target)) {
            target.scrollIntoView({ block: "nearest", inline: "nearest" });
            const r = target.getBoundingClientRect();
            rect = { left: Math.max(0, r.left - pad), top: Math.max(0, r.top - pad), width: Math.min(vw, r.width + 2 * pad), height: Math.min(vh, r.height + 2 * pad) };
        }
        const s = e.spot.style;
        if (rect) { s.left = `${rect.left}px`; s.top = `${rect.top}px`; s.width = `${rect.width}px`; s.height = `${rect.height}px`; }
        else { s.left = `${vw / 2}px`; s.top = `${vh / 2}px`; s.width = "0"; s.height = "0"; }

        // Place the card below the target, else above, else beside; centred when there is no target.
        const c = e.card.style;
        c.left = "0"; c.top = "0";
        const cw = e.card.offsetWidth, ch = e.card.offsetHeight, gap = 14, m = 12;
        let left, top;
        if (!rect) { left = (vw - cw) / 2; top = (vh - ch) / 2; }
        else if (rect.top + rect.height + gap + ch <= vh - m) { top = rect.top + rect.height + gap; left = rect.left; }
        else if (rect.top - gap - ch >= m) { top = rect.top - gap - ch; left = rect.left; }
        else if (rect.left + rect.width + gap + cw <= vw - m) { left = rect.left + rect.width + gap; top = rect.top; }
        else { left = rect.left + rect.width + gap > vw - cw ? m : rect.left; top = Math.max(m, vh - ch - m); }
        c.left = `${Utils.clamp(left, m, Math.max(m, vw - cw - m))}px`;
        c.top = `${Utils.clamp(top, m, Math.max(m, vh - ch - m))}px`;
        e.next.focus();
    },

    /** Finish or skip: remember it so it does not reappear on the next visit. */
    end() {
        if (!this.active) return;
        this.active = false;
        this._markSeen();
        document.removeEventListener("keydown", this._onKey, true);
        this._els.root.remove();
        this._els = null;
        this._prevFocus?.focus?.();
        UI.setStatus("Ready");
    },

    reset() { if (this.active) this.end(); },
    cleanup() {},
    destroy() { this.reset(); }
};
