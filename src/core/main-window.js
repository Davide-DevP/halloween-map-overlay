const {BrowserWindow, app, shell, ipcMain, screen} = require("electron");
const path = require("path");
const fs = require("fs");
const {imageSize} = require('image-size');
const {autoUpdater} = require('electron-updater');
const {computeOverlayPosition, rotatedSize} = require('./overlay-position');

const debug = process.env.DEBUG === 'true';

class MainWindow {

    window = null;
    obsWindow;
    overlayWindow;
    settings;
    mapLibrary;
    /** Version string of a downloaded-but-not-installed update, or null. */
    pendingUpdateVersion = null;
    /** {mapDetector, tray} — set from index.js, both built after this class. */
    shutdownHooks = {};

    constructor(obsWindow, overlayWindow, settings, mapLibrary) {
        this.obsWindow = obsWindow;
        this.overlayWindow = overlayWindow;
        this.settings = settings;
        this.mapLibrary = mapLibrary;

        ipcMain.on('obs-open', async () => {
            obsWindow.show()
        });
        // The renderer can finish loading after `update-downloaded` fired (the
        // window is reopened from the tray, say), so it asks as well as listens.
        ipcMain.handle('get-pending-update', async () => {
            return this.pendingUpdateVersion ? {version: this.pendingUpdateVersion} : null;
        });
        ipcMain.handle('install-update', async () => {
            return this.installUpdate();
        });
        ipcMain.handle('version', async () => {
            // Read this app's package.json — app.getVersion() can pick up
            // Electron's own version (40.x) when running from `npm start`.
            return require('../../package.json').version;
        })
        ipcMain.handle('get-displays', async () => {
            return screen.getAllDisplays().map((display, index) => {
                // bounds is logical (DPI-scaled) pixels, not physical ones -- show the
                // physical resolution so HiDPI displays are actually recognizable in the list.
                const physicalWidth = Math.round(display.bounds.width * display.scaleFactor);
                const physicalHeight = Math.round(display.bounds.height * display.scaleFactor);
                const refreshRate = Math.round(display.displayFrequency);
                return {
                    index,
                    id: display.id,
                    label: display.label || `Display ${index + 1} (${physicalWidth}x${physicalHeight}${refreshRate ? ` @ ${refreshRate}Hz` : ''})`,
                    bounds: display.bounds
                };
            });
        })
        ipcMain.on('map-change', async (event, map, opts = {}) => {
            if (!map) {
                overlayWindow.send('map-hide');
                if (!opts.preview) obsWindow.send('map-hide');
                return;
            }

            let imgData;
            if (opts.preview) {
                // The settings preview is rendered in the renderer and arrives
                // as raw base64 — never look it up in the catalogue.
                imgData = Buffer.from(map, "base64");
            } else {
                const file = this.mapLibrary ? this.mapLibrary.resolve(map) : null;
                if (file) {
                    imgData = await fs.promises.readFile(file);
                } else {
                    imgData = Buffer.from(map, "base64");
                }
            }

            let dimensions;
            try {
                dimensions = imageSize(imgData);
            } catch (err) {
                console.error("map-change: unreadable image payload:", err.message);
                return;
            }

            const displays = screen.getAllDisplays();
            const monitorIndex = parseInt(settings.get('monitor')) || 0;
            const selectedDisplay = displays[monitorIndex] || displays[0] || screen.getPrimaryDisplay();
            let {x: displayX, y: displayY, width, height} = selectedDisplay.workArea;
            overlayWindow.setBounds({
                ...selectedDisplay.workArea,
                width: 0,
                height: 0,
                x: this.settings.get('overlayX') || 0,
                y: this.settings.get('overlayY') || 0
            })
            // Window fits the rotated bounding box so arbitrary angles don't clip
            const displayWidth = parseInt(settings.get('size'));
            const rotated = rotatedSize({
                width: displayWidth,
                height: (displayWidth / dimensions.width) * dimensions.height,
                rotation: settings.get('rotation')
            });
            overlayWindow.setSize(rotated.width + 5, parseInt(rotated.height * 1.1))
            if (debug) {
                console.log("Selected display:", selectedDisplay);
                console.log("Overlay bounds:", overlayWindow.getBounds());
                console.log("Image dimensions:", dimensions);
                console.log("Calculated overlay size:", {width: rotated.width + 5, height: parseInt(rotated.height * 1.1)});
                console.log("Display bounds:", {x: displayX, y: displayY, width, height});
                console.log("Overlay position setting:", settings.get('position'));
                console.log("Draggable setting:", settings.get('draggable'));
            }
            if (!settings.get('draggable')) {
                const overlayBounds = overlayWindow.getBounds();
                const {x, y} = computeOverlayPosition({
                    workArea: selectedDisplay.workArea,
                    overlayWidth: overlayBounds.width,
                    overlayHeight: overlayBounds.height,
                    position: settings.get('position'),
                    glideX: settings.get('glideX'),
                    glideY: settings.get('glideY')
                });
                overlayWindow.setPosition(x, y);
            }
            // `mapLabel` rides along on the existing payload rather than being
            // a second IPC message, so the overlay can never show a name for a
            // map it is not displaying. The settings preview never carries one.
            const mapLabel = (!opts.preview && typeof opts.mapLabel === 'string') ? opts.mapLabel : '';
            if (!settings.get('hideOverlay')) {
                overlayWindow.send('map-change', Buffer.from(imgData).toString("base64"), settings.get('size'), settings.get('opacity'), settings.get('draggable'), settings.get('rotation'), mapLabel)
            } else {
                overlayWindow.send('map-change', Buffer.from("").toString("base64"), settings.get('size'), settings.get('opacity'), settings.get('draggable'), settings.get('rotation'), '');
            }
            // The settings preview stays off the OBS window -- it must never leak into a stream
            if (!opts.preview) obsWindow.send('map-change', Buffer.from(imgData).toString("base64"), settings.get('size'));
        });
    }

    show() {
        if (this.window) {
            if (!this.window.isDestroyed()) {
                this.window.show();
                return
            }
            this.window = null;
        }
        this.window = new BrowserWindow({
            width: 1000,
            height: 720,
            backgroundColor: '#14100f',
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false
            },
            title: "Halloween Map Overlay",
            icon: path.join(global.dirname, "src", "images", "icon.png"),
        })
        let window = this.window;
        let obsWindow = this.obsWindow;
        let overlayWindow = this.overlayWindow;
        this.window.on("closed", () => {
            overlayWindow.close()
            obsWindow.close()
        })
        let settings = this.settings;
        this.window.on("minimize", function (event) {
            if (settings && settings.get('minimizeToTray')) {
                event.preventDefault();
                window.hide();
            }
        })
        this.window.on('close', function (event) {
            if (settings && settings.get('minimizeToTray')) {
                if (!app.isQuiting) {
                    event.preventDefault();
                    window.hide();
                }
            }
            return false;
        });
        this.window.loadFile('src/index.html')

        this.window.webContents.setWindowOpenHandler(({url}) => {
            shell.openExternal(url);
            return {action: 'deny'};
        });

        // A renderer crash is otherwise completely silent from the terminal
        this.window.webContents.on('render-process-gone', (event, details) => {
            console.error('Renderer process gone:', details);
        });
        if (debug) {
            this.window.webContents.on('console-message', (event) => {
                console.log(`[renderer] ${event.message} (${event.sourceId}:${event.lineNumber})`);
            });
        }

        if (debug) this.window.webContents.openDevTools()
        if (!debug) this.window.setMenu(null)

        this.checkUpdates()
    }

    /**
     * Check GitHub Releases for a newer build.
     *
     * This is the app's only network request. It is skipped entirely in dev
     * (there is no release feed to talk to, and unlike the reference this does
     * NOT redefine `app.isPackaged` to fake one), in the portable build, and
     * whenever the user has turned it off in Settings › General. Every failure
     * path is swallowed with a log line: being offline must never do more than
     * show a toast.
     *
     * The update downloads in the background but is **never** installed behind
     * the user's back: `autoInstallOnAppQuit` is off, so the only thing that
     * runs the installer is `installUpdate()`, from the home-page banner or the
     * tray item. Closing the app installs nothing.
     */
    checkUpdates() {
        if (!app.isPackaged) {
            console.log('Update check skipped: not a packaged build.');
            return;
        }
        // `app.isPackaged` is true in the portable exe too, and electron-updater
        // has no portable guard of its own: left alone it would download the
        // NSIS installer and silently install it on quit, while the portable
        // exe the user actually launched stayed at the old version. README and
        // AGENTS.md both promise the portable build does not self-update.
        // electron-builder's portable launcher always sets this variable.
        if (process.env.PORTABLE_EXECUTABLE_DIR) {
            console.log('Update check skipped: portable build.');
            return;
        }
        if (this.settings && this.settings.get('checkForUpdates') === false) {
            console.log('Update check skipped: disabled in settings.');
            return;
        }

        // Download in the background, but install only when the user asks.
        // The 0.1.0 → 0.2.0 update ran electron-updater's default quit handler
        // and the NSIS installer froze the machine for several seconds at the
        // exact moment the user closed the app, possibly mid-game. Both flags
        // are set explicitly so the behaviour does not depend on a library
        // default; `installUpdate()` is now the one and only installer trigger.
        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = false;

        const self = this;
        // show() runs again when the window is reopened from the tray
        if (!MainWindow._updaterBound) {
            MainWindow._updaterBound = true;
            autoUpdater.on('checking-for-update', () => self.sendUpdate('Checking for updates…'));
            autoUpdater.on('update-available', () => self.sendUpdate('Update available — downloading…'));
            autoUpdater.on('update-not-available', () => self.sendUpdate('Halloween Map Overlay is up to date.'));
            autoUpdater.on('download-progress', (p) => {
                self.sendUpdate(`Downloading update: ${Math.round(p.percent || 0)}%`);
            });
            autoUpdater.on('update-downloaded', (info) => {
                const version = info && info.version ? String(info.version) : '';
                self.pendingUpdateVersion = version || null;
                self.sendUpdate('Update downloaded — click Restart and update when you are ready.');
                // The toast auto-hides; the banner is the persistent element.
                self.send('update-ready', {version});
                const tray = self.shutdownHooks && self.shutdownHooks.tray;
                if (tray && typeof tray.setUpdatePending === 'function') {
                    tray.setUpdatePending(version);
                }
            });
            autoUpdater.on('error', (err) => {
                console.error('Update check failed:', err && err.message);
                self.sendUpdate('Could not check for updates.');
            });
        }

        setTimeout(() => {
            // The default notification text promises an install on exit, which
            // is exactly what this no longer does — say what really happens.
            autoUpdater.checkForUpdatesAndNotify({
                title: 'Update ready',
                body: '{appName} {version} has been downloaded. Open the app and click "Restart and update" when it suits you.'
            }).catch(err => {
                console.error('Update check failed:', err && err.message);
            });
        }, 4000);
    }

    /**
     * References to modules built after this one (`index.js` wires them), so
     * the install can shut the app down cleanly and the tray can grow its
     * "Restart and update" item.
     */
    setShutdownHooks(hooks) {
        this.shutdownHooks = hooks || {};
    }

    /**
     * Run the downloaded installer and relaunch. The only caller-facing entry
     * point for installing an update: the home-page banner (`install-update`)
     * and the tray item.
     *
     * `app.isQuiting` has to be set first or the main window's `close` handler
     * hides the window instead of letting it go whenever minimize-to-tray is
     * on, and `app.quit()` inside `quitAndInstall` would never complete.
     */
    installUpdate() {
        if (!this.pendingUpdateVersion) {
            console.log('Install update requested with no update pending.');
            return false;
        }
        try {
            app.isQuiting = true;
            const {mapDetector, tray} = this.shutdownHooks || {};
            if (mapDetector && typeof mapDetector.stop === 'function') mapDetector.stop();
            if (tray && typeof tray.destroy === 'function') tray.destroy();
            console.log(`Installing update ${this.pendingUpdateVersion} and restarting.`);
            // (isSilent, isForceRunAfter): no installer UI, and the app comes
            // back on its own once NSIS is done.
            autoUpdater.quitAndInstall(true, true);
            return true;
        } catch (err) {
            console.error('Install update failed:', err && err.message);
            app.isQuiting = false;
            this.sendUpdate('Could not install the update.');
            return false;
        }
    }

    /** Short status line shown in the bottom-right toast of the main window. */
    sendUpdate(message) {
        if (this.window && !this.window.isDestroyed()) {
            this.window.webContents.send('update-message', message);
        }
    }

    send(event, ...data) {
        if (this.window && !this.window.isDestroyed()) {
            this.window.webContents.send(event, ...data);
        }
    }

    focus() {
        if (this.window) {
            this.window.focus();
        }
    }

    isVisible() {
        if (this.window) {
            return this.window.isVisible();
        }
        return false;
    }

    hide() {
        if (this.window) {
            this.window.hide();
        }
    }
}

module.exports = MainWindow;
