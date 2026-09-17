/**
 * The status toast in the bottom-right corner of the main window (`#logStatus`).
 *
 * Main-process messages arrive on the `update-message` channel and land here;
 * the renderer's own short-lived notices (a hotkey changed the opacity, say)
 * call `showStatus` directly rather than taking a round trip through main.
 * One module so both share the same element and the same auto-hide timer —
 * two independent timers would leave the toast stuck open.
 */

/** How long the toast stays up before it slides away. */
const HIDE_MS = 5000;

let hideTimer = null;

/**
 * Show a short status line. The text is already translated — `.text()`, never
 * markup: some of these carry map names, which can be user-typed.
 * @param {string} message
 */
function showStatus(message) {
    const text = message === null || message === undefined ? '' : String(message);
    if (!text) return;
    $("#logStatus").text(text).slideDown();
    if (hideTimer !== null) clearTimeout(hideTimer);
    hideTimer = setTimeout(function () {
        $("#logStatus").slideUp();
        hideTimer = null;
    }, HIDE_MS);
}

module.exports = {showStatus, HIDE_MS};
