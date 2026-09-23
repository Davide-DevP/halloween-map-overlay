const os = require('os');
const {app, ipcMain} = require('electron');
const RotatingLog = require('./rotating-log');
const {redactHome, redactSettings} = require('../shared/redact');
const {writeCrashReport} = require('./diagnostics/crash');

/**
 * `app.log` — what the app itself did, as opposed to what the detector decided.
 * A **module-level singleton**. See `docs/agents/diagnostics.md`.
 */

/** Rotate at 1 MB, one backup. Higher than the detector's 512 KB per file. */
const MAX_BYTES = 1024 * 1024;
const LOG_NAME = 'app.log';
/** Lines held in memory for the crash report. */
const RING_LINES = 200;
/** A slider drag writes a `setting` line per pixel; those become one append. */
const FLUSH_MS = 500;

class AppLog {

    constructor() {
        /** Set by `init()`. Until then writes go to the ring buffer only. */
        this.log = new RotatingLog(null, {ringSize: RING_LINES});
        this.dir = null;
        this.home = null;
        this.context = {};
        this.crashHandlersInstalled = false;
        this.exiting = false;
    }

    /**
     * Point the log at a directory and register the renderer's error channel.
     * Safe before `app.whenReady()` — `app.getPath` works there, which is also
     * why `Settings` can read its file that early.
     */
    init(dir) {
        let target = dir || null;
        try {
            if (!target && app && typeof app.getPath === 'function') target = app.getPath('userData');
            this.home = app && typeof app.getPath === 'function' ? app.getPath('home') : os.homedir();
        } catch (err) {
            console.error('app.log: no userData path:', err && err.message);
        }
        this.dir = target;
        this.log = new RotatingLog(target, {
            name: LOG_NAME,
            limit: MAX_BYTES,
            flushMs: FLUSH_MS,
            ringSize: RING_LINES,
            failMessage: 'app.log could not be written:'
        });
        // The renderer reports, main writes: two processes appending to one file
        // with two size caches would lose lines at the rotation boundary.
        ipcMain.on('renderer-error', (event, info) => {
            const {kind, message, stack, source, line} = info || {};
            this.error('error', {
                where: 'renderer',
                kind: kind || 'error',
                message: message || '',
                source: source || '',
                line: line === undefined ? null : line,
                stack: stack || ''
            });
        });
        return this;
    }

    /** @param {{settings?, language?, mapLibrary?}} context read by `collect()` */
    setContext(context) {
        this.context = context || {};
        return this;
    }

    /** PRIVACY CHOKE POINT: no path under the user's profile reaches the log. */
    scrub(fields) {
        if (!fields) return fields;
        const out = {};
        for (const [key, value] of Object.entries(fields)) {
            const clean = this.scrubValue(value, 0);
            // The writer prints one token per field: a structure becomes JSON
            // *after* every string inside it was redacted. A log call never throws.
            if (clean !== null && typeof clean === 'object') {
                try { out[key] = JSON.stringify(clean); } catch (_) { out[key] = '[unserialisable]'; }
            } else {
                out[key] = clean;
            }
        }
        return out;
    }

    // Strings anywhere in a field: an Error's message, an array, a nested
    // object. Rule 3 holds for whatever a caller passes, not only strings.
    scrubValue(value, depth) {
        if (typeof value === 'string') return redactHome(value, this.home);
        if (value instanceof Error) return redactHome(`${value.name}: ${value.message}`, this.home);
        if (value === null || typeof value !== 'object') return value;
        // Past the depth cap nothing raw goes through: the rest is dropped.
        if (depth >= 4) return '[nested]';
        if (Array.isArray(value)) return value.map(v => this.scrubValue(v, depth + 1));
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = this.scrubValue(v, depth + 1);
        return out;
    }

    event(event, fields) {
        this.log.write(event, this.scrub(fields), 'info');
    }

    warn(event, fields) {
        this.log.write(event, this.scrub(fields), 'warn');
    }

    error(event, fields) {
        this.log.write(event, this.scrub(fields), 'error');
    }

    /** Write anything queued. Called before the app quits or crashes. */
    flush() {
        try {
            this.log.flush();
        } catch (err) {
            // Never let the log stop a shutdown.
        }
    }

    /** The last lines still in memory — what a crash report carries. */
    recent(count) {
        return this.log.recent(count);
    }

    /** Absolute path of the live log file, or null when it is disabled. */
    file() {
        return this.log.file;
    }

    /**
     * This machine and this install. Used twice: the startup lines, and
     * `system.txt`, whose copy reflects the settings as they are *now*.
     * @returns {Promise<{app: Object, settings: Object, displays: string[], gpu: Object}>}
     */
    async collect() {
        const {settings, language, mapLibrary} = this.context || {};
        let version = 'unknown';
        try {
            version = require('../../package.json').version;
        } catch (err) {
            // Only a dev run with a broken tree gets here.
        }

        let displays = [];
        try {
            // Required lazily: `screen` throws if it is touched before `ready`,
            // and this module is loaded by index.js as its very first import.
            const {screen} = require('electron');
            displays = screen.getAllDisplays().map(d =>
                `${d.bounds.width}x${d.bounds.height}@${d.scaleFactor}${d.bounds.x || d.bounds.y ? `+${d.bounds.x}+${d.bounds.y}` : ''}`);
        } catch (err) {
            displays = [];
        }

        // Custom maps are a count and nothing else: the name is user text.
        let maps = 0;
        let customs = 0;
        try {
            const catalog = mapLibrary ? mapLibrary.getCatalog() : [];
            for (const entry of catalog) {
                if (entry.custom) customs++;
                else maps++;
            }
        } catch (err) {
            // The catalogue is a directory listing; a locked folder is not fatal.
        }

        let gpu = {};
        try {
            // Best effort: `getGPUInfo` rejects on some drivers and headless.
            const info = await app.getGPUInfo('basic');
            if (info && typeof info === 'object') {
                gpu = {
                    vendor: info.gpuDevice && info.gpuDevice[0] ? `0x${Number(info.gpuDevice[0].vendorId).toString(16)}` : '',
                    device: info.gpuDevice && info.gpuDevice[0] ? `0x${Number(info.gpuDevice[0].deviceId).toString(16)}` : '',
                    driver: info.gpuDevice && info.gpuDevice[0] ? (info.gpuDevice[0].driverVersion || '') : '',
                    auxAttributes: info.auxAttributes ? (info.auxAttributes.glRenderer || '') : ''
                };
            }
        } catch (err) {
            gpu = {error: (err && err.message) || 'unavailable'};
        }

        // A silent fall back to the no-op collector costs ~110 MB of peak in
        // main during a match (`docs/MEMORY-REPORT-2.md` §4). Asking also
        // *builds* it, hence once, here.
        let gc = 'unknown';
        try {
            gc = require('./gc').isAvailable() ? 'available' : 'noop';
        } catch (err) {
            gc = 'error';
        }

        return {
            app: {
                version,
                electron: process.versions.electron || '',
                chrome: process.versions.chrome || '',
                node: process.versions.node || '',
                platform: process.platform,
                release: os.release(),
                arch: process.arch,
                locale: (() => {
                    try {
                        return app.getLocale();
                    } catch (err) {
                        return '';
                    }
                })(),
                language: language && typeof language.current === 'function' ? language.current() : '',
                packaged: !!app.isPackaged,
                portable: !!process.env.PORTABLE_EXECUTABLE_DIR,
                displays: displays.length,
                maps,
                customs,
                gc
            },
            displays,
            // No paths (`settings-defaults.js`); a device id becomes (set)/(none).
            settings: settings && typeof settings.get === 'function' ? redactSettings(settings.settings) : {},
            gpu
        };
    }

    /** Three events rather than one 900-character line, so each is greppable. */
    async logStartup() {
        const info = await this.collect();
        this.event('startup', {...info.app, monitors: info.displays.join(', ')});
        this.event('startup-settings', info.settings);
        this.event('startup-gpu', info.gpu);
        this.flush();
        return info;
    }

    /**
     * `uncaughtException` → a crash file, then let the process go: deliberately
     * **not** a swallow, while `unhandledRejection` deliberately is one.
     */
    installCrashHandlers() {
        if (this.crashHandlersInstalled) return;
        this.crashHandlersInstalled = true;

        process.on('uncaughtException', (err) => {
            // console first: if all of the below fails, the terminal has it.
            console.error('Uncaught exception:', err);
            this.fatal('uncaughtException', err);
        });

        process.on('unhandledRejection', (reason) => {
            const err = reason instanceof Error ? reason : new Error(String(reason));
            console.error('Unhandled rejection:', err && err.message);
            this.error('error', {
                kind: 'unhandledRejection',
                message: err.message || '',
                stack: err.stack || ''
            });
        });
    }

    /**
     * Log a fatal error, write the crash file with the ring buffer, and exit.
     * @param {{quit?: boolean}} [opts] `quit: false` records the crash without
     *   ending the process (the renderer death path quits for itself)
     * @returns {?string} the crash file name
     */
    fatal(kind, err, opts = {}) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.error('error', {kind, fatal: 'yes', message: error.message || '', stack: error.stack || ''});
        this.flush();
        let name = null;
        try {
            const version = (() => {
                try {
                    return require('../../package.json').version;
                } catch (e) {
                    return '';
                }
            })();
            const written = writeCrashReport(this.dir, {
                kind,
                version,
                electron: process.versions.electron,
                platform: process.platform,
                arch: process.arch,
                message: error.message,
                stack: error.stack,
                recent: this.recent(),
                home: this.home
            });
            name = written.name;
            if (!written.ok) console.error('Crash report could not be written:', written.error);
            else console.error(`Crash report written: ${written.name}`);
        } catch (e) {
            console.error('Crash report failed:', e && e.message);
        }
        if (opts.quit === false) return name;
        if (this.exiting) return name;
        this.exiting = true;
        // Not `app.quit()`: the app is in an unknown state and `quit` runs
        // handlers that may themselves be what threw. Hard exit, non-zero.
        process.exit(1);
        return name;
    }
}

module.exports = new AppLog();
module.exports.AppLog = AppLog;
module.exports.LOG_NAME = LOG_NAME;
module.exports.MAX_BYTES = MAX_BYTES;
module.exports.RING_LINES = RING_LINES;
