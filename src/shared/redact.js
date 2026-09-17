'use strict';

/**
 * PURE path redaction for anything that reaches a log file or a diagnostic
 * report.
 *
 * The rule the whole diagnostics feature rests on: **a log the owner asks a
 * stranger to email must not carry that stranger's name.** An error message or
 * a stack trace is the one place a path under the user profile arrives without
 * anyone deciding to log it — `ENOENT: … C:\Users\Marco\AppData\…`,
 * `at Object.<anonymous> (C:\Users\Marco\Desktop\…)` — so every such string is
 * pushed through here first and the home directory becomes `~`.
 *
 * Windows makes this fiddlier than it looks, hence a tested pure function:
 * - Separators disagree. A stack trace can hold `C:\Users\Marco\app` while
 *   `app.getPath('home')` hands back the same path and Node's own URLs hold
 *   `C:/Users/Marco/app`. Both spellings have to match.
 * - Case does not matter on Windows: `c:\users\marco` is the same directory.
 * - The home path can contain regex metacharacters (`+`, `(`, `.`), so it is
 *   escaped before it becomes a pattern.
 */

/** Escape a literal string for use inside a RegExp. */
function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace every occurrence of the home directory in `value` with `~`.
 *
 * @param {*} value anything; non-strings are stringified, null/undefined give ''
 * @param {?string} home the user's home directory (`app.getPath('home')`)
 * @returns {string}
 */
function redactHome(value, home) {
    if (value === null || value === undefined) return '';
    let text = String(value);
    if (!home) return text;
    const raw = String(home).replace(/[\\/]+$/, '');
    if (!raw) return text;
    // Both separator spellings of the same directory, matched case-insensitively
    // because Windows paths are. The alternation is over the *escaped* forms so
    // a home directory containing a regex metacharacter cannot build a pattern
    // that matches something else.
    const variants = new Set([raw, raw.replace(/\\/g, '/'), raw.replace(/\//g, '\\')]);
    const pattern = new RegExp(Array.from(variants).map(escapeRegExp).join('|'), 'gi');
    text = text.replace(pattern, '~');
    return text;
}

module.exports = {redactHome, escapeRegExp};
