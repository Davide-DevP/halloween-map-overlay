'use strict';

const {ipcRenderer} = require('electron');
const {markerGeometry, bracketPaths} = require('../shared/marker-geometry');
const {t} = require('../shared/i18n');
const {TAB_PANEL_REL, TAB_LEGEND_REL} = require('../core/map-detector/matcher');

/**
 * Tab-map mode's renderer: the marker brackets and the legend, drawn directly
 * over the game's own Tab map.
 *
 * The window is laid exactly over the game window's rectangle, so every
 * position here is a fraction of **this window's** viewport — read from
 * `window.innerWidth/innerHeight` rather than from numbers main sent, so a
 * one-pixel difference between the DIP bounds main asked for and the size
 * Windows actually gave the window cannot shift the markers. The two regions
 * come from `map-detector/matcher.js`, which is where every frame-relative
 * region in this project lives; there is no second measurement here.
 *
 * Brackets are hollow on purpose: when the player discovers an exit the game
 * draws its own icon at that spot, and it has to show *through* ours.
 *
 * One payload flag reaches this file: `fade`, which main sets only on an
 * **optimistic** show — markers put up on the key-down edge, before a capture
 * has confirmed the game's map is really there. It fades them in over 300 ms
 * with an ease-in curve, so they arrive with the game's own map and a show that
 * turns out to be wrong is barely seen before its deadline takes it down.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The last payload, so a resize or a language change can redraw it. */
let state = null;

/**
 * Should the **next** render fade in rather than appear?
 *
 * Set by a payload flagged `fade` — which main only ever sends for an
 * *optimistic* show, i.e. markers put up on the key-down edge before a capture
 * has confirmed the game's map is really there — and consumed by the first
 * render after it. Consumed, because a window resize and a language change
 * both re-render the same payload, and re-running the fade then would look
 * like a glitch rather than an entrance.
 *
 * A confirmation never re-sends a payload for the same map, so nothing
 * interrupts a fade that is in progress.
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
    // Nothing is left mid-transition for the next show to inherit: a hide is a
    // hide, and the next payload decides for itself whether it fades.
    for (const element of [svg, legend]) {
        element.classList.remove('is-fading');
        element.style.opacity = '';
    }
}

/**
 * Put an element at `target` opacity — instantly, or fading up from nothing.
 *
 * The fade is CSS (`.is-fading` in `tab.html`); all that happens here is
 * setting opacity to 0 with the transition off, forcing the browser to lay
 * that out, and only then switching the transition on and setting the target.
 * Without the forced reflow Chromium coalesces the two assignments into one
 * style recalculation, sees no change to transition *from*, and the element
 * simply appears — which is the bug this three-step dance exists to avoid.
 *
 * @param {Element} element
 * @param {number} target the opacity the payload asked for
 * @param {boolean} fading
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
    // Consumed here rather than read: a resize or a language change re-renders
    // the same payload, and only the render that *follows the payload* fades.
    const fading = fadeNext;
    fadeNext = false;
    clear();
    if (!state || !state.layers || !state.layers.length) return;
    const svg = document.getElementById('tabMarkers');
    const panel = panelRect();
    svg.setAttribute('viewBox', `0 0 ${window.innerWidth} ${window.innerHeight}`);
    applyOpacity(svg, state.opacity === undefined ? 0.9 : state.opacity, fading);

    for (const layer of state.layers) {
        // The panel's own side is the extent, so the brackets are sized against
        // the map they sit on rather than against the window — the same rule
        // the corner minimap uses with its `size` setting.
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
            // A dark halo under each bracket: the game draws this map light for
            // civilians and dark blue for Michael, and one colour has to read
            // on both.
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
    // The legend fades with the brackets: half of an optimistic show appearing
    // instantly would draw more attention than the whole of it. **After**
    // `display` — an element that is still `display: none` has no rendered
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
        // `textContent`, never markup — this window runs with node integration
        // and there is no reason to make that a judgement call per string.
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

// The window is re-bounded whenever the game window moves or resizes, and the
// regions are fractions of the viewport, so a resize is a redraw.
window.addEventListener('resize', () => {
    if (state) render();
});
