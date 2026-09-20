const electron = require('electron');
const nodeScreenshots = require('node-screenshots');
const appLog = require('./app-log');
const {classifyWindow} = require('../shared/detector-rules');
const {
    FOREGROUND_GAME, FOREGROUND_OWN, FOREGROUND_OTHER, FOREGROUND_UNKNOWN,
    shouldHotkeysBeActive
} = require('../shared/hotkeys-rules');

/**
 * Which window is in the foreground, for the `hotkeysGameOnly` setting.
 *
 * A global shortcut is taken from **every** application on the machine. With
 * this on, the app holds its combinations only while the player is actually in
 * the game — or in one of our own windows, so a hotkey can still be tried from
 * Settings › Hotkeys, which is exactly where somebody who just rebound one is
 * standing. The rest of the time the combinations belong to whatever is in
 * front.
 *
 * ## Why this poll is not the capture path
 *
 * `docs/agents/detection.md`'s "The capture path — do not make it heavier" is about
 * `captureImage()`/`toRaw()`/`toGrayScaled()`, the ~6-11 ms of blocking JS per
 * detector tick. **Nothing here captures a frame.** The whole tick is
 * `Window.all()` plus one `isFocused()` per window, measured on the
 * development machine with plain node against the installed
 * `node-screenshots` 0.2.8:
 *
 * | | cost |
 * |---|---|
 * | `Window.all()` (5 windows) | 0.27 ms first call, 0.06-0.09 ms after |
 * | `all()` + `isFocused()` over every window | **0.06-0.32 ms** |
 *
 * At one tick a second that is under 0.03 % of one core, and it does not grow
 * when the game is closed — the enumeration is the same size and there is
 * nothing to capture. With the setting off no timer runs at all.
 *
 * `isFocused()` is the one thing that made this possible without a new native
 * dependency: it is in `node_modules/node-screenshots/index.d.ts` and it works
 * on Windows (verified — the scan reported exactly one focused window, the
 * browser that had focus at the time). The alternatives were all worse: a new
 * native module for `GetForegroundWindow`, a `powershell`/`tasklist` child
 * process per tick (hundreds of milliseconds and a visible process spawn),
 * or Electron's `desktopCapturer`, which is the very thing the detector was
 * moved off.
 *
 * ## Shape
 *
 * - `setTimeout` chaining, never `setInterval`: a slow enumeration must not
 *   queue ticks behind itself.
 * - App-window focus is an **event**, not a poll: `browser-window-focus` /
 *   `browser-window-blur` re-evaluate immediately, so alt-tabbing into
 *   Settings takes effect at once rather than up to a second later.
 * - The callback fires only on a **change** of the active/inactive verdict.
 *   `Hotkeys.setActive()` registers or unregisters the whole set, and doing
 *   that once a second would be a pointless amount of churn.
 * - **`destroy()` reports nothing.** It runs from `before-quit`, which is also
 *   the update path, and `stop()` alone would announce "the setting is off, so
 *   register everything" — a full `loadKeys()` inside the quit handler. The
 *   `destroyed` flag is set before `stop()` and gates every other entry point.
 *   Turning the *setting* off still reports, because that one has to put the
 *   hotkeys back; `test/foreground.test.js` holds the two apart.
 */

/** Poll period while the game is running: "about once a second" (spec §4). */
const FOREGROUND_INTERVAL = 1000;

/**
 * Poll period while there is no game window. The same enumeration, but there
 * is nothing to wait for: the game has to start before anything can change,
 * and a 2 s reaction to that is invisible.
 */
const FOREGROUND_IDLE_INTERVAL = 2000;

/** A failing window enumeration is a state, not an event: log sparsely. */
const ERROR_LOG_INTERVAL = 60000;

class ForegroundWatcher {

    /**
     * @param {Object} settings `core/settings.js`
     * @param {(active: boolean) => void} onChange called only when the verdict
     *   changes, with the new one.
     * @param {{app?: Object, BrowserWindow?: Object, Window?: Object}} [deps]
     *   the three things this class touches outside itself. Injectable so the
     *   lifecycle (above all: `destroy()` must **not** re-register the hotkeys
     *   on the way out) is unit testable — `require('electron')` outside
     *   Electron is just a path string, so without this the class could not be
     *   constructed in a test at all. The real app never passes it.
     */
    constructor(settings, onChange, deps = {}) {
        this.settings = settings;
        this.onChange = typeof onChange === 'function' ? onChange : () => {};
        this.app = deps.app || electron.app;
        this.BrowserWindow = deps.BrowserWindow || electron.BrowserWindow;
        this.Window = deps.Window || nodeScreenshots.Window;
        this.timer = null;
        this.started = false;
        /**
         * True once `destroy()` has run. A destroyed watcher reports nothing
         * ever again: `destroy()` is called from `before-quit`, which is also
         * the update path, and `stop()` alone would report "the setting is off,
         * so register everything" — i.e. `loadKeys()` re-registering a dozen
         * global shortcuts inside the quit handler, milliseconds before the
         * process goes away (and, on the update path, while the installer is
         * being handed control).
         */
        this.destroyed = false;
        /** 'game' | 'own' | 'other' | 'unknown' */
        this.foreground = FOREGROUND_UNKNOWN;
        /** Whether the last enumeration saw a game window at all. */
        this.gameRunning = false;
        /** The last verdict handed to `onChange`; null = never reported. */
        this.active = null;
        this.lastErrorAt = 0;

        // Focus of our *own* windows comes from Electron, not from the poll:
        // it is free, it is instant, and `BrowserWindow.getFocusedWindow()`
        // already means exactly "one of this app's windows is in front".
        this.onAppFocus = () => this.evaluate(FOREGROUND_OWN);
        this.onAppBlur = () => {
            // Losing focus does not say who gained it, so look now instead of
            // waiting out the rest of the current tick.
            this.schedule(0);
        };
        this.app.on('browser-window-focus', this.onAppFocus);
        this.app.on('browser-window-blur', this.onAppBlur);
    }

    /** True unless the setting has been explicitly switched off. */
    gameOnly() {
        return !(this.settings && this.settings.get('hotkeysGameOnly') === false);
    }

    /**
     * Follow the setting. Called at boot and whenever the switch is flipped.
     *
     * With the setting off there is no timer at all — the hotkeys are simply
     * always registered, which is what every version up to 0.6.0 did.
     */
    syncWithSettings() {
        if (this.destroyed) return;
        if (this.gameOnly()) this.start();
        else this.stop();
    }

    start() {
        if (this.destroyed || this.started) return;
        this.started = true;
        appLog.event('hotkeys-foreground', {action: 'start', intervalMs: FOREGROUND_INTERVAL});
        this.tick();
    }

    stop() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        if (this.started) appLog.event('hotkeys-foreground', {action: 'stop'});
        this.started = false;
        this.foreground = FOREGROUND_UNKNOWN;
        this.gameRunning = false;
        // With the watcher off the setting is off, so the hotkeys go back to
        // being always registered. Announced through the same callback so
        // there is one path that turns them on.
        this.report();
    }

    /** Timer + listeners down, and **no** report — see `this.destroyed`. */
    destroy() {
        if (this.destroyed) return;
        // Set first, so the `stop()` below cannot report on the way out.
        this.destroyed = true;
        this.stop();
        this.app.removeListener('browser-window-focus', this.onAppFocus);
        this.app.removeListener('browser-window-blur', this.onAppBlur);
    }

    schedule(delay) {
        if (this.destroyed || !this.started) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.tick(), delay);
    }

    tick() {
        if (this.destroyed || !this.started) return;
        let interval = FOREGROUND_IDLE_INTERVAL;
        try {
            const scan = this.scan();
            this.gameRunning = scan.gameRunning;
            // Electron's answer wins for our *own* windows: it is certain,
            // whereas the enumeration can miss one (the overlay is
            // `focusable: false` and never appears as focused at all).
            this.foreground = this.BrowserWindow.getFocusedWindow() ? FOREGROUND_OWN : scan.foreground;
            // The scan runs even while one of ours is in front — it is ~0.1 ms
            // and it is where `gameRunning` comes from, which the diagnostic
            // report would otherwise print as "no" for anybody who made the
            // report from the Settings window.
            interval = scan.gameRunning ? FOREGROUND_INTERVAL : FOREGROUND_IDLE_INTERVAL;
        } catch (err) {
            // Fail open: a machine whose window list cannot be read must still
            // have working hotkeys, or the symptom is "no hotkeys at all" with
            // nothing on screen to explain it.
            this.foreground = FOREGROUND_UNKNOWN;
            this.gameRunning = false;
            this.logError(err);
        } finally {
            this.report();
            this.schedule(interval);
        }
    }

    /**
     * One pass over the window list.
     *
     * The focused window decides, and the game's own presence is noted on the
     * way past so the cadence can drop while the game is closed. Reads are
     * wrapped per window: a window can vanish between the enumeration and the
     * read, exactly as in `MapDetector.findGameWindow`.
     *
     * @returns {{foreground: string, gameRunning: boolean}}
     */
    scan() {
        let foreground = FOREGROUND_OTHER;
        let gameRunning = false;
        let focusedIsGame = false;
        let focusedIsOwn = false;
        let sawFocused = false;

        for (const win of this.Window.all()) {
            let info;
            let focused;
            try {
                info = {
                    appName: win.appName() || '',
                    title: win.title() || '',
                    minimized: win.isMinimized(),
                    width: win.width(),
                    height: win.height(),
                    pid: win.pid()
                };
                focused = win.isFocused();
            } catch (err) {
                continue;
            }
            const verdict = classifyWindow(info, process.pid);
            if (verdict === 'game' || verdict === 'game-maybe') gameRunning = true;
            if (!focused) continue;
            sawFocused = true;
            // An exact app-name match wins; a looser one still counts, since
            // the window with the keyboard focus is not a guess.
            if (verdict === 'game' || verdict === 'game-maybe') focusedIsGame = true;
            else if (verdict === 'own') focusedIsOwn = true;
        }

        if (focusedIsGame) foreground = FOREGROUND_GAME;
        else if (focusedIsOwn) foreground = FOREGROUND_OWN;
        // Nothing in the list reported focus at all. That is genuinely "we do
        // not know" rather than "somebody else": on Windows it is the desktop
        // shell (which is not enumerated), a lock screen — or an exclusive
        // fullscreen game window the enumeration did not return, which is
        // precisely the case where declaring "other" would switch the hotkeys
        // off *while the player is in the game* and leave nothing on screen to
        // explain it. `unknown` fails open, so it degrades to 0.6.0 behaviour.
        else if (!sawFocused) foreground = FOREGROUND_UNKNOWN;

        return {foreground, gameRunning};
    }

    /**
     * Take the verdict from the current foreground without waiting for a tick.
     * @param {string} foreground one of the FOREGROUND_* values
     */
    evaluate(foreground) {
        if (this.destroyed || !this.started) return;
        this.foreground = foreground;
        this.report();
    }

    /** Hand the verdict over — only when it changed, and never once destroyed. */
    report() {
        if (this.destroyed) return;
        const active = shouldHotkeysBeActive({
            gameOnly: this.started ? this.gameOnly() : false,
            foreground: this.foreground
        });
        if (active === this.active) return;
        this.active = active;
        try {
            this.onChange(active);
        } catch (err) {
            console.error('Foreground watcher callback failed:', err && err.message);
        }
    }

    logError(err) {
        const now = Date.now();
        if (now - this.lastErrorAt < ERROR_LOG_INTERVAL) return;
        this.lastErrorAt = now;
        const message = (err && err.message) || String(err);
        console.error('Foreground watcher:', message);
        appLog.warn('hotkeys-foreground', {action: 'scan-failed', message});
    }

    /** What the diagnostic report prints. */
    state() {
        return {
            gameOnly: this.gameOnly(),
            watching: this.started,
            foreground: this.started ? this.foreground : FOREGROUND_UNKNOWN,
            gameRunning: this.gameRunning,
            active: this.active === null ? true : this.active
        };
    }
}

module.exports = ForegroundWatcher;
module.exports.FOREGROUND_INTERVAL = FOREGROUND_INTERVAL;
module.exports.FOREGROUND_IDLE_INTERVAL = FOREGROUND_IDLE_INTERVAL;
