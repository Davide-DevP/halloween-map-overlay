const {ipcRenderer} = require('electron');
const shared = require('../shared/i18n');
const {debugLog} = require('./logger');

/**
 * Renderer side of the translation layer.
 *
 * A module-level singleton rather than an instance passed around: every view
 * module needs `t()`, the language is one value for the whole window, and a
 * language change has to reach all of them at once. `require('./i18n')` in a
 * view module therefore gives it `t` directly, and the 1-argument form
 * (`t('nav.settings')`) is the renderer's; main uses the pure 3-argument form.
 *
 * ## Static markup
 *
 * `applyDom()` walks the document and fills in anything carrying
 * `data-i18n` (text), `data-i18n-html` (markup — used for the FAQ and the
 * other paragraphs that contain <strong>/<kbd>/<a>), `data-i18n-title`,
 * `data-i18n-placeholder` and `data-i18n-aria-label`. The markup form only
 * ever inserts strings from our own catalogues, never anything a user typed.
 *
 * ## Dynamic markup
 *
 * Views rebuild themselves through `onChange()`, which fires after the
 * language is switched. Anything built with `t()` at render time has to
 * re-render; a table that is not re-rendered would keep the old language until
 * something else touched it.
 */

let current = 'en';
const listeners = [];

/** Translate for the window's current language. */
function t(key, params) {
    return shared.t(current, key, params);
}

/** Translate a `{key, params}` message that arrived from the main process. */
function translateMessage(message) {
    return shared.translateMessage(current, message);
}

function language() {
    return current;
}

/** Register a callback to re-render dynamic content after a language change. */
function onChange(callback) {
    if (typeof callback === 'function') listeners.push(callback);
}

const ATTRIBUTE_TARGETS = [
    ['data-i18n-title', 'title'],
    ['data-i18n-placeholder', 'placeholder'],
    ['data-i18n-aria-label', 'aria-label']
];

/** Fill every marked element in `root` (the whole document by default). */
function applyDom(root) {
    const scope = root || document;
    const text = scope.querySelectorAll('[data-i18n]');
    text.forEach(el => {
        el.textContent = t(el.getAttribute('data-i18n'));
    });
    // Catalogue strings only — never user input. See escape-html.js for the
    // rule that covers everything that is not from these two JSON files.
    scope.querySelectorAll('[data-i18n-html]').forEach(el => {
        el.innerHTML = t(el.getAttribute('data-i18n-html'));
    });
    for (const [dataAttr, target] of ATTRIBUTE_TARGETS) {
        scope.querySelectorAll(`[${dataAttr}]`).forEach(el => {
            el.setAttribute(target, t(el.getAttribute(dataAttr)));
        });
    }
    document.documentElement.setAttribute('lang', current);
    // The one number that says the pass actually ran: a DOM that was not
    // translated looks exactly like a DOM whose language happens to be English.
    debugLog('i18n::applyDom', current, 'elements=' + text.length);
}

/**
 * Adopt a language and re-render. Called once at startup and again whenever
 * the setting changes — main is the single source of the resolved value, so
 * the 'system' option does not have to know about `app.getLocale()` here.
 */
function setLanguage(lang) {
    current = shared.LANGUAGES.includes(lang) ? lang : 'en';
    applyDom();
    for (const listener of listeners) {
        try {
            listener(current);
        } catch (err) {
            console.error('i18n::listener', err && err.message);
        }
    }
}

/** Ask main which language this window should be in, and apply it. */
async function init() {
    try {
        setLanguage(await ipcRenderer.invoke('get-language'));
    } catch (err) {
        console.error('i18n::init', err && err.message);
        setLanguage('en');
    }
    return current;
}

// Main pushes this after the `language` setting changes, so the tray and the
// window never disagree about which language is in force.
ipcRenderer.on('language-changed', (event, lang) => setLanguage(lang));

module.exports = {
    t,
    translateMessage,
    language,
    onChange,
    applyDom,
    setLanguage,
    init,
    LANGUAGES: shared.LANGUAGES,
    LANGUAGE_SETTING_VALUES: shared.LANGUAGE_SETTING_VALUES
};
