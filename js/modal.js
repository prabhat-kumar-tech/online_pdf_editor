/**
 * modal.js — reusable accessible dialog system.
 * Supports open/close, Escape, click-outside, focus trap and focus restore.
 * Every function returns a Promise that resolves with the chosen action value (null if dismissed).
 */
"use strict";

const Modal = (() => {
    const stack = [];
    const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

    function top() { return stack[stack.length - 1]; }

    /**
     * @param {object} opts
     * @param {string} opts.title
     * @param {Node|string} [opts.content]  string is inserted as text
     * @param {Array<{label,value,variant,autofocus}>} [opts.actions]
     * @param {boolean} [opts.dismissible=true]
     * @param {string} [opts.size]  "sm" | "lg"
     * @param {(dialog:HTMLElement)=>void} [opts.onOpen]
     */
    function open(opts) {
        return new Promise(resolve => {
            const root = document.getElementById("modal-root");
            const titleId = Utils.uid("modal-title");
            const dismissible = opts.dismissible !== false;
            const actions = opts.actions || [{ label: "Close", value: true, variant: "primary" }];

            const content = typeof opts.content === "string"
                ? Utils.h("p", { text: opts.content }) : opts.content;

            const dialog = Utils.h("div", {
                class: `modal ${opts.size || ""}`.trim(), role: opts.role || "dialog",
                "aria-modal": "true", "aria-labelledby": titleId, tabindex: "-1"
            },
                Utils.h("div", { class: "modal-header" },
                    opts.icon ? Utils.icon(opts.icon, "modal-icon") : null,
                    Utils.h("h2", { id: titleId, text: opts.title }),
                    dismissible ? Utils.h("button", {
                        class: "icon-btn", type: "button", "aria-label": "Close dialog",
                        onclick: () => close(null)
                    }, Utils.icon("x")) : null),
                Utils.h("div", { class: "modal-body" }, content),
                actions.length ? Utils.h("div", { class: "modal-footer" }, actions.map(a =>
                    Utils.h("button", {
                        type: "button", class: `btn btn-${a.variant || "secondary"}`,
                        dataset: { autofocus: a.autofocus ? "1" : "" },
                        text: a.label,
                        onclick: () => close(a.value)
                    }))) : null
            );
            const backdrop = Utils.h("div", { class: "modal-backdrop" }, dialog);
            backdrop.addEventListener("mousedown", e => {
                if (e.target === backdrop && dismissible) close(null);
            });

            const entry = { backdrop, dialog, resolve, dismissible, prevFocus: document.activeElement };
            stack.push(entry);
            root.append(backdrop);
            document.body.classList.add("modal-open");

            const focusTarget = dialog.querySelector('[data-autofocus="1"]')
                || dialog.querySelector("input,select,textarea")
                || dialog.querySelector(".modal-footer .btn-primary, .modal-footer .btn-danger")
                || dialog;
            requestAnimationFrame(() => {
                focusTarget.focus();
                if (focusTarget.select && focusTarget.tagName === "INPUT") focusTarget.select();
            });
            opts.onOpen?.(dialog);
        });
    }

    function close(value = null) {
        const entry = stack.pop();
        if (!entry) return;
        entry.backdrop.remove();
        if (!stack.length) document.body.classList.remove("modal-open");
        const below = top();
        if (below) {
            // Another dialog is still open underneath: give focus back to it, not to the page behind.
            if (!below.dialog.contains(document.activeElement)) {
                (below.dialog.querySelector(".modal-footer .btn-primary, .modal-footer .btn-danger") || below.dialog).focus();
            }
        } else {
            entry.prevFocus?.focus?.();
        }
        entry.resolve(value);
    }

    function closeAll() { while (stack.length) close(null); }

    // One global key handler for Escape and the Tab focus trap.
    document.addEventListener("keydown", e => {
        const entry = top();
        if (!entry) return;
        if (e.key === "Escape") {
            e.preventDefault(); e.stopPropagation();
            if (entry.dismissible) close(null);
        } else if (e.key === "Tab") {
            const items = Utils.$$(FOCUSABLE, entry.dialog).filter(el => el.offsetParent !== null);
            if (!items.length) { e.preventDefault(); return; }
            const first = items[0], last = items[items.length - 1];
            if (e.shiftKey && (document.activeElement === first || document.activeElement === entry.dialog)) {
                e.preventDefault(); last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault(); first.focus();
            }
        }
    }, true);

    return {
        open, close, closeAll,
        get isOpen() { return stack.length > 0; },

        alert({ title, message, icon, buttonLabel = "OK" }) {
            return open({ title, icon, content: message, actions: [{ label: buttonLabel, value: true, variant: "primary" }] });
        },

        confirm({ title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false }) {
            return open({
                title, content: message, size: "sm",
                actions: [
                    { label: cancelLabel, value: false },
                    { label: confirmLabel, value: true, variant: danger ? "danger" : "primary" }
                ]
            }).then(v => v === true);
        },

        /** Resolves with the trimmed text, or null when cancelled. */
        prompt({ title, label, value = "", confirmLabel = "OK", validate, description, type = "text" }) {
            const input = Utils.h("input", { type, class: "input", value, id: Utils.uid("prompt"), autocomplete: "off" });
            const reveal = type === "password" ? Utils.h("label", { class: "check" },
                Utils.h("input", { type: "checkbox", onchange: e => { input.type = e.target.checked ? "text" : "password"; } }),
                Utils.h("span", { text: "Show password" })) : null;
            const error = Utils.h("p", { class: "field-error", role: "alert", hidden: true });
            const content = Utils.h("div", { class: "stack" },
                description ? Utils.h("p", { class: "muted", text: description }) : null,
                Utils.h("label", { class: "field-label", for: input.id, text: label }), input, reveal, error);
            return new Promise(resolve => {
                const submit = () => {
                    const text = input.value.trim();
                    const problem = !text ? "This field can't be empty." : validate?.(text);
                    if (problem) { error.textContent = problem; error.hidden = false; input.focus(); return; }
                    close(text);
                };
                open({
                    title, content, size: "sm",
                    actions: [
                        { label: "Cancel", value: null },
                        { label: confirmLabel, value: "__submit__", variant: "primary" }
                    ],
                    onOpen: dialog => {
                        input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
                        // Intercept the primary button so validation can keep the dialog open.
                        const btn = dialog.querySelector(".btn-primary");
                        btn.replaceWith(btn.cloneNode(true));
                        dialog.querySelector(".btn-primary").addEventListener("click", submit);
                    }
                }).then(v => resolve(v === "__submit__" ? null : v));
            });
        },

        /** Cancel / Discard / Save dialog. Resolves "cancel" | "discard" | "save". */
        unsaved({ name }) {
            return open({
                title: "You have unsaved changes", size: "sm", icon: "alert",
                content: `Save “${name}” before closing?`,
                actions: [
                    { label: "Cancel", value: "cancel" },
                    { label: "Discard", value: "discard", variant: "danger" },
                    { label: "Save", value: "save", variant: "primary", autofocus: true }
                ]
            }).then(v => v || "cancel");
        }
    };
})();
