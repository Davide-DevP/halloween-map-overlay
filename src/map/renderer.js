const {ipcRenderer} = require('electron');

/** How long the map name stays on the overlay after an automatic switch. */
const LABEL_MS = 3000;

let url = null;
let labelTimer = null;

/**
 * Name the map for a moment. Only automatic (detector) switches send a label —
 * the player did not ask for the change, so the overlay says what it did.
 *
 * `.text()`, never markup: a map name can be a user-supplied custom name and
 * this window runs with node integration.
 */
function showLabel(name, opacity) {
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
    labelTimer = setTimeout(() => {
        $label.hide().text("");
        labelTimer = null;
    }, LABEL_MS);
}

ipcRenderer.on('map-change', async (event, img, size, opacity, draggable, rotation, mapLabel) => {
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
    showLabel(mapLabel, opacity);
});

ipcRenderer.on('map-hide', async (event) => {
    $("#mainImg").css({
        "width": "0px",
    })
    showLabel("");
});
