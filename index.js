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
    const Hotkeys = require("./src/core/hotkeys");
    const Settings = require("./src/core/settings");
    const UserData = require("./src/core/user-data");
    const TrayController = require("./src/core/tray");
    const MapDetector = require("./src/core/map-detector");
    const Language = require("./src/core/language");
    const Diagnostics = require("./src/core/diagnostics");
    const {t} = require("./src/shared/i18n");

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
    // Changing the language has to reach the window (which re-translates its
    // DOM) and the tray (which main draws itself) in the same breath, so the
    // two are rebuilt from one callback rather than each polling the setting.
    const language = new Language(settings, (lang) => {
        mainWindow.send('language-changed', lang);
        trayController.refreshMenu();
    });
    const mapLibrary = new MapLibrary();
    const obsWindow = new ObsWindow();
    const overlayWindow = new OverlayWindow(settings);
    const mainWindow = new MainWindow(obsWindow, overlayWindow, settings, mapLibrary, language);
    const hotkeys = new Hotkeys(mainWindow, settings, mapLibrary);
    const userData = new UserData(mapLibrary);
    const trayController = new TrayController(mainWindow, language);
    const mapDetector = new MapDetector(mainWindow, settings);
    const diagnostics = new Diagnostics(mainWindow, settings);

    // What the startup snapshot and `system.txt` read from.
    appLog.setContext({settings, language, mapLibrary});
    // The one health check the report carries (0.3.2 §4): hotkeys that another
    // application already owns. `Hotkeys` is built after this class, so the
    // list is fetched through a callback rather than held.
    diagnostics.setHealthCheck(() => hotkeys.getConflicts());

    // Both are built after the main window. It needs the tray so a downloaded
    // update can add a "Restart and update" item, and needs both of them shut
    // down before it hands control over to the installer.
    mainWindow.setShutdownHooks({mapDetector, tray: trayController});

    app.on('second-instance', (event, argv) => {
        const args = argv.slice(1);
        args.forEach(arg => {
            if (arg.startsWith('show-map=')) {
                const mapKey = arg.split('=').slice(1).join('=');
                console.log(`Opening map: ${mapKey}`);
                mainWindow.send('show-map-command', mapKey);
            }
        });
        console.log(`Received args from second instance: ${args.join(" ")}`);
    });

    function createWindow() {
        mainWindow.show()
        overlayWindow.show()
        trayController.create()
        // The renderer also asks for these on load; registering here means the
        // global shortcuts work even if the window never finishes rendering.
        hotkeys.loadKeys()
        // Opt-in, off by default; `mapDetection` remembers the home-page switch.
        mapDetector.syncWithSettings()
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
        mapDetector.stop();
        trayController.destroy();
        // Last thing: the buffered log must not lose the final 500 ms of a
        // session, which is precisely the interesting part when the complaint
        // is "it closed on its own".
        appLog.event('shutdown');
        appLog.flush();
    });
}
