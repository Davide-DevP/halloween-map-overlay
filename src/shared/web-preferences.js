'use strict';

/**
 * PURE. The `webPreferences` every window in this app is built with.
 *
 * Imports nothing — it is a plain object builder, so a test can assert the
 * four windows agree without pulling electron in.
 *
 * Two halves:
 *
 * 1. **`nodeIntegration: true`, `contextIsolation: false`** — the app's
 *    existing architecture (see "No context isolation" in `docs/agents/architecture.md`). Not a
 *    memory decision, repeated here only so there is one place that spells it.
 * 2. **The features this app does not have.** Each one is a whole Chromium
 *    subsystem that is initialised per renderer whether or not a page uses it:
 *    - `spellcheck: false` — Electron's default is `true`, which builds a
 *      `SpellCheckHost` and loads a dictionary for the system locale. The only
 *      text fields here are a map name and a read-only hotkey box.
 *    - `webgl: false` — nothing draws with WebGL. `src/js/overlay-preview.js`
 *      is a 2D canvas; the overlay is a PNG and an SVG.
 *    - `enableWebSQL: false` — a deprecated API the app never calls.
 *    Measured together (see `docs/MEMORY-REPORT-2.md`) they are worth a couple
 *    of MB per renderer, not a headline — but they are free and they cannot
 *    regress a feature that does not exist.
 *
 * `backgroundThrottling` is deliberately **left at Electron's default (on)**.
 * The main window sits hidden in the tray for a whole match and throttling its
 * timers is exactly what should happen there; the hotkeys it handles arrive as
 * IPC, which is not a timer.
 *
 * @param {Object} [extra] per-window additions, merged last so a window can
 *   still say something of its own.
 * @returns {Object} a fresh object every call — never share one between
 *   `BrowserWindow`s.
 */
function webPreferences(extra) {
    return Object.assign({
        nodeIntegration: true,
        contextIsolation: false,
        spellcheck: false,
        webgl: false,
        enableWebSQL: false
    }, extra || {});
}

module.exports = {webPreferences};
