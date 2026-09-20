const {ipcRenderer} = require('electron');
const {drawMarkers, drawLegend} = require('./markers');
const {legendItems} = require('../shared/marker-rules');

/** How long the map name stays on the overlay in `auto` mode. */
const LABEL_MS = 3000;

let url = null;
let labelTimer = null;
/**
 * The last marker payload and the width it was drawn at, kept so a language
 * change can re-label the legend without a map change. Markers never outlive
 * the map they belong to: every `map-change` replaces this and `map-hide`
 * clears it, exactly like the map name.
 */
let markerState = null;

/**
 * Name the map on the overlay.
 *
 * `auto` (the default) only ever gets a name for an automatic switch — the
 * player did not ask for the change, so the overlay says what it did, then
 * takes the name away again after a few seconds. `always` keeps it up for
 * whatever is showing; `never` never sends one in the first place, so this is
 * called with an empty name and simply hides the element.
 *
 * `.text()`, never markup: a map name can be a user-supplied custom name and
 * this window runs with node integration.
 *
 * @param {string} name
 * @param {number|string} opacity same opacity as the map itself
 * @param {'auto'|'always'|'never'} [mode]
 */
function showLabel(name, opacity, mode) {
    const $label = $("#mapLabel");
    if (labelTimer !== null) {
        clearTimeout(labelTimer);
        labelTimer = null;
    }
    if (!name) {
        $label.hide().text("");
        return;
    }
    $label.text(name).css("opacity", opacity).show();
    if (mode === 'always') return;
    labelTimer = setTimeout(() => {
        $label.hide().text("");
        labelTimer = null;
    }, LABEL_MS);
}

/**
 * Redraw the marker layer and its legend from whatever `map-change` last sent.
 *
 * Kept as its own function so `language-changed` can re-label the legend
 * without main having to re-send the map — the same reason the main window's
 * `i18n.onChange` hooks exist.
 */
function renderMarkers() {
    const svg = document.getElementById('markerLayer');
    const legend = document.getElementById('markerLegend');
    if (!svg || !legend) return;
    if (!markerState) {
        drawMarkers(svg, {layers: []}, 0);
        drawLegend(legend, [], 'en', false);
        return;
    }
    drawMarkers(svg, markerState.markers, markerState.width);
    drawLegend(legend, legendItems(markerState.markers.layers), markerState.lang,
        markerState.markers.legend);
}

ipcRenderer.on('map-change', async (event, img, size, opacity, draggable, rotation, mapLabel, labelMode, markers, lang) => {
    if (url !== null) {
        URL.revokeObjectURL(url)
    }
    let imgData = Buffer.from(img, "base64");
    let blob = new Blob([imgData]);
    url = URL.createObjectURL(blob);
    // Width and rotation live on the wrapper now, so the markers rotate with
    // the map rather than beside it; the image itself fills the wrapper.
    $("#mapStack").css({
        "width": size + "px",
        "transform": `rotate(${rotation || 0}deg)`
    })
    $("#mainImg").attr("src", url).css({"opacity": opacity})
    if (draggable) {
        $("body").css("-webkit-app-region", "drag");
    } else {
        $("body").css("-webkit-app-region", "no-drag");
    }
    // Markers ride on this payload rather than arriving on a channel of their
    // own, for the same reason the map name does: the overlay must never be
    // able to draw one map's markers over another map's image.
    markerState = (markers && markers.layers && markers.layers.length)
        ? {markers, width: parseInt(size, 10) || 0, lang: lang || 'en'}
        : null;
    renderMarkers();
    // Every map-change settles the label: a new map either names itself or
    // clears a label left over from the previous one.
    showLabel(mapLabel, opacity, labelMode);
});

ipcRenderer.on('map-hide', async (event) => {
    $("#mapStack").css({
        "width": "0px",
    })
    markerState = null;
    renderMarkers();
    showLabel("");
});

// The legend is the only translated thing on this window. Re-labelled in place
// so a language change does not need a map change to take effect.
ipcRenderer.on('language-changed', (event, lang) => {
    if (!markerState) return;
    markerState.lang = lang || 'en';
    renderMarkers();
});
