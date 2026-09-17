const {BrowserWindow} = require('electron')
const path = require("path");

/**
 * Plain window showing the same map on a chroma-key green background, for
 * capturing the overlay in OBS without the transparency.
 */
class ObsWindow {

    window = null;

    show() {
        if (this.window) {
            if (!this.window.isDestroyed()) return
            this.window = null;
        }
        this.window = new BrowserWindow({
            width: 700,
            height: 700,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false
            },
            title: "Halloween Map Overlay for OBS",
            icon: path.join(global.dirname, "src", "images", "icon.png")
        })
        this.window.loadFile('src/map/map_obs.html')
        this.window.setMenu(null)
        this.window.on("closed", () => {
            this.window = null;
        })
    }

    send(event, ...data) {
        if (this.window && !this.window.isDestroyed()) {
            this.window.webContents.send(event, ...data);
        }
    }

    close() {
        if (this.window) {
            if (!this.window.isDestroyed()) this.window.close();
            this.window = null;
        }
    }
}

module.exports = ObsWindow;
