const {test} = require('node:test');
const assert = require('node:assert');

const T = require('../src/shared/tab-mode-rules');
const {GAME_INTERVAL, IDLE_INTERVAL, tickInterval} = require('../src/shared/detector-rules');

/** Run a list of events through the reducer, returning every effect. */
function run(events, opts) {
    let state = T.initialTabModeState();
    const effects = [];
    for (const event of events) {
        const step = T.reduceTabMode(state, event, opts);
        state = step.state;
        effects.push(step.effects);
    }
    return {state, effects, last: effects[effects.length - 1]};
}

const MATCH = {type: 'match', key: 'deftyconchgaming/Haddonfield Heights', drawable: true};

/* ────────────────────────────────────────────────────────────────────────────
 * The cadences and the debounce
 * ──────────────────────────────────────────────────────────────────────────── */

test('the cadences are the measured ones, and the fast one fits its own tick', () => {
    assert.strictEqual(T.FAST_INTERVAL, 150);
    assert.strictEqual(T.DETECT_INTERVAL, 450);
    // The fast tick's measured wall time is ~21 ms, so the interval has to be
    // several times that or a slow capture starts queueing.
    assert.ok(T.FAST_INTERVAL > 21 * 4);
    // Faster than the normal cadence, and not faster than the fast one — the
    // detector's tick does real matching (~22 ms of blocking JS on a Tab
    // frame) and is not a substitute for the cheap check.
    assert.ok(T.DETECT_INTERVAL < GAME_INTERVAL);
    assert.ok(T.DETECT_INTERVAL > T.FAST_INTERVAL);
});

test('the detector cadence is only shortened while the mode is running', () => {
    // No override: exactly what every version before this shipped.
    assert.strictEqual(tickInterval(true), GAME_INTERVAL);
    assert.strictEqual(tickInterval(true, {}), GAME_INTERVAL);
    assert.strictEqual(tickInterval(true, {gameMs: null}), GAME_INTERVAL);
    assert.strictEqual(tickInterval(true, {gameMs: T.DETECT_INTERVAL}), T.DETECT_INTERVAL);
    // The idle cadence is untouched: that path captures nothing, so there is
    // nothing to pay for by polling it faster.
    assert.strictEqual(tickInterval(false, {gameMs: T.DETECT_INTERVAL}), IDLE_INTERVAL);
    // Nonsense overrides fall back rather than producing a zero-delay loop.
    for (const bad of [0, -5, NaN, Infinity, '300', undefined]) {
        assert.strictEqual(tickInterval(true, {gameMs: bad}), GAME_INTERVAL, String(bad));
    }
});

test('one negative gate hides, because lingering is the failure that matters', () => {
    assert.strictEqual(T.HIDE_AFTER_NEGATIVE, 1);
    const {state, last} = run([MATCH, {type: 'gate', up: false}]);
    assert.strictEqual(last.hide, true);
    assert.strictEqual(last.reason, 'released');
    assert.strictEqual(last.nextCheckMs, null, 'the fast loop must stop once nothing is shown');
    assert.strictEqual(state.showing, false);
    assert.strictEqual(state.key, null);
});

test('two-tick debounce is a parameter, so the choice is testable both ways', () => {
    // The argument for two is a false negative on a real Tab screen; measured,
    // the gate separates 0.99 from 0.27-0.65, so it barely exists. The cost of
    // two is 300 ms of brackets over live gameplay instead of 150 ms.
    const opts = {hideAfterNegative: 2};
    const first = run([MATCH, {type: 'gate', up: false}], opts);
    assert.strictEqual(first.last.hide, false);
    assert.strictEqual(first.last.nextCheckMs, T.FAST_INTERVAL);
    assert.strictEqual(first.state.showing, true);
    assert.strictEqual(first.state.negatives, 1);
    const second = run([MATCH, {type: 'gate', up: false}, {type: 'gate', up: false}], opts);
    assert.strictEqual(second.last.hide, true);
    assert.strictEqual(second.state.showing, false);
    // …and one positive in between resets the count, so a flicker cannot
    // accumulate into a hide over a whole Tab press.
    const flicker = run([MATCH, {type: 'gate', up: false}, {type: 'gate', up: true},
        {type: 'gate', up: false}], opts);
    assert.strictEqual(flicker.last.hide, false);
    assert.strictEqual(flicker.state.showing, true);
});

/* ────────────────────────────────────────────────────────────────────────────
 * Showing and hiding
 * ──────────────────────────────────────────────────────────────────────────── */

test('a match shows the markers and starts the fast loop', () => {
    const {state, last} = run([MATCH]);
    assert.strictEqual(last.show, true);
    assert.strictEqual(last.hide, false);
    assert.strictEqual(last.nextCheckMs, T.FAST_INTERVAL);
    assert.strictEqual(state.showing, true);
    assert.strictEqual(state.key, MATCH.key);
});

test('a repeated match keeps them up without redrawing', () => {
    // The detector sends every accepted match; a held Tab produces several.
    const {effects, state} = run([MATCH, MATCH, MATCH]);
    assert.strictEqual(effects[0].show, true);
    assert.strictEqual(effects[1].show, false);
    assert.strictEqual(effects[2].show, false);
    for (const e of effects) assert.strictEqual(e.nextCheckMs, T.FAST_INTERVAL);
    assert.strictEqual(state.showing, true);
});

test('a different map redraws', () => {
    const other = {type: 'match', key: 'deftyconchgaming/East Haddonfield', drawable: true};
    const {effects, state} = run([MATCH, other]);
    assert.strictEqual(effects[1].show, true);
    assert.strictEqual(effects[1].reason, 'match');
    assert.strictEqual(state.key, other.key);
});

test('a recognised map we cannot draw takes the markers DOWN', () => {
    // Leaving the previous map's markers up would put one map's cellars on
    // another map — the worst possible outcome for this feature.
    const {state, last} = run([MATCH, {type: 'match', key: 'x/y', drawable: false}]);
    assert.strictEqual(last.hide, true);
    assert.strictEqual(last.reason, 'not-drawable');
    assert.strictEqual(state.showing, false);
    // And from a standing start it shows nothing at all.
    const cold = run([{type: 'match', key: 'x/y', drawable: false}]);
    assert.strictEqual(cold.last.show, false);
    assert.strictEqual(cold.last.hide, false);
    assert.strictEqual(cold.state.showing, false);
});

test('a gate pass alone never shows anything', () => {
    // "A Tab screen" is not "this map": the map has to come from the detector.
    const {state, last} = run([{type: 'gate', up: true}]);
    assert.strictEqual(last.show, false);
    assert.strictEqual(state.showing, false);
    // …and with nothing shown the fast loop has no job, so it is not scheduled.
    assert.strictEqual(last.nextCheckMs, null);
    assert.strictEqual(last.reason, 'idle');
});

test('a positive gate keeps them up and asks again in FAST_INTERVAL', () => {
    const {state, last} = run([MATCH, {type: 'gate', up: true}]);
    assert.strictEqual(last.hide, false);
    assert.strictEqual(last.show, false);
    assert.strictEqual(last.nextCheckMs, T.FAST_INTERVAL);
    assert.strictEqual(last.reason, 'still-up');
    assert.strictEqual(state.showing, true);
    assert.strictEqual(state.negatives, 0);
});

test('every loss hides at once, whatever caused it', () => {
    for (const reason of ['no-window', 'minimized', 'moved', 'empty-capture', 'capture-error',
        'menu', 'detector-error', 'inactive', 'markers-off', 'no-bounds']) {
        const {state, last} = run([MATCH, {type: 'lost', reason}]);
        assert.strictEqual(last.hide, true, reason);
        assert.strictEqual(last.reason, reason, reason);
        assert.strictEqual(last.nextCheckMs, null, reason);
        assert.strictEqual(state.showing, false, reason);
        assert.strictEqual(state.negatives, 0, reason);
    }
    // A loss with nothing on screen is not reported as a hide — the caller
    // would log a transition that never happened.
    const cold = run([{type: 'lost', reason: 'no-window'}]);
    assert.strictEqual(cold.last.hide, false);
});

test('stop hides and stays down', () => {
    const {state, last} = run([MATCH, {type: 'stop'}]);
    assert.strictEqual(last.hide, true);
    assert.strictEqual(last.reason, 'stopped');
    assert.strictEqual(state.showing, false);
    assert.strictEqual(last.nextCheckMs, null);
});

test('an unknown event changes nothing but keeps the loop alive', () => {
    const {state, last} = run([MATCH, {type: 'nonsense'}]);
    assert.strictEqual(last.show, false);
    assert.strictEqual(last.hide, false);
    assert.strictEqual(state.showing, true);
    assert.strictEqual(last.nextCheckMs, T.FAST_INTERVAL);
    // …and with nothing shown it does not start one either.
    assert.strictEqual(run([{type: 'nonsense'}]).last.nextCheckMs, null);
    assert.strictEqual(run([undefined]).last.nextCheckMs, null);
});

test('the reducer never mutates the state it was given', () => {
    const before = T.initialTabModeState();
    const frozen = Object.freeze(Object.assign({}, before));
    const after = T.reduceTabMode(frozen, MATCH).state;
    assert.notStrictEqual(after, frozen);
    assert.deepStrictEqual(frozen, before);
});

/* ────────────────────────────────────────────────────────────────────────────
 * The key-state seam (a future trigger; nothing here reads a key)
 * ──────────────────────────────────────────────────────────────────────────── */

test('a key-down hint asks for a check and shows nothing by itself', () => {
    // A key press is not evidence that the Tab screen is up — the player may
    // be typing in chat, or have the key bound to something else. The screen
    // gate stays the only thing that can put markers on screen.
    const {state, last} = run([{type: 'hint', key: 'down'}]);
    assert.strictEqual(last.checkNow, true);
    assert.strictEqual(last.show, false);
    assert.strictEqual(state.showing, false);
    // The check it asks for still has to pass the gate before anything shows.
    const gated = run([{type: 'hint', key: 'down'}, {type: 'gate', up: true}]);
    assert.strictEqual(gated.state.showing, false);
    assert.strictEqual(gated.last.show, false);
});

test('a key-down hint while markers are up is a no-op beyond keeping the loop', () => {
    const {state, last} = run([MATCH, {type: 'hint', key: 'down'}]);
    assert.strictEqual(last.checkNow, false);
    assert.strictEqual(last.hide, false);
    assert.strictEqual(last.nextCheckMs, T.FAST_INTERVAL);
    assert.strictEqual(state.showing, true);
});

test('a key-up hint hides immediately', () => {
    // The one case where the key is better evidence than a capture: it is
    // instantaneous, and the fast check is up to FAST_INTERVAL behind.
    const {state, last} = run([MATCH, {type: 'hint', key: 'up'}]);
    assert.strictEqual(last.hide, true);
    assert.strictEqual(last.reason, 'key-up');
    assert.strictEqual(last.nextCheckMs, null);
    assert.strictEqual(state.showing, false);
});

test('the polling path is complete without any hint at all', () => {
    // The whole show/hide cycle, driven only by timer ticks and the detector.
    const {effects, state} = run([MATCH, {type: 'gate', up: true}, {type: 'gate', up: true},
        {type: 'gate', up: false}, MATCH]);
    assert.strictEqual(effects[0].show, true);
    assert.strictEqual(effects[3].hide, true);
    assert.strictEqual(effects[4].show, true);
    assert.strictEqual(state.showing, true);
});

test('an unknown hint is ignored without disturbing anything', () => {
    const {state, last} = run([MATCH, {type: 'hint', key: 'sideways'}]);
    assert.strictEqual(last.hide, false);
    assert.strictEqual(last.checkNow, false);
    assert.strictEqual(state.showing, true);
    assert.strictEqual(last.nextCheckMs, T.FAST_INTERVAL);
});

/* ────────────────────────────────────────────────────────────────────────────
 * Physical pixels → DIPs
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A display as `core/tab-mode.js` builds it: the DIP bounds Electron reports
 * and the physical rectangle `screen.dipToScreenRect` returns for them.
 */
function display(x, y, w, h, scale, physicalX, physicalY, primary) {
    return {
        bounds: {x, y, width: w, height: h},
        physical: {
            x: physicalX === undefined ? x : physicalX,
            y: physicalY === undefined ? y : physicalY,
            width: Math.round(w * scale),
            height: Math.round(h * scale)
        },
        scaleFactor: scale,
        primary: !!primary
    };
}

test('a single 100 % display is the identity', () => {
    const displays = [display(0, 0, 1920, 1080, 1, 0, 0, true)];
    assert.deepStrictEqual(T.gameRectToDip({x: 100, y: 50, width: 1280, height: 720}, displays),
        {x: 100, y: 50, width: 1280, height: 720, scaleFactor: 1, clamped: false});
});

test('125 % and 150 % scale the origin and the size', () => {
    // 125 %: a 2400x1350 physical panel is 1920x1080 DIPs.
    const at125 = [display(0, 0, 1920, 1080, 1.25, 0, 0, true)];
    assert.deepStrictEqual(T.gameRectToDip({x: 250, y: 125, width: 1600, height: 900}, at125),
        {x: 200, y: 100, width: 1280, height: 720, scaleFactor: 1.25, clamped: false});
    // 150 %: a 2880x1620 physical panel is 1920x1080 DIPs.
    const at150 = [display(0, 0, 1920, 1080, 1.5, 0, 0, true)];
    assert.deepStrictEqual(T.gameRectToDip({x: 300, y: 150, width: 1920, height: 1080}, at150),
        {x: 200, y: 100, width: 1280, height: 720, scaleFactor: 1.5, clamped: false});
});

test('a game on the second, differently scaled monitor lands on that monitor', () => {
    // The case this function exists for: 100 % primary, 150 % secondary to its
    // right. Electron lays the DIP space out as 0..1920 then 1920..3200; the
    // physical space is 0..1920 then 1920..3840.
    const displays = [
        display(0, 0, 1920, 1080, 1, 0, 0, true),
        display(1920, 0, 1280, 720, 1.5, 1920, 0)
    ];
    // A window that actually fits on that display: 1200x600 physical at
    // (300, 150) inside its 1920x1080 physical area is 800x400 DIPs at
    // (1920 + 200, 100). (An earlier version of this fixture used a
    // full-1080p window offset by 300 px inside a 1080p display, which cannot
    // exist — the clamp added later is what pointed that out.)
    const rect = {x: 1920 + 300, y: 150, width: 1200, height: 600};
    assert.deepStrictEqual(T.gameRectToDip(rect, displays),
        {x: 1920 + 200, y: 100, width: 800, height: 400, scaleFactor: 1.5, clamped: false});
    // …and a window on the primary is unaffected by the second display existing.
    assert.deepStrictEqual(T.gameRectToDip({x: 0, y: 0, width: 1920, height: 1080}, displays),
        {x: 0, y: 0, width: 1920, height: 1080, scaleFactor: 1, clamped: false});
});

test('a rectangle reaching outside its display is clamped and flagged', () => {
    // Defence in depth: the window rectangle comes from another library, and a
    // game mid-resize — or a reply about a window that was closing — must not
    // become an always-on-top window spanning the desktop. The caller declines
    // to draw on `clamped`, because a clamped box is not where the markers were
    // going to be.
    const displays = [display(0, 0, 1920, 1080, 1, 0, 0, true)];
    const out = T.gameRectToDip({x: -500, y: -200, width: 4000, height: 3000}, displays);
    assert.strictEqual(out.clamped, true);
    assert.strictEqual(out.x, 0);
    assert.strictEqual(out.y, 0);
    assert.strictEqual(out.x + out.width, 1920);
    assert.strictEqual(out.y + out.height, 1080);
    // A rectangle that merely touches the edges is not clamped.
    assert.strictEqual(T.gameRectToDip({x: 0, y: 0, width: 1920, height: 1080}, displays).clamped, false);
    // …and the clamp never produces a zero or negative size.
    const away = T.gameRectToDip({x: 5000, y: 5000, width: 100, height: 100}, displays);
    assert.ok(away.width >= 1 && away.height >= 1);
    assert.strictEqual(away.clamped, true);
});

test('a monitor to the left (negative coordinates) works too', () => {
    const displays = [
        display(0, 0, 1920, 1080, 1, 0, 0, true),
        display(-1600, 0, 1600, 900, 1.25, -2000, 0)
    ];
    assert.deepStrictEqual(T.gameRectToDip({x: -1750, y: 125, width: 1000, height: 500}, displays),
        {x: -1400, y: 100, width: 800, height: 400, scaleFactor: 1.25, clamped: false});
});

test('the far edges are rounded, not the size, so no strip of game is left bare', () => {
    // Rounding the origin and the size separately can lose a pixel on a
    // fractional scale; rounding both edges keeps the right and bottom of the
    // window where the game's are.
    const displays = [display(0, 0, 1920, 1080, 1.25, 0, 0, true)];
    const bounds = T.gameRectToDip({x: 3, y: 3, width: 1001, height: 501}, displays);
    assert.strictEqual(bounds.x, Math.round(3 / 1.25));
    assert.strictEqual(bounds.x + bounds.width, Math.round(1004 / 1.25));
    assert.strictEqual(bounds.y + bounds.height, Math.round(504 / 1.25));
});

test('a window the centre of which is off every display uses the best overlap', () => {
    const displays = [
        display(0, 0, 1920, 1080, 1, 0, 0, true),
        display(1920, 0, 1920, 1080, 1, 1920, 0)
    ];
    // Mostly on the second display, centre just past its right edge.
    const rect = {x: 3000, y: 0, width: 1600, height: 1080};
    assert.strictEqual(T.displayForRect(rect, displays), displays[1]);
    // Off the desktop entirely: the primary, rather than nothing.
    assert.strictEqual(T.displayForRect({x: 99000, y: 99000, width: 10, height: 10}, displays), displays[0]);
});

test('an unusable rectangle or display list is null, never a guess', () => {
    const displays = [display(0, 0, 1920, 1080, 1, 0, 0, true)];
    for (const rect of [null, undefined, {}, {x: 0, y: 0, width: 0, height: 100},
        {x: NaN, y: 0, width: 10, height: 10}, {x: 0, y: 0, width: -1, height: 10}]) {
        assert.strictEqual(T.gameRectToDip(rect, displays), null, JSON.stringify(rect));
    }
    const rect = {x: 0, y: 0, width: 100, height: 100};
    for (const list of [null, undefined, [], [null], [{bounds: {x: 0, y: 0, width: 1, height: 1}}]]) {
        assert.strictEqual(T.gameRectToDip(rect, list), null, JSON.stringify(list));
    }
    // A display with a nonsense scale factor degrades to 1 rather than
    // dividing by zero.
    const broken = [{bounds: {x: 0, y: 0, width: 100, height: 100},
        physical: {x: 0, y: 0, width: 100, height: 100}, scaleFactor: 0}];
    assert.deepStrictEqual(T.gameRectToDip(rect, broken),
        {x: 0, y: 0, width: 100, height: 100, scaleFactor: 1, clamped: false});
});

/* ────────────────────────────────────────────────────────────────────────────
 * "Has the window moved?"
 * ──────────────────────────────────────────────────────────────────────────── */

test('rectChanged is exact, with no tolerance to tune', () => {
    const a = {x: 10, y: 20, width: 100, height: 200};
    assert.strictEqual(T.rectChanged(a, {x: 10, y: 20, width: 100, height: 200}), false);
    for (const field of ['x', 'y', 'width', 'height']) {
        const b = Object.assign({}, a);
        b[field] += 1;
        assert.strictEqual(T.rectChanged(a, b), true, field);
    }
    // No previous rectangle counts as changed: the markers must be re-placed
    // rather than assumed to be where they were.
    assert.strictEqual(T.rectChanged(a, null), true);
    assert.strictEqual(T.rectChanged(null, a), true);
    assert.strictEqual(T.rectChanged(null, null), true);
});

/* ────────────────────────────────────────────────────────────────────────────
 * The optimistic show — `tabMarkersInstant`
 *
 * The markers go up on the key-down edge, before anything has looked at the
 * screen, and fade in with the game's own map. Everything below is the pact
 * that makes that safe: it is allowed only for a map the screen has already
 * been read on, it is bounded by a deadline, and failing to be confirmed costs
 * the map its place in the fast path.
 * ──────────────────────────────────────────────────────────────────────────── */

const KEY = MATCH.key;

/** A context in which the optimistic show is allowed. Override one at a time. */
function context(over) {
    return Object.assign({
        instant: true, method: 'key', foreground: true,
        mapKey: KEY, drawable: true, bounds: true
    }, over || {});
}

/** The state after one confirmed press on `KEY`, with nothing on screen. */
function confirmedIdle() {
    let state = T.reduceTabMode(T.initialTabModeState(), MATCH).state;
    state = T.reduceTabMode(state, {type: 'hint', key: 'up'}).state;
    return state;
}

test('the provisional deadline is long enough to be confirmed and short enough to flash', () => {
    // The game's own fade was measured at 250-330 ms over 39 presses, and a
    // capture costs ~45 ms on top. The deadline has to clear both, or a real
    // Tab press would be taken down just before the screen proved it right.
    assert.ok(T.PROVISIONAL_DEADLINE_MS > 330 + 45);
    // It also has to outlast a confirmation that **really happens**. Each look
    // costs ~45 ms of capture and the next is scheduled that much later again,
    // so the looks start at ~0/95/190/285/380/475 ms and are answered ~45 ms
    // after each. The owner's log has a confirmation at 530 ms; a deadline
    // inside that window turns the slowest genuine presses into
    // show / hide / re-show, which is worse than having waited.
    const CAPTURE_MS = 45;
    const answeredAt = [CAPTURE_MS];
    let startedAt = 0;
    for (const delay of T.CONFIRM_RETRY_DELAYS) {
        startedAt += CAPTURE_MS + delay;
        answeredAt.push(startedAt + CAPTURE_MS);
    }
    assert.ok(T.PROVISIONAL_DEADLINE_MS >= 530, 'a confirmation the owner actually logged would be cut off');
    // All but the very last look are inside it. That last one (the +100 ms
    // retry, answered ~665 ms) is deliberately outside: waiting for it would
    // put a guess on screen for two thirds of a second. Nothing is lost by it
    // either — a deadline that expires with the key still held restarts the
    // ordinary slow path for that same press.
    const inside = answeredAt.filter(ms => ms <= T.PROVISIONAL_DEADLINE_MS).length;
    assert.ok(inside >= answeredAt.length - 1,
        `only ${inside} of ${answeredAt.length} confirming looks are answered inside the deadline`);
    // …and it has to stay at about half a second, because this is also how
    // long a press in chat or the pause menu can put brackets on screen.
    assert.ok(T.PROVISIONAL_DEADLINE_MS <= 600);
});

test('the optimistic memory ages out, and a backwards clock is not freshness', () => {
    // Five minutes: far longer than a match's worth of Tab presses, so it never
    // fires during play. It exists for the one case nothing else covers — a
    // match that ends and another that begins on a different map with no main
    // menu and no window change in between.
    assert.strictEqual(T.CONFIRMED_MEMORY_MS, 5 * 60 * 1000);
    const now = 10 * 60 * 1000;
    assert.strictEqual(T.confirmedMemoryFresh(now, now), true);
    assert.strictEqual(T.confirmedMemoryFresh(now - T.CONFIRMED_MEMORY_MS, now), true);
    assert.strictEqual(T.confirmedMemoryFresh(now - T.CONFIRMED_MEMORY_MS - 1, now), false);
    // Never confirmed at all.
    assert.strictEqual(T.confirmedMemoryFresh(0, now), false);
    // A clock that went backwards — a system time change, a suspend/resume —
    // answers *no*. A refusal costs one slow press; a wrong yes costs a faded
    // show of possibly the wrong map.
    assert.strictEqual(T.confirmedMemoryFresh(now + 1000, now), false);
    for (const bad of [NaN, Infinity, null, undefined, '1000']) {
        assert.strictEqual(T.confirmedMemoryFresh(bad, now), false, String(bad));
        assert.strictEqual(T.confirmedMemoryFresh(now, bad), false, String(bad));
    }
    // The limit is overridable, and nonsense falls back to the constant.
    assert.strictEqual(T.confirmedMemoryFresh(now - 50, now, 10), false);
    assert.strictEqual(T.confirmedMemoryFresh(now - 50, now, 0), true);
});

test('the first press of a match is never provisional', () => {
    // Nothing has been confirmed, so there is nothing to be optimistic with:
    // the press buys a capture and the screen gate decides, exactly as it
    // always did.
    const fresh = T.initialTabModeState();
    assert.strictEqual(fresh.confirmedKey, null);
    const decision = T.shouldShowProvisionally(fresh, context());
    assert.strictEqual(decision.show, false);
    assert.strictEqual(decision.reason, 'first-press');
});

test('the second press of a match is', () => {
    const decision = T.shouldShowProvisionally(confirmedIdle(), context());
    assert.deepStrictEqual(decision, {show: true, key: KEY, reason: 'ok'});
});

test('every reason not to be optimistic, one at a time', () => {
    const state = confirmedIdle();
    const cases = [
        // The user asked to always wait. Nothing can flash.
        [{instant: false}, 'off'],
        // The polling path has no key edge to be early about; its only signal
        // is the capture, and the capture is the thing being pre-empted.
        [{method: 'polling'}, 'method'],
        [{method: 'key-waiting'}, 'method'],
        // Tab moves focus in every window on the machine.
        [{foreground: false}, 'not-foreground'],
        // No map known: there is nothing to draw and no way to know it fits.
        [{mapKey: null}, 'no-map'],
        // A different map to the confirmed one — the hazard this whole memory
        // exists to avoid, which is one map's cellars over another's.
        [{mapKey: 'someone/Another Map'}, 'first-press'],
        // Markers off, every layer off, or a map with no Tab transform.
        [{drawable: false}, 'not-drawable'],
        // No honest place to draw: no rectangle, or one that had to be clamped.
        [{bounds: false}, 'no-bounds']
    ];
    for (const [over, reason] of cases) {
        const decision = T.shouldShowProvisionally(state, context(over));
        assert.strictEqual(decision.show, false, JSON.stringify(over));
        assert.strictEqual(decision.reason, reason, JSON.stringify(over));
        assert.strictEqual(decision.key, null);
    }
    // A provisional show is a start, never an update to markers already up.
    const showing = T.reduceTabMode(state, MATCH).state;
    assert.strictEqual(T.shouldShowProvisionally(showing, context()).reason, 'showing');
    // No state and no context at all are refusals, not crashes.
    assert.strictEqual(T.shouldShowProvisionally(null, null).show, false);
    assert.strictEqual(T.shouldShowProvisionally(undefined, context()).reason, 'first-press');
});

test('an unread `instant` is not the same as `instant: false`', () => {
    // The shape of the bug `resolveTriggerMethod` was rewritten for: a caller
    // that has not read the setting must not silently get the *off* behaviour
    // and leave the user wondering why the switch does nothing.
    const state = confirmedIdle();
    assert.strictEqual(T.shouldShowProvisionally(state, context({instant: undefined})).show, true);
    assert.strictEqual(T.shouldShowProvisionally(state, context({instant: false})).show, false);
});

test('a provisional hint shows, asks for the confirming capture, and starts the loop', () => {
    const state = confirmedIdle();
    const {state: next, effects} = T.reduceTabMode(state,
        {type: 'hint', key: 'down', provisional: true, mapKey: KEY});
    assert.strictEqual(effects.show, true);
    assert.strictEqual(effects.provisional, true, 'the renderer would not have faded it in');
    // The capture runs exactly as it always did: this replaces *waiting* for
    // the screen gate, not the screen gate.
    assert.strictEqual(effects.checkNow, true);
    assert.strictEqual(effects.nextCheckMs, T.FAST_INTERVAL);
    assert.strictEqual(effects.key, KEY);
    assert.strictEqual(next.showing, true);
    assert.strictEqual(next.provisional, true);
    assert.strictEqual(next.key, KEY);
});

test('a hint the caller did not approve is the ordinary press, whatever the memory says', () => {
    // `provisional: true` means "`shouldShowProvisionally` said yes". Without
    // it the reducer must not go looking for a reason to show something.
    const {state, effects} = T.reduceTabMode(confirmedIdle(), {type: 'hint', key: 'down'});
    assert.strictEqual(effects.show, false);
    assert.strictEqual(effects.provisional, false);
    assert.strictEqual(effects.checkNow, true);
    assert.strictEqual(state.showing, false);
    // …and neither does an approval with no map to show.
    assert.strictEqual(
        T.reduceTabMode(confirmedIdle(), {type: 'hint', key: 'down', provisional: true}).state.showing,
        false);
});

test('a confirmation changes nothing on screen and re-sends no payload', () => {
    // The markers are mid-fade when the capture agrees with them. Re-placing
    // the same payload would restart that animation from zero — a flicker at
    // the exact moment the app became sure.
    const provisional = T.reduceTabMode(confirmedIdle(),
        {type: 'hint', key: 'down', provisional: true, mapKey: KEY}).state;
    const {state, effects} = T.reduceTabMode(provisional, MATCH);
    assert.strictEqual(effects.show, false, 'the payload was re-sent and the fade restarted');
    assert.strictEqual(effects.hide, false);
    assert.strictEqual(effects.confirmed, true);
    assert.strictEqual(effects.reason, 'confirmed');
    assert.strictEqual(state.showing, true);
    assert.strictEqual(state.provisional, false);
    assert.strictEqual(state.confirmedKey, KEY);
});

test('a confirmation for a different map replaces the payload, without a fade', () => {
    const provisional = T.reduceTabMode(confirmedIdle(),
        {type: 'hint', key: 'down', provisional: true, mapKey: KEY}).state;
    const other = {type: 'match', key: 'someone/Another Map', drawable: true};
    const {state, effects} = T.reduceTabMode(provisional, other);
    assert.strictEqual(effects.show, true, 'the wrong map was left on screen');
    // Not a provisional show: this payload is new information, and fading it
    // in would mean the right markers arrive *later* than the wrong ones did.
    assert.strictEqual(effects.provisional, false);
    assert.strictEqual(effects.confirmed, true);
    assert.strictEqual(state.key, other.key);
    assert.strictEqual(state.provisional, false);
    assert.strictEqual(state.confirmedKey, other.key, 'the memory still names the old map');
});

test('a negative gate does not hide a provisional show, but does hide a confirmed one', () => {
    // The gate is *expected* to say no while the game fades its map in — that
    // is the entire reason the markers went up early. Hiding here would undo
    // the feature at the one moment it is doing its job.
    const provisional = T.reduceTabMode(confirmedIdle(),
        {type: 'hint', key: 'down', provisional: true, mapKey: KEY}).state;
    const fading = T.reduceTabMode(provisional, {type: 'gate', up: false});
    assert.strictEqual(fading.effects.hide, false);
    assert.strictEqual(fading.effects.reason, 'fading');
    assert.strictEqual(fading.state.showing, true);
    assert.strictEqual(fading.state.negatives, 0, 'a fade must not count towards the hide');
    // Once confirmed, the ordinary rule is back, unchanged: one negative gate.
    const confirmed = T.reduceTabMode(fading.state, MATCH).state;
    const released = T.reduceTabMode(confirmed, {type: 'gate', up: false});
    assert.strictEqual(released.effects.hide, true);
    assert.strictEqual(released.effects.reason, 'released');
    assert.strictEqual(released.state.showing, false);
});

test('a key-up hides a provisional show at once — and forgets, because it proved nothing', () => {
    const provisional = T.reduceTabMode(confirmedIdle(),
        {type: 'hint', key: 'down', provisional: true, mapKey: KEY}).state;
    const {state, effects} = T.reduceTabMode(provisional, {type: 'hint', key: 'up'});
    assert.strictEqual(effects.hide, true);
    assert.strictEqual(effects.reason, 'key-up');
    assert.strictEqual(state.showing, false);
    assert.strictEqual(state.provisional, false);
    // A tap shorter than the game's own fade releases the key before any
    // capture can confirm, so keeping the memory here would let *every* tap in
    // a chat window flash. The cost is one slow press after a genuine short
    // tap — a press whose markers the player did not stay to read.
    assert.strictEqual(state.confirmedKey, null);
    // The same key-up on a **confirmed** show does keep it, which is the case
    // the whole fast path is for.
    const confirmed = T.reduceTabMode(provisional, MATCH).state;
    assert.strictEqual(
        T.reduceTabMode(confirmed, {type: 'hint', key: 'up'}).state.confirmedKey, KEY);
});

test('only "the player let go" keeps the memory; everything else forgets', () => {
    assert.deepStrictEqual(T.MEMORY_KEEPING_HIDE_REASONS, ['key-up', 'released']);
    const shown = T.reduceTabMode(confirmedIdle(), MATCH).state;
    // The two that keep it: the key came up, or the gate said the screen is
    // gone. Both mean "same match, no map on screen right now".
    assert.strictEqual(T.reduceTabMode(shown, {type: 'hint', key: 'up'}).state.confirmedKey, KEY);
    assert.strictEqual(T.reduceTabMode(shown, {type: 'gate', up: false}).state.confirmedKey, KEY);
    // Everything else forgets, because the safe direction here is the slow
    // path: the slow path cannot flash.
    for (const reason of ['unconfirmed', 'menu', 'no-window', 'minimized', 'moved',
        'capture-error', 'no-frame', 'renderer-gone', 'key-changed', 'markers-off']) {
        assert.strictEqual(T.reduceTabMode(shown, {type: 'lost', reason}).state.confirmedKey, null, reason);
    }
    assert.strictEqual(T.reduceTabMode(shown, {type: 'stop'}).state.confirmedKey, null);
    // A recognised map that cannot be drawn is not a map to remember either.
    assert.strictEqual(
        T.reduceTabMode(shown, {type: 'match', key: KEY, drawable: false}).state.confirmedKey, null);
});

test('an unconfirmed deadline costs the map its place in the fast path', () => {
    // The whole reason repeated presses in chat, the pause menu or the end
    // screen flash **at most once**: the first one is taken down unconfirmed
    // and the memory goes with it, so the second is slow and certain again.
    const provisional = T.reduceTabMode(confirmedIdle(),
        {type: 'hint', key: 'down', provisional: true, mapKey: KEY}).state;
    const {state, effects} = T.reduceTabMode(provisional, {type: 'lost', reason: 'unconfirmed'});
    assert.strictEqual(effects.hide, true);
    assert.strictEqual(effects.reason, 'unconfirmed');
    assert.strictEqual(state.confirmedKey, null);
    assert.strictEqual(T.shouldShowProvisionally(state, context()).reason, 'first-press');
});

test('forgetConfirmedMap drops the memory and nothing else', () => {
    const shown = T.reduceTabMode(confirmedIdle(), MATCH).state;
    const after = T.forgetConfirmedMap(shown);
    assert.strictEqual(after.confirmedKey, null);
    // What is on screen is not this function's business: it is used from
    // places that must not disturb a loop or a timer.
    assert.strictEqual(after.showing, shown.showing);
    assert.strictEqual(after.key, shown.key);
    assert.notStrictEqual(after, shown, 'the state it was given was mutated');
    // Nothing to forget is the same object back, and no input is not a crash.
    const fresh = T.initialTabModeState();
    assert.strictEqual(T.forgetConfirmedMap(fresh), fresh);
    assert.strictEqual(T.forgetConfirmedMap(null).confirmedKey, null);
});
