// Extract the exit rings (red = storm cellar, green = escape gate, blue = car)
// from a bundled map: colour mask -> Hough vote for circle centres -> peaks.
// Overlapping rings of the same colour stay separate because each votes for
// its own centre. The legend (top-left / top-right box) is excluded by y/x.
// usage: node exits.js <sharp> <map.png> <legendX0> <legendY0> <legendX1> <legendY1> <out.json>
const sharp = require(process.argv[2]);
const fs = require('fs');
const file = process.argv[3];
const [lx0, ly0, lx1, ly1] = process.argv.slice(4, 8).map(Number);
const outJson = process.argv[8];
const COLOURS = {
    cellar: (r, g, b) => r > 95 && g < 100 && r - g > 40 && r - b > 40,
    gate: (r, g, b) => g > 140 && r < 110 && b < 140,
    car: (r, g, b) => b > 190 && r < 130 && g > 120
};
(async () => {
    const {data, info} = await sharp(file).removeAlpha().raw().toBuffer({resolveWithObject: true});
    const {width: W, height: H} = info;
    const result = {};
    for (const [name, test] of Object.entries(COLOURS)) {
        const pts = [];
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            if (x >= lx0 && x < lx1 && y >= ly0 && y < ly1) continue;
            const i = (y * W + x) * 3;
            if (test(data[i], data[i + 1], data[i + 2])) pts.push([x, y]);
        }
        let found = [];
        for (let R = 14; R <= 28; R++) {
            const acc = new Float32Array(W * H);
            for (const [x, y] of pts) {
                for (let a = 0; a < 72; a++) {
                    const cx = Math.round(x + R * Math.cos(a * Math.PI / 36)), cy = Math.round(y + R * Math.sin(a * Math.PI / 36));
                    if (cx >= 0 && cy >= 0 && cx < W && cy < H) acc[cy * W + cx]++;
                }
            }
            // smooth 3x3 and collect strong cells
            for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
                let s = 0;
                for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += acc[(y + dy) * W + x + dx];
                // a full ring of radius R has ~2*pi*R*thickness pixels; normalise by circumference
                const score = s / (2 * Math.PI * R);
                if (score > 1.2) found.push({x, y, R, score});
            }
        }
        found.sort((a, b) => b.score - a.score);
        const peaks = [];
        for (const f of found) {
            if (peaks.some(p => Math.hypot(p.x - f.x, p.y - f.y) < 14)) continue;
            peaks.push(f);
        }
        // keep peaks within 45 % of the best: weaker ones are arcs/noise
        const best = peaks.length ? peaks[0].score : 0;
        result[name] = peaks.filter(p => p.score > best * 0.45).map(p => ({x: p.x, y: p.y, R: p.R, score: +p.score.toFixed(1)}));
        console.log(name, result[name].length, result[name].map(p => `(${p.x},${p.y} r${p.R} s${p.score})`).join(' '));
    }
    fs.writeFileSync(outJson, JSON.stringify({size: [W, H], exits: result}, null, 2));
})();
