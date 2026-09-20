'use strict';

const {markerGeometry, bracketPaths, markerReach} = require('../shared/marker-geometry');
const {t} = require('../shared/i18n');

/**
 * The marker layer of the overlay and the OBS window.
 *
 * Both windows draw the same picture from the same payload — that is the point:
 * a streamer's capture must show what the player sees, and two drawing routines
 * would eventually disagree. The only difference is that the overlay rotates
 * with the map and the OBS window does not.
 *
 * ## Why SVG rather than a canvas
 *
 * The overlay is resized live (the size slider, Ctrl+Alt+Shift+Up/Down) and
 * rotated in 90° steps. A canvas would have to be re-rasterised on every change
 * and would still be blurry when the CSS scale is not 1; an SVG is re-laid out
 * by the compositor and stays crisp at 150 px and at 800 px alike.
 *
 * ## Why the viewport is in *rendered* pixels
 *
 * The obvious `viewBox="0 0 <image width> <image height>"` would scale the
 * stroke widths with the overlay, which is exactly what the sizing curve in
 * `shared/marker-geometry.js` exists to avoid. So the viewBox is the map's
 * **rendered** size and the geometry is literal pixels; a point's fraction is
 * multiplied by that size here and nowhere else.
 *
 * Nothing in this file decides *which* layers are drawn — `shared/marker-rules.js`
 * does, in the main process, and the payload is the answer.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Keeps a marker near the edge of the map from being clipped in half. */
function viewportPadding(layers, extent) {
    let pad = 0;
    for (const layer of layers) {
        pad = Math.max(pad, markerReach(markerGeometry(extent, {small: layer.small})));
    }
    return Math.ceil(pad);
}

/**
 * Draw the marker layer into an `<svg>` element.
 *
 * @param {SVGElement} svg the element to fill (emptied first)
 * @param {{layers: Array, imageWidth: number, imageHeight: number, opacity: number}} payload
 *   `layers` is `shared/marker-rules.js` `drawableLayers()`; the image size is
 *   what main read off the PNG, so the aspect ratio does not have to wait for
 *   the browser to decode the image.
 * @param {number} width the map's rendered width in px (the `size` setting)
 * @returns {{width: number, height: number}} the SVG's own box, for the caller
 */
function drawMarkers(svg, payload, width) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const layers = (payload && payload.layers) || [];
    const imageWidth = (payload && payload.imageWidth) || 0;
    const imageHeight = (payload && payload.imageHeight) || 0;
    if (!layers.length || !imageWidth || !imageHeight || !width) {
        svg.setAttribute('width', '0');
        svg.setAttribute('height', '0');
        return {width: 0, height: 0};
    }

    const height = width * imageHeight / imageWidth;
    const pad = viewportPadding(layers, width);
    // The viewBox starts at -pad so the map's own (0, 0) stays at (0, 0) of the
    // image while the element itself extends past it on every side; the caller
    // offsets the element by the same amount, so the two line up exactly.
    svg.setAttribute('viewBox', `${-pad} ${-pad} ${width + pad * 2} ${height + pad * 2}`);
    svg.setAttribute('width', String(width + pad * 2));
    svg.setAttribute('height', String(height + pad * 2));
    svg.style.left = `${-pad}px`;
    svg.style.top = `${-pad}px`;
    svg.style.opacity = String(payload.opacity === undefined ? 0.9 : payload.opacity);

    for (const layer of layers) {
        const geometry = markerGeometry(width, {small: layer.small});
        const paths = bracketPaths(geometry);
        const group = document.createElementNS(SVG_NS, 'g');
        group.setAttribute('fill', 'none');
        group.setAttribute('stroke', layer.colour);
        group.setAttribute('stroke-width', String(geometry.stroke));
        group.setAttribute('stroke-linecap', 'round');
        group.setAttribute('stroke-linejoin', 'round');
        // One halo behind the whole layer rather than per marker: the brackets
        // are drawn over the game's own art, and a thin dark outline is what
        // keeps them readable on a pale street map as well as on a dark one.
        group.setAttribute('paint-order', 'stroke');
        for (const point of layer.points) {
            const marker = document.createElementNS(SVG_NS, 'g');
            const cx = round(point.x * width);
            const cy = round(point.y * height);
            marker.setAttribute('transform', geometry.rotation
                ? `translate(${cx} ${cy}) rotate(${geometry.rotation})`
                : `translate(${cx} ${cy})`);
            for (const d of paths) {
                const shadow = document.createElementNS(SVG_NS, 'path');
                shadow.setAttribute('d', d);
                shadow.setAttribute('stroke', '#000');
                shadow.setAttribute('stroke-opacity', '0.55');
                shadow.setAttribute('stroke-width', String(round(geometry.stroke * 2.2)));
                marker.appendChild(shadow);
            }
            for (const d of paths) {
                const path = document.createElementNS(SVG_NS, 'path');
                path.setAttribute('d', d);
                marker.appendChild(path);
            }
            group.appendChild(marker);
        }
        svg.appendChild(group);
    }
    return {width: width + pad * 2, height: height + pad * 2};
}

function round(value) {
    return Math.round(value * 100) / 100;
}

/**
 * Fill the legend element with one chip per drawn layer.
 *
 * Only the layers **we** draw, which on a bundled map is normally just the gas
 * cans — the map image already shows the cellars, gates and cars, and a legend
 * claiming those would be wrong the moment a pack ships a clean image.
 *
 * Built with `textContent`, never markup: the strings are ours, but this window
 * runs with node integration and there is no reason to make that a judgement
 * call per string.
 *
 * @param {HTMLElement} element
 * @param {Array<{id, colour, labelKey}>} items
 * @param {string} lang
 * @param {boolean} show
 */
function drawLegend(element, items, lang, show) {
    while (element.firstChild) element.removeChild(element.firstChild);
    const list = show ? (items || []) : [];
    element.style.display = list.length ? '' : 'none';
    for (const item of list) {
        const chip = document.createElement('div');
        chip.className = 'marker-chip';
        const swatch = document.createElement('span');
        swatch.className = 'marker-swatch';
        swatch.style.borderColor = item.colour;
        chip.appendChild(swatch);
        const text = document.createElement('span');
        text.textContent = t(lang, item.labelKey);
        chip.appendChild(text);
        element.appendChild(chip);
    }
}

module.exports = {SVG_NS, drawMarkers, drawLegend, viewportPadding};
