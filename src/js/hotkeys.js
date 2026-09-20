const {debugLog} = require("./logger");
const {ipcRenderer} = require('electron');
const {
    acceleratorToDisplay,
    keyEventToAccelerator,
    isUnbound,
    resolveSystemAccelerator,
    SYSTEM_HOTKEY_DEFS
} = require("../shared/hotkeys-constants");
const {sameAccelerator} = require("../shared/hotkeys-rules");
const {escapeHtml} = require("../shared/escape-html");
const {showStatus} = require("./status");
const {t, translateMessage, onChange} = require("./i18n");

/** The translated name of a system hotkey action, from its definition. */
function actionName(def) {
    return def && def.descriptionKey ? t(def.descriptionKey) : (def && def.description) || '';
}

/**
 * One accelerator as a row of key caps: `Ctrl+Alt+H` → `<kbd>Ctrl</kbd> +
 * <kbd>Alt</kbd> + <kbd>H</kbd>`, which is how every hotkey is drawn in the
 * FAQ and the help paragraphs.
 *
 * **Escaped**, and not as a formality: an accelerator can come straight out of
 * a hand-edited `settings-app.json`, this goes into `innerHTML`, and the
 * renderer has `nodeIntegration: true`.
 *
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
            // The two FAQ answers that name key combinations are rendered from
            // here rather than from `data-i18n-html`, so they need the hook too.
            this.updateHotkeyTexts();
        });
    }

    /**
     * Fill the FAQ answers that name key combinations with the **live**
     * bindings.
     *
     * They used to hard-code `<kbd>Ctrl</kbd> + <kbd>H</kbd>` in the catalogue,
     * which was wrong the moment anybody rebound or unbound the action — and
     * wrong for everybody once the defaults moved off plain Ctrl. The strings
     * take the accelerators as parameters instead, so there is one source for
     * "what is this action on" and the FAQ cannot drift from the table two
     * tabs away.
     */
    updateHotkeyTexts() {
        const accel = (actionId) => {
            const def = SYSTEM_HOTKEY_DEFS[actionId];
            if (!def) return '';
            return acceleratorKbd(resolveSystemAccelerator(this.systemHotkeys[actionId], def.defaultAccelerator));
        };
        // Catalogue strings with our own markup substituted into them — the
        // same contract as `data-i18n-html`, and `acceleratorKbd` escapes the
        // one part that is not from a catalogue.
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

    // ─── System hotkey table ───────────────────────────────────

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

    updateSystemHotkeysTable() {
        const $list = $('#systemHotkeyList');
        if (!$list.length) return;
        $list.empty();

        for (const [actionId, def] of Object.entries(SYSTEM_HOTKEY_DEFS)) {
            // Not `|| def.defaultAccelerator`: an action the user unbound is
            // stored as `''`, and the old fallback drew the default key cap for
            // it — a table that disagreed with what was actually registered.
            const currentAccel = resolveSystemAccelerator(this.systemHotkeys[actionId], def.defaultAccelerator);
            const unbound = isUnbound(currentAccel);
            // Unbound is not the default, so Reset stays available: it is the
            // way back to the shipped combination. Compared *normalised* like
            // every other accelerator comparison in the app — a hand-edited
            // `ctrl+alt+r` is the default and must not leave Reset enabled as
            // though it were a custom binding.
            const isDefault = sameAccelerator(currentAccel, def.defaultAccelerator);
            // A muted word rather than an empty `<kbd>`, which reads as a
            // rendering fault instead of a deliberate "no shortcut".
            const binding = unbound
                ? `<span class="hotkey-unbound">${escapeHtml(t('hotkeys.notBound'))}</span>`
                : `<kbd class="system-hotkey-binding" data-action="${escapeHtml(actionId)}">${escapeHtml(acceleratorToDisplay(currentAccel))}</kbd>`;

            $list.append(`
                <tr data-action="${escapeHtml(actionId)}">
                    <td>${escapeHtml(actionName(def))}</td>
                    <td>${binding}</td>
                    <td>
                        <span class="row-actions">
                            <button type="button" class="edit-system-btn btn btn-sm btn-quiet"
                                    data-action="${escapeHtml(actionId)}" title="${escapeHtml(t('hotkeys.editTitle'))}">${escapeHtml(t('common.edit'))}</button>
                            <button type="button" class="unbind-system-btn btn btn-sm btn-quiet"
                                    data-action="${escapeHtml(actionId)}" title="${escapeHtml(t('hotkeys.unbindTitle'))}"
                                    ${unbound ? 'disabled' : ''}>${escapeHtml(t('hotkeys.unbind'))}</button>
                            <button type="button" class="reset-system-btn btn btn-sm btn-quiet"
                                    data-action="${escapeHtml(actionId)}" title="${escapeHtml(t('hotkeys.resetTitle'))}"
                                    ${isDefault ? 'disabled' : ''}>${escapeHtml(t('common.reset'))}</button>
                        </span>
                    </td>
                </tr>
            `);
        }

        const self = this;
        $('.edit-system-btn').off('click').on('click', function () {
            self.startSystemHotkeyEdit($(this).data('action'));
        });
        // Fire and forget, like Reset: main answers with a status toast and a
        // `system-hotkeys-updated` push, which is what redraws this table.
        $('.unbind-system-btn').off('click').on('click', function () {
            ipcRenderer.send('unbind-system-hotkey', {actionId: $(this).data('action')});
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
        this.loadGameOnlySwitch();

        ipcRenderer.on('hotkey-updated', (event, hotkeys) => {
            this.hotkeys = hotkeys;
            this.updateHotkeys();
        });

        ipcRenderer.on('system-hotkeys-updated', async (event, bindings) => {
            this.systemHotkeys = bindings;
            this.updateSystemHotkeysTable();
            this.updateHotkeyTexts();
            // Main just wrote these straight to disk; pull the file back in so
            // the next renderer-side write is not based on a stale copy.
            if (this.settings) await this.settings.refresh();
        });

        ipcRenderer.send('load-hotkeys');
        await this.loadSystemHotkeys();
        this.loadTable();
        await this.collectNotice();
        debugLog("hotkeys::loadHotkeys::done");
    }

    /**
     * Settings › Hotkeys › *Only while the game is in the foreground*.
     *
     * Its own IPC handler rather than the generic `set-setting`, because main
     * has to act on it: the foreground watcher starts or stops polling and the
     * global shortcuts are registered or dropped in the same breath.
     */
    loadGameOnlySwitch() {
        const $check = $('#hotkeysGameOnlyCheck');
        if (!$check.length) return;
        // Default on: only an explicit false turns it off, like every other
        // default-on switch in this app.
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
     * One-time notices main could not show, because it decided them before
     * this window existed. Right now that is only the hotkey-defaults
     * migration; main clears the notice as it hands it over, so a renderer
     * reload cannot show it twice.
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

        // A `Map`, not an object literal. `byCreator[creator] || []` inherits
        // from `Object.prototype`, so a creator called `constructor`,
        // `toString` or `__proto__` yields a *function* (truthy) and `.push`
        // throws a TypeError — which does not break that one map, it breaks the
        // whole picker for every map. A creator is a folder name under `maps/`
        // or a downloaded pack's key half, neither of which this file gets to
        // assume anything about.
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

        // Native listeners, not jQuery's: Bootstrap dispatches these as DOM
        // events, and jQuery .on() would treat ".bs.modal" as an event
        // namespace and never fire (same trap as the tabs in options.js).
        const modal = document.getElementById('addHotkeyModal');
        if (!modal) return;

        // Start listening as soon as the modal is up, however it was opened
        modal.addEventListener('shown.bs.modal', () => {
            self.startRecording();
            self.suspendGlobalHotkeys(true);
        });

        // Without this a system-hotkey edit leaks into the next "Add map hotkey"
        modal.addEventListener('hidden.bs.modal', () => {
            self.restoreModalDefaults();
            self.suspendGlobalHotkeys(false);
        });

        // Minimize-to-tray (and a plain minimize) hides the window with the
        // modal still "open", so `hidden.bs.modal` never fires. Nothing can be
        // recorded from a hidden window anyway, and leaving the app holding no
        // hotkeys at all would be the worst possible outcome of a feature whose
        // whole point is that they work.
        document.addEventListener('visibilitychange', () => {
            if (!modal.classList.contains('show')) return;
            self.suspendGlobalHotkeys(!document.hidden);
        });
    }

    /**
     * Ask main to hold none of its global shortcuts while this dialog records.
     *
     * Without it the dialog cannot see a combination the app itself holds:
     * `RegisterHotKey` takes the keystroke before any window is told about it,
     * so pressing the current *Rotate map* hotkey inside the dialog rotated the
     * map instead of being recorded — which made swapping two bindings, or
     * moving one out of the way, impossible.
     *
     * Fire-and-forget on purpose: a failure here costs the convenience, not the
     * edit, and main lifts the suspension by itself if this window goes away.
     *
     * @param {boolean} on
     */
    suspendGlobalHotkeys(on) {
        ipcRenderer.invoke('suspend-hotkeys', !!on).catch(err => {
            console.error('hotkeys::suspend', err && err.message);
        });
    }
}

module.exports = Hotkeys;
// The welcome tour prints the same key caps on its hotkeys step. Exported
// rather than copied: the escaping is the load-bearing part (an accelerator can
// come straight out of a hand-edited settings file and this goes into
// `innerHTML`), and two copies of that rule is one too many.
module.exports.acceleratorKbd = acceleratorKbd;
