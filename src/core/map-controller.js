const {ipcMain} = require('electron');
const {reduceMapState, intentForAction, INITIAL_STATE} = require('../shared/map-state');
const {CUSTOM_CREATOR} = require('./map-catalog');
const appLog = require('./app-log');
const {errorMessage} = require('../shared/errors');

const debug = process.env.DEBUG === 'true';

/**
 * Which map is on the overlay: the impure half of `shared/map-state.js`
 * (`docs/SPEC-MAP-STATE.md`). **It decides nothing itself** — a behaviour
 * question belongs in the reducer, where a test can reach it — and **every
 * entry point works with no window at all**.
 */
class MapController {

    constructor(mainWindow, settings, mapLibrary) {
        this.mainWindow = mainWindow;
        this.settings = settings;
        this.mapLibrary = mapLibrary;
        this.detector = null;
        this.state = Object.assign({}, INITIAL_STATE);

        // A freshly created renderer renders from this, never an assumption.
        ipcMain.handle('get-map-state', async () => this.status());
        // `send`, not `handle`: the answer is the `map-state` push, which every
        // window that cares already listens for.
        ipcMain.on('map-intent', (event, intent) => this.dispatch(intent));
    }

    /** Injected: `MapDetector` is built after this class and needs it both ways. */
    setDetector(detector) {
        this.detector = detector || null;
    }

    status() {
        return {
            currentKey: this.state.currentKey,
            lastKey: this.state.lastKey,
            previewActive: this.state.previewActive
        };
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

    /** A gallery click, a per-map hotkey, or `show-map=<key>` from the CLI. */
    select(key, source) {
        this.dispatch({type: 'select', key, source: source || 'click'});
    }

    /**
     * Every accepted match arrives (the loop's throttle is about IPC volume,
     * not correctness) and the reducer decides against **what the overlay is
     * showing** — see `shared/map-state.js`.
     */
    detected(key) {
        this.dispatch({type: 'detected', key});
    }

    /** The detector saw the game's main menu again: the match is over. */
    menuHide() {
        this.dispatch({type: 'menu-hide'});
    }

    /** @param {string} actionId a `SYSTEM_HOTKEY_DEFS` id, from `core/hotkeys.js` */
    action(actionId) {
        const intent = intentForAction(actionId);
        if (!intent) return false;
        this.dispatch(intent);
        return true;
    }

    /*
     * There is deliberately **no** `catalogChanged()` here — see the
     * `catalog-changed` case in `shared/map-state.js` for why.
     */

    /**
     * Wrapped end to end: this runs from a global-shortcut callback, the
     * detector tick and IPC, where a throw ends the session with a crash file.
     * Losing one map change is survivable.
     */
    dispatch(intent) {
        if (!intent || typeof intent.type !== 'string') return;
        let result;
        try {
            result = reduceMapState(this.state, intent, {
                catalog: this.catalog(),
                settings: this.settings.all()
            });
        } catch (err) {
            console.error(`MapController: "${intent.type}" failed:`, err && err.message);
            appLog.error('map-intent', {intent: intent.type, message: errorMessage(err)});
            return;
        }
        // Captured **before** the commit below: reading `this.state` inside
        // `runEffect` would hand a rollback the state it exists to undo.
        const previous = this.state;
        this.state = result.state;
        let applied = null;
        for (const effect of result.effects) {
            try {
                const source = this.runEffect(effect, previous);
                if (source) applied = source;
            } catch (err) {
                console.error(`MapController: effect "${effect.type}" failed:`, err && err.message);
                appLog.error('map-effect', {effect: effect.type, message: errorMessage(err)});
            }
        }
        this.push(applied);
    }

    /**
     * @param {Object} previous the state before this dispatch, for a rollback
     * @returns {?string} the `source` of an `apply`, which `dispatch` puts on
     *   the push: the view leaves "set position" mode only when a map landed.
     */
    runEffect(effect, previous) {
        switch (effect.type) {

            case 'apply': {
                const opts = {source: effect.source};
                if (effect.mapLabel) opts.mapLabel = effect.mapLabel;
                // On every apply, hides included: the menu clear has to know a
                // map is up *whoever put it there*, or a map picked by hand is
                // never cleared. `noteShown` collapses repeats.
                if (this.detector && typeof this.detector.noteShown === 'function') {
                    this.detector.noteShown(effect.key || null);
                }
                // The rejection is caught here: a map file that vanished
                // between the catalogue check and the read is not worth the
                // app. A `false` answer rolls the state back, because a
                // `currentKey` naming a map the player cannot see desyncs the
                // gallery, toggle-map and the menu clear from the screen.
                const before = previous || this.state;
                if (this.mainWindow) {
                    Promise.resolve(this.mainWindow.applyMapChange(effect.key, opts))
                        .then(ok => {
                            // `undefined` counts as success, so a test double
                            // cannot silently undo every map change.
                            if (ok === false) this.rollback(before, effect);
                        })
                        .catch(err => {
                            console.error('MapController: the map change failed:', err && err.message);
                            appLog.error('map-change', {message: errorMessage(err)});
                            this.rollback(before, effect);
                        });
                }
                return effect.source || 'click';
            }

            case 'setting':
                this.settings.set(effect.key, effect.value);
                return null;

            case 'toast':
                // `{key, params}`, never English: the language can change while
                // a toast is on screen. No `keep` — every toast here describes
                // what the player just did, so with no window it is dropped.
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
                // Only the renderer holds the canvas the sample image came from.
                if (this.mainWindow) this.mainWindow.send('refresh-preview');
                return null;

            case 'missing':
                // Never the key itself: a custom map's key is user text.
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
     * An apply that never reached the overlay: put the state back — but **only
     * when nothing has moved on since**, because a rollback fighting a map the
     * player has already put up is worse than the desync it fixes, and the
     * common `false` (a newer press overtook this one) is exactly that case.
     *
     * @param {Object} before the state as it was before the failed effect
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

    /** Dropped with no window: the view pulls `get-map-state` when it loads. */
    push(source) {
        if (!this.mainWindow) return;
        const payload = this.status();
        if (source) payload.source = source;
        this.mainWindow.send('map-state', payload);
    }
}

module.exports = MapController;
