const {test, after} = require('node:test');
const assert = require('node:assert');

// The recorder un-refs its timers (they must never keep the *app* alive), so a
// test awaiting one leaves the event loop empty. Node 24 waits for the test's
// promise anyway; Node 22 (the workflow ran it until 1.1.0) cancels the test
// ('Promise resolution is still pending but the event loop has already
// resolved'). One ref'd timer for the life of the file makes both behave alike.
const keepAlive = setInterval(() => {}, 1000);
after(() => clearInterval(keepAlive));

const T = require('../src/shared/tab-mode-rules');
const {DEFAULT_MAP_VK, VK_MENU} = require('../src/shared/key-codes');
const {DEFAULT_SETTINGS} = require('../src/shared/settings-defaults');
const {GAME_INTERVAL, tickInterval} = require('../src/shared/detector-rules');

/*
 * The key trigger's *decisions*. The 28 ns `GetAsyncKeyState` call itself is
 * measured in plain node (see docs/SPEC-MARKERS.md); what is tested here is
 * everything that decides whether the app acts on it — which is the half that
 * can make markers appear when they should not.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * One key reading → a hint, or nothing
 * ──────────────────────────────────────────────────────────────────────────── */

const reading = (over) => Object.assign(
    {down: false, alt: false, foreground: true, wasDown: false, enabled: true}, over);

test('an edge produces a hint, a steady state produces nothing', () => {
    assert.deepStrictEqual(T.keyHintFor(reading({down: true})),
        {hint: 'down', down: true, reason: 'down'});
    assert.deepStrictEqual(T.keyHintFor(reading({down: true, wasDown: true})),
        {hint: null, down: true, reason: 'unchanged'});
    assert.deepStrictEqual(T.keyHintFor(reading({down: false, wasDown: true})),
        {hint: 'up', down: false, reason: 'up'});
    assert.deepStrictEqual(T.keyHintFor(reading({down: false, wasDown: false})),
        {hint: null, down: false, reason: 'unchanged'});
});

test('Alt held reads as "not down" — Alt+Tab is Windows, not the player', () => {
    // From up: nothing happens, so Alt+Tab cannot show markers.
    assert.deepStrictEqual(T.keyHintFor(reading({down: true, alt: true})),
        {hint: null, down: false, reason: 'unchanged'});
    // From down: it *hides*, which is right — after Alt+Tab the game is not in
    // front any more. Every refusal resolves to "not down" for exactly this
    // reason: the safe direction is always to take the markers away.
    assert.deepStrictEqual(T.keyHintFor(reading({down: true, alt: true, wasDown: true})),
        {hint: 'up', down: false, reason: 'alt'});
});

test('the game not being in front reads as "not down"', () => {
    // Tab moves focus in a browser, in chat and in every form on the machine.
    assert.deepStrictEqual(T.keyHintFor(reading({down: true, foreground: false})),
        {hint: null, down: false, reason: 'unchanged'});
    assert.deepStrictEqual(T.keyHintFor(reading({down: true, foreground: false, wasDown: true})),
        {hint: 'up', down: false, reason: 'not-foreground'});
});

test('a disabled trigger produces no hints at all', () => {
    // A stale timer after a fallback must not keep talking.
    assert.deepStrictEqual(T.keyHintFor(reading({down: true, enabled: false})),
        {hint: null, down: false, reason: 'unchanged'});
    assert.deepStrictEqual(T.keyHintFor(reading({down: true, wasDown: true, enabled: false})),
        {hint: 'up', down: false, reason: 'disabled'});
});

test('the foreground is checked before Alt, mirroring the read order', () => {
    // The trigger reads the foreground *first* and does not read any key at
    // all unless the game is in front, so when both are wrong the honest
    // reason is the one it would actually have discovered.
    assert.strictEqual(
        T.keyHintFor(reading({down: true, alt: true, foreground: false, wasDown: true})).reason,
        'not-foreground');
    // Alt is the reason only when the game really is in front.
    assert.strictEqual(
        T.keyHintFor(reading({down: true, alt: true, foreground: true, wasDown: true})).reason,
        'alt');
});

test('keyHintFor tolerates a missing reading', () => {
    assert.deepStrictEqual(T.keyHintFor(null), {hint: null, down: false, reason: 'unchanged'});
    assert.deepStrictEqual(T.keyHintFor({}), {hint: null, down: false, reason: 'unchanged'});
});

/* ────────────────────────────────────────────────────────────────────────────
 * Which method is in use
 * ──────────────────────────────────────────────────────────────────────────── */

test('auto prefers the key trigger and falls back on its own', () => {
    assert.deepStrictEqual(
        T.resolveTriggerMethod({mode: 'auto', available: true, running: true, gameWindow: true}),
        {method: 'key', reason: 'key'});
    // Every way it can be unavailable ends in the polling path, with the reason
    // kept so `system.txt` can say which one it was.
    for (const reason of ['load', 'bind', 'probe', 'call']) {
        assert.deepStrictEqual(
            T.resolveTriggerMethod({mode: 'auto', available: false, running: false, reason}),
            {method: 'polling', reason});
    }
    assert.deepStrictEqual(T.resolveTriggerMethod({mode: 'auto', available: false}),
        {method: 'polling', reason: 'unavailable'});
});

test('with the game closed the answer is "waiting", never "unavailable"', () => {
    // The field bug, as a test. The first packaged run had the game shut, so
    // the trigger had never been started — and the two-state version reported
    // `method=polling reason=unavailable`, which Settings renders as "reading
    // the key state is not available on this PC". Nothing had been tried.
    assert.deepStrictEqual(
        T.resolveTriggerMethod({mode: 'auto', available: true, running: false, gameWindow: false}),
        {method: 'key-waiting', reason: 'no-game'});
    // …and "not probed yet" is not "broken" either: `undefined` is not `false`.
    assert.deepStrictEqual(
        T.resolveTriggerMethod({mode: 'auto', running: false, gameWindow: false}),
        {method: 'key-waiting', reason: 'no-game'});
    // Usable, a game window, but not polling (a transient) is still the key
    // method waiting — not a fallback.
    assert.deepStrictEqual(
        T.resolveTriggerMethod({mode: 'auto', available: true, running: false, gameWindow: true}),
        {method: 'key-waiting', reason: 'idle'});
    // A probe that really failed still says so, game or no game.
    assert.deepStrictEqual(
        T.resolveTriggerMethod({mode: 'auto', available: false, reason: 'load', gameWindow: false}),
        {method: 'polling', reason: 'load'});
});

test('nothing fast is in effect while the key method is only waiting', () => {
    // With no game window there is nothing to capture, so neither the 150 ms
    // loop nor the 450 ms detector override may be reported as being in
    // effect — the first field log printed `detectMs=450` in exactly that
    // state.
    assert.strictEqual(T.checkInterval('key-waiting'), T.SAFETY_INTERVAL);
    assert.strictEqual(T.detectIntervalFor({running: true, method: 'key-waiting'}), null);
    // …and the polling path is unchanged.
    assert.strictEqual(T.checkInterval('polling'), T.FAST_INTERVAL);
    assert.strictEqual(T.detectIntervalFor({running: true, method: 'polling'}), T.DETECT_INTERVAL);
});

test('"polling only" is honoured even when the trigger works', () => {
    assert.deepStrictEqual(
        T.resolveTriggerMethod({mode: 'polling', available: true, running: true, gameWindow: true}),
        {method: 'polling', reason: 'forced'});
    // Junk resolves to the polling path: Tab-map mode always has a way to work.
    for (const state of [null, undefined, {mode: 'nonsense', available: false}]) {
        assert.strictEqual(T.resolveTriggerMethod(state).method, 'polling', JSON.stringify(state));
    }
    // …but an empty state is "nothing tried yet", which is `key-waiting`.
    assert.strictEqual(T.resolveTriggerMethod({}).method, 'key-waiting');
});

test('the trigger mode setting is normalised, and defaults to auto', () => {
    assert.deepStrictEqual(T.TRIGGER_MODES, ['auto', 'polling']);
    assert.strictEqual(DEFAULT_SETTINGS.markerTrigger, 'auto');
    assert.strictEqual(T.triggerMode('polling'), 'polling');
    assert.strictEqual(T.triggerMode('auto'), 'auto');
    for (const bad of [null, undefined, '', 'off', 'key', 42, {}]) {
        assert.strictEqual(T.triggerMode(bad), 'auto', String(bad));
    }
});

/* ────────────────────────────────────────────────────────────────────────────
 * What each method costs
 * ──────────────────────────────────────────────────────────────────────────── */

test('the key poll is far cheaper than the interval it runs on', () => {
    assert.strictEqual(T.KEY_POLL_INTERVAL, 30);
    // Measured: 28 ns per GetAsyncKeyState. Asserted as the *relationship* the
    // design rests on rather than as a timing, which is not reproducible: the
    // poll must be orders of magnitude under the capture it replaces.
    assert.ok(T.KEY_POLL_INTERVAL < T.FAST_INTERVAL);
    assert.ok(T.KEY_POLL_INTERVAL < T.SAFETY_INTERVAL);
});

test('the periodic check slows down when the trigger is doing the work', () => {
    assert.strictEqual(T.SAFETY_INTERVAL, 500);
    // On the polling path this loop *is* the show/hide mechanism…
    assert.strictEqual(T.checkInterval('polling'), T.FAST_INTERVAL);
    // …with the trigger it is only the net under a key-up nobody saw.
    assert.strictEqual(T.checkInterval('key'), T.SAFETY_INTERVAL);
    assert.ok(T.SAFETY_INTERVAL > T.FAST_INTERVAL);
    // Anything unrecognised gets the safe, fast cadence rather than the slow one.
    for (const method of [null, undefined, 'nonsense']) {
        assert.strictEqual(T.checkInterval(method), T.FAST_INTERVAL, String(method));
    }
});

test('the detector keeps its normal cadence when the trigger is healthy', () => {
    // The main measurable saving of the trigger: the 450 ms override exists to
    // shorten how long markers take to *appear*, and with an edge-driven
    // trigger it buys nothing.
    assert.strictEqual(T.detectIntervalFor({running: true, method: 'key'}), null);
    assert.strictEqual(T.detectIntervalFor({running: true, method: 'polling'}), T.DETECT_INTERVAL);
    // Nothing is overridden while the mode is not running at all.
    assert.strictEqual(T.detectIntervalFor({running: false, method: 'polling'}), null);
    assert.strictEqual(T.detectIntervalFor({running: false, method: 'key'}), null);
    assert.strictEqual(T.detectIntervalFor(null), null);
    // …and the override really is what the detector applies.
    assert.strictEqual(tickInterval(true, {gameMs: T.detectIntervalFor({running: true, method: 'key'})}),
        GAME_INTERVAL);
    assert.strictEqual(tickInterval(true, {gameMs: T.detectIntervalFor({running: true, method: 'polling'})}),
        T.DETECT_INTERVAL);
});

/* ────────────────────────────────────────────────────────────────────────────
 * The reducer, driven the way the trigger drives it
 * ──────────────────────────────────────────────────────────────────────────── */

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

const KEY_OPTS = {fastMs: T.SAFETY_INTERVAL};
const MATCH = {type: 'match', key: 'deftyconchgaming/Haddonfield Heights', drawable: true};
const DOWN = {type: 'hint', key: 'down'};
const UP = {type: 'hint', key: 'up'};

test('the whole key-driven cycle: down → confirm → show → up → hide', () => {
    const {effects, state} = run([DOWN, MATCH, UP], KEY_OPTS);
    // The press only ever asks for a capture.
    assert.strictEqual(effects[0].checkNow, true);
    assert.strictEqual(effects[0].show, false);
    // The capture confirmed a map: now it shows, and the periodic loop becomes
    // the slow safety net rather than the 150 ms one.
    assert.strictEqual(effects[1].show, true);
    assert.strictEqual(effects[1].nextCheckMs, T.SAFETY_INTERVAL);
    // The release hides at once and stops the loop.
    assert.strictEqual(effects[2].hide, true);
    assert.strictEqual(effects[2].reason, 'key-up');
    assert.strictEqual(effects[2].nextCheckMs, null);
    assert.strictEqual(state.showing, false);
});

test('a press whose capture is not the map screen shows nothing', () => {
    // The commonest case by far: Tab in a menu, in chat, in the lobby. The
    // confirmation simply produces no `match`, and the reducer is never told
    // anything more.
    const {state, effects} = run([DOWN], KEY_OPTS);
    assert.strictEqual(effects[0].checkNow, true);
    assert.strictEqual(state.showing, false);
    // …and a second press just asks again.
    const twice = run([DOWN, UP, DOWN], KEY_OPTS);
    assert.strictEqual(twice.last.checkNow, true);
    assert.strictEqual(twice.state.showing, false);
});

test('a key held across a map change redraws for the new map', () => {
    // The key never goes up, so there is no new `down` hint; the detector's own
    // tick is what notices the different map.
    const other = {type: 'match', key: 'deftyconchgaming/East Haddonfield', drawable: true};
    const {effects, state} = run([DOWN, MATCH, other], KEY_OPTS);
    assert.strictEqual(effects[2].show, true);
    assert.strictEqual(effects[2].reason, 'match');
    assert.strictEqual(state.key, other.key);
    assert.strictEqual(state.showing, true);
});

test('a key still held after something else hid the markers does not re-show', () => {
    // The "stuck down" case: the main menu (or a moved window) takes the
    // markers away while the player is still holding the key. No new edge means
    // no new hint, so nothing comes back until the key is released and pressed
    // again — which is what the player will do anyway, and is the safe answer.
    const {state, effects} = run([DOWN, MATCH, {type: 'lost', reason: 'menu'}], KEY_OPTS);
    assert.strictEqual(effects[2].hide, true);
    assert.strictEqual(state.showing, false);
    assert.strictEqual(effects[2].nextCheckMs, null);
    // A `gate` reading arriving afterwards must not resurrect them either.
    const after = T.reduceTabMode(state, {type: 'gate', up: true}, KEY_OPTS);
    assert.strictEqual(after.effects.show, false);
    assert.strictEqual(after.state.showing, false);
});

test('an up hint with nothing shown is not reported as a hide', () => {
    // The trigger emits `up` whenever the key, Alt or the foreground says so,
    // which happens constantly while nothing is on screen. It must not produce
    // a log line or a window call each time.
    const {last, state} = run([UP], KEY_OPTS);
    assert.strictEqual(last.hide, false);
    assert.strictEqual(state.showing, false);
});

test('the safety check still hides on its own if a key-up is ever missed', () => {
    // The whole reason the periodic check survives the trigger: a key-up this
    // process never saw (a suspended process, a remote session that resets the
    // keyboard, a stuck physical key) must not leave markers over gameplay.
    const {last, state} = run([DOWN, MATCH, {type: 'gate', up: false}], KEY_OPTS);
    assert.strictEqual(last.hide, true);
    assert.strictEqual(last.reason, 'released');
    assert.strictEqual(state.showing, false);
});

test('with the trigger unavailable the polling path is byte-for-byte itself', () => {
    // The fallback is not a degraded mode with its own rules: it is the
    // implementation that shipped first, driven by the same reducer with the
    // fast cadence.
    const polling = {fastMs: T.checkInterval('polling')};
    const {effects, state} = run([MATCH, {type: 'gate', up: true}, {type: 'gate', up: false}], polling);
    assert.strictEqual(effects[0].show, true);
    assert.strictEqual(effects[0].nextCheckMs, T.FAST_INTERVAL);
    assert.strictEqual(effects[1].nextCheckMs, T.FAST_INTERVAL);
    assert.strictEqual(effects[2].hide, true);
    assert.strictEqual(state.showing, false);
});

/* ────────────────────────────────────────────────────────────────────────────
 * The impure trigger, driven without koffi
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A fake koffi whose `user32` (and, since 1.1, `xinput`) behaves however the
 * test needs. `b.pads` is `{slot: gamepadReading}` for the connected pads.
 */
function fakeKoffi(behaviour) {
    const b = behaviour || {};
    return {
        load(name) {
            if (b.loadThrows) throw new Error('user32 blocked');
            if (/xinput/i.test(name)) {
                if (b.xinputMissing) throw new Error(`${name} not found`);
                return {
                    func(convention, symbol) {
                        if (b.xinputBindThrows) throw new Error(`cannot bind ${symbol}`);
                        return (slot, out) => {
                            if (b.xinputCallThrows) throw new Error('call failed');
                            b.xinputCalls = (b.xinputCalls || []);
                            b.xinputCalls.push(slot);
                            const pad = b.pads && b.pads[slot];
                            if (!pad) return 1167;
                            out[0] = {dwPacketNumber: 1, Gamepad: pad};
                            return 0;
                        };
                    }
                };
            }
            return {
                func(convention, symbol) {
                    if (b.bindThrows) throw new Error(`cannot bind ${symbol}`);
                    // `callThrows` breaks **every** bound function, which is what
                    // a native module going wrong actually looks like.
                    if (symbol === 'GetAsyncKeyState') {
                        return (vk) => {
                            if (b.callThrows) throw new Error('call failed');
                            return b.keys && b.keys[vk] ? -32768 : 0;
                        };
                    }
                    if (symbol === 'GetForegroundWindow') {
                        return () => {
                            if (b.callThrows) throw new Error('call failed');
                            return b.hwnd === undefined ? 1 : b.hwnd;
                        };
                    }
                    return (hwnd, out) => {
                        if (b.callThrows) throw new Error('call failed');
                        out[0] = b.foregroundPid || 0;
                        return 1;
                    };
                }
            };
        },
        out: (t) => t,
        pointer: (t) => t,
        struct: (def) => def
    };
}

const KeyTrigger = require('../src/core/key-trigger');

test('a trigger that cannot load koffi reports why and never starts', () => {
    const trigger = new KeyTrigger({load: () => { throw new Error('MODULE_NOT_FOUND'); }});
    assert.strictEqual(trigger.start(), false);
    assert.strictEqual(trigger.isAvailable(), false);
    assert.strictEqual(trigger.reason, 'load');
    assert.strictEqual(trigger.running, false);
    // …and the method decision turns that into the polling path.
    assert.deepStrictEqual(
        T.resolveTriggerMethod({mode: 'auto', available: trigger.running && trigger.usable === true,
            reason: trigger.reason}),
        {method: 'polling', reason: 'load'});
});

test('every other way it can fail is reported as its own reason', () => {
    for (const [behaviour, reason] of [
        [{loadThrows: true}, 'bind'],
        [{bindThrows: true}, 'bind'],
        [{callThrows: true}, 'probe']
    ]) {
        const trigger = new KeyTrigger({load: () => fakeKoffi(behaviour)});
        assert.strictEqual(trigger.start(), false, reason);
        assert.strictEqual(trigger.reason, reason, JSON.stringify(behaviour));
    }
    // A koffi-shaped object with no `load` at all.
    const bogus = new KeyTrigger({load: () => ({})});
    assert.strictEqual(bogus.start(), false);
    assert.strictEqual(bogus.reason, 'load');
});

test('a working trigger reads the map key, Alt and the foreground pid', () => {
    const hints = [];
    const trigger = new KeyTrigger({
        load: () => fakeKoffi({keys: {}, foregroundPid: 1234}),
        onHint: (hint, reason) => hints.push({hint, reason}),
        intervalMs: 1000
    });
    assert.strictEqual(trigger.start(), true);
    assert.strictEqual(trigger.isAvailable(), true);
    trigger.setGamePid(1234);
    assert.strictEqual(trigger.isDown(DEFAULT_MAP_VK), false);
    assert.strictEqual(trigger.isGameForeground(), true);
    trigger.setGamePid(9999);
    assert.strictEqual(trigger.isGameForeground(), false, 'a different pid is not the game');
    trigger.setGamePid(null);
    assert.strictEqual(trigger.isGameForeground(), false, 'no known game pid means no');
    trigger.stop();
});

test('the tick turns key state into edges, and honours Alt and the foreground', () => {
    const hints = [];
    const behaviour = {keys: {}, foregroundPid: 42};
    const trigger = new KeyTrigger({
        load: () => fakeKoffi(behaviour),
        onHint: (hint, reason) => hints.push(`${hint}:${reason}`),
        intervalMs: 100000        // never re-arms on its own during the test
    });
    assert.strictEqual(trigger.start(), true);
    trigger.setGamePid(42);

    // Nothing held: no hint.
    trigger.tick();
    assert.deepStrictEqual(hints, []);
    // Tab down, game in front: one down hint.
    behaviour.keys = {[DEFAULT_MAP_VK]: true};
    trigger.tick();
    assert.deepStrictEqual(hints, ['down:down']);
    // Still down: nothing more.
    trigger.tick();
    assert.deepStrictEqual(hints, ['down:down']);
    // Alt joins in (Alt+Tab): it reads as up.
    behaviour.keys = {[DEFAULT_MAP_VK]: true, [VK_MENU]: true};
    trigger.tick();
    assert.deepStrictEqual(hints, ['down:down', 'up:alt']);
    // Alt released, still holding Tab: down again.
    behaviour.keys = {[DEFAULT_MAP_VK]: true};
    trigger.tick();
    assert.deepStrictEqual(hints, ['down:down', 'up:alt', 'down:down']);
    // The game loses the foreground: up — and from here on no key is read at
    // all, which is the promise the README makes.
    behaviour.foregroundPid = 7;
    trigger.tick();
    assert.deepStrictEqual(hints, ['down:down', 'up:alt', 'down:down', 'up:not-foreground']);

    assert.strictEqual(trigger.counters.downs, 2);
    assert.strictEqual(trigger.counters.ups, 2);
    trigger.stop();
});

test('no key is read at all while the game is not the window in front', () => {
    // The ordering *is* the privacy promise: the foreground is asked about
    // first, and `GetAsyncKeyState` is not called unless the answer is the
    // game. Counted rather than asserted on behaviour, because "it happened
    // not to matter" is not the same as "it never happened".
    const asked = [];
    const behaviour = {keys: {}, foregroundPid: 7};
    const koffi = fakeKoffi(behaviour);
    const spying = {
        load(name) {
            const lib = koffi.load(name);
            return {
                func(convention, symbol, ret, args) {
                    const fn = lib.func(convention, symbol, ret, args);
                    if (symbol !== 'GetAsyncKeyState') return fn;
                    return (vk) => { asked.push(vk); return fn(vk); };
                }
            };
        },
        out: koffi.out,
        pointer: koffi.pointer
    };
    const trigger = new KeyTrigger({load: () => spying, intervalMs: 100000});
    trigger.start();
    trigger.setGamePid(42);            // …but the foreground is pid 7.
    asked.length = 0;                  // ignore the one-off probe in `open()`
    trigger.tick();
    trigger.tick();
    assert.deepStrictEqual(asked, [], 'a key was read while the game was not in front');

    // In the game, exactly one key is read per tick while it is up.
    behaviour.foregroundPid = 42;
    trigger.tick();
    assert.deepStrictEqual(asked, [DEFAULT_MAP_VK]);
    // …and Alt only once the map key itself reads as held.
    behaviour.keys = {[DEFAULT_MAP_VK]: true};
    asked.length = 0;
    trigger.tick();
    assert.deepStrictEqual(asked, [DEFAULT_MAP_VK, VK_MENU]);
    trigger.stop();
});

test('a call that starts failing gives up rather than spinning', () => {
    const behaviour = {keys: {}, foregroundPid: 1};
    let unavailable = null;
    const trigger = new KeyTrigger({load: () => fakeKoffi(behaviour), intervalMs: 100000});
    trigger.onUnavailable = (why) => { unavailable = why; };
    assert.strictEqual(trigger.start(), true);
    trigger.setGamePid(1);
    behaviour.callThrows = true;
    trigger.tick();
    assert.strictEqual(trigger.running, false);
    assert.strictEqual(trigger.usable, false);
    assert.strictEqual(trigger.reason, 'call');
    assert.strictEqual(unavailable, 'call');
});

test('changing the watched key clears the remembered state', () => {
    // A key that changes while the old one is held must not leave a stale
    // "down" behind, or the new key's first real press would produce no edge.
    const trigger = new KeyTrigger({load: () => fakeKoffi({keys: {}}), intervalMs: 100000});
    trigger.start();
    trigger.wasDown = true;
    trigger.setMapVk(0x4D);
    assert.strictEqual(trigger.mapVk, 0x4D);
    assert.strictEqual(trigger.wasDown, false);
    // The same key again is not a change, so nothing is reset needlessly.
    trigger.wasDown = true;
    trigger.setMapVk(0x4D);
    assert.strictEqual(trigger.wasDown, true);
    // Something unwatchable falls back to Tab rather than being stored.
    trigger.setMapVk(0x01);
    assert.strictEqual(trigger.mapVk, DEFAULT_MAP_VK);
    trigger.stop();
});

test('stopping forgets a held key, so restarting sees a fresh press', () => {
    const trigger = new KeyTrigger({load: () => fakeKoffi({keys: {}}), intervalMs: 100000});
    trigger.start();
    trigger.wasDown = true;
    trigger.stop();
    assert.strictEqual(trigger.wasDown, false);
    assert.strictEqual(trigger.running, false);
});

test('status is counters and one reason — never anything about a key', () => {
    const trigger = new KeyTrigger({load: () => fakeKoffi({keys: {}}), intervalMs: 100000});
    trigger.start();
    const status = trigger.status();
    assert.deepStrictEqual(Object.keys(status).sort(),
        ['available', 'downs', 'errors', 'intervalMs', 'pad', 'polls', 'reason', 'running', 'ups', 'vk'].sort());
    // The only key-ish thing it reports is the one code the user configured.
    assert.strictEqual(status.vk, DEFAULT_MAP_VK);
    assert.strictEqual(status.available, true);
    // …and the same for the controller: its one code, availability, counters.
    assert.deepStrictEqual(Object.keys(status.pad).sort(),
        ['available', 'code', 'errors', 'reads', 'reason', 'scans', 'slot'].sort());
    assert.strictEqual(status.pad.code, null);
    assert.strictEqual(status.pad.available, null, 'no button set: the pad path is never tried');
    trigger.stop();
});

/* ────────────────────────────────────────────────────────────────────────────
 * The controller button — the map key's second input
 * ──────────────────────────────────────────────────────────────────────────── */

const VIEW = 0x0020;
const A_BUTTON = 0x1000;

test('with no button set the controller is never opened, let alone read', () => {
    const behaviour = {keys: {}, foregroundPid: 1, pads: {0: {wButtons: 0xFFFF}}};
    const trigger = new KeyTrigger({load: () => fakeKoffi(behaviour), intervalMs: 100000});
    trigger.start();
    trigger.setGamePid(1);
    trigger.tick();
    trigger.tick();
    assert.strictEqual(behaviour.xinputCalls, undefined, 'XInput was called with no button configured');
    assert.strictEqual(trigger.pad.usable, null);
    trigger.stop();
});

test('a controller button held in the game is a down edge, released an up edge', () => {
    const hints = [];
    const behaviour = {keys: {}, foregroundPid: 1, pads: {0: {wButtons: 0}}};
    const trigger = new KeyTrigger({
        load: () => fakeKoffi(behaviour),
        onHint: (hint, reason) => hints.push(`${hint}:${reason}`),
        mapPad: VIEW,
        intervalMs: 100000
    });
    const lines = [];
    trigger.logLine = (event, fields) => lines.push(Object.assign({event}, fields));
    assert.strictEqual(trigger.start(), true);
    assert.strictEqual(trigger.pad.usable, true, 'probed at start because a button is set');
    trigger.setGamePid(1);
    trigger.tick();
    assert.deepStrictEqual(hints, []);
    behaviour.pads[0].wButtons = VIEW;
    trigger.tick();
    assert.deepStrictEqual(hints, ['down:down']);
    trigger.tick();
    assert.deepStrictEqual(hints, ['down:down'], 'held: no second edge');
    // Another button is not the map button.
    behaviour.pads[0].wButtons = A_BUTTON;
    trigger.tick();
    assert.deepStrictEqual(hints, ['down:down', 'up:up']);
    // The log names the source of a down edge and nothing else about the pad.
    assert.deepStrictEqual(lines[0], {event: 'tab-key', state: 'down', reason: 'down', source: 'pad'});
    assert.deepStrictEqual(lines[1], {event: 'tab-key', state: 'up', reason: 'up'});
    assert.strictEqual(trigger.wasDown, false);
    trigger.stop();
});

test('the keyboard and the controller are one input: either holds the markers up', () => {
    const hints = [];
    const behaviour = {keys: {}, foregroundPid: 1, pads: {0: {wButtons: 0}}};
    const trigger = new KeyTrigger({
        load: () => fakeKoffi(behaviour),
        onHint: (hint) => hints.push(hint),
        mapPad: VIEW,
        intervalMs: 100000
    });
    trigger.start();
    trigger.setGamePid(1);
    behaviour.keys = {[DEFAULT_MAP_VK]: true};
    trigger.tick();
    assert.deepStrictEqual(hints, ['down']);
    // The pad joins in, the key lets go: still down, no edge.
    behaviour.pads[0].wButtons = VIEW;
    trigger.tick();
    behaviour.keys = {};
    trigger.tick();
    assert.deepStrictEqual(hints, ['down']);
    // Alt while holding the pad button is not Alt+Tab.
    behaviour.keys = {[VK_MENU]: true};
    trigger.tick();
    assert.deepStrictEqual(hints, ['down']);
    // Everything released: one up.
    behaviour.pads[0].wButtons = 0;
    behaviour.keys = {};
    trigger.tick();
    assert.deepStrictEqual(hints, ['down', 'up']);
    trigger.stop();
});

test('the controller is read only in the game, after the key, and one slot per tick', () => {
    const behaviour = {keys: {}, foregroundPid: 7, pads: {2: {wButtons: 0}}};
    const trigger = new KeyTrigger({load: () => fakeKoffi(behaviour), mapPad: VIEW, intervalMs: 100000});
    trigger.start();
    trigger.setGamePid(1);                // the game is not in front (pid 7)
    behaviour.xinputCalls = [];
    trigger.tick();
    trigger.tick();
    assert.deepStrictEqual(behaviour.xinputCalls, [], 'the pad was read while the game was not in front');
    // In the game: the first reading scans the slots and stops at the pad.
    behaviour.foregroundPid = 1;
    trigger.tick();
    assert.deepStrictEqual(behaviour.xinputCalls, [0, 1, 2]);
    assert.strictEqual(trigger.pad.slot, 2);
    // From then on, one call per tick, to that slot.
    behaviour.xinputCalls = [];
    trigger.tick();
    trigger.tick();
    assert.deepStrictEqual(behaviour.xinputCalls, [2, 2]);
    trigger.stop();
});

test('with no controller plugged in the slots are scanned at the slow cadence', () => {
    let now = 0;
    const behaviour = {keys: {}, foregroundPid: 1, pads: {}};
    const trigger = new KeyTrigger({
        load: () => fakeKoffi(behaviour), mapPad: VIEW, intervalMs: 100000, now: () => now
    });
    trigger.start();
    trigger.setGamePid(1);
    behaviour.xinputCalls = [];
    trigger.tick();
    assert.deepStrictEqual(behaviour.xinputCalls, [0, 1, 2, 3], 'one full scan');
    now += 30;
    trigger.tick();
    now += 30;
    trigger.tick();
    assert.deepStrictEqual(behaviour.xinputCalls, [0, 1, 2, 3], 'no scan inside the interval');
    now += T.PAD_SCAN_INTERVAL;
    trigger.tick();
    assert.deepStrictEqual(behaviour.xinputCalls, [0, 1, 2, 3, 0, 1, 2, 3]);
    assert.strictEqual(trigger.pad.counters.scans, 2);
    // A pad plugged into slot 1 is found on the next scan and then read alone.
    behaviour.pads[1] = {wButtons: VIEW};
    now += T.PAD_SCAN_INTERVAL;
    const hints = [];
    trigger.onHint = (hint) => hints.push(hint);
    trigger.tick();
    assert.strictEqual(trigger.pad.slot, 1);
    assert.deepStrictEqual(hints, ['down']);
    // Unplugged: this tick reads as up and the scan starts again.
    delete behaviour.pads[1];
    trigger.tick();
    assert.deepStrictEqual(hints, ['down', 'up']);
    assert.strictEqual(trigger.pad.slot, null);
    trigger.stop();
});

test('a controller path that fails is the pad\'s failure alone: the key still works', () => {
    for (const [behaviour, reason] of [
        [{xinputMissing: true}, 'bind'],
        [{xinputBindThrows: true}, 'bind']
    ]) {
        const hints = [];
        const b = Object.assign({keys: {}, foregroundPid: 1}, behaviour);
        const trigger = new KeyTrigger({
            load: () => fakeKoffi(b), onHint: (hint) => hints.push(hint), mapPad: VIEW, intervalMs: 100000
        });
        assert.strictEqual(trigger.start(), true, reason);
        assert.strictEqual(trigger.pad.usable, false);
        assert.strictEqual(trigger.pad.reason, reason);
        assert.strictEqual(trigger.status().pad.available, false);
        trigger.setGamePid(1);
        b.keys = {[DEFAULT_MAP_VK]: true};
        trigger.tick();
        assert.deepStrictEqual(hints, ['down'], 'the keyboard half must be untouched');
        trigger.stop();
    }
    // A call that starts throwing stops the pad, not the loop.
    const b = {keys: {}, foregroundPid: 1, pads: {0: {wButtons: 0}}};
    const trigger = new KeyTrigger({load: () => fakeKoffi(b), mapPad: VIEW, intervalMs: 100000});
    trigger.start();
    trigger.setGamePid(1);
    b.xinputCallThrows = true;
    trigger.tick();
    assert.strictEqual(trigger.running, true);
    assert.strictEqual(trigger.pad.usable, false);
    assert.strictEqual(trigger.pad.reason, 'call');
    b.xinputCalls = [];
    trigger.tick();
    assert.deepStrictEqual(b.xinputCalls, [], 'a broken pad path is not retried every tick');
    trigger.stop();
});

test('setting or clearing the button forgets a held state and re-scans', () => {
    const behaviour = {keys: {}, foregroundPid: 1, pads: {3: {wButtons: 0}}};
    const trigger = new KeyTrigger({load: () => fakeKoffi(behaviour), intervalMs: 100000});
    trigger.start();
    assert.strictEqual(trigger.mapPad, null);
    trigger.setMapPad(VIEW);
    assert.strictEqual(trigger.mapPad, VIEW);
    assert.strictEqual(trigger.pad.usable, true, 'probed the moment a button is set');
    trigger.wasDown = true;
    trigger.pad.slot = 3;
    trigger.setMapPad(A_BUTTON);
    assert.strictEqual(trigger.wasDown, false);
    assert.strictEqual(trigger.pad.slot, null);
    trigger.setMapPad(A_BUTTON);
    trigger.wasDown = true;
    assert.strictEqual(trigger.wasDown, true, 'the same button again resets nothing');
    // Junk clears the button rather than storing it.
    trigger.setMapPad(0x0400);
    assert.strictEqual(trigger.mapPad, null);
    assert.strictEqual(trigger.wasDown, false);
    trigger.stop();
});

test('recording waits for exactly one button on any pad and answers with its label', async () => {
    const behaviour = {keys: {}, pads: {1: {wButtons: 0}}};
    const trigger = new KeyTrigger({load: () => fakeKoffi(behaviour), intervalMs: 100000});
    const pending = trigger.recordPad({timeoutMs: 2000, intervalMs: 5});
    assert.ok(trigger.recording, 'a recording is in flight');
    await new Promise(r => setTimeout(r, 20));
    // Two buttons at once is a hand on its way: keep waiting.
    behaviour.pads[1].wButtons = VIEW | A_BUTTON;
    await new Promise(r => setTimeout(r, 20));
    assert.ok(trigger.recording, 'two buttons did not end the recording');
    behaviour.pads[1].wButtons = VIEW;
    const result = await pending;
    assert.deepStrictEqual(result, {ok: true, code: VIEW, label: 'View / Share'});
    assert.strictEqual(trigger.recording, null);
    // The recorder is the one place the pad is read outside the game: no pid
    // was ever set here, and it still answered.
});

test('recording gives up with a reason: no controller, no press, or no XInput', async () => {
    const none = new KeyTrigger({load: () => fakeKoffi({keys: {}, pads: {}}), intervalMs: 100000});
    assert.deepStrictEqual(await none.recordPad({timeoutMs: 30, intervalMs: 5}), {ok: false, reason: 'no-controller'});

    const idle = new KeyTrigger({load: () => fakeKoffi({keys: {}, pads: {0: {wButtons: 0}}}), intervalMs: 100000});
    assert.deepStrictEqual(await idle.recordPad({timeoutMs: 30, intervalMs: 5}), {ok: false, reason: 'timeout'});

    const broken = new KeyTrigger({load: () => fakeKoffi({keys: {}, xinputMissing: true}), intervalMs: 100000});
    assert.deepStrictEqual(await broken.recordPad({timeoutMs: 30, intervalMs: 5}), {ok: false, reason: 'unavailable'});

    // Cancelled from the renderer (a click elsewhere, Esc): its own reason.
    const cancelled = new KeyTrigger({load: () => fakeKoffi({keys: {}, pads: {0: {wButtons: 0}}}), intervalMs: 100000});
    const pending = cancelled.recordPad({timeoutMs: 2000, intervalMs: 5});
    assert.strictEqual(cancelled.cancelPadRecording('cancelled'), true);
    assert.deepStrictEqual(await pending, {ok: false, reason: 'cancelled'});
    assert.strictEqual(cancelled.cancelPadRecording(), false, 'nothing left to cancel');

    // A second recording replaces the first rather than racing it.
    const twice = new KeyTrigger({load: () => fakeKoffi({keys: {}, pads: {0: {wButtons: 0}}}), intervalMs: 100000});
    const first = twice.recordPad({timeoutMs: 2000, intervalMs: 5});
    const second = twice.recordPad({timeoutMs: 30, intervalMs: 5});
    assert.deepStrictEqual(await first, {ok: false, reason: 'replaced'});
    assert.deepStrictEqual(await second, {ok: false, reason: 'timeout'});
});
