// Bounding box of the playable area: the map is drawn brighter inside its
// boundary than outside, so blur -> threshold -> largest connected component.
// usage: node area.js <sharp> <file> <threshold> x0 y0 x1 y1 [maskOut.png]
const sharp = require(process.argv[2]);
const file = process.argv[3];
const thr = Number(process.argv[4]);
const [x0, y0, x1, y1] = process.argv.slice(5, 9).map(Number);
const maskOut = process.argv[9];
(async () => {
    const {data, info} = await sharp(file).removeAlpha().greyscale().blur(2.5).raw().toBuffer({resolveWithObject: true});
    const {width: W, height: H} = info;
    const mask = new Uint8Array(W * H);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (data[y * W + x] >= thr) mask[y * W + x] = 1;
    const label = new Int32Array(W * H);
    let best = null, id = 0;
    for (let s = 0; s < W * H; s++) {
        if (!mask[s] || label[s]) continue;
        id++;
        let minx = W, maxx = 0, miny = H, maxy = 0, n = 0;
        const stack = [s];
        label[s] = id;
        while (stack.length) {
            const p = stack.pop(), x = p % W, y = (p - x) / W;
            n++;
            if (x < minx) minx = x;
            if (x > maxx) maxx = x;
            if (y < miny) miny = y;
            if (y > maxy) maxy = y;
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const nx = x + dx, ny = y + dy;
                if (nx < x0 || ny < y0 || nx >= x1 || ny >= y1) continue;
                const q = ny * W + nx;
                if (mask[q] && !label[q]) {
                    label[q] = id;
                    stack.push(q);
                }
            }
        }
        if (!best || n > best.n) best = {id, minx, maxx, miny, maxy, n};
    }
    const w = best.maxx - best.minx, h = best.maxy - best.miny;
    console.log(`${file.split(/[\\/]/).pop()} ${W}x${H}  x ${best.minx}..${best.maxx} (${w})  y ${best.miny}..${best.maxy} (${h})  aspect=${(w / h).toFixed(4)}  fill=${(best.n / (w * h)).toFixed(3)}`);
    if (maskOut) {
        const out = Buffer.alloc(W * H);
        for (let i = 0; i < W * H; i++) out[i] = label[i] === best.id ? 255 : 0;
        await sharp(out, {raw: {width: W, height: H, channels: 1}}).png().toFile(maskOut);
    }
})();
