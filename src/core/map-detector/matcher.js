/**
 * PURE image matcher: imports nothing, plain arithmetic over a luminance
 * buffer. Frame → luminance → crop the map panel by a region in **fractions of
 * the frame** (which is what makes every 16:9 resolution work with no
 * per-resolution code) → area-average to 64x64 → zero-mean NCC.
 *
 * Every region and threshold here was measured off the committed fixtures and
 * must not be moved without re-measuring: `docs/agents/detection.md`.
 */

/** Map panel interior, inset 10 px (past the cursor highlight the game draws
 * 8 px inside the frame, and past the fixtures' crop differences). */
const MAP_PANEL_REL = {
    x: 887 / 1919,
    y: 157 / 1078,
    w: 766 / 1919,
    h: 766 / 1078
};

/** The same interior **without** the inset: Tab-map mode's `tab` transform
 * (`shared/marker-rules.js`) is a fraction of the *full* 786x786 square. */
const TAB_PANEL_REL = {
    x: 877 / 1919,
    y: 147 / 1078,
    w: 786 / 1919,
    h: 786 / 1078
};

/** Where Tab-map mode puts its legend: the empty lower-left of the game's own
 * Objectives panel. fs x 270..750, y 720..910 of a 1919x1078 frame. */
const TAB_LEGEND_REL = {
    x: 270 / 1919,
    y: 720 / 1078,
    w: 480 / 1919,
    h: 190 / 1078
};

/** Lower ~2/3 of the left (objectives) panel: solid black on the Tab screen,
 * live game world or menu art on everything else. fs x 257..842, y 250..929. */
const LEFT_PANEL_REL = {
    x: 257 / 1919,
    y: 250 / 1078,
    w: 586 / 1919,
    h: 680 / 1078
};

/** The framed map-name box, left-anchored so the region stays inside the box
 * whatever the map is called. fs x 300..479, y 158..204. */
const NAME_BOX_REL = {
    x: 300 / 1919,
    y: 158 / 1078,
    w: 180 / 1919,
    h: 47 / 1078
};

/** The main menu's navigation strip, top left: x 45..760, y 20..68 at 1919x1079.
 * The scene behind the menu changes, the strip does not — but the selected
 * tab's highlight box slides along it, hence `MENU_MIN_SCORE` nowhere near 1. */
const MENU_STRIP_REL = {
    x: 45 / 1919,
    y: 20 / 1079,
    w: 715 / 1919,
    h: 48 / 1079
};

const DEFAULT_SIZE = 64;
const DEFAULT_MIN_SCORE = 0.80;
const DEFAULT_MIN_MARGIN = 0.10;

/**
 * The second accept branch: not bright, but a long way ahead of every other map
 * — a view the templates have never seen scores 0.66-0.76 with the right map
 * 0.20-0.28 ahead. 0.15 not 0.20, because the worst measured stand-in is 0.196
 * (VERIFICATION-6, finding 1). **Both** conditions must hold, so a merely dark
 * frame cannot pass; never replace the pair with one lower `MIN_SCORE`. Best
 * effort only: the real fix for a missing view is a template *variant*.
 */
const DEFAULT_MARGIN_MIN_SCORE = 0.60;
const DEFAULT_MARGIN_MIN_MARGIN = 0.15;

/** A *wide* thumbnail: the strip is ~15:1 and squashing it into 64x64 throws
 * away the horizontal detail that is the whole signal. */
const MENU_TEMPLATE_WIDTH = 96;
const MENU_TEMPLATE_HEIGHT = 12;

/** Accept threshold for the menu: measured positives 0.962-1.000, best negative
 * 0.416, so it sits in a huge gap on purpose — only one menu fixture exists to
 * measure the sliding tab highlight from. Three positive ticks are needed too. */
const MENU_MIN_SCORE = 0.75;

/** Alignment search for the menu strip. Smaller than the map panel's: the strip
 * is anchored to the top-left corner, so a window border moves it far less. */
const MENU_OFFSETS = [];
for (const dy of [-0.01, -0.005, 0, 0.005, 0.01]) {
    for (const dx of [-0.01, -0.005, 0, 0.005, 0.01]) MENU_OFFSETS.push({dx, dy});
}

/** Small alignment search, in fractions of the frame: a window capture can start
 * a few rows off, and a 2 % vertical slip alone drops a correct match 0.99 →
 * 0.68. Lowering the threshold instead would let a wrong map through. */
const DEFAULT_OFFSETS = [];
for (const dy of [-0.02, -0.01, 0, 0.01, 0.02]) {
    for (const dx of [-0.015, 0, 0.015]) DEFAULT_OFFSETS.push({dx, dy});
}

/** Gate thresholds, roughly halfway across a measured separation: dark fraction
 * of the left panel Tab 0.990-0.995 vs other 0.27-0.65; bright fraction of the
 * name box Tab 0.088-0.114 vs other 0.000. See `tabScreenFeatures`. */
const GATE_DARK_LEVEL = 0.06;
const GATE_MIN_DARK_FRACTION = 0.90;
const GATE_NAME_BOX_LEVEL = 0.35;
const GATE_MIN_NAME_BOX_FRACTION = 0.02;

/**
 * BGRA or RGBA bytes → Rec.601 luminance in 0..1. Done here rather than in
 * libvips so the template generator and the runtime share exact numbers.
 * @param {Uint8Array|Buffer} pixels 4 bytes per pixel
 * @param {string} [order] 'bgra' (default, Electron) or 'rgba' (sharp raw)
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
 * BGRA/RGBA bytes → a *smaller* luminance frame in **one pass**. The hot spot:
 * splitting it into `toGray` + `resample` doubles the reads of a 2 MP frame and
 * allocates an 8 MB intermediate. Equivalent to `downsample(toGray(…))`, tested.
 * @param {Uint8Array|Buffer} pixels 4 bytes per pixel
 * @param {string} [order] 'bgra' (default) or 'rgba'
 */
function toGrayScaled(pixels, width, height, outWidth, outHeight, order) {
    const n = width * height;
    if (pixels.length < n * 4) {
        throw new Error('toGrayScaled: expected ' + (n * 4) + ' bytes, got ' + pixels.length);
    }
    return toGrayScaledRegion(pixels, width, height, outWidth, outHeight, order,
        {x: 0, y: 0, width: outWidth, height: outHeight});
}

/**
 * `toGrayScaled` for a **rectangle of the output grid** only — the biggest
 * saving in the tick, since the matcher reads at most a third of the frame.
 * `toGrayScaled` is this with the full box, so a region is bit-identical to
 * the same cells of the whole frame: each output cell depends only on its own
 * source box. `test/detector-equality.test.js` pins it.
 * @param {Uint8Array|Buffer} pixels 4 bytes per pixel
 * @param {number} outWidth the **whole** reduced frame's width — it fixes the
 *   sampling grid, so it is not `box.width`
 * @param {string} order 'bgra' or 'rgba'
 * @param {{x, y, width, height}} box cells to compute, in output coordinates
 */
function toGrayScaledRegion(pixels, width, height, outWidth, outHeight, order, box) {
    const n = width * height;
    if (pixels.length < n * 4) {
        throw new Error('toGrayScaledRegion: expected ' + (n * 4) + ' bytes, got ' + pixels.length);
    }
    const bx0 = Math.max(0, Math.min(outWidth, box.x));
    const by0 = Math.max(0, Math.min(outHeight, box.y));
    const bx1 = Math.max(bx0, Math.min(outWidth, box.x + box.width));
    const by1 = Math.max(by0, Math.min(outHeight, box.y + box.height));
    const outW = bx1 - bx0;
    const rgba = order === 'rgba';
    const rOff = rgba ? 0 : 2;
    const bOff = rgba ? 2 : 0;
    const out = new Float32Array(outW * (by1 - by0));

    // Fast path: whole-number box (1920→640 and 1080→360 are both 3:1). Every
    // weight is 1 and the divisor constant: 13.5 ms full-frame against 25.8 ms
    // on the general path, and a test asserts the two agree.
    if (width % outWidth === 0 && height % outHeight === 0) {
        const bx = width / outWidth;
        const by = height / outHeight;
        const scale = 1 / (bx * by * 255);
        for (let oy = by0; oy < by1; oy++) {
            const y0 = oy * by, y1 = y0 + by;
            for (let ox = bx0; ox < bx1; ox++) {
                const x0 = ox * bx, x1 = x0 + bx;
                let sum = 0;
                for (let y = y0; y < y1; y++) {
                    let p = (y * width + x0) * 4;
                    for (let x = x0; x < x1; x++, p += 4) {
                        sum += 0.299 * pixels[p + rOff] + 0.587 * pixels[p + 1] + 0.114 * pixels[p + bOff];
                    }
                }
                out[(oy - by0) * outW + (ox - bx0)] = sum * scale;
            }
        }
        return out;
    }

    const sx = width / outWidth;
    const sy = height / outHeight;
    for (let oy = by0; oy < by1; oy++) {
        const fy0 = oy * sy, fy1 = (oy + 1) * sy;
        const iy0 = Math.floor(fy0), iy1 = Math.min(height, Math.ceil(fy1));
        for (let ox = bx0; ox < bx1; ox++) {
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
            out[(oy - by0) * outW + (ox - bx0)] = weight > 0 ? sum / (weight * 255) : 0;
        }
    }
    return out;
}

/**
 * The pixel rectangle a relative region resolves to, clamped to the frame.
 * **One** piece of arithmetic decides this: a rounding that differed by a
 * single pixel would change every score.
 * @param {{x:number,y:number,w:number,h:number}} rel fractions of the frame
 */
function regionCropRect(width, height, rel) {
    const x0 = Math.max(0, Math.min(width - 1, Math.round(rel.x * width)));
    const y0 = Math.max(0, Math.min(height - 1, Math.round(rel.y * height)));
    const cw = Math.max(1, Math.min(width - x0, Math.round(rel.w * width)));
    const ch = Math.max(1, Math.min(height - y0, Math.round(rel.h * height)));
    return {x: x0, y: y0, width: cw, height: ch};
}

/**
 * The smallest rectangle covering a region at **every** alignment offset: the
 * union of the crops the match will take, and so exactly how much of the frame
 * must be reduced. Built from `regionCropRect`, clamping included.
 * @param {{x,y,w,h}} region fractions of the frame
 * @param {Array<?{dx: number, dy: number}>} [offsets]
 */
function regionSearchBox(width, height, region, offsets) {
    const list = (offsets && offsets.length) ? offsets : [null];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const offset of list) {
        const shifted = offset
            ? {x: region.x + offset.dx, y: region.y + offset.dy, w: region.w, h: region.h}
            : region;
        const rect = regionCropRect(width, height, shifted);
        if (rect.x < x0) x0 = rect.x;
        if (rect.y < y0) y0 = rect.y;
        if (rect.x + rect.width > x1) x1 = rect.x + rect.width;
        if (rect.y + rect.height > y1) y1 = rect.y + rect.height;
    }
    return {x: x0, y: y0, width: x1 - x0, height: y1 - y0};
}

/** A **window** onto a luminance frame: the cells of a notional
 * `frameWidth x frameHeight` grid inside `box`. Everything downstream still
 * thinks in full-frame coordinates, so the window carries its own origin. */
function frameWindow(data, frameWidth, frameHeight, box) {
    const b = box || {x: 0, y: 0, width: frameWidth, height: frameHeight};
    return {
        data,
        x: b.x, y: b.y, width: b.width, height: b.height,
        frameWidth, frameHeight
    };
}

/** Crop a relative region out of a window: same rectangle, same values and same
 * allocation as `cropRegion` on the full frame, read from a smaller buffer. */
function cropWindow(win, rel) {
    const rect = regionCropRect(win.frameWidth, win.frameHeight, rel);
    const out = new Float32Array(rect.width * rect.height);
    // Checked, not assumed: a rectangle outside the window would silently read
    // the wrong rows.
    if (rect.x < win.x || rect.y < win.y
        || rect.x + rect.width > win.x + win.width
        || rect.y + rect.height > win.y + win.height) {
        throw new Error('cropWindow: region outside the window');
    }
    for (let y = 0; y < rect.height; y++) {
        const src = (rect.y + y - win.y) * win.width + (rect.x - win.x);
        out.set(win.data.subarray(src, src + rect.width), y * rect.width);
    }
    return {data: out, width: rect.width, height: rect.height};
}

/** `resample(cropWindow(win, rel))` without the crop's copy: the same cells
 * read in the same order, straight out of the window, into `out`. */
function windowThumbInto(win, rel, outWidth, outHeight, out) {
    const rect = regionCropRect(win.frameWidth, win.frameHeight, rel);
    if (rect.x < win.x || rect.y < win.y
        || rect.x + rect.width > win.x + win.width
        || rect.y + rect.height > win.y + win.height) {
        throw new Error('cropWindow: region outside the window');
    }
    const base = (rect.y - win.y) * win.width + (rect.x - win.x);
    return resampleInto(win.data, base, win.width, rect.width, rect.height, outWidth, outHeight, out);
}

/**
 * Per-tick scratch for `matchMap` and `matchMenu`: sized once, overwritten in
 * full before every read and never returned, so nothing outlives the call
 * that filled it. detection.md § The capture path.
 */
const SCRATCH = {map: [], menu: []};
function scratch(pool, slot, length) {
    let buf = pool[slot];
    if (!buf || buf.length !== length) pool[slot] = buf = new Float32Array(length);
    return buf;
}

/**
 * Crop a relative region out of a luminance frame.
 * @param {{x:number,y:number,w:number,h:number}} rel fractions of the frame
 */
function cropRegion(gray, width, height, rel) {
    return cropWindow(frameWindow(gray, width, height, null), rel);
}

/** Area-average down to `size` x `size`. Box edges are **fractional**, so the
 * result does not depend on the source being a multiple of `size` — that is
 * what makes every 16:9 resolution produce the same thumbnail. */
function downsample(gray, width, height, size) {
    const n = size || DEFAULT_SIZE;
    return resample(gray, width, height, n, n);
}

/** The rectangular form of `downsample`: area-average to outWidth x outHeight. */
function resample(gray, width, height, outWidth, outHeight) {
    return resampleInto(gray, 0, width, width, height, outWidth, outHeight,
        new Float32Array(outWidth * outHeight));
}

/**
 * `resample` of the `width` x `height` rectangle at `base` in a buffer with
 * row pitch `stride`, into `out` (every cell written). Column weights are
 * computed once per call, not once per row: same doubles, same summation order,
 * so bit-identical. detection.md § The capture path.
 */
function resampleInto(src, base, stride, width, height, outWidth, outHeight, out) {
    const sx = width / outWidth;
    const sy = height / outHeight;
    const colStart = new Int32Array(outWidth + 1);
    const colX = [], colW = [];
    for (let ox = 0; ox < outWidth; ox++) {
        colStart[ox] = colX.length;
        const fx0 = ox * sx, fx1 = (ox + 1) * sx;
        const ix0 = Math.floor(fx0), ix1 = Math.min(width, Math.ceil(fx1));
        for (let x = ix0; x < ix1; x++) {
            const wx = Math.min(x + 1, fx1) - Math.max(x, fx0);
            if (wx <= 0) continue;
            colX.push(x);
            colW.push(wx);
        }
    }
    colStart[outWidth] = colX.length;
    const cx = Int32Array.from(colX), cw = Float64Array.from(colW);
    for (let oy = 0; oy < outHeight; oy++) {
        const fy0 = oy * sy, fy1 = (oy + 1) * sy;
        const iy0 = Math.floor(fy0), iy1 = Math.min(height, Math.ceil(fy1));
        for (let ox = 0; ox < outWidth; ox++) {
            const k0 = colStart[ox], k1 = colStart[ox + 1];
            let sum = 0, weight = 0;
            for (let y = iy0; y < iy1; y++) {
                const wy = Math.min(y + 1, fy1) - Math.max(y, fy0);
                if (wy <= 0) continue;
                const row = base + y * stride;
                for (let k = k0; k < k1; k++) {
                    const wgt = cw[k] * wy;
                    sum += src[row + cx[k]] * wgt;
                    weight += wgt;
                }
            }
            out[oy * outWidth + ox] = weight > 0 ? sum / weight : 0;
        }
    }
    return out;
}

/**
 * Sobel-style gradient magnitude, same size, borders replicated. **The second
 * of the two signals, and not optional**: the maps' luminance thumbnails share
 * a layout (pale roads on dark ground), so luminance NCC alone leaves the
 * runner-up at ~0.775 against a 0.80 threshold; edges drop it to ~0.50.
 * `height` defaults to `width` for the square map thumbnails.
 */
function gradientMagnitude(thumb, width, height) {
    const n = width || Math.round(Math.sqrt(thumb.length));
    const h = height || n;
    return gradientInto(thumb, n, h, new Float32Array(n * h));
}

/** `gradientMagnitude` into a caller's buffer (every cell is written). The
 * interior indexes directly, the border clamps; both keep the exact per-pixel
 * expression, so the result is bit-identical. detection.md § The capture path. */
function gradientInto(thumb, n, h, out) {
    const at = (x, y) => thumb[Math.min(h - 1, Math.max(0, y)) * n + Math.min(n - 1, Math.max(0, x))];
    const edge = (x, y) => {
        const gx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
            - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
        const gy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))
            - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
        out[y * n + x] = Math.sqrt(gx * gx + gy * gy);
    };
    for (let y = 0; y < h; y++) {
        if (y === 0 || y === h - 1 || n < 3) {
            for (let x = 0; x < n; x++) edge(x, y);
            continue;
        }
        edge(0, y);
        for (let x = 1, i = y * n + 1; x < n - 1; x++, i++) {
            const a = thumb[i - n + 1], b = thumb[i + 1], c = thumb[i + n + 1];
            const d = thumb[i - n - 1], e = thumb[i - 1], f = thumb[i + n - 1];
            const gx = (a + 2 * b + c) - (d + 2 * e + f);
            const gy = (f + 2 * thumb[i + n] + c) - (d + 2 * thumb[i - n] + a);
            out[i] = Math.sqrt(gx * gx + gy * gy);
        }
        edge(n - 1, y);
    }
    return out;
}

/** Zero-mean normalized cross-correlation, in [-1, 1]. A constant image has
 * zero variance: return 0 rather than NaN. */
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

/**
 * The half of an NCC that depends on **one** signal, so it is computed once per
 * array rather than once per (view x template) pair. **Same numbers, not
 * similar ones** — same index order, same division; tested per fixture.
 * @returns {{mean: number, dev: number}} `dev` is Σ(x−mean)², not a variance
 */
function nccStats(arr) {
    const n = arr.length;
    let m = 0;
    for (let i = 0; i < n; i++) m += arr[i];
    m /= n;
    let dev = 0;
    for (let i = 0; i < n; i++) {
        const u = arr[i] - m;
        dev += u * u;
    }
    return {mean: m, dev};
}

/**
 * Zero-mean NCC with both signals' statistics known. **Bit-identical** to
 * `ncc(a, b)`; see `nccStats`.
 * @param {{mean: number, dev: number}} sa statistics of `a`, `sb` of `b`
 */
function nccWith(a, sa, b, sb) {
    const n = Math.min(a.length, b.length);
    if (n === 0) return 0;
    if (sa.dev <= 0 || sb.dev <= 0) return 0;
    const ma = sa.mean, mb = sb.mean;
    let num = 0;
    for (let i = 0; i < n; i++) num += (a[i] - ma) * (b[i] - mb);
    const r = num / Math.sqrt(sa.dev * sb.dev);
    return r > 1 ? 1 : (r < -1 ? -1 : r);
}

function mean(arr) {
    let s = 0;
    for (let i = 0; i < arr.length; i++) s += arr[i];
    return arr.length ? s / arr.length : 0;
}

/**
 * The gate's two numbers. `darkFraction`: how much of the lower left panel is
 * essentially black — a **fraction** and not a mean, deliberately, because a
 * bright patch over a tenth of the region (our own overlay) would move a mean
 * past any threshold. `nameBoxFraction`: how much of the map-name box is
 * bright, the one thing gameplay does not draw.
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

/** Cheap pre-check: is this the in-game Tab screen at all? Runs before any NCC,
 * so ordinary gameplay never reaches the matcher. */
function TAB_SCREEN_GATE(gray, width, height) {
    const f = tabScreenFeatures(gray, width, height);
    return f.darkFraction >= GATE_MIN_DARK_FRACTION && f.nameBoxFraction >= GATE_MIN_NAME_BOX_FRACTION;
}

/**
 * The fraction of one relative region of a **raw** frame below (or at/above) a
 * luminance level: the gate's arithmetic straight off the capture, allocating
 * **nothing** — 1.40 ms over 21.9 % of the pixels against 5.5 ms for reducing
 * the whole frame first. Identical arithmetic to the luminance path, asserted.
 * @param {Uint8Array|Buffer} pixels 4 bytes per pixel
 * @param {{x,y,w,h}} rel region, as fractions of the frame
 * @param {number} level luminance threshold in 0..1
 * @param {boolean} below true counts pixels **under** `level`, false at/above
 * @param {string} [order] 'bgra' (default) or 'rgba'
 */
function rawRegionFraction(pixels, width, height, rel, level, below, order) {
    const n = width * height;
    if (pixels.length < n * 4) {
        throw new Error('rawRegionFraction: expected ' + (n * 4) + ' bytes, got ' + pixels.length);
    }
    const rgba = order === 'rgba';
    const rOff = rgba ? 0 : 2;
    const bOff = rgba ? 2 : 0;
    // The same rectangle `cropRegion` takes.
    const {x: x0, y: y0, width: cw, height: ch} = regionCropRect(width, height, rel);
    const cut = level * 255;
    let hit = 0;
    for (let y = 0; y < ch; y++) {
        let p = ((y0 + y) * width + x0) * 4;
        for (let x = 0; x < cw; x++, p += 4) {
            const luma = 0.299 * pixels[p + rOff] + 0.587 * pixels[p + 1] + 0.114 * pixels[p + bOff];
            if (below ? luma < cut : luma >= cut) hit++;
        }
    }
    return hit / (cw * ch);
}

/**
 * The Tab-screen gate straight off a raw capture: same verdict as
 * `TAB_SCREEN_GATE` at a quarter of the cost. The left panel is tested first
 * and returns early — the name box is never read on most frames.
 * @param {string} [order] 'bgra' (default) or 'rgba'
 */
function tabGateFromRaw(pixels, width, height, order) {
    const dark = rawRegionFraction(pixels, width, height, LEFT_PANEL_REL, GATE_DARK_LEVEL, true, order);
    if (dark < GATE_MIN_DARK_FRACTION) return false;
    const bright = rawRegionFraction(pixels, width, height, NAME_BOX_REL, GATE_NAME_BOX_LEVEL, false, order);
    return bright >= GATE_MIN_NAME_BOX_FRACTION;
}

/**
 * Reduce a frame to the 64x64 thumbnail the templates are stored as.
 * @param {object} [opts] `{region, size, offset, window}`; pass `region: null`
 *   when `gray` is already the cropped panel
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
    // From a window when given: the same rectangle out of a smaller buffer.
    const c = o.window ? cropWindow(o.window, shifted) : cropRegion(gray, width, height, shifted);
    return downsample(c.data, c.width, c.height, size);
}

/** The mean of the luminance NCC and the gradient-magnitude NCC — the score. */
function scoreThumbnail(thumb, thumbGrad, template, size) {
    const tpl = template instanceof Float32Array ? template : Float32Array.from(template);
    return (ncc(thumb, tpl) + ncc(thumbGrad, gradientMagnitude(tpl, size))) / 2;
}

/**
 * The thumbnails stored for one map key — **template variants**, one per view of
 * the panel. A key scores as the **max** over its variants, never their mean:
 * they are different pictures (0.69-0.76 against each other) and an average
 * matches neither. Accepts format 1 (`[0.1, …]`) and format 2 (`[[…], […]]`).
 * @param {Float32Array|number[]|Array<Float32Array|number[]>} entry
 * @returns {Array<Float32Array>}
 */
function templateVariants(entry) {
    // Before the `length` test: a prepared entry has no `length` of its own, so
    // asking about it first would report zero thumbnails.
    if (entry && entry.prepared) return entry.variants.map(v => v.tpl);
    if (!entry || !entry.length) return [];
    if (entry instanceof Float32Array) return [entry];
    const first = entry[0];
    if (Array.isArray(first) || ArrayBuffer.isView(first)) {
        return Array.from(entry, v => (v instanceof Float32Array ? v : Float32Array.from(v)));
    }
    return [Float32Array.from(entry)];
}

/**
 * Everything about a template set that does not depend on the frame. **Template
 * work never happens on a tick**: this runs when `templates.json` is read and
 * when a pack is installed. Same functions in the same order as the per-tick
 * code, so scores do not move; `matchMap` accepts either shape.
 * @param {Object<string, *>} templates key → variants, as `templateVariants` takes
 */
function prepareTemplates(templates, size) {
    const n = size || DEFAULT_SIZE;
    const out = {};
    for (const key of Object.keys(templates || {})) {
        const variants = templateVariants(templates[key]).map(tpl => {
            const grad = gradientMagnitude(tpl, n);
            return {tpl, grad, tplStats: nccStats(tpl), gradStats: nccStats(grad)};
        });
        if (!variants.length) continue;
        out[key] = {prepared: true, variants};
    }
    return out;
}

/** The prepared variants of one entry, preparing it on the spot if needed. */
function preparedVariants(entry, size) {
    if (entry && entry.prepared) return entry.variants;
    return templateVariants(entry).map(tpl => {
        const grad = gradientMagnitude(tpl, size);
        return {tpl, grad, tplStats: nccStats(tpl), gradStats: nccStats(grad)};
    });
}

/**
 * Is this (score, margin) pair good enough to switch the overlay? Either
 * branch suffices: `score` >= 0.80 with a 0.10 lead (a solo Tab screen measures
 * 0.99 / 0.49), or `margin` >= 0.60 with a 0.15 lead (a party one, 0.70 / 0.29).
 * The branch's *name* comes back, not `true`, so the caller can log which fired.
 * @param {number} margin best minus runner-up
 * @param {object} [opts] the four thresholds, defaulting to the constants above
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
 * Match a frame against the templates. **Linear in installed variants**, and it
 * has to stay that way: coarse-to-fine prefiltering was measured and rejected
 * because it changes decisions (`docs/agents/detection.md`).
 * @param {Float32Array} gray luminance frame, or null with `opts.window`
 * @param {Object<string, *>} templates key → one thumbnail or a list of them
 * @param {object} [opts] `region` (default `MAP_PANEL_REL`; `null` = `gray` is
 *   already the panel), `size`, the four `acceptMatch` thresholds, `gate`
 *   (false when the panel is pre-cropped), `window`, `report` (always return
 *   the object, `accepted` saying whether the thresholds were met)
 * @returns {{key, score, second, margin, scores, accepted, acceptedBy, panelMean}|null}
 */
function matchMap(gray, width, height, templates, opts) {
    const o = opts || {};
    const gate = o.gate === undefined ? true : o.gate;
    const size = o.size || DEFAULT_SIZE;

    if (gate && !TAB_SCREEN_GATE(gray, width, height)) {
        return o.report ? {key: null, score: 0, second: 0, margin: 0, scores: {}, accepted: false, gated: true} : null;
    }

    // One thumbnail per candidate alignment (just one for a pre-cropped panel).
    const region = o.region === undefined ? MAP_PANEL_REL : o.region;
    const offsets = region ? (o.offsets || DEFAULT_OFFSETS) : [null];
    // With a `window`, `gray` is the window's data while `width`/`height` still
    // describe the **whole** frame, so every fraction and offset is unchanged.
    const win = o.window || frameWindow(gray, width, height, null);
    const cells = size * size;
    const views = offsets.map((offset, i) => {
        const thumbBuf = scratch(SCRATCH.map, 2 * i, cells);
        const shifted = offset
            ? {x: region.x + offset.dx, y: region.y + offset.dy, w: region.w, h: region.h}
            : region;
        const thumb = region
            ? windowThumbInto(win, shifted, size, size, thumbBuf)
            : resampleInto(gray, 0, width, width, height, size, size, thumbBuf);
        const grad = gradientInto(thumb, size, size, scratch(SCRATCH.map, 2 * i + 1, cells));
        return {thumb, grad, offset, thumbStats: nccStats(thumb), gradStats: nccStats(grad)};
    });

    // The **unshifted** view's mean, so it describes the frame rather than the
    // best-scoring alignment: it tells a genuinely dim panel (a party Tab
    // screen) from one the capture slid off. Logged with `no-match`.
    const base = views.find(v => !v.offset || (!v.offset.dx && !v.offset.dy)) || views[0];
    const panelMean = base ? mean(base.thumb) : 0;

    // Each template keeps its best alignment **and** its best variant, per
    // template, so nothing favours whichever map is checked first.
    const scores = {};
    let bestKey = null, best = -Infinity, second = -Infinity;
    for (const key of Object.keys(templates)) {
        const variants = preparedVariants(templates[key], size);
        let s = -Infinity;
        for (const {tpl, grad, tplStats, gradStats} of variants) {
            for (const view of views) {
                const v = (nccWith(view.thumb, view.thumbStats, tpl, tplStats)
                    + nccWith(view.grad, view.gradStats, grad, gradStats)) / 2;
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
    return acceptedBy ? result : null;
}

/*
 * ─── The main menu ──────────────────────────────────────────────────────────
 * Same two-signal NCC on a different region, with one template — so no
 * runner-up and no margin, just a score against a threshold. The streak that
 * turns it into a decision is in `src/core/map-detector.js`.
 */

/**
 * Reduce a frame to the wide thumbnail the menu template is stored as.
 * @param {object} [opts] `{width, height, offset, window}` — template
 *   dimensions and an alignment offset in fractions of the frame
 */
function menuThumbnail(gray, width, height, opts) {
    const o = opts || {};
    const tw = o.width || MENU_TEMPLATE_WIDTH;
    const th = o.height || MENU_TEMPLATE_HEIGHT;
    const offset = o.offset;
    const region = offset
        ? {x: MENU_STRIP_REL.x + offset.dx, y: MENU_STRIP_REL.y + offset.dy, w: MENU_STRIP_REL.w, h: MENU_STRIP_REL.h}
        : MENU_STRIP_REL;
    const c = o.window ? cropWindow(o.window, region) : cropRegion(gray, width, height, region);
    return resample(c.data, c.width, c.height, tw, th);
}

/**
 * Is this frame the game's main menu?
 * @param {number[]|Float32Array} template the stored strip thumbnail
 * @param {object} [opts] `width`/`height`, `minScore` (0.75), `offsets`,
 *   `window`, `prepared`
 * @returns {{score: number, accepted: boolean}} `score` is -1 with no template
 */
function matchMenu(gray, width, height, template, opts) {
    const o = opts || {};
    if (!template || !template.length) return {score: -1, accepted: false};
    const tw = o.width || MENU_TEMPLATE_WIDTH;
    const th = o.height || MENU_TEMPLATE_HEIGHT;
    const minScore = o.minScore === undefined ? MENU_MIN_SCORE : o.minScore;
    const tpl = template instanceof Float32Array ? template : Float32Array.from(template);
    // Once per call, not once per offset — there are 25 of them and none of
    // this depends on the frame. `o.prepared` hoists it out of the tick.
    const prep = o.prepared || {
        tpl, grad: gradientMagnitude(tpl, tw, th),
        tplStats: nccStats(tpl)
    };
    const gradStats = prep.gradStats || nccStats(prep.grad);

    const win = o.window || frameWindow(gray, width, height, null);
    const thumbBuf = scratch(SCRATCH.menu, 0, tw * th);
    const gradBuf = scratch(SCRATCH.menu, 1, tw * th);
    let best = -Infinity;
    for (const offset of (o.offsets || MENU_OFFSETS)) {
        const region = offset
            ? {x: MENU_STRIP_REL.x + offset.dx, y: MENU_STRIP_REL.y + offset.dy, w: MENU_STRIP_REL.w, h: MENU_STRIP_REL.h}
            : MENU_STRIP_REL;
        const thumb = windowThumbInto(win, region, tw, th, thumbBuf);
        const thumbGrad = gradientInto(thumb, tw, th, gradBuf);
        const score = (nccWith(thumb, nccStats(thumb), prep.tpl, prep.tplStats)
            + nccWith(thumbGrad, nccStats(thumbGrad), prep.grad, gradStats)) / 2;
        if (score > best) best = score;
    }
    return {score: best, accepted: best >= minScore};
}

/**
 * The menu template's frame-independent half, for the frame source to hold
 * across ticks. Same values as `matchMenu` would compute itself.
 */
function prepareMenuTemplate(template, tw, th) {
    if (!template || !template.length) return null;
    const width = tw || MENU_TEMPLATE_WIDTH;
    const height = th || MENU_TEMPLATE_HEIGHT;
    const tpl = template instanceof Float32Array ? template : Float32Array.from(template);
    const grad = gradientMagnitude(tpl, width, height);
    return {tpl, grad, tplStats: nccStats(tpl), gradStats: nccStats(grad)};
}

module.exports = {
    MAP_PANEL_REL,
    TAB_PANEL_REL,
    TAB_LEGEND_REL,
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
    toGrayScaledRegion,
    regionCropRect,
    regionSearchBox,
    frameWindow,
    cropWindow,
    nccStats,
    nccWith,
    prepareTemplates,
    preparedVariants,
    prepareMenuTemplate,
    cropRegion,
    downsample,
    resample,
    gradientMagnitude,
    ncc,
    tabScreenFeatures,
    TAB_SCREEN_GATE,
    rawRegionFraction,
    tabGateFromRaw,
    frameThumbnail,
    scoreThumbnail,
    templateVariants,
    acceptMatch,
    matchMap,
    menuThumbnail,
    matchMenu
};
