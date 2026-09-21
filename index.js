global.dirname = __dirname
const {spawn} = require('child_process');
const isWayland = require("./src/core/is-wayland");

if (isWayland() && !process.argv.includes('--ozone-platform=x11')) {

    // Overlay positioning and click-through need X11 semantics Wayland has not.
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
    // **First, before anything else can throw**: a crash during module
    // construction is the one nobody can explain afterwards.
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
                // This process only shows the box and quits, so it reads the
                // language off the file rather than building a second Settings.
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
    // **Must stay before `app.whenReady()`**: `disableHardwareAcceleration()` is
    // ignored once the app is ready, which is why the setting is restart-only
    // and why `Settings` is built here. Off by default — docs/agents/memory.md.
    if (!useHardwareAcceleration(settings.get('hardwareAcceleration'))) {
        app.disableHardwareAcceleration();
    }
    // One callback, so the window's DOM and the tray (drawn by main) are
    // re-translated in the same breath instead of polling the setting.
    const language = new Language(settings, (lang) => {
        mainWindow.send('language-changed', lang);
        // Both re-label the marker legend in place rather than waiting for the
        // next map change; it is the only translated text either one has.
        overlayWindow.send('language-changed', lang);
        obsWindow.send('language-changed', lang);
        trayController.refreshMenu();
    });
    const mapLibrary = new MapLibrary();
    const obsWindow = new ObsWindow();
    const overlayWindow = new OverlayWindow(settings);
    const mainWindow = new MainWindow(obsWindow, overlayWindow, settings, mapLibrary, language);
    // The map state lives in **main**, which is what lets the main window be
    // torn down mid-match. See `docs/SPEC-MAP-STATE.md`.
    const mapController = new MapController(mainWindow, settings, mapLibrary);
    const hotkeys = new Hotkeys(mainWindow, settings, mapLibrary);
    hotkeys.setMapController(mapController);
    const userData = new UserData(mapLibrary);
    const trayController = new TrayController(mainWindow, language);
    const mapDetector = new MapDetector(mainWindow, settings);
    mapDetector.setMapController(mapController);
    mapController.setDetector(mapDetector);
    const mapPacks = new MapPacks(mainWindow, settings, mapLibrary);
    mapLibrary.setPackStore(mapPacks.store);
    mapDetector.setPackSource(() => mapPacks.templates());
    mapPacks.setDetector(mapDetector);
    // …and the hotkeys, so a map arriving after the first run still gets one.
    mapPacks.setHotkeys(hotkeys);
    const mapMarkers = new MapMarkers();
    mapMarkers.setPackSource((key) => mapPacks.markers(key));
    mainWindow.setMapMarkers(mapMarkers);
    const tabMode = new TabMode(settings, mapMarkers, language);
    tabMode.setDetector(mapDetector);
    tabMode.setCornerOverlay(overlayWindow);
    mapDetector.setTabMode(tabMode);
    // `keep`: its one notice ("the key state cannot be read on this PC") is a
    // behaviour change nobody asked for, so it waits for the next window.
    tabMode.setNotifier((message) => mainWindow.sendUpdate(message, {keep: true}));
    const diagnostics = new Diagnostics(mainWindow, settings);
    // `hotkeysGameOnly`: a ~1 s window scan, never a frame capture.
    const foregroundWatcher = new ForegroundWatcher(settings, (active) => hotkeys.setActive(active));
    hotkeys.setGameOnlyHandler(() => foregroundWatcher.syncWithSettings());

    // A failed settings write must not look like a save. `keep`, because it can
    // happen with no window: the overlay drag and the setting hotkeys still run.
    settings.setNotifier((message) => mainWindow.sendUpdate(message, {keep: true}));
    appLog.setContext({settings, language, mapLibrary});
    // Callbacks, not references: a report must see live state.
    diagnostics.setHealthCheck(() => hotkeys.getConflicts());
    // The watcher supplies what it observed; `Hotkeys` has the last word on
    // `active`/`gameOnly`, since it is the one that registers.
    diagnostics.setHotkeyState(() => Object.assign({}, foregroundWatcher.state(), hotkeys.activityState()));
    diagnostics.setMapPacks(() => mapPacks.info());
    // Utility process or in-process fallback: two very different main-thread costs.
    diagnostics.setDetectorSource(() => (mapDetector.frames && mapDetector.frames.status
        ? mapDetector.frames.status() : null));
    // "The markers are not there" has several legitimate causes (master switch,
    // a layer switch, auto-detect off, a map with no data).
    diagnostics.setMarkers(() => ({
        settings: settings.all(),
        maps: mapMarkers.keys(),
        tabMode: tabMode.status()
    }));
    diagnostics.setWindowState(() => mainWindow.unloadState());

    // What has to go before control passes to the installer. `tabMode` is the
    // second always-on-top window; `hotkeys` is the one that knows
    // (`suspended`) that the bind dialog is recording.
    mainWindow.setShutdownHooks({mapDetector, tray: trayController, tabMode, hotkeys});

    app.on('second-instance', (event, argv) => {
        const args = argv.slice(1);
        let showedMap = false;
        args.forEach(arg => {
            if (arg.startsWith('show-map=')) {
                const mapKey = arg.split('=').slice(1).join('=');
                console.log(`Opening map: ${mapKey}`);
                // Straight into main: there may be no window to route it through.
                mapController.select(mapKey, 'cli');
                showedMap = true;
            }
        });
        // The other process says "already running"; this one puts the window
        // back, so that answer is not followed by a window that never appears.
        if (!showedMap) mainWindow.show('second-instance');
        console.log(`Received args from second instance: ${args.join(" ")}`);
    });

    function createWindow() {
        mainWindow.show('startup')
        overlayWindow.show()
        trayController.create()
        // Here too: the shortcuts must work if the window never finishes loading.
        hotkeys.loadKeys()
        mapDetector.syncWithSettings()
        // **After `loadKeys()`**: its first verdict may be "not the game", and
        // that has to unregister a live set rather than race the registration.
        foregroundWatcher.syncWithSettings()
        // A timer, not a call: it lands after the update check, so the two do
        // not toast over each other.
        mapPacks.scheduleStartupCheck()
    }

    app.whenReady().then(() => {
        createWindow()
        // After the window: `screen` and `getGPUInfo` both need a ready app.
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

    // **This order is load-bearing.** The two always-on-top click-through
    // windows go first, before anything slow, so neither is left drawing over
    // the game; the buffered log is flushed last, or a session loses its final
    // 500 ms — the interesting part when the complaint is "it closed on its own".
    app.on('before-quit', () => {
        overlayWindow.close();
        tabMode.destroy();
        // `destroy()`, not `stop()`: it also shuts down the detector's utility
        // process, which must not outlive the app.
        mapDetector.destroy();
        mapPacks.destroy();
        foregroundWatcher.destroy();
        trayController.destroy();
        appLog.event('shutdown');
        appLog.flush();
    });
}
