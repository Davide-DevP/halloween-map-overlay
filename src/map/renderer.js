const {ipcRenderer} = require('electron');
const {drawMarkers, drawLegend} = require('./markers');
const {legendItems} = require('../shared/marker-rules');

/** How long the map name stays on the overlay in `auto` mode. */
const LABEL_MS = 3000;

let url = null;
let labelTimer = null;
/**
 * The last payload and the width it was drawn at, so a language change can
 * re-label the legend. **Markers never outlive their map**: every `map-change`
 * replaces this, `map-hide` clears it.
 */
let markerState = null;

/**
 * Name the map on the overlay. `mode` `auto` (the default) only ever gets a
 * name for an *automatic* switch and takes it away again; `always` keeps it up;
 * `never` arrives with an empty name and just hides the element.
 *
 * `.text()`, never markup: a map name can be user-supplied and this window runs
 * with node integration.
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

/** Redraw from whatever `map-change` last sent; also used by `language-changed`. */
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

/** `{image, size, opacity, draggable, rotation, label, labelMode, markers, lang}` — `MainWindow.applyMapChange`. */
ipcRenderer.on('map-change', async (event, change) => {
    const {image, size, opacity, draggable, rotation, label, labelMode, markers, lang} = change || {};
    if (url !== null) {
        URL.revokeObjectURL(url)
    }
    let imgData = Buffer.from(image || '', "base64");
    let blob = new Blob([imgData]);
    url = URL.createObjectURL(blob);
    // Width and rotation on the wrapper, so the markers rotate *with* the map.
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
    // Markers ride on this payload rather than a channel of their own, so one
    // map's markers can never land over another map's image.
    markerState = (markers && markers.layers && markers.layers.length)
        ? {markers, width: parseInt(size, 10) || 0, lang: lang || 'en'}
        : null;
    renderMarkers();
    // Settled on every change, so no label is left over from the last map.
    showLabel(label, opacity, labelMode);
});

ipcRenderer.on('map-hide', async (event) => {
    $("#mapStack").css({
        "width": "0px",
    })
    markerState = null;
    renderMarkers();
    showLabel("");
});

// The legend is the only translated thing on this window.
ipcRenderer.on('language-changed', (event, lang) => {
    if (!markerState) return;
    markerState.lang = lang || 'en';
    renderMarkers();
});
