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

    constructor(obsWindow, overlayWindow, settings, mapLibrary) {
        this.obsWindow = obsWindow;
        this.overlayWindow = overlayWindow;
        this.settings = settings;
        this.mapLibrary = mapLibrary;

        ipcMain.on('obs-open', async () => {
            obsWindow.show()
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
            if (!settings.get('hideOverlay')) {
                overlayWindow.send('map-change', Buffer.from(imgData).toString("base64"), settings.get('size'), settings.get('opacity'), settings.get('draggable'), settings.get('rotation'))
            } else {
                overlayWindow.send('map-change', Buffer.from("").toString("base64"), settings.get('size'), settings.get('opacity'), settings.get('draggable'), settings.get('rotation'));
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
     * NOT redefine `app.isPackaged` to fake one) and whenever the user has
     * turned it off in Settings › General. Every failure path is swallowed
     * with a log line: being offline must never do more than show a toast.
     */
    checkUpdates() {
        if (!app.isPackaged) {
            console.log('Update check skipped: not a packaged build.');
            return;
        }
        if (this.settings && this.settings.get('checkForUpdates') === false) {
            console.log('Update check skipped: disabled in settings.');
            return;
        }

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
            autoUpdater.on('update-downloaded', () => {
                self.sendUpdate('Update downloaded — it installs when you quit the app.');
            });
            autoUpdater.on('error', (err) => {
                console.error('Update check failed:', err && err.message);
                self.sendUpdate('Could not check for updates.');
            });
        }

        setTimeout(() => {
            autoUpdater.checkForUpdatesAndNotify().catch(err => {
                console.error('Update check failed:', err && err.message);
            });
        }, 4000);
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
