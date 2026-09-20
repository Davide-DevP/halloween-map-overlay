const {test} = require('node:test');
const assert = require('node:assert');
const path = require('path');
const sharp = require('sharp');

const M = require('../src/core/map-detector/matcher');
const TEMPLATE_FILE = require('../src/core/map-detector/templates.json');
const {FIXTURES, listFixtures, TEMPLATE_PREFIX, FULLSCREEN_PREFIX} = require('../scripts/prepare-detector');

/**
 * Tab-map mode's fast check, and the two regions it draws on.
 *
 * The fast check has one job — "is the Tab screen still up?", every 150 ms —
 * and its whole value is being cheap: measured 1.40 ms of blocking JS against
 * the ordinary tick's 5.5 ms, by reading the gate straight off the raw RGBA
 * buffer instead of reducing the frame to 640 px wide first. That is only safe
 * while it gives the *same verdict* as the path the whole detector test suite
 * validates, which is what this file asserts, fixture by fixture.
 */

const TEMPLATES = {};
for (const [key, values] of Object.entries(TEMPLATE_FILE.templates)) {
    TEMPLATES[key] = M.templateVariants(values);
}

const fixture = name => path.join(FIXTURES, name);
const FIXTURE_FILES = listFixtures();
/*
 * The same split `test/map-detector.test.js` uses for the gate, and for the
 * same reason: the gate's regions are fractions of a **full frame**, so only
 * `tab-fullscreen-*` fixtures are gate positives. `tab-<slug>.png` files are
 * hand-made crops of the two panels — template sources, not frames — and are
 * neither a positive nor a negative here.
 */
const TAB_FIXTURES = FIXTURE_FILES.filter(f => f.startsWith(FULLSCREEN_PREFIX));
const OTHER_FIXTURES = FIXTURE_FILES.filter(f => !f.startsWith(TEMPLATE_PREFIX));

async function loadRaw(file) {
    const {data, info} = await sharp(file).ensureAlpha().raw().toBuffer({resolveWithObject: true});
    return {raw: data, width: info.width, height: info.height};
}

/* ────────────────────────────────────────────────────────────────────────────
 * The regions Tab-map mode draws on
 * ──────────────────────────────────────────────────────────────────────────── */

test('TAB_PANEL_REL is the un-inset 786x786 square the measurement describes', () => {
    // MAP_PANEL_REL is that square inset 10 px, because a *template* must not
    // contain the cursor highlight or the fixtures' crop differences. Tab mode
    // draws **onto** the square and the maps' `tab` transforms are fractions of
    // the full interior, so it needs the un-inset one. Two names, one
    // measurement — and a test that they really are the same rectangle.
    const inset = 10;
    const frameW = 1919, frameH = 1078;
    assert.strictEqual(Math.round(M.TAB_PANEL_REL.x * frameW), 877);
    assert.strictEqual(Math.round(M.TAB_PANEL_REL.y * frameH), 147);
    assert.strictEqual(Math.round(M.TAB_PANEL_REL.w * frameW), 786);
    assert.strictEqual(Math.round(M.TAB_PANEL_REL.h * frameH), 786);
    // …and it contains MAP_PANEL_REL with exactly the documented inset.
    assert.strictEqual(Math.round((M.MAP_PANEL_REL.x - M.TAB_PANEL_REL.x) * frameW), inset);
    assert.strictEqual(Math.round((M.MAP_PANEL_REL.y - M.TAB_PANEL_REL.y) * frameH), inset);
    assert.strictEqual(Math.round((M.TAB_PANEL_REL.w - M.MAP_PANEL_REL.w) * frameW), inset * 2);
    assert.strictEqual(Math.round((M.TAB_PANEL_REL.h - M.MAP_PANEL_REL.h) * frameH), inset * 2);
});

test('the panel square really is square on a 16:9 frame', () => {
    // It is expressed as two separate fractions (of the width and of the
    // height) because every region in this project is; on the aspect ratio the
    // game is played at they have to come out equal, or a marker would be
    // displaced along one axis in proportion to how far out they are.
    //
    // They are not *exactly* equal: the fixture the square was measured on is
    // 1919x1078, which is 1.7801:1 rather than 16:9 = 1.7778:1. That is 0.13 %,
    // i.e. one pixel on the 786 px panel at 1080p and two at 4K — well under
    // the width of a bracket stroke, and the same rounding every other region
    // in `matcher.js` carries.
    for (const [w, h] of [[1920, 1080], [1280, 720], [2560, 1440], [3840, 2160]]) {
        const pw = M.TAB_PANEL_REL.w * w;
        const ph = M.TAB_PANEL_REL.h * h;
        assert.ok(Math.abs(pw - ph) / pw < 0.002, `${w}x${h}: ${pw.toFixed(1)} x ${ph.toFixed(1)}`);
    }
});

test('the legend sits inside the game\'s own left panel, below the objectives', () => {
    const legend = M.TAB_LEGEND_REL;
    const panel = M.LEFT_PANEL_REL;
    // Inside the left (objectives) panel horizontally…
    assert.ok(legend.x >= panel.x, 'legend starts left of the panel');
    assert.ok(legend.x + legend.w <= panel.x + panel.w, 'legend runs past the panel');
    // …and in its lower half, so it cannot land on the objectives list.
    assert.ok(legend.y > panel.y + panel.h / 2, 'legend is not in the lower half');
    assert.ok(legend.y + legend.h <= panel.y + panel.h, 'legend runs past the bottom of the panel');
    // It must not reach the map panel, which is what the markers are drawn on.
    assert.ok(legend.x + legend.w <= M.TAB_PANEL_REL.x, 'legend overlaps the map panel');
});

/* ────────────────────────────────────────────────────────────────────────────
 * The raw-buffer gate
 * ──────────────────────────────────────────────────────────────────────────── */

test('rawRegionFraction equals the luminance path on every fixture', async () => {
    // The fast check multiplies the threshold by 255 instead of dividing every
    // pixel by it. Same arithmetic, so the two have to agree exactly.
    for (const name of FIXTURE_FILES) {
        const {raw, width, height} = await loadRaw(fixture(name));
        const gray = M.toGray(raw, width, height, 'rgba');
        const features = M.tabScreenFeatures(gray, width, height);
        const dark = M.rawRegionFraction(raw, width, height, M.LEFT_PANEL_REL,
            M.GATE_DARK_LEVEL, true, 'rgba');
        const bright = M.rawRegionFraction(raw, width, height, M.NAME_BOX_REL,
            M.GATE_NAME_BOX_LEVEL, false, 'rgba');
        assert.ok(Math.abs(dark - features.darkFraction) < 1e-9,
            `${name}: dark ${dark} vs ${features.darkFraction}`);
        assert.ok(Math.abs(bright - features.nameBoxFraction) < 1e-9,
            `${name}: bright ${bright} vs ${features.nameBoxFraction}`);
    }
});

test('tabGateFromRaw agrees with TAB_SCREEN_GATE, fixture by fixture', async () => {
    assert.ok(TAB_FIXTURES.length > 0 && OTHER_FIXTURES.length > 0, 'no fixtures');
    for (const name of FIXTURE_FILES) {
        const {raw, width, height} = await loadRaw(fixture(name));
        const gray = M.toGray(raw, width, height, 'rgba');
        assert.strictEqual(
            M.tabGateFromRaw(raw, width, height, 'rgba'),
            M.TAB_SCREEN_GATE(gray, width, height),
            name);
    }
});

test('the fast gate passes every Tab screen and no other screen', async () => {
    // The same assertion the ordinary gate carries, made directly against the
    // path Tab-map mode actually runs — including the four killer-view frames
    // with the game's own discovered-exit icons drawn on the map.
    for (const name of TAB_FIXTURES) {
        const {raw, width, height} = await loadRaw(fixture(name));
        assert.ok(M.tabGateFromRaw(raw, width, height, 'rgba'), `${name} gated out`);
    }
    for (const name of OTHER_FIXTURES) {
        const {raw, width, height} = await loadRaw(fixture(name));
        assert.ok(!M.tabGateFromRaw(raw, width, height, 'rgba'), `${name} passed the gate`);
    }
});

test('the discovered-exit frames still pass the gate with room to spare', async () => {
    // Why one negative gate is enough to hide (see HIDE_AFTER_NEGATIVE): a
    // false negative on a real Tab screen barely exists. These are the hardest
    // real Tab screens there are — the game is drawing its own icons on the
    // map — and they clear both thresholds by a wide margin.
    const found = TAB_FIXTURES.filter(f => f.includes('killer-found-'));
    assert.strictEqual(found.length, 4, 'the four discovered-exit fixtures are missing');
    for (const name of found) {
        const {raw, width, height} = await loadRaw(fixture(name));
        const gray = M.toGray(raw, width, height, 'rgba');
        const f = M.tabScreenFeatures(gray, width, height);
        assert.ok(f.darkFraction >= 0.98, `${name}: darkFraction ${f.darkFraction.toFixed(4)}`);
        assert.ok(f.nameBoxFraction >= 0.05, `${name}: nameBoxFraction ${f.nameBoxFraction.toFixed(4)}`);
        // …and the map is still recognised, with its Michael-view template
        // unchanged. No threshold moved for these.
        const r = M.matchMap(gray, width, height, TEMPLATES, {report: true});
        assert.ok(r.accepted, `${name}: score ${r.score.toFixed(4)} margin ${r.margin.toFixed(4)}`);
        assert.strictEqual(r.acceptedBy, 'score', name);
        assert.ok(r.score >= 0.9, `${name}: score ${r.score.toFixed(4)}`);
        assert.ok(r.margin >= 0.4, `${name}: margin ${r.margin.toFixed(4)}`);
    }
});

test('tabGateFromRaw handles both channel orders and refuses a short buffer', () => {
    // A 2x2 all-black frame: the left panel is dark, the name box is not
    // bright, so the gate says no — in either order, with the same numbers.
    const rgba = new Uint8Array(2 * 2 * 4);
    assert.strictEqual(M.tabGateFromRaw(rgba, 2, 2, 'rgba'), false);
    assert.strictEqual(M.tabGateFromRaw(rgba, 2, 2, 'bgra'), false);
    assert.throws(() => M.tabGateFromRaw(new Uint8Array(8), 4, 4, 'rgba'), /expected 64 bytes/);
    assert.throws(() => M.rawRegionFraction(new Uint8Array(8), 4, 4, M.NAME_BOX_REL, 0.5, true, 'rgba'),
        /expected 64 bytes/);
});

test('the left panel is tested first, so an ordinary frame early-outs', async () => {
    // The gate reads 21.9 % of the frame at worst and the left panel alone
    // (19.3 %) on the frames there are most of. Asserted through the counts
    // rather than through timings, which are not reproducible in CI.
    const {raw, width, height} = await loadRaw(fixture('gameplay-killer.png'));
    const gray = M.toGray(raw, width, height, 'rgba');
    const f = M.tabScreenFeatures(gray, width, height);
    // Gameplay fails on darkness, which is the test that comes first.
    assert.ok(f.darkFraction < M.GATE_MIN_DARK_FRACTION,
        `darkFraction ${f.darkFraction} would not early-out`);
    assert.strictEqual(M.tabGateFromRaw(raw, width, height, 'rgba'), false);
});

/* ────────────────────────────────────────────────────────────────────────────
 * matchMap without `report`
 * ──────────────────────────────────────────────────────────────────────────── */

test('matchMap without `report` returns the match, or null, and never throws', async () => {
    // This path used to read an undeclared `accepted` and throw a
    // ReferenceError for any frame that got as far as a best match. It was
    // latent because every production caller passes `report: true` and the
    // suite's own negatives all return at the gate — so it needs its own test.
    const {raw, width, height} = await loadRaw(fixture('tab-fullscreen-haddonfield-heights.png'));
    const gray = M.toGray(raw, width, height, 'rgba');

    const accepted = M.matchMap(gray, width, height, TEMPLATES);
    assert.ok(accepted, 'a Tab screen with a known map returned null');
    assert.strictEqual(typeof accepted.key, 'string');
    assert.strictEqual(accepted.accepted, true);
    assert.strictEqual(accepted.acceptedBy, 'score');

    // Same frame, thresholds raised past it: a real best match that is not
    // acceptable. This is the exact case that threw.
    assert.strictEqual(
        M.matchMap(gray, width, height, TEMPLATES, {minScore: 1.1, marginMinScore: 1.1}),
        null);
    // …and with the gate off, so the return is reached by the other route too.
    assert.strictEqual(
        M.matchMap(gray, width, height, TEMPLATES, {gate: false, minScore: 1.1, marginMinScore: 1.1}),
        null);
    // No templates at all: null, not a throw.
    assert.strictEqual(M.matchMap(gray, width, height, {}), null);
    assert.strictEqual(M.matchMap(gray, width, height, {}, {gate: false}), null);
});
