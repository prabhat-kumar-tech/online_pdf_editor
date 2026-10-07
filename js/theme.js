/**
 * theme.js — Light / Dark / System theme, remembered in localStorage("theme").
 */
"use strict";

const Theme = {
    MODES: ["light", "dark", "system"],
    mode: "system",
    _media: null,

    init() {
        this._media = window.matchMedia?.("(prefers-color-scheme: dark)") || null;
        let saved = null;
        if (APP_CONFIG.enableLocalStorage) {
            try { saved = localStorage.getItem("theme"); } catch (_) { /* storage blocked */ }
        }
        this.mode = this.MODES.includes(saved) ? saved : APP_CONFIG.theme;
        if (!this.MODES.includes(this.mode)) this.mode = "system";
        this._media?.addEventListener?.("change", () => { if (this.mode === "system") this.apply(); });
        const btn = document.getElementById("btn-theme");
        if (btn && !APP_CONFIG.enableDarkMode) btn.hidden = true;
        this.apply();
    },

    resolved() {
        if (!APP_CONFIG.enableDarkMode) return "light";
        if (this.mode === "system") return this._media?.matches ? "dark" : "light";
        return this.mode;
    },

    set(mode) {
        if (!this.MODES.includes(mode)) return;
        this.mode = mode;
        if (APP_CONFIG.enableLocalStorage) {
            try { localStorage.setItem("theme", mode); } catch (_) { /* ignore */ }
        }
        this.apply();
    },

    cycle() {
        this.set(this.MODES[(this.MODES.indexOf(this.mode) + 1) % this.MODES.length]);
        Toast.info(`Theme: ${this.mode[0].toUpperCase()}${this.mode.slice(1)}`, { duration: 1500 });
    },

    apply() {
        const root = document.documentElement;
        root.dataset.theme = this.resolved();
        root.dataset.themeMode = this.mode;
        const btn = document.getElementById("btn-theme");
        if (!btn) return;
        const icon = { light: "sun", dark: "moon", system: "monitor" }[this.mode];
        btn.querySelector("use")?.setAttribute("href", `#i-${icon}`);
        const label = `Theme: ${this.mode} (click to change)`;
        btn.setAttribute("aria-label", label);
        btn.dataset.tip = label;
    }
};
