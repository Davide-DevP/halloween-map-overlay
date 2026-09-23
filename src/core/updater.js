'use strict';

const {app, screen} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const {spawn} = require('child_process');
const {autoUpdater} = require('electron-updater');
const updateHelper = require('./update-helper');
const {
    planManualUpdateCheck, isUpdateCheckOccupied, updateCheckStall
} = require('../shared/update-message');
const {msg, t} = require('../shared/i18n');
const {errorMessage} = require('../shared/errors');
const {clearTimer, unrefTimer} = require('../shared/timers');
const {markQuitting, clearQuitting} = require('./quitting');
const appLog = require('./app-log');

/** Delay before the startup check; the Settings button may start its own in it. */
const STARTUP_CHECK_DELAY_MS = 4000;

/** The helper's work area when the primary display cannot be read. */
const FALLBACK_WORK_AREA = {x: 0, y: 0, width: 1920, height: 1080};

/** `autoUpdater` is a process singleton: its listeners go on once. */
let listenersBound = false;

/** `app.getVersion()` answers 40.x under `npm start`, hence package.json. */
function appVersion() {
    try {
        return require('../../package.json').version || '';
    } catch (err) {
        return '';
    }
}

/**
 * The whole update flow: the check, its stall watchdog, the download and the
 * three-tier install. Everything window-shaped is injected, because the main
 * window may not exist. Why: docs/agents/updater-and-installer.md.
 */
class Updater {

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
    /** Has the banner been in front of a person (a *visible* window)? */
    updateBannerShown = false;
    updateDismissed = false;

    /**
     * @param {{settings, language, send: Function, sendUpdate: Function,
     *   getWindow: Function, getTray: Function, runShutdownHooks: Function}} deps
     */
    constructor(deps) {
        this.settings = deps.settings;
        this.language = deps.language || null;
        this.send = deps.send;
        this.sendUpdate = deps.sendUpdate;
        this.getWindow = deps.getWindow;
        this.getTray = deps.getTray;
        this.runShutdownHooks = deps.runShutdownHooks;
    }

    lang() {
        return this.language ? this.language.current() : 'en';
    }

    /** What `shared/window-unload.js` needs from the update flow. */
    unloadInputs() {
        return {
            updatePending: this.pendingUpdateVersion !== null,
            updateBannerShown: this.updateBannerShown,
            installing: this.installStarted || this.installInFlight !== null
        };
    }

    /** Pulled by the renderer on load; `dismissed` has to survive the window. */
    pendingUpdate() {
        if (!this.pendingUpdateVersion) return null;
        return {version: this.pendingUpdateVersion, dismissed: this.updateDismissed};
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
        if (this.settings.get('checkForUpdates') === false) {
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
            // Re-asked: the button may have started its own meanwhile.
            if (isUpdateCheckOccupied(this.resolveStalledUpdateCheck())) return;
            // The stock text promises an install on exit, which is no longer
            // true. Translated *in main* because it is a native notification;
            // `{appName}`/`{version}` are electron-updater's own placeholders,
            // which `t()` leaves alone.
            const lang = this.lang();
            autoUpdater.checkForUpdatesAndNotify({
                title: t(lang, 'update.notify.title'),
                body: t(lang, 'update.notify.body')
            }).catch(err => {
                console.error('Update check failed:', err && err.message);
            });
        }, STARTUP_CHECK_DELAY_MS);
    }

    /**
     * **Once**, whatever starts the check: the Settings button runs with the
     * startup switch off, and `listenersBound` stops ten presses leaving ten
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

        if (listenersBound) return;
        listenersBound = true;
        autoUpdater.on('checking-for-update', () => {
            appLog.event('update', {state: 'checking'});
            this.sendUpdate(msg('update.checking'));
            this.setUpdateCheckState('checking');
        });
        autoUpdater.on('update-available', (info) => {
            const version = (info && info.version) || '';
            appLog.event('update', {state: 'available', version});
            this.sendUpdate(msg('update.available'));
            // `autoDownload` is on, so this is the download starting too.
            this.setUpdateCheckState('found', version);
        });
        autoUpdater.on('update-not-available', () => {
            appLog.event('update', {state: 'up-to-date'});
            this.sendUpdate(msg('update.upToDate'));
            // The version to name is the one running, not anything off the feed.
            this.setUpdateCheckState('upToDate', appVersion());
        });
        autoUpdater.on('download-progress', (p) => {
            this.sendUpdate(msg('update.downloading', {percent: Math.round(p.percent || 0)}));
            // A long download's only liveness signal.
            this.noteUpdateCheckActivity();
        });
        autoUpdater.on('update-downloaded', (info) => this.onDownloaded(info));
        autoUpdater.on('error', (err) => {
            console.error('Update check failed:', err && err.message);
            // Logged, not only toasted, or "it said update failed" is
            // unanswerable. The user sees one sentence, never the error or a path.
            appLog.error('update', {state: 'error', message: errorMessage(err)});
            this.sendUpdate(msg('update.checkFailed'));
            this.setUpdateCheckState('failed');
        });
    }

    onDownloaded(info) {
        const version = info && info.version ? String(info.version) : '';
        appLog.event('update', {state: 'downloaded', version});
        this.pendingUpdateVersion = version || null;
        // The .exe in the update cache, which we run ourselves.
        this.pendingInstallerPath = (info && typeof info.downloadedFile === 'string')
            ? info.downloadedFile : null;
        this.sendUpdate(msg('update.downloaded'));
        this.setUpdateCheckState('downloaded', version);
        // **Not** a reason to build a window: the renderer pulls
        // `get-pending-update` on load and the tray grows its item either way
        // (`docs/SPEC-MAP-STATE.md` §5.3). Both flags reset: a new version is
        // news even after a "Later".
        this.updateBannerShown = false;
        this.updateDismissed = false;
        this.send('update-ready', {version});
        const tray = this.getTray();
        if (tray && typeof tray.setUpdatePending === 'function') {
            tray.setUpdatePending(version);
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
        this.updateCheckWatchdog = clearTimer(this.updateCheckWatchdog);
        const {waitMs} = updateCheckStall({
            state: this.updateCheckState,
            lastActivityAt: this.updateCheckActivityAt,
            now: Date.now()
        });
        if (waitMs <= 0) return;
        this.updateCheckWatchdog = unrefTimer(setTimeout(() => {
            this.updateCheckWatchdog = null;
            this.resolveStalledUpdateCheck();
        }, waitMs));
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
            appLog.error('update', {state: 'error', message: errorMessage(err)});
            this.setUpdateCheckState('failed');
        }
        return this.updateCheckStatus();
    }

    /** The downloaded installer: ours from `update-downloaded`, else the library's. */
    installerPath() {
        return this.pendingInstallerPath
            || (autoUpdater.downloadedUpdateHelper && autoUpdater.downloadedUpdateHelper.file)
            || null;
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
        const installerPath = this.installerPath();
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
        const win = this.getWindow();
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
        let workArea = FALLBACK_WORK_AREA;
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
        const installerPath = this.installerPath();
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
                lang: this.lang(),
                waitPid: process.pid,
                bounds: placement.bounds,
                activate: placement.activate,
                logPath: path.join(app.getPath('userData'), 'updater.log')
            });
        } catch (err) {
            appLog.error('update-helper', {ok: 'no', reason: 'threw', message: errorMessage(err)});
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
        markQuitting();
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
     * The quitting flag has to be set first, or the `close` handler hides the
     * window whenever minimize-to-tray is on and `app.quit()` never completes.
     *
     * @returns {Promise<{ok: boolean, themed: boolean}>} the "updating" view
     *   stays up only while `themed`.
     */
    installUpdate() {
        // **Single-flight.** Tier 1 awaits the handshake for up to 15 s, and the
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
            appLog.error('update-helper', {ok: 'no', reason: 'threw', message: errorMessage(err)});
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
            markQuitting();
            appLog.event('install-update', {version, path: 'quitAndInstall'});
            appLog.flush();
            this.send('update-install-result', {ok: true, themed: false});
            this.runShutdownHooks();
            console.log(`Installing update ${version} through electron-updater (normal priority).`);
            autoUpdater.quitAndInstall(false, true);
            return {ok: true, themed: false};
        } catch (err) {
            console.error('Install update failed:', err && err.message);
            appLog.error('install-update', {version, message: errorMessage(err)});
            this.installStarted = false;
            clearQuitting();
            this.send('update-install-result', {ok: false, themed: false});
            // `keep`: an install can start from the tray item with no window at
            // all, and this is the one update message the user must act on.
            this.sendUpdate(msg('update.installFailed'), {keep: true});
            return {ok: false, themed: false};
        }
    }
}

module.exports = Updater;
module.exports.appVersion = appVersion;
