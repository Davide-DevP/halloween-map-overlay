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

const hotkeyFilePath = path.join(app.getPath('userData'), 'hotkeys.json');

class Hotkeys {

    mainWindow;
    settings;
    mapLibrary;

    constructor(mainWindow, settings, mapLibrary) {
        this.mainWindow = mainWindow;
        this.settings = settings;
        this.mapLibrary = mapLibrary;
        const classInstance = this;

        // --- Per-map hotkeys ---
        // `handle`, not `on`: the renderer keeps the modal open until it knows
        // the binding was actually accepted.
        ipcMain.handle('save-hotkeys', async (event, payload) => {
            const {hotkey, mapkey, id: incomingId} = payload || {};
            if (!hotkey || !mapkey) {
                return classInstance.fail('Pick both a key combination and a map.');
            }

            if (!hasModifier(hotkey)) {
                return classInstance.fail('A hotkey needs at least one modifier (Ctrl, Alt, Shift or Super).');
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
                return classInstance.fail('Failed to save hotkey.');
            }
            console.log(`Saved hotkey [${id}]: ${hotkey} → ${mapkey}`);
            classInstance.loadKeys();
            return classInstance.ok('Hotkey saved.');
        });

        ipcMain.on('load-hotkeys', () => {
            classInstance.loadKeys();
        });

        ipcMain.on('delete-hotkey', (event, id) => {
            const saved = classInstance.readHotkeyFile();
            const keyToDelete = Object.keys(saved).find(hk => saved[hk].id === id);

            if (keyToDelete) {
                delete saved[keyToDelete];
                fs.writeFileSync(hotkeyFilePath, JSON.stringify(saved, null, 2), 'utf-8');
                console.log(`Removed hotkey: ${keyToDelete} (id: ${id})`);
                classInstance.mainWindow.sendUpdate('Hotkey deleted.');
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
                return classInstance.fail('Failed to save hotkey: missing data.');
            }

            const settingKey = ACTION_TO_SETTING_KEY[actionId];
            if (!settingKey) {
                console.warn(`save-system-hotkey: unknown actionId "${actionId}"`);
                return classInstance.fail('Failed to save hotkey: unknown action.');
            }

            if (!hasModifier(accelerator)) {
                return classInstance.fail('A hotkey needs at least one modifier (Ctrl, Alt, Shift or Super).');
            }

            // Conflicts with the other system hotkeys
            const current = classInstance.getSystemHotkeys();
            for (const [otherActionId, otherAccel] of Object.entries(current)) {
                if (otherActionId !== actionId && otherAccel === accelerator) {
                    const def = SYSTEM_HOTKEY_DEFS[otherActionId];
                    const name = def ? def.description : otherActionId;
                    return classInstance.fail(`"${acceleratorToDisplay(accelerator)}" is already bound to "${name}".`);
                }
            }

            // Conflicts with per-map hotkeys
            const customHotkeys = classInstance.readHotkeyFile();
            if (customHotkeys[accelerator]) {
                return classInstance.fail(`"${acceleratorToDisplay(accelerator)}" is already used by a map hotkey.`);
            }

            const invalid = classInstance.rejectIfUnregisterable(accelerator);
            if (invalid) return classInstance.fail(invalid);

            classInstance.settings.set(settingKey, accelerator);
            classInstance.loadKeys();
            return classInstance.ok('System hotkey saved.');
        });

        ipcMain.on('reset-system-hotkey', (event, {actionId}) => {
            const settingKey = ACTION_TO_SETTING_KEY[actionId];
            const def = SYSTEM_HOTKEY_DEFS[actionId];
            if (!settingKey || !def) {
                console.warn(`reset-system-hotkey: unknown actionId "${actionId}"`);
                return;
            }

            classInstance.settings.set(settingKey, def.defaultAccelerator);
            classInstance.mainWindow.sendUpdate('Hotkey reset to default.');
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
     * @returns {string|null} a conflict message when this accelerator is one of
     *   the system hotkeys, null otherwise.
     */
    systemConflict(accelerator) {
        for (const [actionId, accel] of Object.entries(this.getSystemHotkeys())) {
            if (accel !== accelerator) continue;
            const def = SYSTEM_HOTKEY_DEFS[actionId];
            const name = def ? def.description : actionId;
            return `"${acceleratorToDisplay(accelerator)}" is already bound to "${name}".`;
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
            return `"${accelerator}" is not a key combination this app can register.`;
        }
        // The probe took nothing away from us (we never hold this one), so the
        // caller's own loadKeys() after a successful save is the only one
        // needed — this used to run loadKeys three times per save.
        if (registered) globalShortcut.unregister(accelerator);
        else this.mainWindow.sendUpdate(`"${acceleratorToDisplay(accelerator)}" is already taken by another application.`);
        return null;
    }

    /**
     * Every accelerator this app currently binds: the four system hotkeys plus
     * whatever is in `hotkeys.json`.
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
     * @returns {boolean}
     */
    safeRegister(accelerator, handler, label) {
        const win = this.mainWindow;
        try {
            if (globalShortcut.register(accelerator, handler)) return true;
            console.warn(`Failed to register "${accelerator}" (${label}) — already taken`);
            if (win) win.sendUpdate(`"${acceleratorToDisplay(accelerator)}" is already taken by another application.`);
        } catch (err) {
            console.error(`Invalid accelerator "${accelerator}" (${label}): ${err.message}`);
            if (win) win.sendUpdate(`"${accelerator}" is not a valid shortcut — reset it in Settings › Hotkeys.`);
        }
        return false;
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
            this.safeRegister(accelerator, () => win.send(def.action), actionId);
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
                win.sendUpdate(`"${acceleratorToDisplay(hotkey)}" is also a system hotkey — the map binding is inactive.`);
                continue;
            }
            this.safeRegister(hotkey, () => win.send('hotkey-pressed', mapKey), id);
        }
    }

    /** Unregister everything, then re-register system hotkeys, then map hotkeys. */
    loadKeys() {
        globalShortcut.unregisterAll();

        this.ensureDefaultMapHotkeys();
        this.registerSystemHotkeys();

        const parsed = this.readHotkeyFile();
        this.mainWindow.send('hotkey-updated', parsed);
        this.registerCustomHotkeys(parsed);

        this.mainWindow.send('system-hotkeys-updated', this.getSystemHotkeys());
    }
}

module.exports = Hotkeys;
