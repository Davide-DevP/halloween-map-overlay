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

/**
 * Two renderer deaths closer together than this are a crash loop, not a
 * hiccup. One minute, per the 0.3.2 spec.
 */
const RENDERER_CRASH_WINDOW_MS = 60000;

/**
 * How many toasts may wait for a window that does not exist.
 *
 * Only the ones classified `keep` get here at all (see `sendUpdate`), and five
 * of them is already more than anybody reads at once; past that the oldest goes,
 * because the newest is the one that still means something.
 */
const TOAST_QUEUE_MAX = 5;

/**
 * Gap between two queued toasts on their way out.
 *
 * `src/js/status.js` is one element with one auto-hide timer, so sending them
 * back to back means only the last is ever read. 2.5 s is half the toast's own
 * life: each one is up long enough to read, and five of them drain in ten
 * seconds rather than in one frame.
 */
const TOAST_FLUSH_GAP_MS = 2500;

class MainWindow {

    window = null;
    obsWindow;
    overlayWindow;
    settings;
    mapLibrary;
    /** `Language`, for the one string main renders itself (the OS notification). */
    language = null;
    /** Version string of a downloaded-but-not-installed update, or null. */
    pendingUpdateVersion = null;
    /** Absolute path of the downloaded installer (`update-downloaded` gives it). */
    pendingInstallerPath = null;
    /** Set once the installer has been launched, so the banner cannot fire twice. */
    installStarted = false;
    /** The promise of an `installUpdate()` that has not settled yet, or null. */
    installInFlight = null;
    /**
     * Where the update check stands, for Settings › General → "Check for
     * updates now". One of `UPDATE_CHECK_STATES` in
     * `shared/update-message.js`, and the single source of "is a check in
     * flight" — the startup check moves it too, so the button is disabled
     * while that one runs.
     */
    updateCheckState = 'idle';
    /** The version that goes with `updateCheckState`, or null. */
    updateCheckVersion = null;
    /**
     * When that state last moved, including every `download-progress` tick.
     * The watchdog measures *silence*, not elapsed time, so a slow download
     * that is still progressing keeps resetting this and is never cut off.
     */
    updateCheckActivityAt = 0;
    /** The watchdog's timer, or null. One at a time. */
    updateCheckWatchdog = null;
    /** {mapDetector, tray} — set from index.js, both built after this class. */
    shutdownHooks = {};
    /** When the main window's renderer last died; see `render-process-gone`. */
    lastRendererGone = 0;
    /**
     * The last `map-change` written to app.log, so a slider drag (which
     * re-sends the same map once per pixel so main can recompute the rotated
     * bounding box) is one line rather than thirty.
     */
    lastLoggedMap = null;
    /**
     * Monotonic ticket for `applyMapChange`, which is async and re-entrant:
     * a held `next-map` starts one call per press while each is still reading a
     * PNG. The last caller wins; an older one that comes back late drops what
     * it was about to send rather than putting the previous map back.
     */
    mapChangeSeq = 0;
    /*
     * ─── The window is disposable (0.7) ─────────────────────────────────────
     *
     * The main window's renderer is ~32 MB of private working set doing nothing
     * while the app is in the tray mid-match (`docs/MEMORY-REPORT-2.md` §3.3).
     * Since the map state, the hotkeys and the detector's route to the overlay
     * all live in the main process now (`core/map-controller.js`), the window
     * can be destroyed and rebuilt. The decision is the pure
     * `shouldUnloadMainWindow`; what is below is only the bookkeeping.
     */
    /** Epoch ms the window was hidden, or 0 while it is on screen. */
    hiddenAt = 0;
    /** The pending teardown timer, or null. One at a time. */
    unloadTimer = null;
    /** True while there is no window *because we took it away*. */
    unloaded = false;
    /** Reasons the view says it must not be torn down (`window-busy`). */
    busyReasons = new Set();
    /** Has the update banner actually been in front of a person (focused)? */
    updateBannerShown = false;
    /** Has the user pressed "Later" on it? This session only, kept in main. */
    updateDismissed = false;
    /** `cleanStaleUpdateHelpers` + `checkUpdates` run on the first build only. */
    startupTasksDone = false;
    /** Toasts that arrived with no window and are worth keeping — see `sendUpdate`. */
    toastQueue = [];

    constructor(obsWindow, overlayWindow, settings, mapLibrary, language) {
        this.obsWindow = obsWindow;
        this.overlayWindow = overlayWindow;
        this.settings = settings;
        this.mapLibrary = mapLibrary;
        // Only needed for the native update notification, which main draws
        // itself; everything else goes to the renderer as {key, params}.
        this.language = language || null;

        ipcMain.on('obs-open', async () => {
            appLog.event('obs', {action: 'open'});
            obsWindow.show()
        });
        // The renderer can finish loading after `update-downloaded` fired (the
        // window is reopened from the tray, say), so it asks as well as listens.
        // `dismissed` travels with it because "Later" has to survive the window
        // being destroyed — it used to be a flag in the renderer, and the
        // banner came back on every reopen.
        ipcMain.handle('get-pending-update', async () => {
            if (!this.pendingUpdateVersion) return null;
            return {version: this.pendingUpdateVersion, dismissed: this.updateDismissed};
        });
        // "Later" on the banner. This session only — the pending version and
        // the tray's "Restart and update" item both stay.
        ipcMain.on('update-banner-dismissed', () => {
            this.updateDismissed = true;
            // A dismissed banner is no longer a reason to keep the window.
            this.updateBannerShown = true;
            this.scheduleUnload('banner-dismissed');
        });
        ipcMain.handle('install-update', async () => {
            return this.installUpdate();
        });
        // Settings › General → "Check for updates now". `handle`, not `on`:
        // the button stays disabled until this answers, the same as the map
        // packs' button next to it.
        ipcMain.handle('check-for-updates-now', async () => this.checkForUpdatesNow());
        // The Settings window can be opened in the middle of the startup check
        // (or after it), so it asks as well as listens — otherwise the button
        // would look idle while a check was running. It also re-checks for a
        // stall first, so opening Settings is one more way out of a download
        // that died without an `error` event.
        ipcMain.handle('get-update-check-state', async () => {
            this.resolveStalledUpdateCheck();
            return this.updateCheckStatus();
        });
        // Settings › General → "Open log folder". userData holds
        // `detector.log` (and its one `.1` backup), which is what a field
        // report about the detector is built from. `openPath` on the folder,
        // never on the file: opening the log in whatever is registered for
        // `.log` is a surprise, a file manager is not.
        ipcMain.handle('open-log-folder', async () => {
            const dir = app.getPath('userData');
            const error = await shell.openPath(dir);
            if (error) console.error('Could not open the log folder:', error);
            return {ok: !error, path: dir};
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
                // The OS label ("DELL U2720Q") is a device name and is never
                // translated. When there is none the renderer builds one with
                // `t()` — main has no business composing UI text it cannot
                // re-render when the language changes.
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
        // The **settings preview** is the only thing that still reaches this
        // channel from a renderer: it is canvas-rendered in the main window and
        // arrives as raw base64, so it cannot be a catalogue key. Everything
        // else goes through `MapController`, which calls `applyMapChange`
        // directly — the very same function — so there is one implementation of
        // "put a map on the overlay" and it does not need a renderer alive.
        ipcMain.on('map-change', (event, map, opts = {}) => {
            // Caught rather than awaited: an `unhandledRejection` in an IPC
            // handler ends the session with a crash file since 0.3.2.
            Promise.resolve(this.applyMapChange(map, opts)).catch(err => {
                console.error('map-change failed:', err && err.message);
                appLog.error('map-change', {message: (err && err.message) || String(err)});
            });
        });
        // The view reporting that it must not be torn down right now (the
        // Settings modal, the welcome tour, a diagnostic report, an import).
        // See `shared/window-unload.js`.
        ipcMain.on('window-busy', (event, info) => {
            const reason = info && typeof info.reason === 'string' ? info.reason : '';
            if (!reason) return;
            if (info.on === false) this.busyReasons.delete(reason);
            else this.busyReasons.add(reason);
            this.scheduleUnload('busy-changed');
        });
        // The update banner has actually been on screen in a *visible* window.
        // Until then the window is not torn down, so the banner cannot be
        // missed — see `shouldUnloadMainWindow`.
        ipcMain.on('update-banner-shown', () => {
            this.updateBannerShown = true;
            this.scheduleUnload('banner-shown');
        });
    }

    /**
     * Put a map on the overlay and the OBS window, or hide them (`map` empty).
     *
     * The single implementation, called both by `MapController` (a hotkey, the
     * detector, the CLI, a gallery click) and by the `map-change` IPC the
     * settings preview still uses. It touches `this.overlayWindow` and
     * `this.obsWindow`, never `this.window` — which is what lets the main
     * window be destroyed mid-match.
     *
     * **It is async and it can be called again before it finishes** — Ctrl+Alt+→
     * held down is one call per 150 ms while each one is reading a PNG off
     * disk. A sequence token makes the last caller win: an older call that
     * comes back after a newer one has already sized and sent the overlay drops
     * everything it was about to do rather than putting the previous map back.
     * Without it, `next-map` pressed quickly could leave the overlay one map
     * behind the state that says what is on it.
     *
     * @param {string} map a catalogue key, a custom-map file name, or raw
     *   base64. `{preview: true}` forces the base64 path and keeps the image
     *   off the OBS window so it can never leak into a stream.
     * @param {{source?: string, mapLabel?: string, preview?: boolean}} [opts]
     * @returns {Promise<boolean>} whether this call actually reached the
     *   overlay. `false` means it was superseded or the image could not be
     *   read — `MapController` rolls its state back on a `false`, so the
     *   gallery, the detector's `shownKey` and the overlay cannot disagree.
     */
    async applyMapChange(map, opts = {}) {
        // The three locals the body below reads. They used to be the
        // constructor's closure variables; keeping the names (and the block, so
        // the body is not re-indented) is what makes the move from the IPC
        // handler to a method a reviewable diff rather than a rewrite.
        const settings = this.settings;
        const overlayWindow = this.overlayWindow;
        const obsWindow = this.obsWindow;
        const ticket = ++this.mapChangeSeq;
        /** Has a later call overtaken this one while it was awaiting? */
        const superseded = () => this.mapChangeSeq !== ticket;
        {
            if (!map) {
                this.logMapChange('', opts.source || 'hide');
                overlayWindow.send('map-hide');
                if (!opts.preview) obsWindow.send('map-hide');
                return true;
            }

            let imgData;
            // The map's own name, for the `always` label mode. Empty for raw
            // base64 payloads, which have no name to show.
            let resolvedName = '';
            // …and the entry itself, which the markers need for its key. Kept
            // out here rather than inside the branch below because the marker
            // payload is built after the image has been measured, and null is
            // the right answer for a preview or a raw base64 payload: neither
            // is a catalogue map, so neither has markers.
            let resolvedEntry = null;
            if (opts.preview) {
                // The settings preview is rendered in the renderer and arrives
                // as raw base64 — never look it up in the catalogue.
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
                        // The catalogue said the file was there (`resolveEntry`
                        // checks) and it is not any more: deleted, on a drive
                        // that went away, locked by something else. Answer
                        // `false` so the caller can put its state back — a
                        // `currentKey` naming a map that is not on the overlay
                        // is what makes the gallery, the toggle and the menu
                        // clear all disagree with what the player can see.
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
                // A custom map's key is a name the user typed, so only shipped
                // keys are logged; a custom one is logged as the fact that it
                // was custom. See the "never log paths or user text" rule.
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
            // Markers ride on this payload too, and for the same reason: they
            // belong to one map, and a channel of their own would let the
            // overlay draw one map's cellars over another map's image.
            const markers = this.markerPayload(resolvedEntry, dimensions);
            const lang = this.language ? this.language.current() : 'en';

            // Window fits the rotated bounding box so arbitrary angles don't clip
            const displayWidth = parseInt(settings.get('size'));
            const rotated = rotatedSize({
                width: displayWidth,
                height: (displayWidth / dimensions.width) * dimensions.height,
                rotation: settings.get('rotation')
            });
            // A marker on the edge of the map reaches a few pixels past it, and
            // `body { overflow: hidden }` plus the window's own edge clip
            // whatever sticks out. The window already carries +5 px of width
            // and 10 % of height of slack, which is less than a marker's reach
            // at larger sizes — so the reach is added when, and only when,
            // there are markers to draw. Nothing changes for a user with
            // markers switched off, or for a map that has none.
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
            // `mapLabel` rides along on the existing payload rather than being
            // a second IPC message, so the overlay can never show a name for a
            // map it is not displaying.
            //
            // `auto` (the original behaviour) shows a name only when the caller
            // supplies one, which only an automatic detector switch does, and
            // the overlay clears it again after a few seconds. `always` names
            // whatever is on screen — the caller's label if it sent one, the
            // resolved map name otherwise — and the overlay keeps it up. The
            // settings preview carries a label of its own so `always` can be
            // seen in the Overlay tab; in `auto` it is suppressed, because the
            // preview is not a map switch the player needs telling about.
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
            // The settings preview stays off the OBS window -- it must never leak into a stream
            if (!opts.preview) obsWindow.send('map-change', Buffer.from(imgData).toString("base64"), settings.get('size'), mapLabel, labelMode, markers, lang);
            return true;
        }
    }

    /**
     * Where markers come from. Injected rather than a constructor argument:
     * `MapMarkers` owns an IPC handler, so it is built beside the other core
     * modules in `index.js`, and adding a sixth constructor parameter here
     * would touch a signature three other modules pass through.
     * @param {?Object} mapMarkers
     */
    setMapMarkers(mapMarkers) {
        this.mapMarkers = mapMarkers && typeof mapMarkers.markers === 'function' ? mapMarkers : null;
    }

    /**
     * The marker layer for one map, as the overlay and OBS windows draw it.
     *
     * Returns null — i.e. "draw nothing" — for a raw base64 payload and for the
     * settings preview (neither is a catalogue map, so neither has markers), for
     * a map with no marker data, and whenever the master switch or every layer
     * is off. The decision itself is the pure `drawableLayers`; this only reads
     * the settings and the image size.
     *
     * `surface: 'overlay'` is what drops the layers the map image already draws
     * — on the four bundled maps the cellar, gate and car rings are part of the
     * PNG, so only the gas cans are added here. The Tab window asks for the same
     * map with `surface: 'tab'` and gets all four, because the game's own map
     * has none of them on it.
     *
     * @param {?Object} entry the catalogue entry, or null
     * @param {{width: number, height: number}} dimensions the image's own size
     * @returns {?{layers: Array, legend: boolean, opacity: number,
     *             imageWidth: number, imageHeight: number}}
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
     * Reload the main window after its renderer died — **never from inside the
     * `render-process-gone` handler**.
     *
     * Navigating while Chromium is still tearing the dead RenderFrameHost down
     * takes the *whole app* with it: on Electron 40.10.6 a synchronous
     * `reload()` in that handler killed the browser, GPU, utility and even the
     * untouched overlay renderer within ~6 s, with a `STATUS_BREAKPOINT`
     * (0x80000003 — a Chromium `CHECK`) exit code and no chance for the queued
     * log line to reach disk. Reproduced 4/4 on packaged builds. It is
     * Electron issue #19887 ("App crash after render process crash"), and the
     * fix in PR #53924 is exactly this: post the navigation after the teardown.
     *
     * So: one tick later, out of the callback, and only if the window is still
     * there. 100 ms is not a magic number — anything that leaves the current
     * stack works — but it is comfortably past the teardown and invisible to a
     * person watching the window come back.
     *
     * This is also why 0.3.1's behaviour (no handler at all → dead window,
     * living app) must not be *worse* after adding recovery: the overlay has
     * to survive, because the player is mid-match.
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

    /** One log line per *distinct* map change. See `lastLoggedMap`. */
    logMapChange(key, source) {
        if (this.lastLoggedMap && this.lastLoggedMap.key === key && this.lastLoggedMap.source === source) return;
        this.lastLoggedMap = {key, source};
        appLog.event('map-change', {key, source});
    }

    /**
     * Show the window, building it first if there is none.
     *
     * Since 0.7 the "there is none" branch is not only the first start: the
     * window is torn down while it sits in the tray (`unload`), so this is also
     * the way back from that. `reason` is for the `main-window state=loaded`
     * log line the owner's field test reads.
     *
     * **Everything that rebuilds this window is a user action** — a tray click,
     * the tray's Show item, a second launch. Nothing in the app rebuilds it on
     * its own: a window the user did not ask for either costs a renderer build
     * in the middle of a match for nothing, or steals the foreground from the
     * game. Anything that needs to reach the user when there is no window is
     * either pulled on the next load (`get-pending-update`, `get-crash-notice`,
     * `get-hotkey-notice`, `get-hotkey-conflicts`), carried by the tray menu,
     * or queued with `sendUpdate(…, {keep: true})`.
     *
     * @param {string} [reason] what asked for the window ('startup',
     *   'tray-click', 'tray-menu', 'second-instance')
     * @param {{show?: boolean}} [opts] `show: false` builds it hidden. Nothing
     *   uses it today; see the note above before it grows a caller.
     */
    show(reason, opts = {}) {
        const reveal = opts.show !== false;
        if (this.window) {
            if (!this.window.isDestroyed()) {
                // Cancel a teardown that is already pending: the user is using
                // the window again.
                this.cancelUnload();
                if (reveal) this.window.show();
                return
            }
            this.window = null;
        }
        // **Never build a window on the way out.** A second instance launched
        // (or an `update-downloaded` landing) during `finishInstall`'s deferred
        // quit would otherwise construct a whole renderer while the installer
        // is being handed control — and `app.quit()` would then have a fresh
        // window to close. Nothing that could want a window at this point is
        // going to be around to look at it.
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
            // **The guard that makes unloading safe.** Closing the main window
            // is how the app shuts down — it takes the overlay and the OBS
            // window with it — but *our own* teardown must not: the player is
            // mid-match and the overlay is the whole product.
            //
            // The flag lives on **this window object**, not on `this`, and that
            // is deliberate: Electron does not promise that `closed` is emitted
            // synchronously from `destroy()`, so a flag cleared in `unload`'s
            // `finally` could already be false by the time this runs — and the
            // overlay would go down in the middle of a match. A property on the
            // window the flag is *about* cannot be wrong.
            if (window.__hmoUnloading) return;
            // A real close **is** the app shutting down, and it has to say so
            // rather than leaving it to `window-all-closed`.
            //
            // That event only fires when *every* BrowserWindow is gone, and
            // since 0.7 there can be a third one: `TabOverlayWindow` is lazy,
            // kept hidden between Tab presses and closed by nobody here. With
            // `minimizeToTray` off (the default) and Tab-map mode on, clicking
            // X closed the overlay and the OBS window, left the Tab window
            // alive, and `window-all-closed` never fired — so the process stayed
            // resident with the detector, the hotkeys and the key trigger all
            // running behind a **dead** overlay (`OverlayWindow.close()` nulls
            // its window and only `createWindow()` ever calls `show()`), and
            // Tray › Show rebuilt a main window that could never put a map
            // anywhere. Shutting down explicitly is the fix; `runShutdownHooks`
            // already takes the overlay, the Tab window, the detector and the
            // tray with it, in that order.
            app.isQuiting = true;
            this.runShutdownHooks();
            obsWindow.close()
            app.quit();
        })
        // Hidden to the tray, or shown again. The teardown hangs off these two
        // rather than off the `hide()`/`minimize` handlers, so it also covers
        // the tray icon's own click toggle.
        this.window.on('hide', () => {
            this.hiddenAt = Date.now();
            this.scheduleUnload('hidden');
        });
        this.window.on('show', () => {
            this.hiddenAt = 0;
            this.cancelUnload();
            // A queued toast is only worth delivering to a window somebody is
            // looking at — see `flushToastQueue`.
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

        // A renderer crash is otherwise completely silent from the terminal —
        // and from the user, who sees a window that stopped responding to
        // clicks and no error anywhere.
        //
        // Policy (0.3.2): reload once and carry on, because a single renderer
        // death is usually a GPU hiccup and reloading restores a working window
        // in under a second. A *second* death within a minute is not a hiccup:
        // reloading again would loop, so it becomes a crash file and a quit,
        // which at least leaves evidence and a clean state to start from.
        // Every load of this window starts with a renderer that has reported
        // nothing yet, so whatever the *previous* one was busy with is gone:
        // a crash reload, an F5 in dev, or the navigation that follows a
        // `render-process-gone`. Without this a renderer that died with the
        // Settings modal open left `settings` in the set forever and the
        // window could never be unloaded again.
        this.window.webContents.on('did-start-loading', () => {
            if (this.busyReasons.size) {
                appLog.event('window-busy', {cleared: Array.from(this.busyReasons).join(',')});
                this.busyReasons.clear();
            }
            this.scheduleUnload('reload');
        });
        this.window.webContents.on('render-process-gone', (event, details) => {
            // A window we are deliberately destroying is not a crash. Without
            // this, two ordinary tray unloads 46 s apart would look like "the
            // main window died twice in 60 s" and take the whole app down
            // mid-match — the exact opposite of what that policy is for.
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
            // Straight to disk, synchronously, before anything else is
            // attempted. This handler is rare, the append is one small write,
            // and the whole point of the line is that it survives whatever
            // happens next — the buffered 500 ms batch would not.
            appLog.flush();
            // `clean-exit` is the window being closed normally on some
            // platforms; there is nothing to recover from.
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
        // Every child process that dies, not just the renderer: a GPU process
        // that keeps dying is what a "the overlay flickers" report looks like
        // from the inside. Bound once — `show()` runs again every time the
        // window is reopened from the tray.
        //
        // `clean-exit` is skipped: a utility process finishing normally is not
        // an incident, and logging it at error level would teach a reader to
        // ignore the level.
        if (!MainWindow._childGoneBound) {
            MainWindow._childGoneBound = true;
            app.on('child-process-gone', (event, details) => {
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

        // **Once per process, not once per window.** Up to 0.6 this ran only on
        // the first `show()` anyway, because a reopen from the tray took the
        // early return above. Now that the window is rebuilt after every tray
        // unload, running it again would mean one GitHub request every time the
        // user opens the window — a change to the app's outside contact, which
        // the README and the FAQ both describe as "once at startup".
        if (!this.startupTasksDone) {
            this.startupTasksDone = true;
            this.cleanStaleUpdateHelpers()
            this.checkUpdates()
        }
        // Anything important that arrived while there was no window.
        this.flushToastQueue();
        // A window built **hidden** (the update banner) never fires `show` or
        // `hide`, so nothing else would ever ask whether it may go again.
        if (!reveal) this.scheduleUnload('created-hidden');
    }

    /*
     * ─── Tearing the window down while it is in the tray ────────────────────
     */

    /**
     * Ask (or re-ask) whether the window may go, and arm the timer accordingly.
     *
     * Called from every input the decision depends on: the window being hidden
     * or shown, the view reporting busy/idle, the update banner being seen, and
     * the timer itself. The decision is the pure `shouldUnloadMainWindow`; this
     * only owns the one timer.
     *
     * @param {string} trigger which input changed — DEBUG only, the log line
     *   carries the verdict's own reason instead.
     */
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
        // Never a reason to hold the process open: a window that has not been
        // torn down yet is not work anybody is waiting for.
        if (typeof this.unloadTimer.unref === 'function') this.unloadTimer.unref();
    }

    cancelUnload() {
        if (this.unloadTimer === null) return;
        clearTimeout(this.unloadTimer);
        this.unloadTimer = null;
    }

    /** `{unload, reason, waitMs}` — the pure decision, with today's inputs. */
    unloadVerdict() {
        let visible = false;
        let minimized = false;
        const hasWindow = !!(this.window && !this.window.isDestroyed());
        if (hasWindow) {
            try {
                visible = this.window.isVisible();
                minimized = this.window.isMinimized();
            } catch (err) {
                // A window that cannot answer is a window not worth destroying.
                visible = true;
            }
        }
        const hotkeys = this.shutdownHooks && this.shutdownHooks.hotkeys;
        return shouldUnloadMainWindow({
            setting: this.settings ? this.settings.get('unloadWindowInTray') : undefined,
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
     * Destroy the window. The overlay, the OBS window, the detector, the
     * hotkeys and the map state are all untouched — that is the whole point.
     *
     * `destroy()` rather than `close()`: `close()` goes through the `close`
     * handler, which is the one that hides instead of closing whenever
     * minimize-to-tray is on, so it would do nothing at all.
     */
    unload(reason) {
        const hiddenMs = this.hiddenAt ? Date.now() - this.hiddenAt : 0;
        const win = this.window;
        if (!win || win.isDestroyed()) return;
        // Set on the window itself, and never cleared: this window is going
        // away, and its `closed` handler must skip the overlay teardown
        // whenever that handler happens to run. See the handler in `show()`.
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

    /** For `system.txt`: is the window there, and is the setting on? */
    unloadState() {
        return {
            setting: !(this.settings && this.settings.get('unloadWindowInTray') === false),
            loaded: !!(this.window && !this.window.isDestroyed()),
            unloaded: this.unloaded,
            busy: Array.from(this.busyReasons)
        };
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
        // docs/agents/updater-and-installer.md both promise the portable build
        // does not self-update.
        // electron-builder's portable launcher always sets this variable.
        if (process.env.PORTABLE_EXECUTABLE_DIR) {
            console.log('Update check skipped: portable build.');
            return;
        }
        if (this.settings && this.settings.get('checkForUpdates') === false) {
            console.log('Update check skipped: disabled in settings.');
            return;
        }

        // `show()` runs again on every reopen from the tray, so this is not
        // only the startup path: a check that is in flight, or an update that
        // is already downloaded and waiting for the banner, is left alone.
        // electron-updater would dedupe the network work, but the state (and
        // with it the button and the line in Settings) would flicker.
        if (isUpdateCheckOccupied(this.resolveStalledUpdateCheck())) {
            console.log('Update check skipped: one is already in flight.');
            return;
        }

        this.prepareUpdater();

        setTimeout(() => {
            // Re-asked after the wait: 4 s is long enough for the button in
            // Settings to have started a check of its own.
            if (isUpdateCheckOccupied(this.resolveStalledUpdateCheck())) return;
            // The default notification text promises an install on exit, which
            // is exactly what this no longer does — say what really happens.
            // This one *is* translated in main: it is a native OS notification,
            // not something a renderer draws. `{appName}` and `{version}` are
            // electron-updater's own placeholders and survive `t()` untouched,
            // because a placeholder with no matching parameter is left alone.
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
     * Pin electron-updater's flags and bind its events — **once**, whatever
     * starts the check.
     *
     * Two callers: the startup check and the "Check for updates now" button.
     * The button is allowed to run with the startup switch off, so it cannot
     * rely on `checkUpdates()` having got this far; and pressing it ten times
     * must not leave ten listeners behind, which is what `_updaterBound`
     * (already there for `show()` running again after a tray reopen) prevents.
     */
    prepareUpdater() {
        // Download in the background, but install only when the user asks.
        // The 0.1.0 → 0.2.0 update ran electron-updater's default quit handler
        // and the NSIS installer froze the machine for several seconds at the
        // exact moment the user closed the app, possibly mid-game. Both flags
        // are set explicitly so the behaviour does not depend on a library
        // default; `installUpdate()` is now the one and only installer trigger.
        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = false;
        // With a non-silent install this, not quitAndInstall's second argument,
        // is what relaunches the app. Default is already true; pinned so a
        // library default cannot quietly strand the user on a closed app.
        autoUpdater.autoRunAppAfterInstall = true;

        const self = this;
        // show() runs again when the window is reopened from the tray
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
            // `autoDownload` is on, so this is also the start of the download:
            // the button stays disabled until `update-downloaded` or `error`.
            self.setUpdateCheckState('found', version);
        });
        autoUpdater.on('update-not-available', () => {
            appLog.event('update', {state: 'up-to-date'});
            self.sendUpdate(msg('update.upToDate'));
            // The version to name here is the one that is running, not
            // anything off the feed: "you are on the latest version (X)".
            self.setUpdateCheckState('upToDate', MainWindow.appVersion());
        });
        autoUpdater.on('download-progress', (p) => {
            self.sendUpdate(msg('update.downloading', {percent: Math.round(p.percent || 0)}));
            // The one liveness signal a long download has. It does not change
            // the state — it proves the state is still true, which is what
            // keeps the watchdog off a download that is merely slow.
            self.noteUpdateCheckActivity();
        });
        autoUpdater.on('update-downloaded', (info) => {
            const version = info && info.version ? String(info.version) : '';
            appLog.event('update', {state: 'downloaded', version});
            self.pendingUpdateVersion = version || null;
            // `UpdateDownloadedEvent.downloadedFile` (electron-updater
            // out/types.d.ts) is the absolute path of the .exe just written
            // to the update cache. We run it ourselves — see installUpdate().
            self.pendingInstallerPath = (info && typeof info.downloadedFile === 'string')
                ? info.downloadedFile : null;
            self.sendUpdate(msg('update.downloaded'));
            self.setUpdateCheckState('downloaded', version);
            // The banner is the persistent element (the toast auto-hides) and
            // it is the one thing the user has to act on. It is **not** a
            // reason to build a window: the renderer pulls `get-pending-update`
            // on every load, so the banner comes up by itself whenever the
            // window next exists, and the tray grows its "Restart and update"
            // item either way. Rebuilding the window hidden was tried and is
            // worse than useless — a window built with the default
            // `paintWhenInitiallyHidden` reports `document.visibilityState ===
            // 'visible'` on its first load, so it would answer
            // `update-banner-shown` from a window nobody had seen and then be
            // torn down again 45 s later, having cost a renderer build
            // mid-match for nothing.
            //
            // Both flags reset: a *newly* downloaded version is news even if
            // the user said "Later" to the previous one, and an existing window
            // has to put the banner in front of them before it may be unloaded
            // again.
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
            // An update error is the one network failure a user can see, so
            // it is logged rather than only toasted — "it said update
            // failed" is otherwise unanswerable.
            appLog.error('update', {state: 'error', message: (err && err.message) || String(err)});
            self.sendUpdate(msg('update.checkFailed'));
            // The message stays in the log; what the user is shown is one
            // sentence from `shared/update-message.js` — never the error
            // object and never a path.
            self.setUpdateCheckState('failed');
        });
    }

    /**
     * This app's version. `app.getVersion()` can answer with Electron's own
     * (40.x) when running from `npm start`, which is why the `version` IPC
     * handler reads package.json too.
     */
    static appVersion() {
        try {
            return require('../../package.json').version || '';
        } catch (err) {
            return '';
        }
    }

    /** `{state, version}` — what Settings shows beside the button. */
    updateCheckStatus() {
        return {state: this.updateCheckState, version: this.updateCheckVersion};
    }

    /**
     * Record where the check stands and push it to the window. The renderer
     * turns it into a button state and a sentence with `manualCheckView()`;
     * nothing English travels.
     */
    setUpdateCheckState(state, version) {
        this.updateCheckState = state;
        this.updateCheckVersion = version ? String(version) : null;
        this.noteUpdateCheckActivity();
        this.send('update-check-state', this.updateCheckStatus());
    }

    /**
     * "The check is still alive." Every state change and every
     * `download-progress` tick says so, and the watchdog is re-armed from here
     * — a busy state with no watchdog is exactly the bug this prevents.
     */
    noteUpdateCheckActivity() {
        this.updateCheckActivityAt = Date.now();
        this.armUpdateCheckWatchdog();
    }

    /**
     * Arm (or disarm) the stall watchdog from the pure `updateCheckStall()`,
     * which also owns the two thresholds. Not busy → no timer at all.
     */
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
        // Never a reason to hold the process open: quitting mid-download is a
        // perfectly good answer to a stalled download.
        if (typeof this.updateCheckWatchdog.unref === 'function') this.updateCheckWatchdog.unref();
    }

    /**
     * If the check or its download has gone silent for too long, call it
     * failed and give the button back; otherwise leave it exactly as it is.
     *
     * Called by the watchdog timer, and again by anything about to *act* on
     * the state (both check paths), so a timer that never ran — a laptop that
     * was suspended, say — cannot strand the button either.
     *
     * @returns {string} the state after this, so a caller can test it directly.
     */
    resolveStalledUpdateCheck() {
        const verdict = updateCheckStall({
            state: this.updateCheckState,
            lastActivityAt: this.updateCheckActivityAt,
            now: Date.now()
        });
        if (!verdict.stalled) return this.updateCheckState;
        // Not a cancellation: electron-updater is left alone, and if the
        // download does come back to life `update-downloaded` still fires and
        // still raises the banner. All this does is stop claiming that
        // something is in progress when nothing has moved for minutes.
        appLog.error('update', {state: 'stalled', from: this.updateCheckState});
        this.sendUpdate(msg('update.checkFailed'));
        this.setUpdateCheckState('failed');
        return this.updateCheckState;
    }

    /**
     * Settings › General → "Check for updates now".
     *
     * The startup check only runs at startup, so an app left open for a week
     * never hears about a release. This asks on demand, and deliberately does
     * **not** consult the `checkForUpdates` setting: the switch governs the
     * automatic check, and pressing the button is the user asking for this one
     * (the help text says so). It does not change the switch.
     *
     * Everything else about it — dev build, portable build, a check already in
     * flight — is decided by the pure `planManualUpdateCheck()`.
     *
     * @returns {{state: string, version: ?string}} the same shape the
     *   `update-check-state` push carries.
     */
    async checkForUpdatesNow() {
        const plan = planManualUpdateCheck({
            packaged: app.isPackaged,
            // electron-builder's portable launcher always sets this.
            portable: !!process.env.PORTABLE_EXECUTABLE_DIR,
            // Stall check first: a click is the most likely way a user reports
            // a download that died silently, and answering "already running"
            // to the person trying to recover from it would be the worst
            // possible reply.
            state: this.resolveStalledUpdateCheck()
        });
        // No URL, no path: just what the user pressed and what they were told.
        appLog.event('update', {state: 'manual-check', result: plan.state});
        if (!plan.start) {
            // `busy`/`devBuild`/`portableBuild` are answers to this click, not
            // where the check itself stands, so they are returned without
            // overwriting `updateCheckState` — the startup check that is still
            // running has to stay visible to the next caller.
            return {state: plan.state, version: this.updateCheckVersion};
        }
        this.prepareUpdater();
        // Set before the call: `checking-for-update` may fire first, and the
        // button has to be disabled either way.
        this.setUpdateCheckState('checking');
        try {
            const result = await autoUpdater.checkForUpdates();
            // The check has answered, so `checking` is no longer true. It can
            // still be the state here: `checkForUpdates()` resolves with
            // `null` when electron-updater decides not to run at all, and then
            // neither `update-available` nor `update-not-available` ever fires.
            // A definite answer is owed either way, and it is **not** "you are
            // on the latest version" — nothing here has evidence for that.
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
            // The `error` event usually fires as well and says the same thing;
            // both land on `failed`, which is idempotent.
            console.error('Update check failed:', err && err.message);
            appLog.error('update', {state: 'error', message: (err && err.message) || String(err)});
            this.setUpdateCheckState('failed');
        }
        return this.updateCheckStatus();
    }

    /**
     * References to modules built after this one (`index.js` wires them), so
     * the install can shut the app down cleanly and the tray can grow its
     * "Restart and update" item.
     */
    setShutdownHooks(hooks) {
        this.shutdownHooks = hooks || {};
    }

    /** Stop the detector and drop the tray icon before the app goes away. */
    runShutdownHooks() {
        const {mapDetector, tray, tabMode} = this.shutdownHooks || {};
        // Overlay first: it is the always-on-top, click-through window, and it
        // must be gone before anything slow runs so the desktop stays responsive.
        try {
            if (this.overlayWindow && typeof this.overlayWindow.close === 'function') this.overlayWindow.close();
        } catch (err) {
            console.error('Overlay close failed during shutdown:', err && err.message);
        }
        // The second always-on-top window, for exactly the same reason.
        try {
            if (tabMode && typeof tabMode.destroy === 'function') tabMode.destroy();
        } catch (err) {
            console.error('Tab markers close failed during shutdown:', err && err.message);
        }
        try {
            // `destroy()` rather than `stop()`: since 0.7 the detector owns a
            // utility process, and a child still holding a native capture
            // module while the installer replaces the app directory is exactly
            // the shape that has caused trouble on this machine before.
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
     * Launch the downloaded NSIS installer at **idle** process priority.
     *
     * electron-updater would run it at normal priority
     * (`NsisUpdater.doInstall` → `spawnLog(installerPath, args)`), and
     * unpacking ~350 MB (7z to temp, then a copy into the install dir, with
     * Defender reading every file) saturates the disk hard enough to make the
     * mouse cursor stutter for several seconds. Windows derives the I/O
     * priority from the process priority class, so running the installer at
     * IDLE_PRIORITY_CLASS is what actually keeps the desktop responsive; it is
     * not a CPU trick.
     *
     * `cmd.exe /c start "" /LOW /B <installer> --updated --force-run`:
     * - `start /LOW` is the only way to set another process's priority class at
     *   creation time from Node — `child_process.spawn` has no priority option,
     *   and `os.setPriority` can only be applied *after* the process exists (it
     *   is still called below on whatever pid we get, as a cheap extra).
     * - `""` is the window title `start` always consumes first; without it the
     *   quoted installer path would be eaten as the title.
     * - `/B` only suppresses a new *console*; a GUI app still shows its window,
     *   so the installer's progress dialog appears exactly as before (verified
     *   with `start "" /LOW /B notepad.exe`).
     * - `windowsVerbatimArguments` keeps our own quoting, which is what makes a
     *   path with spaces (`...\Halloween Map Overlay Setup 0.2.3.exe`) work.
     * - The args mirror `NsisUpdater.doInstall` for a non-silent force-run
     *   install: `--updated`, `--force-run`, no `/S`. `/D=` and
     *   `--package-file=` are only added there for a custom install directory
     *   or a web installer, neither of which this build uses.
     *
     * The relaunched app does **not** inherit idle priority: the NSIS template
     * restarts it with `${StdUtils.ExecShellAsUser}` (`templates/nsis/common.nsh`
     * `StartApp`), i.e. through the shell, not as a child of the installer.
     *
     * @returns {boolean} true if the installer was started.
     */
    spawnInstallerAtLowPriority() {
        if (process.platform !== 'win32') {
            // `start /LOW` is a cmd.exe builtin. Everywhere else electron-updater
            // is not running an NSIS installer either — let it do its own thing.
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
        // `spawn` reports a failed launch asynchronously; an 'error' event with
        // no listener is an uncaught exception, and by then we are already
        // quitting, so there is nothing left to fall back to but a log line.
        child.on('error', (err) => {
            console.error('Installer launcher failed:', err && err.message);
        });
        // Belt and braces: this is almost certainly the short-lived cmd.exe
        // rather than the installer, and `start /LOW` has already done the real
        // work, but it costs nothing if the pid ever is the installer's.
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
     * electron-updater's cache directory — where the downloaded installer sits
     * and, since 0.5.0, where the helper's working copy goes.
     *
     * Asked of the library first, because the library is the authority. Before
     * any download there is no `downloadedUpdateHelper` yet, so the startup
     * sweep falls back to `app-update.yml`'s `updaterCacheDirName`, which is
     * exactly the value electron-updater would have used.
     *
     * @returns {?string}
     */
    updaterCacheDir() {
        const helper = autoUpdater.downloadedUpdateHelper;
        if (helper && helper.cacheDir) return helper.cacheDir;
        let cacheDirName = null;
        try {
            cacheDirName = updateHelper.updaterCacheDirName(
                fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf-8'));
        } catch (err) {
            // Not a packaged build, or an old app-update.yml. The appName
            // branch below is electron-updater's own fallback for that.
        }
        return updateHelper.helperHome({
            localAppData: process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
            cacheDirName,
            appName: app.getName()
        });
    }

    /**
     * Sweep helper copies a previous update left in the updater cache.
     *
     * They only survive a helper that was killed (an antivirus, a power cut)
     * and they are ~600 KB each, so this is housekeeping rather than a
     * guarantee — it runs once per window creation, never throws, and skips the
     * builds that have no updater at all.
     */
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
     * Where the helper window goes: exactly over the app's own window, in
     * **physical** pixels.
     *
     * Two details that are both load-bearing:
     *
     * - **`getContentBounds()`, not `getBounds()`.** The main window has a
     *   native frame, so its outer rectangle is ~32 px taller than the web
     *   page. The renderer's "updating" view is centred in the *content* area;
     *   a helper centred in the outer rectangle would draw the same picture
     *   about sixteen pixels lower, and the hand-over would jump. Covering the
     *   content area instead leaves the title bar showing for the fraction of a
     *   second before the app quits, which nobody notices — a jumping icon is.
     * - **Physical pixels.** `getContentBounds()` is in DIPs and the helper is
     *   a per-monitor-DPI-aware Win32 process that places itself with
     *   `SetWindowPos`, so the conversion has to happen here; on a 150 %
     *   display the two numbers differ by half again.
     *
     * A window hidden in the tray has nothing to cover, so the helper centres
     * itself on the primary display instead (`helperBounds`).
     */
    updaterPlacement() {
        const win = this.window;
        let rect = null;
        let activate = false;
        try {
            if (win && !win.isDestroyed() && win.isVisible()) {
                rect = screen.dipToScreenRect(win, win.getContentBounds());
                // Do not pull focus out of a fullscreen game: if the app window
                // was not the focused one, the helper shows without activating.
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
            // The helper lays out in DIPs at the *system* (primary) DPI, so
            // that is the scale its minimum size has to be multiplied by.
            scaleFactor = primary.scaleFactor || 1;
        } catch (err) {
            console.error('Could not read the primary display for the updater:', err && err.message);
        }
        return {bounds: updateHelper.helperBounds(rect, workArea, scaleFactor), activate};
    }

    /**
     * Tier 1: the themed helper window (`hmo-updater.exe`).
     *
     * Returns false for **every** failure, and a false here costs nothing: the
     * app has not quit yet and tier 2 is the path 0.4.0 already shipped. The
     * handshake is what buys that — `launchUpdater` only resolves `ok` once the
     * helper has written its ready-file, i.e. once there is a window on screen.
     *
     * @returns {Promise<boolean>}
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
                // NOT the OS temp directory. Bitdefender's Advanced Threat
                // Defense killed the entire launching process tree on this
                // machine when an unsigned NSIS installer was started from
                // under `%TEMP%`, and neutralised the installer file on its way
                // out. The updater cache is where electron-updater already
                // downloads and runs that same installer, so it is the location
                // with evidence behind it. See `helperHome()`.
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
            // The one line that explains a user's "it looked like the old
            // installer": which tier ran, and why the first one did not.
            appLog.error('update-helper', {ok: 'no', reason: result.reason || 'unknown', ms: Date.now() - started});
            return false;
        }
        appLog.event('update-helper', {ok: 'yes', pid: result.pid || 0, ms: Date.now() - started});
        return true;
    }

    /**
     * Shared tail of a successful install: stop being an app.
     *
     * The quit is deferred by one turn of the loop so the renderer's
     * `install-update` reply is actually flushed — it is what tells the
     * "updating" view whether to stay (themed helper coming) or get out of the
     * way (stock installer). Destroying the window first would drop the reply.
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
     * Run the downloaded installer and relaunch. The only caller-facing entry
     * point for installing an update: the home-page banner (`install-update`)
     * and the tray item.
     *
     * **Three tiers, each falling through to the next** (0.5.0; spec §5.1):
     *  1. `startThemedUpdater()` — `hmo-updater.exe` over the app's own window,
     *     running the installer silently (`/S`) so the stock NSIS banner never
     *     appears. It only counts as started once the helper has written its
     *     ready-file, so a blocked or missing helper costs nothing.
     *  2. `spawnInstallerAtLowPriority()` — what 0.2.3 through 0.4.0 shipped:
     *     the visible one-click installer at idle priority.
     *  3. `autoUpdater.quitAndInstall(false, true)` — normal priority. A
     *     stuttery update beats no update.
     *
     * The order is the only thing that changed. Tier 2 and tier 3 are
     * untouched, and **no user can end up stranded on an old version because of
     * tier 1**: the app has not quit when tier 1 gives up.
     *
     * `app.isQuiting` has to be set first or the main window's `close` handler
     * hides the window instead of letting it go whenever minimize-to-tray is
     * on, and `app.quit()` never completes.
     *
     * electron-updater is kept for the check and the download only; the install
     * itself is ours, so the unpack cannot starve the desktop of disk I/O.
     *
     * @returns {Promise<{ok: boolean, themed: boolean}>} the renderer's
     *   "updating" view stays up only while `themed` is true.
     *
     * Why the relaunch survives a non-silent install, traced through
     * electron-updater/electron-builder rather than assumed:
     * - `NsisUpdater.doInstall` spawns the installer with
     *   `["--updated", "--force-run"]` and no `/S`, so the UI shows. Our own
     *   spawn passes exactly those.
     * - `templates/nsis/installSection.nsh` relaunches under `ONE_CLICK` +
     *   `RUN_AFTER_FINISH` when `${ifNot} ${Silent}` **or** `${isForceRun}`;
     *   both hold here. The *assisted* branch (`oneClick: false`) starts the
     *   app only when `isForceRun` **and** `Silent`, so a visible install would
     *   not relaunch — which is why `nsis.oneClick` is now `true`.
     * - On the fallback path `BaseUpdater.quitAndInstall(isSilent,
     *   isForceRunAfter)` calls
     *   `install(isSilent, isSilent ? isForceRunAfter : this.autoRunAppAfterInstall)`,
     *   so with `isSilent = false` our `true` is ignored and
     *   `autoRunAppAfterInstall` (pinned in `checkUpdates()`) decides.
     */
    installUpdate() {
        // One run at a time. `installStarted` is only set once a tier has
        // actually started, and tier 1 awaits the helper's handshake for up to
        // 4 s — without this, the banner button and the tray item pressed
        // inside that window each copied and spawned their own helper, and two
        // helpers mean two silent installers racing over one install dir.
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
        // The window shows its own full-window "updating" view *now*, so the
        // helper opens on top of an identical picture. Pushed from here rather
        // than from the banner's click handler, because the tray item is the
        // other way in and it must look the same.
        this.send('update-installing', {version});

        // Tier 1 — the themed helper. It can only return true once there is a
        // window on screen, so nothing below has been lost by trying.
        try {
            if (await this.startThemedUpdater(version)) {
                this.finishInstall(version, 'themed');
                return {ok: true, themed: true};
            }
        } catch (err) {
            console.error('Themed updater failed:', err && err.message);
            appLog.error('update-helper', {ok: 'no', reason: 'threw', message: (err && err.message) || String(err)});
        }
        // A second click cannot arrive while the await above is pending (the
        // banner button disables itself), but the tray item can — and by now
        // the pending state may have changed under us.
        if (this.installStarted) return {ok: true, themed: true};

        // Tier 2 — the stock installer at idle priority (0.2.3 behaviour).
        try {
            if (this.spawnInstallerAtLowPriority()) {
                // The stock installer draws its own window (build/installer.nsh),
                // so the app's "updating" view has to get out of the way.
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
            // `keep`: an install can be started from the tray item with no
            // window at all, and "the update did not install" is the one
            // update message the user has to act on.
            this.sendUpdate(msg('update.installFailed'), {keep: true});
            return {ok: false, themed: false};
        }
    }

    /**
     * Short status line shown in the bottom-right toast of the main window.
     *
     * With no window (hidden in the tray and torn down, see `unload`) the
     * message is either **dropped** or **queued**, and that is a decision per
     * message class rather than a default — `docs/SPEC-MAP-STATE.md` §6 is the
     * table:
     *
     * - **Dropped** (`keep` absent): everything that describes something the
     *   user just did or is being told twice — "Markers on", the opacity and
     *   size readouts, "that map is not in your list any more", and every
     *   update-check progress line (the banner and the tray item both survive
     *   an unload on their own).
     * - **Kept**: a settings write that failed, a failed install, the map-pack
     *   "N new maps" toast and Tab-mode's "the key state cannot be read on this
     *   PC" — each one explains a change in behaviour the user did not ask for
     *   and cannot otherwise find out about.
     *
     * The genuinely important notices are not toasts at all: the hotkey
     * defaults migration (`get-hotkey-notice`), the crash notice
     * (`get-crash-notice`), a downloaded update (`get-pending-update`) and the
     * hotkey conflicts (`get-hotkey-conflicts`) are all **pulled** by the
     * renderer when it loads, so they survive any number of unloads by
     * construction.
     *
     * @param {{key: string, params: ?Object}|string} message built with `msg()`;
     *   the renderer translates it on arrival, so a toast already on screen is
     *   never stranded in the previous language.
     * @param {{keep?: boolean}} [opts] `keep: true` queues it for the next
     *   window instead of dropping it.
     */
    sendUpdate(message, opts = {}) {
        if (this.window && !this.window.isDestroyed()) {
            this.window.webContents.send('update-message', message);
            return;
        }
        if (!opts.keep) return;
        const key = message && typeof message === 'object' ? message.key : String(message || '');
        // Deduped by key: the throttled "settings could not be saved" is the
        // one most likely to arrive several times, and five copies of it would
        // push everything else out of a five-deep queue.
        this.toastQueue = this.toastQueue.filter(m => (m && typeof m === 'object' ? m.key : String(m)) !== key);
        this.toastQueue.push(message);
        while (this.toastQueue.length > TOAST_QUEUE_MAX) this.toastQueue.shift();
    }

    /**
     * Hand the queue to a window that has just come back.
     *
     * **One message at a time, spaced.** `src/js/status.js` is a single
     * `#logStatus` element with one shared auto-hide timer, so five sends in
     * the same tick are five overwrites and only the last one is ever read.
     * They go out `TOAST_FLUSH_GAP_MS` apart instead — comfortably inside the
     * toast's own 5 s life, so each one is on screen long enough to read and
     * the queue drains in a couple of seconds.
     *
     * Only into a window that is actually **visible**: a toast auto-hides on a
     * timer whether or not anybody is looking, so flushing into a window built
     * hidden would throw the queue away in a different, quieter way. The queue
     * is left alone in that case and the next `show` flushes it.
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
        // After the renderer has had a chance to build its toast element. The
        // window may have been created microseconds ago; `did-finish-load` is
        // the honest hook rather than a timeout.
        const deliver = () => {
            queued.forEach((message, index) => {
                // The first one goes out now — there is nothing for it to
                // collide with, and a window that has just come back should
                // say what it has been holding straight away.
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
