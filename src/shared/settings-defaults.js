'use strict';

/**
 * PURE default settings. Imports nothing — `src/core/settings.js` is the
 * fs/electron half that reads and writes `settings-app.json` in userData and
 * merges these over whatever it finds there.
 *
 * Split out so the tests can assert the defaults line up with the rest of the
 * app (every system hotkey has a stored accelerator, every enum default is one
 * of its allowed values) without pulling electron into a unit test.
 *
 * A key that is absent from a user's file is filled in from here on every
 * start, so adding one is backwards compatible; removing one is not.
 */
const DEFAULT_SETTINGS = {
    size: 250,
    position: 1,
    opacity: 0.5,
    draggable: false,
    hideOverlay: false,
    minimizeToTray: false,
    disableFaqPopup: false,
    checkForUpdates: true,
    // Automatic map detection. Off by default: it captures the game window
    // every 2 s (5 s once a map is known) while the game is running.
    mapDetection: false,
    // Clear the overlay when the detector sees the game's main menu again.
    // Only ever acts while `mapDetection` is on and a map has been detected.
    hideInMenu: true,
    // Map name on the overlay: 'auto' (a few seconds after an automatic
    // switch), 'always' or 'never'. See MAP_LABEL_MODES.
    mapLabel: 'auto',
    // UI language: 'system' (follow the OS locale), 'en' or 'it'.
    language: 'system',
    rotation: 0,
    monitor: 0,
    overlayX: null,
    overlayY: null,
    glideX: null,
    glideY: null,
    hotkeyToggleMap: 'CommandOrControl+H',
    hotkeyRotateMap: 'CommandOrControl+R',
    hotkeyNextMap: 'CommandOrControl+Right',
    hotkeyPrevMap: 'CommandOrControl+Left',
    hotkeyClearMap: 'CommandOrControl+Shift+D',
    hotkeyOpacityUp: 'CommandOrControl+Up',
    hotkeyOpacityDown: 'CommandOrControl+Down',
    hotkeySizeUp: 'CommandOrControl+Shift+Up',
    hotkeySizeDown: 'CommandOrControl+Shift+Down'
};

/** Allowed values of the `mapLabel` setting. */
const MAP_LABEL_MODES = ['auto', 'always', 'never'];

/**
 * Normalise a stored `mapLabel` value. A file hand-edited to nonsense must not
 * make the overlay do something undefined.
 * @param {*} value
 * @returns {'auto'|'always'|'never'}
 */
function mapLabelMode(value) {
    return MAP_LABEL_MODES.includes(value) ? value : 'auto';
}

module.exports = {DEFAULT_SETTINGS, MAP_LABEL_MODES, mapLabelMode};
