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
        /** Anything else that draws this switch — see `onStatus`. */
        this.statusListeners = [];
        onChange(() => this.render(this.lastStatus));
    }

    async init() {
        const self = this;

        ipcRenderer.on('map-detector-status', (event, status) => self.render(status));

        $("#mapDetectionCheck").on("change", async function () {
            await self.setEnabled($(this).is(":checked"));
        });

        const status = await ipcRenderer.invoke('map-detector-status');
        debugLog("detector::init", JSON.stringify(status));
        this.render(status);
    }

    /**
     * Start or stop the loop. The single path for it, so the home-page switch
     * and the welcome tour's switch cannot end up doing it two slightly
     * different ways.
     *
     * The setting is written by main's own start/stop handlers rather than
     * through `Settings.set`, so the stored value and the running loop can
     * never disagree.
     * @param {boolean} on
     */
    async setEnabled(on) {
        const $check = $("#mapDetectionCheck");
        $check.prop("disabled", true);
        try {
            const status = await ipcRenderer.invoke(on ? 'map-detector-start' : 'map-detector-stop');
            this.render(status);
        } catch (err) {
            // The invoke rejected (the handler threw, or main is on its way
            // out). Without this the `render` never runs and every switch —
            // the home page's and the tour's — is left showing the state the
            // *click* implied over a loop that is not in it. Ask main what is
            // actually true and draw that instead.
            console.error("detector::setEnabled", err && err.message);
            try {
                this.render(await ipcRenderer.invoke('map-detector-status'));
            } catch (statusErr) {
                // Even the status call failed. "Off" is the safe claim: it is
                // the state the user can recover from with one click, and a
                // switch that says "watching" over a dead loop is the one thing
                // this app must never show.
                console.error("detector::setEnabled::status", statusErr && statusErr.message);
                this.render({running: false});
            }
        } finally {
            $check.prop("disabled", false);
        }
    }

    /**
     * Register a second view of the switch.
     *
     * The welcome tour has one on its auto-detect step, and it has to follow
     * every status push rather than only its own click: the loop can also be
     * started or stopped from the home page behind the tour, and a start that
     * main refuses must not leave a ticked box.
     * @param {(running: boolean) => void} callback
     */
    onStatus(callback) {
        if (typeof callback === 'function') this.statusListeners.push(callback);
    }

    /** Tell every extra view what the switch is now. Never throws at a caller. */
    notifyStatus(running) {
        for (const listener of this.statusListeners) {
            try {
                listener(running);
            } catch (err) {
                console.error('detector::listener', err && err.message);
            }
        }
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
        this.notifyStatus(!!s.running);

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
