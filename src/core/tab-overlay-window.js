'use strict';

const {BrowserWindow} = require('electron');
const {webPreferences} = require('../shared/web-preferences');
const appLog = require('./app-log');

/**
 * ELECTRON tier: the second transparent window, laid over the **game's own
 * window**. Same rules as `overlay-window.js`, and load-bearing here because
 * `hotkeysGameOnly` registers the shortcuts only while the game is in front,
 * so a window of ours that steals the foreground unregisters the player's
 * hotkeys mid-match. Four that must survive:
 *
 * - `focusable: false`, `skipTaskbar: true`, and **`showInactive()` / `hide()`,
 *   never `show()`** — `show()` gives focus, and collapsing to 0x0 is no
 *   substitute for `hide()`, which works when the renderer is hung.
 * - `setIgnoreMouseEvents(true)` **without** `forward: true`: forwarding
 *   installs a WH_MOUSE_LL hook and every mouse move on the machine then waits
 *   on our main thread (the 0.2.3 cursor stutter).
 * - `alwaysOnTop` at level `pop-up-menu` on win32 (`screen-saver` is silently
 *   ignored there), **re-asserted every second**, or the game pushes it behind.
 * - Built **lazily**; `close()` is for good, so a late `set-tab-markers`
 *   cannot build a second always-on-top window.
 */
class TabOverlayWindow {

    constructor() {
        this.window = null;
        this._alwaysOnTopInterval = null;
        /** Set by `close()`: nothing may build the window again after a quit. */
        this.destroyed = false;
        /** The bounds the window was last asked for, so a no-op costs nothing. */
        this.bounds = null;
        /**
         * Has the renderer loaded? A `send` before its handlers exist loses the
         * message, so the last payload waits for `did-finish-load`.
         */
        this.ready = false;
        this.pending = null;
    }

    /** Build the window if it does not exist yet. Returns whether it is usable. */
    ensure() {
        if (this.destroyed) return false;
        if (this.window && !this.window.isDestroyed()) return true;
        this.window = null;
        // A previous window's re-assertion timer must not outlive it.
        if (this._alwaysOnTopInterval) {
            clearInterval(this._alwaysOnTopInterval);
            this._alwaysOnTopInterval = null;
        }
        try {
            this.window = new BrowserWindow({
                // Built hidden; only `showInactive()` ever makes it visible.
                show: false,
                width: 0,
                height: 0,
                x: 0,
                y: 0,
                maximizable: false,
                minimizable: false,
                focusable: false,
                skipTaskbar: true,
                alwaysOnTop: true,
                frame: false,
                transparent: true,
                hasShadow: false,
                resizable: false,
                webPreferences: webPreferences()
            });
        } catch (err) {
            console.error('Tab markers: could not create the window:', err && err.message);
            appLog.error('tab-markers', {action: 'create-failed', message: (err && err.message) || String(err)});
            this.window = null;
            return false;
        }
        this.ready = false;
        this.pending = null;
        // Before `loadFile`, or a cached page can finish loading in between.
        this.window.webContents.on('did-finish-load', () => {
            this.ready = true;
            if (this.pending) {
                const payload = this.pending;
                this.pending = null;
                // Only while the markers are still meant to be up: a load
                // finishing after the Tab screen is gone would linger.
                if (this.bounds) this.send('tab-markers', payload);
            }
        });
        this.window.loadFile('src/map/tab.html');
        const level = process.platform === 'win32' ? 'pop-up-menu' : 'screen-saver';
        this.window.setAlwaysOnTop(true, level);
        this.window.setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true});
        this.window.setSkipTaskbar(true);
        this.window.setIgnoreMouseEvents(true);
        if (process.platform === 'win32') {
            this._alwaysOnTopInterval = setInterval(() => {
                if (this.window && !this.window.isDestroyed()) {
                    this.window.setAlwaysOnTop(true, 'pop-up-menu');
                }
            }, 1000);
        }
        // Reloaded on a timer: navigating from inside `render-process-gone`
        // takes the whole app down on Electron 40.
        this.window.webContents.on('render-process-gone', (event, details) => {
            const reason = (details && details.reason) || 'unknown';
            appLog.error('render-process-gone', {
                where: 'tab-markers',
                reason,
                exitCode: details && details.exitCode
            });
            appLog.flush();
            if (reason === 'clean-exit') return;
            // **Hide it**, do not merely forget the bounds: a dead renderer
            // leaves its last frame on an always-on-top window over the game.
            // `onRendererGone` tells `TabMode`, which still believes them fine.
            this.ready = false;
            this.pending = null;
            try {
                if (this.window && !this.window.isDestroyed()) this.window.hide();
            } catch (err) {
                console.error('Tab markers: could not hide after a renderer death:', err && err.message);
            }
            this.bounds = null;
            if (typeof this.onRendererGone === 'function') {
                try {
                    this.onRendererGone(reason);
                } catch (err) {
                    console.error('Tab markers: renderer-gone handler failed:', err && err.message);
                }
            }
            setTimeout(() => {
                try {
                    if (this.window && !this.window.isDestroyed()) this.window.reload();
                } catch (err) {
                    console.error('Tab markers reload failed:', err && err.message);
                }
            }, 100);
        });
        appLog.event('tab-markers', {action: 'window-created'});
        return true;
    }

    /** Is the window there and sized to something? */
    isShowing() {
        return !!(this.window && !this.window.isDestroyed() && this.bounds);
    }

    /** Lay the window over `bounds` (Electron **DIPs**) and draw `payload`. */
    place(bounds, payload) {
        if (!this.ensure()) return false;
        // Only when it changed: `setBounds` is cheap, not free, and the fast
        // loop would otherwise call it every tick.
        const changed = !this.bounds
            || this.bounds.x !== bounds.x || this.bounds.y !== bounds.y
            || this.bounds.width !== bounds.width || this.bounds.height !== bounds.height;
        if (changed) {
            try {
                this.window.setBounds({
                    x: bounds.x,
                    y: bounds.y,
                    width: Math.max(1, bounds.width),
                    height: Math.max(1, bounds.height)
                });
            } catch (err) {
                console.error('Tab markers: could not place the window:', err && err.message);
                return false;
            }
        }
        this.bounds = {x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height};
        if (this.ready) this.send('tab-markers', payload);
        else this.pending = payload;
        // `showInactive()`, never `show()` — see the file header. After the
        // bounds, so it never appears at its previous rectangle for a frame.
        try {
            if (!this.window.isVisible()) this.window.showInactive();
        } catch (err) {
            console.error('Tab markers: could not show the window:', err && err.message);
            return false;
        }
        return true;
    }

    /**
     * Two mechanisms, in this order, not redundant: `tab-hide` is the **fast**
     * path, `window.hide()` the **authoritative** one when the renderer hangs.
     */
    hide() {
        // A payload that has not been drawn yet must not be drawn after this.
        this.pending = null;
        if (!this.window || this.window.isDestroyed()) {
            this.bounds = null;
            return;
        }
        this.send('tab-hide');
        try {
            this.window.hide();
        } catch (err) {
            console.error('Tab markers: could not hide the window:', err && err.message);
        }
        this.bounds = null;
    }

    send(channel, ...data) {
        if (this.window && !this.window.isDestroyed()) {
            try {
                this.window.webContents.send(channel, ...data);
            } catch (err) {
                console.error('Tab markers: could not send to the window:', err && err.message);
            }
        }
    }

    /**
     * Quit, update, or the mode off. **Closed for good**, because a renderer
     * that has not gone away can still send `set-tab-markers`.
     */
    close() {
        this.destroyed = true;
        if (this._alwaysOnTopInterval) {
            clearInterval(this._alwaysOnTopInterval);
            this._alwaysOnTopInterval = null;
        }
        this.bounds = null;
        this.ready = false;
        this.pending = null;
        if (this.window) {
            if (!this.window.isDestroyed()) {
                appLog.event('tab-markers', {action: 'window-closed'});
                this.window.close();
            }
            this.window = null;
        }
    }
}

module.exports = TabOverlayWindow;
