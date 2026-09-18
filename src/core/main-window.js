const {BrowserWindow, app, shell, ipcMain, screen} = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const {spawn} = require("child_process");
const {imageSize} = require('image-size');
const {autoUpdater} = require('electron-updater');
const {computeOverlayPosition, rotatedSize} = require('./overlay-position');
const updateHelper = require('./update-helper');
const {mapLabelMode} = require('../shared/settings-defaults');
const {msg, t} = require('../shared/i18n');
const appLog = require('./app-log');

const debug = process.env.DEBUG === 'true';

/**
 * Two renderer deaths closer together than this are a crash loop, not a
 * hiccup. One minute, per the 0.3.2 spec.
 */
const RENDERER_CRASH_WINDOW_MS = 60000;

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
        ipcMain.handle('get-pending-update', async () => {
            return this.pendingUpdateVersion ? {version: this.pendingUpdateVersion} : null;
        });
        ipcMain.handle('install-update', async () => {
            return this.installUpdate();
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
        ipcMain.on('map-change', async (event, map, opts = {}) => {
            if (!map) {
                this.logMapChange('', opts.source || 'hide');
                overlayWindow.send('map-hide');
                if (!opts.preview) obsWindow.send('map-hide');
                return;
            }

            let imgData;
            // The map's own name, for the `always` label mode. Empty for raw
            // base64 payloads, which have no name to show.
            let resolvedName = '';
            if (opts.preview) {
                // The settings preview is rendered in the renderer and arrives
                // as raw base64 — never look it up in the catalogue.
                imgData = Buffer.from(map, "base64");
                this.logMapChange('(preview)', 'preview');
            } else {
                const entry = this.mapLibrary ? this.mapLibrary.resolveEntry(map) : null;
                if (entry) {
                    resolvedName = entry.name;
                    imgData = await fs.promises.readFile(entry.path);
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
                overlayWindow.send('map-change', Buffer.from(imgData).toString("base64"), settings.get('size'), settings.get('opacity'), settings.get('draggable'), settings.get('rotation'), mapLabel, labelMode)
            } else {
                overlayWindow.send('map-change', Buffer.from("").toString("base64"), settings.get('size'), settings.get('opacity'), settings.get('draggable'), settings.get('rotation'), '', labelMode);
            }
            // The settings preview stays off the OBS window -- it must never leak into a stream
            if (!opts.preview) obsWindow.send('map-change', Buffer.from(imgData).toString("base64"), settings.get('size'), mapLabel, labelMode);
        });
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

        // A renderer crash is otherwise completely silent from the terminal —
        // and from the user, who sees a window that stopped responding to
        // clicks and no error anywhere.
        //
        // Policy (0.3.2): reload once and carry on, because a single renderer
        // death is usually a GPU hiccup and reloading restores a working window
        // in under a second. A *second* death within a minute is not a hiccup:
        // reloading again would loop, so it becomes a crash file and a quit,
        // which at least leaves evidence and a clean state to start from.
        this.window.webContents.on('render-process-gone', (event, details) => {
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

        this.cleanStaleUpdateHelpers()
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
        // With a non-silent install this, not quitAndInstall's second argument,
        // is what relaunches the app. Default is already true; pinned so a
        // library default cannot quietly strand the user on a closed app.
        autoUpdater.autoRunAppAfterInstall = true;

        const self = this;
        // show() runs again when the window is reopened from the tray
        if (!MainWindow._updaterBound) {
            MainWindow._updaterBound = true;
            autoUpdater.on('checking-for-update', () => {
                appLog.event('update', {state: 'checking'});
                self.sendUpdate(msg('update.checking'));
            });
            autoUpdater.on('update-available', (info) => {
                appLog.event('update', {state: 'available', version: (info && info.version) || ''});
                self.sendUpdate(msg('update.available'));
            });
            autoUpdater.on('update-not-available', () => {
                appLog.event('update', {state: 'up-to-date'});
                self.sendUpdate(msg('update.upToDate'));
            });
            autoUpdater.on('download-progress', (p) => {
                self.sendUpdate(msg('update.downloading', {percent: Math.round(p.percent || 0)}));
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
                // The toast auto-hides; the banner is the persistent element.
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
            });
        }

        setTimeout(() => {
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
     * References to modules built after this one (`index.js` wires them), so
     * the install can shut the app down cleanly and the tray can grow its
     * "Restart and update" item.
     */
    setShutdownHooks(hooks) {
        this.shutdownHooks = hooks || {};
    }

    /** Stop the detector and drop the tray icon before the app goes away. */
    runShutdownHooks() {
        const {mapDetector, tray} = this.shutdownHooks || {};
        // Overlay first: it is the always-on-top, click-through window, and it
        // must be gone before anything slow runs so the desktop stays responsive.
        try {
            if (this.overlayWindow && typeof this.overlayWindow.close === 'function') this.overlayWindow.close();
        } catch (err) {
            console.error('Overlay close failed during shutdown:', err && err.message);
        }
        try {
            if (mapDetector && typeof mapDetector.stop === 'function') mapDetector.stop();
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
            this.sendUpdate(msg('update.installFailed'));
            return {ok: false, themed: false};
        }
    }

    /**
     * Short status line shown in the bottom-right toast of the main window.
     * @param {{key: string, params: ?Object}|string} message built with `msg()`;
     *   the renderer translates it on arrival, so a toast already on screen is
     *   never stranded in the previous language.
     */
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
