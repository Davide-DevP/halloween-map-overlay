'use strict';

/**
 * PURE map state: what the overlay is showing, what `toggle-map` would bring
 * back, and every decision that used to live in the main window's renderer.
 *
 * Same shape as `shared/tab-mode-rules.js` / `core/tab-mode.js` and
 * `shared/hotkeys-rules.js` / `core/hotkeys.js`:
 *
 *     reduceMapState(state, intent, context) -> {state, effects}
 *
 * The impure half is `core/map-controller.js`, which turns each effect into a
 * call. Nothing here reads a file, a setting or a window; the catalogue and the
 * settings arrive as plain data in `context`.
 *
 * ## Why this is in main at all
 *
 * Up to 0.7 `src/js/maps.js` owned `currentKey`/`lastKey`, every hotkey
 * handler, `show-map-command` (the detector's only route to the overlay) and
 * the `map-detector-shown` report the menu clear is gated on. That made the
 * main window's renderer load-bearing for the whole in-match feature set, which
 * is exactly why `docs/MEMORY-REPORT-2.md` §3.3 rejected tearing it down in the
 * tray. Moving the decisions here is what makes that ~32 MB reclaimable — and,
 * on its own, makes a renderer crash cost *nothing*: the state is not in the
 * process that died. See `docs/SPEC-MAP-STATE.md`.
 *
 * ## The one rule that must not drift
 *
 * The detector sends **every** accepted match (throttled per key in
 * `core/map-detector.js`) and something else decides whether anything actually
 * changes. That decision is `shouldApplyDetected(currentKey, key)` and it has
 * to be made against *what the overlay is showing*, never against the
 * detector's own `lastDetected` — comparing against `lastDetected` is what made
 * a manual pick permanent in 0.3.0 (the same map detected again looked
 * unchanged and was never re-applied). Read the long comment above
 * `MapDetector` before touching `detected` below.
 */

const {findClosestMapMatch, nextMap, prevMap} = require('../core/map-catalog');
const {stepOpacity, stepSize, OPACITY_STEP, SIZE_STEP} = require('./hotkeys-constants');
// `msg()` is pure — it only builds `{key, params}` — and using it here rather
// than a bare string is what lets `test/i18n.test.js` see these keys: it finds
// keys by reading the source, and "nothing names this key" is exactly the check
// that keeps the catalogues honest.
const {msg} = require('./i18n');
const {shouldApplyDetected} = require('./detector-rules');

/** The state a freshly started process holds: nothing on the overlay. */
const INITIAL_STATE = Object.freeze({
    currentKey: '',
    lastKey: '',
    previewActive: false
});

/** Sources `app.log`'s `map-change` line may carry. Documentation, not a gate. */
const SOURCES = ['click', 'hotkey', 'cli', 'detector', 'settings', 'preview', 'hide'];

/**
 * The system hotkey actions this reducer answers, as `SYSTEM_HOTKEY_DEFS` ids.
 * `core/hotkeys.js` hands the id straight through, so a new action needs an
 * entry here and nothing else.
 */
const ACTION_INTENTS = {
    'toggle-map': {type: 'toggle'},
    'next-map': {type: 'next'},
    'prev-map': {type: 'prev'},
    'clear-map': {type: 'clear'},
    'rotate-map': {type: 'rotate'},
    'opacity-up': {type: 'opacity', delta: OPACITY_STEP},
    'opacity-down': {type: 'opacity', delta: -OPACITY_STEP},
    'size-up': {type: 'size', delta: SIZE_STEP},
    'size-down': {type: 'size', delta: -SIZE_STEP},
    'toggle-markers': {type: 'toggle-markers'}
};

function normalizeState(state) {
    const source = state || INITIAL_STATE;
    return {
        currentKey: typeof source.currentKey === 'string' ? source.currentKey : '',
        lastKey: typeof source.lastKey === 'string' ? source.lastKey : '',
        previewActive: source.previewActive === true
    };
}

/**
 * "Is this detected map already on the overlay?" — the one rule, still in
 * `shared/detector-rules.js` where it has always lived and where its tests
 * are. Only the *caller* moved: the main window's renderer used to import it,
 * and now the reducer does.
 */
function alreadyShowing(currentKey, key) {
    return !shouldApplyDetected(currentKey, key);
}

/**
 * Put a key on the overlay (or `''` to hide it) and produce the effects that go
 * with it.
 *
 * Shared by every intent that changes what is on screen, so the bookkeeping —
 * `lastKey` only ever remembers a *real* map, the preview has to be re-sent
 * over the top of whatever just arrived — is written once.
 *
 * @param {Object} state normalised
 * @param {string} key catalogue key, or `''` to hide
 * @param {{source: string, mapLabel?: string}} opts
 * @returns {{state: Object, effects: Array}}
 */
function applyKey(state, key, opts) {
    const value = key || '';
    const next = {
        currentKey: value,
        lastKey: value ? value : state.lastKey,
        previewActive: state.previewActive
    };
    const effect = {type: 'apply', key: value, source: opts.source || 'click'};
    if (opts.mapLabel) effect.mapLabel = opts.mapLabel;
    const effects = [effect];
    // A map arriving mid-preview must not replace the sample image on screen.
    // The renderer holds the canvas that produced it, so it is asked to send it
    // again — exactly what `Maps.sendMap` used to do inline.
    if (next.previewActive) effects.push({type: 'refresh-preview'});
    return {state: next, effects};
}

function noChange(state) {
    return {state, effects: []};
}

/**
 * Resolve a key that was stored rather than clicked (`lastKey`, a per-map
 * hotkey, a CLI argument) against the catalogue.
 *
 * Returns null when the map is gone — an uninstalled map pack, a deleted custom
 * image. Up to 0.7 those were sent blind: main could not resolve the key, fell
 * through to the base64 branch, `imageSize` threw on the decoded garbage and
 * **nothing happened at all**. Saying so is the same answer a per-map hotkey
 * for a missing map already gives.
 */
function resolve(key, catalog) {
    if (!key) return null;
    return findClosestMapMatch(key, catalog || []) || null;
}

/**
 * @param {Object} state `{currentKey, lastKey, previewActive}`
 * @param {Object} intent `{type, ...}` — see `docs/SPEC-MAP-STATE.md` §3.2
 * @param {{catalog: Array, settings: Object}} context the catalogue and the
 *   settings object, both read-only here.
 * @returns {{state: Object, effects: Array}}
 */
function reduceMapState(state, intent, context) {
    const current = normalizeState(state);
    const ctx = context || {};
    const catalog = ctx.catalog || [];
    const settings = ctx.settings || {};
    const type = (intent && intent.type) || '';

    switch (type) {

        /*
         * A map the user (or the CLI) named. The gallery sends a key it took
         * straight out of the catalogue; a per-map hotkey and `show-map=` send
         * whatever is stored, which may no longer exist.
         */
        case 'select': {
            const entry = resolve(intent.key, catalog);
            if (!entry) {
                // Only a hotkey says so out loud: pressing a key and having
                // nothing happen is indistinguishable from a broken hotkey.
                // A CLI argument that names nothing is answered in the log.
                return {
                    state: current,
                    effects: intent.source === 'hotkey'
                        ? [{type: 'toast', message: msg('hotkeys.error.mapMissing')}]
                        : [{type: 'missing', key: intent.key || '', source: intent.source || ''}]
                };
            }
            return applyKey(current, entry.key, {source: intent.source || 'click'});
        }

        /*
         * The detector accepted a match. Every accepted match arrives (the
         * throttle in the loop is about IPC volume, not correctness), so this
         * is where "does anything change?" is answered — and the answer goes
         * back so `detector.log` records the whole chain: match -> send ->
         * applied/ignored.
         */
        case 'detected': {
            const entry = resolve(intent.key, catalog);
            if (!entry) {
                return {
                    state: current,
                    effects: [{type: 'detector-applied', key: intent.key || '', applied: false, reason: 'no-match'}]
                };
            }
            if (alreadyShowing(current.currentKey, entry.key)) {
                // Already on screen: no re-send, and above all no label flash.
                return {
                    state: current,
                    effects: [{type: 'detector-applied', key: entry.key, applied: false, reason: 'same-as-current'}]
                };
            }
            // An automatic switch names the map on the overlay for a moment —
            // the player never asked for it, so it has to say what it did. The
            // name comes from the catalogue entry, never from the key the
            // matcher produced: the catalogue is the single source for a name.
            const result = applyKey(current, entry.key, {source: 'detector', mapLabel: entry.name});
            result.effects.push({type: 'detector-applied', key: entry.key, applied: true});
            return result;
        }

        /* Ctrl+Alt+H. Hidden -> put `lastKey` back; showing -> hide. */
        case 'toggle': {
            if (current.currentKey) return applyKey(current, '', {source: 'hotkey'});
            if (!current.lastKey) {
                // Nothing has ever been shown. The old renderer sent `""` here,
                // i.e. re-hid an already hidden overlay; a hide of nothing is
                // not worth a `map-change` line.
                return noChange(current);
            }
            const entry = resolve(current.lastKey, catalog);
            if (!entry) {
                return {
                    state: Object.assign({}, current, {lastKey: ''}),
                    effects: [{type: 'toast', message: msg('hotkeys.error.mapMissing')}]
                };
            }
            return applyKey(current, entry.key, {source: 'hotkey'});
        }

        case 'next':
        case 'prev': {
            const pick = type === 'next' ? nextMap : prevMap;
            const entry = pick(current.currentKey || current.lastKey, catalog);
            if (!entry) return noChange(current);
            return applyKey(current, entry.key, {source: 'hotkey'});
        }

        /*
         * Ctrl+Alt+D is not toggle-map: it also tells the detector to forget
         * what it last saw, so the next Tab press re-detects even the same map.
         * Without that the loop would see no change and the overlay would stay
         * blank until the map actually changed. `lastKey` is dropped too — the
         * user asked for a clean slate.
         */
        case 'clear': {
            const result = applyKey(current, '', {source: 'hotkey'});
            result.state.lastKey = '';
            result.effects.unshift({type: 'detector-reset'});
            return result;
        }

        /*
         * The detector saw the game's main menu again: the match this map
         * belonged to is over. `lastKey` is deliberately kept, so toggle-map
         * still brings the same map back if the player wants it.
         */
        case 'menu-hide': {
            if (!current.currentKey) return noChange(current);
            return applyKey(current, '', {source: 'detector'});
        }

        /* The home page's "Hide" button. */
        case 'hide':
            return applyKey(current, '', {source: intent.source || 'click'});

        /*
         * Re-send whatever is on the overlay so main recomputes the rotated
         * bounding box, the marker payload and the window position. Deliberately
         * does **not** fall back to `lastKey`: a settings change while the
         * overlay is hidden must not put a map back on screen.
         */
        case 'refresh': {
            if (!current.currentKey) {
                return applyKey(current, '', {source: intent.source || 'settings'});
            }
            return applyKey(current, current.currentKey, {source: intent.source || 'settings'});
        }

        /*
         * The four hotkeys that change a setting all do the same four things:
         * write it, re-send the map so **main** recomputes the window bounds,
         * toast the new value, and (through the `map-state` push) let an open
         * Settings modal move its slider. Do not resize the overlay from here —
         * only `MainWindow.applyMapChange` knows the rotated bounding box.
         *
         * **Three of them re-send `currentKey || lastKey`, and the fourth must
         * not.** Falling back to `lastKey` is 0.6.0 behaviour for rotate,
         * opacity and size (`src/js/maps.js` `sendMap(currentKey || lastKey)`),
         * and it is defensible there: those three are aimed at the picture, so
         * "make it bigger" with nothing on screen reasonably means "put it back
         * and make it bigger". `toggle-markers` is not — it is a switch on a
         * *layer of* the picture, and turning markers on must never be the
         * thing that puts a map the player deliberately hid (or that the menu
         * clear took away) back over their game. It re-sends only what is
         * already showing; the setting still lands, so the markers are simply
         * right the next time a map goes up.
         */
        case 'rotate': {
            const value = parseInt(settings.rotation, 10) || 0;
            const next = (value + 90) % 360;
            return withSetting(current, catalog, 'rotation', next, null);
        }

        case 'opacity': {
            const delta = Number(intent.delta) || 0;
            const next = stepOpacity(settings.opacity, delta);
            return withSetting(current, catalog, 'opacity', next,
                msg('toast.opacity', {percent: Math.round(next * 100)}));
        }

        case 'size': {
            const delta = Number(intent.delta) || 0;
            const next = stepSize(settings.size, delta);
            return withSetting(current, catalog, 'size', next,
                msg('toast.size', {size: next}));
        }

        /*
         * The one master switch for every marker layer. `!== false` on the way
         * in, like every other marker setting: a settings file written before
         * markers existed means "on", so the first press turns them **off**
         * rather than appearing to do nothing.
         *
         * Two toast keys rather than one computed key: `test/i18n.test.js`
         * finds keys by reading the source, and a key that only exists inside a
         * ternary looks unused to it.
         */
        case 'toggle-markers': {
            const next = settings.markers === false;
            return withSetting(current, catalog, 'markers', next,
                next ? msg('toast.markersOn') : msg('toast.markersOff'),
                {restore: false});
        }

        /*
         * Settings › Overlay is previewing the sample map. The real map is not
         * forgotten — `stopPreview` puts it straight back — and anything that
         * lands on the overlay meanwhile re-sends the preview over the top.
         */
        case 'preview-start':
            return {state: Object.assign({}, current, {previewActive: true}), effects: []};

        case 'preview-stop': {
            if (!current.previewActive) return noChange(current);
            const stopped = Object.assign({}, current, {previewActive: false});
            // Through the normal path, NOT `{preview: true}`: that flag forces
            // main down the raw-base64 branch, and a catalogue key decoded as
            // base64 is not an image.
            return applyKey(stopped, stopped.currentKey, {source: 'preview'});
        }

        /*
         * A map pack landed, or a custom image was added or deleted.
         *
         * Nothing to do, and that is the decision rather than an omission: the
         * map on the overlay is left exactly where it is (a pack that replaces
         * a bundled map keeps its key, and a custom image the user just deleted
         * is still on screen because the overlay already has the pixels), and
         * the controller holds no catalogue of its own to refresh — it asks
         * `MapLibrary` on every dispatch. The *stale key* is handled where it
         * matters: every path that re-sends a stored key (`toggle`, the four
         * setting hotkeys) resolves it against the catalogue first and says so
         * when it is gone. Kept as a named case, with no caller, so the next
         * reader does not have to rediscover that answer.
         */
        case 'catalog-changed':
            return noChange(current);

        default:
            return noChange(current);
    }
}

/**
 * The shared tail of `rotate` / `opacity` / `size` / `toggle-markers`: write the
 * setting, re-send `currentKey || lastKey`, and toast.
 *
 * @param {Object} state normalised
 * @param {Array} catalog
 * @param {string} key settings key
 * @param {*} value
 * @param {?{key: string, params?: Object}} toast a `msg()` object, or null
 * @param {{restore?: boolean}} [opts] `restore: false` re-sends only what is
 *   already on screen and never falls back to `lastKey` — see the comment on
 *   `toggle-markers`.
 */
function withSetting(state, catalog, key, value, toast, opts) {
    const effects = [{type: 'setting', key, value}];
    const restore = !(opts && opts.restore === false);
    const target = restore ? (state.currentKey || state.lastKey) : state.currentKey;
    const entry = target ? resolve(target, catalog) : null;
    let next = state;
    if (!target && !restore) {
        // Nothing on the overlay and this one may not put anything there. The
        // setting still lands and the toast still goes out; the overlay is left
        // exactly as the player left it.
    } else if (target && !entry) {
        // The map this would have re-sent has left the catalogue. The setting
        // still lands (the slider has to move and the next map has to use it);
        // the re-send — which used to fail silently inside `map-change`, where
        // `imageSize` threw on a catalogue key decoded as base64 — is simply
        // not made. One toast per press, and it is the one about the setting.
        effects.push({type: 'missing', key: target, source: 'hotkey'});
    } else {
        // `''` when there is nothing to re-send at all: the hide is what 0.6
        // sent too (`sendMap(currentKey || lastKey)` with both empty), and it
        // keeps the `map-change` log honest about the source of the change.
        const applied = applyKey(state, entry ? entry.key : '', {source: 'hotkey'});
        next = applied.state;
        effects.push(...applied.effects);
    }
    if (toast) effects.push({type: 'toast', message: toast});
    return {state: next, effects};
}

/**
 * A `SYSTEM_HOTKEY_DEFS` action id -> the intent it means.
 * @param {string} actionId
 * @returns {?Object}
 */
function intentForAction(actionId) {
    const base = ACTION_INTENTS[actionId];
    if (!base) return null;
    return Object.assign({}, base);
}

module.exports = {
    INITIAL_STATE,
    SOURCES,
    ACTION_INTENTS,
    reduceMapState,
    intentForAction,
    alreadyShowing,
    normalizeState
};
