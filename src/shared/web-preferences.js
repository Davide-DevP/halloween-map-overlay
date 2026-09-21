'use strict';

/**
 * PURE: the `webPreferences` all four windows are built with. Imports nothing,
 * so a test can assert they agree without electron.
 *
 * `spellcheck`/`webgl`/`enableWebSQL` are off because the app has none of those
 * features; `backgroundThrottling` is deliberately left at Electron's default.
 * Both decisions and their measurements: docs/agents/memory.md.
 *
 * @param {Object} [extra] per-window additions, merged last.
 * @returns {Object} a fresh object every call — never share one between windows.
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
