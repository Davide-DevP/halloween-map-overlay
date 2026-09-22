'use strict';

/**
 * Dev-only: does this PC's controller reach the app? Plain node, no Electron.
 * Binds XInput exactly as `src/core/pad-input.js` does and prints the button
 * held on any connected pad, by the app's own label. Ctrl+C to stop.
 *
 *   node scripts/probe-pad.js
 *
 * A PlayStation pad is seen only while Steam is translating it (a Steam game
 * open with Steam Input on) or through DS4Windows — the same rule as the app.
 */
const PadInput = require('../src/core/pad-input');
const {heldPadButtons, padLabel, PAD_BUTTONS} = require('../src/shared/pad-codes');
const {PAD_SLOTS} = require('../src/shared/tab-mode-rules');

const pad = new PadInput();
const opened = pad.open();
if (!opened.ok) {
    console.error(`XInput is not usable here (${opened.reason}).`);
    process.exit(1);
}
console.log(`XInput bound through ${pad.dll}. Buttons the app can watch:`);
console.log('  ' + PAD_BUTTONS.map(b => b.label).join(' · '));
console.log('Press buttons on the controller. Ctrl+C to stop.\n');

let last = '';
let seen = false;
setInterval(() => {
    const lines = [];
    for (let slot = 0; slot < PAD_SLOTS; slot++) {
        const reading = pad.readSlot(slot);
        if (!reading || !reading.connected) continue;
        seen = true;
        const held = heldPadButtons(reading.gamepad).map(padLabel);
        lines.push(`slot ${slot}: ${held.length ? held.join(' + ') : '(nothing held)'}`);
    }
    const text = lines.length ? lines.join('  |  ') : (seen ? 'controller unplugged' : 'no controller found yet…');
    if (text !== last) {
        last = text;
        console.log(new Date().toISOString().slice(11, 23), text);
    }
}, 30);
