'use strict';

const {BrowserWindow, ipcMain} = require('electron');
const {webPreferences} = require('../shared/web-preferences');
const appLog = require('./app-log');
const {PAD_RECORD_TIMEOUT} = require('../shared/tab-mode-rules');
const {resolveMapPad, resolvePadId, padLabel} = require('../shared/pad-codes');
const {errorMessage} = require('../shared/errors');
const {clearTimer, unrefTimer} = require('../shared/timers');

/**
 * ELECTRON tier: the **hidden window that reads the controller** through the
 * Gamepad API, which exists only in a renderer — the app's one controller path. Nothing is ever shown; it is
 * built only while a controller button is configured (or being chosen) and
 * closed again otherwise — unlike `tab-overlay-window.js`, closing is *not*
 * for good, because the button can be set and cleared all day.
 *
 * `backgroundThrottling: false` is the one thing that makes it work, and the
 * one deviation from the shared builder's default: Chromium samples gamepads
 * only for a *visible* page, and Electron reports a hidden window's page as
 * hidden unless throttling is off. Why: docs/agents/memory.md and
 * docs/agents/markers-and-tab-mode.md § The controller button.
 *
 * What crosses from the renderer: `pad-edge` (down/up of the one watched
 * button), `pad-recorded` (one code and that pad's `Gamepad.id`), `pad-seen`
 * (a count). Never a reading; the id is never logged.
 */
class PadWindow {

    constructor() {
        this.window = null;
        this.ready = false;
        /** Set at quit: nothing may build the window again. */
        this.destroyed = false;
        /** What the renderer was last told, so a repeat costs nothing. */
        this.watch = {on: false, code: null, id: null};
        /** The window could not be built: what Settings calls "unavailable". */
        this.failed = false;
        this.onEdge = null;
        this.recording = null;
        this.counters = {edges: 0, padsSeen: 0, created: 0};
        this.handlers = null;
    }

    /** Only messages from *this* window's renderer are believed. */
    fromMe(event) {
        return !!(this.window && !this.window.isDestroyed()
            && event && event.sender === this.window.webContents);
    }

    listen() {
        if (this.handlers) return;
        this.handlers = {
            edge: (event, down) => {
                if (!this.fromMe(event)) return;
                this.counters.edges++;
                if (typeof this.onEdge === 'function') {
                    try { this.onEdge(down === true); } catch (err) {
                        console.error('Controller: edge handler failed:', err && err.message);
                    }
                }
            },
            recorded: (event, answer) => {
                if (!this.fromMe(event)) return;
                const a = answer || {};
                const resolved = resolveMapPad(a.code);
                if (this.recording && resolved !== null) {
                    this.recording.finish({ok: true, code: resolved, label: padLabel(resolved), id: resolvePadId(a.id)});
                }
            },
            seen: (event, count) => {
                if (!this.fromMe(event)) return;
                this.counters.padsSeen = typeof count === 'number' ? count : 0;
            }
        };
        ipcMain.on('pad-edge', this.handlers.edge);
        ipcMain.on('pad-recorded', this.handlers.recorded);
        ipcMain.on('pad-seen', this.handlers.seen);
    }

    /** Build the hidden window if it does not exist yet. @returns {boolean} usable */
    ensure() {
        if (this.destroyed) return false;
        if (this.window && !this.window.isDestroyed()) return true;
        this.window = null;
        this.ready = false;
        this.watch = {on: false, code: null, id: null};
        try {
            this.window = new BrowserWindow({
                show: false,
                width: 1,
                height: 1,
                focusable: false,
                skipTaskbar: true,
                frame: false,
                webPreferences: webPreferences({backgroundThrottling: false})
            });
        } catch (err) {
            console.error('Controller: could not create the input window:', err && err.message);
            appLog.error('pad-window', {action: 'create-failed', message: errorMessage(err)});
            this.window = null;
            this.failed = true;
            return false;
        }
        this.failed = false;
        this.listen();
        this.counters.created++;
        this.window.webContents.on('did-finish-load', () => {
            this.ready = true;
            // Re-send what it should be doing: a reload forgets everything.
            const wanted = this.watch;
            this.watch = {on: false, code: null, id: null};
            this.setWatch(wanted.on, wanted.code, wanted.id);
            if (this.recording) this.send('pad-record', {on: true});
        });
        this.window.webContents.on('render-process-gone', (event, details) => {
            const reason = (details && details.reason) || 'unknown';
            appLog.error('render-process-gone', {where: 'pad-window', reason, exitCode: details && details.exitCode});
            this.ready = false;
            if (typeof this.onEdge === 'function') this.onEdge(false);
            if (reason === 'clean-exit') return;
            setTimeout(() => {
                try {
                    if (this.window && !this.window.isDestroyed()) this.window.reload();
                } catch (err) {
                    console.error('Controller: reload failed:', err && err.message);
                }
            }, 100);
        });
        this.window.loadFile('src/map/pad.html');
        appLog.event('pad-window', {action: 'created'});
        return true;
    }

    send(channel, ...data) {
        if (!this.window || this.window.isDestroyed() || !this.ready) return;
        try {
            this.window.webContents.send(channel, ...data);
        } catch (err) {
            console.error('Controller: could not send to the input window:', err && err.message);
        }
    }

    /**
     * Read the pad, or stop. `on` is decided by the caller from the same three
     * facts as the key read: the trigger runs, a button is set, the game is in
     * front. `id` is the chosen pad's `Gamepad.id`, for `padsToRead`. Idempotent.
     */
    setWatch(on, code, id) {
        const resolved = resolveMapPad(code);
        const next = {on: on === true && resolved !== null, code: resolved, id: resolvePadId(id)};
        if (next.on === this.watch.on && next.code === this.watch.code && next.id === this.watch.id) return;
        // `ensure()` resets `watch` when it has to build the window, so it
        // runs first; `did-finish-load` then re-sends whatever `watch` holds.
        if (next.on && !this.ensure()) return;
        this.watch = next;
        this.send('pad-watch', next);
    }

    /**
     * *Choose button…* through the Gamepad API. Resolves, never rejects:
     * `{ok: true, code, label, id}` or `{ok: false, reason}`.
     * @param {{timeoutMs?}} [opts]
     */
    record(opts) {
        const o = opts || {};
        if (this.recording) this.recording.finish({ok: false, reason: 'replaced'});
        if (!this.ensure()) return Promise.resolve({ok: false, reason: 'unavailable'});
        const timeoutMs = typeof o.timeoutMs === 'number' && o.timeoutMs > 0 ? o.timeoutMs : PAD_RECORD_TIMEOUT;
        return new Promise((resolve) => {
            const rec = {timer: null, done: false};
            rec.finish = (result) => {
                if (rec.done) return;
                rec.done = true;
                rec.timer = clearTimer(rec.timer);
                if (this.recording === rec) this.recording = null;
                this.send('pad-record', {on: false});
                resolve(result);
            };
            rec.timer = unrefTimer(setTimeout(() => {
                rec.finish({ok: false, reason: this.counters.padsSeen > 0 ? 'timeout' : 'no-controller'});
            }, timeoutMs));
            this.recording = rec;
            this.send('pad-record', {on: true});
        });
    }

    cancelRecord(why) {
        if (!this.recording) return false;
        this.recording.finish({ok: false, reason: why || 'cancelled'});
        return true;
    }

    /** Close the window; it can be built again. */
    close() {
        this.cancelRecord('closed');
        this.watch = {on: false, code: null, id: null};
        this.ready = false;
        if (this.window) {
            if (!this.window.isDestroyed()) {
                appLog.event('pad-window', {action: 'closed'});
                this.window.close();
            }
            this.window = null;
        }
    }

    /** Quit or update: closed for good. */
    destroy() {
        this.destroyed = true;
        this.close();
        if (this.handlers) {
            ipcMain.removeListener('pad-edge', this.handlers.edge);
            ipcMain.removeListener('pad-recorded', this.handlers.recorded);
            ipcMain.removeListener('pad-seen', this.handlers.seen);
            this.handlers = null;
        }
    }

    /** What `system.txt` prints: existence, the watch, counts — never the id. */
    status() {
        return {
            exists: !!(this.window && !this.window.isDestroyed()),
            failed: this.failed,
            ready: this.ready,
            watching: this.watch.on,
            padsSeen: this.counters.padsSeen,
            edges: this.counters.edges,
            created: this.counters.created
        };
    }
}

module.exports = PadWindow;
