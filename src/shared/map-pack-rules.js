'use strict';

/**
 * PURE map-pack rules. Imports nothing — no electron, no fs, no net.
 *
 * A *map pack* is a few hundred KB of data that adds or replaces one map
 * without an app release: the overlay PNG, the detector templates for that one
 * map, an optional `markers.json`, and a `pack.json` manifest describing all of
 * them. See `docs/SPEC-MAP-PACKS.md` for the format and the reasoning.
 *
 * Everything in this file is a *decision*, which is why it lives here and is
 * the half the tests drive:
 *   - what a file name inside a pack may look like, and the URL it derives;
 *   - whether an index / manifest / template file / markers file is acceptable;
 *   - which of two versions of one map wins (bundled vs pack);
 *   - whether it is time to check again.
 *
 * Everything a pack carries is **untrusted**: it arrives over the network as
 * JSON and is written by whoever pushed to the packs repository. So the rule
 * throughout is *allow-list, never deny-list* — a shape that is not explicitly
 * accepted is rejected, and a pack that fails any single check is discarded
 * whole rather than partially installed.
 */

/** Bumped only if the on-the-wire format changes incompatibly. */
const PACK_FORMAT = 1;

/**
 * The one host packs may come from, and the one path prefix under it.
 *
 * Both halves matter. The host stops an index that points somewhere else; the
 * prefix stops it pointing at *another repository* on the same host, which
 * anybody can create.
 *
 * Note what the prefix does **not** do: GitHub raw serves every commit of every
 * *fork* under the same `/<owner>/<repo>/` path, so a fork's blob is reachable
 * through it. The actual trust root is narrower and is one level up — the index
 * at `main/packs/index.json` in this repository, which is the only document the
 * app ever starts from. Everything else is pinned to it by SHA-256, so a
 * reachable fork blob can only ever be fetched if its hash is the one the index
 * published, i.e. if it is byte-identical to the intended file.
 */
const PACK_HOST = 'raw.githubusercontent.com';
const PACK_PATH_PREFIX = '/Davide-DevP/halloween-map-overlay/';
const INDEX_URL = `https://${PACK_HOST}${PACK_PATH_PREFIX}main/packs/index.json`;

/**
 * Hard byte caps. A cap is not a guess about what a real pack needs — it is
 * the number at which we stop reading, so a hostile or broken index cannot
 * make the app fill the user's disk. Measured against the bundled maps
 * (see `docs/SPEC-MAP-PACKS.md`): one map is ~300 KB of PNG and ~48 KB of
 * templates, so every cap below has at least an order of magnitude of room.
 */
const LIMITS = {
    index: 256 * 1024,
    image: 8 * 1024 * 1024,
    templates: 8 * 1024 * 1024,
    manifest: 64 * 1024,
    markers: 64 * 1024,
    /** Everything one pack may download, all files together. */
    pack: 16 * 1024 * 1024,
    /** Packs the index may list. A list, not a stream — it is read whole. */
    packs: 200,
    /** Files one pack may list. */
    files: 8,
    /**
     * Template variants the detector may end up scoring, bundled **and**
     * installed packs together.
     *
     * This is a cost bound, not a capacity plan. Measured (`docs/agents/detection.md`, "The
     * capture path"): a frame that passes the Tab gate costs ~16 ms of matching
     * over the bundled 8 variants, i.e. ~2 ms per variant, and the file's own
     * rule is that the blocking JS must not grow past ~30 ms per tick. Without
     * a bound, an index listing its full 200 packs at 8 variants each would put
     * 1600 variants in the hot loop — seconds per tick. 48 is ~24 maps at two
     * views, comfortably more than the game will have, and packs past it are
     * dropped with a log line rather than silently making the detector unusable.
     * If the real map count ever approaches this, the answer is the
     * `utilityProcess` move `docs/agents/detection.md` already names, not a bigger number here.
     */
    variants: 48
};

/** Check at most once a day, plus whenever the user presses the button. */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * How long to wait after a check that **failed** before trying again.
 *
 * A launch with no network would otherwise burn the whole day's slot: the
 * check fails in a second, `lastCheckAt` is written anyway, and the user who
 * comes back online ten minutes later gets nothing until tomorrow. An hour is
 * short enough to catch that and long enough that a permanently offline
 * machine is not retrying in a loop.
 */
const RETRY_INTERVAL_MS = 60 * 60 * 1000;

/** The only file extensions a pack may contain. */
const ALLOWED_EXTENSIONS = ['.png', '.json'];

/** The manifest's own name inside a pack. Never listed in `files`. */
const MANIFEST_NAME = 'pack.json';
const TEMPLATES_NAME = 'templates.json';
const MARKERS_NAME = 'markers.json';

/**
 * The reserved creator for user-imported maps (`src/core/map-catalog.js`
 * `CUSTOM_CREATOR`). A pack may not claim it: those keys mean "a file in the
 * user's own `custom/` folder", and a pack pretending to be one would make the
 * catalogue ambiguous about where an image lives.
 *
 * Duplicated as a literal rather than imported, because this module imports
 * nothing; `test/map-pack-rules.test.js` asserts the two agree.
 */
const RESERVED_CREATOR = 'Custom';

/**
 * One segment of a map key: a display-ish name, deliberately narrow.
 *
 * Wide enough for the real map names (`Haddonfield Town Center`,
 * `O'Malley's Farm`), narrow enough that a key is safe to put in a log line
 * (`<ISO> <event> key=…`, so no newlines and no `=`), safe as the seed of a
 * directory name, and free of the characters that make a path traversal
 * (`/`, `\`, `..`, `:`) possible in the first place.
 */
const KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9 ._'()-]{0,63}$/;

/** A file name inside a pack: one segment, no dots-only, an allowed extension. */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

/**
 * Stems Windows reserves as **device names**, whatever extension follows.
 *
 * `CON.png` is not a file on Windows; it is the console, and opening it
 * succeeds while writing to it goes nowhere. `fs.writeFileSync` therefore does
 * not fail, the size check afterwards does — so a pack naming its image `CON.png`
 * would install nothing and be retried forever. The allow-list above cannot
 * express this (they are ordinary letters), so it is the one deny-list here,
 * and it is applied to the stem case-insensitively.
 */
const WINDOWS_RESERVED_STEMS = new Set([
    'con', 'prn', 'aux', 'nul',
    'com0', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
    'lpt0', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
]);

/**
 * Characters that must never survive into a stored string: the C0 and C1
 * control ranges, DEL, the zero-width and bidirectional-override formatting
 * characters, and the BOM. A `credit` line carrying `U+202E` renders the rest
 * of a sentence right-to-left wherever it is shown.
 *
 * Written with `\u` escapes, **never as the literal characters**. Spelling the
 * class out in raw bytes put NUL and C1 bytes in this file, so git classified
 * the project's one security validator as **binary** — every diff of it read
 * `Bin 0 -> 52314 bytes`, i.e. unreviewable — and any editor or tool that
 * normalises text could have dropped a byte out of the middle of the class and
 * silently stopped filtering it. A test asserts this file is pure ASCII, so it
 * cannot come back.
 *
 *   \u0000-\u001F  C0 controls (NUL .. US)
 *   \u007F-\u009F  DEL and the C1 controls
 *   \u200B-\u200F  zero-width space / non-joiner / joiner, LRM, RLM
 *   \u202A-\u202E  the LRE/RLE/PDF/LRO/RLO bidi overrides
 *   \u2066-\u2069  the LRI/RLI/FSI/PDI bidi isolates
 *   \uFEFF         BOM / zero-width no-break space
 */
const UNSAFE_TEXT = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/* ────────────────────────────────────────────────────────────────────────────
 * Small helpers
 * ──────────────────────────────────────────────────────────────────────────── */

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

/** A plain object, not an array and not null. */
function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A lower-case hex SHA-256 digest. Upper case is refused rather than folded:
 * the generator writes lower case, and accepting both means two spellings of
 * one hash in the index. */
function isSha256(value) {
    return typeof value === 'string' && SHA256_HEX.test(value);
}

/** The extension of a file name, lower-cased, including the dot. */
function extensionOf(name) {
    const match = /\.[^.]+$/.exec(String(name || ''));
    return match ? match[0].toLowerCase() : '';
}

/* ────────────────────────────────────────────────────────────────────────────
 * Names, keys and versions
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Is this a file name a pack may contain?
 *
 * Refused: anything with a separator (`/`, `\`), `..` anywhere, a drive letter
 * or any other colon, a leading dot, a control character, an extension that is
 * not `.png`/`.json`, and anything over 64 characters. The test suite feeds it
 * the classic traversal spellings.
 *
 * @param {*} name
 * @returns {boolean}
 */
function isValidFileName(name) {
    if (typeof name !== 'string' || !name) return false;
    if (name.length > 64) return false;
    // Checked explicitly as well as by the pattern: these are the ones whose
    // absence is the actual security property, and a regex is easy to widen by
    // accident while reading it as "just characters".
    if (name.includes('/') || name.includes('\\') || name.includes(':')) return false;
    if (name.includes('..')) return false;
    if (!FILE_NAME.test(name)) return false;
    if (!ALLOWED_EXTENSIONS.includes(extensionOf(name))) return false;
    // The one deny-list in this file — see WINDOWS_RESERVED_STEMS.
    const stem = name.slice(0, name.length - extensionOf(name).length).trim().toLowerCase();
    if (WINDOWS_RESERVED_STEMS.has(stem)) return false;
    return true;
}

/**
 * A stored free-text field with the characters that cannot be displayed safely
 * taken out. Only `credit` uses it: `name` and `creator` are derived from the
 * key and so are already inside the key charset.
 *
 * Stripped rather than refused: a stray zero-width space in a credit line is a
 * copy-paste accident, and throwing the whole map away over it would be the
 * wrong trade. Length is bounded after stripping.
 *
 * @param {*} value
 * @param {number} max
 * @returns {?string} null when there is nothing left
 */
function sanitizeText(value, max) {
    if (typeof value !== 'string') return null;
    const cleaned = value.replace(UNSAFE_TEXT, '').trim().slice(0, max || 200);
    return cleaned || null;
}

/**
 * Is this a map key a pack may claim? `Creator/Map Name`, exactly one slash.
 * @param {*} key
 * @returns {boolean}
 */
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

/**
 * The directory a pack is installed into, derived from its key.
 *
 * Derived, never taken from the pack: the pack supplies a key, we decide where
 * it lands. Lower-cased and reduced to `[a-z0-9-]` so it is a legal name on
 * every file system and case-insensitively unique, with the key's SHA-free
 * shape kept readable (`deftyconchgaming-east-haddonfield`). `isValidPackKey`
 * has already refused anything that could collapse to an empty string.
 *
 * @param {string} key
 * @returns {?string} null when the key is not one a pack may claim
 */
function packDirName(key) {
    if (!isValidPackKey(key)) return null;
    const slug = key
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return slug || null;
}

/**
 * Compare two dotted numeric versions (`"0.7.0"`, `"1.2"`).
 *
 * Only the leading numeric components are compared; a suffix such as
 * `-beta.1` is ignored rather than making the whole comparison fail, because
 * the only question ever asked of it is "is the app at least this version",
 * and a pre-release of X.Y.Z is treated as X.Y.Z. A string that holds no
 * numbers at all compares as 0.
 *
 * @returns {number} <0, 0 or >0
 */
function compareVersions(a, b) {
    // The *leading* numeric run only: `1.0.0-beta.1` is `[1, 0, 0]`, not
    // `[1, 0, 0, 1]`. Filtering the non-numeric parts out instead would make a
    // pre-release compare as *newer* than its own release.
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

/**
 * Is this app new enough for the pack?
 *
 * A missing/blank `minAppVersion` means "any version", which is the common
 * case — a pack is data. A pack that needs a *newer* app than this one is
 * skipped silently rather than installed and half-understood: `markers.json`
 * is exactly the kind of field a later version teaches the app to render.
 *
 * @param {string} appVersion
 * @param {*} minAppVersion
 * @returns {boolean}
 */
function appSatisfies(appVersion, minAppVersion) {
    if (minAppVersion === undefined || minAppVersion === null || minAppVersion === '') return true;
    if (typeof minAppVersion !== 'string') return false;
    if (!/^\d+(\.\d+)*/.test(minAppVersion)) return false;
    return compareVersions(appVersion, minAppVersion) >= 0;
}

/* ────────────────────────────────────────────────────────────────────────────
 * URL derivation
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Is this a URL the app is allowed to request?
 *
 * https only, one host, one path prefix, no credentials, no query. Used both
 * for the URLs derived below and, again, for every redirect `Location` the
 * fetcher is handed — a redirect is just another URL somebody else chose.
 *
 * @param {string} url
 * @returns {boolean}
 */
function isAllowedUrl(url) {
    if (typeof url !== 'string' || !url) return false;
    // On the raw string as well as on the parsed path. `new URL` *normalises*
    // `..` away, and a normalised path that still starts with the prefix would
    // otherwise be requested — harmless in itself (it cannot leave the prefix;
    // one that climbs out fails the prefix test) but it means a socket opens
    // for a URL nobody intended. Refuse it before that.
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

/**
 * The URL of one file of a pack: the index's `base` plus a validated file name.
 *
 * This is the only way a file URL is ever produced. The pack never supplies a
 * URL — it supplies a *name*, which has to pass `isValidFileName`, and a base,
 * which is either a relative directory (resolved against the index's own
 * directory, so it cannot leave the host by construction) or an absolute URL
 * that has to pass `isAllowedUrl` on its own.
 *
 * @param {string} indexUrl the URL the index was fetched from
 * @param {*} base the pack's `base` field
 * @param {*} name the file name
 * @returns {?string} null when either half is unacceptable
 */
function packFileUrl(indexUrl, base, name) {
    if (!isAllowedUrl(indexUrl)) return null;
    if (!isValidFileName(name)) return null;
    if (typeof base !== 'string' || !base) return null;
    if (base.includes('..') || base.includes('\\')) return null;

    let baseUrl;
    if (/^https?:\/\//i.test(base)) {
        // An absolute base is allowed but wins nothing: it still has to be the
        // one host under the one prefix.
        if (!isAllowedUrl(base)) return null;
        baseUrl = base.endsWith('/') ? base : base + '/';
    } else {
        // A relative base is one or more plain path segments under the index's
        // own directory. Each segment is validated like a file name minus the
        // extension rule, so `%2e%2e`, a leading `/` and a drive letter are all
        // out before `new URL` ever sees them.
        const segments = base.split('/').filter(part => part !== '');
        if (!segments.length || base.startsWith('/')) return null;
        for (const segment of segments) {
            if (segment.length > 64) return null;
            if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment)) return null;
        }
        const dir = indexUrl.slice(0, indexUrl.lastIndexOf('/') + 1);
        baseUrl = dir + segments.join('/') + '/';
    }

    // A map image keeps the map's own name, so the one character that needs
    // encoding is the space. Encoded here rather than left to whatever the
    // HTTP client does with it, so the string that is checked is the string
    // that is sent. `isValidFileName` has already refused everything else that
    // would need escaping.
    const url = baseUrl + encodeURIComponent(name);
    // Re-validated rather than trusted: this is the string that goes to the
    // network, so it is the string that has to pass the allow-list.
    return isAllowedUrl(url) ? url : null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The index
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * One file entry, as both the index and the manifest spell it.
 * @returns {?{name: string, bytes: number, sha256: string}}
 */
function normalizeFileEntry(raw, limit) {
    if (!isPlainObject(raw)) return null;
    if (!isValidFileName(raw.name)) return null;
    if (!isPositiveInt(raw.bytes)) return null;
    if (limit && raw.bytes > limit) return null;
    if (!isSha256(raw.sha256)) return null;
    return {name: raw.name, bytes: raw.bytes, sha256: raw.sha256};
}

/** The cap that applies to a file, by extension. */
function limitForFile(name) {
    if (extensionOf(name) === '.png') return LIMITS.image;
    if (name === MARKERS_NAME) return LIMITS.markers;
    if (name === MANIFEST_NAME) return LIMITS.manifest;
    return LIMITS.templates;
}

/**
 * Validate a parsed `packs/index.json`.
 *
 * Returns the packs it accepted *and* the reasons it dropped the rest, because
 * "the new map did not arrive" has to be answerable from `app.log` without a
 * debugger. A malformed entry drops that entry; a malformed document drops
 * everything.
 *
 * @param {*} json the result of `JSON.parse`
 * @returns {{ok: boolean, error: ?string, packs: Array, rejected: Array}}
 */
function validateIndex(json) {
    const rejected = [];
    if (!isPlainObject(json)) return {ok: false, error: 'not-an-object', packs: [], rejected};
    if (json.formatVersion !== PACK_FORMAT) {
        // A newer index format is not an error the user can do anything about,
        // but it must not be guessed at either.
        return {ok: false, error: `format-version:${json.formatVersion}`, packs: [], rejected};
    }
    if (!Array.isArray(json.packs)) return {ok: false, error: 'packs-not-an-array', packs: [], rejected};
    if (json.packs.length > LIMITS.packs) return {ok: false, error: 'too-many-packs', packs: [], rejected};

    const packs = [];
    const seen = new Set();
    /**
     * Install directories already claimed.
     *
     * `packDirName` folds every non-alphanumeric character to `-`, so
     * `a/b c`, `a/b-c`, `a/b.c`, `a/b'c` and `a-b/c` are five different keys
     * that all install into `a-b-c`. Left alone they reinstall over each other
     * on **every** check forever: each one sees the other's manifest, decides
     * its own key is not installed, downloads, commits, and makes the other map
     * vanish — with a toast and a gallery refresh each time. The second such
     * entry is refused, and `MapPackStore.commit` refuses again at the point of
     * the swap, because an index is not the only way a directory gets there.
     */
    const dirs = new Set();
    for (const raw of json.packs) {
        const reject = (reason) => rejected.push({
            key: isPlainObject(raw) && typeof raw.key === 'string' ? raw.key.slice(0, 80) : '',
            reason
        });
        if (!isPlainObject(raw)) { reject('not-an-object'); continue; }
        if (!isValidPackKey(raw.key)) { reject('bad-key'); continue; }
        // Duplicate keys are a broken index, not a precedence question: which
        // of the two entries is meant is unknowable, so both are refused.
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
        // The manifest is the pack's own description of itself and is fetched
        // by name; listing it among the files it describes would be circular.
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

/* ────────────────────────────────────────────────────────────────────────────
 * The manifest
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Validate a parsed `pack.json` against the index entry it came from.
 *
 * The manifest is not a second opinion — where the two disagree the pack is
 * refused. It exists so an *installed* pack is self-describing (the app reads
 * the catalogue from disk on every start, long after the index is gone) and so
 * that a file copied into the packs folder by hand is still checked.
 *
 * @param {*} json parsed `pack.json`
 * @param {{key: string, version: number, files: Array}} [entry] the index entry
 * @param {{appVersion?: string}} [opts]
 * @returns {{ok: boolean, error: ?string, manifest: ?object}}
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
    /*
     * `name` and `creator` are **derived from the key**, never taken from the
     * manifest. They may appear — the generator writes them and they make the
     * file readable — but only spelled exactly as the key spells them.
     *
     * They were free text in the first draft, and that was wrong four ways at
     * once. A pack `aaa/Foo` calling itself "East Haddonfield" sorts ahead of
     * the real one and hijacks `show-map=east haddonfield` and every bare-name
     * lookup. `creator: "Custom"` lands in the reserved group with
     * `custom: false`, so it is offered as a bundled map that is not in
     * `maps/`. `creator: "constructor"` or `"__proto__"` reaches
     * `byCreator[creator] || []` in the renderer's map picker and inherits a
     * function from `Object.prototype`, breaking the picker for *every* map
     * (fixed there too, with a `Map`, since a `maps/constructor/` folder would
     * do the same). And free text is a rendering surface: nothing interpolates
     * it raw today, but 58 characters is enough for an `onerror=` payload, and
     * one future call site that forgets `escapeHtml` would be RCE with
     * `nodeIntegration: true`.
     *
     * The key is already the single source for both halves — that is how
     * `buildCatalog` derives them for a bundled map from its path — so this
     * removes a duplicate rather than a feature. Renaming a map means
     * publishing it under a new key, which is the same thing renaming the
     * folder means for a bundled one.
     */
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
            // From the key, always — see the comment above.
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

/* ────────────────────────────────────────────────────────────────────────────
 * Templates and markers
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Validate a pack's `templates.json`.
 *
 * The shape is exactly what `src/core/map-detector/templates.json` holds for
 * one map, and the lengths are exactly what the matcher indexes into: every
 * variant is `size * size` finite numbers. The matcher reads a template with
 * `Float32Array.from`, which turns a `null`, a string or a missing element
 * into `NaN` — and one `NaN` poisons the whole NCC, so every map would then
 * score `NaN` and the detector would silently stop working. Hence "finite
 * numbers only", checked element by element.
 *
 * A pack's file names one key only: its own. A file that carries templates for
 * a *different* map would let one pack quietly replace another.
 *
 * @param {*} json parsed `templates.json`
 * @param {{key: string, size: number}} expect
 * @returns {{ok: boolean, error: ?string, variants: number}}
 */
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
    // Four views of one map panel is already more than the bundled maps have
    // (two). The cap exists so a file cannot make the detector's per-tick cost
    // unbounded: every variant is scored on every frame that passes the Tab
    // gate.
    if (variants.length > 8) return fail(`too-many-variants:${variants.length}`);
    const expected = size * size;
    for (const variant of variants) {
        if (!Array.isArray(variant)) return fail('variant-not-an-array');
        if (variant.length !== expected) return fail(`variant-length:${variant.length}`);
        for (let i = 0; i < variant.length; i++) {
            const value = variant[i];
            if (!isFiniteNumber(value)) return fail('variant-not-finite');
            // The matcher works on 0..1 luminance. A value outside it is not
            // fatal to the arithmetic, but it is not something the generator
            // can produce, so it is a corrupt file.
            if (value < 0 || value > 1) return fail('variant-out-of-range');
        }
    }
    return {ok: true, error: null, variants: variants.length};
}

/** A layer name inside a markers document. */
const MARKER_LAYER_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$/;

/**
 * Validate one map's markers document — a pack's optional `markers.json`, and
 * (since 0.7) every entry of the bundled `src/core/map-markers/markers.json`,
 * so a bundled map and a pack map are held to exactly the same shape.
 *
 * `{layers: {<name>: [{x, y}, …]}, baked?: [<name>, …], tab?: {sx, sy, tx, ty}}`
 *
 * - `layers` — points as fractions (0..1) of the map **image**.
 * - `baked`  — layers the map image already draws itself. On the four bundled
 *   maps the author drew the cellar / gate / car rings into the PNG, so
 *   drawing them over the corner minimap would double them; the in-game Tab
 *   map has nothing baked, so every layer is drawn there. A pack built from a
 *   clean image simply omits `baked` and gets all four in both places. Optional
 *   and defaulting to "nothing is baked", which is why adding it is backwards
 *   compatible: a `markers.json` written before it existed still validates and
 *   still means the same thing.
 * - `tab`    — the affine map from an image fraction onto the in-game Tab map
 *   panel's interior square: `u = sx*x + tx`, `v = sy*y + ty`. Optional; a map
 *   without it simply cannot be drawn in Tab mode.
 *
 * Everything a *pack* carries is untrusted, so this stays an allow-list and
 * every number is checked for finiteness — a `NaN` coordinate would become an
 * SVG attribute the renderer silently drops, i.e. a marker that is missing with
 * no way to tell why.
 *
 * @param {*} json parsed markers document
 * @returns {{ok: boolean, error: ?string, layers: number, points: number, baked: number}}
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
            // A `baked` entry naming a layer that is not there is a typo, and a
            // typo here is invisible at runtime (the layer simply draws), so it
            // is refused rather than ignored.
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

/* ────────────────────────────────────────────────────────────────────────────
 * Precedence and scheduling
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Which packs from the index are worth downloading?
 *
 * Three reasons to skip, and each one is a normal outcome rather than an error:
 *   - `up-to-date`   the installed version is the same;
 *   - `downgrade`    the index offers an *older* version than what is
 *                    installed. Refused, not installed: the index is a file in
 *                    a git repository, and a botched revert must not roll every
 *                    user's map back. The user's escape hatch is the next
 *                    genuine version bump.
 *   - `needs-app`    the pack wants a newer app.
 *
 * @param {Array} indexPacks from `validateIndex`
 * @param {Array<{key: string, version: number}>} installed
 * @param {string} appVersion
 * @returns {{install: Array, skipped: Array<{key, reason, version}>}}
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
 * Merge installed packs into the catalogue built from `maps/` + `custom/`.
 *
 * Precedence, and it is the whole point of the feature: **a pack wins over a
 * bundled map with the same key**. A bundled map has no version — it is
 * whatever the installed app ships — so any pack claiming its key is newer by
 * construction, which is what lets a pack fix a bundled map's image, templates
 * or markers without a 93 MB release. Custom maps are untouched: their keys
 * live under the reserved `Custom` creator, which `isValidPackKey` refuses, so
 * the two sets cannot collide.
 *
 * The returned entries are the same shape the rest of the app already
 * consumes, plus `pack` (the install directory, so the fs half can find the
 * image) and `packVersion`. Nothing downstream has to special-case them:
 * that is what makes the gallery, next/prev, the hotkey picker, the first-run
 * defaults and `show-map=` see a pack map exactly like a bundled one.
 *
 * @param {Array} catalog entries from `buildCatalog`/`mergeCustomMaps`
 * @param {Array<{key, name, creator, version, dir, image, markers}>} packs
 * @param {(entries: Array) => Array} sort the catalogue's own sort, injected so
 *   this module stays import-free and there is still exactly one ordering.
 * @returns {Array}
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
            // Same key: the pack replaces the bundled entry in place. `creator`
            // and `name` still come from the *key* (`validateManifest` refuses a
            // manifest that spells them differently), so a pack cannot rename a
            // map into another one's name — it publishes a new key instead.
            out[at] = entry;
        }
    }
    return typeof sort === 'function' ? sort(out) : out;
}

/**
 * Template sources for the detector: the bundled file plus every installed
 * pack, with a pack winning on a shared key.
 *
 * Returns the plain `key → variants` object the detector already builds its
 * `Float32Array`s from, so the merge costs one object walk **at load time** and
 * nothing at all per tick.
 *
 * Two things it is careful about:
 *
 * - **Key comparison is case-insensitive, exactly like `mergeMapPacks`.** It
 *   was exact here and folded there, so a pack published as
 *   `deftyconchgaming/east haddonfield` replaced the bundled map in the
 *   *gallery* while the bundled map's *templates* stayed — i.e. the one thing
 *   the pack existed to fix (a map auto-detect keeps missing) was the one thing
 *   it could not fix. The pack's own spelling of the key wins, so there is
 *   never more than one entry for one map.
 * - **A global variant budget** (`LIMITS.variants`). Every variant of every key
 *   is scored on every frame that passes the Tab gate, so an index listing its
 *   full 200 packs would put seconds of work in the hot loop. Bundled maps are
 *   never dropped — they are what the app shipped with; packs past the budget
 *   are, and they are named in `dropped` so the caller can log it.
 *
 * @param {Object} bundled `templates` from the committed templates.json
 * @param {Array<{key: string, templates: Object}>} packs
 * @param {{maxVariants?: number}} [opts]
 * @returns {{templates: Object, replaced: Array<string>, dropped: Array<string>,
 *            variants: number}}
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
            // Delete before setting: the pack's own spelling wins, and leaving
            // the old one would mean two candidates for one map.
            delete templates[existingKey];
        }
        templates[pack.key] = variants;
        byLower.set(lower, pack.key);
        total = total - freed + variants.length;
    }
    return {templates, replaced, dropped, variants: total};
}

/**
 * Is it time to look for new packs?
 *
 * With the setting off the answer is always no and **no request is made** —
 * that is the promise in the README, so it is a rule here rather than a branch
 * at the call site. `force` is the "Check for new maps" button, which ignores
 * the interval but not the setting: a user who turned the feature off did not
 * ask for one more request.
 *
 * A `lastCheckAt` in the future (a clock that was wrong, or moved back) counts
 * as "now", so a bad clock cannot lock the check out for a day.
 *
 * A check that **failed** is retried after `RETRY_INTERVAL_MS` instead: the
 * laptop that was launched on a train fails in a second, writes `lastCheckAt`
 * anyway, and would otherwise get nothing until tomorrow however long it is
 * online afterwards.
 *
 * @param {{enabled: boolean, lastCheckAt: ?number, now: number,
 *          force?: boolean, lastFailed?: boolean, intervalMs?: number,
 *          retryMs?: number}} state
 * @returns {{check: boolean, reason: string}}
 */
function shouldCheckPacks(state) {
    const {enabled, lastCheckAt, now, force, lastFailed} = state || {};
    const full = isPositiveInt(state && state.intervalMs) ? state.intervalMs : CHECK_INTERVAL_MS;
    const retry = isPositiveInt(state && state.retryMs) ? state.retryMs : RETRY_INTERVAL_MS;
    // Never longer than the ordinary interval, whatever the two are set to.
    const interval = lastFailed ? Math.min(retry, full) : full;
    if (enabled === false) return {check: false, reason: 'disabled'};
    if (force) return {check: true, reason: 'forced'};
    if (!isFiniteNumber(now)) return {check: false, reason: 'no-clock'};
    if (!isFiniteNumber(lastCheckAt) || lastCheckAt <= 0) return {check: true, reason: 'never'};
    if (lastCheckAt > now) return {check: true, reason: 'clock-moved'};
    if (now - lastCheckAt >= interval) return {check: true, reason: lastFailed ? 'retry' : 'due'};
    return {check: false, reason: 'too-soon'};
}

/* ────────────────────────────────────────────────────────────────────────────
 * Image sanity
 * ──────────────────────────────────────────────────────────────────────────── */

/** The eight bytes every PNG starts with. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Dimensions a map overlay image may have. The bundled four are ~600x600. */
const MIN_IMAGE_SIDE = 64;
const MAX_IMAGE_SIDE = 8192;

/**
 * Is this buffer a PNG? Checked on the bytes rather than on the file name: the
 * name is something the pack chose.
 * @param {{length: number, [index: number]: number}} bytes
 */
function hasPngSignature(bytes) {
    if (!bytes || bytes.length < PNG_SIGNATURE.length) return false;
    for (let i = 0; i < PNG_SIGNATURE.length; i++) {
        if (bytes[i] !== PNG_SIGNATURE[i]) return false;
    }
    return true;
}

/**
 * Does this buffer end in an `IEND` chunk?
 *
 * The last 12 bytes of every PNG are a zero length, the literal `IEND` and its
 * CRC. A truncated download that happens to have the right byte count (a
 * mirror serving a padded error page, a half-written file whose size was
 * guessed) still fails this.
 *
 * @param {Buffer} bytes
 */
function hasPngEnd(bytes) {
    if (!bytes || bytes.length < 20) return false;
    // `latin1` so this works on a plain Buffer with no assumptions about text.
    return bytes.slice(bytes.length - 8, bytes.length - 4).toString('latin1') === 'IEND';
}

/**
 * Could a PNG of these dimensions really be this small?
 *
 * A header-only PNG — the 8-byte signature plus a 25-byte IHDR, 33 bytes in
 * total — passes both `hasPngSignature` and `isSaneImageSize` while declaring
 * 8192x8192, because `image-size` reads the header and stops. Installing it
 * costs nothing and gains nothing: the map is then permanently blank, and
 * because the pack is "installed" the next check says up-to-date.
 *
 * The bound is deliberately far below anything a real encoder produces. One
 * *fully uniform* image deflates to roughly a byte per thousand pixels, so a
 * quarter of a bit per pixel plus 67 bytes of chunk overhead cannot reject a
 * genuine file: the four bundled maps are ~600x600 and 221–313 **KB** against a
 * 155-byte floor. It exists to catch truncation and nonsense, not to judge
 * compression.
 *
 * @param {Buffer} bytes
 * @param {{width: number, height: number}} size
 */
function isPlausiblePngBytes(bytes, size) {
    if (!bytes || !isPlainObject(size)) return false;
    if (!hasPngEnd(bytes)) return false;
    const floor = 67 + Math.floor((size.width * size.height) / 4096);
    return bytes.length >= floor;
}

/**
 * Are these dimensions a map image could plausibly have?
 * @param {*} size the `{width, height, type}` an image decoder returned
 */
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
