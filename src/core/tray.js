const {app, Menu, Tray} = require('electron');
const path = require('path');
const fs = require("fs");
const {t} = require('../shared/i18n');

class TrayController {
    mainWindow = null;
    tray = null;
    /** `Language` — the tray is drawn by main, so it translates for itself. */
    language = null;
    /** Version of a downloaded update, or null. Drives the extra menu item. */
    pendingUpdateVersion = null;

    constructor(mainWindow, language) {
        this.mainWindow = mainWindow;
        this.language = language || null;
    }

    /** Translate for the current UI language, falling back to English. */
    t(key) {
        return this.language ? this.language.t(key) : t('en', key);
    }

    create() {
        const trayIconPath = path.join(global.dirname, "src", "images", "icon.png");
        if (!fs.existsSync(trayIconPath)) {
            console.log("Tray icon not found at path:", trayIconPath);
            return;
        }
        this.tray = new Tray(trayIconPath);
        this.tray.setToolTip('Halloween Map Overlay');

        this.refreshMenu();

        let mainWindow = this.mainWindow;

        this.tray.on('double-click', () => {
            mainWindow.show();
            mainWindow.focus();
        });

        this.tray.on('click', () => {
            mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
        });
    }

    /**
     * Remember that an update is waiting and rebuild the menu so the
     * "Restart and update" item appears. Called from `MainWindow`'s
     * `update-downloaded` handler.
     */
    setUpdatePending(version) {
        this.pendingUpdateVersion = version || '';
        this.refreshMenu();
    }

    /**
     * Rebuild the context menu from scratch — Electron menus are immutable, so
     * a conditional item means a new template every time the condition changes.
     */
    refreshMenu() {
        if (!this.tray || this.tray.isDestroyed()) return;

        const mainWindow = this.mainWindow;
        const template = [
            {
                label: this.t('tray.show'),
                click: function () {
                    mainWindow.show();
                    mainWindow.focus();
                }
            }
        ];

        if (this.pendingUpdateVersion !== null) {
            template.push({type: 'separator'});
            template.push({
                label: this.t('tray.update'),
                click: function () {
                    mainWindow.installUpdate();
                }
            });
        }

        template.push({type: 'separator'});
        template.push({
            label: this.t('tray.quit'),
            click: function () {
                app.isQuiting = true;
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
