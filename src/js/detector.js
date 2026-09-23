const {ipcRenderer} = require("electron");
const {debugLog} = require("./logger");
const {t, onChange} = require("./i18n");
const {detectorStatusView, emptyDetectorMemory} = require("../shared/detector-status");

/**
 * Home-page switch and status line for the automatic map detection. All the
 * work is in main (`core/map-detector.js`).
 */
class Detector {

    constructor(settings) {
        this.settings = settings;
        /** What the line remembers between pushes — `shared/detector-status.js`. */
        this.memory = emptyDetectorMemory();
        /** The last status seen, so the line can be re-rendered in a new language. */
        this.lastStatus = null;
        /** Anything else that draws this switch — see `onStatus`. */
        this.statusListeners = [];
        /**
         * A placement that *needs* detection must not be breakable from here:
         * a plain "On" instead of the switch. `Options.syncPlacement` owns it.
         */
        this.placementLocked = false;
        onChange(() => this.render(this.lastStatus));
    }

    /** @param {boolean} locked `autoDetectSwitchState(...).control === 'status'` */
    setPlacementLock(locked) {
        const on = locked === true;
        if (on === this.placementLocked) return;
        this.placementLocked = on;
        this.applyLock();
    }

    applyLock() {
        $("#mapDetectionSwitch").toggleClass('d-none', this.placementLocked);
        $("#mapDetectionLocked").toggleClass('d-none', !this.placementLocked);
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
     * The single path, so the two views of this switch cannot differ. The
     * setting is written by main's handlers: value and loop cannot disagree.
     */
    async setEnabled(on) {
        const $check = $("#mapDetectionCheck");
        $check.prop("disabled", true);
        try {
            const status = await ipcRenderer.invoke(on ? 'map-detector-start' : 'map-detector-stop');
            this.render(status);
        } catch (err) {
            // The invoke rejected; ask main what is actually true rather than
            // leaving both switches showing what the *click* implied.
            console.error("detector::setEnabled", err && err.message);
            try {
                this.render(await ipcRenderer.invoke('map-detector-status'));
            } catch (statusErr) {
                // "Off" is the safe claim: a switch saying "watching" over a
                // dead loop is the one thing this app must never show.
                console.error("detector::setEnabled::status", statusErr && statusErr.message);
                this.render({running: false});
            }
        } finally {
            $check.prop("disabled", false);
        }
    }

    /**
     * A second view of the switch, following every status push and not only
     * its own click: a start main refuses must not leave a ticked box.
     */
    onStatus(callback) {
        if (typeof callback === 'function') this.statusListeners.push(callback);
    }

    /** Never throws at a caller. */
    notifyStatus(running) {
        for (const listener of this.statusListeners) {
            try {
                listener(running);
            } catch (err) {
                console.error('detector::listener', err && err.message);
            }
        }
    }

    /** @param {'off'|'watching'|'menu'|'detected'} state — for CSS to colour */
    setState(state) {
        $("#detectorReadout").attr("data-state", state);
    }

    /**
     * @param {{running: boolean, lastDetected: ?string, lastAt: ?number,
     *          state: ?string, inMenu: ?boolean}} status
     */
    render(status) {
        const s = status || this.lastStatus || {};
        this.lastStatus = s;
        $("#mapDetectionCheck").prop("checked", !!s.running);
        this.applyLock();
        this.notifyStatus(!!s.running);

        const view = detectorStatusView(this.memory, s);
        this.memory = view.memory;
        this.setState(view.state);
        // .text(): no map name ever reaches innerHTML unescaped.
        $("#detectorStatus").text(t(view.messageKey, view.params));
    }
}

module.exports = Detector;
