'use strict';

/**
 * PURE default settings; `src/core/settings.js` is the fs/electron half. A
 * one-line note where the name does not say it.
 * Why: docs/agents/settings-and-onboarding.md § Settings reference.
 */
const DEFAULT_SETTINGS = {
    size: 250,                  // overlay width, px
    position: 1,                // corner preset, 1..4
    opacity: 0.5,               // overlay opacity, 0.1..1.0
    draggable: false,
    hideOverlay: false,
    minimizeToTray: false,
    disableFaqPopup: false,
    checkForUpdates: true,
    checkForMapPacks: true,     // docs/SPEC-MAP-PACKS.md
    mapDetection: false,        // the app's one screen capture
    hideInMenu: true,
    mapLabel: 'auto',           // MAP_LABEL_MODES
    markers: true,              // master switch (shared/marker-rules.js)
    markerLayerCellar: true,
    markerLayerGate: true,
    markerLayerCar: true,
    markerLayerGas: true,
    markerLegend: true,
    tabMarkers: false,          // Tab-map mode; needs `mapDetection`
    tabHidesMinimap: false,
    tabMarkersInstant: true,    // draw on key-down, from the second press on
    tabMarkerKey: 9,            // a Windows virtual-key code (9 = Tab)
    tabMarkerKeyLabel: 'Tab',   // what the browser called that key
    markerTrigger: 'auto',      // 'auto' (key trigger) | 'polling'
    markerOpacity: 0.9,         // brackets, 0.1..1.0; not the map's opacity
    language: 'system',         // 'system' (OS locale) | a catalogue code
    hardwareAcceleration: false, // restart-only
    unloadWindowInTray: true,
    onboardingPending: false,   // owed the welcome tour? MUST stay false
    onboardingDone: false,
    lastCrashSeen: null,        // newest crash-*.txt shown; a file name
    rotation: 0,                // degrees, multiple of 90
    monitor: 0,                 // display index
    overlayX: null,             // last dragged position, px
    overlayY: null,
    glideX: null,               // glide within the monitor, percent
    glideY: null,
    hotkeysGameOnly: true,
    hotkeyDefaultsVersion: 0,   // MUST stay behind HOTKEY_DEFAULTS_VERSION
    // A test asserts these agree with `SYSTEM_HOTKEY_DEFS`.
    hotkeyToggleMap: 'CommandOrControl+Alt+H',
    hotkeyRotateMap: 'CommandOrControl+Alt+R',
    hotkeyNextMap: 'CommandOrControl+Alt+Right',
    hotkeyPrevMap: 'CommandOrControl+Alt+Left',
    hotkeyClearMap: 'CommandOrControl+Alt+D',
    hotkeyOpacityUp: 'CommandOrControl+Alt+Up',
    hotkeyOpacityDown: 'CommandOrControl+Alt+Down',
    hotkeySizeUp: 'CommandOrControl+Alt+Shift+Up',
    hotkeySizeDown: 'CommandOrControl+Alt+Shift+Down',
    hotkeyToggleMarkers: 'CommandOrControl+Alt+M'
};

const MAP_LABEL_MODES = ['auto', 'always', 'never'];

/**
 * Normalise a stored `mapLabel`; a file hand-edited to nonsense must not make
 * the overlay do something undefined.
 * @returns {'auto'|'always'|'never'}
 */
function mapLabelMode(value) {
    return MAP_LABEL_MODES.includes(value) ? value : 'auto';
}

/**
 * Read **before `app.whenReady()`** (`index.js`) — after it,
 * `app.disableHardwareAcceleration()` has no effect. A non-boolean is the
 * shipped default, so a hand-edited file cannot add a third state.
 * @param {*} value the stored `hardwareAcceleration` value
 * @returns {boolean}
 */
function useHardwareAcceleration(value) {
    return typeof value === 'boolean' ? value : DEFAULT_SETTINGS.hardwareAcceleration;
}

module.exports = {DEFAULT_SETTINGS, MAP_LABEL_MODES, mapLabelMode, useHardwareAcceleration};
