const {BrowserWindow, ipcMain} = require('electron');
const {webPreferences} = require('../shared/web-preferences');
const appLog = require('./app-log');

/** Every quirk below is load-bearing — see docs/agents/overlay-windows.md. */
class OverlayWindow {
    window = null;
    settings = null;

    constructor(settings) {
        this.settings = settings || null;
        let classInstance = this;
        ipcMain.on('set-mouse-drag', async (event, drag) => {
            if (!classInstance.window) return
            if (drag) {
                classInstance.window.setIgnoreMouseEvents(false);
            } else {
                classInstance.window.setIgnoreMouseEvents(true);
            }
        });
    }

    show() {
        if (this.window) {
            if (!this.window.isDestroyed()) return
            this.window = null;
        }
        const isDraggable = this.settings && this.settings.get('draggable');
        const savedX = this.settings && this.settings.get('overlayX');
        const savedY = this.settings && this.settings.get('overlayY');
        this.window = new BrowserWindow({
            width: 0,
            height: 0,
            x: (isDraggable && savedX !== null && savedX !== undefined) ? savedX : 0,
            y: (isDraggable && savedY !== null && savedY !== undefined) ? savedY : 0,
            maximizable: true,
            minimizable: false,
            // `focusable: false` + `skipTaskbar` are load-bearing: the overlay
            // must never take the foreground from the game (`hotkeysGameOnly`
            // would then unregister the hotkeys).
            focusable: false,
            skipTaskbar: true,
            alwaysOnTop: true,
            frame: false,
            transparent: true,
            webPreferences: webPreferences()
        })
        this.window.loadFile('src/map/map.html')
        // win32 silently ignores 'screen-saver'; 'pop-up-menu' is the level that
        // maps to HWND_TOPMOST and stays above a fullscreen game.
        const alwaysOnTopLevel = process.platform === 'win32' ? 'pop-up-menu' : 'screen-saver';
        this.window.setAlwaysOnTop(true, alwaysOnTopLevel);
        this.window.setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true});
        this.window.setSkipTaskbar(true);
        // Click-through **without** `forward: true`: forwarding installs a
        // WH_MOUSE_LL hook in this process, and every mouse move then waits on
        // our main thread — the cursor stutters system-wide. No hover events are
        // needed here, so the hook is pure cost.
        this.window.setIgnoreMouseEvents(true);
        // A window created while the Tab map is up starts out suppressed too.
        this.applySuppressed();

        // Re-assert always-on-top every second, or a fullscreen game (or another
        // HWND_TOPMOST window) pushes the overlay behind it.
        if (process.platform === 'win32') {
            this._alwaysOnTopInterval = setInterval(() => {
                if (this.window && !this.window.isDestroyed()) {
                    this.window.setAlwaysOnTop(true, 'pop-up-menu');
                }
            }, 1000);
        }

        // **Never reload from inside this handler**: navigating while Chromium
        // tears the dead frame down takes the whole app with it on Electron 40
        // (see `MainWindow.scheduleRendererReload`). Hence the `setTimeout`.
        // The window comes back blank — main keeps no image — so the map returns
        // on the next map change or toggle-map.
        this.window.webContents.on('render-process-gone', (event, details) => {
            const reason = (details && details.reason) || 'unknown';
            console.error('Overlay renderer gone:', details);
            appLog.error('render-process-gone', {
                where: 'overlay',
                reason,
                exitCode: details && details.exitCode
            });
            appLog.flush();
            if (reason === 'clean-exit') return;
            setTimeout(() => {
                try {
                    if (this.window && !this.window.isDestroyed()) this.window.reload();
                } catch (err) {
                    console.error('Overlay reload failed:', err && err.message);
                }
            }, 100);
        });

        appLog.event('overlay', {action: 'show', draggable: !!isDraggable});

        this.window.on('moved', () => {
            console.log("Window moved");
            console.log(this.window.getBounds());
            if (this.settings && this.settings.get('draggable') && this.window) {
                const bounds = this.window.getBounds();
                this.settings.set('overlayX', bounds.x);
                this.settings.set('overlayY', bounds.y);
                // Coordinates, never a path — see the redaction rule.
                appLog.event('overlay', {action: 'move', x: bounds.x, y: bounds.y});
            }
        });
    }

    /**
     * Off screen while the markers are on the game's own Tab map
     * (`tabHidesMinimap`). Opacity, not `hide()`/`showInactive()`: the window
     * keeps its size, its place in the topmost band and what it has drawn, and
     * nothing that shows, resizes or closes it has to know about this.
     */
    setSuppressed(on) {
        this.suppressed = on === true;
        this.applySuppressed();
    }

    applySuppressed() {
        if (!this.window || this.window.isDestroyed()) return;
        try {
            this.window.setOpacity(this.suppressed ? 0 : 1);
        } catch (err) {
            console.error('Overlay: could not change the opacity:', err && err.message);
        }
    }

    send(event, ...data) {
        if (this.window) {
            this.window.webContents.send(event, ...data);
        }
    }

    setSize(width, height) {
        if (this.window) {
            this.window.setSize(width, height);
        }
    }

    setBounds(bounds) {
        if (this.window) {
            this.window.setBounds(bounds);
        }
    }

    setPosition(x, y) {
        if (this.window) {
            this.window.setPosition(x, y);
        }
    }

    getBounds() {
        if (this.window) {
            return this.window.getBounds();
        }
        return {width: 0, height: 0};
    }

    close() {
        if (this.window) appLog.event('overlay', {action: 'hide'});
        if (this._alwaysOnTopInterval) {
            clearInterval(this._alwaysOnTopInterval);
            this._alwaysOnTopInterval = null;
        }
        if (this.window) {
            if (!this.window.isDestroyed()) this.window.close();
            this.window = null;
        }
    }
}

module.exports = OverlayWindow;