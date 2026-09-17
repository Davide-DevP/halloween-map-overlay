/**
 * Dev-only: build `src/core/map-detector/templates.json` from the cropped Tab
 * screenshots in `detection-fixtures/`.
 *
 * Run with `npm run prepare-detector`. The output is committed; the app never
 * runs this and `sharp` stays a devDependency.
 *
 * ## How the map panel is located
 *
 * The four `tab-<map>.png` fixtures are the two Tab-screen panels at native
 * scale, but each was cropped by hand, so their offsets differ by up to 10 px
 * (and all four cut a few pixels off the panel's own frame). Hard-coding one
 * offset would mis-register three of the four templates, so the panel is found
 * in every image instead, from two features the game draws at fixed positions:
 *
 *   1. the map panel's left frame line — a 1 px line of luminance 21 then 28
 *      on an otherwise black panel, the last such vertical line in the image;
 *   2. the map-name box's top frame line — luminance 67 then 86, the first
 *      bright row inside the left panel.
 *
 * In the uncropped fixture (`tab-fullscreen-haddonfield-heights.png`, 1919x1078)
 * those sit at x 875/876 and y 160/161, and the map panel interior is
 * x 877..1662, y 147..932. Finding them in a crop therefore gives the crop's
 * offset from full-screen coordinates, and the same 766x766 region the runtime
 * matcher uses (`MAP_PANEL_REL`, the interior inset by 10 px) can be cut out of
 * it. `test/map-detector.test.js` re-uses `locatePanel()` from here, so the
 * tests measure the crops rather than trusting a constant.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const {toGray, downsample, DEFAULT_SIZE} = require('../src/core/map-detector/matcher');
const {buildCatalog, findClosestMapMatch} = require('../src/core/map-catalog');
const {getFilesFromDir} = require('../src/core/utils');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(ROOT, 'detection-fixtures');
const MAPS = path.join(ROOT, 'maps');
const OUT_FILE = path.join(ROOT, 'src', 'core', 'map-detector', 'templates.json');

/** Reference positions in the uncropped 1919x1078 Tab screenshot. */
const REF = {
    panelLeftInterior: 877,   // first column inside the map panel frame
    panelTopInterior: 147,    // first row inside the map panel frame
    panelSize: 786,           // the interior is an exact square
    inset: 10,                // what MAP_PANEL_REL trims off each side
    nameBoxFrameTop: 160,     // first row of the map-name box frame
    nameBoxX0: 302,           // a column band that is inside the box for any name
    nameBoxX1: 478
};

/*
 * ─── Fixture naming convention ──────────────────────────────────────────────
 *
 * Adding a map must be a data-only change, so nothing here lists the maps.
 *
 *   detection-fixtures/tab-<slug>.png             template source
 *   detection-fixtures/tab-fullscreen-<slug>.png  extra full-frame test fixture
 *   detection-fixtures/<anything-else>.png        negative fixture (expects null)
 *
 * `<slug>` is the map name lower-cased with non-alphanumerics turned into
 * hyphens ("Haddonfield Town Center" → `haddonfield-town-center`). The slug is
 * un-slugged and resolved against the real catalogue built from `maps/`, using
 * `findClosestMapMatch` — the project's single source of name matching — so the
 * creator folder comes from the map file and the key can never drift from the
 * catalogue. Both a full frame and a panel crop work as a template source;
 * `locatePanel` finds the panel either way.
 */

/** The `tab-fullscreen-…` prefix marks a full-frame fixture, not a source. */
const FULLSCREEN_PREFIX = 'tab-fullscreen-';
const TEMPLATE_PREFIX = 'tab-';

/** Every PNG in `detection-fixtures/`, sorted. */
function listFixtures() {
    return fs.readdirSync(FIXTURES).filter(f => /\.png$/i.test(f)).sort();
}

/** The catalogue as the app sees it, built from the committed `maps/` folder. */
function catalog() {
    if (!fs.existsSync(MAPS)) return [];
    return buildCatalog(getFilesFromDir(MAPS).map(file => path.relative(MAPS, file)));
}

/**
 * `tab-haddonfield-town-center.png` → `deftyconchgaming/Haddonfield Town Center`.
 * @returns {string|null} null when the fixture is not a template source or the
 *   slug matches no map in `maps/`.
 */
function keyForFixture(file, entries) {
    if (!file.startsWith(TEMPLATE_PREFIX) || file.startsWith(FULLSCREEN_PREFIX)) return null;
    const slug = file.slice(TEMPLATE_PREFIX.length).replace(/\.png$/i, '');
    const entry = findClosestMapMatch(slug.replace(/-+/g, ' '), entries || catalog());
    return entry ? entry.key : null;
}

/** Fixture file → catalogue key, for every template source that resolves. */
function templateSources() {
    const entries = catalog();
    const sources = {};
    for (const file of listFixtures()) {
        const key = keyForFixture(file, entries);
        if (key) sources[file] = key;
    }
    return sources;
}

/** Decode any PNG to a luminance frame using the matcher's own conversion. */
async function loadGray(file) {
    const {data, info} = await sharp(file).ensureAlpha().raw().toBuffer({resolveWithObject: true});
    return {gray: toGray(data, info.width, info.height, 'rgba'), width: info.width, height: info.height};
}

function columnMean(gray, width, height, x, y0, y1) {
    let s = 0;
    for (let y = y0; y < y1; y++) s += gray[y * width + x];
    return s / (y1 - y0);
}

function rowMean(gray, width, y, x0, x1) {
    let s = 0;
    for (let x = x0; x < x1; x++) s += gray[y * width + x];
    return s / (x1 - x0);
}

/**
 * Find the map panel in a Tab screenshot, cropped or not.
 *
 * @returns {{dx:number, dy:number, x:number, y:number, size:number,
 *            frameCol:number, nameBoxRow:number}}
 *   `dx`/`dy` are the crop's offset from full-screen coordinates; `x`, `y` and
 *   `size` are the region to cut (the same one `MAP_PANEL_REL` selects).
 */
function locatePanel(gray, width, height) {
    // 1. vertical frame lines, measured over the middle half of the image so
    //    map content and the objectives text cannot masquerade as a line.
    const yb0 = Math.round(height * 0.25), yb1 = Math.round(height * 0.75);
    const col = new Float64Array(width);
    for (let x = 0; x < width; x++) col[x] = columnMean(gray, width, height, x, yb0, yb1) * 255;

    // The panel frame is a *dim* line (luminance 21 then 28 out of 255). The
    // upper bound matters: when the cursor is over the map panel the game also
    // draws a near-white 1 px highlight rectangle 8 px inside the frame (two of
    // the four fixtures have it), and without the bound that line wins.
    const runs = [];
    for (let x = 4; x < width - 4; x++) {
        const neighbour = (col[x - 4] + col[x + 4]) / 2;
        if (col[x] > 14 && col[x] < 60 && col[x] > neighbour * 2.5) {
            const last = runs[runs.length - 1];
            if (last && x - last[last.length - 1] <= 2) last.push(x);
            else runs.push([x]);
        }
    }
    if (!runs.length) throw new Error('locatePanel: no panel frame line found');
    // The last vertical line in the image is the map panel's left frame: the
    // panel's right frame is cropped away in every fixture, and in the
    // uncropped screenshot the right frame is a *right* edge, whose interior
    // lies to its left — handled by taking the last run that still leaves room
    // for a panel.
    let frameRun = null;
    for (let i = runs.length - 1; i >= 0; i--) {
        const inner = runs[i][runs[i].length - 1] + 1;
        if (width - inner >= REF.panelSize * 0.9) { frameRun = runs[i]; break; }
    }
    if (!frameRun) throw new Error('locatePanel: no left frame line with a panel behind it');
    const panelLeft = frameRun[frameRun.length - 1] + 1;
    const dx = REF.panelLeftInterior - panelLeft;

    // 2. the map-name box top frame, inside the left panel.
    const nx0 = REF.nameBoxX0 - dx, nx1 = REF.nameBoxX1 - dx;
    if (nx0 < 0 || nx1 > width) throw new Error('locatePanel: name box outside the image');
    let nameBoxRow = -1;
    const searchTo = Math.min(height, Math.round(height * 0.35));
    for (let y = 0; y < searchTo; y++) {
        if (rowMean(gray, width, y, nx0, nx1) * 255 > 40) { nameBoxRow = y; break; }
    }
    if (nameBoxRow < 0) throw new Error('locatePanel: map-name box not found');
    const dy = REF.nameBoxFrameTop - nameBoxRow;

    const x = REF.panelLeftInterior + REF.inset - dx;
    const y = REF.panelTopInterior + REF.inset - dy;
    const size = REF.panelSize - 2 * REF.inset;
    if (x < 0 || y < 0 || x + size > width || y + size > height) {
        throw new Error(`locatePanel: region ${x},${y} ${size}x${size} does not fit in ${width}x${height}`);
    }
    return {dx, dy, x, y, size, frameCol: panelLeft - 1, nameBoxRow};
}

/** Cut `size x size` out of a luminance frame at `x,y`. */
function cutSquare(gray, width, height, x, y, size) {
    const out = new Float32Array(size * size);
    for (let row = 0; row < size; row++) {
        const src = (y + row) * width + x;
        out.set(gray.subarray(src, src + size), row * size);
    }
    return out;
}

/** Fixture file → the 64x64 template thumbnail, plus where it was cut from. */
async function buildTemplate(file, size) {
    const {gray, width, height} = await loadGray(file);
    const loc = locatePanel(gray, width, height);
    const panel = cutSquare(gray, width, height, loc.x, loc.y, loc.size);
    return {thumb: downsample(panel, loc.size, loc.size, size || DEFAULT_SIZE), loc, width, height, panel};
}

async function main() {
    const debugDir = process.argv.includes('--debug')
        ? process.argv[process.argv.indexOf('--debug') + 1]
        : null;

    const sources = templateSources();
    if (!Object.keys(sources).length) {
        throw new Error(`No template fixtures found in ${FIXTURES} (expected detection-fixtures/tab-<slug>.png)`);
    }

    const templates = {};
    for (const [file, key] of Object.entries(sources)) {
        const full = path.join(FIXTURES, file);
        if (templates[key]) {
            console.warn(`  ! ${file} also resolves to ${key}; keeping the first fixture.`);
            continue;
        }
        const {thumb, loc, panel} = await buildTemplate(full);
        // 3 decimals: 0.001 of a luminance step is far below anything NCC can
        // notice, and it keeps the committed file at ~20 KB per map.
        templates[key] = Array.from(thumb, v => Math.round(v * 1000) / 1000);
        console.log(`${file.padEnd(34)} ${loc.size}x${loc.size} at ${loc.x},${loc.y}  (dx=${loc.dx} dy=${loc.dy})  -> ${key}`);

        if (debugDir) {
            const bytes = Buffer.from(Array.from(panel, v => Math.max(0, Math.min(255, Math.round(v * 255)))));
            await sharp(bytes, {raw: {width: loc.size, height: loc.size, channels: 1}})
                .png().toFile(path.join(debugDir, 'panel-' + file));
            const tbytes = Buffer.from(Array.from(thumb, v => Math.max(0, Math.min(255, Math.round(v * 255)))));
            await sharp(tbytes, {raw: {width: DEFAULT_SIZE, height: DEFAULT_SIZE, channels: 1}})
                .resize(256, 256, {kernel: 'nearest'}).png().toFile(path.join(debugDir, 'thumb-' + file));
        }
    }

    // Sorted keys + a stable 2-space format: re-running the script on an
    // unchanged fixture set must produce a byte-identical file.
    const ordered = {};
    for (const key of Object.keys(templates).sort()) ordered[key] = templates[key];
    const payload = {
        size: DEFAULT_SIZE,
        note: 'Generated by scripts/prepare-detector.js from detection-fixtures/. Do not edit by hand.',
        templates: ordered
    };
    fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
    console.log(`\nWrote ${path.relative(ROOT, OUT_FILE)} (${Object.keys(ordered).length} templates, ${DEFAULT_SIZE}x${DEFAULT_SIZE})`);
}

module.exports = {
    locatePanel, loadGray, cutSquare, buildTemplate,
    listFixtures, catalog, keyForFixture, templateSources,
    REF, FIXTURES, MAPS, TEMPLATE_PREFIX, FULLSCREEN_PREFIX
};

if (require.main === module) {
    main().catch(err => { console.error(err); process.exit(1); });
}
