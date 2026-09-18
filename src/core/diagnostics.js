const fs = require('fs');
const path = require('path');
const {app, ipcMain, shell} = require('electron');
const appLog = require('./app-log');
const {buildDiagnosticReport} = require('./diagnostics/report');
const {listCrashFiles, pendingCrash} = require('./diagnostics/crash');
const {redactCustomMapKeys} = require('../shared/redact');
const {CUSTOM_CREATOR} = require('./map-catalog');
const {msg} = require('../shared/i18n');

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
        for (const [key, value] of Object.entries(info.settings)) lines.push(`${key} = ${JSON.stringify(value)}`);
        lines.push('', '[health]');
        const conflicts = this.healthCheck ? (this.healthCheck() || []) : [];
        if (!conflicts.length) {
            lines.push('hotkeys = all registered');
        } else {
            lines.push(`hotkeys = ${conflicts.length} could not be registered`);
            for (const c of conflicts) lines.push(`  ${c.accelerator} (${c.action || 'map hotkey'}) - ${c.reason || 'taken'}`);
        }
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
