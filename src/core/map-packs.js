'use strict';

const {app, ipcMain} = require('electron');
const path = require('path');

const appLog = require('./app-log');
const rules = require('../shared/map-pack-rules');
const MapPackStore = require('./map-pack-store');
const {fetchPackFile} = require('./map-pack-fetch');
const {checkForPacks} = require('./map-pack-install');
const {msg} = require('../shared/i18n');
const {acceleratorToDisplay} = require('../shared/hotkeys-constants');
const {DEFAULT_SIZE} = require('./map-detector/matcher');

/**
 * Map packs — new and updated maps without an app release. Spec:
 * `docs/SPEC-MAP-PACKS.md`.
 *
 * This is the **electron half**: where the packs live (`userData/map-packs`),
 * the setting that gates the request, when the check runs, the IPC the Settings
 * button calls, and who is told after a pack lands. Everything it decides is
 * pure (`shared/map-pack-rules.js`), everything it writes is fs-only
 * (`map-pack-store.js`), and everything it downloads goes through one injected
 * function (`map-pack-fetch.js`) — so the whole install is unit tested without
 * Electron and without the network.
 *
 * The rules that make this the app's *second* network request and not a
 * surprise:
 *
 * - **`checkForMapPacks` (default true, Settings › General).** With it off no
 *   request is made at all — the gate is in the pure `shouldCheckPacks`, so it
 *   cannot be forgotten at one of the two call sites, and the "Check for new
 *   maps" button honours it too.
 * - **Never before the window.** The startup check is a `setTimeout` after the
 *   main window has shown, deliberately later than the update check so two
 *   toasts do not arrive together on a slow connection.
 * - **At most once per 24 h**, remembered in `map-packs/state.json` rather than
 *   in the settings file.
 * - **Nothing is sent.** A GET of a public file, no query string, no cookies,
 *   no identifiers; the only header that says anything is the `User-Agent`.
 * - **A pack's key is logged in full, like a shipped map's.** The logging rule
 *   (`docs/agents/diagnostics.md`) is that a *custom* map's key is user text and becomes `Custom/(custom)`. A
 *   pack's key is not user text: it is catalogue data from a manifest published
 *   in this project's own repository, and `isValidPackKey` restricts it to a
 *   narrow character set with no newlines and no `=`, so it is safe in a
 *   `k=v` log line. Which pack failed to install is also the only thing that
 *   makes "the new map never arrived" answerable. Packs may not claim the
 *   reserved `Custom` creator, so this can never become a way to launder a
 *   user-typed name into the log.
 */
class MapPacks {

    /**
     * @param {Object} mainWindow for the status toast and the refresh push
     * @param {Object} settings the `checkForMapPacks` gate
     * @param {Object} mapLibrary invalidated after an install
     */
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
        // Leftovers from a run that was killed mid-download or mid-swap.
        // Mostly housekeeping — but a pack parked aside by a swap the process
        // did not live to finish is *restored* here rather than deleted, which
        // is the one case where it is recovery.
        const swept = this.store.sweep();
        if (swept.removed || swept.restored) {
            appLog.event('map-pack-sweep', {removed: swept.removed, restored: swept.restored});
        }

        const self = this;
        // The "Check for new maps" button. `handle`, not `on`: the button is
        // disabled until it answers.
        ipcMain.handle('check-map-packs', async () => self.check({force: true}));
        // What Settings shows next to the button, and what the renderer needs
        // to say "3 installed, last checked …" without a second source.
        ipcMain.handle('get-map-pack-state', async () => self.info());
        // `get-map-markers` used to be handled here. It now lives in
        // `core/map-markers.js`, which asks `markers()` below first and falls
        // back to the bundled file — one channel, one precedence rule, whether
        // the map came from a pack or from `maps/`.
    }

    /** The running app's version, for `minAppVersion`. */
    static appVersion() {
        try {
            return require('../../package.json').version || '0.0.0';
        } catch (err) {
            return '0.0.0';
        }
    }

    /**
     * `MapDetector`, so a freshly installed pack's templates are picked up
     * without a restart. Injected rather than held from the constructor: the
     * detector is built after this class in `index.js`.
     */
    setDetector(detector) {
        this.detector = detector && typeof detector.reloadTemplates === 'function' ? detector : null;
    }

    /**
     * `Hotkeys`, so a map that arrives *after* the first run still gets a
     * number key. Injected for the same reason as the detector: it is built
     * before this class but the dependency runs the other way, and the file
     * writing stays in the one place that owns `hotkeys.json`.
     */
    setHotkeys(hotkeys) {
        this.hotkeys = hotkeys && typeof hotkeys.assignPackMapHotkey === 'function' ? hotkeys : null;
    }

    /** Installed packs, as the catalogue and the diagnostic report want them. */
    list() {
        return this.store.list();
    }

    /**
     * Every installed pack's templates, for the detector's one-time load.
     * @returns {Array<{key: string, templates: Object}>}
     */
    templates() {
        const out = [];
        for (const pack of this.store.list()) {
            const loaded = this.store.readTemplates(pack);
            if (loaded) out.push(loaded);
        }
        return out;
    }

    /**
     * The markers an installed pack carries for this key, or null.
     * `core/map-markers.js` calls it first and falls back to the bundled file,
     * so a pack overrides a bundled map's markers exactly as it overrides its
     * image and its templates.
     */
    markers(key) {
        const pack = this.store.list().find(p => p.key === key);
        return pack ? this.store.readMarkers(pack) : null;
    }

    /**
     * Installed packs plus the last check, for `system.txt` and the renderer.
     * @returns {{packs: Array<{key, version}>, lastCheckAt: number,
     *            lastResult: string, lastError: ?string, skipped: Array}}
     */
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

    /**
     * The inputs of the pure `shouldCheckPacks`, in one place so the startup
     * timer and the button cannot end up asking slightly different questions.
     *
     * `lastFailed` shortens the wait to an hour: a launch with no network fails
     * in a second and would otherwise burn the whole day's slot, so coming back
     * online ten minutes later would find nothing until tomorrow. A 404 on the
     * index is **not** a failure — it is "nothing published yet" — so it does
     * not shorten anything either.
     */
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

    /**
     * The startup check: after the window is up, never blocking it.
     *
     * The delay is longer than the update check's 4 s on purpose — the two are
     * the app's only two requests, and arriving together they would produce two
     * toasts over a freshly drawn home page.
     * @param {number} [delayMs]
     */
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

    /**
     * Check the index and install what is new.
     *
     * @param {{force?: boolean, startup?: boolean}} [opts] `force` is the
     *   button: it ignores the 24 h interval but **not** the setting.
     * @returns {Promise<{ok: boolean, installed: number, error: ?string,
     *                    state: object}>}
     */
    async check(opts) {
        const options = opts || {};
        if (this.checking) return {ok: false, installed: 0, error: 'busy', state: this.info()};

        const decision = rules.shouldCheckPacks(this.gateState(options.force));
        if (!decision.check) {
            // With the setting off this is the whole story: no socket is
            // opened, and the button says so rather than doing nothing.
            if (decision.reason === 'disabled' && options.force) {
                this.toast(msg('mapPacks.disabled'));
            }
            return {ok: false, installed: 0, error: decision.reason, state: this.info()};
        }

        this.checking = true;
        if (options.force) this.toast(msg('mapPacks.checking'));
        // Which map keys the catalogue held *before* the check. A pack key that
        // is not in here is a genuinely new map and is offered a number key;
        // one that is replaces a bundled map (or an older version of itself)
        // and keeps whatever binding that map already had.
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
            // `checkForPacks` is written never to throw; if it ever does, being
            // offline still must not be more than a toast.
            appLog.error('map-pack-check', {result: 'threw', message: (err && err.message) || String(err)});
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
            // "Nothing published yet" is a different sentence from "you have
            // them all" — and until the first pack ships it is the honest one.
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

    /**
     * A pack landed: make it visible everywhere, without a restart.
     *
     * The catalogue first, because the gallery refresh, the detector and the
     * hotkey assignment all read through it.
     *
     * @param {Array<{key: string, version: number}>} installed
     * @param {Set<string>} [before] catalogue keys from before the check
     */
    applyNewPacks(installed, before) {
        if (this.mapLibrary && typeof this.mapLibrary.invalidate === 'function') this.mapLibrary.invalidate();
        // Templates are re-read here, once, and never on a tick — see
        // "The capture path — do not make it heavier" in docs/agents/detection.md.
        if (this.detector) this.detector.reloadTemplates();
        const bound = this.assignHotkeys(installed, before);
        const names = installed.map(p => p.key.split('/').pop());
        if (installed.length === 1 && bound.length === 1) {
            // Binding a *global* accelerator without saying so would be the
            // kind of surprise this app does not do.
            this.toast(msg('mapPacks.installedOneBound', {
                map: names[0],
                accelerator: acceleratorToDisplay(bound[0].accelerator)
            }));
        } else {
            this.toast(installed.length === 1
                ? msg('mapPacks.installedOne', {map: names[0]})
                : msg('mapPacks.installedMany', {count: installed.length}));
        }
        // The gallery, the creator filter and the hotkey map picker all rebuild
        // from the catalogue the renderer asks main for.
        if (this.mainWindow) this.mainWindow.send('map-packs-updated', {installed: installed.length});
    }

    /**
     * Give each genuinely **new** map a default `Ctrl+Alt+N`.
     *
     * `hotkeys.json` is written once, on the first run, so a map that arrives a
     * week later used to be a map with no number forever. The decision (and
     * every rule that keeps it from re-arming what a user cleared, offering the
     * same map twice, or creating a conflict) is the pure `planPackMapHotkey`;
     * `Hotkeys.assignPackMapHotkey` owns the write, so there is still exactly
     * one `hotkeys.json` writer.
     *
     * "Offered" is remembered in the pack store's state file rather than in
     * `hotkeys.json`, because the whole point is that a binding the user
     * **deleted** must not come back on the next start.
     *
     * @returns {Array<{key: string, accelerator: string}>} what was bound
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
        // One reload for however many arrived: `loadKeys` unregisters and
        // re-registers everything, so calling it per map would be N times the
        // work and N sets of renderer pushes.
        if (bound.length && typeof this.hotkeys.loadKeys === 'function') this.hotkeys.loadKeys();
        return bound;
    }

    /**
     * `keep: true` — the startup check runs on a timer, so "3 new maps were
     * installed (and one of them is on Ctrl+Alt+5)" can land while the main
     * window is torn down in the tray. It is the only notice the user gets
     * that their catalogue changed, so it waits for the next window rather
     * than disappearing. See `MainWindow.sendUpdate`.
     */
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

/**
 * The image decoder main already has: `image-size` is a runtime dependency
 * required by `src/core/main-window.js` for the overlay's bounds. It parses the
 * header only — no pixels, no decode — which is exactly the amount of trust a
 * downloaded PNG deserves. Resolved lazily and wrapped so a pack can never
 * make the check itself throw.
 *
 * @param {Buffer} bytes
 * @returns {?{width: number, height: number, type: string}}
 */
MapPacks.probeImage = function probeImage(bytes) {
    try {
        const {imageSize} = require('image-size');
        return imageSize(bytes);
    } catch (err) {
        return null;
    }
};

module.exports = MapPacks;
