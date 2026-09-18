const {ipcRenderer} = require("electron");
const {debugLog} = require("./logger");
const {t, onChange} = require("./i18n");

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
        // The last status seen, so the line can be re-rendered in the new
        // language without waiting for the next push from main.
        this.lastStatus = null;
        onChange(() => this.render(this.lastStatus));
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
     * The small state dot beside the status line. Four states, taken from the
     * same status push that produces the sentence — nothing new is computed
     * here, it is the existing branch written out as an attribute so CSS can
     * colour it: `off` / `watching` / `menu` / `detected`.
     * @param {'off'|'watching'|'menu'|'detected'} state
     */
    setState(state) {
        $("#detectorReadout").attr("data-state", state);
    }

    /**
     * "Off" / "Watching for the in-game map (Tab)…" / "Back in menu — map
     * cleared" / "Detected <Map> at 12:04".
     * @param {{running: boolean, lastDetected: ?string, lastAt: ?number,
     *          state: ?string, inMenu: ?boolean}} status
     */
    render(status) {
        const s = status || this.lastStatus || {};
        this.lastStatus = s;
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
            this.setState('off');
            $("#detectorStatus").text(t('detector.off'));
            return;
        }
        if (this.inMenu && !this.lastKey) {
            this.setState('menu');
            $("#detectorStatus").text(t('detector.menu'));
            return;
        }
        if (!this.lastKey) {
            this.setState('watching');
            $("#detectorStatus").text(t('detector.watching'));
            return;
        }
        this.setState('detected');
        const at = this.lastAt ? new Date(this.lastAt) : null;
        // The map name is never translated; only the sentence around it is.
        const map = this.lastKey.split("/").pop();
        const text = at
            ? t('detector.detectedAt', {
                map,
                time: `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`
            })
            : t('detector.detected', {map});
        // .text(), never interpolated markup — the key comes from main, but the
        // rule in this app is that no map name ever reaches innerHTML unescaped.
        $("#detectorStatus").text(text);
    }
}

module.exports = Detector;
