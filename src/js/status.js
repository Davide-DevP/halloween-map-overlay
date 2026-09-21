/**
 * The status toast in the main window (`#logStatus`). One module, so main's
 * `update-message` and the renderer's own notices share one element and one
 * timer — two timers would leave the toast stuck open.
 */

const HIDE_MS = 5000;

/** ms one outcome is left alone: this element replaces rather than queues. */
const TOAST_READ_MS = 2600;

let hideTimer = null;

/** Already translated. `.text()`: some of these carry user-typed map names. */
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

module.exports = {showStatus, HIDE_MS, TOAST_READ_MS};
