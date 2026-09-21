'use strict';

/**
 * PURE marker geometry — four hollow reticle corner brackets. Everything is in
 * **rendered pixels**: a stroke width in image coordinates would be multiplied
 * by the CSS scale and undo the sizing curve. One rule for both surfaces. Why
 * each number: docs/agents/markers-and-tab-mode.md § Measured constants.
 */

/** The overlay width the numbers below were drawn for (the shipped default). */
const REFERENCE_EXTENT = 250;

/** Half the side of the brackets' square, at REFERENCE_EXTENT. */
const REFERENCE_HALF = 11.25;

/** Bracket stroke, at REFERENCE_EXTENT. */
const REFERENCE_STROKE = 1.6;

/** Arm length as a fraction of `half`: how far each L runs along its side. */
const ARM_RATIO = 0.42;

/** Clamps: the curve's fitted range, and no hairlines or blobs at the ends. */
const MIN_EXTENT = 50;
const MAX_EXTENT = 1600;
const MIN_HALF = 5;
const MAX_HALF = 26;
const MIN_STROKE = 1;
const MAX_STROKE = 3.2;

/** Gas: the same brackets rotated 45°, and smaller because a diamond reaches. */
const GAS_SCALE = 0.78;
const GAS_ROTATION = 45;

function clamp(value, min, max) {
    return value < min ? min : (value > max ? max : value);
}

/**
 * One marker's geometry, in rendered pixels. Scales with
 * `sqrt(extent / REFERENCE_EXTENT)`, so doubling the map grows a marker ~1.41x
 * while halving its share of it.
 * @param {number} extent the drawn map's width in px — the `size` setting, or
 *   the Tab panel's own side. `opts.small` is the gas variant.
 */
function markerGeometry(extent, opts) {
    const o = opts || {};
    const width = Number.isFinite(extent) ? extent : REFERENCE_EXTENT;
    const scale = Math.sqrt(clamp(width, MIN_EXTENT, MAX_EXTENT) / REFERENCE_EXTENT);
    const shrink = o.small ? GAS_SCALE : 1;
    const half = clamp(REFERENCE_HALF * scale, MIN_HALF, MAX_HALF) * shrink;
    const stroke = clamp(REFERENCE_STROKE * scale, MIN_STROKE, MAX_STROKE) * (o.small ? GAS_SCALE : 1);
    return {
        half: round(half),
        arm: round(half * ARM_RATIO),
        stroke: round(stroke),
        rotation: o.small ? GAS_ROTATION : 0
    };
}

/** Three decimals is well under a device pixel and keeps the markup short. */
function round(value) {
    return Math.round(value * 1000) / 1000;
}

/**
 * The four bracket paths **centred on (0, 0)**, so a marker is one
 * `<g transform>` and the renderer does no geometry. TL, TR, BR, BL.
 */
function bracketPaths(geometry) {
    const h = geometry.half;
    const a = geometry.arm;
    return [
        `M ${-h} ${-h + a} L ${-h} ${-h} L ${-h + a} ${-h}`,
        `M ${h - a} ${-h} L ${h} ${-h} L ${h} ${-h + a}`,
        `M ${h} ${h - a} L ${h} ${h} L ${h - a} ${h}`,
        `M ${-h + a} ${h} L ${-h} ${h} L ${-h} ${h - a}`
    ];
}

/** Reach from the centre, half the stroke in: the SVG viewport's padding. */
function markerReach(geometry) {
    const diagonal = geometry.rotation ? Math.SQRT2 : 1;
    return round(geometry.half * diagonal + geometry.stroke / 2);
}

module.exports = {
    REFERENCE_EXTENT,
    REFERENCE_HALF,
    REFERENCE_STROKE,
    ARM_RATIO,
    MIN_HALF,
    MAX_HALF,
    MIN_STROKE,
    MAX_STROKE,
    GAS_SCALE,
    GAS_ROTATION,
    markerGeometry,
    bracketPaths,
    markerReach
};
