const {ipcRenderer} = require("electron");

/**
 * "Do not tear this window down right now" — one input to the pure
 * `shared/window-unload.js`, for work whose state lives **in the renderer**.
 * `reason` is a short stable id and they are a *set* in main, so a nested pair
 * cannot switch the other off. Always clear one in a `finally`: a reason never
 * cleared keeps the window alive forever.
 */
function setBusy(reason, on) {
    try {
        ipcRenderer.send('window-busy', {reason, on: !!on});
    } catch (err) {
        // An optimisation, not a correctness requirement.
        console.error('busy report failed:', err && err.message);
    }
}

/**
 * Any open Bootstrap modal is a reason: each holds state that only exists here.
 * `shown`/`hidden`, not `show`/`hide` — the "ing" events can be cancelled.
 * No counter: nested modals cannot happen in this window.
 */
function watchModals() {
    document.addEventListener('shown.bs.modal', () => setBusy('modal', true), true);
    document.addEventListener('hidden.bs.modal', () => setBusy('modal', false), true);
}

module.exports = {setBusy, watchModals};
