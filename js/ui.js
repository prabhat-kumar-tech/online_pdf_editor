/**
 * ui.js — application chrome: action routing, menus, tooltips, dropzones, progress overlay,
 * error dialogs, view switching and enabling/disabling of controls from AppState.
 * Other modules never touch chrome elements directly; they call UI.* or emit events.
 */
"use strict";

const UI = {
    actions: {},
    DOC_TOOLS: ["viewer", "editor", "organize", "rotate", "delete", "extract", "split", "watermark", "numbers", "toimg", "totext", "protect"],
    SCROLL_TOOLS: ["viewer", "editor"],
    ORGANIZER_TOOLS: ["organize", "rotate", "delete", "extract"],

    init() {
        document.querySelectorAll("[data-app-name]").forEach(el => { el.textContent = APP_CONFIG.appName; });
        document.querySelectorAll("[data-tagline]").forEach(el => { el.textContent = APP_CONFIG.tagline; });
        document.title = APP_CONFIG.appName;
        const contact = document.getElementById("btn-contact");   // address comes from config.js
        if (contact && APP_CONFIG.developer?.email) {
            contact.href = `mailto:${APP_CONFIG.developer.email}`;
            contact.dataset.tip = APP_CONFIG.developer.email;   // shown on hover
            contact.setAttribute("aria-label", `Contact me by email: ${APP_CONFIG.developer.email}`);
        }

        // One delegated click handler routes every [data-action] to the registry.
        document.addEventListener("click", e => {
            const el = e.target.closest("[data-action]");
            if (!el || el.disabled) return;
            const fn = this.actions[el.dataset.action];
            if (!fn) { Logger.warn("No handler for action", el.dataset.action); return; }
            if (el.tagName === "A") e.preventDefault();
            fn(el, e);
        });

        this._bindMenus();
        this._bindTooltips();
        this._bindSidebar();
        Events.on("state:change", () => this.refresh());
        Events.on("history:change", () => this.refresh());

        // Never let the browser navigate away when a file is dropped outside a dropzone.
        ["dragover", "drop"].forEach(t => window.addEventListener(t, e => {
            if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
        }));
    },

    register(map) { Object.assign(this.actions, map); },
    run(name, el = null, ev = null) { this.actions[name]?.(el, ev); },

    /* ------------------------------------------------------------ views */
    showView(name) {
        document.querySelectorAll(".view").forEach(v => { v.hidden = v.dataset.view !== name; });
    },

    /** Show/hide elements that declare data-tools="a b c" depending on the active tool. */
    applyToolVisibility(tool) {
        document.querySelectorAll("[data-tools]").forEach(el => {
            el.hidden = !el.dataset.tools.split(" ").includes(tool);
        });
        document.querySelectorAll(".tool-btn").forEach(btn => {
            const active = btn.dataset.tool === tool;
            btn.classList.toggle("active", active);
            if (active) btn.setAttribute("aria-current", "page"); else btn.removeAttribute("aria-current");
        });
    },

    setStatus(text) {
        const el = document.getElementById("status-msg");
        if (el) el.textContent = text;
    },

    /** Re-evaluates every state-dependent control. Cheap; safe to call often. */
    refresh() {
        const hasDoc = !!AppState.pdfDocument;
        const tool = AppState.currentTool;
        const inScroll = hasDoc && this.SCROLL_TOOLS.includes(tool);

        const title = document.getElementById("doc-title");
        if (title) {
            title.hidden = !hasDoc;
            document.getElementById("doc-name").textContent = AppState.currentFile?.name || "";
            document.getElementById("dirty-dot").hidden = !AppState.isDirty;
        }
        document.title = hasDoc
            ? `${AppState.isDirty ? "* " : ""}${AppState.currentFile?.name || ""} — ${APP_CONFIG.appName}`
            : APP_CONFIG.appName;

        const states = {
            doc: hasDoc,
            scroll: inScroll,
            undo: hasDoc && AppState.historyIndex > 0,
            redo: hasDoc && AppState.historyIndex < AppState.history.length - 1,
            pagesel: hasDoc && AppState.selectedPages.length > 0
        };
        document.querySelectorAll("[data-requires]").forEach(el => {
            const ok = !!states[el.dataset.requires];
            el.disabled = !ok;
            el.setAttribute("aria-disabled", String(!ok));
        });

        const pageInput = document.getElementById("page-input");
        pageInput.disabled = !inScroll;
        pageInput.max = String(AppState.totalPages || 1);
        if (document.activeElement !== pageInput) pageInput.value = String(AppState.currentPage);
        document.getElementById("page-total").textContent = String(AppState.totalPages);
        document.getElementById("zoom-label").textContent = `${Math.round(AppState.zoom * 100)}%`;
    },

    /* ------------------------------------------------------------ sidebar */
    _bindSidebar() {
        const app = document.getElementById("app");
        // Default per breakpoint: desktop expanded, tablet icon-only, phone = bottom tool bar. Re-applied only
        // when the window crosses a breakpoint, so a manual toggle is not undone by small resizes.
        let bracket = null;
        const phone = window.matchMedia("(max-width: 700px)"), tablet = window.matchMedia("(max-width: 1000px)");
        const apply = () => {
            const b = phone.matches ? "phone" : tablet.matches ? "tablet" : "desktop";
            if (b === bracket) return;
            bracket = b;
            app.dataset.sidebar = b === "tablet" ? "collapsed" : "expanded";
        };
        apply();
        phone.addEventListener("change", apply);
        tablet.addEventListener("change", apply);
        this.register({
            "toggle-sidebar": () => {
                app.dataset.sidebar = app.dataset.sidebar === "expanded" ? "collapsed" : "expanded";
            }
        });
    },

    /** On narrow screens the sidebar overlays content, so close it after choosing a tool. */
    collapseSidebarIfNarrow() {
        if (!window.matchMedia("(max-width: 700px)").matches && window.matchMedia("(max-width: 1000px)").matches) {
            document.getElementById("app").dataset.sidebar = "collapsed";
        }
    },

    /* ------------------------------------------------------------ menus */
    _bindMenus() {
        const menus = Array.from(document.querySelectorAll(".menu"));
        const closeAll = () => menus.forEach(m => {
            m.querySelector(".menu-list").hidden = true;
            m.querySelector(".menu-btn").setAttribute("aria-expanded", "false");
        });
        const isAnyOpen = () => menus.some(m => !m.querySelector(".menu-list").hidden);
        const open = (menu, focusFirst = false) => {
            closeAll();
            const list = menu.querySelector(".menu-list");
            list.hidden = false;
            menu.querySelector(".menu-btn").setAttribute("aria-expanded", "true");
            if (focusFirst) list.querySelector("button:not([disabled])")?.focus();
        };
        menus.forEach((menu, i) => {
            const btn = menu.querySelector(".menu-btn");
            const list = menu.querySelector(".menu-list");
            btn.addEventListener("click", () => (list.hidden ? open(menu) : closeAll()));
            btn.addEventListener("mouseenter", () => { if (isAnyOpen() && list.hidden) open(menu); });
            btn.addEventListener("keydown", e => {
                if (e.key === "ArrowDown") { e.preventDefault(); open(menu, true); }
            });
            menu.addEventListener("keydown", e => {
                const items = Array.from(list.querySelectorAll("button:not([disabled])"));
                const idx = items.indexOf(document.activeElement);
                if (e.key === "ArrowDown" && idx >= 0) { e.preventDefault(); items[(idx + 1) % items.length].focus(); }
                else if (e.key === "ArrowUp" && idx >= 0) { e.preventDefault(); items[(idx - 1 + items.length) % items.length].focus(); }
                else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                    const next = menus[(i + (e.key === "ArrowRight" ? 1 : -1) + menus.length) % menus.length];
                    open(next, idx >= 0); next.querySelector(".menu-btn").focus();
                    if (idx >= 0) next.querySelector(".menu-list button:not([disabled])")?.focus();
                } else if (e.key === "Escape" && isAnyOpen()) { closeAll(); btn.focus(); e.stopPropagation(); }
            });
            list.addEventListener("click", e => { if (e.target.closest("button")) closeAll(); });
        });
        document.addEventListener("click", e => { if (!e.target.closest(".menu")) closeAll(); });
        window.addEventListener("blur", closeAll);
    },

    /* ------------------------------------------------------------ tooltips */
    _bindTooltips() {
        const tip = document.getElementById("tooltip");
        let timer = null, current = null;
        const hide = () => { clearTimeout(timer); tip.hidden = true; current = null; };
        const show = el => {
            const text = el.dataset.tip;
            if (!text) return;
            current = el;
            tip.textContent = text;
            tip.hidden = false;
            const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
            let left = Utils.clamp(r.left + r.width / 2 - t.width / 2, 6, window.innerWidth - t.width - 6);
            let top = r.bottom + 8;
            if (top + t.height > window.innerHeight - 6) top = r.top - t.height - 8;
            tip.style.left = `${left}px`;
            tip.style.top = `${top}px`;
        };
        const over = e => {
            const el = e.target.closest?.("[data-tip]");
            if (!el || el === current) return;
            hide();
            timer = setTimeout(() => show(el), e.type === "focusin" ? 0 : 450);
        };
        document.addEventListener("mouseover", over);
        document.addEventListener("focusin", over);
        document.addEventListener("mouseout", e => { if (e.target.closest?.("[data-tip]")) hide(); });
        document.addEventListener("focusout", hide);
        document.addEventListener("mousedown", hide);
        document.addEventListener("scroll", hide, true);
        document.addEventListener("keydown", e => { if (e.key === "Escape") hide(); });
    },

    /* ------------------------------------------------------------ dropzone */
    /**
     * Makes an element a reusable drop zone: click, Enter/Space, drag & drop, multiple files.
     * @param {HTMLElement} el
     * @param {{kinds:string[], multiple:boolean, onFiles:(files:File[])=>void}} opts
     */
    bindDropzone(el, { kinds = ["pdf"], multiple = false, onFiles }) {
        if (!el) return;
        const pick = async () => {
            const files = await FileManager.pickFiles({ kinds, multiple });
            if (files.length) onFiles(files);
        };
        el.addEventListener("click", pick);
        el.addEventListener("keydown", e => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); }
        });
        let depth = 0;
        el.addEventListener("dragenter", e => { e.preventDefault(); depth++; el.classList.add("drag-over"); });
        el.addEventListener("dragover", e => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; });
        el.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) el.classList.remove("drag-over"); });
        el.addEventListener("drop", e => {
            e.preventDefault(); e.stopPropagation();
            depth = 0; el.classList.remove("drag-over");
            const files = Array.from(e.dataTransfer?.files || []);
            if (files.length) onFiles(multiple ? files : files.slice(0, 1));
        });
    },

    /* ------------------------------------------------------------ progress */
    _progressDepth: 0,
    progress: {
        show(title = "Processing PDF…", { determinate = false } = {}) {
            UI._progressDepth++;
            AppState.set({ busy: true });
            document.getElementById("progress-title").textContent = title;
            const bar = document.getElementById("progress-bar");
            bar.classList.toggle("indeterminate", !determinate);
            document.getElementById("progress-fill").style.width = determinate ? "0%" : "";
            if (determinate) bar.setAttribute("aria-valuenow", "0"); else bar.removeAttribute("aria-valuenow");
            document.getElementById("progress-text").textContent = determinate ? "0%" : "Please wait.";
            document.getElementById("progress-overlay").hidden = false;
        },
        update(fraction, text) {
            const pct = Math.round(Utils.clamp(fraction, 0, 1) * 100);
            const bar = document.getElementById("progress-bar");
            bar.classList.remove("indeterminate");
            bar.setAttribute("aria-valuenow", String(pct));
            document.getElementById("progress-fill").style.width = `${pct}%`;
            document.getElementById("progress-text").textContent = text ? `${text} — ${pct}%` : `${pct}%`;
        },
        hide() {
            UI._progressDepth = Math.max(0, UI._progressDepth - 1);
            if (UI._progressDepth) return;
            document.getElementById("progress-overlay").hidden = true;
            AppState.set({ busy: false });
        }
    },

    /** Runs fn(update) behind the progress overlay. update(fraction, text) switches to a determinate bar. */
    async withProgress(title, fn, opts = {}) {
        this.progress.show(title, opts);
        await Utils.nextFrame();
        await Utils.nextFrame();
        try {
            return await fn((f, t) => this.progress.update(f, t));
        } finally {
            this.progress.hide();
        }
    },

    /* ------------------------------------------------------------ errors */
    /** Friendly error dialog. `err` may be an Error or {title, message}. */
    showError(err, { actionLabel, onAction } = {}) {
        const info = err && err.title && err.message && !(err instanceof Error) ? err : Utils.describeError(err);
        if (err instanceof Error) Logger.error(err);
        const actions = [{ label: "Close", value: "close" }];
        if (actionLabel) actions.push({ label: actionLabel, value: "action", variant: "primary", autofocus: true });
        return Modal.open({ title: info.title, icon: "alert", role: "alertdialog", content: info.message, actions })
            .then(v => { if (v === "action") onAction?.(); return v; });
    }
};
