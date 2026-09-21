'use strict';

/**
 * PURE redaction for anything that reaches a log or a diagnostic report.
 * PRIVACY RULE: **a log the owner asks a stranger to email must not carry that
 * stranger's name** — and a stack trace or an `ENOENT` is where a path arrives
 * without anyone deciding to log it.
 */

/** Escape a literal string for use inside a RegExp. */
function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every occurrence of `home` (`app.getPath('home')`) in `value` → `~`.
 * Non-strings are stringified; null/undefined give ''.
 */
function redactHome(value, home) {
    if (value === null || value === undefined) return '';
    let text = String(value);
    if (!home) return text;
    const raw = String(home).replace(/[\\/]+$/, '');
    if (!raw) return text;
    // Both separator spellings (a stack trace holds `C:\Users\…`, a Node URL
    // `C:/Users/…`), case-insensitive because Windows paths are, and escaped
    // first so a `+` or `(` in the home path cannot build a wider pattern.
    const variants = new Set([raw, raw.replace(/\\/g, '/'), raw.replace(/\//g, '\\')]);
    const pattern = new RegExp(Array.from(variants).map(escapeRegExp).join('|'), 'gi');
    text = text.replace(pattern, '~');
    return text;
}

/**
 * Every `<creator>/<name>` map key in a JSON document → `<creator>/(custom)`: a
 * custom map's key is a name its owner typed, and the README promises the
 * report carries none of them. A regex over the text, not a parse-and-rewrite,
 * because a `hotkeys.json` that will not parse must be redacted too.
 */
function redactCustomMapKeys(text, creator = 'Custom') {
    if (text === null || text === undefined) return '';
    const prefix = escapeRegExp(String(creator));
    const pattern = new RegExp(`${prefix}/(?:\\\\.|[^"\\\\])*`, 'g');
    return String(text).replace(pattern, `${creator}/(custom)`);
}

module.exports = {redactHome, redactCustomMapKeys, escapeRegExp};
