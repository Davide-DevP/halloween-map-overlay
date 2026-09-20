'use strict';

const appLog = require('./app-log');
const {KEY_POLL_INTERVAL, keyHintFor} = require('../shared/tab-mode-rules');
const {VK_MENU, resolveMapVk} = require('../shared/key-codes');

/**
 * Tab-map mode's **key-state trigger**: it asks Windows whether *one* key —
 * the game's map key — is currently held, and reports the edges.
 *
 * ## What this does and does not read
 *
 * `GetAsyncKeyState(vk)` answers one question about one virtual-key code: is
 * that key down right now? It is not a hook, it receives nothing, it cannot
 * see characters, and it cannot enumerate the keyboard. This module queries
 * **two** codes and no others, ever:
 *
 *   - the map key (the `tabMarkerKey` setting, default Tab);
 *   - `VK_MENU` (either Alt), and only while the map key reads as down, purely
 *     so Alt+Tab is not mistaken for the player opening the map.
 *
 * Nothing about any key is logged except the **edges of that one key**
 * (`tab-key down` / `tab-key up` in `detector.log`), and nothing at all is
 * stored or sent. Deliberately **not** used:
 *
 *   - `globalShortcut` / `RegisterHotKey` — it *reserves* the combination, so
 *     the game would stop seeing its own map key, and it has no key-up event
 *     at all, which is the half that matters most here.
 *   - a keyboard hook (`SetWindowsHookEx`, `uiohook`, `iohook`) — that would
 *     put every keystroke on the machine through this process. Reading one
 *     key's state is the smallest thing that answers the question.
 *   - `GetKeyboardState` / `GetKeyState` — the first returns all 256 keys at
 *     once, which is more than is needed and more than should be read.
 *
 * ## Why koffi
 *
 * Prebuilt N-API binaries per platform (`@koromix/koffi-win32-x64`), so there
 * is no compile step and `npm ci` on the CI runner needs nothing extra —
 * exactly the property that made `node-screenshots` acceptable. Measured on the
 * dev machine with plain node: `require('koffi')` 7.7 ms **once**, binding the
 * three functions 0.19 ms, and then
 *
 *   GetAsyncKeyState                          28 ns/call
 *   GetForegroundWindow + …ThreadProcessId   302 ns/call
 *
 * At the 30 ms poll one `GetAsyncKeyState` is 0.00009 % of one core.
 *
 * ## Everything can fail, and then the polling path takes over
 *
 * The module is loaded **lazily**, only when Tab-map mode starts, and every
 * step is wrapped: a missing package, a `user32` bind that throws, a call that
 * throws, an antivirus that blocks the native module (Bitdefender has killed
 * unsigned processes on the owner's machine before — see
 * `docs/agents/updater-and-installer.md`). Any of
 * those sets `unavailable` with a reason, and `core/tab-mode.js` falls back to
 * the polling implementation, which is complete on its own.
 */
class KeyTrigger {

    /**
     * @param {{onHint: Function, mapVk?: number, intervalMs?: number,
     *          load?: Function, log?: Function}} opts
     *   The **only** two virtual keys this class ever queries are the map key
     *   and `VK_MENU`, and neither is read unless the game is the foreground
     *   window — see `tick()`.
     *   `load` returns the koffi module — injected so `test/key-trigger.test.js`
     *   can drive the success *and* the failure paths without the native
     *   module, which is the half that decides whether a user with an
     *   over-eager antivirus still gets the feature.
     */
    constructor(opts) {
        const o = opts || {};
        this.onHint = typeof o.onHint === 'function' ? o.onHint : () => {};
        this.mapVk = resolveMapVk(o.mapVk);
        this.intervalMs = typeof o.intervalMs === 'number' && o.intervalMs > 0
            ? o.intervalMs : KEY_POLL_INTERVAL;
        this.loader = typeof o.load === 'function' ? o.load : () => require('koffi');
        this.logLine = typeof o.log === 'function' ? o.log : null;

        /** The bound functions, or null until `open()` succeeds. */
        this.fn = null;
        /** Null = never tried; true/false = the verdict of the last `open()`. */
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
        this.counters = {polls: 0, downs: 0, ups: 0, errors: 0};
        /** So the "it works" line is written once, not on every `probe()`. */
        this.loggedAvailable = false;
    }

    /**
     * Load koffi and bind the three `user32` functions. Idempotent, and it
     * never throws: the answer is the return value.
     *
     * @returns {{ok: boolean, reason: ?string}}
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
                // DWORD GetWindowThreadProcessId(HWND, LPDWORD) — the pid comes
                // back through the out parameter, not the return value (which
                // is the thread id).
                getWindowThreadProcessId: user32.func('__stdcall', 'GetWindowThreadProcessId', 'uint32_t',
                    ['void *', koffi.out(koffi.pointer('uint32_t'))])
            };
        } catch (err) {
            return this.fail('bind', err);
        }
        // Prove it before claiming it works: a bound function that throws on
        // the first call would otherwise fall back mid-match rather than at
        // start-up, which is the worse moment to change behaviour.
        //
        // **The probe reads no key.** `GetForegroundWindow()` takes no
        // arguments, returns a window handle and tells us nothing about the
        // keyboard — it is the most harmless call in the binding, and it
        // exercises exactly what has to work (koffi loaded, `user32` bound, a
        // `__stdcall` into it returns). It used to probe with
        // `GetAsyncKeyState`, which meant "is the native path available?" could
        // not be answered without reading a key, and the help text promises
        // that keys are read only while the game is in front.
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

    /**
     * Load, bind and probe **without starting the poll** — so the app can say
     * whether the native path works even with the game closed.
     *
     * This is what the first field run needed: the trigger is only *started*
     * when there is a game window, so with the game shut nothing had ever been
     * tried, and the app reported "not available on this PC" about something it
     * had not looked at. Now availability is a separate question from whether
     * the loop is running, and it is answered once, here.
     *
     * @returns {{ok: boolean, reason: ?string}}
     */
    probe() {
        return this.open();
    }

    /** Record why the trigger is unusable, once, and answer no. */
    fail(where, err) {
        this.fn = null;
        this.usable = false;
        // The message can carry a path (a failed `require`), and `app.log`
        // redacts those; the reason itself is one of four fixed words.
        this.reason = where;
        appLog.warn('tab-key-trigger', {
            available: 'no',
            where,
            message: (err && err.message) || String(err)
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
        // A key that changes while the old one is held must not leave a stale
        // "down" behind: the next reading starts from "up", so a genuine press
        // of the new key is a fresh edge.
        this.wasDown = false;
    }

    /**
     * The game's pid, from the detector's own window read — **not** a second
     * window enumeration. `GetForegroundWindow` gives an HWND and
     * `GetWindowThreadProcessId` its pid, and that is compared against this.
     * Measured: `node-screenshots`' `pid()` and the pid Windows reports for the
     * focused window agree.
     * @param {?number} pid
     */
    setGamePid(pid) {
        this.gamePid = typeof pid === 'number' && pid > 0 ? pid : null;
    }

    /**
     * Is the game the foreground window *right now*?
     *
     * 302 ns, against the ~1 s staleness of the foreground watcher's last
     * verdict — and the watcher's own answer costs a `Window.all()`
     * enumeration, which is exactly what must not happen every 30 ms. So the
     * watcher is left to the hotkeys and this asks Windows directly, using the
     * pid the detector already read.
     *
     * Read only when it can matter (the key reads as down), so the steady-state
     * cost of the loop is one 28 ns call.
     *
     * @returns {?boolean} false when it cannot be established — the safe
     *   direction, since a `down` that is refused only means "do not show".
     *   **null** when the call itself threw, which is not "no" but "no answer"
     *   and makes the caller give the whole native path up.
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

    /**
     * A call that worked once and then threw. Stop rather than spin: the caller
     * falls back to the polling path, which always works.
     */
    giveUp() {
        this.fail('call', new Error('a user32 call failed'));
        this.stop();
        if (this.onUnavailable) this.onUnavailable('call');
    }

    /** Is one virtual key down? `null` when the call failed. */
    isDown(vk) {
        if (!this.fn) return null;
        try {
            // The **high** bit only. The low bit is "pressed since the last
            // call", which is per-caller sticky state; using it would make two
            // readers of the same key interfere, and all this needs is the
            // physical state.
            return (this.fn.getAsyncKeyState(vk) & 0x8000) !== 0;
        } catch (err) {
            this.counters.errors++;
            return null;
        }
    }

    /**
     * Start polling. Returns false when the native path is not usable, which is
     * the caller's signal to use the polling implementation instead.
     * @returns {boolean}
     */
    start() {
        if (this.running) return true;
        const opened = this.open();
        if (!opened.ok) return false;
        this.running = true;
        this.wasDown = false;
        this.counters = {polls: 0, downs: 0, ups: 0, errors: 0};
        this.schedule(0);
        return true;
    }

    stop() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        if (!this.running) return;
        this.running = false;
        // A key held when the loop stops must not look held when it starts
        // again: the next reading is an edge from "up", so a key the player is
        // still holding produces a fresh `down` rather than nothing at all.
        this.wasDown = false;
    }

    /** `setTimeout` chaining, never `setInterval` — the project-wide rule. */
    schedule(delay) {
        if (!this.running) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.tick(), delay);
        // The loop must never be the reason the process stays alive.
        if (this.timer.unref) this.timer.unref();
    }

    /**
     * One reading.
     *
     * **The foreground is read first, and the key is not read at all unless the
     * game is the window in front.** That ordering is the difference between
     * "the app reads your keyboard while the game is running" and "the app asks
     * about one key only while you are actually in the game" — and the second
     * is what the README, the FAQ and the help text say, so it has to be what
     * the code does rather than a consequence of how the answer is used later.
     *
     * It costs 302 ns against the 28 ns it guards, which at 30 ms is 0.001 % of
     * one core: the honest ordering is affordable, and the expensive thing here
     * was never either call.
     *
     * So a tick is: one foreground read; then, only in the game, one key read;
     * then, only while that key is held, one Alt read.
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
        // Not in the game: nothing is asked about any key at all. A held key is
        // still resolved to "up" below, so leaving the game hides the markers.
        const down = foreground ? this.isDown(this.mapVk) : false;
        if (down === null) {
            // The call started throwing after working once. Stop rather than
            // spin: the caller falls back to polling, which always works.
            this.giveUp();
            return;
        }
        // Alt is only asked about while the key reads as down.
        const alt = down ? this.isDown(VK_MENU) === true : false;
        const verdict = keyHintFor({
            down,
            alt,
            foreground,
            wasDown: this.wasDown,
            enabled: this.running
        });
        this.wasDown = verdict.down;
        if (verdict.hint) {
            if (verdict.hint === 'down') this.counters.downs++;
            else this.counters.ups++;
            // The one thing about a key that ever reaches a log: the edge of
            // this single key, with why it was refused when it was.
            if (this.logLine) this.logLine('tab-key', {state: verdict.hint, reason: verdict.reason});
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
            // `this.usable` verbatim: true (probed, works), false (probed,
            // failed) and **null** (never probed) are three different answers,
            // and flattening the third into `false` is what made the app claim
            // the native path was unavailable when it had simply not been
            // tried yet.
            available: this.usable,
            reason: this.reason,
            running: this.running,
            vk: this.mapVk,
            intervalMs: this.intervalMs,
            polls: this.counters.polls,
            downs: this.counters.downs,
            ups: this.counters.ups,
            errors: this.counters.errors
        };
    }

    destroy() {
        this.stop();
        this.fn = null;
    }
}

module.exports = KeyTrigger;
