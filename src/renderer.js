const {ipcRenderer} = require('electron');

const Settings = require("./js/settings.js");
const Maps = require("./js/maps.js");
const Hotkeys = require("./js/hotkeys.js");
const Options = require("./js/options.js");
const Custom = require("./js/custom.js");
const Detector = require("./js/detector.js");
const {debugLog} = require("./js/logger.js");
const {showStatus} = require("./js/status.js");
const {updateReadyHeadline} = require("./shared/update-message.js");

ipcRenderer.on("update-message", async (event, message) => {
    showStatus(message);
});

// The toast above auto-hides after 5 s; a downloaded update is too important
// for that, so it also raises a banner that stays until the user acts on it.
// "Later" only silences it for this session — main keeps the pending version,
// and the tray item stays there too.
let updateDismissed = false;

function showUpdateBanner(version) {
    if (updateDismissed) return;
    // .text(), never interpolation: the version comes off the release feed.
    $("#updateReadyHeadline").text(updateReadyHeadline(version));
    $("#updateReady").removeClass("d-none").hide().slideDown();
}

ipcRenderer.on("update-ready", async (event, info) => {
    showUpdateBanner(info && info.version);
});

const settings = new Settings();
const maps = new Maps(settings);
const hotkeys = new Hotkeys(maps, settings);
const custom = new Custom(maps);
const detector = new Detector(settings);

document.addEventListener('DOMContentLoaded', async function () {
    $("#title").text("Halloween Map Overlay v" + await ipcRenderer.invoke('version'));

    await settings.init();
    const options = new Options(settings, maps);
    maps.setOptions(options);

    await maps.loadCatalog();
    await maps.renderGallery();
    await custom.generateCustomList();
    await hotkeys.loadHotkeys();
    await detector.init();

    $("#updateLater").on("click", function () {
        updateDismissed = true;
        $("#updateReady").slideUp();
    });
    $("#updateRestart").on("click", function () {
        $(this).prop("disabled", true).text("Restarting…");
        ipcRenderer.invoke('install-update');
    });
    // `update-downloaded` can fire before this window finished loading (it was
    // hidden in the tray, say), so ask as well as listen.
    const pendingUpdate = await ipcRenderer.invoke('get-pending-update');
    if (pendingUpdate) showUpdateBanner(pendingUpdate.version);

    $('#loadingOverlay').slideUp();
    debugLog("renderer::ready",
        "maps=" + maps.catalog.length,
        "cards=" + $("#results .map-card").length,
        "customs=" + $("#customList tr").length);
    setTimeout(function () {
        $('#warning').slideUp();
    }, 15000);
});

window.addEventListener('error', (e) => {
    console.error('renderer::uncaught', e.message, e.filename, e.lineno);
});
window.addEventListener('unhandledrejection', (e) => {
    console.error('renderer::unhandled-rejection', e.reason && e.reason.message);
});

// Importing or removing a custom map changes the catalogue, so the map picker
// in the "add hotkey" modal has to be rebuilt too.
window.addCustomMap = async function () {
    await custom.addCustomMap();
    hotkeys.populateMapSelect();
};

window.deleteImage = async function (button) {
    await custom.deleteCustomMap($(button).attr("data-img"));
    hotkeys.populateMapSelect();
};
