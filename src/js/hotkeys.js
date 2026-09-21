/**
 * Renderer, Hotkeys tab: the two tables, the bind dialog and key capture.
 * A VIEW — main owns every decision. See docs/agents/hotkeys.md.
 */
const {debugLog} = require("./logger");
const {ipcRenderer} = require('electron');
const {
    acceleratorToDisplay,
    keyEventToAccelerator,
    isUnbound,
    resolveSystemAccelerator,
    SYSTEM_HOTKEY_DEFS
} = require("../shared/hotkeys-constants");
const {systemHotkeyRows} = require("../shared/hotkeys-rules");
const {escapeHtml} = require("../shared/escape-html");
const {showStatus} = require("./status");
const {t, translateMessage, onChange} = require("./i18n");

function actionName(def) {
    return def && def.descriptionKey ? t(def.descriptionKey) : (def && def.description) || '';
}

/**
 * One accelerator as a row of `<kbd>` caps. **Escaped**, and not as a
 * formality: an accelerator can come straight out of a hand-edited
 * `settings-app.json`, this goes into `innerHTML`, and the renderer has
 * `nodeIntegration: true`.
 * @param {string} accelerator Electron spelling, or `''` when unbound
 * @returns {string} markup
 */
function acceleratorKbd(accelerator) {
    if (isUnbound(accelerator)) return `<em>${escapeHtml(t('hotkeys.notBound'))}</em>`;
    return acceleratorToDisplay(accelerator)
        .split(' + ')
        .map(part => `<kbd>${escapeHtml(part)}</kbd>`)
        .join(' + ');
}

class Hotkeys {

    constructor(maps, settings) {
        this.maps = maps;
        this.settings = settings || null;
        this.recordingHotkey = false;
        // actionId while editing a system hotkey, null while adding a map hotkey
        this.editingSystemAction = null;
        // Electron's own spelling, kept out of the input's text so nothing has
        // to parse it back.
        this.recordedAccelerator = '';
        this.hotkeys = {};
        this.systemHotkeys = {};
        // Everything built with t() is rebuilt on a language change; the modal
        // is left alone, because if it is open the user is mid-edit.
        onChange(() => {
            this.updateHotkeys();
            this.updateSystemHotkeysTable();
            // Built in JS, so `applyDom` cannot reach the placeholder.
            this.populateMapSelect();
            this.applyModalTitle();
            this.updateHotkeyTexts();
        });
    }

    /**
     * The FAQ answers that name key combinations, from the **live** bindings:
     * never hard-code a combination in a catalogue string.
     */
    updateHotkeyTexts() {
        const accel = (actionId) => {
            const def = SYSTEM_HOTKEY_DEFS[actionId];
            if (!def) return '';
            return acceleratorKbd(resolveSystemAccelerator(this.systemHotkeys[actionId], def.defaultAccelerator));
        };
        // `data-i18n-html`'s contract; `acceleratorKbd` escapes the rest.
        $('#faqAutodetect').html(t('faq.autodetect.a', {clear: accel('clear-map')}));
        $('#faqInTheWay').html(t('faq.inTheWay.a', {
            toggle: accel('toggle-map'),
            opacityUp: accel('opacity-up'),
            opacityDown: accel('opacity-down'),
            sizeUp: accel('size-up'),
            sizeDown: accel('size-down')
        }));
    }

    /**
     * JS-owned rather than `data-i18n`, because both depend on state: which
     * action is being edited, and whether a key is being recorded.
     */
    applyModalTitle() {
        const def = this.editingSystemAction ? SYSTEM_HOTKEY_DEFS[this.editingSystemAction] : null;
        $('#addHotkeyModal .modal-title').text(def
            ? t('hotkeys.modal.changeTitle', {action: actionName(def)})
            : t('hotkeys.modal.title'));
        $('#hotkeyInput').attr('placeholder',
            this.recordingHotkey ? t('hotkeys.modal.listening') : t('hotkeys.modal.placeholder'));
    }

    /**
     * @param {string|{key: string, params: ?Object}} message a literal, or the
     *   `{key, params}` main sends back from an IPC handler.
     */
    showToast(message, isSuccess = true) {
        const toastEl = document.getElementById('hotkeyToast');
        const toastBody = document.getElementById('hotkeyToastBody');
        if (!toastEl || !toastBody) return;

        toastBody.textContent = translateMessage(message);
        toastEl.classList.remove('bg-success', 'bg-danger');
        toastEl.classList.add(isSuccess ? 'bg-success' : 'bg-danger');

        bootstrap.Toast.getOrCreateInstance(toastEl).show();
    }

    closeModal() {
        const el = document.getElementById('addHotkeyModal');
        const modal = el && bootstrap.Modal.getInstance(el);
        if (modal) modal.hide();
    }

    updateHotkeys() {
        const $list = $('#hotkeyList').empty();
        const entries = Object.entries(this.hotkeys);

        if (!entries.length) {
            $list.append(`<tr><td colspan="4" class="help-text">${escapeHtml(t('hotkeys.empty'))}</td></tr>`);
            return;
        }

        for (const [hotkey, {id, mapKey}] of entries) {
            const parts = String(mapKey).split('/');
            const name = parts.pop();
            const creator = parts.join('/');
            // Map names can be user-typed (custom imports) — escape everything
            $list.append(`
                <tr data-id="${escapeHtml(id)}">
                    <td><kbd>${escapeHtml(acceleratorToDisplay(hotkey))}</kbd></td>
                    <td>${escapeHtml(name)}</td>
                    <td>${escapeHtml(creator)}</td>
                    <td>
                        <span class="row-actions">
                            <button type="button" class="delete-row btn btn-sm btn-outline-danger"
                                    data-id="${escapeHtml(id)}" title="${escapeHtml(t('hotkeys.deleteTitle'))}">${escapeHtml(t('common.delete'))}</button>
                        </span>
                    </td>
                </tr>
            `);
        }
    }

    loadTable() {
        $('#hotkeyList').on('click', '.delete-row', (e) => {
            const id = $(e.currentTarget).data('id');
            $(e.currentTarget).closest('tr').remove();

            for (const [hotkey, obj] of Object.entries(this.hotkeys)) {
                if (obj.id === id) {
                    delete this.hotkeys[hotkey];
                    break;
                }
            }
            ipcRenderer.send('delete-hotkey', id);
        });
    }

    async loadSystemHotkeys() {
        try {
            this.systemHotkeys = await ipcRenderer.invoke('get-system-hotkeys');
        } catch (err) {
            console.error("Failed to load system hotkeys:", err);
            this.systemHotkeys = {};
        }
        this.updateSystemHotkeysTable();
        this.updateHotkeyTexts();
    }

    /** One System row from a `systemHotkeyRows()` entry. @returns {string} markup */
    systemHotkeyRow(row) {
        // A muted word, not an empty `<kbd>`, which reads as a rendering
        // fault rather than a deliberate "no shortcut".
        const binding = row.bound
            ? `<kbd class="system-hotkey-binding" data-action="${escapeHtml(row.actionId)}">${escapeHtml(acceleratorToDisplay(row.accelerator))}</kbd>`
            : `<span class="hotkey-unbound">${escapeHtml(t('hotkeys.notBound'))}</span>`;

        return `
            <tr data-action="${escapeHtml(row.actionId)}">
                <td>${escapeHtml(row.descriptionKey ? t(row.descriptionKey) : row.description || '')}</td>
                <td>${binding}</td>
                <td>
                    <span class="row-actions">
                        <button type="button" class="edit-system-btn btn btn-sm btn-quiet"
                                data-action="${escapeHtml(row.actionId)}" title="${escapeHtml(t('hotkeys.editTitle'))}">${escapeHtml(t('common.edit'))}</button>
                        <button type="button" class="unbind-system-btn btn btn-sm btn-quiet"
                                data-action="${escapeHtml(row.actionId)}" title="${escapeHtml(t('hotkeys.unbindTitle'))}"
                                ${row.bound ? '' : 'disabled'}>${escapeHtml(t('hotkeys.unbind'))}</button>
                        <button type="button" class="reset-system-btn btn btn-sm btn-quiet"
                                data-action="${escapeHtml(row.actionId)}" title="${escapeHtml(t('hotkeys.resetTitle'))}"
                                ${row.isDefault ? 'disabled' : ''}>${escapeHtml(t('common.reset'))}</button>
                    </span>
                </td>
            </tr>
        `;
    }

    /**
     * Two tbodies, one loop; the split is the pure `systemHotkeyRows`.
     */
    updateSystemHotkeysTable() {
        const $list = $('#systemHotkeyList');
        if (!$list.length) return;
        const $more = $('#systemHotkeyListMore');
        const $fold = $('#systemHotkeyMoreFold');
        $list.empty();
        $more.empty();

        const {main, more} = systemHotkeyRows(this.systemHotkeys);
        for (const row of main) $list.append(this.systemHotkeyRow(row));
        for (const row of more) $more.append(this.systemHotkeyRow(row));
        // Nothing to unfold is not an empty fold with a heading: it is no fold.
        $fold.toggle(more.length > 0);

        const self = this;
        $('.edit-system-btn').off('click').on('click', function () {
            self.startSystemHotkeyEdit($(this).data('action'));
        });
        // Fire and forget: main answers with a toast and the
        // `system-hotkeys-updated` push that redraws this table.
        $('.unbind-system-btn').off('click').on('click', function () {
            ipcRenderer.send('unbind-system-hotkey', {actionId: $(this).data('action')});
        });
        $('.reset-system-btn').off('click').on('click', function () {
            ipcRenderer.send('reset-system-hotkey', {actionId: $(this).data('action')});
        });
    }

    startSystemHotkeyEdit(actionId) {
        const def = SYSTEM_HOTKEY_DEFS[actionId];
        if (!def) return;

        this.editingSystemAction = actionId;

        $('#mapSelectField').hide();

        this.startRecording();
        this.applyModalTitle();

        const self = this;
        $('#saveHotkeyBtn').off('click').on('click', function () {
            self.saveSystemHotkey();
        });

        new bootstrap.Modal(document.getElementById('addHotkeyModal')).show();
    }

    async saveSystemHotkey() {
        const actionId = this.editingSystemAction;
        if (!actionId) return;

        if (!this.recordedAccelerator) {
            this.showToast(t('hotkeys.error.noKey'), false);
            return;
        }

        const result = await ipcRenderer.invoke('save-system-hotkey', {
            actionId,
            accelerator: this.recordedAccelerator
        });
        this.showToast(result.message, result.ok);
        // The modal only closes once main has actually accepted the binding
        if (result.ok) this.closeModal();
    }

    restoreModalDefaults() {
        $('#mapSelectField').show();
        $('#hotkeyInput').val('');
        this.editingSystemAction = null;
        this.recordingHotkey = false;
        this.recordedAccelerator = '';
        this.applyModalTitle();

        const self = this;
        $('#saveHotkeyBtn').off('click').on('click', function () {
            self.saveHotkeyToFile();
        });
    }

    async saveHotkeyToFile() {
        const mapkey = $('#selectMap').val();
        if (!this.recordedAccelerator || !mapkey) {
            this.showToast(t('hotkeys.error.pickBoth'), false);
            return;
        }
        const result = await ipcRenderer.invoke('save-hotkeys', {
            hotkey: this.recordedAccelerator,
            mapkey
        });
        this.showToast(result.message, result.ok);
        if (result.ok) this.closeModal();
    }

    async loadHotkeys() {
        this.populateMapSelect();
        this.applyModalTitle();
        this.loadCapture();
        this.loadGameOnlySwitch();

        ipcRenderer.on('hotkey-updated', (event, hotkeys) => {
            this.hotkeys = hotkeys;
            this.updateHotkeys();
        });

        ipcRenderer.on('system-hotkeys-updated', async (event, bindings) => {
            this.systemHotkeys = bindings;
            this.updateSystemHotkeysTable();
            this.updateHotkeyTexts();
            // Main wrote these straight to disk, so pull the file back in.
            if (this.settings) await this.settings.refresh();
        });

        ipcRenderer.send('load-hotkeys');
        await this.loadSystemHotkeys();
        this.loadTable();
        await this.collectNotice();
        debugLog("hotkeys::loadHotkeys::done");
    }

    /**
     * Settings › Hotkeys › *Only while the game is in the foreground*. Its own
     * IPC handler, because main has to act on it — see
     * docs/agents/settings-and-onboarding.md § Writing settings.
     */
    loadGameOnlySwitch() {
        const $check = $('#hotkeysGameOnlyCheck');
        if (!$check.length) return;
        $check.prop('checked', !this.settings || this.settings.raw('hotkeysGameOnly') !== false);
        const self = this;
        $check.off('input').on('input', async function () {
            const on = $(this).prop('checked');
            const result = await ipcRenderer.invoke('set-hotkeys-game-only', on);
            if (result && result.ok === false) {
                // The write failed, so put the switch back where the file is.
                $(this).prop('checked', !on);
                return;
            }
            if (self.settings) await self.settings.refresh();
        });
    }

    /**
     * One-time notices main decided before this window existed. Main clears
     * each one as it hands it over, so a reload cannot show it twice.
     */
    async collectNotice() {
        try {
            const notice = await ipcRenderer.invoke('get-hotkey-notice');
            if (notice) showStatus(translateMessage(notice));
        } catch (err) {
            console.error('hotkeys::notice', err && err.message);
        }
    }

    populateMapSelect() {
        const $select = $("#selectMap");
        if (!$select.length) return;
        $select.empty().append($('<option>').val('').text(t('hotkeys.modal.selectMap')));

        // A `Map`, never an object literal.
        // Why: docs/agents/hotkeys.md § Priority, conflicts and registration.
        const byCreator = new Map();
        for (const entry of this.maps.catalog) {
            if (!byCreator.has(entry.creator)) byCreator.set(entry.creator, []);
            byCreator.get(entry.creator).push(entry);
        }
        for (const [creator, entries] of byCreator) {
            // .attr()/.text() keep user-typed custom map names out of the parser
            const $group = $('<optgroup>').attr('label', creator);
            entries.forEach(e => $group.append($('<option>').val(e.key).text(e.name)));
            $select.append($group);
        }
    }

    startRecording() {
        this.recordingHotkey = true;
        this.recordedAccelerator = '';
        $('#hotkeyInput').val('').attr('placeholder', t('hotkeys.modal.listening'));
    }

    loadCapture() {
        const self = this;

        $('#hotkeyInput').on('click', function () {
            self.startRecording();
        });

        $(document).on('keydown', function (e) {
            if (!self.recordingHotkey) return;
            e.preventDefault();

            // Translated before anything is stored: a browser key name is not
            // an Electron accelerator name.
            const result = keyEventToAccelerator({
                ctrlKey: e.ctrlKey,
                altKey: e.altKey,
                shiftKey: e.shiftKey,
                metaKey: e.metaKey,
                key: e.key
            });

            if (result.status === 'pending') {
                self.recordedAccelerator = '';
                $('#hotkeyInput').val(result.display);
                return;
            }
            if (result.status === 'unsupported') {
                self.recordedAccelerator = '';
                $('#hotkeyInput').val('');
                self.showToast(t('hotkeys.error.unsupportedKey', {key: result.key}), false);
                return;
            }
            if (result.status === 'no-modifier') {
                self.recordedAccelerator = '';
                $('#hotkeyInput').val('');
                // A bare key would be swallowed system-wide, in game included
                self.showToast(t('hotkeys.error.addModifier'), false);
                return;
            }

            self.recordedAccelerator = result.accelerator;
            $('#hotkeyInput').val(result.display).attr('placeholder', result.display);
        });

        $(document).on('click', function (e) {
            if (!$(e.target).is('#hotkeyInput')) self.recordingHotkey = false;
        });

        $("#saveHotkeyBtn").on("click", () => this.saveHotkeyToFile());

        // Native listeners, not jQuery's: jQuery `.on()` treats ".bs.modal" as
        // an event namespace and never fires (same trap as the tabs in
        // options.js).
        const modal = document.getElementById('addHotkeyModal');
        if (!modal) return;

        modal.addEventListener('shown.bs.modal', () => {
            self.startRecording();
            self.suspendGlobalHotkeys(true);
        });

        // Without this a system-hotkey edit leaks into the next "Add map hotkey"
        modal.addEventListener('hidden.bs.modal', () => {
            self.restoreModalDefaults();
            self.suspendGlobalHotkeys(false);
        });

        // Minimize-to-tray hides the window with the modal still "open", so
        // `hidden.bs.modal` never fires and the app would be left holding no
        // hotkeys at all.
        document.addEventListener('visibilitychange', () => {
            if (!modal.classList.contains('show')) return;
            self.suspendGlobalHotkeys(!document.hidden);
        });
    }

    /**
     * Ask main to hold none of its global shortcuts while this dialog records.
     * Fire-and-forget: a failure costs the convenience, not the edit, and main
     * lifts the suspension by itself.
     * Why: docs/agents/hotkeys.md § Suspended while the bind dialog records.
     * @param {boolean} on
     */
    suspendGlobalHotkeys(on) {
        ipcRenderer.invoke('suspend-hotkeys', !!on).catch(err => {
            console.error('hotkeys::suspend', err && err.message);
        });
    }
}

module.exports = Hotkeys;
// Exported rather than copied into the tutorial: the escaping is load-bearing.
module.exports.acceleratorKbd = acceleratorKbd;
