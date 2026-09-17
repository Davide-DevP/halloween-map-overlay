const os = require('os');
const {app, ipcMain} = require('electron');
const RotatingLog = require('./rotating-log');
const {redactHome} = require('../shared/redact');
const {writeCrashReport} = require('./diagnostics/crash');

/**
 * `app.log` — what the app itself did, as opposed to what the detector decided.
 *
 * The whole 0.3.2 diagnostics batch exists for one sentence: *"it does not
 * work"*. `detector.log` already answers that for auto-detect, and answers
 * nothing else — a hotkey that never registered, an update that failed, a
 * window that died, a setting the user does not remember changing are all
 * invisible. This is that second half: one line per event, in userData, next
 * to the detector's log, collected by the **Create diagnostic report** button.
 *
 * A module-level singleton rather than an injected instance, deliberately.
 * Nearly every module in `src/core` logs something, and threading a logger
 * through eight constructors (several of which are built before the one that
 * would own it) buys nothing: there is exactly one app and exactly one log.
 * `require('./app-log')` and call `event()`.
 *
 * Rules, which are the same rules the detector's log has and are restated here
 * because this log sees far more of the app:
 * - **Never a path under the user's profile.** Every string value is pushed
 *   through `redactHome` on its way in, so an `ENOENT` message or a stack
 *   trace becomes `~/…`. See `src/shared/redact.js`.
 * - **Never a frame, never a map image, never a custom map's file name.** The
 *   custom maps appear as a count and nothing else — the name is something the
 *   user typed.
 * - **Never a reason not to log.** It is not gated on DEBUG (the whole point is
 *   the session that already went wrong) and a write failure costs a line.
 * - Buffered at 500 ms: a slider drag writes a `setting` line per pixel, and
 *   those become one append. Anything that ends the process flushes first.
 */

/** Rotate at 1 MB, one backup. Higher than the detector's 512 KB per file. */
const MAX_BYTES = 1024 * 1024;
const LOG_NAME = 'app.log';
/** Lines held in memory for the crash report. */
const RING_LINES = 200;
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
     * Point the log at a directory (userData) and register the renderer's error
     * channel. Safe to call before `app.whenReady()` — `app.getPath` works
     * there, which is also why `Settings` can read its file that early.
     * @param {?string} dir
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
        // The renderer runs with nodeIntegration, so it could write the file
        // itself — but then two processes would append to one file with two
        // size caches and rotation would lose lines. It reports, main writes.
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

    /**
     * Modules the startup snapshot and the diagnostic report read from.
     * @param {{settings?: Object, language?: Object, mapLibrary?: Object}} context
     */
    setContext(context) {
        this.context = context || {};
        return this;
    }

    /** Redact every string value on its way into the file. One choke point. */
    scrub(fields) {
        if (!fields) return fields;
        const out = {};
        for (const [key, value] of Object.entries(fields)) {
            out[key] = typeof value === 'string' ? redactHome(value, this.home) : value;
        }
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
     * Everything worth knowing about this machine and this install, gathered
     * once. Used twice: written to the log at startup, and regenerated into
     * `system.txt` when a diagnostic report is built (the second copy is the
     * one that reflects settings as they are *now*).
     *
     * GPU info is best effort — `getGPUInfo` rejects on some drivers and in
     * headless sessions, and a report without it is still a report.
     *
     * @returns {Promise<{app: Object, settings: Object, displays: string[], gpu: Object}>}
     */
    async collect() {
        const {settings, language, mapLibrary} = this.context || {};
        let version = 'unknown';
        try {
            version = require('../../package.json').version;
        } catch (err) {
            // Packaged builds always have it; a dev run with a broken tree does not.
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
                customs
            },
            displays,
            // The whole settings object. It holds no paths — see
            // `shared/settings-defaults.js`; `overlayX`/`overlayY` are numbers.
            settings: settings && typeof settings.get === 'function' ? {...settings.settings} : {},
            gpu
        };
    }

    /**
     * The `startup` block. Three lines rather than one 900-character line: the
     * scalars, then the settings snapshot, then the GPU. Each is still exactly
     * one event on one line, and `grep startup-settings app.log` is a thing a
     * person can do.
     */
    async logStartup() {
        const info = await this.collect();
        this.event('startup', {...info.app, monitors: info.displays.join(', ')});
        this.event('startup-settings', info.settings);
        this.event('startup-gpu', info.gpu);
        this.flush();
        return info;
    }

    /**
     * `uncaughtException` → a crash file, then let the process go.
     *
     * Deliberately **not** a swallow. An app that keeps running after an
     * unhandled throw in main is an app in an unknown state, and the failure
     * mode people report ("it just froze") is exactly that. `unhandledRejection`
     * is different: a rejected promise nobody awaited is usually one broken
     * feature, not a broken process, so it is logged and the app lives.
     */
    installCrashHandlers() {
        if (this.crashHandlersInstalled) return;
        this.crashHandlersInstalled = true;

        process.on('uncaughtException', (err) => {
            // console first: if everything below fails, the terminal still has it.
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
     * @param {string} kind
     * @param {Error} err
     * @param {{quit?: boolean}} [opts] `quit: false` records the crash without
     *   ending the process (the renderer death path does its own quitting).
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
