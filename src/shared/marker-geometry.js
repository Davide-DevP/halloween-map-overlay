'use strict';

/**
 * PURE marker geometry. Imports nothing — no electron, no DOM.
 *
 * One marker is four **reticle corner brackets** around a point (the approved
 * look, `dist/marker-variants/variant-B-brackets.png`): an L at each corner of
 * a square, with the middle of every side left open. Hollow on purpose — on the
 * in-game Tab map the game draws its own icon on an exit the player has
 * discovered, and it has to show *through* ours rather than be covered by it.
 *
 * ## Why the size is a curve rather than a proportion
 *
 * The overlay is a user-set width between 50 and 800 px (`SIZE_MIN`/`SIZE_MAX`
 * in `shared/hotkeys-constants.js`), and the same marker has to be legible on a
 * 150 px minimap and not cartoonish on an 800 px one. Two obvious rules both
 * fail:
 *   - a fixed **proportion** of the map (e.g. 9 %) is 13 px across at 150 and
 *     72 px at 800 — three markers would swallow a street;
 *   - a fixed **pixel** size disappears at 800 and covers half the map at 150.
 *
 * So everything scales with `sqrt(extent / REFERENCE_EXTENT)`: doubling the map
 * grows a marker by ~1.41x, which keeps it recognisable at both ends while its
 * share of the map halves. The numbers are anchored on the default 250 px
 * overlay, where the approved mock-up was drawn, and clamped at both ends so a
 * hand-edited size cannot produce a hairline or a blob.
 *
 * The same function serves the in-game Tab map, where `extent` is the map
 * panel's own side (~786 px at 1080p) — one rule, two surfaces.
 *
 * Everything returned is in **rendered pixels**, because the renderers draw the
 * SVG in rendered-pixel space (viewBox `0 0 w h`) rather than in the image's
 * own coordinates. A stroke width in image coordinates would be multiplied by
 * the CSS scale and undo all of the above.
 */

/** The overlay width the numbers below were drawn for (the shipped default). */
const REFERENCE_EXTENT = 250;

/** Half the side of the square the four brackets sit on, at REFERENCE_EXTENT. */
const REFERENCE_HALF = 11.25;

/** Bracket stroke, at REFERENCE_EXTENT. */
const REFERENCE_STROKE = 1.6;

/** Arm length as a fraction of `half`: how far each L runs along its side. */
const ARM_RATIO = 0.42;

/** Clamps. The extent clamp keeps the curve inside the range it was fitted on. */
const MIN_EXTENT = 50;
const MAX_EXTENT = 1600;
const MIN_HALF = 5;
const MAX_HALF = 26;
const MIN_STROKE = 1;
const MAX_STROKE = 3.2;

/**
 * Gas cans are drawn as the same brackets **rotated 45° and smaller**, so the
 * one layer that is not a ring on the map image is also the one that does not
 * read as a ring. Smaller because a diamond's corners reach further than a
 * square's for the same half-extent.
 */
const GAS_SCALE = 0.78;
const GAS_ROTATION = 45;

function clamp(value, min, max) {
    return value < min ? min : (value > max ? max : value);
}

/**
 * The geometry of one marker, in rendered pixels.
 *
 * @param {number} extent the drawn map's width in px — the overlay `size`
 *   setting on the corner minimap, the Tab panel's side in Tab mode.
 * @param {{small?: boolean}} [opts] `small` is the gas variant.
 * @returns {{half: number, arm: number, stroke: number, rotation: number}}
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
 * The four bracket paths of one marker, as SVG path data **centred on (0, 0)**.
 *
 * Centred so a marker is one `<g transform="translate(cx cy) rotate(r)">` with
 * four identical children: the renderer positions and rotates, it never does
 * geometry. Each path is a two-segment L — along the side, turn the corner,
 * along the other side.
 *
 * @param {{half: number, arm: number}} geometry from `markerGeometry`
 * @returns {string[]} four path `d` strings (TL, TR, BR, BL)
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

/**
 * How far a marker reaches from its centre, including half the stroke.
 *
 * The renderers use it to pad the SVG viewport, so a marker near the edge of
 * the map is not clipped in half. A diamond's corner is `half * sqrt(2)` away.
 *
 * @param {{half: number, stroke: number, rotation: number}} geometry
 * @returns {number}
 */
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
