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
    tabMarkerPad: null,         // a controller button code (shared/pad-codes.js); null = none
    markerTrigger: 'auto',      // 'auto' (key trigger) | 'polling'
    markerOpacity: 0.9,         // brackets, 0.1..1.0; not the map's opacity
    language: 'system',         // 'system' (OS locale) | a catalogue code
    hardwareAcceleration: false, // restart-only
    onboardingPending: false,   // owed the setup tutorial? MUST stay false
    onboardingDone: false,
    tourSeenVersion: 0,         // MUST stay behind TOUR_VERSION
    lastCrashSeen: null,        // newest crash-*.txt shown; a file name
    rotation: 0,                // degrees, multiple of 90
    monitor: 0,                 // display index
    overlayX: null,             // last dragged position, px
    overlayY: null,
    glideX: null,               // glide within the monitor, percent
    glideY: null,
    hotkeysGameOnly: true,
    hotkeyDefaultsVersion: 0,   // MUST stay behind HOTKEY_DEFAULTS_VERSION
    // A test asserts these agree with `SYSTEM_HOTKEY_DEFS`. `''` = ships with
    // no key (docs/agents/hotkeys.md § Defaults and the migration onto them).
    hotkeyToggleMap: 'CommandOrControl+Alt+H',
    hotkeyRotateMap: '',
    hotkeyNextMap: 'CommandOrControl+Alt+Right',
    hotkeyPrevMap: 'CommandOrControl+Alt+Left',
    hotkeyClearMap: 'CommandOrControl+Alt+D',
    hotkeyOpacityUp: '',
    hotkeyOpacityDown: '',
    hotkeySizeUp: '',
    hotkeySizeDown: '',
    hotkeyToggleMarkers: 'CommandOrControl+Alt+M'
};

const MAP_LABEL_MODES = ['auto', 'always', 'never'];

/** A `mapLabel` hand-edited to nonsense must not reach the overlay. */
function mapLabelMode(value) {
    return MAP_LABEL_MODES.includes(value) ? value : 'auto';
}

/**
 * Read **before `app.whenReady()`** (`index.js`) — after it,
 * `app.disableHardwareAcceleration()` has no effect. A non-boolean is the
 * shipped default, so a hand-edited file cannot add a third state.
 */
function useHardwareAcceleration(value) {
    return typeof value === 'boolean' ? value : DEFAULT_SETTINGS.hardwareAcceleration;
}

/** The two keys the one *Check for updates automatically* switch stands for. */
const NEWS_CHECK_KEYS = Object.freeze(['checkForUpdates', 'checkForMapPacks']);

/**
 * **On when either key is on**, never only when both: a file holding
 * `{checkForUpdates: true, checkForMapPacks: false}` still contacts GitHub on
 * every start, and a switch reading "off" over that would be the app lying
 * about its network use (AGENTS.md rule 1).
 */
function newsCheckState(settings) {
    const s = settings && typeof settings === 'object' ? settings : {};
    return {checked: NEWS_CHECK_KEYS.some(key => s[key] !== false)};
}

/** Off has to reach **both**, or the request the switch denies still happens. */
function settingsForNewsCheck(on) {
    const value = on === true;
    const out = {};
    for (const key of NEWS_CHECK_KEYS) out[key] = value;
    return out;
}

module.exports = {
    DEFAULT_SETTINGS,
    MAP_LABEL_MODES,
    NEWS_CHECK_KEYS,
    mapLabelMode,
    useHardwareAcceleration,
    newsCheckState,
    settingsForNewsCheck
};
