const {test} = require('node:test');
const assert = require('node:assert');

const R = require('../src/shared/marker-rules');
const {validateMarkers} = require('../src/shared/map-pack-rules');
const {DEFAULT_SETTINGS} = require('../src/shared/settings-defaults');
const BUNDLED = require('../src/core/map-markers/markers.json');
const {build} = require('../scripts/build-markers');

/** The four bundled maps, as `core/map-markers.js` hands one over. */
const MAPS = BUNDLED.maps;
const KEYS = Object.keys(MAPS);
const HEIGHTS = 'deftyconchgaming/Haddonfield Heights';

/* ────────────────────────────────────────────────────────────────────────────
 * The layer table
 * ──────────────────────────────────────────────────────────────────────────── */

test('the four layers are the documented ones, with the approved colours', () => {
    assert.deepStrictEqual(R.MARKER_LAYERS.map(l => l.id), ['cellar', 'gate', 'car', 'gas']);
    // The approved variant B palette (dist/marker-variants/variant-B-brackets.png).
    assert.deepStrictEqual(R.MARKER_LAYERS.map(l => l.colour),
        ['#e0605a', '#4fc58a', '#5fb4ea', '#f0cf55']);
    // Gas is the only small, rotated one.
    assert.deepStrictEqual(R.MARKER_LAYERS.map(l => l.small), [false, false, false, true]);
});

test('every layer has a settings key that really ships a default', () => {
    for (const layer of R.MARKER_LAYERS) {
        assert.ok(Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, layer.settingKey), layer.id);
        // On by default: the data ships with the app and costs nothing to draw.
        assert.strictEqual(DEFAULT_SETTINGS[layer.settingKey], true, layer.id);
        assert.match(layer.labelKey, /^markers\.layer\./, layer.id);
    }
    assert.strictEqual(DEFAULT_SETTINGS.markers, true);
    assert.strictEqual(DEFAULT_SETTINGS.markerLegend, true);
    // Tab mode is the one that is off: experimental, and it samples the game
    // window more often while Tab is held.
    assert.strictEqual(DEFAULT_SETTINGS.tabMarkers, false);
});

test('only an explicit false turns a layer off', () => {
    // A settings file written before markers existed has none of these keys,
    // and must behave like the shipped defaults rather than like "all off".
    for (const settings of [{}, null, undefined, {markerLayerGas: undefined}, {markerLayerGas: 1}]) {
        assert.strictEqual(R.isLayerEnabled(settings, 'gas'), true, JSON.stringify(settings));
    }
    assert.strictEqual(R.isLayerEnabled({markerLayerGas: false}, 'gas'), false);
    // An id that is not a layer is never enabled.
    assert.strictEqual(R.isLayerEnabled({}, 'nope'), false);
});

/* ────────────────────────────────────────────────────────────────────────────
 * Baked layers — the "do not draw the rings twice" rule
 * ──────────────────────────────────────────────────────────────────────────── */

test('the bundled maps mark cellar/gate/car as baked, and only those', () => {
    for (const key of KEYS) {
        assert.deepStrictEqual(MAPS[key].baked, ['cellar', 'gate', 'car'], key);
        // …and every baked name really is a layer of that map, which is what
        // `validateMarkers` refuses a typo on.
        for (const name of MAPS[key].baked) {
            assert.ok(Array.isArray(MAPS[key].layers[name]), `${key}: ${name}`);
        }
    }
});

test('the corner minimap draws only the gas cans on a bundled map', () => {
    // The map image's author drew the other three rings into the PNG, so
    // drawing them again would double every one of them — the single most
    // visible way this feature could look broken.
    const layers = R.drawableLayers({markers: MAPS[HEIGHTS], surface: R.SURFACE_OVERLAY, settings: {}});
    assert.deepStrictEqual(layers.map(l => l.id), ['gas']);
    assert.strictEqual(layers[0].small, true);
    assert.ok(layers[0].points.length > 0);
});

test('the in-game Tab map draws all four: nothing is baked there', () => {
    const layers = R.drawableLayers({markers: MAPS[HEIGHTS], surface: R.SURFACE_TAB, settings: {}});
    assert.deepStrictEqual(layers.map(l => l.id), ['cellar', 'gate', 'car', 'gas']);
});

test('a pack built from a clean image has nothing baked and draws all four', () => {
    // The whole reason `baked` is per-map data rather than a property of the
    // layer: a future pack whose image has no rings on it gets all four
    // everywhere, with no code change.
    const clean = {layers: MAPS[HEIGHTS].layers, tab: MAPS[HEIGHTS].tab};
    const layers = R.drawableLayers({markers: clean, surface: R.SURFACE_OVERLAY, settings: {}});
    assert.deepStrictEqual(layers.map(l => l.id), ['cellar', 'gate', 'car', 'gas']);
});

test('a switched-off layer is dropped, and so is an empty one', () => {
    const clean = {layers: MAPS[HEIGHTS].layers};
    assert.deepStrictEqual(
        R.drawableLayers({markers: clean, surface: R.SURFACE_TAB, settings: {markerLayerCar: false}})
            .map(l => l.id),
        ['cellar', 'gate', 'gas']);
    // An empty layer would show a legend chip promising something the data
    // does not have.
    const empty = {layers: {cellar: [], gas: [{x: 0.5, y: 0.5}]}};
    assert.deepStrictEqual(
        R.drawableLayers({markers: empty, surface: R.SURFACE_TAB, settings: {}}).map(l => l.id),
        ['gas']);
});

test('nothing at all is drawn without data', () => {
    for (const markers of [null, undefined, {}, {layers: null}, 'nope', 42]) {
        assert.deepStrictEqual(R.drawableLayers({markers, surface: R.SURFACE_TAB, settings: {}}), [],
            JSON.stringify(markers));
    }
    assert.deepStrictEqual(R.drawableLayers(null), []);
});

test('a point that is not two finite numbers is dropped, not drawn as NaN', () => {
    // A NaN coordinate becomes an SVG attribute the browser silently ignores,
    // i.e. a marker that is missing with no way to tell why.
    const markers = {
        layers: {
            gas: [
                {x: 0.5, y: 0.5},
                {x: NaN, y: 0.5},
                {x: 0.5},
                {x: '0.5', y: 0.5},
                null
            ]
        }
    };
    const layers = R.drawableLayers({markers, surface: R.SURFACE_TAB, settings: {}});
    assert.strictEqual(layers.length, 1);
    assert.deepStrictEqual(layers[0].points, [{x: 0.5, y: 0.5}]);
});

/* ────────────────────────────────────────────────────────────────────────────
 * The Tab transform
 * ──────────────────────────────────────────────────────────────────────────── */

test('tabPoint applies the affine fit, and refuses an unusable one', () => {
    const tab = {sx: 2, tx: 0.1, sy: 0.5, ty: -0.2};
    assert.deepStrictEqual(R.tabPoint({x: 0.25, y: 1}, tab), {u: 0.6, v: 0.3});
    // Missing or non-finite fields mean "cannot be drawn", never a guess.
    for (const bad of [null, {}, {sx: 1, tx: 0, sy: 1}, {sx: NaN, tx: 0, sy: 1, ty: 0},
        {sx: 1, tx: 0, sy: 1, ty: '0'}]) {
        assert.strictEqual(R.tabPoint({x: 0.5, y: 0.5}, bad), null, JSON.stringify(bad));
    }
    assert.strictEqual(R.tabPoint(null, tab), null);
    assert.strictEqual(R.tabPoint({x: NaN, y: 0}, tab), null);
});

test('every bundled map has a Tab transform, and it is near the identity', () => {
    for (const key of KEYS) {
        const tab = MAPS[key].tab;
        assert.ok(R.hasTabTransform(MAPS[key]), key);
        // The fits were measured by boundary-silhouette registration at IoU
        // 0.96-0.98, so a scale far from 1 or an offset far from 0 would mean
        // the data had been regenerated wrongly.
        assert.ok(Math.abs(tab.sx - 1) < 0.05, `${key}: sx ${tab.sx}`);
        assert.ok(Math.abs(tab.sy - 1) < 0.05, `${key}: sy ${tab.sy}`);
        assert.ok(Math.abs(tab.tx) < 0.05, `${key}: tx ${tab.tx}`);
        assert.ok(Math.abs(tab.ty) < 0.05, `${key}: ty ${tab.ty}`);
    }
    assert.strictEqual(R.hasTabTransform({layers: {}}), false);
    assert.strictEqual(R.hasTabTransform(null), false);
});

test('tabLayers maps every bundled point inside the panel', () => {
    // If a transform pushed points off the panel they would be drawn over the
    // game's *other* UI, so `tabLayers` clips them — and none of the four
    // bundled maps may lose a single point to that clip today.
    for (const key of KEYS) {
        const before = R.drawableLayers({markers: MAPS[key], surface: R.SURFACE_TAB, settings: {}});
        const after = R.tabLayers({markers: MAPS[key], settings: {}});
        assert.strictEqual(after.length, before.length, key);
        for (let i = 0; i < after.length; i++) {
            assert.strictEqual(after[i].points.length, before[i].points.length,
                `${key}: layer ${after[i].id} lost a point to the panel clip`);
            for (const {u, v} of after[i].points) {
                assert.ok(u >= 0 && u <= 1 && v >= 0 && v <= 1, `${key}: ${u},${v}`);
            }
        }
    }
});

test('tabLayers clips a point the transform puts off the panel', () => {
    const markers = {
        layers: {gas: [{x: 0.5, y: 0.5}, {x: 0.99, y: 0.5}]},
        // A deliberately bad fit: x 0.99 maps to u 1.98.
        tab: {sx: 2, tx: 0, sy: 1, ty: 0}
    };
    const layers = R.tabLayers({markers, settings: {}});
    assert.strictEqual(layers.length, 1);
    assert.deepStrictEqual(layers[0].points, [{u: 1, v: 0.5}]);
});

test('no Tab transform means nothing is drawn on the game map', () => {
    // The corner minimap stays the fallback: a wrong overlay on the game's own
    // map would be worse than no overlay.
    assert.deepStrictEqual(R.tabLayers({markers: {layers: MAPS[HEIGHTS].layers}, settings: {}}), []);
    assert.deepStrictEqual(R.tabLayers({markers: null, settings: {}}), []);
    assert.deepStrictEqual(R.tabLayers(null), []);
});

/* ────────────────────────────────────────────────────────────────────────────
 * The legend and the settings shape
 * ──────────────────────────────────────────────────────────────────────────── */

test('the legend lists exactly the layers being drawn', () => {
    const layers = R.drawableLayers({markers: MAPS[HEIGHTS], surface: R.SURFACE_OVERLAY, settings: {}});
    const items = R.legendItems(layers);
    // One chip, for the one layer the app itself draws on a bundled map.
    assert.deepStrictEqual(items, [{
        id: 'gas',
        colour: '#f0cf55',
        labelKey: 'markers.layer.gas'
    }]);
    assert.deepStrictEqual(R.legendItems([]), []);
    assert.deepStrictEqual(R.legendItems(null), []);
});

test('markerState turns the flat settings file into one shape', () => {
    const fresh = R.markerState(DEFAULT_SETTINGS);
    assert.strictEqual(fresh.enabled, true);
    assert.strictEqual(fresh.legend, true);
    assert.strictEqual(fresh.tabMode, false);
    assert.strictEqual(fresh.opacity, DEFAULT_SETTINGS.markerOpacity);
    for (const layer of R.MARKER_LAYERS) assert.strictEqual(fresh.layers[layer.settingKey], true);

    // An empty file reads as the defaults, and `tabMode` needs an explicit
    // `true` — the one setting that is off by default.
    const empty = R.markerState({});
    assert.strictEqual(empty.enabled, true);
    assert.strictEqual(empty.tabMode, false);
    assert.strictEqual(R.markerState({tabMarkers: true}).tabMode, true);
    assert.strictEqual(R.markerState({tabMarkers: 'yes'}).tabMode, false);
    assert.strictEqual(R.markerState({markers: false}).enabled, false);
    assert.strictEqual(R.markerState(null).enabled, true);
});

test('markerState clamps the opacity a hand-edited file could hold', () => {
    assert.strictEqual(R.markerState({markerOpacity: 0}).opacity, 0.1);
    assert.strictEqual(R.markerState({markerOpacity: 5}).opacity, 1);
    assert.strictEqual(R.markerState({markerOpacity: 'nonsense'}).opacity, 0.9);
    assert.strictEqual(R.markerState({markerOpacity: '0.5'}).opacity, 0.5);
});

/* ────────────────────────────────────────────────────────────────────────────
 * The shipped data itself
 * ──────────────────────────────────────────────────────────────────────────── */

test('every bundled markers entry passes the validator packs use', () => {
    // One validator for a bundled map and a pack map alike — that is the whole
    // point of putting the shipped file in the pack format.
    assert.ok(KEYS.length >= 4, `${KEYS.length} maps`);
    for (const key of KEYS) {
        const verdict = validateMarkers(MAPS[key]);
        assert.ok(verdict.ok, `${key}: ${verdict.error}`);
        assert.strictEqual(verdict.layers, 4, key);
        assert.strictEqual(verdict.baked, 3, key);
        assert.ok(verdict.points > 0, key);
    }
    assert.strictEqual(BUNDLED.formatVersion, 1);
    // The gas data is u/deftyconchgaming's and the credit travels with it.
    assert.match(String(BUNDLED.credit), /deftyconchgaming/);
});

test('the shipped file is what the converter produces from maps-src', () => {
    // `--check` in CI form: the committed file must be reproducible from
    // `maps-src/markers.json`, so the positions cannot drift from the data the
    // marker tools actually measured.
    assert.deepStrictEqual(build(), BUNDLED);
});

test('validateMarkers: `baked` is optional and backwards compatible', () => {
    const base = {layers: {gas: [{x: 0.5, y: 0.5}]}};
    // A markers.json written before `baked` existed still validates, and still
    // means the same thing (nothing is baked).
    assert.strictEqual(validateMarkers(base).ok, true);
    assert.strictEqual(validateMarkers(base).baked, 0);
    assert.strictEqual(validateMarkers(Object.assign({baked: null}, base)).ok, true);
    assert.strictEqual(validateMarkers(Object.assign({baked: []}, base)).ok, true);
    assert.strictEqual(validateMarkers(Object.assign({baked: ['gas']}, base)).baked, 1);
});

test('validateMarkers: a bad `baked` is refused rather than ignored', () => {
    const base = {layers: {gas: [{x: 0.5, y: 0.5}]}};
    const bad = (baked) => validateMarkers(Object.assign({baked}, base));
    assert.strictEqual(bad('gas').error, 'baked-not-an-array');
    assert.strictEqual(bad({}).error, 'baked-not-an-array');
    assert.strictEqual(bad([1]).error, 'bad-baked-name');
    assert.strictEqual(bad(['..']).error, 'bad-baked-name');
    // A name that is not a layer of this map is a typo, and a typo here is
    // invisible at runtime — the layer simply draws.
    assert.strictEqual(bad(['cellar']).error, 'baked-unknown-layer');
    assert.strictEqual(bad(['gas', 'gas']).error, 'duplicate-baked');
    assert.strictEqual(bad(new Array(33).fill('gas')).error, 'too-many-baked');
});

test('validateMarkers: the pack spelling of the Tab transform is the runtime one', () => {
    const base = {layers: {gas: [{x: 0.5, y: 0.5}]}};
    // `{sx, tx, sy, ty}` — the authoring file's `{ax, bx, ay, by}` is converted
    // once, by scripts/build-markers.js, and must never reach the runtime.
    assert.strictEqual(validateMarkers(Object.assign({tab: {sx: 1, tx: 0, sy: 1, ty: 0}}, base)).ok, true);
    assert.strictEqual(validateMarkers(Object.assign({tab: {ax: 1, bx: 0, ay: 1, by: 0}}, base)).error, 'tab-sx');
    for (const key of KEYS) {
        assert.deepStrictEqual(Object.keys(MAPS[key].tab).sort(), ['sx', 'sy', 'tx', 'ty'], key);
    }
});
