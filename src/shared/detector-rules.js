/** PURE rules for automatic detection, read by the detector loop, the map state
 * and `core/foreground.js`. No electron, no `fs`, no timers — the one place a
 * cadence is written down. See `docs/agents/detection.md`. */

/** Poll period **while the game window exists**: a Tab press lasts one or two
 * seconds, so 700 ms puts two ticks inside the shortest realistic one. There is
 * deliberately no slower post-detection cadence. */
const GAME_INTERVAL = 700;

/** Poll period with **no** game window: one 0.2 ms `Window.all()` and no
 * capture, so leaving the switch on while the game is closed is free. */
const IDLE_INTERVAL = 2000;

/** Consecutive menu-matching ticks before the overlay is cleared: at 700 ms
 * three is ~2.1 s of *steady* menu, where two could be covered by a loading
 * screen sweeping past the menu layout. */
const MENU_TICKS_TO_HIDE = 3;

/** Minimum gap between two offers of the **same key**, since a held Tab press
 * produces two or three accepted matches in a row. Not a correctness gate:
 * the map state judges whether anything changes. */
const SEND_THROTTLE = 2000;

/** A tick slower than this is worth a log line. Diagnostics only. */
const SLOW_TICK_MS = 100;

/**
 * The delay before the next tick. `gameMs` overrides `GAME_INTERVAL` for a
 * caller with a reason to poll faster — today only Tab-map mode, at 450 ms,
 * because this cadence decides how long its markers take to appear. An argument
 * rather than a second constant, and the idle cadence is not affected.
 * @returns {number} milliseconds
 */
function tickInterval(gameWindowPresent, opts) {
    if (!gameWindowPresent) return IDLE_INTERVAL;
    const override = opts && opts.gameMs;
    return typeof override === 'number' && Number.isFinite(override) && override > 0
        ? override : GAME_INTERVAL;
}

/** Has enough time passed since the last send of this key?
 * @param {?number} lastSentAt epoch ms of the previous send, or null */
function throttleAllows(lastSentAt, now, window = SEND_THROTTLE) {
    if (lastSentAt === null || lastSentAt === undefined) return true;
    return now - lastSentAt >= window;
}

/**
 * Should a detected map be acted on? Only whoever knows what is on the overlay
 * **right now** may answer — the map state, never the detector loop against its
 * own `lastDetected`, which after a manual pick still holds the detected map,
 * so the next Tab press on it looks like "no change".
 * @param {?string} currentKey the key the overlay is showing ("" when hidden)
 */
function shouldApplyDetected(currentKey, key) {
    if (!key) return false;
    return (currentKey || '') !== key;
}

/**
 * Should this tick run the main-menu matcher? The gate is **"is a map on the
 * overlay", whoever put it there**, never the detector's own `lastDetected`: a
 * map the player set by hand because the matcher accepted nothing would then
 * never be cleared back in the menu, because this would never run.
 * @param {*} hideInMenu the setting; only an explicit `false` turns it off, so
 *   a settings file written before it existed keeps the default
 */
function shouldWatchMenu(shownKey, hideInMenu) {
    if (hideInMenu === false) return false;
    return !!shownKey;
}

/**
 * The menu-clear streak plus the transition rule that keeps it honest: the
 * overlay may be cleared only once the game has been seen **away from the
 * menu** since the current map went up (`sawNonMenu`). Without that, a map
 * picked by hand while the menu is up is taken away ~2.1 s later, and again
 * after the next pick (VERIFICATION-6, finding 2).
 */
class MenuStreak {

    /** @param {number} [ticksToHide] consecutive menu frames required */
    constructor(ticksToHide = MENU_TICKS_TO_HIDE) {
        this.ticksToHide = ticksToHide;
        this.ticks = 0;
        this.sawNonMenu = false;
    }

    /** A different map (or nothing) is on the overlay: the streak restarts and
     * the game must be seen outside the menu before anything is cleared. */
    noteShown() {
        this.ticks = 0;
        this.sawNonMenu = false;
    }

    /** A Tab screen with an accepted map: as non-menu as a frame gets. */
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
     * One frame that failed the Tab-screen gate. `clear` is the only verdict;
     * `ticks`/`broke` are for the log; `waiting` means "menu, but the map went
     * up in the menu, so it does not count".
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

/** Per-key send throttle. `allow()` records the send when it returns true, so
 * callers cannot forget to. */
class SendThrottle {

    /** @param {number} [window] throttle window in ms */
    constructor(window = SEND_THROTTLE) {
        this.window = window;
        this.sentAt = new Map();
    }

    /** @returns {boolean} true when the caller may send — and the send is
     *   recorded, so this must not be called speculatively */
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
 * The *decision*, shared so the detector loop and `core/foreground.js` cannot
 * disagree. The property reads stay in the impure callers.
 */

/** The game, matched on the window's **app name** (`Halloween.exe` →
 * "Halloween"), never its title: a terminal window called "Halloween The Game
 * mappe" or any browser tab about the game matches `/halloween/i` on its title.
 * The title is consulted only when the OS gives no app name at all. */
const GAME_NAME = /halloween/i;

/** This app's own windows — the main one matches GAME_NAME too. */
const OWN_NAME = /map\s*overlay/i;

/** A window this small cannot be the game; skip splash/tooltip windows. */
const MIN_WINDOW = {width: 320, height: 240};

/**
 * How one enumerated window relates to us.
 * @param {{appName?: string, title?: string, minimized?: boolean, width?: number, height?: number, pid?: number}} info
 * @returns {'own'|'game'|'game-maybe'|'other'} `game` is an exact
 *   `Halloween`/`Halloween.exe` app name; `game-maybe` only wins if none is
 */
function classifyWindow(info, ownPid) {
    const w = info || {};
    const appName = typeof w.appName === 'string' ? w.appName.trim() : '';
    const title = typeof w.title === 'string' ? w.title.trim() : '';
    // Our own windows first, and both tests are needed: the main window is
    // literally called "Halloween Map Overlay", so the name catches one the pid
    // cannot see and the pid catches one somebody renamed.
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
 * Index of the game's window in an enumerated list, or -1. An exact app-name
 * match anywhere in the list beats a looser one whatever the z order says: a
 * browser window whose title mentions the game must not win by coming first.
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
