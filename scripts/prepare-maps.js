#!/usr/bin/env node
'use strict';

/**
 * Build-prep script (dev only — `sharp` is a devDependency): crops each
 * `maps-src/` image to the map square into `maps/<CREATOR>/<Map Name>.png`,
 * drops the loose `maps/*.webp` copies once every crop succeeded, and
 * rasterises the icon SVG to `build/icon.png`, `build/icon.ico`,
 * `src/images/icon.png` (the tile) and `src/images/tray.png` (the mark alone).
 * `--icons-only` skips the maps.
 * Crop edges are **detected, never hard-coded** — see "Map crop detection" in
 * `docs/agents/maps-authoring.md`.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'maps-src');
const MAPS_DIR = path.join(ROOT, 'maps');
const CREATOR = 'deftyconchgaming';
const OUT_DIR = path.join(MAPS_DIR, CREATOR);

/** Source file stem → shipped map name. */
const MAP_NAMES = {
    east_haddonfield: 'East Haddonfield',
    haddonfield_heights: 'Haddonfield Heights',
    orange_grove_estates: 'Orange Grove Estates',
    haddonfield_town_center: 'Haddonfield Town Center'
};

// Mean luminance below which a row/column is the dark map square rather than
// the letterbox around it (measured: letterbox ≈ 45–49, map edges ≈ 0–5).
const LETTERBOX_CUTOFF = 30;
// A drawn frame line is far brighter than its surroundings, across most of the
// side it runs along.
const FRAME_BRIGHTNESS = 110;
const FRAME_COVERAGE = 0.7;

function mkdirp(dir) {
    fs.mkdirSync(dir, {recursive: true});
}

/** Mean luminance of every column of a greyscale raw buffer. */
function columnMeans(gray, width, height) {
    const means = new Array(width).fill(0);
    for (let x = 0; x < width; x++) {
        let sum = 0;
        for (let y = 0; y < height; y++) sum += gray[y * width + x];
        means[x] = sum / height;
    }
    return means;
}

/** Mean luminance of every row, restricted to the columns [from..to]. */
function rowMeans(gray, width, height, from, to) {
    const span = to - from + 1;
    const means = new Array(height).fill(0);
    for (let y = 0; y < height; y++) {
        let sum = 0;
        for (let x = from; x <= to; x++) sum += gray[y * width + x];
        means[y] = sum / span;
    }
    return means;
}

/** Walk inwards from both ends of a luminance profile while it still looks like
 * letterbox. Outside-in, never "longest dark run": that is what keeps bright
 * content in the middle of the map from breaking the bounds. */
function darkSquareBounds(means) {
    let start = 0;
    while (start < means.length && means[start] > LETTERBOX_CUTOFF) start++;
    let end = means.length - 1;
    while (end >= 0 && means[end] > LETTERBOX_CUTOFF) end--;
    return {start, end};
}

/** How far in the crop must move to sit just inside a drawn frame line on this
 * side; 0 where there is no frame — two of the four sources have none. */
function frameInset(gray, width, from, to, across, isRow) {
    const span = across.to - across.from + 1;
    const step = to >= from ? 1 : -1;
    let inset = 0;
    for (let i = from; step > 0 ? i <= to : i >= to; i += step) {
        let bright = 0;
        for (let j = across.from; j <= across.to; j++) {
            const value = isRow ? gray[i * width + j] : gray[j * width + i];
            if (value >= FRAME_BRIGHTNESS) bright++;
        }
        if (bright >= span * FRAME_COVERAGE) {
            // Skip the line and any further pixels of the same stroke.
            inset = Math.abs(i - from) + 1;
            continue;
        }
        if (inset) break;
    }
    return inset;
}

async function cropMap(srcFile, outFile) {
    const image = sharp(srcFile);
    const meta = await image.metadata();
    const {data, info} = await image.clone().greyscale().raw().toBuffer({resolveWithObject: true});
    const {width, height} = info;

    const cols = darkSquareBounds(columnMeans(data, width, height));
    if (cols.start >= cols.end) throw new Error('map square not found horizontally');
    const rows = darkSquareBounds(rowMeans(data, width, height, cols.start, cols.end));
    if (rows.start >= rows.end) throw new Error('map square not found vertically');

    const square = {left: cols.start, right: cols.end, top: rows.start, bottom: rows.end};

    // A short probe only: a deep scan latches onto bright map content.
    const probe = 24;
    const acrossRows = {from: square.top, to: square.bottom};
    const acrossCols = {from: square.left, to: square.right};
    const left = square.left + frameInset(data, width, square.left, Math.min(square.left + probe, square.right), acrossRows, false);
    const right = square.right - frameInset(data, width, square.right, Math.max(square.right - probe, square.left), acrossRows, false);
    const top = square.top + frameInset(data, width, square.top, Math.min(square.top + probe, square.bottom), acrossCols, true);
    const bottom = square.bottom - frameInset(data, width, square.bottom, Math.max(square.bottom - probe, square.top), acrossCols, true);

    const cropWidth = right - left + 1;
    const cropHeight = bottom - top + 1;
    if (cropWidth < 100 || cropHeight < 100) {
        throw new Error(`implausible crop ${cropWidth}x${cropHeight}`);
    }

    await sharp(srcFile)
        .extract({left, top, width: cropWidth, height: cropHeight})
        .png({compressionLevel: 9})
        .toFile(outFile);

    return {
        source: `${meta.width}x${meta.height}`,
        square,
        crop: {left, top, width: cropWidth, height: cropHeight}
    };
}

/**
 * The mark: a map pin whose head is a carved pumpkin ("Lantern Pin", chosen by
 * the owner from a Claude Design board on 2026-09-23). One silhouette, so it
 * still reads as a location at 16 px when the face blurs. 1024 grid.
 * Why: docs/agents/maps-authoring.md § The app icon.
 */
const MARK_STEM = "M473.3 192.7L473.3 190C473.7 173.4 486.2 154.4 501.3 147.5L547.8 126.3C557.9 121.7 565.6 126.9 565.1 138L562.5 196C546.3 190.8 529.4 188 512 188C498.8 188 485.8 189.6 473.3 192.7Z";
const MARK_PIN = "M800 468C800 548.4 771.4 619.4 727.7 662L512 901L296.3 662C252.6 619.4 224 548.4 224 468C224 337.7 299.2 232 392 232C394 232 396.1 232.1 398.1 232.2C430.7 204.3 469.8 188 512 188C554.2 188 593.3 204.3 625.9 232.2C627.9 232.1 630 232 632 232C724.8 232 800 337.7 800 468ZM285 433L317.2 534.3L327.5 547.9L337.8 560.7L348 572.9L358.2 584.3L368.5 594.9L378.8 604.9L389 614L399.2 622.5L409.5 630.2L419.8 637.2L430 643.5L440.2 649L450.5 653.8L460 657.5L512 607L564 657.5L573.5 653.8L583.8 649L594 643.5L604.2 637.2L614.5 630.2L624.8 622.5L635 614L645.2 604.9L655.5 594.9L665.8 584.3L676 572.9L686.2 560.7L696.5 547.9L706.8 534.3L739 433L706.8 471.1L696.5 478.9L686.2 486.3L676 493.2L665.8 499.7L655.5 505.8L652 507.8L590 590.8L528 546.5L522.2 546.8L512 547L501.8 546.8L496 546.5L434 590.8L372 507.8L368.5 505.8L358.2 499.7L348 493.2L337.8 486.3L327.5 478.9L317.2 471.1ZM337 372L392 504L472 432ZM687 372L552 432L632 504Z";

/**
 * @param {{tile: boolean}} opts the mark on the app's rounded off-black tile
 *   (app, taskbar, installer), or alone on transparent (the tray).
 */
function iconSvg(opts = {}) {
    const tile = opts.tile !== false;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  ${tile ? '<rect width="1024" height="1024" rx="225" fill="#14100f"/>' : ''}
  <path fill="#6d4b24" d="${MARK_STEM}"/>
  <path fill="#e8853a" fill-rule="evenodd" d="${MARK_PIN}"/>
</svg>`;
}

/** A PNG-compressed ICO, the shape electron-builder itself writes (7 entries, 16 → 256). */
function encodeIco(pngs) {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(pngs.length, 4);
    const entries = [];
    let offset = 6 + 16 * pngs.length;
    for (const {size, png} of pngs) {
        const entry = Buffer.alloc(16);
        entry.writeUInt8(size >= 256 ? 0 : size, 0);
        entry.writeUInt8(size >= 256 ? 0 : size, 1);
        entry.writeUInt8(0, 2);
        entry.writeUInt8(0, 3);
        entry.writeUInt16LE(1, 4);
        entry.writeUInt16LE(32, 6);
        entry.writeUInt32LE(png.length, 8);
        entry.writeUInt32LE(offset, 12);
        entries.push(entry);
        offset += png.length;
    }
    return Buffer.concat([header, ...entries, ...pngs.map(p => p.png)]);
}

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

async function writeIcons() {
    const tileSvg = Buffer.from(iconSvg({tile: true}));
    const markSvg = Buffer.from(iconSvg({tile: false}));
    const render = (svg, px) => sharp(svg, {density: 384}).resize(px, px).png({compressionLevel: 9});
    const buildIcon = path.join(ROOT, 'build', 'icon.png');
    const buildIco = path.join(ROOT, 'build', 'icon.ico');
    const appIcon = path.join(ROOT, 'src', 'images', 'icon.png');
    const trayIcon = path.join(ROOT, 'src', 'images', 'tray.png');
    mkdirp(path.dirname(buildIcon));
    mkdirp(path.dirname(appIcon));
    await render(tileSvg, 512).toFile(buildIcon);
    await render(tileSvg, 256).toFile(appIcon);
    // The mark alone: a dark tile on a dark taskbar is a blob at 16 px.
    await render(markSvg, 64).toFile(trayIcon);
    const pngs = [];
    for (const size of ICO_SIZES) pngs.push({size, png: await render(tileSvg, size).toBuffer()});
    fs.writeFileSync(buildIco, encodeIco(pngs));
    console.log(`icon  → ${path.relative(ROOT, buildIcon)} (512x512)`);
    console.log(`icon  → ${path.relative(ROOT, buildIco)} (${ICO_SIZES.join('/')})`);
    console.log(`icon  → ${path.relative(ROOT, appIcon)} (256x256)`);
    console.log(`icon  → ${path.relative(ROOT, trayIcon)} (64x64, mark only)`);
}

async function main() {
    if (process.argv.includes('--icons-only')) {
        await writeIcons();
        return;
    }
    if (!fs.existsSync(SRC_DIR)) {
        throw new Error(`missing source directory ${SRC_DIR}`);
    }
    mkdirp(OUT_DIR);

    const sources = fs.readdirSync(SRC_DIR).filter(f => /\.(webp|png|jpe?g)$/i.test(f));
    if (!sources.length) throw new Error(`no source images in ${SRC_DIR}`);

    let converted = 0;
    for (const file of sources) {
        const stem = file.replace(/\.[^.]+$/, '');
        const name = MAP_NAMES[stem];
        if (!name) {
            console.warn(`skip  ${file} — no map name mapped for "${stem}"`);
            continue;
        }
        const outFile = path.join(OUT_DIR, `${name}.png`);
        const result = await cropMap(path.join(SRC_DIR, file), outFile);
        console.log(
            `map   ${file} (${result.source}) → ${CREATOR}/${name}.png ` +
            `[square l${result.square.left} t${result.square.top} r${result.square.right} b${result.square.bottom}] ` +
            `crop ${result.crop.width}x${result.crop.height} @ ${result.crop.left},${result.crop.top}`
        );
        converted++;
    }

    if (converted !== sources.length) {
        throw new Error(`converted ${converted}/${sources.length} sources — leaving maps/ untouched`);
    }

    // Only once every source converted.
    for (const file of fs.readdirSync(MAPS_DIR)) {
        const full = path.join(MAPS_DIR, file);
        if (fs.statSync(full).isFile() && /\.(webp|png|jpe?g)$/i.test(file)) {
            fs.unlinkSync(full);
            console.log(`clean maps/${file}`);
        }
    }

    await writeIcons();
    console.log(`done  ${converted} map(s) in maps/${CREATOR}/`);
}

main().catch(err => {
    console.error('prepare-maps failed:', err.message);
    process.exitCode = 1;
});
