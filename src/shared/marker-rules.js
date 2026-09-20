'use strict';

/**
 * PURE marker rules. Imports nothing — no electron, no fs, no DOM.
 *
 * What a *marker* is: a place the game **may** put a storm cellar, an escape
 * gate, a car or a gas can. The game activates a varying subset every match, so
 * every point here is a possibility, never a fact — which is why the legend
 * says "possible location" and why nothing in this file ever claims otherwise.
 *
 * This module owns four decisions and nothing else:
 *   1. which layers exist, in which order, in which colour, and under which
 *      setting key (`MARKER_LAYERS` — the single list; the settings defaults,
 *      the Settings tab, the legend and both renderers all read it);
 *   2. which layers are actually drawn on a given **surface** — the corner
 *      minimap skips the layers the map image already draws
 *      (`baked`), the in-game Tab map draws all of them because the game's own
 *      map has none of them on it;
 *   3. where a point lands on the in-game Tab map panel (`tabPoint`);
 *   4. what the legend lists.
 *
 * The data itself is validated by `shared/map-pack-rules.js` `validateMarkers`
 * — one validator for a bundled map and a pack map alike — and reaches the
 * renderer through `get-map-markers`.
 */

/**
 * The four layers, in draw order (back to front) and legend order.
 *
 * The colours are the approved variant B palette
 * (`dist/marker-variants/variant-B-brackets.png`). They are deliberately *not*
 * `app.css` design tokens: these are drawn over the game's own art on a
 * transparent window, so they have to read against grass, asphalt and the Tab
 * screen's two very different map renderings, not against this app's surfaces.
 *
 * `baked` is per-map data, not a property of the layer — a pack built from a
 * clean image has nothing baked and draws all four everywhere.
 */
const MARKER_LAYERS = [
    {
        id: 'cellar',
        colour: '#e0605a',
        small: false,
        settingKey: 'markerLayerCellar',
        labelKey: 'markers.layer.cellar'
    },
    {
        id: 'gate',
        colour: '#4fc58a',
        small: false,
        settingKey: 'markerLayerGate',
        labelKey: 'markers.layer.gate'
    },
    {
        id: 'car',
        colour: '#5fb4ea',
        small: false,
        settingKey: 'markerLayerCar',
        labelKey: 'markers.layer.car'
    },
    {
        // The one layer that is nowhere on the bundled images: traced from
        // u/deftyconchgaming's separate gas-spawn maps. Drawn as the same
        // brackets rotated 45° and smaller, so it never reads as a ring.
        id: 'gas',
        colour: '#f0cf55',
        small: true,
        settingKey: 'markerLayerGas',
        labelKey: 'markers.layer.gas'
    }
];

/** The two surfaces markers are drawn on. */
const SURFACE_OVERLAY = 'overlay';
const SURFACE_TAB = 'tab';

const LAYER_BY_ID = new Map(MARKER_LAYERS.map(layer => [layer.id, layer]));

/** @returns {?Object} the definition of one layer, or null. */
function layerDef(id) {
    return LAYER_BY_ID.get(id) || null;
}

function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Is this layer switched on?
 *
 * Only an explicit `false` turns a layer off, so a settings file written before
 * markers existed behaves like the shipped defaults (all four on) rather than
 * like "everything off" — the same rule `hideInMenu` already uses.
 *
 * @param {Object} settings a plain object of setting key → value
 * @param {string} id
 * @returns {boolean}
 */
function isLayerEnabled(settings, id) {
    const def = layerDef(id);
    if (!def) return false;
    return !settings || settings[def.settingKey] !== false;
}

/**
 * Is a layer already drawn by the surface itself?
 *
 * On the four bundled maps the image's author drew the cellar / gate / car
 * rings into the PNG, so drawing them again on the corner minimap would double
 * every one of them — the single most visible way this feature could look
 * broken. The in-game Tab map is the game's own rendering and has none of them,
 * so `baked` never applies there.
 *
 * @param {*} markers one map's markers document
 * @param {string} id
 * @param {string} surface `overlay` or `tab`
 * @returns {boolean}
 */
function isLayerBaked(markers, id, surface) {
    if (surface !== SURFACE_OVERLAY) return false;
    const baked = markers && Array.isArray(markers.baked) ? markers.baked : [];
    return baked.indexOf(id) !== -1;
}

/**
 * The layers to draw on one surface, with their points and their look.
 *
 * Returns the whole drawing instruction so both renderers (and the Tab window)
 * share one answer: which layers, in which order, in which colour, with which
 * points, and whether each is the small 45°-rotated variant.
 *
 * A layer with no points is dropped — an empty legend chip is a promise the
 * data does not keep.
 *
 * @param {{markers: *, surface: string, settings: Object}} state
 * @returns {Array<{id, colour, small, labelKey, points: Array<{x, y}>}>}
 */
function drawableLayers(state) {
    const {markers, surface, settings} = state || {};
    const out = [];
    if (!markers || typeof markers !== 'object' || !markers.layers) return out;
    for (const def of MARKER_LAYERS) {
        if (!isLayerEnabled(settings, def.id)) continue;
        if (isLayerBaked(markers, def.id, surface)) continue;
        const raw = markers.layers[def.id];
        if (!Array.isArray(raw) || !raw.length) continue;
        const points = raw.filter(p => p && isFiniteNumber(p.x) && isFiniteNumber(p.y))
            .map(p => ({x: p.x, y: p.y}));
        if (!points.length) continue;
        out.push({
            id: def.id,
            colour: def.colour,
            small: def.small,
            labelKey: def.labelKey,
            points
        });
    }
    return out;
}

/**
 * An image fraction → a fraction of the in-game Tab map panel's interior
 * square: `u = sx*x + tx`, `v = sy*y + ty`.
 *
 * The transform is per map and was measured by registering the community map's
 * boundary silhouette against the game's own panel (IoU 0.96-0.98; see
 * `maps-src/markers.json` `_about`). It is an affine fit, not a guess, which is
 * why it is stored per map rather than assumed to be the identity.
 *
 * @param {{x: number, y: number}} point an image fraction
 * @param {{sx: number, tx: number, sy: number, ty: number}} tab
 * @returns {?{u: number, v: number}} null when the transform is unusable
 */
function tabPoint(point, tab) {
    if (!point || !tab) return null;
    if (!isFiniteNumber(point.x) || !isFiniteNumber(point.y)) return null;
    for (const field of ['sx', 'tx', 'sy', 'ty']) {
        if (!isFiniteNumber(tab[field])) return null;
    }
    return {u: tab.sx * point.x + tab.tx, v: tab.sy * point.y + tab.ty};
}

/**
 * The same layers, transformed onto the Tab map panel and clipped to it.
 *
 * Clipped rather than clamped: a point the transform puts outside the panel
 * would be drawn over the game's *other* UI — the objectives list, the player
 * list, the map name — which is worse than not drawing it. None of the four
 * bundled maps produces one (the transforms are near-identity), so this is a
 * guard for a future pack whose fit is worse, not a filter that fires today.
 *
 * @param {{markers: *, settings: Object}} state
 * @returns {Array<{id, colour, small, labelKey, points: Array<{u, v}>}>}
 */
function tabLayers(state) {
    const {markers, settings} = state || {};
    const tab = markers && markers.tab;
    if (!tab) return [];
    const out = [];
    for (const layer of drawableLayers({markers, surface: SURFACE_TAB, settings})) {
        const points = [];
        for (const point of layer.points) {
            const mapped = tabPoint(point, tab);
            if (!mapped) continue;
            if (mapped.u < 0 || mapped.u > 1 || mapped.v < 0 || mapped.v > 1) continue;
            points.push(mapped);
        }
        if (points.length) out.push(Object.assign({}, layer, {points}));
    }
    return out;
}

/**
 * Can this map be drawn on the in-game Tab map at all?
 *
 * Needs the per-map affine fit. Without it nothing is drawn and the corner
 * minimap stays the fallback — a wrong overlay on the game's own map would be
 * worse than no overlay.
 *
 * @param {*} markers
 * @returns {boolean}
 */
function hasTabTransform(markers) {
    return !!(markers && markers.tab && tabPoint({x: 0, y: 0}, markers.tab));
}

/**
 * The legend: one chip per layer actually being drawn, in layer order.
 *
 * Only the layers **we** draw. On the corner minimap that is normally just the
 * gas cans, because the map image already shows the other three — claiming
 * credit for rings somebody else drew would make the legend a lie the first
 * time a pack ships a clean image.
 *
 * @param {Array<{id, colour, labelKey}>} layers from `drawableLayers`/`tabLayers`
 * @returns {Array<{id: string, colour: string, labelKey: string}>}
 */
function legendItems(layers) {
    return (layers || []).map(layer => ({
        id: layer.id,
        colour: layer.colour,
        labelKey: layer.labelKey
    }));
}

/**
 * The marker half of the settings, as both renderers want it.
 *
 * One place turns the flat settings file into the shape the drawing code takes,
 * so "markers are off" means the same thing on the overlay, on the OBS window
 * and in the Tab window. `markersEnabled` is the master switch the
 * *Show / hide markers* hotkey toggles.
 *
 * @param {Object} settings
 * @returns {{enabled: boolean, legend: boolean, tabMode: boolean, opacity: number, layers: Object}}
 */
function markerState(settings) {
    const s = settings || {};
    const layers = {};
    for (const def of MARKER_LAYERS) layers[def.settingKey] = isLayerEnabled(s, def.id);
    const opacity = parseFloat(s.markerOpacity);
    return {
        enabled: s.markers !== false,
        legend: s.markerLegend !== false,
        tabMode: s.tabMarkers === true,
        opacity: Number.isFinite(opacity) ? Math.min(1, Math.max(0.1, opacity)) : 0.9,
        layers
    };
}

module.exports = {
    MARKER_LAYERS,
    SURFACE_OVERLAY,
    SURFACE_TAB,
    layerDef,
    isLayerEnabled,
    isLayerBaked,
    drawableLayers,
    tabPoint,
    tabLayers,
    hasTabTransform,
    legendItems,
    markerState
};
