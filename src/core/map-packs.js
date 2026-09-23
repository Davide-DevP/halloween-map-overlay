'use strict';

const {app, ipcMain} = require('electron');
const path = require('path');

const appLog = require('./app-log');
const {errorMessage} = require('../shared/errors');
const rules = require('../shared/map-pack-rules');
const MapPackStore = require('./map-pack-store');
const {fetchPackFile} = require('./map-pack-fetch');
const {checkForPacks} = require('./map-pack-install');
const {msg} = require('../shared/i18n');
const {acceleratorToDisplay} = require('../shared/hotkeys-constants');
const {DEFAULT_SIZE} = require('./map-detector/matcher');

/**
 * Map packs, the **electron half**: where packs live (`userData/map-packs`), the
 * setting that gates the request, when the check runs, the IPC and who is told
 * after a pack lands. Every decision is pure (`shared/map-pack-rules.js`), every
 * write fs-only (`map-pack-store.js`), every download through one injected
 * function (`map-pack-fetch.js`), so the install is unit tested without
 * Electron and without the network. **Nothing is sent**: a GET of one public
 * file, no query, no cookies, no identifiers. **A pack's key is logged in
 * full**, unlike a custom map's — it is catalogue data, not user text. Spec:
 * `docs/SPEC-MAP-PACKS.md`; reasoning: `docs/agents/map-packs.md`.
 */
class MapPacks {

    /** `mainWindow` takes the toast and the refresh push, `settings` holds the
     * `checkForMapPacks` gate, `mapLibrary` is invalidated after an install. */
    constructor(mainWindow, settings, mapLibrary) {
        this.mainWindow = mainWindow;
        this.settings = settings;
        this.mapLibrary = mapLibrary;
        /** Set by `setDetector` — reloads the templates after an install. */
        this.detector = null;
        /** Set by `setHotkeys` — gives a newly downloaded map its number key. */
        this.hotkeys = null;
        this.checking = false;
        this.startupTimer = null;

        let dir = null;
        try {
            dir = app && typeof app.getPath === 'function'
                ? path.join(app.getPath('userData'), 'map-packs')
                : null;
        } catch (err) {
            console.error('Map packs: no userData path:', err && err.message);
        }
        this.store = new MapPackStore(dir, {
            appVersion: MapPacks.appVersion(),
            templateSize: DEFAULT_SIZE
        });
        // Housekeeping, except that a pack parked aside by an unfinished swap
        // is *restored* here rather than deleted.
        const swept = this.store.sweep();
        if (swept.removed || swept.restored) {
            appLog.event('map-pack-sweep', {removed: swept.removed, restored: swept.restored});
        }

        const self = this;
        // `handle`, not `on`: the button stays disabled until it answers.
        ipcMain.handle('check-map-packs', async () => self.check({force: true}));
        ipcMain.handle('get-map-pack-state', async () => self.info());
    }

    /** The running app's version, for `minAppVersion`. */
    static appVersion() {
        try {
            return require('../../package.json').version || '0.0.0';
        } catch (err) {
            return '0.0.0';
        }
    }

    /** So a new pack's templates are picked up without a restart. Injected,
     * not taken in the constructor: it is built after this class. */
    setDetector(detector) {
        this.detector = detector && typeof detector.reloadTemplates === 'function' ? detector : null;
    }

    /** So a map arriving after the first run still gets a number key. Injected
     * so the write stays in the one place that owns `hotkeys.json`. */
    setHotkeys(hotkeys) {
        this.hotkeys = hotkeys && typeof hotkeys.assignPackMapHotkey === 'function' ? hotkeys : null;
    }

    list() {
        return this.store.list();
    }

    /** Every installed pack's templates, for the detector's one-time load. */
    templates() {
        const out = [];
        for (const pack of this.store.list()) {
            const loaded = this.store.readTemplates(pack);
            if (loaded) out.push(loaded);
        }
        return out;
    }

    /** `core/map-markers.js` calls this before the bundled file, so a pack
     * overrides markers as it overrides image and templates. */
    markers(key) {
        const pack = this.store.list().find(p => p.key === key);
        return pack ? this.store.readMarkers(pack) : null;
    }

    /** Installed packs plus the last check, for `system.txt` and Settings. */
    info() {
        const state = this.store.state();
        return {
            packs: this.store.list().map(p => ({key: p.key, version: p.version, bytes: p.bytes})),
            skipped: this.store.skipped.slice(),
            lastCheckAt: state.lastCheckAt,
            lastResult: state.lastResult,
            lastError: state.lastError,
            enabled: this.enabled()
        };
    }

    enabled() {
        return !this.settings || this.settings.get('checkForMapPacks') !== false;
    }

    /** The inputs of the pure `shouldCheckPacks`, in one place so the startup
     * timer and the button cannot ask different questions. `lastFailed`
     * shortens the wait to an hour; a 404 is "nothing published yet", **not** a
     * failure, so it shortens nothing. */
    gateState(force) {
        const state = this.store.state();
        return {
            enabled: this.enabled(),
            lastCheckAt: state.lastCheckAt,
            lastFailed: state.lastResult === 'failed',
            now: Date.now(),
            force: !!force
        };
    }

    /** After the window is up, never blocking it, and later than the update
     * check's 4 s so the two toasts cannot land together. */
    scheduleStartupCheck(delayMs) {
        if (this.startupTimer) clearTimeout(this.startupTimer);
        const decision = rules.shouldCheckPacks(this.gateState());
        if (!decision.check) {
            console.log(`Map pack check skipped at startup: ${decision.reason}.`);
            return;
        }
        this.startupTimer = setTimeout(() => {
            this.startupTimer = null;
            this.check({startup: true}).catch(err => {
                console.error('Map pack check failed:', err && err.message);
            });
        }, typeof delayMs === 'number' ? delayMs : 9000);
        if (this.startupTimer.unref) this.startupTimer.unref();
    }

    /** Check the index and install what is new. `opts.force` is the button: it
     * ignores the 24 h interval **and** the setting — the click is the consent. */
    async check(opts) {
        const options = opts || {};
        if (this.checking) return {ok: false, installed: 0, error: 'busy', state: this.info()};

        const decision = rules.shouldCheckPacks(this.gateState(options.force));
        if (!decision.check) {
            return {ok: false, installed: 0, error: decision.reason, state: this.info()};
        }

        this.checking = true;
        if (options.force) this.toast(msg('mapPacks.checking'));
        // The catalogue's keys *before* the check: only a key missing from it is
        // a new map, and only a new map is offered a number key.
        const before = this.catalogKeys();
        let result;
        try {
            result = await checkForPacks({
                store: this.store,
                fetch: fetchPackFile,
                appVersion: MapPacks.appVersion(),
                probeImage: MapPacks.probeImage,
                log: (event, fields) => appLog.event(event, fields)
            });
        } catch (err) {
            // `checkForPacks` is written never to throw; if it does, being
            // offline still must not be more than a toast.
            appLog.error('map-pack-check', {result: 'threw', message: errorMessage(err)});
            result = {ok: false, error: 'threw', notPublished: false, installed: [], skipped: [], failed: []};
        } finally {
            this.checking = false;
        }

        const installed = result.installed.length;
        this.store.writeState({
            lastCheckAt: Date.now(),
            lastResult: result.ok
                ? (result.notPublished ? 'not-published' : (installed ? `installed:${installed}` : 'up-to-date'))
                : 'failed',
            lastError: result.ok ? null : (result.error || 'failed'),
            installed: this.store.list().length
        });

        if (!result.ok) {
            if (options.force) this.toast(msg('mapPacks.failed'));
            return {ok: false, installed: 0, error: result.error, state: this.info()};
        }
        if (installed) {
            this.applyNewPacks(result.installed, before);
        } else if (options.force) {
            // "Nothing published yet" ≠ "you have them all".
            this.toast(result.notPublished ? msg('mapPacks.notPublished') : msg('mapPacks.upToDate'));
        }
        return {ok: true, installed, error: null, state: this.info()};
    }

    /** Lower-cased catalogue keys, or an empty set when there is no library. */
    catalogKeys() {
        try {
            const catalog = this.mapLibrary ? this.mapLibrary.getCatalog() : [];
            return new Set(catalog.map(e => String(e.key || '').toLowerCase()));
        } catch (err) {
            return new Set();
        }
    }

    /** A pack landed: make it visible everywhere without a restart. The
     * catalogue first — the gallery refresh, the detector and the hotkey
     * assignment all read through it. `before` is its keys from before. */
    applyNewPacks(installed, before) {
        if (this.mapLibrary && typeof this.mapLibrary.invalidate === 'function') this.mapLibrary.invalidate();
        // Templates are re-read here, once, never on a tick — see "The capture
        // path" in docs/agents/detection.md.
        if (this.detector) this.detector.reloadTemplates();
        const bound = this.assignHotkeys(installed, before);
        const names = installed.map(p => p.key.split('/').pop());
        if (installed.length === 1 && bound.length === 1) {
            // The toast names the key: binding a *global* accelerator
            // silently would be a surprise.
            this.toast(msg('mapPacks.installedOneBound', {
                map: names[0],
                accelerator: acceleratorToDisplay(bound[0].accelerator)
            }));
        } else {
            this.toast(installed.length === 1
                ? msg('mapPacks.installedOne', {map: names[0]})
                : msg('mapPacks.installedMany', {count: installed.length}));
        }
        if (this.mainWindow) this.mainWindow.send('map-packs-updated', {installed: installed.length});
    }

    /**
     * Give each genuinely **new** map a default `Ctrl+Alt+N`. The decision is
     * the pure `planPackMapHotkey`; `Hotkeys.assignPackMapHotkey` owns the
     * write, so there is still exactly one `hotkeys.json` writer. "Offered" is
     * remembered in the pack store's state file, not in `hotkeys.json`, so a
     * binding the user **deleted** cannot come back on the next start.
     * @returns {Array<{key, accelerator}>} what was bound
     */
    assignHotkeys(installed, before) {
        if (!this.hotkeys) return [];
        const seen = before instanceof Set ? before : new Set();
        const offered = this.store.state().offeredHotkeys;
        const bound = [];
        const remember = [];
        for (const pack of installed) {
            // A pack replacing a bundled map is not a new map.
            if (seen.has(String(pack.key).toLowerCase())) continue;
            const outcome = this.hotkeys.assignPackMapHotkey(pack.key, offered.concat(remember));
            if (outcome.remember) remember.push(pack.key);
            if (outcome.accelerator) bound.push({key: pack.key, accelerator: outcome.accelerator});
        }
        if (remember.length) this.store.noteOfferedHotkeys(remember);
        // One reload for however many arrived: `loadKeys` re-registers
        // everything, so per-map calls would be N times the work.
        if (bound.length && typeof this.hotkeys.loadKeys === 'function') this.hotkeys.loadKeys();
        return bound;
    }

    /** `keep: true`: the check runs on a timer, so this can fire while the main
     * window is torn down in the tray, and it is the only notice that the
     * catalogue changed — it waits for the next window. See `sendUpdate`. */
    toast(message) {
        if (this.mainWindow && typeof this.mainWindow.sendUpdate === 'function') {
            this.mainWindow.sendUpdate(message, {keep: true});
        }
    }

    destroy() {
        if (this.startupTimer) clearTimeout(this.startupTimer);
        this.startupTimer = null;
    }
}

/** `image-size`, the decoder main already has for the overlay's bounds: header
 * only, no pixels and no decode, which is the amount of trust a downloaded PNG
 * deserves. Lazy and wrapped, so a pack cannot make the check itself throw. */
MapPacks.probeImage = function probeImage(bytes) {
    try {
        const {imageSize} = require('image-size');
        return imageSize(bytes);
    } catch (err) {
        return null;
    }
};

module.exports = MapPacks;
