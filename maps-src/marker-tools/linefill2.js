// Playable-area silhouette for the dark "glow outline" map style, WITHOUT the
// glow: the bright boundary line is a wall, everything reachable from the image
// border is outside, the largest remaining component is the map.
// (area.js thresholded brightness instead, which swallowed ~6 px of glow on
// every side and so over-estimated the map's size by ~4 %.)
// usage: node linefill.js <sharp> <file> <lineThreshold> <maskOut.png>
const sharp = require(process.argv[2]);
const [file, thrArg, maskOut, rArg] = process.argv.slice(3);
const R = Number(rArg || 1);
const thr = Number(thrArg);
(async () => {
    const {data, info} = await sharp(file).removeAlpha().greyscale().raw().toBuffer({resolveWithObject: true});
    const {width: W, height: H} = info;
    const wall = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (data[y * W + x] < thr) continue;
        // 1 px dilation so a diagonal 1 px line cannot be slipped through
        for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < W && ny < H) wall[ny * W + nx] = 1;
        }
    }
    const outside = new Uint8Array(W * H);
    const stack = [];
    for (let x = 0; x < W; x++) stack.push(x, (H - 1) * W + x);
    for (let y = 0; y < H; y++) stack.push(y * W, y * W + W - 1);
    while (stack.length) {
        const p = stack.pop();
        if (outside[p] || wall[p]) continue;
        outside[p] = 1;
        const x = p % W, y = (p - x) / W;
        if (x > 0) stack.push(p - 1);
        if (x < W - 1) stack.push(p + 1);
        if (y > 0) stack.push(p - W);
        if (y < H - 1) stack.push(p + W);
    }
    // largest component of "not outside"
    const label = new Int32Array(W * H);
    let best = null, id = 0;
    for (let s = 0; s < W * H; s++) {
        if (outside[s] || label[s]) continue;
        id++;
        let n = 0, minx = W, maxx = 0, miny = H, maxy = 0;
        const st = [s];
        label[s] = id;
        while (st.length) {
            const p = st.pop(), x = p % W, y = (p - x) / W;
            n++;
            if (x < minx) minx = x;
            if (x > maxx) maxx = x;
            if (y < miny) miny = y;
            if (y > maxy) maxy = y;
            for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1]) {
                if (q >= 0 && !outside[q] && !label[q]) {
                    label[q] = id;
                    st.push(q);
                }
            }
        }
        if (!best || n > best.n) best = {id, n, minx, maxx, miny, maxy};
    }
    console.log(`${file.split(/[\\/]/).pop()}  x ${best.minx}..${best.maxx}  y ${best.miny}..${best.maxy}  fill=${(best.n / ((best.maxx - best.minx) * (best.maxy - best.miny))).toFixed(3)}`);
    const out = Buffer.alloc(W * H);
    for (let i = 0; i < W * H; i++) out[i] = label[i] === best.id ? 255 : 0;
    await sharp(out, {raw: {width: W, height: H, channels: 1}}).png().toFile(maskOut);
})();
