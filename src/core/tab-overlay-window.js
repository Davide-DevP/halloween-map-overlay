'use strict';

const {BrowserWindow} = require('electron');
const {webPreferences} = require('../shared/web-preferences');
const appLog = require('./app-log');

/**
 * The second transparent window: Tab-map mode's marker layer, laid over the
 * **game's own window** rather than over a corner of the desktop.
 *
 * Built to exactly the same rules as `overlay-window.js`, and every one of them
 * is load-bearing here for a sharper reason: `hotkeysGameOnly` (default on)
 * registers the global shortcuts only while the game is in the foreground, so a
 * window of ours that steals the foreground does not merely annoy — it
 * unregisters the player's hotkeys mid-match.
 *
 * - `focusable: false`, `skipTaskbar: true`, and **never** `show()`n or
 *   `focus()`ed. Electron 40's own typings say it plainly: `show()` "Shows and
 *   gives focus to the window", while `showInactive()` "Shows the window but
 *   doesn't focus on it". So `showInactive()` / `hide()` are the mechanism and
 *   `show()` is the one call that must not appear in this file.
 *
 *   It used to hide by collapsing to 0x0, with a comment claiming that was
 *   what the corner overlay does. That was wrong — `overlay-window.js` never
 *   resizes to hide; its *renderer* sets the image width to zero — so the
 *   claim was parity with something that does not exist, and the real
 *   mechanism (`setBounds` on a frameless `resizable: false` window) was
 *   never exercised anywhere. `hide()` is what Electron documents for this,
 *   and it keeps working when the renderer is slow or hung, which is exactly
 *   when it matters: the renderer message stays the *fast* path, and the
 *   window hide is the one that is guaranteed.
 * - `setIgnoreMouseEvents(true)` **without** `forward: true`. Forwarding
 *   installs a WH_MOUSE_LL hook in this process on Windows and makes every
 *   mouse move on the machine wait on our main thread — the 0.2.3 cursor
 *   stutter. This window needs no hover events at all.
 * - `alwaysOnTop` at level `pop-up-menu` on win32 (`screen-saver` is silently
 *   ignored there) **re-asserted every second**, or the game pushes it behind.
 *   `showInactive()` brings the window into that topmost band without
 *   activating it, and the re-assertion keeps it there.
 * - Created **lazily**, on the first start of the mode, so a user who never
 *   turns it on never pays for a second renderer process. `destroy()` marks it
 *   closed **for good**, so a late `set-tab-markers` or a detector restart
 *   during quit cannot build a second always-on-top window while the installer
 *   is taking over.
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
         * Has the renderer finished loading?
         *
         * `webContents.send` before the page's `ipcRenderer.on` handlers exist
         * simply loses the message, and `loadFile` is asynchronous — so the
         * first show after the window is built, and the first after a renderer
         * reload, would draw nothing and stay blank until the *next* Tab press.
         * The last payload is held and flushed on `did-finish-load` instead.
         */
        this.ready = false;
        this.pending = null;
    }

    /** Build the window if it does not exist yet. Returns whether it is usable. */
    ensure() {
        if (this.destroyed) return false;
        if (this.window && !this.window.isDestroyed()) return true;
        this.window = null;
        // A previous window's re-assertion timer must not outlive it: `ensure()`
        // runs again after a destroyed window, and two timers would both be
        // calling `setAlwaysOnTop` on whatever `this.window` happened to be.
        if (this._alwaysOnTopInterval) {
            clearInterval(this._alwaysOnTopInterval);
            this._alwaysOnTopInterval = null;
        }
        try {
            this.window = new BrowserWindow({
                // Built hidden and only ever made visible with
                // `showInactive()`, which Electron documents as "shows the
                // window but doesn't focus on it".
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
        // Before `loadFile`, so a page that is already cached cannot finish
        // loading between the two calls.
        this.window.webContents.on('did-finish-load', () => {
            this.ready = true;
            if (this.pending) {
                const payload = this.pending;
                this.pending = null;
                // Only if the markers are still meant to be up: the Tab screen
                // may well be gone by the time a first load completes, and
                // drawing then would be exactly the lingering this feature must
                // not do.
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
        // Same policy as the corner overlay: a dead renderer leaves a window
        // that will never draw again, and navigating from inside
        // `render-process-gone` takes the whole app down on Electron 40 (see
        // `MainWindow.scheduleRendererReload`). It comes back empty, and the
        // next positive Tab check fills it.
        this.window.webContents.on('render-process-gone', (event, details) => {
            const reason = (details && details.reason) || 'unknown';
            appLog.error('render-process-gone', {
                where: 'tab-markers',
                reason,
                exitCode: details && details.exitCode
            });
            appLog.flush();
            if (reason === 'clean-exit') return;
            // **Hide it**, do not merely forget the bounds. A dead renderer
            // leaves whatever it last painted on screen, and this window is
            // always-on-top over the game: forgetting `bounds` used to leave
            // the markers visible while `TabMode` still believed they were
            // fine. `onRendererGone` tells it otherwise.
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

    /**
     * Lay the window over a rectangle (Electron DIPs) and draw a payload into
     * it.
     *
     * @param {{x, y, width, height}} bounds
     * @param {Object} payload for `tab-markers`
     */
    place(bounds, payload) {
        if (!this.ensure()) return false;
        // Re-bounded only when it actually changed: `setBounds` on a
        // click-through always-on-top window is cheap but not free, and the
        // fast loop would otherwise call it every 150 ms.
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
        // `showInactive()`, never `show()`: Electron 40's typings say `show()`
        // "Shows and gives focus to the window", which with `hotkeysGameOnly`
        // on would unregister the player's hotkeys mid-match. Called after the
        // bounds so the window never appears at its previous rectangle for a
        // frame, and unconditionally because a window hidden by `hide()` has to
        // be told to come back.
        try {
            if (!this.window.isVisible()) this.window.showInactive();
        } catch (err) {
            console.error('Tab markers: could not show the window:', err && err.message);
            return false;
        }
        return true;
    }

    /**
     * Take the markers off screen.
     *
     * Two mechanisms, in this order, and they are not redundant:
     *
     * 1. `tab-hide` to the renderer — the **fast** path. It clears the SVG in
     *    the frame the message arrives, with no window-manager work at all.
     * 2. `window.hide()` — the **authoritative** path. It is what makes the
     *    markers go away when the renderer is slow, busy or hung, which is
     *    precisely the case where step 1 cannot be relied on. This used to
     *    collapse the window to 0x0 instead, on a `resizable: false` frameless
     *    window, which is not something Electron documents as a way to hide a
     *    window and was never exercised anywhere else in this app.
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
     * Quit, update, or the mode being switched off for good.
     *
     * Marks the window **closed for good**: `runShutdownHooks()` runs from
     * `before-quit` and from the update path, and a renderer that has not gone
     * away yet can still send `set-tab-markers` — which would otherwise build a
     * second always-on-top window while the installer is taking over.
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
