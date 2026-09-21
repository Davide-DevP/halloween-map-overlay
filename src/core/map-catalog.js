'use strict';

/**
 * PURE map catalogue (no electron, no fs): the caller passes a listing of
 * relative paths. A shipped `maps/<Creator>/<Map Name>.png` has the key
 * `<Creator>/<Map Name>`; user imports are flat files in userData `custom/`
 * merged in under the reserved creator `Custom`. `docs/agents/architecture.md`.
 */

const CUSTOM_CREATOR = 'Custom';
const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;

function stripExtension(name) {
    return String(name || '').replace(/\.[^.]+$/, '');
}

function toPosix(p) {
    return String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

/** Accent/punctuation/case insensitive folding. The project's **single**
 * name normaliser — do not re-implement it elsewhere. */
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

/** Shipped maps first (creator, then name), custom last. `nextMap`/`prevMap`
 * cycle in exactly this order. */
function sortCatalog(entries) {
    return entries.slice().sort((a, b) => {
        if (a.custom !== b.custom) return a.custom ? 1 : -1;
        const byCreator = a.creator.localeCompare(b.creator, 'en');
        if (byCreator !== 0) return byCreator;
        return a.name.localeCompare(b.name, 'en');
    });
}

/** Build the catalogue from a maps-root listing of relative paths. */
function buildCatalog(listing) {
    const out = [];
    const seen = new Set();
    for (const raw of listing || []) {
        const parts = toPosix(raw).split('/').filter(Boolean);
        // A shipped map needs <Creator>/<Map>: a loose file in the maps root has
        // no creator, so it is skipped rather than silently mis-filed.
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

/** Merge a userData `custom/` listing of bare file names into a catalogue under
 * the `Custom` creator. Returns a new array; the input is not mutated. */
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
 * Resolve a key, a bare map name or a custom-map file name — any case, with or
 * without extension — to a catalogue entry: exact match on any candidate form,
 * then normalised substring either way round, then closest by Levenshtein
 * (bounded), **for a bare name only**.
 * A full `Creator/Name` query must keep stopping after the substring stage: the
 * fuzzy bound is a fraction of the string's length and every key in a creator's
 * folder shares that whole prefix, so `<creator>/Smiths Grove` lands within
 * 40 % of `<creator>/East Haddonfield` and a `hotkeys.json` entry for a map
 * that is gone would silently put a *different* map on the overlay. The
 * substring stage still covers a renamed creator folder (tested).
 */
function findClosestMapMatch(key, catalog) {
    if (!key || !Array.isArray(catalog) || catalog.length === 0) return null;
    const raw = toPosix(key);
    const query = foldName(stripExtension(raw));
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

    // A qualified key gets no fuzzy stage — see above.
    if (raw.includes('/')) return null;

    let best = null;
    let bestDistance = Infinity;
    for (const entry of catalog) {
        for (const form of candidateForms(entry)) {
            const folded = foldName(form);
            if (!folded) continue;
            const distance = levenshtein(query, folded);
            // Bounded, so an unrelated string does not resolve to a random map.
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
    // Unknown/empty key: forward starts at the first map, back at the last.
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
    // Exported for `mergeMapPacks`, which is import-free and takes the ordering
    // as an argument: a pack must sort exactly like a bundled map, and there is
    // still one implementation of that order.
    sortCatalog,
    mergeCustomMaps,
    findClosestMapMatch,
    nextMap,
    prevMap,
    listCreators
};
