/**
 * pdf-stamp.js — Watermark and Page Numbers.
 *
 * Both tools add ordinary text objects (tagged with `stamp: "watermark" | "numbers"`) to the
 * document model. That means they are previewed live on the page, are undoable, can be moved,
 * restyled or deleted individually in the Edit PDF tool, rotate with their page, and are written
 * by the normal export pipeline — no separate rendering path.
 */
"use strict";

const PDFStamp = {
    init() {
        UI.register({
            "wm-apply": () => this.applyWatermark(),
            "wm-remove": () => this.remove("watermark"),
            "pn-apply": () => this.applyNumbers(),
            "pn-remove": () => this.remove("numbers")
        });
        const opacity = document.getElementById("wm-opacity");
        opacity.addEventListener("input", () => { document.getElementById("wm-opacity-val").textContent = `${opacity.value}%`; });
        Events.on("tool:shown", ({ tool }) => {
            if (tool !== "watermark" && tool !== "numbers") return;
            const n = PDFEditor.doc?.pages.length || 0;
            document.getElementById(tool === "watermark" ? "wm-info" : "pn-info").textContent =
                `${PDFEditor.doc?.name || ""} · ${n} page${n === 1 ? "" : "s"}. The result is shown in Viewer / Edit PDF and saved with Save PDF.`;
        });
    },

    /** 0-based page indexes from an optional range input (empty = all pages). */
    _targets(inputId) {
        const doc = PDFEditor.doc, text = document.getElementById(inputId).value.trim();
        return text ? Utils.parseRanges(text, doc.pages.length) : doc.pages.map((_, i) => i);
    },

    _make(page, stamp, text, style) {
        const obj = {
            id: Utils.uid("obj"), type: "text", page: page.id, stamp, text, x: 0, y: 0, w: 10, h: 10, rotation: 0,
            autoWidth: true, fontFamily: "Arial", bold: false, italic: false, underline: false, align: "left", ...style
        };
        Object.assign(obj, PDFTextEditor.measureObject(obj));
        return obj;
    },

    _strip(kind, pageIds) {
        const doc = PDFEditor.doc, set = new Set(pageIds);
        let removed = 0;
        for (const id of set) {
            const list = doc.objects[id] || [];
            const next = list.filter(o => o.stamp !== kind);
            removed += list.length - next.length;
            doc.objects[id] = next;
        }
        return removed;
    },

    _finish(label, message) {
        PDFEditor.commit(label);
        PDFTextEditor.renderAll();
        Toast.success(message);
    },

    applyWatermark() {
        const doc = PDFEditor.doc;
        if (!doc) return;
        const text = document.getElementById("wm-text").value.trim();
        if (!text) { Toast.error("Enter the watermark text."); return; }
        let targets;
        try { targets = this._targets("wm-pages"); } catch (err) { Toast.error(err.message); return; }
        const style = {
            fontSize: Utils.clamp(Number(document.getElementById("wm-size").value) || 64, 8, 300),
            color: document.getElementById("wm-color").value, bold: true,
            opacity: Utils.clamp(Number(document.getElementById("wm-opacity").value) / 100, 0.05, 1)
        };
        const angle = Number(document.getElementById("wm-angle").value);
        const tiled = document.getElementById("wm-layout").value === "tiled";
        PDFTextEditor.finishEditing();
        this._strip("watermark", targets.map(i => doc.pages[i].id));

        for (const i of targets) {
            const page = doc.pages[i], { w: W, h: H } = PDFEditor.displaySize(page);
            const base = this._make(page, "watermark", text, { ...style, rotation: angle });
            const list = (doc.objects[page.id] ||= []);
            if (!tiled) {
                base.x = (W - base.w) / 2; base.y = (H - base.h) / 2;
                list.push(base);
                continue;
            }
            // Tiled: a staggered grid whose cell centres fall on (or just outside) the page.
            const stepX = base.w * 1.5, stepY = base.h * 3;
            let row = 0;
            for (let cy = stepY / 2; cy < H + stepY / 2; cy += stepY, row++) {
                for (let cx = (row % 2 ? stepX / 2 : 0); cx < W + stepX / 2; cx += stepX) {
                    list.push({ ...base, id: Utils.uid("obj"), x: cx - base.w / 2, y: cy - base.h / 2 });
                }
            }
        }
        this._finish("Add watermark", `Watermark added to ${targets.length} page${targets.length === 1 ? "" : "s"}.`);
    },

    applyNumbers() {
        const doc = PDFEditor.doc;
        if (!doc) return;
        let targets;
        try { targets = this._targets("pn-pages"); } catch (err) { Toast.error(err.message); return; }
        const v = id => document.getElementById(id).value;
        const format = v("pn-format"), [vert, horiz] = v("pn-position").split("-");
        const start = Math.floor(Number(v("pn-start"))) || 1;
        const margin = Utils.clamp(Number(v("pn-margin")) || 30, 0, 200);
        const style = { fontSize: Utils.clamp(Number(v("pn-size")) || 11, 6, 72), color: v("pn-color"), opacity: 1 };
        const total = doc.pages.length;
        PDFTextEditor.finishEditing();
        this._strip("numbers", targets.map(i => doc.pages[i].id));

        for (const i of targets) {
            const page = doc.pages[i], { w: W, h: H } = PDFEditor.displaySize(page);
            const n = start + i;
            const text = format.replace("{n}", n).replace("{total}", total + start - 1);
            const obj = this._make(page, "numbers", text, style);
            obj.x = horiz === "left" ? margin : horiz === "right" ? W - margin - obj.w : (W - obj.w) / 2;
            obj.y = vert === "top" ? margin : H - margin - obj.h;
            (doc.objects[page.id] ||= []).push(obj);
        }
        this._finish("Add page numbers", `Page numbers added to ${targets.length} page${targets.length === 1 ? "" : "s"}.`);
    },

    remove(kind) {
        const doc = PDFEditor.doc;
        if (!doc) return;
        const removed = this._strip(kind, doc.pages.map(p => p.id));
        if (!removed) { Toast.info(kind === "watermark" ? "There is no watermark to remove." : "There are no page numbers to remove."); return; }
        PDFTextEditor.finishEditing();
        this._finish(kind === "watermark" ? "Remove watermark" : "Remove page numbers", "Removed. Press Ctrl+Z to undo.");
    },

    reset() {},
    cleanup() {},
    destroy() {}
};
