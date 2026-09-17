const {test} = require('node:test');
const assert = require('node:assert');

const {
    GAME_INTERVAL, IDLE_INTERVAL, MENU_TICKS_TO_HIDE, SEND_THROTTLE,
    tickInterval, throttleAllows, shouldApplyDetected, shouldWatchMenu,
    MenuStreak, SendThrottle
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

/* ────────────────────────────────────────────────────────────────────────────
 * The menu gate (0.3.3)
 *
 * This is the second half of the same lesson: main must judge what is on the
 * overlay, not what main itself last recognised. In the owner's 0.3.2 log the
 * party matcher accepted nothing, the maps were picked by hand, and because
 * `lastDetected` stayed null the menu matcher never ran once — the overlay was
 * never cleared for the rest of the session.
 * ──────────────────────────────────────────────────────────────────────────── */

test('shouldWatchMenu: a map on the overlay is watched, an empty one is not', () => {
    assert.strictEqual(shouldWatchMenu('a/One', true), true);
    assert.strictEqual(shouldWatchMenu('', true), false);
    assert.strictEqual(shouldWatchMenu(null, true), false);
    assert.strictEqual(shouldWatchMenu(undefined, true), false);
});

test('shouldWatchMenu: a hand-picked map is watched exactly like a detected one', () => {
    // The whole fix: nothing here knows or cares who set the map. Main gets
    // this key from the renderer, which is the only process that knows.
    assert.strictEqual(shouldWatchMenu('Custom/My Map', undefined), true);
});

test('shouldWatchMenu: only an explicit false turns the feature off', () => {
    assert.strictEqual(shouldWatchMenu('a/One', false), false);
    // A settings file written before `hideInMenu` existed keeps the default.
    assert.strictEqual(shouldWatchMenu('a/One', undefined), true);
    assert.strictEqual(shouldWatchMenu('a/One', null), true);
});

/* ────────────────────────────────────────────────────────────────────────────
 * The menu streak and its transition rule
 *
 * Three menu frames in a row are not enough on their own: the game has to have
 * been seen *away* from the menu since the current map went up. Otherwise a map
 * picked by hand while the menu is on screen — the obvious moment to pick one —
 * is taken away 2.1 s later, and again after the next pick (VERIFICATION-6,
 * finding 2).
 * ──────────────────────────────────────────────────────────────────────────── */

/** Feed n frames of one kind; returns how many of them asked for a clear. */
function feed(streak, isMenu, n) {
    let cleared = 0;
    for (let i = 0; i < n; i++) if (streak.note(isMenu).clear) cleared++;
    return cleared;
}

test('MenuStreak: a map picked while the menu is up is never cleared', () => {
    const streak = new MenuStreak();
    streak.noteShown();                       // the pick happened in the menu
    assert.strictEqual(feed(streak, true, 20), 0, 'the hand-picked map was cleared');
    // And the ticks are not silently accumulating behind the scenes.
    assert.strictEqual(streak.ticks, 0);
    assert.strictEqual(streak.note(true).waiting, true);
});

test('MenuStreak: a match then the menu clears after exactly three ticks', () => {
    const streak = new MenuStreak();
    streak.noteShown();
    streak.noteMatch();                       // a Tab screen: definitely not the menu
    assert.strictEqual(streak.note(true).clear, false);
    assert.strictEqual(streak.note(true).clear, false);
    const third = streak.note(true);
    assert.strictEqual(third.clear, true);
    assert.strictEqual(third.ticks, MENU_TICKS_TO_HIDE);
});

test('MenuStreak: gameplay frames alone unlock the clear', () => {
    const streak = new MenuStreak();
    streak.noteShown();
    // A gated-out frame that is not the menu: ordinary gameplay.
    assert.strictEqual(streak.note(false).clear, false);
    assert.strictEqual(feed(streak, true, MENU_TICKS_TO_HIDE), 1);
});

test('MenuStreak: pick in the menu, leave, come back — now it clears', () => {
    const streak = new MenuStreak();
    streak.noteShown();
    assert.strictEqual(feed(streak, true, 5), 0, 'cleared before the game ever left the menu');
    streak.note(false);                       // the match started
    assert.strictEqual(feed(streak, true, MENU_TICKS_TO_HIDE), 1, 'did not clear on the way back');
});

test('MenuStreak: the three ticks have to be consecutive', () => {
    const streak = new MenuStreak();
    streak.noteShown();
    streak.noteMatch();
    assert.strictEqual(streak.note(true).ticks, 1);
    assert.strictEqual(streak.note(true).ticks, 2);
    // A loading screen sweeping past the menu layout.
    const broken = streak.note(false);
    assert.strictEqual(broken.broke, true);
    assert.strictEqual(broken.clear, false);
    assert.strictEqual(streak.note(true).ticks, 1);
    assert.strictEqual(feed(streak, true, MENU_TICKS_TO_HIDE - 1), 1);
});

test('MenuStreak: a new map revokes the right to clear until the game moves', () => {
    const streak = new MenuStreak();
    streak.noteShown();
    streak.noteMatch();
    assert.strictEqual(streak.note(true).ticks, 1);
    // The player picks another map by hand, two ticks into the streak.
    streak.noteShown();
    assert.strictEqual(feed(streak, true, 10), 0, 'the new pick was cleared by the old streak');
});

test('MenuStreak: reset forgets the streak and the transition', () => {
    const streak = new MenuStreak();
    streak.noteMatch();
    streak.note(true);
    streak.reset();
    assert.strictEqual(streak.ticks, 0);
    assert.strictEqual(streak.sawNonMenu, false);
    assert.strictEqual(feed(streak, true, 10), 0);
});

test('MenuStreak: the tick count is configurable and honoured', () => {
    const streak = new MenuStreak(2);
    streak.noteMatch();
    assert.strictEqual(streak.note(true).clear, false);
    assert.strictEqual(streak.note(true).clear, true);
});
