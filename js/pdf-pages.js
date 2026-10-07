/**
 * pdf-pages.js — page management: thumbnail grid, selection, drag & drop reorder,
 * rotate / delete / duplicate / extract / insert, plus the Split tool.
 *
 * All operations edit the lightweight page model (PDFEditor.doc.pages) and then call
 * PDFEditor.pagesChanged(label), which records an undo step and refreshes every view.
 */
"use strict";

const PDFPages = {
    grid: null,
    _stale: true,
    _anchor: null,
    _drag: null,

    HINTS: {
        organize: "Drag pages to reorder them. Click to select; use Ctrl or Shift to select several.",
        rotate: "Select pages and rotate them, or rotate every page at once.",
        delete: "Select the pages to remove, or enter a range such as 2-4, 7. Deleting can be undone.",
        extract: "Select pages (or enter a range) and extract them into a new PDF. The open document is not changed."
    },

    init() {
        this.grid = document.getElementById("org-grid");
        this.grid.setAttribute("role", "listbox");
        this.grid.setAttribute("aria-multiselectable", "true");

        UI.register({
            "org-select-all": () => this.selectAll(),
            "org-clear": () => this.setSelection([]),
            "org-rotate-left": () => this.rotate(this.selectedIds(), -90),
            "org-rotate-right": () => this.rotate(this.selectedIds(), 90),
            "org-rotate-all-left": () => this.rotate(this.allIds(), -90),
            "org-rotate-all-right": () => this.rotate(this.allIds(), 90),
            "org-duplicate": () => this.duplicate(this.selectedIds()),
            "org-delete": () => this.remove(this.selectedIds()),
            "org-extract": () => this.extract(this.selectedIds()),
            "org-insert-blank": () => this.insertBlank(),
            "org-insert-pdf": () => this.insertPdf(),
            "org-delete-range": () => this.withRange("org-range-delete", ids => this.remove(ids)),
            "org-extract-range": () => this.withRange("org-range-extract", ids => this.extract(ids)),
            "split-run": () => this.runSplit()
        });
        // Live preview: repaint which file each page goes to whenever the split options change.
        const repaint = Utils.debounce(() => this.paintSplit(), 120);
        document.querySelectorAll('input[name="smode"]').forEach(r => r.addEventListener("change", repaint));
        // Typing in a mode's own field selects that mode, so the preview matches what the user is editing.
        [["split-n", "every"], ["split-ranges", "ranges"]].forEach(([id, mode]) => {
            const input = document.getElementById(id);
            const select = () => { document.querySelector(`input[name="smode"][value="${mode}"]`).checked = true; };
            input.addEventListener("focus", () => { select(); repaint(); });
            input.addEventListener("input", () => { select(); repaint(); });
        });
    },

    isActive() { return UI.ORGANIZER_TOOLS.includes(AppState.currentTool); },

    /** Called when an organizer-type tool (or the split tool) becomes visible. */
    onShown(tool) {
        if (tool === "split") {
            const doc = PDFEditor.doc;
            document.getElementById("split-info").textContent =
                doc ? `${doc.name} · ${doc.pages.length} page${doc.pages.length === 1 ? "" : "s"}` : "";
            this.renderSplit();
            return;
        }
        document.getElementById("org-hint").textContent = this.HINTS[tool] || "";
        if (this._stale) this.render();
    },

    /* ------------------------------------------------------------ rendering */
    render() {
        const doc = PDFEditor.doc;
        if (AppState.currentTool === "split") this.renderSplit();     // keep the split preview in step with edits/undo
        if (!this.isActive()) { this._stale = true; return; }
        this._stale = false;
        this.grid.replaceChildren();
        if (!doc) return;
        const valid = new Set(doc.pages.map(p => p.id));
        const sel = AppState.selectedPages.filter(id => valid.has(id));
        if (sel.length !== AppState.selectedPages.length) AppState.set({ selectedPages: sel });
        doc.pages.forEach((page, i) => this.grid.append(this._card(page, i)));
        this._paintSelection();
    },

    _card(page, index) {
        const canvas = Utils.h("canvas");
        PDFViewer.observeThumb(canvas, page, 150);
        const checkbox = Utils.h("input", {
            type: "checkbox", class: "org-check", tabindex: "-1", "aria-label": `Select page ${index + 1}`,
            onclick: e => { e.stopPropagation(); this._toggle(page.id, true, false); },
            onchange: () => {}
        });
        const btn = (icon, label, fn) => Utils.h("button", {
            type: "button", class: "icon-btn icon-btn-sm", "aria-label": `${label} (page ${index + 1})`, "data-tip": label,
            draggable: "false",
            onclick: e => { e.stopPropagation(); fn(); }
        }, Utils.icon(icon));

        const li = Utils.h("li", {
            class: "org-page", role: "option", tabindex: "0", draggable: "true",
            "aria-label": `Page ${index + 1}`, dataset: { pageId: page.id }
        },
            checkbox,
            Utils.h("div", { class: "org-thumb" }, canvas),
            Utils.h("div", { class: "org-label" }, Utils.h("span", { text: `Page ${index + 1}` }),
                Utils.h("span", { class: "org-actions" },
                    btn("rotate-cw", "Rotate clockwise", () => this.rotate([page.id], 90)),
                    btn("copy", "Duplicate page", () => this.duplicate([page.id])),
                    btn("trash", "Delete page", () => this.remove([page.id]))))
        );

        li.addEventListener("click", e => this._toggle(page.id, e.ctrlKey || e.metaKey, e.shiftKey));
        li.addEventListener("keydown", e => this._onKey(e, page.id));
        li.addEventListener("dragstart", e => this._dragStart(e, page.id, li));
        li.addEventListener("dragover", e => this._dragOver(e, li));
        li.addEventListener("dragleave", () => li.classList.remove("drop-before", "drop-after"));
        li.addEventListener("drop", e => this._drop(e, page.id, li));
        li.addEventListener("dragend", () => this._dragEnd());
        return li;
    },

    /* ------------------------------------------------------------ selection */
    selectedIds() {
        // keep document order regardless of click order
        const set = new Set(AppState.selectedPages);
        return (PDFEditor.doc?.pages || []).filter(p => set.has(p.id)).map(p => p.id);
    },
    allIds() { return (PDFEditor.doc?.pages || []).map(p => p.id); },

    setSelection(ids) {
        AppState.set({ selectedPages: ids });
        this._paintSelection();
    },

    selectAll() { this.setSelection(this.allIds()); },

    _toggle(id, additive, range) {
        const all = this.allIds();
        let sel = new Set(AppState.selectedPages);
        if (range && this._anchor && all.includes(this._anchor)) {
            const a = all.indexOf(this._anchor), b = all.indexOf(id);
            sel = new Set(all.slice(Math.min(a, b), Math.max(a, b) + 1));
        } else if (additive) {
            if (sel.has(id)) sel.delete(id); else sel.add(id);
            this._anchor = id;
        } else {
            sel = sel.size === 1 && sel.has(id) ? new Set() : new Set([id]);
            this._anchor = id;
        }
        this.setSelection([...sel]);
    },

    _paintSelection() {
        const sel = new Set(AppState.selectedPages);
        for (const li of this.grid.children) {
            const on = sel.has(li.dataset.pageId);
            li.classList.toggle("selected", on);
            li.setAttribute("aria-selected", String(on));
            li.querySelector(".org-check").checked = on;
        }
    },

    _onKey(e, id) {
        if (e.target.closest("button")) return;
        const kids = Array.from(this.grid.children);
        const i = kids.findIndex(li => li.dataset.pageId === id);
        if (e.key === " " || e.key === "Enter") { e.preventDefault(); this._toggle(id, true, false); }
        else if (e.key === "Delete" || e.key === "Backspace") {
            e.preventDefault();
            const ids = AppState.selectedPages.length ? this.selectedIds() : [id];
            this.remove(ids);
        } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
            e.preventDefault();
            const dir = e.key === "ArrowRight" ? 1 : -1;
            if (e.ctrlKey || e.metaKey) {
                const target = kids[i + dir];
                if (target) {
                    this.move([id], target.dataset.pageId, dir > 0);
                    requestAnimationFrame(() => this.grid.querySelector(`[data-page-id="${id}"]`)?.focus());
                }
            } else kids[i + dir]?.focus();
        }
    },

    /* ------------------------------------------------------------ drag & drop */
    _dragStart(e, id, li) {
        const selected = this.selectedIds();
        this._drag = selected.includes(id) && selected.length > 1 ? selected : [id];
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", `page:${id}`);
        li.classList.add("dragging");
    },
    _dragOver(e, li) {
        if (!this._drag) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const r = li.getBoundingClientRect();
        const after = e.clientX > r.left + r.width / 2;
        li.classList.toggle("drop-after", after);
        li.classList.toggle("drop-before", !after);
    },
    _drop(e, targetId, li) {
        if (!this._drag) return;
        e.preventDefault();
        const r = li.getBoundingClientRect();
        const after = e.clientX > r.left + r.width / 2;
        const ids = this._drag;
        this._dragEnd();
        this.move(ids, targetId, after);
    },
    _dragEnd() {
        this._drag = null;
        this.grid.querySelectorAll(".dragging,.drop-before,.drop-after").forEach(el => el.classList.remove("dragging", "drop-before", "drop-after"));
    },

    /* ------------------------------------------------------------ operations */
    /** Move pages (kept in document order) before/after the target page. */
    move(ids, targetId, after) {
        const doc = PDFEditor.doc;
        const moving = new Set(ids);
        if (moving.has(targetId)) return;
        const moved = doc.pages.filter(p => moving.has(p.id));
        const rest = doc.pages.filter(p => !moving.has(p.id));
        const at = rest.findIndex(p => p.id === targetId) + (after ? 1 : 0);
        const next = [...rest.slice(0, at), ...moved, ...rest.slice(at)];
        if (next.every((p, i) => p === doc.pages[i])) return;
        doc.pages = next;
        PDFEditor.pagesChanged(ids.length > 1 ? "Reorder pages" : "Reorder page");
    },

    /**
     * Rotate pages by a multiple of 90° (positive = clockwise). Annotation objects on the page
     * rotate with it: each box's centre is rotated around the page and its own rotation advances.
     */
    rotate(ids, delta) {
        const doc = PDFEditor.doc;
        if (!doc || !ids.length) return;
        const steps = (((delta % 360) + 360) % 360) / 90;
        const set = new Set(ids);
        for (const page of doc.pages) {
            if (!set.has(page.id)) continue;
            let { w: W, h: H } = PDFEditor.displaySize(page);
            for (let k = 0; k < steps; k++) {
                for (const obj of doc.objects[page.id] || []) {
                    const cx = obj.x + obj.w / 2, cy = obj.y + obj.h / 2;
                    const ncx = H - cy, ncy = cx;                      // 90° clockwise about the page
                    obj.x = ncx - obj.w / 2;
                    obj.y = ncy - obj.h / 2;
                    obj.rotation = ((obj.rotation || 0) + 90) % 360;
                }
                [W, H] = [H, W];
            }
            page.rot = (page.rot + steps * 90) % 360;
        }
        PDFEditor.pagesChanged(delta > 0 ? "Rotate pages clockwise" : "Rotate pages counter-clockwise");
    },

    remove(ids) {
        const doc = PDFEditor.doc;
        if (!doc || !ids.length) return;
        if (ids.length >= doc.pages.length) {
            Toast.warning("A document needs at least one page. Add a page first or close the document instead.");
            return;
        }
        const set = new Set(ids);
        doc.pages = doc.pages.filter(p => !set.has(p.id));
        ids.forEach(id => delete doc.objects[id]);
        AppState.set({ selectedPages: AppState.selectedPages.filter(id => !set.has(id)) });
        PDFEditor.pagesChanged(ids.length > 1 ? `Delete ${ids.length} pages` : "Delete page");
        Toast.info(`${ids.length} page${ids.length === 1 ? "" : "s"} deleted. Press Ctrl+Z to undo.`);
    },

    duplicate(ids) {
        const doc = PDFEditor.doc;
        if (!doc || !ids.length) return;
        const set = new Set(ids), copies = [], next = [];
        for (const page of doc.pages) {
            next.push(page);
            if (!set.has(page.id)) continue;
            const copy = { ...page, id: Utils.uid("pg"), geom: { ...page.geom } };
            doc.objects[copy.id] = (doc.objects[page.id] || []).map(o => ({ ...o, id: Utils.uid("obj"), page: copy.id }));
            copies.push(copy.id);
            next.push(copy);
        }
        doc.pages = next;
        AppState.set({ selectedPages: copies });
        PDFEditor.pagesChanged("Duplicate pages");
    },

    insertBlank() {
        const doc = PDFEditor.doc;
        if (!doc) return;
        const sel = this.selectedIds();
        const refId = sel.length ? sel[sel.length - 1] : doc.pages[doc.pages.length - 1].id;
        const at = doc.pages.findIndex(p => p.id === refId) + 1;
        const { w, h } = PDFEditor.displaySize(doc.pages[at - 1]);
        const blank = { id: Utils.uid("pg"), src: -1, idx: 0, rot: 0, native: 0, blank: true, geom: { x0: 0, y0: 0, w, h } };
        doc.pages.splice(at, 0, blank);
        AppState.set({ selectedPages: [blank.id] });
        PDFEditor.pagesChanged("Insert blank page");
    },

    async insertPdf() {
        const doc = PDFEditor.doc;
        if (!doc) return;
        const [file] = await FileManager.pickFiles({ kinds: ["pdf"] });
        if (!file) return;
        const ok = FileManager.filter([file], ["pdf"]);
        if (!ok.length) return;
        try {
            const bytes = await PDFSecurity.ensureReadable(await FileManager.readBytes(file), file.name);   // asks for a password if needed
            if (!bytes) return;
            const pages = await UI.withProgress("Reading PDF…", () => PDFEditor.loadPagesFromFile(file, bytes));
            const sel = this.selectedIds();
            const refId = sel.length ? sel[sel.length - 1] : doc.pages[doc.pages.length - 1].id;
            const at = doc.pages.findIndex(p => p.id === refId) + 1;
            doc.pages.splice(at, 0, ...pages);
            AppState.set({ selectedPages: pages.map(p => p.id) });
            PDFEditor.pagesChanged(`Insert ${pages.length} pages`);
            Toast.success(`Inserted ${pages.length} page${pages.length === 1 ? "" : "s"} from ${file.name}.`);
        } catch (err) {
            UI.showError(err);
        }
    },

    async extract(ids) {
        const doc = PDFEditor.doc;
        if (!doc || !ids.length) { Toast.info("Select at least one page first."); return; }
        const name = await FileManager.promptFilename(`${Utils.baseName(doc.name)}_extract.pdf`, { title: "Extract pages", confirmLabel: "Extract & download" });
        if (!name) return;
        try {
            const { bytes } = await UI.withProgress("Extracting pages…", p => PDFTools.buildPdf(doc, { pageIds: ids, onProgress: p }), { determinate: true });
            FileManager.downloadBlob(new Blob([bytes], { type: "application/pdf" }), name);
            Toast.success(`Extracted ${ids.length} page${ids.length === 1 ? "" : "s"} to ${name}.`);
        } catch (err) {
            UI.showError(err);
        }
    },

    /** Parse the page range typed into an input and pass the matching page ids to fn. */
    withRange(inputId, fn) {
        const doc = PDFEditor.doc;
        if (!doc) return;
        try {
            const indexes = Utils.parseRanges(document.getElementById(inputId).value, doc.pages.length);
            fn(indexes.map(i => doc.pages[i].id));
        } catch (err) {
            Toast.error(err.message);
        }
    },

    /* ------------------------------------------------------------ split */
    /**
     * What the current Split options would produce.
     * @returns {{groups:number[][], namer:(i:number,g:number[])=>string}}  groups are lists of 0-based page indexes
     * @throws {Error} with a friendly message when the options are invalid
     */
    _splitPlan() {
        const doc = PDFEditor.doc, total = doc.pages.length, base = Utils.baseName(doc.name);
        const mode = document.querySelector('input[name="smode"]:checked').value;
        if (mode === "each") {
            return { groups: doc.pages.map((_, i) => [i]), namer: i => `${base}_page_${i + 1}.pdf` };
        }
        if (mode === "every") {
            const n = Math.floor(Number(document.getElementById("split-n").value));
            if (!(n >= 1)) throw new Error("Enter how many pages each file should contain (1 or more).");
            const groups = [];
            for (let i = 0; i < total; i += n) groups.push(Array.from({ length: Math.min(n, total - i) }, (_, k) => i + k));
            return { groups, namer: i => `${base}_part_${i + 1}.pdf` };
        }
        return {
            groups: Utils.parseRangeGroups(document.getElementById("split-ranges").value, total),
            namer: (i, g) => `${base}_pages_${g[0] + 1}-${g[g.length - 1] + 1}.pdf`
        };
    },

    /** Thumbnails of every page under the split options (rebuilt when the pages change). */
    renderSplit() {
        const grid = document.getElementById("split-grid"), doc = PDFEditor.doc;
        grid.replaceChildren();
        if (!doc) return;
        document.getElementById("split-info").textContent = `${doc.name} · ${doc.pages.length} page${doc.pages.length === 1 ? "" : "s"}`;
        doc.pages.forEach((page, i) => {
            const canvas = Utils.h("canvas");
            PDFViewer.observeThumb(canvas, page, 100);
            grid.append(Utils.h("li", { class: "split-card", dataset: { index: i } },
                Utils.h("div", {}, canvas),
                Utils.h("div", { class: "split-meta" }, Utils.h("span", { class: "split-num", text: `Page ${i + 1}` }), Utils.h("span", { class: "split-tags" }))));
        });
        this.paintSplit();
    },

    /** Colour each page by the output file(s) it will end up in, and summarise. */
    paintSplit() {
        const doc = PDFEditor.doc, summary = document.getElementById("split-summary");
        if (!doc || AppState.currentTool !== "split") return;
        let plan;
        try { plan = this._splitPlan(); } catch (err) {
            summary.textContent = err.message;
            for (const li of document.getElementById("split-grid").children) {
                li.classList.remove("excluded"); li.style.removeProperty("--g"); li.querySelector(".split-tags").replaceChildren();
            }
            return;
        }
        const files = doc.pages.map(() => []);
        plan.groups.forEach((g, gi) => g.forEach(idx => files[idx].push(gi)));
        for (const li of document.getElementById("split-grid").children) {
            const list = files[Number(li.dataset.index)];
            li.classList.toggle("excluded", list.length === 0);
            if (list.length) li.style.setProperty("--g", `hsl(${(list[0] * 47) % 360} 65% 42%)`); else li.style.removeProperty("--g");
            li.querySelector(".split-tags").replaceChildren(...(list.length
                ? list.map(g => Utils.h("span", { class: "split-badge", style: { "--g": `hsl(${(g * 47) % 360} 65% 42%)` }, text: `File ${g + 1}` }))
                : [Utils.h("span", { class: "split-badge", text: "Not included" })]));
        }
        const skipped = files.filter(l => !l.length).length;
        summary.textContent = `This will create ${plan.groups.length} file${plan.groups.length === 1 ? "" : "s"}`
            + (skipped ? `; ${skipped} page${skipped === 1 ? " is" : "s are"} not included.` : ".");
    },

    async runSplit() {
        const doc = PDFEditor.doc;
        if (!doc) return;
        const base = Utils.baseName(doc.name);
        let groups, namer;
        try {
            ({ groups, namer } = this._splitPlan());
        } catch (err) {
            Toast.error(err.message);
            return;
        }
        if (groups.length > 200 && !(await Modal.confirm({ title: "Create many files?", message: `This will create ${groups.length} files. Continue?`, confirmLabel: "Continue" }))) return;

        try {
            const files = await UI.withProgress("Splitting PDF…", p => PDFTools.splitGroups(doc, groups, namer, p), { determinate: true });
            const canZip = typeof JSZip !== "undefined" && document.getElementById("split-zip").checked;
            if (files.length === 1) {
                await FileManager.saveBlobAs(new Blob([files[0].bytes], { type: "application/pdf" }), files[0].name, { title: "Save PDF" });
            } else if (canZip) {
                const zip = await UI.withProgress("Creating .zip…", () => PDFTools.zip(files));
                await FileManager.saveBlobAs(zip, `${base}_split.zip`, { title: "Save split files", ext: "zip" });
            } else {
                Toast.info("Downloading files one by one. Your browser may ask to allow multiple downloads.");
                for (const f of files) {
                    FileManager.downloadBlob(new Blob([f.bytes], { type: "application/pdf" }), f.name);
                    await Utils.sleep(350);
                }
            }
            Toast.success(`Split into ${files.length} file${files.length === 1 ? "" : "s"}.`);
        } catch (err) {
            UI.showError(err);
        }
    },

    /* ------------------------------------------------------------ lifecycle */
    reset() {
        this.grid.replaceChildren();
        document.getElementById("split-grid").replaceChildren();
        this._stale = true;
        this._anchor = null;
        this._drag = null;
    },
    cleanup() { this.reset(); },
    destroy() { this.reset(); }
};
