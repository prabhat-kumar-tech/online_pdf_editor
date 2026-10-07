/**
 * config.js — application-level settings.
 * Every tunable value lives here; no module hard-codes the app name, limits or library URLs.
 */
const APP_CONFIG = {
    appName: "Online PDF Editor",
    tagline: "Your browser-based PDF workspace",
    version: "1.0.0",
    author: "Prabhat Kumar",
    developer: { name: "Prabhat Kumar", email: "prabhatkumar9304@gmail.com" },

    // Files
    // No software limits: how big a PDF / how many pages or files you can work with depends only on your
    // device's memory. Set a positive number below only if you want to impose a cap yourself (0 = none).
    maxFileSizeMB: 0,
    maxFiles: 0,
    largeFileWarnMB: 50,       // friendly heads-up only (0 = never); it does not block anything

    // Viewer
    defaultZoom: 1,            // 1 = 100 % (96 dpi: 1 PDF point = 1.333 CSS px)
    minZoom: 0.25,
    maxZoom: 4,
    zoomStep: 0.1,
    thumbWidth: 140,           // CSS px
    renderMaxPixels: 0,        // 0 = no software cap: use the most the browser can allocate for one page canvas

    // Editor
    historyLimit: 50,          // undo steps kept (0 = unlimited)
    defaultFont: "Arial",
    defaultFontSize: 14,
    defaultTextColor: "#000000",
    fonts: ["Arial", "Times New Roman", "Courier New"], // map to PDF standard fonts on export
    fontSizes: [8, 9, 10, 11, 12, 14, 16, 18, 24, 32, 48, 72],

    // Image -> PDF
    defaultPageSize: "A4",
    defaultMargin: 20,         // points; used as the "Medium" margin
    imageDpi: 96,              // used for "Original Size" (px -> pt)

    // Behaviour
    theme: "system",           // light | dark | system (user choice is remembered)
    enableDarkMode: true,
    enableDebug: false,
    enableLocalStorage: true,
    enableCompression: true,   // pdf-lib object streams when saving

    // Privacy: nothing is uploaded unless a server is explicitly configured (not implemented).
    serverProcessing: { enabled: false },

    // External libraries. Each entry is a list of URLs tried in order (CDN fallbacks).
    // To work fully offline, download the files into ./libs/ and put those paths first.
    libs: {
        pdfjs: {
            scripts: [
                "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
                "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js"
            ],
            workers: [
                "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
                "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js"
            ],
            cMapUrl: "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/",
            standardFontDataUrl: "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/standard_fonts/"
        },
        pdfLib: {
            scripts: [
                "https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js",
                "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js"
            ]
        },
        qpdf: { // WebAssembly qpdf, loaded on demand for password-protected PDFs (open + Protect PDF)
            scripts: [
                "https://cdn.jsdelivr.net/npm/@jspawn/qpdf-wasm@0.0.2/qpdf.js",
                "https://unpkg.com/@jspawn/qpdf-wasm@0.0.2/qpdf.js"
            ],
            optional: true
        },
        jszip: { // optional: only used to bundle several split files into one .zip
            scripts: [
                "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js",
                "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js"
            ],
            optional: true
        }
    }
};
