'use strict';

/**
 * **All of the detector's pixel work, in one place.**
 *
 * Find the game window, capture it, run the Tab gate on the raw bytes, produce
 * luminance for the one region that is needed and match. What comes out is
 * decisions and numbers: a window rectangle, a gate verdict, a map key with its
 * scores, a menu score, timings. **No pixels, ever.**
 *
 * It is its own module because it runs in two places and must behave the same
 * in both:
 *   - in the main process, when the utility process is unavailable
 *     (`core/map-detector/worker-host.js` falls back to it);
 *   - in the utility process (`worker.js` is a message adapter around it).
 *
 * That is also what makes the worker testable: a test can drive *this* module
 * with the real fixtures, and separately drive the message plumbing, instead of
 * needing Electron to exercise either.
 *
 * `node-screenshots` is required lazily so that loading this file — which
 * `worker-host.js` does at startup to have a fallback ready — does not pull a
 * native module into the main process before anything asks for a frame.
 */

const {
    tabGateFromRaw, toGrayScaledRegion, regionSearchBox, frameWindow,
    matchMap, matchMenu, prepareTemplates, prepareMenuTemplate, templateVariants,
    MAP_PANEL_REL, MENU_STRIP_REL, DEFAULT_OFFSETS, MENU_OFFSETS, DEFAULT_SIZE
} = require('./matcher');
const {pickGameWindow} = require('../../shared/detector-rules');

/**
 * Width the captured window is reduced to before anything looks at it. The
 * templates are 64x64 thumbnails of a region that is ~40 % of the frame, so
 * 640 px across leaves ~255 px for a 64 px thumbnail — four times more detail
 * than the match needs, and a quarter of the pixels of a 1080p frame.
 */
const CAPTURE_WIDTH = 640;

class FrameSource {

    /**
     * @param {{windows?: Function, gc?: Object, ownPid?: number}} [deps]
     *   `windows` returns the enumerated windows (`Window.all`), injected so a
     *   test can drive the whole source without a screen. The real one is
     *   `node-screenshots`, required on first use.
     */
    constructor(deps) {
        const d = deps || {};
        this.windowsFn = d.windows || null;
        this.gc = d.gc || null;
        this.ownPid = d.ownPid || process.pid;
        this.size = DEFAULT_SIZE;
        this.templates = {};
        this.variantCount = 0;
        this.menuTemplate = null;
        this.menuPrepared = null;
        this.menuWidth = 0;
        this.menuHeight = 0;
        /** The last window rectangle read, so `pid` survives a failed read. */
        this.lastWindow = {present: false, pid: null, rect: null};
    }

    /** `Window.all`, resolved on first use so the module itself stays cheap. */
    windows() {
        if (!this.windowsFn) {
            const {Window} = require('node-screenshots');
            this.windowsFn = () => Window.all();
        }
        return this.windowsFn();
    }

    /**
     * Install the template set. Takes the same plain arrays `templates.json`
     * holds — which is what crosses the process boundary — and does every
     * frame-independent computation once, here.
     *
     * @param {{templates: Object, menu: ?Object, size: ?number}} payload
     */
    setTemplates(payload) {
        const p = payload || {};
        this.size = p.size || DEFAULT_SIZE;
        const plain = {};
        let variantCount = 0;
        for (const [key, values] of Object.entries(p.templates || {})) {
            const variants = templateVariants(values);
            if (!variants.length) continue;
            plain[key] = variants;
            variantCount += variants.length;
        }
        this.templates = prepareTemplates(plain, this.size);
        this.variantCount = variantCount;
        const menu = p.menu || null;
        this.menuTemplate = menu && menu.template ? Float32Array.from(menu.template) : null;
        this.menuWidth = (menu && menu.width) || 0;
        this.menuHeight = (menu && menu.height) || 0;
        this.menuPrepared = this.menuTemplate
            ? prepareMenuTemplate(this.menuTemplate, this.menuWidth, this.menuHeight)
            : null;
        return {keys: Object.keys(this.templates).length, variants: variantCount};
    }

    /**
     * The game's window, or null when the game is not running.
     *
     * The *decision* is the pure `pickGameWindow`, shared with
     * `core/foreground.js` so the two cannot disagree about what the game's
     * window is. The reads stay here because a window can disappear between the
     * enumeration and the read, which is a try/catch, not a rule.
     */
    findGameWindow() {
        const windows = [];
        const infos = [];
        for (const win of this.windows()) {
            try {
                infos.push({
                    appName: win.appName() || '',
                    title: win.title() || '',
                    minimized: win.isMinimized(),
                    width: win.width(),
                    height: win.height(),
                    pid: win.pid()
                });
            } catch (err) {
                continue;
            }
            windows.push(win);
        }
        const index = pickGameWindow(infos, this.ownPid);
        if (index === -1) return null;
        return {win: windows[index], info: infos[index]};
    }

    /**
     * One request: capture the game window and answer whatever was asked for.
     *
     * @param {{menu?: boolean, match?: boolean}} want `match` false is the cheap
     *   "is the Tab screen still up?" check Tab-map mode makes while its markers
     *   are shown — gate only, no luminance, no NCC.
     * @returns {Promise<Object>} numbers and keys only
     */
    async grab(want) {
        const w = want || {};
        const started = Date.now();
        const found = this.findGameWindow();
        const enumeratedAt = Date.now();
        if (!found) {
            this.lastWindow = {present: false, pid: null, rect: null};
            return {
                window: {present: false, pid: null, rect: null},
                gate: false, match: null, menu: null,
                timings: {enumerate: enumeratedAt - started, capture: 0, match: 0, total: Date.now() - started}
            };
        }

        const {win} = found;
        let rect = null;
        let pid = null;
        try {
            rect = {x: win.x(), y: win.y(), width: win.width(), height: win.height()};
            pid = win.pid();
        } catch (err) {
            rect = null;
        }
        const windowInfo = {present: true, pid, rect, minimized: !!found.info.minimized};
        this.lastWindow = windowInfo;

        let image;
        try {
            image = await win.captureImage();
        } catch (err) {
            return this.errorReply(windowInfo, started, enumeratedAt, 'capture: ' + ((err && err.message) || err));
        }
        const {width, height} = image;
        if (!width || !height) {
            return this.errorReply(windowInfo, started, enumeratedAt, 'empty-capture');
        }
        let raw;
        try {
            raw = await image.toRaw();
        } catch (err) {
            return this.errorReply(windowInfo, started, enumeratedAt, 'toRaw: ' + ((err && err.message) || err));
        }
        const capturedAt = Date.now();
        windowInfo.captured = {width, height};

        const outWidth = CAPTURE_WIDTH;
        const outHeight = Math.max(1, Math.round(CAPTURE_WIDTH * height / width));

        // The gate, on the raw bytes: 21.9 % of the pixels, ~1.4 ms, nothing
        // allocated. Every frame that is not the Tab screen stops here, which
        // is almost all of them.
        const gate = tabGateFromRaw(raw, width, height, 'rgba');

        let match = null;
        let menu = null;
        if (gate && w.match !== false) {
            // Luminance for the map panel and its alignment margins only —
            // about a third of the frame instead of all of it.
            const box = regionSearchBox(outWidth, outHeight, MAP_PANEL_REL, DEFAULT_OFFSETS);
            const data = toGrayScaledRegion(raw, width, height, outWidth, outHeight, 'rgba', box);
            const result = matchMap(null, outWidth, outHeight, this.templates, {
                size: this.size,
                report: true,
                gate: false,
                window: frameWindow(data, outWidth, outHeight, box)
            });
            // Copied field by field, so nothing that is not a number or a
            // string can reach the reply even by accident.
            match = {
                key: result.key,
                score: result.score,
                second: result.second,
                margin: result.margin,
                accepted: result.accepted,
                acceptedBy: result.acceptedBy || null,
                panelMean: result.panelMean
            };
        } else if (!gate && w.menu && this.menuTemplate) {
            const box = regionSearchBox(outWidth, outHeight, MENU_STRIP_REL, MENU_OFFSETS);
            const data = toGrayScaledRegion(raw, width, height, outWidth, outHeight, 'rgba', box);
            const result = matchMenu(null, outWidth, outHeight, this.menuTemplate, {
                width: this.menuWidth,
                height: this.menuHeight,
                window: frameWindow(data, outWidth, outHeight, box),
                prepared: this.menuPrepared
            });
            menu = {score: result.score, accepted: result.accepted};
        }

        const finishedAt = Date.now();
        // The native RGBA buffer is 8 MB at 1080p and `node-screenshots` has no
        // dispose API, so a collection is the only lever there is. In the
        // worker this costs the main process nothing at all.
        let gcMs = 0;
        if (this.gc) {
            const gcStarted = Date.now();
            try {
                this.gc.collect();
            } catch (err) {
                /* a failed collection is never worth failing a tick over */
            }
            gcMs = Date.now() - gcStarted;
        }

        return {
            window: windowInfo,
            gate,
            match,
            menu,
            timings: {
                enumerate: enumeratedAt - started,
                capture: capturedAt - enumeratedAt,
                match: finishedAt - capturedAt,
                gc: gcMs,
                total: Date.now() - started
            }
        };
    }

    errorReply(windowInfo, started, enumeratedAt, message) {
        return {
            window: windowInfo,
            gate: false,
            match: null,
            menu: null,
            error: String(message).slice(0, 200),
            timings: {enumerate: enumeratedAt - started, capture: 0, match: 0, total: Date.now() - started}
        };
    }
}

module.exports = FrameSource;
module.exports.CAPTURE_WIDTH = CAPTURE_WIDTH;
