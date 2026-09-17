const {app, ipcMain} = require("electron");
const fs = require("fs");
const path = require("path");

// The defaults themselves are pure and live in src/shared/settings-defaults.js
// so the tests can check them without importing electron.
const {DEFAULT_SETTINGS: defaultConfig} = require("../shared/settings-defaults");
const appLog = require("./app-log");

class Settings {

    settings = {};

    constructor() {
        const userdata = app.getPath('userData');
        const fileDir = path.join(userdata, "settings-app.json")
        if (!fs.existsSync(fileDir)) {
            fs.writeFileSync(fileDir, JSON.stringify(defaultConfig))
        }
        try {
            this.settings = JSON.parse(fs.readFileSync(fileDir, "utf-8"));
        } catch (err) {
            // A truncated/corrupt settings file must not stop the app booting
            console.error("Settings: could not parse settings-app.json, using defaults:", err.message);
            this.settings = {};
        }
        for (let key in defaultConfig) {
            if (this.settings[key] === undefined) {
                this.settings[key] = defaultConfig[key]
            }
        }
        let classInstance = this;
        ipcMain.handle('get-settings', async (event) => {
            return classInstance.settings
        })
        // One key at a time. The renderer used to post its whole cached copy of
        // the settings object, which silently reverted anything the main
        // process had written since the renderer loaded it — system hotkey
        // changes and the dragged overlayX/overlayY both go straight to disk
        // from main and are never read back by the renderer.
        ipcMain.handle('set-setting', async (event, key, value) => {
            if (typeof key !== 'string' || !key) return null;
            classInstance.set(key, value);
            return classInstance.settings;
        })
        // Kept for bulk updates, but merging rather than replacing, for the
        // same reason.
        ipcMain.handle('save-settings', async (event, settings) => {
            if (settings && typeof settings === 'object') {
                classInstance.merge(settings);
            }
            return classInstance.settings;
        })
    }

    get(key) {
        return this.settings[key];
    }

    set(key, value) {
        const before = this.settings[key];
        this.settings[key] = value;
        this.write();
        // Every setting change is a log line: half the field reports about this
        // app are "it used to work", and the settings file only ever shows the
        // *current* value. None of these values is a path or user text — see
        // shared/settings-defaults.js.
        if (before !== value) appLog.event('setting', {key, value: value === null ? 'null' : value});
    }

    /** Apply several keys at once without dropping keys the caller never saw. */
    merge(partial) {
        Object.assign(this.settings, partial);
        this.write();
    }

    write() {
        const fileDir = path.join(app.getPath('userData'), "settings-app.json")
        fs.writeFileSync(fileDir, JSON.stringify(this.settings))
    }

}

module.exports = Settings;
module.exports.defaultConfig = defaultConfig;
