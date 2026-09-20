'use strict';

const {ipcMain} = require('electron');

const appLog = require('./app-log');
const {validateMarkers} = require('../shared/map-pack-rules');
const BUNDLED = require('./map-markers/markers.json');

/**
 * Map **markers**: where a storm cellar, an escape gate, a car or a gas can may
 * appear. Every point is a *possible* location — the game activates a varying
 * subset each match — which is what the legend says and what the README
 * explains.
 *
 * This is the one place the renderer asks, for a bundled map and for a map pack
 * alike. The two sources differ in trust (a `require`d file inside the asar vs.
 * a downloaded one on disk) but not in shape: both are validated by the same
 * pure `validateMarkers`, and a pack's markers **override** the bundled ones
 * for the same key, exactly as its image and its templates already do
 * (`mergeMapPacks`, `mergeTemplateSources`).
 *
 * Three deliberate choices:
 *
 * - **Validated at load, once.** A corrupt entry is dropped with a log line
 *   rather than reaching the renderer, and the check never runs per request —
 *   `get-map-markers` is invoked on every map change.
 * - **Inside the asar, not `maps/`.** `maps/` is an `extraResources` directory
 *   whose *listing* is the catalogue (`map-library.js` → `buildCatalog`), so a
 *   stray `.json` there is a file the catalogue has to learn to ignore. A
 *   `require`d JSON under `src/` is packaged by `build.files` with no entry of
 *   its own, which is how `map-detector/templates.json` already ships.
 * - **One spelling at runtime.** The authoring file
 *   (`maps-src/markers.json`) writes the Tab transform as `{ax, bx, ay, by}`;
 *   the pack format writes `{sx, tx, sy, ty}`. `scripts/build-markers.js`
 *   converts once, at build time, so nothing at runtime has two spellings to
 *   reconcile.
 */
class MapMarkers {

    constructor() {
        /** key → validated markers document, from the shipped file. */
        this.bundled = {};
        /**
         * Where an installed pack's markers come from — a function
         * `key → markers|null`, injected by `index.js` because `MapPacks` is
         * built after this class. Null means bundled maps only.
         */
        this.packSource = null;
        this.load();

        const self = this;
        // The same channel the pack spec (docs/SPEC-MAP-PACKS.md §2) already
        // documented, so the renderer has exactly one way to ask for markers
        // whatever kind of map it is looking at.
        ipcMain.handle('get-map-markers', async (event, key) => self.markers(key));
    }

    /** Validate the shipped file once. A bad entry is dropped, not trusted. */
    load() {
        const out = {};
        let rejected = 0;
        const maps = (BUNDLED && BUNDLED.maps) || {};
        for (const [key, document] of Object.entries(maps)) {
            const verdict = validateMarkers(document);
            if (!verdict.ok) {
                rejected++;
                // A shipped file that fails its own validator is a build
                // mistake, not a user problem — but it must be visible rather
                // than silently costing the map its markers.
                appLog.warn('map-markers', {key, result: 'rejected', reason: verdict.error});
                continue;
            }
            out[key] = document;
        }
        this.bundled = out;
        if (rejected) console.error(`Markers: ${rejected} bundled entries failed validation.`);
        return {maps: Object.keys(out).length, rejected};
    }

    /**
     * Where installed map packs' markers come from.
     * @param {?Function} fn `key → markers|null`
     */
    setPackSource(fn) {
        this.packSource = typeof fn === 'function' ? fn : null;
    }

    /**
     * One map's markers, or null.
     *
     * A pack wins over the bundled map with the same key — that is what lets a
     * pack correct a bundled map's marker positions, and what makes a pack
     * built from a clean image (nothing `baked`) draw all four layers on the
     * corner minimap.
     *
     * @param {string} key catalogue key
     * @returns {?Object}
     */
    markers(key) {
        if (typeof key !== 'string' || !key) return null;
        if (this.packSource) {
            try {
                const fromPack = this.packSource(key);
                if (fromPack) return fromPack;
            } catch (err) {
                console.error('Markers: could not read a pack\'s markers:', err && err.message);
            }
        }
        return Object.prototype.hasOwnProperty.call(this.bundled, key) ? this.bundled[key] : null;
    }

    /** Which bundled maps carry markers — for `system.txt`. */
    keys() {
        return Object.keys(this.bundled);
    }
}

module.exports = MapMarkers;
