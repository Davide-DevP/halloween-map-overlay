const path = require('path');
const {app, globalShortcut, ipcMain} = require('electron');
const fs = require("fs");
const {randomUUID} = require("crypto");
const {
    SYSTEM_HOTKEY_DEFS,
    ACTION_TO_SETTING_KEY,
    UNBOUND_ACCELERATOR,
    acceleratorToDisplay,
    buildDefaultMapHotkeys,
    hasModifier,
    isUnbound,
    resolveSystemAccelerator
} = require("../shared/hotkeys-constants");
const {
    acceleratorKey,
    boundEntries,
    findSystemConflict,
    findMapConflict,
    canResetToDefault,
    shadowedMapBindings,
    duplicateMapBindings,
    ownAcceleratorKeys,
    planPackMapHotkey,
    hotkeysShouldBeRegistered
} = require("../shared/hotkeys-rules");
const {HOTKEY_DEFAULTS_VERSION, planHotkeyDefaultsMigration} = require("../shared/hotkey-migration");
const {msg} = require("../shared/i18n");
const appLog = require("./app-log");

const hotkeyFilePath = path.join(app.getPath('userData'), 'hotkeys.json');

/** The settings key that records which generation of defaults a file has seen. */
const DEFAULTS_VERSION_KEY = 'hotkeyDefaultsVersion';

/**
 * How long a recording suspension may last before it is lifted anyway.
 *
 * The renderer suspends the global shortcuts while the bind dialog is open and
 * resumes on `hidden.bs.modal`, and there are several ways that second message
 * can go missing: the window is closed with the modal still up, the renderer
 * dies and is reloaded, a `visibilitychange` race. Every one of those would
 * otherwise leave the app holding **no** hotkeys with nothing on screen to
 * explain it, which is the worst failure this feature can have. Two minutes is
 * far longer than anyone spends pressing one key combination, and the
 * `load-hotkeys` a reloaded renderer sends lifts it immediately anyway.
 */
const SUSPEND_MAX_MS = 120000;

/**
 * "…is already bound to <action>." The action's name is a nested message, not a
 * string: main does not know which language the window is in, so the inner noun
 * has to be translated at the same moment as the sentence around it.
 */
function conflictMessage(accelerator, actionId) {
    const def = SYSTEM_HOTKEY_DEFS[actionId];
    return msg('hotkeys.error.boundTo', {
        accelerator: acceleratorToDisplay(accelerator),
        action: def ? msg(def.descriptionKey) : actionId
    });
}

class Hotkeys {

    mainWindow;
    settings;
    mapLibrary;
    /**
     * Accelerators the last `loadKeys()` could not register — the §4 health
     * check. `[{accelerator, action, reason}]`, rebuilt from scratch on every
     * reload so it can never accumulate stale entries.
     */
    conflicts = [];
    /**
     * The accelerators that were already failing at the end of the previous
     * `loadKeys()`. Only a conflict that is *new* is worth a log line — see
     * `noteConflict`. The banner is rebuilt from `conflicts` either way.
     */
    previousConflicts = new Set();
    /**
     * True while `loadKeys()` is running. A failed registration then goes to
     * the banner instead of the toast: reloading binds a dozen accelerators at
     * once and one toast per failure, five times a session, is noise the user
     * learns to dismiss without reading.
     */
    bulkLoading = false;
    /**
     * Whether the global shortcuts are registered *right now* — the composed
     * verdict, `hotkeysShouldBeRegistered({foregroundAllows, suspended})`.
     *
     * Starts `true` so a build without the watcher (or the setting off)
     * behaves exactly as 0.6.0 did, and so the very first `loadKeys()` from
     * `createWindow` registers.
     */
    active = true;
    /**
     * Does the foreground allow the hotkeys? Set by `core/foreground.js`:
     * with `hotkeysGameOnly` on it flips as the player alt-tabs, so a
     * combination belongs to whatever application is in front unless that is
     * the game or one of our own windows.
     */
    foregroundAllows = true;
    /**
     * True while the renderer's bind dialog is recording a combination.
     *
     * Our own windows counting as "in front" is deliberate — a hotkey has to
     * be triable from Settings — but it is also what made re-recording
     * impossible: an accelerator the app already holds is taken by the OS
     * before any window sees the keystroke, so the dialog never received it
     * and the *bound action* fired instead. While the dialog records, the app
     * holds nothing.
     */
    suspended = false;
    /** Watchdog handle for `SUSPEND_MAX_MS`. */
    suspendTimer = null;
    /**
     * A one-time message the renderer collects when it loads
     * (`get-hotkey-notice`). The defaults migration runs during startup,
     * *before* any window can receive a toast, so the notice waits here.
     */
    pendingNotice = null;
    /**
     * `core/map-controller.js`, injected from `index.js`.
     *
     * Up to 0.7 every hotkey was `win.send(<channel>)` and the **main window's
     * renderer** did the work, which is what made that renderer load-bearing
     * for a match (see `docs/MEMORY-REPORT-2.md` §3.3). The accelerators now
     * dispatch straight into the main process, so they work with no window at
     * all — which is the whole point of the tray unload.
     */
    mapController = null;

    constructor(mainWindow, settings, mapLibrary) {
        this.mainWindow = mainWindow;
        this.settings = settings;
        this.mapLibrary = mapLibrary;
        const classInstance = this;

        // Before anything reads a binding: an install made on the old plain-Ctrl
        // defaults is moved onto the Ctrl+Alt ones, once.
        this.migrateDefaultHotkeys();

        // The banner is raised by a push from `loadKeys()`, which runs before
        // the window has finished loading on a cold start — so the renderer
        // asks as well as listens.
        ipcMain.handle('get-hotkey-conflicts', async () => classInstance.getConflicts());

        // Collected once by the renderer on load. The defaults migration is the
        // only thing that puts anything here, and it happens before there is a
        // window to tell.
        ipcMain.handle('get-hotkey-notice', async () => {
            const notice = classInstance.pendingNotice;
            classInstance.pendingNotice = null;
            return notice;
        });

        // The `hotkeysGameOnly` switch has its own handler rather than going
        // through the generic `set-setting`, because main has to act on it:
        // `core/foreground.js` starts or stops polling and the shortcuts are
        // registered or dropped in the same breath.
        ipcMain.handle('set-hotkeys-game-only', async (event, value) => {
            const on = value !== false;
            // Rolled back on failure: the switch snaps back in the UI, so the
            // in-memory value has to snap back too or main would poll (or not
            // poll) for a setting the file does not hold and the diagnostic
            // report would disagree with what the user is looking at.
            // No toast of our own either — `Settings.write()` already raises
            // the throttled "could not be saved" one, and two toasts saying
            // the same thing is one toast the user does not read.
            if (!classInstance.settings.set('hotkeysGameOnly', on, {rollback: true})) {
                return {ok: false, gameOnly: !on, active: classInstance.active};
            }
            if (classInstance.onGameOnlyChanged) classInstance.onGameOnlyChanged(on);
            return {ok: true, gameOnly: on, active: classInstance.active};
        });

        // The bind dialog is recording: hold nothing until it closes. `handle`,
        // not `on`, so the renderer knows the suspension is in force before it
        // starts listening for keystrokes.
        ipcMain.handle('suspend-hotkeys', async (event, on) => {
            classInstance.setSuspended(on !== false);
            return {ok: true, suspended: classInstance.suspended};
        });

        // --- Per-map hotkeys ---
        // `handle`, not `on`: the renderer keeps the modal open until it knows
        // the binding was actually accepted.
        ipcMain.handle('save-hotkeys', async (event, payload) => {
            const {hotkey, mapkey, id: incomingId} = payload || {};
            if (!hotkey || !mapkey) {
                return classInstance.fail(msg('hotkeys.error.pickBoth'));
            }

            if (!hasModifier(hotkey)) {
                return classInstance.fail(msg('hotkeys.error.noModifier'));
            }

            const conflict = classInstance.systemConflict(hotkey);
            if (conflict) return classInstance.fail(conflict);

            const invalid = classInstance.rejectIfUnregisterable(hotkey);
            if (invalid) return classInstance.fail(invalid);

            const saved = classInstance.readHotkeyFile();
            // A re-bind has to replace the entry it is *equivalent* to, not the
            // one spelled identically: saving Ctrl+Alt+1 over a file holding
            // `ctrl+alt+1` would otherwise leave two entries for one
            // combination, the second of which can never register.
            const existingKey = findMapConflict(saved, hotkey);
            const id = incomingId || (existingKey && saved[existingKey] && saved[existingKey].id) || randomUUID();
            if (existingKey && existingKey !== hotkey) delete saved[existingKey];
            saved[hotkey] = {id, mapKey: mapkey};

            if (!classInstance.writeHotkeyFile(saved, 'save')) {
                return classInstance.fail(msg('hotkeys.error.saveFailed'));
            }
            console.log(`Saved hotkey [${id}]: ${hotkey} → ${mapkey}`);
            classInstance.loadKeys();
            return classInstance.ok(msg('hotkeys.saved'));
        });

        ipcMain.on('load-hotkeys', () => {
            // A renderer that has just loaded is not recording anything, so
            // this is also the safety net for a suspension whose "resume"
            // never arrived — the window died mid-dialog and came back.
            classInstance.setSuspended(false);
            classInstance.loadKeys();
        });

        ipcMain.on('delete-hotkey', (event, id) => {
            const saved = classInstance.readHotkeyFile();
            const keyToDelete = Object.keys(saved).find(hk => saved[hk].id === id);

            if (keyToDelete) {
                delete saved[keyToDelete];
                if (!classInstance.writeHotkeyFile(saved, 'delete')) {
                    classInstance.mainWindow.sendUpdate(msg('hotkeys.error.saveFailed'));
                    return;
                }
                console.log(`Removed hotkey: ${keyToDelete} (id: ${id})`);
                classInstance.mainWindow.sendUpdate(msg('hotkeys.deleted'));
                classInstance.loadKeys();
            } else {
                console.warn(`No hotkey found for id ${id}`);
            }
        });

        // --- System hotkeys ---
        ipcMain.handle('get-system-hotkeys', async () => {
            return classInstance.getSystemHotkeys();
        });

        ipcMain.handle('save-system-hotkey', async (event, payload) => {
            const {actionId, accelerator} = payload || {};
            if (!actionId || !accelerator) {
                return classInstance.fail(msg('hotkeys.error.missingData'));
            }

            const settingKey = ACTION_TO_SETTING_KEY[actionId];
            if (!settingKey) {
                console.warn(`save-system-hotkey: unknown actionId "${actionId}"`);
                return classInstance.fail(msg('hotkeys.error.unknownAction'));
            }

            if (!hasModifier(accelerator)) {
                return classInstance.fail(msg('hotkeys.error.noModifier'));
            }

            // Conflicts with the other system hotkeys. `systemConflict` is the
            // one place that comparison lives now, so the unbound actions are
            // skipped here exactly as they are for a per-map binding.
            const systemTaken = classInstance.systemConflict(accelerator, actionId);
            if (systemTaken) return classInstance.fail(systemTaken);

            // Conflicts with per-map hotkeys — compared normalised, so a
            // hand-edited `Ctrl+R` in hotkeys.json is found by a probe for
            // `CommandOrControl+R`.
            const usedByMap = findMapConflict(classInstance.readHotkeyFile(), accelerator);
            if (usedByMap) {
                return classInstance.fail(msg('hotkeys.error.usedByMap',
                    {accelerator: acceleratorToDisplay(usedByMap)}));
            }

            const invalid = classInstance.rejectIfUnregisterable(accelerator);
            if (invalid) return classInstance.fail(invalid);

            // `rollback`, because this handler answers `fail`: without it the
            // rejected accelerator stays in memory and the next `loadKeys()`
            // — an alt-tab away and back is enough — registers the binding the
            // user was just told could not be saved, and the Hotkeys table
            // shows it until the app is restarted.
            if (!classInstance.settings.set(settingKey, accelerator, {rollback: true})) {
                return classInstance.fail(msg('hotkeys.error.saveFailed'));
            }
            classInstance.loadKeys();
            return classInstance.ok(msg('hotkeys.savedSystem'));
        });

        ipcMain.on('reset-system-hotkey', (event, payload) => {
            const {actionId} = payload || {};
            const settingKey = ACTION_TO_SETTING_KEY[actionId];
            const def = SYSTEM_HOTKEY_DEFS[actionId];
            if (!settingKey || !def) {
                console.warn(`reset-system-hotkey: unknown actionId "${actionId}"`);
                return;
            }

            // The default is not guaranteed to be free. This used to write it
            // blind, which was already wrong after a rebind (move rotate to
            // Alt+K, give its default to a map, press Reset); unbinding makes
            // the obvious sequence — unbind "Rotate map", hand its combination
            // to a map, press Reset — put two things on one accelerator. The
            // second registration then fails into the conflict banner (or the
            // map binding is silently shadowed), which is a worse outcome than
            // refusing the reset and saying why. The rule itself is pure.
            const verdict = canResetToDefault({
                effective: classInstance.getSystemHotkeys(),
                mapHotkeys: classInstance.readHotkeyFile(),
                actionId,
                defaultAccelerator: def.defaultAccelerator
            });
            if (!verdict.ok) {
                classInstance.mainWindow.sendUpdate(verdict.kind === 'system'
                    ? conflictMessage(def.defaultAccelerator, verdict.actionId)
                    : msg('hotkeys.error.usedByMap', {accelerator: acceleratorToDisplay(verdict.accelerator)}));
                return;
            }

            if (!classInstance.settings.set(settingKey, def.defaultAccelerator, {rollback: true})) {
                classInstance.mainWindow.sendUpdate(msg('hotkeys.error.saveFailed'));
                return;
            }
            classInstance.mainWindow.sendUpdate(msg('hotkeys.resetToDefault'));
            classInstance.loadKeys();
        });

        // Unbinding is not "reset to nothing": the empty string is *stored*, so
        // the settings back-fill cannot hand the default back on the next start
        // (see `resolveSystemAccelerator`). It is what lets a user leave a
        // combination to the rest of the system instead of parking an action
        // they never use on a key that is then swallowed everywhere. The Edit
        // button still works from here — recording a combination re-binds it.
        ipcMain.on('unbind-system-hotkey', (event, payload) => {
            const {actionId} = payload || {};
            const settingKey = ACTION_TO_SETTING_KEY[actionId];
            const def = SYSTEM_HOTKEY_DEFS[actionId];
            if (!settingKey || !def) {
                console.warn(`unbind-system-hotkey: unknown actionId "${actionId}"`);
                return;
            }

            // Rolled back too: an unbind that did not reach the disk must not
            // leave the action silently dead for the rest of the session.
            if (!classInstance.settings.set(settingKey, UNBOUND_ACCELERATOR, {rollback: true})) {
                classInstance.mainWindow.sendUpdate(msg('hotkeys.error.saveFailed'));
                return;
            }
            // Its own line, because `setting key=hotkeyRotateMap value=` reads
            // like a write that lost its value. "The user turned this off" and
            // "this hotkey does nothing" are the same support question
            // otherwise.
            appLog.event('hotkey-unbound', {action: actionId});
            classInstance.mainWindow.sendUpdate(msg('hotkeys.unbound'));
            classInstance.loadKeys();
        });
    }

    /** Result helpers — the message also goes to the main window's status toast. */
    ok(message) {
        this.mainWindow.sendUpdate(message);
        return {ok: true, message};
    }

    fail(message) {
        this.mainWindow.sendUpdate(message);
        return {ok: false, message};
    }

    /*
     * ─── Active / inactive (hotkeysGameOnly) ────────────────────────────────
     */

    /**
     * Called by `core/foreground.js` when the foreground changes sides.
     *
     * Registration is all-or-nothing and only ever runs on a **change**: doing
     * it once a second would churn a dozen `globalShortcut` calls for nothing.
     *
     * Deactivating deliberately leaves `conflicts` and `previousConflicts`
     * exactly as the last *active* load found them, and sends no
     * `hotkey-conflicts` push. Clearing them would make the home-page banner
     * flash off and on with every alt-tab, and rebuilding them would report
     * phantom conflicts for bindings that are not even registered. Keeping the
     * baseline is also what stops "log only new conflicts" from turning into a
     * fresh set of log lines on every activation.
     *
     * @param {boolean} active whether the **foreground** allows the hotkeys
     */
    setActive(active) {
        this.foregroundAllows = !!active;
        this.applyRegistration('foreground');
    }

    /**
     * The bind dialog is (or is no longer) recording a combination.
     *
     * Composes with the foreground state rather than replacing it, so closing
     * the dialog while the game is *not* in front does not register anything —
     * and alt-tabbing during a recording does not un-suspend.
     *
     * Always self-limiting: the watchdog lifts a suspension whose "resume"
     * never arrived (window closed with the modal up, renderer died), and the
     * `load-hotkeys` a reloaded renderer sends lifts it at once.
     *
     * @param {boolean} suspended
     */
    setSuspended(suspended) {
        const next = !!suspended;
        if (this.suspendTimer) {
            clearTimeout(this.suspendTimer);
            this.suspendTimer = null;
        }
        if (next) {
            this.suspendTimer = setTimeout(() => {
                this.suspendTimer = null;
                if (!this.suspended) return;
                appLog.warn('hotkeys-suspend', {action: 'watchdog', ms: SUSPEND_MAX_MS});
                this.suspended = false;
                this.applyRegistration('watchdog');
            }, SUSPEND_MAX_MS);
            // `unref` so a forgotten watchdog cannot hold the process open.
            if (this.suspendTimer.unref) this.suspendTimer.unref();
        }
        if (next === this.suspended) return;
        this.suspended = next;
        appLog.event('hotkeys-suspend', {recording: next ? 'yes' : 'no'});
        this.applyRegistration('suspend');
    }

    /**
     * Register or unregister everything, on a **change** of the composed
     * verdict only: doing it once a second would churn a dozen
     * `globalShortcut` calls for nothing.
     *
     * Deactivating deliberately leaves `conflicts` and `previousConflicts`
     * exactly as the last *active* load found them, and sends no
     * `hotkey-conflicts` push. Clearing them would make the home-page banner
     * flash off and on with every alt-tab, and rebuilding them would report
     * phantom conflicts for bindings that are not even registered. Keeping the
     * baseline is also what stops "log only new conflicts" from turning into a
     * fresh set of log lines on every activation.
     *
     * @param {string} reason for the log line — which input changed
     */
    applyRegistration(reason) {
        const next = hotkeysShouldBeRegistered({
            foregroundAllows: this.foregroundAllows,
            suspended: this.suspended
        });
        // Whatever the verdict, the *inputs* moved — and `suspended` is one of
        // the things that stops the main window being unloaded in the tray. A
        // bind dialog whose "resume" never arrived (the window was closed with
        // the modal up) is lifted by the watchdog below, and without this
        // nothing would ever re-ask whether the window may go now.
        if (this.mainWindow && typeof this.mainWindow.scheduleUnload === 'function') {
            this.mainWindow.scheduleUnload('hotkeys-' + (reason || 'change'));
        }
        if (next === this.active) return;
        this.active = next;
        appLog.event('hotkeys-active', {active: next ? 'yes' : 'no', reason: reason || ''});
        if (next) {
            this.loadKeys();
        } else {
            globalShortcut.unregisterAll();
        }
    }

    /**
     * What to do when the `hotkeysGameOnly` switch is flipped.
     *
     * Injected from `index.js`: `ForegroundWatcher` is built after this class
     * (it needs `setActive` as its callback), so the two are wired in that
     * direction and this one holds a function rather than the object.
     * @param {(on: boolean) => void} fn
     */
    setGameOnlyHandler(fn) {
        this.onGameOnlyChanged = typeof fn === 'function' ? fn : null;
    }

    /**
     * Where a pressed accelerator goes. Injected because `MapController` is
     * built after this class.
     * @param {?Object} controller
     */
    setMapController(controller) {
        this.mapController = controller || null;
    }

    /**
     * Run a system hotkey.
     *
     * The action is performed in **main** (`MapController.action`), and the
     * window — if there is one — is only *told*, on `hotkey-action`. Nothing in
     * the renderer acts on that notification; the welcome tour is the one
     * listener, and it uses it to tick off its "try it" step.
     *
     * @param {string} actionId a `SYSTEM_HOTKEY_DEFS` id
     */
    runAction(actionId) {
        appLog.event('hotkey', {action: actionId});
        if (this.mapController) this.mapController.action(actionId);
        if (this.mainWindow) this.mainWindow.send('hotkey-action', {action: actionId});
    }

    /** For the diagnostic report. */
    activityState() {
        return {
            gameOnly: !(this.settings && this.settings.get('hotkeysGameOnly') === false),
            active: this.active,
            suspended: this.suspended
        };
    }

    /*
     * ─── Conflict rules (all pure, in shared/hotkeys-rules.js) ──────────────
     */

    /**
     * @param {string} accelerator
     * @param {?string} [exceptActionId] a system action to ignore — the one
     *   being re-bound or reset, which must not conflict with itself.
     * @returns {{key: string, params: Object}|null} a conflict message when this
     *   accelerator is one of the system hotkeys, null otherwise.
     */
    systemConflict(accelerator, exceptActionId = null) {
        // Nothing conflicts with "no combination at all", in either direction:
        // an empty probe matches nothing, and the unbound actions are not in
        // the bound entries to be matched against. Both rules are in
        // `findSystemConflict`, which also compares *normalised*, so a
        // hand-edited `ctrl+r` collides with `CommandOrControl+R` the way
        // Electron says it does.
        const actionId = findSystemConflict(this.getSystemHotkeys(), accelerator, exceptActionId);
        return actionId ? conflictMessage(accelerator, actionId) : null;
    }

    /**
     * Dry-run an accelerator through Electron before it is ever persisted.
     *
     * `globalShortcut.register` THROWS on an accelerator it cannot parse, and a
     * throw inside `loadKeys` aborts every registration after it — so an
     * unparseable string saved to disk disables all remaining hotkeys on every
     * subsequent boot. Catching it here is what keeps that out of the file.
     *
     * A `false` return (some other application already owns the combination) is
     * not a parse failure: the binding is allowed and the user is told.
     *
     * Accelerators this app *itself* already holds are skipped entirely. The
     * probe runs while our own bindings are live, so `register` on one of them
     * returns `false` — re-recording the same combination for the same action
     * used to produce a bogus "taken by another application" toast. An
     * accelerator we are already holding has demonstrably parsed and
     * registered, so there is nothing to find out and nothing to disturb.
     *
     * The probe works the same while the hotkeys are **inactive** (the game is
     * not in front): register + unregister does not depend on our own bindings
     * being live, and the early return above covers the one case that did.
     *
     * @returns {string|null} an error message when invalid, null when usable.
     */
    rejectIfUnregisterable(accelerator) {
        if (this.ownAccelerators().has(acceleratorKey(accelerator))) return null;

        let registered = false;
        try {
            registered = globalShortcut.register(accelerator, () => {});
        } catch (err) {
            console.warn(`Rejected accelerator "${accelerator}": ${err.message}`);
            // A throw mid-register may have left globalShortcut in a state
            // where one of our bindings is gone; rebuild them.
            this.loadKeys();
            return msg('hotkeys.error.unregisterable', {accelerator});
        }
        // The probe took nothing away from us (we never hold this one), so the
        // caller's own loadKeys() after a successful save is the only one
        // needed — this used to run loadKeys three times per save.
        if (registered) globalShortcut.unregister(accelerator);
        else this.mainWindow.sendUpdate(msg('hotkeys.error.takenByOther',
            {accelerator: acceleratorToDisplay(accelerator)}));
        return null;
    }

    /**
     * Every combination this app binds, as **comparison keys**: every *bound*
     * system hotkey plus whatever is in `hotkeys.json`. Normalised, so the set
     * is what Electron would consider taken rather than what happens to be
     * spelled the same way.
     *
     * An unbound action must not put `''` in here. `rejectIfUnregisterable`
     * treats a member of this set as "already proven registrable" and returns
     * early, which for an empty string would skip the one check that keeps an
     * unparseable accelerator out of the settings file.
     *
     * @returns {Set<string>}
     */
    ownAccelerators() {
        return ownAcceleratorKeys(this.getSystemHotkeys(), this.readHotkeyFile());
    }

    /*
     * ─── hotkeys.json ───────────────────────────────────────────────────────
     */

    readHotkeyFile() {
        if (!fs.existsSync(hotkeyFilePath)) return {};
        try {
            return JSON.parse(fs.readFileSync(hotkeyFilePath, "utf-8")) || {};
        } catch (err) {
            console.error("Error parsing hotkeys.json:", err.message);
            return {};
        }
    }

    /**
     * The single `hotkeys.json` writer.
     *
     * Wrapped like every other sync write in main since 0.3.2: an
     * `uncaughtException` now ends the process (with a crash file), so a locked
     * `hotkeys.json` must cost the one change, not the session. The return
     * value is what every caller reports to the user with — a write that
     * failed must never come back as "saved".
     *
     * @param {Object} contents
     * @param {string} action for the log line
     * @returns {boolean}
     */
    writeHotkeyFile(contents, action) {
        try {
            fs.writeFileSync(hotkeyFilePath, JSON.stringify(contents, null, 2), 'utf-8');
            return true;
        } catch (err) {
            console.error(`Failed to write hotkeys.json (${action}):`, err && err.message);
            appLog.error('hotkey-write-failed', {action, message: (err && err.message) || String(err)});
            return false;
        }
    }

    /**
     * First run only: bind Ctrl+Alt+1..Ctrl+Alt+N to the shipped maps. Never
     * touches an existing file, so a user who cleared every binding keeps it
     * cleared.
     */
    ensureDefaultMapHotkeys() {
        if (fs.existsSync(hotkeyFilePath)) return;
        const catalog = this.mapLibrary ? this.mapLibrary.getCatalog() : [];
        const defaults = buildDefaultMapHotkeys(catalog, randomUUID);
        if (!Object.keys(defaults).length) return;
        if (this.writeHotkeyFile(defaults, 'defaults')) {
            console.log(`Wrote default map hotkeys: ${Object.keys(defaults).join(", ")}`);
        }
    }

    /**
     * Give a map that a **map pack** just added the next free `Ctrl+Alt+N`.
     *
     * The decision is the pure `planPackMapHotkey` (see it for the four rules
     * that keep this from re-arming accelerators a user cleared, from offering
     * the same map twice, and from ever creating a conflict). This half only
     * reads the file, writes it through the **single** `hotkeys.json` writer,
     * reports a failed write the way every other hotkey path does, and
     * re-registers.
     *
     * Called by `core/map-packs.js` for each pack key that was not already in
     * the catalogue — a pack that merely *replaces* a bundled map is not a new
     * map and keeps whatever binding that map already had.
     *
     * @param {string} mapKey
     * @param {Array<string>} [offeredKeys] map keys already offered one, from
     *   the pack store's state file
     * @returns {{ok: boolean, accelerator: ?string, reason: string, remember: boolean}}
     */
    assignPackMapHotkey(mapKey, offeredKeys) {
        const plan = planPackMapHotkey({
            mapKey,
            fileExists: fs.existsSync(hotkeyFilePath),
            mapHotkeys: this.readHotkeyFile(),
            systemHotkeys: this.getSystemHotkeys(),
            offeredKeys: offeredKeys || []
        });
        if (!plan.accelerator) {
            appLog.event('map-pack-hotkey', {key: mapKey, assigned: 'no', reason: plan.reason});
            return {ok: true, accelerator: null, reason: plan.reason, remember: plan.remember};
        }

        const saved = this.readHotkeyFile();
        saved[plan.accelerator] = {id: randomUUID(), mapKey};
        if (!this.writeHotkeyFile(saved, 'pack-default')) {
            // Reported exactly like a hotkey the user saved by hand: the write
            // is the same write and the failure means the same thing.
            this.mainWindow.sendUpdate(msg('hotkeys.error.saveFailed'));
            return {ok: false, accelerator: null, reason: 'write-failed', remember: false};
        }
        appLog.event('map-pack-hotkey', {key: mapKey, assigned: 'yes', accelerator: plan.accelerator});
        console.log(`Map pack "${mapKey}" bound to ${plan.accelerator}.`);
        // One reload for however many maps arrived: the caller batches.
        return {ok: true, accelerator: plan.accelerator, reason: 'assign', remember: true};
    }

    /*
     * ─── The one-time move onto the Ctrl+Alt defaults ───────────────────────
     */

    /**
     * Apply `planHotkeyDefaultsMigration` — the impure half of §3.
     *
     * The decision (which bindings may move, and what blocks a move) is pure
     * and unit tested; this only writes, logs, and leaves a notice for the
     * renderer to collect. It runs from the constructor, before anything has
     * read a binding, and the version stamp is what makes the second run a
     * no-op.
     */
    migrateDefaultHotkeys() {
        if (!this.settings) return;
        const plan = planHotkeyDefaultsMigration({
            storedVersion: this.settings.get(DEFAULTS_VERSION_KEY),
            freshInstall: !!this.settings.freshInstall,
            settings: this.settings.settings,
            mapHotkeys: this.readHotkeyFile()
        });

        // Two writes at most, not eleven. `hotkeys.json` first, then **one**
        // `merge()` for up to nine accelerators plus the version stamp — the
        // migration used to call `set()` per key, i.e. ten full rewrites of
        // `settings-app.json` during startup, each one a synchronous write.
        //
        // The stamp rides in that same merge, and only if the file write it
        // also covers actually landed: a run that could not write is retried
        // on the next start rather than being recorded as done. Retrying is
        // safe, because the plan is computed from the state on disk — whichever
        // half did land is simply not a candidate any more. `rollback` keeps
        // memory and file together if the merge itself fails.
        const fileOk = plan.mapChanged ? this.writeHotkeyFile(plan.mapHotkeys, 'migrate') : true;
        const changes = Object.assign({}, plan.settingChanges);
        if (plan.stamp && fileOk) changes[DEFAULTS_VERSION_KEY] = plan.version;
        if (Object.keys(changes).length) this.settings.merge(changes, {rollback: true});

        if (!plan.migrated) return;
        appLog.event('hotkey-defaults-migrated', {
            version: plan.version,
            moved: plan.moved.length,
            system: plan.moved.filter(m => m.kind === 'system').length,
            maps: plan.moved.filter(m => m.kind === 'map').length,
            blocked: plan.blocked.length
        });
        for (const entry of plan.blocked) {
            appLog.warn('hotkey-defaults-kept', {kind: entry.kind, to: entry.to, reason: entry.reason});
        }
        console.log(`Hotkey defaults migrated to v${plan.version}: `
            + plan.moved.map(m => `${m.from} → ${m.to}`).join(', '));
        this.pendingNotice = this.defaultsMovedNotice(plan);
    }

    /**
     * The one-time "your hotkeys moved" notice.
     *
     * Two wordings, because the version that names a combination can only be
     * used when that combination is the thing that actually changed. Saying
     * *"the defaults have moved off plain Ctrl — Ctrl + H now shows the map"*
     * is a sentence that contradicts itself, and it is reachable two ways:
     * toggle-map's own move was **blocked** (something else holds Ctrl+Alt+H,
     * so it is still on the old combination), or only per-map bindings moved
     * at all (a reset `settings-app.json` beside an old `hotkeys.json`). An
     * unbound toggle-map would leave the clause with a hole in it.
     *
     * The accelerator is read live rather than taken from the plan, so it is
     * still right if something rebinds it between here and the renderer asking.
     *
     * @param {Object} plan from `planHotkeyDefaultsMigration`
     * @returns {{key: string, params?: Object}}
     */
    defaultsMovedNotice(plan) {
        const toggleMoved = plan.moved.some(m => m.kind === 'system' && m.id === 'toggle-map');
        const toggle = this.getSystemHotkeys()['toggle-map'];
        if (!toggleMoved || isUnbound(toggle)) return msg('hotkeys.defaultsMovedPlain');
        return msg('hotkeys.defaultsMoved', {accelerator: acceleratorToDisplay(toggle)});
    }

    /*
     * ─── Registration ───────────────────────────────────────────────────────
     */

    /**
     * Current system hotkey accelerators: stored overrides merged over
     * defaults, with `''` for every action the user unbound.
     *
     * This used to be `stored || def.defaultAccelerator`, which resurrected the
     * default for an unbound action on every read. The three-way resolution
     * lives in the pure `resolveSystemAccelerator` so the renderer's table
     * cannot come to a different conclusion.
     *
     * @returns {Object<string, string>} actionId → accelerator, `''` = unbound
     */
    getSystemHotkeys() {
        const result = {};
        for (const [actionId, def] of Object.entries(SYSTEM_HOTKEY_DEFS)) {
            const settingKey = ACTION_TO_SETTING_KEY[actionId];
            result[actionId] = resolveSystemAccelerator(this.settings.get(settingKey), def.defaultAccelerator);
        }
        return result;
    }

    /**
     * Only the system actions that actually hold a key combination.
     * The rule is pure (`boundEntries`); this is the call site that has the
     * settings to hand.
     * @returns {Array<[string, string]>} [actionId, accelerator] pairs
     */
    boundSystemHotkeys() {
        return boundEntries(this.getSystemHotkeys());
    }

    /**
     * Register one accelerator, surviving anything Electron throws at us.
     * A bad entry must never stop the ones after it from being registered.
     * @param {string} accelerator
     * @param {Function} handler
     * @param {string} label for the console line — a system action id, or a
     *   per-map binding's uuid.
     * @param {string} [actionLabel] what a failure is *recorded* as, when that
     *   differs: a uuid means nothing in a diagnostic report.
     * @returns {boolean}
     */
    safeRegister(accelerator, handler, label, actionLabel) {
        const win = this.mainWindow;
        try {
            if (globalShortcut.register(accelerator, handler)) return true;
            console.warn(`Failed to register "${accelerator}" (${label}) — already taken`);
            this.noteConflict(accelerator, actionLabel || label, 'taken');
            if (win && !this.bulkLoading) win.sendUpdate(msg('hotkeys.error.takenByOther', {accelerator: acceleratorToDisplay(accelerator)}));
        } catch (err) {
            console.error(`Invalid accelerator "${accelerator}" (${label}): ${err.message}`);
            this.noteConflict(accelerator, actionLabel || label, 'invalid');
            if (win && !this.bulkLoading) win.sendUpdate(msg('hotkeys.error.invalidSaved', {accelerator}));
        }
        return false;
    }

    /**
     * Record a registration failure for the home-page banner and the log.
     *
     * A hotkey that silently does nothing is the single hardest thing to
     * diagnose remotely: the user presses the combination, nothing happens, and
     * the app looks broken when in fact Discord or the NVIDIA overlay took it
     * first. Both halves of 0.3.2 exist for this case — the log line for the
     * report, the banner so the user does not have to send one.
     */
    noteConflict(accelerator, action, reason) {
        const entry = {accelerator, action: action || '', reason: reason || 'taken'};
        if (this.conflicts.some(c => c.accelerator === accelerator)) return;
        this.conflicts.push(entry);
        // Logged once per *change*, not once per reload. `loadKeys()` runs at
        // least twice on every start (once from `createWindow`, once from the
        // renderer's `load-hotkeys`) and again after every hotkey edit — and,
        // since 0.7, again every time the game comes back to the foreground. A
        // user who runs Discord would otherwise put thirteen identical warnings
        // in app.log several times a session and reach the 1 MB cap for
        // nothing. A conflict that *appears* is news and is logged; one that
        // persists is already in the file.
        if (this.previousConflicts.has(accelerator)) return;
        appLog.warn('hotkey-register-failed', {accelerator, action: entry.action, reason: entry.reason});
    }

    /** @returns {Array<{accelerator: string, action: string, reason: string}>} */
    getConflicts() {
        return this.conflicts.slice();
    }

    registerSystemHotkeys() {
        // No window check any more: the actions run in main, so a hotkey works
        // whether or not the main window exists. Registering them only when
        // there was a window to send them to was the 0.6 shape and is exactly
        // what the tray unload had to stop depending on.
        //
        // `boundSystemHotkeys()`, not every definition: an unbound action has
        // nothing to register, and `globalShortcut.register('')` throws — which
        // `safeRegister` would turn into a phantom "invalid accelerator" entry
        // in the conflict banner for an action the user switched off on purpose.
        for (const [actionId, accelerator] of this.boundSystemHotkeys()) {
            const def = SYSTEM_HOTKEY_DEFS[actionId];
            if (!def) continue;
            this.safeRegister(accelerator, () => this.runAction(actionId), actionId);
        }
    }

    /**
     * Register per-map hotkeys. System hotkeys take priority — conflicts are
     * skipped and reported, so a stale colliding entry is not silently inert.
     * Both "which of these does a system hotkey shadow?" and "which of these
     * are two spellings of one combination?" are pure decisions.
     * @param {Object} hotkeys — { accelerator: { id, mapKey } }
     */
    registerCustomHotkeys(hotkeys) {
        // `win` is only used for the two toasts below; the bindings themselves
        // no longer need a window (see `registerSystemHotkeys`). `sendUpdate`
        // drops a toast with no window, so the guard is not needed there either.
        const win = this.mainWindow;

        const effective = this.getSystemHotkeys();
        const shadowed = new Set(shadowedMapBindings(effective, hotkeys).map(e => e.accelerator));
        // JSON cannot hold one key twice, but it can hold `Ctrl+1` *and*
        // `CommandOrControl+1`, which Electron treats as one accelerator: the
        // second `register` returned `false` and was reported as "taken by
        // another application", blaming a third party for our own file.
        const duplicates = new Set(duplicateMapBindings(hotkeys).map(e => e.accelerator));

        for (const [hotkey, {mapKey, id}] of Object.entries(hotkeys)) {
            if (shadowed.has(hotkey)) {
                console.warn(`Skipping map hotkey "${hotkey}" — conflicts with a system hotkey.`);
                this.noteConflict(hotkey, 'map', 'shadowed');
                // Same rule as every other registration failure: the banner
                // carries it, and the toast is only for the reload the user
                // themselves just caused. This one used to fire on every
                // `loadKeys()`, which is several times a session.
                if (win && !this.bulkLoading) {
                    win.sendUpdate(msg('hotkeys.error.systemShadowsMap', {accelerator: acceleratorToDisplay(hotkey)}));
                }
                continue;
            }
            if (duplicates.has(hotkey)) {
                console.warn(`Skipping map hotkey "${hotkey}" — another entry already holds that combination.`);
                this.noteConflict(hotkey, 'map', 'duplicate');
                if (win && !this.bulkLoading) {
                    win.sendUpdate(msg('hotkeys.error.duplicateBinding', {accelerator: acceleratorToDisplay(hotkey)}));
                }
                continue;
            }
            // The console label stays the binding's id (that is what
            // hotkeys.json is keyed by when something has to be found in it);
            // the *recorded* action is just "map", because a per-map hotkey's
            // real name is a map name and a custom map's name is user text.
            this.safeRegister(hotkey, () => {
                appLog.event('hotkey', {action: 'map'});
                // Straight into main, so a per-map binding works with the
                // window torn down in the tray. The map key is *not* logged:
                // a per-map hotkey's real name is a map name, and a custom
                // map's name is user text.
                if (this.mapController) this.mapController.select(mapKey, 'hotkey');
            }, id, 'map');
        }
    }

    /**
     * Unregister everything, then re-register system hotkeys, then map hotkeys.
     *
     * While the hotkeys are **inactive** — `hotkeysGameOnly` on and the game
     * not in front, or the bind dialog recording — this still refreshes the two
     * tables in the renderer but registers nothing: editing a hotkey from the
     * Settings window must not quietly re-arm the whole set behind the
     * setting's back, and a save made from the dialog must not take the
     * keyboard away from the dialog. Note the conflict list is left untouched
     * in that case — see `applyRegistration`.
     */
    loadKeys() {
        globalShortcut.unregisterAll();
        this.ensureDefaultMapHotkeys();
        const parsed = this.readHotkeyFile();

        if (!this.active) {
            this.mainWindow.send('hotkey-updated', parsed);
            this.mainWindow.send('system-hotkeys-updated', this.getSystemHotkeys());
            appLog.event('hotkeys-loaded', {maps: Object.keys(parsed).length, active: 'no'});
            return;
        }

        // Rebuilt from scratch: a combination the user has since freed must
        // drop off the banner, and a reload is the only moment we can know.
        this.conflicts = [];
        this.bulkLoading = true;
        try {
            this.registerSystemHotkeys();
            this.mainWindow.send('hotkey-updated', parsed);
            this.registerCustomHotkeys(parsed);
        } finally {
            this.bulkLoading = false;
        }

        // What this load found becomes the baseline for the next one, so a
        // conflict that simply persists is not logged again.
        this.previousConflicts = new Set(this.conflicts.map(c => c.accelerator));

        this.mainWindow.send('system-hotkeys-updated', this.getSystemHotkeys());
        // One banner, updated in place — not a toast per failure per reload.
        this.mainWindow.send('hotkey-conflicts', this.getConflicts());
        appLog.event('hotkeys-loaded', {
            maps: Object.keys(parsed).length,
            conflicts: this.conflicts.length
        });
    }
}

module.exports = Hotkeys;
module.exports.HOTKEY_DEFAULTS_VERSION = HOTKEY_DEFAULTS_VERSION;
module.exports.DEFAULTS_VERSION_KEY = DEFAULTS_VERSION_KEY;
