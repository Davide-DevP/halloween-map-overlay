/**
 * Renderer, Settings modal: the Map and General tabs. A VIEW — it writes
 * settings and asks main to act, and it never draws the overlay itself.
 * See docs/agents/settings-and-onboarding.md.
 */
const {ipcRenderer} = require('electron');
const {buildPreviewImage} = require('./overlay-preview');
const {presetToGlide} = require('../core/overlay-position');
const {mapLabelMode, newsCheckState, settingsForNewsCheck} = require('../shared/settings-defaults');
const {keyEventToVk, vkLabel, resolveMapVk, DEFAULT_MAP_VK} = require('../shared/key-codes');
const {resolveMapPad, resolvePadId, padLabel, padDisplayName} = require('../shared/pad-codes');
const {manualCheckView} = require('../shared/update-message');
const {
    normalisePlacement, placementFromSettings, settingsForPlacement, placementSections,
    autoDetectSwitchState, shouldStartDetection, markerMasterNotice
} = require('../shared/map-placement');
const i18n = require('./i18n');
const {t, onChange} = i18n;
const isWayland = require('../core/is-wayland');
const {showStatus, TOAST_READ_MS} = require('./status');
const {setBusy} = require('./busy');

/** An OS-supplied display name is a device name, never translated. */
function displayLabel(display) {
    if (display.label) return display.label;
    const params = {
        index: display.index + 1,
        width: display.physicalWidth,
        height: display.physicalHeight,
        refresh: display.refreshRate
    };
    return display.refreshRate
        ? t('settings.monitor.labelHz', params)
        : t('settings.monitor.label', params);
}

/**
 * Open the FAQ, optionally at a `.faq-item` id. Settings is closed **first**:
 * one focus trap at a time, the same rule the tutorial follows.
 */
function openFaq(anchorId) {
    const faqEl = document.getElementById('faqModal');
    if (!faqEl) return;
    const show = () => {
        if (anchorId) {
            // On `shown`: a modal not yet laid out cannot scroll to anything.
            faqEl.addEventListener('shown.bs.modal', () => {
                const anchor = document.getElementById(anchorId);
                if (anchor) anchor.scrollIntoView({block: 'start'});
            }, {once: true});
        }
        bootstrap.Modal.getOrCreateInstance(faqEl).show();
    };
    const settingsEl = document.getElementById('settings');
    if (settingsEl && settingsEl.classList.contains('show')) {
        settingsEl.addEventListener('hidden.bs.modal', show, {once: true});
        bootstrap.Modal.getOrCreateInstance(settingsEl).hide();
        return;
    }
    show();
}

const MARKER_CHIPS = [
    ['#markerCellarCheck', 'markerLayerCellar'],
    ['#markerGateCheck', 'markerLayerGate'],
    ['#markerCarCheck', 'markerLayerCar'],
    ['#markerGasCheck', 'markerLayerGas'],
    ['#markerLegendCheck', 'markerLegend']
];

class Options {
    /** @param {?Object} detector `src/js/detector.js`, the one start/stop path */
    constructor(settings, maps, detector) {
        this.settings = settings;
        this.maps = maps;
        this.detector = detector || null;
        this.setting = false;
        this.previewActive = false;
        /** Last `{state, version}` from main, so the line can be re-translated. */
        this.updateCheckInfo = null;
        /** Between a click on "Check now" and its outcome. */
        this.manualUpdateCheck = false;
        /** A manual check is running, **both** halves of it. */
        this.checkingNow = false;
        /** Which map-key button is armed, or null. */
        this.recordingMapKey = null;
        this.mapKeyTargets = [];
        /** Which controller-button recorder is waiting on main, or null. */
        this.recordingMapPad = null;
        this.mapPadTargets = [];
        /** Ticket per `applyPlacement`: a queued write whose ticket moved on drops out. */
        this.placementSeq = 0;
        /** Serialises the writes — see `applyPlacement`. */
        this.placementChain = null;
        /** Called once a card's writes have landed (the tutorial re-renders). */
        this.placementListeners = [];
        /** A flag, never `disabled`: that blurs the switch and drops the tutorial's focus trap. */
        this.detectBusy = false;

        this.bindGeneral();
        this.bindMap();
        this.bindOverlay();
        this.bindMarkers();
        this.bindUpdates();
        this.bindHelp();
        this.bindModalEvents();
        this.syncReadouts();
        onChange(() => this.syncReadouts());
    }

    refreshOverlay() {
        if (this.previewActive) {
            this.sendPreview();
        } else {
            // 'settings', not 'click': app.log collapses repeats of one key
            // from one source. No fallback to `lastKey`: a hidden map stays hidden.
            this.maps.send({type: 'refresh', source: 'settings'});
        }
    }

    /* ── General tab ─────────────────────────────────────────────────────── */

    bindGeneral() {
        const settings = this.settings;

        $("#minimizeToTrayCheck").prop("checked", settings.raw("minimizeToTray") === true);
        $("#disableFaqPopupCheck").prop("checked", settings.raw("disableFaqPopup") === true);
        // `=== true` here, `!== false` elsewhere: the shipped default decides which.
        // Why: the doc § Settings reference.
        $("#hardwareAccelerationCheck").prop("checked", settings.raw("hardwareAcceleration") === true);

        // Its own handler: main resolves "system" once and pushes it everywhere.
        $("#languageSelect").on("input", async function () {
            const resolved = await ipcRenderer.invoke('set-language', $(this).val());
            await settings.refresh();
            i18n.setLanguage(resolved);
        }).val(settings.raw("language") || 'system');

        $("#minimizeToTrayCheck").on("input", async function () {
            await settings.set("minimizeToTray", $(this).prop('checked'));
        });
        $("#disableFaqPopupCheck").on("input", async function () {
            await settings.set("disableFaqPopup", $(this).prop('checked'));
        });
        $("#hardwareAccelerationCheck").on("input", async function () {
            // Restart-only, so the toast says so out loud.
            await settings.set("hardwareAcceleration", $(this).prop('checked'));
            showStatus(t('settings.hardwareAcceleration.restart'));
        });

        if (settings.raw("disableFaqPopup") !== true) {
            $("#warning").removeClass("d-none").addClass("show").slideDown();
        }
    }

    /* ── Map tab: where do you want to see the map? ──────────────────────── */

    bindMap() {
        const self = this;

        $('#placementCards input[name="mapPlacement"]').on('change', async function () {
            await self.applyPlacement($(this).val());
            for (const listener of self.placementListeners) listener();
        });
        // One setting in three places — always through `Detector.setEnabled`.
        // A re-entrant click is dropped, never disabled (see `detectBusy`).
        $("#autoDetectCheck").on("change", async function () {
            if (!self.detector) return;
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
        if (this.detector && typeof this.detector.onStatus === 'function') {
            this.detector.onStatus(() => {
                self.syncPlacement();
                self.refreshTabMarkerMethod();
            });
        }
        // Only a user click may start a capture (AGENTS.md rule 1).
        $("#autoDetectStart").on('click', async function () {
            if (!self.detector) return;
            await self.detector.setEnabled(true);
        });
        this.syncPlacement();
    }

    /* ── Map tab: the map in the corner, and Other adjustments ───────────── */

    bindOverlay() {
        const self = this;
        const settings = this.settings;

        // The env vars survive the x11 relaunch (index.js).
        if (isWayland()) {
            $("#waylandWarning").removeClass("d-none");
        }

        $("#hiddenCheck").prop("checked", settings.raw("hideOverlay") === true);
        $("#hiddenCheck").on("input", async function () {
            await settings.set("hideOverlay", $(this).prop('checked'));
            self.refreshOverlay();
        });

        this.populateMonitors();
        onChange(() => self.populateMonitors());
        $("#monitorSelect").on("input", async function () {
            await settings.set("monitor", parseInt($(this).val(), 10));
            self.refreshOverlay();
        });

        // `parseInt`, not the raw `.val()`: a range input hands back a string
        // and main writes a number. Why: the doc § Settings reference.
        $("#sizeRange").on("input", async function () {
            self.syncReadouts();
            await settings.set("size", parseInt($(this).val(), 10) || 0);
            self.refreshOverlay();
        }).val(settings.raw("size"));

        $("#positionLabel").on("input", async function () {
            await settings.set("position", $(this).val());
            await self.snapGlideToPreset();
            self.refreshOverlay();
        }).val(settings.raw("position"));
        $("#opacityRange").on("input", async function () {
            self.syncReadouts();
            await settings.set("opacity", parseFloat($(this).val()) || 0);
            self.refreshOverlay();
        }).val(settings.raw("opacity"));

        // Snapped to the nearest quarter turn, in case a stray one was saved.
        const savedRotation = (Math.round((parseInt(settings.raw("rotation"), 10) || 0) / 90) * 90) % 360;
        $("#rotationSelect").on("input", async function () {
            await settings.set("rotation", parseInt($(this).val(), 10) || 0);
            self.refreshOverlay();
        }).val(String(savedRotation));

        $("#mapLabelSelect").on("input", async function () {
            await settings.set("mapLabel", mapLabelMode($(this).val()));
            self.refreshOverlay();
        }).val(mapLabelMode(settings.raw("mapLabel")));

        // `raw`, not `get`: a saved 0 must mean 0, not "follow the preset".
        const initialCorner = presetToGlide(settings.raw("position"));
        const savedGlideX = settings.raw('glideX');
        const savedGlideY = settings.raw('glideY');
        $("#glideXRange").on("input", async function () {
            self.syncReadouts();
            await settings.set("glideX", parseInt($(this).val(), 10) || 0);
            self.refreshOverlay();
        }).val(savedGlideX !== null && savedGlideX !== undefined ? savedGlideX : initialCorner.x);
        $("#glideYRange").on("input", async function () {
            self.syncReadouts();
            await settings.set("glideY", parseInt($(this).val(), 10) || 0);
            self.refreshOverlay();
        }).val(savedGlideY !== null && savedGlideY !== undefined ? savedGlideY : initialCorner.y);

        this.bindDrag();
    }

    /** `.val()`/`.text()`: no OS string is interpolated into markup. */
    async populateMonitors() {
        const displays = await ipcRenderer.invoke('get-displays');
        const select = $("#monitorSelect");
        select.empty();
        displays.forEach(d => select.append($('<option>').val(d.index).text(displayLabel(d))));
        const saved = this.settings.raw('monitor');
        select.val(saved !== null && saved !== undefined ? saved : 0);
    }

    /** The corner preset doubles as a glide shortcut: it snaps both sliders. */
    async snapGlideToPreset() {
        const corner = presetToGlide(this.settings.raw("position"));
        $("#glideXRange").val(corner.x);
        $("#glideYRange").val(corner.y);
        this.syncReadouts();
        await this.settings.set("glideX", corner.x);
        await this.settings.set("glideY", corner.y);
    }

    /**
     * *Set position* turns `draggable` on and lets the overlay catch the
     * mouse; `#glideReset` is the only way back to the corner preset.
     */
    bindDrag() {
        const self = this;
        const settings = this.settings;
        this.applyDragState(settings.raw("draggable") === true);
        $("#unset-pos").hide();
        $("#set-pos").on("click", async function () {
            await settings.set("draggable", true);
            ipcRenderer.send('set-mouse-drag', true);
            self.applyDragState(true);
            $("#unset-pos").show();
            $("#set-pos").hide();
            self.setting = true;
            self.refreshOverlay();
        });
        $("#unset-pos").on("click", function () {
            ipcRenderer.send('set-mouse-drag', false);
            $("#unset-pos").hide();
            $("#set-pos").show();
            self.setting = false;
        });
        $("#glideReset").on("click", async function () {
            // Also the escape hatch out of "moved by hand", so it ends the drag.
            ipcRenderer.send('set-mouse-drag', false);
            self.setting = false;
            $("#unset-pos").hide();
            $("#set-pos").show();
            await settings.set("draggable", false);
            self.applyDragState(false);
            await self.snapGlideToPreset();
            self.refreshOverlay();
        });
    }

    /* ── Map tab: what to show, the game's map key, the trouble fold ─────── */

    bindMarkers() {
        const self = this;
        const settings = this.settings;

        // Only a setting and a re-send: main rebuilds the marker payload.
        for (const [selector, key] of MARKER_CHIPS) {
            $(selector).prop('checked', settings.raw(key) !== false);
            $(selector).on('change', async function () {
                await settings.set(key, $(this).prop('checked'));
                self.refreshOverlay();
            });
        }
        // The master switch is Ctrl+Alt+M only — see `syncMarkerMaster`.
        $("#markersShowBtn").on('click', async function () {
            await settings.set('markers', true);
            self.syncMarkerMaster();
            self.refreshOverlay();
        });
        this.syncMarkerMaster();

        $("#markerOpacityRange").on("input", async function () {
            self.syncReadouts();
            await settings.set("markerOpacity", parseFloat($(this).val()));
            self.refreshOverlay();
        }).val(settings.raw("markerOpacity") !== null && settings.raw("markerOpacity") !== undefined
            ? settings.raw("markerOpacity") : 0.9);

        this.attachMapKeyRecorder('#tabMarkerKeyBtn', '#tabMarkerKeyValue');
        this.attachMapKeyReset('#tabMarkerKeyReset');
        this.renderMapKey();
        this.attachMapPadRecorder('#tabMarkerPadBtn', '#tabMarkerPadValue', '#tabMarkerPadName');
        this.attachMapPadRemove('#tabMarkerPadReset');
        this.renderMapPad();

        $("#tabMarkersInstantCheck").prop('checked', settings.raw("tabMarkersInstant") !== false);
        $("#tabMarkersInstantCheck").on("input", async function () {
            await settings.set("tabMarkersInstant", $(this).prop('checked'));
        });

        // Main switches method, so this needs its own handler.
        $("#markerTriggerPollingCheck").prop('checked', settings.raw("markerTrigger") === 'polling');
        $("#markerTriggerPollingCheck").on("input", async function () {
            await ipcRenderer.invoke('set-marker-trigger', $(this).prop('checked') ? 'polling' : 'auto');
            await settings.refresh();
            self.refreshTabMarkerMethod();
        });
        this.refreshTabMarkerMethod();
        onChange(() => {
            self.renderMapKey();
            self.renderMapPad();
            self.refreshTabMarkerMethod();
            self.syncPlacement();
        });
    }

    /* ── General tab: one switch, one button, both checks ────────────────── */

    bindUpdates() {
        const self = this;
        const settings = this.settings;

        // One switch, two keys: on while **either** request is still made.
        $("#checkForUpdatesCheck").prop("checked", newsCheckState(settings.all()).checked);
        $("#checkForUpdatesCheck").on("input", async function () {
            const target = settingsForNewsCheck($(this).prop('checked'));
            for (const [key, value] of Object.entries(target)) await settings.set(key, value);
            self.refreshMapPackStatus();
        });
        // Works with the switch above off — the click is the consent — and
        // never touches it. Main decides with the pure `planManualUpdateCheck`.
        $("#checkUpdatesNowBtn").on("click", function () {
            self.checkNow(this);
        });
        // The startup check moves the same state, so it disables the button too.
        ipcRenderer.on('update-check-state', (event, info) => {
            self.renderUpdateCheckState(info, true);
        });
        this.refreshUpdateCheckState();
        // Rebuilt on a language change, without toasting again.
        onChange(() => self.renderUpdateCheckState(self.updateCheckInfo, false));
        this.refreshMapPackStatus();
        onChange(() => self.refreshMapPackStatus());
    }

    /** *Check now*: the app update, then — after a readable pause — the maps. */
    async checkNow(button) {
        // `checkingNow` holds the button down for the **whole** flow: a
        // second click during the pause starts a flow that answers `busy`.
        if (this.checkingNow) return;
        this.checkingNow = true;
        $(button).prop('disabled', true);
        this.manualUpdateCheck = true;
        try {
            try {
                this.renderUpdateCheckState(await ipcRenderer.invoke('check-for-updates-now'), true);
            } catch (err) {
                // A rejected `invoke` would leave the button disabled
                // forever: the push that re-enables it is never coming.
                console.error('options::check-for-updates-now', err && err.message);
                this.renderUpdateCheckState({state: 'failed'}, false);
                showStatus(t('update.manual.failed'));
            }
            // The toast replaces rather than queues, so only the second
            // outcome would show without the pause.
            await new Promise(resolve => setTimeout(resolve, TOAST_READ_MS));
            try {
                await ipcRenderer.invoke('check-map-packs');
            } catch (err) {
                console.error('options::check-map-packs', err && err.message);
            }
            this.refreshMapPackStatus();
        } finally {
            // The real state, not this flag, decides if the button comes back.
            this.checkingNow = false;
            this.refreshUpdateCheckState();
        }
    }

    /* ── General tab: help ───────────────────────────────────────────────── */

    bindHelp() {
        // Main opens userData: the renderer never learns the path, it just asks.
        $("#openLogFolder").on("click", async function () {
            const result = await ipcRenderer.invoke('open-log-folder');
            if (!result || !result.ok) showStatus(t('settings.openLogFolder.failed'));
        });
        $("#openFaqBtn").on('click', () => openFaq(null));
        // Delegated: the link can be inside the tutorial as well as in Settings.
        $(document).on('click', '.faq-link', function () {
            openFaq($(this).attr('data-faq') || null);
        });
    }

    /* ── The modal itself: the sample map and the busy reason ────────────── */

    bindModalEvents() {
        const self = this;
        // Native listeners, not jQuery's: `.on()` would treat ".bs.tab" as an
        // event namespace and never fire.
        const mapTab = document.getElementById('map-tab');
        const settingsModal = document.getElementById('settings');
        mapTab.addEventListener('shown.bs.tab', () => self.startPreview());
        mapTab.addEventListener('hidden.bs.tab', () => self.stopPreview());
        settingsModal.addEventListener('shown.bs.modal', () => {
            // Bootstrap keeps the last active tab across modal open/close.
            if (mapTab.classList.contains('active')) self.startPreview();
            // State main must not tear down — `shared/window-unload.js`.
            setBusy('settings', true);
        });
        settingsModal.addEventListener('hide.bs.modal', () => self.stopPreview());
        settingsModal.addEventListener('hidden.bs.modal', () => setBusy('settings', false));
        // Minimize-to-tray leaves the modal open; the sample must leave the overlay.
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                self.stopPreview();
            } else if (settingsModal.classList.contains('show') && mapTab.classList.contains('active')) {
                self.startPreview();
            }
        });
    }

    /* ── Where the map goes ─────────────────────────────────────────────── */

    detectorRunning() {
        const status = this.detector && this.detector.lastStatus;
        return !!(status && status.running);
    }

    /** @param {function(): void} callback after a card's writes have landed */
    onPlacementApplied(callback) {
        if (typeof callback === 'function') this.placementListeners.push(callback);
    }

    /** The single source of truth, re-read rather than cached. */
    placement() {
        return placementFromSettings(this.settings.all());
    }

    /**
     * Apply one of the three cards — **only ever from a user action**: two of
     * them switch a screen capture on (AGENTS.md rule 1). Detection first
     * (`core/tab-mode.js` refuses to start without it) and nothing is written
     * until the loop really runs, so a refusal leaves the stored choice alone.
     * @param {*} placement 'corner' | 'tab' | 'both'
     */
    async applyPlacement(placement) {
        const next = normalisePlacement(placement);
        const seq = ++this.placementSeq;
        const run = () => this.writePlacement(next, seq);
        // Serialised, so two cards cannot interleave their two writes; a queued
        // one that has been superseded drops out at the top of `writePlacement`.
        this.placementChain = this.placementChain
            ? this.placementChain.then(run, run)
            : run();
        return this.placementChain;
    }

    /** One card's two writes. @param {number} seq the ticket from `applyPlacement` */
    async writePlacement(next, seq) {
        if (seq !== this.placementSeq) return;
        if (shouldStartDetection(next, this.detectorRunning()) && this.detector) {
            await this.detector.setEnabled(true);
            if (seq !== this.placementSeq) return;
            if (shouldStartDetection(next, this.detectorRunning())) {
                showStatus(t('settings.where.needsDetect'));
                this.syncPlacement();
                return;
            }
        }
        // **The last chance to drop out**: past this line the pair is written
        // to the end — half of it stored is half a choice the user did not pick.
        if (seq !== this.placementSeq) return;
        const target = settingsForPlacement(next);
        // `TabMode` picks this up through `settings.onChange`, so the generic
        // setter is enough — but it has to land *before* the mode starts.
        await this.settings.set('tabHidesMinimap', target.tabHidesMinimap);
        // Its own handler, because main has to *act*: the window and the loop.
        await ipcRenderer.invoke('set-tab-markers', target.tabMarkers);
        await this.settings.refresh();
        this.syncPlacement();
        this.refreshTabMarkerMethod();
    }

    /** Everything the choice shows, hides and locks — the home page's switch too. */
    syncPlacement() {
        if (!$('#placementCards').length) return;
        const placement = this.placement();
        // From the stored pair, never from the click: the tutorial writes it too.
        $('#placementCards input[name="mapPlacement"]').each(function () {
            $(this).prop('checked', $(this).val() === placement);
        });
        const sections = placementSections(placement);
        $('#cornerBlock').toggleClass('d-none', !sections.corner);
        $('#gameMapKeyBlock').toggleClass('d-none', !sections.gameMap);
        $('#gameMapTroubleFold').toggleClass('d-none', !sections.troubleshooting);
        const auto = autoDetectSwitchState(placement, this.detectorRunning());
        const check = document.getElementById('autoDetectCheck');
        // Disabling the focused element blurs it: hand focus to its dialog first,
        // or the tutorial's focus trap loses it. Why: docs/agents/settings-and-onboarding.md.
        if (auto.disabled && check && check === document.activeElement) {
            const dialog = check.closest('#tour, .modal');
            if (dialog) dialog.focus();
        }
        $(check).prop('checked', auto.checked).prop('disabled', auto.disabled);
        $('#autoDetectHelp').text(t(auto.reasonKey));
        $('#autoDetectStart').toggleClass('d-none', !auto.blocked);
        if (this.detector && typeof this.detector.setPlacementLock === 'function') {
            this.detector.setPlacementLock(auto.disabled);
        }
    }

    /** The corner controls that a hand-placed overlay makes meaningless. */
    applyDragState(on) {
        $("#positionLabel").prop("disabled", on);
        $("#glideXRange, #glideYRange").prop("disabled", on);
        $("#monitorSelect").prop("disabled", on);
        $("#movedByHandNote").toggleClass('d-none', !on);
    }

    /** "Every chip on, nothing on screen" is the one state to explain. */
    syncMarkerMaster() {
        const notice = markerMasterNotice(this.settings.raw('markers'));
        $('#markersHiddenNotice').toggleClass('d-none', !notice.hidden);
    }

    /* ── The game's map key ─────────────────────────────────────────────── */

    /**
     * Arm one button as the map-key recorder — **one** recorder however many
     * buttons there are, or one code would have two write paths. Keyed on the
     * **button**, not `document` (`src/js/hotkeys.js` owns one while recording),
     * and it stops the event dead, or Tab would just move focus.
     */
    attachMapKeyRecorder(buttonId, valueId) {
        const self = this;
        if (!$(buttonId).length) return;
        this.mapKeyTargets.push({buttonId, valueId});
        $(buttonId).on("click", function () {
            self.recordingMapKey = buttonId;
            $(this).text(t('settings.tabMarkers.mapKey.press')).addClass('active').focus();
        });
        $(buttonId).on("blur", function () {
            // A click elsewhere cancels rather than leaving it armed.
            if (self.recordingMapKey !== buttonId) return;
            self.recordingMapKey = null;
            self.renderMapKey();
        });
        $(buttonId).on("keydown", async function (event) {
            if (self.recordingMapKey !== buttonId) return;
            event.preventDefault();
            event.stopPropagation();
            const original = event.originalEvent || event;
            if (original.key === 'Escape') {
                self.recordingMapKey = null;
                self.renderMapKey();
                return;
            }
            const result = keyEventToVk(original);
            if (result.status !== 'ok') {
                // Stay armed: a modifier on the way to the key they meant.
                if (result.status === 'modifier') return;
                showStatus(result.status === 'with-modifier'
                    ? t('settings.tabMarkers.mapKey.error.withModifier')
                    : t('settings.tabMarkers.mapKey.error.unsupported'));
                return;
            }
            self.recordingMapKey = null;
            // The label travels with the code — see the doc § Settings reference.
            await ipcRenderer.invoke('set-tab-marker-key', result.vk, result.label);
            await self.settings.refresh();
            self.renderMapKey();
            self.refreshTabMarkerMethod();
        });
    }

    attachMapKeyReset(buttonId) {
        const self = this;
        if (!$(buttonId).length) return;
        $(buttonId).on("click", async function () {
            self.recordingMapKey = null;
            await ipcRenderer.invoke('set-tab-marker-key', DEFAULT_MAP_VK, 'Tab');
            await self.settings.refresh();
            self.renderMapKey();
            self.refreshTabMarkerMethod();
        });
    }

    /** Never translated: the label names a physical key. */
    renderMapKey() {
        const vk = resolveMapVk(this.settings.raw('tabMarkerKey'));
        // `vkLabel` is the fallback, right only on a US keyboard.
        const stored = this.settings.raw('tabMarkerKeyLabel');
        const label = (typeof stored === 'string' && stored.trim()) ? stored.trim() : vkLabel(vk);
        for (const {buttonId, valueId} of this.mapKeyTargets) {
            $(valueId).text(label);
            $(buttonId).text(t('settings.tabMarkers.mapKey.change')).removeClass('active');
        }
    }

    /* ── The controller button ──────────────────────────────────────────── */

    /**
     * Arm one button as the controller-button recorder. The wait happens in
     * main's hidden pad window (`record-tab-marker-pad`, bounded there), and
     * the pad pressed on becomes the chosen controller. **Losing focus does
     * not cancel**: the player may switch to the game to press. Esc or a
     * second click cancels. One recorder for however many buttons.
     */
    attachMapPadRecorder(buttonId, valueId, nameId) {
        const self = this;
        if (!$(buttonId).length) return;
        this.mapPadTargets.push({buttonId, valueId, nameId});
        $(buttonId).on("click", async function () {
            if (self.recordingMapPad === buttonId) {
                await self.cancelMapPadRecording();
                return;
            }
            if (self.recordingMapPad) await self.cancelMapPadRecording();
            self.recordingMapPad = buttonId;
            $(this).text(t('settings.tabMarkers.pad.press')).addClass('active').focus();
            const result = await ipcRenderer.invoke('record-tab-marker-pad');
            // A cancel already re-rendered, and its answer is not a result.
            if (self.recordingMapPad !== buttonId) return;
            self.recordingMapPad = null;
            if (!result || !result.ok) {
                self.renderMapPad();
                const reason = result && result.reason;
                if (reason === 'no-controller') showStatus(t('settings.tabMarkers.pad.error.noController'));
                else if (reason === 'timeout') showStatus(t('settings.tabMarkers.pad.error.timeout'));
                else if (reason === 'unavailable') showStatus(t('settings.tabMarkers.pad.error.unavailable'));
                return;
            }
            await ipcRenderer.invoke('set-tab-marker-pad', result.code);
            await self.settings.refresh();
            self.renderMapPad();
            self.refreshTabMarkerMethod();
        });
        $(buttonId).on("keydown", function (event) {
            if (self.recordingMapPad !== buttonId) return;
            const original = event.originalEvent || event;
            if (original.key !== 'Escape') return;
            event.preventDefault();
            self.cancelMapPadRecording();
        });
    }

    async cancelMapPadRecording() {
        if (!this.recordingMapPad) return;
        this.recordingMapPad = null;
        this.renderMapPad();
        await ipcRenderer.invoke('cancel-tab-marker-pad');
    }

    attachMapPadRemove(buttonId) {
        const self = this;
        if (!$(buttonId).length) return;
        $(buttonId).on("click", async function () {
            await self.cancelMapPadRecording();
            await ipcRenderer.invoke('set-tab-marker-pad', null);
            await self.settings.refresh();
            self.renderMapPad();
            self.refreshTabMarkerMethod();
        });
    }

    /**
     * The label names a physical button, so only "None" is translated; the
     * controller's name is the pad's own, shown only once one was chosen.
     */
    renderMapPad() {
        const code = resolveMapPad(this.settings.raw('tabMarkerPad'));
        const label = code === null ? t('settings.tabMarkers.pad.none') : padLabel(code);
        const id = code === null ? null : resolvePadId(this.settings.raw('tabMarkerPadId'));
        const name = id === null ? '' : padDisplayName(id, t('settings.tabMarkers.pad.controller'));
        for (const {buttonId, valueId, nameId} of this.mapPadTargets) {
            // `.text()`: the name comes from the device, not from this app.
            if (nameId) $(nameId).text(name).attr('title', name || null);
            $(valueId).text(label).toggleClass('is-unset', code === null);
            $(buttonId).text(t('settings.tabMarkers.pad.change')).removeClass('active');
        }
    }

    /** Display only — never touches `Settings`, so anything may call it. */
    syncReadouts() {
        const px = (value) => t('settings.value.px', {value: Math.round(Number(value) || 0)});
        const percent = (value) => t('settings.value.percent', {value: Math.round(Number(value) || 0)});
        $("#sizeValue").text(px($("#sizeRange").val()));
        $("#opacityValue").text(percent(Number($("#opacityRange").val()) * 100));
        $("#glideXValue").text(percent($("#glideXRange").val()));
        $("#glideYValue").text(percent($("#glideYRange").val()));
        $("#markerOpacityValue").text(percent(Number($("#markerOpacityRange").val()) * 100));
    }

    mapKeyLabel(info) {
        if (info && typeof info.mapKeyLabel === 'string' && info.mapKeyLabel) return info.mapKeyLabel;
        return vkLabel(info ? info.mapVk : null);
    }

    /** Which of the two methods the game's-map mode is using, and why. */
    async refreshTabMarkerMethod() {
        const $line = $("#tabMarkerMethod");
        if (!$line.length) return;
        const info = await ipcRenderer.invoke('get-tab-marker-state');
        if (!info) return;
        this.tabMarkerInfo = info;
        let text = '';
        // With a controller button set the line names both inputs — unless the
        // hidden pad window could not be built, which is its own sentence.
        const padSet = info.mapPad !== null && info.mapPad !== undefined;
        const padBroken = padSet && !!(info.padWindow && info.padWindow.failed);
        const params = {key: this.mapKeyLabel(info), button: info.mapPadLabel || ''};
        const both = padSet && !padBroken;
        if (!info.setting) text = '';
        else if (info.method === 'key') {
            text = both ? t('settings.tabMarkers.method.keyPad', params) : t('settings.tabMarkers.method.key', params);
        }
        // Ready but the game is not running: "unavailable" would be alarming.
        else if (info.method === 'key-waiting') {
            text = both ? t('settings.tabMarkers.method.waitingPad', params) : t('settings.tabMarkers.method.waiting', params);
        }
        else if (info.methodReason === 'forced') text = t('settings.tabMarkers.method.polling');
        else text = t('settings.tabMarkers.method.unavailable');
        if (info.setting && padBroken && info.method !== 'polling') {
            text += ' ' + t('settings.tabMarkers.method.padUnavailable');
        }
        // A bordered window's capture is not its own rectangle, so every marker
        // would sit off by the border and nothing is drawn at all.
        if (info.setting && info.sizeMismatch) text = t('settings.tabMarkers.method.windowed');
        $line.text(text);
    }

    /** `.text()`: a pack's name is text this app did not write. */
    async refreshMapPackStatus() {
        const $line = $("#mapPacksStatus");
        if (!$line.length) return;
        const info = await ipcRenderer.invoke('get-map-pack-state');
        if (!info) return;
        const count = (info.packs || []).length;
        if (!count) {
            $line.text(t('settings.mapPacks.none'));
            return;
        }
        $line.text(t('settings.mapPacks.installed', {count}));
    }

    /** Fetched as well as pushed: this window can open mid-check or long after. */
    async refreshUpdateCheckState() {
        this.renderUpdateCheckState(await ipcRenderer.invoke('get-update-check-state'), false);
    }

    /**
     * The button and the line under it, every decision from the pure
     * `manualCheckView()`. `.text()`, never markup: the version in it comes off
     * the release feed.
     * @param {boolean} toast true for a real state change, false for a language
     *   re-render; and only a check the user asked for is toasted at all.
     */
    renderUpdateCheckState(info, toast) {
        const $button = $("#checkUpdatesNowBtn");
        if (!$button.length) return;
        const state = (info && info.state) || 'idle';
        const version = (info && info.version) || '';
        this.updateCheckInfo = {state, version};
        const view = manualCheckView(state, version);
        // `checkingNow` outlives the update half — see the click handler.
        $button.prop('disabled', view.disabled || this.checkingNow === true);
        const text = view.message ? i18n.translateMessage(view.message) : '';
        $("#updateCheckStatus").text(text);
        if (toast && this.manualUpdateCheck && text) showStatus(text);
        // Anything that is not "still running" ends the click this belonged to.
        if (!view.disabled) this.manualUpdateCheck = false;
    }

    /**
     * Re-read the controls main can change behind this window's back: the
     * opacity, size, rotation and markers hotkeys write in **main**.
     */
    syncFromSettings() {
        const settings = this.settings;
        if ($("#opacityRange").length) $("#opacityRange").val(String(settings.raw("opacity")));
        if ($("#sizeRange").length) $("#sizeRange").val(String(settings.raw("size")));
        if ($("#rotationSelect").length) {
            $("#rotationSelect").val(String(parseInt(settings.raw("rotation"), 10) || 0));
        }
        // The Show / hide points hotkey is the only way the master switch moves.
        this.syncMarkerMaster();
        this.syncReadouts();
    }

    startPreview() {
        this.previewActive = true;
        // Main has to know: anything landing on the overlay while the preview
        // is up asks this window to put the sample back (`refresh-preview`).
        this.maps.send({type: 'preview-start'});
        this.sendPreview();
    }

    async sendPreview() {
        const img = await buildPreviewImage();
        // The tab may have been left while the sample was still rendering.
        if (!this.previewActive) return;
        // The sample map has no catalogue name, so it brings its own.
        ipcRenderer.send('map-change', img, {preview: true, mapLabel: t('overlay.sampleMap')});
    }

    stopPreview() {
        if (!this.previewActive) return;
        this.previewActive = false;
        // Main re-applies its own `currentKey`, deliberately **without**
        // `{preview: true}`: that flag forces the raw-base64 path.
        this.maps.send({type: 'preview-stop'});
    }
}

module.exports = Options;
