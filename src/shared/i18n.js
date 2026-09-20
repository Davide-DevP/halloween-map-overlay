'use strict';

/**
 * PURE translation. Imports the JSON catalogues and nothing else — no electron,
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
 * - **Adding a language is data plus two lines**: a `src/i18n/<code>.json` with
 *   exactly `en.json`'s keys, a `require` and an entry in `LANGUAGES` /
 *   `CATALOGUES` here, one `<option data-i18n-ignore>` in `src/index.html`
 *   (the welcome tour clones that select), and a rule in
 *   `SYSTEM_LANGUAGE_RULES` if the OS locale should pick it. Packaging needs
 *   nothing: `build.files` only excludes.
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
const es = require('../i18n/es.json');
const de = require('../i18n/de.json');
const fr = require('../i18n/fr.json');
const ptBR = require('../i18n/pt-BR.json');

/** Languages with a catalogue. The first is the fallback. */
const LANGUAGES = ['en', 'it', 'es', 'de', 'fr', 'pt-BR'];

/** Values the `language` setting accepts. */
const LANGUAGE_SETTING_VALUES = ['system'].concat(LANGUAGES);

const CATALOGUES = {en, it, es, de, fr, 'pt-BR': ptBR};

/**
 * Translate any parameter that is itself a `{key, params}` message.
 *
 * "\"Ctrl + Alt + R\" is already bound to \"Rotate the map\"" is one sentence with a
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
 * @param {string} lang one of `LANGUAGES` (anything else falls back to English)
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
 * The `system` setting's rule: an OS locale → one of our languages.
 *
 * A locale is matched on its **primary subtag**, not compared whole —
 * `app.getLocale()` returns a full BCP 47 tag, so `it`, `it-IT` and `it-CH`
 * all have to land on Italian. `\b` is what keeps the match to a whole subtag:
 * `italian` is not `it`, `deutsch` is not `de`, `português` is not `pt`.
 * `_` is folded to `-` first, because some environments hand out `it_IT`.
 *
 * There is exactly one Portuguese catalogue and it is the Brazilian one, so
 * every `pt*` locale gets it — a pt-PT reader is better served by Brazilian
 * Portuguese than by English. Anything else is English.
 *
 * Pure and exported on its own so the rule itself is unit-tested rather than
 * only reachable through `resolveLanguage`.
 *
 * @param {string} locale `app.getLocale()`
 * @returns {string} one of `LANGUAGES`
 */
function systemLanguage(locale) {
    const tag = String(locale || '').replace(/_/g, '-');
    for (const [pattern, lang] of SYSTEM_LANGUAGE_RULES) {
        if (pattern.test(tag)) return lang;
    }
    return 'en';
}

/** locale prefix → language. Order is irrelevant; the prefixes are disjoint. */
const SYSTEM_LANGUAGE_RULES = [
    [/^it\b/i, 'it'],
    [/^es\b/i, 'es'],
    [/^de\b/i, 'de'],
    [/^fr\b/i, 'fr'],
    [/^pt\b/i, 'pt-BR']
];

/**
 * The language to actually use: an explicit choice, or the OS locale when the
 * setting is `system` (or anything unrecognised).
 *
 * @param {string} setting the stored `language` setting
 * @param {string} locale `app.getLocale()`
 * @returns {string} one of `LANGUAGES`
 */
function resolveLanguage(setting, locale) {
    if (LANGUAGES.includes(setting)) return setting;
    return systemLanguage(locale);
}

module.exports = {
    LANGUAGES,
    LANGUAGE_SETTING_VALUES,
    SYSTEM_LANGUAGE_RULES,
    CATALOGUES,
    t,
    has,
    msg,
    translateMessage,
    systemLanguage,
    resolveLanguage,
    format
};
