'use strict';

/**
 * Pure map catalogue. No electron, no fs — the caller passes a plain listing
 * of relative paths, so both processes and the unit tests can use it.
 *
 * Shipped maps live at `maps/<Creator>/<Map Name>.png`, so a listing entry
 * looks like `deftyconchgaming/East Haddonfield.png` and its catalogue key is
 * `deftyconchgaming/East Haddonfield`.
 *
 * User-imported maps are flat files in userData `custom/` and are merged in
 * under the reserved creator `Custom` (`Custom/My Map`).
 */

const CUSTOM_CREATOR = 'Custom';
const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;

function stripExtension(name) {
    return String(name || '').replace(/\.[^.]+$/, '');
}

function toPosix(p) {
    return String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

/**
 * Accent/punctuation/case insensitive name folding. Single source of name
 * normalisation for this project — do not re-implement it elsewhere.
 */
function foldName(s) {
    return String(s || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/['’`´]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    const dp = Array.from({length: m + 1}, (_, i) => {
        const row = new Array(n + 1);
        row[0] = i;
        return row;
    });
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }
    return dp[m][n];
}

function makeEntry(creator, name, file, custom) {
    return {
        key: `${creator}/${name}`,
        creator,
        name,
        file,
        custom: !!custom
    };
}

/**
 * Deterministic ordering: shipped maps first (creator, then map name), custom
 * maps last. `nextMap`/`prevMap` cycle in exactly this order.
 */
function sortCatalog(entries) {
    return entries.slice().sort((a, b) => {
        if (a.custom !== b.custom) return a.custom ? 1 : -1;
        const byCreator = a.creator.localeCompare(b.creator, 'en');
        if (byCreator !== 0) return byCreator;
        return a.name.localeCompare(b.name, 'en');
    });
}

/**
 * Build the catalogue from a maps-root listing.
 * @param {string[]} listing relative paths, e.g. ["deftyconchgaming/East Haddonfield.png"]
 * @returns {Array<{key: string, creator: string, name: string, file: string, custom: boolean}>}
 */
function buildCatalog(listing) {
    const out = [];
    const seen = new Set();
    for (const raw of listing || []) {
        const parts = toPosix(raw).split('/').filter(Boolean);
        // A shipped map needs at least <Creator>/<Map>; loose files in the maps
        // root have no creator and are skipped rather than silently mis-filed.
        if (parts.length < 2) continue;
        const fileName = parts[parts.length - 1];
        if (!IMAGE_EXTENSIONS.test(fileName)) continue;
        const creator = parts[parts.length - 2];
        const name = stripExtension(fileName);
        const entry = makeEntry(creator, name, parts.join('/'), false);
        if (seen.has(entry.key)) continue;
        seen.add(entry.key);
        out.push(entry);
    }
    return sortCatalog(out);
}

/**
 * Merge flat user-imported files (userData `custom/`) into a catalogue under
 * the `Custom` creator. Returns a new array; the input is not mutated.
 * @param {Array} catalog
 * @param {string[]} customListing file names, e.g. ["My Map.png"]
 */
function mergeCustomMaps(catalog, customListing) {
    const base = (catalog || []).filter(e => !e.custom);
    const seen = new Set(base.map(e => e.key));
    const customs = [];
    for (const raw of customListing || []) {
        const fileName = toPosix(raw).split('/').filter(Boolean).pop();
        if (!fileName || !IMAGE_EXTENSIONS.test(fileName)) continue;
        const entry = makeEntry(CUSTOM_CREATOR, stripExtension(fileName), fileName, true);
        if (seen.has(entry.key)) continue;
        seen.add(entry.key);
        customs.push(entry);
    }
    return sortCatalog(base.concat(customs));
}

/** The strings a query may legitimately be written as for a given entry. */
function candidateForms(entry) {
    return [entry.key, entry.name, stripExtension(entry.file)];
}

/**
 * Resolve a user/CLI/hotkey-supplied key to a catalogue entry.
 *
 * Accepts a full catalogue key (`deftyconchgaming/East Haddonfield`), a bare map name
 * (`east haddonfield`), or a custom-map file name (`My Map.png`), with or
 * without extension and in any case. Tried in order:
 *   1. exact match on any candidate form
 *   2. normalized substring match either way round
 *   3. closest candidate by Levenshtein distance (bounded, so garbage misses)
 *
 * @returns {object|null} the catalogue entry, or null when nothing is close
 */
function findClosestMapMatch(key, catalog) {
    if (!key || !Array.isArray(catalog) || catalog.length === 0) return null;
    const query = foldName(stripExtension(toPosix(key)));
    if (!query) return null;

    for (const entry of catalog) {
        if (candidateForms(entry).some(form => foldName(form) === query)) return entry;
    }

    for (const entry of catalog) {
        if (candidateForms(entry).some(form => {
            const folded = foldName(form);
            return folded.includes(query) || query.includes(folded);
        })) return entry;
    }

    let best = null;
    let bestDistance = Infinity;
    for (const entry of catalog) {
        for (const form of candidateForms(entry)) {
            const folded = foldName(form);
            if (!folded) continue;
            const distance = levenshtein(query, folded);
            // Bounded so an unrelated string does not resolve to a random map
            const limit = Math.max(2, Math.floor(Math.max(query.length, folded.length) * 0.4));
            if (distance > limit) continue;
            if (distance < bestDistance) {
                bestDistance = distance;
                best = entry;
            }
        }
    }
    return best;
}

function indexOfKey(currentKey, catalog) {
    if (!currentKey) return -1;
    const match = findClosestMapMatch(currentKey, catalog);
    if (!match) return -1;
    return catalog.indexOf(match);
}

function step(currentKey, catalog, delta) {
    if (!Array.isArray(catalog) || catalog.length === 0) return null;
    const index = indexOfKey(currentKey, catalog);
    // Unknown/empty current key: stepping forward starts at the first map,
    // stepping back at the last one.
    if (index === -1) return delta > 0 ? catalog[0] : catalog[catalog.length - 1];
    const next = (index + delta + catalog.length) % catalog.length;
    return catalog[next];
}

/** Next entry in catalogue order, wrapping around the end. */
function nextMap(currentKey, catalog) {
    return step(currentKey, catalog, 1);
}

/** Previous entry in catalogue order, wrapping around the start. */
function prevMap(currentKey, catalog) {
    return step(currentKey, catalog, -1);
}

/** Unique creator names in catalogue order (`Custom` last, when present). */
function listCreators(catalog) {
    const out = [];
    for (const entry of catalog || []) {
        if (!out.includes(entry.creator)) out.push(entry.creator);
    }
    return out;
}

module.exports = {
    CUSTOM_CREATOR,
    foldName,
    levenshtein,
    stripExtension,
    buildCatalog,
    mergeCustomMaps,
    findClosestMapMatch,
    nextMap,
    prevMap,
    listCreators
};
