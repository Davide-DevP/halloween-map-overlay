'use strict';

/**
 * PURE translation. Imports two JSON catalogues and nothing else — no electron,
 * no fs, no framework — so both processes and the unit tests use the same code.
 *
 * ## The rules
 *
 * - Keys are flat and **dotted** (`settings.overlay.title`). The nesting is in
 *   the name, not in the JSON, so a key is one lookup and `Object.keys()` is
 *   the complete list — which is what lets a test compare the two files and
 *   scan the source for every key actually used.
 * - Placeholders are `{name}`. A placeholder with no matching parameter is left
 *   in the string untouched: electron-updater's notification body carries its
 *   own `{appName}` / `{version}` and substitutes them after we translate.
 * - Fallback chain: the requested language → English → the key itself. A
 *   missing Italian string shows English, never an empty element.
 * - **Map names and creator names are never translated.** They come from the
 *   `maps/` folder and from users' own imports.
 *
 * ## Messages across IPC
 *
 * The main process cannot know which language the window is showing at the
 * moment it speaks, and the language can change while a toast is up. So main
 * sends `{key, params}` objects built with `msg()` and the renderer translates
 * them on arrival with `translateMessage()`. Only the tray and the
 * single-instance dialog — which main draws itself — translate in main.
 */

const en = require('../i18n/en.json');
const it = require('../i18n/it.json');

/** Languages with a catalogue. The first is the fallback. */
const LANGUAGES = ['en', 'it'];

/** Values the `language` setting accepts. */
const LANGUAGE_SETTING_VALUES = ['system', 'en', 'it'];

const CATALOGUES = {en, it};

/**
 * Translate any parameter that is itself a `{key, params}` message.
 *
 * "\"Ctrl + R\" is already bound to \"Rotate the map\"" is one sentence with a
 * translatable noun inside it, and main — which builds the message — does not
 * know the window's language. So the inner part travels as a message too and is
 * resolved here, in the language the outer one is finally rendered in.
 */
function resolveParams(lang, params) {
    if (!params || typeof params !== 'object') return params;
    let resolved = null;
    for (const [name, value] of Object.entries(params)) {
        if (value && typeof value === 'object' && typeof value.key === 'string') {
            resolved = resolved || Object.assign({}, params);
            resolved[name] = t(lang, value.key, value.params);
        }
    }
    return resolved || params;
}

/** Substitute `{name}` placeholders; unknown ones are left in place. */
function format(template, params) {
    if (!params || typeof params !== 'object') return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => (
        Object.prototype.hasOwnProperty.call(params, name) && params[name] !== undefined && params[name] !== null
            ? String(params[name])
            : match
    ));
}

/**
 * Translate one key.
 *
 * @param {string} lang 'en' | 'it' (anything else falls back to English)
 * @param {string} key dotted catalogue key
 * @param {Object} [params] `{name: value}` for `{name}` placeholders
 * @returns {string} the translation, the English string, or the key itself
 */
function t(lang, key, params) {
    if (typeof key !== 'string' || !key) return '';
    const catalogue = CATALOGUES[lang] || CATALOGUES.en;
    let value = catalogue[key];
    if (typeof value !== 'string') value = CATALOGUES.en[key];
    if (typeof value !== 'string') return key;
    return format(value, resolveParams(lang, params));
}

/** Does this language have its own string for `key` (as opposed to falling back)? */
function has(lang, key) {
    const catalogue = CATALOGUES[lang];
    return !!catalogue && typeof catalogue[key] === 'string';
}

/**
 * Build a message for the renderer to translate. Main-process code says
 * `sendUpdate(msg('update.checking'))` rather than posting English.
 * @param {string} key
 * @param {Object} [params]
 * @returns {{key: string, params: ?Object}}
 */
function msg(key, params) {
    return params === undefined ? {key} : {key, params};
}

/**
 * Translate whatever arrived over IPC: a `{key, params}` message, or a plain
 * string (from a code path that has not been converted, or from a library).
 * @param {string} lang
 * @param {{key: string, params: ?Object}|string} message
 * @returns {string}
 */
function translateMessage(lang, message) {
    if (message && typeof message === 'object' && typeof message.key === 'string') {
        return t(lang, message.key, message.params);
    }
    return typeof message === 'string' ? message : '';
}

/**
 * The language to actually use.
 *
 * `system` follows the OS: anything whose locale starts with `it` (it, it-IT,
 * it-CH) gets Italian, everything else English. A locale is matched on its
 * prefix, not compared whole — `app.getLocale()` returns a full BCP 47 tag.
 *
 * @param {string} setting the stored `language` setting
 * @param {string} locale `app.getLocale()`
 * @returns {'en'|'it'}
 */
function resolveLanguage(setting, locale) {
    if (LANGUAGES.includes(setting)) return setting;
    return /^it\b/i.test(String(locale || '').replace(/_/g, '-')) ? 'it' : 'en';
}

module.exports = {
    LANGUAGES,
    LANGUAGE_SETTING_VALUES,
    CATALOGUES,
    t,
    has,
    msg,
    translateMessage,
    resolveLanguage,
    format
};
