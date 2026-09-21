#!/usr/bin/env node
'use strict';

/**
 * Build-prep script (dev only — `sharp` is a devDependency): crops each
 * `maps-src/` image to the map square into `maps/<CREATOR>/<Map Name>.png`,
 * drops the loose `maps/*.webp` copies once every crop succeeded, and
 * rasterises the icon SVG to `build/icon.png` and `src/images/icon.png`.
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

/** Jack-o'-lantern: orange pumpkin with a carved face on a dark round ground. */
function iconSvg() {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <radialGradient id="glow" cx="50%" cy="58%" r="55%">
      <stop offset="0%" stop-color="#ff9d3c"/>
      <stop offset="100%" stop-color="#e8641a"/>
    </radialGradient>
  </defs>
  <rect width="512" height="512" rx="96" fill="#14100f"/>
  <!-- Stem and leaf are drawn first so the pumpkin body occludes their base. -->
  <rect x="242" y="112" width="28" height="90" rx="13" fill="#6d4b24"/>
  <path d="M268 132 C284 106 312 96 344 100 C330 132 302 150 268 150 Z" fill="#4f7a34"/>
  <ellipse cx="256" cy="300" rx="168" ry="140" fill="url(#glow)"/>
  <ellipse cx="256" cy="300" rx="72" ry="140" fill="#ffae55" opacity="0.35"/>
  <ellipse cx="148" cy="300" rx="52" ry="128" fill="#c9500f" opacity="0.35"/>
  <ellipse cx="364" cy="300" rx="52" ry="128" fill="#c9500f" opacity="0.35"/>
  <path d="M182 268 l58 -34 l16 60 Z" fill="#14100f"/>
  <path d="M330 268 l-58 -34 l-16 60 Z" fill="#14100f"/>
  <path d="M256 296 l26 40 l-52 0 Z" fill="#14100f"/>
  <path d="M170 360 l34 -14 l16 24 l22 -26 l18 26 l22 -26 l18 26 l16 -24 l26 14 c-24 34 -60 52 -96 52 c-36 0 -72 -18 -96 -52 Z" fill="#14100f"/>
</svg>`;
}

async function writeIcons() {
    const svg = Buffer.from(iconSvg());
    const buildIcon = path.join(ROOT, 'build', 'icon.png');
    const appIcon = path.join(ROOT, 'src', 'images', 'icon.png');
    mkdirp(path.dirname(buildIcon));
    mkdirp(path.dirname(appIcon));
    await sharp(svg, {density: 384}).resize(512, 512).png({compressionLevel: 9}).toFile(buildIcon);
    await sharp(svg, {density: 384}).resize(256, 256).png({compressionLevel: 9}).toFile(appIcon);
    console.log(`icon  → ${path.relative(ROOT, buildIcon)} (512x512)`);
    console.log(`icon  → ${path.relative(ROOT, appIcon)} (256x256)`);
}

async function main() {
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
