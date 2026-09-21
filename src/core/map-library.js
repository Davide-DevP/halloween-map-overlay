const {app, ipcMain} = require("electron");
const fs = require("fs");
const path = require("path");
const {getFilesFromDir} = require("./utils");
const {buildCatalog, mergeCustomMaps, findClosestMapMatch, sortCatalog} = require("./map-catalog");
const {mergeMapPacks} = require("../shared/map-pack-rules");

/**
 * The fs side of the map catalogue: the three roots, the listings, and how a key
 * from the renderer / a hotkey / the CLI becomes an absolute path. All matching
 * logic is the pure `map-catalog.js`; this only supplies it a listing. See
 * `docs/agents/architecture.md`.
 */
class MapLibrary {

    constructor() {
        this._catalog = null;
        // Injected from `index.js`, because `MapPacks` needs the main window
        // and is built later; nothing reads the catalogue before that.
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

    /** Packaged: an extraResource next to the app. Dev: straight out of the repo. */
    get mapsRoot() {
        return app.isPackaged
            ? path.join(process.resourcesPath, "maps")
            : path.join(global.dirname, "maps");
    }

    /** User imports — the reserved "Custom" creator. */
    get customRoot() {
        return path.join(app.getPath('userData'), "custom");
    }

    /** Installed packs, one directory per map. */
    get packsRoot() {
        return path.join(app.getPath('userData'), "map-packs");
    }

    /** `store` is a `MapPackStore`, or null to turn packs off. */
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

    /** Bundled maps, installed packs and the user's imports, in one list and one
     * order. A pack **replaces** the bundled map with the same key, which is
     * how a pack fixes a shipped map; custom maps are merged last and cannot be
     * touched, since a pack may not claim their reserved creator. */
    getCatalog() {
        if (!this._catalog) {
            const shipped = mergeMapPacks(buildCatalog(this.listShipped()), this.listPacks(), sortCatalog);
            this._catalog = mergeCustomMaps(shipped, this.listCustom());
        }
        return this._catalog;
    }

    /** Call after a custom map or a pack is added or deleted. */
    invalidate() {
        this._catalog = null;
    }

    /** The catalogue entry a key, a bare map name or a custom-map file name
     * refers to, but only when its image is on disk; null otherwise, and
     * callers then treat the payload as raw base64 image data. Separate from
     * `resolve()` because the overlay label needs the *name*, and re-deriving
     * it would mean matching twice with two chances to disagree. */
    resolveEntry(key) {
        // Base64 image payloads are strings too, and a key never gets near this
        // length: bail out before fuzzy-matching a whole PNG.
        if (typeof key !== 'string' || !key || key.length > 260) return null;
        const entry = findClosestMapMatch(key, this.getCatalog());
        if (!entry) return null;
        // Three roots, one rule: the entry says which. `entry.pack` is the
        // directory `packDirName` derived from the key, never a pack's path.
        const root = entry.custom ? this.customRoot
            : (entry.pack ? path.join(this.packsRoot, entry.pack) : this.mapsRoot);
        const file = path.join(root, entry.file);
        if (!fs.existsSync(file)) return null;
        return Object.assign({}, entry, {path: file});
    }

    /** `resolveEntry`, reduced to the absolute path. */
    resolve(key) {
        const entry = this.resolveEntry(key);
        return entry ? entry.path : null;
    }
}

module.exports = MapLibrary;
