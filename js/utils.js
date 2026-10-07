/**
 * utils.js — shared infrastructure: Logger, Events (pub/sub), AppState, AppError and Utils.
 * Loaded first (after config.js); everything else depends on it.
 */
"use strict";

/* ------------------------------------------------------------------ Logger */
const Logger = (() => {
    const emit = (level, args) => {
        if (!APP_CONFIG.enableDebug) return;
        console[level](`[${APP_CONFIG.appName}]`, ...args);
    };
    return {
        info: (...a) => emit("info", a),
        warn: (...a) => emit("warn", a),
        error: (...a) => emit("error", a)
    };
})();

/* ------------------------------------------------------------------ Events */
const Events = (() => {
    const map = new Map();
    return {
        on(name, fn) {
            if (!map.has(name)) map.set(name, new Set());
            map.get(name).add(fn);
            return () => this.off(name, fn);
        },
        off(name, fn) { map.get(name)?.delete(fn); },
        emit(name, detail) {
            map.get(name)?.forEach(fn => {
                try { fn(detail); } catch (err) { Logger.error(`Listener for "${name}" failed`, err); }
            });
        }
    };
})();

/* --------------------------------------------------------------- AppState */
/** Single source of truth for application-level state. Change it through set() so UI can react. */
const AppState = {
    currentTool: null,
    currentFile: null,       // { name, size }
    pdfDocument: null,       // the editable document model owned by PDFEditor
    currentPage: 1,
    totalPages: 0,
    zoom: APP_CONFIG.defaultZoom,
    selectedObject: null,    // id of the primary selected annotation object
    selectedPages: [],       // page ids selected in the organizer
    history: [],
    historyIndex: -1,
    isDirty: false,
    busy: false,
    set(patch) {
        const changed = [];
        for (const [key, value] of Object.entries(patch)) {
            if (this[key] !== value) { this[key] = value; changed.push(key); }
        }
        if (changed.length) Events.emit("state:change", { changed });
    }
};

/* --------------------------------------------------------------- AppError */
/** An error whose title/message are safe and meant to be shown to the user. */
class AppError extends Error {
    constructor(title, message, cause) {
        super(message);
        this.name = "AppError";
        this.title = title;
        this.cause = cause;
    }
}

/* ------------------------------------------------------------------ Utils */
const Utils = {
    /** CSS px per PDF point at zoom 1 (96 dpi / 72 pt-per-inch). */
    PX_PER_PT: 96 / 72,

    _uid: 0,
    uid(prefix = "id") { return `${prefix}_${(++this._uid).toString(36)}${Math.random().toString(36).slice(2, 6)}`; },
    /**
     * Largest canvas (pixels) one render may use. With renderMaxPixels = 0 the app adds no cap of its own and
     * only respects what the browser can allocate (Safari/iOS ~16.7 MP, Chrome/Edge/Firefox ~268 MP).
     */
    maxCanvasPixels() {
        const cfg = APP_CONFIG.renderMaxPixels;
        if (cfg > 0) return cfg;
        return (this._canvasMax ||= /^((?!chrome|android|crios|fxios).)*safari|iphone|ipad/i.test(navigator.userAgent) ? 16777216 : 268435456);
    },

    clamp: (v, min, max) => Math.min(max, Math.max(min, v)),
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    /** Wait for the next paint, but never hang: rAF is paused in background tabs, so a timer races it. */
    nextFrame: () => new Promise(r => { requestAnimationFrame(() => r()); setTimeout(r, 50); }),

    formatBytes(bytes) {
        if (!Number.isFinite(bytes)) return "";
        if (bytes < 1024) return `${bytes} B`;
        const units = ["KB", "MB", "GB"];
        let v = bytes / 1024, i = 0;
        while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
        return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
    },

    debounce(fn, wait = 150) {
        let t;
        const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
        wrapped.cancel = () => clearTimeout(t);
        return wrapped;
    },

    throttle(fn, wait = 100) {
        let last = 0, timer = null;
        return (...args) => {
            const now = performance.now(), remaining = wait - (now - last);
            if (remaining <= 0) { last = now; fn(...args); }
            else if (!timer) {
                timer = setTimeout(() => { timer = null; last = performance.now(); fn(...args); }, remaining);
            }
        };
    },

    $: (sel, root = document) => root.querySelector(sel),
    $$: (sel, root = document) => Array.from(root.querySelectorAll(sel)),

    /**
     * Tiny DOM builder. Text is always inserted as text nodes (never innerHTML),
     * so file names or PDF text can never inject markup.
     */
    h(tag, props = {}, ...children) {
        const el = document.createElement(tag);
        for (const [key, value] of Object.entries(props || {})) {
            if (value === undefined || value === null || value === false) continue;
            if (key === "class") el.className = value;
            else if (key === "text") el.textContent = value;
            else if (key === "dataset") Object.assign(el.dataset, value);
            else if (key === "style" && typeof value === "object") Object.assign(el.style, value);
            else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
            else el.setAttribute(key, value === true ? "" : String(value));
        }
        const add = child => {
            if (child === null || child === undefined || child === false) return;
            if (Array.isArray(child)) child.forEach(add);
            else el.append(child instanceof Node ? child : document.createTextNode(String(child)));
        };
        children.forEach(add);
        return el;
    },

    /** SVG icon referencing a symbol of the sprite in index.html. */
    icon(name, cls = "") {
        const ns = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(ns, "svg");
        svg.setAttribute("class", `icon ${cls}`.trim());
        svg.setAttribute("aria-hidden", "true");
        const use = document.createElementNS(ns, "use");
        use.setAttribute("href", `#i-${name}`);
        svg.append(use);
        return svg;
    },

    baseName: name => String(name || "document").replace(/\.[^.]+$/, ""),
    extOf: name => (String(name).match(/\.([^.]+)$/) || [, ""])[1].toLowerCase(),
    sanitizeFilename: name => String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim(),

    hexToRgb01(hex) {
        const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
        const n = m ? parseInt(m[1], 16) : 0;
        return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
    },
    rgbToHex: (r, g, b) => "#" + [r, g, b].map(v => Utils.clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join(""),

    /* ---------------------------------------------------------------------
     * PAGE COORDINATE SYSTEMS
     *
     *  user space    PDF native: points, origin = bottom-left of the visible (crop) box
     *                (x0,y0), y grows UP.
     *  display space the page as the user sees it: after rotation R (clockwise, 0/90/180/270),
     *                origin = top-left, y grows DOWN, still in points.
     *  screen space  display space * scale, where scale = zoom * PX_PER_PT (CSS px).
     *
     *  geom = { x0, y0, w, h }: the visible rectangle in user space, UNROTATED size.
     * ------------------------------------------------------------------- */

    /** user space -> display space (points). */
    userToDisplay(ux, uy, geom, rotation) {
        const px = ux - geom.x0;                 // distance from left of unrotated page
        const py = geom.h - (uy - geom.y0);      // distance from top of unrotated page (flip y)
        switch (((rotation % 360) + 360) % 360) {
            case 90:  return { x: geom.h - py, y: px };
            case 180: return { x: geom.w - px, y: geom.h - py };
            case 270: return { x: py, y: geom.w - px };
            default:  return { x: px, y: py };
        }
    },

    /** display space (points) -> user space. Exact inverse of userToDisplay. */
    displayToUser(dx, dy, geom, rotation) {
        let px, py;
        switch (((rotation % 360) + 360) % 360) {
            case 90:  px = dy;            py = geom.h - dx; break;
            case 180: px = geom.w - dx;   py = geom.h - dy; break;
            case 270: px = geom.w - dy;   py = dx;          break;
            default:  px = dx;            py = dy;
        }
        return { x: geom.x0 + px, y: geom.y0 + geom.h - py };
    },

    /** PDF user-space point -> CSS pixel position inside the page element at `zoom`. */
    pdfToScreenCoordinates(ux, uy, geom, rotation, zoom) {
        const d = Utils.userToDisplay(ux, uy, geom, rotation);
        const s = zoom * Utils.PX_PER_PT;
        return { x: d.x * s, y: d.y * s };
    },

    /** CSS pixel position inside the page element at `zoom` -> PDF user-space point. */
    screenToPdfCoordinates(sx, sy, geom, rotation, zoom) {
        const s = zoom * Utils.PX_PER_PT;
        return Utils.displayToUser(sx / s, sy / s, geom, rotation);
    },

    /** "1-3, 5" -> sorted unique zero-based indexes. Throws Error with a friendly message. */
    parseRanges(text, total) {
        return [...new Set(Utils.parseRangeGroups(text, total).flat())].sort((a, b) => a - b);
    },

    /** "1-3, 5" -> [[0,1,2],[4]] (one group per comma separated part). */
    parseRangeGroups(text, total) {
        const parts = String(text || "").split(/[,;\s]+/).filter(Boolean);
        if (!parts.length) throw new Error("Enter at least one page number or range, for example 1-3, 5.");
        return parts.map(part => {
            const m = /^(\d+)(?:-(\d+))?$/.exec(part);
            if (!m) throw new Error(`"${part}" is not a valid page range.`);
            let a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
            if (a > b) [a, b] = [b, a];
            if (a < 1 || b > total) throw new Error(`"${part}" is outside this document (pages 1–${total}).`);
            const out = [];
            for (let i = a; i <= b; i++) out.push(i - 1);
            return out;
        });
    },

    /** Convert any thrown value into { title, message } suitable for the UI. */
    describeError(err) {
        if (err instanceof AppError) return { title: err.title, message: err.message };
        const name = err?.name || "", msg = String(err?.message || "");
        if (name === "PasswordException" || /password|encrypted/i.test(msg)) {
            return { title: "Password-protected PDF", message: "This PDF is protected with a password or encryption, and it could not be unlocked." };
        }
        if (name === "InvalidPDFException" || name === "FormatError" || /invalid pdf|no pdf header|failed to parse|bad xref|unexpected/i.test(msg)) {
            return { title: "Unable to open PDF", message: "The selected file may be corrupted, password protected, or unsupported." };
        }
        if (/memory|allocation|too large|out of range/i.test(msg) || name === "RangeError") {
            return { title: "Not enough memory", message: "The browser ran out of memory. This app sets no page or size limit — it depends on your device's free memory. Close other tabs or apps, or try a smaller file, fewer files at once, or lower quality settings." };
        }
        return { title: "Something went wrong", message: "The operation could not be completed. Please try again or use a different file." };
    }
};
