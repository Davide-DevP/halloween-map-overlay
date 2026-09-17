const { ipcRenderer } = require('electron');

/** How long the map name stays up in `auto` mode — same as the overlay. */
const LABEL_MS = 3000;

let url = null;
let labelTimer = null;

/**
 * The same map name the transparent overlay shows, following the same
 * `mapLabel` setting, so a stream sees what the player sees.
 *
 * `.text()`, never markup: custom map names are typed by the user and this
 * window runs with node integration.
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

ipcRenderer.on('map-change', async (event, img, size, mapLabel, labelMode) => {
    if (url!==null){
        URL.revokeObjectURL(url)
    }
    let imgData = Buffer.from(img,"base64");
    let blob = new Blob([imgData]);
    url = URL.createObjectURL(blob);
    $("#mainImg").attr("src",url).css({
        "width":size+"px",
    })
    showLabel(mapLabel, labelMode);
});

ipcRenderer.on('map-hide', async (event) => {
    $("#mainImg").css({
        "width":"0px",
    })
    showLabel("");
});
