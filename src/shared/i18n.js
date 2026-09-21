'use strict';

/**
 * PURE translation: the JSON catalogues and nothing else — no electron, no fs,
 * no framework — so both processes and the tests use the same code. Flat dotted
 * keys, `{name}` placeholders. **Map and creator names are never translated.**
 * See `docs/agents/i18n.md`.
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

/** A parameter can itself be a `{key, params}` message; main builds both halves. */
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

/**
 * Substitute `{name}` placeholders. An unknown one stays put: electron-updater
 * substitutes its own `{appName}`/`{version}` after us.
 */
function format(template, params) {
    if (!params || typeof params !== 'object') return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => (
        Object.prototype.hasOwnProperty.call(params, name) && params[name] !== undefined && params[name] !== null
            ? String(params[name])
            : match
    ));
}

/**
 * Translate one key: the requested language → English → the key itself, so a
 * missing string never blanks an element. An unknown `lang` is English.
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
 * Build a message for the renderer to translate. Main never posts English: the
 * language can change while a toast is up. `sendUpdate(msg('update.checking'))`.
 */
function msg(key, params) {
    return params === undefined ? {key} : {key, params};
}

/** Whatever arrived over IPC: a `{key, params}` message, or a plain string. */
function translateMessage(lang, message) {
    if (message && typeof message === 'object' && typeof message.key === 'string') {
        return t(lang, message.key, message.params);
    }
    return typeof message === 'string' ? message : '';
}

/**
 * `app.getLocale()` → one of `LANGUAGES`, matched on the **primary subtag**.
 * The `\b` in each rule is load-bearing (`italian` is not `it`); `_` is folded
 * to `-` first, for the `it_IT` spellings.
 */
function systemLanguage(locale) {
    const tag = String(locale || '').replace(/_/g, '-');
    for (const [pattern, lang] of SYSTEM_LANGUAGE_RULES) {
        if (pattern.test(tag)) return lang;
    }
    return 'en';
}

/**
 * Locale prefix → language; disjoint, so order is irrelevant. There is one
 * Portuguese catalogue and it is the Brazilian one, so `pt-PT` lands there too.
 */
const SYSTEM_LANGUAGE_RULES = [
    [/^it\b/i, 'it'],
    [/^es\b/i, 'es'],
    [/^de\b/i, 'de'],
    [/^fr\b/i, 'fr'],
    [/^pt\b/i, 'pt-BR']
];

/** An explicit `setting`, else the locale — `system` and junk both fall through. */
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
