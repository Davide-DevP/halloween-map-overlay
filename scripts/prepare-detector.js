/**
 * Dev-only (`npm run prepare-detector`): build the committed
 * `src/core/map-detector/templates.json` from the Tab screenshots in
 * `detection-fixtures/`. The app never runs this, so `sharp` stays a
 * devDependency. The map panel is **located in every image**, never at a
 * hard-coded offset, because the fixtures are hand-cropped — see "Locating the
 * map panel in a fixture" in `docs/agents/maps-authoring.md`. The tests re-use
 * `locatePanel()` from here, so they measure the crops rather than a constant.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const {
    toGray, downsample, DEFAULT_SIZE, matchMap, templateVariants,
    menuThumbnail, MENU_TEMPLATE_WIDTH, MENU_TEMPLATE_HEIGHT
} = require('../src/core/map-detector/matcher');
const {buildCatalog, findClosestMapMatch} = require('../src/core/map-catalog');
const {getFilesFromDir} = require('../src/core/utils');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(ROOT, 'detection-fixtures');
const MAPS = path.join(ROOT, 'maps');
const OUT_FILE = path.join(ROOT, 'src', 'core', 'map-detector', 'templates.json');

/** Measured in the uncropped 1919x1078 Tab screenshot. */
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
 * Adding a map must be a data-only change, so nothing here lists the maps: the
 * fixture *names* say what each file is, and the slug is resolved against the
 * real `maps/` catalogue. The rules are "Fixture naming rules" in
 * `docs/agents/detection.md` — do not break them. `tab-fullscreen-…` is a
 * full-frame test fixture, not a template source; `menu-…` are menu positives,
 * the first in sort order being the menu template's source.
 */
const FULLSCREEN_PREFIX = 'tab-fullscreen-';
const TEMPLATE_PREFIX = 'tab-';
const MENU_PREFIX = 'menu-';

/** Cross-score at which two maps are too alike to be separate maps. Nothing at
 * runtime reads it: a review gate, not a threshold.
 * Why: docs/agents/detection.md § Map similarity is a build-time check */
const SIMILAR_MAP_SCORE = 0.70;

function listFixtures() {
    return fs.readdirSync(FIXTURES).filter(f => /\.png$/i.test(f)).sort();
}

/** The catalogue as the app sees it, from the committed `maps/` folder. */
function catalog() {
    if (!fs.existsSync(MAPS)) return [];
    return buildCatalog(getFilesFromDir(MAPS).map(file => path.relative(MAPS, file)));
}

/** `tab-<slug>.png` → catalogue key; null when it is not a template source or
 * its slug matches no map in `maps/`. */
function keyForFixture(file, entries) {
    if (!file.startsWith(TEMPLATE_PREFIX) || file.startsWith(FULLSCREEN_PREFIX)) return null;
    const slug = file.slice(TEMPLATE_PREFIX.length).replace(/\.png$/i, '');
    const entry = findClosestMapMatch(slug.replace(/-+/g, ' '), entries || catalog());
    return entry ? entry.key : null;
}

function templateSources() {
    const entries = catalog();
    const sources = {};
    for (const file of listFixtures()) {
        const key = keyForFixture(file, entries);
        if (key) sources[file] = key;
    }
    return sources;
}

/** Catalogue key → every `tab-*` fixture that resolves to it, in sort order. A
 * map may have **more than one**: that is how a view the detector does not
 * recognise is taught to it, by dropping another fixture in and re-running. */
function templateSourcesByKey() {
    const byKey = {};
    for (const [file, key] of Object.entries(templateSources())) {
        (byKey[key] = byKey[key] || []).push(file);
    }
    return byKey;
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

/** Find the map panel in a Tab screenshot, cropped or not. `dx`/`dy` are the
 * crop's offset from full-screen coordinates; `x`, `y` and `size` are the
 * region to cut — the same one the runtime's `MAP_PANEL_REL` selects. */
function locatePanel(gray, width, height) {
    // 1. Vertical frame lines, over the middle half of the image only, so map
    //    content and the objectives text cannot masquerade as a line.
    const yb0 = Math.round(height * 0.25), yb1 = Math.round(height * 0.75);
    const col = new Float64Array(width);
    for (let x = 0; x < width; x++) col[x] = columnMean(gray, width, height, x, yb0, yb1) * 255;

    // The panel frame is a *dim* line (luminance 21 then 28 of 255); the upper
    // bound keeps the near-white highlight rectangle the game draws 8 px inside
    // the frame under the cursor from winning instead.
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
    // The last vertical line that still leaves room for a panel behind it is
    // the map panel's left frame — the right frame is cropped away in every
    // fixture, and in an uncropped frame it has no panel behind it.
    let frameRun = null;
    for (let i = runs.length - 1; i >= 0; i--) {
        const inner = runs[i][runs[i].length - 1] + 1;
        if (width - inner >= REF.panelSize * 0.9) { frameRun = runs[i]; break; }
    }
    if (!frameRun) throw new Error('locatePanel: no left frame line with a panel behind it');
    const panelLeft = frameRun[frameRun.length - 1] + 1;
    const dx = REF.panelLeftInterior - panelLeft;

    // 2. The map-name box top frame, inside the left panel.
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

/*
 * ─── Cross-scores between maps ──────────────────────────────────────────────
 * The similarity check, here for the shipped maps and in `build-pack.js` for
 * one new one. Both score through `matchMap`: never a second implementation.
 * Why: docs/agents/detection.md § Map similarity is a build-time check
 */

/** Every `tab-*` fixture mapped to the key it shows, `tab-fullscreen-*`
 * included: not template sources, but frames of a real map. */
function frameSourcesByKey() {
    const entries = catalog();
    const byKey = {};
    for (const file of listFixtures()) {
        if (!file.startsWith(TEMPLATE_PREFIX)) continue;
        const asSource = file.startsWith(FULLSCREEN_PREFIX)
            ? TEMPLATE_PREFIX + file.slice(FULLSCREEN_PREFIX.length)
            : file;
        const key = keyForFixture(asSource, entries);
        if (key) (byKey[key] = byKey[key] || []).push(file);
    }
    return byKey;
}

/** One frame's score against every key, the **higher** of two registrations:
 * the runtime path and the panel `locatePanel` finds — so no rule is needed
 * about full frame versus hand-made crop, and a warning errs high. */
function frameScores(gray, width, height, templates) {
    const at = (scores, key) => (scores && scores[key] !== undefined ? scores[key] : -Infinity);
    const direct = matchMap(gray, width, height, templates, {gate: false, report: true}).scores;
    let located = null;
    try {
        const loc = locatePanel(gray, width, height);
        const panel = cutSquare(gray, width, height, loc.x, loc.y, loc.size);
        located = matchMap(panel, loc.size, loc.size, templates,
            {region: null, gate: false, report: true}).scores;
    } catch (err) {
        /* no findable panel: the runtime registration alone */
    }
    const out = {};
    for (const key of Object.keys(templates)) out[key] = Math.max(at(direct, key), at(located, key));
    return out;
}

/** One row per frame: `{key, file, scores}`.
 * @param {Array<{key: string, file: string}>} frames `file` is a full path */
async function crossScoreRows(frames, templates) {
    const rows = [];
    for (const {key, file} of frames) {
        const {gray, width, height} = await loadGray(file);
        rows.push({key, file: path.basename(file), scores: frameScores(gray, width, height, templates)});
    }
    return rows;
}

/** One row per **stored variant** of every key: the only frame this repository
 * has of a map published as a pack, so these keep the matrix two-directional. */
function templateRows(templates, size) {
    const n = size || DEFAULT_SIZE;
    const rows = [];
    for (const key of Object.keys(templates)) {
        templateVariants(templates[key]).forEach((thumb, i) => {
            // `region: null` on a `size`-square input makes the reduction the
            // identity, so these are the matcher's own numbers.
            rows.push({
                key,
                file: `${key} · stored variant ${i + 1}`,
                scores: matchMap(thumb, n, n, templates, {region: null, gate: false, report: true}).scores
            });
        });
    }
    return rows;
}

/** The pairs of **different** maps whose cross-score reaches `threshold` either
 * way round; sorted and deduplicated, so two runs report one list.
 * @param {Array<{key: string, scores: Object<string, number>}>} rows */
function similarPairsFromRows(rows, threshold) {
    const bar = threshold === undefined ? SIMILAR_MAP_SCORE : threshold;
    const seen = new Map();
    for (const row of rows || []) {
        for (const [key, score] of Object.entries(row.scores || {})) {
            if (key === row.key || !(score >= bar)) continue;
            const pair = [row.key, key].sort();
            seen.set(pair[0] + '\n' + pair[1], pair);
        }
    }
    return [...seen.keys()].sort().map(id => seen.get(id));
}

/** The shipped maps' cross-score matrix and the pairs that reach the
 * threshold. Frames: every `tab-*` fixture, plus every stored variant. */
async function buildSimilarity(templates) {
    const frames = [];
    for (const [key, files] of Object.entries(frameSourcesByKey())) {
        if (!Object.prototype.hasOwnProperty.call(templates, key)) continue;
        for (const file of files) frames.push({key, file: path.join(FIXTURES, file)});
    }
    const rows = (await crossScoreRows(frames, templates)).concat(templateRows(templates));
    const measured = Object.keys(templates).filter(key => rows.some(row => row.key === key)).sort();
    return {threshold: SIMILAR_MAP_SCORE, measured, pairs: similarPairsFromRows(rows), rows};
}

/** The matrix, so a reviewer sees the separation, not a verdict about it. */
function printCrossScores(similar) {
    const short = key => key.split('/').pop();
    const keys = similar.measured;
    console.log(`\nCross-scores between maps (too alike at ${similar.threshold})\n`);
    console.log('  ' + 'frame'.padEnd(52) + keys.map(k => short(k).slice(0, 14).padEnd(16)).join(''));
    for (const row of similar.rows) {
        console.log('  ' + row.file.slice(0, 50).padEnd(52)
            + keys.map(k => ((k === row.key ? '*' : ' ') + row.scores[k].toFixed(4)).padEnd(16)).join(''));
    }
    if (!similar.pairs.length) {
        console.log('\n  no pair reaches the threshold: every wrong-map score is well below it');
        return;
    }
    console.log(`\n  ! TOO ALIKE: ${similar.pairs.map(p => p.join(' ~ ')).join(', ')}`);
    console.log('  ! Two shipped maps scoring this close have never been seen. Check they are not the');
    console.log('  ! same map twice, and see docs/agents/maps-authoring.md § When two maps score alike.');
}

function menuFixtures() {
    return listFixtures().filter(f => f.startsWith(MENU_PREFIX));
}

/** The menu navigation strip, as the wide thumbnail the runtime compares
 * against — through the detector's own `menuThumbnail`, so the region is never
 * measured twice. */
async function buildMenuTemplate() {
    const [file] = menuFixtures();
    if (!file) return null;
    const {gray, width, height} = await loadGray(path.join(FIXTURES, file));
    return {
        thumb: menuThumbnail(gray, width, height),
        width, height, file
    };
}

function cutSquare(gray, width, height, x, y, size) {
    const out = new Float32Array(size * size);
    for (let row = 0; row < size; row++) {
        const src = (y + row) * width + x;
        out.set(gray.subarray(src, src + size), row * size);
    }
    return out;
}

/** One fixture's template thumbnail, plus where it was cut from. */
async function buildTemplate(file, size) {
    const {gray, width, height} = await loadGray(file);
    const loc = locatePanel(gray, width, height);
    const panel = cutSquare(gray, width, height, loc.x, loc.y, loc.size);
    return {thumb: downsample(panel, loc.size, loc.size, size || DEFAULT_SIZE), loc, width, height, panel};
}

/** One map's template **variants**: one thumbnail per fixture (absolute paths),
 * in file order. **Never an average** — the civilian and Michael views of one
 * panel are different pictures, and blending them matches neither; `matchMap`
 * scores the key as the best of its variants (`docs/agents/detection.md`). */
async function buildVariantsForKey(files, size) {
    const parts = [];
    for (const file of files) {
        const built = await buildTemplate(file, size);
        parts.push({file, loc: built.loc, panel: built.panel, thumb: built.thumb});
    }
    return {variants: parts.map(p => p.thumb), parts};
}

async function main() {
    const debugDir = process.argv.includes('--debug')
        ? process.argv[process.argv.indexOf('--debug') + 1]
        : null;

    const byKey = templateSourcesByKey();
    if (!Object.keys(byKey).length) {
        throw new Error(`No template fixtures found in ${FIXTURES} (expected detection-fixtures/tab-<slug>.png)`);
    }

    const templates = {};
    for (const [key, files] of Object.entries(byKey)) {
        const {variants, parts} = await buildVariantsForKey(files.map(f => path.join(FIXTURES, f)));
        // 3 decimals: 0.001 of a luminance step is below anything NCC notices,
        // and it keeps the committed file at ~20 KB per variant.
        templates[key] = variants.map(thumb => Array.from(thumb, v => Math.round(v * 1000) / 1000));
        files.forEach((file, i) => {
            const {loc} = parts[i];
            console.log(`${file.padEnd(38)} ${loc.size}x${loc.size} at ${loc.x},${loc.y}  (dx=${loc.dx} dy=${loc.dy})  -> ${key}`
                + `  [variant ${i + 1}/${files.length}]`);
        });

        if (debugDir) {
            for (let i = 0; i < parts.length; i++) {
                const {loc, panel, thumb} = parts[i];
                const bytes = Buffer.from(Array.from(panel, v => Math.max(0, Math.min(255, Math.round(v * 255)))));
                await sharp(bytes, {raw: {width: loc.size, height: loc.size, channels: 1}})
                    .png().toFile(path.join(debugDir, 'panel-' + files[i]));
                const tbytes = Buffer.from(Array.from(thumb, v => Math.max(0, Math.min(255, Math.round(v * 255)))));
                await sharp(tbytes, {raw: {width: DEFAULT_SIZE, height: DEFAULT_SIZE, channels: 1}})
                    .resize(256, 256, {kernel: 'nearest'}).png().toFile(path.join(debugDir, 'thumb-' + files[i]));
            }
        }
    }

    // Sorted keys + a stable 2-space format: re-running the script on an
    // unchanged fixture set must produce a byte-identical file.
    const ordered = {};
    for (const key of Object.keys(templates).sort()) ordered[key] = templates[key];

    // Measured on the rounded thumbnails that are committed, and only printed:
    // nothing at runtime reads it, so nothing is written.
    printCrossScores(await buildSimilarity(ordered));

    // Its own section, not a key in `templates`: the menu must never appear in
    // the map matcher's candidate list.
    const menu = await buildMenuTemplate();
    if (menu) {
        console.log(`${menu.file.padEnd(34)} ${menu.width}x${menu.height} nav strip`
            + `  -> menu ${MENU_TEMPLATE_WIDTH}x${MENU_TEMPLATE_HEIGHT}`);
        if (debugDir) {
            const bytes = Buffer.from(Array.from(menu.thumb, v => Math.max(0, Math.min(255, Math.round(v * 255)))));
            await sharp(bytes, {raw: {width: MENU_TEMPLATE_WIDTH, height: MENU_TEMPLATE_HEIGHT, channels: 1}})
                .resize(MENU_TEMPLATE_WIDTH * 8, MENU_TEMPLATE_HEIGHT * 8, {kernel: 'nearest'})
                .png().toFile(path.join(debugDir, 'menu-strip.png'));
        }
    } else {
        console.warn('  ! no detection-fixtures/menu-*.png — the menu template will be empty.');
    }

    const payload = {
        // Format 2: `templates[key]` is a *list* of thumbnails, one per view of
        // the map panel. `templateVariants` also reads the format-1 shape.
        format: 2,
        size: DEFAULT_SIZE,
        note: 'Generated by scripts/prepare-detector.js from detection-fixtures/. Do not edit by hand.',
        templates: ordered,
        menu: menu ? {
            width: MENU_TEMPLATE_WIDTH,
            height: MENU_TEMPLATE_HEIGHT,
            source: menu.file,
            template: Array.from(menu.thumb, v => Math.round(v * 1000) / 1000)
        } : null
    };
    fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
    const variantTotal = Object.values(ordered).reduce((n, list) => n + list.length, 0);
    console.log(`\nWrote ${path.relative(ROOT, OUT_FILE)} (${Object.keys(ordered).length} templates`
        + `, ${variantTotal} variants, ${DEFAULT_SIZE}x${DEFAULT_SIZE}`
        + `${menu ? `, plus the menu strip` : ''})`);
}

module.exports = {
    locatePanel, loadGray, cutSquare, buildTemplate, buildVariantsForKey,
    listFixtures, catalog, keyForFixture, templateSources, templateSourcesByKey,
    frameSourcesByKey, frameScores, crossScoreRows, templateRows, similarPairsFromRows,
    buildSimilarity, printCrossScores,
    menuFixtures, buildMenuTemplate,
    REF, FIXTURES, MAPS, TEMPLATE_PREFIX, FULLSCREEN_PREFIX, MENU_PREFIX, SIMILAR_MAP_SCORE
};

if (require.main === module) {
    main().catch(err => { console.error(err); process.exit(1); });
}
