const {app, ipcMain} = require('electron');
const fs = require('fs');
const path = require('path');
const {t, resolveLanguage, LANGUAGE_SETTING_VALUES} = require('../shared/i18n');
const appLog = require('./app-log');

/**
 * The main process's view of the UI language.
 *
 * Most user-facing text is drawn by the renderer, which translates on its own —
 * main sends `{key, params}` messages (see `msg()` in `src/shared/i18n.js`) so
 * a toast that is already on screen when the language changes is not stuck in
 * the old one. What main *draws itself* has no renderer to do that: the tray
 * menu and the "already running" dialog. Those go through this class.
 *
 * `system` (the default) is resolved here rather than in the renderer because
 * `app.getLocale()` is a main-process API and there is no reason to expose a
 * second way of answering the same question.
 */
class Language {

    constructor(settings, onChange) {
        this.settings = settings || null;
        this.onChange = typeof onChange === 'function' ? onChange : null;

        ipcMain.handle('get-language', async () => this.current());
        // The renderer writes the setting through `set-setting` like any other,
        // then tells main to re-resolve it and push the result back — to itself
        // (so `system` is resolved in one place) and to the tray.
        ipcMain.handle('set-language', async (event, value) => {
            const next = LANGUAGE_SETTING_VALUES.includes(value) ? value : 'system';
            if (this.settings) this.settings.set('language', next);
            const resolved = this.current();
            appLog.event('language', {setting: next, resolved});
            if (this.onChange) this.onChange(resolved);
            return resolved;
        });
    }

    /** @returns {'en'|'it'} */
    current() {
        const setting = this.settings ? this.settings.get('language') : 'system';
        return resolveLanguage(setting, app.getLocale());
    }

    /** Translate for the current language. Used by the tray. */
    t(key, params) {
        return t(this.current(), key, params);
    }
}

/**
 * The language a process that has no `Settings` instance should use.
 *
 * The second-instance branch in `index.js` runs before any module is built and
 * quits again immediately; constructing `Settings` there would register a
 * second set of IPC handlers for a window that is never shown. Reading the file
 * is cheaper and cannot have side effects. A missing or corrupt file just means
 * `system`.
 *
 * @returns {'en'|'it'}
 */
function languageWithoutSettings() {
    let setting = 'system';
    try {
        const file = path.join(app.getPath('userData'), 'settings-app.json');
        if (fs.existsSync(file)) {
            const stored = JSON.parse(fs.readFileSync(file, 'utf-8'));
            if (stored && LANGUAGE_SETTING_VALUES.includes(stored.language)) setting = stored.language;
        }
    } catch (err) {
        // Not worth a log line: the fallback is the same one the app uses.
    }
    return resolveLanguage(setting, app.getLocale());
}

module.exports = Language;
module.exports.languageWithoutSettings = languageWithoutSettings;
