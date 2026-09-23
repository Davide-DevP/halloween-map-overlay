'use strict';

/**
 * PURE: what the home page's detector line says, from main's status push and
 * what the line remembered from the pushes before it. The view in
 * `src/js/detector.js` only translates and draws the answer.
 */

/** @returns {{lastKey: ?string, lastAt: ?number, inMenu: boolean}} */
function emptyDetectorMemory() {
    return {lastKey: null, lastAt: null, inMenu: false};
}

/** `HH:MM` in local time. The clock is not translated. */
function clockTime(at) {
    const date = new Date(at);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * @param {?{lastKey: ?string, lastAt: ?number, inMenu: boolean}} memory
 * @param {?{running: boolean, lastDetected: ?string, lastAt: ?number,
 *           state: ?string, inMenu: ?boolean}} status
 * @returns {{memory: Object, state: 'off'|'menu'|'watching'|'detected',
 *            messageKey: string, params: ?Object}} `state` is for CSS to colour
 */
function detectorStatusView(memory, status) {
    const s = status || {};
    const next = Object.assign(emptyDetectorMemory(), memory || {});

    if (s.lastDetected) {
        next.lastKey = s.lastDetected;
        next.lastAt = s.lastAt;
        next.inMenu = false;
    } else if (s.state === 'menu') {
        next.lastKey = null;
        next.lastAt = null;
        next.inMenu = true;
    } else if (s.state === 'watching') {
        // The clear hotkey dropped the last detection; go back to watching.
        next.lastKey = null;
        next.lastAt = null;
        next.inMenu = false;
    } else if (s.inMenu !== undefined) {
        // The one `invoke` at startup, which carries no `state`.
        next.inMenu = !!s.inMenu;
    }

    if (!s.running) {
        return {memory: emptyDetectorMemory(), state: 'off', messageKey: 'detector.off', params: null};
    }
    if (next.inMenu && !next.lastKey) {
        return {memory: next, state: 'menu', messageKey: 'detector.menu', params: null};
    }
    if (!next.lastKey) {
        return {memory: next, state: 'watching', messageKey: 'detector.watching', params: null};
    }
    // The map name is never translated; only the sentence around it is.
    const map = next.lastKey.split('/').pop();
    if (next.lastAt) {
        return {memory: next, state: 'detected', messageKey: 'detector.detectedAt', params: {map, time: clockTime(next.lastAt)}};
    }
    return {memory: next, state: 'detected', messageKey: 'detector.detected', params: {map}};
}

module.exports = {detectorStatusView, emptyDetectorMemory, clockTime};
