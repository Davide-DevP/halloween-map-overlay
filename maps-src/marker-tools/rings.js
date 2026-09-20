// Find the yellow gas-can rings in a source image:
// yellow pixels -> connected components -> ring centres.
const sharp = require(process.argv[2]);
const file = process.argv[3];
(async () => {
    const {data, info} = await sharp(file).removeAlpha().raw().toBuffer({resolveWithObject: true});
    const {width: W, height: H} = info;
    const mask = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
        const r = data[i * 3], g = data[i * 3 + 1], b = data[i * 3 + 2];
        // ring yellow ~ (250,215,70)
        if (r > 200 && g > 170 && b < 130 && r - b > 110 && Math.abs(r - g) < 70) mask[i] = 1;
    }
    const seen = new Uint8Array(W * H), out = [];
    for (let s = 0; s < W * H; s++) {
        if (!mask[s] || seen[s]) continue;
        let minx = W, maxx = 0, miny = H, maxy = 0, n = 0;
        const stack = [s];
        seen[s] = 1;
        while (stack.length) {
            const p = stack.pop(), x = p % W, y = (p - x) / W;
            n++;
            if (x < minx) minx = x;
            if (x > maxx) maxx = x;
            if (y < miny) miny = y;
            if (y > maxy) maxy = y;
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
                const nx = x + dx, ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
                const q = ny * W + nx;
                if (mask[q] && !seen[q]) {
                    seen[q] = 1;
                    stack.push(q);
                }
            }
        }
        const w = maxx - minx + 1, h = maxy - miny + 1;
        if (n > 100 && w > 18 && w < 90 && h > 18 && h < 90) out.push({cx: (minx + maxx) / 2, cy: (miny + maxy) / 2, w, h, n});
    }
    console.log(file.split(/[\\/]/).pop(), W + 'x' + H, out.length, 'rings');
    for (const o of out) console.log(' ', o.cx, o.cy, o.w + 'x' + o.h, o.n);
})();
