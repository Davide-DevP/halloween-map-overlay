'use strict';

/**
 * Text for the "update ready" banner on the home page.
 *
 * Pure so it can be unit tested: the banner itself can only be seen by running
 * a packaged build against a real release, which no test can do.
 *
 * The version string comes from the GitHub release feed, i.e. from outside the
 * app, and is interpolated into the DOM. The renderer sets it with jQuery
 * `.text()` so it can never be markup, but anything that is not a plausible
 * version is dropped here as well rather than being echoed back at the user.
 */

const {t, msg} = require('./i18n');

const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

/**
 * "Version 0.2.1 is ready." — or a version-less fallback.
 * @param {string} lang 'en' | 'it'
 * @param {string} version from the GitHub release feed
 */
function updateReadyHeadline(lang, version) {
    const value = typeof version === 'string' ? version.trim() : '';
    if (!value || !VERSION_PATTERN.test(value)) return t(lang, 'update.ready.headlineUnknown');
    return t(lang, 'update.ready.headline', {version: value});
}

/**
 * "Updating to 0.5.1" — the headline of the full-window "updating" view, and
 * the same sentence `hmo-updater.exe` draws a moment later (the `headline` key
 * in `updater/strings.json`). The two have to stay word for word identical:
 * the helper opens at this window's exact bounds and the swap is meant to be
 * invisible.
 *
 * Same version guard as above — the string comes off the release feed.
 *
 * @param {string} lang 'en' | 'it'
 * @param {string} version
 */
function updatingHeadline(lang, version) {
    const value = typeof version === 'string' ? version.trim() : '';
    if (!value || !VERSION_PATTERN.test(value)) return t(lang, 'update.installing.headlineUnknown');
    return t(lang, 'update.installing.headline', {version: value});
}

/* ────────────────────────────────────────────────────────────────────────────
 * "Check for updates now" (Settings › General)
 *
 * The startup check only runs at startup, so an app that has been open for a
 * week never learns about a release. The button asks on demand. Everything it
 * decides — whether a click does anything at all, whether the button is
 * disabled, and which sentence goes next to it — lives here, because the two
 * halves that would otherwise own it (the updater events in
 * `core/main-window.js` and the markup in `js/options.js`) are both places a
 * test cannot reach: seeing a real answer needs a packaged build talking to a
 * real release feed.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Every state the check can be in. The middle five are electron-updater events
 * (`checking-for-update`, `update-available`, `update-downloaded`,
 * `update-not-available`, `error`); `busy`, `devBuild` and `portableBuild` are
 * the three answers a click can get without any network at all.
 */
const UPDATE_CHECK_STATES = [
    'idle', 'checking', 'found', 'downloaded', 'upToDate',
    'failed', 'busy', 'devBuild', 'portableBuild'
];

/**
 * States in which a check (or the download that follows one) is still running.
 * The button is disabled for exactly these: a second `checkForUpdates()` on a
 * live autoUpdater is at best wasted and at worst a duplicate download.
 * `found` is in the list because `autoDownload` is on — the download starts by
 * itself the moment a version is found and is not finished until `downloaded`.
 */
const BUSY_STATES = ['checking', 'found', 'busy'];

/** Is a check or its download still in flight? */
function isUpdateCheckBusy(state) {
    return BUSY_STATES.includes(state);
}

/**
 * Would starting another check right now be pointless? Busy, or an update that
 * is already downloaded and waiting for the banner. The **automatic** check
 * asks this: `show()` runs again on every tray reopen and its 4 s timer would
 * otherwise re-enter a check that is already in flight and flicker the state
 * (electron-updater dedupes the network work, but the button and the line beside
 * it are ours). The manual path needs the two apart, so it has its own branches.
 */
function isUpdateCheckOccupied(state) {
    return isUpdateCheckBusy(state) || state === 'downloaded';
}

/**
 * How long a busy state may go without moving before it is presumed dead.
 *
 * Two different numbers because they are two different waits: the HTTPS call
 * that asks GitHub whether a release exists should answer in seconds, while a
 * ~90 MB download legitimately takes minutes — but it emits `download-progress`
 * all the way through, so its silence is what is being measured, not its
 * duration.
 */
const CHECK_STALL_MS = 60000;
const DOWNLOAD_STALL_MS = 120000;

/**
 * The watchdog. Without it a download that dies mid-flight (the Wi-Fi drops and
 * no `error` event ever arrives) leaves the state at `found` and the button
 * disabled until the app is restarted.
 *
 * Liveness is **activity**, never elapsed time: `lastActivityAt` is bumped by
 * every state change *and* by every `download-progress` tick, so a slow but
 * progressing download is never cut off — it just keeps resetting this.
 *
 * @param {{state: string, lastActivityAt: ?number, now: number}} args
 * @returns {{stalled: boolean, state: string, waitMs: number}} `state` is what
 *   to move to (unchanged unless it stalled); `waitMs` is how long to wait
 *   before asking again, and 0 means "no watchdog needed" — so the caller can
 *   arm its timer from the same answer rather than duplicating the thresholds.
 */
function updateCheckStall({state, lastActivityAt, now} = {}) {
    const limit = isUpdateCheckBusy(state)
        ? (state === 'found' ? DOWNLOAD_STALL_MS : CHECK_STALL_MS)
        : 0;
    if (!limit) return {stalled: false, state, waitMs: 0};
    const at = Number(lastActivityAt);
    const nowAt = Number(now);
    // A missing, zero (nothing recorded yet) or nonsense timestamp, and a clock
    // that jumped backwards, are all treated as "just now": the watchdog waits
    // one more full period rather than declaring a live download dead on
    // arithmetic. Only a real, older timestamp can stall anything.
    const known = Number.isFinite(at) && at > 0 && Number.isFinite(nowAt) && nowAt > at;
    const since = known ? nowAt - at : 0;
    if (since >= limit) return {stalled: true, state: 'failed', waitMs: 0};
    return {stalled: false, state, waitMs: limit - since};
}

/**
 * The version if it is a plausible one, `''` otherwise — the same guard as the
 * two headlines above, for the same reason: the value comes off the release
 * feed, i.e. from outside the app. An empty answer picks the version-less
 * wording rather than echoing whatever arrived back at the user.
 */
function cleanVersion(version) {
    const value = typeof version === 'string' ? version.trim() : '';
    return value && VERSION_PATTERN.test(value) ? value : '';
}

/**
 * The button and the line beside it, for one state.
 *
 * @param {string} state one of `UPDATE_CHECK_STATES`
 * @param {?string} version the found version for `found`, the running one for
 *   `upToDate`; ignored by every other state
 * @returns {{disabled: boolean, message: ?{key: string, params: ?Object}}}
 *   a `msg()` shape, not English — the renderer translates it, so the line
 *   survives a language change (`i18n.onChange`).
 */
function manualCheckView(state, version) {
    const disabled = isUpdateCheckBusy(state);
    const named = cleanVersion(version);
    switch (state) {
        case 'checking':
            return {disabled, message: msg('update.checking')};
        case 'busy':
            return {disabled, message: msg('update.manual.busy')};
        case 'found':
            return {disabled, message: named
                ? msg('update.manual.found', {version: named})
                : msg('update.manual.foundUnknown')};
        // From here the existing green banner and the themed updater take over,
        // so this only has to stop saying "downloading".
        case 'downloaded':
            return {disabled, message: msg('update.downloaded')};
        case 'upToDate':
            return {disabled, message: named
                ? msg('update.manual.upToDate', {version: named})
                : msg('update.manual.upToDateUnknown')};
        // Offline, rate-limited, a 500 from GitHub: one sentence, never the
        // error object and never a path.
        case 'failed':
            return {disabled, message: msg('update.manual.failed')};
        case 'devBuild':
            return {disabled, message: msg('update.manual.devBuild')};
        case 'portableBuild':
            return {disabled, message: msg('update.manual.portableBuild')};
        default:
            return {disabled: false, message: null};
    }
}

/**
 * What a click should do.
 *
 * Deliberately **not** consulted: the `checkForUpdates` setting. The switch
 * governs the automatic check at startup; pressing the button is the user
 * asking, which is its own consent, and it leaves the switch alone.
 *
 * @param {{packaged: boolean, portable: boolean, state: string}} state of the
 *   app and of the check that may already be running (the startup one counts).
 * @returns {{start: boolean, state: string}} `start` is whether
 *   `autoUpdater.checkForUpdates()` should be called; `state` is what to show.
 */
function planManualUpdateCheck({packaged, portable, state} = {}) {
    // electron-updater does nothing useful without a release feed, and this app
    // does not fake `app.isPackaged` to pretend otherwise. Say so.
    if (!packaged) return {start: false, state: 'devBuild'};
    // The portable exe has nothing installed to replace; offering it the NSIS
    // installer would update a copy the user is not running.
    if (portable) return {start: false, state: 'portableBuild'};
    // Already downloaded: checking again would find the same release and the
    // banner is already up.
    if (state === 'downloaded') return {start: false, state: 'downloaded'};
    // A check is in flight — the startup one, or a previous click.
    if (isUpdateCheckBusy(state)) return {start: false, state: 'busy'};
    return {start: true, state: 'checking'};
}

module.exports = {
    updateReadyHeadline,
    updatingHeadline,
    manualCheckView,
    planManualUpdateCheck,
    isUpdateCheckBusy,
    isUpdateCheckOccupied,
    updateCheckStall,
    UPDATE_CHECK_STATES,
    CHECK_STALL_MS,
    DOWNLOAD_STALL_MS,
    VERSION_PATTERN
};
