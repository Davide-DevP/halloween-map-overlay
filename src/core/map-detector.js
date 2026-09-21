const {ipcMain, app} = require('electron');
// No `node-screenshots` here: every capture is in `map-detector/frame-source.js`,
// normally in a utility process. This file is the scheduler and the state machine.
const {
    DEFAULT_SIZE, MENU_TEMPLATE_WIDTH, MENU_TEMPLATE_HEIGHT
} = require('./map-detector/matcher');
const DetectorLog = require('./map-detector/log');
const DetectorWorkerHost = require('./map-detector/worker-host');
// `./gc` is required **lazily**, from `start()`: a frozen V8 flag makes its
// `setFlagsFromString` a FATAL rather than a catchable throw, and that risk
// must not sit in the startup path of users who have detection switched off.
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

/** Re-exported; the reasoning is in `map-detector/frame-source.js`. */
const CAPTURE_WIDTH = 640;

/** "Game not running" and capture errors are states, not events: log sparsely. */
const STATE_LOG_INTERVAL = 60000;

/** How many thumbnails a `templates.json` entry holds, **without** building
 * them: main only reports the number, and converting would allocate a megabyte
 * of `Float32Array` for a log line. Accepts both stored shapes. */
function countVariants(entry) {
    if (!entry || !entry.length) return 0;
    if (ArrayBuffer.isView(entry)) return 1;
    const first = entry[0];
    if (Array.isArray(first) || ArrayBuffer.isView(first)) return entry.length;
    return 1;
}

/** A map key as `detector.log` may spell it. The log travels inside the
 * diagnostic report and a custom map's key is a name its owner typed, so it
 * becomes `Custom/(custom)`; shipped keys are catalogue data and go in full. */
function logKey(key) {
    if (!key) return '';
    return key.startsWith(CUSTOM_CREATOR + '/') ? CUSTOM_CREATOR + '/(custom)' : key;
}

/**
 * Automatic map detection: the **scheduler and the state machine** only, off by
 * default (`mapDetection`). No pixels here — they are captured and reduced in
 * the utility process, and the event log records decisions and **never a
 * pixel**. `setTimeout` chaining, never `setInterval`: a slow grab must not
 * queue ticks behind itself. See `docs/agents/detection.md`.
 */
class MapDetector {

    /** @param {{frames?: Object}} [deps] `frames` is the capture source,
     *   injected so the tests can drive the real worker through a fake port */
    constructor(mainWindow, settings, deps) {
        this.mainWindow = mainWindow;
        this.settings = settings;
        this.timer = null;
        this.running = false;
        this.busy = false;
        /** Which run of the loop we are on: a tick from an older run drops its
         * result and does not reschedule. */
        this.runId = 0;
        this.lastDetected = null;
        this.lastAt = null;
        this.lastScore = null;
        this.lastErrorAt = 0;
        this.lastMissingAt = 0;
        this.lastTiming = null;
        /** Post-capture collection cost of the last capturing tick, in ms. */
        this.lastGcMs = 0;
        this.lagTimer = null;

        /**
         * The key the **overlay is actually showing** (null while hidden), from
         * the map controller after every apply, hides included. The menu clear
         * is gated on this and never on `lastDetected` — see `shouldWatchMenu`.
         * Tracked whether or not the loop runs, so a map picked before the
         * switch went on is known.
         */
        this.shownKey = null;

        /** The streak and its transition rule, pure in `detector-rules.js`. */
        this.menuStreak = new MenuStreak(MENU_TICKS_TO_HIDE);
        /** True once the menu has cleared the overlay, until the next detection. */
        this.inMenu = false;
        /** Whether the previous tick found the game window (null = not looked yet). */
        this.windowSeen = null;
        /** The game's pid from that same read, for `gameWindowInfo`. */
        this.gamePid = null;
        /** At most one offer per key per SEND_THROTTLE ms. */
        this.sendThrottle = new SendThrottle(SEND_THROTTLE);

        // Append-only event log in userData, never gated on DEBUG: the point is
        // that the owner can send it after a session that misbehaved.
        let logDir = null;
        try {
            logDir = app && typeof app.getPath === 'function' ? app.getPath('userData') : null;
        } catch (err) {
            console.error('Map detection: no userData path for the event log:', err && err.message);
        }
        this.log = new DetectorLog(logDir);

        this.size = TEMPLATE_FILE.size || DEFAULT_SIZE;
        /** Installed packs' templates: a function returning `[{key, templates}]`,
         * injected because `MapPacks` is built after this class. */
        this.packSource = null;
        /** `core/tab-mode.js`, injected; null means the mode does not exist here. */
        this.tabMode = null;
        /** `core/map-controller.js`, injected: every accepted match and the menu
         * clear go through it, so neither needs a renderer to be alive. */
        this.mapController = null;
        /** Which keys the frame source holds, and how many variants —
         * **counts, not pixels**; a prepared copy here would be dead weight. */
        this.templateKeys = [];
        this.variantCount = 0;
        // The menu strip has its own section of templates.json: it is not a map
        // and must never be a candidate in the map match.
        const menu = TEMPLATE_FILE.menu || null;
        this.menuTemplate = menu && Array.isArray(menu.template) ? Float32Array.from(menu.template) : null;
        this.menuWidth = (menu && menu.width) || MENU_TEMPLATE_WIDTH;
        this.menuHeight = (menu && menu.height) || MENU_TEMPLATE_HEIGHT;

        /** Where frames come from: the utility process, or this one when there
         * is none. **Every** capture in the app goes through it. */
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
        // `resetLastDetected()`, `noteApplied()` and `noteShown()` have no
        // channels: `MapController` calls them. See `docs/SPEC-MAP-STATE.md` §2.2.
    }

    /** @param {?Object} controller `core/map-controller.js`, injected */
    setMapController(controller) {
        this.mapController = controller || null;
    }

    /**
     * Completes the chain in `detector.log`: match → send → applied/ignored.
     * "Ignored, that map is already on the overlay" is the normal answer while
     * Tab is held, and the line that says the loop is working, not stuck.
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

    /** Tab-map mode, injected. It is told an accepted match, a gate verdict and
     * the window disappearing, and decides for itself (`tab-mode-rules.js`). */
    setTabMode(tabMode) {
        this.tabMode = tabMode || null;
    }

    /** Tell Tab-map mode something, without caring whether it exists. */
    notifyTabMode(method, ...args) {
        if (!this.tabMode || typeof this.tabMode[method] !== 'function') return;
        try {
            this.tabMode[method](...args);
        } catch (err) {
            // Tab-map mode must never be able to break the detector loop that
            // the rest of the app depends on.
            console.error(`Map detection: tab mode ${method} failed:`, err && err.message);
        }
    }

    /** Ask Tab-map mode a question, with the same protection — never read off
     * `this.tabMode` inside the tick, where a throw would break every tick. */
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

    /** @param {?Function} fn returns installed packs' `[{key, templates}]` */
    setPackSource(fn) {
        this.packSource = typeof fn === 'function' ? fn : null;
        // The bundled set is already built; packs only exist once this is
        // wired, so fold them in now rather than losing the first session.
        this.loadTemplates();
    }

    /**
     * Count the committed `templates.json` plus every installed pack and hand
     * the merged set to the frame source. A pack **wins on a shared key**, so it
     * can fix a bundled map without a release. **Never runs on a tick.**
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
        // Main counts them and forgets them: `prepareTemplates` runs wherever
        // the matching does, and a prepared copy here would be dead weight.
        this.templateKeys = keys;
        this.variantCount = variantCount;
        // The **only** thing that crosses the process boundary inwards, as the
        // plain arrays `templates.json` holds: build output, not a capture.
        if (this.frames && typeof this.frames.setTemplates === 'function') {
            this.frames.setTemplates({
                templates: merged.templates,
                menu: TEMPLATE_FILE.menu || null,
                size: this.size
            });
        }
        // A pack past the variant budget is *not* loaded — every variant is
        // scored on every gated-in frame — and it is said out loud, because
        // "in the gallery but auto-detect ignores it" has to be answerable.
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

    /** Re-read the templates after a pack install. Safe while the loop runs:
     * the frame source swaps its set in one assignment. */
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
     * A map went on to the overlay (or came off it), from the map controller
     * after every apply. Throttled to actual changes: an apply also fires on an
     * opacity nudge, a rotation and a slider drag. `key` is ""/null when hidden.
     */
    noteShown(key) {
        const next = key || null;
        if (next === this.shownKey) return;
        this.shownKey = next;
        // Restarts the streak *and* withdraws the right to clear until the game
        // is seen outside the menu again.
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
        // Cleared by hand, so the next match on that map must go out at once
        // rather than waiting out the throttle window.
        this.sendThrottle.reset();
        if (debug) console.log('map-detector: last detection cleared.');
        this.sendStatus({state: this.running ? 'watching' : 'off'});
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
     * The game window as the last tick saw it — the **state**, because
     * `noteWindow` only fires on an edge and a feature switched on between two
     * edges would wait for the next one, possibly the next game restart.
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
        // A new run: anything still in flight belongs to the previous one and
        // must not clear this run's `busy`, schedule its next tick, or act on a
        // frame captured before the switch was turned off and on again.
        this.runId++;
        // Resolved here, not at module load — see `let gc` above. Wrapped
        // because a collector-less detector is a documented oscillation, not a fault.
        if (!gc) {
            try {
                gc = require('./gc');
            } catch (err) {
                console.error('Map detection: the collector could not be loaded:', err && err.message);
                gc = {collect: () => {}, isAvailable: () => false};
            }
        }
        // The collector belongs where the frames are: the child loads its own,
        // so this is for the **fallback** source, which captures in this process.
        if (this.frames.setGc) this.frames.setGc(gc);
        console.log(`Map detection started (${this.templateKeys.length} templates, `
            + `${this.variantCount} variants, every ${GAME_INTERVAL} ms while the game is running).`);
        // app.log only records that the feature was on, so a report can be read
        // without detector.log beside it.
        appLog.event('detector', {action: 'start'});
        this.log.write('loop-start', {
            templates: this.templateKeys.length,
            variants: this.variantCount,
            gameMs: GAME_INTERVAL,
            idleMs: IDLE_INTERVAL,
            // A silent no-op collector is worth ~110 MB of peak during a match,
            // and this is the only place it is ever recorded.
            gc: gc.isAvailable() ? 'available' : 'noop',
            version: require('../../package.json').version
        });
        this.windowSeen = null;
        this.sendThrottle.reset();
        // Now, and not before: the process exists only while frames are wanted.
        const worker = this.frames.start ? this.frames.start() : null;
        this.log.write('detector-source', worker
            ? {mode: worker.mode, reason: worker.reason}
            : {mode: 'in-process', reason: 'injected'});
        this.startLagProbe();
        this.sendStatus({state: 'watching'});
        // Tab-map mode requires auto-detect, so it follows this switch instead
        // of having one of its own. Notified after `running` is true.
        this.notifyTabMode('syncWithSettings');
        this.schedule(0);
    }

    /** DEBUG only: how late a 200 ms timer fires, i.e. how long the main thread
     * was blocked — the number that says whether the detector makes the machine
     * stutter. Leave it in. */
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
        // A tick may be waiting on a grab; its `finally` is guarded by `runId`
        // and clears nothing, so the flag is cleared here — otherwise the next
        // `start()` finds the loop permanently "busy" and never ticks again.
        this.busy = false;
        this.lastDetected = null;
        this.menuStreak.reset();
        this.inMenu = false;
        this.windowSeen = null;
        this.sendThrottle.reset();
        appLog.event('detector', {action: 'stop'});
        this.log.write('loop-stop');
        console.log('Map detection stopped.');
        // `running` is already false, so this takes the Tab markers down: the
        // mode cannot outlive the thing that names the map it is drawing.
        this.notifyTabMode('syncWithSettings');
        // Nothing wants a frame, so the whole utility process goes away.
        if (this.frames.stop) this.frames.stop();
        this.sendStatus({state: 'off'});
    }

    /** Quit or update: closes the utility process for good. A child holding the
     * native capture module while the installer replaces the app directory is a
     * shape that has caused trouble here before. */
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

    /** Milliseconds for the last tick. `capture` is the native grab plus the
     * raw-pixel copy; `match` is the reduction, the gate and the NCCs. */
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

    /** One capture, gate and match, for Tab-map mode's confirming press —
     * through the same frame source, so there is exactly one place in the app
     * that touches pixels. Answers with decisions and numbers, never pixels. */
    grabMatch() {
        return this.frames.grab({match: true});
    }

    /** Tab-map mode's cheap "is the Tab screen still up?" safety check while its
     * markers are shown: capture and gate, no luminance and no NCC. */
    grabGate() {
        return this.frames.grab({match: false});
    }

    /**
     * The cadence for a tick that produced no verdict about the window: the last
     * answer that *did* still stands, so a window seen a moment ago comes back
     * at the game cadence rather than the 2 s "no game" one.
     * @param {number} fallback what to use when the window has never been seen
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
        // Re-checked after the await and in the `finally`: the user can switch
        // detection off and on again while a grab is in flight.
        const runId = this.runId;
        let interval = IDLE_INTERVAL;
        const started = Date.now();
        /** Did this tick pull pixels? Only then is there a gc number to print. */
        let capturedFrame = false;
        try {
            // Whether the menu matcher is wanted is decided **here**, before any
            // pixel work: it depends on state main owns, not the worker.
            const wantMenu = !!(this.menuTemplate && this.settings
                && shouldWatchMenu(this.shownKey, this.settings.get('hideInMenu')));
            const reply = await this.frames.grab({menu: wantMenu});
            if (!this.running || this.runId !== runId) return;
            // **No answer is not an answer about the window**, and not a reason
            // to slow down. Check `aborted` and `error` **before** `window`, or
            // a stop reads as the game having been closed.
            if (reply.aborted) {
                if (debug) console.log(`map-detector: no frame this tick (${reply.reason})`);
                interval = this.knownWindowInterval(interval);
                // No answer over live gameplay means take the markers down.
                this.notifyTabMode('onLost', 'no-frame');
                return;
            }
            // A failed capture with the window still there (an alt-tab, a
            // display-mode change) is a second of trouble, not a closed game.
            if (reply.error) {
                this.lastTiming = reply.timings || this.lastTiming;
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
            // Kept so a mode switched on *between* window edges can read it
            // (`gameWindowInfo`) instead of waiting for the next edge.
            this.gamePid = gamePid;
            this.noteWindow(!!win.present, gamePid);
            if (!win.present) {
                this.logState('lastMissingAt', 'game window not found — is Halloween: The Game running?');
                // The game window is the surface Tab-map mode draws on, so
                // losing it must take those markers down at once.
                this.notifyTabMode('onLost', 'no-window');
                return;
            }
            interval = tickInterval(true, {
                gameMs: this.askTabMode('wantsFasterDetection', false) ? TAB_DETECT_INTERVAL : null
            });
            this.lastTiming = reply.timings || null;
            // The collection was paid where the frame was, never here.
            this.lastGcMs = (reply.timings && reply.timings.gc) || 0;

            // Tab-map mode's cheapest signal: a gated-out frame while its
            // markers are up means Tab is down, at no extra cost at all.
            this.notifyTabMode('onGate', !!reply.gate);

            if (!reply.gate) {
                // Ordinary gameplay: the common case, every tick of a match.
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
                // The one case where "it did not switch" is the matcher's doing,
                // and the scores are the only way to tell why. `panelMean` makes
                // a slipped or dimmed panel diagnosable without keeping a frame.
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

            // A Tab screen is the clearest possible "not in the menu", so the
            // map about to go up may be cleared when the match ends.
            this.menuStreak.noteMatch();
            this.inMenu = false;
            this.lastScore = match.score;
            this.lastAt = Date.now();
            const changed = match.key !== this.lastDetected;
            // `lastDetected` gates the menu clear and drives the status line;
            // it does **not** decide whether to send.
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
            // Throttled per key so a held Tab does not spam the controller,
            // which drops a map already on the overlay — it is the one that knows.
            if (this.sendThrottle.allow(match.key, this.lastAt)) {
                this.log.write('send', {key: match.key});
                if (this.mapController) this.mapController.detected(match.key);
            }
            // **Every** accepted match, not only the throttled ones: a re-show
            // after a hide must not wait out the throttle. `started` travels with
            // it because the key can be released *during* a capture, and Tab mode
            // drops anything older than its last hide.
            this.notifyTabMode('onMatch', match.key, gameRect, win.captured || null, started);
            this.sendStatus({state: 'detected', key: match.key, at: this.lastAt, score: match.score});
        } catch (err) {
            this.log.write('error', {message: (err && err.message) || String(err)});
            this.logState('lastErrorAt', (err && err.message) || String(err), 'error');
            // A tick that threw is no answer about the Tab screen, and no
            // answer means take the markers down.
            this.notifyTabMode('onLost', 'detector-error');
        } finally {
            // A tick from a previous run must not clear this run's busy flag or
            // schedule its next tick — that would be two loops chaining at once.
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
     * Log the game window appearing and disappearing — **edges only**, so this
     * is not a per-tick cost. Tab-map mode is told on the same edge: its key
     * trigger has nothing to do without a game window, and the pid it compares
     * the foreground process against comes from this very read.
     */
    noteWindow(present, pid) {
        if (this.windowSeen === present) return;
        this.windowSeen = present;
        this.log.write(present ? 'window-found' : 'window-lost');
        this.notifyTabMode('onWindow', present, pid || null);
    }

    /**
     * A gated-out frame's menu verdict, as the frame source computed it.
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
     * Back in the main menu? Clear the overlay. Runs only on a tick that failed
     * the Tab-screen gate, and only while **a map is on the overlay**, whoever
     * put it there (`shownKey`, never `lastDetected` — see `shouldWatchMenu`).
     *
     * `lastDetected` is cleared along with the overlay so that starting the
     * *same* map again reads as a change; without that the overlay would stay
     * blank for the whole next match, the trap `clear-map` also has to avoid.
     *
     * @param {{score: number, accepted: boolean}} menu the verdict
     */
    applyMenuVerdict(menu) {
        // The streak and both of its rules live in the pure `MenuStreak`; this
        // half only logs and acts.
        const verdict = this.menuStreak.note(menu.accepted);
        if (!menu.accepted) {
            if (verdict.broke) this.log.write('menu-streak', {ticks: 0, score: menu.score, broke: 'yes'});
            if (debug && menu.score > 0.5) {
                console.log(`map-detector: menu score ${menu.score.toFixed(3)} (below threshold)`);
            }
            return;
        }
        if (verdict.waiting) {
            // The map went up *during* the menu — a pick between matches.
            // Nothing is taken away until the game leaves the menu.
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
        // Optimistic: the controller confirms with its own `noteShown` a moment
        // later, but until then this must not read as "a map is still up" and
        // start a second streak.
        this.shownKey = null;
        // The next detection of this map has to go out at once rather than
        // being eaten by the throttle.
        this.sendThrottle.reset();
        // The match is over, so anything drawn on the game's own map goes too —
        // before the controller is even told about the overlay.
        this.notifyTabMode('onLost', 'menu');
        this.log.write('menu-clear', {was: logKey(was), score: menu.score});
        console.log(`Main menu detected (score ${menu.score.toFixed(3)}) — clearing "${was}" from the overlay.`);
        // Through the map controller, never straight at the overlay window: it
        // owns which map is current, and hiding behind its back would leave the
        // toggle hotkey switching a map that is not on screen.
        if (this.mapController) this.mapController.menuHide();
        this.sendStatus({state: 'menu'});
    }

    sendStatus(payload) {
        if (!this.mainWindow) return;
        this.mainWindow.send('map-detector-status', Object.assign(this.status(), payload));
    }
}

module.exports = MapDetector;
// Re-exports: these all live in the pure `shared/detector-rules.js`, shared
// with `core/foreground.js` so the two cannot disagree about the game's window.
module.exports.GAME_INTERVAL = GAME_INTERVAL;
module.exports.IDLE_INTERVAL = IDLE_INTERVAL;
module.exports.SEND_THROTTLE = SEND_THROTTLE;
module.exports.CAPTURE_WIDTH = CAPTURE_WIDTH;
module.exports.MENU_TICKS_TO_HIDE = MENU_TICKS_TO_HIDE;
module.exports.GAME_NAME = GAME_NAME;
module.exports.OWN_NAME = OWN_NAME;
module.exports.MIN_WINDOW = MIN_WINDOW;
