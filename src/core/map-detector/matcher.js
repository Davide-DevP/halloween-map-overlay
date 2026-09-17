/**
 * PURE image matcher for the automatic map detection (phase 2).
 *
 * Imports nothing — no electron, no fs, no sharp. Everything here is plain
 * arithmetic over a luminance buffer, so the whole thing is unit testable and
 * runs in well under a millisecond per frame.
 *
 * Pipeline: screen frame → grayscale → crop the in-game map panel by a
 * resolution-independent relative region → area-average down to 64x64 →
 * zero-mean normalized cross-correlation against the four bundled templates.
 *
 * ## Where the regions come from
 *
 * Measured from `detection-fixtures/tab-fullscreen-haddonfield-heights.png`
 * (1919x1078). The Tab screen draws two panels with a 1 px frame line whose
 * luminance is exactly 21/28 on an otherwise black panel, which makes the
 * frame trivial to locate by scanning column/row means:
 *
 *   left panel   frame cols 255/256 and 843/844, rows 145/146 and 933/934
 *   map panel    frame cols 875/876 and 1663/1664, rows 145/146 and 933/934
 *
 * so the map panel interior is x 877..1662, y 147..932 — an exact 786x786
 * square. The region used below is that square inset by 10 px on every side
 * (x 887..1652, y 157..922 = 766x766). The inset does two jobs: it absorbs the
 * few-pixel differences between the four cropped fixtures, and it excludes the
 * bright 1 px highlight rectangle the game draws 8 px inside the frame when the
 * cursor is over the map panel (present in two of the four fixtures, absent in
 * the other two — including it would put a fixture-specific artefact in the
 * templates).
 */

/** Map panel interior, inset 10 px. Fractions of the full frame. */
const MAP_PANEL_REL = {
    x: 887 / 1919,   // 0.462220
    y: 157 / 1078,   // 0.145640
    w: 766 / 1919,   // 0.399166
    h: 766 / 1078    // 0.710575
};

/**
 * Lower ~2/3 of the left (objectives) panel: solid black on the Tab screen,
 * live game world or menu art on everything else. fs x 257..842, y 250..929.
 */
const LEFT_PANEL_REL = {
    x: 257 / 1919,   // 0.133924
    y: 250 / 1078,   // 0.231911
    w: 586 / 1919,   // 0.305367
    h: 680 / 1078    // 0.630798
};

/**
 * The framed map-name box, left-anchored so the region stays inside the box
 * whatever the map is called. fs x 300..479, y 158..204.
 */
const NAME_BOX_REL = {
    x: 300 / 1919,   // 0.156331
    y: 158 / 1078,   // 0.146568
    w: 180 / 1919,   // 0.093799
    h: 47 / 1078     // 0.043599
};

const DEFAULT_SIZE = 64;
const DEFAULT_MIN_SCORE = 0.80;
const DEFAULT_MIN_MARGIN = 0.10;

/**
 * Small alignment search, in fractions of the frame.
 *
 * `MAP_PANEL_REL` is exact for a full-screen capture at any 16:9 resolution,
 * but a capture of the game *window* can start a few rows or columns off (a
 * client area that is not exactly the screen, a window border, a screenshot
 * that lost a row). A 2 % vertical slip is ~21 px at 1080p, or 3 % of the
 * panel, and that alone drops a correct match from 0.99 to 0.68 — below the
 * accept threshold, even though it is still plainly the right map.
 *
 * So the region is tried at a few offsets and each template keeps its best.
 * 15 crops of a quarter-megapixel region cost well under a millisecond, and
 * the alternative — lowering the threshold until a misaligned frame passes —
 * would let a wrong map through as well.
 */
const DEFAULT_OFFSETS = [];
for (const dy of [-0.02, -0.01, 0, 0.01, 0.02]) {
    for (const dx of [-0.015, 0, 0.015]) DEFAULT_OFFSETS.push({dx, dy});
}

/**
 * Gate thresholds — see `tabScreenFeatures` for what they measure. Measured
 * over the eight fixtures (Tab screen / rescaled Tab screen vs. two gameplay
 * screens and the main menu); the separation is huge in both directions, so
 * the thresholds sit roughly halfway and in the tolerant direction:
 *
 *   dark fraction of the left panel   Tab 0.990-0.995   other 0.27-0.65
 *   bright fraction of the name box   Tab 0.088-0.114   other 0.000
 */
const GATE_DARK_LEVEL = 0.06;
const GATE_MIN_DARK_FRACTION = 0.90;
const GATE_NAME_BOX_LEVEL = 0.35;
const GATE_MIN_NAME_BOX_FRACTION = 0.02;

/**
 * BGRA (Electron `nativeImage.toBitmap()`) or RGBA bytes → Rec.601 luminance
 * in 0..1. Doing the conversion here rather than leaning on sharp/libvips keeps
 * the dev-time template generator and the runtime on exactly the same numbers.
 *
 * @param {Uint8Array|Buffer} pixels 4 bytes per pixel
 * @param {number} width
 * @param {number} height
 * @param {string} [order] 'bgra' (default, Electron) or 'rgba' (sharp raw)
 * @returns {Float32Array} width*height luminance values
 */
function toGray(pixels, width, height, order) {
    const n = width * height;
    if (pixels.length < n * 4) {
        throw new Error('toGray: expected ' + (n * 4) + ' bytes, got ' + pixels.length);
    }
    const out = new Float32Array(n);
    const rgba = order === 'rgba';
    const rOff = rgba ? 0 : 2;
    const bOff = rgba ? 2 : 0;
    for (let i = 0; i < n; i++) {
        const p = i * 4;
        out[i] = (0.299 * pixels[p + rOff] + 0.587 * pixels[p + 1] + 0.114 * pixels[p + bOff]) / 255;
    }
    return out;
}

/**
 * Crop a relative region out of a luminance frame.
 * @param {Float32Array} gray
 * @param {number} width
 * @param {number} height
 * @param {{x:number,y:number,w:number,h:number}} rel fractions of the frame
 * @returns {{data: Float32Array, width: number, height: number}}
 */
function cropRegion(gray, width, height, rel) {
    const x0 = Math.max(0, Math.min(width - 1, Math.round(rel.x * width)));
    const y0 = Math.max(0, Math.min(height - 1, Math.round(rel.y * height)));
    const cw = Math.max(1, Math.min(width - x0, Math.round(rel.w * width)));
    const ch = Math.max(1, Math.min(height - y0, Math.round(rel.h * height)));
    const out = new Float32Array(cw * ch);
    for (let y = 0; y < ch; y++) {
        const src = (y0 + y) * width + x0;
        out.set(gray.subarray(src, src + cw), y * cw);
    }
    return {data: out, width: cw, height: ch};
}

/**
 * Area-average down to `size` x `size`. Box edges are fractional, so the
 * result does not depend on the source being a multiple of `size` — that is
 * what makes 1280x720, 1920x1080 and 2560x1440 produce the same thumbnail.
 *
 * @returns {Float32Array} size*size values
 */
function downsample(gray, width, height, size) {
    const n = size || DEFAULT_SIZE;
    const out = new Float32Array(n * n);
    const sx = width / n;
    const sy = height / n;
    for (let oy = 0; oy < n; oy++) {
        const fy0 = oy * sy, fy1 = (oy + 1) * sy;
        const iy0 = Math.floor(fy0), iy1 = Math.min(height, Math.ceil(fy1));
        for (let ox = 0; ox < n; ox++) {
            const fx0 = ox * sx, fx1 = (ox + 1) * sx;
            const ix0 = Math.floor(fx0), ix1 = Math.min(width, Math.ceil(fx1));
            let sum = 0, weight = 0;
            for (let y = iy0; y < iy1; y++) {
                const wy = Math.min(y + 1, fy1) - Math.max(y, fy0);
                if (wy <= 0) continue;
                const row = y * width;
                for (let x = ix0; x < ix1; x++) {
                    const wx = Math.min(x + 1, fx1) - Math.max(x, fx0);
                    if (wx <= 0) continue;
                    const wgt = wx * wy;
                    sum += gray[row + x] * wgt;
                    weight += wgt;
                }
            }
            out[oy * n + ox] = weight > 0 ? sum / weight : 0;
        }
    }
    return out;
}

/**
 * Sobel-style gradient magnitude of a square thumbnail, as a same-sized array.
 *
 * The raw luminance thumbnails of the four maps all share the same layout (a
 * pale road network on a dark ground inside a dark square), so plain NCC on
 * luminance leaves a thin margin between the runner-up maps. The gradient
 * magnitude keys on *where the edges are* instead of how bright the area is,
 * which is what actually differs between the maps; averaging the two NCCs
 * roughly doubles the separation. Border pixels are replicated.
 */
function gradientMagnitude(thumb, size) {
    const n = size || Math.round(Math.sqrt(thumb.length));
    const at = (x, y) => thumb[Math.min(n - 1, Math.max(0, y)) * n + Math.min(n - 1, Math.max(0, x))];
    const out = new Float32Array(n * n);
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            const gx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
                - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
            const gy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))
                - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
            out[y * n + x] = Math.sqrt(gx * gx + gy * gy);
        }
    }
    return out;
}

/**
 * Zero-mean normalized cross-correlation, in [-1, 1].
 * A constant image has zero variance; return 0 rather than NaN.
 */
function ncc(a, b) {
    const n = Math.min(a.length, b.length);
    if (n === 0) return 0;
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) {
        const u = a[i] - ma, v = b[i] - mb;
        num += u * v; da += u * u; db += v * v;
    }
    if (da <= 0 || db <= 0) return 0;
    const r = num / Math.sqrt(da * db);
    return r > 1 ? 1 : (r < -1 ? -1 : r);
}

/** Mean of an array-like of numbers. */
function mean(arr) {
    let s = 0;
    for (let i = 0; i < arr.length; i++) s += arr[i];
    return arr.length ? s / arr.length : 0;
}

/**
 * The two numbers the Tab-screen gate is built on.
 * - `darkFraction`: the fraction of the lower left panel that is essentially
 *   black. On the Tab screen that panel is a solid black rectangle; during
 *   gameplay and in the menu it is live image. A *fraction* rather than the
 *   mean on purpose — the app's own overlay window is on screen and will be
 *   captured with everything else, and a bright patch covering a tenth of the
 *   region would move a mean past any useful threshold while barely touching
 *   this.
 * - `nameBoxFraction`: fraction of pixels in the map-name box that are bright.
 *   The framed uppercase title is the one thing the Tab screen has and normal
 *   gameplay (which still draws the objectives list) does not.
 */
function tabScreenFeatures(gray, width, height) {
    const panel = cropRegion(gray, width, height, LEFT_PANEL_REL);
    const box = cropRegion(gray, width, height, NAME_BOX_REL);
    let dark = 0;
    for (let i = 0; i < panel.data.length; i++) if (panel.data[i] < GATE_DARK_LEVEL) dark++;
    let bright = 0;
    for (let i = 0; i < box.data.length; i++) if (box.data[i] >= GATE_NAME_BOX_LEVEL) bright++;
    return {
        darkFraction: panel.data.length ? dark / panel.data.length : 0,
        panelMean: mean(panel.data),
        nameBoxFraction: box.data.length ? bright / box.data.length : 0
    };
}

/**
 * Cheap pre-check: is this frame the in-game Tab (Objectives) screen at all?
 * Runs before any NCC, so ordinary gameplay never reaches the matcher.
 * @returns {boolean}
 */
function TAB_SCREEN_GATE(gray, width, height) {
    const f = tabScreenFeatures(gray, width, height);
    return f.darkFraction >= GATE_MIN_DARK_FRACTION && f.nameBoxFraction >= GATE_MIN_NAME_BOX_FRACTION;
}

/**
 * Reduce a frame to the 64x64 thumbnail the templates are stored as.
 * @param {Float32Array} gray
 * @param {number} width
 * @param {number} height
 * @param {object} [opts] `{region, size}`; pass `region: null` when `gray` is
 *   already the cropped panel.
 * @returns {Float32Array}
 */
function frameThumbnail(gray, width, height, opts) {
    const o = opts || {};
    const size = o.size || DEFAULT_SIZE;
    const region = o.region === undefined ? MAP_PANEL_REL : o.region;
    if (!region) return downsample(gray, width, height, size);
    const offset = o.offset;
    const shifted = offset
        ? {x: region.x + offset.dx, y: region.y + offset.dy, w: region.w, h: region.h}
        : region;
    const c = cropRegion(gray, width, height, shifted);
    return downsample(c.data, c.width, c.height, size);
}

/**
 * Score one thumbnail against one template: the mean of the luminance NCC and
 * the gradient-magnitude NCC. See `gradientMagnitude` for why.
 */
function scoreThumbnail(thumb, thumbGrad, template, size) {
    const tpl = template instanceof Float32Array ? template : Float32Array.from(template);
    return (ncc(thumb, tpl) + ncc(thumbGrad, gradientMagnitude(tpl, size))) / 2;
}

/**
 * Match a frame against the templates.
 *
 * @param {Float32Array} gray luminance frame
 * @param {number} width
 * @param {number} height
 * @param {Object<string, number[]|Float32Array>} templates key → size*size thumbnail
 * @param {object} [opts]
 *   `region` (default `MAP_PANEL_REL`; `null` = `gray` is already the panel),
 *   `size` (64), `minScore` (0.80), `minMargin` (0.10),
 *   `gate` (default true; a caller passing a pre-cropped panel must pass false),
 *   `report` (true → always return the object, with `accepted` saying whether
 *   the thresholds were met, so the tests can print every score).
 * @returns {{key, score, second, margin, scores, accepted}|null}
 */
function matchMap(gray, width, height, templates, opts) {
    const o = opts || {};
    const minScore = o.minScore === undefined ? DEFAULT_MIN_SCORE : o.minScore;
    const minMargin = o.minMargin === undefined ? DEFAULT_MIN_MARGIN : o.minMargin;
    const gate = o.gate === undefined ? true : o.gate;
    const size = o.size || DEFAULT_SIZE;

    if (gate && !TAB_SCREEN_GATE(gray, width, height)) {
        return o.report ? {key: null, score: 0, second: 0, margin: 0, scores: {}, accepted: false, gated: true} : null;
    }

    // One thumbnail per candidate alignment (just the one when the caller
    // passes a pre-cropped panel — there is nothing to align then).
    const region = o.region === undefined ? MAP_PANEL_REL : o.region;
    const offsets = region ? (o.offsets || DEFAULT_OFFSETS) : [null];
    const views = offsets.map(offset => {
        const thumb = frameThumbnail(gray, width, height, Object.assign({}, o, {offset}));
        return {thumb, grad: gradientMagnitude(thumb, size)};
    });

    // Each template keeps its best alignment. Doing it per template rather
    // than picking one alignment for all of them costs nothing extra and
    // cannot favour whichever map happens to be checked first.
    const scores = {};
    let bestKey = null, best = -Infinity, second = -Infinity;
    for (const key of Object.keys(templates)) {
        let s = -Infinity;
        for (const view of views) {
            const v = scoreThumbnail(view.thumb, view.grad, templates[key], size);
            if (v > s) s = v;
        }
        scores[key] = s;
        if (s > best) { second = best; best = s; bestKey = key; }
        else if (s > second) { second = s; }
    }
    if (bestKey === null) return o.report ? {key: null, score: 0, second: 0, margin: 0, scores, accepted: false} : null;
    if (second === -Infinity) second = 0;

    const accepted = best >= minScore && (best - second) >= minMargin;
    const result = {key: bestKey, score: best, second, margin: best - second, scores, accepted, gated: false};
    if (o.report) return result;
    return accepted ? result : null;
}

module.exports = {
    MAP_PANEL_REL,
    LEFT_PANEL_REL,
    NAME_BOX_REL,
    DEFAULT_SIZE,
    DEFAULT_MIN_SCORE,
    DEFAULT_MIN_MARGIN,
    DEFAULT_OFFSETS,
    GATE_DARK_LEVEL,
    GATE_MIN_DARK_FRACTION,
    GATE_NAME_BOX_LEVEL,
    GATE_MIN_NAME_BOX_FRACTION,
    toGray,
    cropRegion,
    downsample,
    gradientMagnitude,
    ncc,
    tabScreenFeatures,
    TAB_SCREEN_GATE,
    frameThumbnail,
    scoreThumbnail,
    matchMap
};
