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

// Main sends `{key, params}`, not English: the language can change while a
// toast is on screen, and main has no business knowing which one is in force.
ipcRenderer.on("update-message", async (event, message) => {
    showStatus(i18n.translateMessage(message));
});

// The toast above auto-hides after 5 s; a downloaded update is too important
// for that, so it also raises a banner that stays until the user acts on it.
// **"Later" is remembered in main**, not here: this window is destroyed while
// the app sits in the tray (0.7), so a flag in the renderer meant the banner
// the user had already dismissed came back the next time they opened it. Main
// keeps the pending version and now the dismissal too, and the tray item stays
// there regardless.
let updateDismissed = false;
/** Kept so the banner can be re-translated when the language changes. */
let pendingVersion = null;

/**
 * Tell main the banner has actually been in front of a person.
 *
 * Until it has, the window is not torn down in the tray — the one thing the
 * user has to act on must not be thrown away unseen. It takes **focus**, not
 * `document.hidden`: a window built hidden paints (and therefore reports
 * itself `visible`) with Electron's default `paintWhenInitiallyHidden`, and a
 * window sitting behind the game is not one anybody has read.
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

// The hand-over to `hmo-updater.exe` (0.5.0). Main pushes this from
// `installUpdate()` rather than the click handler doing it, because the tray
// item is the other way in and both have to look the same. The view is the
// picture the helper opens on top of, so it goes up *immediately* — before
// anything is spawned — and it is never animated in: a slide would be a
// visible difference from the helper's own fade.
ipcRenderer.on("update-installing", async (event, info) => {
    const version = (info && info.version) || "";
    $("#updatingHeadline").text(updatingHeadline(i18n.language(), version));
    // `overflow: hidden` on the body, or the home page's scrollbar keeps a
    // 11 px strip of itself down the right edge of an otherwise full-window
    // view — and the helper, which has no scrollbar, would not have one there.
    $("body").addClass("is-updating");
    $("#updatingOverlay").removeClass("d-none");
});

// Only tier 1 (the themed helper) keeps the view: the stock installer draws its
// own window and a failure has to put the user back on a working home page.
ipcRenderer.on("update-install-result", async (event, result) => {
    if (result && result.themed) return;
    $("#updatingOverlay").addClass("d-none");
    $("body").removeClass("is-updating");
    // The failure toast itself is main's (`sendUpdate(msg('update.installFailed'))`),
    // so all that is left here is giving the button back.
    if (result && result.ok === false) {
        $("#updateRestart").prop("disabled", false).text(t('update.restart'));
    }
});

const settings = new Settings();
const maps = new Maps(settings);
const hotkeys = new Hotkeys(maps, settings);
const custom = new Custom(maps);
const detector = new Detector(settings);
const diagnostics = new Diagnostics();

document.addEventListener('DOMContentLoaded', async function () {
    // Before anything can open one: an open modal holds state that only exists
    // in this window, and main must not tear the window down underneath it.
    watchModals();
    // The product name is not translated; the version is not text.
    $("#title").text("Halloween Map Overlay v" + await ipcRenderer.invoke('version'));

    await settings.init();
    // Before anything renders: every view builds its markup with `t()`.
    await i18n.init();
    const options = new Options(settings, maps);
    maps.setOptions(options);

    await maps.loadCatalog();
    // Which map the overlay is showing is main's answer, not this window's
    // memory of it: this renderer may have been built seconds ago to replace
    // one that was torn down in the tray (or that crashed) mid-match.
    await maps.loadState();
    await maps.renderGallery();
    await custom.generateCustomList();
    await hotkeys.loadHotkeys();
    await detector.init();
    await diagnostics.init();
    // The welcome tour. Built here rather than beside the others because it
    // drives the *existing* settings controls (`options`) instead of holding
    // any state of its own.
    const tour = new Onboarding(options, hotkeys, detector, diagnostics);
    await tour.init();

    $("#updateLater").on("click", function () {
        updateDismissed = true;
        // Remembered in main for the rest of the session, so an unload and a
        // reopen do not put a dismissed banner back in the user's face.
        ipcRenderer.send('update-banner-dismissed');
        $("#updateReady").slideUp();
    });
    $("#updateRestart").on("click", function () {
        // No data-i18n any more once this is clicked: the app is on its way out.
        $(this).prop("disabled", true).removeAttr("data-i18n").text(t('update.restarting'));
        ipcRenderer.invoke('install-update');
    });
    // `update-downloaded` can fire before this window finished loading (it was
    // hidden in the tray and torn down, say), so ask as well as listen. Main
    // answers `null` once the banner has been dismissed with "Later", which is
    // what makes that dismissal survive the window being destroyed.
    const pendingUpdate = await ipcRenderer.invoke('get-pending-update');
    if (pendingUpdate) {
        updateDismissed = !!pendingUpdate.dismissed;
        showUpdateBanner(pendingUpdate.version);
    }

    // The tour opens once the loading view is out of the way — it is the last
    // thing this load does, so the crash notice, the hotkey-conflict banner,
    // the update banner and the hotkey-defaults notice are all already up
    // (behind it) rather than arriving on top of an open panel. It decides for
    // itself whether this is a genuinely fresh install.
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

// A renderer error used to exist only in a devtools console nobody has open.
// It is now forwarded to main, which writes it to app.log — the renderer never
// touches the file itself: two processes appending to one log with two size
// caches would lose lines at the rotation boundary.
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
