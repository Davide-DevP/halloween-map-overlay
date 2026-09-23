const {test} = require('node:test');
const assert = require('node:assert');

const M = require('../src/core/map-detector/matcher');
const TEMPLATE_FILE = require('../src/core/map-detector/templates.json');

/*
 * `gradientMagnitude` (interior without clamping) and `resample` (column
 * weights computed once per call) were rewritten for speed. Both sides of
 * `detector-equality.test.js` share them, so it cannot see a drift here: these
 * are the pre-rewrite loops, verbatim, and the results must match to the bit.
 */

function referenceGradient(thumb, width, height) {
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

function referenceResample(gray, width, height, outWidth, outHeight) {
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

function randomArray(length, seed) {
    let s = seed;
    return Float32Array.from({length}, () => (s = (s * 16807) % 2147483647) / 2147483647);
}

function assertSameBits(actual, expected, what) {
    assert.strictEqual(actual.length, expected.length, what + ': length');
    for (let i = 0; i < expected.length; i++) {
        if (!Object.is(actual[i], expected[i])) {
            assert.fail(what + ': cell ' + i + ' is ' + actual[i] + ', expected ' + expected[i]);
        }
    }
}

test('gradientMagnitude is bit-identical to the clamped reference, borders and tiny sizes included', () => {
    const sizes = [[1, 1], [2, 1], [1, 2], [2, 2], [3, 3], [3, 5], [7, 2], [64, 64], [96, 12], [37, 21]];
    sizes.forEach(([w, h], i) => {
        const a = randomArray(w * h, 7 + i);
        assertSameBits(M.gradientMagnitude(a, w, h), referenceGradient(a, w, h), 'grad ' + w + 'x' + h);
    });
    for (const values of Object.values(TEMPLATE_FILE.templates)) {
        for (const tpl of values) {
            const t = Float32Array.from(tpl);
            assertSameBits(M.gradientMagnitude(t, TEMPLATE_FILE.size), referenceGradient(t, TEMPLATE_FILE.size), 'template');
        }
    }
});

test('resample is bit-identical to the per-row reference, up and down', () => {
    const src = randomArray(255 * 257, 3);
    for (const [ow, oh] of [[64, 64], [96, 12], [1, 1], [37, 21], [255, 257], [300, 500]]) {
        assertSameBits(M.resample(src, 255, 257, ow, oh), referenceResample(src, 255, 257, ow, oh), 'resample ' + ow + 'x' + oh);
    }
});

test('matchMap and matchMenu reuse scratch buffers without leaking state between calls', () => {
    const prepared = M.prepareTemplates(TEMPLATE_FILE.templates, TEMPLATE_FILE.size);
    const a = randomArray(640 * 360, 11), b = randomArray(640 * 360, 12);
    const opts = {size: TEMPLATE_FILE.size, report: true, gate: false};
    const first = M.matchMap(a, 640, 360, prepared, opts);
    const kept = JSON.stringify(first);
    M.matchMap(b, 640, 360, prepared, opts);
    assert.strictEqual(JSON.stringify(first), kept, 'a returned result is not touched by the next call');
    assert.deepStrictEqual(M.matchMap(a, 640, 360, prepared, opts), first);

    const menu = TEMPLATE_FILE.menu;
    const mOpts = {width: menu.width, height: menu.height};
    const m1 = M.matchMenu(a, 640, 360, menu.template, mOpts);
    M.matchMenu(b, 640, 360, menu.template, mOpts);
    assert.deepStrictEqual(M.matchMenu(a, 640, 360, menu.template, mOpts), m1);
});
