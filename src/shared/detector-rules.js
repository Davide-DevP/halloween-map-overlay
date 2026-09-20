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
 * Minimum gap between two offers of the **same key** to the map controller.
 *
 * At 700 ms a held Tab press produces two or three accepted matches in a row.
 * The loop does not suppress them by comparing against `lastDetected` (that is
 * what broke re-applying a map after a manual pick — see `shouldApplyDetected`),
 * so this throttle is what keeps a held Tab from spamming the controller. It is
 * cheap and it is **not** a correctness gate: the map state is the judge of
 * whether anything actually changes.
 */
const SEND_THROTTLE = 2000;

/**
 * How long a tick may take before it is worth a log line of its own. Purely a
 * diagnostics threshold; it changes no behaviour.
 */
const SLOW_TICK_MS = 100;

/**
 * The delay before the next tick.
 *
 * `gameMs` overrides `GAME_INTERVAL` for callers that have a reason to poll
 * faster while the game is up — today the only one is Tab-map mode, which
 * shortens it to `DETECT_INTERVAL` (450 ms) **while that mode is running**,
 * because 700 ms is what decides how long its markers take to appear. The
 * override is an argument rather than a second constant here so this module
 * stays the one place a cadence is written down, and so the idle cadence (which
 * costs one 0.2 ms enumeration and captures nothing) is not affected at all.
 *
 * @param {boolean} gameWindowPresent whether this tick found the game window
 * @param {{gameMs?: ?number}} [opts]
 * @returns {number} milliseconds
 */
function tickInterval(gameWindowPresent, opts) {
    if (!gameWindowPresent) return IDLE_INTERVAL;
    const override = opts && opts.gameMs;
    return typeof override === 'number' && Number.isFinite(override) && override > 0
        ? override : GAME_INTERVAL;
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
 * Should a detected map be acted on?
 *
 * This is the comparison that used to live inside the detector loop as
 * `match.key !== this.lastDetected`, and *that* is what made it wrong: after
 * the player picked another map by hand, `lastDetected` still held the detected
 * map, so the next Tab press on that same map looked like "no change" and the
 * overlay was never put back. The question can only be answered by whoever
 * knows what is on the overlay right now — the *map state*, which is
 * `shared/map-state.js` in the main process since 0.7 (and `src/js/maps.js` in
 * the main window's renderer before that). The rule itself never changed.
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
 * Should this tick run the main-menu matcher at all?
 *
 * Two conditions, and the second is the 0.3.2 bug. The check used to be gated
 * on the detector's own `lastDetected` — "did *I* recognise a map in this
 * match?" — so a match whose map the player set by hand (because the matcher
 * accepted nothing; see the party case in `matcher.js`) was never cleared when
 * the game went back to the menu. The owner's field log shows it exactly: after
 * the manual picks, not one `menu-streak` line for the rest of the evening.
 *
 * What matters is whether **a map is on the overlay**, whoever put it there.
 * `core/map-controller.js` reports that to the loop (`noteShown`) after every
 * change; up to 0.7 it was the main window's renderer doing it over
 * `map-detector-shown`, and the rule is unchanged by the move.
 *
 * @param {?string} shownKey the key the overlay is showing (""/null = hidden)
 * @param {*} hideInMenu the `hideInMenu` setting; only an explicit `false`
 *   turns the feature off, so a settings file written before it existed still
 *   behaves like the default.
 * @returns {boolean}
 */
function shouldWatchMenu(shownKey, hideInMenu) {
    if (hideInMenu === false) return false;
    return !!shownKey;
}

/**
 * The menu-clear streak, with the transition rule that keeps it honest.
 *
 * Counting three consecutive menu frames is only half of it. The other half is
 * *when the counting may start*: the overlay may be cleared only if the game
 * has been seen **away from the menu** since the current map went up. Without
 * that, a map picked by hand while the main menu is already on screen — the
 * obvious moment to pick one, between matches — is taken away again ~2.1 s
 * later, and again after the next pick, for as long as the menu is up
 * (VERIFICATION-6, finding 2).
 *
 * So `sawNonMenu` is false whenever a new map appears on the overlay, any
 * non-menu frame sets it, and only then can menu frames accumulate. The three
 * cases, all tested:
 *   - pick while in the menu        → menu frames never count      → no clear
 *   - match, then back to the menu  → gameplay set the flag        → clear
 *   - pick in the menu, leave, come back → leaving set the flag    → clear
 *
 * Pure: it holds two integers' worth of state and no timers, so the loop's
 * "should the overlay be cleared now?" question is unit testable.
 */
class MenuStreak {

    /** @param {number} [ticksToHide] consecutive menu frames required */
    constructor(ticksToHide = MENU_TICKS_TO_HIDE) {
        this.ticksToHide = ticksToHide;
        this.ticks = 0;
        this.sawNonMenu = false;
    }

    /**
     * A different map (or nothing) is on the overlay now. The streak restarts
     * and, above all, the game has to be seen outside the menu again before
     * anything may be cleared.
     */
    noteShown() {
        this.ticks = 0;
        this.sawNonMenu = false;
    }

    /**
     * A Tab screen with an accepted map: proof the player is in a match, which
     * is as non-menu as a frame gets.
     */
    noteMatch() {
        this.ticks = 0;
        this.sawNonMenu = true;
    }

    /** Forget everything (loop stop, clear-map, a menu clear just fired). */
    reset() {
        this.ticks = 0;
        this.sawNonMenu = false;
    }

    /**
     * One frame that failed the Tab-screen gate.
     *
     * @param {boolean} isMenu did it match the main-menu strip?
     * @returns {{ticks: number, clear: boolean, broke: boolean, waiting: boolean}}
     *   `clear` is the only verdict; `ticks` and `broke` are for the log, and
     *   `waiting` means "this was the menu, but the map went up in the menu, so
     *   it does not count".
     */
    note(isMenu) {
        if (!isMenu) {
            const broke = this.ticks > 0;
            this.ticks = 0;
            this.sawNonMenu = true;
            return {ticks: 0, clear: false, broke, waiting: false};
        }
        if (!this.sawNonMenu) return {ticks: 0, clear: false, broke: false, waiting: true};
        this.ticks++;
        const clear = this.ticks >= this.ticksToHide;
        if (clear) this.ticks = 0;
        return {ticks: clear ? this.ticksToHide : this.ticks, clear, broke: false, waiting: false};
    }
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

/*
 * ─── Which window is the game ───────────────────────────────────────────────
 *
 * Extracted from `map-detector.js` so the detector loop and the foreground
 * watcher (`core/foreground.js`, which decides whether the global hotkeys
 * should be registered) cannot come to different conclusions about what the
 * game's window is. The property *reads* stay in the impure callers — a
 * `node-screenshots` Window can disappear between the enumeration and the
 * read, which is a try/catch, not a rule — and this half is the decision.
 */

/**
 * The game, matched on the window's **app name** — which comes from the
 * running executable (`Halloween.exe` → "Halloween"), not from whatever the
 * window happens to be displaying.
 *
 * Deliberately not the title: titles produce false positives constantly. On the
 * machine this was developed on, a terminal window called "Halloween The Game
 * mappe" (the project folder) and any browser tab about the game would both
 * match `/halloween/i` on the title while having app names "Windows Terminal
 * Host" and "Floorp". The title is only consulted when the app name is empty,
 * i.e. when the OS would not tell us what owns the window.
 */
const GAME_NAME = /halloween/i;

/** This app's own windows — the main one matches GAME_NAME too. */
const OWN_NAME = /map\s*overlay/i;

/** A window this small cannot be the game; skip splash/tooltip windows. */
const MIN_WINDOW = {width: 320, height: 240};

/**
 * How one enumerated window relates to us.
 *
 * @param {{appName?: string, title?: string, minimized?: boolean, width?: number, height?: number, pid?: number}} info
 * @param {number} ownPid this process's pid
 * @returns {'own'|'game'|'game-maybe'|'other'}
 *   `game` is an exact `Halloween` / `Halloween.exe` app name, `game-maybe` a
 *   looser match that only wins if nothing exact turns up.
 */
function classifyWindow(info, ownPid) {
    const w = info || {};
    const appName = typeof w.appName === 'string' ? w.appName.trim() : '';
    const title = typeof w.title === 'string' ? w.title.trim() : '';
    // Our own windows first: the main window is literally called "Halloween
    // Map Overlay", so both the pid and the name test are needed — the name
    // catches a window of ours the pid check cannot see, the pid catches one
    // somebody renamed.
    if (w.pid !== undefined && w.pid === ownPid) return 'own';
    if (OWN_NAME.test(`${appName} ${title}`)) return 'own';
    // Windows hands back a stale or empty image for a minimized window, and a
    // minimized window is not in the foreground either.
    if (w.minimized) return 'other';
    if ((w.width || 0) < MIN_WINDOW.width || (w.height || 0) < MIN_WINDOW.height) return 'other';
    if (/^halloween(\.exe)?$/i.test(appName)) return 'game';
    if (GAME_NAME.test(appName) || (!appName && GAME_NAME.test(title))) return 'game-maybe';
    return 'other';
}

/**
 * Index of the game's window in an enumerated list, or -1.
 *
 * An exact app-name match anywhere in the list beats a looser match, whatever
 * the z order says — a browser window whose title mentions the game must not
 * win just because it came first.
 *
 * @param {Array<Object>} infos the same shape `classifyWindow` takes
 * @param {number} ownPid
 * @returns {number}
 */
function pickGameWindow(infos, ownPid) {
    if (!Array.isArray(infos)) return -1;
    let fallback = -1;
    for (let i = 0; i < infos.length; i++) {
        const verdict = classifyWindow(infos[i], ownPid);
        if (verdict === 'game') return i;
        if (verdict === 'game-maybe' && fallback === -1) fallback = i;
    }
    return fallback;
}

module.exports = {
    GAME_INTERVAL,
    IDLE_INTERVAL,
    MENU_TICKS_TO_HIDE,
    SEND_THROTTLE,
    SLOW_TICK_MS,
    GAME_NAME,
    OWN_NAME,
    MIN_WINDOW,
    tickInterval,
    throttleAllows,
    shouldApplyDetected,
    shouldWatchMenu,
    classifyWindow,
    pickGameWindow,
    MenuStreak,
    SendThrottle
};
