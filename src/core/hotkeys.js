/**
 * Global hotkeys: registration, `hotkeys.json`, the active/suspended switch.
 * Electron tier; the decisions are pure, in `shared/hotkeys-rules.js`.
 * See docs/agents/hotkeys.md.
 */
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

/** Watchdog for a lost "resume", ms. Why: the doc § Suspended while the bind dialog records. */
const SUSPEND_MAX_MS = 120000;

/** "…is already bound to <action>." Why the nested `msg`: the doc § The conflict banner. */
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
     * `[{accelerator, action, reason}]` the last `loadKeys()` could not
     * register, rebuilt from scratch each reload; `previousConflicts` is the
     * same set from the load before. Why: the doc § The conflict banner.
     */
    conflicts = [];
    previousConflicts = new Set();
    /** While `loadKeys()` runs, failures go to the banner, not a toast. */
    bulkLoading = false;
    /**
     * Registered right now? The composed verdict of the two fields below, and
     * `true` initially so a build with no foreground watcher still registers.
     */
    active = true;
    foregroundAllows = true;
    /** Why the app holds nothing while recording:
     * the doc § Suspended while the bind dialog records. */
    suspended = false;
    suspendTimer = null;
    /** Collected on load: the migration runs before any window can be toasted. */
    pendingNotice = null;
    mapController = null;

    constructor(mainWindow, settings, mapLibrary) {
        this.mainWindow = mainWindow;
        this.settings = settings;
        this.mapLibrary = mapLibrary;
        const classInstance = this;

        // Before anything reads a binding.
        this.migrateDefaultHotkeys();

        // `loadKeys()` pushes the banner before the window finishes loading, so
        // the renderer asks as well as listens.
        ipcMain.handle('get-hotkey-conflicts', async () => classInstance.getConflicts());

        ipcMain.handle('get-hotkey-notice', async () => {
            const notice = classInstance.pendingNotice;
            classInstance.pendingNotice = null;
            return notice;
        });

        // Its own handler, not `set-setting`: main has to act on it.
        // Why: docs/agents/settings-and-onboarding.md § Writing settings.
        ipcMain.handle('set-hotkeys-game-only', async (event, value) => {
            const on = value !== false;
            // Rolled back, or main polls for a setting the file does not hold.
            if (!classInstance.settings.set('hotkeysGameOnly', on, {rollback: true})) {
                return {ok: false, gameOnly: !on, active: classInstance.active};
            }
            if (classInstance.onGameOnlyChanged) classInstance.onGameOnlyChanged(on);
            return {ok: true, gameOnly: on, active: classInstance.active};
        });

        // `handle`: the renderer must know the suspension is in force before it
        // starts listening for keystrokes.
        ipcMain.handle('suspend-hotkeys', async (event, on) => {
            classInstance.setSuspended(on !== false);
            return {ok: true, suspended: classInstance.suspended};
        });

        // `handle`: the modal stays open until the binding is accepted.
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
            // A re-bind replaces the *equivalent* entry, not the one spelled
            // identically. Why: the doc § Priority, conflicts and registration.
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
            // A fresh renderer is not recording: one of the nets for a
            // suspension whose "resume" never arrived.
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

            const systemTaken = classInstance.systemConflict(accelerator, actionId);
            if (systemTaken) return classInstance.fail(systemTaken);

            // Normalised, so a stored `Ctrl+R` is found by `CommandOrControl+R`.
            const usedByMap = findMapConflict(classInstance.readHotkeyFile(), accelerator);
            if (usedByMap) {
                return classInstance.fail(msg('hotkeys.error.usedByMap',
                    {accelerator: acceleratorToDisplay(usedByMap)}));
            }

            const invalid = classInstance.rejectIfUnregisterable(accelerator);
            if (invalid) return classInstance.fail(invalid);

            // `rollback`, or the next `loadKeys()` registers the binding the
            // user was just told could not be saved.
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

            // The default is not guaranteed free, so Reset can be refused.
            // Why: the doc § Unbinding, rule 3.
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
            // Five actions ship with no key, so a Reset can *be* an unbind;
            // its own line, or `value=` reads like a write that lost its value.
            if (isUnbound(def.defaultAccelerator)) appLog.event('hotkey-unbound', {action: actionId});
            classInstance.mainWindow.sendUpdate(msg('hotkeys.resetToDefault'));
            classInstance.loadKeys();
        });

        // Unbound is the *stored* empty string, never a deleted key.
        // Why: the doc § Unbinding.
        ipcMain.on('unbind-system-hotkey', (event, payload) => {
            const {actionId} = payload || {};
            const settingKey = ACTION_TO_SETTING_KEY[actionId];
            const def = SYSTEM_HOTKEY_DEFS[actionId];
            if (!settingKey || !def) {
                console.warn(`unbind-system-hotkey: unknown actionId "${actionId}"`);
                return;
            }

            // Rolled back: an unbind that missed the disk must not leave the
            // action dead for the session.
            if (!classInstance.settings.set(settingKey, UNBOUND_ACCELERATOR, {rollback: true})) {
                classInstance.mainWindow.sendUpdate(msg('hotkeys.error.saveFailed'));
                return;
            }
            // Its own line: `setting key=hotkeyRotateMap value=` reads like a
            // write that lost its value.
            appLog.event('hotkey-unbound', {action: actionId});
            classInstance.mainWindow.sendUpdate(msg('hotkeys.unbound'));
            classInstance.loadKeys();
        });
    }

    /** The message also goes to the status toast. */
    ok(message) {
        this.mainWindow.sendUpdate(message);
        return {ok: true, message};
    }

    fail(message) {
        this.mainWindow.sendUpdate(message);
        return {ok: false, message};
    }

    /** @param {boolean} active whether the **foreground** allows the hotkeys */
    setActive(active) {
        this.foregroundAllows = !!active;
        this.applyRegistration('foreground');
    }

    /** Composes with the foreground rather than replacing it. */
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
     * verdict only, and deactivating never touches the conflict lists.
     * Why both: the doc § Only while the game is in front.
     * @param {string} reason for the log line — which input changed
     */
    applyRegistration(reason) {
        const next = hotkeysShouldBeRegistered({
            foregroundAllows: this.foregroundAllows,
            suspended: this.suspended
        });
        // Whatever the verdict, the *inputs* moved, and `suspended` is one of
        // the things that stops the tray unload.
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

    /** Injected: `ForegroundWatcher` is built after this class. */
    setGameOnlyHandler(fn) {
        this.onGameOnlyChanged = typeof fn === 'function' ? fn : null;
    }

    /** Injected: `MapController` is built after this class. */
    setMapController(controller) {
        this.mapController = controller || null;
    }

    /**
     * Run a system hotkey. The action happens in **main**; `hotkey-action` only
     * *tells* the window, for the setup tutorial's "try it" step.
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

    /**
     * @param {?string} [exceptActionId] the action being re-bound or reset,
     *   which must not conflict with itself
     * @returns {{key: string, params: Object}|null} a conflict message, or null
     */
    systemConflict(accelerator, exceptActionId = null) {
        const actionId = findSystemConflict(this.getSystemHotkeys(), accelerator, exceptActionId);
        return actionId ? conflictMessage(accelerator, actionId) : null;
    }

    /**
     * Dry-run an accelerator through Electron before it is ever persisted.
     * Why, and why a `false` return is not a failure:
     * the doc § Priority, conflicts and registration.
     * @returns {string|null} an error message when invalid, null when usable
     */
    rejectIfUnregisterable(accelerator) {
        if (this.ownAccelerators().has(acceleratorKey(accelerator))) return null;

        let registered = false;
        try {
            registered = globalShortcut.register(accelerator, () => {});
        } catch (err) {
            console.warn(`Rejected accelerator "${accelerator}": ${err.message}`);
            // A throw mid-register may have dropped one of our bindings.
            this.loadKeys();
            return msg('hotkeys.error.unregisterable', {accelerator});
        }
        if (registered) globalShortcut.unregister(accelerator);
        else this.mainWindow.sendUpdate(msg('hotkeys.error.takenByOther',
            {accelerator: acceleratorToDisplay(accelerator)}));
        return null;
    }

    /**
     * @returns {Set<string>} every combination this app binds, as normalised
     *   comparison keys — never `''`, which the probe would skip
     */
    ownAccelerators() {
        return ownAcceleratorKeys(this.getSystemHotkeys(), this.readHotkeyFile());
    }

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
     * The single `hotkeys.json` writer, wrapped like every sync write in main.
     * Why: docs/agents/settings-and-onboarding.md § Writing settings.
     * @param {string} action for the log line
     * @returns {boolean} whether it reached the disk; every caller reports it
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

    /** Never touches an existing file, so a cleared set stays cleared. */
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
     * The next free `Ctrl+Alt+N` for a map a **map pack** just added; the
     * decision is the pure `planPackMapHotkey`. Why: docs/agents/map-packs.md.
     * @param {Array<string>} [offeredKeys] from the pack store's state file
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
            this.mainWindow.sendUpdate(msg('hotkeys.error.saveFailed'));
            return {ok: false, accelerator: null, reason: 'write-failed', remember: false};
        }
        appLog.event('map-pack-hotkey', {key: mapKey, assigned: 'yes', accelerator: plan.accelerator});
        console.log(`Map pack "${mapKey}" bound to ${plan.accelerator}.`);
        // One reload for however many maps arrived: the caller batches.
        return {ok: true, accelerator: plan.accelerator, reason: 'assign', remember: true};
    }

    /**
     * The impure half of the one-time move onto the Ctrl+Alt defaults.
     * Why: the doc § Defaults and the migration onto them.
     */
    migrateDefaultHotkeys() {
        if (!this.settings) return;
        const plan = planHotkeyDefaultsMigration({
            storedVersion: this.settings.get(DEFAULTS_VERSION_KEY),
            freshInstall: !!this.settings.freshInstall,
            settings: this.settings.settings,
            // The raw file, so "no key stored" is not read as a deliberate unbind.
            fileSettings: this.settings.fileSettings,
            mapHotkeys: this.readHotkeyFile()
        });

        // Two writes at most, and the stamp only rides along if the file write
        // it also covers landed. Why: the doc, same section.
        const fileOk = plan.mapChanged ? this.writeHotkeyFile(plan.mapHotkeys, 'migrate') : true;
        const changes = Object.assign({}, plan.settingChanges);
        if (plan.stamp && fileOk) changes[DEFAULTS_VERSION_KEY] = plan.version;
        // **No `rollback` here, deliberately** — the one writer in the app that
        // must not have it: a rolled-back pin restores the `''` the back-fill
        // invented, a later write persists that `''` without the stamp, and the
        // next start reads it as a deliberate unbind. Why: the doc, same section.
        if (Object.keys(changes).length && !this.settings.merge(changes)) {
            // Kept in memory: a later successful write carries them along.
            appLog.warn('hotkey-defaults-deferred', {
                version: plan.version,
                keys: Object.keys(changes).length
            });
        }

        for (const entry of plan.blocked) {
            appLog.warn('hotkey-defaults-kept', {kind: entry.kind, to: entry.to, reason: entry.reason});
        }
        // Not a move and never toasted, but logged: it *is* a write.
        if (plan.pinned.length) {
            appLog.event('hotkey-defaults-pinned', {
                version: plan.version,
                actions: plan.pinned.map(p => p.id).join(' ')
            });
        }

        if (!plan.migrated) return;
        appLog.event('hotkey-defaults-migrated', {
            version: plan.version,
            moved: plan.moved.length,
            system: plan.moved.filter(m => m.kind === 'system').length,
            maps: plan.moved.filter(m => m.kind === 'map').length,
            blocked: plan.blocked.length
        });
        console.log(`Hotkey defaults migrated to v${plan.version}: `
            + plan.moved.map(m => `${m.from} → ${m.to}`).join(', '));
        this.pendingNotice = this.defaultsMovedNotice(plan);
    }

    /**
     * Two wordings, and the accelerator read live rather than from the plan.
     * Why both: the doc, same section.
     * @returns {{key: string, params?: Object}}
     */
    defaultsMovedNotice(plan) {
        const toggleMoved = plan.moved.some(m => m.kind === 'system' && m.id === 'toggle-map');
        const toggle = this.getSystemHotkeys()['toggle-map'];
        if (!toggleMoved || isUnbound(toggle)) return msg('hotkeys.defaultsMovedPlain');
        return msg('hotkeys.defaultsMoved', {accelerator: acceleratorToDisplay(toggle)});
    }

    /**
     * Stored overrides merged over the defaults, always through
     * `resolveSystemAccelerator`. Why: the doc § Unbinding, rule 1.
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

    /** @returns {Array<[string, string]>} only the actions that hold a combination */
    boundSystemHotkeys() {
        return boundEntries(this.getSystemHotkeys());
    }

    /**
     * A bad entry must never stop the ones after it from registering.
     * @param {string} label for the console line — an action id, or a uuid
     * @param {string} [actionLabel] what a failure is *recorded* as: a uuid
     *   means nothing in a diagnostic report
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

    /** Record a registration failure. Why: the doc § The conflict banner. */
    noteConflict(accelerator, action, reason) {
        const entry = {accelerator, action: action || '', reason: reason || 'taken'};
        if (this.conflicts.some(c => c.accelerator === accelerator)) return;
        this.conflicts.push(entry);
        // Logged once per *change*, not per reload — a Discord user would
        // otherwise reach app.log's 1 MB cap for nothing.
        if (this.previousConflicts.has(accelerator)) return;
        appLog.warn('hotkey-register-failed', {accelerator, action: entry.action, reason: entry.reason});
    }

    /** @returns {Array<{accelerator: string, action: string, reason: string}>} */
    getConflicts() {
        return this.conflicts.slice();
    }

    registerSystemHotkeys() {
        // Deliberately no window check: the actions run in main, which is what
        // the tray unload depends on. And `boundSystemHotkeys()`, not every
        // definition, because `globalShortcut.register('')` throws.
        for (const [actionId, accelerator] of this.boundSystemHotkeys()) {
            const def = SYSTEM_HOTKEY_DEFS[actionId];
            if (!def) continue;
            this.safeRegister(accelerator, () => this.runAction(actionId), actionId);
        }
    }

    /**
     * System hotkeys take priority; a colliding or duplicate entry is skipped
     * and reported, never silently inert.
     * Why: the doc § Priority, conflicts and registration.
     * @param {Object} hotkeys — { accelerator: { id, mapKey } }
     */
    registerCustomHotkeys(hotkeys) {
        const win = this.mainWindow;

        const effective = this.getSystemHotkeys();
        const shadowed = new Set(shadowedMapBindings(effective, hotkeys).map(e => e.accelerator));
        const duplicates = new Set(duplicateMapBindings(hotkeys).map(e => e.accelerator));

        for (const [hotkey, {mapKey, id}] of Object.entries(hotkeys)) {
            if (shadowed.has(hotkey)) {
                console.warn(`Skipping map hotkey "${hotkey}" — conflicts with a system hotkey.`);
                this.noteConflict(hotkey, 'map', 'shadowed');
                // The banner carries it; the toast is only for a reload the
                // user themselves caused.
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
            // Recorded as "map", and the map key is never logged: a custom
            // map's name is user text.
            this.safeRegister(hotkey, () => {
                appLog.event('hotkey', {action: 'map'});
                if (this.mapController) this.mapController.select(mapKey, 'hotkey');
            }, id, 'map');
        }
    }

    /**
     * Unregister everything, then system hotkeys, then map hotkeys. While
     * **inactive** it refreshes the renderer tables but registers nothing.
     * Why: the doc § Only while the game is in front.
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

        // Rebuilt from scratch: a combination since freed must drop off the
        // banner, and a reload is the only moment we can know.
        this.conflicts = [];
        this.bulkLoading = true;
        try {
            this.registerSystemHotkeys();
            this.mainWindow.send('hotkey-updated', parsed);
            this.registerCustomHotkeys(parsed);
        } finally {
            this.bulkLoading = false;
        }

        // The baseline for the next load — see `noteConflict`.
        this.previousConflicts = new Set(this.conflicts.map(c => c.accelerator));

        this.mainWindow.send('system-hotkeys-updated', this.getSystemHotkeys());
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
