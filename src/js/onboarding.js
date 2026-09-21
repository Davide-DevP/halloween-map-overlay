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
    tabMarkersSwitchState,
    backgroundInertTargets,
    shouldRecaptureFocus,
    tabWrapTarget
} = require('../shared/onboarding-rules');
const {SIZE_MIN, SIZE_MAX, SIZE_STEP, acceleratorToDisplay} = require('../shared/hotkeys-constants');
const {resolveMapVk, vkLabel} = require('../shared/key-codes');
const {escapeHtml} = require('../shared/escape-html');
const {acceleratorKbd} = require('./hotkeys');
const {setBusy} = require('./busy');
const {t, onChange} = require('./i18n');
const {debugLog} = require('./logger');

/**
 * The first-run welcome tour: a panel over the home page, **not** a Bootstrap
 * modal. Every choice in it *mirrors* the real control in Settings; the only
 * setting it owns is `onboardingDone`.
 * See docs/agents/settings-and-onboarding.md.
 */
class Onboarding {

    constructor(options, hotkeys, detector, diagnostics) {
        this.options = options;
        this.hotkeys = hotkeys;
        this.detector = detector;
        this.diagnostics = diagnostics || null;
        this.isOpen = false;
        this.step = ONBOARDING_STEPS[0];
        /** Finished or skipped in this session. */
        this.done = false;
        /** Whatever had focus before the tour opened, so it can be given back. */
        this.returnFocus = null;
        /** A flag, never `disabled`: that blurs and kills the focus trap. */
        this.detectBusy = false;
        /** Exactly the elements this instance made `inert`, so it can undo it. */
        this.inerted = [];

        // Re-render in place with **no** focus move: the user is most likely
        // standing on the language picker that caused it.
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

        // Each mirror writes through the real control, so there is one write
        // path per setting and the tour cannot drift from Settings.
        this.mirror('#tourLanguage', '#languageSelect');
        this.mirror('#tourMonitor', '#monitorSelect');
        this.mirror('#tourCorner', '#positionLabel');
        $('#tourSize').on('input', function () {
            $('#tourSizeValue').text(t('settings.value.px', {value: Math.round(Number($(this).val()) || 0)}));
            $('#sizeRange').val($(this).val()).trigger('input');
        });

        // The home page's own start/stop path; a re-entrant click is dropped
        // rather than disabling the switch (see `detectBusy`).
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
        // refuses must not leave a ticked box behind, and Tab-map mode on the
        // same step requires auto-detect.
        this.detector.onStatus((running) => {
            $('#tourDetectCheck').prop('checked', running);
            if (self.isOpen && self.step === 'detect') self.renderDetectStep();
        });

        // Through the real switches in Settings, which own the IPC round trips.
        this.mirrorCheck('#tourTabMarkersCheck', '#tabMarkersCheck');
        this.mirrorCheck('#tourMarkersCheck', '#markersCheck');

        // `hotkey-action` is a **notification**, not a command: the toggle
        // happens in main, and this only ticks the step off.
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

        // All key handling on the panel, never on `document`: the hotkey
        // recorder owns a `document` keydown listener while it records.
        panel.addEventListener('keydown', (e) => self.onKeyDown(e));
        // A backdrop click does not dismiss, but focus has to come back inside
        // or Esc stops working.
        panel.addEventListener('mousedown', (e) => {
            if (e.target === panel) e.preventDefault();
        });

        // The focus guard. `focusout` with a null `relatedTarget` catches focus
        // falling off the document, which no keydown listener could see.
        document.addEventListener('focusin', (e) => {
            if (!shouldRecaptureFocus({open: self.isOpen, insidePanel: panel.contains(e.target)})) return;
            self.recaptureFocus();
        });
        document.addEventListener('focusout', (e) => {
            const next = e.relatedTarget;
            const insidePanel = next !== null && next !== undefined && panel.contains(next);
            if (!shouldRecaptureFocus({open: self.isOpen, insidePanel})) return;
            self.recaptureFocus();
        });

        // Minimizing makes `options.js` take the placement step's sample map
        // off the overlay. A full re-render, so the mirrors also pick up a
        // monitor unplugged while the window was away.
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

    /** Whichever handler Settings put on the real switch is the one that runs. */
    mirrorCheck(mirrorId, realId) {
        $(mirrorId).on('change', function () {
            $(realId).prop('checked', $(this).prop('checked')).trigger('input');
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
            if (state && state.onboardingDone === true) this.done = true;
            if (!shouldShowOnboarding(state)) return false;
            await this.open(ONBOARDING_STEPS[0]);
            return true;
        } catch (err) {
            // A tour that cannot decide whether to open simply does not.
            console.error('onboarding::maybeOpen', err && err.message);
            return false;
        }
    }

    async open(stepId) {
        if (this.isOpen) return;
        this.closeSettingsModal();
        this.returnFocus = document.activeElement;
        this.isOpen = true;
        // The tour has step state of its own; main must not tear this window
        // down underneath it.
        setBusy('tour', true);
        this.step = stepPosition(stepId).id;
        $('body').addClass('is-touring');
        this.setBackgroundInert(true);
        $('#tour').removeClass('d-none');
        // Next frame: a `display: none` element has no opacity to animate from,
        // so the fade needs the class change to land after the layout.
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
        if (this.returnFocus && typeof this.returnFocus.focus === 'function'
            && document.body.contains(this.returnFocus)) {
            this.returnFocus.focus();
        }
        this.returnFocus = null;
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
     * A failed write is not silent (main toasts it) but the tour is still
     * marked done **in memory**. Why: the doc § The first-run welcome tour.
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

    /** One focus trap at a time: two of them fight over Tab and over Esc. */
    closeSettingsModal() {
        const el = document.getElementById('settings');
        const modal = el && bootstrap.Modal.getInstance(el);
        if (modal) modal.hide();
    }

    /**
     * Only the elements this call changed are recorded, so one somebody else
     * had already made inert is not un-inerted by the tour closing.
     */
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

    /**
     * The dialog itself, not its first control: this runs after focus has
     * wandered, and `#tour` carries `tabindex="-1"` for exactly that.
     */
    recaptureFocus() {
        const panel = document.getElementById('tour');
        if (panel) panel.focus();
    }

    /**
     * @param {{focus?: boolean}} [opts] `focus` moves the keyboard to the new
     *   step's heading. Only on open and on a step change — never on the
     *   re-render a language change causes.
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
            case 'placement':
                this.syncMirror('#tourMonitor', '#monitorSelect');
                this.syncMirror('#tourCorner', '#positionLabel');
                // Say *why*: Settings greys the picker out while draggable.
                $('#tourCornerLocked').toggleClass('d-none', !$('#tourCorner').prop('disabled'));
                $('#tourSize').val($('#sizeRange').val());
                $('#tourSizeValue').text(t('settings.value.px', {
                    value: Math.round(Number($('#sizeRange').val()) || 0)
                }));
                break;
            case 'markers':
                this.syncCheckMirror('#tourMarkersCheck', '#markersCheck');
                break;
            case 'hotkeys':
                this.renderHotkeys();
                break;
            case 'detect':
                this.renderDetectStep();
                break;
            default:
                break;
        }

        // The preview belongs to the placement step and nowhere else.
        if (position.id === 'placement') {
            this.startPreview();
        } else {
            this.stopPreview();
        }

        if (opts.focus) this.focusStep(position.id);
    }

    renderDots(position) {
        const $dots = $('#tourDots').empty();
        ONBOARDING_STEPS.forEach((id, index) => {
            const state = index === position.index ? ' is-current' : (index < position.index ? ' is-done' : '');
            $dots.append(`<span class="tour-dot${state}"></span>`);
        });
    }

    /** One row per action, from the live bindings, plus "press it now". */
    renderHotkeys() {
        const stored = (this.hotkeys && this.hotkeys.systemHotkeys) || {};
        const conflicts = this.hotkeyConflicts();
        const $list = $('#tourHotkeyList').empty();
        for (const row of onboardingHotkeyRows(stored)) {
            // `acceleratorKbd` draws, escapes and owns the "Not bound" wording,
            // so an unbound row just passes `''`.
            $list.append(`
                <tr>
                    <td>${escapeHtml(t(row.descriptionKey))}</td>
                    <td>${acceleratorKbd(row.accelerator)}</td>
                </tr>
            `);
        }

        this.renderHotkeyConflicts(conflicts);

        const tryIt = onboardingTryIt(stored, conflicts);
        // `data-i18n-html`'s contract; `acceleratorKbd` escapes the rest.
        $('#tourTryIt').html(t(tryIt.promptKey, {toggle: acceleratorKbd(tryIt.accelerator)}));
        // Hidden again on every entry, so going back does not show a stale
        // "that was it".
        $('#tourTryItOk').addClass('d-none');
    }

    /** Both halves of the auto-detect step; neither switch is pre-ticked. */
    renderDetectStep() {
        $('#tourDetectCheck').prop('checked', this.detectorRunning());

        // All three inputs from the **real** controls, so the tour holds no
        // opinion of its own.
        const state = tabMarkersSwitchState({
            autoDetect: this.detectorRunning(),
            markers: $('#markersCheck').prop('checked'),
            tabMarkers: $('#tabMarkersCheck').prop('checked')
        });
        const $check = $('#tourTabMarkersCheck');
        $check.prop('checked', state.checked);
        this.setDisabled($check, !state.enabled, '#tourDetectCheck');

        const $blocked = $('#tourTabBlocked');
        if (state.reasonKey) {
            $blocked.removeClass('d-none').html(t(state.reasonKey));
        } else {
            $blocked.addClass('d-none').empty();
        }

        // The capture control is deliberately not duplicated here.
        $('#tourTabKey').html(t('onboarding.detect.tab.key', {
            key: `<kbd>${escapeHtml(this.mapKeyLabel())}</kbd>`
        }));
    }

    /**
     * Read from the `<kbd>` Settings renders it into, never resolved again:
     * only the browser knows what the layout calls a virtual-key code. The
     * fallback is derived, never a hard-coded "Tab".
     */
    mapKeyLabel() {
        const shown = $('#tabMarkerKeyValue').text();
        if (typeof shown === 'string' && shown.trim()) return shown.trim();
        return vkLabel(resolveMapVk(null));
    }

    hotkeyConflicts() {
        const conflicts = this.diagnostics && this.diagnostics.conflicts;
        return Array.isArray(conflicts) ? conflicts : [];
    }

    /**
     * `.text()`, never interpolated: an accelerator can come straight out of a
     * hand-edited settings file.
     */
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

    // The overlay preview, borrowed from the Overlay settings tab.
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
        // While a hotkey is being recorded the recorder owns every key.
        if (this.hotkeys && this.hotkeys.recordingHotkey) return;

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
        // `null` from the pure `tabWrapTarget` means the browser's own Tab is
        // already going somewhere inside the panel.
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
