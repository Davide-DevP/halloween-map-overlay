// Silhouette of the playable area on the in-game Tab map (civilian view): the red
// boundary line is the wall, flood from the border is outside.
// usage: node redfill.js <sharp> <in> <out> <dilate>
const sharp = require(process.argv[2]);
const [inF, outF, rArg] = process.argv.slice(3); const R = Number(rArg || 1);
(async () => {
    const {data, info} = await sharp(inF).removeAlpha().raw().toBuffer({resolveWithObject: true});
    const {width: W, height: H} = info;
    const wall = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 3, r = data[i], g = data[i + 1], b = data[i + 2];
        if (!(r > 105 && r - g > 28 && r - b > 24)) continue;
        for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < W && ny < H) wall[ny * W + nx] = 1;
        }
    }
    const outside = new Uint8Array(W * H), stack = [];
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
    let n = 0; const out = Buffer.alloc(W * H);
    for (let i = 0; i < W * H; i++) if (!outside[i]) { out[i] = 255; n++; }
    console.log('inside fraction', (n / (W * H)).toFixed(3));
    await sharp(out, {raw: {width: W, height: H, channels: 1}}).png().toFile(outF);
})();
