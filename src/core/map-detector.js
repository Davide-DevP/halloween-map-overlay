const {desktopCapturer, ipcMain, screen} = require('electron');
const {toGray, matchMap, DEFAULT_SIZE} = require('./map-detector/matcher');
const TEMPLATE_FILE = require('./map-detector/templates.json');

const debug = process.env.DEBUG === 'true';

/** Poll period while nothing has been recognised. */
const SEARCH_INTERVAL = 2000;
/** Poll period after a successful detection — a map lasts a whole match. */
const DETECTED_INTERVAL = 5000;
/** What we ask `desktopCapturer` for. Big enough for a 64x64 map thumbnail. */
const THUMBNAIL_SIZE = {width: 640, height: 360};
/** A capture that keeps failing must not fill the log. */
const ERROR_LOG_INTERVAL = 60000;

/**
 * Automatic map detection (phase 2).
 *
 * Off by default (`mapDetection` setting). While on, it grabs a 640x360
 * thumbnail of the display the overlay is configured for every 1.5 s, runs it
 * through the pure matcher in `map-detector/matcher.js`, and — when it sees the
 * in-game Tab screen showing a *different* map than the last one it recognised
 * — tells the renderer to switch, on the same `show-map-command` channel the
 * CLI uses.
 *
 * Deliberate choices:
 * - The frame never leaves this function. It is not stored, not written to
 *   disk, not sent anywhere, and the only thing derived from it that survives
 *   the tick is a map name.
 * - A manual pick by the user does **not** stop detection (the reference app
 *   works that way and it is wrong here): the user asked for "press Tab once
 *   and the overlay is right". Detection only acts on a map *different* from
 *   `lastDetected`, so overriding by hand is never fought over — the next Tab
 *   press showing the same map changes nothing.
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
        this.lastTiming = null;
        this.lagTimer = null;

        // Stored as plain arrays in JSON; Float32Array once, here, so the hot
        // loop never re-allocates.
        this.size = TEMPLATE_FILE.size || DEFAULT_SIZE;
        this.templates = {};
        for (const [key, values] of Object.entries(TEMPLATE_FILE.templates || {})) {
            this.templates[key] = Float32Array.from(values);
        }

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
    }

    /** Forget the last detection so even the same map is acted on again. */
    resetLastDetected() {
        if (!this.lastDetected) return;
        this.lastDetected = null;
        this.lastAt = null;
        this.lastScore = null;
        if (debug) console.log('map-detector: last detection cleared.');
        this.sendStatus({state: this.running ? 'watching' : 'off'});
        // Look again now rather than sitting out the 5 s post-detection wait.
        if (this.running) this.schedule(0);
    }

    /** @returns {{running, lastDetected, lastAt, lastScore, templates}} */
    status() {
        return {
            running: this.running,
            lastDetected: this.lastDetected,
            lastAt: this.lastAt,
            lastScore: this.lastScore,
            templates: Object.keys(this.templates).length
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
        console.log(`Map detection started (${Object.keys(this.templates).length} templates, every ${SEARCH_INTERVAL} ms).`);
        this.startLagProbe();
        this.sendStatus({state: 'watching'});
        this.schedule(0);
    }

    /**
     * DEBUG only: how late a 200 ms timer actually fires, i.e. how long the
     * main thread was blocked. The capture call is native and synchronous once
     * it reaches the compositor, so this is the number that says whether the
     * detector is making the UI (and the machine) stutter. Peak drift is
     * reported once every 10 s and reset.
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
     * `capture=… match=… total=…` in milliseconds for the last tick.
     *
     * The capture number is the one that matters: `desktopCapturer.getSources`
     * is the expensive half by two orders of magnitude, and it is the reason
     * the poll period is measured in seconds rather than frames.
     */
    timingLabel() {
        const t = this.lastTiming;
        if (!t) return '';
        return `capture=${t.capture}ms match=${t.match}ms total=${t.total}ms`;
    }

    logError(message) {
        const now = Date.now();
        if (now - this.lastErrorAt < ERROR_LOG_INTERVAL) return;
        this.lastErrorAt = now;
        console.error('Map detection:', message);
    }

    /**
     * The display the overlay is on — the same `monitor` index Settings ›
     * Overlay writes and `get-displays` enumerates.
     */
    targetDisplay() {
        const displays = screen.getAllDisplays();
        const index = parseInt(this.settings ? this.settings.get('monitor') : 0) || 0;
        return displays[index] || displays[0] || screen.getPrimaryDisplay();
    }

    /**
     * Pick the capture source for that display. `display_id` is the reliable
     * link; the index is only a fallback for platforms that leave it empty.
     */
    pickSource(sources, display) {
        if (!sources || !sources.length) return null;
        if (display) {
            const wanted = String(display.id);
            const byId = sources.find(s => String(s.display_id) === wanted);
            if (byId) return byId;
        }
        const index = parseInt(this.settings ? this.settings.get('monitor') : 0) || 0;
        return sources[index] || sources[0];
    }

    async tick() {
        if (!this.running || this.busy) return;
        this.busy = true;
        let interval = SEARCH_INTERVAL;
        const started = Date.now();
        let capturedAt = started;
        try {
            const display = this.targetDisplay();
            const sources = await desktopCapturer.getSources({
                types: ['screen'],
                thumbnailSize: THUMBNAIL_SIZE,
                fetchWindowIcons: false
            });
            capturedAt = Date.now();
            if (!this.running) return;

            const source = this.pickSource(sources, display);
            if (!source || !source.thumbnail || source.thumbnail.isEmpty()) {
                this.logError('no screen capture source available.');
                return;
            }

            const {width, height} = source.thumbnail.getSize();
            if (!width || !height) {
                this.logError('capture returned an empty frame.');
                return;
            }

            // BGRA on every platform Electron supports. The buffer, the
            // luminance frame and the thumbnail all go out of scope here.
            const gray = toGray(source.thumbnail.toBitmap(), width, height);
            const match = matchMap(gray, width, height, this.templates, {size: this.size});
            this.lastTiming = {
                capture: capturedAt - started,
                match: Date.now() - capturedAt,
                total: Date.now() - started
            };

            if (!match) {
                if (debug) console.log(`map-detector: no match (${width}x${height} from "${source.name}") ${this.timingLabel()}`);
                return;
            }

            interval = DETECTED_INTERVAL;
            this.lastScore = match.score;
            this.lastAt = Date.now();
            if (match.key === this.lastDetected) {
                if (debug) console.log(`map-detector: still "${match.key}" (${match.score.toFixed(3)})`);
                this.sendStatus({state: 'detected', key: match.key, at: this.lastAt, score: match.score});
                return;
            }

            this.lastDetected = match.key;
            console.log(`Map detected: ${match.key} (score ${match.score.toFixed(3)}, margin ${match.margin.toFixed(3)}) ${this.timingLabel()}`);
            if (this.mainWindow) this.mainWindow.send('show-map-command', match.key, {fromDetector: true});
            this.sendStatus({state: 'detected', key: match.key, at: this.lastAt, score: match.score});
        } catch (err) {
            this.logError((err && err.message) || String(err));
        } finally {
            this.busy = false;
            this.schedule(interval);
        }
    }

    sendStatus(payload) {
        if (!this.mainWindow) return;
        this.mainWindow.send('map-detector-status', Object.assign(this.status(), payload));
    }
}

module.exports = MapDetector;
module.exports.SEARCH_INTERVAL = SEARCH_INTERVAL;
module.exports.DETECTED_INTERVAL = DETECTED_INTERVAL;
module.exports.THUMBNAIL_SIZE = THUMBNAIL_SIZE;
