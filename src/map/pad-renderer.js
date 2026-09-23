'use strict';

const {ipcRenderer} = require('electron');
const {mapButtonDown, heldStandardButtons} = require('../shared/pad-codes');
const {KEY_POLL_INTERVAL} = require('../shared/tab-mode-rules');

/**
 * RENDERER tier: the map key's controller input, through the Gamepad API. Main
 * says when to read (`pad-watch`) and which button, and this loop answers with
 * **edges only** — `down`/`up` of that one button, on any connected pad — never
 * a reading.
 * Nothing runs unless main asked, and `pad-watch off` stops it at once. Every
 * pad Chromium knows (Xbox, DualShock, DualSense, generic) arrives here through
 * the standard mapping. Why: docs/agents/markers-and-tab-mode.md § The controller button.
 */

let watching = false;
let watchCode = null;
let wasDown = false;
let watchTimer = null;

let recording = false;
let recordTimer = null;

/** How many pads are connected, reported on change for `system.txt`. */
let lastPadCount = -1;

function pads() {
    try {
        const list = navigator.getGamepads ? navigator.getGamepads() : [];
        return Array.from(list || []).filter(Boolean);
    } catch (err) {
        return [];
    }
}

function reportPadCount(list) {
    if (list.length === lastPadCount) return;
    lastPadCount = list.length;
    // A count, never an id: `Gamepad.id` names the vendor and product.
    ipcRenderer.send('pad-seen', list.length);
}

/** `setTimeout` chaining, never `setInterval` — the project-wide rule. */
function watchTick() {
    watchTimer = null;
    if (!watching) return;
    const list = pads();
    reportPadCount(list);
    const down = list.some(pad => mapButtonDown(pad.buttons, watchCode));
    if (down !== wasDown) {
        wasDown = down;
        ipcRenderer.send('pad-edge', down);
    }
    watchTimer = setTimeout(watchTick, KEY_POLL_INTERVAL);
}

function stopWatch() {
    watching = false;
    if (watchTimer) clearTimeout(watchTimer);
    watchTimer = null;
    // A button held when the watch stops must not look held when it starts.
    if (wasDown) {
        wasDown = false;
        ipcRenderer.send('pad-edge', false);
    }
}

ipcRenderer.on('pad-watch', (event, request) => {
    const r = request || {};
    if (!r.on || typeof r.code !== 'number') {
        stopWatch();
        return;
    }
    if (watching && watchCode === r.code) return;
    stopWatch();
    watching = true;
    watchCode = r.code;
    watchTick();
});

/**
 * *Choose button…*: exactly one held button on any pad is the answer. Two at
 * once is a hand on its way somewhere. Main bounds the wait and cancels.
 */
function recordTick() {
    recordTimer = null;
    if (!recording) return;
    const list = pads();
    reportPadCount(list);
    for (const pad of list) {
        const held = heldStandardButtons(pad.buttons);
        if (held.length === 1) {
            recording = false;
            ipcRenderer.send('pad-recorded', {code: held[0]});
            return;
        }
    }
    recordTimer = setTimeout(recordTick, KEY_POLL_INTERVAL);
}

ipcRenderer.on('pad-record', (event, request) => {
    const on = !!(request && request.on);
    if (recordTimer) clearTimeout(recordTimer);
    recordTimer = null;
    recording = on;
    if (on) recordTick();
});
