const {ipcRenderer} = require("electron");
const {debugLog} = require("./logger");

/**
 * Home-page switch and status line for the automatic map detection.
 *
 * All the work happens in the main process (`src/core/map-detector.js`); this
 * is the switch, the label under it, and nothing else. The switch writes the
 * `mapDetection` setting through the start/stop IPC handlers rather than
 * through `Settings.set`, so the loop and the stored value can never disagree.
 */
class Detector {

    constructor(settings) {
        this.settings = settings;
        this.lastKey = null;
        this.lastAt = null;
        // True between "the menu cleared the map" and the next detection.
        this.inMenu = false;
    }

    async init() {
        const self = this;
        const $check = $("#mapDetectionCheck");

        ipcRenderer.on('map-detector-status', (event, status) => self.render(status));

        $check.on("change", async function () {
            const on = $(this).is(":checked");
            $check.prop("disabled", true);
            try {
                const status = await ipcRenderer.invoke(on ? 'map-detector-start' : 'map-detector-stop');
                self.render(status);
            } finally {
                $check.prop("disabled", false);
            }
        });

        const status = await ipcRenderer.invoke('map-detector-status');
        debugLog("detector::init", JSON.stringify(status));
        this.render(status);
    }

    /**
     * "Off" / "Watching for the in-game map (Tab)…" / "Back in menu — map
     * cleared" / "Detected <Map> at 12:04".
     * @param {{running: boolean, lastDetected: ?string, lastAt: ?number,
     *          state: ?string, inMenu: ?boolean}} status
     */
    render(status) {
        const s = status || {};
        $("#mapDetectionCheck").prop("checked", !!s.running);

        if (s.lastDetected) {
            this.lastKey = s.lastDetected;
            this.lastAt = s.lastAt;
            this.inMenu = false;
        } else if (s.state === 'menu') {
            this.lastKey = null;
            this.lastAt = null;
            this.inMenu = true;
        } else if (s.state === 'watching') {
            // Ctrl+Shift+D cleared the last detection; go back to watching.
            this.lastKey = null;
            this.lastAt = null;
            this.inMenu = false;
        } else if (s.inMenu !== undefined) {
            // The one `invoke` at startup, which carries no `state`.
            this.inMenu = !!s.inMenu;
        }
        if (!s.running) {
            this.lastKey = null;
            this.lastAt = null;
            this.inMenu = false;
            $("#detectorStatus").text("Off");
            return;
        }
        if (this.inMenu && !this.lastKey) {
            $("#detectorStatus").text("Back in menu — map cleared");
            return;
        }
        if (!this.lastKey) {
            $("#detectorStatus").text("Watching for the in-game map (Tab)…");
            return;
        }
        const at = this.lastAt ? new Date(this.lastAt) : null;
        const clock = at
            ? ` at ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`
            : "";
        // .text(), never interpolated markup — the key comes from main, but the
        // rule in this app is that no map name ever reaches innerHTML unescaped.
        $("#detectorStatus").text(`Detected ${this.lastKey.split("/").pop()}${clock}`);
    }
}

module.exports = Detector;
