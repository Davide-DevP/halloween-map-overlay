// Three marker styles over the owner's real Tab screenshot (killer view, all
// three exit types discovered) so the look can be chosen before anything is built.
// usage: node variants.js <sharp> <screenshot> <exits.json> <gas.json> <outDir>
const sharp = require(process.argv[2]);
const fs = require('fs');
const [shot, exitsF, gasF, outDir] = process.argv.slice(3);
const OX = 889, OY = 158;
const exits = JSON.parse(fs.readFileSync(exitsF)).points;
const gas = JSON.parse(fs.readFileSync(gasF)).points;
// order written by the earlier register run: gate, cellar, car, then 8 cellars, 2 gates, 3 cars
const TYPES = ['gate', 'cellar', 'car', 'cellar', 'cellar', 'cellar', 'cellar', 'cellar', 'cellar', 'cellar', 'cellar', 'gate', 'gate', 'car', 'car', 'car'];
// the legend colours of the bundled maps, slightly desaturated for a dark UI
const C = {cellar: '#e0605a', gate: '#4fc58a', car: '#5fb4ea', gas: '#f0cf55'};
const INK = '#d9d0bf';

const ring = (x, y, c) => `<circle cx="${x}" cy="${y}" r="19" fill="none" stroke="${c}" stroke-width="1.75" stroke-opacity="0.9"/>`;
const diamond = (x, y, c, r = 13) => `<path d="M${x} ${y - r}L${x + r} ${y}L${x} ${y + r}L${x - r} ${y}Z" fill="none" stroke="${c}" stroke-width="1.75" stroke-opacity="0.95"/>`;
function brackets(x, y, c, r = 18, l = 7) {
    const p = [];
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const cx = x + sx * r, cy = y + sy * r;
        p.push(`M${cx - sx * l} ${cy}L${cx} ${cy}L${cx} ${cy - sy * l}`);
    }
    return `<path d="${p.join('')}" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="square" stroke-opacity="0.95"/>`;
}
const gasBrackets = (x, y, c) => `<g transform="rotate(45 ${x} ${y})">${brackets(x, y, c, 11, 5)}</g>`;
const halo = (x, y, c) => `<circle cx="${x}" cy="${y}" r="17" fill="${c}" fill-opacity="0.16"/><circle cx="${x}" cy="${y}" r="17" fill="none" stroke="${c}" stroke-width="1" stroke-opacity="0.45"/><circle cx="${x}" cy="${y}" r="3.2" fill="${c}"/>`;
const gasHalo = (x, y, c) => `<path d="M${x} ${y - 14}L${x + 14} ${y}L${x} ${y + 14}L${x - 14} ${y}Z" fill="${c}" fill-opacity="0.16" stroke="${c}" stroke-width="1" stroke-opacity="0.5"/><path d="M${x} ${y - 4}L${x + 4} ${y}L${x} ${y + 4}L${x - 4} ${y}Z" fill="${c}"/>`;

const STYLES = {
    'A-thin-rings': {exit: ring, gas: diamond, name: 'A  Thin rings'},
    'B-brackets': {exit: brackets, gas: gasBrackets, name: 'B  Corner brackets'},
    'C-halo-dots': {exit: halo, gas: gasHalo, name: 'C  Dot + halo'}
};

function legend(style) {
    // sits in the empty lower half of the game's own Objectives panel
    const rows = [['cellar', 'STORM CELLAR'], ['gate', 'ESCAPE GATE'], ['car', 'CAR'], ['gas', 'GAS CAN']];
    let s = `<text x="302" y="770" font-family="Bahnschrift Condensed, Arial Narrow, Arial" font-size="15" letter-spacing="2" fill="${INK}" fill-opacity="0.55">POSSIBLE LOCATIONS</text>`;
    s += `<line x1="302" y1="780" x2="560" y2="780" stroke="${INK}" stroke-opacity="0.25"/>`;
    rows.forEach(([k, label], i) => {
        const x = 320, y = 812 + i * 30;
        const small = k === 'gas' ? style.gas(x, y, C[k]) : style.exit(x, y, C[k]);
        s += `<g transform="translate(${x} ${y}) scale(0.6) translate(${-x} ${-y})">${small}</g>`;
        s += `<text x="${x + 24}" y="${y + 6}" font-family="Bahnschrift Condensed, Arial Narrow, Arial" font-size="18" letter-spacing="1" fill="${INK}">${label}</text>`;
    });
    return s;
}

(async () => {
    const meta = await sharp(shot).metadata();
    for (const [file, style] of Object.entries(STYLES)) {
        let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${meta.width}" height="${meta.height}">`;
        exits.forEach((p, i) => s += style.exit(p.px + OX, p.py + OY, C[TYPES[i]]));
        gas.forEach(p => s += style.gas(p.px + OX, p.py + OY, C.gas));
        s += legend(style);
        s += `<text x="889" y="132" font-family="Arial" font-size="20" fill="#ffffff" fill-opacity="0.85">${style.name}</text></svg>`;
        const out = `${outDir}/variant-${file}.png`;
        await sharp(shot).composite([{input: Buffer.from(s)}]).png().toFile(out);
        await sharp(out).extract({left: 250, top: 120, width: 1420, height: 830}).toFile(`${outDir}/crop-${file}.png`);
        console.log(out);
    }
})();
