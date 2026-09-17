// Sample image shown on the overlay while the Overlay settings tab is open,
// so size/position/opacity/rotation changes can be previewed live without
// picking a real map first. Rendered once on a canvas and cached as base64
// PNG (the same format map-change already accepts).

const {t, language} = require("./i18n");

const SIZE = 900;

// Cached per language: the watermark is the one piece of text on it.
let cachedPreview = null;
let cachedLanguage = null;

function loadIcon() {
    return new Promise((resolve) => {
        const icon = new Image();
        // icon missing is cosmetic only -- the preview still works without it
        icon.onload = () => resolve(icon);
        icon.onerror = () => resolve(null);
        icon.src = "images/icon.png";
    });
}

async function buildPreviewImage() {
    if (cachedPreview && cachedLanguage === language()) return cachedPreview;

    const canvas = document.createElement("canvas");
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext("2d");

    const bg = ctx.createRadialGradient(SIZE / 2, SIZE / 2, 100, SIZE / 2, SIZE / 2, SIZE * 0.75);
    bg.addColorStop(0, "#241a12");
    bg.addColorStop(1, "#0d0a09");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, SIZE, SIZE);

    // Faint dot grid so the surface reads as textured, not flat
    ctx.fillStyle = "rgba(255, 255, 255, 0.06)";
    for (let y = 30; y < SIZE; y += 30) {
        for (let x = 30; x < SIZE; x += 30) {
            ctx.fillRect(x, y, 2, 2);
        }
    }

    // Frame keeps the overlay's edges visible while adjusting size/position
    ctx.strokeStyle = "rgba(255, 160, 60, 0.35)";
    ctx.lineWidth = 3;
    ctx.strokeRect(20, 20, SIZE - 40, SIZE - 40);

    // Diagonal watermark so it can never be mistaken for a real map
    ctx.save();
    ctx.translate(SIZE / 2, SIZE / 2);
    ctx.rotate(-Math.PI / 4);
    ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
    ctx.font = "bold 150px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(t('overlay.previewWatermark'), 0, 55);
    ctx.restore();

    const icon = await loadIcon();
    if (icon) {
        const iconSize = 520;
        ctx.save();
        ctx.shadowColor = "rgba(255, 150, 50, 0.5)";
        ctx.shadowBlur = 40;
        ctx.drawImage(icon, (SIZE - iconSize) / 2, 90, iconSize, iconSize);
        ctx.restore();
    }

    ctx.textAlign = "center";
    ctx.fillStyle = "#f0e6d8";
    // The product name, which is not translated.
    ctx.font = "bold 78px Georgia, serif";
    ctx.fillText("Halloween Map Overlay", SIZE / 2, 730);

    cachedPreview = canvas.toDataURL("image/png").split(",")[1];
    cachedLanguage = language();
    return cachedPreview;
}

module.exports = {buildPreviewImage};
