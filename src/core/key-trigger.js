'use strict';

const appLog = require('./app-log');
const {KEY_POLL_INTERVAL, keyHintFor, foldMapInputs} = require('../shared/tab-mode-rules');
const {VK_MENU, resolveMapVk} = require('../shared/key-codes');
const {resolveMapPad} = require('../shared/pad-codes');
const {errorMessage} = require('../shared/errors');
const {clearTimer, unrefTimer} = require('../shared/timers');

/** Zeroed at construction and on every `start()`; `status()` prints them. */
function freshCounters() {
    return {polls: 0, downs: 0, ups: 0, errors: 0};
}

/**
 * ELECTRON tier: Tab-map mode's **key-state trigger** — koffi → `user32`
 * `GetAsyncKeyState`, asking whether *one* key is held and reporting the edges.
 * The map key's optional second input, one controller button, is read by
 * `core/pad-window.js`; its level is pushed here and folded into the same tick.
 *
 * **The privacy contract, which this code must keep rather than imply.**
 * Exactly **two** virtual keys are ever queried: the map key, and `VK_MENU`
 * only while the map key reads down. The pushed controller level counts only
 * while the game is in front. Nothing about any key or button is logged but
 * the edges of that one input, and nothing is stored or sent. Deliberately **not** `globalShortcut` (it *reserves* the key
 * and has no key-up), **not** a keyboard hook, **not** `GetKeyboardState`.
 * Loaded **lazily**, every step wrapped because any can fail on a user's
 * machine, after which `core/tab-mode.js` falls back to polling. Why, and the
 * measurements: docs/agents/markers-and-tab-mode.md § The key-state trigger.
 */
class KeyTrigger {

    /**
     * @param {{onHint, mapVk?, mapPad?, intervalMs?, load?, log?}} opts
     *   `intervalMs` in ms; `load` returns koffi, injected so the tests can
     *   drive the failures.
     */
    constructor(opts) {
        const o = opts || {};
        this.onHint = typeof o.onHint === 'function' ? o.onHint : () => {};
        this.mapVk = resolveMapVk(o.mapVk);
        /** The controller button, or null: the pad is read only with one set. */
        this.mapPad = resolveMapPad(o.mapPad);
        this.intervalMs = typeof o.intervalMs === 'number' && o.intervalMs > 0
            ? o.intervalMs : KEY_POLL_INTERVAL;
        this.loader = typeof o.load === 'function' ? o.load : () => require('koffi');
        this.logLine = typeof o.log === 'function' ? o.log : null;
        /** The Gamepad API's level for the button, pushed by `core/pad-window.js`. */
        this.apiPadDown = false;
        /** Last foreground verdict, so `onForeground` fires on edges only. */
        this.foreground = null;
        /** Called with true/false when the game gains or loses the front. */
        this.onForeground = null;

        /** The bound functions, or null until `open()` succeeds. */
        this.fn = null;
        /** **Tri-state**: null = untried, and that is not the same as broken. */
        this.usable = null;
        /** Why it is not usable, for the log, `system.txt` and the notice. */
        this.reason = null;
        this.timer = null;
        this.running = false;
        /** Last known state of the map key, for edge detection. */
        this.wasDown = false;
        /** The game's process id, from the detector's window read. */
        this.gamePid = null;
        /** Counters for `system.txt`. */
        this.counters = freshCounters();
        /** So the "it works" line is written once, not on every `open()`. */
        this.loggedAvailable = false;
    }

    /**
     * Load koffi and bind `user32`. Idempotent, never throws, and **does not
     * start the poll**: availability is not "running".
     */
    open() {
        if (this.fn) return {ok: true, reason: null};
        if (this.usable === false) return {ok: false, reason: this.reason};
        let koffi;
        try {
            koffi = this.loader();
        } catch (err) {
            return this.fail('load', err);
        }
        if (!koffi || typeof koffi.load !== 'function') return this.fail('load', new Error('no koffi.load'));
        try {
            const user32 = koffi.load('user32.dll');
            this.fn = {
                // SHORT GetAsyncKeyState(int vKey) — the high bit is "down".
                getAsyncKeyState: user32.func('__stdcall', 'GetAsyncKeyState', 'int16_t', ['int']),
                // HWND GetForegroundWindow(void)
                getForegroundWindow: user32.func('__stdcall', 'GetForegroundWindow', 'void *', []),
                // The pid comes back through the out parameter, not the return.
                getWindowThreadProcessId: user32.func('__stdcall', 'GetWindowThreadProcessId', 'uint32_t',
                    ['void *', koffi.out(koffi.pointer('uint32_t'))])
            };
        } catch (err) {
            return this.fail('bind', err);
        }
        // Prove it before claiming it works. **The probe reads no key**: the
        // help text promises keys are read only while the game is in front.
        try {
            this.fn.getForegroundWindow();
        } catch (err) {
            this.fn = null;
            return this.fail('probe', err);
        }
        this.usable = true;
        this.reason = null;
        if (!this.loggedAvailable) {
            this.loggedAvailable = true;
            appLog.event('tab-key-trigger', {available: 'yes', where: 'probe'});
        }
        return {ok: true, reason: null};
    }

    /** Record why the trigger is unusable, once, and answer no. */
    fail(where, err) {
        this.fn = null;
        this.usable = false;
        // The message can carry a path; `app.log` redacts those, and `reason`
        // is one of four fixed words.
        this.reason = where;
        appLog.warn('tab-key-trigger', {
            available: 'no',
            where,
            message: errorMessage(err)
        });
        console.error(`Tab markers: the key trigger is unavailable (${where}):`, err && err.message);
        return {ok: false, reason: where};
    }

    /** @returns {boolean} whether the native path is usable at all. */
    isAvailable() {
        if (this.usable === null) this.open();
        return this.usable === true;
    }

    /** Which key is watched, and where the game is. */
    setMapVk(vk) {
        const next = resolveMapVk(vk);
        if (next === this.mapVk) return;
        this.mapVk = next;
        // No stale "down" from the old key: the next reading starts from "up".
        this.wasDown = false;
    }

    /** Which controller button is watched; null = none, and the pad is not read. */
    setMapPad(code) {
        const next = resolveMapPad(code);
        if (next === this.mapPad) return;
        this.mapPad = next;
        this.wasDown = false;
        this.apiPadDown = false;
    }

    /** The controller button's level, pushed by `core/pad-window.js`; read on the next tick. */
    setApiPadDown(down) {
        this.apiPadDown = down === true;
    }

    /** Remember the foreground and tell the owner on a change. */
    noteForeground(foreground) {
        const next = foreground === true;
        if (next === this.foreground) return;
        this.foreground = next;
        if (typeof this.onForeground === 'function') {
            try { this.onForeground(next); } catch (err) {
                console.error('Tab markers: foreground handler failed:', err && err.message);
            }
        }
    }

    /** The game's pid from the detector's read — **not** a second enumeration. */
    setGamePid(pid) {
        this.gamePid = typeof pid === 'number' && pid > 0 ? pid : null;
    }

    /**
     * Is the game the foreground window *right now*? Asked directly, not taken
     * from the foreground watcher's ≤1 s-stale verdict, whose answer costs a
     * `Window.all()` enumeration this loop must not pay.
     * @returns {?boolean} false when it cannot be established; **null** when
     *   the call threw, which is "no answer", not "no", and gives up.
     */
    isGameForeground() {
        if (!this.fn) return null;
        if (!this.gamePid) return false;
        try {
            const hwnd = this.fn.getForegroundWindow();
            if (!hwnd) return false;
            const out = [0];
            this.fn.getWindowThreadProcessId(hwnd, out);
            return out[0] === this.gamePid;
        } catch (err) {
            this.counters.errors++;
            return null;
        }
    }

    /** A call that worked once and then threw: stop rather than spin. */
    giveUp() {
        this.fail('call', new Error('a user32 call failed'));
        this.stop();
        if (this.onUnavailable) this.onUnavailable('call');
    }

    /** Is one virtual key down? `null` when the call failed. */
    isDown(vk) {
        if (!this.fn) return null;
        try {
            // The **high** bit only: the low bit is per-caller sticky state.
            return (this.fn.getAsyncKeyState(vk) & 0x8000) !== 0;
        } catch (err) {
            this.counters.errors++;
            return null;
        }
    }

    /** @returns {boolean} false = unusable, the caller's signal to poll instead. */
    start() {
        if (this.running) return true;
        const opened = this.open();
        if (!opened.ok) return false;
        this.running = true;
        this.wasDown = false;
        this.counters = freshCounters();
        this.schedule(0);
        return true;
    }

    stop() {
        this.timer = clearTimer(this.timer);
        if (!this.running) return;
        this.running = false;
        // A key held when the loop stops must not look held when it starts.
        this.wasDown = false;
        this.apiPadDown = false;
        this.noteForeground(false);
    }

    /** `setTimeout` chaining, never `setInterval` — the project-wide rule. */
    schedule(delay) {
        if (!this.running) return;
        clearTimer(this.timer);
        this.timer = unrefTimer(setTimeout(() => this.tick(), delay));
    }

    /**
     * One reading: one foreground read; then, **only in the game**, one key
     * read; then, only while it is held, one Alt read. The pushed controller
     * level counts only in the game too. **That ordering is the privacy
     * promise itself. Do not reorder it.**
     */
    tick() {
        this.timer = null;
        if (!this.running) return;
        this.counters.polls++;
        const foreground = this.isGameForeground();
        if (foreground === null) {
            this.giveUp();
            return;
        }
        this.noteForeground(foreground);
        // Not in the game: **no key or button is read at all**, and a held one
        // resolves to "up" below, so leaving the game hides the markers.
        const keyDown = foreground ? this.isDown(this.mapVk) : false;
        if (keyDown === null) {
            this.giveUp();
            return;
        }
        // Alt is only asked about while the key reads as down.
        const alt = keyDown ? this.isDown(VK_MENU) === true : false;
        const padDown = foreground && this.mapPad !== null ? this.apiPadDown : false;
        const folded = foldMapInputs({key: keyDown, pad: padDown, alt});
        const verdict = keyHintFor({
            down: folded.down,
            alt: folded.alt,
            foreground,
            wasDown: this.wasDown,
            enabled: this.running
        });
        this.wasDown = verdict.down;
        if (verdict.hint) {
            if (verdict.hint === 'down') this.counters.downs++;
            else this.counters.ups++;
            // The only thing about a key or button that ever reaches a log.
            const line = {state: verdict.hint, reason: verdict.reason};
            if (verdict.hint === 'down' && folded.source) line.source = folded.source;
            if (this.logLine) this.logLine('tab-key', line);
            try {
                this.onHint(verdict.hint, verdict.reason);
            } catch (err) {
                console.error('Tab markers: key hint handler failed:', err && err.message);
            }
        }
        this.schedule(this.intervalMs);
    }

    /** What `system.txt` prints. */
    status() {
        return {
            // Verbatim — three answers, not two. See `this.usable`.
            available: this.usable,
            reason: this.reason,
            running: this.running,
            vk: this.mapVk,
            intervalMs: this.intervalMs,
            polls: this.counters.polls,
            downs: this.counters.downs,
            ups: this.counters.ups,
            errors: this.counters.errors,
            // The one configured code; `core/pad-window.js` reports the rest.
            pad: {code: this.mapPad}
        };
    }

    destroy() {
        this.stop();
        this.fn = null;
    }
}

module.exports = KeyTrigger;
