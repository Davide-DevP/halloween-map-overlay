const {app, ipcMain} = require("electron");
const fs = require("fs");
const path = require("path");

const defaultConfig = {
    size: 250,
    position: 1,
    opacity: 0.5,
    draggable: false,
    hideOverlay: false,
    minimizeToTray: false,
    disableFaqPopup: false,
    checkForUpdates: true,
    // Automatic map detection. Off by default: it takes a screenshot of the
    // selected display every 1.5 s while it is on.
    mapDetection: false,
    rotation: 0,
    monitor: 0,
    overlayX: null,
    overlayY: null,
    glideX: null,
    glideY: null,
    hotkeyToggleMap: 'CommandOrControl+H',
    hotkeyRotateMap: 'CommandOrControl+R',
    hotkeyNextMap: 'CommandOrControl+Right',
    hotkeyPrevMap: 'CommandOrControl+Left',
    hotkeyClearMap: 'CommandOrControl+Shift+D'
};

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
        this.settings[key] = value;
        this.write();
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
