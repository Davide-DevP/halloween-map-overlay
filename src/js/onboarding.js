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
 * The first-run welcome tour: five steps in a panel over the home page
 * (`#tour` in `src/index.html`).
 *
 * ## No parallel state
 *
 * Every choice in the tour is the **same control** as in Settings. The tour's
 * own selects and sliders are mirrors: a change writes the value into the real
 * control and fires its `input` event, so `src/js/options.js` does the saving,
 * the overlay refresh and the glide snap exactly as it does when the user drags
 * the real slider. The auto-detect switch goes through `Detector.setEnabled`,
 * which is the home-page switch's own path. Nothing here calls
 * `Settings.set` itself, and the tour holds no copy of any setting.
 *
 * The one setting it owns is `onboardingDone`, and that has its own IPC handler
 * (`set-onboarding-done`) because it is the one write whose **failure** this
 * side has to see: `set-setting` answers with the settings object, which cannot
 * say no.
 *
 * ## Why it is not a Bootstrap modal, and what that costs
 *
 * It opens at most once by itself; it is reopened from *inside* the Settings
 * modal, which it closes first so there is only ever one focus trap; and its
 * key handling has to stay out of the way of the hotkey recorder, which listens
 * on `document` keydown while it is recording. So every key the tour handles is
 * caught on the `#tour` element, and the handler still bails out while a hotkey
 * is being recorded — belt and braces.
 *
 * Not being a modal means the three things Bootstrap would have done have to be
 * done here, and **all three are needed**: a keydown listener on the panel is
 * only ever reached while focus is inside it, and a click on a paragraph, a
 * table or an alert moves focus to the nearest focusable ancestor — of which
 * there was none. Focus went to `<body>`, after which Esc was dead and Tab
 * walked the page *behind* the backdrop (Enter on an invisible map card
 * changing the overlay). So:
 *
 * 1. `tabindex="-1"` on `#tour` (in the markup), so such a click lands focus on
 *    the dialog itself.
 * 2. `inert` on every other top-level region while the tour is open, so the
 *    page behind is not tabbable, not clickable and not in the a11y tree
 *    (`backgroundInertTargets`; removed again on **every** close path).
 * 3. A `focusin`/`focusout` guard on `document` that pulls focus back whenever
 *    it leaves the panel — `focusin`, deliberately not a second `document`
 *    keydown listener, so it cannot collide with the hotkey recorder.
 *
 * ## Ordering against the rest of the first minute
 *
 * The tour is the **last** thing the load sequence does (it opens from the
 * `#loadingOverlay` slide-up callback in `src/renderer.js`), after the crash
 * notice, the hotkey-conflict banner, the update banner and the
 * hotkey-defaults notice have all been collected — so none of them can push
 * itself on top of an open panel. Two of those cannot happen on a fresh install
 * at all: nothing has crashed yet, and `planHotkeyDefaultsMigration` returns
 * early when `freshInstall` is set. The banners that can (an update, a hotkey
 * another app already owns) stay on the page behind the backdrop and are still
 * there when the tour closes. The status toast and the hotkey toast sit
 * *above* the tour on purpose — see `--hmo-z-tour` in `src/css/app.css`.
 */
class Onboarding {

    /**
     * @param {Object} options `src/js/options.js` — owns the real settings
     *   controls and the overlay preview the placement step shows.
     * @param {Object} hotkeys `src/js/hotkeys.js` — holds the live system
     *   bindings and the `recordingHotkey` flag.
     * @param {Object} detector `src/js/detector.js` — the auto-detect switch.
     * @param {Object} [diagnostics] `src/js/diagnostics.js` — holds the live
     *   hotkey-conflict list, whose home-page banner is behind the backdrop
     *   while the tour is open.
     */
    constructor(options, hotkeys, detector, diagnostics) {
        this.options = options;
        this.hotkeys = hotkeys;
        this.detector = detector;
        this.diagnostics = diagnostics || null;
        this.isOpen = false;
        /** Current step id. */
        this.step = ONBOARDING_STEPS[0];
        /** True once the tour has been finished or skipped in this session. */
        this.done = false;
        /** Whatever had focus before the tour opened, so it can be given back. */
        this.returnFocus = null;
        /**
         * True while the auto-detect switch is waiting for main.
         *
         * A flag rather than `disabled` on the checkbox: disabling the element
         * that currently has focus blurs it, and nothing focused it again — so
         * one click on the switch broke Esc and the Tab trap for the rest of
         * the tour.
         */
        this.detectBusy = false;
        /** Exactly the elements this instance made `inert`, so it can undo it. */
        this.inerted = [];

        // A language change re-renders the tour in place: every line of it is
        // either `data-i18n` markup (which `applyDom` has already refreshed by
        // the time this runs) or built with `t()` here. No focus move — the
        // user is most likely standing on the language picker that caused it.
        onChange(() => {
            if (this.isOpen) this.render();
        });
    }

    async init() {
        const self = this;
        const panel = document.getElementById('tour');
        if (!panel) return;

        // The size mirror's bounds come from the shared constants rather than
        // from a fourth copy of 50/800/25 in the markup.
        $('#tourSize').attr({min: SIZE_MIN, max: SIZE_MAX, step: SIZE_STEP});

        $('#tourNext').on('click', () => self.advance());
        $('#tourBack').on('click', () => self.back());
        $('#tourSkip, #tourClose').on('click', () => self.close({done: true}));
        $('#showTourBtn').on('click', () => self.open(ONBOARDING_STEPS[0]));

        // ── The mirrors. Each one writes through the real control, so there is
        // one write path per setting and the tour cannot drift from Settings.
        this.mirror('#tourLanguage', '#languageSelect');
        this.mirror('#tourMonitor', '#monitorSelect');
        this.mirror('#tourCorner', '#positionLabel');
        $('#tourSize').on('input', function () {
            $('#tourSizeValue').text(t('settings.value.px', {value: Math.round(Number($(this).val()) || 0)}));
            $('#sizeRange').val($(this).val()).trigger('input');
        });

        // The auto-detect step's switch: the home page's own start/stop path.
        // The element is **never disabled** while it waits — that blurs it and
        // takes the focus trap down with it. A re-entrant click is dropped, and
        // the status push below is what puts the box right afterwards.
        $('#tourDetectCheck').on('change', async function () {
            if (self.detectBusy) {
                // Put the box back where the loop actually is; the push that
                // follows the in-flight call will confirm it.
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
        // …and it follows every status push, not just its own click: a start
        // main refuses must not leave a ticked box behind. Tab-map mode sits on
        // the same step and **requires** auto-detect, so its switch and its
        // explanation are redrawn from the same push rather than only on entry.
        this.detector.onStatus((running) => {
            $('#tourDetectCheck').prop('checked', running);
            if (self.isOpen && self.step === 'detect') self.renderDetectStep();
        });

        // Markers on the game's own map. Written through the real switch in
        // Settings › Overlay, which owns the `set-tab-markers` round trip —
        // main has to start or stop a window and a capture loop, so it cannot
        // go through `set-setting`.
        this.mirrorCheck('#tourTabMarkersCheck', '#tabMarkersCheck');
        // The markers master switch, one step earlier. Also the thing that
        // decides whether Tab-map mode has anything to draw.
        this.mirrorCheck('#tourMarkersCheck', '#markersCheck');

        // The "try it" acknowledgement. The hotkey reaches this window because
        // this app's own windows count as the foreground for `hotkeysGameOnly`,
        // so it really does fire while the tour is on screen.
        //
        // `hotkey-action` is a **notification**, not a command: since 0.7 the
        // toggle itself happens in main (`core/map-controller.js`), which is
        // what lets a hotkey work with no window at all. Nothing here acts on
        // it beyond ticking the step off.
        ipcRenderer.on('hotkey-action', (event, info) => {
            if (!info || info.action !== 'toggle-map') return;
            if (!self.isOpen || self.step !== 'hotkeys') return;
            $('#tourTryItOk').removeClass('d-none');
        });

        // A hotkey another application already owns is reported on this channel
        // (`src/js/diagnostics.js` keeps the list; its listener is registered
        // first, so the array is already updated by the time this runs). The
        // hotkeys step carries its own copy of that warning, because the
        // home-page banner is behind the backdrop.
        ipcRenderer.on('hotkey-conflicts', () => {
            if (self.isOpen && self.step === 'hotkeys') self.renderHotkeys();
        });

        // All key handling lives on the panel, never on `document`: the hotkey
        // recorder owns a `document` keydown listener while it is recording, and
        // the two must not swallow each other's keys.
        panel.addEventListener('keydown', (e) => self.onKeyDown(e));
        // Clicking the backdrop does not dismiss — losing the tour to a stray
        // click would be worse than one more click to skip it — but focus has
        // to come back inside, or Esc would stop working.
        panel.addEventListener('mousedown', (e) => {
            if (e.target === panel) e.preventDefault();
        });

        // ── The focus guard. `focusin`/`focusout` rather than a second
        // `document` keydown listener, so there is nothing for the hotkey
        // recorder to collide with. `focusin` catches focus arriving somewhere
        // outside (a Tab that escaped, a programmatic focus); `focusout` with a
        // null `relatedTarget` catches focus falling off the document
        // altogether, which is the case no keydown listener could ever see.
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

        // The placement step puts a sample map on the real overlay. Minimizing
        // (or minimize-to-tray) makes `options.js` take it off again; coming
        // back has to put it there, or the step would describe something that
        // is no longer on screen. A full re-render rather than just the
        // preview, so the mirrors pick up anything that changed while the
        // window was away — a monitor unplugged, say.
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && self.isOpen) self.render();
        });
    }

    /**
     * Point a tour control at the real one in Settings.
     *
     * The options are **cloned** from the real select rather than rebuilt: the
     * monitor list is built from OS-supplied display names (which this app
     * never interpolates into markup) and the corner list carries its own
     * `data-i18n` attributes, so cloning keeps one source for both.
     *
     * @param {string} mirrorId selector of the tour's control
     * @param {string} realId selector of the control in the Settings modal
     */
    mirror(mirrorId, realId) {
        $(mirrorId).on('input', function () {
            $(realId).val($(this).val()).trigger('input');
        });
    }

    /**
     * The same idea for a switch: the tour's box sets the real one and fires
     * its `input` event, so whichever handler Settings put on it — a plain
     * `set-setting` for the marker switches, the `set-tab-markers` round trip
     * for Tab-map mode — is the one that runs. The tour writes no setting.
     */
    mirrorCheck(mirrorId, realId) {
        $(mirrorId).on('change', function () {
            $(realId).prop('checked', $(this).prop('checked')).trigger('input');
        });
    }

    /** Copy a real switch's state into its mirror. */
    syncCheckMirror(mirrorId, realId) {
        const $real = $(realId);
        if (!$real.length) return;
        $(mirrorId).prop('checked', $real.prop('checked'));
    }

    /**
     * Disable a control without ever blurring it.
     *
     * Disabling the element that currently has focus drops focus on the floor,
     * which is how the panel lost Esc and its Tab trap once already. If the
     * control being switched off is the focused one, the keyboard is moved to a
     * sibling that is staying — inside the panel either way.
     *
     * @param {Object} $el jQuery element
     * @param {boolean} disabled
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
     * Copy the real control's options, value **and disabled state** into the
     * mirror. The last one matters: Settings disables the corner picker while
     * the overlay is draggable, and `.trigger()` runs a handler whether or not
     * its element is disabled — so a mirror that looked enabled would write a
     * setting the real control is refusing to take.
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

    /**
     * Open the tour by itself, if this install is owed it.
     *
     * The decision is the pure `shouldShowOnboarding`, over the two stored
     * flags main hands over: was this user ever owed the tour
     * (`onboardingPending`, written once on the start that created the settings
     * file) and has it been seen (`onboardingDone`). A first run abandoned
     * before Skip or Finish therefore still gets it next time.
     */
    async maybeOpen() {
        try {
            const state = await ipcRenderer.invoke('get-onboarding-state');
            debugLog('onboarding::state', JSON.stringify(state));
            if (state && state.onboardingDone === true) this.done = true;
            if (!shouldShowOnboarding(state)) return false;
            await this.open(ONBOARDING_STEPS[0]);
            return true;
        } catch (err) {
            // A tour that cannot decide whether to open simply does not: it is
            // the least important thing happening on this window.
            console.error('onboarding::maybeOpen', err && err.message);
            return false;
        }
    }

    async open(stepId) {
        if (this.isOpen) return;
        this.closeSettingsModal();
        this.returnFocus = document.activeElement;
        this.isOpen = true;
        // The tour drives the real Settings controls and has its own step
        // state; main must not tear this window down underneath it.
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

    /**
     * @param {{done?: boolean}} [opts] `done` marks the tour as seen — Skip,
     *   Esc and Finish all do.
     */
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
            // Every close path goes through here, which is what makes it safe
            // to leave the page inert until now: Skip, Esc, Finish and a reopen
            // all end up in this one method. In a `finally` because it is the
            // one line that *must* run: `stopPreview` talks to main, and a
            // throw above this would leave the whole page `inert` — no focus,
            // no clicks, nothing to do but restart the app.
            this.setBackgroundInert(false);
        }
        // Give the keyboard back where it came from (the Settings button, or
        // the document on a first run).
        if (this.returnFocus && typeof this.returnFocus.focus === 'function'
            && document.body.contains(this.returnFocus)) {
            this.returnFocus.focus();
        }
        this.returnFocus = null;
        if (opts.done) await this.markDone();
        debugLog('onboarding::close', opts.done ? 'done' : 'open-again');
    }

    /** Next, or Finish on the last step. */
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
     * Remember that the tour has been seen.
     *
     * A failed write is **not** silent — main already shows the throttled
     * `settings.error.writeFailed` toast, which sits above the tour on purpose.
     * It is still marked done in memory, and that is a deliberate trade: the
     * alternative is a panel that reopens on top of a user who has already
     * dismissed it. Across restarts it can only come back if
     * `settings-app.json` could not be written at all — which is also the only
     * state in which `onboardingPending` keeps being set (`core/settings.js`
     * re-marks it on every start that finds no file), and in that state nothing
     * else the user changes survives a restart either. A tour that greets them
     * again is the least of that problem; being unable to get rid of it would
     * be a new one.
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
     * Close the Settings modal the tour was reopened from. One focus trap at a
     * time: two of them fight over Tab and over Esc.
     */
    closeSettingsModal() {
        const el = document.getElementById('settings');
        const modal = el && bootstrap.Modal.getInstance(el);
        if (modal) modal.hide();
    }

    // ─── Keeping the panel modal ───────────────────────────────

    /**
     * Make the rest of the window `inert` while the tour is open, and undo
     * exactly that on close.
     *
     * `inert` is what makes the page behind the backdrop untabbable,
     * unclickable and invisible to a screen reader — without it the keyboard
     * could walk into the gallery and press a map card nobody can see. The
     * element list comes from the pure `backgroundInertTargets`, and only the
     * elements this call actually changed are recorded: an element somebody
     * else had already made inert must not be un-inerted by the tour closing.
     *
     * @param {boolean} on
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
     * Put the keyboard back on the dialog itself.
     *
     * The dialog, not the first control: this runs after focus has wandered
     * (or fallen off the document), and yanking it onto the close button would
     * be a surprise on top of a surprise. `#tour` carries `tabindex="-1"`, so
     * it can hold focus without becoming a tab stop, and Tab from there moves
     * to the first control inside.
     */
    recaptureFocus() {
        const panel = document.getElementById('tour');
        if (panel) panel.focus();
    }

    // ─── Rendering ─────────────────────────────────────────────

    /**
     * @param {{focus?: boolean}} [opts] `focus` moves the keyboard to the new
     *   step's heading. Only on open and on a step change — a language change
     *   re-renders too, and stealing focus from the picker that caused it would
     *   be the rudest possible response.
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
        // On the last step Finish is the only way out that makes sense, and it
        // does exactly what Skip does, so the second button goes away.
        $('#tourSkip').toggleClass('d-none', position.last);
        $('#tourNext').text(position.last ? t('onboarding.finish') : t('onboarding.next'));

        switch (position.id) {
            case 'welcome':
                this.syncMirror('#tourLanguage', '#languageSelect');
                break;
            case 'placement':
                this.syncMirror('#tourMonitor', '#monitorSelect');
                this.syncMirror('#tourCorner', '#positionLabel');
                // Say *why* the corner picker is greyed out. Settings disables
                // it while the overlay is draggable, which is reachable
                // whenever the tour is reopened later.
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

    /**
     * The hotkeys step: one row per action, from the live bindings, plus the
     * "press it now" sentence.
     */
    renderHotkeys() {
        const stored = (this.hotkeys && this.hotkeys.systemHotkeys) || {};
        const conflicts = this.hotkeyConflicts();
        const $list = $('#tourHotkeyList').empty();
        for (const row of onboardingHotkeyRows(stored)) {
            // `acceleratorKbd` (shared with the Hotkeys table) draws the key
            // caps and escapes them; the muted "Not bound" wording is its job
            // too, which is why an unbound row just passes `''`.
            $list.append(`
                <tr>
                    <td>${escapeHtml(t(row.descriptionKey))}</td>
                    <td>${acceleratorKbd(row.accelerator)}</td>
                </tr>
            `);
        }

        this.renderHotkeyConflicts(conflicts);

        const tryIt = onboardingTryIt(stored, conflicts);
        // A catalogue string with our own markup substituted in — the same
        // contract as `data-i18n-html`, and the one part that is not from a
        // catalogue is escaped by `acceleratorKbd`.
        $('#tourTryIt').html(t(tryIt.promptKey, {toggle: acceleratorKbd(tryIt.accelerator)}));
        // The acknowledgement starts hidden every time the step is entered, so
        // going back and forth does not show a stale "that was it".
        $('#tourTryItOk').addClass('d-none');
    }

    /**
     * The auto-detect step, both halves of it.
     *
     * Neither switch is ever pre-ticked: both read the live state, and both
     * settings ship off. The Tab-map half follows the auto-detect half on this
     * same step — it cannot work without it — so it is redrawn from the status
     * push as well as on entry.
     */
    renderDetectStep() {
        $('#tourDetectCheck').prop('checked', this.detectorRunning());

        // The three inputs come from the **real** controls, so the tour cannot
        // hold an opinion of its own about any of them.
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
            // A catalogue string with our own markup in it — `data-i18n-html`'s
            // contract. The auto-detect reason is Settings' own string.
            $blocked.removeClass('d-none').html(t(state.reasonKey));
        } else {
            $blocked.addClass('d-none').empty();
        }

        // The live map key, named the way the hotkey rows name live
        // accelerators. The capture control is not duplicated here; the
        // sentence points at Settings instead.
        $('#tourTabKey').html(t('onboarding.detect.tab.key', {
            key: `<kbd>${escapeHtml(this.mapKeyLabel())}</kbd>`
        }));
    }

    /**
     * What the game's map key is called.
     *
     * Read from the `<kbd>` Settings already renders it into, rather than
     * resolved a second time here: only the browser knows what the active
     * layout calls a virtual-key code, `Options.renderMapKey` is where that
     * lives, and two resolutions would be two chances to disagree. The fallback
     * is the shipped default's label — derived, never a hard-coded "Tab".
     */
    mapKeyLabel() {
        const shown = $('#tabMarkerKeyValue').text();
        if (typeof shown === 'string' && shown.trim()) return shown.trim();
        return vkLabel(resolveMapVk(null));
    }

    /** The live conflict list, from the module that already keeps it current. */
    hotkeyConflicts() {
        const conflicts = this.diagnostics && this.diagnostics.conflicts;
        return Array.isArray(conflicts) ? conflicts : [];
    }

    /**
     * The hotkeys step's own copy of the conflict warning.
     *
     * Same three pieces and the same two catalogue strings as the home-page
     * banner (`#hotkeyConflict`), which is behind the backdrop while the tour
     * is open. Built as nodes with `.text()`, never interpolated: an
     * accelerator can come straight out of a hand-edited settings file.
     *
     * @param {Array<{accelerator: *}>} conflicts
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

    /** Move the keyboard to the step's heading, which also announces it. */
    focusStep(stepId) {
        const heading = document.querySelector(`.tour-step[data-tour-step="${stepId}"] .tour-title`);
        if (!heading) return;
        // A heading is not focusable on its own, and it must not become a tab
        // stop either — hence -1 rather than 0.
        heading.setAttribute('tabindex', '-1');
        heading.focus();
    }

    // ─── The overlay preview (borrowed from the Overlay settings tab) ──

    startPreview() {
        if (!this.options || this.options.previewActive) return;
        this.options.startPreview();
    }

    stopPreview() {
        if (!this.options || !this.options.previewActive) return;
        this.options.stopPreview();
    }

    /** Whether the detector loop is running, from the status the renderer holds. */
    detectorRunning() {
        const status = this.detector && this.detector.lastStatus;
        return !!(status && status.running);
    }

    // ─── Keyboard ──────────────────────────────────────────────

    onKeyDown(e) {
        if (!this.isOpen) return;
        // While a hotkey is being recorded the recorder owns every key. It can
        // only happen if something opened the bind modal over the tour, which
        // nothing does today — but the two listeners are one `document` apart
        // and this is cheaper than finding out the hard way.
        if (this.hotkeys && this.hotkeys.recordingHotkey) return;

        if (e.key === 'Escape') {
            e.preventDefault();
            this.close({done: true});
            return;
        }
        if (e.key === 'Tab') this.trapTab(e);
    }

    /** Keep Tab inside the panel, in both directions. */
    trapTab(e) {
        const panel = document.getElementById('tour');
        const items = this.focusableItems();
        if (!items.length) {
            e.preventDefault();
            return;
        }
        const active = document.activeElement;
        // The decision is the pure `tabWrapTarget`; this half is only the DOM
        // reads it needs and the one focus call it asks for. `null` means the
        // browser's own Tab is already going somewhere inside the panel.
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

    /** Everything inside the panel the keyboard can reach, in DOM order. */
    focusableItems() {
        return $('#tour')
            .find('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')
            .filter(':visible')
            .toArray();
    }
}

module.exports = Onboarding;
