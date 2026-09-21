'use strict';

const {markerGeometry, bracketPaths, markerReach} = require('../shared/marker-geometry');
const {t} = require('../shared/i18n');

/**
 * RENDERER tier: the marker layer of the overlay **and** the OBS window, one
 * routine for both so a streamer's capture cannot disagree with the player's
 * view. SVG, not a canvas, because the overlay is resized and rotated live.
 * The viewBox is the map's **rendered** size, never the image's, or the stroke
 * widths scale with the overlay and undo the sizing curve. *Which* layers are
 * drawn is main's decision; the payload is the answer.
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
 * Draw the marker layer into an `<svg>` element (emptied first).
 * @param {{layers, imageWidth, imageHeight, opacity}} payload the image size is
 *   main's read of the PNG, so the aspect ratio does not wait for the decode
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
    // Starting at -pad keeps the map's own (0, 0) put while the element
    // extends past it; the caller offsets by the same amount.
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
        // A dark halo keeps the brackets readable over the game's own art on a
        // pale street map as well as a dark one.
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
 * One legend chip per drawn layer. `textContent`, never markup: this window
 * runs with node integration, so that is not a judgement call per string.
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
