// PURE positioning math for the overlay window; no electron, so it is tested.
// See docs/agents/overlay-windows.md.
//
// Glide is a percentage of the free space around the overlay: 0 = left/top edge
// of the work area, 100 = right/bottom. It is the mouse-free alternative to
// click-to-drag, which needs window moves that do not work on Wayland.

// Corner preset (1 TL, 2 TR, 3 BL, 4 BR) as glide percentages. Stored as a
// number (defaults) or a string (the select), hence `String(position)`; an
// unknown value means top-left.
const PRESET_GLIDE = {
    "1": {x: 0, y: 0},
    "2": {x: 100, y: 0},
    "3": {x: 0, y: 100},
    "4": {x: 100, y: 100}
};

function presetToGlide(position) {
    return PRESET_GLIDE[String(position)] || PRESET_GLIDE["1"];
}

function clampPercent(value, fallback) {
    const n = parseFloat(value);
    // Garbage falls back to the corner preset, so installs that predate the
    // sliders keep the corner they had picked.
    if (!Number.isFinite(n)) return fallback;
    return Math.min(100, Math.max(0, n));
}

function computeOverlayPosition({workArea, overlayWidth, overlayHeight, position, glideX, glideY}) {
    const freeW = Math.max(0, workArea.width - overlayWidth);
    const freeH = Math.max(0, workArea.height - overlayHeight);
    const preset = presetToGlide(position);
    const gx = clampPercent(glideX, preset.x);
    const gy = clampPercent(glideY, preset.y);
    return {
        x: workArea.x + Math.round(gx / 100 * freeW),
        y: workArea.y + Math.round(gy / 100 * freeH)
    };
}

// Bounding box of a width x height image rotated by `rotation` degrees: the
// overlay window is sized to this so no angle clips its corners.
function rotatedSize({width, height, rotation}) {
    const a = (parseFloat(rotation) || 0) * Math.PI / 180;
    const cos = Math.abs(Math.cos(a));
    const sin = Math.abs(Math.sin(a));
    return {
        width: Math.round(width * cos + height * sin),
        height: Math.round(width * sin + height * cos)
    };
}

module.exports = {computeOverlayPosition, presetToGlide, rotatedSize};
