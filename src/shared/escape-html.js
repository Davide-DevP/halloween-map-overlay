'use strict';

/**
 * PURE escaping. SECURITY RULE: **user text never reaches markup raw.** The
 * renderer has `nodeIntegration: true`, so an `<img src=x onerror=…>` in a
 * user-typed map name would execute with full Node access. Quotes too — an
 * unescaped `"` in a `data-key` truncates the key.
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
