/**
 * file-manager.js — validation, loading, metadata, object-URL lifecycle and downloads.
 * Files never leave the browser: everything goes through File / Blob / ArrayBuffer APIs.
 */
"use strict";

const FileManager = {
    MIME: {
        pdf: ["application/pdf"],
        image: ["image/jpeg", "image/png", "image/webp"]
    },
    EXT: {
        pdf: ["pdf"],
        image: ["jpg", "jpeg", "png", "webp"]
    },
    _urls: new Map(), // url -> owner tag

    /** "pdf" | "image" | null (MIME type first, extension as fallback). */
    classify(file) {
        for (const kind of Object.keys(this.MIME)) {
            if (this.MIME[kind].includes(file.type)) return kind;
        }
        const ext = Utils.extOf(file.name);
        for (const kind of Object.keys(this.EXT)) {
            if (!file.type && this.EXT[kind].includes(ext)) return kind;
        }
        return null;
    },

    acceptAttr(kinds) {
        return kinds.flatMap(k => [...this.MIME[k], ...this.EXT[k].map(e => "." + e)]).join(",");
    },

    /** @returns {{ok:boolean, kind?:string, reason?:string}} */
    validate(file, kinds = ["pdf", "image"]) {
        const kind = this.classify(file);
        if (!kind || !kinds.includes(kind)) {
            const wanted = kinds.map(k => k === "pdf" ? "PDF" : "JPG, PNG or WEBP image").join(" or ");
            return { ok: false, reason: `“${file.name}” is not supported. Please choose a ${wanted}.` };
        }
        const max = APP_CONFIG.maxFileSizeMB * 1024 * 1024;
        if (APP_CONFIG.maxFileSizeMB > 0 && file.size > max) {      // 0 = no limit (device memory decides)
            return { ok: false, reason: `“${file.name}” is ${Utils.formatBytes(file.size)}; the limit is ${APP_CONFIG.maxFileSizeMB} MB.` };
        }
        if (file.size === 0) return { ok: false, reason: `“${file.name}” is empty.` };
        return { ok: true, kind };
    },

    /** Validates a list, toasts every rejection and returns only the accepted files. */
    filter(files, kinds, { alreadyHave = 0 } = {}) {
        const accepted = [];
        for (const file of Array.from(files)) {
            const res = this.validate(file, kinds);
            if (!res.ok) { Toast.error(res.reason); continue; }
            if (APP_CONFIG.maxFiles > 0 && alreadyHave + accepted.length >= APP_CONFIG.maxFiles) {
                Toast.warning(`You can add at most ${APP_CONFIG.maxFiles} files.`);
                break;
            }
            accepted.push(file);
        }
        return accepted;
    },

    meta(file) {
        return { name: file.name, size: file.size, sizeLabel: Utils.formatBytes(file.size), type: file.type, kind: this.classify(file) };
    },

    async readBytes(file) {
        try {
            return new Uint8Array(await file.arrayBuffer());
        } catch (err) {
            throw new AppError("Unable to read file", `“${file.name}” could not be read. It may have been moved or deleted.`, err);
        }
    },

    /** Opens the native file picker. Resolves with [] if the user cancels. */
    pickFiles({ kinds = ["pdf"], multiple = false } = {}) {
        return new Promise(resolve => {
            const input = Utils.h("input", { type: "file", accept: this.acceptAttr(kinds), hidden: true });
            input.multiple = multiple;
            input.addEventListener("change", () => { resolve(Array.from(input.files)); input.remove(); });
            input.addEventListener("cancel", () => { resolve([]); input.remove(); });
            document.body.append(input);
            input.click();
        });
    },

    /* ---- object URLs: always created through here so they can be revoked ---- */
    createUrl(blob, owner = "default") {
        const url = URL.createObjectURL(blob);
        this._urls.set(url, owner);
        return url;
    },
    revokeUrl(url) {
        if (!url) return;
        URL.revokeObjectURL(url);
        this._urls.delete(url);
    },
    revokeOwner(owner) {
        for (const [url, o] of [...this._urls]) if (o === owner) this.revokeUrl(url);
    },

    downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = Utils.h("a", { href: url, download: filename, rel: "noopener", hidden: true });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 15000);
    },

    /** Ask for a file name (with the extension kept), resolves with the final name or null. */
    async promptFilename(defaultName, { title = "Download", confirmLabel = "Download", ext = "pdf" } = {}) {
        const result = await Modal.prompt({
            title, label: "Filename", value: defaultName, confirmLabel,
            validate: text => Utils.sanitizeFilename(text).replace(/\.+$/, "") ? null : "Please enter a valid file name."
        });
        if (!result) return null;
        let name = Utils.sanitizeFilename(result);
        if (!name.toLowerCase().endsWith("." + ext)) name += "." + ext;
        return name;
    },

    /** Prompt for a name, then download. Returns the saved name or null. */
    async saveBlobAs(blob, defaultName, opts = {}) {
        const name = await this.promptFilename(defaultName, opts);
        if (!name) return null;
        this.downloadBlob(blob, name);
        return name;
    }
};

/** Convenience global requested by the spec. */
const downloadBlob = (blob, filename) => FileManager.downloadBlob(blob, filename);
