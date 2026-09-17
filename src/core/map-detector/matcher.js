/**
 * PURE image matcher for the automatic map detection (phase 2).
 *
 * Imports nothing — no electron, no fs, no sharp. Everything here is plain
 * arithmetic over a luminance buffer, so the whole thing is unit testable and
 * runs in well under a millisecond per frame.
 *
 * Pipeline: captured game-window frame → grayscale → crop the in-game map panel
 * by a resolution-independent relative region → area-average down to 64x64 →
 * zero-mean normalized cross-correlation against the bundled templates.
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

/**
 * The main menu's navigation strip, top left: the `Q` / `E` shoulder badges
 * around "MICHAEL'S STORY · MULTIPLAYER · CHARACTERS · GRAVEYARD".
 *
 * Measured from `detection-fixtures/menu-main.png` (1919x1079) by scanning the
 * top-left corner: rows 22..64 carry the strip (row means jump from ~0.6/255
 * above it to 9-41/255 across it and back to ~1/255 by row 66), and columns
 * 45..760 span the two badges and everything between them (the `Q` badge peaks
 * at x 50-60 and the `E` badge at x 730-745, both ~82/255 against a near-black
 * background). The region below is that box rounded outward by a couple of
 * pixels: x 45..760, y 20..68.
 *
 * The 3D scene behind the menu changes with the selected tab, the time of day
 * in the render and the player's cosmetics — the strip does not. The selected
 * tab's highlight box does move along the strip, which is why the accept
 * threshold is nowhere near 1.0 (see MENU_MIN_SCORE).
 */
const MENU_STRIP_REL = {
    x: 45 / 1919,    // 0.023450
    y: 20 / 1079,    // 0.018536
    w: 715 / 1919,   // 0.372590
    h: 48 / 1079     // 0.044486
};

const DEFAULT_SIZE = 64;
const DEFAULT_MIN_SCORE = 0.80;
const DEFAULT_MIN_MARGIN = 0.10;

/**
 * The second accept branch: a match that is **not** bright, but is a long way
 * ahead of every other map.
 *
 * Field evidence, 0.3.2, the owner's `detector.log` (2026-09-17 20:23 onwards):
 * dozens of Tab presses in a row — as it turned out, from matches played in
 * the *civilian* role, whose map panel is drawn differently from Michael's,
 * which is the only view the committed fixtures had — scored
 *
 *   score 0.68 - 0.72   runner-up 0.39 - 0.42   margin 0.27 - 0.31
 *
 * The right map was first every single time and nothing was ever sent, because
 * the absolute score sits under `DEFAULT_MIN_SCORE`. Lowering that threshold
 * outright is what the alignment search exists to avoid, so the margin carries
 * the second branch instead: 0.60 with a 0.15 lead.
 *
 * Why 0.15 and not the 0.20 this shipped with first. The stand-in for "a view
 * nobody has sent a screenshot of" is one of the committed civilian frames
 * matched with **its own** variant removed (the other maps keep theirs), and
 * re-measuring that (VERIFICATION-6, finding 1) gives
 *
 *   East Haddonfield        0.6879 / margin 0.2194   (640x360: 0.6905 / 0.2228)
 *   Haddonfield Heights     0.6972 / margin 0.1956   (640x360: 0.7031 / 0.2036)
 *   Haddonfield Town Center 0.7623 / margin 0.2792   (640x360: 0.7669 / 0.2826)
 *   Orange Grove Estates    0.6644 / margin 0.2493   (640x360: 0.6738 / 0.2528)
 *
 * — a worst case of 0.196, i.e. at 0.20 the branch rejected one of the four at
 * full resolution and accepted another by 0.004. The committed negatives,
 * scored with the Tab gate switched off, sit at
 *
 *   gameplay-civilian 0.136 / 0.052 · gameplay-killer 0.160 / 0.004
 *   menu-main 0.279 / 0.023
 *
 * so 0.15 is still ~3x the worst negative margin *and* 0.32 under the score
 * floor, which a test asserts fixture by fixture. Two independent conditions
 * have to be met, so a frame that is merely dark (every template correlating
 * weakly with it) cannot pass: that is exactly the shape of the negatives,
 * where the runner-up sits right behind the leader.
 *
 * It is still **best effort**, not a guarantee: a view the templates have
 * never seen lands wherever it lands, and 0.196 was the worst of four. The
 * real fix for a missing view is a template *variant* for it (see
 * `templateVariants`); this branch is what keeps the detector useful until
 * someone sends that screenshot.
 */
const DEFAULT_MARGIN_MIN_SCORE = 0.60;
const DEFAULT_MARGIN_MIN_MARGIN = 0.15;

/**
 * The menu template is a *wide* thumbnail, not a square one: the strip is
 * roughly 15:1, and squashing that into 64x64 would throw away the horizontal
 * detail that is the whole signal. 96x12 keeps the aspect within a factor of
 * two and still averages several source pixels per cell at the 640 px wide
 * frame the detector actually works on (the strip is ~238x16 there).
 */
const MENU_TEMPLATE_WIDTH = 96;
const MENU_TEMPLATE_HEIGHT = 12;

/**
 * Accept threshold for the menu. Measured over the committed fixtures:
 *
 *   menu-main.png, native and rescaled to 640x360 … 2560x1440   0.962 - 1.000
 *   the highest anything else reaches (a full-frame Tab screen)  0.416
 *
 * 0.75 therefore sits in an enormous gap, which is deliberate: the selected
 * tab's highlight box slides along the strip, and only one menu fixture exists
 * to measure that from. Two consecutive positive ticks are required on top of
 * this, so the cost of the threshold being slightly generous is bounded.
 */
const MENU_MIN_SCORE = 0.75;

/**
 * Alignment search for the menu strip, in fractions of the frame. Smaller than
 * the map panel's: the strip is anchored to the top-left corner of the screen
 * rather than centred, so a capture that is off by a window border moves it far
 * less, and the region is short enough that a 2 % vertical slip would leave it
 * entirely.
 */
const MENU_OFFSETS = [];
for (const dy of [-0.01, -0.005, 0, 0.005, 0.01]) {
    for (const dx of [-0.01, -0.005, 0, 0.005, 0.01]) MENU_OFFSETS.push({dx, dy});
}

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
 * BGRA/RGBA bytes → a *smaller* luminance frame, in one pass.
 *
 * The capture backend hands us a full-size window image (2 MP at 1080p) and has
 * no resize of its own. Converting that to luminance and then area-averaging it
 * would touch every source pixel twice and allocate an 8 MB intermediate; this
 * does the box average and the luma conversion together, so each source pixel is
 * read exactly once and nothing bigger than the output is allocated. It is the
 * single most expensive thing the detector does per tick, which is why it is
 * one loop and not two.
 *
 * Equivalent to `downsample(toGray(pixels, w, h), w, h, …)` to within float
 * rounding — there is a test for that.
 *
 * @param {Uint8Array|Buffer} pixels 4 bytes per pixel
 * @param {number} width source width
 * @param {number} height source height
 * @param {number} outWidth
 * @param {number} outHeight
 * @param {string} [order] 'bgra' (default) or 'rgba'
 * @returns {Float32Array} outWidth*outHeight luminance values in 0..1
 */
function toGrayScaled(pixels, width, height, outWidth, outHeight, order) {
    const n = width * height;
    if (pixels.length < n * 4) {
        throw new Error('toGrayScaled: expected ' + (n * 4) + ' bytes, got ' + pixels.length);
    }
    const rgba = order === 'rgba';
    const rOff = rgba ? 0 : 2;
    const bOff = rgba ? 2 : 0;
    const out = new Float32Array(outWidth * outHeight);

    // Fast path: whole-number box. 1920 -> 640 is exactly 3:1, and so is the
    // matching vertical ratio, so this is what actually runs on a 1080p window.
    // Every weight is 1 and the divisor is constant, which takes the per-pixel
    // work down to three multiplies and an add.
    if (width % outWidth === 0 && height % outHeight === 0) {
        const bx = width / outWidth;
        const by = height / outHeight;
        const scale = 1 / (bx * by * 255);
        for (let oy = 0; oy < outHeight; oy++) {
            const y0 = oy * by, y1 = y0 + by;
            for (let ox = 0; ox < outWidth; ox++) {
                const x0 = ox * bx, x1 = x0 + bx;
                let sum = 0;
                for (let y = y0; y < y1; y++) {
                    let p = (y * width + x0) * 4;
                    for (let x = x0; x < x1; x++, p += 4) {
                        sum += 0.299 * pixels[p + rOff] + 0.587 * pixels[p + 1] + 0.114 * pixels[p + bOff];
                    }
                }
                out[oy * outWidth + ox] = sum * scale;
            }
        }
        return out;
    }

    const sx = width / outWidth;
    const sy = height / outHeight;
    for (let oy = 0; oy < outHeight; oy++) {
        const fy0 = oy * sy, fy1 = (oy + 1) * sy;
        const iy0 = Math.floor(fy0), iy1 = Math.min(height, Math.ceil(fy1));
        for (let ox = 0; ox < outWidth; ox++) {
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
                    const p = (row + x) * 4;
                    const luma = 0.299 * pixels[p + rOff] + 0.587 * pixels[p + 1] + 0.114 * pixels[p + bOff];
                    const wgt = wx * wy;
                    sum += luma * wgt;
                    weight += wgt;
                }
            }
            out[oy * outWidth + ox] = weight > 0 ? sum / (weight * 255) : 0;
        }
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
    return resample(gray, width, height, n, n);
}

/**
 * The rectangular form of `downsample`: area-average to `outWidth x outHeight`.
 * @returns {Float32Array}
 */
function resample(gray, width, height, outWidth, outHeight) {
    const out = new Float32Array(outWidth * outHeight);
    const sx = width / outWidth;
    const sy = height / outHeight;
    for (let oy = 0; oy < outHeight; oy++) {
        const fy0 = oy * sy, fy1 = (oy + 1) * sy;
        const iy0 = Math.floor(fy0), iy1 = Math.min(height, Math.ceil(fy1));
        for (let ox = 0; ox < outWidth; ox++) {
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
            out[oy * outWidth + ox] = weight > 0 ? sum / weight : 0;
        }
    }
    return out;
}

/**
 * Sobel-style gradient magnitude of a thumbnail, as a same-sized array.
 *
 * The raw luminance thumbnails of the four maps all share the same layout (a
 * pale road network on a dark ground inside a dark square), so plain NCC on
 * luminance leaves a thin margin between the runner-up maps. The gradient
 * magnitude keys on *where the edges are* instead of how bright the area is,
 * which is what actually differs between the maps; averaging the two NCCs
 * roughly doubles the separation. Border pixels are replicated.
 *
 * `height` defaults to `width`, so the square map thumbnails call this as
 * `gradientMagnitude(thumb, 64)`; the wide menu strip passes both.
 */
function gradientMagnitude(thumb, width, height) {
    const n = width || Math.round(Math.sqrt(thumb.length));
    const h = height || n;
    const at = (x, y) => thumb[Math.min(h - 1, Math.max(0, y)) * n + Math.min(n - 1, Math.max(0, x))];
    const out = new Float32Array(n * h);
    for (let y = 0; y < h; y++) {
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
 * The thumbnails stored for one map key, as a list — **template variants**.
 *
 * The same map does not look the same to everyone: the Tab screen's map panel
 * is drawn differently for the civilian role than for Michael, which is what
 * the owner's 0.3.2 field log was actually showing (all four committed
 * fixtures are Michael's view; the 0.68-0.72 scores came from civilian
 * matches). A map therefore gets one thumbnail *per view*, and the key's score
 * is the best of them — averaging them would blur two genuinely different
 * pictures into one that matches neither well.
 *
 * Accepts either shape, so a `templates.json` written before variants existed
 * still loads:
 *   `[0.1, 0.2, …]`        one variant  (format 1)
 *   `[[0.1, …], [0.3, …]]` several      (format 2)
 *
 * @param {Float32Array|number[]|Array<Float32Array|number[]>} entry
 * @returns {Array<Float32Array>}
 */
function templateVariants(entry) {
    if (!entry || !entry.length) return [];
    if (entry instanceof Float32Array) return [entry];
    const first = entry[0];
    if (Array.isArray(first) || ArrayBuffer.isView(first)) {
        return Array.from(entry, v => (v instanceof Float32Array ? v : Float32Array.from(v)));
    }
    return [Float32Array.from(entry)];
}

/**
 * Is this (score, margin) pair good enough to switch the overlay?
 *
 * Two branches, and a match needs only one of them:
 *   `score`  — a bright match: score >= 0.80 with the usual 0.10 lead. What a
 *              solo Tab screen produces (0.99 / 0.49 in the field log).
 *   `margin` — a dim but unambiguous match: score >= 0.60 with a 0.15 lead.
 *              What a party Tab screen produces (0.70 / 0.29).
 *
 * Returns the branch's name rather than `true` so the caller can log which one
 * fired — "it switched, but only just" is a different field report from "it
 * switched".
 *
 * @param {number} score the best template's score
 * @param {number} margin best minus runner-up
 * @param {object} [opts] `minScore`, `minMargin`, `marginMinScore`,
 *   `marginMinMargin` — all defaulting to the constants above.
 * @returns {?string} 'score', 'margin', or null when neither branch accepts
 */
function acceptMatch(score, margin, opts) {
    const o = opts || {};
    const minScore = o.minScore === undefined ? DEFAULT_MIN_SCORE : o.minScore;
    const minMargin = o.minMargin === undefined ? DEFAULT_MIN_MARGIN : o.minMargin;
    const marginMinScore = o.marginMinScore === undefined ? DEFAULT_MARGIN_MIN_SCORE : o.marginMinScore;
    const marginMinMargin = o.marginMinMargin === undefined ? DEFAULT_MARGIN_MIN_MARGIN : o.marginMinMargin;
    if (score >= minScore && margin >= minMargin) return 'score';
    if (score >= marginMinScore && margin >= marginMinMargin) return 'margin';
    return null;
}

/**
 * Match a frame against the templates.
 *
 * @param {Float32Array} gray luminance frame
 * @param {number} width
 * @param {number} height
 * @param {Object<string, number[]|Float32Array|Array<number[]>>} templates key →
 *   one size*size thumbnail, or a list of them (role variants; the key scores
 *   as the best of its variants)
 * @param {object} [opts]
 *   `region` (default `MAP_PANEL_REL`; `null` = `gray` is already the panel),
 *   `size` (64), `minScore` (0.80), `minMargin` (0.10),
 *   `marginMinScore` (0.60), `marginMinMargin` (0.15) — see `acceptMatch`,
 *   `gate` (default true; a caller passing a pre-cropped panel must pass false),
 *   `report` (true → always return the object, with `accepted` saying whether
 *   the thresholds were met, so the tests can print every score).
 * @returns {{key, score, second, margin, scores, accepted, acceptedBy, panelMean}|null}
 */
function matchMap(gray, width, height, templates, opts) {
    const o = opts || {};
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
        return {thumb, grad: gradientMagnitude(thumb, size), offset};
    });

    // Mean luminance of the map panel as the region names it — the unshifted
    // view, so it describes the frame rather than whichever alignment scored
    // best. It is what tells a *dim* panel (a party Tab screen, which is what
    // the margin accept branch exists for) from a panel the capture has slid
    // off, and it costs one pass over 4096 floats. Logged with `no-match`.
    const base = views.find(v => !v.offset || (!v.offset.dx && !v.offset.dy)) || views[0];
    const panelMean = base ? mean(base.thumb) : 0;

    // Each template keeps its best alignment **and its best variant**. Doing
    // it per template rather than picking one alignment for all of them costs
    // nothing extra and cannot favour whichever map happens to be checked
    // first; taking the max over the variants rather than their mean is the
    // whole point of having them (see `templateVariants`).
    //
    // The variants' gradients are computed once per tick, not once per
    // alignment: that is 15 fewer `gradientMagnitude` passes per variant than
    // the naive loop, which is what pays for a second variant existing at all.
    const scores = {};
    let bestKey = null, best = -Infinity, second = -Infinity;
    for (const key of Object.keys(templates)) {
        const variants = templateVariants(templates[key]).map(tpl => ({tpl, grad: gradientMagnitude(tpl, size)}));
        let s = -Infinity;
        for (const {tpl, grad} of variants) {
            for (const view of views) {
                const v = (ncc(view.thumb, tpl) + ncc(view.grad, grad)) / 2;
                if (v > s) s = v;
            }
        }
        if (s === -Infinity) continue;   // an entry with no thumbnail at all
        scores[key] = s;
        if (s > best) { second = best; best = s; bestKey = key; }
        else if (s > second) { second = s; }
    }
    if (bestKey === null) {
        return o.report
            ? {key: null, score: 0, second: 0, margin: 0, scores, accepted: false, acceptedBy: null, panelMean}
            : null;
    }
    if (second === -Infinity) second = 0;

    const acceptedBy = acceptMatch(best, best - second, o);
    const result = {
        key: bestKey, score: best, second, margin: best - second, scores,
        accepted: !!acceptedBy, acceptedBy, panelMean, gated: false
    };
    if (o.report) return result;
    return accepted ? result : null;
}

/*
 * ─── The main menu ──────────────────────────────────────────────────────────
 *
 * Same two-signal NCC as the map matcher, on a different region and with one
 * template instead of several, so there is no runner-up and no margin — only a
 * score against a threshold. The detector requires two consecutive positive
 * ticks on top of that; see `src/core/map-detector.js`.
 */

/**
 * Reduce a frame to the wide thumbnail the menu template is stored as.
 * @param {Float32Array} gray
 * @param {number} width
 * @param {number} height
 * @param {object} [opts] `{width, height, offset}` — template dimensions and an
 *   alignment offset in fractions of the frame.
 * @returns {Float32Array}
 */
function menuThumbnail(gray, width, height, opts) {
    const o = opts || {};
    const tw = o.width || MENU_TEMPLATE_WIDTH;
    const th = o.height || MENU_TEMPLATE_HEIGHT;
    const offset = o.offset;
    const region = offset
        ? {x: MENU_STRIP_REL.x + offset.dx, y: MENU_STRIP_REL.y + offset.dy, w: MENU_STRIP_REL.w, h: MENU_STRIP_REL.h}
        : MENU_STRIP_REL;
    const c = cropRegion(gray, width, height, region);
    return resample(c.data, c.width, c.height, tw, th);
}

/**
 * Is this frame the game's main menu?
 *
 * @param {Float32Array} gray luminance frame
 * @param {number} width
 * @param {number} height
 * @param {number[]|Float32Array} template the stored strip thumbnail
 * @param {object} [opts] `width`/`height` (template dimensions),
 *   `minScore` (0.75), `offsets`.
 * @returns {{score: number, accepted: boolean}} `score` is -1 with no template.
 */
function matchMenu(gray, width, height, template, opts) {
    const o = opts || {};
    if (!template || !template.length) return {score: -1, accepted: false};
    const tw = o.width || MENU_TEMPLATE_WIDTH;
    const th = o.height || MENU_TEMPLATE_HEIGHT;
    const minScore = o.minScore === undefined ? MENU_MIN_SCORE : o.minScore;
    const tpl = template instanceof Float32Array ? template : Float32Array.from(template);
    const tplGrad = gradientMagnitude(tpl, tw, th);

    let best = -Infinity;
    for (const offset of (o.offsets || MENU_OFFSETS)) {
        const thumb = menuThumbnail(gray, width, height, {width: tw, height: th, offset});
        const score = (ncc(thumb, tpl) + ncc(gradientMagnitude(thumb, tw, th), tplGrad)) / 2;
        if (score > best) best = score;
    }
    return {score: best, accepted: best >= minScore};
}

module.exports = {
    MAP_PANEL_REL,
    LEFT_PANEL_REL,
    NAME_BOX_REL,
    MENU_STRIP_REL,
    MENU_TEMPLATE_WIDTH,
    MENU_TEMPLATE_HEIGHT,
    MENU_MIN_SCORE,
    MENU_OFFSETS,
    DEFAULT_SIZE,
    DEFAULT_MIN_SCORE,
    DEFAULT_MIN_MARGIN,
    DEFAULT_MARGIN_MIN_SCORE,
    DEFAULT_MARGIN_MIN_MARGIN,
    DEFAULT_OFFSETS,
    GATE_DARK_LEVEL,
    GATE_MIN_DARK_FRACTION,
    GATE_NAME_BOX_LEVEL,
    GATE_MIN_NAME_BOX_FRACTION,
    toGray,
    toGrayScaled,
    cropRegion,
    downsample,
    resample,
    gradientMagnitude,
    ncc,
    tabScreenFeatures,
    TAB_SCREEN_GATE,
    frameThumbnail,
    scoreThumbnail,
    templateVariants,
    acceptMatch,
    matchMap,
    menuThumbnail,
    matchMenu
};
