const {ipcRenderer} = require("electron");

/**
 * "Do not tear this window down right now."
 *
 * Since 0.7 the main window is **destroyed** while the app sits in the tray
 * during a match — nothing in a match depends on it any more, and it is ~32 MB
 * of private working set (`docs/MEMORY-REPORT-2.md` §3.3). The decision is the
 * pure `shared/window-unload.js`, and one of its inputs is this: work that has
 * state **in the renderer** and would simply be thrown away.
 *
 * Four reasons use it today — the Settings modal, the welcome tour, a
 * diagnostic report being built and a custom-map import. The hotkey bind dialog
 * does not need one: main already knows it is recording (`Hotkeys.suspended`).
 *
 * Reasons are a set in main, so a nested pair (the tour drives the Settings
 * controls) cannot switch the other one off. Always clear a reason in a
 * `finally`: a reason that is never cleared keeps the window alive forever,
 * which is a memory leak with a very long fuse.
 *
 * @param {string} reason a short stable id
 * @param {boolean} on
 */
function setBusy(reason, on) {
    try {
        ipcRenderer.send('window-busy', {reason, on: !!on});
    } catch (err) {
        // Reporting busy is an optimisation, never a correctness requirement:
        // the worst case is a window torn down a little sooner than ideal.
        console.error('busy report failed:', err && err.message);
    }
}

/**
 * Count **any** open Bootstrap modal as a reason.
 *
 * Every modal in this window holds state that only exists here — a file the
 * user picked in *Add custom image*, a half-recorded accelerator in the bind
 * dialog, the tab of Settings they were reading — and destroying the window
 * throws all of it away without a word. The specific reasons (`settings`, the
 * tour, a report, an import) stay because they are longer-lived than the modal
 * that started them; this is the blanket one.
 *
 * `shown`/`hidden`, not `show`/`hide`: the "ing" events can be cancelled.
 * Nested modals cannot happen in this window, so a counter is not needed —
 * but the reason is cleared on `hidden` from *whichever* modal closes, and a
 * reload clears the whole set in main anyway.
 */
function watchModals() {
    document.addEventListener('shown.bs.modal', () => setBusy('modal', true), true);
    document.addEventListener('hidden.bs.modal', () => setBusy('modal', false), true);
}

module.exports = {setBusy, watchModals};
