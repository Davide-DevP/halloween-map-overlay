const {ipcRenderer} = require('electron');
const {t, onChange} = require('./i18n');
const {showStatus} = require('./status');
const {setBusy} = require('./busy');
const {acceleratorToDisplay} = require('../shared/hotkeys-constants');
const {debugLog} = require('./logger');

/**
 * The renderer half of the field diagnostics: the crash notice, the
 * hotkey-conflict banner and the **Create diagnostic report** button. See
 * `docs/agents/diagnostics.md`.
 *
 * The conflict banner is persistent for the session and updated in place, never
 * a toast per failed registration: a reload binds a dozen accelerators at once.
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
     * `.text()`, never interpolation: an accelerator comes off a JSON file the
     * user can hand-edit.
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
        // Main must not tear this window down while the button waits.
        setBusy('report', true);
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
            setBusy('report', false);
            buttons.prop("disabled", false);
        }
    }
}

module.exports = Diagnostics;
