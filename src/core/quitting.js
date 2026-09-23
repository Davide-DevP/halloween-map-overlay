'use strict';

/**
 * "The app is on its way out": set by every real quit (window close, tray
 * Quit, an update install) and read by the window handlers that would
 * otherwise hide instead of close. One process-wide flag, no electron import.
 * Why: docs/agents/overlay-windows.md § The overlay does not depend on the main window.
 */
let quitting = false;

function markQuitting() {
    quitting = true;
}

/** Only an install that failed before handing over takes it back. */
function clearQuitting() {
    quitting = false;
}

function isQuitting() {
    return quitting;
}

module.exports = {markQuitting, clearQuitting, isQuitting};
