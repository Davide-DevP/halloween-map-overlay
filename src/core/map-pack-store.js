'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const rules = require('../shared/map-pack-rules');

/**
 * The installed map packs on disk. **fs only, never electron** — the directory
 * is injected, which is what lets `test/map-pack-store.test.js` drive the whole
 * class against an `mkdtemp` folder. `src/core/map-packs.js` is the electron
 * half that knows the directory is `userData/map-packs`.
 *
 * Layout:
 *
 *   map-packs/
 *     state.json                         last check time + last result
 *     <safe-dir>/pack.json               the validated manifest
 *     <safe-dir>/<Map Name>.png          the overlay image
 *     <safe-dir>/templates.json          the detector templates for this map
 *     <safe-dir>/markers.json            optional, opaque to this version
 *     .staging-<random>/                 a download in progress
 *     .old-<random>-<safe-dir>/          the previous version, mid-swap
 *
 * Three rules hold it together:
 *
 * 1. **Nothing from a pack is ever executed.** Every file is read with
 *    `fs.readFileSync` and parsed with `JSON.parse`; there is no `require`, no
 *    `vm`, no `eval` anywhere near a pack, and the PNG is handed to the
 *    renderer as bytes exactly like a bundled map.
 * 2. **A pack is fully re-validated on every read, not only at install** —
 *    including the **SHA-256 of every file**, not just its size. Size alone was
 *    a hole: a `map.png` that a power cut or a bad sector zero-filled *in place*
 *    keeps its byte count, so it passed, was offered to the catalogue, and (for
 *    a pack replacing a bundled map) left that map permanently blank while the
 *    next check reported "up to date". Hashing ~350 KB per pack at startup is
 *    nothing next to being unable to heal. A pack that fails falls out of
 *    `list()`, which means the bundled map comes back **and** the pack is not
 *    in the installed set, so the next check downloads it again.
 * 3. **A pack that fails anything is skipped whole**, and the previously good
 *    version is untouched — which is why the swap is rename-based (below)
 *    rather than "delete, then write".
 */

/**
 * The parked copy of a pack mid-swap: `.old-<12 hex>-<safe-dir>`.
 *
 * The directory it belonged to is **in the name** on purpose. The first draft
 * used `.old-<random>` and `sweep()` deleted every one of them at startup —
 * which is right for a crash between the two renames only if the live directory
 * survived. Kill the process in that window and both copies are gone: the live
 * name does not exist yet and the only copy of the pack is a `.old-*` folder
 * the next start throws away. Now `sweep()` can tell what a parked folder was,
 * and puts it back when its live name is missing.
 */
const PARKED_PREFIX = '.old-';
const PARKED_RANDOM_HEX = 12;

/**
 * How many map keys the "a default hotkey was already offered" list holds. It
 * only ever grows, one entry per map ever downloaded, so it is bounded to the
 * same order as the index's own pack cap.
 */
const MAX_OFFERED_HOTKEYS = 400;

/** `.old-abc123abc123-my-pack` → `my-pack`; null when it is not one of ours. */
function parkedDirName(name) {
    if (typeof name !== 'string' || !name.startsWith(PARKED_PREFIX)) return null;
    const rest = name.slice(PARKED_PREFIX.length);
    if (rest.length <= PARKED_RANDOM_HEX + 1) return null;
    if (!/^[0-9a-f]+$/.test(rest.slice(0, PARKED_RANDOM_HEX))) return null;
    if (rest[PARKED_RANDOM_HEX] !== '-') return null;
    return rest.slice(PARKED_RANDOM_HEX + 1) || null;
}
class MapPackStore {

    /**
     * @param {string} dir where packs are installed (`userData/map-packs`)
     * @param {{appVersion?: string, templateSize?: number}} [opts]
     */
    constructor(dir, opts) {
        const options = opts || {};
        this.dir = dir || null;
        this.appVersion = options.appVersion || '0.0.0';
        /** The `size` a pack's templates must declare — the matcher's own. */
        this.templateSize = options.templateSize || 64;
        /** Cached result of `list()`; dropped by `invalidate()`. */
        this._packs = null;
        /** Reasons packs on disk were skipped, for the diagnostic report. */
        this.skipped = [];
    }

    /** Create the packs directory. Returns false rather than throwing. */
    ensureDir() {
        if (!this.dir) return false;
        try {
            fs.mkdirSync(this.dir, {recursive: true});
            return true;
        } catch (err) {
            return false;
        }
    }

    invalidate() {
        this._packs = null;
    }

    /**
     * Every installed pack, in key order, each one fully validated.
     *
     * @returns {Array<{key, name, creator, credit, version, dir, image,
     *                  markers, bytes}>}
     */
    list() {
        if (this._packs) return this._packs;
        this._packs = [];
        this.skipped = [];
        if (!this.dir) return this._packs;
        let names = [];
        try {
            names = fs.readdirSync(this.dir, {withFileTypes: true})
                .filter(e => e.isDirectory() && !e.name.startsWith('.'))
                .map(e => e.name)
                .sort();
        } catch (err) {
            // No directory yet is the normal state on a fresh install.
            return this._packs;
        }
        for (const name of names) {
            const pack = this.readPack(name);
            if (pack) this._packs.push(pack);
        }
        this._packs.sort((a, b) => a.key.localeCompare(b.key, 'en'));
        return this._packs;
    }

    /**
     * Read and validate one installed pack directory.
     * @param {string} dirName
     * @returns {?object} null when anything about it is wrong
     */
    readPack(dirName) {
        const note = (reason) => this.skipped.push({dir: dirName, reason});
        const manifest = this.readManifestFile(path.join(this.dir, dirName, rules.MANIFEST_NAME));
        if (!manifest.ok) {
            note(manifest.error);
            return null;
        }
        const pack = manifest.manifest;
        // The directory name is derived from the key, so a pack in the wrong
        // folder is a folder somebody renamed — and two folders could then
        // claim one key. Refused rather than reconciled.
        if (rules.packDirName(pack.key) !== dirName) {
            note('dir-key-mismatch');
            return null;
        }
        // Size **and** SHA-256 of every listed file, exactly as at install
        // time — see rule 2 in this file's header for why the size alone was
        // not enough. The size is checked first because it is free and it is
        // also the bound on the read that follows.
        for (const file of pack.files) {
            const full = path.join(this.dir, dirName, file.name);
            let stat;
            try {
                stat = fs.statSync(full);
            } catch (err) {
                note(`missing:${file.name}`);
                return null;
            }
            if (!stat.isFile() || stat.size !== file.bytes) {
                note(`bytes:${file.name}`);
                return null;
            }
            let digest;
            try {
                digest = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
            } catch (err) {
                note(`unreadable:${file.name}`);
                return null;
            }
            if (digest !== file.sha256) {
                note(`sha256:${file.name}`);
                return null;
            }
        }
        return {
            key: pack.key,
            name: pack.name,
            creator: pack.creator,
            credit: pack.credit,
            version: pack.version,
            minAppVersion: pack.minAppVersion,
            dir: dirName,
            image: pack.image,
            markers: pack.markers,
            files: pack.files,
            bytes: pack.files.reduce((sum, f) => sum + f.bytes, 0)
        };
    }

    /** Parse + validate a `pack.json`. Never throws. */
    readManifestFile(file) {
        let text;
        try {
            const stat = fs.statSync(file);
            if (!stat.isFile() || stat.size > rules.LIMITS.manifest) {
                return {ok: false, error: 'manifest-size', manifest: null};
            }
            text = fs.readFileSync(file, 'utf-8');
        } catch (err) {
            return {ok: false, error: 'no-manifest', manifest: null};
        }
        return this.parseManifest(text, null);
    }

    /**
     * `JSON.parse` + `validateManifest`. The only way a manifest is ever read —
     * there is deliberately no `require()` of a pack file anywhere.
     * @param {string} text
     * @param {?object} entry the index entry to cross-check against, or null
     */
    parseManifest(text, entry) {
        let json;
        try {
            json = JSON.parse(text);
        } catch (err) {
            return {ok: false, error: 'manifest-not-json', manifest: null};
        }
        return rules.validateManifest(json, entry, {appVersion: this.appVersion});
    }

    /** Absolute path of a file inside an installed pack. */
    filePath(pack, name) {
        if (!pack || !pack.dir || !rules.isValidFileName(name)) return null;
        return path.join(this.dir, pack.dir, name);
    }

    /**
     * A pack's validated templates, as the plain `key → variants` object the
     * detector converts to `Float32Array`s.
     *
     * Read once at load, never per tick — see "The capture path — do not make
     * it heavier" in `docs/agents/detection.md`.
     *
     * @param {object} pack a `list()` entry
     * @returns {?{key: string, templates: Object, variants: number}}
     */
    readTemplates(pack) {
        const file = this.filePath(pack, rules.TEMPLATES_NAME);
        if (!file) return null;
        let json;
        try {
            const stat = fs.statSync(file);
            if (!stat.isFile() || stat.size > rules.LIMITS.templates) return null;
            json = JSON.parse(fs.readFileSync(file, 'utf-8'));
        } catch (err) {
            return null;
        }
        const check = rules.validateTemplates(json, {key: pack.key, size: this.templateSize});
        if (!check.ok) return null;
        return {key: pack.key, templates: json.templates, variants: check.variants};
    }

    /**
     * A pack's optional markers, validated only against the documented
     * top-level shape. Opaque otherwise: a later version renders them.
     * @returns {?object}
     */
    readMarkers(pack) {
        if (!pack || !pack.markers) return null;
        const file = this.filePath(pack, rules.MARKERS_NAME);
        if (!file) return null;
        try {
            const stat = fs.statSync(file);
            if (!stat.isFile() || stat.size > rules.LIMITS.markers) return null;
            const json = JSON.parse(fs.readFileSync(file, 'utf-8'));
            return rules.validateMarkers(json).ok ? json : null;
        } catch (err) {
            return null;
        }
    }

    /* ── install ─────────────────────────────────────────────────────────── */

    /**
     * A fresh, empty staging directory inside the packs folder.
     *
     * **Inside userData, never `%TEMP%`.** Two reasons, and the second one is
     * the hard-won half: a cross-volume `rename` is not atomic (Windows refuses
     * it outright), and running anything out of `%TEMP%` on this project's
     * development machine trips Bitdefender's Advanced Threat Defense — see the
     * `%TEMP%` trap in `docs/agents/updater-and-installer.md`. Nothing here is executed, but the folder a
     * download lands in belongs next to where it is going.
     *
     * @returns {?string} absolute path, or null when it could not be created
     */
    staging() {
        if (!this.ensureDir()) return null;
        const name = `.staging-${crypto.randomBytes(6).toString('hex')}`;
        const full = path.join(this.dir, name);
        try {
            fs.mkdirSync(full);
            return full;
        } catch (err) {
            return null;
        }
    }

    /** Remove a directory and everything in it. Never throws. */
    discard(dir) {
        if (!dir) return;
        try {
            fs.rmSync(dir, {recursive: true, force: true});
        } catch (err) {
            /* a leftover folder is swept on the next start */
        }
    }

    /**
     * Clear out staging and mid-swap leftovers, **recovering** where there is
     * something to recover.
     *
     * Called once at startup.
     *
     * - A `.staging-*` folder can only exist because a run was killed
     *   mid-download. It is incomplete by definition and is deleted.
     * - A `.old-<rand>-<dir>` folder means a run was killed mid-swap. If `<dir>`
     *   is there, the swap completed and the parked copy is the *old* version:
     *   delete it. If `<dir>` is **not** there, the process died between the two
     *   renames and this folder is the only copy of that pack — so it is renamed
     *   back rather than thrown away. Deleting it (which the first draft did)
     *   was the one case where "a previously installed good version stays" was
     *   not true.
     *   It is re-validated on the next `list()` like any other pack, so
     *   restoring something damaged costs nothing.
     *
     * @returns {{removed: number, restored: number}}
     */
    sweep() {
        const result = {removed: 0, restored: 0};
        if (!this.dir) return result;
        let entries = [];
        try {
            entries = fs.readdirSync(this.dir, {withFileTypes: true});
        } catch (err) {
            return result;
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const full = path.join(this.dir, entry.name);
            if (entry.name.startsWith('.staging-')) {
                this.discard(full);
                result.removed++;
                continue;
            }
            const parked = parkedDirName(entry.name);
            if (parked === null) continue;
            const live = path.join(this.dir, parked);
            if (fs.existsSync(live)) {
                this.discard(full);
                result.removed++;
                continue;
            }
            try {
                fs.renameSync(full, live);
                result.restored++;
                this.invalidate();
            } catch (err) {
                // Leaving it in place is strictly better than deleting it: the
                // next start tries again, and nothing reads a `.old-*` folder.
                console.error('Map packs: could not restore a parked pack:', err && err.message);
            }
        }
        return result;
    }

    /**
     * Move a fully verified staging directory into place.
     *
     * Rename-based, in this order, because the invariant is *"a previously
     * installed good version stays"*:
     *   1. the live folder (if any) is renamed aside to `.old-<rand>-<dir>`;
     *   2. the staging folder is renamed onto the live name;
     *   3. only then is the old one deleted.
     * If step 2 fails, step 1 is undone and the old pack is still installed; if
     * the *process* dies between 1 and 2, the next `sweep()` renames the parked
     * folder back (which is what its name carries the directory for). Two
     * renames rather than one because Windows refuses to rename onto an
     * existing directory.
     *
     * Before any of that: if the live directory already exists and belongs to a
     * **different key**, the swap is refused. `packDirName` folds punctuation,
     * so `a/b c` and `a/b-c` are two keys with one directory, and letting the
     * second one overwrite the first is how two packs end up reinstalling over
     * each other on every check forever. `validateIndex` refuses that pair as
     * well; this is the check at the point where it actually matters, because
     * an index is not the only way a directory gets there.
     *
     * @param {string} stagingDir
     * @param {string} key the pack's map key
     * @returns {{ok: boolean, dir: ?string, error: ?string}}
     */
    commit(stagingDir, key) {
        const dirName = rules.packDirName(key);
        if (!dirName) return {ok: false, dir: null, error: 'bad-key'};
        if (!this.ensureDir()) return {ok: false, dir: null, error: 'no-packs-dir'};
        const target = path.join(this.dir, dirName);
        const parked = path.join(this.dir,
            `${PARKED_PREFIX}${crypto.randomBytes(PARKED_RANDOM_HEX / 2).toString('hex')}-${dirName}`);

        // Whose directory is this? A manifest that will not parse is not a
        // claim, so an unreadable one does not block the install — it is
        // replaced, which is also how a half-written pack heals.
        if (fs.existsSync(target)) {
            const existing = this.readManifestFile(path.join(target, rules.MANIFEST_NAME));
            if (existing.ok && existing.manifest.key !== key) {
                return {ok: false, dir: null, error: 'dir-owned-by-other-key'};
            }
        }

        let hadPrevious = false;
        try {
            if (fs.existsSync(target)) {
                fs.renameSync(target, parked);
                hadPrevious = true;
            }
        } catch (err) {
            return {ok: false, dir: null, error: `park:${(err && err.code) || 'failed'}`};
        }
        try {
            fs.renameSync(stagingDir, target);
        } catch (err) {
            // Put the old version back before reporting failure — an install
            // that fails must leave the user exactly where they were.
            if (hadPrevious) {
                try {
                    fs.renameSync(parked, target);
                } catch (restoreErr) {
                    return {ok: false, dir: null, error: 'restore-failed'};
                }
            }
            return {ok: false, dir: null, error: `swap:${(err && err.code) || 'failed'}`};
        }
        if (hadPrevious) this.discard(parked);
        this.invalidate();
        return {ok: true, dir: dirName, error: null};
    }

    /* ── state ───────────────────────────────────────────────────────────── */

    /**
     * When the last check ran and how it went.
     *
     * A file next to the packs rather than a setting: `settings-app.json` is the
     * user's preferences and every write of it is an `app.log` line, while this
     * is bookkeeping that changes once a day. It also keeps the "last check
     * result" the diagnostic report prints in the same place as the packs it
     * describes.
     *
     * `offeredHotkeys` is the other thing it remembers: the map keys a default
     * `Ctrl+Alt+N` has already been offered for. A binding the user *deleted*
     * must not come back on the next start, so "have we ever offered one for
     * this map" has to outlive `hotkeys.json` itself. Bounded, because it only
     * ever grows.
     *
     * @returns {{lastCheckAt: number, lastResult: string, lastError: ?string,
     *            installed: number, offeredHotkeys: Array<string>}}
     */
    state() {
        const empty = () => ({
            lastCheckAt: 0, lastResult: 'never', lastError: null, installed: 0, offeredHotkeys: []
        });
        if (!this.dir) return empty();
        try {
            const file = path.join(this.dir, 'state.json');
            const stat = fs.statSync(file);
            if (!stat.isFile() || stat.size > 64 * 1024) return empty();
            const json = JSON.parse(fs.readFileSync(file, 'utf-8'));
            if (!json || typeof json !== 'object') return empty();
            return {
                lastCheckAt: Number.isFinite(json.lastCheckAt) ? json.lastCheckAt : 0,
                lastResult: typeof json.lastResult === 'string' ? json.lastResult.slice(0, 64) : 'never',
                lastError: typeof json.lastError === 'string' ? json.lastError.slice(0, 120) : null,
                installed: Number.isFinite(json.installed) ? json.installed : 0,
                offeredHotkeys: Array.isArray(json.offeredHotkeys)
                    ? json.offeredHotkeys.filter(k => typeof k === 'string' && rules.isValidPackKey(k))
                        .slice(0, MAX_OFFERED_HOTKEYS)
                    : []
            };
        } catch (err) {
            return empty();
        }
    }

    /**
     * Remember that a default hotkey has been offered for these map keys.
     * Idempotent, and bounded — see `state()`.
     * @param {Array<string>} keys
     * @returns {boolean} whether it reached the disk
     */
    noteOfferedHotkeys(keys) {
        const list = (keys || []).filter(k => typeof k === 'string' && rules.isValidPackKey(k));
        if (!list.length) return true;
        const merged = this.state().offeredHotkeys.slice();
        for (const key of list) if (!merged.includes(key)) merged.push(key);
        return this.writeState({offeredHotkeys: merged.slice(-MAX_OFFERED_HOTKEYS)});
    }

    /**
     * Record a check. Synchronous and wrapped: main installs an
     * `uncaughtException` handler that writes a crash file and exits, so every
     * synchronous write reachable from a handler has to swallow its own error
     * (`docs/agents/diagnostics.md`).
     * @returns {boolean}
     */
    writeState(partial) {
        if (!this.ensureDir()) return false;
        const next = Object.assign(this.state(), partial || {});
        try {
            fs.writeFileSync(path.join(this.dir, 'state.json'), JSON.stringify(next));
            return true;
        } catch (err) {
            return false;
        }
    }
}

module.exports = MapPackStore;
module.exports.parkedDirName = parkedDirName;
module.exports.PARKED_PREFIX = PARKED_PREFIX;
module.exports.MAX_OFFERED_HOTKEYS = MAX_OFFERED_HOTKEYS;
