const {test, before} = require('node:test');
const assert = require('node:assert');
const path = require('path');
const sharp = require('sharp');

const M = require('../src/core/map-detector/matcher');
const {
    locatePanel, cutSquare, listFixtures, catalog, keyForFixture, templateSources,
    FIXTURES, TEMPLATE_PREFIX, FULLSCREEN_PREFIX
} = require('../scripts/prepare-detector');
const TEMPLATE_FILE = require('../src/core/map-detector/templates.json');

const TEMPLATES = {};
for (const [key, values] of Object.entries(TEMPLATE_FILE.templates)) TEMPLATES[key] = Float32Array.from(values);
const KEYS = Object.keys(TEMPLATES).sort();
const SIZE = TEMPLATE_FILE.size;

/*
 * Nothing below names a map. The fixtures in `detection-fixtures/` are the
 * test matrix: `tab-<slug>.png` is a positive for the map its slug resolves
 * to, `tab-fullscreen-<slug>.png` is an extra full-frame positive, anything
 * else is a negative that must detect nothing. Dropping a new map's image into
 * `maps/` and its Tab screenshot into `detection-fixtures/` is therefore all it
 * takes to get it covered here.
 */
const CATALOG = catalog();
const SOURCES = templateSources();
const FIXTURE_FILES = listFixtures();
const FULLSCREEN_FIXTURES = FIXTURE_FILES.filter(f => f.startsWith(FULLSCREEN_PREFIX));
const NEGATIVE_FIXTURES = FIXTURE_FILES.filter(f => !f.startsWith(TEMPLATE_PREFIX));

/** The catalogue key a `tab-fullscreen-<slug>.png` fixture should detect. */
function fullscreenKey(file) {
    return keyForFixture(TEMPLATE_PREFIX + file.slice(FULLSCREEN_PREFIX.length), CATALOG);
}

const fixture = name => path.join(FIXTURES, name);
const short = key => (key ? key.split('/').pop() : '—');

/**
 * Decode a PNG (path or buffer) into the same luminance frame the runtime
 * builds from `nativeImage.toBitmap()` — sharp gives RGBA, Electron BGRA, and
 * `toGray` is the single conversion both go through.
 */
async function loadFrame(input) {
    const {data, info} = await sharp(input).ensureAlpha().raw().toBuffer({resolveWithObject: true});
    return {gray: M.toGray(data, info.width, info.height, 'rgba'), width: info.width, height: info.height};
}

/** A fixture resampled to another resolution. */
async function rescaled(file, width, height) {
    const buf = await sharp(fixture(file)).resize(width, height, {fit: 'fill'}).png().toBuffer();
    return loadFrame(buf);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Score report. Every fixture prints its four NCC scores and the margin, so a
 * reviewer can see the separation rather than take the assertions on trust.
 * ──────────────────────────────────────────────────────────────────────────── */

const rows = [];

function record(label, expected, result) {
    rows.push({label, expected, result});
    return result;
}

// Printed once the whole file has run, whatever order node:test chose.
process.on('exit', printReport);

function printReport() {
    if (!rows.length) return;
    const pad = (s, n) => String(s).padEnd(n);
    console.log('\n  Map detector — fixture scores (score = mean of luminance NCC and gradient NCC)\n');
    console.log('  ' + pad('fixture', 52) + pad('expected', 24) + pad('detected', 36)
        + pad('score', 9) + pad('runner-up', 11) + 'margin');
    console.log('  ' + '-'.repeat(140));
    for (const {label, expected, result} of rows) {
        const detected = result.gated ? 'GATED OUT' : short(result.key) + (result.accepted ? '' : ' (rejected)');
        console.log('  ' + pad(label, 52) + pad(expected, 24) + pad(detected, 36)
            + pad(result.gated ? '—' : result.score.toFixed(4), 9)
            + pad(result.gated ? '—' : result.second.toFixed(4), 11)
            + (result.gated ? '—' : result.margin.toFixed(4)));
        if (!result.gated) {
            console.log('  ' + ' '.repeat(52) + KEYS.map(k => short(k) + '=' + result.scores[k].toFixed(4)).join('  '));
        }
    }
    console.log('');
}

/* ────────────────────────────────────────────────────────────────────────────
 * Unit tests for the pure pieces
 * ──────────────────────────────────────────────────────────────────────────── */

test('ncc: identical signals correlate at 1', () => {
    const a = Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
    assert.ok(Math.abs(M.ncc(a, a) - 1) < 1e-6);
});

test('ncc: an inverted signal correlates at -1', () => {
    const a = Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
    const b = Float32Array.from(Array.from(a, v => 1 - v));
    assert.ok(Math.abs(M.ncc(a, b) + 1) < 1e-6);
});

test('ncc: a brighter, higher-contrast copy still correlates at 1', () => {
    const a = Float32Array.from([0.1, 0.4, 0.2, 0.9, 0.5, 0.3]);
    const b = Float32Array.from(Array.from(a, v => v * 0.5 + 0.2));
    assert.ok(Math.abs(M.ncc(a, b) - 1) < 1e-6);
});

test('ncc: a constant image gives 0, not NaN', () => {
    const flat = new Float32Array(16);
    const a = Float32Array.from({length: 16}, (_, i) => i);
    assert.strictEqual(M.ncc(flat, flat), 0);
    assert.strictEqual(M.ncc(flat, a), 0);
    assert.strictEqual(M.ncc(a, flat), 0);
});

test('ncc: an empty signal gives 0', () => {
    assert.strictEqual(M.ncc(new Float32Array(0), new Float32Array(0)), 0);
});

test('downsample: averages the area of each output cell', () => {
    // 4x4 counting up; 2x2 output cells are the means of each 2x2 block.
    const src = Float32Array.from([
        0, 1, 2, 3,
        4, 5, 6, 7,
        8, 9, 10, 11,
        12, 13, 14, 15
    ]);
    const out = M.downsample(src, 4, 4, 2);
    assert.deepStrictEqual(Array.from(out), [2.5, 4.5, 10.5, 12.5]);
});

test('downsample: handles a size that does not divide the source', () => {
    const src = Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8]);   // 3x3
    const out = M.downsample(src, 3, 3, 2);
    assert.strictEqual(out.length, 4);
    // Every value is a weighted mean of the source, so it stays in range.
    for (const v of out) assert.ok(v >= 0 && v <= 8, `${v} out of range`);
    // Top-left cell covers 1.5x1.5 px starting at (0,0): (0*1+1*.5+3*.5+4*.25)/2.25
    assert.ok(Math.abs(out[0] - (0 + 0.5 + 1.5 + 1) / 2.25) < 1e-6);
});

test('downsample: a uniform image stays uniform at any size', () => {
    const src = new Float32Array(37 * 53).fill(0.42);
    for (const v of M.downsample(src, 37, 53, 8)) assert.ok(Math.abs(v - 0.42) < 1e-6);
});

test('downsample of a rescaled image matches the original', async () => {
    const native = await loadFrame(fixture(FULLSCREEN_FIXTURES[0]));
    const big = await rescaled(FULLSCREEN_FIXTURES[0], 2560, 1440);
    const a = M.frameThumbnail(native.gray, native.width, native.height);
    const b = M.frameThumbnail(big.gray, big.width, big.height);
    assert.ok(M.ncc(a, b) > 0.99, `resolution-independent thumbnail: ncc=${M.ncc(a, b)}`);
});

test('toGray: converts BGRA and RGBA to the same luminance', () => {
    const rgba = Uint8Array.from([10, 20, 30, 255, 200, 100, 50, 255]);
    const bgra = Uint8Array.from([30, 20, 10, 255, 50, 100, 200, 255]);
    const g1 = M.toGray(rgba, 2, 1, 'rgba');
    const g2 = M.toGray(bgra, 2, 1, 'bgra');
    assert.deepStrictEqual(Array.from(g1), Array.from(g2));
    assert.ok(Math.abs(g1[0] - (0.299 * 10 + 0.587 * 20 + 0.114 * 30) / 255) < 1e-6);
});

test('toGray: refuses a buffer that is too small', () => {
    assert.throws(() => M.toGray(new Uint8Array(8), 4, 4), /expected 64 bytes/);
});

test('toGrayScaled equals toGray followed by downsample', async () => {
    // The runtime fuses the two into one pass over the capture; that shortcut
    // is only safe while it produces the same numbers as the slow path.
    const file = fixture(FULLSCREEN_FIXTURES[0]);
    const {data, info} = await sharp(file).ensureAlpha().raw().toBuffer({resolveWithObject: true});
    const slowGray = M.toGray(data, info.width, info.height, 'rgba');
    // 1919x1078 divides evenly by neither, so these exercise the general path;
    // the exact-ratio fast path is covered by the 1920x1080 case below.
    for (const [outW, outH] of [[640, 360], [320, 180], [info.width, info.height]]) {
        const fused = M.toGrayScaled(data, info.width, info.height, outW, outH, 'rgba');
        const slow = M.resample(slowGray, info.width, info.height, outW, outH);
        assert.strictEqual(fused.length, outW * outH, `${outW}x${outH}: length`);
        let worst = 0;
        for (let i = 0; i < fused.length; i++) worst = Math.max(worst, Math.abs(fused[i] - slow[i]));
        assert.ok(worst < 1e-5, `${outW}x${outH}: worst difference ${worst}`);
    }
});

test('toGrayScaled: the exact-ratio fast path agrees with the general one', async () => {
    // 1920 -> 640 and 1080 -> 360 are both exactly 3:1, which is the path a
    // 1080p game window actually takes. It must produce the same numbers as the
    // fractional-weight code, or the templates stop matching on exactly the
    // resolution everyone plays at.
    const buf = await sharp(fixture(FULLSCREEN_FIXTURES[0])).resize(1920, 1080, {fit: 'fill'}).png().toBuffer();
    const {data, info} = await sharp(buf).ensureAlpha().raw().toBuffer({resolveWithObject: true});
    assert.strictEqual(info.width % 640, 0);
    assert.strictEqual(info.height % 360, 0);
    const fast = M.toGrayScaled(data, info.width, info.height, 640, 360, 'rgba');
    const slow = M.resample(M.toGray(data, info.width, info.height, 'rgba'), info.width, info.height, 640, 360);
    let worst = 0;
    for (let i = 0; i < fast.length; i++) worst = Math.max(worst, Math.abs(fast[i] - slow[i]));
    assert.ok(worst < 1e-5, `worst difference ${worst}`);
});

test('toGrayScaled: handles both channel orders and rejects a short buffer', () => {
    const rgba = Uint8Array.from([10, 20, 30, 255, 200, 100, 50, 255]);
    const bgra = Uint8Array.from([30, 20, 10, 255, 50, 100, 200, 255]);
    assert.deepStrictEqual(
        Array.from(M.toGrayScaled(rgba, 2, 1, 2, 1, 'rgba')),
        Array.from(M.toGrayScaled(bgra, 2, 1, 2, 1, 'bgra'))
    );
    // 2x1 averaged into 1x1 is the mean of the two lumas.
    const one = M.toGrayScaled(rgba, 2, 1, 1, 1, 'rgba');
    const both = M.toGrayScaled(rgba, 2, 1, 2, 1, 'rgba');
    assert.ok(Math.abs(one[0] - (both[0] + both[1]) / 2) < 1e-6);
    assert.throws(() => M.toGrayScaled(new Uint8Array(8), 4, 4, 2, 2), /expected 64 bytes/);
});

test('a 640-wide capture of any 16:9 window still detects the map', async () => {
    // What the runtime actually feeds the matcher: raw window pixels reduced to
    // 640 px wide by toGrayScaled, not a pre-made thumbnail.
    const key = fullscreenKey(FULLSCREEN_FIXTURES[0]);
    for (const [w, h] of [[1920, 1080], [1280, 720], [2560, 1440]]) {
        const buf = await sharp(fixture(FULLSCREEN_FIXTURES[0])).resize(w, h, {fit: 'fill'}).png().toBuffer();
        const {data, info} = await sharp(buf).ensureAlpha().raw().toBuffer({resolveWithObject: true});
        const outW = 640, outH = Math.round(640 * info.height / info.width);
        const gray = M.toGrayScaled(data, info.width, info.height, outW, outH, 'rgba');
        const r = record(`window ${w}x${h} → ${outW}x${outH} (runtime path)`, short(key),
            M.matchMap(gray, outW, outH, TEMPLATES, {report: true}));
        assert.strictEqual(r.key, key, `${w}x${h}`);
        assert.ok(r.accepted, `${w}x${h}: not accepted`);
        assert.ok(r.margin >= 0.10, `${w}x${h}: margin ${r.margin.toFixed(4)}`);
    }
});

test('templates.json: one 64x64 template per template fixture, keyed by catalogue key', () => {
    assert.strictEqual(SIZE, 64);
    assert.ok(KEYS.length > 0, 'no templates');
    // Exactly the keys the fixtures resolve to — regenerate with
    // `npm run prepare-detector` after adding or removing a fixture.
    assert.deepStrictEqual(KEYS, Array.from(new Set(Object.values(SOURCES))).sort(),
        'templates.json is out of date with detection-fixtures/');
    const catalogKeys = new Set(CATALOG.map(e => e.key));
    for (const key of KEYS) {
        assert.ok(catalogKeys.has(key), `${key} is not a map in maps/`);
    }
    for (const key of KEYS) {
        assert.strictEqual(TEMPLATES[key].length, 64 * 64, `${key} is not 64x64`);
        for (const v of TEMPLATES[key]) assert.ok(v >= 0 && v <= 1, `${key} has a value outside 0..1`);
    }
});

/* ────────────────────────────────────────────────────────────────────────────
 * The Tab-screen gate
 * ──────────────────────────────────────────────────────────────────────────── */

test('gate: every Tab screen passes, every other screen does not', async () => {
    for (const name of FULLSCREEN_FIXTURES) {
        const f = await loadFrame(fixture(name));
        const features = M.tabScreenFeatures(f.gray, f.width, f.height);
        assert.ok(M.TAB_SCREEN_GATE(f.gray, f.width, f.height),
            `${name} gated out: ${JSON.stringify(features)}`);
        assert.ok(features.darkFraction >= 0.95, `${name}: darkFraction ${features.darkFraction}`);
    }
    assert.ok(NEGATIVE_FIXTURES.length > 0, 'no negative fixtures');
    for (const name of NEGATIVE_FIXTURES) {
        const f = await loadFrame(fixture(name));
        const features = M.tabScreenFeatures(f.gray, f.width, f.height);
        assert.ok(!M.TAB_SCREEN_GATE(f.gray, f.width, f.height),
            `${name} passed the gate: ${JSON.stringify(features)}`);
    }
});

/* ────────────────────────────────────────────────────────────────────────────
 * The acceptance table (SPEC-DETECT §2.5)
 * ──────────────────────────────────────────────────────────────────────────── */

for (const file of FULLSCREEN_FIXTURES) {
    const key = fullscreenKey(file);
    test(`full frame: ${file} detects ${short(key)}`, async () => {
        assert.ok(key, `${file}: its slug matches no map in maps/`);
        const f = await loadFrame(fixture(file));
        const r = record(file, short(key),
            M.matchMap(f.gray, f.width, f.height, TEMPLATES, {report: true}));
        assert.strictEqual(r.key, key);
        assert.ok(r.accepted, 'not accepted');
        assert.ok(r.margin >= 0.10, `margin ${r.margin.toFixed(4)} < 0.10`);
    });
}

for (const [file, key] of Object.entries(SOURCES)) {
    test(`cropped fixture: ${file} detects ${short(key)}`, async () => {
        const f = await loadFrame(fixture(file));
        // The crops are not full frames: find the map panel in the crop's own
        // coordinates (see scripts/prepare-detector.js) and feed just that
        // through the same downsample the runtime uses.
        const loc = locatePanel(f.gray, f.width, f.height);
        const panel = cutSquare(f.gray, f.width, f.height, loc.x, loc.y, loc.size);
        const r = record(file, short(key),
            M.matchMap(panel, loc.size, loc.size, TEMPLATES, {region: null, gate: false, report: true}));
        assert.strictEqual(r.key, key);
        assert.ok(r.accepted, 'not accepted');
        assert.ok(r.margin >= 0.10, `margin ${r.margin.toFixed(4)} < 0.10`);
    });
}

// 640x360 is the size the runtime capture is reduced to.
for (const [w, h] of [[1280, 720], [2560, 1440], [640, 360]]) {
    for (const file of FULLSCREEN_FIXTURES) {
        const key = fullscreenKey(file);
        test(`${file} rescaled to ${w}x${h}: still ${short(key)}`, async () => {
            const f = await rescaled(file, w, h);
            const r = record(`${file} @ ${w}x${h}`, short(key),
                M.matchMap(f.gray, f.width, f.height, TEMPLATES, {report: true}));
            assert.strictEqual(r.key, key);
            assert.ok(r.accepted, 'not accepted');
            assert.ok(r.margin >= 0.10, `margin ${r.margin.toFixed(4)} < 0.10`);
        });
    }
}

/**
 * A captured *window* (rather than the whole display) can be off by a few
 * pixels vertically — a title bar, a slightly different client size. Borderless
 * windowed has none, but the gate and the match have to survive a small shift
 * either way, since the regions are relative to the captured image.
 */
const SHIFT_FIXTURE = FULLSCREEN_FIXTURES[0];
for (const shift of [-2, -1, 1, 2]) {
    test(`tolerates a ${shift}% vertical shift of the captured frame`, async () => {
        const key = fullscreenKey(SHIFT_FIXTURE);
        const {width, height} = await sharp(fixture(SHIFT_FIXTURE)).metadata();
        const offset = Math.round(height * shift / 100);
        // Slide the frame and pad with black, keeping the frame size identical:
        // the same thing a capture that starts a few rows late would produce.
        const buf = await sharp(fixture(SHIFT_FIXTURE))
            .extract({
                left: 0,
                top: Math.max(0, -offset),
                width,
                height: height - Math.abs(offset)
            })
            .extend({
                top: Math.max(0, offset),
                bottom: Math.max(0, -offset),
                background: {r: 0, g: 0, b: 0, alpha: 255}
            })
            .png().toBuffer();
        const f = await loadFrame(buf);
        assert.strictEqual(f.height, height, 'the shifted frame changed size');
        const r = record(`${SHIFT_FIXTURE} shifted ${shift > 0 ? '+' : ''}${shift}%`, short(key),
            M.matchMap(f.gray, f.width, f.height, TEMPLATES, {report: true}));
        assert.ok(!r.gated, 'the gate rejected a slightly shifted Tab screen');
        assert.strictEqual(r.key, key);
        assert.ok(r.accepted, 'not accepted');
        assert.ok(r.margin >= 0.10, `margin ${r.margin.toFixed(4)} < 0.10`);
    });
}

for (const name of NEGATIVE_FIXTURES) {
    test(`negative: ${name} detects nothing`, async () => {
        const f = await loadFrame(fixture(name));
        assert.strictEqual(M.matchMap(f.gray, f.width, f.height, TEMPLATES), null);
        record(name, 'null', M.matchMap(f.gray, f.width, f.height, TEMPLATES, {report: true}));
    });
}

test('negative: the negatives stay below threshold even with the gate off', async () => {
    for (const name of NEGATIVE_FIXTURES) {
        const f = await loadFrame(fixture(name));
        const r = M.matchMap(f.gray, f.width, f.height, TEMPLATES, {gate: false, report: true});
        record(name + ' (gate off)', 'null', r);
        assert.ok(!r.accepted, `${name} scored ${r.score.toFixed(4)} for ${short(r.key)}`);
        assert.ok(r.score < M.DEFAULT_MIN_SCORE,
            `${name} scored ${r.score.toFixed(4)}, above the ${M.DEFAULT_MIN_SCORE} threshold`);
    }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Panel location — the measurement the templates and the tests both rest on
 * ──────────────────────────────────────────────────────────────────────────── */

test('locatePanel: finds the same 766x766 panel in every Tab fixture', async () => {
    // The offsets of the fixtures that were measured by hand, as a regression
    // guard. A fixture added later is still checked for size and fit.
    const measured = {
        'tab-fullscreen-haddonfield-heights.png': {dx: 0, dy: 0},
        'tab-east-haddonfield.png': {dx: 257, dy: 146},
        'tab-haddonfield-heights.png': {dx: 255, dy: 148},
        'tab-haddonfield-town-center.png': {dx: 261, dy: 149},
        'tab-orange-grove-estates.png': {dx: 251, dy: 146}
    };
    const tabFixtures = FIXTURE_FILES.filter(f => f.startsWith(TEMPLATE_PREFIX));
    assert.ok(tabFixtures.length > 0, 'no Tab fixtures');
    for (const name of tabFixtures) {
        const f = await loadFrame(fixture(name));
        const loc = locatePanel(f.gray, f.width, f.height);
        assert.strictEqual(loc.size, 766, `${name}: size`);
        assert.ok(loc.x >= 0 && loc.y >= 0 && loc.x + loc.size <= f.width && loc.y + loc.size <= f.height,
            `${name}: panel does not fit`);
        const want = measured[name];
        if (!want) continue;
        assert.strictEqual(loc.dx, want.dx, `${name}: dx`);
        assert.strictEqual(loc.dy, want.dy, `${name}: dy`);
    }
});

test('locatePanel on the full frame agrees with MAP_PANEL_REL', async () => {
    const f = await loadFrame(fixture(FULLSCREEN_FIXTURES[0]));
    const loc = locatePanel(f.gray, f.width, f.height);
    const rel = M.cropRegion(f.gray, f.width, f.height, M.MAP_PANEL_REL);
    assert.strictEqual(rel.width, loc.size);
    assert.strictEqual(rel.height, loc.size);
    const a = M.downsample(rel.data, rel.width, rel.height, SIZE);
    const b = M.downsample(cutSquare(f.gray, f.width, f.height, loc.x, loc.y, loc.size), loc.size, loc.size, SIZE);
    assert.ok(M.ncc(a, b) > 0.999, 'the relative region and the located panel are not the same rectangle');
});

test('templates reproduce from the fixtures (prepare-detector is idempotent)', async () => {
    for (const [file, key] of Object.entries(SOURCES)) {
        const f = await loadFrame(fixture(file));
        const loc = locatePanel(f.gray, f.width, f.height);
        const thumb = M.downsample(cutSquare(f.gray, f.width, f.height, loc.x, loc.y, loc.size), loc.size, loc.size, SIZE);
        const stored = TEMPLATES[key];
        for (let i = 0; i < stored.length; i++) {
            assert.ok(Math.abs(stored[i] - thumb[i]) <= 0.0006,
                `${key}[${i}]: stored ${stored[i]} vs rebuilt ${thumb[i]}`);
        }
    }
});

test('every map in maps/ has a detection fixture', () => {
    // A map the detector cannot recognise is a half-added map: drop its Tab
    // screenshot into detection-fixtures/tab-<slug>.png and re-run
    // `npm run prepare-detector`.
    const covered = new Set(Object.values(SOURCES));
    const missing = CATALOG.filter(e => !e.custom && !covered.has(e.key)).map(e => e.key);
    assert.deepStrictEqual(missing, [],
        `no detection fixture for: ${missing.join(', ')}`);
});
