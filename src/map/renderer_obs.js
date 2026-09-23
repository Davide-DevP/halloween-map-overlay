const { ipcRenderer } = require('electron');
const {drawMarkers, drawLegend} = require('./markers');
const {legendItems} = require('../shared/marker-rules');

/** How long the map name stays up in `auto` mode — same as the overlay. */
const LABEL_MS = 3000;

let url = null;
let labelTimer = null;
/** The last marker payload, so a language change can re-label the legend. */
let markerState = null;

/**
 * The same map name the overlay shows, on the same `mapLabel` setting, so a
 * stream sees what the player sees. `.text()`, never markup: custom map names
 * are user-typed and this window runs with node integration.
 */
function showLabel(name, mode) {
    const $label = $("#mapLabel");
    if (labelTimer !== null) {
        clearTimeout(labelTimer);
        labelTimer = null;
    }
    if (!name) {
        $label.hide().text("");
        return;
    }
    $label.text(name).show();
    if (mode === 'always') return;
    labelTimer = setTimeout(() => {
        $label.hide().text("");
        labelTimer = null;
    }, LABEL_MS);
}

/** Same marker layer as the overlay, drawn from the same payload. */
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

/** `{image, size, label, labelMode, markers, lang}` — `MainWindow.applyMapChange`. */
ipcRenderer.on('map-change', async (event, change) => {
    const {image, size, label, labelMode, markers, lang} = change || {};
    if (url!==null){
        URL.revokeObjectURL(url)
    }
    let imgData = Buffer.from(image || '',"base64");
    let blob = new Blob([imgData]);
    url = URL.createObjectURL(blob);
    $("#mapStack").css({
        "width":size+"px",
    })
    $("#mainImg").attr("src",url)
    markerState = (markers && markers.layers && markers.layers.length)
        ? {markers, width: parseInt(size, 10) || 0, lang: lang || 'en'}
        : null;
    renderMarkers();
    showLabel(label, labelMode);
});

ipcRenderer.on('map-hide', async (event) => {
    $("#mapStack").css({
        "width":"0px",
    })
    markerState = null;
    renderMarkers();
    showLabel("");
});

ipcRenderer.on('language-changed', (event, lang) => {
    if (!markerState) return;
    markerState.lang = lang || 'en';
    renderMarkers();
});
