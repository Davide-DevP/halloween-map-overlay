const {ipcRenderer} = require("electron");
const {debugLog} = require("./logger");

/**
 * Renderer-side mirror of the main process settings file.
 *
 * Writes go one key at a time (`set-setting`). Posting the whole cached object
 * would revert anything main wrote in the meantime — system hotkey changes and
 * the dragged `overlayX`/`overlayY` are written from the main process and never
 * travel back through here.
 */
class Settings {

    constructor() {
        this.settings = {};
    }

    async init() {
        debugLog("settings::init::called");
        this.settings = await ipcRenderer.invoke('get-settings');
        return this;
    }

    /** Re-read from main, after something changed settings outside this window. */
    async refresh() {
        this.settings = await ipcRenderer.invoke('get-settings');
        return this.settings;
    }

    /** Falsy stored values (0, false, "") come back as null — see `raw()`. */
    get(key) {
        return this.settings[key] || null;
    }

    /** Untouched stored value, for settings where 0/false is meaningful. */
    raw(key) {
        return this.settings[key];
    }

    async set(key, value) {
        this.settings[key] = value;
        const updated = await ipcRenderer.invoke('set-setting', key, value);
        // Adopt main's copy so keys it owns stay current in this window
        if (updated && typeof updated === 'object') this.settings = updated;
    }
}

module.exports = Settings;
