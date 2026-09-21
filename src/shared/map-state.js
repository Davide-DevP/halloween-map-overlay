'use strict';

/**
 * PURE map state — `reduceMapState(state, intent, context) -> {state, effects}`.
 * Nothing here reads a file, a setting or a window; the impure half is
 * `core/map-controller.js`. See `docs/SPEC-MAP-STATE.md`.
 *
 * **The one rule that must not drift**: the detector sends *every* accepted
 * match, and `shouldApplyDetected(currentKey, key)` decides whether anything
 * changes — against **what the overlay is showing**, never against the
 * detector's own `lastDetected`, which made a manual pick permanent.
 */

const {findClosestMapMatch, nextMap, prevMap} = require('../core/map-catalog');
const {stepOpacity, stepSize, OPACITY_STEP, SIZE_STEP} = require('./hotkeys-constants');
// `msg()` builds `{key, params}` and is pure; using it rather than a bare
// string is what lets `test/i18n.test.js` find these keys in the source.
const {msg} = require('./i18n');
const {shouldApplyDetected} = require('./detector-rules');

const INITIAL_STATE = Object.freeze({
    currentKey: '',
    lastKey: '',
    previewActive: false
});

/** Sources `app.log`'s `map-change` line may carry. Documentation, not a gate. */
const SOURCES = ['click', 'hotkey', 'cli', 'detector', 'settings', 'preview', 'hide'];

/** `SYSTEM_HOTKEY_DEFS` ids → intents; a new action needs an entry here only. */
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

/** The rule and its tests live in `shared/detector-rules.js`. */
function alreadyShowing(currentKey, key) {
    return !shouldApplyDetected(currentKey, key);
}

/**
 * Shared by every intent that changes what is on screen, so the bookkeeping is
 * written once: `lastKey` only ever remembers a *real* map.
 * @param {string} key catalogue key, or `''` to hide
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
    // A map arriving mid-preview must not replace the sample image on screen,
    // and only the renderer holds the canvas that produced it.
    if (next.previewActive) effects.push({type: 'refresh-preview'});
    return {state: next, effects};
}

function noChange(state) {
    return {state, effects: []};
}

/**
 * A stored key (`lastKey`, a per-map hotkey, a CLI argument) resolved; null
 * when the map is gone. Sent blind it falls through main's base64 branch and
 * `imageSize` throws — nothing happens at all, silently.
 */
function resolve(key, catalog) {
    if (!key) return null;
    return findClosestMapMatch(key, catalog || []) || null;
}

/**
 * @param {Object} intent `{type, ...}` — see `docs/SPEC-MAP-STATE.md` §3.2
 * @param {{catalog: Array, settings: Object}} context both read-only here
 */
function reduceMapState(state, intent, context) {
    const current = normalizeState(state);
    const ctx = context || {};
    const catalog = ctx.catalog || [];
    const settings = ctx.settings || {};
    const type = (intent && intent.type) || '';

    switch (type) {

        /* The gallery's key is the catalogue's; a hotkey's may be long gone. */
        case 'select': {
            const entry = resolve(intent.key, catalog);
            if (!entry) {
                // Only a hotkey says so out loud: a press with nothing
                // happening looks like a broken hotkey.
                return {
                    state: current,
                    effects: intent.source === 'hotkey'
                        ? [{type: 'toast', message: msg('hotkeys.error.mapMissing')}]
                        : [{type: 'missing', key: intent.key || '', source: intent.source || ''}]
                };
            }
            return applyKey(current, entry.key, {source: intent.source || 'click'});
        }

        /* The answer goes back too, so `detector.log` records the whole chain. */
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
            // An automatic switch names the map for a moment: nobody asked for
            // it. The name is the catalogue's, never the matcher's key.
            const result = applyKey(current, entry.key, {source: 'detector', mapLabel: entry.name});
            result.effects.push({type: 'detector-applied', key: entry.key, applied: true});
            return result;
        }

        case 'toggle': {
            if (current.currentKey) return applyKey(current, '', {source: 'hotkey'});
            if (!current.lastKey) {
                // A hide of nothing is not worth a `map-change` line.
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
         * Not toggle-map: it also makes the detector forget what it last saw,
         * or the loop sees no change and the overlay stays blank until the map
         * really changes.
         */
        case 'clear': {
            const result = applyKey(current, '', {source: 'hotkey'});
            result.state.lastKey = '';
            result.effects.unshift({type: 'detector-reset'});
            return result;
        }

        /* Back in the main menu. `lastKey` is kept, so toggle-map still works. */
        case 'menu-hide': {
            if (!current.currentKey) return noChange(current);
            return applyKey(current, '', {source: 'detector'});
        }

        case 'hide':
            return applyKey(current, '', {source: intent.source || 'click'});

        /*
         * **No** fallback to `lastKey`: a settings change while the overlay is
         * hidden must not put a map back on screen.
         */
        case 'refresh': {
            if (!current.currentKey) {
                return applyKey(current, '', {source: intent.source || 'settings'});
            }
            return applyKey(current, current.currentKey, {source: intent.source || 'settings'});
        }

        /*
         * The four setting hotkeys. Never resize the overlay from here — only
         * `applyMapChange` knows the rotated box.
         *
         * **Three re-send `currentKey || lastKey`; the fourth must not.**
         * Rotate, opacity and size aim at the picture, so "bigger" with nothing
         * on screen reasonably means "put it back, bigger". `toggle-markers` is
         * a switch on a *layer of* the picture, and must never put a map the
         * player hid back over their game.
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
         * `=== false` on the way in, like every marker setting: a file written
         * before markers existed means "on", so the first press turns them
         * **off**. Two literal toast keys, because `test/i18n.test.js` reads the
         * source and a key built inside a ternary looks unused to it.
         */
        case 'toggle-markers': {
            const next = settings.markers === false;
            return withSetting(current, catalog, 'markers', next,
                next ? msg('toast.markersOn') : msg('toast.markersOff'),
                {restore: false});
        }

        /* The real map is not forgotten, and anything landing meanwhile re-sends. */
        case 'preview-start':
            return {state: Object.assign({}, current, {previewActive: true}), effects: []};

        case 'preview-stop': {
            if (!current.previewActive) return noChange(current);
            const stopped = Object.assign({}, current, {previewActive: false});
            // The normal path, **not** `{preview: true}`: that flag forces
            // main's raw-base64 branch, and a key decoded as base64 is garbage.
            return applyKey(stopped, stopped.currentKey, {source: 'preview'});
        }

        /*
         * A map pack landed, or a custom image was added or deleted. **Nothing
         * to do, and that is the decision rather than an omission**: the map on
         * the overlay stays (it already has the pixels), the controller holds
         * no catalogue to refresh, and a stale *key* is handled where it matters
         * — every path that re-sends a stored key resolves it first. Kept as a
         * named case, with no caller, so nobody rediscovers that answer.
         */
        case 'catalog-changed':
            return noChange(current);

        default:
            return noChange(current);
    }
}

/**
 * @param {string} key a settings key
 * @param {?{key: string, params?: Object}} toast a `msg()` object, or null
 * @param {{restore?: boolean}} [opts] `restore: false` re-sends only what is
 *   on screen and never falls back to `lastKey` — see `toggle-markers`.
 */
function withSetting(state, catalog, key, value, toast, opts) {
    const effects = [{type: 'setting', key, value}];
    const restore = !(opts && opts.restore === false);
    const target = restore ? (state.currentKey || state.lastKey) : state.currentKey;
    const entry = target ? resolve(target, catalog) : null;
    let next = state;
    if (!target && !restore) {
        // The setting lands, the toast goes out, the overlay is left alone.
    } else if (target && !entry) {
        // The map this would have re-sent has left the catalogue. The setting
        // still lands (the slider moves, the next map uses it).
        effects.push({type: 'missing', key: target, source: 'hotkey'});
    } else {
        // `''` when there is nothing to re-send: a hide keeps the `map-change`
        // log honest about the source of the change.
        const applied = applyKey(state, entry ? entry.key : '', {source: 'hotkey'});
        next = applied.state;
        effects.push(...applied.effects);
    }
    if (toast) effects.push({type: 'toast', message: toast});
    return {state: next, effects};
}

/** @returns {?Object} the intent a `SYSTEM_HOTKEY_DEFS` id means, or null */
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
