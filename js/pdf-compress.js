/**
 * pdf-compress.js — reduce PDF size.
 *  - "lossless": optimise the file structure; the level (1–200 %) chooses how thorough (visuals never change)
 *  - "raster":   re-draw every page as a JPEG; the level (0–200 %) trades quality for size (text becomes pixels)
 */
"use strict";

const PDFCompress = {
    file: null,
    _result: null, // { bytes, name }

    init() {
        UI.bindDropzone(document.getElementById("dz-compress"), {
            kinds: ["pdf"], multiple: false, onFiles: files => this.setFile(files)
        });
        document.querySelectorAll('input[name="cmode"]').forEach(r => r.addEventListener("change", () => this.render()));
        // number box and slider stay in sync; both are clamped to the mode's range (raster 0–200 %, lossless 1–200 %)
        const num = document.getElementById("compress-level"), range = document.getElementById("compress-level-range");
        range.addEventListener("input", () => { num.value = range.value; this._hint(); });
        num.addEventListener("input", () => { if (num.value !== "") range.value = String(this._parse(num.value)); this._hint(); });
        num.addEventListener("change", () => { num.value = String(this._level()); range.value = num.value; this._hint(); });
        this._hint();
        UI.register({
            "compress-run": () => this.run(),
            "compress-clear": () => this.reset(),
            "compress-reset": () => this.reset(),
            "compress-open": () => this._open(),
            "compress-download": () => this._download()
        });
    },

    _mode() { return document.querySelector('input[name="cmode"]:checked').value; },

    /** Lowest allowed level: 0 % is meaningful for the lossy method only. */
    _min() { return this._mode() === "raster" ? 0 : 1; },

    /** Text -> whole number within the mode's range (empty/garbage falls back to the default 100). */
    _parse(text) {
        const n = Number(text);
        return String(text).trim() === "" || !Number.isFinite(n) ? 100 : Utils.clamp(Math.round(n), this._min(), 200);
    },

    /** Current level as a whole number. */
    _level() { return this._parse(document.getElementById("compress-level").value); },

    _hint() {
        const level = this._level();
        document.getElementById("compress-level-hint").textContent = this._mode() === "raster"
            ? (({ dpi, quality }) => `Pages are re-drawn at about ${dpi} dpi with JPEG quality ${Math.round(quality * 100)}. 0 % = best quality, 200 % = smallest file.`)(PDFTools.levelToSettings(level))
            : (({ name, info }) => `${name}: ${info} Visible content is never changed; savings depend on the file.`)(PDFTools.losslessTier(level));
    },

    /** Keep label, slider/number limits and value in line with the selected method. */
    _syncLevelField() {
        const min = this._min(), num = document.getElementById("compress-level"), range = document.getElementById("compress-level-range");
        document.querySelector('label[for="compress-level"]').textContent = `Compression level (${min}–200 %)`;
        num.min = range.min = String(min);
        num.value = String(this._level());
        range.value = num.value;
        this._hint();
    },

    setFile(files) {
        const [file] = FileManager.filter(files, ["pdf"]);
        if (!file) return;
        this.file = file;
        this._result = null;
        this.render();
    },

    render() {
        const has = !!this.file;
        document.getElementById("dz-compress").hidden = has || !!this._result;
        document.getElementById("compress-panel").hidden = !has || !!this._result;
        document.getElementById("compress-result").hidden = !this._result;
        if (has) {
            document.getElementById("compress-name").textContent = this.file.name;
            document.getElementById("compress-size").textContent = Utils.formatBytes(this.file.size);
        }
        this._syncLevelField();                      // the level applies to both methods
    },

    async run() {
        if (!this.file) return;
        const mode = this._mode(), min = this._min();
        const rawText = document.getElementById("compress-level").value, rawLevel = Number(rawText);
        if (rawText.trim() === "" || !(rawLevel >= min && rawLevel <= 200)) { Toast.error(`Enter a compression level between ${min} and 200 %.`); return; }
        const level = this._level();
        try {
            const bytes = await PDFSecurity.ensureReadable(await FileManager.readBytes(this.file), this.file.name);
            if (!bytes) return;                      // password prompt cancelled
            const out = await UI.withProgress("Compressing PDF…", update =>
                mode === "raster" ? PDFTools.compressRaster(bytes, level, update) : PDFTools.compressLossless(bytes, level),
                { determinate: mode === "raster" });
            const name = `${Utils.baseName(this.file.name)}_compressed.pdf`;
            this._result = { bytes: out, name };
            const saved = 1 - out.length / this.file.size;
            document.getElementById("compress-result-info").textContent = saved > 0.005
                ? `${Utils.formatBytes(this.file.size)} → ${Utils.formatBytes(out.length)} (${Math.round(saved * 100)}% smaller)`
                : `${Utils.formatBytes(this.file.size)} → ${Utils.formatBytes(out.length)}. This file could not be made smaller with this method; keep the original.`;
            this.render();
        } catch (err) {
            UI.showError(err, { actionLabel: "Try Another File", onAction: () => this.reset() });
        }
    },

    async _open() {
        if (!this._result) return;
        if (await PDFEditor.openBytes(this._result.bytes.slice(), this._result.name)) App.openTool("viewer");
    },

    _download() {
        if (!this._result) return;
        FileManager.saveBlobAs(new Blob([this._result.bytes], { type: "application/pdf" }), this._result.name, { title: "Download compressed PDF" });
    },

    reset() {
        this.file = null;
        this._result = null;
        this.render();
    },
    cleanup() { this._result = null; },
    destroy() { this.reset(); }
};
