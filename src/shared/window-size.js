'use strict';

/**
 * PURE: the main window's size — what to open at, and what a resize may store.
 * Size only, never position. Why: docs/agents/overlay-windows.md § The main window's size.
 */

const MAIN_WINDOW_DEFAULT = Object.freeze({width: 1100, height: 820});
const MAIN_WINDOW_MIN = Object.freeze({width: 900, height: 640});

function positiveInt(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

/** `{width, height}` of positive finite numbers, rounded; anything else is null. */
function readSize(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const width = positiveInt(value.width);
    const height = positiveInt(value.height);
    return width && height ? {width, height} : null;
}

function clampAxis(value, min, max) {
    if (!max) return Math.max(value, min);
    // A work area smaller than the minimum wins: never open past the screen.
    return Math.min(Math.max(value, Math.min(min, max)), max);
}

/**
 * The size to open at: `saved` when it is a valid size, else `defaults`,
 * held between `min` and the target display's work area.
 * @returns {{width: number, height: number}}
 */
function clampWindowSize(saved, workArea, defaults = MAIN_WINDOW_DEFAULT, min = MAIN_WINDOW_MIN) {
    const base = readSize(saved) || readSize(defaults) || {...MAIN_WINDOW_DEFAULT};
    const floor = readSize(min) || {...MAIN_WINDOW_MIN};
    const area = readSize(workArea);
    return {
        width: clampAxis(base.width, floor.width, area && area.width),
        height: clampAxis(base.height, floor.height, area && area.height)
    };
}

/** `minWidth`/`minHeight` for a work area that may be smaller than the minimum. */
function minimumSize(workArea, min = MAIN_WINDOW_MIN) {
    const floor = readSize(min) || {...MAIN_WINDOW_MIN};
    const area = readSize(workArea);
    return {
        width: area ? Math.min(floor.width, area.width) : floor.width,
        height: area ? Math.min(floor.height, area.height) : floor.height
    };
}

/**
 * What a settled resize stores, or null to store nothing: a maximised,
 * minimised or full-screen window is not a size the user chose.
 * @param {?{width: number, height: number}} size the window's outer size
 * @param {?{maximized?: boolean, minimized?: boolean, fullScreen?: boolean}} state
 * @param {?Object} stored what `mainWindowSize` holds now
 */
function sizeToPersist(size, state, stored) {
    const s = state || {};
    if (s.maximized || s.minimized || s.fullScreen) return null;
    const next = readSize(size);
    if (!next) return null;
    const before = readSize(stored);
    if (before && before.width === next.width && before.height === next.height) return null;
    return next;
}

module.exports = {
    MAIN_WINDOW_DEFAULT,
    MAIN_WINDOW_MIN,
    readSize,
    clampWindowSize,
    minimumSize,
    sizeToPersist
};
