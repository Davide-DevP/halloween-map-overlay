const {debugLog} = require("./logger");
const {ipcRenderer} = require('electron');
const {
    acceleratorToDisplay,
    keyEventToAccelerator,
    SYSTEM_HOTKEY_DEFS
} = require("../shared/hotkeys-constants");
const {escapeHtml} = require("../shared/escape-html");
const {t, translateMessage, onChange} = require("./i18n");

/** The translated name of a system hotkey action, from its definition. */
function actionName(def) {
    return def && def.descriptionKey ? t(def.descriptionKey) : (def && def.description) || '';
}

/** Hotkeys tab: the system hotkey table, the per-map table and key capture. */
class Hotkeys {

    constructor(maps, settings) {
        this.maps = maps;
        this.settings = settings || null;
        this.recordingHotkey = false;
        // actionId while editing a system hotkey, null while adding a map hotkey
        this.editingSystemAction = null;
        // The accelerator captured in the modal, in Electron's own spelling.
        // Kept out of the input's text so nothing has to parse it back.
        this.recordedAccelerator = '';
        this.hotkeys = {};
        this.systemHotkeys = {};
        // Both tables are built with t(), so both are rebuilt on a language
        // change. The modal is left alone: if it is open the user is mid-edit.
        onChange(() => {
            this.updateHotkeys();
            this.updateSystemHotkeysTable();
            // The picker's "Select a map…" placeholder is built in JS, not from
            // markup — `applyDom` cannot reach it once the select is rebuilt.
            this.populateMapSelect();
            this.applyModalTitle();
        });
    }

    /**
     * Title and placeholder of the bind modal, which JS owns rather than
     * `data-i18n` because both depend on state: which action is being edited,
     * and whether a key is being recorded right now.
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

    // ─── Per-map hotkey table ──────────────────────────────────

    updateHotkeys() {
        const $list = $('#hotkeyList').empty();
        const entries = Object.entries(this.hotkeys);

        if (!entries.length) {
            $list.append(`<tr><td colspan="4" class="text-secondary">${escapeHtml(t('hotkeys.empty'))}</td></tr>`);
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
                    <td class="text-center">
                        <button type="button" class="delete-row btn btn-sm btn-outline-danger"
                                data-id="${escapeHtml(id)}" title="${escapeHtml(t('hotkeys.deleteTitle'))}">${escapeHtml(t('common.delete'))}</button>
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

    // ─── System hotkey table ───────────────────────────────────

    async loadSystemHotkeys() {
        try {
            this.systemHotkeys = await ipcRenderer.invoke('get-system-hotkeys');
        } catch (err) {
            console.error("Failed to load system hotkeys:", err);
            this.systemHotkeys = {};
        }
        this.updateSystemHotkeysTable();
    }

    updateSystemHotkeysTable() {
        const $list = $('#systemHotkeyList');
        if (!$list.length) return;
        $list.empty();

        for (const [actionId, def] of Object.entries(SYSTEM_HOTKEY_DEFS)) {
            const currentAccel = this.systemHotkeys[actionId] || def.defaultAccelerator;
            const isDefault = currentAccel === def.defaultAccelerator;

            $list.append(`
                <tr data-action="${escapeHtml(actionId)}">
                    <td>${escapeHtml(actionName(def))}</td>
                    <td><kbd class="system-hotkey-binding" data-action="${escapeHtml(actionId)}">${escapeHtml(acceleratorToDisplay(currentAccel))}</kbd></td>
                    <td class="text-center">
                        <button type="button" class="edit-system-btn btn btn-sm btn-outline-primary"
                                data-action="${escapeHtml(actionId)}" title="${escapeHtml(t('hotkeys.editTitle'))}">${escapeHtml(t('common.edit'))}</button>
                    </td>
                    <td class="text-center">
                        <button type="button" class="reset-system-btn btn btn-sm btn-outline-warning"
                                data-action="${escapeHtml(actionId)}" title="${escapeHtml(t('hotkeys.resetTitle'))}"
                                ${isDefault ? 'disabled' : ''}>${escapeHtml(t('common.reset'))}</button>
                    </td>
                </tr>
            `);
        }

        const self = this;
        $('.edit-system-btn').off('click').on('click', function () {
            self.startSystemHotkeyEdit($(this).data('action'));
        });
        $('.reset-system-btn').off('click').on('click', function () {
            ipcRenderer.send('reset-system-hotkey', {actionId: $(this).data('action')});
        });
    }

    // ─── System hotkey editing ─────────────────────────────────

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

    // ─── Wiring ────────────────────────────────────────────────

    async loadHotkeys() {
        this.populateMapSelect();
        this.applyModalTitle();
        this.loadCapture();

        ipcRenderer.on('hotkey-updated', (event, hotkeys) => {
            this.hotkeys = hotkeys;
            this.updateHotkeys();
        });

        ipcRenderer.on('system-hotkeys-updated', async (event, bindings) => {
            this.systemHotkeys = bindings;
            this.updateSystemHotkeysTable();
            // Main just wrote these straight to disk; pull the file back in so
            // the next renderer-side write is not based on a stale copy.
            if (this.settings) await this.settings.refresh();
        });

        ipcRenderer.send('load-hotkeys');
        await this.loadSystemHotkeys();
        this.loadTable();
        debugLog("hotkeys::loadHotkeys::done");
    }

    populateMapSelect() {
        const $select = $("#selectMap");
        if (!$select.length) return;
        $select.empty().append($('<option>').val('').text(t('hotkeys.modal.selectMap')));

        const byCreator = {};
        for (const entry of this.maps.catalog) {
            (byCreator[entry.creator] = byCreator[entry.creator] || []).push(entry);
        }
        for (const [creator, entries] of Object.entries(byCreator)) {
            // .attr()/.text() keep user-typed custom map names out of the parser
            const $group = $('<optgroup>').attr('label', creator);
            entries.forEach(e => $group.append($('<option>').val(e.key).text(e.name)));
            $select.append($group);
        }
    }

    // ─── Key capture ───────────────────────────────────────────

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

            // Browser key names are not Electron accelerator names, and an
            // accelerator Electron cannot parse makes globalShortcut.register
            // throw — which is why this translation happens before anything is
            // stored, not at registration time.
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

        // Start listening as soon as the modal is up, however it was opened
        $('#addHotkeyModal').on('shown.bs.modal', function () {
            self.startRecording();
        });

        $('#addHotkeyModal').on('hidden.bs.modal', function () {
            self.restoreModalDefaults();
        });
    }
}

module.exports = Hotkeys;
