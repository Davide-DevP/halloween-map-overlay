'use strict';

/**
 * PURE marker rules: which layers exist, which are drawn on which surface,
 * where a point lands on the Tab panel, what the legend lists. A marker is a
 * place the game **may** put a cellar, gate, car or gas can — a varying subset
 * is active each match, so nothing here may ever read as a fact.
 */

/**
 * The four layers, in draw and legend order — the single list the defaults, the
 * Settings tab, the legend and both renderers read. The colours are
 * deliberately *not* `app.css` tokens: they are drawn over the game's own art.
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
        // Nowhere on the bundled images, so never `baked`, and rotated 45° so
        // it never reads as a ring.
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
 * Is this layer on? Only an explicit `false` turns one off, so a `settings`
 * object written before markers existed behaves like the shipped defaults.
 */
function isLayerEnabled(settings, id) {
    const def = layerDef(id);
    if (!def) return false;
    return !settings || settings[def.settingKey] !== false;
}

/**
 * Is a layer already drawn by the `surface` (`overlay`|`tab`) itself? The
 * bundled images have the rings in the PNG, so drawing them again would double
 * every one; the game's own Tab map has none. Per-map data, not per-layer.
 */
function isLayerBaked(markers, id, surface) {
    if (surface !== SURFACE_OVERLAY) return false;
    const baked = markers && Array.isArray(markers.baked) ? markers.baked : [];
    return baked.indexOf(id) !== -1;
}

/**
 * The whole drawing instruction for one surface, so all three renderers share
 * one answer. A layer with no points is dropped: an empty legend chip is a
 * promise the data does not keep.
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
 * An image fraction → a fraction of the Tab panel's interior square. An affine
 * fit measured per map against the game's own panel (IoU 0.96-0.98; provenance
 * in `maps-src/markers.json` `_about`), never assumed to be the identity.
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
 * The same layers on the Tab panel and **clipped** to it — not clamped, or a
 * point outside lands on the game's objectives or player list. A guard for a
 * future pack, not a filter that fires today.
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

/** Drawable on the Tab panel? Without the fit, a wrong overlay is worse. */
function hasTabTransform(markers) {
    return !!(markers && markers.tab && tabPoint({x: 0, y: 0}, markers.tab));
}

/**
 * One chip per layer **we** actually draw (from `drawableLayers`/`tabLayers`) —
 * normally just the gas cans. Claiming credit for rings the image already shows
 * would make the legend a lie the moment a pack ships a clean image.
 */
function legendItems(layers) {
    return (layers || []).map(layer => ({
        id: layer.id,
        colour: layer.colour,
        labelKey: layer.labelKey
    }));
}

/**
 * The marker half of the settings, in one place, so "markers are off" means the
 * same on all three surfaces. `enabled` is the master switch the hotkey toggles.
 * @returns {{enabled, legend, tabMode, opacity, layers}}
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
