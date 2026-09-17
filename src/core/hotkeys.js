const path = require('path');
const {app, globalShortcut, ipcMain} = require('electron');
const fs = require("fs");
const {randomUUID} = require("crypto");
const {
    SYSTEM_HOTKEY_DEFS,
    ACTION_TO_SETTING_KEY,
    acceleratorToDisplay,
    buildDefaultMapHotkeys,
    hasModifier
} = require("../shared/hotkeys-constants");
const {msg} = require("../shared/i18n");
const appLog = require("./app-log");

const hotkeyFilePath = path.join(app.getPath('userData'), 'hotkeys.json');

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

    constructor(mainWindow, settings, mapLibrary) {
        this.mainWindow = mainWindow;
        this.settings = settings;
        this.mapLibrary = mapLibrary;
        const classInstance = this;

        // The banner is raised by a push from `loadKeys()`, which runs before
        // the window has finished loading on a cold start — so the renderer
        // asks as well as listens.
        ipcMain.handle('get-hotkey-conflicts', async () => classInstance.getConflicts());

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
            const id = incomingId || (saved[hotkey] && saved[hotkey].id) || randomUUID();
            saved[hotkey] = {id, mapKey: mapkey};

            try {
                fs.writeFileSync(hotkeyFilePath, JSON.stringify(saved, null, 2), "utf-8");
            } catch (err) {
                console.error("Failed to save hotkeys:", err);
                return classInstance.fail(msg('hotkeys.error.saveFailed'));
            }
            console.log(`Saved hotkey [${id}]: ${hotkey} → ${mapkey}`);
            classInstance.loadKeys();
            return classInstance.ok(msg('hotkeys.saved'));
        });

        ipcMain.on('load-hotkeys', () => {
            classInstance.loadKeys();
        });

        ipcMain.on('delete-hotkey', (event, id) => {
            const saved = classInstance.readHotkeyFile();
            const keyToDelete = Object.keys(saved).find(hk => saved[hk].id === id);

            if (keyToDelete) {
                delete saved[keyToDelete];
                // Wrapped like every other sync write in main since 0.3.2: an
                // `uncaughtException` now ends the process (with a crash file),
                // so a locked `hotkeys.json` must cost the deletion, not the
                // session. `save-hotkeys` above already did this.
                try {
                    fs.writeFileSync(hotkeyFilePath, JSON.stringify(saved, null, 2), 'utf-8');
                } catch (err) {
                    console.error('Failed to delete hotkey:', err && err.message);
                    appLog.error('hotkey-write-failed', {action: 'delete', message: (err && err.message) || String(err)});
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

            // Conflicts with the other system hotkeys
            const current = classInstance.getSystemHotkeys();
            for (const [otherActionId, otherAccel] of Object.entries(current)) {
                if (otherActionId !== actionId && otherAccel === accelerator) {
                    return classInstance.fail(conflictMessage(accelerator, otherActionId));
                }
            }

            // Conflicts with per-map hotkeys
            const customHotkeys = classInstance.readHotkeyFile();
            if (customHotkeys[accelerator]) {
                return classInstance.fail(msg('hotkeys.error.usedByMap',
                    {accelerator: acceleratorToDisplay(accelerator)}));
            }

            const invalid = classInstance.rejectIfUnregisterable(accelerator);
            if (invalid) return classInstance.fail(invalid);

            classInstance.settings.set(settingKey, accelerator);
            classInstance.loadKeys();
            return classInstance.ok(msg('hotkeys.savedSystem'));
        });

        ipcMain.on('reset-system-hotkey', (event, {actionId}) => {
            const settingKey = ACTION_TO_SETTING_KEY[actionId];
            const def = SYSTEM_HOTKEY_DEFS[actionId];
            if (!settingKey || !def) {
                console.warn(`reset-system-hotkey: unknown actionId "${actionId}"`);
                return;
            }

            classInstance.settings.set(settingKey, def.defaultAccelerator);
            classInstance.mainWindow.sendUpdate(msg('hotkeys.resetToDefault'));
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

    /**
     * @returns {{key: string, params: Object}|null} a conflict message when this
     *   accelerator is one of the system hotkeys, null otherwise.
     */
    systemConflict(accelerator) {
        for (const [actionId, accel] of Object.entries(this.getSystemHotkeys())) {
            if (accel !== accelerator) continue;
            return conflictMessage(accelerator, actionId);
        }
        return null;
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
     * @returns {string|null} an error message when invalid, null when usable.
     */
    rejectIfUnregisterable(accelerator) {
        if (this.ownAccelerators().has(accelerator)) return null;

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
     * Every accelerator this app currently binds: every system hotkey in
     * `SYSTEM_HOTKEY_DEFS` plus whatever is in `hotkeys.json`.
     * @returns {Set<string>}
     */
    ownAccelerators() {
        const held = new Set(Object.values(this.getSystemHotkeys()));
        for (const accelerator of Object.keys(this.readHotkeyFile())) held.add(accelerator);
        return held;
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
     * First run only: bind Ctrl+1..Ctrl+N to the shipped maps. Never touches an
     * existing file, so a user who cleared every binding keeps it cleared.
     */
    ensureDefaultMapHotkeys() {
        if (fs.existsSync(hotkeyFilePath)) return;
        const catalog = this.mapLibrary ? this.mapLibrary.getCatalog() : [];
        const defaults = buildDefaultMapHotkeys(catalog, randomUUID);
        if (!Object.keys(defaults).length) return;
        try {
            fs.writeFileSync(hotkeyFilePath, JSON.stringify(defaults, null, 2), "utf-8");
            console.log(`Wrote default map hotkeys: ${Object.keys(defaults).join(", ")}`);
        } catch (err) {
            console.error("Failed to write default hotkeys:", err.message);
        }
    }

    /**
     * Current system hotkey accelerators: stored overrides merged over defaults.
     * @returns {Object<string, string>} actionId → accelerator
     */
    getSystemHotkeys() {
        const result = {};
        for (const [actionId, def] of Object.entries(SYSTEM_HOTKEY_DEFS)) {
            const settingKey = ACTION_TO_SETTING_KEY[actionId];
            const stored = this.settings.get(settingKey);
            result[actionId] = stored || def.defaultAccelerator;
        }
        return result;
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
     * diagnose remotely: the user presses Ctrl+H, nothing happens, and the app
     * looks broken when in fact Discord or the NVIDIA overlay took the
     * combination first. Both halves of 0.3.2 exist for this case — the log
     * line for the report, the banner so the user does not have to send one.
     */
    noteConflict(accelerator, action, reason) {
        const entry = {accelerator, action: action || '', reason: reason || 'taken'};
        if (this.conflicts.some(c => c.accelerator === accelerator)) return;
        this.conflicts.push(entry);
        // Logged once per *change*, not once per reload. `loadKeys()` runs at
        // least twice on every start (once from `createWindow`, once from the
        // renderer's `load-hotkeys`) and again after every hotkey edit; a user
        // who runs Discord would otherwise put thirteen identical warnings in
        // app.log several times a session and reach the 1 MB cap for nothing.
        // A conflict that *appears* is news and is logged; one that persists
        // is already in the file.
        if (this.previousConflicts.has(accelerator)) return;
        appLog.warn('hotkey-register-failed', {accelerator, action: entry.action, reason: entry.reason});
    }

    /** @returns {Array<{accelerator: string, action: string, reason: string}>} */
    getConflicts() {
        return this.conflicts.slice();
    }

    registerSystemHotkeys() {
        const win = this.mainWindow;
        if (!win) {
            console.log("Main window not available, cannot set system hotkeys.");
            return;
        }

        for (const [actionId, accelerator] of Object.entries(this.getSystemHotkeys())) {
            const def = SYSTEM_HOTKEY_DEFS[actionId];
            if (!def) continue;
            this.safeRegister(accelerator, () => {
                appLog.event('hotkey', {action: actionId});
                win.send(def.action);
            }, actionId);
        }
    }

    /**
     * Register per-map hotkeys. System hotkeys take priority — conflicts are
     * skipped and reported, so a stale colliding entry is not silently inert.
     * @param {Object} hotkeys — { accelerator: { id, mapKey } }
     */
    registerCustomHotkeys(hotkeys) {
        const win = this.mainWindow;
        if (!win) return;

        const systemAccelerators = new Set(Object.values(this.getSystemHotkeys()));

        for (const [hotkey, {mapKey, id}] of Object.entries(hotkeys)) {
            if (systemAccelerators.has(hotkey)) {
                console.warn(`Skipping map hotkey "${hotkey}" — conflicts with a system hotkey.`);
                this.noteConflict(hotkey, 'map', 'shadowed');
                // Same rule as every other registration failure: the banner
                // carries it, and the toast is only for the reload the user
                // themselves just caused. This one used to fire on every
                // `loadKeys()`, which is several times a session.
                if (!this.bulkLoading) {
                    win.sendUpdate(msg('hotkeys.error.systemShadowsMap', {accelerator: acceleratorToDisplay(hotkey)}));
                }
                continue;
            }
            // The console label stays the binding's id (that is what
            // hotkeys.json is keyed by when something has to be found in it);
            // the *recorded* action is just "map", because a per-map hotkey's
            // real name is a map name and a custom map's name is user text.
            this.safeRegister(hotkey, () => {
                appLog.event('hotkey', {action: 'map'});
                win.send('hotkey-pressed', mapKey);
            }, id, 'map');
        }
    }

    /** Unregister everything, then re-register system hotkeys, then map hotkeys. */
    loadKeys() {
        globalShortcut.unregisterAll();

        // Rebuilt from scratch: a combination the user has since freed must
        // drop off the banner, and a reload is the only moment we can know.
        this.conflicts = [];
        this.bulkLoading = true;
        let parsed;
        try {
            this.ensureDefaultMapHotkeys();
            this.registerSystemHotkeys();

            parsed = this.readHotkeyFile();
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
            maps: Object.keys(parsed || {}).length,
            conflicts: this.conflicts.length
        });
    }
}

module.exports = Hotkeys;
