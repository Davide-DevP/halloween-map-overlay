const {app, Menu, Tray} = require('electron');
const {markQuitting} = require('./quitting');
const path = require('path');
const fs = require("fs");
const {t} = require('../shared/i18n');

class TrayController {
    mainWindow = null;
    tray = null;
    language = null;
    /** Version of a downloaded update, or null. Drives the extra menu item. */
    pendingUpdateVersion = null;

    constructor(mainWindow, language) {
        this.mainWindow = mainWindow;
        this.language = language || null;
    }

    /** The tray is drawn by main, so it translates for itself; en is the fallback. */
    t(key) {
        return this.language ? this.language.t(key) : t('en', key);
    }

    create() {
        // The mark alone, not the tile: a dark tile on a dark taskbar is a blob at 16 px.
        const trayIconPath = path.join(global.dirname, "src", "images", "tray.png");
        if (!fs.existsSync(trayIconPath)) {
            console.log("Tray icon not found at path:", trayIconPath);
            return;
        }
        this.tray = new Tray(trayIconPath);
        this.tray.setToolTip('Halloween Map Overlay');

        this.refreshMenu();

        let mainWindow = this.mainWindow;

        // The window may not exist: it is destroyed while the app sits in the
        // tray. `show()` rebuilds it; `focus()`/`isVisible()` answer for "no
        // window" themselves.
        this.tray.on('double-click', () => {
            mainWindow.show('tray-double-click');
            mainWindow.focus();
        });

        this.tray.on('click', () => {
            mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show('tray-click');
        });
    }

    /** Called from `MainWindow`'s `update-downloaded`: grow the "Restart and update" item. */
    setUpdatePending(version) {
        this.pendingUpdateVersion = version || '';
        this.refreshMenu();
    }

    /**
     * Electron menus are immutable, so a conditional item means rebuilding the
     * whole template every time its condition changes.
     */
    refreshMenu() {
        if (!this.tray || this.tray.isDestroyed()) return;

        const mainWindow = this.mainWindow;
        const template = [
            {
                label: this.t('tray.show'),
                click: function () {
                    mainWindow.show('tray-menu');
                    mainWindow.focus();
                }
            }
        ];

        if (this.pendingUpdateVersion !== null) {
            template.push({type: 'separator'});
            template.push({
                label: this.t('tray.update'),
                click: function () {
                    // Same entry point as the banner, so main pushes the
                    // "updating" view either way. The catch only stops a
                    // rejection becoming uncaught inside a menu callback.
                    Promise.resolve(mainWindow.installUpdate()).catch(function (err) {
                        console.error('Install update from the tray failed:', err && err.message);
                    });
                }
            });
        }

        template.push({type: 'separator'});
        template.push({
            label: this.t('tray.quit'),
            click: function () {
                markQuitting();
                app.quit();
            }
        });

        this.tray.setContextMenu(Menu.buildFromTemplate(template));
    }

    destroy() {
        if (this.tray && !this.tray.isDestroyed()) {
            this.tray.destroy();
        }
    }
}

module.exports = TrayController
