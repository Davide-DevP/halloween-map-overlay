global.dirname = __dirname
const {spawn} = require('child_process');
const isWayland = require("./src/core/is-wayland");

if (isWayland() && !process.argv.includes('--ozone-platform=x11')) {

    // Overlay positioning and click-through rely on X11 semantics that Wayland
    // does not provide; respawn under XWayland instead of misbehaving.
    const args = [
        ...process.argv.slice(1),
        '--ozone-platform=x11',
    ];

    const child = spawn(process.execPath, args, {
        stdio: 'inherit'
    });

    child.on('error', (err) => {
        console.error('Wayland respawn failed:', err);
        process.exit(1);
    });

    child.on('exit', (code) => {
        process.exit(code);
    });
} else {

    const {app, BrowserWindow, dialog} = require('electron')
    // First, before anything else can throw: `app.log` and the crash handlers.
    // A crash during module construction is exactly the crash nobody can
    // explain afterwards, and `app.getPath` already works at this point (it is
    // what `Settings` reads its file with).
    const appLog = require("./src/core/app-log").init();
    appLog.installCrashHandlers();
    const ObsWindow = require("./src/core/obs-window");
    const MainWindow = require("./src/core/main-window");
    const OverlayWindow = require("./src/core/overlay-window");
    const MapLibrary = require("./src/core/map-library");
    const MapController = require("./src/core/map-controller");
    const Hotkeys = require("./src/core/hotkeys");
    const Settings = require("./src/core/settings");
    const UserData = require("./src/core/user-data");
    const TrayController = require("./src/core/tray");
    const MapDetector = require("./src/core/map-detector");
    const MapPacks = require("./src/core/map-packs");
    const MapMarkers = require("./src/core/map-markers");
    const TabMode = require("./src/core/tab-mode");
    const ForegroundWatcher = require("./src/core/foreground");
    const Language = require("./src/core/language");
    const Diagnostics = require("./src/core/diagnostics");
    const {t} = require("./src/shared/i18n");
    const {useHardwareAcceleration} = require("./src/shared/settings-defaults");

    const gotLock = app.requestSingleInstanceLock();

    if (!gotLock) {
        if (process.argv.length <= 1) {
            console.log("Another instance is already running.");
            app.whenReady().then(async () => {
                const tempWin = new BrowserWindow({show: false});
                // No Settings instance here: this process exists only to show
                // this box and quit, so the language is read straight off the
                // settings file rather than building a second IPC surface.
                const lang = Language.languageWithoutSettings();

                await dialog.showMessageBox(tempWin, {
                    type: 'info',
                    title: t(lang, 'app.alreadyRunning.title'),
                    message: t(lang, 'app.alreadyRunning.message'),
                    buttons: [t(lang, 'common.ok')]
                });

                app.quit();
            });
        } else {
            console.log(`Sending args to application: ${process.argv.slice(1).join(" ")}`);
            app.quit();
        }
        return;
    }

    const settings = new Settings();
    // **Before `app.whenReady()`, and it has to stay there**:
    // `disableHardwareAcceleration()` is ignored once the app is ready, which
    // is why this setting only takes effect on the next start (its help text
    // says so) and why `Settings` is built above rather than inside
    // `createWindow`.
    //
    // Off by default — measured, see `docs/MEMORY-REPORT-2.md` and the comment
    // on the setting itself. Chromium keeps a GPU process either way; without
    // acceleration it is a software display compositor and costs ~19 MB of
    // commit instead of ~77-95 MB. The overlay is a still image and an SVG,
    // so it looks identical, and the idle CPU is the same either way.
    if (!useHardwareAcceleration(settings.get('hardwareAcceleration'))) {
        app.disableHardwareAcceleration();
    }
    // Changing the language has to reach the window (which re-translates its
    // DOM) and the tray (which main draws itself) in the same breath, so the
    // two are rebuilt from one callback rather than each polling the setting.
    const language = new Language(settings, (lang) => {
        mainWindow.send('language-changed', lang);
        // The overlay and the OBS window draw the marker legend, which is the
        // only translated text either of them has. They re-label it in place
        // rather than waiting for the next map change.
        overlayWindow.send('language-changed', lang);
        obsWindow.send('language-changed', lang);
        trayController.refreshMenu();
    });
    const mapLibrary = new MapLibrary();
    const obsWindow = new ObsWindow();
    const overlayWindow = new OverlayWindow(settings);
    const mainWindow = new MainWindow(obsWindow, overlayWindow, settings, mapLibrary, language);
    // Which map is on the overlay, and every decision that changes it — the
    // hotkeys, the detector, the CLI, the gallery. It lives in **main** since
    // 0.7 (it was `src/js/maps.js` before), which is what lets the main window
    // be torn down while the app sits in the tray during a match. See
    // `docs/SPEC-MAP-STATE.md`.
    const mapController = new MapController(mainWindow, settings, mapLibrary);
    const hotkeys = new Hotkeys(mainWindow, settings, mapLibrary);
    hotkeys.setMapController(mapController);
    const userData = new UserData(mapLibrary);
    const trayController = new TrayController(mainWindow, language);
    const mapDetector = new MapDetector(mainWindow, settings);
    // Both ways: the loop hands every accepted match and the menu clear to the
    // controller, and the controller tells the loop what is on the overlay.
    mapDetector.setMapController(mapController);
    mapController.setDetector(mapDetector);
    // New and updated maps without an app release. Built after the window (it
    // toasts) and wired both ways here: the catalogue reads installed packs,
    // and the detector re-reads their templates when one lands.
    const mapPacks = new MapPacks(mainWindow, settings, mapLibrary);
    mapLibrary.setPackStore(mapPacks.store);
    mapDetector.setPackSource(() => mapPacks.templates());
    mapPacks.setDetector(mapDetector);
    // …and the hotkeys, so a map that arrives after the first run still gets
    // its Ctrl+Alt+N. `Hotkeys` owns the only `hotkeys.json` writer; this just
    // points at it.
    mapPacks.setHotkeys(hotkeys);
    // Markers: the possible cellar / gate / car / gas-can locations. One
    // `get-map-markers` for bundled maps and pack maps alike, with a pack
    // winning on a shared key exactly as it does for the image and the
    // templates.
    const mapMarkers = new MapMarkers();
    mapMarkers.setPackSource((key) => mapPacks.markers(key));
    mainWindow.setMapMarkers(mapMarkers);
    // Tab-map mode (experimental, off by default): the markers drawn straight
    // onto the game's own Tab map. Wired both ways — it needs the detector's
    // game-window lookup and its event log, and the detector tells it about
    // every accepted match, every gate verdict and every lost window.
    const tabMode = new TabMode(settings, mapMarkers, language);
    tabMode.setDetector(mapDetector);
    tabMode.setCornerOverlay(overlayWindow);
    mapDetector.setTabMode(tabMode);
    // The one notice it can produce: "reading your map key is not available on
    // this PC, using the slower method". Injected like `Settings.setNotifier`,
    // and translated on arrival in the renderer.
    // `keep`: it explains a change in behaviour the user did not ask for, so it
    // waits for the next window rather than being lost with the one that was
    // torn down in the tray. See `MainWindow.sendUpdate`.
    tabMode.setNotifier((message) => mainWindow.sendUpdate(message, {keep: true}));
    const diagnostics = new Diagnostics(mainWindow, settings);
    // `hotkeysGameOnly`: the global shortcuts are registered only while the
    // game (or one of our own windows) is in the foreground, so the
    // combinations belong to whatever else is in front the rest of the time.
    // A cheap ~1 s window scan, never a frame capture — see
    // `src/core/foreground.js` for the measured cost.
    const foregroundWatcher = new ForegroundWatcher(settings, (active) => hotkeys.setActive(active));
    hotkeys.setGameOnlyHandler(() => foregroundWatcher.syncWithSettings());

    // A settings write that fails must not look like a save. `Settings` is
    // built before the window, so the toast is wired up here. `keep`, because
    // it can happen while the window is torn down in the tray (the overlay's
    // drag handler and every hotkey that writes a setting still run then) and
    // "nothing you change is being saved" has to reach the user eventually.
    settings.setNotifier((message) => mainWindow.sendUpdate(message, {keep: true}));
    // What the startup snapshot and `system.txt` read from.
    appLog.setContext({settings, language, mapLibrary});
    // The one health check the report carries (0.3.2 §4): hotkeys that another
    // application already owns. `Hotkeys` is built after this class, so the
    // list is fetched through a callback rather than held.
    diagnostics.setHealthCheck(() => hotkeys.getConflicts());
    // …plus whether they are registered at all right now, which is the first
    // thing to check when the report says "the hotkeys do nothing".
    // The watcher supplies what it observed; `Hotkeys` has the last word on
    // `active`/`gameOnly`, since it is the one that actually registers.
    diagnostics.setHotkeyState(() => Object.assign({}, foregroundWatcher.state(), hotkeys.activityState()));
    // Which maps this install actually has, and whether the last look for new
    // ones worked: "I do not have the new map" is otherwise unanswerable.
    diagnostics.setMapPacks(() => mapPacks.info());
    // Which implementation is capturing: the utility process, or this one after
    // a fallback. Two very different main-thread costs, so a report has to say.
    diagnostics.setDetectorSource(() => (mapDetector.frames && mapDetector.frames.status
        ? mapDetector.frames.status() : null));
    // The marker settings plus Tab-map mode's state and last timings: "the
    // markers are not there" has several legitimate causes (the master switch,
    // a layer switch, auto-detect off, a map with no marker data) and the
    // report has to tell them apart.
    diagnostics.setMarkers(() => ({
        settings: settings.all(),
        maps: mapMarkers.keys(),
        tabMode: tabMode.status()
    }));
    // Is the main window there at all? Since 0.7 it is torn down while the app
    // sits in the tray, and "the window took a second to open" / "the report
    // says the hotkeys are registered but there is no window" both start here.
    diagnostics.setWindowState(() => mainWindow.unloadState());

    // Both are built after the main window. It needs the tray so a downloaded
    // update can add a "Restart and update" item, and needs both of them shut
    // down before it hands control over to the installer.
    // `tabMode` is in there for the same reason the overlay is closed first:
    // it is a second always-on-top window, and it must be gone before the
    // installer takes over.
    // `hotkeys` is in there for a different reason: the window must not be torn
    // down while the bind dialog is recording a combination, and `Hotkeys` is
    // the one that knows (`suspended`).
    mainWindow.setShutdownHooks({mapDetector, tray: trayController, tabMode, hotkeys});

    app.on('second-instance', (event, argv) => {
        const args = argv.slice(1);
        let showedMap = false;
        args.forEach(arg => {
            if (arg.startsWith('show-map=')) {
                const mapKey = arg.split('=').slice(1).join('=');
                console.log(`Opening map: ${mapKey}`);
                // Straight into main: a `show-map=` launched while this app is
                // minimised to the tray must put the map on the overlay, and
                // since 0.7 there may be no window to route it through.
                mapController.select(mapKey, 'cli');
                showedMap = true;
            }
        });
        // A plain second launch (no `show-map=`) is somebody trying to open the
        // app again. The second process shows them "it is already running";
        // this one puts the window back if we had torn it down, so that answer
        // is not followed by a window that never appears.
        if (!showedMap) mainWindow.show('second-instance');
        console.log(`Received args from second instance: ${args.join(" ")}`);
    });

    function createWindow() {
        mainWindow.show('startup')
        overlayWindow.show()
        trayController.create()
        // The renderer also asks for these on load; registering here means the
        // global shortcuts work even if the window never finishes rendering.
        hotkeys.loadKeys()
        // Opt-in, off by default; `mapDetection` remembers the home-page switch.
        mapDetector.syncWithSettings()
        // On by default. Started *after* `loadKeys()`: its first verdict may be
        // "not the game" and that has to unregister a live set rather than race
        // the registration.
        foregroundWatcher.syncWithSettings()
        // New maps. A timer, not a call: the window is up and must stay
        // responsive, and this deliberately lands after the update check so the
        // two requests do not toast over each other. At most once per 24 h, and
        // not at all with `checkForMapPacks` off.
        mapPacks.scheduleStartupCheck()
    }

    app.whenReady().then(() => {
        createWindow()
        // After the window, not before: `screen` and `getGPUInfo` both need a
        // ready app, and the snapshot is worth more than four milliseconds of
        // startup are.
        appLog.logStartup().catch(err => console.error('startup log failed:', err && err.message));
        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                createWindow()
            }
        })
    })

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') {
            app.quit()
        }
    })

    app.on('before-quit', () => {
        overlayWindow.close();
        // Before the detector: it is the other always-on-top click-through
        // window, and it must not be left drawing over the game while the app
        // is going away.
        tabMode.destroy();
        // `destroy()`, not `stop()`: it also shuts the detector's utility
        // process down, which must not outlive the app.
        mapDetector.destroy();
        mapPacks.destroy();
        foregroundWatcher.destroy();
        trayController.destroy();
        // Last thing: the buffered log must not lose the final 500 ms of a
        // session, which is precisely the interesting part when the complaint
        // is "it closed on its own".
        appLog.event('shutdown');
        appLog.flush();
    });
}
