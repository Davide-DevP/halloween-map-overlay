const {test} = require('node:test');
const assert = require('node:assert');

const G = require('../src/shared/marker-geometry');
const {SIZE_MIN, SIZE_MAX} = require('../src/shared/hotkeys-constants');

/*
 * The sizing curve is the whole reason this module exists: the same marker has
 * to be legible on a 150 px minimap and not cartoonish on an 800 px one, and
 * neither a fixed proportion nor a fixed pixel size manages both. So the tests
 * are about the *shape* of the curve at the two ends of the real slider range
 * (`SIZE_MIN`..`SIZE_MAX` in hotkeys-constants.js, which is what the Settings
 * slider allows) rather than about particular numbers.
 */

test('the reference size reproduces the numbers the mock-up was drawn at', () => {
    const g = G.markerGeometry(G.REFERENCE_EXTENT);
    assert.strictEqual(g.half, G.REFERENCE_HALF);
    assert.strictEqual(g.stroke, G.REFERENCE_STROKE);
    assert.strictEqual(g.rotation, 0);
    // The arms are a fraction of the half-extent, so the L never closes the
    // side: a bracket with `arm === half` is a box, and the point of the
    // reticle look is that the middle of every side stays open.
    assert.ok(g.arm > 0 && g.arm < g.half, `arm ${g.arm} vs half ${g.half}`);
});

test('a marker grows with the map, but far more slowly', () => {
    const small = G.markerGeometry(150);
    const big = G.markerGeometry(800);
    // It really does grow…
    assert.ok(big.half > small.half, `${small.half} → ${big.half}`);
    assert.ok(big.stroke > small.stroke, `${small.stroke} → ${big.stroke}`);
    // …and the map grew 5.33x while the marker grew well under half of that,
    // which is what stops three markers swallowing a street at 800 px.
    assert.ok(big.half / small.half < 2.5, `half grew ${(big.half / small.half).toFixed(2)}x`);
    // As a share of the map it therefore shrinks — the opposite of a fixed
    // proportion, and the reason a fixed proportion was rejected.
    assert.ok((big.half / 800) < (small.half / 150));
});

test('legible at 150 px and not huge at 800 px', () => {
    const small = G.markerGeometry(150);
    // At 150 px a marker is a readable object: at least 2 px of stroke across
    // the pair of edges, and 8 px or more across the whole bracket square.
    assert.ok(small.stroke >= 1, `stroke ${small.stroke} at 150 px`);
    assert.ok(small.half * 2 >= 8, `${small.half * 2} px across at 150 px`);
    // …and it does not cover the map: under a quarter of the width.
    assert.ok(small.half * 2 <= 150 * 0.25, `${small.half * 2} px across at 150 px`);

    const big = G.markerGeometry(800);
    assert.ok(big.stroke <= G.MAX_STROKE, `stroke ${big.stroke} at 800 px`);
    // Under a tenth of the map at the top of the slider.
    assert.ok(big.half * 2 <= 800 * 0.1, `${big.half * 2} px across at 800 px`);
});

test('gas is the same bracket, rotated 45 degrees and smaller', () => {
    const plain = G.markerGeometry(250);
    const gas = G.markerGeometry(250, {small: true});
    assert.strictEqual(gas.rotation, G.GAS_ROTATION);
    assert.ok(gas.half < plain.half, `${gas.half} vs ${plain.half}`);
    assert.ok(gas.stroke < plain.stroke, `${gas.stroke} vs ${plain.stroke}`);
    // Smaller by the documented factor, not by a stray rounding.
    assert.ok(Math.abs(gas.half - plain.half * G.GAS_SCALE) < 0.01);
});

test('the curve is clamped at both ends, so a hand-edited size cannot break it', () => {
    // Anything at all, including values no slider can produce.
    for (const extent of [0, -1, 1, 20, SIZE_MIN, SIZE_MAX, 5000, NaN, undefined, null, '250']) {
        const g = G.markerGeometry(extent);
        assert.ok(Number.isFinite(g.half) && g.half > 0, `half for ${extent}: ${g.half}`);
        assert.ok(g.half >= G.MIN_HALF * G.GAS_SCALE && g.half <= G.MAX_HALF, `half for ${extent}: ${g.half}`);
        assert.ok(g.stroke >= G.MIN_STROKE * G.GAS_SCALE && g.stroke <= G.MAX_STROKE,
            `stroke for ${extent}: ${g.stroke}`);
        assert.ok(g.arm > 0 && g.arm < g.half, `arm for ${extent}: ${g.arm}`);
    }
});

test('it is monotonic across the whole slider range', () => {
    // A size step must never make a marker smaller: the user drags the slider
    // and watches, and a non-monotonic curve reads as a bug.
    let previous = 0;
    for (let extent = SIZE_MIN; extent <= SIZE_MAX; extent += 25) {
        const g = G.markerGeometry(extent);
        assert.ok(g.half >= previous, `${extent}: ${g.half} < ${previous}`);
        previous = g.half;
    }
});

test('bracketPaths: four L shapes, centred on the origin, open in the middle', () => {
    const g = G.markerGeometry(250);
    const paths = G.bracketPaths(g);
    assert.strictEqual(paths.length, 4);
    for (const d of paths) {
        // `M x y L x y L x y` — two segments, i.e. one corner.
        assert.match(d, /^M -?[\d.]+ -?[\d.]+ L -?[\d.]+ -?[\d.]+ L -?[\d.]+ -?[\d.]+$/, d);
        const numbers = d.match(/-?[\d.]+/g).map(Number);
        for (const n of numbers) {
            assert.ok(Number.isFinite(n), d);
            // Nothing reaches past the bracket square.
            assert.ok(Math.abs(n) <= g.half + 1e-9, `${n} outside ±${g.half} in ${d}`);
        }
        // The corner itself is at a corner of the square: both of the middle
        // pair are exactly ±half.
        assert.strictEqual(Math.abs(numbers[2]), g.half);
        assert.strictEqual(Math.abs(numbers[3]), g.half);
    }
    // All four corners are distinct — a copy-paste slip would give two the
    // same corner and leave one side of every marker bare.
    const corners = new Set(paths.map(d => {
        const n = d.match(/-?[\d.]+/g).map(Number);
        return `${n[2]},${n[3]}`;
    }));
    assert.strictEqual(corners.size, 4);
});

test('markerReach covers the stroke, and a rotated marker reaches further', () => {
    const plain = G.markerGeometry(250);
    const gas = G.markerGeometry(250, {small: true});
    // The renderers pad the SVG viewport by this, so it has to be at least the
    // geometric extent plus half a stroke or an edge marker is clipped.
    assert.ok(G.markerReach(plain) >= plain.half + plain.stroke / 2 - 1e-9);
    // A diamond's corner is half*sqrt(2) away, which is the case that would
    // otherwise be clipped even though the gas marker is the smaller one.
    assert.ok(G.markerReach(gas) >= gas.half * Math.SQRT2);
});
