const {BrowserWindow, app, shell, ipcMain, screen} = require("electron");
const path = require("path");
const fs = require("fs");
const {imageSize} = require('image-size');
const {computeOverlayPosition, rotatedSize} = require('./overlay-position');
const {mapLabelMode} = require('../shared/settings-defaults');
const {webPreferences} = require('../shared/web-preferences');
const {drawableLayers, markerState, SURFACE_OVERLAY} = require('../shared/marker-rules');
const {markerGeometry, markerReach} = require('../shared/marker-geometry');
const {shouldUnloadMainWindow, UNLOAD_GRACE_MS} = require('../shared/window-unload');
const {errorMessage} = require('../shared/errors');
const {clearTimer, unrefTimer} = require('../shared/timers');
const {clampWindowSize, minimumSize, sizeToPersist} = require('../shared/window-size');
const {markQuitting, isQuitting} = require('./quitting');
const Updater = require('./updater');
const appLog = require('./app-log');

const debug = process.env.DEBUG === 'true';

/** Two renderer deaths closer together than this are a crash loop, not a hiccup. */
const RENDERER_CRASH_WINDOW_MS = 60000;

/** Only has to leave the `render-process-gone` stack; see `scheduleRendererReload`. */
const RENDERER_RELOAD_DELAY_MS = 100;

/** How many `keep` toasts may wait for a window that does not exist; oldest goes. */
const TOAST_QUEUE_MAX = 5;

/** `src/js/status.js` has one auto-hide timer, so only the last of a batch is
 * read. 2.5 s = half the toast's 5 s life. */
const TOAST_FLUSH_GAP_MS = 2500;

/** The overlay window's slack around the rotated map: width in px, height as a factor. */
const OVERLAY_WIDTH_SLACK_PX = 5;
const OVERLAY_HEIGHT_SLACK = 1.1;

/** The colour the main window paints before the page loads. */
const MAIN_WINDOW_BACKGROUND = '#14100f';

/** A resize is stored once it has settled, not on every drag tick. */
const SIZE_SAVE_DELAY_MS = 500;

class MainWindow {

    window = null;
    obsWindow;
    overlayWindow;
    settings;
    mapLibrary;
    language = null;
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
    /** `cleanStaleUpdateHelpers` + `checkUpdates` run on the first build only. */
    startupTasksDone = false;
    toastQueue = [];
    sizeSaveTimer = null;

    constructor(obsWindow, overlayWindow, settings, mapLibrary, language) {
        this.obsWindow = obsWindow;
        this.overlayWindow = overlayWindow;
        this.settings = settings;
        this.mapLibrary = mapLibrary;
        // Only for the native notification; everything else travels as `{key, params}`.
        this.language = language || null;
        this.updater = new Updater({
            settings,
            language: this.language,
            send: (channel, payload) => this.send(channel, payload),
            sendUpdate: (message, opts) => this.sendUpdate(message, opts),
            getWindow: () => this.window,
            getTray: () => this.shutdownHooks && this.shutdownHooks.tray,
            runShutdownHooks: () => this.runShutdownHooks()
        });

        ipcMain.on('obs-open', async () => {
            appLog.event('obs', {action: 'open'});
            obsWindow.show()
        });
        // Pulled, not only pushed, and `dismissed` travels with it: "Later" has
        // to survive the window being destroyed.
        ipcMain.handle('get-pending-update', async () => this.updater.pendingUpdate());
        ipcMain.on('update-banner-dismissed', () => {
            this.updater.updateDismissed = true;
            // A dismissed banner is no longer a reason to keep the window.
            this.updater.updateBannerShown = true;
            this.scheduleUnload('banner-dismissed');
        });
        ipcMain.handle('install-update', async () => this.installUpdate());
        // `handle`, not `on`: the button stays disabled until this answers.
        ipcMain.handle('check-for-updates-now', async () => this.updater.checkForUpdatesNow());
        // Stall check first: one more way out of a silently dead download.
        ipcMain.handle('get-update-check-state', async () => {
            this.updater.resolveStalledUpdateCheck();
            return this.updater.updateCheckStatus();
        });
        // The folder, never the file: a `.log` opens in who knows what.
        ipcMain.handle('open-log-folder', async () => {
            const dir = app.getPath('userData');
            const error = await shell.openPath(dir);
            if (error) console.error('Could not open the log folder:', error);
            return {ok: !error, path: dir};
        });
        // package.json, not `app.getVersion()` — see `Updater.appVersion`.
        ipcMain.handle('version', async () => require('../../package.json').version);
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
                appLog.error('map-change', {message: errorMessage(err)});
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
            this.updater.updateBannerShown = true;
            this.scheduleUnload('banner-shown');
        });
    }

    /** Is there a window to talk to? */
    alive() {
        return !!(this.window && !this.window.isDestroyed());
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
                        message: errorMessage(err)
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
        overlayWindow.setBounds({
            ...selectedDisplay.workArea,
            width: 0,
            height: 0,
            x: settings.get('overlayX') || 0,
            y: settings.get('overlayY') || 0
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
        // At larger sizes an edge marker reaches past the slack.
        const markerPad = markers
            ? Math.ceil(markerReach(markerGeometry(displayWidth))) * 2 : 0;
        const overlayWidth = rotated.width + OVERLAY_WIDTH_SLACK_PX + markerPad;
        const overlayHeight = parseInt(rotated.height * OVERLAY_HEIGHT_SLACK) + markerPad;
        overlayWindow.setSize(overlayWidth, overlayHeight)
        if (debug) {
            console.log("Selected display:", selectedDisplay);
            console.log("Overlay bounds:", overlayWindow.getBounds());
            console.log("Image dimensions:", dimensions);
            console.log("Calculated overlay size:", {width: overlayWidth, height: overlayHeight, markerPad});
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
        let label = '';
        if (labelMode === 'always') label = requested || resolvedName;
        else if (labelMode === 'auto') label = opts.preview ? '' : requested;

        const image = Buffer.from(imgData).toString("base64");
        const size = settings.get('size');
        const hidden = settings.get('hideOverlay');
        overlayWindow.send('map-change', {
            image: hidden ? '' : image,
            size,
            opacity: settings.get('opacity'),
            draggable: settings.get('draggable'),
            rotation: settings.get('rotation'),
            label: hidden ? '' : label,
            labelMode,
            markers: hidden ? null : markers,
            lang
        });
        // The settings preview must never leak into a stream.
        if (!opts.preview) obsWindow.send('map-change', {image, size, label, labelMode, markers, lang});
        return true;
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
        const state = markerState(this.settings.all());
        if (!state.enabled) return null;
        const markers = this.mapMarkers.markers(entry.key);
        if (!markers) return null;
        const layers = drawableLayers({
            markers,
            surface: SURFACE_OVERLAY,
            settings: this.settings.all()
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
                if (this.alive()) this.window.reload();
            } catch (err) {
                console.error('Renderer reload failed:', err && err.message);
                appLog.error('render-process-gone', {reload: 'failed', message: errorMessage(err)});
            }
        }, RENDERER_RELOAD_DELAY_MS);
    }

    logMapChange(key, source) {
        if (this.lastLoggedMap && this.lastLoggedMap.key === key && this.lastLoggedMap.source === source) return;
        this.lastLoggedMap = {key, source};
        appLog.event('map-change', {key, source});
    }

    /** Debounced; a failed write warns through `Settings.write()`, as the overlay drag does. */
    scheduleSizeSave(window) {
        this.sizeSaveTimer = clearTimer(this.sizeSaveTimer);
        this.sizeSaveTimer = unrefTimer(setTimeout(() => {
            this.sizeSaveTimer = null;
            if (!window || window.isDestroyed()) return;
            const [width, height] = window.getSize();
            const next = sizeToPersist({width, height}, {
                maximized: window.isMaximized(),
                minimized: window.isMinimized(),
                fullScreen: window.isFullScreen()
            }, this.settings.get('mainWindowSize'));
            if (next) this.settings.set('mainWindowSize', next);
        }, SIZE_SAVE_DELAY_MS));
    }

    /**
     * **Everything that rebuilds this window is a user action.** One nobody
     * asked for either costs a renderer build mid-match or steals the
     * foreground from the game; anything that has to reach the user with no
     * window is pulled on the next load, carried by the tray, or queued.
     */
    show(reason) {
        if (this.alive()) {
            this.cancelUnload();
            this.window.show();
            return;
        }
        this.window = null;
        // **Never build a window on the way out**: a second instance during
        // `finishInstall`'s deferred quit would build a renderer while the
        // installer is taking over, and `app.quit()` would have one more window.
        if (isQuitting()) return;
        const wasUnloaded = this.unloaded;
        this.unloaded = false;
        this.cancelUnload();
        // Size only, checked against the screen it opens on; never position.
        // Why: docs/agents/overlay-windows.md § The main window's size.
        const workArea = screen.getPrimaryDisplay().workArea;
        const size = clampWindowSize(this.settings.get('mainWindowSize'), workArea);
        const min = minimumSize(workArea);
        this.window = new BrowserWindow({
            width: size.width,
            height: size.height,
            minWidth: min.width,
            minHeight: min.height,
            backgroundColor: MAIN_WINDOW_BACKGROUND,
            show: true,
            webPreferences: webPreferences(),
            title: "Halloween Map Overlay",
            icon: path.join(global.dirname, "src", "images", "icon.png"),
        })
        if (wasUnloaded) {
            appLog.event('main-window', {state: 'loaded', reason: reason || 'show'});
        }
        this.hiddenAt = 0;
        const window = this.window;
        const obsWindow = this.obsWindow;
        const settings = this.settings;
        window.on("closed", () => {
            // **The guard that makes unloading safe**: closing this window
            // shuts the app down, but *our own* teardown must not take the
            // overlay with it mid-match. The flag is on the **window object**
            // because `closed` may not be synchronous with `destroy()`.
            this.sizeSaveTimer = clearTimer(this.sizeSaveTimer);
            if (window.__hmoUnloading) return;
            // A real close shuts down **explicitly**, never via
            // `window-all-closed`: that needs *every* window gone, and the lazy
            // Tab window is closed by nobody there (overlay-windows.md).
            markQuitting();
            this.runShutdownHooks();
            obsWindow.close()
            app.quit();
        })
        // Not off `hide()`/`minimize`, so the tray click toggle is covered too.
        window.on('hide', () => {
            this.hiddenAt = Date.now();
            this.scheduleUnload('hidden');
        });
        window.on('show', () => {
            this.hiddenAt = 0;
            this.cancelUnload();
            this.flushToastQueue();
        });
        window.on('resize', () => this.scheduleSizeSave(window));
        window.on("minimize", (event) => {
            if (settings.get('minimizeToTray')) {
                event.preventDefault();
                window.hide();
            }
        })
        window.on('close', (event) => {
            if (settings.get('minimizeToTray') && !isQuitting()) {
                event.preventDefault();
                window.hide();
            }
            return false;
        });
        window.loadFile('src/index.html')

        window.webContents.setWindowOpenHandler(({url}) => {
            shell.openExternal(url);
            return {action: 'deny'};
        });

        // Every load starts with a renderer that has reported nothing: one that
        // died with Settings open would leave `settings` in the busy set forever.
        window.webContents.on('did-start-loading', () => {
            if (this.busyReasons.size) {
                appLog.event('window-busy', {cleared: Array.from(this.busyReasons).join(',')});
                this.busyReasons.clear();
            }
            this.scheduleUnload('reload');
        });
        // Reload once, then a crash file and a quit within
        // `RENDERER_CRASH_WINDOW_MS`. Policy: docs/agents/diagnostics.md.
        window.webContents.on('render-process-gone', (event, details) => {
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
            markQuitting();
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
            window.webContents.on('console-message', (event) => {
                console.log(`[renderer] ${event.message} (${event.sourceId}:${event.lineNumber})`);
            });
        }

        if (debug) window.webContents.openDevTools()
        if (!debug) window.setMenu(null)

        // **Once per process, not once per window**: the window is rebuilt after
        // every tray unload, and a GitHub request per reopen would change the
        // outside contact the README and the FAQ call "once at startup".
        if (!this.startupTasksDone) {
            this.startupTasksDone = true;
            this.updater.cleanStaleUpdateHelpers()
            this.updater.checkUpdates()
        }
        this.flushToastQueue();
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
        this.unloadTimer = unrefTimer(setTimeout(() => {
            this.unloadTimer = null;
            this.scheduleUnload('grace');
        }, verdict.waitMs));
    }

    cancelUnload() {
        this.unloadTimer = clearTimer(this.unloadTimer);
    }

    unloadVerdict() {
        let visible = false;
        let minimized = false;
        const hasWindow = this.alive();
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
            ...this.updater.unloadInputs(),
            quitting: isQuitting(),
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
        if (!this.alive()) return;
        const win = this.window;
        // Never cleared: the `closed` handler must skip the overlay teardown
        // whenever it happens to run.
        win.__hmoUnloading = true;
        try {
            win.destroy();
        } catch (err) {
            console.error('Main window unload failed:', err && err.message);
            appLog.error('main-window', {state: 'unload-failed', message: errorMessage(err)});
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
            loaded: this.alive(),
            unloaded: this.unloaded,
            busy: Array.from(this.busyReasons)
        };
    }

    /** The tray's and the banner's way in; the flow is `Updater.installUpdate`. */
    installUpdate() {
        return this.updater.installUpdate();
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
        if (this.alive()) {
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
        if (!this.alive()) return;
        const win = this.window;
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
                unrefTimer(setTimeout(() => {
                    if (!win.isDestroyed()) win.webContents.send('update-message', message);
                }, index * TOAST_FLUSH_GAP_MS));
            });
        };
        if (win.webContents.isLoading()) win.webContents.once('did-finish-load', deliver);
        else deliver();
    }

    send(event, ...data) {
        if (this.alive()) this.window.webContents.send(event, ...data);
    }

    focus() {
        if (this.alive()) this.window.focus();
    }

    isVisible() {
        return this.alive() ? this.window.isVisible() : false;
    }

    hide() {
        if (this.alive()) this.window.hide();
    }
}

module.exports = MainWindow;
