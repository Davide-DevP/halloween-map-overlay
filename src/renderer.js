const {ipcRenderer} = require('electron');

const Settings = require("./js/settings.js");
const Maps = require("./js/maps.js");
const Hotkeys = require("./js/hotkeys.js");
const Options = require("./js/options.js");
const Custom = require("./js/custom.js");
const Detector = require("./js/detector.js");
const Diagnostics = require("./js/diagnostics.js");
const Onboarding = require("./js/onboarding.js");
const {debugLog} = require("./js/logger.js");
const {showStatus} = require("./js/status.js");
const {watchModals} = require("./js/busy.js");
const i18n = require("./js/i18n.js");
const {t} = i18n;
const {updateReadyHeadline, updatingHeadline} = require("./shared/update-message.js");

ipcRenderer.on("update-message", async (event, message) => {
    showStatus(i18n.translateMessage(message));
});

// **"Later" is remembered in main**, not here: this window is destroyed while
// the app sits in the tray, so a flag kept here put a dismissed banner back in
// the user's face on the next open.
let updateDismissed = false;
/** Kept so the banner can be re-translated when the language changes. */
let pendingVersion = null;

/**
 * Until the banner has been in front of a person the window is not torn down in
 * the tray. **Focus**, not `document.hidden`: a window built hidden paints (and
 * reports itself `visible`) under Electron's `paintWhenInitiallyHidden`.
 */
function noteBannerSeen() {
    if (pendingVersion === null || updateDismissed) return;
    if (!document.hasFocus()) return;
    ipcRenderer.send('update-banner-shown');
}

function showUpdateBanner(version) {
    pendingVersion = version || null;
    if (updateDismissed) return;
    // .text(), never interpolation: the version comes off the release feed.
    $("#updateReadyHeadline").text(updateReadyHeadline(i18n.language(), version));
    $("#updateReady").removeClass("d-none").hide().slideDown();
    noteBannerSeen();
}

// …and the moment the window is actually looked at counts, however it got there.
window.addEventListener('focus', noteBannerSeen);
document.addEventListener('visibilitychange', noteBannerSeen);

ipcRenderer.on("update-ready", async (event, info) => {
    showUpdateBanner(info && info.version);
});

i18n.onChange(() => {
    if (pendingVersion === null) return;
    $("#updateReadyHeadline").text(updateReadyHeadline(i18n.language(), pendingVersion));
});

// Pushed by main's `installUpdate()`, not by the click handler, because the
// tray item is the other way in. This view is the picture `hmo-updater.exe`
// opens on top of, so it goes up *immediately* and is never animated.
ipcRenderer.on("update-installing", async (event, info) => {
    const version = (info && info.version) || "";
    $("#updatingHeadline").text(updatingHeadline(i18n.language(), version));
    // `overflow: hidden` on the body, or the home page's scrollbar keeps an
    // 11 px strip down the right edge that the helper does not have.
    $("body").addClass("is-updating");
    $("#updatingOverlay").removeClass("d-none");
});

// Only tier 1 (the themed helper) keeps the view: the stock installer draws its
// own window and a failure has to put the user back on a working home page.
ipcRenderer.on("update-install-result", async (event, result) => {
    if (result && result.themed) return;
    $("#updatingOverlay").addClass("d-none");
    $("body").removeClass("is-updating");
    // The failure toast is main's (`sendUpdate(msg('update.installFailed'))`).
    if (result && result.ok === false) {
        $("#updateRestart").prop("disabled", false).text(t('update.restart'));
    }
});

const settings = new Settings();
const maps = new Maps(settings);
const hotkeys = new Hotkeys(maps, settings);
// Importing or removing a custom map changes the catalogue, so the map picker
// in the "add hotkey" modal has to be rebuilt too.
const custom = new Custom(maps, () => hotkeys.populateMapSelect());
const detector = new Detector(settings);
const diagnostics = new Diagnostics();

document.addEventListener('DOMContentLoaded', async function () {
    // Before anything can open one: an open modal holds state that exists only
    // here, and main must not tear the window down underneath it.
    watchModals();
    // The product name is not translated; the version is not text.
    $("#title").text("Halloween Map Overlay v" + await ipcRenderer.invoke('version'));

    await settings.init();
    // Before anything renders: every view builds its markup with `t()`.
    await i18n.init();
    // Injected: the Map tab's placement cards switch detection on through it.
    const options = new Options(settings, maps, detector);
    maps.setOptions(options);

    await maps.loadCatalog();
    // Main's answer, not this window's memory: this renderer may have been
    // built seconds ago to replace one torn down in the tray mid-match.
    await maps.loadState();
    await maps.renderGallery();
    await custom.generateCustomList();
    await hotkeys.loadHotkeys();
    await detector.init();
    await diagnostics.init();
    // The tour drives the *existing* settings controls rather than holding any
    // state of its own, hence built after them.
    const tour = new Onboarding(options, hotkeys, detector, diagnostics);
    await tour.init();

    $("#updateLater").on("click", function () {
        updateDismissed = true;
        ipcRenderer.send('update-banner-dismissed');
        $("#updateReady").slideUp();
    });
    $("#updateRestart").on("click", function () {
        // No data-i18n any more once this is clicked: the app is on its way out.
        $(this).prop("disabled", true).removeAttr("data-i18n").text(t('update.restarting'));
        ipcRenderer.invoke('install-update');
    });
    // `update-downloaded` can fire before this window finished loading, so ask
    // as well as listen. Main answers `null` after a "Later", which is what
    // makes that dismissal survive the window being destroyed.
    const pendingUpdate = await ipcRenderer.invoke('get-pending-update');
    if (pendingUpdate) {
        updateDismissed = !!pendingUpdate.dismissed;
        showUpdateBanner(pendingUpdate.version);
    }

    // The tour opens last, so every banner is already up behind it rather than
    // arriving on top of an open panel.
    $('#loadingOverlay').slideUp(function () {
        tour.maybeOpen().catch(err => debugLog("renderer::tour", err && err.message));
    });
    debugLog("renderer::ready",
        "maps=" + maps.catalog.length,
        "cards=" + $("#results .map-card").length,
        "customs=" + $("#customList tr").length);
    setTimeout(function () {
        $('#warning').slideUp();
    }, 15000);
});

// Forwarded to main, which writes them to app.log: the renderer never touches
// that file itself.
window.addEventListener('error', (e) => {
    console.error('renderer::uncaught', e.message, e.filename, e.lineno);
    ipcRenderer.send('renderer-error', {
        kind: 'error',
        message: e.message || '',
        source: e.filename || '',
        line: e.lineno,
        stack: (e.error && e.error.stack) || ''
    });
});
window.addEventListener('unhandledrejection', (e) => {
    console.error('renderer::unhandled-rejection', e.reason && e.reason.message);
    ipcRenderer.send('renderer-error', {
        kind: 'unhandledrejection',
        message: (e.reason && e.reason.message) || String(e.reason || ''),
        stack: (e.reason && e.reason.stack) || ''
    });
});
