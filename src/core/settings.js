/**
 * `settings-app.json` in userData: read, back-fill, write, report. Electron
 * tier. See docs/agents/settings-and-onboarding.md.
 */
const {app, ipcMain} = require("electron");
const fs = require("fs");
const path = require("path");

const {DEFAULT_SETTINGS: defaultConfig} = require("../shared/settings-defaults");
const {TOUR_VERSION} = require("../shared/onboarding-rules");
const {msg} = require("../shared/i18n");
const appLog = require("./app-log");

/** Write-failure warnings, ms between them. Why: the doc § Writing settings. */
const WRITE_WARN_INTERVAL = 30000;

class Settings {

    settings = {};

    constructor() {
        const userdata = app.getPath('userData');
        const fileDir = path.join(userdata, "settings-app.json")
        /** Did *this* start create the settings file? The migration needs it. */
        this.freshInstall = !fs.existsSync(fileDir);
        this.notifier = null;
        this.changeListeners = [];
        /** Epoch ms of the last write-failure warning shown to the user. */
        this.lastWarnAt = 0;
        if (this.freshInstall) {
            // A failure is survivable: the defaults are in memory and the
            // next `set()` tries again.
            try {
                fs.writeFileSync(fileDir, JSON.stringify(defaultConfig))
            } catch (err) {
                console.error("Settings: could not create settings-app.json:", err.message);
            }
        }
        try {
            this.settings = Settings.parseFile(fs.readFileSync(fileDir, "utf-8"));
        } catch (err) {
            // A corrupt settings file must not stop the app booting.
            console.error("Settings: could not parse settings-app.json, using defaults:", err.message);
            this.settings = {};
        }
        /**
         * The parsed file **before** the back-fill: only it can tell "the file
         * holds no key for this action" from "the file stores `''`".
         * Why: docs/agents/hotkeys.md § Defaults and the migration onto them.
         */
        this.fileSettings = Object.assign({}, this.settings);
        for (let key in defaultConfig) {
            if (this.settings[key] === undefined) {
                this.settings[key] = defaultConfig[key]
            }
        }
        // "Owed the setup tutorial", after the back-fill so a file that could
        // not be created or parsed still has it owed in memory this session.
        if (this.freshInstall && this.settings.onboardingPending !== true) {
            this.settings.onboardingPending = true;
            this.write();
        }
        let classInstance = this;
        ipcMain.handle('get-settings', async (event) => {
            return classInstance.settings
        })
        // One key at a time, never the renderer's whole cached object.
        // Why: the doc § Writing settings.
        ipcMain.handle('set-setting', async (event, key, value) => {
            if (typeof key !== 'string' || !key) return null;
            classInstance.set(key, value);
            return classInstance.settings;
        })
        // The tutorial's own handlers: `set-setting` answers with the settings
        // object and so cannot say "that did not reach the disk".
        ipcMain.handle('get-onboarding-state', async () => ({
            onboardingPending: classInstance.settings.onboardingPending === true,
            onboardingDone: classInstance.settings.onboardingDone === true,
            tourSeenVersion: classInstance.settings.tourSeenVersion
        }));
        ipcMain.handle('set-onboarding-done', async (event, value) => {
            const done = value === true;
            const ok = classInstance.set('onboardingDone', done);
            // Only the first write's success is reported: the rest would fail
            // the same way.
            if (done) {
                classInstance.set('onboardingPending', false);
                // The once-per-version stamp, on Finish *and* on Skip.
                classInstance.set('tourSeenVersion', TOUR_VERSION);
            }
            return {ok};
        });
        ipcMain.handle('save-settings', async (event, settings) => {
            if (settings && typeof settings === 'object') {
                classInstance.merge(settings);
            }
            return classInstance.settings;
        })
    }

    /**
     * `JSON.parse` alone is not enough here, and getting it wrong means an app
     * that will not start at all. Why: the doc § Writing settings.
     */
    static parseFile(text) {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            console.error('Settings: settings-app.json is not an object, using defaults.');
            return {};
        }
        return parsed;
    }

    /** Injected, because `Settings` is built before `MainWindow`. */
    setNotifier(fn) {
        this.notifier = typeof fn === 'function' ? fn : null;
    }

    get(key) {
        return this.settings[key];
    }

    /** The live object, not a copy — read-only by convention. */
    all() {
        return this.settings;
    }

    /**
     * @param {{rollback?: boolean}} [options] `rollback: true` restores the
     *   previous in-memory value when the write fails. Opt-in.
     * @returns {boolean} whether the value reached the disk — a caller answering
     *   an IPC invoke has to pass it on. Why: the doc § Writing settings.
     */
    set(key, value, options) {
        const had = Object.prototype.hasOwnProperty.call(this.settings, key);
        const before = this.settings[key];
        this.settings[key] = value;
        const ok = this.write();
        if (!ok && options && options.rollback) {
            if (had) this.settings[key] = before;
            else delete this.settings[key];
            return false;
        }
        // Every change is logged (the file only shows the *current* value).
        // Safe: no setting is a path or user text (settings-defaults.js).
        if (before !== value) {
            appLog.event('setting', {key, value: value === null ? 'null' : value});
            this.notifyChange([key]);
        }
        return ok;
    }

    /**
     * For anything that has to *act* on a setting written through the generic
     * `set-setting` — see docs/agents/markers-and-tab-mode.md.
     * @param {(keys: string[]) => void} fn run after the write, with the changed
     *   keys; one that throws must not break that write
     */
    onChange(fn) {
        if (typeof fn !== 'function') return;
        if (!this.changeListeners) this.changeListeners = [];
        this.changeListeners.push(fn);
    }

    /** Guarded: `test/settings-write.test.js` skips the constructor. */
    notifyChange(keys) {
        if (!this.changeListeners || !this.changeListeners.length) return;
        if (!keys || !keys.length) return;
        for (const listener of this.changeListeners) {
            try {
                listener(keys);
            } catch (err) {
                console.error('Settings: a change listener failed:', err && err.message);
            }
        }
    }

    /**
     * Several keys at once, without dropping keys the caller never saw.
     * @param {{rollback?: boolean}} [options] as `set()`, for every key at once
     */
    merge(partial, options) {
        // Only a real object: `Object.assign(settings, 'nope')` would add
        // `{0: 'n', …}` to the file.
        const source = partial && typeof partial === 'object' ? partial : {};
        const before = new Map();
        for (const key of Object.keys(source)) {
            before.set(key, Object.prototype.hasOwnProperty.call(this.settings, key)
                ? this.settings[key] : undefined);
        }
        Object.assign(this.settings, source);
        const ok = this.write();
        if (!ok && options && options.rollback) {
            for (const [key, value] of before) {
                if (value === undefined) delete this.settings[key];
                else this.settings[key] = value;
            }
            return ok;
        }
        // Only the keys that moved: a `save-settings` re-post is not every setting.
        const changed = [...before.keys()].filter(key => before.get(key) !== this.settings[key]);
        this.notifyChange(changed);
        return ok;
    }

    /**
     * Synchronous, wrapped, never thrown, never silent.
     * Why all four: the doc § Writing settings.
     */
    write() {
        const fileDir = path.join(app.getPath('userData'), "settings-app.json")
        try {
            fs.writeFileSync(fileDir, JSON.stringify(this.settings))
            return true;
        } catch (err) {
            console.error('Settings could not be written:', err && err.message);
            appLog.error('setting-write-failed', {message: (err && err.message) || String(err)});
            this.warnWriteFailed();
            return false;
        }
    }

    /** Throttled, because the overlay drag handler writes on every tick. */
    warnWriteFailed() {
        const now = Date.now();
        if (now - this.lastWarnAt < WRITE_WARN_INTERVAL) return;
        this.lastWarnAt = now;
        if (this.notifier) this.notifier(msg('settings.error.writeFailed'));
    }

}

module.exports = Settings;
module.exports.defaultConfig = defaultConfig;
