'use strict';

/**
 * Escape a value for interpolation into an HTML string.
 *
 * The renderer runs with `nodeIntegration: true`, so a `<img src=x onerror=…>`
 * that reaches the DOM executes with full Node access. Custom map names are
 * typed by the user and end up in markup (gallery cards, the custom list, the
 * hotkey tables, `<option>` values), so every one of those interpolations goes
 * through here. Quotes are escaped too — an unescaped `"` in a `data-key`
 * attribute silently truncates the key.
 */
function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

module.exports = {escapeHtml};
