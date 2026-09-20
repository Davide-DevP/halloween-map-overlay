const {BrowserWindow, ipcMain} = require('electron');
const {webPreferences} = require('../shared/web-preferences');
const appLog = require('./app-log');

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
            focusable: false,
            skipTaskbar: true,
            alwaysOnTop: true,
            frame: false,
            transparent: true,
            webPreferences: webPreferences()
        })
        this.window.loadFile('src/map/map.html')
        // On Windows, 'screen-saver' level is not supported and gets silently ignored.
        // Use 'pop-up-menu' on Windows which correctly maps to HWND_TOPMOST and stays
        // above fullscreen game windows. On other platforms keep 'screen-saver'.
        const alwaysOnTopLevel = process.platform === 'win32' ? 'pop-up-menu' : 'screen-saver';
        this.window.setAlwaysOnTop(true, alwaysOnTopLevel);
        this.window.setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true});
        this.window.setSkipTaskbar(true);
        // Click-through WITHOUT `forward: true`. On Windows, forwarding installs a
        // low-level mouse hook (WH_MOUSE_LL) in this process; whenever the main
        // thread is busy (quit, install, a capture tick) every mouse move waits on
        // that hook and the cursor stutters system-wide. The overlay never needs
        // hover events, so the hook is pure cost.
        this.window.setIgnoreMouseEvents(true);
        // A window created while the Tab map is up starts out suppressed too.
        this.applySuppressed();

        // On Windows, periodically re-assert always-on-top to prevent the game
        // or other HWND_TOPMOST windows from pushing the overlay behind them.
        if (process.platform === 'win32') {
            this._alwaysOnTopInterval = setInterval(() => {
                if (this.window && !this.window.isDestroyed()) {
                    this.window.setAlwaysOnTop(true, 'pop-up-menu');
                }
            }, 1000);
        }

        // The overlay's own renderer can die too, and when it does the window
        // stays up showing nothing — which looks exactly like "the overlay
        // stopped working" and left no trace at all before 0.3.2.
        //
        // The reload is deferred for the same hard reason as the main window's
        // (see `MainWindow.scheduleRendererReload`): navigating from inside
        // `render-process-gone` takes the whole app down on Electron 40. It
        // comes back blank — main does not keep the last image — so the map
        // returns on the next map change or a toggle-map press. That is still far
        // better than a window that will never draw again.
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
                // Coordinates, never a path: where the user actually dragged
                // the overlay is half of every "it is off screen" report.
                appLog.event('overlay', {action: 'move', x: bounds.x, y: bounds.y});
            }
        });
    }

    /**
     * Take the corner minimap off screen while the markers are drawn on the
     * game's own Tab map (`tabHidesMinimap`), and bring it back afterwards.
     *
     * Opacity, not `hide()`/`showInactive()`: the window keeps its size, its
     * place in the topmost band and whatever it has drawn, nothing can take
     * focus from the game, and none of the code that shows, resizes or closes
     * this window has to know about it.
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