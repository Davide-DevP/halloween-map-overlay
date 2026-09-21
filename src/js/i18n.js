const {ipcRenderer} = require('electron');
const shared = require('../shared/i18n');
const {debugLog} = require('./logger');

/**
 * Renderer side of the translation layer — a module-level singleton, so a view
 * module writes the 1-argument `t('nav.settings')` while main uses the pure
 * 3-argument form. `applyDom()` fills the static markup; views rebuild
 * themselves through `onChange()`. See `docs/agents/i18n.md`.
 */

let current = 'en';
/** False until the first `setLanguage`, so the initial pass always runs. */
let applied = false;
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
    // Catalogue strings only — never user input. See escape-html.js.
    scope.querySelectorAll('[data-i18n-html]').forEach(el => {
        el.innerHTML = t(el.getAttribute('data-i18n-html'));
    });
    for (const [dataAttr, target] of ATTRIBUTE_TARGETS) {
        scope.querySelectorAll(`[${dataAttr}]`).forEach(el => {
            el.setAttribute(target, t(el.getAttribute(dataAttr)));
        });
    }
    document.documentElement.setAttribute('lang', current);
    // An untranslated DOM looks exactly like a DOM that happens to be English,
    // so the count is the one thing that says the pass ran.
    debugLog('i18n::applyDom', current, 'elements=' + text.length);
}

/** Adopt a language and re-render. Main resolves the value, including `system`. */
function setLanguage(lang) {
    const next = shared.LANGUAGES.includes(lang) ? lang : 'en';
    // A switch reaches here twice — the select's own handler and main's
    // `language-changed` push — and re-rendering every view twice is waste.
    if (applied && next === current) return;
    current = next;
    applied = true;
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

// Pushed after the setting changes, so the tray and the window never disagree.
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
