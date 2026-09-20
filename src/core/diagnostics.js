const fs = require('fs');
const path = require('path');
const {app, ipcMain, shell} = require('electron');
const appLog = require('./app-log');
const {buildDiagnosticReport} = require('./diagnostics/report');
const {listCrashFiles, pendingCrash} = require('./diagnostics/crash');
const {redactCustomMapKeys} = require('../shared/redact');
const {CUSTOM_CREATOR} = require('./map-catalog');
const {msg} = require('../shared/i18n');
const {isUnbound} = require('../shared/hotkeys-constants');
const {MARKER_LAYERS} = require('../shared/marker-rules');
const {vkLabel: markerKeyLabel} = require('../shared/key-codes');

/**
 * The **Create diagnostic report** button, and the crash notice that offers it.
 *
 * One click has to produce everything the owner needs from a friend who says
 * "it does not work": both logs and their backups, the settings, the hotkey
 * bindings, every crash file, and a freshly generated `system.txt`. One zip on
 * the Desktop, named after the minute it was made, that the friend can drag
 * into a chat window.
 *
 * What is emphatically *not* in it: no screenshots, no map images, no custom
 * map names, no paths under the user's profile (`app-log.js` redacts those on
 * the way into the log, so the files being collected are already clean). The
 * file list below is the whole contract — `report.js` walks no directories of
 * its own, so "what is in the zip" is answerable by reading one function.
 *
 * Nothing is uploaded. The app's only network call is still the update check.
 */

/**
 * Files collected from userData verbatim, in the order they appear in the
 * archive. `hotkeys.json` is deliberately **not** here — it is added as
 * generated text so the custom map names in it can be redacted first
 * (`redactedHotkeys`).
 */
const LOG_FILES = [
    'app.log',
    'app.log.1',
    'detector.log',
    'detector.log.1',
    // Written by `hmo-updater.exe`, not by the app, and only when an update has
    // actually been installed — so it is usually absent, which `report.js`
    // treats as a skipped entry rather than a failure. It carries the step
    // timings and the folder-size curve, which is the only evidence there is
    // after "the update did nothing".
    'updater.log',
    'settings-app.json'
];

class Diagnostics {

    /**
     * @param {Object} mainWindow for the status toast
     * @param {Object} settings for `lastCrashSeen`
     */
    constructor(mainWindow, settings) {
        this.mainWindow = mainWindow;
        this.settings = settings;
        /** Set by `setHealthCheck` — the §4 hotkey conflicts, for system.txt. */
        this.healthCheck = null;
        /** Set by `setHotkeyState` — are the hotkeys registered right now? */
        this.hotkeyState = null;
        /** Set by `setMapPacks` — installed map packs + the last check. */
        this.mapPacks = null;
        /** Set by `setMarkers` — the marker settings + Tab-map mode's state. */
        this.markers = null;
        /** Set by `setWindowState` — is the main window loaded right now? */
        this.windowState = null;
        this.dir = null;
        try {
            this.dir = app.getPath('userData');
        } catch (err) {
            console.error('Diagnostics: no userData path:', err && err.message);
        }

        ipcMain.handle('create-diagnostic-report', async () => this.create());

        // The home-page crash banner. The renderer asks on load rather than
        // waiting for a push: the crash it is reporting happened during the
        // *previous* run, so there is nothing to push it from.
        ipcMain.handle('get-crash-notice', async () => {
            const file = pendingCrash(this.dir, this.settings ? this.settings.get('lastCrashSeen') : null);
            // Logged either way: "did it warn me?" is itself a support
            // question, and this is the only trace the banner leaves.
            appLog.event('crash-notice', {pending: file ? 'yes' : 'no', file: file || ''});
            return file ? {file} : null;
        });

        // Dismissing it is what "acknowledged" means; the same crash must not
        // greet the user on every start forever.
        ipcMain.handle('dismiss-crash-notice', async () => {
            const files = listCrashFiles(this.dir);
            const newest = files.length ? files[files.length - 1] : null;
            if (newest && this.settings) this.settings.set('lastCrashSeen', newest);
            appLog.event('crash-notice', {dismissed: newest || 'none'});
            return {ok: true};
        });
    }

    /**
     * @param {Function} fn returns `[{accelerator, action}]` — the hotkeys that
     *   failed to register. Injected rather than imported: `Hotkeys` is built
     *   after this class and owns the list.
     */
    setHealthCheck(fn) {
        this.healthCheck = typeof fn === 'function' ? fn : null;
    }

    /**
     * @param {Function} fn returns `{gameOnly, active, watching, foreground,
     *   gameRunning}`. With `hotkeysGameOnly` on, "the hotkeys do nothing" has
     *   a second, entirely legitimate cause — the game was not in front — and
     *   the report has to be able to tell that from a conflict.
     */
    /**
     * @param {Function} fn returns `DetectorWorkerHost.status()` — which
     *   implementation is capturing, and why. A user whose machine cannot start
     *   a utility process gets the in-process path, which is slower on the main
     *   thread; that difference has to be visible in a report.
     */
    setDetectorSource(fn) {
        this.detectorSource = typeof fn === 'function' ? fn : null;
    }

    setHotkeyState(fn) {
        this.hotkeyState = typeof fn === 'function' ? fn : null;
    }

    /**
     * @param {Function} fn returns `MapPacks.info()` — `{packs: [{key,
     *   version}], lastCheckAt, lastResult, lastError, skipped}`. Two support
     *   questions need it: "I do not have the new map" (is the pack installed,
     *   and at which version?) and "it never finds new maps" (did the check
     *   run, and what did it say?). A pack's key is catalogue data published by
     *   this project, not user text, so it is printed in full exactly like a
     *   shipped map's — see `core/map-packs.js`.
     */
    setMapPacks(fn) {
        this.mapPacks = typeof fn === 'function' ? fn : null;
    }

    /**
     * @param {Function} fn returns `{settings, maps, tabMode}` — the marker
     *   switches, which maps carry marker data, and Tab-map mode's state plus
     *   its last fast-check timings. "The markers are not showing" has at least
     *   five legitimate causes (the master switch, one layer switch, a map with
     *   no marker data, auto-detect off, a layer the map image already draws),
     *   and only a report that prints all of them can tell them apart.
     */
    setMarkers(fn) {
        this.markers = typeof fn === 'function' ? fn : null;
    }

    /**
     * @param {Function} fn returns `MainWindow.unloadState()` —
     *   `{setting, loaded, unloaded, busy}`. Since 0.7 the main window is
     *   **destroyed** while the app sits in the tray (`unloadWindowInTray`), so
     *   a report can legitimately be made moments after the window was rebuilt
     *   — and "the window took a second to open" has to be answerable from the
     *   report rather than guessed at.
     */
    setWindowState(fn) {
        this.windowState = typeof fn === 'function' ? fn : null;
    }

    /**
     * `system.txt`: the startup snapshot as it is *now* (not as it was when the
     * app started — the user may have changed five settings since) plus the one
     * health check.
     * @returns {Promise<string>}
     */
    async systemText() {
        const info = await appLog.collect();
        // ASCII only, same reason as the crash file.
        const lines = ['Halloween Map Overlay - system report', `generated ${new Date().toISOString()}`, ''];
        lines.push('[app]');
        for (const [key, value] of Object.entries(info.app)) lines.push(`${key} = ${value}`);
        lines.push('', '[displays]');
        info.displays.forEach((d, i) => lines.push(`${i} = ${d}`));
        lines.push('', '[gpu]');
        for (const [key, value] of Object.entries(info.gpu)) lines.push(`${key} = ${value}`);
        lines.push('', '[settings]');
        for (const [key, value] of Object.entries(info.settings)) {
            // An unbound system hotkey is stored as an empty string, and a bare
            // `""` in a report reads like a value that went missing. Say what it
            // means: "my hotkey does nothing" and "I switched that hotkey off"
            // are otherwise the same line.
            const shown = key.startsWith('hotkey') && typeof value === 'string' && isUnbound(value) ? '(unbound)' : JSON.stringify(value);
            lines.push(`${key} = ${shown}`);
        }
        lines.push('', '[health]');
        // Whether the shortcuts are held at all comes first: with
        // `hotkeysGameOnly` on they are deliberately unregistered while the
        // game is not in the foreground, and a report taken from the Settings
        // window naturally shows `foreground = own`.
        const hotkeyState = this.hotkeyState ? (this.hotkeyState() || {}) : {};
        if (Object.keys(hotkeyState).length) {
            lines.push(`hotkeysGameOnly = ${hotkeyState.gameOnly ? 'on' : 'off'}`);
            lines.push(`hotkeys registered = ${hotkeyState.active ? 'yes' : 'no'}`);
            lines.push(`foreground = ${hotkeyState.foreground || 'unknown'}`);
            lines.push(`game running = ${hotkeyState.gameRunning ? 'yes' : 'no'}`);
            // Only when it is true: a report made with the bind dialog open is
            // the one case where "registered = no" is neither the foreground
            // nor a conflict, and it would otherwise be a dead end.
            if (hotkeyState.suspended) lines.push('hotkeys suspended = yes (recording a key combination)');
        }
        // Is the main window there at all? It is destroyed while the app sits
        // in the tray (0.7, `unloadWindowInTray`), and the two questions that
        // starts — "the window took a moment to come back" and "a toast never
        // appeared" — both begin here. `app.log` carries the edges themselves
        // as `main-window state=unloaded|loaded`.
        const windowState = this.windowState ? (this.windowState() || {}) : {};
        if (Object.keys(windowState).length) {
            lines.push(`unloadWindowInTray = ${windowState.setting ? 'on' : 'off'}`);
            lines.push(`main window = ${windowState.loaded ? 'loaded' : 'unloaded'}`);
            if ((windowState.busy || []).length) {
                lines.push(`main window held by = ${windowState.busy.join(', ')}`);
            }
        }
        // Whether the detector's on-demand V8 collection works in this
        // runtime. `info.app.gc` is the same probe the startup snapshot runs;
        // `noop` means the loop is back to the peak-rss oscillation
        // `docs/MEMORY-REPORT-2.md` §4 measured, which is otherwise invisible.
        if (info.app && info.app.gc) lines.push(`detector gc = ${info.app.gc}`);
        // Where the capture actually happens. Since 0.7 it is a utility
        // process, so the main thread never blocks on a frame — but every way
        // that can fail falls back to doing it here, and "it stutters on my PC"
        // starts with knowing which one ran.
        const detectorSource = this.detectorSource ? (this.detectorSource() || null) : null;
        if (detectorSource) {
            lines.push(`detector = ${detectorSource.mode}`
                + (detectorSource.mode === 'worker' ? '' : ` (${detectorSource.reason})`)
                + (detectorSource.restarts ? `, ${detectorSource.restarts} restart(s)` : '')
                + (detectorSource.timeouts ? `, ${detectorSource.timeouts} timeout(s)` : ''));
            // The frames are in the worker, so the collection that releases
            // them has to be too. `noop` there means the *child* is back to the
            // peak-rss oscillation; nothing in main's own `gc` line would show
            // it, and nothing else ever asks the child.
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
        // A folder that failed validation is the whole answer to "I installed
        // the map and it is not there", so it is printed rather than dropped.
        for (const skipped of packInfo.skipped || []) lines.push(`skipped = ${skipped.dir} (${skipped.reason})`);

        lines.push('', '[markers]');
        const markerInfo = this.markers ? (this.markers() || {}) : {};
        const markerSettings = markerInfo.settings || {};
        // The switches, spelled out rather than left to the [settings] dump
        // above: this is the section somebody reading the report turns to when
        // the complaint is about markers, and it has to be self-contained.
        lines.push(`markers = ${markerSettings.markers === false ? 'off' : 'on'}`);
        for (const layer of MARKER_LAYERS) {
            lines.push(`layer ${layer.id} = ${markerSettings[layer.settingKey] === false ? 'off' : 'on'}`);
        }
        lines.push(`legend = ${markerSettings.markerLegend === false ? 'off' : 'on'}`);
        lines.push(`opacity = ${markerSettings.markerOpacity === undefined ? '(default)' : markerSettings.markerOpacity}`);
        // Which maps have marker data at all. Bundled keys only, and a bundled
        // key is catalogue data rather than user text (custom maps never carry
        // markers), so it is printed in full like a shipped map's.
        const markerMaps = markerInfo.maps || [];
        lines.push(`maps with markers = ${markerMaps.length}`);
        for (const key of markerMaps) lines.push(`  ${key}`);
        const tab = markerInfo.tabMode || {};
        lines.push(`tab mode setting = ${tab.setting ? 'on' : 'off'} (experimental)`);
        lines.push(`tab mode active = ${tab.active ? 'yes' : 'no'}`);
        lines.push(`tab mode showing = ${tab.showing ? `yes (${tab.key || '?'})` : 'no'}`);
        // Which of the two methods is in use, and why: the two behave
        // differently enough (how soon markers appear, how often the window is
        // captured) that "it works differently on my PC" starts here.
        lines.push(`tab mode method = ${tab.method || '?'} (${tab.methodReason || '?'}), `
            + `setting "${tab.triggerMode || '?'}"`);
        const trigger = tab.trigger || {};
        // The label is what the *active layout* calls that key, which a virtual
        // key code alone cannot say on a non-US keyboard.
        lines.push(`map key = vk 0x${Number(tab.mapVk || 0).toString(16).toUpperCase()} `
            + `(${tab.mapKeyLabel || markerKeyLabel(tab.mapVk)})`);
        lines.push(`game window seen = ${tab.gameWindow ? 'yes' : 'no'}`);
        // A window whose capture is not its own rectangle (a border and a title
        // bar): nothing is drawn, and this is the only place that says why.
        lines.push(`window/capture mismatch = ${tab.sizeMismatch ? 'yes (not drawing)' : 'no'}`);
        // Counters and errors only — never which key, beyond the one the user
        // configured, and never anything about any other key.
        // "Available" (the native path works) and "running" (it is polling the
        // key right now) are different questions: with the game closed the
        // first is yes and the second is no, and reporting that as
        // "unavailable" is the field bug this section was corrected for.
        lines.push(`key trigger = available ${trigger.available === true ? 'yes'
            : (trigger.available === false ? 'no' : 'not probed')}`
            + `${trigger.reason ? ` (${trigger.reason})` : ''}, running ${trigger.running ? 'yes' : 'no'}, `
            + `every ${trigger.intervalMs || 0} ms`);
        lines.push(`key trigger counters = ${trigger.polls || 0} polls, ${trigger.downs || 0} down, `
            + `${trigger.ups || 0} up, ${trigger.errors || 0} errors`);
        lines.push(`tab mode cadence = check ${tab.checkMs || 0} ms `
            + `(fast ${tab.fastMs || 0} / safety ${tab.safetyMs || 0}), detect ${tab.detectMs || 0} ms, `
            + `hide after ${tab.hideAfterNegative || 0} negative gate(s)`);
        // `stale` is the count of answers that arrived after the markers had
        // already come down — a quick tap always produces one, so a trickle is
        // normal and a flood means captures are much slower than they should be.
        lines.push(`tab mode counters = ${tab.checks || 0} checks, ${tab.shows || 0} shows, `
            + `${tab.hides || 0} hides, ${tab.stale || 0} stale, ${tab.retries || 0} retries`);
        // The optimistic show. `provisional` counts the shows that went up on
        // the key edge alone and `unconfirmed` the ones the screen never agreed
        // with — i.e. how often this setting actually cost the user a flash.
        // The two together are the first thing to read when the complaint is
        // "I see markers flicker where there is no map".
        lines.push(`tab mode instant show = ${tab.instant === false ? 'off' : 'on'}`
            + ` (deadline ${tab.provisionalMs || 0} ms), `
            + `${tab.provisional || 0} provisional, ${tab.unconfirmed || 0} unconfirmed`);
        // The last fast check's timings: enumerate/capture/gate in ms. This is
        // the number that says whether the 150 ms cadence is actually being
        // met on the user's machine, and it is decisions-only — no pixels.
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
     * `hotkeys.json` with the custom map names taken out.
     *
     * The file itself is exactly what a "my hotkey does nothing" report needs,
     * and the spec asks for it — but every entry names the map it is bound to,
     * and a custom map's key is `Custom/` plus a name its owner typed. Which
     * accelerator is bound to *a custom map* is the whole diagnostic value; the
     * name is none of it, and the README promises the zip carries no custom map
     * names. So the copy in the report is redacted and the original file is
     * **not** in `LOG_FILES`.
     *
     * @returns {?string} null when there is no file to include
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
            return `(hotkeys.json could not be read: ${(err && err.message) || err})\n`;
        }
    }

    /**
     * Build the zip and show it in the file manager.
     *
     * The Desktop, because that is where a user can find it again without
     * being told a path; userData is the fallback for the (rare) machine where
     * `getPath('desktop')` throws or points somewhere unwritable.
     *
     * @returns {Promise<{ok: boolean, name: ?string, entries: number}>}
     */
    async create() {
        // Whatever is still queued belongs in this report — the click that
        // triggered it is itself the most recent interesting event.
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

        // `hotkeys.json` travels as generated text rather than as a file, so
        // the custom map names in it can be redacted — see `redactedHotkeys`.
        const texts = [{name: 'system.txt', text: system}];
        const hotkeys = this.redactedHotkeys();
        if (hotkeys !== null) texts.push({name: 'hotkeys.json', text: hotkeys});

        let result = buildDiagnosticReport({files, texts, outDir});
        const desktop = outDir;
        if (!result.ok && outDir !== this.dir) {
            // A read-only or redirected Desktop (OneDrive with no network does
            // this) must not lose the report — fall back to userData, which is
            // writable by definition or the app would not have started.
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
        // Name the folder the file is actually in. The toast used to say
        // "Desktop" unconditionally, which after the fallback sent the user
        // looking somewhere the file was not.
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
