/**
 * toast.js — non-blocking notifications (success | error | warning | info).
 */
"use strict";

const Toast = {
    ICONS: { success: "check", error: "alert", warning: "alert", info: "info" },

    show(message, type = "info", { duration } = {}) {
        const root = document.getElementById("toast-root");
        if (!root) return null;
        const ms = duration ?? (type === "error" ? 7000 : 4000);
        const toast = Utils.h("div", { class: `toast toast-${type}`, role: type === "error" ? "alert" : "status" },
            Utils.icon(this.ICONS[type] || "info"),
            Utils.h("span", { class: "toast-text", text: message }),
            Utils.h("button", {
                class: "toast-close", type: "button", "aria-label": "Dismiss notification",
                onclick: () => this.dismiss(toast)
            }, Utils.icon("x"))
        );
        root.append(toast);
        while (root.children.length > 4) root.firstElementChild.remove();
        if (ms > 0) toast._timer = setTimeout(() => this.dismiss(toast), ms);
        return toast;
    },

    dismiss(toast) {
        if (!toast || !toast.isConnected) return;
        clearTimeout(toast._timer);
        toast.classList.add("leaving");
        setTimeout(() => toast.remove(), 180);
    },

    success(msg, opts) { return this.show(msg, "success", opts); },
    error(msg, opts) { return this.show(msg, "error", opts); },
    warning(msg, opts) { return this.show(msg, "warning", opts); },
    info(msg, opts) { return this.show(msg, "info", opts); },

    cleanup() { document.getElementById("toast-root")?.replaceChildren(); }
};
