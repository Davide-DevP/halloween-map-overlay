const {test, before} = require('node:test');
const assert = require('node:assert');
const path = require('path');
const sharp = require('sharp');

const M = require('../src/core/map-detector/matcher');
const {
    locatePanel, cutSquare, listFixtures, catalog, keyForFixture, templateSources,
    templateSourcesByKey, buildVariantsForKey,
    menuFixtures, buildMenuTemplate,
    FIXTURES, TEMPLATE_PREFIX, FULLSCREEN_PREFIX, MENU_PREFIX
} = require('../scripts/prepare-detector');
const TEMPLATE_FILE = require('../src/core/map-detector/templates.json');

/** key → its template *variants* (one thumbnail per view of the map panel). */
const TEMPLATES = {};
for (const [key, values] of Object.entries(TEMPLATE_FILE.templates)) TEMPLATES[key] = M.templateVariants(values);
const KEYS = Object.keys(TEMPLATES).sort();
const SIZE = TEMPLATE_FILE.size;

const MENU = TEMPLATE_FILE.menu || null;
const MENU_TEMPLATE = MENU && Array.isArray(MENU.template) ? Float32Array.from(MENU.template) : null;
const MENU_OPTS = MENU ? {width: MENU.width, height: MENU.height} : {};

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
/** `menu-*.png` is a main-menu positive; every other fixture is a menu negative. */
const MENU_FIXTURES = menuFixtures();
const MENU_NEGATIVE_FIXTURES = FIXTURE_FILES.filter(f => !f.startsWith(MENU_PREFIX));

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

/** Menu-matcher scores, printed as their own table under the map one. */
const menuRows = [];

function recordMenu(label, expected, result) {
    menuRows.push({label, expected, score: result.score, accepted: result.accepted});
    return result;
}

// Printed once the whole file has run, whatever order node:test chose.
process.on('exit', () => {
    printReport();
    printMenuReport();
});

function printMenuReport() {
    if (!menuRows.length) return;
    const pad = (s, n) => String(s).padEnd(n);
    console.log(`\n  Main-menu detector — fixture scores (accept at ${M.MENU_MIN_SCORE})\n`);
    console.log('  ' + pad('fixture', 52) + pad('expected', 12) + pad('menu?', 10)
        + pad('score', 10) + 'margin to threshold');
    console.log('  ' + '-'.repeat(110));
    for (const {label, expected, score, accepted} of menuRows) {
        const margin = score - M.MENU_MIN_SCORE;
        console.log('  ' + pad(label, 52) + pad(expected, 12) + pad(accepted ? 'menu' : 'no', 10)
            + pad(score.toFixed(4), 10) + (margin >= 0 ? '+' : '') + margin.toFixed(4));
    }
    console.log('');
}

function printReport() {
    if (!rows.length) return;
    const pad = (s, n) => String(s).padEnd(n);
    console.log('\n  Map detector — fixture scores (score = mean of luminance NCC and gradient NCC)');
    console.log(`  accept: score >= ${M.DEFAULT_MIN_SCORE} with margin >= ${M.DEFAULT_MIN_MARGIN}`
        + `, OR score >= ${M.DEFAULT_MARGIN_MIN_SCORE} with margin >= ${M.DEFAULT_MARGIN_MIN_MARGIN}`
        + ' (the civilian/party case — see acceptMatch)');
    // A map scores as the best of its variants, so how many it has is part of
    // reading the table: one view per variant (Michael, civilian, …).
    console.log('  templates: '
        + KEYS.map(k => `${short(k)} variants=${TEMPLATES[k].length}`).join('  ·  ') + '\n');
    console.log('  ' + pad('fixture', 52) + pad('expected', 24) + pad('detected', 36)
        + pad('score', 9) + pad('runner-up', 11) + pad('margin', 10) + 'by');
    console.log('  ' + '-'.repeat(146));
    for (const {label, expected, result} of rows) {
        const detected = result.gated ? 'GATED OUT' : short(result.key) + (result.accepted ? '' : ' (rejected)');
        console.log('  ' + pad(label, 52) + pad(expected, 24) + pad(detected, 36)
            + pad(result.gated ? '—' : result.score.toFixed(4), 9)
            + pad(result.gated ? '—' : result.second.toFixed(4), 11)
            + pad(result.gated ? '—' : result.margin.toFixed(4), 10)
            + (result.gated ? '—' : (result.acceptedBy || 'none')));
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

test('templates.json: one 64x64 variant per template fixture, keyed by catalogue key', () => {
    assert.strictEqual(SIZE, 64);
    assert.strictEqual(TEMPLATE_FILE.format, 2, 'templates.json is not the variant format');
    assert.ok(KEYS.length > 0, 'no templates');
    // One variant per `tab-*` fixture that resolves to the key, in file order.
    const byKey = templateSourcesByKey();
    for (const key of KEYS) {
        assert.strictEqual(TEMPLATES[key].length, byKey[key].length,
            `${key}: ${TEMPLATES[key].length} variants for ${byKey[key].length} fixtures`);
    }
    // Exactly the keys the fixtures resolve to — regenerate with
    // `npm run prepare-detector` after adding or removing a fixture.
    assert.deepStrictEqual(KEYS, Array.from(new Set(Object.values(SOURCES))).sort(),
        'templates.json is out of date with detection-fixtures/');
    const catalogKeys = new Set(CATALOG.map(e => e.key));
    for (const key of KEYS) {
        assert.ok(catalogKeys.has(key), `${key} is not a map in maps/`);
    }
    for (const key of KEYS) {
        for (const variant of TEMPLATES[key]) {
            assert.strictEqual(variant.length, 64 * 64, `${key} has a variant that is not 64x64`);
            for (const v of variant) assert.ok(v >= 0 && v <= 1, `${key} has a value outside 0..1`);
        }
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

/**
 * The margin branch (0.3.3) is the one that could let a wrong map through, so
 * it is asserted on its own rather than only through `accepted`: with the Tab
 * gate switched off — the most hostile setting there is, since it hands the
 * matcher frames the runtime would never score at all — **no** negative
 * fixture may satisfy it. Measured: the best negative scores 0.09/0.13/0.28
 * with margins of 0.035 and below, so it misses both halves of the branch by
 * an order of magnitude.
 */
test('negative: no negative fixture can fire the margin accept branch (gate off)', async () => {
    for (const name of NEGATIVE_FIXTURES) {
        const f = await loadFrame(fixture(name));
        const r = M.matchMap(f.gray, f.width, f.height, TEMPLATES, {gate: false, report: true});
        assert.strictEqual(M.acceptMatch(r.score, r.margin), null,
            `${name}: score ${r.score.toFixed(4)} margin ${r.margin.toFixed(4)} was accepted`);
        // ...and it is not a near miss on either half.
        assert.ok(r.score < M.DEFAULT_MARGIN_MIN_SCORE,
            `${name}: score ${r.score.toFixed(4)} reaches the margin branch's ${M.DEFAULT_MARGIN_MIN_SCORE} floor`);
        assert.ok(r.margin < M.DEFAULT_MARGIN_MIN_MARGIN,
            `${name}: margin ${r.margin.toFixed(4)} reaches the margin branch's ${M.DEFAULT_MARGIN_MIN_MARGIN}`);
    }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Acceptance (0.3.3): the field numbers, not invented ones
 *
 * From the owner's detector.log on 0.3.2. Solo matches scored 0.992 with a
 * 0.492 margin and switched. Every party Tab press scored 0.68-0.72 with a
 * 0.27-0.31 margin — the right map first, every time — and nothing was ever
 * sent, because the absolute score is under 0.80.
 * ──────────────────────────────────────────────────────────────────────────── */

test('acceptMatch: a bright solo match is accepted on score', () => {
    assert.strictEqual(M.acceptMatch(0.992, 0.492), 'score');
    // Exactly on both thresholds still accepts.
    assert.strictEqual(M.acceptMatch(M.DEFAULT_MIN_SCORE, M.DEFAULT_MIN_MARGIN), 'score');
});

test('acceptMatch: the party case from the field log is accepted on margin', () => {
    // The synthetic pair the fix is specified against: score 0.70, second 0.41.
    assert.strictEqual(M.acceptMatch(0.70, 0.70 - 0.41), 'margin');
    // The whole observed band, both ends.
    for (const [score, second] of [[0.680, 0.405], [0.715, 0.415], [0.687, 0.398], [0.709, 0.413]]) {
        assert.strictEqual(M.acceptMatch(score, score - second), 'margin',
            `score ${score} second ${second}`);
    }
});

test('acceptMatch: a dim match needs BOTH halves of the margin branch', () => {
    // Clear lead, but too dim even for the second branch.
    assert.strictEqual(M.acceptMatch(0.59, 0.40), null);
    // Bright enough for the second branch, but the runner-up is right behind:
    // the shape of every negative fixture, and of a frame that correlates
    // weakly with everything. 0.14 is just under the 0.15 lead the branch
    // wants; 0.196 (the worst "unseen view" case) is just over it.
    assert.strictEqual(M.acceptMatch(0.70, 0.14), null);
    assert.strictEqual(M.acceptMatch(0.6972, 0.1956), 'margin');
    // ...and the first branch still needs its own margin.
    assert.strictEqual(M.acceptMatch(0.85, 0.09), null);
    // The exact corner of the second branch accepts.
    assert.strictEqual(M.acceptMatch(M.DEFAULT_MARGIN_MIN_SCORE, M.DEFAULT_MARGIN_MIN_MARGIN), 'margin');
});

test('acceptMatch: the thresholds are overridable, and matchMap passes them through', async () => {
    assert.strictEqual(M.acceptMatch(0.70, 0.29, {marginMinScore: 0.75}), null);
    // A fixture that is accepted today must be rejected once the bar is raised
    // past it — proof matchMap really uses these and does not hard-code them.
    const f = await loadFrame(fixture(FULLSCREEN_FIXTURES[0]));
    const r = M.matchMap(f.gray, f.width, f.height, TEMPLATES, {report: true, minScore: 1.1, marginMinScore: 1.1});
    assert.strictEqual(r.accepted, false);
    assert.strictEqual(r.acceptedBy, null);
});

test('matchMap reports which branch accepted, and the map panel mean luminance', async () => {
    const f = await loadFrame(fixture(FULLSCREEN_FIXTURES[0]));
    const r = M.matchMap(f.gray, f.width, f.height, TEMPLATES, {report: true});
    assert.strictEqual(r.acceptedBy, 'score');
    // `panelMean` is what `no-match` logs so a dimmed or slipped panel is
    // visible without keeping a frame: a real map panel is dark but not black.
    assert.ok(r.panelMean > 0 && r.panelMean < 0.5, `panelMean ${r.panelMean}`);
    const panel = M.cropRegion(f.gray, f.width, f.height, M.MAP_PANEL_REL);
    let sum = 0;
    for (const v of panel.data) sum += v;
    assert.ok(Math.abs(r.panelMean - sum / panel.data.length) < 0.01,
        `panelMean ${r.panelMean} is not the map panel's mean ${(sum / panel.data.length).toFixed(4)}`);
});

/**
 * The civilian panel is a light street map with **random** decoration: the
 * yellow/blue glow spots over houses and the player arrow move from match to
 * match. They are not the map, and a template cut from one match must not be
 * keyed on them — which is the job of the gradient half of the score (the road
 * network, the red boundary, the grid letters and the building numbers are
 * edges; a soft glow is almost none).
 *
 * Soft radial bumps at fixed positions stand in for them: same shape, and
 * deterministic so a failure is reproducible.
 */
function addGlows(thumb, size, spots) {
    const out = Float32Array.from(thumb);
    for (const {cx, cy, r, amp} of spots) {
        for (let y = Math.max(0, cy - r); y <= Math.min(size - 1, cy + r); y++) {
            for (let x = Math.max(0, cx - r); x <= Math.min(size - 1, cx + r); x++) {
                const d = Math.hypot(x - cx, y - cy) / r;
                if (d >= 1) continue;
                const falloff = Math.cos(d * Math.PI / 2) ** 2;   // soft, zero at the rim
                out[y * size + x] = Math.min(1, out[y * size + x] + amp * falloff);
            }
        }
    }
    return out;
}

const CIVILIAN_FULLSCREEN = FULLSCREEN_FIXTURES.filter(f => f.includes('civilian-'));

for (const file of CIVILIAN_FULLSCREEN) {
    test(`random glow spots do not stop ${file} matching its own variant`, async () => {
        const key = fullscreenKey(file);
        const f = await loadFrame(fixture(file));
        const own = M.frameThumbnail(f.gray, f.width, f.height);
        // Two house glows and the player arrow. A radius of 3 cells is ~36 px
        // of the 766 px panel, i.e. house-sized, and +0.3 luminance is a bright
        // one: measured 0.909-0.917 against the map's own variants.
        const lit = addGlows(own, SIZE, [
            {cx: 18, cy: 22, r: 3, amp: 0.3},
            {cx: 41, cy: 37, r: 3, amp: 0.3},
            {cx: 30, cy: 52, r: 3, amp: 0.3}
        ]);
        assert.notDeepStrictEqual(Array.from(lit), Array.from(own), 'the glows changed nothing');

        const best = (thumb, variants) => M.templateVariants(variants)
            .reduce((b, tpl) => Math.max(b, score(thumb, tpl)), -Infinity);
        const s = best(lit, TEMPLATES[key]);
        assert.ok(s >= 0.90, `${file} with glows scores ${s.toFixed(4)} on its own variants`);

        // An absurd amount of glow — five-cell blobs at +0.45 — costs ~0.12 and
        // still leaves the right map far in front: this is the second thing the
        // margin branch is for.
        const drenched = addGlows(own, SIZE, [
            {cx: 18, cy: 22, r: 5, amp: 0.45},
            {cx: 41, cy: 37, r: 5, amp: 0.45},
            {cx: 30, cy: 52, r: 5, amp: 0.45}
        ]);
        for (const [label, thumb] of [['glows', lit], ['heavy glows', drenched]]) {
            const mine = best(thumb, TEMPLATES[key]);
            let bestOther = -Infinity;
            for (const other of KEYS) {
                if (other === key) continue;
                bestOther = Math.max(bestOther, best(thumb, TEMPLATES[other]));
            }
            assert.ok(M.acceptMatch(mine, mine - bestOther),
                `${file} with ${label}: ${mine.toFixed(4)} vs runner-up ${bestOther.toFixed(4)}`);
        }
    });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Panel location — the measurement the templates and the tests both rest on
 * ──────────────────────────────────────────────────────────────────────────── */

test('locatePanel: finds the same 766x766 panel in every Tab fixture', async () => {
    // The offsets of the fixtures that were measured by hand, as a regression
    // guard. A fixture added later is still checked for size and fit.
    const measured = {
        'tab-fullscreen-haddonfield-heights.png': {dx: 0, dy: 0},
        // The civilian view: a light street map where Michael's is dark blue,
        // and a crop that includes the left objectives panel like the others.
        // The panel is found from the frame lines, not from what is inside it,
        // so the same locator has to work on both — that is what this pins.
        'tab-fullscreen-civilian-haddonfield-town-center.png': {dx: 0, dy: 0},
        'tab-civilian-haddonfield-town-center.png': {dx: 256, dy: 137},
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
    // ±1 px: the region is a fraction of the frame, and the fixtures are
    // 1919x1078 and 1919x1079, so the rounding can differ by a pixel. What
    // matters is that it is the same rectangle, which the NCC below settles.
    assert.ok(Math.abs(rel.width - loc.size) <= 1, `width ${rel.width} vs ${loc.size}`);
    assert.ok(Math.abs(rel.height - loc.size) <= 1, `height ${rel.height} vs ${loc.size}`);
    const a = M.downsample(rel.data, rel.width, rel.height, SIZE);
    const b = M.downsample(cutSquare(f.gray, f.width, f.height, loc.x, loc.y, loc.size), loc.size, loc.size, SIZE);
    assert.ok(M.ncc(a, b) > 0.999, 'the relative region and the located panel are not the same rectangle');
});

test('templates reproduce from the fixtures (prepare-detector is idempotent)', async () => {
    // Through the generator's own per-key path, so a map with two fixtures is
    // rebuilt with its variants in the same order they were written.
    for (const [key, files] of Object.entries(templateSourcesByKey())) {
        const {variants} = await buildVariantsForKey(files.map(f => fixture(f)));
        const stored = TEMPLATES[key];
        assert.strictEqual(stored.length, variants.length, `${key}: variant count`);
        for (let v = 0; v < variants.length; v++) {
            for (let i = 0; i < variants[v].length; i++) {
                assert.ok(Math.abs(stored[v][i] - variants[v][i]) <= 0.0006,
                    `${key}[${v}][${i}]: stored ${stored[v][i]} vs rebuilt ${variants[v][i]}`);
            }
        }
    }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Template variants (0.3.3)
 *
 * The same map is drawn differently for the civilian role than for Michael, so
 * a map key holds one thumbnail **per view** and scores as the best of them.
 * Averaging them would blur two different pictures into one that matches
 * neither. A view the detector misses is taught with one screenshot:
 * `tab-<role>-<slug>.png`.
 * ──────────────────────────────────────────────────────────────────────────── */

test('templateVariants: both stored shapes, and nothing else', () => {
    const flat = [0, 0.5, 1, 0.25];
    // Format 1 (pre-0.3.3): one flat array per key.
    const one = M.templateVariants(flat);
    assert.strictEqual(one.length, 1);
    assert.deepStrictEqual(Array.from(one[0]), flat);
    // Format 2: a list of them.
    const two = M.templateVariants([flat, [1, 0, 1, 0]]);
    assert.strictEqual(two.length, 2);
    assert.deepStrictEqual(Array.from(two[1]), [1, 0, 1, 0]);
    // Float32Array in, Float32Array out, without a copy per tick.
    const typed = Float32Array.from(flat);
    assert.strictEqual(M.templateVariants(typed)[0], typed);
    assert.deepStrictEqual(Array.from(M.templateVariants([typed, typed])[0]), flat);
    // Nothing stored is nothing to match.
    for (const empty of [null, undefined, [], new Float32Array(0)]) {
        assert.deepStrictEqual(M.templateVariants(empty), [], String(empty));
    }
});

test('every fixture is grouped under its key as a variant, and nothing is dropped', () => {
    const byKey = templateSourcesByKey();
    assert.deepStrictEqual(Object.keys(byKey).sort(), KEYS);
    const grouped = Object.values(byKey).reduce((n, files) => n + files.length, 0);
    assert.strictEqual(grouped, Object.keys(SOURCES).length, 'a template fixture was dropped');
    assert.strictEqual(grouped, KEYS.reduce((n, key) => n + TEMPLATES[key].length, 0),
        'templates.json holds a different number of variants than there are fixtures');
});

test('a role-prefixed fixture is the same map as the plain one', () => {
    // `tab-civilian-<slug>.png` / `tab-party-<slug>.png` must land on the map
    // the slug names — that is the whole naming convention, and it goes
    // through the project's single name matcher, not a rule of its own.
    for (const [file, key] of Object.entries(SOURCES)) {
        const tail = file.slice(TEMPLATE_PREFIX.length);
        for (const role of ['civilian-', 'party-', 'michael-']) {
            assert.strictEqual(keyForFixture(TEMPLATE_PREFIX + role + tail, CATALOG), key,
                TEMPLATE_PREFIX + role + tail);
        }
    }
});

/**
 * A synthetic stand-in for another role's rendering of one map: the same panel
 * through a gamma curve, i.e. dimmed non-linearly. Linear dimming would prove
 * nothing — NCC is invariant to scale and offset — so the copy has to bend the
 * tone curve to be a different picture at all. At `^4` it scores 0.78-0.82
 * against the view it came from, which is the same neighbourhood as the real
 * civilian-versus-Michael pair (0.76).
 */
const VARIANT_GAMMA = 4;
const score = (thumb, tpl) => M.scoreThumbnail(thumb, M.gradientMagnitude(thumb, SIZE), tpl, SIZE);

for (const file of FULLSCREEN_FIXTURES) {
    test(`a second variant of ${file} matches its own view without costing the first`, async () => {
        const key = fullscreenKey(file);
        const f = await loadFrame(fixture(file));
        const own = M.frameThumbnail(f.gray, f.width, f.height);
        const dimmed = Float32Array.from(own, v => Math.pow(v, VARIANT_GAMMA));

        // The gamma copy really is a different picture for the matcher...
        assert.ok(score(dimmed, own) < 0.95,
            `the synthetic variant is too similar to be a test: ${score(dimmed, own).toFixed(4)}`);

        // ...and with both variants stored, each view is matched by one of
        // them. The new view scores on its own variant exactly; the original
        // keeps whatever it had, because a variant can only ever add a
        // candidate to the max — never take one away.
        const withVariant = Object.assign({}, TEMPLATES, {[key]: [...TEMPLATES[key], dimmed]});
        const best = (thumb, variants) => M.templateVariants(variants)
            .reduce((b, tpl) => Math.max(b, score(thumb, tpl)), -Infinity);

        assert.ok(best(dimmed, withVariant[key]) >= 0.95,
            `second view: ${best(dimmed, withVariant[key]).toFixed(4)} against its key's variants`);

        const before = best(own, TEMPLATES[key]);
        const after = best(own, withVariant[key]);
        assert.ok(after >= before - 1e-9, `the original view lost ground: ${before} → ${after}`);
        // 0.9959 where the fixture *is* the template's source screenshot,
        // 0.9490 for the full frame whose template was cut from a different
        // screenshot of the same view — both are "this is plainly my map".
        assert.ok(after >= 0.94, `original view: ${after.toFixed(4)} against its key's variants`);

        // The real frame still resolves to the same map, and the extra variant
        // has not made any negative acceptable.
        const r = M.matchMap(f.gray, f.width, f.height, withVariant, {report: true});
        assert.strictEqual(r.key, key);
        assert.ok(r.accepted && r.score >= 0.94, `score ${r.score.toFixed(4)}`);
        for (const name of NEGATIVE_FIXTURES) {
            const n = await loadFrame(fixture(name));
            const nr = M.matchMap(n.gray, n.width, n.height, withVariant, {gate: false, report: true});
            assert.strictEqual(M.acceptMatch(nr.score, nr.margin), null,
                `${name} became acceptable with an extra variant: ${nr.score.toFixed(4)} / ${nr.margin.toFixed(4)}`);
        }
    });
}

/* ────────────────────────────────────────────────────────────────────────────
 * The main menu (SPEC-0.3 §1)
 *
 * Same fixture-driven rule as the map matcher: `menu-*.png` is a positive,
 * everything else in detection-fixtures/ is a negative. Adding another menu
 * screenshot therefore adds a test case and nothing else has to be edited.
 * ──────────────────────────────────────────────────────────────────────────── */

test('templates.json carries one menu strip template', () => {
    assert.ok(MENU, 'templates.json has no menu section — run `npm run prepare-detector`');
    assert.strictEqual(MENU.width, M.MENU_TEMPLATE_WIDTH);
    assert.strictEqual(MENU.height, M.MENU_TEMPLATE_HEIGHT);
    assert.strictEqual(MENU_TEMPLATE.length, MENU.width * MENU.height);
    assert.ok(MENU_FIXTURES.includes(MENU.source), `menu source ${MENU.source} is not a menu fixture`);
    for (const v of MENU_TEMPLATE) assert.ok(v >= 0 && v <= 1, `menu template value ${v} outside 0..1`);
    // The menu must never be a candidate in the map match.
    assert.ok(!Object.prototype.hasOwnProperty.call(TEMPLATE_FILE.templates, 'menu'));
});

test('the menu template reproduces from its fixture (prepare-detector is idempotent)', async () => {
    const built = await buildMenuTemplate();
    assert.ok(built, 'no menu fixture');
    for (let i = 0; i < MENU_TEMPLATE.length; i++) {
        assert.ok(Math.abs(MENU_TEMPLATE[i] - built.thumb[i]) <= 0.0006,
            `menu[${i}]: stored ${MENU_TEMPLATE[i]} vs rebuilt ${built.thumb[i]}`);
    }
});

for (const name of MENU_FIXTURES) {
    test(`menu: ${name} is recognised as the main menu`, async () => {
        const f = await loadFrame(fixture(name));
        const r = recordMenu(name, 'menu', M.matchMenu(f.gray, f.width, f.height, MENU_TEMPLATE, MENU_OPTS));
        assert.ok(r.accepted, `score ${r.score.toFixed(4)} < ${M.MENU_MIN_SCORE}`);
    });
}

for (const name of MENU_NEGATIVE_FIXTURES) {
    test(`menu negative: ${name} is not the main menu`, async () => {
        const f = await loadFrame(fixture(name));
        const r = recordMenu(name, 'not menu', M.matchMenu(f.gray, f.width, f.height, MENU_TEMPLATE, MENU_OPTS));
        assert.ok(!r.accepted, `score ${r.score.toFixed(4)} >= ${M.MENU_MIN_SCORE}`);
    });
}

// The runtime never sees a native-resolution frame: it matches a 640 px wide
// reduction of the game window, whatever the game is actually running at.
for (const [w, h] of [[1920, 1080], [1280, 720], [2560, 1440], [640, 360]]) {
    for (const name of MENU_FIXTURES) {
        test(`menu: ${name} rescaled to ${w}x${h} is still the main menu`, async () => {
            const f = await rescaled(name, w, h);
            const r = recordMenu(`${name} @ ${w}x${h}`, 'menu',
                M.matchMenu(f.gray, f.width, f.height, MENU_TEMPLATE, MENU_OPTS));
            assert.ok(r.accepted, `score ${r.score.toFixed(4)} < ${M.MENU_MIN_SCORE}`);
        });
    }
}

test('menu: the strip survives the runtime capture path', async () => {
    // toGrayScaled straight off raw window pixels, exactly like a tick.
    const buf = await sharp(fixture(MENU_FIXTURES[0])).resize(1920, 1080, {fit: 'fill'}).png().toBuffer();
    const {data, info} = await sharp(buf).ensureAlpha().raw().toBuffer({resolveWithObject: true});
    const outW = 640, outH = Math.round(640 * info.height / info.width);
    const gray = M.toGrayScaled(data, info.width, info.height, outW, outH, 'rgba');
    const r = recordMenu(`${MENU_FIXTURES[0]} → ${outW}x${outH} (runtime path)`, 'menu',
        M.matchMenu(gray, outW, outH, MENU_TEMPLATE, MENU_OPTS));
    assert.ok(r.accepted, `score ${r.score.toFixed(4)} < ${M.MENU_MIN_SCORE}`);
    // ...and the same frame must not look like a map.
    assert.strictEqual(M.matchMap(gray, outW, outH, TEMPLATES), null);
});

test('menu: the positives clear the negatives by a wide margin', async () => {
    let worstPositive = Infinity;
    for (const name of MENU_FIXTURES) {
        const f = await loadFrame(fixture(name));
        worstPositive = Math.min(worstPositive, M.matchMenu(f.gray, f.width, f.height, MENU_TEMPLATE, MENU_OPTS).score);
    }
    let bestNegative = -Infinity;
    for (const name of MENU_NEGATIVE_FIXTURES) {
        const f = await loadFrame(fixture(name));
        bestNegative = Math.max(bestNegative, M.matchMenu(f.gray, f.width, f.height, MENU_TEMPLATE, MENU_OPTS).score);
    }
    // The threshold has to sit inside the gap, not at one edge of it: the
    // selected tab's highlight box slides along the strip and only one menu
    // screenshot exists to measure that from.
    assert.ok(worstPositive > M.MENU_MIN_SCORE + 0.15,
        `worst positive ${worstPositive.toFixed(4)} is too close to ${M.MENU_MIN_SCORE}`);
    assert.ok(bestNegative < M.MENU_MIN_SCORE - 0.15,
        `best negative ${bestNegative.toFixed(4)} is too close to ${M.MENU_MIN_SCORE}`);
});

test('menu: no template means no menu, never a crash', () => {
    const flat = new Float32Array(640 * 360);
    for (const empty of [null, undefined, [], new Float32Array(0)]) {
        const r = M.matchMenu(flat, 640, 360, empty, MENU_OPTS);
        assert.strictEqual(r.accepted, false, String(empty));
        assert.strictEqual(r.score, -1);
    }
});

test('menu: gradientMagnitude handles a non-square thumbnail', () => {
    // A 4x2 ramp: the square form would read it as 2x2 (sqrt of the length)
    // and silently mis-index every row.
    const a = Float32Array.from([0, 1, 2, 3, 3, 2, 1, 0]);
    const g = M.gradientMagnitude(a, 4, 2);
    assert.strictEqual(g.length, 8);
    for (const v of g) assert.ok(Number.isFinite(v) && v >= 0, String(v));
    // The square call still works the way the map templates use it.
    const sq = M.gradientMagnitude(Float32Array.from({length: 16}, (_, i) => i), 4);
    assert.strictEqual(sq.length, 16);
    assert.deepStrictEqual(Array.from(M.gradientMagnitude(a, 4, 2)), Array.from(g));
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
