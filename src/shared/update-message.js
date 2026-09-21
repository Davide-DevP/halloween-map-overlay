'use strict';

/**
 * PURE: the update banner's text and every decision behind *Check for updates
 * now*. Here because the two halves that would otherwise own it — the updater
 * events in main and the markup in the renderer — are both places no test can
 * reach. **The version string comes from outside the app** and reaches the
 * DOM, so anything implausible is dropped rather than echoed back.
 */

const {t, msg} = require('./i18n');

const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

/** "Version 0.2.1 is ready." — or a version-less fallback. */
function updateReadyHeadline(lang, version) {
    const value = typeof version === 'string' ? version.trim() : '';
    if (!value || !VERSION_PATTERN.test(value)) return t(lang, 'update.ready.headlineUnknown');
    return t(lang, 'update.ready.headline', {version: value});
}

/**
 * Also the sentence `hmo-updater.exe` draws a moment later (`headline` in
 * `updater/strings.json`). **The two must stay word for word identical** — the
 * helper opens at this window's exact bounds — and a test asserts it.
 */
function updatingHeadline(lang, version) {
    const value = typeof version === 'string' ? version.trim() : '';
    if (!value || !VERSION_PATTERN.test(value)) return t(lang, 'update.installing.headlineUnknown');
    return t(lang, 'update.installing.headline', {version: value});
}

/** The last three are the answers a click can get with no network at all. */
const UPDATE_CHECK_STATES = [
    'idle', 'checking', 'found', 'downloaded', 'upToDate',
    'failed', 'busy', 'devBuild', 'portableBuild'
];

/**
 * The button is disabled for exactly these: a second `checkForUpdates()` on a
 * live autoUpdater is at best wasted, at worst a duplicate download. `found`
 * is in the list because `autoDownload` is on.
 */
const BUSY_STATES = ['checking', 'found', 'busy'];

function isUpdateCheckBusy(state) {
    return BUSY_STATES.includes(state);
}

/**
 * Busy, or already downloaded — what the **automatic** check asks, because
 * `show()` runs on every tray reopen. The manual path needs the two apart.
 */
function isUpdateCheckOccupied(state) {
    return isUpdateCheckBusy(state) || state === 'downloaded';
}

/**
 * Two numbers for two waits: the HTTPS call should answer in seconds, while a
 * ~90 MB download takes minutes — but it emits `download-progress` throughout,
 * so **silence** is what is measured.
 */
const CHECK_STALL_MS = 60000;
const DOWNLOAD_STALL_MS = 120000;

/**
 * Without this a download that dies mid-flight (the Wi-Fi drops, no `error`
 * event arrives) leaves the state at `found` and the button disabled until the
 * app is restarted. Liveness is **activity**, never elapsed time.
 *
 * @returns {{stalled: boolean, state: string, waitMs: number}} `state` is what
 *   to move to; `waitMs` is how long before asking again, 0 = no watchdog, so
 *   the caller arms its timer from this rather than from a copy of the numbers.
 */
function updateCheckStall({state, lastActivityAt, now} = {}) {
    const limit = isUpdateCheckBusy(state)
        ? (state === 'found' ? DOWNLOAD_STALL_MS : CHECK_STALL_MS)
        : 0;
    if (!limit) return {stalled: false, state, waitMs: 0};
    const at = Number(lastActivityAt);
    const nowAt = Number(now);
    // A missing, zero or nonsense timestamp, and a clock that jumped back, all
    // count as "just now": one more full period rather than declaring a live
    // download dead on arithmetic.
    const known = Number.isFinite(at) && at > 0 && Number.isFinite(nowAt) && nowAt > at;
    const since = known ? nowAt - at : 0;
    if (since >= limit) return {stalled: true, state: 'failed', waitMs: 0};
    return {stalled: false, state, waitMs: limit - since};
}

/** `''` when implausible, which picks the version-less wording. */
function cleanVersion(version) {
    const value = typeof version === 'string' ? version.trim() : '';
    return value && VERSION_PATTERN.test(value) ? value : '';
}

/**
 * The button and the line beside it, for one state.
 *
 * @param {?string} version the found version for `found`, the running one for
 *   `upToDate`; ignored by every other state
 * @returns {{disabled: boolean, message: ?{key: string, params: ?Object}}} a
 *   `msg()` shape, never English, so the line survives a language change.
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
        // The green banner takes over; this only stops saying "downloading".
        case 'downloaded':
            return {disabled, message: msg('update.downloaded')};
        case 'upToDate':
            return {disabled, message: named
                ? msg('update.manual.upToDate', {version: named})
                : msg('update.manual.upToDateUnknown')};
        // Offline, rate-limited, a 500: one sentence, never the error or a path.
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
 * What a click should do. Deliberately **not** consulted: the `checkForUpdates`
 * setting — that switch governs the automatic check, and pressing the button is
 * its own consent. `state` includes a startup check that is still running.
 *
 * @returns {{start: boolean, state: string}} `start` = call
 *   `autoUpdater.checkForUpdates()`; `state` = what to show.
 */
function planManualUpdateCheck({packaged, portable, state} = {}) {
    // No release feed in dev, and this app does not fake `app.isPackaged`.
    if (!packaged) return {start: false, state: 'devBuild'};
    // The NSIS installer would update a copy the portable user is not running.
    if (portable) return {start: false, state: 'portableBuild'};
    // The same release would be found and the banner is already up.
    if (state === 'downloaded') return {start: false, state: 'downloaded'};
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
