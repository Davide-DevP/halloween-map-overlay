const {ipcRenderer} = require('electron');

/** How long the map name stays on the overlay in `auto` mode. */
const LABEL_MS = 3000;

let url = null;
let labelTimer = null;

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

ipcRenderer.on('map-change', async (event, img, size, opacity, draggable, rotation, mapLabel, labelMode) => {
    if (url !== null) {
        URL.revokeObjectURL(url)
    }
    let imgData = Buffer.from(img, "base64");
    let blob = new Blob([imgData]);
    url = URL.createObjectURL(blob);
    $("#mainImg").attr("src", url).css({
        "width": size + "px",
        "opacity": opacity,
        "transform": `rotate(${rotation || 0}deg)`
    })
    if (draggable) {
        $("body").css("-webkit-app-region", "drag");
    } else {
        $("body").css("-webkit-app-region", "no-drag");
    }
    // Every map-change settles the label: a new map either names itself or
    // clears a label left over from the previous one.
    showLabel(mapLabel, opacity, labelMode);
});

ipcRenderer.on('map-hide', async (event) => {
    $("#mainImg").css({
        "width": "0px",
    })
    showLabel("");
});
