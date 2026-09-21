const {app, ipcMain} = require('electron');
const fs = require('fs');
const path = require('path');
const {t, resolveLanguage, LANGUAGE_SETTING_VALUES} = require('../shared/i18n');
const appLog = require('./app-log');

/**
 * The main process's view of the UI language: for the two things main draws
 * itself, the tray menu and the "already running" dialog. Everything else
 * travels as a `{key, params}` message. See `docs/agents/i18n.md`.
 */
class Language {

    constructor(settings, onChange) {
        this.settings = settings || null;
        this.onChange = typeof onChange === 'function' ? onChange : null;

        ipcMain.handle('get-language', async () => this.current());
        // The renderer asks main to re-resolve and push the result back — to
        // itself and to the tray — so `system` is resolved in one place.
        ipcMain.handle('set-language', async (event, value) => {
            const next = LANGUAGE_SETTING_VALUES.includes(value) ? value : 'system';
            if (this.settings) this.settings.set('language', next);
            const resolved = this.current();
            appLog.event('language', {setting: next, resolved});
            if (this.onChange) this.onChange(resolved);
            return resolved;
        });
    }

    /** @returns {string} one of `LANGUAGES` in `shared/i18n.js` */
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
 * The language for a process with no `Settings`: the second-instance branch in
 * `index.js` quits immediately, and constructing `Settings` there would
 * register a second set of IPC handlers for a window that is never shown.
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
