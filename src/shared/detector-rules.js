/**
 * PURE rules shared by the detector loop (main) and the map switcher (renderer).
 *
 * Nothing here touches electron, `fs` or a timer — it is the half of the
 * detector's behaviour that can be unit tested, and both processes read the
 * same numbers from it so a cadence documented in one place cannot drift in
 * the other.
 */

/**
 * Poll period **while the game window exists**.
 *
 * The player holds Tab for one to two seconds. At the old 2000 ms search
 * cadence (and 5000 ms once a map had been recognised) a whole Tab press
 * regularly fell between two ticks, so the switch either did not happen or
 * arrived so late the player had already picked the map by hand — which is
 * exactly what the 0.3.0 field report said.
 *
 * 700 ms puts at least two ticks inside the shortest realistic Tab press. The
 * cost is measured, not guessed: the capture itself is ~17 ms of *async native*
 * work that does not block the event loop, and the JS that does block is the
 * ~6-11 ms `toGrayScaled` pass plus a sub-millisecond match. ~8 ms of blocking
 * JS every 700 ms is ~1-2 % of one core.
 *
 * There is deliberately **no** slower post-detection cadence any more: a match
 * can change map (a manual pick, a new match starting) and the whole point of
 * the feature is that the next Tab press is acted on.
 */
const GAME_INTERVAL = 700;

/**
 * Poll period while there is **no** game window.
 *
 * That path costs one `Window.all()` enumeration — 0.2 ms — and does not
 * capture anything, so leaving the switch on while the game is closed stays
 * free at 2 s.
 */
const IDLE_INTERVAL = 2000;

/**
 * Consecutive menu-matching ticks before the overlay is cleared.
 *
 * Two was tuned for the old 5000 ms post-detection cadence (10 s of menu).
 * With ticks every 700 ms two would be 1.4 s, which a loading screen sweeping
 * past the menu layout could plausibly cover; three is ~2.1 s of *steady* menu
 * and still clears the overlay well inside the time it takes a player to click
 * through to the next match.
 */
const MENU_TICKS_TO_HIDE = 3;

/**
 * Minimum gap between two `show-map-command` messages **for the same key**.
 *
 * At 700 ms a held Tab press produces two or three accepted matches in a row.
 * Main no longer suppresses them by comparing against `lastDetected` (that is
 * what broke re-applying a map after a manual pick — see `shouldApplyDetected`),
 * so this throttle is what keeps a held Tab from spamming IPC. It is cheap and
 * it is not a correctness gate: the renderer is the judge of whether anything
 * actually changes.
 */
const SEND_THROTTLE = 2000;

/**
 * How long a tick may take before it is worth a log line of its own. Purely a
 * diagnostics threshold; it changes no behaviour.
 */
const SLOW_TICK_MS = 100;

/**
 * The delay before the next tick.
 * @param {boolean} gameWindowPresent whether this tick found the game window
 * @returns {number} milliseconds
 */
function tickInterval(gameWindowPresent) {
    return gameWindowPresent ? GAME_INTERVAL : IDLE_INTERVAL;
}

/**
 * Has enough time passed since the last send of this key?
 * @param {?number} lastSentAt epoch ms of the previous send, or null/undefined
 * @param {number} now epoch ms
 * @param {number} [window] throttle window in ms
 * @returns {boolean}
 */
function throttleAllows(lastSentAt, now, window = SEND_THROTTLE) {
    if (lastSentAt === null || lastSentAt === undefined) return true;
    return now - lastSentAt >= window;
}

/**
 * Should the renderer act on a detected map?
 *
 * This is the comparison that used to live in main as
 * `match.key !== this.lastDetected`, and being in main is what made it wrong:
 * after the player picked another map by hand, `lastDetected` still held the
 * detected map, so the next Tab press on that same map looked like "no change"
 * and the overlay was never put back. Only the renderer knows what is on the
 * overlay right now (`Maps.currentKey`), so only the renderer can answer this.
 *
 * @param {?string} currentKey the key the overlay is showing ("" when hidden)
 * @param {?string} key the detected key
 * @returns {boolean} true when the overlay should be switched
 */
function shouldApplyDetected(currentKey, key) {
    if (!key) return false;
    return (currentKey || '') !== key;
}

/**
 * Per-key send throttle. A plain object of key → last send time; `allow()`
 * records the send when it returns true, so callers cannot forget to.
 */
class SendThrottle {

    /** @param {number} [window] throttle window in ms */
    constructor(window = SEND_THROTTLE) {
        this.window = window;
        this.sentAt = new Map();
    }

    /**
     * @param {string} key
     * @param {number} [now] epoch ms
     * @returns {boolean} true when the caller may send, and the send is recorded
     */
    allow(key, now = Date.now()) {
        if (!throttleAllows(this.sentAt.get(key), now, this.window)) return false;
        this.sentAt.set(key, now);
        return true;
    }

    /** Forget every key, so the very next match is sent immediately. */
    reset() {
        this.sentAt.clear();
    }
}

module.exports = {
    GAME_INTERVAL,
    IDLE_INTERVAL,
    MENU_TICKS_TO_HIDE,
    SEND_THROTTLE,
    SLOW_TICK_MS,
    tickInterval,
    throttleAllows,
    shouldApplyDetected,
    SendThrottle
};
