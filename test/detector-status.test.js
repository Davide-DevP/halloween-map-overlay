const {test} = require('node:test');
const assert = require('node:assert');
const {detectorStatusView, emptyDetectorMemory, clockTime} = require('../src/shared/detector-status');

const at = new Date(2026, 8, 23, 7, 5).getTime();

test('a stopped loop is "off" and forgets everything it remembered', () => {
    const memory = {lastKey: 'deftyconchgaming/East Haddonfield', lastAt: at, inMenu: true};
    const view = detectorStatusView(memory, {running: false, lastDetected: 'x/Y', lastAt: at});
    assert.strictEqual(view.state, 'off');
    assert.strictEqual(view.messageKey, 'detector.off');
    assert.deepStrictEqual(view.memory, emptyDetectorMemory());
});

test('no status at all is "off", never a crash', () => {
    assert.strictEqual(detectorStatusView(null, null).state, 'off');
    assert.strictEqual(detectorStatusView(undefined, undefined).messageKey, 'detector.off');
});

test('a detection names the map, without its creator, and the time', () => {
    const view = detectorStatusView(null, {
        running: true, lastDetected: 'deftyconchgaming/East Haddonfield', lastAt: at
    });
    assert.strictEqual(view.state, 'detected');
    assert.strictEqual(view.messageKey, 'detector.detectedAt');
    assert.deepStrictEqual(view.params, {map: 'East Haddonfield', time: '07:05'});
});

test('a detection with no time uses the sentence without one', () => {
    const view = detectorStatusView(null, {running: true, lastDetected: 'a/Smiths Grove'});
    assert.strictEqual(view.messageKey, 'detector.detected');
    assert.deepStrictEqual(view.params, {map: 'Smiths Grove'});
});

test('the menu clears the last detection until the next one', () => {
    const detected = detectorStatusView(null, {running: true, lastDetected: 'a/B', lastAt: at});
    const menu = detectorStatusView(detected.memory, {running: true, state: 'menu'});
    assert.strictEqual(menu.state, 'menu');
    assert.strictEqual(menu.messageKey, 'detector.menu');
    assert.strictEqual(menu.memory.lastKey, null);
    const again = detectorStatusView(menu.memory, {running: true, lastDetected: 'a/C', lastAt: at});
    assert.strictEqual(again.state, 'detected');
    assert.strictEqual(again.memory.inMenu, false);
});

test('"watching" after the clear hotkey drops the last detection', () => {
    const detected = detectorStatusView(null, {running: true, lastDetected: 'a/B', lastAt: at});
    const view = detectorStatusView(detected.memory, {running: true, state: 'watching'});
    assert.strictEqual(view.state, 'watching');
    assert.strictEqual(view.messageKey, 'detector.watching');
    assert.strictEqual(view.memory.lastKey, null);
});

test('a push with no news keeps the remembered detection', () => {
    const detected = detectorStatusView(null, {running: true, lastDetected: 'a/B', lastAt: at});
    const view = detectorStatusView(detected.memory, {running: true});
    assert.strictEqual(view.state, 'detected');
    assert.strictEqual(view.params.map, 'B');
});

test('the startup answer carries only `inMenu`, and it is honoured', () => {
    assert.strictEqual(detectorStatusView(null, {running: true, inMenu: true}).state, 'menu');
    assert.strictEqual(detectorStatusView(null, {running: true, inMenu: false}).state, 'watching');
});

test('the same status twice gives the same answer (a language re-render)', () => {
    const status = {running: true, lastDetected: 'a/B', lastAt: at};
    const first = detectorStatusView(null, status);
    const second = detectorStatusView(first.memory, status);
    assert.deepStrictEqual(second, first);
});

test('the memory passed in is not changed', () => {
    const memory = {lastKey: 'a/B', lastAt: at, inMenu: false};
    detectorStatusView(memory, {running: true, state: 'menu'});
    assert.deepStrictEqual(memory, {lastKey: 'a/B', lastAt: at, inMenu: false});
});

test('the clock is two-digit hours and minutes', () => {
    assert.strictEqual(clockTime(new Date(2026, 0, 1, 23, 59).getTime()), '23:59');
    assert.strictEqual(clockTime(new Date(2026, 0, 1, 0, 0).getTime()), '00:00');
});
