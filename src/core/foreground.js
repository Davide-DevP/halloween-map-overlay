const electron = require('electron');
const nodeScreenshots = require('node-screenshots');
const appLog = require('./app-log');
const {errorMessage} = require('../shared/errors');
const {classifyWindow} = require('../shared/detector-rules');
const {
    FOREGROUND_GAME, FOREGROUND_OWN, FOREGROUND_OTHER, FOREGROUND_UNKNOWN,
    shouldHotkeysBeActive
} = require('../shared/hotkeys-rules');

/**
 * Which window is in the foreground, for the `hotkeysGameOnly` setting: the app
 * holds its global shortcuts only while the player is in the game, or in one of
 * our own windows so a rebound hotkey can be tried from Settings. Measurements,
 * the `isFocused()` choice and the fail-open rules: `docs/agents/hotkeys.md`.
 *
 * **This is not the capture path** (`docs/agents/detection.md`): nothing here
 * captures a frame. A tick is `Window.all()` plus one `isFocused()` per window,
 * 0.06-0.32 ms measured, and with the setting off no timer runs at all.
 *
 * Shape that must not be "cleaned up": `setTimeout` chaining, never
 * `setInterval`; our own windows' focus comes from Electron's events, not the
 * poll; the callback fires only on a **change**, because `Hotkeys.setActive()`
 * re-registers the whole set; and `destroy()` reports **nothing**.
 */

/** Poll period while the game is running, ms. Why 1 s:
 * docs/agents/hotkeys.md § Only while the game is in front. */
const FOREGROUND_INTERVAL = 1000;

/** Poll period with no game window: nothing can change until the game starts,
 * and a 2 s reaction to that is invisible. */
const FOREGROUND_IDLE_INTERVAL = 2000;

/** A failing window enumeration is a state, not an event: log sparsely. */
const ERROR_LOG_INTERVAL = 60000;

class ForegroundWatcher {

    /**
     * @param {(active: boolean) => void} onChange called only on a change
     * @param {{app?: Object, BrowserWindow?: Object, Window?: Object}} [deps]
     *   everything this class touches outside itself, injectable so the
     *   lifecycle is unit testable. The real app never passes it.
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
         * True once `destroy()` has run, and then nothing is ever reported
         * again. `destroy()` comes from `before-quit`, which is also the update
         * path, and `stop()` alone would report "the setting is off, so register
         * everything" — a dozen global shortcuts re-registered inside the quit
         * handler while the installer takes over.
         */
        this.destroyed = false;
        /** 'game' | 'own' | 'other' | 'unknown' */
        this.foreground = FOREGROUND_UNKNOWN;
        /** Whether the last enumeration saw a game window at all. */
        this.gameRunning = false;
        /** The last verdict handed to `onChange`; null = never reported. */
        this.active = null;
        this.lastErrorAt = 0;

        // Our own windows' focus comes from Electron, not the poll: free,
        // instant, and exact.
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

    /** Follow the setting: called at boot and whenever the switch is flipped.
     * With it off there is no timer and the hotkeys are always registered. */
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
        // Watcher off means setting off, so the hotkeys go back to always
        // registered — through the same callback, so there is one path.
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
            // Electron's answer wins for our *own* windows: the enumeration can
            // miss one (the overlay is `focusable: false`). The scan still runs,
            // because `gameRunning` comes from it and a report made from the
            // Settings window would otherwise say the game was not running.
            this.foreground = this.BrowserWindow.getFocusedWindow() ? FOREGROUND_OWN : scan.foreground;
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
     * One pass over the window list: the focused window decides, and the game's
     * presence is noted on the way past so the cadence can drop while the game
     * is closed. Reads are wrapped per window — one can vanish between the
     * enumeration and the read.
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
        // Nothing reported focus: genuinely "we do not know", not "somebody
        // else". Calling that `other` would switch the hotkeys off *while the
        // player is in the game*, so it fails open.
        else if (!sawFocused) foreground = FOREGROUND_UNKNOWN;

        return {foreground, gameRunning};
    }

    /** Take the verdict from the current foreground without waiting for a tick.
     * @param {string} foreground one of the FOREGROUND_* values */
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
        const message = errorMessage(err);
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
