// erode a binary mask by r px (square element). usage: node erode.js <sharp> in out r
const sharp = require(process.argv[2]);
const [inF, outF, rArg] = process.argv.slice(3); const r = Number(rArg);
(async () => {
    const {data, info} = await sharp(inF).greyscale().raw().toBuffer({resolveWithObject: true});
    const {width: W, height: H} = info; const out = Buffer.alloc(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let keep = data[y * W + x] > 127;
        for (let dy = -r; keep && dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H || data[ny * W + nx] <= 127) { keep = false; break; }
        }
        out[y * W + x] = keep ? 255 : 0;
    }
    await sharp(out, {raw: {width: W, height: H, channels: 1}}).png().toFile(outF);
})();
