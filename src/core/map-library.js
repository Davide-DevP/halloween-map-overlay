const {app, ipcMain} = require("electron");
const fs = require("fs");
const path = require("path");
const {getFilesFromDir} = require("./utils");
const {buildCatalog, mergeCustomMaps, findClosestMapMatch, sortCatalog} = require("./map-catalog");
const {mergeMapPacks} = require("../shared/map-pack-rules");

/**
 * Owns the on-disk side of the map catalogue: where the maps live, which files
 * are there, and how a key coming from the renderer / a hotkey / the CLI turns
 * into an absolute file path.
 *
 * All the matching logic itself lives in the pure `map-catalog.js`; this class
 * only supplies it with a directory listing.
 */
class MapLibrary {

    constructor() {
        this._catalog = null;
        /**
         * Installed map packs (`core/map-pack-store.js`), or null when the
         * feature is not wired up. Injected from `index.js` rather than built
         * here: `MapPacks` needs the main window for its toast and is therefore
         * constructed later, while nothing reads the catalogue before
         * `createWindow()`.
         */
        this._packs = null;
        ipcMain.handle('get-map-catalog', async () => this.getCatalog());
        ipcMain.handle('read-map-image', async (event, key) => {
            const file = this.resolve(key);
            if (!file) return Buffer.from("");
            try {
                return await fs.promises.readFile(file);
            } catch (err) {
                console.error(`MapLibrary: could not read "${key}":`, err.message);
                return Buffer.from("");
            }
        });
        ipcMain.handle('invalidate-map-catalog', async () => {
            this.invalidate();
            return this.getCatalog();
        });
    }

    /**
     * Packaged builds ship the maps as an extraResource next to the app, dev
     * runs read them straight out of the repo.
     */
    get mapsRoot() {
        return app.isPackaged
            ? path.join(process.resourcesPath, "maps")
            : path.join(global.dirname, "maps");
    }

    /** User-imported maps (the "Custom" creator). */
    get customRoot() {
        return path.join(app.getPath('userData'), "custom");
    }

    /** Installed map packs, one directory per map. */
    get packsRoot() {
        return path.join(app.getPath('userData'), "map-packs");
    }

    /**
     * Where installed packs come from. See `core/map-packs.js`.
     * @param {?Object} store a `MapPackStore`, or null to turn packs off
     */
    setPackStore(store) {
        this._packs = store && typeof store.list === 'function' ? store : null;
        this.invalidate();
    }

    listPacks() {
        if (!this._packs) return [];
        try {
            return this._packs.list();
        } catch (err) {
            // A broken packs folder must never stop the bundled maps loading.
            console.error('MapLibrary: could not list map packs:', err && err.message);
            return [];
        }
    }

    listShipped() {
        const root = this.mapsRoot;
        if (!fs.existsSync(root)) {
            console.warn(`MapLibrary: maps directory not found at ${root}`);
            return [];
        }
        return getFilesFromDir(root).map(file => path.relative(root, file));
    }

    listCustom() {
        const root = this.customRoot;
        if (!fs.existsSync(root)) return [];
        return getFilesFromDir(root).map(file => path.relative(root, file));
    }

    /**
     * The whole catalogue: bundled maps, installed map packs and the user's
     * own imports, in one list and one order.
     *
     * A pack **replaces** the bundled map with the same key (see `mergeMapPacks`
     * for why), so this is also how a pack fixes a shipped map's image. Custom
     * maps are merged last and are never touched: their creator is reserved and
     * a pack may not claim it.
     */
    getCatalog() {
        if (!this._catalog) {
            const shipped = mergeMapPacks(buildCatalog(this.listShipped()), this.listPacks(), sortCatalog);
            this._catalog = mergeCustomMaps(shipped, this.listCustom());
        }
        return this._catalog;
    }

    /** Drop the cached listing — call after a custom map is added or deleted. */
    invalidate() {
        this._catalog = null;
    }

    /**
     * The catalogue entry a key, a bare map name or a custom-map file name
     * refers to, but only when its image is actually on disk. Returns null when
     * nothing matches — callers then treat the payload as raw base64 image data.
     *
     * Kept separate from `resolve()` because the overlay label needs the map's
     * *name*, and re-deriving it from the payload string would mean matching the
     * name twice with two chances to disagree.
     *
     * @returns {{key, name, creator, file, custom, path}|null}
     */
    resolveEntry(key) {
        // Base64 image payloads are also strings; a path/key never gets near
        // this length, so bail out before fuzzy-matching a whole PNG.
        if (typeof key !== 'string' || !key || key.length > 260) return null;
        const entry = findClosestMapMatch(key, this.getCatalog());
        if (!entry) return null;
        // Three roots, one rule: the entry says where it came from. `entry.pack`
        // is the install directory name, which `packDirName` derived from the
        // key — never a path the pack supplied.
        const root = entry.custom ? this.customRoot
            : (entry.pack ? path.join(this.packsRoot, entry.pack) : this.mapsRoot);
        const file = path.join(root, entry.file);
        if (!fs.existsSync(file)) return null;
        return Object.assign({}, entry, {path: file});
    }

    /**
     * Turn a catalogue key, a bare map name or a custom-map file name into an
     * absolute path. Returns null when nothing matches — callers then treat the
     * payload as raw base64 image data instead.
     */
    resolve(key) {
        const entry = this.resolveEntry(key);
        return entry ? entry.path : null;
    }
}

module.exports = MapLibrary;
