const {test} = require('node:test');
const assert = require('node:assert');
const path = require('path');
const sharp = require('sharp');

const M = require('../src/core/map-detector/matcher');
const TEMPLATE_FILE = require('../src/core/map-detector/templates.json');
const {FIXTURES, listFixtures} = require('../scripts/prepare-detector');

/*
 * The detector tick was made much cheaper (see docs/agents/detection.md): the
 * Tab gate now runs on the raw capture, luminance is produced only for the
 * region the matcher actually samples, and every template's gradient and NCC
 * statistics are computed once at load instead of once per tick.
 *
 * None of that is allowed to move a single score. The thresholds in
 * `matcher.js` were derived from measured separations of a few hundredths —
 * 0.15 rather than 0.20 for the margin branch, because one fixture measured
 * 0.196 — so "close enough" is not a thing here: a change of 1e-6 in the wrong
 * place is a different accept/reject decision on somebody's screen.
 *
 * So this file runs the OLD pipeline and the NEW one over every committed
 * fixture at four resolutions and asserts they agree **exactly**: gate verdict,
 * every per-map score, the winner, the margin, `acceptedBy`, `panelMean`, and
 * the menu verdict.
 */

const SIZE = TEMPLATE_FILE.size;
const RAW_TEMPLATES = {};
for (const [key, values] of Object.entries(TEMPLATE_FILE.templates)) RAW_TEMPLATES[key] = values;
const PREPARED = M.prepareTemplates(RAW_TEMPLATES, SIZE);

const MENU = TEMPLATE_FILE.menu || null;
const MENU_TEMPLATE = MENU && Array.isArray(MENU.template) ? Float32Array.from(MENU.template) : null;
const MENU_OPTS = MENU ? {width: MENU.width, height: MENU.height} : {};
const MENU_PREPARED = M.prepareMenuTemplate(MENU_TEMPLATE, MENU && MENU.width, MENU && MENU.height);

const FIXTURE_FILES = listFixtures();
const RESOLUTIONS = [null, [1280, 720], [2560, 1440], [640, 360]];
const CAPTURE_WIDTH = 640;

/** A fixture as RGBA bytes, at its own size or resampled. */
async function rawFrame(file, size) {
    let image = sharp(path.join(FIXTURES, file));
    if (size) image = image.resize(size[0], size[1], {fit: 'fill'});
    const {data, info} = await image.ensureAlpha().raw().toBuffer({resolveWithObject: true});
    return {raw: data, width: info.width, height: info.height};
}

/**
 * What the tick used to do: reduce the whole frame, then gate and match.
 *
 * The match runs with `gate: false` so that **every** fixture produces a full
 * score table, including the ones the gate throws away. A gated-out frame never
 * reaches the matcher at runtime, but its scores are exactly where a silent
 * arithmetic change would hide, so they are compared too.
 */
function oldPipeline(frame) {
    const outWidth = CAPTURE_WIDTH;
    const outHeight = Math.max(1, Math.round(CAPTURE_WIDTH * frame.height / frame.width));
    const gray = M.toGrayScaled(frame.raw, frame.width, frame.height, outWidth, outHeight, 'rgba');
    const gate = M.TAB_SCREEN_GATE(gray, outWidth, outHeight);
    const match = M.matchMap(gray, outWidth, outHeight, RAW_TEMPLATES,
        {size: SIZE, report: true, gate: false});
    const menu = MENU_TEMPLATE
        ? M.matchMenu(gray, outWidth, outHeight, MENU_TEMPLATE, MENU_OPTS)
        : null;
    return {gray, outWidth, outHeight, gate, match, menu};
}

/** What it does now: raw gate, then luminance for one region only. */
function newPipeline(frame) {
    const outWidth = CAPTURE_WIDTH;
    const outHeight = Math.max(1, Math.round(CAPTURE_WIDTH * frame.height / frame.width));
    const gate = M.tabGateFromRaw(frame.raw, frame.width, frame.height, 'rgba');

    const panelBox = M.regionSearchBox(outWidth, outHeight, M.MAP_PANEL_REL, M.DEFAULT_OFFSETS);
    const panelData = M.toGrayScaledRegion(frame.raw, frame.width, frame.height,
        outWidth, outHeight, 'rgba', panelBox);
    const panelWindow = M.frameWindow(panelData, outWidth, outHeight, panelBox);
    const match = M.matchMap(null, outWidth, outHeight, PREPARED,
        {size: SIZE, report: true, gate: false, window: panelWindow});

    let menu = null;
    if (MENU_TEMPLATE) {
        const menuBox = M.regionSearchBox(outWidth, outHeight, M.MENU_STRIP_REL, M.MENU_OFFSETS);
        const menuData = M.toGrayScaledRegion(frame.raw, frame.width, frame.height,
            outWidth, outHeight, 'rgba', menuBox);
        const menuWindow = M.frameWindow(menuData, outWidth, outHeight, menuBox);
        menu = M.matchMenu(null, outWidth, outHeight, MENU_TEMPLATE,
            Object.assign({}, MENU_OPTS, {window: menuWindow, prepared: MENU_PREPARED}));
    }
    return {gate, match, menu};
}

/* ────────────────────────────────────────────────────────────────────────────
 * The primitives
 * ──────────────────────────────────────────────────────────────────────────── */

test('toGrayScaledRegion is a bit-identical subset of toGrayScaled', async () => {
    // Both code paths: 1919x1078 is the fractional-weight one, 1920x1080 the
    // exact 3:1 fast path. They are different loops, so both are checked.
    for (const size of [null, [1920, 1080], [1280, 720]]) {
        const frame = await rawFrame('tab-fullscreen-haddonfield-heights.png', size);
        const outWidth = CAPTURE_WIDTH;
        const outHeight = Math.max(1, Math.round(CAPTURE_WIDTH * frame.height / frame.width));
        const full = M.toGrayScaled(frame.raw, frame.width, frame.height, outWidth, outHeight, 'rgba');
        for (const box of [
            M.regionSearchBox(outWidth, outHeight, M.MAP_PANEL_REL, M.DEFAULT_OFFSETS),
            M.regionSearchBox(outWidth, outHeight, M.MENU_STRIP_REL, M.MENU_OFFSETS),
            {x: 0, y: 0, width: outWidth, height: outHeight},
            {x: 7, y: 3, width: 11, height: 5}
        ]) {
            const part = M.toGrayScaledRegion(frame.raw, frame.width, frame.height,
                outWidth, outHeight, 'rgba', box);
            for (let y = 0; y < box.height; y++) {
                for (let x = 0; x < box.width; x++) {
                    const a = full[(box.y + y) * outWidth + (box.x + x)];
                    const b = part[y * box.width + x];
                    assert.strictEqual(b, a,
                        `${size ? size.join('x') : 'native'} cell ${box.x + x},${box.y + y}`);
                }
            }
        }
    }
});

test('regionSearchBox contains every crop the alignment search takes', () => {
    for (const [w, h] of [[640, 360], [640, 359], [320, 180]]) {
        for (const [region, offsets] of [
            [M.MAP_PANEL_REL, M.DEFAULT_OFFSETS],
            [M.MENU_STRIP_REL, M.MENU_OFFSETS]
        ]) {
            const box = M.regionSearchBox(w, h, region, offsets);
            assert.ok(box.width > 0 && box.height > 0);
            for (const offset of offsets) {
                const shifted = {x: region.x + offset.dx, y: region.y + offset.dy, w: region.w, h: region.h};
                const rect = M.regionCropRect(w, h, shifted);
                assert.ok(rect.x >= box.x && rect.y >= box.y
                    && rect.x + rect.width <= box.x + box.width
                    && rect.y + rect.height <= box.y + box.height,
                    `${w}x${h} offset ${offset.dx},${offset.dy} escapes the search box`);
            }
            // …and it is not simply the whole frame: the saving is the point.
            assert.ok(box.width * box.height < w * h * 0.75, `${w}x${h}: box is not smaller`);
        }
    }
});

test('nccWith equals ncc, exactly', () => {
    // Deterministic signals of the shapes the matcher really uses, including
    // the degenerate ones (`ncc` answers 0 for a constant signal rather than
    // NaN, and the prepared form has to agree).
    const make = (n, fn) => Float32Array.from({length: n}, (_, i) => fn(i));
    const cases = [
        [make(4096, i => Math.sin(i * 0.031) * 0.5 + 0.5), make(4096, i => Math.cos(i * 0.017) * 0.4 + 0.5)],
        [make(4096, i => (i % 64) / 64), make(4096, i => ((i * 7) % 64) / 64)],
        [make(1152, i => i / 1152), make(1152, i => 1 - i / 1152)],
        [make(64, () => 0.5), make(64, i => i / 64)],
        [make(64, i => i / 64), make(64, () => 0.25)],
        [make(64, () => 0.5), make(64, () => 0.5)]
    ];
    for (const [a, b] of cases) {
        assert.strictEqual(M.nccWith(a, M.nccStats(a), b, M.nccStats(b)), M.ncc(a, b));
    }
});

test('prepareTemplates keeps the same variants, gradients and statistics', () => {
    const keys = Object.keys(RAW_TEMPLATES);
    assert.deepStrictEqual(Object.keys(PREPARED).sort(), keys.slice().sort());
    for (const key of keys) {
        const raw = M.templateVariants(RAW_TEMPLATES[key]);
        const prepared = PREPARED[key].variants;
        assert.strictEqual(prepared.length, raw.length, key);
        for (let i = 0; i < raw.length; i++) {
            assert.deepStrictEqual(Array.from(prepared[i].tpl), Array.from(raw[i]), `${key}[${i}] thumbnail`);
            const grad = M.gradientMagnitude(raw[i], SIZE);
            assert.deepStrictEqual(Array.from(prepared[i].grad), Array.from(grad), `${key}[${i}] gradient`);
            assert.deepStrictEqual(prepared[i].tplStats, M.nccStats(raw[i]), `${key}[${i}] stats`);
            assert.deepStrictEqual(prepared[i].gradStats, M.nccStats(grad), `${key}[${i}] gradient stats`);
        }
    }
    // `templateVariants` still answers for a prepared entry, so nothing that
    // reads the thumbnails has to know which shape it was handed.
    for (const key of keys) {
        assert.deepStrictEqual(
            M.templateVariants(PREPARED[key]).map(v => Array.from(v)),
            M.templateVariants(RAW_TEMPLATES[key]).map(v => Array.from(v)), key);
    }
});

/* ────────────────────────────────────────────────────────────────────────────
 * The whole pipeline, fixture by fixture
 * ──────────────────────────────────────────────────────────────────────────── */

for (const file of FIXTURE_FILES) {
    for (const size of RESOLUTIONS) {
        const label = `${file} @ ${size ? size.join('x') : 'native'}`;
        test(`identical decisions: ${label}`, async () => {
            const frame = await rawFrame(file, size);
            const before = oldPipeline(frame);
            const after = newPipeline(frame);

            // The gate: same verdict, from the raw buffer instead of the
            // reduced frame.
            assert.strictEqual(after.gate, before.gate, `${label}: gate verdict`);

            // Every per-map score, to the last bit.
            assert.deepStrictEqual(Object.keys(after.match.scores).sort(),
                Object.keys(before.match.scores).sort(), `${label}: scored keys`);
            for (const key of Object.keys(before.match.scores)) {
                assert.strictEqual(after.match.scores[key], before.match.scores[key],
                    `${label}: score for ${key}`);
            }
            for (const field of ['key', 'score', 'second', 'margin', 'acceptedBy', 'accepted', 'panelMean']) {
                assert.strictEqual(after.match[field], before.match[field], `${label}: ${field}`);
            }

            if (before.menu) {
                assert.strictEqual(after.menu.score, before.menu.score, `${label}: menu score`);
                assert.strictEqual(after.menu.accepted, before.menu.accepted, `${label}: menu verdict`);
            }
        });
    }
}

test('the prepared templates do not change matchMap on the full-frame path', async () => {
    // The two changes are independent: this one isolates "prepared templates"
    // from "windowed frame", so a failure says which.
    for (const file of FIXTURE_FILES) {
        const frame = await rawFrame(file, null);
        const outWidth = CAPTURE_WIDTH;
        const outHeight = Math.max(1, Math.round(CAPTURE_WIDTH * frame.height / frame.width));
        const gray = M.toGrayScaled(frame.raw, frame.width, frame.height, outWidth, outHeight, 'rgba');
        const raw = M.matchMap(gray, outWidth, outHeight, RAW_TEMPLATES, {size: SIZE, report: true});
        const prep = M.matchMap(gray, outWidth, outHeight, PREPARED, {size: SIZE, report: true});
        assert.deepStrictEqual(prep.scores, raw.scores, `${file}: scores`);
        assert.strictEqual(prep.key, raw.key, `${file}: key`);
        assert.strictEqual(prep.margin, raw.margin, `${file}: margin`);
        assert.strictEqual(prep.acceptedBy, raw.acceptedBy, `${file}: acceptedBy`);
    }
});
