'use strict';

const {ipcRenderer} = require('electron');
const {markerGeometry, bracketPaths} = require('../shared/marker-geometry');
const {t} = require('../shared/i18n');
const {TAB_PANEL_REL, TAB_LEGEND_REL} = require('../core/map-detector/matcher');

/**
 * RENDERER tier: Tab-map mode's brackets and legend, drawn over the game's own
 * Tab map. Every position is a fraction of **this window's** viewport, read
 * from `window.innerWidth/innerHeight` and not from numbers main sent, so a
 * one-pixel difference between the DIP bounds asked for and the size Windows
 * gave cannot shift the markers. The regions come from `matcher.js` — there is
 * no second measurement here. See docs/agents/markers-and-tab-mode.md.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The last payload, so a resize or a language change can redraw it. */
let state = null;

/**
 * Should the **next** render fade in? Set by a payload flagged `fade` (only an
 * *optimistic* show carries it) and **consumed** by the first render after,
 * because a resize or a language change re-renders the same payload and the
 * fade would then look like a glitch rather than an entrance.
 */
let fadeNext = false;

/** The Tab map panel's interior square, in this window's CSS pixels. */
function panelRect() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    return {
        x: TAB_PANEL_REL.x * w,
        y: TAB_PANEL_REL.y * h,
        w: TAB_PANEL_REL.w * w,
        h: TAB_PANEL_REL.h * h
    };
}

function round(value) {
    return Math.round(value * 100) / 100;
}

function clear() {
    const svg = document.getElementById('tabMarkers');
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const legend = document.getElementById('tabLegend');
    while (legend.firstChild) legend.removeChild(legend.firstChild);
    legend.style.display = 'none';
    // Nothing left mid-transition: the next payload decides its own fade.
    for (const element of [svg, legend]) {
        element.classList.remove('is-fading');
        element.style.opacity = '';
    }
}

/**
 * Put an element at `target` opacity, instantly or fading up from nothing (the
 * fade is `.is-fading` in `tab.html`). The `getBoundingClientRect()` is a
 * **required forced reflow**: without it Chromium coalesces the two opacity
 * assignments, has nothing to transition *from*, and the element just appears.
 */
function applyOpacity(element, target, fading) {
    element.classList.remove('is-fading');
    if (!fading) {
        element.style.opacity = String(target);
        return;
    }
    element.style.opacity = '0';
    void element.getBoundingClientRect();
    element.classList.add('is-fading');
    element.style.opacity = String(target);
}

function render() {
    const fading = fadeNext;
    fadeNext = false;
    clear();
    if (!state || !state.layers || !state.layers.length) return;
    const svg = document.getElementById('tabMarkers');
    const panel = panelRect();
    svg.setAttribute('viewBox', `0 0 ${window.innerWidth} ${window.innerHeight}`);
    applyOpacity(svg, state.opacity === undefined ? 0.9 : state.opacity, fading);

    for (const layer of state.layers) {
        // The panel's own side is the extent, so brackets are sized against the
        // map they sit on, not the window.
        const geometry = markerGeometry(panel.w, {small: layer.small});
        const paths = bracketPaths(geometry);
        const group = document.createElementNS(SVG_NS, 'g');
        group.setAttribute('fill', 'none');
        group.setAttribute('stroke', layer.colour);
        group.setAttribute('stroke-width', String(geometry.stroke));
        group.setAttribute('stroke-linecap', 'round');
        group.setAttribute('stroke-linejoin', 'round');
        for (const point of layer.points) {
            const marker = document.createElementNS(SVG_NS, 'g');
            const cx = round(panel.x + point.u * panel.w);
            const cy = round(panel.y + point.v * panel.h);
            marker.setAttribute('transform', geometry.rotation
                ? `translate(${cx} ${cy}) rotate(${geometry.rotation})`
                : `translate(${cx} ${cy})`);
            // A dark halo: the game draws this map light for civilians and dark
            // blue for Michael, and one colour has to read on both.
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

    if (!state.legend) return;
    const legend = document.getElementById('tabLegend');
    legend.style.left = `${TAB_LEGEND_REL.x * window.innerWidth}px`;
    legend.style.top = `${TAB_LEGEND_REL.y * window.innerHeight}px`;
    legend.style.width = `${TAB_LEGEND_REL.w * window.innerWidth}px`;
    legend.style.display = '';
    // After `display`, always: an element still `display: none` has no rendered
    // opacity to transition from, so the fade would simply not run.
    applyOpacity(legend, 1, fading);
    for (const layer of state.layers) {
        const chip = document.createElement('div');
        chip.className = 'marker-chip';
        const swatch = document.createElement('span');
        swatch.className = 'marker-swatch';
        swatch.style.borderColor = layer.colour;
        chip.appendChild(swatch);
        const text = document.createElement('span');
        // `textContent`, never markup — this window runs with node integration.
        text.textContent = t(state.lang, layer.labelKey);
        chip.appendChild(text);
        legend.appendChild(chip);
    }
    const note = document.createElement('div');
    note.className = 'marker-chip is-note';
    note.textContent = t(state.lang, 'markers.legend.note');
    legend.appendChild(note);
}

ipcRenderer.on('tab-markers', (event, payload) => {
    state = payload && payload.layers && payload.layers.length ? payload : null;
    fadeNext = !!(state && state.fade);
    render();
});

ipcRenderer.on('tab-hide', () => {
    state = null;
    fadeNext = false;
    clear();
});

// The regions are fractions of the viewport, so a resize is a redraw.
window.addEventListener('resize', () => {
    if (state) render();
});
