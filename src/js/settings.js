const {ipcRenderer} = require("electron");
const {debugLog} = require("./logger");

/**
 * Renderer-side mirror of the main process settings file. Writes go one key at
 * a time (`set-setting`): posting the whole cached object would revert whatever
 * main wrote in the meantime. See docs/agents/settings-and-onboarding.md.
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

    /** The whole cached object, for the pure rules that read several keys. */
    all() {
        return this.settings;
    }

    async set(key, value) {
        this.settings[key] = value;
        const updated = await ipcRenderer.invoke('set-setting', key, value);
        // Adopt main's copy, so keys it owns stay current here.
        if (updated && typeof updated === 'object') this.settings = updated;
    }
}

module.exports = Settings;
