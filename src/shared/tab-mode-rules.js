'use strict';

/**
 * PURE Tab-map-mode rules: the scheduler and the physical-pixel → DIP maths.
 * Markers over live gameplay are the failure that matters, so every rule leans
 * towards hiding, and **this file owns the show/hide policy**. Why each
 * constant: docs/agents/markers-and-tab-mode.md § Measured constants.
 */

/** Periodic-check cadence while markers are shown, polling path (ms). */
const FAST_INTERVAL = 150;

/** The detector's cadence while this mode runs on the polling path (ms). */
const DETECT_INTERVAL = 450;

/** Consecutive negative gates before the markers come down. When in doubt, hide. */
const HIDE_AFTER_NEGATIVE = 1;

/** How often the map key's state is read while the trigger runs (ms). */
const KEY_POLL_INTERVAL = 30;

/** Periodic-check cadence once the key trigger is healthy (ms). */
const SAFETY_INTERVAL = 500;

/** With no controller found, how often the four XInput slots are scanned (ms). */
const PAD_SCAN_INTERVAL = 1000;

/** XInput's `XUSER_MAX_COUNT`: the slots a controller can be in. */
const PAD_SLOTS = 4;

/** How long *Choose button…* waits for one controller button (ms): room for an Alt+Tab. */
const PAD_RECORD_TIMEOUT = 15000;

/** Confirming-capture retries while the key is held, as delays from the last (ms). */
const CONFIRM_RETRY_DELAYS = [50, 50, 50, 50, 50, 100];

/** Unconfirmed markers' whole budget (ms); the caller's own timer enforces it. */
const PROVISIONAL_DEADLINE_MS = 550;

/** How long a "confirmed on this map" memory is worth acting on (ms). */
const CONFIRMED_MEMORY_MS = 5 * 60 * 1000;

/** The only hides that keep the memory, and only for a **confirmed** show. */
const MEMORY_KEEPING_HIDE_REASONS = ['key-up', 'released'];

/** @returns {?number} ms from now for `attempt`, null when out of retries. */
function confirmRetryDelay(attempt) {
    if (!isFiniteNumber(attempt) || attempt < 1) return CONFIRM_RETRY_DELAYS[0];
    const index = Math.floor(attempt) - 1;
    return index < CONFIRM_RETRY_DELAYS.length ? CONFIRM_RETRY_DELAYS[index] : null;
}

/** The `markerTrigger` setting: let the app choose, or force the polling path. */
const TRIGGER_MODES = ['auto', 'polling'];

/**
 * Which method is in use — three states, because two lied. `available: false`
 * means a probe failed, `undefined` means untried.
 * Why: the doc § The key-state trigger.
 */
function resolveTriggerMethod(state) {
    // A caller bug answers with the path that always works *and* the faster
    // cadence, or the reported cadence is not the one holding the markers up.
    if (!state || typeof state !== 'object') return {method: 'polling', reason: 'unavailable'};
    const {mode, available, running, gameWindow, reason} = state;
    if (mode === 'polling') return {method: 'polling', reason: 'forced'};
    // `=== false`, not `!available`: "not probed yet" is not "broken".
    if (available === false) return {method: 'polling', reason: reason || 'unavailable'};
    if (running) return {method: 'key', reason: 'key'};
    return {method: 'key-waiting', reason: gameWindow ? 'idle' : 'no-game'};
}

/** Normalise a stored `markerTrigger` value. */
function triggerMode(value) {
    return TRIGGER_MODES.includes(value) ? value : 'auto';
}

/** Cadence in ms: the show/hide mechanism in `polling`, else the safety net. */
function checkInterval(method) {
    return method === 'key' || method === 'key-waiting' ? SAFETY_INTERVAL : FAST_INTERVAL;
}

/** Only polling needs a faster detector. @returns {?number} ms, or null. */
function detectIntervalFor(state) {
    const {running, method} = state || {};
    if (!running) return null;
    return method === 'polling' ? DETECT_INTERVAL : null;
}

/**
 * One reading of the map key → a hint, or nothing. The three refusals (not in
 * front, Alt held, trigger inactive) **all resolve to "the key is not down"**,
 * never to "ignore": the safe direction is to hide. Foreground first, as in
 * `core/key-trigger.js`. `down` in the result is what to remember.
 */
function keyHintFor(reading) {
    const r = reading || {};
    const wasDown = !!r.wasDown;
    let down = !!r.down;
    let reason = down ? 'down' : 'up';
    if (r.enabled === false) { down = false; reason = 'disabled'; }
    else if (!r.foreground) { down = false; reason = 'not-foreground'; }
    else if (down && r.alt) { down = false; reason = 'alt'; }
    if (down === wasDown) return {hint: null, down, reason: 'unchanged'};
    return {hint: down ? 'down' : 'up', down, reason};
}

/**
 * The map key's two inputs folded into the one reading `keyHintFor` takes.
 * Either held is "down"; **Alt only vetoes the keyboard** — Alt+Tab is a
 * keyboard gesture, and a controller button held while Alt happens to be down
 * is still the player opening the map. `null` from a read means "not down".
 * @param {{key?: ?boolean, pad?: ?boolean, alt?: ?boolean}} inputs
 * @returns {{down: boolean, alt: boolean, source: 'key'|'pad'|null}}
 */
function foldMapInputs(inputs) {
    const i = inputs || {};
    const key = i.key === true;
    const pad = i.pad === true;
    const alt = i.alt === true;
    if (key && !alt) return {down: true, alt: false, source: 'key'};
    if (pad) return {down: true, alt: false, source: 'pad'};
    // Only the vetoed keyboard press is left: `keyHintFor` turns it into "up".
    if (key) return {down: true, alt: true, source: 'key'};
    return {down: false, alt: false, source: null};
}

/** No timers, no handles. `confirmedKey` is the only map showable unseen. */
function initialTabModeState() {
    return {showing: false, key: null, negatives: 0, provisional: false, confirmedKey: null};
}

function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Drop the memory, screen and both loops untouched. **Not** a reducer event:
 * `reduceTabMode` would re-arm a timer as a side effect.
 */
function forgetConfirmedMap(state) {
    const current = state || initialTabModeState();
    if (!current.confirmedKey) return current;
    return Object.assign({}, current, {confirmedKey: null});
}

/**
 * Is the memory still worth acting on? A clock that went **backwards** answers
 * *no*, not "infinitely fresh": a refusal costs one slow press, a wrong yes a
 * faded wrong map. `confirmedAt`/`now` in ms, 0 = never; `maxAgeMs` defaults.
 */
function confirmedMemoryFresh(confirmedAt, now, maxAgeMs) {
    if (!isFiniteNumber(confirmedAt) || confirmedAt <= 0) return false;
    if (!isFiniteNumber(now)) return false;
    const limit = isFiniteNumber(maxAgeMs) && maxAgeMs > 0 ? maxAgeMs : CONFIRMED_MEMORY_MS;
    const age = now - confirmedAt;
    return age >= 0 && age <= limit;
}

/**
 * May the markers go up **now**, on the key-down edge, before anything has
 * looked at the screen? The load-bearing refusal is **`mapKey` not being the
 * *confirmed* map**, which keeps a match's first press as certain as ever.
 * `foreground` is passed rather than assumed: a rule only true by someone
 * else's construction stops being true when that changes. `context.bounds`
 * means "known *and* unclamped".
 */
function shouldShowProvisionally(state, context) {
    const s = state || initialTabModeState();
    const c = context || {};
    const no = (reason) => ({show: false, key: null, reason});
    // `=== false`, not `!c.instant`: a caller that has not read the setting yet
    // must not silently get the *off* behaviour.
    if (c.instant === false) return no('off');
    if (c.method !== 'key') return no('method');
    if (!c.foreground) return no('not-foreground');
    if (s.showing) return no('showing');
    const key = c.mapKey || null;
    if (!key) return no('no-map');
    if (s.confirmedKey !== key) return no('first-press');
    if (!c.drawable) return no('not-drawable');
    if (!c.bounds) return no('no-bounds');
    return {show: true, key, reason: 'ok'};
}

/**
 * One step of the scheduler, as a pure reducer. A `down` hint **never shows
 * anything on its own** — a press is not evidence that the Tab screen is up,
 * and the optimistic show is no exception: it needs a press on this very map
 * already confirmed by the gate. An `up` hint hides at once.
 * @param {{type: 'match'|'gate'|'lost'|'hint'|'stop', …}} event
 * @param {{fastMs?, hideAfterNegative?}} [opts] `fastMs` in ms
 * @returns {{state, effects}} `effects.nextCheckMs` is ms, null = stop
 */
function reduceTabMode(state, event, opts) {
    const o = opts || {};
    const fastMs = isFiniteNumber(o.fastMs) ? o.fastMs : FAST_INTERVAL;
    const hideAfter = isFiniteNumber(o.hideAfterNegative) && o.hideAfterNegative >= 1
        ? Math.floor(o.hideAfterNegative) : HIDE_AFTER_NEGATIVE;
    const current = state || initialTabModeState();
    const type = event && event.type;

    const keep = (next, effects) => ({
        state: Object.assign({}, current, next),
        effects: Object.assign({
            show: false, hide: false, checkNow: false, nextCheckMs: null, key: null, reason: '',
            // A show going up unseen: the caller fades it and arms the deadline.
            provisional: false,
            // A guess turned certain: nothing visible changes, it is only the
            // moment worth logging.
            confirmed: false
        }, effects)
    });
    const down = (reason) => keep(
        {
            showing: false, key: null, negatives: 0, provisional: false,
            // See `MEMORY_KEEPING_HIDE_REASONS`.
            confirmedKey: (!current.provisional && MEMORY_KEEPING_HIDE_REASONS.includes(reason))
                ? current.confirmedKey : null
        },
        {hide: current.showing, nextCheckMs: null, reason}
    );

    switch (type) {
        case 'match': {
            if (!event.drawable) {
                // Leaving them up would put one map's cellars on another map.
                return down('not-drawable');
            }
            const changed = current.key !== event.key;
            return keep(
                {
                    showing: true, key: event.key, negatives: 0, provisional: false,
                    // A confirmed press earns this map the fast path next time.
                    confirmedKey: event.key
                },
                {
                    // Up already and the same map: **nothing is re-sent**, or
                    // a fade in progress restarts — a flicker at the exact
                    // moment the app became sure.
                    show: !current.showing || changed,
                    confirmed: current.provisional,
                    nextCheckMs: fastMs,
                    key: event.key,
                    reason: current.provisional ? 'confirmed' : (changed ? 'match' : 'same')
                }
            );
        }
        case 'gate': {
            if (!current.showing) {
                // A gate pass alone must never show markers: it says "a Tab
                // screen", not "this map". Finding the map is the detector's job.
                return keep({negatives: 0}, {nextCheckMs: null, reason: 'idle'});
            }
            if (event.up) return keep({negatives: 0}, {nextCheckMs: fastMs, key: current.key, reason: 'still-up'});
            if (current.provisional) {
                // A negative gate is *expected* while the game fades its map in,
                // so it hides nothing: the caller's deadline bounds this state,
                // and `fading` is the one reason it must not `invalidate()` on.
                return keep({negatives: 0}, {nextCheckMs: fastMs, key: current.key, reason: 'fading'});
            }
            const negatives = current.negatives + 1;
            if (negatives < hideAfter) {
                return keep({negatives}, {nextCheckMs: fastMs, key: current.key, reason: 'negative'});
            }
            return down('released');
        }
        case 'hint': {
            if (event.key === 'up') return down('key-up');
            if (event.key !== 'down') return keep({}, {nextCheckMs: current.showing ? fastMs : null, reason: 'hint'});
            if (event.provisional === true && !current.showing && event.mapKey) {
                // The confirming capture is still requested: this does not
                // replace the screen gate, it replaces *waiting* for it.
                return keep(
                    {showing: true, key: event.mapKey, negatives: 0, provisional: true},
                    {
                        show: true, provisional: true, checkNow: true, nextCheckMs: fastMs,
                        key: event.mapKey, reason: 'provisional'
                    }
                );
            }
            // Ask for a check *now*; the gate still decides.
            return keep({}, {
                checkNow: !current.showing,
                nextCheckMs: current.showing ? fastMs : null,
                key: current.key,
                reason: 'key-down'
            });
        }
        case 'lost':
            return down((event && event.reason) || 'lost');
        case 'stop':
            return down('stopped');
        default:
            return keep({}, {nextCheckMs: current.showing ? fastMs : null, reason: 'ignored'});
    }
}

/* ── Physical pixels → DIPs ───────────────────────────────────────────────── */

/** @returns {number} the area two rectangles share, 0 when they do not. */
function overlapArea(a, b) {
    const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
}

function isRect(rect) {
    return !!rect && isFiniteNumber(rect.x) && isFiniteNumber(rect.y)
        && isFiniteNumber(rect.width) && isFiniteNumber(rect.height)
        && rect.width > 0 && rect.height > 0;
}

/** Which display a physical `rect` is on: centre, then overlap, then primary. */
function displayForRect(rect, displays) {
    const list = (displays || []).filter(d => d && isRect(d.physical) && isRect(d.bounds));
    if (!list.length) return null;
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    for (const display of list) {
        const p = display.physical;
        if (cx >= p.x && cx < p.x + p.width && cy >= p.y && cy < p.y + p.height) return display;
    }
    let best = null;
    let bestArea = 0;
    for (const display of list) {
        const area = overlapArea(rect, display.physical);
        if (area > bestArea) { bestArea = area; best = display; }
    }
    if (best) return best;
    return list.find(d => d.primary) || list[0];
}

/**
 * A game-window rect in **physical** pixels → Electron bounds in **DIPs**. Both
 * edges are rounded, never the origin and the size, or a 125 % display leaves a
 * one-pixel strip of game uncovered (docs/agents/overlay-windows.md). Each
 * display carries DIP `bounds` *and* `physical`, so this is an offset + scale.
 */
function gameRectToDip(rect, displays) {
    if (!isRect(rect)) return null;
    const display = displayForRect(rect, displays);
    if (!display) return null;
    const scale = isFiniteNumber(display.scaleFactor) && display.scaleFactor > 0 ? display.scaleFactor : 1;
    const toDipX = (px) => display.bounds.x + (px - display.physical.x) / scale;
    const toDipY = (py) => display.bounds.y + (py - display.physical.y) / scale;
    const left = Math.round(toDipX(rect.x));
    const top = Math.round(toDipY(rect.y));
    const right = Math.round(toDipX(rect.x + rect.width));
    const bottom = Math.round(toDipY(rect.y + rect.height));
    // Defence in depth: the rect comes from another library, and one reaching
    // outside the desktop must not become a window spanning the whole of it.
    const b = display.bounds;
    const clampX = (v) => Math.min(Math.max(v, b.x), b.x + b.width);
    const clampY = (v) => Math.min(Math.max(v, b.y), b.y + b.height);
    const cl = clampX(left), cr = clampX(right);
    const ct = clampY(top), cb = clampY(bottom);
    return {
        x: cl,
        y: ct,
        width: Math.max(1, cr - cl),
        height: Math.max(1, cb - ct),
        scaleFactor: scale,
        // The clamp fired, so the caller declines to draw at all.
        clamped: cl !== left || ct !== top || cr !== right || cb !== bottom
    };
}

/** Moved or resized? Any change hides: the panel is a fraction of the window. */
function rectChanged(a, b) {
    if (!a || !b) return true;
    return a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height;
}

module.exports = {
    FAST_INTERVAL,
    DETECT_INTERVAL,
    HIDE_AFTER_NEGATIVE,
    KEY_POLL_INTERVAL,
    SAFETY_INTERVAL,
    PAD_SCAN_INTERVAL,
    PAD_SLOTS,
    PAD_RECORD_TIMEOUT,
    CONFIRM_RETRY_DELAYS,
    confirmRetryDelay,
    PROVISIONAL_DEADLINE_MS,
    CONFIRMED_MEMORY_MS,
    MEMORY_KEEPING_HIDE_REASONS,
    shouldShowProvisionally,
    forgetConfirmedMap,
    confirmedMemoryFresh,
    TRIGGER_MODES,
    resolveTriggerMethod,
    triggerMode,
    checkInterval,
    detectIntervalFor,
    keyHintFor,
    foldMapInputs,
    initialTabModeState,
    reduceTabMode,
    displayForRect,
    gameRectToDip,
    rectChanged
};
