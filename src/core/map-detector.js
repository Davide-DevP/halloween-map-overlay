const {ipcMain, app} = require('electron');
// `node-screenshots` is **not** required here any more: every capture happens
// in `map-detector/frame-source.js`, which normally runs in the detector's
// utility process. This file is the scheduler and the state machine.
const {
    DEFAULT_SIZE, MENU_TEMPLATE_WIDTH, MENU_TEMPLATE_HEIGHT
} = require('./map-detector/matcher');
const DetectorLog = require('./map-detector/log');
const DetectorWorkerHost = require('./map-detector/worker-host');
/*
 * `./gc` is required **lazily**, from `start()`. It flips a V8 flag with
 * `v8.setFlagsFromString`, which an embedder is allowed to freeze — and if one
 * ever does, V8 aborts the process rather than throwing something a try/catch
 * could absorb. Requiring it at module load put that risk in the startup path
 * of every user, including the great majority who have automatic detection
 * switched **off**. Held here once `start()` has resolved it.
 */
let gc = null;
const appLog = require('./app-log');
const {CUSTOM_CREATOR} = require('./map-catalog');
const {
    GAME_INTERVAL, IDLE_INTERVAL, MENU_TICKS_TO_HIDE, SEND_THROTTLE, SLOW_TICK_MS,
    GAME_NAME, OWN_NAME, MIN_WINDOW,
    tickInterval, shouldWatchMenu, pickGameWindow, MenuStreak, SendThrottle
} = require('../shared/detector-rules');
const {DETECT_INTERVAL: TAB_DETECT_INTERVAL} = require('../shared/tab-mode-rules');
const rules = require('../shared/map-pack-rules');
const {mergeTemplateSources} = rules;
const TEMPLATE_FILE = require('./map-detector/templates.json');

const debug = process.env.DEBUG === 'true';

/**
 * Width the captured window is reduced to before anything looks at it. The
 * templates are 64x64 thumbnails of a region that is ~40 % of the frame, so
 * 640 px across leaves ~255 px for a 64 px thumbnail — four times more detail
 * than the match needs, and a quarter of the pixels of a 1080p frame.
 */
const CAPTURE_WIDTH = 640;

/*
 * `GAME_NAME`, `OWN_NAME`, `MIN_WINDOW` and the decision built on them
 * (`classifyWindow`) moved into the pure `shared/detector-rules.js` in 0.7:
 * `core/foreground.js` needs the same answer to "is the game in front?" and
 * two copies of that test would eventually disagree. They are re-exported at
 * the bottom of this file so nothing that already read them off the loop has
 * to learn a new path.
 */

/** "Game not running" and capture errors are states, not events: log sparsely. */
const STATE_LOG_INTERVAL = 60000;

/**
 * How many thumbnails a `templates.json` entry holds — **without** building
 * them.
 *
 * The same shapes `matcher.js`'s `templateVariants` accepts (a list of
 * thumbnails since 0.3.3, a single flat one before it), counted rather than
 * converted: this process only ever reports the number, and converting would
 * allocate a megabyte of `Float32Array` for a log line.
 *
 * @param {*} entry
 * @returns {number}
 */
function countVariants(entry) {
    if (!entry || !entry.length) return 0;
    if (ArrayBuffer.isView(entry)) return 1;
    const first = entry[0];
    if (Array.isArray(first) || ArrayBuffer.isView(first)) return entry.length;
    return 1;
}

/**
 * A map key as `detector.log` is allowed to spell it.
 *
 * `detector.log` travels inside the diagnostic report, and a custom map's key
 * is `Custom/` plus a name its owner typed — the README promises the zip
 * carries no custom map names. Shipped keys are catalogue data and are logged
 * in full; a custom one becomes `Custom/(custom)`, which is all the log needs
 * (that *a* map was on the overlay), exactly like `app.log` already does.
 */
function logKey(key) {
    if (!key) return '';
    return key.startsWith(CUSTOM_CREATOR + '/') ? CUSTOM_CREATOR + '/(custom)' : key;
}

/**
 * Automatic map detection (phase 2).
 *
 * Off by default (`mapDetection` setting). While on, it captures **the game's
 * own window** every 700 ms (2 s while the game is not running), reduces it to
 * 640 px wide, runs it through the pure matcher in `map-detector/matcher.js`,
 * and — when it sees the in-game Tab screen showing a map — hands the key to
 * `core/map-controller.js`, which is also where the CLI's `show-map=` lands.
 *
 * Deliberate choices:
 * - **The game window, not the display.** `desktopCapturer.getSources` (the
 *   first implementation) cost 286-518 ms of main-thread time per tick and
 *   stuttered the whole machine every poll. `node-screenshots` captures one
 *   window asynchronously for a fraction of that, and when the game is not
 *   running there is no window to capture, so a tick costs one cheap window
 *   enumeration and nothing else.
 * - **One cadence while the game is up.** 0.3.0 polled every 2 s searching and
 *   every 5 s after a hit; a Tab press lasts one or two seconds, so it often
 *   fell entirely between two ticks and the switch never happened (or happened
 *   so late the player had already picked the map by hand). See
 *   `shared/detector-rules.js` for the numbers and their cost.
 * - The frame never leaves this function. It is not stored, not written to
 *   disk, not sent anywhere, and the only thing derived from it that survives
 *   the tick is a map name. The event log in userData records decisions —
 *   keys, scores, timings — and **never a pixel**.
 * - A manual pick by the user does **not** stop detection (the reference app
 *   works that way and it is wrong here): the user asked for "press Tab once
 *   and the overlay is right". This loop therefore offers every accepted match
 *   (at most once per 2 s per key) and **`shared/map-state.js`** decides
 *   whether anything changes, because only the map state knows what the
 *   overlay is showing. Comparing against `lastDetected` here is what made a
 *   manual pick permanent in 0.3.0: the same map detected again looked
 *   unchanged and was never re-applied. That decision lived in the main
 *   window's renderer until 0.7 and is now in main — the *rule* is identical,
 *   it simply no longer needs a window to be alive.
 * - `setTimeout` chaining rather than `setInterval`: a slow capture must not
 *   queue up ticks behind itself.
 */
class MapDetector {

    /**
     * @param {Object} mainWindow
     * @param {Object} settings
     * @param {{frames?: Object}} [deps] `frames` is the capture source,
     *   injected so the tests can run the real worker module through a fake
     *   port. The app never passes it.
     */
    constructor(mainWindow, settings, deps) {
        this.mainWindow = mainWindow;
        this.settings = settings;
        this.timer = null;
        this.running = false;
        this.busy = false;
        /**
         * Which run of the loop we are on. Bumped by `start()`; a tick that
         * started under an older one drops its result and does not reschedule.
         */
        this.runId = 0;
        this.lastDetected = null;
        this.lastAt = null;
        this.lastScore = null;
        this.lastErrorAt = 0;
        this.lastMissingAt = 0;
        this.lastTiming = null;
        /**
         * How long the post-capture collection took on the last tick that
         * captured a frame, in ms. Printed on the DEBUG timing line so the
         * owner's field log shows what it really costs on their machine —
         * measured here at 1.3 ms median, 6.3 ms worst of 200.
         */
        this.lastGcMs = 0;
        this.lagTimer = null;

        /**
         * The key the **overlay is actually showing** (`null` while hidden),
         * reported by `core/map-controller.js` on every apply — hides
         * included. It is what the menu clear is gated on.
         *
         * 0.3.2 gated that on `lastDetected` — the map *this loop* recognised
         * — and the owner's field log shows the hole: in a party the matcher
         * accepted nothing, the owner set the map by hand, `lastDetected`
         * stayed null and the overlay was therefore never cleared back in the
         * menu (not one `menu-streak` line after the manual picks). Only the
         * owner of the map state knows what is on screen, so it says so; this
         * loop just listens. (Until 0.7 that owner was the main window's
         * renderer and this arrived as `map-detector-shown`; the rule and the
         * field bug it fixes are unchanged.)
         * Tracked whether or not the loop is running, so a map picked before
         * the switch was turned on is still known.
         */
        this.shownKey = null;

        /**
         * The menu streak *and* the transition rule that guards it: a map may
         * only be cleared once the game has been seen away from the menu since
         * that map went up. Pure, in `shared/detector-rules.js`.
         */
        this.menuStreak = new MenuStreak(MENU_TICKS_TO_HIDE);
        /** True once the menu has cleared the overlay, until the next detection. */
        this.inMenu = false;
        /** Whether the previous tick found the game window (null = not looked yet). */
        this.windowSeen = null;
        /** The game's pid from that same read, for `gameWindowInfo`. */
        this.gamePid = null;
        /** At most one offer per key per SEND_THROTTLE ms. */
        this.sendThrottle = new SendThrottle(SEND_THROTTLE);

        /**
         * Append-only event log in userData. Not gated on DEBUG: the whole
         * point is that the owner can send it after a session that misbehaved.
         * `app.getPath` works before `ready` (Settings already relies on it).
         */
        let logDir = null;
        try {
            logDir = app && typeof app.getPath === 'function' ? app.getPath('userData') : null;
        } catch (err) {
            console.error('Map detection: no userData path for the event log:', err && err.message);
        }
        this.log = new DetectorLog(logDir);

        this.size = TEMPLATE_FILE.size || DEFAULT_SIZE;
        /**
         * Where the templates of *installed map packs* come from — a function
         * returning `[{key, templates}]`, injected by `index.js` because
         * `MapPacks` is built after this class. Null means bundled maps only,
         * which is what the whole of 0.6 was.
         */
        this.packSource = null;
        /**
         * `core/tab-mode.js`, injected (it is built after this class and needs
         * `findGameWindow` from here). Null means Tab-map mode does not exist
         * in this process, which is what every version before 0.7 was.
         */
        this.tabMode = null;
        /**
         * `core/map-controller.js`, injected. Every accepted match and the
         * menu clear go through it; up to 0.7 they went to the main window's
         * renderer as `show-map-command` / `menu-hide-map`, which meant
         * auto-detect stopped working the moment that window was not there.
         */
        this.mapController = null;
        /**
         * Which map keys the frame source has been given, and how many
         * variants in total — **counts, not pixels**. The thumbnails
         * themselves live wherever the matching happens, which is normally
         * another process; main used to keep a fully prepared copy (thumbnails,
         * gradients and NCC statistics, a megabyte of Float32Array) purely to
         * be able to print how many there were.
         */
        this.templateKeys = [];
        this.variantCount = 0;
        // The menu strip lives in its own section of templates.json — it is not
        // a map and must never be a candidate in the map match.
        const menu = TEMPLATE_FILE.menu || null;
        this.menuTemplate = menu && Array.isArray(menu.template) ? Float32Array.from(menu.template) : null;
        this.menuWidth = (menu && menu.width) || MENU_TEMPLATE_WIDTH;
        this.menuHeight = (menu && menu.height) || MENU_TEMPLATE_HEIGHT;

        /**
         * Where frames come from: the utility process when there is one, this
         * process when there is not. Every capture in the app goes through it —
         * the tick, Tab-map mode's confirming press and its safety check — so
         * there is one place that touches pixels and one place to move off the
         * main thread. Injectable for the tests, which drive the real worker
         * module through a fake port.
         */
        this.frames = (deps && deps.frames) || new DetectorWorkerHost({
            log: (event, fields) => this.log.write(event, fields),
            gc: null
        });
        this.loadTemplates();

        const self = this;
        ipcMain.handle('map-detector-start', async () => {
            self.settings.set('mapDetection', true);
            self.start();
            return self.status();
        });
        ipcMain.handle('map-detector-stop', async () => {
            self.settings.set('mapDetection', false);
            self.stop();
            return self.status();
        });
        ipcMain.handle('map-detector-status', async () => self.status());
        /*
         * Three channels are gone since 0.7, and they were all round trips
         * through a renderer that is now allowed not to exist:
         *
         * - `map-detector-reset` — "Clear map" (Ctrl+Alt+D) forgetting the last
         *   detection. `MapController` calls `resetLastDetected()`.
         * - `map-detector-applied` — what was done with the last offered match.
         *   `MapController` calls `noteApplied()`.
         * - `map-detector-shown` — what the overlay is showing. `MapController`
         *   calls `noteShown()` after every apply.
         *
         * The *rules* are unchanged, including the 0.3.3 one this loop exists
         * to honour: the menu clear is gated on what the overlay is actually
         * showing, whoever put it there (`shownKey`), never on `lastDetected`.
         * See `docs/SPEC-MAP-STATE.md` §2.2.
         */
    }

    /**
     * Where the accepted matches go. Injected from `index.js` — the controller
     * is built before this class, but this way the detector can be constructed
     * in a test with no controller at all.
     * @param {?Object} controller `core/map-controller.js`
     */
    setMapController(controller) {
        this.mapController = controller || null;
    }

    /**
     * What was done with the last match this loop offered.
     *
     * The whole chain lives in `detector.log`: match → send → applied/ignored.
     * "Ignored because that map is already on the overlay" is the normal answer
     * while a Tab screen is held, and it is the line that tells a reader the
     * loop is working rather than stuck.
     *
     * @param {{key: string, applied: boolean, reason: ?string}} info
     */
    noteApplied(info) {
        const {key, applied, reason} = info || {};
        this.log.write('applied', {
            key: logKey(key) || '',
            applied: applied ? 'yes' : 'no',
            reason: reason || (applied ? 'switched' : '')
        });
        if (debug) console.log(`map-detector: ${applied ? 'applied' : 'ignored'} "${key}"${reason ? ` (${reason})` : ''}`);
    }

    /**
     * Where installed map packs' templates come from.
     * @param {?Function} fn returns `[{key, templates}]`
     */
    /**
     * Tab-map mode. It is told about three things this loop already knows —
     * every accepted match on a Tab frame, every tick's gate verdict, and the
     * game window disappearing — and it decides for itself what to do with
     * them (`shared/tab-mode-rules.js`). It also shortens this loop's cadence
     * while it is running; see `tickInterval`.
     * @param {?Object} tabMode
     */
    setTabMode(tabMode) {
        this.tabMode = tabMode || null;
    }

    /** Tell Tab-map mode something, without caring whether it exists. */
    notifyTabMode(method, ...args) {
        if (!this.tabMode || typeof this.tabMode[method] !== 'function') return;
        try {
            this.tabMode[method](...args);
        } catch (err) {
            // Tab-map mode is experimental and must never be able to break the
            // detector loop that the rest of the app depends on.
            console.error(`Map detection: tab mode ${method} failed:`, err && err.message);
        }
    }

    /**
     * Ask Tab-map mode a question, with the same protection.
     *
     * The answers below used to be read straight off `this.tabMode` inside the
     * tick, outside `notifyTabMode`'s try/catch — so a throw from the
     * experimental feature would have broken every tick of the detector, which
     * is exactly what that try/catch exists to prevent.
     */
    askTabMode(method, fallback) {
        if (!this.tabMode || typeof this.tabMode[method] !== 'function') return fallback;
        try {
            return this.tabMode[method]();
        } catch (err) {
            console.error(`Map detection: tab mode ${method} failed:`, err && err.message);
            return fallback;
        }
    }

    /** Is Tab-map mode running and therefore interested in this tick? */
    tabModeWants() {
        return this.askTabMode('isActive', false) === true;
    }

    setPackSource(fn) {
        this.packSource = typeof fn === 'function' ? fn : null;
        // The constructor has already built the bundled set; installed packs
        // only exist once this is wired, so fold them in now rather than
        // leaving the first session of every start without them.
        this.loadTemplates();
    }

    /**
     * Build `this.templates` from the committed `templates.json` plus every
     * installed map pack.
     *
     * Stored as plain arrays in JSON; `Float32Array` once, **here**, so the hot
     * loop never re-allocates and never parses anything. A key holds a *list*
     * of thumbnails since 0.3.3 — one per view of the map panel (Michael /
     * civilian) — and `templateVariants` also accepts the single-thumbnail
     * shape a pre-0.3.3 file has.
     *
     * A pack wins on a shared key, which is how a pack fixes a *bundled* map's
     * detection without an app release. The merge itself is the pure
     * `mergeTemplateSources`.
     *
     * This runs at construction and again after a pack is installed — never on
     * a tick. See "The capture path — do not make it heavier" in
     * `docs/agents/detection.md`.
     */
    loadTemplates() {
        let packs = [];
        if (this.packSource) {
            try {
                packs = this.packSource() || [];
            } catch (err) {
                console.error('Map detection: could not read map pack templates:', err && err.message);
                packs = [];
            }
        }
        const merged = mergeTemplateSources(TEMPLATE_FILE.templates || {}, packs);
        const keys = [];
        let variantCount = 0;
        for (const [key, values] of Object.entries(merged.templates)) {
            const variants = countVariants(values);
            if (!variants) continue;
            keys.push(key);
            variantCount += variants;
        }
        // Main counts them and forgets them. Each variant's gradient magnitude
        // and NCC statistics do not depend on the frame and used to be
        // recomputed on **every tick**; they are now prepared exactly once, by
        // whichever process is going to match with them (`prepareTemplates`,
        // pure, pinned by `test/detector-equality.test.js`). Preparing a second
        // copy here would be a megabyte this process has no use for.
        this.templateKeys = keys;
        this.variantCount = variantCount;
        // The frame source needs them too — and it is normally in another
        // process, so they travel as the plain arrays `templates.json` holds
        // and are prepared on the other side. This is the **only** thing that
        // crosses the boundary in that direction, and it is the app's own build
        // output rather than anything captured.
        if (this.frames && typeof this.frames.setTemplates === 'function') {
            this.frames.setTemplates({
                templates: merged.templates,
                menu: TEMPLATE_FILE.menu || null,
                size: this.size
            });
        }
        // A pack past the global variant budget is *not* loaded — every variant
        // is scored on every gated-in frame, so an index listing hundreds of
        // packs would put seconds of work in the hot loop. Said out loud rather
        // than dropped silently: "the new map is in the gallery but auto-detect
        // does not know it" has to be answerable.
        if (merged.dropped.length) {
            console.warn(`Map detection: ${merged.dropped.length} map pack template set(s) skipped — `
                + `the ${rules.LIMITS.variants}-variant budget is full: ${merged.dropped.join(', ')}`);
            this.log.write('templates-dropped', {
                packs: merged.dropped.length,
                budget: rules.LIMITS.variants
            });
        }
        return {
            keys: keys.length,
            variants: variantCount,
            packs: packs.length,
            replaced: merged.replaced,
            dropped: merged.dropped
        };
    }

    /**
     * Re-read the templates after a map pack was installed, so a new map is
     * detectable without a restart.
     *
     * Safe to call while the loop is running: the frame source swaps its set in
     * one assignment, so the worst case is one tick scored against the previous
     * one.
     */
    reloadTemplates() {
        const before = this.templateKeys.length;
        const info = this.loadTemplates();
        if (info.keys === before && !info.replaced.length) return info;
        this.log.write('templates-reloaded', {
            templates: info.keys,
            variants: info.variants,
            packs: info.packs,
            replaced: info.replaced.length
        });
        console.log(`Map detection: templates reloaded (${info.keys} maps, ${info.variants} variants, `
            + `${info.packs} from map packs).`);
        return info;
    }

    /**
     * A map went on to the overlay (or came off it). Called by
     * `core/map-controller.js` after every apply.
     *
     * Throttled to actual changes: an apply also fires on an opacity nudge, a
     * rotation and a slider drag, all with the same key, and the log holds
     * decisions rather than repetitions.
     *
     * A change here also breaks a menu streak. A player who picks a map by
     * hand while the loop is two ticks into "this looks like the main menu"
     * has just said what they want on screen, and letting the third tick take
     * it away again would be the stalest kind of surprise.
     *
     * @param {?string} key catalogue key, or ""/null when the overlay is hidden
     */
    noteShown(key) {
        const next = key || null;
        if (next === this.shownKey) return;
        this.shownKey = next;
        // A new map on the overlay restarts the streak *and* withdraws the
        // right to clear until the game is seen outside the menu again — a map
        // picked by hand while the menu is up must not be taken away 2 s later.
        this.menuStreak.noteShown();
        if (next) this.inMenu = false;
        this.log.write('shown', {key: logKey(next) || '(none)'});
        if (debug) console.log(`map-detector: overlay is showing "${next || ''}"`);
    }

    /** Forget the last detection so even the same map is acted on again. */
    resetLastDetected() {
        if (!this.lastDetected) return;
        this.log.write('reset', {was: this.lastDetected});
        this.lastDetected = null;
        this.lastAt = null;
        this.lastScore = null;
        this.menuStreak.reset();
        this.inMenu = false;
        // The map was just cleared by hand: the next match on it must go out
        // at once rather than waiting for the throttle window to expire.
        this.sendThrottle.reset();
        if (debug) console.log('map-detector: last detection cleared.');
        this.sendStatus({state: this.running ? 'watching' : 'off'});
        // Look again now rather than sitting out the 5 s post-detection wait.
        if (this.running) this.schedule(0);
    }

    /** @returns {{running, lastDetected, lastAt, lastScore, templates, inMenu}} */
    status() {
        return {
            running: this.running,
            lastDetected: this.lastDetected,
            lastAt: this.lastAt,
            lastScore: this.lastScore,
            templates: this.templateKeys.length,
            inMenu: this.inMenu
        };
    }

    isRunning() {
        return this.running;
    }

    /**
     * The game window as the last tick saw it.
     *
     * `noteWindow` only fires on an *edge*, so a feature switched on between
     * two edges (Tab-map mode, from the Settings switch) would otherwise wait
     * for the next one — which may be the next time the player closes the game.
     * This is the state, not an event.
     *
     * @returns {{present: boolean, pid: ?number}}
     */
    gameWindowInfo() {
        return {present: this.windowSeen === true, pid: this.gamePid || null};
    }

    start() {
        if (this.running) return;
        if (!this.templateKeys.length) {
            console.error('Map detection not started: templates.json holds no templates.');
            return;
        }
        this.running = true;
        // A new run. Anything still in flight from the previous one belongs to
        // the previous one: it must not clear this run's `busy`, schedule this
        // run's next tick, or act on a frame captured before the switch was
        // turned off and on again.
        this.runId++;
        // The on-demand collector, resolved here rather than at module load —
        // see the `let gc` declaration at the top of this file. Wrapped
        // because this is the one module in the app whose *require* can have
        // consequences, and a detector without a collector is 0.2.2 behaviour
        // (a documented oscillation), not a fault.
        if (!gc) {
            try {
                gc = require('./gc');
            } catch (err) {
                console.error('Map detection: the collector could not be loaded:', err && err.message);
                gc = {collect: () => {}, isAvailable: () => false};
            }
        }
        // The collector belongs wherever the frames are. In worker mode that is
        // the child, which loads its own; this hands it to the **fallback**
        // source, which captures in this process and would otherwise never
        // collect at all.
        if (this.frames.setGc) this.frames.setGc(gc);
        console.log(`Map detection started (${this.templateKeys.length} templates, `
            + `${this.variantCount} variants, every ${GAME_INTERVAL} ms while the game is running).`);
        // The detail stays in detector.log; app.log only records that the
        // feature was on, so a report can be read without the other file.
        appLog.event('detector', {action: 'start'});
        this.log.write('loop-start', {
            templates: this.templateKeys.length,
            variants: this.variantCount,
            gameMs: GAME_INTERVAL,
            idleMs: IDLE_INTERVAL,
            // Whether the on-demand collection is actually available in this
            // runtime. It has never been recorded from inside Electron, and a
            // silent no-op here is worth ~110 MB of peak during a match.
            gc: gc.isAvailable() ? 'available' : 'noop',
            version: require('../../package.json').version
        });
        this.windowSeen = null;
        this.sendThrottle.reset();
        // Now, and not before: the utility process exists only while there is
        // something for it to capture. A user with auto-detect off — the great
        // majority — never pays for a second process at all.
        const worker = this.frames.start ? this.frames.start() : null;
        this.log.write('detector-source', worker
            ? {mode: worker.mode, reason: worker.reason}
            : {mode: 'in-process', reason: 'injected'});
        this.startLagProbe();
        this.sendStatus({state: 'watching'});
        // Tab-map mode requires auto-detect (only this loop knows which map is
        // on screen), so it follows this switch rather than having one of its
        // own to keep in step. Notified after `running` is true.
        this.notifyTabMode('syncWithSettings');
        this.schedule(0);
    }

    /**
     * DEBUG only: how late a 200 ms timer actually fires, i.e. how long the
     * main thread was blocked. This is the number that says whether the
     * detector is making the UI (and the machine) stutter — it is what caught
     * the original `desktopCapturer` backend. Peak drift is reported once every
     * 10 s and reset.
     */
    startLagProbe() {
        if (!debug || this.lagTimer) return;
        let previous = Date.now();
        let peak = 0;
        let reportedAt = Date.now();
        this.lagTimer = setInterval(() => {
            const now = Date.now();
            const drift = now - previous - 200;
            previous = now;
            if (drift > peak) peak = drift;
            if (now - reportedAt >= 10000) {
                console.log(`map-detector: event-loop peak drift over the last 10 s: ${peak} ms`);
                peak = 0;
                reportedAt = now;
            }
        }, 200);
        if (this.lagTimer.unref) this.lagTimer.unref();
    }

    stop() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        if (this.lagTimer) clearInterval(this.lagTimer);
        this.lagTimer = null;
        if (!this.running) return;
        this.running = false;
        // A tick may be waiting on a grab right now. Its `finally` belongs to
        // the run that is ending — it is guarded by `runId` and will neither
        // reschedule nor clear this flag — so the flag is cleared here, or the
        // next `start()` would find the loop permanently "busy" and never tick
        // again. That is exactly how a lost reply used to kill auto-detect for
        // the rest of the session.
        this.busy = false;
        this.lastDetected = null;
        this.menuStreak.reset();
        this.inMenu = false;
        this.windowSeen = null;
        this.sendThrottle.reset();
        appLog.event('detector', {action: 'stop'});
        this.log.write('loop-stop');
        console.log('Map detection stopped.');
        // `running` is already false, so this takes the Tab markers down and
        // stops their loop — the mode cannot outlive the thing that names the
        // map it is drawing.
        this.notifyTabMode('syncWithSettings');
        // …and with nothing left that wants a frame, the utility process goes
        // away. It is a whole process: it must not sit there for the rest of a
        // session in which the user turned the feature off.
        if (this.frames.stop) this.frames.stop();
        this.sendStatus({state: 'off'});
    }

    /**
     * Quit or update. Closes the utility process for good — `runShutdownHooks`
     * runs from `before-quit` and from the install path, and a child still
     * holding a native capture module while the installer replaces the app
     * directory is exactly the shape that has caused trouble here before.
     */
    destroy() {
        this.stop();
        if (this.frames.destroy) this.frames.destroy();
    }

    /** Follow the setting: called at boot and whenever the switch is flipped. */
    syncWithSettings() {
        if (this.settings && this.settings.get('mapDetection')) this.start();
        else this.stop();
    }

    schedule(delay) {
        if (!this.running) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.tick(), delay);
    }

    /**
     * `enumerate=… capture=… match=… total=…` in milliseconds for the last
     * tick. `capture` is the native window grab plus the raw-pixel copy;
     * `match` is the downscale, the gate and the NCCs.
     */
    timingLabel() {
        const t = this.lastTiming;
        if (!t) return '';
        return `enumerate=${t.enumerate}ms capture=${t.capture}ms match=${t.match}ms total=${t.total}ms gc=${this.lastGcMs}ms`;
    }

    /** A repeating state (game closed, capture refused) must not fill the log. */
    logState(field, message, level) {
        const now = Date.now();
        if (now - this[field] < STATE_LOG_INTERVAL) return;
        this[field] = now;
        (level === 'error' ? console.error : console.log)('Map detection:', message);
    }

    /**
     * One capture, gate and match — for Tab-map mode's confirming press.
     *
     * Tab mode used to find the window and capture it itself, in main. It now
     * asks through the same frame source, so its captures are off the main
     * thread too and there is exactly one place in the app that touches pixels.
     * Which window is the game is still the pure `pickGameWindow`, shared with
     * `core/foreground.js`, wherever it runs.
     *
     * @returns {Promise<Object>} decisions and numbers, never pixels
     */
    grabMatch() {
        return this.frames.grab({match: true});
    }

    /**
     * The cheap "is the Tab screen still up?" grab: capture and gate, no
     * luminance and no NCC. Tab-map mode's safety check while its markers are
     * shown.
     * @returns {Promise<Object>}
     */
    grabGate() {
        return this.frames.grab({match: false});
    }

    /**
     * The cadence for a tick that produced no verdict about the window.
     *
     * The last thing that *did* produce one still stands: if the game window
     * was there a moment ago, come back at the game cadence (700 ms, or 450 ms
     * while Tab-map mode is running) rather than at the 2 s "no game" one.
     *
     * @param {number} fallback what to use when the window has never been seen
     * @returns {number}
     */
    knownWindowInterval(fallback) {
        if (this.windowSeen !== true) return fallback;
        return tickInterval(true, {
            gameMs: this.askTabMode('wantsFasterDetection', false) ? TAB_DETECT_INTERVAL : null
        });
    }

    async tick() {
        if (!this.running || this.busy) return;
        this.busy = true;
        // Which run this tick belongs to; re-checked after the await and in the
        // `finally`, because the user can switch detection off and on again
        // while a grab is in flight.
        const runId = this.runId;
        // The cadence follows one thing only: is the game up? A Tab press is
        // over in a second or two, so there is no "we already know the map"
        // discount any more.
        let interval = IDLE_INTERVAL;
        const started = Date.now();
        // Did this tick actually pull pixels out of the game window? Only then
        // is there native memory worth collecting — see the `finally` below.
        let capturedFrame = false;
        try {
            // **One request, and the pixels are somebody else's problem.**
            //
            // The capture, the gate, the luminance and the NCCs happen in the
            // detector's utility process (`map-detector/worker.js`); what comes
            // back is a window rectangle, a gate verdict, a map key and some
            // numbers. With no utility process available this is exactly the
            // same code running here instead (`frame-source.js`), so the tick
            // below reads the same either way.
            //
            // The menu matcher is asked for *here*, because whether it is
            // wanted depends on `shownKey` and `hideInMenu` — state main owns
            // and the worker has no business knowing.
            const wantMenu = !!(this.menuTemplate && this.settings
                && shouldWatchMenu(this.shownKey, this.settings.get('hideInMenu')));
            const reply = await this.frames.grab({menu: wantMenu});
            if (!this.running || this.runId !== runId) return;
            // **No answer is not an answer about the window.** A stop, a
            // restart backoff or a request that timed out resolves as
            // `aborted`, and reading `window` off it would report the game as
            // closed: the window edge would be logged, Tab mode would be told
            // the window was lost and the cadence would drop to the 2 s idle
            // one, all because *we* could not ask.
            if (reply.aborted) {
                if (debug) console.log(`map-detector: no frame this tick (${reply.reason})`);
                // …and neither is it a reason to slow down. The idle 2 s cadence
                // means "the game is not running"; a tick that could not ask
                // must come back at the cadence the last *answer* justified, or
                // one timeout during a Tab press costs the player two seconds.
                interval = this.knownWindowInterval(interval);
                // Still no answer about the Tab screen, and no answer over live
                // gameplay means take the markers down.
                this.notifyTabMode('onLost', 'no-frame');
                return;
            }
            // Before the window is read: a worker whose handler threw answers
            // with an error and **no window at all**, which otherwise looked
            // exactly like "the game is not running" — the log said the game
            // was not found while the real fault went unrecorded.
            if (reply.error) {
                this.lastTiming = reply.timings || this.lastTiming;
                // A capture that failed with the game window still there (an
                // alt-tab, a display-mode change) is a second of trouble, not a
                // closed game: retry at the game cadence.
                interval = this.knownWindowInterval(interval);
                this.log.write('error', {message: reply.error});
                this.logState('lastErrorAt', reply.error, 'error');
                this.notifyTabMode('onLost', 'detector-error');
                return;
            }
            const win = reply.window || {present: false};
            capturedFrame = !!(win.captured);

            const gameRect = this.tabModeWants() ? win.rect : null;
            const gamePid = win.present ? win.pid : null;
            // Kept so a mode switched on *between* window edges can ask for it
            // (`gameWindowInfo`) instead of waiting for the next edge, which
            // might be the next time the player closes the game.
            this.gamePid = gamePid;
            this.noteWindow(!!win.present, gamePid);
            if (!win.present) {
                // Nothing to capture: a tick costs one window enumeration and
                // stops here, so having the switch on while the game is closed
                // is free.
                this.logState('lastMissingAt', 'game window not found — is Halloween: The Game running?');
                // The game window is also the surface Tab-map mode draws on, so
                // losing it must take those markers down at once.
                this.notifyTabMode('onLost', 'no-window');
                return;
            }
            // 700 ms normally; 450 ms while Tab-map mode is running, because
            // that is what decides how long its markers take to appear. See
            // `tickInterval` and `shared/tab-mode-rules.js`.
            interval = tickInterval(true, {
                gameMs: this.askTabMode('wantsFasterDetection', false) ? TAB_DETECT_INTERVAL : null
            });
            this.lastTiming = reply.timings || null;
            // Whatever the collection cost, it was paid where the frame was —
            // in the worker normally, in the fallback source when there is no
            // worker. Main does not collect for a frame it never held.
            this.lastGcMs = (reply.timings && reply.timings.gc) || 0;

            // Tab-map mode's cheapest signal: this tick already knows whether
            // the frame was a Tab screen. A gated-out frame while its markers
            // are up means Tab is down, at no extra cost at all.
            this.notifyTabMode('onGate', !!reply.gate);

            if (!reply.gate) {
                // Ordinary gameplay — the common case, every tick of every
                // match. The worker produced the menu strip's luminance only if
                // this tick asked for it; the streak and the clear stay here.
                this.noteMenu(reply.menu, wantMenu);
                if (debug) console.log(`map-detector: no match (gated out) ${this.timingLabel()}`);
                return;
            }

            const match = reply.match;
            if (!match) {
                // Gated in but no match was computed — only possible when the
                // caller asked for a gate-only grab, which the tick never does.
                return;
            }

            if (!match.accepted) {
                // The Tab screen was up but nothing was accepted: the one case
                // where "it did not switch" is the matcher's doing, and the
                // scores are the only way to tell why.
                //
                // `gate=in` says explicitly what the absence of a `gated` frame
                // used to say implicitly (only gated-*in* frames reach this
                // line), and `panelMean` is the mean luminance of the map panel
                // itself: a panel the capture has slid off, or one the game drew
                // much darker than the template, is visible in the log without
                // ever keeping a frame.
                this.log.write('no-match', {
                    score: match.score,
                    second: match.second,
                    margin: match.margin,
                    gate: 'in',
                    panelMean: match.panelMean,
                    tickMs: this.lastTiming.total
                });
                if (debug) console.log(`map-detector: no match (gated in) ${this.timingLabel()}`);
                return;
            }

            // A Tab screen is proof the player is in a match, whatever the menu
            // matcher thought a moment ago — and it is the clearest possible
            // "not in the menu", so the map about to go up may be cleared when
            // the match ends.
            this.menuStreak.noteMatch();
            this.inMenu = false;
            this.lastScore = match.score;
            this.lastAt = Date.now();
            const changed = match.key !== this.lastDetected;
            // `lastDetected` still gates the menu clear and drives the status
            // line — it no longer decides whether to send.
            this.lastDetected = match.key;
            this.log.write('match', {
                key: match.key,
                score: match.score,
                margin: match.margin,
                by: match.acceptedBy || 'score',
                tickMs: this.lastTiming.total,
                changed: changed ? 'yes' : 'no'
            });
            if (changed) {
                console.log(`Map detected: ${match.key} (score ${match.score.toFixed(3)}, margin ${match.margin.toFixed(3)}) ${this.timingLabel()}`);
            } else if (debug) {
                console.log(`map-detector: still "${match.key}" (${match.score.toFixed(3)}) ${this.timingLabel()}`);
            }
            // Every accepted match is offered to the map controller, throttled
            // per key so a held Tab does not spam it. The controller drops it
            // when that map is already on the overlay — it is the one place
            // that knows, and since 0.7 that place is in this process rather
            // than in a renderer that may not exist.
            if (this.sendThrottle.allow(match.key, this.lastAt)) {
                this.log.write('send', {key: match.key});
                if (this.mapController) this.mapController.detected(match.key);
            }
            // Tab-map mode draws on *this* frame's window, so it is told every
            // accepted match — not only the throttled ones. The throttle exists
            // to keep IPC quiet; drawing the markers again on the same window
            // rectangle is a no-op, and a re-show after a hide must not have to
            // wait two seconds for the throttle window to expire.
            //
            // The window rect is read here, where the window object is, and
            // only when there is something to read it for; the capture's own
            // size travels with it so a capture that is not the window
            // rectangle is visible in the log rather than silently absorbed.
            // `started` travels with it: this tick began before the capture, and
            // the player can release the map key *during* a 27 ms capture. Tab
            // mode drops anything older than its last hide, which is what stops
            // a tick that was already in flight putting the markers back up
            // over live gameplay with no key-down behind them.
            this.notifyTabMode('onMatch', match.key, gameRect, win.captured || null, started);
            this.sendStatus({state: 'detected', key: match.key, at: this.lastAt, score: match.score});
        } catch (err) {
            this.log.write('error', {message: (err && err.message) || String(err)});
            this.logState('lastErrorAt', (err && err.message) || String(err), 'error');
            // A tick that threw is no answer about the Tab screen, and no
            // answer means take the markers down.
            this.notifyTabMode('onLost', 'detector-error');
        } finally {
            // A tick from a previous run must not clear the current run's busy
            // flag, and must not schedule its next tick — that would be two
            // loops chaining at once.
            //
            // The 8 MB native frame is released by a collection *where the
            // frame is* (`frame-source.js`, worker or fallback), so there is
            // nothing to collect here: `node-screenshots` is not even loaded in
            // this process in worker mode. `capturedFrame` still decides
            // whether the timing line has a gc number to print.
            if (this.runId === runId) {
                this.busy = false;
                if (!capturedFrame) this.lastGcMs = 0;
                const spent = Date.now() - started;
                if (spent >= SLOW_TICK_MS) this.log.write('slow-tick', {tickMs: spent});
                this.schedule(interval);
            }
        }
    }

    /**
     * Log the game window appearing and disappearing — edges only.
     *
     * Tab-map mode is told on the same edge: its key trigger has nothing to do
     * without a game window, and the pid it compares the foreground process
     * against comes from this very window read. Edge-driven, so this is not a
     * per-tick cost — and `pid` is only read at all when Tab mode exists.
     *
     * @param {boolean} present
     * @param {?number} [pid]
     */
    noteWindow(present, pid) {
        if (this.windowSeen === present) return;
        this.windowSeen = present;
        this.log.write(present ? 'window-found' : 'window-lost');
        this.notifyTabMode('onWindow', present, pid || null);
    }

    /**
     * A gated-out frame's menu verdict, as the frame source computed it.
     *
     * The *decision* to ask was made in the tick, before any pixel work: no map
     * on the overlay, or `hideInMenu` off, and the strip is never reduced at
     * all. That is where most of the saving is — a gated-out frame is the
     * common case, every 700 ms for the whole of a match, and the tick used to
     * reduce the entire capture before finding it had nothing to do with it.
     *
     * @param {?{score: number, accepted: boolean}} menu
     * @param {boolean} wanted whether this tick asked for it
     */
    noteMenu(menu, wanted) {
        if (!wanted) {
            this.menuStreak.reset();
            return;
        }
        if (!menu) return;
        this.applyMenuVerdict(menu);
    }

    /**
     * Back in the main menu? Clear the overlay.
     *
     * Runs only on a tick whose frame failed the Tab-screen gate, and only
     * while **a map is on the overlay** — there is nothing to clear otherwise.
     *
     * That second condition used to be `lastDetected`, i.e. "the loop
     * recognised a map in this match". The owner's 0.3.2 field log shows why
     * that was wrong: through a whole evening of party matches the matcher
     * accepted nothing (see `DEFAULT_MARGIN_MIN_SCORE`), the maps were picked
     * by hand, `lastDetected` stayed null — and the overlay was never cleared
     * back in the menu, because the menu matcher was never even run. What is
     * on the overlay is what matters, whoever put it there, so the gate is
     * `shownKey`, which `core/map-controller.js` reports.
     *
     * `lastDetected` is cleared along with the overlay so that starting the
     * *same* map again is detected as a change; without that the loop would see
     * no difference and the overlay would stay blank for the whole next match —
     * exactly the trap `clear-map` already has to avoid.
     *
     * The matching itself happens in the frame source (and therefore, normally,
     * in the utility process); everything below — the streak, the transition
     * rule, the clear and all the logging — is main's, because it is state and
     * state does not cross the boundary.
     *
     * @param {{score: number, accepted: boolean}} menu the verdict
     */
    applyMenuVerdict(menu) {
        // The streak, the "a non-menu frame breaks it" rule and the transition
        // rule all live in the pure `MenuStreak`; this half only logs and acts.
        const verdict = this.menuStreak.note(menu.accepted);
        if (!menu.accepted) {
            if (verdict.broke) this.log.write('menu-streak', {ticks: 0, score: menu.score, broke: 'yes'});
            if (debug && menu.score > 0.5) {
                console.log(`map-detector: menu score ${menu.score.toFixed(3)} (below threshold)`);
            }
            return;
        }
        if (verdict.waiting) {
            // The menu is up, but this map went up *during* it — a pick between
            // matches. Nothing is taken away until the game leaves the menu.
            if (debug) console.log(`map-detector: menu score ${menu.score.toFixed(3)} (map picked in the menu; not counting)`);
            return;
        }

        this.log.write('menu-streak', {ticks: verdict.ticks, of: MENU_TICKS_TO_HIDE, score: menu.score});
        if (debug) console.log(`map-detector: menu score ${menu.score.toFixed(3)} (tick ${verdict.ticks}/${MENU_TICKS_TO_HIDE})`);
        if (!verdict.clear) return;

        this.menuStreak.reset();
        this.inMenu = true;
        const was = this.shownKey;
        this.lastDetected = null;
        this.lastAt = null;
        this.lastScore = null;
        // Optimistic: the controller confirms with its own `noteShown` a
        // moment later, but until it does this must not read as "a map is
        // still up" and start a second streak.
        this.shownKey = null;
        // The map is gone from the overlay, so the next detection of it has to
        // go out immediately rather than being eaten by the throttle.
        this.sendThrottle.reset();
        // The match is over, so anything drawn on the game's own map has to go
        // too — before the map controller is even told about the overlay.
        this.notifyTabMode('onLost', 'menu');
        this.log.write('menu-clear', {was: logKey(was), score: menu.score});
        console.log(`Main menu detected (score ${menu.score.toFixed(3)}) — clearing "${was}" from the overlay.`);
        // Through the map controller, not straight at the overlay window: it
        // owns which map is current, and hiding behind its back would leave
        // Ctrl+Alt+H toggling a map that is not on screen. (Up to 0.7 that
        // owner was the main window's renderer and this was an IPC message;
        // same rule, one process closer.)
        if (this.mapController) this.mapController.menuHide();
        this.sendStatus({state: 'menu'});
    }

    sendStatus(payload) {
        if (!this.mainWindow) return;
        this.mainWindow.send('map-detector-status', Object.assign(this.status(), payload));
    }
}

module.exports = MapDetector;
// The cadence itself lives in the pure `shared/detector-rules.js`; re-exported
// here so nothing that already reads it off the loop has to learn a new path.
module.exports.GAME_INTERVAL = GAME_INTERVAL;
module.exports.IDLE_INTERVAL = IDLE_INTERVAL;
module.exports.SEND_THROTTLE = SEND_THROTTLE;
module.exports.CAPTURE_WIDTH = CAPTURE_WIDTH;
module.exports.MENU_TICKS_TO_HIDE = MENU_TICKS_TO_HIDE;
// The game-window identification is pure and shared with `core/foreground.js`.
module.exports.GAME_NAME = GAME_NAME;
module.exports.OWN_NAME = OWN_NAME;
module.exports.MIN_WINDOW = MIN_WINDOW;
