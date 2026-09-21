'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const rules = require('../shared/map-pack-rules');

/**
 * The installed map packs on disk. **fs only, never electron** — the directory
 * is injected, so the tests drive the whole class against an `mkdtemp` folder;
 * `map-packs.js` is the electron half. `state.json` holds the last check,
 * `<safe-dir>/` one pack, `.staging-<random>/` a download in progress and
 * `.old-<random>-<safe-dir>/` a version mid-swap.
 * Three rules hold it together, all three in `docs/agents/map-packs.md`:
 * **nothing from a pack is ever executed** (`readFileSync` + `JSON.parse`, no
 * `require`, no `vm`); **a pack is fully re-validated on every read**, SHA-256
 * included; and **a pack that fails anything is skipped whole** with the
 * previously installed version untouched — hence the rename-based swap.
 */

/** `.old-<12 hex>-<safe-dir>`: the directory it belonged to is **in the name**
 * so `sweep()` can put it back when the live name is missing. Without that, a
 * kill between the two renames leaves a pack's only copy in a folder the next
 * start deletes. */
const PARKED_PREFIX = '.old-';
const PARKED_RANDOM_HEX = 12;

/** Cap on the "hotkey already offered" list: it only ever grows. */
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

    /** @param {string} dir where packs are installed (`userData/map-packs`) */
    constructor(dir, opts) {
        const options = opts || {};
        this.dir = dir || null;
        this.appVersion = options.appVersion || '0.0.0';
        /** The `size` a pack's templates must declare — the matcher's own. */
        this.templateSize = options.templateSize || 64;
        this._packs = null;
        /** Reasons packs on disk were skipped, for the diagnostic report. */
        this.skipped = [];
    }

    /** Returns false rather than throwing. */
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

    /** Every installed pack, in key order, each one fully validated. */
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

    /** Read and validate one pack directory; null if anything is wrong. */
    readPack(dirName) {
        const note = (reason) => this.skipped.push({dir: dirName, reason});
        const manifest = this.readManifestFile(path.join(this.dir, dirName, rules.MANIFEST_NAME));
        if (!manifest.ok) {
            note(manifest.error);
            return null;
        }
        const pack = manifest.manifest;
        // The name is derived from the key, so a mismatch is a renamed folder —
        // and two folders could then claim one key.
        if (rules.packDirName(pack.key) !== dirName) {
            note('dir-key-mismatch');
            return null;
        }
        // Size **and** SHA-256 of every listed file, exactly as at install time:
        // a file zero-filled in place keeps its byte count. Size first, because
        // it is free and it bounds the read that follows.
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

    /** Never throws. */
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

    /** `JSON.parse` + `validateManifest`, the only way a manifest is ever read:
     * there is deliberately no `require()` of a pack file anywhere. `entry` is
     * the index entry to cross-check against, or null. */
    parseManifest(text, entry) {
        let json;
        try {
            json = JSON.parse(text);
        } catch (err) {
            return {ok: false, error: 'manifest-not-json', manifest: null};
        }
        return rules.validateManifest(json, entry, {appVersion: this.appVersion});
    }

    filePath(pack, name) {
        if (!pack || !pack.dir || !rules.isValidFileName(name)) return null;
        return path.join(this.dir, pack.dir, name);
    }

    /** A `list()` entry's validated templates, as the plain `key → variants`
     * object the detector converts to `Float32Array`s. Read once at load, never
     * per tick — see "The capture path" in `docs/agents/detection.md`. */
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

    /** A pack's optional markers, validated against the documented shape. */
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

    /** A fresh, empty staging directory **inside userData, never `%TEMP%`**: a
     * cross-volume rename is not atomic (Windows refuses it), and `%TEMP%` is
     * where Bitdefender's ATD watches (`docs/agents/updater-and-installer.md`).
     * Null when it could not be created. */
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

    /** Never throws. */
    discard(dir) {
        if (!dir) return;
        try {
            fs.rmSync(dir, {recursive: true, force: true});
        } catch (err) {
            /* a leftover folder is swept on the next start */
        }
    }

    /** Clear out staging and mid-swap leftovers at startup, **recovering**
     * where there is something to recover. `.staging-*` is an interrupted
     * download, incomplete by definition: deleted. `.old-<rand>-<dir>` is an
     * interrupted swap — with `<dir>` present the parked copy is the old
     * version, but with `<dir>` **missing** it is that pack's only copy, so it
     * is renamed back rather than deleted. */
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
                // Left in place, never deleted: the next start tries again.
                console.error('Map packs: could not restore a parked pack:', err && err.message);
            }
        }
        return result;
    }

    /**
     * Move a fully verified staging directory into place. Rename-based and in
     * this order, because the invariant is *"a previously installed good
     * version stays"*: park the live folder aside as `.old-<rand>-<dir>`,
     * rename staging onto the live name, and only then delete the parked copy.
     * A failed swap undoes the park; a process death between the two is
     * repaired by the next `sweep()`. Two renames, not one, because Windows
     * refuses to rename onto an existing directory. And first of all, a live
     * directory belonging to a **different key** refuses the swap — an index is
     * not the only way a directory gets there.
     */
    commit(stagingDir, key) {
        const dirName = rules.packDirName(key);
        if (!dirName) return {ok: false, dir: null, error: 'bad-key'};
        if (!this.ensureDir()) return {ok: false, dir: null, error: 'no-packs-dir'};
        const target = path.join(this.dir, dirName);
        const parked = path.join(this.dir,
            `${PARKED_PREFIX}${crypto.randomBytes(PARKED_RANDOM_HEX / 2).toString('hex')}-${dirName}`);

        // Whose directory is this? An unparseable manifest is not a claim, so
        // it is replaced — which is also how a half-written pack heals.
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
            // Put the old version back first: a failed install must leave the
            // user exactly where they were.
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

    /** When the last check ran and how it went. A file next to the packs rather
     * than a setting: every `settings-app.json` write is an `app.log` line, and
     * this is once-a-day bookkeeping. `offeredHotkeys` is the map keys a default
     * `Ctrl+Alt+N` has already been offered for — it has to outlive
     * `hotkeys.json`, so a binding the user *deleted* cannot come back. */
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

    /** Remember that a default hotkey has been offered for these map keys.
     * Idempotent and bounded; returns whether it reached the disk. */
    noteOfferedHotkeys(keys) {
        const list = (keys || []).filter(k => typeof k === 'string' && rules.isValidPackKey(k));
        if (!list.length) return true;
        const merged = this.state().offeredHotkeys.slice();
        for (const key of list) if (!merged.includes(key)) merged.push(key);
        return this.writeState({offeredHotkeys: merged.slice(-MAX_OFFERED_HOTKEYS)});
    }

    /** Record a check. Synchronous and wrapped: a write reachable from main's
     * `uncaughtException` handler must swallow its own error. */
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
