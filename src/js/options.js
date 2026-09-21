/**
 * Renderer, Settings modal: the General and Overlay tabs. A VIEW — it writes
 * settings and asks main to act, and it never draws the overlay itself.
 * See docs/agents/settings-and-onboarding.md.
 */
const {ipcRenderer} = require('electron');
const {buildPreviewImage} = require('./overlay-preview');
const {presetToGlide} = require('../core/overlay-position');
const {mapLabelMode} = require('../shared/settings-defaults');
const {keyEventToVk, vkLabel, resolveMapVk, DEFAULT_MAP_VK} = require('../shared/key-codes');
const {manualCheckView} = require('../shared/update-message');
const i18n = require('./i18n');
const {t, onChange} = i18n;
const isWayland = require('../core/is-wayland');
const {showStatus} = require('./status');
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

class Options {
    constructor(settings, maps) {
        this.settings = settings;
        this.maps = maps;
        this.setting = false;
        this.previewActive = false;
        /** Last `{state, version}` from main, so the line can be re-translated. */
        this.updateCheckInfo = null;
        /** Between a click on "Check for updates now" and its outcome. */
        this.manualUpdateCheck = false;
        /** The "Game's map key" button is waiting for a keystroke. */
        this.recordingMapKey = false;
        const classInstance = this;

        // The sample map while the Overlay tab previews settings, the real map
        // otherwise.
        const refreshOverlay = () => {
            if (classInstance.previewActive) {
                classInstance.sendPreview();
            } else {
                // 'settings', not 'click': app.log collapses repeats of one key
                // from one source. `refresh` deliberately does not fall back to
                // `lastKey`, so a hidden map stays hidden.
                maps.send({type: 'refresh', source: 'settings'});
            }
        };

        if (settings.raw("draggable") === true) {
            $("#positionLabel").prop("disabled", true);
            $("#glideXRange, #glideYRange, #glideReset").prop("disabled", true);
            $("#dragCheck").prop("checked", true);
        } else {
            $("#set-pos").hide();
        }

        // The env vars survive the x11 relaunch (index.js).
        if (isWayland()) {
            $("#waylandWarning").removeClass("d-none");
        }

        $("#minimizeToTrayCheck").prop("checked", settings.raw("minimizeToTray") === true);
        $("#hiddenCheck").prop("checked", settings.raw("hideOverlay") === true);
        $("#disableFaqPopupCheck").prop("checked", settings.raw("disableFaqPopup") === true);
        // `=== true` here, `!== false` below: the shipped default decides which.
        // Why: the doc § Settings reference.
        $("#hardwareAccelerationCheck").prop("checked", settings.raw("hardwareAcceleration") === true);
        $("#checkForUpdatesCheck").prop("checked", settings.raw("checkForUpdates") !== false);
        $("#checkForMapPacksCheck").prop("checked", settings.raw("checkForMapPacks") !== false);
        $("#hideInMenuCheck").prop("checked", settings.raw("hideInMenu") !== false);

        // `.val()`/`.text()`: no OS string is interpolated into markup.
        const populateMonitors = async () => {
            const displays = await ipcRenderer.invoke('get-displays');
            const select = $("#monitorSelect");
            select.empty();
            displays.forEach(d => select.append($('<option>').val(d.index).text(displayLabel(d))));
            const saved = settings.raw('monitor');
            select.val(saved !== null && saved !== undefined ? saved : 0);
        };
        populateMonitors();

        // Its own handler, so main resolves "system" once and pushes the result
        // to every window and the tray.
        $("#languageSelect").on("input", async function () {
            const resolved = await ipcRenderer.invoke('set-language', $(this).val());
            await settings.refresh();
            i18n.setLanguage(resolved);
        }).val(settings.raw("language") || 'system');

        onChange(() => populateMonitors());

        $("#hiddenCheck").on("input", async function () {
            await settings.set("hideOverlay", $(this).prop('checked'));
            refreshOverlay();
        });
        $("#dragCheck").on("input", async function () {
            const val = $(this).prop('checked');
            await settings.set("draggable", val);
            if (val) {
                $("#positionLabel").prop("disabled", true);
                $("#glideXRange, #glideYRange, #glideReset").prop("disabled", true);
                $("#set-pos").show();
            } else {
                $("#positionLabel").prop("disabled", false);
                $("#glideXRange, #glideYRange, #glideReset").prop("disabled", false);
                $("#set-pos").hide();
            }
            refreshOverlay();
        });
        $("#minimizeToTrayCheck").on("input", async function () {
            await settings.set("minimizeToTray", $(this).prop('checked'));
        });
        $("#disableFaqPopupCheck").on("input", async function () {
            await settings.set("disableFaqPopup", $(this).prop('checked'));
        });
        $("#unloadWindowInTrayCheck").prop("checked", settings.raw("unloadWindowInTray") !== false);
        $("#unloadWindowInTrayCheck").on("input", async function () {
            await settings.set("unloadWindowInTray", $(this).prop('checked'));
        });
        $("#hardwareAccelerationCheck").on("input", async function () {
            // Restart-only, so the toast says so out loud.
            await settings.set("hardwareAcceleration", $(this).prop('checked'));
            showStatus(t('settings.hardwareAcceleration.restart'));
        });
        $("#checkForUpdatesCheck").on("input", async function () {
            await settings.set("checkForUpdates", $(this).prop('checked'));
        });
        // Works with the switch above off — the click is the consent — and
        // never touches it. Main decides with the pure `planManualUpdateCheck`.
        $("#checkUpdatesNowBtn").on("click", async function () {
            // Disabled on the spot, not on main's answer: it is a network call.
            const $button = $(this);
            $button.prop('disabled', true);
            classInstance.manualUpdateCheck = true;
            try {
                classInstance.renderUpdateCheckState(
                    await ipcRenderer.invoke('check-for-updates-now'), true);
            } catch (err) {
                // A rejected `invoke` would leave the button disabled forever:
                // the push that re-enables it is never coming.
                console.error('options::check-for-updates-now', err && err.message);
                classInstance.renderUpdateCheckState({state: 'failed'}, false);
                $button.prop('disabled', false);
                showStatus(t('update.manual.failed'));
            }
        });
        // The startup check moves the same state, so the button is disabled
        // while *that* one runs too.
        ipcRenderer.on('update-check-state', (event, info) => {
            classInstance.renderUpdateCheckState(info, true);
        });
        this.refreshUpdateCheckState();
        // Rebuilt on a language change, without toasting again.
        onChange(() => classInstance.renderUpdateCheckState(classInstance.updateCheckInfo, false));
        $("#hideInMenuCheck").on("input", async function () {
            await settings.set("hideInMenu", $(this).prop('checked'));
        });
        // The switch gates the request itself (main re-reads the setting on
        // every check); the button asks main to look right now.
        $("#checkForMapPacksCheck").on("input", async function () {
            await settings.set("checkForMapPacks", $(this).prop('checked'));
            classInstance.refreshMapPackStatus();
        });
        $("#checkMapPacksBtn").on("click", async function () {
            const $button = $(this);
            $button.prop('disabled', true);
            try {
                await ipcRenderer.invoke('check-map-packs');
            } finally {
                $button.prop('disabled', false);
            }
            classInstance.refreshMapPackStatus();
        });
        this.refreshMapPackStatus();
        onChange(() => classInstance.refreshMapPackStatus());
        // Main opens userData: the renderer never learns the path, it just asks.
        $("#openLogFolder").on("click", async function () {
            const result = await ipcRenderer.invoke('open-log-folder');
            if (!result || !result.ok) showStatus(t('settings.openLogFolder.failed'));
        });
        // `parseInt`, not the raw `.val()`: a range input hands back a string
        // and main writes a number. Why: the doc § Settings reference.
        $("#sizeRange").on("input", async function () {
            classInstance.syncReadouts();
            await settings.set("size", parseInt($(this).val(), 10) || 0);
            refreshOverlay();
        }).val(settings.raw("size"));

        // The corner preset doubles as a glide shortcut: picking a corner snaps
        // both sliders to it, then they fine-tune from there.
        const snapGlideToPreset = async () => {
            const corner = presetToGlide(settings.raw("position"));
            $("#glideXRange").val(corner.x);
            $("#glideYRange").val(corner.y);
            classInstance.syncReadouts();
            await settings.set("glideX", corner.x);
            await settings.set("glideY", corner.y);
        };

        $("#positionLabel").on("input", async function () {
            await settings.set("position", $(this).val());
            await snapGlideToPreset();
            refreshOverlay();
        }).val(settings.raw("position"));
        // A number, same as `size` above.
        $("#opacityRange").on("input", async function () {
            classInstance.syncReadouts();
            await settings.set("opacity", parseFloat($(this).val()) || 0);
            refreshOverlay();
        }).val(settings.raw("opacity"));

        // Snapped to the nearest quarter turn, in case a stray one was saved.
        const savedRotation = (Math.round((parseInt(settings.raw("rotation"), 10) || 0) / 90) * 90) % 360;
        $("#rotationSelect").on("input", async function () {
            await settings.set("rotation", parseInt($(this).val(), 10) || 0);
            refreshOverlay();
        }).val(String(savedRotation));

        // The preview carries a sample name, so "always" can be seen here.
        $("#mapLabelSelect").on("input", async function () {
            await settings.set("mapLabel", mapLabelMode($(this).val()));
            refreshOverlay();
        }).val(mapLabelMode(settings.raw("mapLabel")));

        $("#monitorSelect").on("input", async function () {
            await settings.set("monitor", parseInt($(this).val(), 10));
            refreshOverlay();
        });

        // These only write a setting and re-send the map: main rebuilds the
        // marker payload in `map-change`, so nothing here draws.
        const MARKER_SWITCHES = [
            ['#markersCheck', 'markers'],
            ['#markerCellarCheck', 'markerLayerCellar'],
            ['#markerGateCheck', 'markerLayerGate'],
            ['#markerCarCheck', 'markerLayerCar'],
            ['#markerGasCheck', 'markerLayerGas'],
            ['#markerLegendCheck', 'markerLegend']
        ];
        for (const [selector, key] of MARKER_SWITCHES) {
            $(selector).prop('checked', settings.raw(key) !== false);
            $(selector).on('input', async function () {
                await settings.set(key, $(this).prop('checked'));
                refreshOverlay();
            });
        }
        $("#markerOpacityRange").on("input", async function () {
            classInstance.syncReadouts();
            await settings.set("markerOpacity", parseFloat($(this).val()));
            refreshOverlay();
        }).val(settings.raw("markerOpacity") !== null && settings.raw("markerOpacity") !== undefined
            ? settings.raw("markerOpacity") : 0.9);

        // Its own handler, because main has to *act* on it: start or stop a
        // second window and a capture loop in the same breath.
        $("#tabMarkersCheck").prop('checked', settings.raw("tabMarkers") === true);
        $("#tabMarkersCheck").on("input", async function () {
            await ipcRenderer.invoke('set-tab-markers', $(this).prop('checked'));
            await settings.refresh();
        });
        this.syncTabMarkers(null);
        ipcRenderer.on('map-detector-status', (event, status) => {
            classInstance.syncTabMarkers(status);
        });

        // Recorded on the **button**, not on `document`, because
        // `src/js/hotkeys.js` owns a document keydown listener while it records
        // — and the handler stops the event dead, or Tab (the default!) would
        // just move focus away.
        $("#tabMarkerKeyBtn").on("click", function () {
            classInstance.recordingMapKey = true;
            $(this).text(t('settings.tabMarkers.mapKey.press')).addClass('active').focus();
        });
        $("#tabMarkerKeyBtn").on("blur", function () {
            // A click elsewhere cancels rather than leaving it armed.
            if (!classInstance.recordingMapKey) return;
            classInstance.recordingMapKey = false;
            classInstance.renderMapKey();
        });
        $("#tabMarkerKeyBtn").on("keydown", async function (event) {
            if (!classInstance.recordingMapKey) return;
            event.preventDefault();
            event.stopPropagation();
            const original = event.originalEvent || event;
            if (original.key === 'Escape') {
                classInstance.recordingMapKey = false;
                classInstance.renderMapKey();
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
            classInstance.recordingMapKey = false;
            // The label travels with the code — see the doc § Settings reference.
            await ipcRenderer.invoke('set-tab-marker-key', result.vk, result.label);
            await settings.refresh();
            classInstance.renderMapKey();
            classInstance.refreshTabMarkerMethod();
        });
        $("#tabMarkerKeyReset").on("click", async function () {
            classInstance.recordingMapKey = false;
            await ipcRenderer.invoke('set-tab-marker-key', DEFAULT_MAP_VK, 'Tab');
            await settings.refresh();
            classInstance.renderMapKey();
            classInstance.refreshTabMarkerMethod();
        });
        this.renderMapKey();

        // `TabMode` picks these two up through `settings.onChange`, so the
        // generic setter is enough.
        $("#tabHidesMinimapCheck").prop('checked', settings.raw("tabHidesMinimap") === true);
        $("#tabHidesMinimapCheck").on("input", async function () {
            await settings.set("tabHidesMinimap", $(this).prop('checked'));
        });

        $("#tabMarkersInstantCheck").prop('checked', settings.raw("tabMarkersInstant") !== false);
        $("#tabMarkersInstantCheck").on("input", async function () {
            await settings.set("tabMarkersInstant", $(this).prop('checked'));
        });

        // "Do not read the key state" — the escape hatch. Main switches method,
        // so this needs its own handler too.
        $("#markerTriggerPollingCheck").prop('checked', settings.raw("markerTrigger") === 'polling');
        $("#markerTriggerPollingCheck").on("input", async function () {
            await ipcRenderer.invoke('set-marker-trigger', $(this).prop('checked') ? 'polling' : 'auto');
            await settings.refresh();
            classInstance.refreshTabMarkerMethod();
        });
        this.refreshTabMarkerMethod();
        onChange(() => {
            classInstance.renderMapKey();
            classInstance.refreshTabMarkerMethod();
        });

        // `raw`, not `get`: a saved 0 must mean 0, not "follow the preset".
        const initialCorner = presetToGlide(settings.raw("position"));
        const savedGlideX = settings.raw('glideX');
        const savedGlideY = settings.raw('glideY');
        $("#glideXRange").on("input", async function () {
            classInstance.syncReadouts();
            await settings.set("glideX", parseInt($(this).val(), 10) || 0);
            refreshOverlay();
        }).val(savedGlideX !== null && savedGlideX !== undefined ? savedGlideX : initialCorner.x);
        $("#glideYRange").on("input", async function () {
            classInstance.syncReadouts();
            await settings.set("glideY", parseInt($(this).val(), 10) || 0);
            refreshOverlay();
        }).val(savedGlideY !== null && savedGlideY !== undefined ? savedGlideY : initialCorner.y);

        this.syncReadouts();
        onChange(() => classInstance.syncReadouts());
        $("#glideReset").on("click", async function () {
            await snapGlideToPreset();
            refreshOverlay();
        });

        $("#set-pos").on("click", function () {
            ipcRenderer.send('set-mouse-drag', true);
            $("#unset-pos").show();
            $("#set-pos").hide();
            classInstance.setting = true;
        });
        $("#unset-pos").on("click", function () {
            ipcRenderer.send('set-mouse-drag', false);
            $("#unset-pos").hide();
            $("#set-pos").show();
            classInstance.setting = false;
        });

        if (settings.raw("disableFaqPopup") !== true) {
            $("#warning").removeClass("d-none").addClass("show").slideDown();
        }

        // The sample map is up only while the Overlay tab is the active tab of
        // an open modal. Native listeners, not jQuery's: `.on()` would treat
        // ".bs.tab" as an event namespace and never fire.
        const overlayTab = document.getElementById('overlay-tab');
        const settingsModal = document.getElementById('settings');
        overlayTab.addEventListener('shown.bs.tab', () => classInstance.startPreview());
        overlayTab.addEventListener('hidden.bs.tab', () => classInstance.stopPreview());
        settingsModal.addEventListener('shown.bs.modal', () => {
            // Bootstrap keeps the last active tab across modal open/close.
            if (overlayTab.classList.contains('active')) classInstance.startPreview();
            // State main must not tear down — `shared/window-unload.js`.
            setBusy('settings', true);
        });
        settingsModal.addEventListener('hide.bs.modal', () => classInstance.stopPreview());
        settingsModal.addEventListener('hidden.bs.modal', () => setBusy('settings', false));
        // Minimize-to-tray leaves the modal "open" in a hidden window, but the
        // sample map must leave the overlay.
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                classInstance.stopPreview();
            } else if (settingsModal.classList.contains('show') && overlayTab.classList.contains('active')) {
                classInstance.startPreview();
            }
        });
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

    /**
     * Tab-map mode needs auto-detect, so the switch is **disabled with the
     * reason on screen** rather than enabled and inert.
     * @param {?{running: boolean}} status from `map-detector-status`, or null to
     *   ask for it
     */
    async syncTabMarkers(status) {
        const $check = $("#tabMarkersCheck");
        if (!$check.length) return;
        const info = status || await ipcRenderer.invoke('map-detector-status');
        const running = !!(info && info.running);
        $check.prop('disabled', !running);
        $("#tabMarkersNeedsDetect").toggleClass('d-none', running);
        this.refreshTabMarkerMethod();
    }

    /** Never translated: the label names a physical key. */
    renderMapKey() {
        const $value = $("#tabMarkerKeyValue");
        if (!$value.length) return;
        const vk = resolveMapVk(this.settings.raw('tabMarkerKey'));
        // `vkLabel` is the fallback, right only on a US keyboard.
        const stored = this.settings.raw('tabMarkerKeyLabel');
        $value.text((typeof stored === 'string' && stored.trim()) ? stored.trim() : vkLabel(vk));
        $("#tabMarkerKeyBtn").text(t('settings.tabMarkers.mapKey.change')).removeClass('active');
    }

    mapKeyLabel(info) {
        if (info && typeof info.mapKeyLabel === 'string' && info.mapKeyLabel) return info.mapKeyLabel;
        return vkLabel(info ? info.mapVk : null);
    }

    /**
     * Which of the two methods Tab-map mode is using, and why: they behave
     * slightly differently, so "it works differently on my PC" would otherwise
     * be unanswerable.
     */
    async refreshTabMarkerMethod() {
        const $line = $("#tabMarkerMethod");
        if (!$line.length) return;
        const info = await ipcRenderer.invoke('get-tab-marker-state');
        if (!info) return;
        this.tabMarkerInfo = info;
        let text = '';
        if (!info.setting) text = '';
        else if (info.method === 'key') text = t('settings.tabMarkers.method.key', {key: this.mapKeyLabel(info)});
        // Ready but the game is not running: "not available on this PC" would
        // be both false and alarming.
        else if (info.method === 'key-waiting') text = t('settings.tabMarkers.method.waiting', {key: this.mapKeyLabel(info)});
        else if (info.methodReason === 'forced') text = t('settings.tabMarkers.method.polling');
        else text = t('settings.tabMarkers.method.unavailable');
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

    /**
     * Fetched as well as pushed: this window can open while the startup check
     * is still running, or long after it finished.
     */
    async refreshUpdateCheckState() {
        this.renderUpdateCheckState(await ipcRenderer.invoke('get-update-check-state'), false);
    }

    /**
     * The button and the line under it. Every decision is the pure
     * `manualCheckView()`; `.text()`, never markup, because the version in it
     * comes off the release feed.
     * @param {?{state: string, version: ?string}} info from main
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
        $button.prop('disabled', view.disabled);
        const text = view.message ? i18n.translateMessage(view.message) : '';
        $("#updateCheckStatus").text(text);
        if (toast && this.manualUpdateCheck && text) showStatus(text);
        // Anything that is not "still running" ends the click this belonged to.
        if (!view.disabled) this.manualUpdateCheck = false;
    }

    /**
     * Re-read the controls main can change behind this window's back: the
     * opacity, size, rotation and markers hotkeys write in **main**, so an open
     * Settings modal *follows* rather than leads.
     */
    syncFromSettings() {
        const settings = this.settings;
        if ($("#opacityRange").length) $("#opacityRange").val(String(settings.raw("opacity")));
        if ($("#sizeRange").length) $("#sizeRange").val(String(settings.raw("size")));
        if ($("#rotationSelect").length) {
            $("#rotationSelect").val(String(parseInt(settings.raw("rotation"), 10) || 0));
        }
        if ($("#markersCheck").length) $("#markersCheck").prop('checked', settings.raw("markers") !== false);
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
        // Main re-applies its own `currentKey`, and deliberately **without**
        // `{preview: true}`: that flag forces the raw-base64 path, and a
        // catalogue key decoded as base64 is not an image.
        this.maps.send({type: 'preview-stop'});
    }
}

module.exports = Options;
