const {ipcRenderer} = require('electron');
const {
    ONBOARDING_STEPS,
    shouldShowOnboarding,
    stepPosition,
    nextStep,
    previousStep,
    onboardingHotkeyRows,
    onboardingConflictList,
    onboardingTryIt,
    onboardingMapHotkeys,
    placementRecap,
    backgroundInertTargets,
    shouldRecaptureFocus,
    tabWrapTarget
} = require('../shared/onboarding-rules');
const {
    placementFromSettings, placementSections, autoDetectSwitchState, markerMasterNotice
} = require('../shared/map-placement');
const {SIZE_MIN, SIZE_MAX, SIZE_STEP, acceleratorToDisplay} = require('../shared/hotkeys-constants');
const {escapeHtml} = require('../shared/escape-html');
const {acceleratorKbd} = require('./hotkeys');
const {setBusy} = require('./busy');
const {t, onChange} = require('./i18n');
const {debugLog} = require('./logger');

/**
 * The setup tutorial: a panel over the home page, **not** a Bootstrap modal.
 * Every control *mirrors* the real one in Settings and writes only on user
 * input — pressing Next changes nothing. docs/agents/settings-and-onboarding.md.
 */
class Onboarding {

    constructor(options, hotkeys, detector, diagnostics) {
        this.options = options;
        this.hotkeys = hotkeys;
        this.detector = detector;
        this.diagnostics = diagnostics || null;
        this.isOpen = false;
        this.step = ONBOARDING_STEPS[0];
        /** Stamped in this session (Finish or Skip). */
        this.done = false;
        /** Whatever had focus before the tutorial opened, so it can be given back. */
        this.returnFocus = null;
        /** A flag, never `disabled`: that blurs and kills the focus trap. */
        this.detectBusy = false;
        /** Exactly the elements this instance made `inert`, so it can undo it. */
        this.inerted = [];
        /**
          * The dialogs the tutorial opened. While one is up it owns focus and
          * Esc. A Set, not a flag: two of them must not clear each other, and
          * a `show` another listener prevented emits nothing else at all.
          */
        this.openDialogs = new Set();
        this.dialogOpener = null;
        this.dialogAction = null;

        // Re-render in place, with **no** focus move: the language picker did it.
        onChange(() => {
            if (this.isOpen) this.render();
        });
    }

    async init() {
        const self = this;
        const panel = document.getElementById('tour');
        if (!panel) return;

        // From the shared constants, not a fourth copy of 50/800/25.
        $('#tourSize').attr({min: SIZE_MIN, max: SIZE_MAX, step: SIZE_STEP});

        $('#tourNext').on('click', () => self.advance());
        $('#tourBack').on('click', () => self.back());
        $('#tourSkip, #tourClose').on('click', () => self.close({done: true}));
        $('#showTourBtn').on('click', () => self.open(ONBOARDING_STEPS[0]));

        // One write path per setting: the real control in Settings owns it.
        this.mirror('#tourLanguage', '#languageSelect');
        this.mirror('#tourMonitor', '#monitorSelect');
        this.mirror('#tourCorner', '#positionLabel');
        $('#tourSize').on('input', function () {
            $('#tourSizeValue').text(t('settings.value.px', {value: Math.round(Number($(this).val()) || 0)}));
            $('#sizeRange').val($(this).val()).trigger('input');
        });
        $('#tourOpacity').on('input', function () {
            $('#tourOpacityValue').text(t('settings.value.percent', {
                value: Math.round((Number($(this).val()) || 0) * 100)
            }));
            $('#opacityRange').val($(this).val()).trigger('input');
        });

        // `Options.applyPlacement` owns the order the writes have to happen in.
        $('#tourPlacementCards input[name="tourMapPlacement"]').on('change', async function () {
            if (!self.options) return;
            await self.options.applyPlacement($(this).val());
            if (self.isOpen) self.render();
        });

        // The same recorder Settings uses — not a second one.
        if (this.options && typeof this.options.attachMapKeyRecorder === 'function') {
            this.options.attachMapKeyRecorder('#tourMapKeyBtn', '#tourMapKeyValue');
            this.options.attachMapKeyReset('#tourMapKeyReset');
            this.options.renderMapKey();
            this.options.attachMapPadRecorder('#tourMapPadBtn', '#tourMapPadValue');
            this.options.attachMapPadRemove('#tourMapPadReset');
            this.options.renderMapPad();
        }

        // A re-entrant click is dropped, never disabled (see `detectBusy`).
        $('#tourDetectCheck').on('change', async function () {
            if (self.detectBusy) {
                $(this).prop('checked', self.detectorRunning());
                return;
            }
            self.detectBusy = true;
            try {
                await self.detector.setEnabled($(this).prop('checked'));
            } finally {
                self.detectBusy = false;
            }
        });
        // Follows every status push, not just its own click: a start main
        // refuses must not leave a ticked box behind.
        this.detector.onStatus(() => {
            if (self.isOpen && self.step === 'layers') self.renderLayersStep();
        });

        // Through the real chips in Settings, which own the writes.
        this.mirrorCheck('#tourChipCellar', '#markerCellarCheck');
        this.mirrorCheck('#tourChipGate', '#markerGateCheck');
        this.mirrorCheck('#tourChipCar', '#markerCarCheck');
        this.mirrorCheck('#tourChipGas', '#markerGasCheck');
        this.mirrorCheck('#tourChipLegend', '#markerLegendCheck');
        this.mirrorCheck('#tourUpdatesCheck', '#checkForUpdatesCheck');
        $('#tourMarkersShowBtn').on('click', () => {
            $('#markersShowBtn').trigger('click');
            if (self.isOpen && self.step === 'layers') self.renderLayersStep();
        });
        $('#tourDetectStart').on('click', () => $('#autoDetectStart').trigger('click'));

        // `hotkey-action` is a **notification**: the toggle happens in main.
        ipcRenderer.on('hotkey-action', (event, info) => {
            if (!info || info.action !== 'toggle-map') return;
            if (!self.isOpen || self.step !== 'hotkeys') return;
            $('#tourTryItOk').removeClass('d-none');
        });

        // `src/js/diagnostics.js` registers its listener first, so its array is
        // already updated by the time this runs.
        ipcRenderer.on('hotkey-conflicts', () => {
            if (self.isOpen && self.step === 'hotkeys') self.renderHotkeys();
        });
        // Same reason for `src/js/hotkeys.js`: the map keys arrive on a push.
        ipcRenderer.on('hotkey-updated', () => {
            if (self.isOpen && self.step === 'hotkeys') self.renderHotkeys();
        });

        // Each row's "change" opens the **real** bind dialog, so suspension,
        // the conflict check and the toast are all the ones that already exist.
        $('#tourHotkeyList').on('click', '.tour-hotkey-change', function () {
            const actionId = $(this).attr('data-action');
            if (!actionId || !self.hotkeys) return;
            self.dialogAction = actionId;
            self.hotkeys.startSystemHotkeyEdit(actionId);
        });
        // `show`, not `shown`: Bootstrap moves focus into the dialog *before*
        // `shown`, so a guard armed there still pulls it back and Esc is dead.
        for (const id of ['addHotkeyModal', 'faqModal']) {
            const el = document.getElementById(id);
            if (!el) continue;
            el.addEventListener('show.bs.modal', () => {
                self.openDialogs.add(id);
                const active = document.activeElement;
                self.dialogOpener = (active && panel.contains(active)) ? active : null;
                // A prevented `show` fires nothing further, so confirm from the
                // DOM one frame later rather than letting the entry stick.
                requestAnimationFrame(() => {
                    if (!el.classList.contains('show')) self.openDialogs.delete(id);
                });
            });
            // On `hide` as well as `hidden`: focus leaves during the fade, and
            // the guard has to be allowed to catch it.
            el.addEventListener('hide.bs.modal', () => self.openDialogs.delete(id));
            el.addEventListener('hidden.bs.modal', () => {
                self.openDialogs.delete(id);
                if (!self.isOpen) return;
                self.restoreDialogFocus();
            });
        }

        // All key handling on the panel, never on `document`: the hotkey
        // recorder owns a `document` keydown listener while it records.
        panel.addEventListener('keydown', (e) => self.onKeyDown(e));
        // A backdrop click does not dismiss, but focus has to come back inside.
        panel.addEventListener('mousedown', (e) => {
            if (e.target === panel) e.preventDefault();
        });

        // The focus guard. `focusout` with a null `relatedTarget` catches focus
        // falling off the document, which no keydown listener could see.
        document.addEventListener('focusin', (e) => {
            if (!shouldRecaptureFocus({
                open: self.isOpen,
                insidePanel: panel.contains(e.target),
                dialogOpen: self.anyDialogOpen()
            })) return;
            self.recaptureFocus();
        });
        document.addEventListener('focusout', (e) => {
            const next = e.relatedTarget;
            const insidePanel = next !== null && next !== undefined && panel.contains(next);
            if (!shouldRecaptureFocus({
                open: self.isOpen,
                insidePanel,
                dialogOpen: self.anyDialogOpen()
            })) return;
            self.recaptureFocus();
        });

        // A full re-render: the mirrors also pick up a monitor unplugged while
        // the window was away.
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && self.isOpen) self.render();
        });
    }

    /** @param {string} realId the control in the Settings modal */
    mirror(mirrorId, realId) {
        $(mirrorId).on('input', function () {
            $(realId).val($(this).val()).trigger('input');
        });
    }

    /** The real control's handler does the writing; one event, or it writes twice. */
    mirrorCheck(mirrorId, realId) {
        $(mirrorId).on('change', function () {
            const $real = $(realId).prop('checked', $(this).prop('checked'));
            $real.trigger($real.attr('role') === 'switch' ? 'input' : 'change');
        });
    }

    syncCheckMirror(mirrorId, realId) {
        const $real = $(realId);
        if (!$real.length) return;
        $(mirrorId).prop('checked', $real.prop('checked'));
    }

    /**
     * Disable without blurring — see `detectBusy`.
     * @param {string} fallbackId selector to focus if `$el` had the keyboard
     */
    setDisabled($el, disabled, fallbackId) {
        if (!$el.length) return;
        if (disabled && $el[0] === document.activeElement) {
            const $fallback = $(fallbackId);
            if ($fallback.length) $fallback.trigger('focus');
            else this.recaptureFocus();
        }
        $el.prop('disabled', disabled);
    }

    /**
     * Options, value **and disabled state**: `.trigger()` runs a handler
     * whether or not its element is disabled, so a mirror that looked enabled
     * would write a setting the real control is refusing. Options are cloned,
     * never rebuilt: OS display names must not be interpolated into markup.
     */
    syncMirror(mirrorId, realId) {
        const $real = $(realId);
        if (!$real.length) return;
        $(mirrorId)
            .empty()
            .append($real.children().clone())
            .val($real.val())
            .prop('disabled', $real.prop('disabled'));
    }

    /** Open by itself if this install is owed it — `shouldShowOnboarding`. */
    async maybeOpen() {
        try {
            const state = await ipcRenderer.invoke('get-onboarding-state');
            debugLog('onboarding::state', JSON.stringify(state));
            if (!shouldShowOnboarding(state)) return false;
            await this.open(ONBOARDING_STEPS[0]);
            return true;
        } catch (err) {
            // A tutorial that cannot decide whether to open simply does not.
            console.error('onboarding::maybeOpen', err && err.message);
            return false;
        }
    }

    async open(stepId) {
        if (this.isOpen) return;
        // **Before** `is-touring` goes on: that class raises the dialogs, and a
        // Settings modal still fading out would be raised with them.
        await this.closeSettingsModal();
        this.returnFocus = document.activeElement;
        this.isOpen = true;
        // Step state of its own: main must not tear this window down under it.
        setBusy('tour', true);
        this.step = stepPosition(stepId).id;
        $('body').addClass('is-touring');
        this.setBackgroundInert(true);
        $('#tour').removeClass('d-none');
        // Next frame: a `display: none` element has no opacity to animate from.
        requestAnimationFrame(() => $('#tour').addClass('is-open'));
        this.render({focus: true});
        debugLog('onboarding::open', this.step);
    }

    /** @param {{done?: boolean}} [opts] Skip, Esc and Finish all pass `done` */
    async close(opts = {}) {
        if (!this.isOpen) return;
        // First, so the focus guard is off before anything moves the keyboard.
        this.isOpen = false;
        setBusy('tour', false);
        try {
            this.stopPreview();
            $('#tour').addClass('d-none').removeClass('is-open');
            $('body').removeClass('is-touring');
        } finally {
            // The one line that *must* run: a throw above it would leave the
            // whole page `inert` — no focus, no clicks, only a restart.
            this.setBackgroundInert(false);
        }
        this.restoreReturnFocus();
        if (opts.done) await this.markDone();
        debugLog('onboarding::close', opts.done ? 'done' : 'open-again');
    }

    async advance() {
        const next = nextStep(this.step);
        if (next === null) {
            await this.close({done: true});
            return;
        }
        this.goTo(next);
    }

    back() {
        const previous = previousStep(this.step);
        if (previous !== null) this.goTo(previous);
    }

    goTo(stepId) {
        this.step = stepPosition(stepId).id;
        this.render({focus: true});
    }

    /**
     * Stamps `tourSeenVersion` as well as `onboardingDone` (one handler in
     * main), on Finish **and** on Skip. A failed write is not silent, but the
     * tutorial is still marked done **in memory** — why: the doc.
     */
    async markDone() {
        if (this.done) return;
        try {
            const result = await ipcRenderer.invoke('set-onboarding-done', true);
            if (!result || result.ok === false) debugLog('onboarding::markDone::write-failed');
        } catch (err) {
            console.error('onboarding::markDone', err && err.message);
        }
        this.done = true;
    }

    /**
     * One focus trap at a time: two fight over Tab and Esc. Waited on with a
     * deadline, so a transition that never finishes cannot block the tutorial.
     */
    closeSettingsModal() {
        const el = document.getElementById('settings');
        const modal = el && bootstrap.Modal.getInstance(el);
        if (!modal || !el.classList.contains('show')) return Promise.resolve();
        return new Promise((resolve) => {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                resolve();
            };
            el.addEventListener('hidden.bs.modal', finish, {once: true});
            setTimeout(finish, 600);
            modal.hide();
        });
    }

    /** Only what this call made `inert` is recorded, so it undoes exactly that. */
    setBackgroundInert(on) {
        if (!on) {
            for (const element of this.inerted) element.inert = false;
            this.inerted = [];
            return;
        }
        const children = Array.from(document.body.children);
        const described = children.map(el => ({id: el.id, className: el.className}));
        this.inerted = [];
        for (const index of backgroundInertTargets(described)) {
            const element = children[index];
            if (element.inert) continue;
            element.inert = true;
            this.inerted.push(element);
        }
    }

    anyDialogOpen() {
        return this.openDialogs.size > 0;
    }

    /**
     * Is this element still something the keyboard can be given to? `contains`
     * alone is not enough: focusing a hidden element lands focus on `<body>`,
     * after which Tab restarts at the top of the page.
     */
    static focusable(element) {
        if (!element || typeof element.focus !== 'function') return false;
        if (!document.body.contains(element)) return false;
        return element.offsetParent !== null || element.getClientRects().length > 0;
    }

    /** Whatever had the keyboard before, or the menu item that leads back. */
    restoreReturnFocus() {
        const previous = this.returnFocus;
        this.returnFocus = null;
        if (Onboarding.focusable(previous)) {
            previous.focus();
            return;
        }
        const fallback = document.getElementById('settingsLink');
        if (fallback) fallback.focus();
    }

    /**
     * Back to the control that opened the dialog. `renderHotkeys` rebuilds the
     * rows, so the row for the same action is the fallback, the panel the last.
     */
    restoreDialogFocus() {
        const opener = this.dialogOpener;
        const action = this.dialogAction;
        this.dialogOpener = null;
        this.dialogAction = null;
        if (this.step === 'hotkeys') this.renderHotkeys();
        if (Onboarding.focusable(opener)) {
            opener.focus();
            return;
        }
        const $again = $('#tourHotkeyList .tour-hotkey-change')
            .filter(function () { return action && $(this).attr('data-action') === action; });
        if ($again.length) $again.first().trigger('focus');
        else this.recaptureFocus();
    }

    /** The panel itself, not its first control — `#tour` has `tabindex="-1"`. */
    recaptureFocus() {
        const panel = document.getElementById('tour');
        if (panel) panel.focus();
    }

    /**
     * @param {{focus?: boolean}} [opts] `focus` moves the keyboard to the new
     *   step's heading; only on open and on a step change, never on a re-render
     */
    render(opts = {}) {
        if (!this.isOpen) return;
        const position = stepPosition(this.step);
        this.step = position.id;

        $('#tourProgress').text(t('onboarding.progress', {
            number: position.number,
            total: position.total
        }));

        $('#tour .tour-step').each(function () {
            $(this).toggleClass('d-none', $(this).attr('data-tour-step') !== position.id);
        });

        this.renderDots(position);

        $('#tourBack').prop('disabled', position.first);
        // On the last step Finish does what Skip does, so Skip goes away.
        $('#tourSkip').toggleClass('d-none', position.last);
        $('#tourNext').text(position.last ? t('onboarding.finish') : t('onboarding.next'));

        switch (position.id) {
            case 'welcome':
                this.syncMirror('#tourLanguage', '#languageSelect');
                break;
            case 'where':
                this.renderWhereStep();
                break;
            case 'setup':
                this.renderSetupStep();
                break;
            case 'layers':
                this.renderLayersStep();
                break;
            case 'hotkeys':
                this.renderHotkeys();
                break;
            case 'done':
                this.renderDoneStep();
                break;
            default:
                break;
        }

        // The sample map belongs to the step that places it, corner half only.
        if (position.id === 'setup' && placementSections(this.placement()).corner) {
            this.startPreview();
        } else {
            this.stopPreview();
        }

        if (opts.focus) this.focusStep(position.id);
    }

    /** Read from the settings file, never held here: no parallel state. */
    placement() {
        const settings = this.options && this.options.settings;
        return placementFromSettings(settings ? settings.all() : null);
    }

    renderDots(position) {
        const $dots = $('#tourDots').empty();
        ONBOARDING_STEPS.forEach((id, index) => {
            const state = index === position.index ? ' is-current' : (index < position.index ? ' is-done' : '');
            $dots.append(`<span class="tour-dot${state}"></span>`);
        });
    }

    renderWhereStep() {
        $('#tourPlacementCards input[name="tourMapPlacement"]')
            .prop('checked', false)
            .filter(`[value="${this.placement()}"]`).prop('checked', true);
    }

    /** Which half of step 3 the choice on step 2 asks for. */
    renderSetupStep() {
        const sections = placementSections(this.placement());
        $('#tourCornerBlock').toggleClass('d-none', !sections.corner);
        $('#tourKeyBlock').toggleClass('d-none', !sections.gameMap);
        this.syncMirror('#tourMonitor', '#monitorSelect');
        this.syncMirror('#tourCorner', '#positionLabel');
        // Say *why*: Settings greys the picker out once the map was hand-placed.
        $('#tourCornerLocked').toggleClass('d-none', !$('#tourCorner').prop('disabled'));
        $('#tourSize').val($('#sizeRange').val());
        $('#tourSizeValue').text(t('settings.value.px', {
            value: Math.round(Number($('#sizeRange').val()) || 0)
        }));
        $('#tourOpacity').val($('#opacityRange').val());
        $('#tourOpacityValue').text(t('settings.value.percent', {
            value: Math.round((Number($('#opacityRange').val()) || 0) * 100)
        }));
        if (this.options && typeof this.options.renderMapKey === 'function') {
            this.options.renderMapKey();
        }
    }

    /**
     * The chips and the auto-recognise switch, all from the **real** controls:
     * the tutorial holds no opinion of its own. The switch is locked on exactly
     * when the placement needs it (`autoDetectSwitchState`).
     */
    renderLayersStep() {
        this.syncCheckMirror('#tourChipCellar', '#markerCellarCheck');
        this.syncCheckMirror('#tourChipGate', '#markerGateCheck');
        this.syncCheckMirror('#tourChipCar', '#markerCarCheck');
        this.syncCheckMirror('#tourChipGas', '#markerGasCheck');
        this.syncCheckMirror('#tourChipLegend', '#markerLegendCheck');
        // Every chip on with nothing on screen: the notice Settings shows.
        const settings = this.options && this.options.settings;
        const notice = markerMasterNotice(settings ? settings.raw('markers') : undefined);
        $('#tourMarkersHidden').toggleClass('d-none', !notice.hidden);

        const auto = autoDetectSwitchState(this.placement(), this.detectorRunning());
        const $check = $('#tourDetectCheck');
        $check.prop('checked', auto.checked);
        this.setDisabled($check, auto.disabled, '#tourNext');
        // The reason, and the button, come straight from the pure state: with a
        // game's-map placement whose loop is off, only a click may start it.
        $('#tourDetectHelp').text(auto.blocked
            ? t(auto.reasonKey)
            : (auto.disabled ? t(auto.reasonKey) : t('onboarding.layers.detect.help')));
        $('#tourDetectStart').toggleClass('d-none', !auto.blocked);
    }

    renderDoneStep() {
        this.syncCheckMirror('#tourUpdatesCheck', '#checkForUpdatesCheck');
        const recap = placementRecap(this.placement());
        $('#tourRecap').text(t('onboarding.done.recap', {placement: t(recap.labelKey)}));
    }

    /** One row per action, from the live bindings, plus "press it now". */
    renderHotkeys() {
        const stored = (this.hotkeys && this.hotkeys.systemHotkeys) || {};
        const conflicts = this.hotkeyConflicts();
        const $list = $('#tourHotkeyList').empty();
        const change = escapeHtml(t('onboarding.hotkeys.change'));
        for (const row of onboardingHotkeyRows(stored)) {
            // `acceleratorKbd` escapes and owns the "no key" wording.
            $list.append(`
                <tr>
                    <td>${escapeHtml(t(row.descriptionKey))}</td>
                    <td>${acceleratorKbd(row.accelerator)}
                        <button type="button" class="btn btn-link btn-sm p-0 linkish ms-2 tour-hotkey-change"
                                data-action="${escapeHtml(row.actionId)}">${change}</button></td>
                </tr>
            `);
        }

        this.renderHotkeyConflicts(conflicts);

        // The map keys are read live, from `hotkeys.json`, never hard-coded.
        const maps = onboardingMapHotkeys(this.hotkeys && this.hotkeys.hotkeys);
        $('#tourHotkeyMaps').html(maps.keys.length
            ? t(maps.promptKey, {keys: maps.keys.map(acceleratorKbd).join(', ')})
            : t(maps.promptKey));

        const tryIt = onboardingTryIt(stored, conflicts);
        // `data-i18n-html`'s contract; `acceleratorKbd` escapes the rest.
        $('#tourTryIt').html(t(tryIt.promptKey, {toggle: acceleratorKbd(tryIt.accelerator)}));
        // Hidden again on every entry: going back must not show a stale "that was it".
        $('#tourTryItOk').addClass('d-none');
    }

    hotkeyConflicts() {
        const conflicts = this.diagnostics && this.diagnostics.conflicts;
        return Array.isArray(conflicts) ? conflicts : [];
    }

    /** `.text()`: an accelerator can come straight out of a hand-edited file. */
    renderHotkeyConflicts(conflicts) {
        const $banner = $('#tourHotkeyConflict').empty();
        const list = onboardingConflictList(conflicts);
        if (!list.length) {
            $banner.addClass('d-none');
            return;
        }
        $banner
            .removeClass('d-none')
            .append($('<strong>').text(t('hotkeyConflict.title')))
            .append(document.createTextNode(' '))
            .append($('<span>').text(list.map(acceleratorToDisplay).join(', ')))
            .append(document.createTextNode(' '))
            .append($('<span>').text(t('hotkeyConflict.help')));
    }

    focusStep(stepId) {
        const heading = document.querySelector(`.tour-step[data-tour-step="${stepId}"] .tour-title`);
        if (!heading) return;
        // -1, not 0: hold focus without becoming a tab stop.
        heading.setAttribute('tabindex', '-1');
        heading.focus();
    }

    // The overlay preview, borrowed from the Map settings tab.
    startPreview() {
        if (!this.options || this.options.previewActive) return;
        this.options.startPreview();
    }

    stopPreview() {
        if (!this.options || !this.options.previewActive) return;
        this.options.stopPreview();
    }

    detectorRunning() {
        const status = this.detector && this.detector.lastStatus;
        return !!(status && status.running);
    }

    onKeyDown(e) {
        if (!this.isOpen) return;
        // While a hotkey is recorded the recorder owns every key, the dialog Esc.
        if (this.anyDialogOpen()) return;
        if (this.hotkeys && this.hotkeys.recordingHotkey) return;
        // The map-key recorder is armed on a button *inside* this panel.
        if (this.options && this.options.recordingMapKey) return;

        if (e.key === 'Escape') {
            e.preventDefault();
            this.close({done: true});
            return;
        }
        if (e.key === 'Tab') this.trapTab(e);
    }

    /** Keep Tab inside the panel, both directions. */
    trapTab(e) {
        const panel = document.getElementById('tour');
        const items = this.focusableItems();
        if (!items.length) {
            e.preventDefault();
            return;
        }
        const active = document.activeElement;
        // `null` = the browser's own Tab is already going somewhere inside.
        const target = tabWrapTarget({
            insidePanel: !!(active && panel.contains(active)),
            shiftKey: e.shiftKey === true,
            atFirst: active === items[0],
            atLast: active === items[items.length - 1]
        });
        if (target === null) return;
        e.preventDefault();
        (target === 'first' ? items[0] : items[items.length - 1]).focus();
    }

    focusableItems() {
        return $('#tour')
            .find('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')
            .filter(':visible')
            .toArray();
    }
}

module.exports = Onboarding;
