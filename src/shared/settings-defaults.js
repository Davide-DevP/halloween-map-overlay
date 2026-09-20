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
    // Look for new and updated *maps* (map packs — see docs/SPEC-MAP-PACKS.md).
    // On by default, like the update check, and the same kind of request: one
    // HTTPS GET of a public file, nothing sent. With it off no request is made
    // at all — the gate is the pure `shouldCheckPacks`, so the startup check
    // and the "Check for new maps" button cannot disagree about it.
    checkForMapPacks: true,
    // Automatic map detection. Off by default: it captures the game window
    // every 2 s (5 s once a map is known) while the game is running.
    mapDetection: false,
    // Clear the overlay when the detector sees the game's main menu again.
    // Only ever acts while `mapDetection` is on and a map has been detected.
    hideInMenu: true,
    // Map name on the overlay: 'auto' (a few seconds after an automatic
    // switch), 'always' or 'never'. See MAP_LABEL_MODES.
    mapLabel: 'auto',
    // ─── Markers (shared/marker-rules.js) ───────────────────────────────────
    // Where a storm cellar, an escape gate, a car or a gas can MAY appear. On
    // by default: the data ships with the app, it costs nothing to draw, and on
    // the four bundled maps only the gas cans are actually added — the other
    // three rings are already part of the map images.
    markers: true,
    // The master switch's per-layer switches. Every one of them is read through
    // `isLayerEnabled`, which treats only an explicit `false` as off, so a
    // settings file written before markers existed behaves like these defaults.
    markerLayerCellar: true,
    markerLayerGate: true,
    markerLayerCar: true,
    markerLayerGas: true,
    // The legend chip naming the layers the app itself draws.
    markerLegend: true,
    // Markers drawn straight onto the game's own Tab map while Tab is held.
    // **Experimental and off by default**: it needs auto-detect, and it looks
    // at the game window a little more while the map key is held. See
    // docs/SPEC-MARKERS.md.
    tabMarkers: false,
    // With that mode running, do not show the corner minimap at all: the player
    // reads the game's own map instead. Off by default, and it only applies
    // while Tab-map mode is actually running — see `TabMode.syncCornerOverlay`.
    tabHidesMinimap: false,
    // Put those markers up the moment the map key goes down, instead of waiting
    // for a capture to confirm the game's map is really on screen.
    //
    // **On by default**, and it is only ever allowed from the *second* press of
    // a match onwards: it needs a press on that same map to have been confirmed
    // by the screen gate already, so the first Tab of every match is exactly as
    // slow and exactly as certain as it always was. The game fades its own map
    // in over 250-330 ms (measured, 39 presses), which is why the markers
    // arrived 320-530 ms after the press — this draws them faded in over the
    // same 300 ms instead, and takes them down again after 550 ms if no capture
    // agrees (`PROVISIONAL_DEADLINE_MS`). The cost is that a press where the
    // map does not open — the chat, the pause menu — can flash faintly once.
    // Off means "always wait": nothing can flash. See docs/SPEC-MARKERS.md.
    tabMarkersInstant: true,
    // The game's map key, as a **Windows virtual-key code** (9 = Tab). Not an
    // accelerator and never registered: Tab-map mode asks Windows whether this
    // one key is held (`GetAsyncKeyState`), which leaves the key with the game
    // and gives a key-*up* event, neither of which `globalShortcut` can do.
    // Configurable because the game lets players rebind it. See
    // `shared/key-codes.js`.
    tabMarkerKey: 9,
    // What that key is *called*, as the browser reported it when it was
    // recorded. Stored because a virtual-key code cannot be turned back into a
    // name on anything but a US layout: Windows calls the Italian `ò` key
    // `VK_OEM_3`, and only the browser knows it prints `ò`.
    tabMarkerKeyLabel: 'Tab',
    // How Tab-map mode notices the Tab screen: 'auto' (the key trigger, with an
    // automatic fall back to polling if it is unavailable) or 'polling' (force
    // the capture-only path). See `shared/tab-mode-rules.js`.
    markerTrigger: 'auto',
    // Opacity of the marker brackets, 0.1..1.0. Separate from the overlay's own
    // `opacity`: the map is a backdrop the player reads through, the markers
    // are the thing being read.
    markerOpacity: 0.9,
    // UI language: 'system' (follow the OS locale), 'en' or 'it'.
    language: 'system',
    // Draw the app's windows with the graphics card.
    //
    // **Off by default**, which is unusual for an Electron app and is a
    // measured decision, not a preference — see `docs/MEMORY-REPORT-2.md`.
    // With it off Chromium keeps its GPU process but drops it to a software
    // display compositor, and in the in-match state (a map on the overlay,
    // the main window in the tray, auto-detect on) that measured
    // **−14 MB of private working set and −59 MB of commit** on the
    // development machine, for **no measurable CPU** (0.24 % of one core with
    // it on against 0.19 % with it off, paired 5½-minute runs), and with no
    // visible difference on the overlay: it is
    // a still PNG plus an SVG with no animation of any kind, so there is
    // nothing for the GPU to accelerate. The window is moved by the OS
    // (`-webkit-app-region: drag` and `setPosition` from main), which the
    // renderer's raster mode does not touch.
    //
    // What it costs is the *main window's* UI — the gallery's fade-up, the
    // modal transitions — which is rastered on the CPU. That window is only
    // looked at between matches, and it is hidden in the tray during one.
    // Turning this back on is the escape hatch for a machine where software
    // compositing looks or feels wrong; the help text says so.
    hardwareAcceleration: false,
    // Free the main window's memory while the app sits in the tray.
    //
    // **On by default.** The window's renderer is ~32 MB of private working set
    // — about a quarter of everything the app holds in the in-match state — and
    // it is doing nothing at all while the player is in a match with the window
    // hidden. Since 0.7 nothing in a match depends on it: the map state, every
    // hotkey and the detector's route to the overlay are in the main process
    // (`shared/map-state.js` + `core/map-controller.js`), so the window is
    // destroyed after ~45 s in the tray and rebuilt when it is next wanted.
    // Reopening it costs the same as a cold start of that one window —
    // noticeable and brief, which is why the switch exists.
    //
    // It is deliberately *not* applied to a window minimised to the taskbar,
    // nor while the Settings modal, the welcome tour, a diagnostic report, an
    // import, a hotkey recording or an unseen update banner is in play. Those
    // rules are the pure `shared/window-unload.js`.
    unloadWindowInTray: true,
    // Is this user owed the welcome tour? The shipped default is **false** and
    // that is the load-bearing half: the back-fill puts this key into an
    // *existing* settings file too, so an upgrade is never interrupted. Only
    // `core/settings.js` sets it, once, on the start that creates the file.
    onboardingPending: false,
    // Has the welcome tour been seen (finished or skipped)? This is what keeps
    // it from opening twice; `onboardingPending` is what decides it was ever
    // owed. See `shared/onboarding-rules.js`.
    onboardingDone: false,
    // File name of the newest `crash-*.txt` the user has already been shown
    // the home-page notice for. Null means "never seen one", so any crash file
    // present at startup raises the banner. A file name, not a timestamp: the
    // names sort chronologically and cannot disagree with the files on disk.
    lastCrashSeen: null,
    rotation: 0,
    monitor: 0,
    overlayX: null,
    overlayY: null,
    glideX: null,
    glideY: null,
    // Register the global shortcuts only while the game (or one of this app's
    // own windows) is in the foreground. On by default: a global shortcut is
    // taken from every other application on the machine, and "my browser
    // stopped switching tabs" is not a trade a map viewer gets to make on the
    // user's behalf. Turning it off is the escape hatch for a game window this
    // app cannot identify.
    hotkeysGameOnly: true,
    // Which generation of default hotkeys this settings file has been through.
    // 0 = a file written before the Ctrl+Alt defaults existed, which is what
    // makes the one-time migration in `shared/hotkey-migration.js` possible:
    // the shipped default is deliberately *behind* HOTKEY_DEFAULTS_VERSION so
    // the back-fill cannot make an old file look already-migrated.
    hotkeyDefaultsVersion: 0,
    // The Ctrl+Alt defaults. See the comment above SYSTEM_HOTKEY_DEFS in
    // `shared/hotkeys-constants.js` for why none of them is a plain Ctrl
    // combination any more; a test asserts the two files agree.
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

/**
 * Should this start draw with the graphics card?
 *
 * Read **before `app.whenReady()`** (`index.js`), because
 * `app.disableHardwareAcceleration()` has no effect after the app is ready.
 * There is therefore no way to apply a change without a restart, which is what
 * the setting's help text says.
 *
 * Anything that is not a boolean is the shipped default: a hand-edited
 * settings file must not be able to put the app in a third state, and the
 * back-fill in `core/settings.js` already covers a *missing* key.
 *
 * @param {*} value the stored `hardwareAcceleration` value
 * @returns {boolean}
 */
function useHardwareAcceleration(value) {
    return typeof value === 'boolean' ? value : DEFAULT_SETTINGS.hardwareAcceleration;
}

module.exports = {DEFAULT_SETTINGS, MAP_LABEL_MODES, mapLabelMode, useHardwareAcceleration};
