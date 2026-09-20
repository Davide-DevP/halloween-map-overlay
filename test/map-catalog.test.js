const {test} = require('node:test');
const assert = require('node:assert');
const {
    buildCatalog,
    mergeCustomMaps,
    findClosestMapMatch,
    nextMap,
    prevMap,
    listCreators
} = require('../src/core/map-catalog');

// What `maps/` looks like on disk, as the main process lists it.
const LISTING = [
    'deftyconchgaming/East Haddonfield.png',
    'deftyconchgaming/Haddonfield Heights.png',
    'deftyconchgaming/Haddonfield Town Center.png',
    'deftyconchgaming/Orange Grove Estates.png'
];

const catalog = buildCatalog(LISTING);
const keys = c => c.map(e => e.key);

test('buildCatalog derives key, creator, name and file from the listing', () => {
    assert.deepStrictEqual(catalog[0], {
        key: 'deftyconchgaming/East Haddonfield',
        creator: 'deftyconchgaming',
        name: 'East Haddonfield',
        file: 'deftyconchgaming/East Haddonfield.png',
        custom: false
    });
    assert.strictEqual(catalog.length, 4);
});

test('buildCatalog sorts by creator then name, so cycling order is stable', () => {
    assert.deepStrictEqual(keys(catalog), [
        'deftyconchgaming/East Haddonfield',
        'deftyconchgaming/Haddonfield Heights',
        'deftyconchgaming/Haddonfield Town Center',
        'deftyconchgaming/Orange Grove Estates'
    ]);
    // Same listing in another order produces the same catalogue
    assert.deepStrictEqual(keys(buildCatalog(LISTING.slice().reverse())), keys(catalog));
});

test('buildCatalog accepts Windows separators and skips non-images and loose files', () => {
    const built = buildCatalog([
        'deftyconchgaming\\East Haddonfield.png',
        'deftyconchgaming/notes.txt',
        'loose-file-in-maps-root.png'
    ]);
    assert.deepStrictEqual(keys(built), ['deftyconchgaming/East Haddonfield']);
});

test('buildCatalog keeps several creators apart', () => {
    const built = buildCatalog(['deftyconchgaming/A.png', 'Someone Else/A.png']);
    assert.deepStrictEqual(keys(built), ['deftyconchgaming/A', 'Someone Else/A']);
    assert.deepStrictEqual(listCreators(built), ['deftyconchgaming', 'Someone Else']);
});

test('findClosestMapMatch: exact key, case-insensitive, extension-less', () => {
    assert.strictEqual(findClosestMapMatch('deftyconchgaming/East Haddonfield', catalog).name, 'East Haddonfield');
    assert.strictEqual(findClosestMapMatch('DEFTYCONCHGAMING/east haddonfield', catalog).name, 'East Haddonfield');
    assert.strictEqual(findClosestMapMatch('deftyconchgaming/East Haddonfield.png', catalog).name, 'East Haddonfield');
    assert.strictEqual(findClosestMapMatch('deftyconchgaming\\East Haddonfield.png', catalog).name, 'East Haddonfield');
});

test('a key saved under an older creator folder still resolves', () => {
    // hotkeys.json written before the creator folder was renamed holds
    // `Community/<Map>` keys; the map name still carries the match.
    assert.strictEqual(findClosestMapMatch('Community/East Haddonfield', catalog).key,
        'deftyconchgaming/East Haddonfield');
});

test('findClosestMapMatch: a bare map name resolves without its creator', () => {
    assert.strictEqual(findClosestMapMatch('Orange Grove Estates', catalog).key, 'deftyconchgaming/Orange Grove Estates');
    assert.strictEqual(findClosestMapMatch('orange grove estates', catalog).key, 'deftyconchgaming/Orange Grove Estates');
});

test('findClosestMapMatch: normalized substring before fuzzy', () => {
    // "haddonfield heights" is a substring of the full key
    assert.strictEqual(findClosestMapMatch('Haddonfield Heights', catalog).name, 'Haddonfield Heights');
    // A longer query containing the name still resolves
    assert.strictEqual(findClosestMapMatch('deftyconchgaming/Haddonfield Town Center', catalog).name, 'Haddonfield Town Center');
});

test('findClosestMapMatch: typos fall through to the closest name', () => {
    assert.strictEqual(findClosestMapMatch('Est Haddonfeld', catalog).name, 'East Haddonfield');
    assert.strictEqual(findClosestMapMatch('orang grove estate', catalog).name, 'Orange Grove Estates');
});

test('findClosestMapMatch: a FULL key that matches nothing resolves to nothing', () => {
    /*
     * The fuzzy stage is skipped for a qualified `Creator/Name` query. Its
     * bound is a fraction of the string's own length, and every key in a
     * creator's folder shares that whole creator prefix — so
     * `deftyconchgaming/Smiths Grove` was within 40 % of
     * `deftyconchgaming/East Haddonfield` and resolved to it. A `hotkeys.json`
     * entry for a map that is *gone* (an uninstalled map pack, a deleted
     * custom image) therefore put a **different** map on the overlay: the user
     * pressed their Smiths Grove key and got East Haddonfield with no
     * explanation, which is worse than nothing happening. The renderer now
     * says the map is missing instead.
     */
    for (const gone of [
        'deftyconchgaming/Smiths Grove',
        'deftyconchgaming/Silver Shamrock',
        'deftyconchgaming/Haddonfield Hills',
        'Custom/Deleted Image'
    ]) {
        assert.strictEqual(findClosestMapMatch(gone, catalog), null, gone);
    }
    // A bare name still gets the fuzzy stage — that is where a typed query
    // comes from, and there is no shared prefix to weaken the bound.
    assert.strictEqual(findClosestMapMatch('Est Haddonfeld', catalog).name, 'East Haddonfield');
    // …and the two earlier stages still run for a full key, which is what the
    // renamed-creator case has always relied on (test above).
    assert.strictEqual(findClosestMapMatch('deftyconchgaming/East Haddonfield', catalog).name,
        'East Haddonfield');
});

test('findClosestMapMatch: unrelated input matches nothing', () => {
    assert.strictEqual(findClosestMapMatch('Coal Tower', catalog), null);
    assert.strictEqual(findClosestMapMatch('', catalog), null);
    assert.strictEqual(findClosestMapMatch('East Haddonfield', []), null);
    assert.strictEqual(findClosestMapMatch(null, catalog), null);
});

test('nextMap wraps around the end of the catalogue', () => {
    assert.strictEqual(nextMap('deftyconchgaming/East Haddonfield', catalog).name, 'Haddonfield Heights');
    assert.strictEqual(nextMap('deftyconchgaming/Haddonfield Heights', catalog).name, 'Haddonfield Town Center');
    assert.strictEqual(nextMap('deftyconchgaming/Orange Grove Estates', catalog).name, 'East Haddonfield');
});

test('prevMap wraps around the start of the catalogue', () => {
    assert.strictEqual(prevMap('deftyconchgaming/Haddonfield Heights', catalog).name, 'East Haddonfield');
    assert.strictEqual(prevMap('deftyconchgaming/East Haddonfield', catalog).name, 'Orange Grove Estates');
});

test('next/prev from no current map start at the two ends', () => {
    assert.strictEqual(nextMap('', catalog).name, 'East Haddonfield');
    assert.strictEqual(prevMap('', catalog).name, 'Orange Grove Estates');
    assert.strictEqual(nextMap('Something Unknown Entirely', catalog).name, 'East Haddonfield');
});

test('next/prev on an empty catalogue return null instead of throwing', () => {
    assert.strictEqual(nextMap('deftyconchgaming/East Haddonfield', []), null);
    assert.strictEqual(prevMap('deftyconchgaming/East Haddonfield', []), null);
});

test('next/prev accept a fuzzy current key', () => {
    assert.strictEqual(nextMap('east haddonfield', catalog).name, 'Haddonfield Heights');
});

test('mergeCustomMaps files flat user images under the Custom creator, last', () => {
    const merged = mergeCustomMaps(catalog, ['My Basement.png', 'shed.webp']);
    assert.deepStrictEqual(keys(merged), [
        'deftyconchgaming/East Haddonfield',
        'deftyconchgaming/Haddonfield Heights',
        'deftyconchgaming/Haddonfield Town Center',
        'deftyconchgaming/Orange Grove Estates',
        'Custom/My Basement',
        'Custom/shed'
    ]);
    const custom = merged.find(e => e.key === 'Custom/My Basement');
    assert.deepStrictEqual(custom, {
        key: 'Custom/My Basement',
        creator: 'Custom',
        name: 'My Basement',
        file: 'My Basement.png',
        custom: true
    });
    assert.deepStrictEqual(listCreators(merged), ['deftyconchgaming', 'Custom']);
});

test('mergeCustomMaps replaces the previous custom set and ignores non-images', () => {
    const once = mergeCustomMaps(catalog, ['Old.png', 'readme.md']);
    const twice = mergeCustomMaps(once, ['New.png']);
    assert.deepStrictEqual(keys(twice).filter(k => k.startsWith('Custom/')), ['Custom/New']);
});

test('custom maps resolve by their bare file name and join the cycle', () => {
    const merged = mergeCustomMaps(catalog, ['My Basement.png']);
    assert.strictEqual(findClosestMapMatch('My Basement.png', merged).key, 'Custom/My Basement');
    assert.strictEqual(findClosestMapMatch('Custom/My Basement', merged).file, 'My Basement.png');
    // Cycling past the last shipped map now reaches the custom one
    assert.strictEqual(nextMap('deftyconchgaming/Orange Grove Estates', merged).key, 'Custom/My Basement');
    assert.strictEqual(nextMap('Custom/My Basement', merged).key, 'deftyconchgaming/East Haddonfield');
});
