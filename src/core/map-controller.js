const {ipcMain} = require('electron');
const {reduceMapState, intentForAction, INITIAL_STATE} = require('../shared/map-state');
const {CUSTOM_CREATOR} = require('./map-catalog');
const appLog = require('./app-log');

const debug = process.env.DEBUG === 'true';

/**
 * Which map is on the overlay, and every decision that changes it.
 *
 * The impure half of `shared/map-state.js` — it holds the state, reads the
 * catalogue and the settings, and turns each effect the pure reducer produces
 * into a call. It decides nothing itself; if a behaviour question comes up, the
 * answer belongs in the reducer, where a test can reach it.
 *
 * ## Why this is in the main process
 *
 * Until 0.7 all of this lived in `src/js/maps.js`, i.e. in the **main window's
 * renderer**, which made that renderer load-bearing for everything the app does
 * during a match: every system and per-map hotkey, the detector's only route to
 * the overlay, the menu clear, the markers toggle. `docs/MEMORY-REPORT-2.md`
 * §3.3 measured ~32 MB sitting in that renderer while the window is hidden in
 * the tray and rejected reclaiming it for exactly that reason. With the state
 * here:
 *
 * - **Every entry point works with no window at all.** `select`, `detected`,
 *   `menuHide` and `action` touch the overlay and the OBS window, which are
 *   separate `BrowserWindow`s with their own renderers. The main window is a
 *   *view*: it asks for the state on load, renders it, sends intents, and
 *   receives `map-state` pushes.
 * - **A main-window renderer crash costs nothing.** Before, the reloaded
 *   renderer came back with `currentKey = ''` while main still believed the old
 *   map was up (VERIFICATION-6, finding 4, patched with an extra
 *   `map-detector-shown` on load). There is nothing to lose here.
 *
 * See `docs/SPEC-MAP-STATE.md` for the whole channel inventory.
 */
class MapController {

    /**
     * @param {Object} mainWindow `core/main-window.js` — `applyMapChange`,
     *   `sendUpdate` and `send`.
     * @param {Object} settings `core/settings.js`
     * @param {Object} mapLibrary `core/map-library.js` — the catalogue
     */
    constructor(mainWindow, settings, mapLibrary) {
        this.mainWindow = mainWindow;
        this.settings = settings;
        this.mapLibrary = mapLibrary;
        /** `core/map-detector.js`, injected — it is built after this class. */
        this.detector = null;
        this.state = Object.assign({}, INITIAL_STATE);

        const self = this;
        // The view's load-time fetch. A renderer that has just been created —
        // a first start, a reopen from the tray after an unload, a reload after
        // a crash — renders from this, never from an assumption.
        ipcMain.handle('get-map-state', async () => self.status());
        // One channel for every intent the view can express. `send`, not
        // `handle`: the answer is the `map-state` push, which every window that
        // cares is listening for anyway.
        ipcMain.on('map-intent', (event, intent) => self.dispatch(intent));
    }

    /**
     * The detector. Injected rather than a constructor argument because
     * `MapDetector` is built after this class and needs it in the other
     * direction (every accepted match arrives here).
     * @param {?Object} detector
     */
    setDetector(detector) {
        this.detector = detector || null;
    }

    /** `{currentKey, lastKey, previewActive}` — what the view renders from. */
    status() {
        return {
            currentKey: this.state.currentKey,
            lastKey: this.state.lastKey,
            previewActive: this.state.previewActive
        };
    }

    /** What the overlay is showing, for the diagnostic report. */
    currentKey() {
        return this.state.currentKey;
    }

    catalog() {
        if (!this.mapLibrary) return [];
        try {
            return this.mapLibrary.getCatalog() || [];
        } catch (err) {
            console.error('MapController: could not read the catalogue:', err && err.message);
            return [];
        }
    }

    /*
     * ─── Entry points ───────────────────────────────────────────────────────
     */

    /** A gallery click, a per-map hotkey, or `show-map=<key>` from the CLI. */
    select(key, source) {
        this.dispatch({type: 'select', key, source: source || 'click'});
    }

    /**
     * The detector accepted a match.
     *
     * Every accepted match arrives (the per-key throttle in the loop is about
     * IPC volume, not correctness) and the reducer decides whether anything
     * changes — **against what the overlay is showing**, never against the
     * detector's own `lastDetected`. Comparing against `lastDetected` is what
     * made a manual pick permanent in 0.3.0; read the comment above
     * `MapDetector` before changing this.
     */
    detected(key) {
        this.dispatch({type: 'detected', key});
    }

    /** The detector saw the game's main menu again: the match is over. */
    menuHide() {
        this.dispatch({type: 'menu-hide'});
    }

    /**
     * A system hotkey fired. `actionId` is a `SYSTEM_HOTKEY_DEFS` id, handed
     * straight through by `core/hotkeys.js`.
     * @returns {boolean} whether the action was known
     */
    action(actionId) {
        const intent = intentForAction(actionId);
        if (!intent) return false;
        this.dispatch(intent);
        return true;
    }

    /*
     * There is deliberately **no** `catalogChanged()` here.
     *
     * A map pack landing or a custom image being deleted does not change what
     * is on the overlay, and this class holds no catalogue snapshot to
     * refresh: `catalog()` asks `MapLibrary` on every dispatch and `MapLibrary`
     * owns the cache (invalidated by `user-data.js` and by the pack install).
     * A stale *key* is handled where it matters instead — every path that
     * re-sends a stored key resolves it against the catalogue first and says
     * so when it is gone.
     */

    /*
     * ─── The loop ───────────────────────────────────────────────────────────
     */

    /**
     * Reduce, run the effects, push the result.
     *
     * Wrapped end to end: this is called from a global-shortcut callback, from
     * the detector's tick and from IPC, and a throw in any of those is an
     * `uncaughtException` — which, since 0.3.2, ends the session with a crash
     * file. Losing one map change is survivable; losing the app mid-match is
     * not.
     */
    dispatch(intent) {
        if (!intent || typeof intent.type !== 'string') return;
        let result;
        try {
            result = reduceMapState(this.state, intent, {
                catalog: this.catalog(),
                settings: this.settings ? this.settings.all() : {}
            });
        } catch (err) {
            console.error(`MapController: "${intent.type}" failed:`, err && err.message);
            appLog.error('map-intent', {intent: intent.type, message: (err && err.message) || String(err)});
            return;
        }
        // Captured **before** the commit below: this is where a failed apply
        // has to go back to, and reading `this.state` inside `runEffect` would
        // hand it the state the reducer has just produced — i.e. the very
        // thing the rollback exists to undo.
        const previous = this.state;
        this.state = result.state;
        let applied = null;
        for (const effect of result.effects) {
            try {
                const source = this.runEffect(effect, previous);
                if (source) applied = source;
            } catch (err) {
                console.error(`MapController: effect "${effect.type}" failed:`, err && err.message);
                appLog.error('map-effect', {effect: effect.type, message: (err && err.message) || String(err)});
            }
        }
        this.push(applied);
    }

    /**
     * One effect. Returns the `source` of an `apply`, so `dispatch` can put it
     * on the push (the view leaves "set position" mode when a map actually
     * landed, and only then).
     * @param {Object} effect
     * @param {Object} previous the state before this dispatch, for a rollback
     * @returns {?string}
     */
    runEffect(effect, previous) {
        switch (effect.type) {

            case 'apply': {
                const opts = {source: effect.source};
                if (effect.mapLabel) opts.mapLabel = effect.mapLabel;
                // Tell the detector what is on the overlay — on every apply,
                // hides included. Its "back in the menu, clear the map" check
                // needs to know a map is up *whoever put it there*: gating that
                // on the detector's own last detection meant a match whose map
                // was picked by hand was never cleared in the menu (0.3.2 field
                // log, fixed in 0.3.3). `noteShown` collapses repeats, so the
                // re-sends from a slider drag cost nothing.
                if (this.detector && typeof this.detector.noteShown === 'function') {
                    this.detector.noteShown(effect.key || null);
                }
                // `applyMapChange` is async (it reads the image), and this is
                // called from a global-shortcut callback and from the detector
                // tick — so the rejection has to be caught here. An
                // `unhandledRejection` ends the session with a crash file
                // since 0.3.2, and a map file that vanished between the
                // catalogue check and the read is not worth the app.
                //
                // A `false` answer means the map never reached the overlay —
                // the file is gone, the payload is not an image, or a later
                // press overtook this one. The state is rolled back to what it
                // was *before* this effect, because a `currentKey` naming a map
                // the player cannot see is what makes the gallery highlight,
                // toggle-map and the detector's menu clear all disagree with
                // the screen.
                const before = previous || this.state;
                if (this.mainWindow) {
                    Promise.resolve(this.mainWindow.applyMapChange(effect.key, opts))
                        .then(ok => {
                            // `undefined` from a double that predates the return
                            // value is treated as success, so a stub cannot
                            // silently undo every map change.
                            if (ok === false) this.rollback(before, effect);
                        })
                        .catch(err => {
                            console.error('MapController: the map change failed:', err && err.message);
                            appLog.error('map-change', {message: (err && err.message) || String(err)});
                            this.rollback(before, effect);
                        });
                }
                return effect.source || 'click';
            }

            case 'setting':
                if (this.settings) this.settings.set(effect.key, effect.value);
                return null;

            case 'toast':
                // `{key, params}` from the reducer's `msg()`, never English:
                // the language can change while a toast is on screen and main
                // has no business knowing which one is in force.
                //
                // No `keep`: every toast the map state produces describes
                // something the player just did with a hotkey, so with the
                // window torn down in the tray it is dropped rather than
                // queued. See `MainWindow.sendUpdate`.
                if (this.mainWindow) this.mainWindow.sendUpdate(effect.message);
                return null;

            case 'detector-reset':
                if (this.detector && typeof this.detector.resetLastDetected === 'function') {
                    this.detector.resetLastDetected();
                }
                return null;

            case 'detector-applied':
                if (this.detector && typeof this.detector.noteApplied === 'function') {
                    this.detector.noteApplied(effect);
                }
                return null;

            case 'refresh-preview':
                // The sample image lives in the renderer's canvas, so only the
                // renderer can re-send it. The Overlay tab is open, therefore
                // the window exists; with no window this is dropped and the
                // preview is rebuilt when the tab is next shown.
                if (this.mainWindow) this.mainWindow.send('refresh-preview');
                return null;

            case 'missing':
                // A stored key that no longer names a map: a deleted custom
                // image, a map pack that failed its checksum re-check. Never
                // the key itself — a custom map's key is a name the user typed.
                appLog.event('map-missing', {
                    key: this.logKey(effect.key),
                    source: effect.source || ''
                });
                if (debug) console.log(`map-controller: no catalogue entry for "${effect.key}"`);
                return null;

            default:
                return null;
        }
    }

    /**
     * An apply that never reached the overlay: put the state back.
     *
     * Only when nothing has moved on since — a rollback that fought a map the
     * player has *already* put up would be worse than the desync it is fixing,
     * and the common `false` (a newer press overtook this one) is exactly that
     * case. `mapChangeSeq` in `MainWindow` decides the overlay's winner; this
     * decides the state's, and the test is the same one: has anything been
     * applied since?
     *
     * @param {Object} before the state as it was before the failed effect
     * @param {Object} effect the `apply` that failed
     */
    rollback(before, effect) {
        if (this.state.currentKey !== (effect.key || '')) return;
        this.state = before;
        if (this.detector && typeof this.detector.noteShown === 'function') {
            this.detector.noteShown(before.currentKey || null);
        }
        appLog.warn('map-change', {rolledBack: this.logKey(effect.key), source: effect.source || ''});
        this.push(null);
    }

    /** A map key as the log is allowed to spell it — see the redaction rule. */
    logKey(key) {
        if (!key) return '';
        return String(key).startsWith(CUSTOM_CREATOR + '/') ? '(custom)' : key;
    }

    /**
     * Push the state to the main window's view.
     *
     * Dropped when there is no window, which is the normal mid-match state:
     * the view asks with `get-map-state` the moment it loads, so it can never
     * be stale for longer than its own construction.
     * @param {?string} source the `source` of the apply this push follows, or
     *   null when nothing landed on the overlay.
     */
    push(source) {
        if (!this.mainWindow) return;
        const payload = this.status();
        if (source) payload.source = source;
        this.mainWindow.send('map-state', payload);
    }
}

module.exports = MapController;
