const {ipcMain, app} = require('electron');
const {Window} = require('node-screenshots');
const {
    toGrayScaled, matchMap, matchMenu, templateVariants, DEFAULT_SIZE,
    MENU_TEMPLATE_WIDTH, MENU_TEMPLATE_HEIGHT
} = require('./map-detector/matcher');
const DetectorLog = require('./map-detector/log');
const appLog = require('./app-log');
const {CUSTOM_CREATOR} = require('./map-catalog');
const {
    GAME_INTERVAL, IDLE_INTERVAL, MENU_TICKS_TO_HIDE, SEND_THROTTLE, SLOW_TICK_MS,
    tickInterval, shouldWatchMenu, MenuStreak, SendThrottle
} = require('../shared/detector-rules');
const TEMPLATE_FILE = require('./map-detector/templates.json');

const debug = process.env.DEBUG === 'true';

/**
 * Width the captured window is reduced to before anything looks at it. The
 * templates are 64x64 thumbnails of a region that is ~40 % of the frame, so
 * 640 px across leaves ~255 px for a 64 px thumbnail — four times more detail
 * than the match needs, and a quarter of the pixels of a 1080p frame.
 */
const CAPTURE_WIDTH = 640;

/**
 * The game, matched on the window's **app name** — which comes from the
 * running executable (`Halloween.exe` → "Halloween"), not from whatever the
 * window happens to be displaying.
 *
 * Deliberately not the title: titles produce false positives constantly. On the
 * machine this was developed on, a terminal window called "Halloween The Game
 * mappe" (the project folder) and any browser tab about the game would both
 * match `/halloween/i` on the title while having app names "Windows Terminal
 * Host" and "Floorp". Capturing one of those and matching it against the map
 * templates is harmless but pointless, and it would keep the detector busy
 * while the game was not even running. The title is only consulted when the
 * app name is empty, i.e. when the OS would not tell us what owns the window.
 */
const GAME_NAME = /halloween/i;
/** This app's own windows — they match GAME_NAME too. */
const OWN_NAME = /map\s*overlay/i;
/** A window this small cannot be the game; skip splash/tooltip windows. */
const MIN_WINDOW = {width: 320, height: 240};

/** "Game not running" and capture errors are states, not events: log sparsely. */
const STATE_LOG_INTERVAL = 60000;

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
 * and — when it sees the in-game Tab screen showing a map — tells the renderer
 * to switch, on the same `show-map-command` channel the CLI uses.
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
 *   and the overlay is right". Main therefore sends every accepted match (at
 *   most once per 2 s per key) and the **renderer** decides whether anything
 *   changes, because only it knows what the overlay is showing. Comparing
 *   against `lastDetected` here is what made a manual pick permanent in 0.3.0:
 *   the same map detected again looked unchanged and was never re-applied.
 * - `setTimeout` chaining rather than `setInterval`: a slow capture must not
 *   queue up ticks behind itself.
 */
class MapDetector {

    constructor(mainWindow, settings) {
        this.mainWindow = mainWindow;
        this.settings = settings;
        this.timer = null;
        this.running = false;
        this.busy = false;
        this.lastDetected = null;
        this.lastAt = null;
        this.lastScore = null;
        this.lastErrorAt = 0;
        this.lastMissingAt = 0;
        this.lastTiming = null;
        this.lagTimer = null;

        /**
         * The key the **overlay is actually showing** (`null` while hidden),
         * as reported by the renderer over `map-detector-shown` on every
         * `Maps.sendMap`. It is what the menu clear is gated on.
         *
         * 0.3.2 gated that on `lastDetected` — the map *this loop* recognised
         * — and the owner's field log shows the hole: in a party the matcher
         * accepted nothing, the owner set the map by hand, `lastDetected`
         * stayed null and the overlay was therefore never cleared back in the
         * menu (not one `menu-streak` line after the manual picks). Only the
         * renderer knows what is on screen, so it says so; main just listens.
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
        /** At most one `show-map-command` per key per SEND_THROTTLE ms. */
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

        // Stored as plain arrays in JSON; Float32Array once, here, so the hot
        // loop never re-allocates. A key holds a *list* of thumbnails since
        // 0.3.3 — one per view of the map panel (Michael / civilian) — and
        // `templateVariants` also accepts the single-thumbnail shape a
        // pre-0.3.3 `templates.json` has.
        this.size = TEMPLATE_FILE.size || DEFAULT_SIZE;
        this.templates = {};
        this.variantCount = 0;
        for (const [key, values] of Object.entries(TEMPLATE_FILE.templates || {})) {
            const variants = templateVariants(values);
            if (!variants.length) continue;
            this.templates[key] = variants;
            this.variantCount += variants.length;
        }
        // The menu strip lives in its own section of templates.json — it is not
        // a map and must never be a candidate in the map match.
        const menu = TEMPLATE_FILE.menu || null;
        this.menuTemplate = menu && Array.isArray(menu.template) ? Float32Array.from(menu.template) : null;
        this.menuWidth = (menu && menu.width) || MENU_TEMPLATE_WIDTH;
        this.menuHeight = (menu && menu.height) || MENU_TEMPLATE_HEIGHT;

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
        // "Clear map" (Ctrl+Shift+D) hides the overlay *and* forgets what was
        // detected, so pressing Tab on the same map detects it again. Without
        // the reset the loop would see an unchanged map and do nothing, and the
        // overlay would stay blank for the rest of the match.
        ipcMain.on('map-detector-reset', () => self.resetLastDetected());
        // What the renderer did with the last `show-map-command`. Main cannot
        // know — it does not own `currentKey` — so the renderer reports back
        // and the log holds the whole chain: match → send → applied/ignored.
        ipcMain.on('map-detector-applied', (event, info) => {
            const {key, applied, reason} = info || {};
            self.log.write('applied', {
                key: key || '',
                applied: applied ? 'yes' : 'no',
                reason: reason || (applied ? 'switched' : '')
            });
            if (debug) console.log(`map-detector: renderer ${applied ? 'applied' : 'ignored'} "${key}"${reason ? ` (${reason})` : ''}`);
        });
        // What the overlay is showing, from the one process that knows. Sent
        // on every `Maps.sendMap`, hides included — see `noteShown`.
        ipcMain.on('map-detector-shown', (event, info) => self.noteShown(info && info.key));
    }

    /**
     * The renderer put a map on the overlay (or took it off).
     *
     * Throttled to actual changes: `sendMap` also fires on an opacity nudge, a
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
            templates: Object.keys(this.templates).length,
            inMenu: this.inMenu
        };
    }

    isRunning() {
        return this.running;
    }

    start() {
        if (this.running) return;
        if (!Object.keys(this.templates).length) {
            console.error('Map detection not started: templates.json holds no templates.');
            return;
        }
        this.running = true;
        console.log(`Map detection started (${Object.keys(this.templates).length} templates, `
            + `${this.variantCount} variants, every ${GAME_INTERVAL} ms while the game is running).`);
        // The detail stays in detector.log; app.log only records that the
        // feature was on, so a report can be read without the other file.
        appLog.event('detector', {action: 'start'});
        this.log.write('loop-start', {
            templates: Object.keys(this.templates).length,
            variants: this.variantCount,
            gameMs: GAME_INTERVAL,
            idleMs: IDLE_INTERVAL,
            version: require('../../package.json').version
        });
        this.windowSeen = null;
        this.sendThrottle.reset();
        this.startLagProbe();
        this.sendStatus({state: 'watching'});
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
        this.lastDetected = null;
        this.menuStreak.reset();
        this.inMenu = false;
        this.windowSeen = null;
        this.sendThrottle.reset();
        appLog.event('detector', {action: 'stop'});
        this.log.write('loop-stop');
        console.log('Map detection stopped.');
        this.sendStatus({state: 'off'});
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
        return `enumerate=${t.enumerate}ms capture=${t.capture}ms match=${t.match}ms total=${t.total}ms`;
    }

    /** A repeating state (game closed, capture refused) must not fill the log. */
    logState(field, message, level) {
        const now = Date.now();
        if (now - this[field] < STATE_LOG_INTERVAL) return;
        this[field] = now;
        (level === 'error' ? console.error : console.log)('Map detection:', message);
    }

    /**
     * The game's window, or null when the game is not running.
     *
     * Three things have to be kept out: this app's own windows (the main window
     * is literally called "Halloween Map Overlay", so a bare name test would
     * match it), minimized windows (Windows hands back a stale or empty image
     * for those), and anything that merely mentions the game — see `GAME_NAME`.
     * An exact `Halloween` / `Halloween.exe` app name wins over a looser one.
     */
    findGameWindow() {
        let fallback = null;
        for (const win of Window.all()) {
            let appName, title, minimized, width, height, pid;
            try {
                appName = (win.appName() || '').trim();
                title = (win.title() || '').trim();
                minimized = win.isMinimized();
                width = win.width();
                height = win.height();
                pid = win.pid();
            } catch (err) {
                // A window can disappear between the enumeration and the reads.
                continue;
            }
            if (minimized) continue;
            if (pid === process.pid) continue;
            if (width < MIN_WINDOW.width || height < MIN_WINDOW.height) continue;
            if (OWN_NAME.test(`${appName} ${title}`)) continue;

            if (/^halloween(\.exe)?$/i.test(appName)) return win;
            // Looser app-name match, or a title match only when the OS gave us
            // no app name at all.
            if (GAME_NAME.test(appName) || (!appName && GAME_NAME.test(title))) {
                if (!fallback) fallback = win;
            }
        }
        return fallback;
    }

    async tick() {
        if (!this.running || this.busy) return;
        this.busy = true;
        // The cadence follows one thing only: is the game up? A Tab press is
        // over in a second or two, so there is no "we already know the map"
        // discount any more.
        let interval = IDLE_INTERVAL;
        const started = Date.now();
        try {
            const win = this.findGameWindow();
            const enumeratedAt = Date.now();
            this.noteWindow(!!win);
            if (!win) {
                // Nothing to capture: a tick costs one window enumeration and
                // stops here, so having the switch on while the game is closed
                // is free.
                this.logState('lastMissingAt', 'game window not found — is Halloween: The Game running?');
                return;
            }
            interval = tickInterval(true);

            const image = await win.captureImage();
            if (!this.running) return;
            const {width, height} = image;
            if (!width || !height) {
                this.logState('lastErrorAt', 'the game window capture came back empty.', 'error');
                return;
            }

            // node-screenshots hands back RGBA. Reduce to 640 px wide while
            // converting to luminance — one pass over the source pixels, no
            // multi-megabyte intermediate, and everything after this is small.
            const raw = await image.toRaw();
            if (!this.running) return;
            const capturedAt = Date.now();

            const outWidth = CAPTURE_WIDTH;
            const outHeight = Math.max(1, Math.round(CAPTURE_WIDTH * height / width));
            const gray = toGrayScaled(raw, width, height, outWidth, outHeight, 'rgba');
            // `report` so the Tab-screen gate's verdict is visible here: a frame
            // that failed the gate is the only one worth showing the menu
            // matcher, and running it on a Tab screen would be pure cost.
            const match = matchMap(gray, outWidth, outHeight, this.templates, {size: this.size, report: true});
            this.lastTiming = {
                enumerate: enumeratedAt - started,
                capture: capturedAt - enumeratedAt,
                match: Date.now() - capturedAt,
                total: Date.now() - started
            };

            if (!match.accepted) {
                if (match.gated) this.checkMenu(gray, outWidth, outHeight);
                else {
                    // The Tab screen was up but nothing was accepted: the one
                    // case where "it did not switch" is the matcher's doing,
                    // and the scores are the only way to tell why.
                    //
                    // `gate=in` says explicitly what the absence of a `gated`
                    // frame used to say implicitly (only gated-*in* frames
                    // reach this line), and `panelMean` is the mean luminance
                    // of the map panel itself: a panel the capture has slid
                    // off, or one the game drew much darker than the template,
                    // is visible in the log without ever keeping a frame.
                    this.log.write('no-match', {
                        score: match.score,
                        second: match.second,
                        margin: match.margin,
                        gate: 'in',
                        panelMean: match.panelMean,
                        tickMs: this.lastTiming.total
                    });
                }
                if (debug) console.log(`map-detector: no match (${width}x${height} → ${outWidth}x${outHeight}) ${this.timingLabel()}`);
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
            // Every accepted match is offered to the renderer, throttled per
            // key so a held Tab does not spam IPC. The renderer drops it when
            // that map is already on the overlay, which is the only place the
            // answer is actually known.
            if (this.sendThrottle.allow(match.key, this.lastAt)) {
                this.log.write('send', {key: match.key});
                if (this.mainWindow) this.mainWindow.send('show-map-command', match.key, {fromDetector: true});
            }
            this.sendStatus({state: 'detected', key: match.key, at: this.lastAt, score: match.score});
        } catch (err) {
            this.log.write('error', {message: (err && err.message) || String(err)});
            this.logState('lastErrorAt', (err && err.message) || String(err), 'error');
        } finally {
            this.busy = false;
            const spent = Date.now() - started;
            if (spent >= SLOW_TICK_MS) this.log.write('slow-tick', {tickMs: spent});
            this.schedule(interval);
        }
    }

    /** Log the game window appearing and disappearing — edges only. */
    noteWindow(present) {
        if (this.windowSeen === present) return;
        this.windowSeen = present;
        this.log.write(present ? 'window-found' : 'window-lost');
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
     * `shownKey`, which the renderer reports.
     *
     * `lastDetected` is cleared along with the overlay so that starting the
     * *same* map again is detected as a change; without that the loop would see
     * no difference and the overlay would stay blank for the whole next match —
     * exactly the trap `clear-map` already has to avoid.
     *
     * @param {Float32Array} gray the reduced capture
     * @param {number} width
     * @param {number} height
     */
    checkMenu(gray, width, height) {
        if (!this.menuTemplate) return;
        if (!this.settings) return;
        if (!shouldWatchMenu(this.shownKey, this.settings.get('hideInMenu'))) {
            this.menuStreak.reset();
            return;
        }

        const menu = matchMenu(gray, width, height, this.menuTemplate, {
            width: this.menuWidth,
            height: this.menuHeight
        });
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
        // Optimistic: the renderer confirms with its own `map-detector-shown`
        // a moment later, but until it does this must not read as "a map is
        // still up" and start a second streak.
        this.shownKey = null;
        // The map is gone from the overlay, so the next detection of it has to
        // go out immediately rather than being eaten by the throttle.
        this.sendThrottle.reset();
        this.log.write('menu-clear', {was: logKey(was), score: menu.score});
        console.log(`Main menu detected (score ${menu.score.toFixed(3)}) — clearing "${was}" from the overlay.`);
        // Through the renderer, not straight at the overlay window: `Maps` owns
        // which map is current, and hiding behind its back would leave Ctrl+H
        // toggling a map that is not on screen.
        if (this.mainWindow) this.mainWindow.send('menu-hide-map');
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
