const {app, ipcMain} = require("electron");
const fs = require("fs");
const path = require("path");

// The defaults themselves are pure and live in src/shared/settings-defaults.js
// so the tests can check them without importing electron.
const {DEFAULT_SETTINGS: defaultConfig} = require("../shared/settings-defaults");
const {msg} = require("../shared/i18n");
const appLog = require("./app-log");

/**
 * How often the user may be told that a settings write failed.
 *
 * The overlay's `moved` handler writes on **every** drag tick, so a locked
 * `settings-app.json` would otherwise produce a toast per pixel dragged. One
 * warning every half minute says the same thing without making the app
 * unusable on top of the problem it is reporting.
 */
const WRITE_WARN_INTERVAL = 30000;

class Settings {

    settings = {};

    constructor() {
        const userdata = app.getPath('userData');
        const fileDir = path.join(userdata, "settings-app.json")
        /**
         * True when this start is the one that created the settings file.
         *
         * The hotkey-defaults migration needs it: after the constructor's
         * back-fill a fresh file and an old one look identical, and a fresh
         * install must not be "migrated" (see `shared/hotkey-migration.js`).
         */
        this.freshInstall = !fs.existsSync(fileDir);
        /** Set from index.js once the main window exists — see `setNotifier`. */
        this.notifier = null;
        /** `onChange` listeners: things that have to *act* on a setting. */
        this.changeListeners = [];
        /** Epoch ms of the last write-failure warning shown to the user. */
        this.lastWarnAt = 0;
        if (this.freshInstall) {
            // First run. A failure here is not worth refusing to start over:
            // the defaults are already in memory, the app works, and the next
            // `set()` tries again. Before 0.3.2 this threw into Electron's
            // default handler; now it would write a crash file and exit.
            try {
                fs.writeFileSync(fileDir, JSON.stringify(defaultConfig))
            } catch (err) {
                console.error("Settings: could not create settings-app.json:", err.message);
            }
        }
        try {
            this.settings = Settings.parseFile(fs.readFileSync(fileDir, "utf-8"));
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
        // A brand-new install is owed the welcome tour, and that is recorded as
        // a **stored marker** rather than inferred from `freshInstall` later.
        // `freshInstall` is only true for the length of the session that made
        // the file: a first run abandoned before Skip or Finish — a quit, a
        // crash, an update restart — looked like an existing install on the
        // next start and was never greeted at all. Written after the back-fill
        // so it also survives a file that could not be created or parsed: the
        // in-memory copy still says the tour is owed *this* session, and the
        // next start (still `freshInstall`) will try to write it again.
        if (this.freshInstall && this.settings.onboardingPending !== true) {
            this.settings.onboardingPending = true;
            this.write();
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
        // The welcome tour. Its own handler rather than `get-settings` so the
        // two flags arrive as the booleans `shouldShowOnboarding` expects,
        // whatever a hand-edited file holds.
        ipcMain.handle('get-onboarding-state', async () => ({
            onboardingPending: classInstance.settings.onboardingPending === true,
            onboardingDone: classInstance.settings.onboardingDone === true
        }));
        // …and its own writer, because `set-setting` answers with the settings
        // object and so cannot say "that did not reach the disk". The tour has
        // to know: marking itself done on a write that failed would make it
        // look dismissed while the file still says otherwise.
        //
        // Both keys move together. `onboardingDone` is what stops it opening
        // again; clearing `onboardingPending` is bookkeeping, so that a
        // settings file read by a human says "not owed, already seen" rather
        // than leaving a marker set forever.
        ipcMain.handle('set-onboarding-done', async (event, value) => {
            const done = value === true;
            const ok = classInstance.set('onboardingDone', done);
            // Only the first write's success is reported: if it failed, the
            // second will fail the same way and one warning is the whole point
            // of the throttle.
            if (done) classInstance.set('onboardingPending', false);
            return {ok};
        });
        // Kept for bulk updates, but merging rather than replacing, for the
        // same reason.
        ipcMain.handle('save-settings', async (event, settings) => {
            if (settings && typeof settings === 'object') {
                classInstance.merge(settings);
            }
            return classInstance.settings;
        })
    }

    /**
     * `settings-app.json` → a settings object, or `{}`.
     *
     * `JSON.parse` is not enough on its own: `null`, `[]`, `3` and `"x"` are
     * all **valid** JSON, so the `try/catch` above never fires for them — and
     * then the back-fill `this.settings[key] = …` throws a TypeError on `null`
     * (and silently builds a settings object out of an array or a boxed number
     * for the rest). That throw happens in the constructor, *before*
     * `app.whenReady()` and before `appLog.installCrashHandlers()` has anything
     * to catch it with, so the app would simply fail to start with no window
     * and no crash file — on every start, forever, until the user found and
     * deleted a file they do not know exists.
     *
     * An array is deliberately rejected too: `typeof [] === 'object'`, and an
     * array with settings keys on it is not a settings file either.
     *
     * Static and pure so a test can reach it without an Electron `app`.
     *
     * @param {string} text
     * @returns {Object}
     */
    static parseFile(text) {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            console.error('Settings: settings-app.json is not an object, using defaults.');
            return {};
        }
        return parsed;
    }

    /**
     * Where a failed write is reported to the user.
     *
     * Injected rather than held: `Settings` is built before `MainWindow` (the
     * window needs the settings to size itself), so it cannot be a constructor
     * argument.
     * @param {(message: Object|string) => void} fn
     */
    setNotifier(fn) {
        this.notifier = typeof fn === 'function' ? fn : null;
    }

    get(key) {
        return this.settings[key];
    }

    /**
     * The whole settings object, for the pure rule modules that take one
     * (`shared/marker-rules.js` `markerState`). Not a copy: the same object
     * `get-settings` already hands the renderer, and every caller reads it.
     */
    all() {
        return this.settings;
    }

    /**
     * @param {string} key
     * @param {*} value
     * @param {{rollback?: boolean}} [options] `rollback: true` puts the previous
     *   in-memory value back when the write fails, so the process cannot go on
     *   believing something the file does not say.
     *
     *   It is **opt-in** because the two kinds of caller want opposite things.
     *   A hotkey binding must roll back: otherwise `save-system-hotkey` answers
     *   "could not be saved", and the next time the foreground watcher
     *   re-registers everything (an alt-tab away and back) `loadKeys()` reads
     *   the in-memory value and binds the accelerator the user was just told
     *   was rejected — visible in the Hotkeys table until a restart. The
     *   overlay's drag handler wants the opposite: `overlayX`/`overlayY` are
     *   where the window *is*, the next drag tick writes again a few
     *   milliseconds later, and reverting them mid-drag would make the stored
     *   position chase the cursor backwards.
     * @returns {boolean} whether the value reached the disk. Callers that
     *   answer an IPC invoke with `{ok: true}` have to pass this on: the UI
     *   used to say "saved" while `settings-app.json` was locked, and the
     *   change was gone on the next start.
     */
    set(key, value, options) {
        const had = Object.prototype.hasOwnProperty.call(this.settings, key);
        const before = this.settings[key];
        this.settings[key] = value;
        const ok = this.write();
        if (!ok && options && options.rollback) {
            // `delete` rather than `= undefined` for a key that was not there:
            // an `undefined` would read as "unset" to `get()` but would still
            // be an own property, which is not the state we came from.
            if (had) this.settings[key] = before;
            else delete this.settings[key];
            return false;
        }
        // Every setting change is a log line: half the field reports about this
        // app are "it used to work", and the settings file only ever shows the
        // *current* value. None of these values is a path or user text — see
        // shared/settings-defaults.js.
        if (before !== value) {
            appLog.event('setting', {key, value: value === null ? 'null' : value});
            this.notifyChange([key]);
        }
        return ok;
    }

    /**
     * Tell anything that has to *act* on a setting, not merely read it later.
     *
     * Most settings are read when they are next needed, which is why this did
     * not exist. The ones that are not are the ones main owns a running thing
     * for — and those used to get their own IPC handler (`set-hotkeys-game-only`,
     * `map-detector-start`, `set-tab-markers`). That does not cover a setting
     * written through the **generic** `set-setting`, which is how the renderer
     * writes the markers master switch and every marker layer: Ctrl+Alt+M
     * turned the corner markers off and on while Tab-map mode carried on
     * regardless, because nothing told it.
     *
     * Listeners are called after the write, with the keys that changed, and a
     * listener that throws must not break the write that triggered it.
     *
     * @param {(keys: string[]) => void} fn
     */
    onChange(fn) {
        if (typeof fn !== 'function') return;
        if (!this.changeListeners) this.changeListeners = [];
        this.changeListeners.push(fn);
    }

    /**
     * @param {string[]} keys
     *
     * Defensive about its own field: `test/settings-write.test.js` drives
     * `set()`/`merge()` on an instance built without the constructor (it has no
     * Electron to build one with), and a write must not start depending on a
     * field that only the constructor sets.
     */
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
     * Apply several keys at once without dropping keys the caller never saw.
     * @param {Object} partial
     * @param {{rollback?: boolean}} [options] as `set()`, for every key at once
     * @returns {boolean} whether the write succeeded
     */
    merge(partial, options) {
        // Only a real object, and the guard is on the assignment as well as on
        // the key list: `Object.assign(settings, 'nope')` would quietly add
        // `{0: 'n', 1: 'o', …}` to the settings file.
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
        // Only the keys whose value actually moved, so a `save-settings` that
        // re-posts everything does not look like every setting changing.
        const changed = [...before.keys()].filter(key => before.get(key) !== this.settings[key]);
        this.notifyChange(changed);
        return ok;
    }

    /**
     * Persist the whole object. Synchronous on purpose (a settings write must
     * not race the next one), and **wrapped**: since 0.3.2 main has an
     * `uncaughtException` handler that writes a crash file and exits, so an
     * EPERM from an antivirus or a sync client holding `settings-app.json`
     * open would end the session instead of Electron's old dialog-and-carry-on.
     * The overlay's `moved` handler writes through here on every drag, which
     * is exactly where such a lock shows up. Losing one write is survivable;
     * losing the app mid-match is not.
     *
     * It is also not **silent** any more. Swallowing the error left the UI
     * saying "saved" over a change that would be gone on the next start, which
     * is the worst of the three possible behaviours (the other two being a
     * throw, which now ends the session, and telling the user). So: never
     * thrown, always logged, and reported to the status toast at most once
     * every `WRITE_WARN_INTERVAL`.
     *
     * @returns {boolean}
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
