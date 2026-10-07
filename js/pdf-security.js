/**
 * pdf-security.js — password-protected PDFs.
 *
 *  - OPEN: when a PDF needs a password, ask for it, verify it and decrypt a copy *in memory* so the
 *    normal tools (edit, merge, split, …) work. The saved result is not password protected unless the
 *    Protect PDF tool is used again.
 *  - MAKE: Protect PDF encrypts the current document with AES-256 (open password, optional owner
 *    password and permissions: print / copy / modify / annotate).
 *
 * Cryptography is done by qpdf compiled to WebAssembly (@jspawn/qpdf-wasm), downloaded from the
 * configured CDN the first time it is needed (~1.3 MB). Passwords never leave the browser.
 */
"use strict";

const PDFSecurity = {
    _q: null,
    _loading: null,

    init() {
        UI.register({ "protect-run": () => this.protect() });
        const show = document.getElementById("pw-show");
        show.addEventListener("change", () => {
            ["pw-user", "pw-user2", "pw-owner"].forEach(id => { document.getElementById(id).type = show.checked ? "text" : "password"; });
        });
        Events.on("tool:shown", ({ tool }) => {
            if (tool !== "protect") return;
            const n = PDFEditor.doc?.pages.length || 0;
            document.getElementById("pw-info").textContent = `${PDFEditor.doc?.name || ""} · ${n} page${n === 1 ? "" : "s"}. The open document stays unprotected; the downloaded copy is encrypted.`;
        });
    },

    /* ------------------------------------------------------------ engine */
    /** Load qpdf-wasm on first use. */
    async _engine() {
        if (this._q) return this._q;
        this._loading ||= (async () => {
            const cfg = APP_CONFIG.libs.qpdf;
            const url = await App._loadFirst(cfg.scripts);
            const base = url.replace(/qpdf\.js$/, "");
            return window.Module({ locateFile: f => base + f, print: () => {}, printErr: () => {} });
        })();
        try {
            this._q = await this._loading;
            return this._q;
        } catch (err) {
            this._loading = null;
            Logger.error("qpdf load failed", err);
            throw new AppError("Security engine unavailable",
                "The encryption engine could not be downloaded. Please check your internet connection or the library source in config.js, then try again.", err);
        }
    },

    /** Run qpdf on `bytes`; returns the output bytes or null when qpdf reports a failure. */
    async _run(bytes, args) {
        const q = await this._engine();
        q.FS.writeFile("/in.pdf", bytes);
        let status;
        try { status = q.callMain([...args, "/in.pdf", "/out.pdf"]); } catch (err) { status = err?.status ?? 1; }
        let out = null;
        if (status === 0 || status === 3) {                 // 3 = finished with warnings, output exists
            try { out = q.FS.readFile("/out.pdf").slice(); } catch (_) { out = null; }
        }
        for (const f of ["/in.pdf", "/out.pdf"]) { try { q.FS.unlink(f); } catch (_) { /* not there */ } }
        return out;
    },

    /** Decrypted copy of `bytes`, or null if the password is wrong. */
    decrypt(bytes, password) { return this._run(bytes, [`--password=${password}`, "--decrypt"]); },

    /* ------------------------------------------------------------ opening protected files */
    isPasswordError(err) {
        return err?.cause?.name === "PasswordException" || err?.name === "PasswordException";
    },

    /**
     * Ask for the password until it works or the user cancels.
     * Call this when no progress overlay is showing (it would cover the dialog).
     * @returns {Promise<Uint8Array|null>} decrypted bytes, or null if cancelled
     */
    async unlockWithPrompt(bytes, name) {
        let note = "This PDF is password-protected. Enter its password to open it. The password is only used in your browser.";
        for (;;) {
            const password = await Modal.prompt({
                title: "Password required", label: `Password for “${name}”`, type: "password",
                description: note, confirmLabel: "Unlock"
            });
            if (!password) return null;
            const out = await UI.withProgress("Unlocking PDF…", () => this.decrypt(bytes, password));
            if (out) {
                Toast.info("Unlocked. The copy you save will not be password protected — use Protect PDF to add a password again.", { duration: 7000 });
                return out;
            }
            note = "⚠ Incorrect password. Please try again.";
        }
    },

    /** Returns bytes that PDF.js/pdf-lib can read (decrypting after a password prompt), or null if cancelled. */
    async ensureReadable(bytes, name) {
        try {
            (await PDFTools.openPdfJs(bytes)).destroy();
            return bytes;
        } catch (err) {
            if (!this.isPasswordError(err)) throw err;
            return this.unlockWithPrompt(bytes, name);
        }
    },

    /* ------------------------------------------------------------ making protected files */
    _randomPassword() {
        const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
        return Array.from(crypto.getRandomValues(new Uint8Array(20)), b => chars[b % chars.length]).join("");
    },

    /** AES-256 encryption. `perms`: { print, copy, modify, annotate } booleans. */
    encrypt(bytes, { user, owner, perms }) {
        const modify = perms.modify ? "all" : perms.annotate ? "annotate" : "none";
        return this._run(bytes, [
            "--encrypt", user, owner, "256",
            `--print=${perms.print ? "full" : "none"}`, `--modify=${modify}`, `--extract=${perms.copy ? "y" : "n"}`, "--"
        ]);
    },

    async protect() {
        const doc = PDFEditor.doc;
        if (!doc) return;
        const v = id => document.getElementById(id).value;
        const user = v("pw-user");
        if (!user) { Toast.error("Enter a password to protect the PDF."); return; }
        if (user !== v("pw-user2")) { Toast.error("The two passwords do not match."); return; }
        const generated = !v("pw-owner");
        const owner = generated ? this._randomPassword() : v("pw-owner");
        const perms = { print: document.getElementById("pw-print").checked, copy: document.getElementById("pw-copy").checked,
            modify: document.getElementById("pw-modify").checked, annotate: document.getElementById("pw-annotate").checked };

        PDFTextEditor.finishEditing();
        const name = await FileManager.promptFilename(`${Utils.baseName(doc.name)}_protected.pdf`, { title: "Save protected PDF", confirmLabel: "Protect & download" });
        if (!name) return;
        try {
            const out = await UI.withProgress("Protecting PDF…", async update => {
                const { bytes } = await PDFTools.buildPdf(doc, { onProgress: (f, t) => update(f * 0.8, t) });
                update(0.85, "Encrypting");
                const enc = await this.encrypt(bytes, { user, owner, perms });
                if (!enc) throw new AppError("Unable to protect PDF", "The PDF could not be encrypted. Try different passwords (very unusual characters can cause problems).");
                return enc;
            }, { determinate: true });
            FileManager.downloadBlob(new Blob([out], { type: "application/pdf" }), name);
            Toast.success(`Saved ${name} (${Utils.formatBytes(out.length)}), encrypted with AES-256.`);
            ["pw-user", "pw-user2", "pw-owner"].forEach(id => { document.getElementById(id).value = ""; });
            if (generated) {
                await Modal.alert({
                    title: "Keep your owner password", icon: "lock",
                    message: `The file opens with the password you chose. Its permissions can only be changed with this generated owner password — store it somewhere safe:  ${owner}`
                });
            }
        } catch (err) {
            UI.showError(err instanceof AppError ? err : new AppError("Unable to protect PDF", "The PDF could not be encrypted."));
        }
    },

    reset() { },
    cleanup() { },
    destroy() { this._q = null; this._loading = null; }
};
