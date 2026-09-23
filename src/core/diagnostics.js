const fs = require('fs');
const path = require('path');
const {app, ipcMain, shell} = require('electron');
const appLog = require('./app-log');
const {buildDiagnosticReport} = require('./diagnostics/report');
const {listCrashFiles, pendingCrash} = require('./diagnostics/crash');
const {redactCustomMapKeys, redactSettingsText} = require('../shared/redact');
const {CUSTOM_CREATOR} = require('./map-catalog');
const {msg} = require('../shared/i18n');
const {isUnbound} = require('../shared/hotkeys-constants');
const {MARKER_LAYERS} = require('../shared/marker-rules');
const {vkLabel: markerKeyLabel} = require('../shared/key-codes');

/**
 * The **Create diagnostic report** button, and the crash notice that offers it.
 * Nothing is uploaded, and nothing is in the zip that the list below did not
 * name: no screenshots, no map images, no custom map names, no paths.
 * See `docs/agents/diagnostics.md`.
 */

/**
 * Collected from userData verbatim, in archive order. `hotkeys.json` and
 * `settings-app.json` are deliberately **not** here — they go in as generated
 * text, redacted first (`redactedHotkeys`, `redactedSettings`).
 */
const LOG_FILES = [
    'app.log',
    'app.log.1',
    'detector.log',
    'detector.log.1',
    // Written by `hmo-updater.exe`, not by the app, so usually absent.
    'updater.log'
];

class Diagnostics {

    /** @param mainWindow for the status toast · @param settings for `lastCrashSeen` */
    constructor(mainWindow, settings) {
        this.mainWindow = mainWindow;
        this.settings = settings;
        this.healthCheck = null;
        this.hotkeyState = null;
        this.mapPacks = null;
        this.markers = null;
        this.windowState = null;
        this.dir = null;
        try {
            this.dir = app.getPath('userData');
        } catch (err) {
            console.error('Diagnostics: no userData path:', err && err.message);
        }

        ipcMain.handle('create-diagnostic-report', async () => this.create());

        // Asked for, not pushed: the crash happened in a process that is gone.
        ipcMain.handle('get-crash-notice', async () => {
            const file = pendingCrash(this.dir, this.settings ? this.settings.get('lastCrashSeen') : null);
            appLog.event('crash-notice', {pending: file ? 'yes' : 'no', file: file || ''});
            return file ? {file} : null;
        });

        // Dismissing it is what "acknowledged" means.
        ipcMain.handle('dismiss-crash-notice', async () => {
            const files = listCrashFiles(this.dir);
            const newest = files.length ? files[files.length - 1] : null;
            if (newest && this.settings) this.settings.set('lastCrashSeen', newest);
            appLog.event('crash-notice', {dismissed: newest || 'none'});
            return {ok: true};
        });
    }

    /**
     * All six setters take a getter, injected rather than imported: each of
     * those modules is built after this class. Here, the failed registrations.
     */
    setHealthCheck(fn) {
        this.healthCheck = typeof fn === 'function' ? fn : null;
    }

    /** @param {Function} fn returns `DetectorWorkerHost.status()` */
    setDetectorSource(fn) {
        this.detectorSource = typeof fn === 'function' ? fn : null;
    }

    /** @param {Function} fn returns `{gameOnly, active, watching, foreground, gameRunning}` */
    setHotkeyState(fn) {
        this.hotkeyState = typeof fn === 'function' ? fn : null;
    }

    /** `MapPacks.info()`. A pack key is catalogue data, not user text. */
    setMapPacks(fn) {
        this.mapPacks = typeof fn === 'function' ? fn : null;
    }

    /** @param {Function} fn returns `{settings, maps, tabMode}` */
    setMarkers(fn) {
        this.markers = typeof fn === 'function' ? fn : null;
    }

    /** @param {Function} fn returns `MainWindow.unloadState()` */
    setWindowState(fn) {
        this.windowState = typeof fn === 'function' ? fn : null;
    }

    /**
     * `system.txt`: the startup snapshot as it is *now*, not as it was at
     * startup. ASCII only, same reason as the crash file.
     */
    async systemText() {
        const info = await appLog.collect();
        const lines = ['Halloween Map Overlay - system report', `generated ${new Date().toISOString()}`, ''];
        lines.push('[app]');
        for (const [key, value] of Object.entries(info.app)) lines.push(`${key} = ${value}`);
        lines.push('', '[displays]');
        info.displays.forEach((d, i) => lines.push(`${i} = ${d}`));
        lines.push('', '[gpu]');
        for (const [key, value] of Object.entries(info.gpu)) lines.push(`${key} = ${value}`);
        lines.push('', '[settings]');
        for (const [key, value] of Object.entries(info.settings)) {
            // An unbound hotkey is `""`, which reads like a missing value.
            const shown = key.startsWith('hotkey') && typeof value === 'string' && isUnbound(value) ? '(unbound)' : JSON.stringify(value);
            lines.push(`${key} = ${shown}`);
        }
        lines.push('', '[health]');
        // First, because with `hotkeysGameOnly` on the shortcuts are
        // deliberately unregistered while the game is not in front.
        const hotkeyState = this.hotkeyState ? (this.hotkeyState() || {}) : {};
        if (Object.keys(hotkeyState).length) {
            lines.push(`hotkeysGameOnly = ${hotkeyState.gameOnly ? 'on' : 'off'}`);
            lines.push(`hotkeys registered = ${hotkeyState.active ? 'yes' : 'no'}`);
            lines.push(`foreground = ${hotkeyState.foreground || 'unknown'}`);
            lines.push(`game running = ${hotkeyState.gameRunning ? 'yes' : 'no'}`);
            // The bind dialog is the one case where "registered = no" is
            // neither the foreground nor a conflict.
            if (hotkeyState.suspended) lines.push('hotkeys suspended = yes (recording a key combination)');
        }
        // The window is destroyed in the tray, always since 1.0.
        const windowState = this.windowState ? (this.windowState() || {}) : {};
        if (Object.keys(windowState).length) {
            lines.push(`main window = ${windowState.loaded ? 'loaded' : 'unloaded'}`);
            if ((windowState.busy || []).length) {
                lines.push(`main window held by = ${windowState.busy.join(', ')}`);
            }
        }
        // `noop` = back to the peak-rss oscillation of MEMORY-REPORT-2 §4.
        if (info.app && info.app.gc) lines.push(`detector gc = ${info.app.gc}`);
        // The utility process, or the in-process fallback.
        const detectorSource = this.detectorSource ? (this.detectorSource() || null) : null;
        if (detectorSource) {
            lines.push(`detector = ${detectorSource.mode}`
                + (detectorSource.mode === 'worker' ? '' : ` (${detectorSource.reason})`)
                + (detectorSource.restarts ? `, ${detectorSource.restarts} restart(s)` : '')
                + (detectorSource.timeouts ? `, ${detectorSource.timeouts} timeout(s)` : ''));
            // Main's `gc` line cannot show the child's.
            if (detectorSource.gc) lines.push(`worker gc = ${detectorSource.gc}`);
        }
        const conflicts = this.healthCheck ? (this.healthCheck() || []) : [];
        if (!conflicts.length) {
            lines.push('hotkeys = all registered');
        } else {
            lines.push(`hotkeys = ${conflicts.length} could not be registered`);
            for (const c of conflicts) lines.push(`  ${c.accelerator} (${c.action || 'map hotkey'}) - ${c.reason || 'taken'}`);
        }
        lines.push('', '[map packs]');
        const packInfo = this.mapPacks ? (this.mapPacks() || {}) : {};
        lines.push(`checkForMapPacks = ${packInfo.enabled === false ? 'off' : 'on'}`);
        lines.push(`last check = ${packInfo.lastCheckAt ? new Date(packInfo.lastCheckAt).toISOString() : '(never)'}`);
        lines.push(`last result = ${packInfo.lastResult || 'never'}${packInfo.lastError ? ` (${packInfo.lastError})` : ''}`);
        const packs = packInfo.packs || [];
        if (!packs.length) lines.push('installed = (none)');
        else for (const pack of packs) lines.push(`installed = ${pack.key} v${pack.version}`);
        // A folder that failed validation answers "the map is not there".
        for (const skipped of packInfo.skipped || []) lines.push(`skipped = ${skipped.dir} (${skipped.reason})`);

        lines.push('', '[markers]');
        const markerInfo = this.markers ? (this.markers() || {}) : {};
        const markerSettings = markerInfo.settings || {};
        // Repeated from the [settings] dump: this section is self-contained.
        lines.push(`markers = ${markerSettings.markers === false ? 'off' : 'on'}`);
        for (const layer of MARKER_LAYERS) {
            lines.push(`layer ${layer.id} = ${markerSettings[layer.settingKey] === false ? 'off' : 'on'}`);
        }
        lines.push(`legend = ${markerSettings.markerLegend === false ? 'off' : 'on'}`);
        lines.push(`opacity = ${markerSettings.markerOpacity === undefined ? '(default)' : markerSettings.markerOpacity}`);
        // Bundled keys only — catalogue data, not user text.
        const markerMaps = markerInfo.maps || [];
        lines.push(`maps with markers = ${markerMaps.length}`);
        for (const key of markerMaps) lines.push(`  ${key}`);
        const tab = markerInfo.tabMode || {};
        lines.push(`tab mode setting = ${tab.setting ? 'on' : 'off'} (experimental)`);
        lines.push(`tab mode active = ${tab.active ? 'yes' : 'no'}`);
        lines.push(`tab mode showing = ${tab.showing ? `yes (${tab.key || '?'})` : 'no'}`);
        // The two methods differ in latency and in capture frequency.
        lines.push(`tab mode method = ${tab.method || '?'} (${tab.methodReason || '?'}), `
            + `setting "${tab.triggerMode || '?'}"`);
        const trigger = tab.trigger || {};
        // The label is what the *active layout* calls that key.
        lines.push(`map key = vk 0x${Number(tab.mapVk || 0).toString(16).toUpperCase()} `
            + `(${tab.mapKeyLabel || markerKeyLabel(tab.mapVk)})`);
        lines.push(`game window seen = ${tab.gameWindow ? 'yes' : 'no'}`);
        // A capture that is not the window's own rectangle (a border, a title
        // bar): nothing is drawn, and only this line says why.
        lines.push(`window/capture mismatch = ${tab.sizeMismatch ? 'yes (not drawing)' : 'no'}`);
        // PRIVACY: counters and errors only, and never any key but the one the
        // user configured. "Available" (the native path works) and "running"
        // (polling now) are different questions.
        lines.push(`key trigger = available ${trigger.available === true ? 'yes'
            : (trigger.available === false ? 'no' : 'not probed')}`
            + `${trigger.reason ? ` (${trigger.reason})` : ''}, running ${trigger.running ? 'yes' : 'no'}, `
            + `every ${trigger.intervalMs || 0} ms`);
        lines.push(`key trigger counters = ${trigger.polls || 0} polls, ${trigger.downs || 0} down, `
            + `${trigger.ups || 0} up, ${trigger.errors || 0} errors`);
        // The controller: the one configured code — never a pad, never a reading.
        if (tab.mapPad === null || tab.mapPad === undefined) {
            lines.push('controller button = none (the controller is not read)');
        } else {
            lines.push(`controller button = standard index ${Number(tab.mapPad)} (${tab.mapPadLabel || '?'}), read on every pad`);
        }
        const pw = tab.padWindow || {};
        lines.push(`controller window = ${pw.exists ? 'open' : 'closed'}${pw.exists && !pw.ready ? ' (loading)' : ''}`
            + `${pw.failed ? ' (could not be created)' : ''}, `
            + `watching ${pw.watching ? 'yes' : 'no'}, ${pw.padsSeen || 0} pad(s) seen, ${pw.edges || 0} edges, `
            + `created ${pw.created || 0} time(s)`);
        lines.push(`tab mode cadence = check ${tab.checkMs || 0} ms `
            + `(fast ${tab.fastMs || 0} / safety ${tab.safetyMs || 0}), detect ${tab.detectMs || 0} ms, `
            + `hide after ${tab.hideAfterNegative || 0} negative gate(s)`);
        // `stale` = answers that arrived after the markers came down: a tap
        // makes one, a flood means captures are far too slow.
        lines.push(`tab mode counters = ${tab.checks || 0} checks, ${tab.shows || 0} shows, `
            + `${tab.hides || 0} hides, ${tab.stale || 0} stale, ${tab.retries || 0} retries`);
        // `provisional` = shows that went up on the key edge alone,
        // `unconfirmed` = the ones the screen never agreed with (a flash).
        lines.push(`tab mode instant show = ${tab.instant === false ? 'off' : 'on'}`
            + ` (deadline ${tab.provisionalMs || 0} ms), `
            + `${tab.provisional || 0} provisional, ${tab.unconfirmed || 0} unconfirmed`);
        // Enumerate/capture/gate in ms — whether the cadence is being met here.
        const timing = tab.lastTiming;
        lines.push(`tab mode last check = ${timing
            ? `enumerate=${timing.enumerate}ms capture=${timing.capture}ms gate=${timing.gate}ms total=${timing.total}ms`
            : '(none yet)'}`);

        lines.push('', '[crash files]');
        const crashes = listCrashFiles(this.dir);
        if (!crashes.length) lines.push('(none)');
        else for (const name of crashes) lines.push(name);
        return lines.join('\n') + '\n';
    }

    /**
     * `hotkeys.json` with the custom map names taken out — which is why the
     * file itself is **not** in `LOG_FILES`. Null when there is none.
     */
    redactedHotkeys() {
        const file = path.join(this.dir || '', 'hotkeys.json');
        try {
            if (!this.dir || !fs.existsSync(file)) return null;
            // Raw text, not parse-and-rewrite: a hotkeys.json that will not
            // parse is itself worth seeing, and it has to be redacted too.
            return redactCustomMapKeys(fs.readFileSync(file, 'utf-8'), CUSTOM_CREATOR);
        } catch (err) {
            console.error('hotkeys.json could not be read for the report:', err && err.message);
            // The code only: an fs error message carries the full path (rule 3).
            return `(hotkeys.json could not be read: ${(err && err.code) || 'error'})\n`;
        }
    }

    /**
     * `settings-app.json` with any stored controller id taken out (a 1.3.x key,
     * still redacted) — which is why the file is **not** in `LOG_FILES`. Null
     * when there is none.
     */
    redactedSettings() {
        const file = path.join(this.dir || '', 'settings-app.json');
        try {
            if (!this.dir || !fs.existsSync(file)) return null;
            return redactSettingsText(fs.readFileSync(file, 'utf-8'));
        } catch (err) {
            console.error('settings-app.json could not be read for the report:', err && err.message);
            // The code only: an fs error message carries the full path (rule 3).
            return `(settings-app.json could not be read: ${(err && err.code) || 'error'})
`;
        }
    }

    /**
     * Build the zip and show it in the file manager. The Desktop, because that
     * is where a user can find it again without being told a path.
     */
    async create() {
        // The click that triggered this is itself the most recent event.
        appLog.flush();

        let outDir = this.dir;
        try {
            outDir = app.getPath('desktop') || this.dir;
        } catch (err) {
            outDir = this.dir;
        }

        let system = '';
        try {
            system = await this.systemText();
        } catch (err) {
            system = `system report failed: ${(err && err.message) || err}\n`;
        }

        const files = LOG_FILES.map(name => path.join(this.dir, name));
        for (const name of listCrashFiles(this.dir)) files.push(path.join(this.dir, name));

        const texts = [{name: 'system.txt', text: system}];
        const hotkeys = this.redactedHotkeys();
        if (hotkeys !== null) texts.push({name: 'hotkeys.json', text: hotkeys});
        const settingsText = this.redactedSettings();
        if (settingsText !== null) texts.push({name: 'settings-app.json', text: settingsText});

        let result = buildDiagnosticReport({files, texts, outDir});
        const desktop = outDir;
        if (!result.ok && outDir !== this.dir) {
            // A redirected Desktop (OneDrive offline) must not lose the report.
            console.error('Diagnostic report on the Desktop failed:', result.error);
            outDir = this.dir;
            result = buildDiagnosticReport({files, texts, outDir});
        }

        if (!result.ok) {
            appLog.error('diagnostic-report', {ok: 'no', message: result.error || ''});
            if (this.mainWindow) this.mainWindow.sendUpdate(msg('diagnostics.failed'));
            return {ok: false, name: null, entries: 0};
        }

        const onDesktop = outDir === desktop && desktop !== this.dir;
        appLog.event('diagnostic-report', {
            ok: 'yes',
            where: onDesktop ? 'desktop' : 'userData',
            entries: result.entries.length,
            skipped: result.skipped.length,
            bytes: result.entries.reduce((sum, e) => sum + e.bytes, 0)
        });
        // The toast names the folder the file is actually in.
        if (this.mainWindow) {
            this.mainWindow.sendUpdate(onDesktop
                ? msg('diagnostics.created', {file: result.name})
                : msg('diagnostics.createdFallback', {file: result.name}));
        }
        try {
            shell.showItemInFolder(result.path);
        } catch (err) {
            console.error('showItemInFolder failed:', err && err.message);
        }
        return {ok: true, name: result.name, entries: result.entries.length};
    }
}

module.exports = Diagnostics;
module.exports.LOG_FILES = LOG_FILES;
