/**
 * pdf-history.js — application-level undo/redo ("historyManager").
 *
 * A snapshot is the JSON of the lightweight document model (page list + annotation objects).
 * PDF bytes are never copied: pages only reference their source document, so even long
 * histories stay small. The editor supplies capture()/restore() callbacks via init().
 */
"use strict";

const PDFHistory = {
    _capture: null,
    _restore: null,
    savedIndex: -1,

    init({ capture, restore }) {
        this._capture = capture;
        this._restore = restore;
    },

    /** Forget everything (new document opened/closed). */
    clear() {
        this.savedIndex = -1;
        AppState.set({ history: [], historyIndex: -1 });
        Events.emit("history:change");
    },

    /** Record the current model as a new undo step. Returns false if nothing changed. */
    pushState(label = "Change") {
        if (!this._capture) return false;
        const snap = this._capture();
        const current = AppState.history[AppState.historyIndex];
        if (current && current.snap === snap) return false;

        const list = AppState.history.slice(0, AppState.historyIndex + 1); // drop redo branch
        list.push({ snap, label });
        while (APP_CONFIG.historyLimit > 0 && list.length > APP_CONFIG.historyLimit) { list.shift(); this.savedIndex--; }
        AppState.set({ history: list, historyIndex: list.length - 1 });
        this._sync();
        return true;
    },

    canUndo: () => AppState.historyIndex > 0,
    canRedo: () => AppState.historyIndex < AppState.history.length - 1,

    undo() { return this.canUndo() ? this._go(AppState.historyIndex - 1) : false; },
    redo() { return this.canRedo() ? this._go(AppState.historyIndex + 1) : false; },

    /** The current state matches what is on disk (after a successful save). */
    markSaved() {
        this.savedIndex = AppState.historyIndex;
        this._sync();
    },

    _go(index) {
        AppState.set({ historyIndex: index });
        this._restore(AppState.history[index].snap);
        this._sync();
        return true;
    },

    _sync() {
        AppState.set({ isDirty: AppState.historyIndex !== this.savedIndex });
        Events.emit("history:change");
    }
};
