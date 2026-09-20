// Register a source image onto a bundled map by maximising the overlap (IoU) of
// the two playable-area silhouettes under x' = sx*x + tx, y' = sy*y + ty, then
// carry the gas rings across and draw a preview.
// usage: node register.js <sharp> <srcMask> <ourMask> <ourMap> <out.png> <out.json> "x,y;x,y;..."
const sharp = require(process.argv[2]);
const [srcMaskF, ourMaskF, ourMapF, outPng, outJson, ringsArg] = process.argv.slice(3);
const rings = ringsArg.split(';').map(p => p.split(',').map(Number));
const fs = require('fs');

async function load(f) {
    const {data, info} = await sharp(f).greyscale().raw().toBuffer({resolveWithObject: true});
    return {d: data, W: info.width, H: info.height};
}

function bbox(m) {
    let x0 = m.W, x1 = 0, y0 = m.H, y1 = 0;
    for (let y = 0; y < m.H; y++) for (let x = 0; x < m.W; x++) if (m.d[y * m.W + x] > 127) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
    }
    return {x0, x1, y0, y1};
}

function iou(src, our, sx, sy, tx, ty, step) {
    let inter = 0, uni = 0;
    for (let y = 0; y < our.H; y += step) for (let x = 0; x < our.W; x += step) {
        const a = our.d[y * our.W + x] > 127;
        const u = Math.round((x - tx) / sx), v = Math.round((y - ty) / sy);
        const b = u >= 0 && v >= 0 && u < src.W && v < src.H && src.d[v * src.W + u] > 127;
        if (a && b) inter++;
        if (a || b) uni++;
    }
    return inter / uni;
}

(async () => {
    const src = await load(srcMaskF), our = await load(ourMaskF);
    const sb = bbox(src), ob = bbox(our);
    let best = {
        sx: (ob.x1 - ob.x0) / (sb.x1 - sb.x0), sy: (ob.y1 - ob.y0) / (sb.y1 - sb.y0), tx: 0, ty: 0, score: -1
    };
    const s0 = (best.sx + best.sy) / 2;
    best.sx = best.sy = s0;
    best.tx = (ob.x0 + ob.x1) / 2 - s0 * (sb.x0 + sb.x1) / 2;
    best.ty = (ob.y0 + ob.y1) / 2 - s0 * (sb.y0 + sb.y1) / 2;
    best.score = iou(src, our, best.sx, best.sy, best.tx, best.ty, 3);
    // coordinate descent, coarse to fine; anisotropy allowed (the source may be
    // a slightly stretched repost)
    for (const [ds, dt, step] of [[0.01, 4, 3], [0.004, 2, 3], [0.002, 1, 2], [0.001, 0.5, 1]]) {
        let improved = true;
        while (improved) {
            improved = false;
            for (const [k, d] of [['sx', ds], ['sy', ds], ['tx', dt], ['ty', dt], ['both', ds]]) {
                for (const sign of [1, -1]) {
                    const c = {...best};
                    if (k === 'both') {
                        c.sx += sign * d;
                        c.sy += sign * d;
                    } else c[k] += sign * d;
                    c.score = iou(src, our, c.sx, c.sy, c.tx, c.ty, step);
                    const ref = iou(src, our, best.sx, best.sy, best.tx, best.ty, step);
                    if (c.score > ref + 1e-6) {
                        best = c;
                        improved = true;
                    }
                }
            }
        }
    }
    best.score = iou(src, our, best.sx, best.sy, best.tx, best.ty, 1);
    const mapMeta = await sharp(ourMapF).metadata();
    const pts = rings.map(([x, y]) => ({
        px: best.sx * x + best.tx, py: best.sy * y + best.ty
    })).map(p => ({x: +(p.px / mapMeta.width).toFixed(4), y: +(p.py / mapMeta.height).toFixed(4), px: Math.round(p.px), py: Math.round(p.py)}));
    console.log(ourMapF.split(/[\\/]/).pop(), `sx=${best.sx.toFixed(4)} sy=${best.sy.toFixed(4)} tx=${best.tx.toFixed(1)} ty=${best.ty.toFixed(1)} IoU=${best.score.toFixed(4)}`);
    fs.writeFileSync(outJson, JSON.stringify({transform: best, size: [mapMeta.width, mapMeta.height], points: pts}, null, 2));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${mapMeta.width}" height="${mapMeta.height}">` +
        pts.map(p => `<circle cx="${p.px}" cy="${p.py}" r="10" fill="none" stroke="#ffd83a" stroke-width="3"/><circle cx="${p.px}" cy="${p.py}" r="2" fill="#ffd83a"/>`).join('') + '</svg>';
    await sharp(ourMapF).composite([{input: Buffer.from(svg)}]).png().toFile(outPng);
})();
