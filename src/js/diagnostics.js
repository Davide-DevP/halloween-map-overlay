const {ipcRenderer} = require('electron');
const {t, onChange} = require('./i18n');
const {showStatus} = require('./status');
const {acceleratorToDisplay} = require('../shared/hotkeys-constants');
const {debugLog} = require('./logger');

/**
 * The renderer half of the 0.3.2 field diagnostics: two home-page banners and
 * the button both of them (and Settings › General) point at.
 *
 * - **Crash notice.** Raised when the previous run ended in an
 *   `uncaughtException` the user has not been told about yet. It is asked for,
 *   not pushed: the crash it reports happened in a process that no longer
 *   exists, so there is nothing left to push it from. Dismissing it is what
 *   "acknowledged" means — main writes the crash file's name to
 *   `lastCrashSeen` and the same crash never greets the user twice.
 * - **Hotkey conflict warning.** Persistent for the session and updated in
 *   place, never a toast per failed registration: a reload binds a dozen
 *   accelerators at once, and five toasts a session is something a user learns
 *   to dismiss without reading. A hotkey that silently does nothing (Discord
 *   or the NVIDIA overlay took the combination first) is otherwise the single
 *   hardest thing to diagnose from a distance.
 * - **Create diagnostic report.** One zip on the Desktop. The success toast
 *   comes from main, which is also what opens the folder; this side only
 *   disables the button while it works and reports a failure.
 *
 * Both banners are built with `t()` at render time, so both re-render through
 * `i18n.onChange` — see the rule in AGENTS.md.
 */
class Diagnostics {

    constructor() {
        /** `[{accelerator, action, reason}]` from the last hotkey reload. */
        this.conflicts = [];
        /** True while a report is being written, so a double click is one zip. */
        this.busy = false;
        onChange(() => this.renderConflicts());
    }

    async init() {
        const self = this;

        ipcRenderer.on('hotkey-conflicts', (event, conflicts) => {
            self.conflicts = Array.isArray(conflicts) ? conflicts : [];
            self.renderConflicts();
        });

        $("#createReport").on("click", () => self.createReport());
        $("#crashReportBtn").on("click", () => self.createReport());
        $("#crashDismiss").on("click", async () => {
            $("#crashNotice").slideUp();
            await ipcRenderer.invoke('dismiss-crash-notice');
        });

        // Hotkeys are registered before this window finishes loading (see
        // `createWindow` in index.js), so the push may already have happened.
        try {
            const conflicts = await ipcRenderer.invoke('get-hotkey-conflicts');
            this.conflicts = Array.isArray(conflicts) ? conflicts : [];
            this.renderConflicts();
        } catch (err) {
            console.error('diagnostics::conflicts', err && err.message);
        }

        try {
            const crash = await ipcRenderer.invoke('get-crash-notice');
            debugLog("diagnostics::crash-notice", crash ? crash.file : "none");
            if (crash) $("#crashNotice").removeClass("d-none").hide().slideDown();
        } catch (err) {
            console.error('diagnostics::crash-notice', err && err.message);
        }
    }

    /**
     * Fill the conflict banner, or hide it when the last reload bound
     * everything. `.text()`, never interpolation: an accelerator comes off a
     * JSON file the user can hand-edit.
     */
    renderConflicts() {
        const banner = $("#hotkeyConflict");
        if (!this.conflicts.length) {
            banner.addClass("d-none");
            return;
        }
        const list = this.conflicts.map(c => acceleratorToDisplay(c.accelerator)).join(", ");
        $("#hotkeyConflictList").text(list);
        banner.removeClass("d-none");
    }

    /** Build the zip. The toast on success is main's — it knows the name. */
    async createReport() {
        if (this.busy) return;
        this.busy = true;
        const buttons = $("#createReport, #crashReportBtn");
        buttons.prop("disabled", true);
        showStatus(t('diagnostics.creating'));
        try {
            const result = await ipcRenderer.invoke('create-diagnostic-report');
            debugLog("diagnostics::report", JSON.stringify(result));
            if (!result || !result.ok) showStatus(t('diagnostics.failed'));
        } catch (err) {
            console.error('diagnostics::report', err && err.message);
            showStatus(t('diagnostics.failed'));
        } finally {
            this.busy = false;
            buttons.prop("disabled", false);
        }
    }
}

module.exports = Diagnostics;
