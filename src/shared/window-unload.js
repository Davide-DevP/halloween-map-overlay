'use strict';

/**
 * PURE: may the main window be destroyed right now? The impure half is
 * `core/main-window.js`. Every refusal below is something a user would notice
 * losing, which is why the decision is here with a test rather than inside a
 * timer callback. docs/agents/memory.md, docs/SPEC-MAP-STATE.md §5.
 */

/**
 * 45 s is past every tray round trip — rebuilding a renderer for each of those
 * costs more than leaving it alone — and far inside a match.
 */
const UNLOAD_GRACE_MS = 45000;

/** Every reason the window is kept, in the order they are checked. */
const KEEP_REASONS = [
    'no-window', 'quitting', 'installing', 'visible', 'minimized',
    'busy', 'recording', 'update-banner', 'grace'
];

/**
 * The unload has **no setting** any more (`unloadWindowInTray` until 1.0): it
 * is always on, and a stored `false` is ignored. Why: docs/agents/memory.md.
 *
 * @param {boolean} input.minimized minimised to the taskbar is **not** "hidden
 *   in the tray": it is still on the desktop and must restore instantly.
 * @param {number} input.hiddenAt epoch ms the window was hidden, 0 = not hidden
 * @param {Array<string>|Set<string>} [input.busy] reasons the view reported —
 *   each one is work whose state lives *in the renderer*.
 * @param {boolean} [input.recording] `Hotkeys.suspended`, known to main already
 * @param {boolean} [input.updateBannerShown] the banner has been on screen in a
 *   *visible* window, so the one thing the user must act on cannot be thrown
 *   away unseen.
 * @returns {{unload: boolean, reason: string, waitMs: number}} `waitMs` is how
 *   long before asking again; 0 means "nothing to wait for".
 */
function shouldUnloadMainWindow(input) {
    const o = input || {};
    const now = Number(o.now) || 0;
    const graceMs = Number.isFinite(o.graceMs) ? o.graceMs : UNLOAD_GRACE_MS;

    if (!o.hasWindow) return keep('no-window');
    // Both end with the process going away; neither wants a teardown racing it.
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
