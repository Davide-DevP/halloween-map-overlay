const {BrowserWindow, app, shell, ipcMain, screen} = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const {spawn} = require("child_process");
const {imageSize} = require('image-size');
const {autoUpdater} = require('electron-updater');
const {computeOverlayPosition, rotatedSize} = require('./overlay-position');
const updateHelper = require('./update-helper');
const {
    planManualUpdateCheck, isUpdateCheckOccupied, updateCheckStall
} = require('../shared/update-message');
const {mapLabelMode} = require('../shared/settings-defaults');
const {webPreferences} = require('../shared/web-preferences');
const {drawableLayers, markerState, SURFACE_OVERLAY} = require('../shared/marker-rules');
const {markerGeometry, markerReach} = require('../shared/marker-geometry');
const {msg, t} = require('../shared/i18n');
const {shouldUnloadMainWindow, UNLOAD_GRACE_MS} = require('../shared/window-unload');
const appLog = require('./app-log');

const debug = process.env.DEBUG === 'true';

/** Two renderer deaths closer together than this are a crash loop, not a hiccup. */
const RENDERER_CRASH_WINDOW_MS = 60000;

/** How many `keep` toasts may wait for a window that does not exist; oldest goes. */
const TOAST_QUEUE_MAX = 5;

/** `src/js/status.js` has one auto-hide timer, so only the last of a batch is
 * read. 2.5 s = half the toast's 5 s life. */
const TOAST_FLUSH_GAP_MS = 2500;

class MainWindow {

    window = null;
    obsWindow;
    overlayWindow;
    settings;
    mapLibrary;
    language = null;
    pendingUpdateVersion = null;
    pendingInstallerPath = null;
    /** Set once a tier has started, so the banner cannot fire twice. */
    installStarted = false;
    installInFlight = null;
    /** A `UPDATE_CHECK_STATES` value, and the single source of "in flight". */
    updateCheckState = 'idle';
    updateCheckVersion = null;
    /** Last movement, `download-progress` included: the watchdog times silence. */
    updateCheckActivityAt = 0;
    updateCheckWatchdog = null;
    /** {mapDetector, tray, tabMode, hotkeys} — set from index.js. */
    shutdownHooks = {};
    lastRendererGone = 0;
    /** The last logged `map-change`, so a slider drag is one line, not thirty. */
    lastLoggedMap = null;
    /**
     * Ticket for the async, re-entrant `applyMapChange`: the last caller wins,
     * and an older one returning late drops what it was about to send.
     */
    mapChangeSeq = 0;
    /** Epoch ms the window was hidden, or 0 while it is on screen. */
    hiddenAt = 0;
    unloadTimer = null;
    /** True while there is no window *because we took it away*. */
    unloaded = false;
    busyReasons = new Set();
    /** Has the banner been in front of a person (a *visible* window)? */
    updateBannerShown = false;
    updateDismissed = false;
    /** `cleanStaleUpdateHelpers` + `checkUpdates` run on the first build only. */
    startupTasksDone = false;
    toastQueue = [];

    constructor(obsWindow, overlayWindow, settings, mapLibrary, language) {
        this.obsWindow = obsWindow;
        this.overlayWindow = overlayWindow;
        this.settings = settings;
        this.mapLibrary = mapLibrary;
        // Only for the native notification; everything else travels as `{key, params}`.
        this.language = language || null;

        ipcMain.on('obs-open', async () => {
            appLog.event('obs', {action: 'open'});
            obsWindow.show()
        });
        // Pulled, not only pushed, and `dismissed` travels with it: "Later" has
        // to survive the window being destroyed.
        ipcMain.handle('get-pending-update', async () => {
            if (!this.pendingUpdateVersion) return null;
            return {version: this.pendingUpdateVersion, dismissed: this.updateDismissed};
        });
        ipcMain.on('update-banner-dismissed', () => {
            this.updateDismissed = true;
            // A dismissed banner is no longer a reason to keep the window.
            this.updateBannerShown = true;
            this.scheduleUnload('banner-dismissed');
        });
        ipcMain.handle('install-update', async () => {
            return this.installUpdate();
        });
        // `handle`, not `on`: the button stays disabled until this answers.
        ipcMain.handle('check-for-updates-now', async () => this.checkForUpdatesNow());
        // Stall check first: one more way out of a silently dead download.
        ipcMain.handle('get-update-check-state', async () => {
            this.resolveStalledUpdateCheck();
            return this.updateCheckStatus();
        });
        // The folder, never the file: a `.log` opens in who knows what.
        ipcMain.handle('open-log-folder', async () => {
            const dir = app.getPath('userData');
            const error = await shell.openPath(dir);
            if (error) console.error('Could not open the log folder:', error);
            return {ok: !error, path: dir};
        });
        ipcMain.handle('version', async () => {
            // package.json, not `app.getVersion()` — see `appVersion()`.
            return require('../../package.json').version;
        })
        ipcMain.handle('get-displays', async () => {
            return screen.getAllDisplays().map((display, index) => {
                // `bounds` is DIPs; the list shows physical pixels, or a HiDPI
                // display is not recognisable in it.
                const physicalWidth = Math.round(display.bounds.width * display.scaleFactor);
                const physicalHeight = Math.round(display.bounds.height * display.scaleFactor);
                const refreshRate = Math.round(display.displayFrequency);
                // The OS label is a device name, never translated; with none the
                // renderer builds one, because main must not compose UI text.
                return {
                    index,
                    id: display.id,
                    label: display.label || '',
                    physicalWidth,
                    physicalHeight,
                    refreshRate,
                    bounds: display.bounds
                };
            });
        })
        // The **settings preview** is the only thing left on this channel: it
        // is canvas-rendered, so it can only be raw base64. Everything else
        // reaches `applyMapChange` through `MapController`, with no renderer.
        ipcMain.on('map-change', (event, map, opts = {}) => {
            // Caught, not awaited: an `unhandledRejection` writes a crash file.
            Promise.resolve(this.applyMapChange(map, opts)).catch(err => {
                console.error('map-change failed:', err && err.message);
                appLog.error('map-change', {message: (err && err.message) || String(err)});
            });
        });
        // "Do not tear this window down right now" — `shared/window-unload.js`.
        ipcMain.on('window-busy', (event, info) => {
            const reason = info && typeof info.reason === 'string' ? info.reason : '';
            if (!reason) return;
            if (info.on === false) this.busyReasons.delete(reason);
            else this.busyReasons.add(reason);
            this.scheduleUnload('busy-changed');
        });
        // Until this arrives the window stays, so the banner cannot be missed.
        ipcMain.on('update-banner-shown', () => {
            this.updateBannerShown = true;
            this.scheduleUnload('banner-shown');
        });
    }

    /**
     * Put a map on the overlay and the OBS window, or hide them (`map` empty).
     * The single implementation, and it touches `overlayWindow`/`obsWindow`,
     * never `this.window` — which is what lets the main window be destroyed
     * mid-match. **Async and re-entrant**: see `mapChangeSeq`.
     *
     * @param {string} map a catalogue key, a custom-map file name, or raw
     *   base64; `{preview: true}` forces the base64 path.
     * @returns {Promise<boolean>} did this reach the overlay. `false` =
     *   superseded or unreadable, and `MapController` rolls back on it.
     */
    async applyMapChange(map, opts = {}) {
        const settings = this.settings;
        const overlayWindow = this.overlayWindow;
        const obsWindow = this.obsWindow;
        const ticket = ++this.mapChangeSeq;
        const superseded = () => this.mapChangeSeq !== ticket;
        {
            if (!map) {
                this.logMapChange('', opts.source || 'hide');
                overlayWindow.send('map-hide');
                if (!opts.preview) obsWindow.send('map-hide');
                return true;
            }

            let imgData;
            let resolvedName = '';
            let resolvedEntry = null;
            if (opts.preview) {
                imgData = Buffer.from(map, "base64");
                this.logMapChange('(preview)', 'preview');
            } else {
                const entry = this.mapLibrary ? this.mapLibrary.resolveEntry(map) : null;
                resolvedEntry = entry;
                if (entry) {
                    resolvedName = entry.name;
                    try {
                        imgData = await fs.promises.readFile(entry.path);
                    } catch (err) {
                        // `false` so the caller can put its state back: a
                        // `currentKey` naming a map that is not on the overlay
                        // desyncs the gallery, the toggle and the menu clear.
                        console.error('map-change: the map image could not be read:', err && err.message);
                        appLog.error('map-change', {
                            key: entry.custom ? '(custom)' : entry.key,
                            message: (err && err.message) || String(err)
                        });
                        return false;
                    }
                    if (superseded()) return false;
                } else {
                    imgData = Buffer.from(map, "base64");
                }
                // A custom map's key is a name the user typed, so it is logged
                // as `(custom)` — the "never log paths or user text" rule.
                this.logMapChange(entry ? (entry.custom ? '(custom)' : entry.key) : '(raw image)',
                    opts.source || 'click');
            }

            let dimensions;
            try {
                dimensions = imageSize(imgData);
            } catch (err) {
                console.error("map-change: unreadable image payload:", err.message);
                return false;
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
            // Same payload, so one map's cellars can never reach another map.
            const markers = this.markerPayload(resolvedEntry, dimensions);
            const lang = this.language ? this.language.current() : 'en';

            // Sized to the rotated bounding box, so no angle clips.
            const displayWidth = parseInt(settings.get('size'));
            const rotated = rotatedSize({
                width: displayWidth,
                height: (displayWidth / dimensions.width) * dimensions.height,
                rotation: settings.get('rotation')
            });
            // At larger sizes an edge marker reaches past the +5 px / 10 % slack.
            const markerPad = markers
                ? Math.ceil(markerReach(markerGeometry(displayWidth))) * 2 : 0;
            const overlayWidth = rotated.width + 5 + markerPad;
            const overlayHeight = parseInt(rotated.height * 1.1) + markerPad;
            overlayWindow.setSize(overlayWidth, overlayHeight)
            if (debug) {
                console.log("Selected display:", selectedDisplay);
                console.log("Overlay bounds:", overlayWindow.getBounds());
                console.log("Image dimensions:", dimensions);
                console.log("Calculated overlay size:", {width: overlayWidth, height: overlayHeight, markerPad});
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
            // Same payload again, so the overlay can never name a map it is not
            // showing. The three modes: docs/agents/overlay-windows.md.
            const labelMode = mapLabelMode(settings.get('mapLabel'));
            const requested = typeof opts.mapLabel === 'string' ? opts.mapLabel : '';
            let mapLabel = '';
            if (labelMode === 'always') mapLabel = requested || resolvedName;
            else if (labelMode === 'auto') mapLabel = opts.preview ? '' : requested;

            if (!settings.get('hideOverlay')) {
                overlayWindow.send('map-change', Buffer.from(imgData).toString("base64"), settings.get('size'), settings.get('opacity'), settings.get('draggable'), settings.get('rotation'), mapLabel, labelMode, markers, lang)
            } else {
                overlayWindow.send('map-change', Buffer.from("").toString("base64"), settings.get('size'), settings.get('opacity'), settings.get('draggable'), settings.get('rotation'), '', labelMode, null, lang);
            }
            // The settings preview must never leak into a stream.
            if (!opts.preview) obsWindow.send('map-change', Buffer.from(imgData).toString("base64"), settings.get('size'), mapLabel, labelMode, markers, lang);
            return true;
        }
    }

    setMapMarkers(mapMarkers) {
        this.mapMarkers = mapMarkers && typeof mapMarkers.markers === 'function' ? mapMarkers : null;
    }

    /**
     * null = draw nothing. `surface: 'overlay'` drops the layers the PNG
     * already has baked in — see docs/agents/markers-and-tab-mode.md.
     */
    markerPayload(entry, dimensions) {
        if (!entry || !entry.key || !this.mapMarkers) return null;
        const state = markerState(this.settings ? this.settings.all() : null);
        if (!state.enabled) return null;
        const markers = this.mapMarkers.markers(entry.key);
        if (!markers) return null;
        const layers = drawableLayers({
            markers,
            surface: SURFACE_OVERLAY,
            settings: this.settings ? this.settings.all() : null
        });
        if (!layers.length) return null;
        return {
            layers,
            legend: state.legend,
            opacity: state.opacity,
            imageWidth: dimensions.width,
            imageHeight: dimensions.height
        };
    }

    /**
     * **Never reload from inside the `render-process-gone` handler**: navigating
     * while Chromium tears the dead frame host down takes the whole app with it
     * on Electron 40, the overlay renderer included. The delay only has to
     * leave the current stack. Measurements: docs/agents/diagnostics.md.
     */
    scheduleRendererReload() {
        setTimeout(() => {
            try {
                if (this.window && !this.window.isDestroyed()) this.window.reload();
            } catch (err) {
                console.error('Renderer reload failed:', err && err.message);
                appLog.error('render-process-gone', {reload: 'failed', message: (err && err.message) || String(err)});
            }
        }, 100);
    }

    logMapChange(key, source) {
        if (this.lastLoggedMap && this.lastLoggedMap.key === key && this.lastLoggedMap.source === source) return;
        this.lastLoggedMap = {key, source};
        appLog.event('map-change', {key, source});
    }

    /**
     * **Everything that rebuilds this window is a user action.** One nobody
     * asked for either costs a renderer build mid-match or steals the
     * foreground from the game; anything that has to reach the user with no
     * window is pulled on the next load, carried by the tray, or queued.
     * `opts.show === false` has no caller — read that rule before adding one.
     */
    show(reason, opts = {}) {
        const reveal = opts.show !== false;
        if (this.window) {
            if (!this.window.isDestroyed()) {
                this.cancelUnload();
                if (reveal) this.window.show();
                return
            }
            this.window = null;
        }
        // **Never build a window on the way out**: a second instance during
        // `finishInstall`'s deferred quit would build a renderer while the
        // installer is taking over, and `app.quit()` would have one more window.
        if (app.isQuiting) return;
        const wasUnloaded = this.unloaded;
        this.unloaded = false;
        this.cancelUnload();
        this.window = new BrowserWindow({
            width: 1000,
            height: 720,
            backgroundColor: '#14100f',
            show: reveal,
            webPreferences: webPreferences(),
            title: "Halloween Map Overlay",
            icon: path.join(global.dirname, "src", "images", "icon.png"),
        })
        if (wasUnloaded) {
            appLog.event('main-window', {state: 'loaded', reason: reason || 'show'});
        }
        this.hiddenAt = reveal ? 0 : Date.now();
        let window = this.window;
        let obsWindow = this.obsWindow;
        this.window.on("closed", () => {
            // **The guard that makes unloading safe**: closing this window
            // shuts the app down, but *our own* teardown must not take the
            // overlay with it mid-match. The flag is on the **window object**
            // because `closed` may not be synchronous with `destroy()`.
            if (window.__hmoUnloading) return;
            // A real close shuts down **explicitly**, never via
            // `window-all-closed`: that needs *every* window gone, and the lazy
            // Tab window is closed by nobody there (overlay-windows.md).
            app.isQuiting = true;
            this.runShutdownHooks();
            obsWindow.close()
            app.quit();
        })
        // Not off `hide()`/`minimize`, so the tray click toggle is covered too.
        this.window.on('hide', () => {
            this.hiddenAt = Date.now();
            this.scheduleUnload('hidden');
        });
        this.window.on('show', () => {
            this.hiddenAt = 0;
            this.cancelUnload();
            this.flushToastQueue();
        });
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

        // Every load starts with a renderer that has reported nothing: one that
        // died with Settings open would leave `settings` in the busy set forever.
        this.window.webContents.on('did-start-loading', () => {
            if (this.busyReasons.size) {
                appLog.event('window-busy', {cleared: Array.from(this.busyReasons).join(',')});
                this.busyReasons.clear();
            }
            this.scheduleUnload('reload');
        });
        // Reload once, then a crash file and a quit within
        // `RENDERER_CRASH_WINDOW_MS`. Policy: docs/agents/diagnostics.md.
        this.window.webContents.on('render-process-gone', (event, details) => {
            // A window we are deliberately destroying is not a crash, or two
            // ordinary tray unloads 46 s apart would read as "died twice".
            if (window.__hmoUnloading) return;
            console.error('Renderer process gone:', details);
            const reason = (details && details.reason) || 'unknown';
            const now = Date.now();
            const recent = this.lastRendererGone && (now - this.lastRendererGone) < RENDERER_CRASH_WINDOW_MS;
            appLog.error('render-process-gone', {
                reason,
                exitCode: details && details.exitCode,
                repeat: recent ? 'yes' : 'no'
            });
            // Synchronously: the line has to survive whatever happens next.
            appLog.flush();
            // `clean-exit` is a normal close on some platforms.
            if (reason === 'clean-exit') return;
            this.lastRendererGone = now;
            if (!recent) {
                this.scheduleRendererReload();
                return;
            }
            appLog.fatal('render-process-gone', new Error(`the main window died twice in ${RENDERER_CRASH_WINDOW_MS / 1000} s (${reason})`), {quit: false});
            app.isQuiting = true;
            this.runShutdownHooks();
            app.quit();
        });
        // A GPU process that keeps dying is what "the overlay flickers" looks
        // like from the inside. **Bound once**: `show()` runs on every reopen.
        if (!MainWindow._childGoneBound) {
            MainWindow._childGoneBound = true;
            app.on('child-process-gone', (event, details) => {
                // A utility process finishing normally is not an incident.
                if (details && details.reason === 'clean-exit') return;
                appLog.error('child-process-gone', {
                    type: (details && details.type) || '',
                    reason: (details && details.reason) || '',
                    exitCode: details && details.exitCode
                });
            });
        }
        if (debug) {
            this.window.webContents.on('console-message', (event) => {
                console.log(`[renderer] ${event.message} (${event.sourceId}:${event.lineNumber})`);
            });
        }

        if (debug) this.window.webContents.openDevTools()
        if (!debug) this.window.setMenu(null)

        // **Once per process, not once per window**: the window is rebuilt after
        // every tray unload, and a GitHub request per reopen would change the
        // outside contact the README and the FAQ call "once at startup".
        if (!this.startupTasksDone) {
            this.startupTasksDone = true;
            this.cleanStaleUpdateHelpers()
            this.checkUpdates()
        }
        this.flushToastQueue();
        // A window built hidden never fires `show`/`hide`, so nothing else
        // would ever ask whether it may go again.
        if (!reveal) this.scheduleUnload('created-hidden');
    }

    /** Called from every input the pure `shouldUnloadMainWindow` depends on. */
    scheduleUnload(trigger) {
        this.cancelUnload();
        const verdict = this.unloadVerdict();
        if (debug) console.log(`main-window: unload check (${trigger}) → ${verdict.reason}`);
        if (verdict.unload) {
            this.unload(verdict.reason);
            return;
        }
        if (verdict.waitMs <= 0) return;
        this.unloadTimer = setTimeout(() => {
            this.unloadTimer = null;
            this.scheduleUnload('grace');
        }, verdict.waitMs);
        if (typeof this.unloadTimer.unref === 'function') this.unloadTimer.unref();
    }

    cancelUnload() {
        if (this.unloadTimer === null) return;
        clearTimeout(this.unloadTimer);
        this.unloadTimer = null;
    }

    unloadVerdict() {
        let visible = false;
        let minimized = false;
        const hasWindow = !!(this.window && !this.window.isDestroyed());
        if (hasWindow) {
            try {
                visible = this.window.isVisible();
                // Minimise-to-tray hides a window that Windows still reports as
                // minimised; only a window `hide()` never touched is on the taskbar.
                minimized = this.window.isMinimized() && !this.hiddenAt;
            } catch (err) {
                // A window that cannot answer is not worth destroying.
                visible = true;
            }
        }
        const hotkeys = this.shutdownHooks && this.shutdownHooks.hotkeys;
        return shouldUnloadMainWindow({
            hasWindow,
            visible,
            minimized,
            hiddenAt: this.hiddenAt,
            now: Date.now(),
            busy: this.busyReasons,
            recording: !!(hotkeys && hotkeys.suspended),
            updatePending: this.pendingUpdateVersion !== null,
            updateBannerShown: this.updateBannerShown,
            installing: this.installStarted || this.installInFlight !== null,
            quitting: !!app.isQuiting,
            graceMs: UNLOAD_GRACE_MS
        });
    }

    /**
     * The overlay, the detector, the hotkeys and the map state are untouched —
     * the whole point. `destroy()`, not `close()`: `close()` runs the handler
     * that *hides* whenever minimize-to-tray is on.
     */
    unload(reason) {
        const hiddenMs = this.hiddenAt ? Date.now() - this.hiddenAt : 0;
        const win = this.window;
        if (!win || win.isDestroyed()) return;
        // Never cleared: the `closed` handler must skip the overlay teardown
        // whenever it happens to run.
        win.__hmoUnloading = true;
        try {
            win.destroy();
        } catch (err) {
            console.error('Main window unload failed:', err && err.message);
            appLog.error('main-window', {state: 'unload-failed', message: (err && err.message) || String(err)});
            return;
        }
        this.window = null;
        this.unloaded = true;
        this.busyReasons.clear();
        appLog.event('main-window', {state: 'unloaded', reason: reason || 'tray', hiddenMs});
        console.log(`Main window unloaded after ${Math.round(hiddenMs / 1000)} s in the tray (${reason || 'tray'}).`);
    }

    unloadState() {
        return {
            loaded: !!(this.window && !this.window.isDestroyed()),
            unloaded: this.unloaded,
            busy: Array.from(this.busyReasons)
        };
    }

    /**
     * One of the app's two network requests. Skipped in dev (**do not** redefine
     * `app.isPackaged` to fake a feed), in the portable build and with the
     * setting off; every failure is only logged, because being offline is at
     * most a toast.
     */
    checkUpdates() {
        if (!app.isPackaged) {
            console.log('Update check skipped: not a packaged build.');
            return;
        }
        // `app.isPackaged` is true in the portable exe too and electron-updater
        // has no guard of its own: it would update a copy nobody is running.
        if (process.env.PORTABLE_EXECUTABLE_DIR) {
            console.log('Update check skipped: portable build.');
            return;
        }
        if (this.settings && this.settings.get('checkForUpdates') === false) {
            console.log('Update check skipped: disabled in settings.');
            return;
        }

        // `show()` runs on every tray reopen: the library dedupes the network
        // work, but the Settings button and line would flicker.
        if (isUpdateCheckOccupied(this.resolveStalledUpdateCheck())) {
            console.log('Update check skipped: one is already in flight.');
            return;
        }

        this.prepareUpdater();

        setTimeout(() => {
            // Re-asked: 4 s is long enough for the button to start its own.
            if (isUpdateCheckOccupied(this.resolveStalledUpdateCheck())) return;
            // The stock text promises an install on exit, which is no longer
            // true. Translated *in main* because it is a native notification;
            // `{appName}`/`{version}` are electron-updater's own placeholders,
            // which `t()` leaves alone.
            const lang = this.language ? this.language.current() : 'en';
            autoUpdater.checkForUpdatesAndNotify({
                title: t(lang, 'update.notify.title'),
                body: t(lang, 'update.notify.body')
            }).catch(err => {
                console.error('Update check failed:', err && err.message);
            });
        }, 4000);
    }

    /**
     * **Once**, whatever starts the check: the Settings button runs with the
     * startup switch off, and `_updaterBound` stops ten presses leaving ten
     * listeners behind.
     */
    prepareUpdater() {
        // Download in the background, install only when asked: the default quit
        // handler ran the installer the moment the user closed the app and froze
        // the machine. Explicit, and `installUpdate()` is the only trigger.
        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = false;
        // With a *non-silent* install this, not `quitAndInstall`'s second
        // argument, relaunches the app. Pinned though already default.
        autoUpdater.autoRunAppAfterInstall = true;

        const self = this;
        if (MainWindow._updaterBound) return;
        MainWindow._updaterBound = true;
        autoUpdater.on('checking-for-update', () => {
            appLog.event('update', {state: 'checking'});
            self.sendUpdate(msg('update.checking'));
            self.setUpdateCheckState('checking');
        });
        autoUpdater.on('update-available', (info) => {
            const version = (info && info.version) || '';
            appLog.event('update', {state: 'available', version});
            self.sendUpdate(msg('update.available'));
            // `autoDownload` is on, so this is the download starting too.
            self.setUpdateCheckState('found', version);
        });
        autoUpdater.on('update-not-available', () => {
            appLog.event('update', {state: 'up-to-date'});
            self.sendUpdate(msg('update.upToDate'));
            // The version to name is the one running, not anything off the feed.
            self.setUpdateCheckState('upToDate', MainWindow.appVersion());
        });
        autoUpdater.on('download-progress', (p) => {
            self.sendUpdate(msg('update.downloading', {percent: Math.round(p.percent || 0)}));
            // A long download's only liveness signal.
            self.noteUpdateCheckActivity();
        });
        autoUpdater.on('update-downloaded', (info) => {
            const version = info && info.version ? String(info.version) : '';
            appLog.event('update', {state: 'downloaded', version});
            self.pendingUpdateVersion = version || null;
            // The .exe in the update cache, which we run ourselves.
            self.pendingInstallerPath = (info && typeof info.downloadedFile === 'string')
                ? info.downloadedFile : null;
            self.sendUpdate(msg('update.downloaded'));
            self.setUpdateCheckState('downloaded', version);
            // **Not** a reason to build a window: the renderer pulls
            // `get-pending-update` on load and the tray grows its item either
            // way (rebuilding it hidden was tried and removed —
            // `docs/SPEC-MAP-STATE.md` §5.3). Both flags reset: a new version
            // is news even after a "Later".
            self.updateBannerShown = false;
            self.updateDismissed = false;
            self.send('update-ready', {version});
            const tray = self.shutdownHooks && self.shutdownHooks.tray;
            if (tray && typeof tray.setUpdatePending === 'function') {
                tray.setUpdatePending(version);
            }
        });
        autoUpdater.on('error', (err) => {
            console.error('Update check failed:', err && err.message);
            // Logged, not only toasted, or "it said update failed" is
            // unanswerable. The user sees one sentence, never the error or a path.
            appLog.error('update', {state: 'error', message: (err && err.message) || String(err)});
            self.sendUpdate(msg('update.checkFailed'));
            self.setUpdateCheckState('failed');
        });
    }

    /** `app.getVersion()` answers 40.x under `npm start`, hence package.json. */
    static appVersion() {
        try {
            return require('../../package.json').version || '';
        } catch (err) {
            return '';
        }
    }

    updateCheckStatus() {
        return {state: this.updateCheckState, version: this.updateCheckVersion};
    }

    /** Record the state and push it; nothing English travels (`manualCheckView`). */
    setUpdateCheckState(state, version) {
        this.updateCheckState = state;
        this.updateCheckVersion = version ? String(version) : null;
        this.noteUpdateCheckActivity();
        this.send('update-check-state', this.updateCheckStatus());
    }

    /** The watchdog is re-armed here: a busy state without one is the bug. */
    noteUpdateCheckActivity() {
        this.updateCheckActivityAt = Date.now();
        this.armUpdateCheckWatchdog();
    }

    /** The pure `updateCheckStall()` owns the thresholds; not busy → no timer. */
    armUpdateCheckWatchdog() {
        if (this.updateCheckWatchdog !== null) {
            clearTimeout(this.updateCheckWatchdog);
            this.updateCheckWatchdog = null;
        }
        const {waitMs} = updateCheckStall({
            state: this.updateCheckState,
            lastActivityAt: this.updateCheckActivityAt,
            now: Date.now()
        });
        if (waitMs <= 0) return;
        this.updateCheckWatchdog = setTimeout(() => {
            this.updateCheckWatchdog = null;
            this.resolveStalledUpdateCheck();
        }, waitMs);
        if (typeof this.updateCheckWatchdog.unref === 'function') this.updateCheckWatchdog.unref();
    }

    /**
     * Silent for too long → `failed`, and the button comes back. Called by the
     * watchdog *and* by anything about to act on the state, so a timer that
     * never ran (a suspended laptop) cannot strand the button.
     * @returns {string} the state after this.
     */
    resolveStalledUpdateCheck() {
        const verdict = updateCheckStall({
            state: this.updateCheckState,
            lastActivityAt: this.updateCheckActivityAt,
            now: Date.now()
        });
        if (!verdict.stalled) return this.updateCheckState;
        // **Not a cancellation**: electron-updater is left alone, so a download
        // that comes back to life still raises the banner.
        appLog.error('update', {state: 'stalled', from: this.updateCheckState});
        this.sendUpdate(msg('update.checkFailed'));
        this.setUpdateCheckState('failed');
        return this.updateCheckState;
    }

    /**
     * Settings › General → "Check for updates now". Deliberately does **not**
     * consult the `checkForUpdates` setting: that switch governs the *automatic*
     * check, pressing the button is its own consent, and this never writes it.
     * @returns {{state: string, version: ?string}} the `update-check-state` shape.
     */
    async checkForUpdatesNow() {
        const plan = planManualUpdateCheck({
            packaged: app.isPackaged,
            portable: !!process.env.PORTABLE_EXECUTABLE_DIR,
            // Stall check first: a click is how a user reports a dead download,
            // and "already running" is the worst possible reply to that.
            state: this.resolveStalledUpdateCheck()
        });
        // No URL, no path: what the user pressed and what they were told.
        appLog.event('update', {state: 'manual-check', result: plan.state});
        if (!plan.start) {
            // These answer the *click*, not where the check stands, so a
            // running startup check stays visible to the next caller.
            return {state: plan.state, version: this.updateCheckVersion};
        }
        this.prepareUpdater();
        // Before the call: `checking-for-update` may fire first.
        this.setUpdateCheckState('checking');
        try {
            const result = await autoUpdater.checkForUpdates();
            // Still `checking` means neither event fired (`checkForUpdates()`
            // resolves `null` when electron-updater declines to run). An answer
            // is owed, and it is **not** "you are on the latest version".
            if (this.updateCheckState === 'checking') {
                const version = result && result.updateInfo && result.updateInfo.version;
                if (result && result.downloadPromise) {
                    this.setUpdateCheckState('found', version);
                } else {
                    appLog.error('update', {state: 'no-answer'});
                    this.setUpdateCheckState('failed');
                }
            }
        } catch (err) {
            // The `error` event usually fires too; `failed` is idempotent.
            console.error('Update check failed:', err && err.message);
            appLog.error('update', {state: 'error', message: (err && err.message) || String(err)});
            this.setUpdateCheckState('failed');
        }
        return this.updateCheckStatus();
    }

    setShutdownHooks(hooks) {
        this.shutdownHooks = hooks || {};
    }

    /**
     * **This order is load-bearing**: the two always-on-top click-through
     * windows first, before anything slow, so neither is left drawing over the
     * game; then the detector, then the tray. A throw would strand the quit.
     */
    runShutdownHooks() {
        const {mapDetector, tray, tabMode} = this.shutdownHooks || {};
        try {
            if (this.overlayWindow && typeof this.overlayWindow.close === 'function') this.overlayWindow.close();
        } catch (err) {
            console.error('Overlay close failed during shutdown:', err && err.message);
        }
        try {
            if (tabMode && typeof tabMode.destroy === 'function') tabMode.destroy();
        } catch (err) {
            console.error('Tab markers close failed during shutdown:', err && err.message);
        }
        try {
            // `destroy()`, not `stop()`: a child still holding the native
            // capture module while the installer replaces the app dir is trouble.
            if (mapDetector && typeof mapDetector.destroy === 'function') mapDetector.destroy();
            else if (mapDetector && typeof mapDetector.stop === 'function') mapDetector.stop();
        } catch (err) {
            console.error('Detector stop failed during install:', err && err.message);
        }
        try {
            if (tray && typeof tray.destroy === 'function') tray.destroy();
        } catch (err) {
            console.error('Tray destroy failed during install:', err && err.message);
        }
    }

    /**
     * **Idle** priority is what keeps the desktop responsive: Windows derives
     * the **I/O** priority from the priority class, and the ~350 MB unpack is
     * disk-bound, not CPU. **Every token of the command line below is
     * load-bearing** — each one: docs/agents/updater-and-installer.md.
     */
    spawnInstallerAtLowPriority() {
        if (process.platform !== 'win32') {
            // `start /LOW` is a cmd.exe builtin; elsewhere there is no NSIS.
            return false;
        }
        const installerPath = this.pendingInstallerPath
            || (autoUpdater.downloadedUpdateHelper && autoUpdater.downloadedUpdateHelper.file)
            || null;
        if (!installerPath) {
            console.error('No installer path from update-downloaded; falling back to electron-updater.');
            return false;
        }
        if (!fs.existsSync(installerPath)) {
            console.error(`Downloaded installer is gone (${installerPath}); falling back to electron-updater.`);
            return false;
        }
        const args = ['/c', 'start', '""', '/LOW', '/B', `"${installerPath}"`, '--updated', '--force-run'];
        const child = spawn('cmd.exe', args, {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
            windowsVerbatimArguments: true
        });
        // An `error` event with no listener is an uncaught exception.
        child.on('error', (err) => {
            console.error('Installer launcher failed:', err && err.message);
        });
        // Belt and braces: this pid is almost certainly the transient cmd.exe.
        try {
            if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW);
        } catch (err) {
            console.log('setPriority on the installer launcher failed (harmless):', err && err.message);
        }
        child.unref();
        console.log(`Installer started at low priority: ${installerPath}`);
        return true;
    }

    /**
     * The library is the authority; before any download the startup sweep has
     * to fall back to `app-update.yml`.
     */
    updaterCacheDir() {
        const helper = autoUpdater.downloadedUpdateHelper;
        if (helper && helper.cacheDir) return helper.cacheDir;
        let cacheDirName = null;
        try {
            cacheDirName = updateHelper.updaterCacheDirName(
                fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf-8'));
        } catch (err) {
            // Not packaged; the `appName` branch is the library's own fallback.
        }
        return updateHelper.helperHome({
            localAppData: process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
            cacheDirName,
            appName: app.getName()
        });
    }

    /** Housekeeping, not a guarantee, so it never throws. */
    cleanStaleUpdateHelpers() {
        if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_DIR) return;
        try {
            const removed = updateHelper.cleanStaleHelpers({homeDir: this.updaterCacheDir()});
            if (removed) appLog.event('update-helper', {cleaned: removed});
        } catch (err) {
            console.error('Stale updater cleanup failed (harmless):', err && err.message);
        }
    }

    /**
     * **Physical** pixels (the helper places itself with `SetWindowPos`), and
     * **`getContentBounds()`, not `getBounds()`**: the native frame makes the
     * outer rectangle ~32 px taller, so a helper centred in it draws the same
     * picture ~16 px lower and the hand-over visibly jumps.
     */
    updaterPlacement() {
        const win = this.window;
        let rect = null;
        let activate = false;
        try {
            if (win && !win.isDestroyed() && win.isVisible()) {
                rect = screen.dipToScreenRect(win, win.getContentBounds());
                // Never pull focus out of a game: unfocused here, unactivated there.
                activate = win.isFocused();
            }
        } catch (err) {
            console.error('Could not read the window bounds for the updater:', err && err.message);
            rect = null;
        }
        let workArea = {x: 0, y: 0, width: 1920, height: 1080};
        let scaleFactor = 1;
        try {
            const primary = screen.getPrimaryDisplay();
            workArea = screen.dipToScreenRect(null, primary.workArea);
            // The helper lays out in DIPs at the *system* (primary) DPI.
            scaleFactor = primary.scaleFactor || 1;
        } catch (err) {
            console.error('Could not read the primary display for the updater:', err && err.message);
        }
        return {bounds: updateHelper.helperBounds(rect, workArea, scaleFactor), activate};
    }

    /**
     * Tier 1. False for **every** failure, and a false costs nothing: the app
     * has not quit, because `launchUpdater` resolves `ok` only once there is a
     * helper window on screen.
     */
    async startThemedUpdater(version) {
        if (process.platform !== 'win32') return false;
        if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_DIR) return false;
        const installerPath = this.pendingInstallerPath
            || (autoUpdater.downloadedUpdateHelper && autoUpdater.downloadedUpdateHelper.file)
            || null;
        if (!installerPath || !fs.existsSync(installerPath)) return false;

        const appExe = app.getPath('exe');
        const placement = this.updaterPlacement();
        const started = Date.now();
        let result;
        try {
            result = await updateHelper.launchUpdater({
                resourcesPath: process.resourcesPath,
                // **Never `%TEMP%`**: an unsigned exe run from there made
                // Bitdefender's ATD kill the whole launching process tree. The
                // updater cache already runs that same installer.
                homeDir: this.updaterCacheDir(),
                version,
                installerPath,
                installDir: path.dirname(appExe),
                appExe,
                lang: this.language ? this.language.current() : 'en',
                waitPid: process.pid,
                bounds: placement.bounds,
                activate: placement.activate,
                logPath: path.join(app.getPath('userData'), 'updater.log')
            });
        } catch (err) {
            appLog.error('update-helper', {ok: 'no', reason: 'threw', message: (err && err.message) || String(err)});
            return false;
        }
        if (!result.ok) {
            appLog.error('update-helper', {ok: 'no', reason: result.reason || 'unknown', ms: Date.now() - started});
            return false;
        }
        appLog.event('update-helper', {ok: 'yes', pid: result.pid || 0, ms: Date.now() - started});
        return true;
    }

    /**
     * The quit is deferred one turn of the loop so the `install-update` reply is
     * flushed: it tells the "updating" view whether to stay or get out of the
     * way, and destroying the window drops it.
     */
    finishInstall(version, how) {
        this.installStarted = true;
        app.isQuiting = true;
        appLog.event('install-update', {version, path: how});
        appLog.flush();
        console.log(`Installing update ${version} (${how}) and restarting.`);
        setImmediate(() => {
            this.runShutdownHooks();
            app.quit();
        });
    }

    /**
     * The only entry point for installing an update.
     *
     * **Three tiers, each falling through to the next**: the themed helper
     * (silent `/S`), the visible one-click installer at idle priority, then
     * `autoUpdater.quitAndInstall`. **No user can be stranded on an old version
     * by tier 1**, because the app has not quit when tier 1 gives up. The NSIS
     * flags the relaunch depends on, and why the install is ours at all, are in
     * docs/agents/updater-and-installer.md.
     *
     * `app.isQuiting` has to be set first, or the `close` handler hides the
     * window whenever minimize-to-tray is on and `app.quit()` never completes.
     *
     * @returns {Promise<{ok: boolean, themed: boolean}>} the "updating" view
     *   stays up only while `themed`.
     */
    installUpdate() {
        // **Single-flight.** Tier 1 awaits the handshake for up to 4 s, and the
        // banner and the tray item pressed inside that window each spawned
        // their own helper — two silent installers over one install dir.
        if (this.installInFlight) return this.installInFlight;
        this.installInFlight = this.runInstallUpdate().finally(() => {
            this.installInFlight = null;
        });
        return this.installInFlight;
    }

    async runInstallUpdate() {
        if (!this.pendingUpdateVersion) {
            console.log('Install update requested with no update pending.');
            return {ok: false, themed: false};
        }
        if (this.installStarted) {
            console.log('Install update ignored: the installer is already running.');
            return {ok: true, themed: true};
        }
        const version = this.pendingUpdateVersion;
        // The window shows its "updating" view *now*, so the helper opens on an
        // identical picture — from here, because the tray item is a second way in.
        this.send('update-installing', {version});

        // Tier 1. Nothing below has been lost by trying.
        try {
            if (await this.startThemedUpdater(version)) {
                this.finishInstall(version, 'themed');
                return {ok: true, themed: true};
            }
        } catch (err) {
            console.error('Themed updater failed:', err && err.message);
            appLog.error('update-helper', {ok: 'no', reason: 'threw', message: (err && err.message) || String(err)});
        }
        // The tray item can arrive while the await above is pending.
        if (this.installStarted) return {ok: true, themed: true};

        try {
            if (this.spawnInstallerAtLowPriority()) {
                // It draws its own window (build/installer.nsh), so the app's
                // "updating" view has to get out of the way.
                this.send('update-install-result', {ok: true, themed: false});
                this.finishInstall(version, 'stock');
                return {ok: true, themed: false};
            }
        } catch (err) {
            console.error('Low-priority installer launch failed:', err && err.message);
        }
        // Tier 3 — electron-updater, normal priority. Not deferred: this one
        // quits the app itself.
        try {
            this.installStarted = true;
            app.isQuiting = true;
            appLog.event('install-update', {version, path: 'quitAndInstall'});
            appLog.flush();
            this.send('update-install-result', {ok: true, themed: false});
            this.runShutdownHooks();
            console.log(`Installing update ${version} through electron-updater (normal priority).`);
            autoUpdater.quitAndInstall(false, true);
            return {ok: true, themed: false};
        } catch (err) {
            console.error('Install update failed:', err && err.message);
            appLog.error('install-update', {version, message: (err && err.message) || String(err)});
            this.installStarted = false;
            app.isQuiting = false;
            this.send('update-install-result', {ok: false, themed: false});
            // `keep`: an install can start from the tray item with no window at
            // all, and this is the one update message the user must act on.
            this.sendUpdate(msg('update.installFailed'), {keep: true});
            return {ok: false, themed: false};
        }
    }

    /**
     * The bottom-right toast of the main window.
     *
     * With no window a message is **dropped** unless it is classified `keep`,
     * which is a decision per message class, not a default: `keep` is for the
     * ones that explain a behaviour change nobody asked for. The table is
     * `docs/SPEC-MAP-STATE.md` §6.
     *
     * @param {{key: string, params: ?Object}|string} message built with `msg()`,
     *   so the renderer translates it on arrival and a toast on screen is never
     *   stranded in the previous language.
     */
    sendUpdate(message, opts = {}) {
        if (this.window && !this.window.isDestroyed()) {
            this.window.webContents.send('update-message', message);
            return;
        }
        if (!opts.keep) return;
        const key = message && typeof message === 'object' ? message.key : String(message || '');
        // Deduped by key, or five copies of "settings could not be saved" push
        // everything else out of a five-deep queue.
        this.toastQueue = this.toastQueue.filter(m => (m && typeof m === 'object' ? m.key : String(m)) !== key);
        this.toastQueue.push(message);
        while (this.toastQueue.length > TOAST_QUEUE_MAX) this.toastQueue.shift();
    }

    /**
     * **One at a time, `TOAST_FLUSH_GAP_MS` apart**, and only into a **visible**
     * window: a toast auto-hides whether or not anybody is looking.
     */
    flushToastQueue() {
        if (!this.toastQueue.length) return;
        const win = this.window;
        if (!win || win.isDestroyed()) return;
        let visible = false;
        try {
            visible = win.isVisible();
        } catch (err) {
            visible = false;
        }
        if (!visible) return;
        const queued = this.toastQueue;
        this.toastQueue = [];
        appLog.event('toast-queue', {flushed: queued.length});
        // The window may be microseconds old; `did-finish-load`, not a timeout.
        const deliver = () => {
            queued.forEach((message, index) => {
                // The first goes out now: nothing for it to collide with.
                if (index === 0) {
                    if (!win.isDestroyed()) win.webContents.send('update-message', message);
                    return;
                }
                const timer = setTimeout(() => {
                    if (!win.isDestroyed()) win.webContents.send('update-message', message);
                }, index * TOAST_FLUSH_GAP_MS);
                if (typeof timer.unref === 'function') timer.unref();
            });
        };
        if (win.webContents.isLoading()) win.webContents.once('did-finish-load', deliver);
        else deliver();
    }

    send(event, ...data) {
        if (this.window && !this.window.isDestroyed()) {
            this.window.webContents.send(event, ...data);
        }
    }

    focus() {
        if (this.window && !this.window.isDestroyed()) {
            this.window.focus();
        }
    }

    isVisible() {
        if (this.window && !this.window.isDestroyed()) {
            return this.window.isVisible();
        }
        return false;
    }

    hide() {
        if (this.window && !this.window.isDestroyed()) {
            this.window.hide();
        }
    }
}

module.exports = MainWindow;
