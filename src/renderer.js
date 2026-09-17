const {ipcRenderer} = require('electron');

const Settings = require("./js/settings.js");
const Maps = require("./js/maps.js");
const Hotkeys = require("./js/hotkeys.js");
const Options = require("./js/options.js");
const Custom = require("./js/custom.js");
const Detector = require("./js/detector.js");
const {debugLog} = require("./js/logger.js");

let timeoutHide = null;
ipcRenderer.on("update-message", async (event, message) => {
    $("#logStatus").text(message).slideDown();
    if (timeoutHide !== null) clearTimeout(timeoutHide);
    timeoutHide = setTimeout(function () {
        $("#logStatus").slideUp();
        timeoutHide = null;
    }, 5000);
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
