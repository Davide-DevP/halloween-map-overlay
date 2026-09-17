const {test} = require('node:test');
const assert = require('node:assert');

const {
    GAME_INTERVAL, IDLE_INTERVAL, MENU_TICKS_TO_HIDE, SEND_THROTTLE,
    tickInterval, throttleAllows, shouldApplyDetected, SendThrottle
} = require('../src/shared/detector-rules');

/* ────────────────────────────────────────────────────────────────────────────
 * Cadence
 *
 * The numbers themselves are asserted, not just their relationship: the whole
 * 0.3.1 fix is "a Tab press lasts 1-2 s, so ticks have to be well under that",
 * and a later edit that quietly doubled the interval would otherwise pass.
 * ──────────────────────────────────────────────────────────────────────────── */

test('the cadence is fast enough for a 1 s Tab press', () => {
    assert.strictEqual(GAME_INTERVAL, 700);
    // At least two ticks inside the shortest realistic Tab press.
    assert.ok(GAME_INTERVAL * 2 <= 1500, `${GAME_INTERVAL} ms is too slow`);
});

test('no game window keeps the cheap 2 s cadence', () => {
    assert.strictEqual(IDLE_INTERVAL, 2000);
    assert.ok(IDLE_INTERVAL > GAME_INTERVAL);
});

test('tickInterval follows the game window and nothing else', () => {
    assert.strictEqual(tickInterval(true), GAME_INTERVAL);
    assert.strictEqual(tickInterval(false), IDLE_INTERVAL);
    // No third state: there is deliberately no slower post-detection cadence.
    assert.strictEqual(tickInterval(1), GAME_INTERVAL);
    assert.strictEqual(tickInterval(null), IDLE_INTERVAL);
    assert.strictEqual(tickInterval(undefined), IDLE_INTERVAL);
});

test('the menu streak is three ticks, i.e. about two seconds of steady menu', () => {
    assert.strictEqual(MENU_TICKS_TO_HIDE, 3);
    const seconds = (MENU_TICKS_TO_HIDE * GAME_INTERVAL) / 1000;
    // Long enough that a loading screen sweeping past the menu cannot do it,
    // short enough that the player is not left with a stale map.
    assert.ok(seconds >= 2 && seconds <= 4, `${seconds}s`);
});

/* ────────────────────────────────────────────────────────────────────────────
 * Send throttle
 * ──────────────────────────────────────────────────────────────────────────── */

test('throttleAllows: the first send of a key always goes out', () => {
    assert.strictEqual(throttleAllows(null, 1000), true);
    assert.strictEqual(throttleAllows(undefined, 1000), true);
});

test('throttleAllows: a repeat inside the window is dropped', () => {
    assert.strictEqual(throttleAllows(1000, 1000 + SEND_THROTTLE - 1), false);
    assert.strictEqual(throttleAllows(1000, 1000 + SEND_THROTTLE), true);
    assert.strictEqual(throttleAllows(1000, 1000 + SEND_THROTTLE + 1), true);
});

test('SendThrottle: a held Tab sends once, not once per tick', () => {
    const throttle = new SendThrottle();
    const key = 'deftyconchgaming/East Haddonfield';
    // A 2 s Tab press at 700 ms is three accepted matches.
    assert.strictEqual(throttle.allow(key, 0), true);
    assert.strictEqual(throttle.allow(key, 700), false);
    assert.strictEqual(throttle.allow(key, 1400), false);
    // ...and the next press, a match later, goes out again.
    assert.strictEqual(throttle.allow(key, 1400 + SEND_THROTTLE), true);
});

test('SendThrottle: the window is per key, so a real map change is never delayed', () => {
    const throttle = new SendThrottle();
    assert.strictEqual(throttle.allow('a/One', 0), true);
    // A different map in the same instant is a genuine switch.
    assert.strictEqual(throttle.allow('a/Two', 0), true);
    assert.strictEqual(throttle.allow('a/One', 10), false);
});

test('SendThrottle: reset forgets everything (clear-map, menu clear)', () => {
    const throttle = new SendThrottle();
    assert.strictEqual(throttle.allow('a/One', 0), true);
    assert.strictEqual(throttle.allow('a/One', 10), false);
    throttle.reset();
    assert.strictEqual(throttle.allow('a/One', 20), true);
});

test('SendThrottle: the window is configurable and honoured', () => {
    const throttle = new SendThrottle(100);
    assert.strictEqual(throttle.allow('a/One', 0), true);
    assert.strictEqual(throttle.allow('a/One', 99), false);
    assert.strictEqual(throttle.allow('a/One', 100), true);
});

/* ────────────────────────────────────────────────────────────────────────────
 * The renderer's decision
 *
 * This is the 0.3.0 bug: main compared against the map it last *recognised*,
 * not against the map on the overlay, so a manual pick was never undone.
 * ──────────────────────────────────────────────────────────────────────────── */

test('shouldApplyDetected: a map that is already showing is ignored', () => {
    assert.strictEqual(shouldApplyDetected('a/One', 'a/One'), false);
});

test('shouldApplyDetected: the same map after a manual pick IS applied', () => {
    // The player detected One, then picked Two by hand; Tab shows One again.
    // Main's `lastDetected` is still One, which is exactly why main cannot be
    // the one to decide.
    assert.strictEqual(shouldApplyDetected('a/Two', 'a/One'), true);
});

test('shouldApplyDetected: a hidden overlay is switched to', () => {
    assert.strictEqual(shouldApplyDetected('', 'a/One'), true);
    assert.strictEqual(shouldApplyDetected(null, 'a/One'), true);
    assert.strictEqual(shouldApplyDetected(undefined, 'a/One'), true);
});

test('shouldApplyDetected: no key is never applied', () => {
    assert.strictEqual(shouldApplyDetected('a/One', ''), false);
    assert.strictEqual(shouldApplyDetected('a/One', null), false);
    assert.strictEqual(shouldApplyDetected('', null), false);
});
