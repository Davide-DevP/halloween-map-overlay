'use strict';

/**
 * PURE: may the main window be destroyed right now?
 *
 * The main window's renderer is ~32 MB of private working set
 * (`docs/MEMORY-REPORT-2.md` §3.3) doing nothing while the app sits in the tray
 * during a match. Since 0.7 nothing in a match depends on it — the map state,
 * every hotkey and the detector's route to the overlay live in the main process
 * (`shared/map-state.js` + `core/map-controller.js`) — so the window can simply
 * go away and be rebuilt when it is next wanted.
 *
 * "Simply" is doing a lot of work there, which is why the decision is here and
 * has a test rather than being a condition inside a timer callback. Every
 * refusal below is something a user would notice losing.
 *
 * The impure half is `core/main-window.js` (`scheduleUnload`/`unload`).
 */

/**
 * How long the window must have been hidden before it is torn down.
 *
 * A tray round trip — open it, glance at the gallery, close it again — is a
 * few seconds, and rebuilding a renderer for each one would be both slower and
 * more allocation churn than leaving it alone. 45 s is comfortably past every
 * "I just wanted to check something" and far inside a match.
 */
const UNLOAD_GRACE_MS = 45000;

/** Every reason the window is kept, in the order they are checked. */
const KEEP_REASONS = [
    'setting-off', 'no-window', 'quitting', 'installing', 'visible', 'minimized',
    'busy', 'recording', 'update-banner', 'grace'
];

/**
 * @param {Object} input
 * @param {*} input.setting the stored `unloadWindowInTray` value. Anything that
 *   is not an explicit `false` is "on" — the shipped default is `true` and a
 *   settings file written before the key existed must behave like it.
 * @param {boolean} input.hasWindow is there a window at all
 * @param {boolean} input.visible `BrowserWindow.isVisible()`
 * @param {boolean} input.minimized `BrowserWindow.isMinimized()` — minimise to
 *   the taskbar is **not** "hidden in the tray"; the window is still on the
 *   user's desktop and restoring it must be instant.
 * @param {number} input.hiddenAt epoch ms the window was hidden, 0 = not hidden
 * @param {number} input.now epoch ms
 * @param {Array<string>|Set<string>} [input.busy] reasons the view reported:
 *   the Settings modal, the welcome tour, a diagnostic report being built, a
 *   custom-map import. Each one is a piece of work with state *in the
 *   renderer*, and destroying it would throw that work away.
 * @param {boolean} [input.recording] the hotkey bind dialog is recording
 *   (`Hotkeys.suspended`). Main knows this already, so the view does not have
 *   to report it.
 * @param {boolean} [input.updatePending] an update has been downloaded
 * @param {boolean} [input.updateBannerShown] …and its banner has been on screen
 *   in a visible window. Until then the window stays, so the one thing the user
 *   has to act on cannot be thrown away unseen.
 * @param {boolean} [input.installing] an install is under way
 * @param {boolean} [input.quitting] `app.isQuiting`
 * @returns {{unload: boolean, reason: string, waitMs: number}} `waitMs` is how
 *   long to wait before asking again; 0 means "nothing to wait for".
 */
function shouldUnloadMainWindow(input) {
    const o = input || {};
    const now = Number(o.now) || 0;
    const graceMs = Number.isFinite(o.graceMs) ? o.graceMs : UNLOAD_GRACE_MS;

    if (o.setting === false) return keep('setting-off');
    if (!o.hasWindow) return keep('no-window');
    // Both of these end with the process going away or the window being
    // replaced, and neither wants a teardown racing it.
    if (o.quitting) return keep('quitting');
    if (o.installing) return keep('installing');
    if (o.visible) return keep('visible');
    if (o.minimized) return keep('minimized');

    const busy = toArray(o.busy);
    if (busy.length) return keep('busy');
    if (o.recording) return keep('recording');
    if (o.updatePending && !o.updateBannerShown) return keep('update-banner');

    const hiddenAt = Number(o.hiddenAt) || 0;
    if (!hiddenAt) return keep('no-window');
    const elapsed = now - hiddenAt;
    if (elapsed < graceMs) return {unload: false, reason: 'grace', waitMs: graceMs - elapsed};

    return {unload: true, reason: 'tray', waitMs: 0};
}

function keep(reason) {
    return {unload: false, reason, waitMs: 0};
}

function toArray(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value.size === 'number') return Array.from(value);
    return [];
}

module.exports = {UNLOAD_GRACE_MS, KEEP_REASONS, shouldUnloadMainWindow};
