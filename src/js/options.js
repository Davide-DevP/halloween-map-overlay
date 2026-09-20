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

/**
 * A display's label for the monitor picker. The OS usually supplies one
 * ("DELL U2720Q"), which is a device name and is never translated; only the
 * generated fallback is.
 * @param {{index, label, physicalWidth, physicalHeight, refreshRate}} display
 */
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

/** Settings modal: General and Overlay tabs. */
class Options {
    constructor(settings, maps) {
        this.settings = settings;
        this.maps = maps;
        this.setting = false;
        this.previewActive = false;
        /** Last `{state, version}` from main, so the line can be re-translated. */
        this.updateCheckInfo = null;
        /** True between a click on "Check for updates now" and its outcome. */
        this.manualUpdateCheck = false;
        /** True while the "Game's map key" button is waiting for a keystroke. */
        this.recordingMapKey = false;
        const classInstance = this;

        // Re-send whatever the overlay should currently show: the sample map
        // while the Overlay tab previews settings, the real map otherwise.
        const refreshOverlay = () => {
            if (classInstance.previewActive) {
                classInstance.sendPreview();
            } else {
                // 'settings', not 'click': a slider drag re-sends the same map
                // thirty times, and app.log collapses repeats of one key from
                // one source into a single line. `refresh` deliberately does
                // not fall back to `lastKey` — a settings change while the
                // overlay is hidden must not put a map back on screen.
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

        // The env vars survive the x11 relaunch (see index.js), so this still
        // detects the real session type
        if (isWayland()) {
            $("#waylandWarning").removeClass("d-none");
        }

        $("#minimizeToTrayCheck").prop("checked", settings.raw("minimizeToTray") === true);
        $("#hiddenCheck").prop("checked", settings.raw("hideOverlay") === true);
        $("#disableFaqPopupCheck").prop("checked", settings.raw("disableFaqPopup") === true);
        // Off by default, so the same `=== true` shape as the three above. The
        // resolver main reads it with (`useHardwareAcceleration`) treats a
        // non-boolean as the default, and this box agrees with it.
        $("#hardwareAccelerationCheck").prop("checked", settings.raw("hardwareAcceleration") === true);
        // All three default to on: only an explicit false turns them off
        $("#checkForUpdatesCheck").prop("checked", settings.raw("checkForUpdates") !== false);
        $("#checkForMapPacksCheck").prop("checked", settings.raw("checkForMapPacks") !== false);
        $("#hideInMenuCheck").prop("checked", settings.raw("hideInMenu") !== false);

        // Built with .val()/.text(): a display name comes from the OS, and this
        // app's rule is that nothing outside our own catalogues is interpolated
        // into markup.
        const populateMonitors = async () => {
            const displays = await ipcRenderer.invoke('get-displays');
            const select = $("#monitorSelect");
            select.empty();
            displays.forEach(d => select.append($('<option>').val(d.index).text(displayLabel(d))));
            const saved = settings.raw('monitor');
            select.val(saved !== null && saved !== undefined ? saved : 0);
        };
        populateMonitors();

        // The language select writes through its own IPC handler rather than
        // `set-setting`, so main resolves "system" once and pushes the result
        // back to every window and to the tray.
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
        // On by default, so `!== false` — and it takes effect at once: main
        // re-asks `shouldUnloadMainWindow` on the next hide.
        $("#unloadWindowInTrayCheck").prop("checked", settings.raw("unloadWindowInTray") !== false);
        $("#unloadWindowInTrayCheck").on("input", async function () {
            await settings.set("unloadWindowInTray", $(this).prop('checked'));
        });
        $("#hardwareAccelerationCheck").on("input", async function () {
            // Restart-only, like nothing else in this window — so it says so
            // out loud rather than leaving the user wondering why the app looks
            // exactly the same. `app.disableHardwareAcceleration()` is ignored
            // once the app is ready, and there is no runtime equivalent.
            await settings.set("hardwareAcceleration", $(this).prop('checked'));
            showStatus(t('settings.hardwareAcceleration.restart'));
        });
        $("#checkForUpdatesCheck").on("input", async function () {
            // Takes effect on the next start — the automatic check runs once at
            // startup. The button below is unaffected: it asks on demand.
            await settings.set("checkForUpdates", $(this).prop('checked'));
        });
        // "Check for updates now". It works with the switch above off — the
        // click is the consent — and it never touches the switch. Main decides
        // whether it does anything at all (dev build, portable build, a check
        // already in flight) with the pure `planManualUpdateCheck`.
        $("#checkUpdatesNowBtn").on("click", async function () {
            // Disabled on the spot rather than waiting for main's answer: the
            // round trip is a network call, and two of them would be one
            // `checkForUpdates` too many.
            const $button = $(this);
            $button.prop('disabled', true);
            classInstance.manualUpdateCheck = true;
            try {
                classInstance.renderUpdateCheckState(
                    await ipcRenderer.invoke('check-for-updates-now'), true);
            } catch (err) {
                // An `invoke` that rejects (the handler threw, main was
                // reloading) would otherwise leave the button disabled until
                // the app is restarted — the state push that would re-enable
                // it is never coming.
                console.error('options::check-for-updates-now', err && err.message);
                // Rendered as a plain `failed`, so the button, the line, the
                // remembered state (for a language change) and the toast flag
                // all come back to one consistent place.
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
        // Built with t(), so it has to be rebuilt when the language changes —
        // without toasting it again.
        onChange(() => classInstance.renderUpdateCheckState(classInstance.updateCheckInfo, false));
        // Read by the detector loop on every tick, so this takes effect at once
        $("#hideInMenuCheck").on("input", async function () {
            await settings.set("hideInMenu", $(this).prop('checked'));
        });
        // Map packs: the switch gates the request itself (main re-reads the
        // setting on every check, so switching it off stops the next one), and
        // the button asks main to look right now.
        $("#checkForMapPacksCheck").on("input", async function () {
            await settings.set("checkForMapPacks", $(this).prop('checked'));
            classInstance.refreshMapPackStatus();
        });
        $("#checkMapPacksBtn").on("click", async function () {
            const $button = $(this);
            // Disabled while it runs: the check is a network round trip and a
            // second one would only queue behind main's single-flight guard.
            $button.prop('disabled', true);
            try {
                await ipcRenderer.invoke('check-map-packs');
            } finally {
                $button.prop('disabled', false);
            }
            classInstance.refreshMapPackStatus();
        });
        this.refreshMapPackStatus();
        // "3 extra maps installed" is built with t(), so it has to be rebuilt
        // when the language changes.
        onChange(() => classInstance.refreshMapPackStatus());
        // userData, where `detector.log` lives. Main opens it with
        // `shell.openPath` — the renderer never learns the path, it just asks.
        $("#openLogFolder").on("click", async function () {
            const result = await ipcRenderer.invoke('open-log-folder');
            if (!result || !result.ok) showStatus(t('settings.openLogFolder.failed'));
        });
        // `parseInt`, not the raw `.val()`: a range input hands back a
        // **string**, and the same setting is written as a number by
        // `shared/map-state.js` when the size hotkeys move it. A settings file
        // that holds `"275"` one day and `275` the next makes `stepSize`'s
        // input, the diagnostic report and any future comparison depend on
        // which of the two last touched it.
        $("#sizeRange").on("input", async function () {
            classInstance.syncReadouts();
            await settings.set("size", parseInt($(this).val(), 10) || 0);
            refreshOverlay();
        }).val(settings.raw("size"));

        // The corner preset doubles as a glide shortcut: picking a corner snaps
        // both sliders to it, then they can fine-tune from there
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
        // Same as `size` above: a number, because the opacity hotkeys write one.
        $("#opacityRange").on("input", async function () {
            classInstance.syncReadouts();
            await settings.set("opacity", parseFloat($(this).val()) || 0);
            refreshOverlay();
        }).val(settings.raw("opacity"));

        // Snap any stored value to the nearest quarter turn in case a stray
        // rotation ever got saved
        const savedRotation = (Math.round((parseInt(settings.raw("rotation"), 10) || 0) / 90) * 90) % 360;
        $("#rotationSelect").on("input", async function () {
            await settings.set("rotation", parseInt($(this).val(), 10) || 0);
            refreshOverlay();
        }).val(String(savedRotation));

        // Map name on the overlay: auto (a few seconds after an automatic
        // switch), always, or never. The preview carries a sample name so
        // "always" can actually be seen while this tab is open.
        $("#mapLabelSelect").on("input", async function () {
            await settings.set("mapLabel", mapLabelMode($(this).val()));
            refreshOverlay();
        }).val(mapLabelMode(settings.raw("mapLabel")));

        $("#monitorSelect").on("input", async function () {
            await settings.set("monitor", parseInt($(this).val(), 10));
            refreshOverlay();
        });

        /*
         * ─── Markers ────────────────────────────────────────────────────────
         *
         * Every one of these defaults to **on**, so `!== false` rather than
         * `=== true`: a settings file written before markers existed must
         * behave like the shipped defaults, which is the same rule the pure
         * `isLayerEnabled` applies on the other side.
         *
         * They all just write a setting and re-send the map — main rebuilds the
         * marker payload in `map-change` (`MainWindow.markerPayload`), exactly
         * like it recomputes the rotated bounding box. Nothing here draws.
         */
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

        // Tab-map mode. Its own handler rather than `set-setting`, for the same
        // reason `mapDetection` and `hotkeysGameOnly` have one: main has to
        // *act* on it — start or stop a second window and a capture loop in the
        // same breath — and posting the setting alone would leave the two out
        // of step until the next restart.
        $("#tabMarkersCheck").prop('checked', settings.raw("tabMarkers") === true);
        $("#tabMarkersCheck").on("input", async function () {
            await ipcRenderer.invoke('set-tab-markers', $(this).prop('checked'));
            await settings.refresh();
        });
        // It needs auto-detect: without it nothing knows which map is on
        // screen. Disabled with the reason spelled out rather than silently
        // doing nothing, and kept in step with the home-page switch.
        this.syncTabMarkers(null);
        ipcRenderer.on('map-detector-status', (event, status) => {
            classInstance.syncTabMarkers(status);
        });

        /*
         * ─── The game's map key ─────────────────────────────────────────────
         *
         * A *virtual-key code*, not an accelerator: it is never registered, so
         * the key stays the game's and there is a key-up event. It therefore
         * goes nowhere near `globalShortcut`, the system-hotkey tables or
         * `hotkeys.json` — see `shared/key-codes.js`.
         *
         * Recorded on the **button**, not on `document`: `src/js/hotkeys.js`
         * owns a document-level keydown listener while it is recording an
         * accelerator, and two listeners must not swallow each other's keys.
         * The button has to be focused to record, and the handler stops the
         * event dead — otherwise pressing Tab (the default!) would just move
         * focus out of the control.
         */
        $("#tabMarkerKeyBtn").on("click", function () {
            classInstance.recordingMapKey = true;
            $(this).text(t('settings.tabMarkers.mapKey.press')).addClass('active').focus();
        });
        $("#tabMarkerKeyBtn").on("blur", function () {
            // Clicking elsewhere cancels rather than leaving the button armed.
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
                // Stay armed: the user pressed a modifier on the way to the
                // key they meant, which is the common case.
                if (result.status === 'modifier') return;
                showStatus(result.status === 'with-modifier'
                    ? t('settings.tabMarkers.mapKey.error.withModifier')
                    : t('settings.tabMarkers.mapKey.error.unsupported'));
                return;
            }
            classInstance.recordingMapKey = false;
            // The label travels with the code: only the browser knows what the
            // active layout calls that key, and a virtual-key code cannot be
            // turned back into a name on anything but a US keyboard.
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

        // Main acts on it through `settings.onChange` (see
        // `TabMode.syncCornerOverlay`), so the generic setter is enough.
        $("#tabHidesMinimapCheck").prop('checked', settings.raw("tabHidesMinimap") === true);
        $("#tabHidesMinimapCheck").on("input", async function () {
            await settings.set("tabHidesMinimap", $(this).prop('checked'));
        });

        // Same shape, same reason: `TabMode` reads it through `settings.onChange`
        // (`onSettingsChanged`), so the generic setter is enough. Default **on**,
        // so an unset value has to read as checked.
        $("#tabMarkersInstantCheck").prop('checked', settings.raw("tabMarkersInstant") !== false);
        $("#tabMarkersInstantCheck").on("input", async function () {
            await settings.set("tabMarkersInstant", $(this).prop('checked'));
        });

        // "Do not read the key state" — the escape hatch. Main switches method,
        // so this goes through its own handler like the mode switch itself.
        $("#markerTriggerPollingCheck").prop('checked', settings.raw("markerTrigger") === 'polling');
        $("#markerTriggerPollingCheck").on("input", async function () {
            await ipcRenderer.invoke('set-marker-trigger', $(this).prop('checked') ? 'polling' : 'auto');
            await settings.refresh();
            classInstance.refreshTabMarkerMethod();
        });
        this.refreshTabMarkerMethod();
        // Both are built with t(), so they follow a language change.
        onChange(() => {
            classInstance.renderMapKey();
            classInstance.refreshTabMarkerMethod();
        });

        // Raw settings access: a saved 0 must mean 0, not "unset -- follow the
        // corner preset"
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

        // Every slider carries its current value beside its label, in the mono
        // face with tabular figures so the number does not jitter while it is
        // dragged. Purely a readout: nothing here writes a setting, which is
        // why the hotkeys (`Maps.nudgeOpacity`/`nudgeSize`) can call it too.
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

        // Sample-map preview lifecycle: visible only while the Overlay tab is the
        // active tab of an open settings modal. Native listeners on purpose --
        // Bootstrap 5 dispatches these as native events, jQuery's .on() would
        // treat ".bs.tab" as an event namespace and never fire.
        const overlayTab = document.getElementById('overlay-tab');
        const settingsModal = document.getElementById('settings');
        overlayTab.addEventListener('shown.bs.tab', () => classInstance.startPreview());
        overlayTab.addEventListener('hidden.bs.tab', () => classInstance.stopPreview());
        settingsModal.addEventListener('shown.bs.modal', () => {
            // Bootstrap keeps the last active tab across modal open/close
            if (overlayTab.classList.contains('active')) classInstance.startPreview();
            // While this modal is open the window holds work with state in it
            // (a half-recorded hotkey, a tab the user is reading), so main must
            // not tear it down. See `shared/window-unload.js`.
            setBusy('settings', true);
        });
        settingsModal.addEventListener('hide.bs.modal', () => classInstance.stopPreview());
        settingsModal.addEventListener('hidden.bs.modal', () => setBusy('settings', false));
        // Covers minimize-to-tray and plain minimize: the settings modal stays
        // "open" in the hidden window, but the sample map must leave the overlay.
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                classInstance.stopPreview();
            } else if (settingsModal.classList.contains('show') && overlayTab.classList.contains('active')) {
                classInstance.startPreview();
            }
        });
    }

    /**
     * Re-read the four range sliders and print their values next to the labels.
     * Display only — it never touches `Settings`, so it is safe to call from
     * anywhere that moved a slider (the opacity/size hotkeys do).
     */
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
     * Keep the Tab-mode switch honest about needing auto-detect.
     *
     * The switch is **disabled with the reason on screen** while auto-detect is
     * off, rather than enabled and inert: the mode places its markers by the
     * map the detector recognised, so with the detector off there is nothing to
     * place them by, and a switch that can be turned on and then does nothing
     * is the worst of the three options.
     *
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
        // Whether the key trigger is in use depends on the mode running at all.
        this.refreshTabMarkerMethod();
    }

    /**
     * Name the key Tab-map mode is watching.
     *
     * `.text()` on a `<kbd>`, and the label is never translated: it names a
     * physical key, the same way a map name names a map.
     */
    renderMapKey() {
        const $value = $("#tabMarkerKeyValue");
        if (!$value.length) return;
        const vk = resolveMapVk(this.settings.raw('tabMarkerKey'));
        // The stored label is what the *active layout* called the key when it
        // was recorded; `vkLabel` is the fallback for an upgrade or a
        // hand-edited file, and is only right on a US keyboard.
        const stored = this.settings.raw('tabMarkerKeyLabel');
        $value.text((typeof stored === 'string' && stored.trim()) ? stored.trim() : vkLabel(vk));
        $("#tabMarkerKeyBtn").text(t('settings.tabMarkers.mapKey.change')).removeClass('active');
    }

    /** The map key's name, for the "which method" line. */
    mapKeyLabel(info) {
        if (info && typeof info.mapKeyLabel === 'string' && info.mapKeyLabel) return info.mapKeyLabel;
        return vkLabel(info ? info.mapVk : null);
    }

    /**
     * The line under the switches: which of the two methods Tab-map mode is
     * actually using, and why.
     *
     * It is shown because the two behave slightly differently (how soon the
     * markers appear, how often the window is looked at), and because "it
     * works differently on my PC" is otherwise unanswerable — the same reason
     * `system.txt` prints it.
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
        // Ready, but the game is not running: the key method *is* what will be
        // used, and nothing is being read in the meantime. Saying "not
        // available on this PC" here — which is what the two-state version did
        // — is both false and alarming.
        else if (info.method === 'key-waiting') text = t('settings.tabMarkers.method.waiting', {key: this.mapKeyLabel(info)});
        else if (info.methodReason === 'forced') text = t('settings.tabMarkers.method.polling');
        else text = t('settings.tabMarkers.method.unavailable');
        // A window whose capture is not its own rectangle (a bordered window)
        // would put every marker off by the border, so nothing is drawn — and
        // saying nothing about that would make it look simply broken.
        if (info.setting && info.sizeMismatch) text = t('settings.tabMarkers.method.windowed');
        $line.text(text);
    }

    /**
     * The line under the "Check for new maps" button: how many downloaded maps
     * this install has on top of the bundled ones.
     *
     * `.text()`, never interpolated markup — a pack's name is text this app did
     * not write, and the count is the only thing shown anyway.
     */
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
     * Ask main where the update check stands. The Settings window can be
     * opened while the startup check is still running (or long after it
     * finished), so the button's state is fetched as well as pushed.
     */
    async refreshUpdateCheckState() {
        this.renderUpdateCheckState(await ipcRenderer.invoke('get-update-check-state'), false);
    }

    /**
     * The "Check for updates now" button and the line under it.
     *
     * Every decision — disabled or not, and which sentence — comes from the
     * pure `manualCheckView()`; this only puts the answer on screen. The text
     * is `.text()`, never markup: the version in it comes off the release feed.
     *
     * @param {?{state: string, version: ?string}} info from main
     * @param {boolean} toast also show the outcome in the status toast. True
     *   for a real state change, false for a language re-render — and the
     *   toast is limited to a check the user asked for, so the automatic one
     *   at startup does not interrupt anybody twice.
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
     * Re-read the controls main can change behind this window's back.
     *
     * The opacity, size, rotation and markers hotkeys all write their setting
     * in **main** now (`shared/map-state.js`), so an open Settings modal has to
     * follow rather than being the thing that wrote it. Called from
     * `Maps.applyState` on a `map-state` push whose source is a hotkey.
     */
    syncFromSettings() {
        const settings = this.settings;
        if ($("#opacityRange").length) $("#opacityRange").val(String(settings.raw("opacity")));
        if ($("#sizeRange").length) $("#sizeRange").val(String(settings.raw("size")));
        if ($("#rotationSelect").length) {
            $("#rotationSelect").val(String(parseInt(settings.raw("rotation"), 10) || 0));
        }
        // `!== false`, like every other marker switch: a settings file written
        // before markers existed means "on".
        if ($("#markersCheck").length) $("#markersCheck").prop('checked', settings.raw("markers") !== false);
        this.syncReadouts();
    }

    startPreview() {
        this.previewActive = true;
        // Main has to know too: anything that lands on the overlay while the
        // preview is up asks this window to put the sample image back on top
        // (`refresh-preview`), which is what the renderer's own `sendMap` used
        // to do inline before the map state moved into main.
        this.maps.send({type: 'preview-start'});
        this.sendPreview();
    }

    async sendPreview() {
        const img = await buildPreviewImage();
        // The tab may have been left while the sample map was still rendering
        if (!this.previewActive) return;
        // The sample map has no catalogue name, so it brings its own. Main only
        // puts it on the overlay when the setting is "always" — which is the
        // point: the label can be seen here before it is turned on for real.
        ipcRenderer.send('map-change', img, {preview: true, mapLabel: t('overlay.sampleMap')});
    }

    stopPreview() {
        if (!this.previewActive) return;
        this.previewActive = false;
        // Put the overlay back to whatever it showed before the preview. Main
        // re-applies its own `currentKey` and does **not** use
        // `{preview: true}`: that flag forces the raw-base64 path, and a
        // catalogue key decoded as base64 is not an image — `imageSize` threw
        // and the overlay was left showing the sample map until something else
        // changed it.
        this.maps.send({type: 'preview-stop'});
    }
}

module.exports = Options;
