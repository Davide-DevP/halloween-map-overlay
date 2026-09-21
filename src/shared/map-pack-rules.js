'use strict';

/**
 * PURE map-pack rules (imports nothing): names, URLs, validation, precedence
 * and the check schedule. Everything a pack carries is **untrusted**, so every
 * rule here is an allow-list and a pack that fails one check is discarded
 * whole. See `docs/SPEC-MAP-PACKS.md` and `docs/agents/map-packs.md`.
 */

/** Bumped only if the on-the-wire format changes incompatibly. */
const PACK_FORMAT = 1;

/** The one host and the one path prefix under it, both enforced. The prefix
 * does *not* exclude forks; SHA-256 pinning to this index does — see "The
 * trust root" in `docs/agents/map-packs.md`. */
const PACK_HOST = 'raw.githubusercontent.com';
const PACK_PATH_PREFIX = '/Davide-DevP/halloween-map-overlay/';
const INDEX_URL = `https://${PACK_HOST}${PACK_PATH_PREFIX}main/packs/index.json`;

/** Hard byte caps — where reading stops, so a hostile index cannot fill the
 * disk. A real map is ~300 KB of PNG and ~48 KB of templates. */
const LIMITS = {
    index: 256 * 1024,
    image: 8 * 1024 * 1024,
    templates: 8 * 1024 * 1024,
    manifest: 64 * 1024,
    markers: 64 * 1024,
    /** One pack, all files together. */
    pack: 16 * 1024 * 1024,
    /** Packs the index may list — a list, not a stream: it is read whole. */
    packs: 200,
    /** Files one pack may list. */
    files: 8,
    /** Template variants the detector may score, bundled **and** packs: a cost
     * bound at ~0.10 ms each (re-measured for 1.0) against a ~30 ms per-tick
     * budget, not a capacity plan. See `docs/agents/detection.md`. */
    variants: 48
};

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Retry delay after a **failed** check: a launch with no network would
 * otherwise write `lastCheckAt` and burn the whole day's slot. */
const RETRY_INTERVAL_MS = 60 * 60 * 1000;

const ALLOWED_EXTENSIONS = ['.png', '.json'];

const MANIFEST_NAME = 'pack.json';
const TEMPLATES_NAME = 'templates.json';
const MARKERS_NAME = 'markers.json';

/** Reserved for user imports (`map-catalog.js` `CUSTOM_CREATOR`); a pack
 * claiming it makes the catalogue ambiguous about where the image lives. A
 * literal, since this module imports nothing — a test asserts they agree. */
const RESERVED_CREATOR = 'Custom';

/** One segment of a map key. Deliberately narrow: wide enough for the real
 * names (`O'Malley's Farm`), safe in a `key=…` log line (no newline, no `=`) and
 * as a directory-name seed, free of every path-traversal character. */
const KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9 ._'()-]{0,63}$/;

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

/** Stems Windows reserves as **device names**, whatever extension follows:
 * writing `CON.png` succeeds and goes nowhere, so such a pack installs nothing
 * and is retried forever. The one deny-list here; applied to the stem. */
const WINDOWS_RESERVED_STEMS = new Set([
    'con', 'prn', 'aux', 'nul',
    'com0', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
    'lpt0', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
]);

/** Characters that must never survive into a stored string: C0/C1 controls and
 * DEL, the zero-width formatters, the bidi overrides and isolates, the BOM — a
 * `credit` carrying `U+202E` reverses every sentence it is shown in. `\u`
 * escapes only, **never the literal characters**: in raw bytes git classified
 * this validator as binary, and a text-normaliser could drop a range. A test
 * asserts this file is pure ASCII. */
const UNSAFE_TEXT = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** A number that is finite and real — `NaN`/`Infinity`/`"3"` are not. */
function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeInt(value) {
    return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

function isPositiveInt(value) {
    return isNonNegativeInt(value) && value > 0;
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A lower-case hex SHA-256 digest. Upper case is refused, not folded: the
 * generator writes lower case, and folding means two spellings of one hash. */
function isSha256(value) {
    return typeof value === 'string' && SHA256_HEX.test(value);
}

/** The extension of a file name, lower-cased, including the dot. */
function extensionOf(name) {
    const match = /\.[^.]+$/.exec(String(name || ''));
    return match ? match[0].toLowerCase() : '';
}

/** Is this a file name a pack may contain? Refuses separators, `..`, a colon, a
 * leading dot, controls, any extension but `.png`/`.json`, and >64 chars. */
function isValidFileName(name) {
    if (typeof name !== 'string' || !name) return false;
    if (name.length > 64) return false;
    // Checked explicitly as well as by the pattern: their absence IS the
    // security property, and a regex is easy to widen by accident.
    if (name.includes('/') || name.includes('\\') || name.includes(':')) return false;
    if (name.includes('..')) return false;
    if (!FILE_NAME.test(name)) return false;
    if (!ALLOWED_EXTENSIONS.includes(extensionOf(name))) return false;
    // Windows device names: writing them succeeds and goes nowhere.
    const stem = name.slice(0, name.length - extensionOf(name).length).trim().toLowerCase();
    if (WINDOWS_RESERVED_STEMS.has(stem)) return false;
    return true;
}

/** A stored free-text field with the unsafe characters taken out, bounded to
 * `max` after stripping; null when nothing is left. Only `credit` uses it.
 * Stripped rather than refused: a stray zero-width space is a copy-paste
 * accident, not a reason to drop a map. */
function sanitizeText(value, max) {
    if (typeof value !== 'string') return null;
    const cleaned = value.replace(UNSAFE_TEXT, '').trim().slice(0, max || 200);
    return cleaned || null;
}

/** Is this a map key a pack may claim? `Creator/Map Name`, one slash. */
function isValidPackKey(key) {
    if (typeof key !== 'string' || !key) return false;
    const parts = key.split('/');
    if (parts.length !== 2) return false;
    if (!KEY_SEGMENT.test(parts[0]) || !KEY_SEGMENT.test(parts[1])) return false;
    // Trailing/leading spaces would make two keys that look identical.
    if (parts.some(part => part !== part.trim())) return false;
    if (parts[0].toLowerCase() === RESERVED_CREATOR.toLowerCase()) return false;
    return true;
}

/** The install directory for a pack, **derived** from its key and never taken
 * from the pack; null for a key a pack may not claim. Reduced to `[a-z0-9-]`,
 * so it is legal everywhere and case-insensitively unique; the folding lets
 * distinct keys collide, which `validateIndex` and `store.commit` refuse. */
function packDirName(key) {
    if (!isValidPackKey(key)) return null;
    const slug = key
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return slug || null;
}

/** Compare two dotted numeric versions; `<0`, `0` or `>0`. A pre-release of
 * X.Y.Z compares equal to X.Y.Z; a string with no numbers compares as 0. */
function compareVersions(a, b) {
    // The *leading* numeric run only: filtering non-numeric parts out instead
    // would make `1.0.0-beta.1` compare *newer* than `1.0.0`.
    const parse = (value) => {
        const match = /^\d+(?:\.\d+)*/.exec(String(value == null ? '' : value).trim());
        return match ? match[0].split('.').map(Number) : [];
    };
    const left = parse(a);
    const right = parse(b);
    const length = Math.max(left.length, right.length);
    for (let i = 0; i < length; i++) {
        const l = left[i] || 0;
        const r = right[i] || 0;
        if (l !== r) return l < r ? -1 : 1;
    }
    return 0;
}

/** Is this app new enough for the pack? A missing/blank `minAppVersion` means
 * any version. A pack needing a newer app is skipped rather than installed and
 * half-understood — a later version may teach the app a field it now ignores. */
function appSatisfies(appVersion, minAppVersion) {
    if (minAppVersion === undefined || minAppVersion === null || minAppVersion === '') return true;
    if (typeof minAppVersion !== 'string') return false;
    if (!/^\d+(\.\d+)*/.test(minAppVersion)) return false;
    return compareVersions(appVersion, minAppVersion) >= 0;
}

/** The URL allow-list: https only, one host, one path prefix, no credentials,
 * no port, no query. Applied to the URLs derived below **and** to every
 * redirect `Location` — a redirect is another URL somebody else chose. */
function isAllowedUrl(url) {
    if (typeof url !== 'string' || !url) return false;
    // On the raw string as well as on the parsed path: `new URL` normalises
    // `..` away, so a socket would open for a URL nobody intended.
    if (url.includes('..') || url.includes('\\')) return false;
    let parsed;
    try {
        parsed = new URL(url);
    } catch (err) {
        return false;
    }
    if (parsed.protocol !== 'https:') return false;
    if (parsed.hostname.toLowerCase() !== PACK_HOST) return false;
    if (parsed.port) return false;
    if (parsed.username || parsed.password) return false;
    if (parsed.search || parsed.hash) return false;
    if (!parsed.pathname.startsWith(PACK_PATH_PREFIX)) return false;
    if (parsed.pathname.includes('..') || parsed.pathname.includes('//')) return false;
    return true;
}

/** One pack file's URL, from the index's own URL plus the pack's `base` and
 * file name; null when any part is unacceptable. **The only way a file URL is
 * produced**: a pack supplies a *name* (through `isValidFileName`) and a
 * `base`, never a URL. The base is either a relative directory resolved against
 * the index's own, or an absolute URL that must pass `isAllowedUrl`. */
function packFileUrl(indexUrl, base, name) {
    if (!isAllowedUrl(indexUrl)) return null;
    if (!isValidFileName(name)) return null;
    if (typeof base !== 'string' || !base) return null;
    if (base.includes('..') || base.includes('\\')) return null;

    let baseUrl;
    if (/^https?:\/\//i.test(base)) {
        // An absolute base wins nothing: still the one host under the prefix.
        if (!isAllowedUrl(base)) return null;
        baseUrl = base.endsWith('/') ? base : base + '/';
    } else {
        // Plain path segments only, each validated like a file name, so
        // `%2e%2e`, a leading `/` and a drive letter are out before `new URL`
        // ever sees them.
        const segments = base.split('/').filter(part => part !== '');
        if (!segments.length || base.startsWith('/')) return null;
        for (const segment of segments) {
            if (segment.length > 64) return null;
            if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment)) return null;
        }
        const dir = indexUrl.slice(0, indexUrl.lastIndexOf('/') + 1);
        baseUrl = dir + segments.join('/') + '/';
    }

    // Encoded here, not left to the HTTP client, so the string that is checked
    // is the string that is sent (a map image's name may hold a space).
    const url = baseUrl + encodeURIComponent(name);
    // Re-validated: what goes to the network is what must pass the allow-list.
    return isAllowedUrl(url) ? url : null;
}

/** One `{name, bytes, sha256}` entry, as index and manifest both spell it. */
function normalizeFileEntry(raw, limit) {
    if (!isPlainObject(raw)) return null;
    if (!isValidFileName(raw.name)) return null;
    if (!isPositiveInt(raw.bytes)) return null;
    if (limit && raw.bytes > limit) return null;
    if (!isSha256(raw.sha256)) return null;
    return {name: raw.name, bytes: raw.bytes, sha256: raw.sha256};
}

function limitForFile(name) {
    if (extensionOf(name) === '.png') return LIMITS.image;
    if (name === MARKERS_NAME) return LIMITS.markers;
    if (name === MANIFEST_NAME) return LIMITS.manifest;
    return LIMITS.templates;
}

/** Validate a parsed `packs/index.json` into `{ok, error, packs, rejected}` —
 * the packs it accepted *and* why it dropped the rest, so "the new map did not
 * arrive" is answerable from `app.log`. A malformed entry drops that entry, a
 * malformed document everything. */
function validateIndex(json) {
    const rejected = [];
    if (!isPlainObject(json)) return {ok: false, error: 'not-an-object', packs: [], rejected};
    if (json.formatVersion !== PACK_FORMAT) {
        // A newer index format is never guessed at.
        return {ok: false, error: `format-version:${json.formatVersion}`, packs: [], rejected};
    }
    if (!Array.isArray(json.packs)) return {ok: false, error: 'packs-not-an-array', packs: [], rejected};
    if (json.packs.length > LIMITS.packs) return {ok: false, error: 'too-many-packs', packs: [], rejected};

    const packs = [];
    const seen = new Set();
    // Install directories already claimed: `packDirName` folds punctuation, so
    // `a/b c`, `a/b-c` and `a-b/c` all land in `a-b-c` and would reinstall over
    // each other forever. `store.commit` checks again at the swap.
    const dirs = new Set();
    for (const raw of json.packs) {
        const reject = (reason) => rejected.push({
            key: isPlainObject(raw) && typeof raw.key === 'string' ? raw.key.slice(0, 80) : '',
            reason
        });
        if (!isPlainObject(raw)) { reject('not-an-object'); continue; }
        if (!isValidPackKey(raw.key)) { reject('bad-key'); continue; }
        // A duplicate key is a broken index, not a precedence question.
        const lower = raw.key.toLowerCase();
        if (seen.has(lower)) { reject('duplicate-key'); continue; }
        const dir = packDirName(raw.key);
        if (!dir) { reject('bad-key'); continue; }
        if (dirs.has(dir)) { reject('duplicate-dir'); continue; }
        if (!isPositiveInt(raw.version)) { reject('bad-version'); continue; }
        if (raw.minAppVersion !== undefined && raw.minAppVersion !== null
            && (typeof raw.minAppVersion !== 'string' || !/^\d+(\.\d+)*$/.test(raw.minAppVersion))) {
            reject('bad-min-app-version');
            continue;
        }
        if (typeof raw.base !== 'string' || !raw.base) { reject('bad-base'); continue; }
        if (!Array.isArray(raw.files) || !raw.files.length) { reject('bad-files'); continue; }
        if (raw.files.length > LIMITS.files) { reject('too-many-files'); continue; }

        const files = [];
        const names = new Set();
        let total = 0;
        let bad = null;
        for (const rawFile of raw.files) {
            const file = normalizeFileEntry(rawFile, isPlainObject(rawFile) ? limitForFile(rawFile.name) : 0);
            if (!file) { bad = 'bad-file'; break; }
            if (names.has(file.name.toLowerCase())) { bad = 'duplicate-file'; break; }
            names.add(file.name.toLowerCase());
            total += file.bytes;
            files.push(file);
        }
        if (bad) { reject(bad); continue; }
        if (total > LIMITS.pack) { reject('pack-too-large'); continue; }
        // Fetched by name; listing it among the files it describes is circular.
        if (names.has(MANIFEST_NAME)) { reject('manifest-listed'); continue; }
        if (!names.has(TEMPLATES_NAME)) { reject('no-templates'); continue; }
        if (![...names].some(name => extensionOf(name) === '.png')) { reject('no-image'); continue; }

        seen.add(lower);
        dirs.add(dir);
        packs.push({
            key: raw.key,
            version: raw.version,
            minAppVersion: typeof raw.minAppVersion === 'string' ? raw.minAppVersion : null,
            base: raw.base,
            files,
            bytes: total
        });
    }
    return {ok: true, error: null, packs, rejected};
}

/**
 * Validate a parsed `pack.json` against the index `entry` it came from (or
 * against nothing, for an installed pack) into `{ok, error, manifest}`. Not a
 * second opinion: where the two disagree the pack is refused. It exists so an
 * *installed* pack is self-describing — the catalogue is read from disk on
 * every start, long after the index is gone — and so a pack copied in by hand
 * is checked too. `opts.appVersion` enables the `minAppVersion` check.
 */
function validateManifest(json, entry, opts) {
    const options = opts || {};
    const fail = (error) => ({ok: false, error, manifest: null});
    if (!isPlainObject(json)) return fail('not-an-object');
    if (json.formatVersion !== PACK_FORMAT) return fail(`format-version:${json.formatVersion}`);
    if (!isValidPackKey(json.key)) return fail('bad-key');
    if (!isPositiveInt(json.version)) return fail('bad-version');
    if (json.minAppVersion !== undefined && json.minAppVersion !== null
        && (typeof json.minAppVersion !== 'string' || !/^\d+(\.\d+)*$/.test(json.minAppVersion))) {
        return fail('bad-min-app-version');
    }
    const minAppVersion = typeof json.minAppVersion === 'string' ? json.minAppVersion : null;
    if (options.appVersion && !appSatisfies(options.appVersion, minAppVersion)) {
        return fail(`needs-app:${minAppVersion}`);
    }
    // `name`/`creator` are **derived from the key**, never taken from the
    // manifest: as free text they hijack bare-name lookups, reach the reserved
    // `Custom` group and `Object.prototype`, and are a rendering surface. See
    // `docs/agents/map-packs.md`.
    const [keyCreator, keyName] = json.key.split('/');
    if (json.name !== undefined && json.name !== null && json.name !== keyName) return fail('name-mismatch');
    if (json.creator !== undefined && json.creator !== null && json.creator !== keyCreator) {
        return fail('creator-mismatch');
    }
    if (json.credit !== undefined && json.credit !== null && typeof json.credit !== 'string') {
        return fail('bad-credit');
    }
    if (!isValidFileName(json.image) || extensionOf(json.image) !== '.png') return fail('bad-image');
    if (json.markers !== undefined && json.markers !== null && json.markers !== MARKERS_NAME) {
        return fail('bad-markers-name');
    }
    if (!Array.isArray(json.files) || !json.files.length || json.files.length > LIMITS.files) {
        return fail('bad-files');
    }

    const files = [];
    const byName = new Map();
    let total = 0;
    for (const rawFile of json.files) {
        const file = normalizeFileEntry(rawFile, isPlainObject(rawFile) ? limitForFile(rawFile.name) : 0);
        if (!file) return fail('bad-file');
        if (byName.has(file.name)) return fail('duplicate-file');
        byName.set(file.name, file);
        total += file.bytes;
        files.push(file);
    }
    if (total > LIMITS.pack) return fail('pack-too-large');
    if (!byName.has(json.image)) return fail('image-not-listed');
    if (!byName.has(TEMPLATES_NAME)) return fail('templates-not-listed');
    if (json.markers && !byName.has(MARKERS_NAME)) return fail('markers-not-listed');

    if (entry) {
        if (entry.key !== json.key) return fail('key-mismatch');
        if (entry.version !== json.version) return fail('version-mismatch');
        const indexFiles = new Map((entry.files || []).map(f => [f.name, f]));
        if (indexFiles.size !== byName.size) return fail('file-list-mismatch');
        for (const [name, file] of byName) {
            const other = indexFiles.get(name);
            if (!other) return fail('file-list-mismatch');
            if (other.bytes !== file.bytes || other.sha256 !== file.sha256) return fail('file-hash-mismatch');
        }
    }

    return {
        ok: true,
        error: null,
        manifest: {
            formatVersion: PACK_FORMAT,
            key: json.key,
            name: keyName,
            creator: keyCreator,
            credit: sanitizeText(json.credit, 200),
            version: json.version,
            minAppVersion,
            image: json.image,
            markers: json.markers ? MARKERS_NAME : null,
            files
        }
    };
}

/** Validate a pack's `templates.json` against `expect: {key, size}` — the shape
 * `map-detector/templates.json` holds for one map, every variant `size * size`
 * finite numbers. Finiteness is checked element by element: the matcher reads
 * templates with `Float32Array.from`, and one `NaN` poisons the NCC for every
 * map, i.e. the detector silently stops working. A pack's file names its own
 * key only, or one pack could replace another. */
function validateTemplates(json, expect) {
    const key = expect && expect.key;
    const size = expect && expect.size;
    const fail = (error) => ({ok: false, error, variants: 0});
    if (!isPlainObject(json)) return fail('not-an-object');
    if (json.format !== 2) return fail(`format:${json.format}`);
    if (!isPositiveInt(json.size) || json.size !== size) return fail(`size:${json.size}`);
    if (!isPlainObject(json.templates)) return fail('templates-not-an-object');

    const keys = Object.keys(json.templates);
    if (keys.length !== 1) return fail(`keys:${keys.length}`);
    if (keys[0] !== key) return fail('key-mismatch');

    const variants = json.templates[keys[0]];
    if (!Array.isArray(variants) || !variants.length) return fail('variants-not-an-array');
    // Per-pack cap on the detector's per-tick cost: every variant is scored on
    // every frame that passes the Tab gate. Bundled maps have two.
    if (variants.length > 8) return fail(`too-many-variants:${variants.length}`);
    const expected = size * size;
    for (const variant of variants) {
        if (!Array.isArray(variant)) return fail('variant-not-an-array');
        if (variant.length !== expected) return fail(`variant-length:${variant.length}`);
        for (let i = 0; i < variant.length; i++) {
            const value = variant[i];
            if (!isFiniteNumber(value)) return fail('variant-not-finite');
            // 0..1 luminance: the generator cannot produce anything else.
            if (value < 0 || value > 1) return fail('variant-out-of-range');
        }
    }
    return {ok: true, error: null, variants: variants.length};
}

const MARKER_LAYER_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$/;

/**
 * Validate one map's markers document — a pack's optional `markers.json` *and*
 * every entry of the bundled `map-markers/markers.json`, held to one shape:
 * `{layers: {<name>: [{x, y}, …]}, baked?: [<name>, …], tab?: {sx, sy, tx, ty}}`.
 * Points are fractions (0..1) of the map **image**; `baked` names the layers
 * the image already draws and `tab` is the affine map onto the Tab panel
 * interior (`u = sx*x + tx`), both optional — see
 * `docs/agents/markers-and-tab-mode.md`. Every number is checked for
 * finiteness: a `NaN` becomes an SVG attribute the renderer silently drops.
 */
function validateMarkers(json) {
    const fail = (error) => ({ok: false, error, layers: 0, points: 0, baked: 0});
    if (!isPlainObject(json)) return fail('not-an-object');
    if (!isPlainObject(json.layers)) return fail('layers-not-an-object');
    const names = Object.keys(json.layers);
    if (names.length > 32) return fail('too-many-layers');
    let points = 0;
    for (const name of names) {
        if (!MARKER_LAYER_NAME.test(name)) return fail('bad-layer-name');
        const layer = json.layers[name];
        if (!Array.isArray(layer)) return fail('layer-not-an-array');
        if (layer.length > 512) return fail('layer-too-long');
        for (const point of layer) {
            if (!isPlainObject(point)) return fail('point-not-an-object');
            if (!isFiniteNumber(point.x) || !isFiniteNumber(point.y)) return fail('point-not-finite');
            if (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return fail('point-out-of-range');
            points++;
        }
    }
    let baked = 0;
    if (json.baked !== undefined && json.baked !== null) {
        if (!Array.isArray(json.baked)) return fail('baked-not-an-array');
        if (json.baked.length > 32) return fail('too-many-baked');
        const seen = new Set();
        for (const name of json.baked) {
            if (typeof name !== 'string' || !MARKER_LAYER_NAME.test(name)) return fail('bad-baked-name');
            // Naming an absent layer is a typo that is invisible at runtime
            // (the layer simply draws), so it is refused.
            if (!Object.prototype.hasOwnProperty.call(json.layers, name)) return fail('baked-unknown-layer');
            if (seen.has(name)) return fail('duplicate-baked');
            seen.add(name);
        }
        baked = seen.size;
    }
    if (json.tab !== undefined && json.tab !== null) {
        if (!isPlainObject(json.tab)) return fail('tab-not-an-object');
        for (const field of ['sx', 'sy', 'tx', 'ty']) {
            if (!isFiniteNumber(json.tab[field])) return fail(`tab-${field}`);
        }
    }
    return {ok: true, error: null, layers: names.length, points, baked};
}

/**
 * Which of `validateIndex`'s packs are worth downloading, given the `installed`
 * `{key, version}` list, as `{install, skipped}`. Three normal (non-error)
 * reasons to skip: `up-to-date`, `needs-app`, and `downgrade` — an index
 * offering an *older* version is refused, because the index is a file in a git
 * repository and a botched revert must not roll every user's map back. The
 * escape hatch is the next genuine version bump.
 */
function selectPacksToInstall(indexPacks, installed, appVersion) {
    const have = new Map();
    for (const pack of installed || []) {
        if (pack && typeof pack.key === 'string') have.set(pack.key.toLowerCase(), pack.version || 0);
    }
    const install = [];
    const skipped = [];
    for (const pack of indexPacks || []) {
        if (!appSatisfies(appVersion, pack.minAppVersion)) {
            skipped.push({key: pack.key, reason: 'needs-app', version: pack.version});
            continue;
        }
        const current = have.get(pack.key.toLowerCase());
        if (current !== undefined) {
            if (pack.version === current) {
                skipped.push({key: pack.key, reason: 'up-to-date', version: pack.version});
                continue;
            }
            if (pack.version < current) {
                skipped.push({key: pack.key, reason: 'downgrade', version: pack.version});
                continue;
            }
        }
        install.push(pack);
    }
    return {install, skipped};
}

/**
 * Merge installed packs into a `buildCatalog`/`mergeCustomMaps` catalogue.
 * **A pack wins over a bundled map with the same key** — that is the feature:
 * a bundled map has no version, so a pack can fix its image, templates or
 * markers without a release. Custom maps cannot collide (`isValidPackKey`
 * refuses the reserved `Custom` creator). Entries keep the shape the rest of
 * the app consumes, plus `pack` (the install directory, so the fs half finds
 * the image) and `packVersion`, so nothing downstream special-cases them.
 * `sort` is the catalogue's own ordering, injected so this module stays
 * import-free and there is still exactly one implementation of it.
 */
function mergeMapPacks(catalog, packs, sort) {
    const out = [];
    const byKey = new Map();
    for (const entry of catalog || []) {
        out.push(entry);
        if (!entry.custom) byKey.set(entry.key.toLowerCase(), out.length - 1);
    }
    for (const pack of packs || []) {
        if (!pack || !isValidPackKey(pack.key)) continue;
        const [creator, name] = pack.key.split('/');
        const entry = {
            key: pack.key,
            creator: pack.creator || creator,
            name: pack.name || name,
            file: pack.image,
            custom: false,
            pack: pack.dir,
            packVersion: pack.version,
            markers: pack.markers ? true : false
        };
        const at = byKey.get(pack.key.toLowerCase());
        if (at === undefined) {
            byKey.set(pack.key.toLowerCase(), out.length);
            out.push(entry);
        } else {
            // In place, with `creator`/`name` still from the *key*, so a pack
            // cannot rename a map into another one's name.
            out[at] = entry;
        }
    }
    return typeof sort === 'function' ? sort(out) : out;
}

/**
 * Template sources for the detector: `bundled` (the committed `templates`
 * object) plus every installed pack, a pack winning on a shared key. Returns
 * `{templates, replaced, dropped, variants}` — one object walk **at load time**
 * and nothing per tick. Two rules: **key comparison folds case, exactly like
 * `mergeMapPacks`** (when they disagreed, a pack replaced the gallery entry and
 * left the bundled templates, i.e. the detection it existed to fix), and a
 * **global variant budget** (`opts.maxVariants`, default `LIMITS.variants`),
 * since every variant is scored on every gated-in frame — bundled maps are
 * never dropped, packs past the budget are and are named in `dropped`.
 */
function mergeTemplateSources(bundled, packs, opts) {
    const max = (opts && isPositiveInt(opts.maxVariants)) ? opts.maxVariants : LIMITS.variants;
    const templates = Object.assign({}, bundled || {});
    const replaced = [];
    const dropped = [];

    /** lower-cased key → the spelling actually present in `templates`. */
    const byLower = new Map();
    let total = 0;
    for (const [key, variants] of Object.entries(templates)) {
        byLower.set(key.toLowerCase(), key);
        total += Array.isArray(variants) ? variants.length : 1;
    }

    for (const pack of packs || []) {
        if (!pack || !isValidPackKey(pack.key) || !isPlainObject(pack.templates)) continue;
        const variants = pack.templates[pack.key];
        if (!Array.isArray(variants) || !variants.length) continue;

        const lower = pack.key.toLowerCase();
        const existingKey = byLower.get(lower);
        const freed = existingKey && Array.isArray(templates[existingKey])
            ? templates[existingKey].length : 0;
        if (total - freed + variants.length > max) {
            dropped.push(pack.key);
            continue;
        }
        if (existingKey !== undefined) {
            replaced.push(existingKey);
            // Delete before setting: two spellings would be two candidates.
            delete templates[existingKey];
        }
        templates[pack.key] = variants;
        byLower.set(lower, pack.key);
        total = total - freed + variants.length;
    }
    return {templates, replaced, dropped, variants: total};
}

/**
 * Is it time to look for new packs? The one gate both the startup timer and the
 * "Check for new maps now" button go through, so they cannot disagree. With the
 * setting off the answer is always no and **no request is made** — the promise
 * in the README, so a rule here and not a branch at the call site. `force` (the
 * button) ignores the interval but not the setting; a `lastCheckAt` in the
 * future counts as "now", so a bad clock cannot lock the check out for a day.
 * @param {{enabled, lastCheckAt, now, force?, lastFailed?, intervalMs?,
 *          retryMs?}} state
 * @returns {{check: boolean, reason: string}}
 */
function shouldCheckPacks(state) {
    const {enabled, lastCheckAt, now, force, lastFailed} = state || {};
    const full = isPositiveInt(state && state.intervalMs) ? state.intervalMs : CHECK_INTERVAL_MS;
    const retry = isPositiveInt(state && state.retryMs) ? state.retryMs : RETRY_INTERVAL_MS;
    // Never longer than the ordinary interval, whatever the two are set to.
    const interval = lastFailed ? Math.min(retry, full) : full;
    // `force` is only ever the *Check now* button and the click is the consent;
    // there is no separate map-pack switch left to point the user at.
    if (force) return {check: true, reason: enabled === false ? 'manual' : 'forced'};
    if (enabled === false) return {check: false, reason: 'disabled'};
    if (!isFiniteNumber(now)) return {check: false, reason: 'no-clock'};
    if (!isFiniteNumber(lastCheckAt) || lastCheckAt <= 0) return {check: true, reason: 'never'};
    if (lastCheckAt > now) return {check: true, reason: 'clock-moved'};
    if (now - lastCheckAt >= interval) return {check: true, reason: lastFailed ? 'retry' : 'due'};
    return {check: false, reason: 'too-soon'};
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Dimensions a map overlay image may have. The bundled four are ~600x600. */
const MIN_IMAGE_SIDE = 64;
const MAX_IMAGE_SIDE = 8192;

/** Is this buffer a PNG? On the bytes, never the name the pack chose. */
function hasPngSignature(bytes) {
    if (!bytes || bytes.length < PNG_SIGNATURE.length) return false;
    for (let i = 0; i < PNG_SIGNATURE.length; i++) {
        if (bytes[i] !== PNG_SIGNATURE[i]) return false;
    }
    return true;
}

/**
 * Does this buffer end in an `IEND` chunk (a zero length, `IEND`, its CRC)?
 * Catches a truncated download that happens to have the right byte count.
 */
function hasPngEnd(bytes) {
    if (!bytes || bytes.length < 20) return false;
    // `latin1` so this works on a plain Buffer with no assumptions about text.
    return bytes.slice(bytes.length - 8, bytes.length - 4).toString('latin1') === 'IEND';
}

/**
 * Could a PNG of `size` really be this small? A 33-byte signature+IHDR claiming
 * 8192² passes every other check and installs a permanently blank map the next
 * check calls up-to-date. The floor (¼ bit per pixel + 67 bytes of overhead) is
 * far below any real encoder — the bundled maps are ~600x600 and 221–313 **KB**
 * against a 155-byte floor — so it catches truncation, not compression.
 */
function isPlausiblePngBytes(bytes, size) {
    if (!bytes || !isPlainObject(size)) return false;
    if (!hasPngEnd(bytes)) return false;
    const floor = 67 + Math.floor((size.width * size.height) / 4096);
    return bytes.length >= floor;
}

/** Plausible dimensions? `size` is a decoder's `{width, height, type}`. */
function isSaneImageSize(size) {
    if (!isPlainObject(size)) return false;
    if (size.type && String(size.type).toLowerCase() !== 'png') return false;
    for (const side of [size.width, size.height]) {
        if (!isPositiveInt(side)) return false;
        if (side < MIN_IMAGE_SIDE || side > MAX_IMAGE_SIDE) return false;
    }
    return true;
}

module.exports = {
    PACK_FORMAT,
    PACK_HOST,
    PACK_PATH_PREFIX,
    INDEX_URL,
    LIMITS,
    CHECK_INTERVAL_MS,
    RETRY_INTERVAL_MS,
    ALLOWED_EXTENSIONS,
    WINDOWS_RESERVED_STEMS,
    MANIFEST_NAME,
    TEMPLATES_NAME,
    MARKERS_NAME,
    RESERVED_CREATOR,
    MARKER_LAYER_NAME,
    MIN_IMAGE_SIDE,
    MAX_IMAGE_SIDE,
    isValidFileName,
    isValidPackKey,
    sanitizeText,
    packDirName,
    compareVersions,
    appSatisfies,
    isAllowedUrl,
    packFileUrl,
    limitForFile,
    validateIndex,
    validateManifest,
    validateTemplates,
    validateMarkers,
    selectPacksToInstall,
    mergeMapPacks,
    mergeTemplateSources,
    shouldCheckPacks,
    hasPngSignature,
    hasPngEnd,
    isPlausiblePngBytes,
    isSaneImageSize
};
