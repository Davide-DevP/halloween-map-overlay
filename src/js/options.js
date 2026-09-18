const {ipcRenderer} = require('electron');
const {buildPreviewImage} = require('./overlay-preview');
const {presetToGlide} = require('../core/overlay-position');
const {mapLabelMode} = require('../shared/settings-defaults');
const i18n = require('./i18n');
const {t, onChange} = i18n;
const isWayland = require('../core/is-wayland');
const {showStatus} = require('./status');

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
        const classInstance = this;

        // Re-send whatever the overlay should currently show: the sample map
        // while the Overlay tab previews settings, the real map otherwise.
        const refreshOverlay = () => {
            if (classInstance.previewActive) {
                classInstance.sendPreview();
            } else {
                // 'settings', not 'click': a slider drag re-sends the same map
                // thirty times, and app.log collapses repeats of one key from
                // one source into a single line.
                maps.sendMap(maps.currentKey, {source: 'settings'});
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
        // Both default to on: only an explicit false turns them off
        $("#checkForUpdatesCheck").prop("checked", settings.raw("checkForUpdates") !== false);
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
        $("#checkForUpdatesCheck").on("input", async function () {
            // Takes effect on the next start — the check runs once at startup
            await settings.set("checkForUpdates", $(this).prop('checked'));
        });
        // Read by the detector loop on every tick, so this takes effect at once
        $("#hideInMenuCheck").on("input", async function () {
            await settings.set("hideInMenu", $(this).prop('checked'));
        });
        // userData, where `detector.log` lives. Main opens it with
        // `shell.openPath` — the renderer never learns the path, it just asks.
        $("#openLogFolder").on("click", async function () {
            const result = await ipcRenderer.invoke('open-log-folder');
            if (!result || !result.ok) showStatus(t('settings.openLogFolder.failed'));
        });
        $("#sizeRange").on("input", async function () {
            classInstance.syncReadouts();
            await settings.set("size", $(this).val());
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
        $("#opacityRange").on("input", async function () {
            classInstance.syncReadouts();
            await settings.set("opacity", $(this).val());
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
        });
        settingsModal.addEventListener('hide.bs.modal', () => classInstance.stopPreview());
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
    }

    startPreview() {
        this.previewActive = true;
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
        // Put the overlay back to whatever it showed before the preview.
        // Through `sendMap`, NOT `{preview: true}`: that flag forces main down
        // the raw-base64 path, and a catalogue key decoded as base64 is not an
        // image — `imageSize` threw and the overlay was left showing the sample
        // map until something else changed it.
        this.maps.sendMap(this.maps.currentKey || "", {source: 'preview'});
    }
}

module.exports = Options;
