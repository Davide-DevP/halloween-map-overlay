'use strict';

const {ipcMain} = require('electron');

const appLog = require('./app-log');
const {validateMarkers} = require('../shared/map-pack-rules');
const BUNDLED = require('./map-markers/markers.json');

/**
 * ELECTRON tier: owns `get-map-markers` for bundled maps and packs alike, both
 * validated by the same pure `validateMarkers`, a pack winning on a shared key.
 */
class MapMarkers {

    constructor() {
        /** key → validated markers document, from the shipped file. */
        this.bundled = {};
        /** `key → markers|null`; injected, because `MapPacks` is built later. */
        this.packSource = null;
        this.load();

        const self = this;
        ipcMain.handle('get-map-markers', async (event, key) => self.markers(key));
    }

    /** Validated **once**: `get-map-markers` runs on every map change. */
    load() {
        const out = {};
        let rejected = 0;
        const maps = (BUNDLED && BUNDLED.maps) || {};
        for (const [key, document] of Object.entries(maps)) {
            const verdict = validateMarkers(document);
            if (!verdict.ok) {
                rejected++;
                // A build mistake, not a user problem — but it must be visible.
                appLog.warn('map-markers', {key, result: 'rejected', reason: verdict.error});
                continue;
            }
            out[key] = document;
        }
        this.bundled = out;
        if (rejected) console.error(`Markers: ${rejected} bundled entries failed validation.`);
        return {maps: Object.keys(out).length, rejected};
    }

    /** @param {?Function} fn `key → markers|null`, from installed packs. */
    setPackSource(fn) {
        this.packSource = typeof fn === 'function' ? fn : null;
    }

    /** One map's markers, or null. A pack wins on a shared key, and so can fix it. */
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
