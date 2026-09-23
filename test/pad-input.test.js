const {test} = require('node:test');
const assert = require('node:assert');
const {installElectronStub, stubModule} = require('./helpers/electron-stub');

/*
 * `core/pad-input.js`: koffi → `XInputGetState`, one bit of one pad. Driven
 * through the injected `load` (and once through `require('koffi')` itself,
 * stubbed), so no native module and no controller is involved. The privacy
 * half — the pad is not touched with no button configured — is asserted at
 * this level too: nothing is loaded or called until someone asks.
 * `test/key-trigger.test.js` covers the same class wired into the trigger.
 */
installElectronStub({userData: null});
const PadInput = require('../src/core/pad-input');
const {PAD_SCAN_INTERVAL, PAD_SLOTS} = require('../src/shared/tab-mode-rules');

const A = 0;           // xinput 0x1000
const LT = 6;          // analog, threshold 30
const NOT_CONNECTED = 1167;

/**
 * A koffi double: `pads[slot]` is that slot's `Gamepad`, missing = empty slot.
 * Records every DLL tried and every `XInputGetState` call.
 */
function fakeKoffi(o) {
    const log = {dlls: [], calls: [], loads: 0};
    const koffi = {
        load(dll) {
            log.dlls.push(dll);
            if ((o.missing || []).includes(dll)) throw new Error(`${dll} not found`);
            return {
                func(convention, symbol) {
                    if (o.bindThrows) throw new Error(`cannot bind ${symbol}`);
                    return (slot, out) => {
                        log.calls.push(slot);
                        if (o.callThrows) throw new Error('call failed');
                        if (o.rc !== undefined) return o.rc;
                        const pad = o.pads && o.pads[slot];
                        if (!pad) return NOT_CONNECTED;
                        out[0] = {dwPacketNumber: 1, Gamepad: pad};
                        return 0;
                    };
                }
            };
        },
        struct: (def) => def,
        out: (t) => t,
        pointer: (t) => t
    };
    return {koffi, log};
}

function build(o, clock) {
    const {koffi, log} = fakeKoffi(o || {});
    const time = clock || {now: 0};
    const pad = new PadInput({load: () => { log.loads += 1; return koffi; }, now: () => time.now});
    return {pad, log, time};
}

test('nothing is loaded or read until something asks', () => {
    const {pad, log} = build({pads: {0: {wButtons: 0x1000}}});
    assert.strictEqual(pad.isDown(A), null, 'not opened: no reading at all');
    assert.strictEqual(pad.readAll(), null);
    assert.deepStrictEqual([log.loads, log.calls.length], [0, 0]);
    assert.strictEqual(pad.status().available, null, 'tri-state: untried');
});

test('open() binds the first XInput DLL that loads, once', () => {
    const {pad, log} = build({missing: ['xinput1_4.dll']});
    assert.deepStrictEqual(pad.open(), {ok: true, reason: null});
    assert.strictEqual(pad.dll, 'xinput9_1_0.dll');
    assert.deepStrictEqual(pad.open(), {ok: true, reason: null});
    assert.strictEqual(log.loads, 1, 'idempotent');
    assert.strictEqual(pad.isAvailable(), true);
});

test('koffi unavailable is a reason, not a throw, and is not retried', () => {
    const pad = new PadInput({load: () => { throw new Error('MODULE_NOT_FOUND'); }});
    assert.deepStrictEqual(pad.open(), {ok: false, reason: 'load'});
    assert.strictEqual(pad.isAvailable(), false);
    assert.strictEqual(pad.isDown(A), null);
    assert.deepStrictEqual(pad.status(), {available: false, reason: 'load', slot: null, reads: 0, scans: 0, errors: 0});
});

test('the default loader is require("koffi"), and a missing one is handled the same way', () => {
    const restore = stubModule('koffi', new Error("Cannot find module 'koffi'"));
    try {
        assert.deepStrictEqual(new PadInput().open(), {ok: false, reason: 'load'});
    } finally {
        restore();
    }
});

test('no XInput at all, or a koffi without struct, fails as bind / load', () => {
    const none = build({missing: ['xinput1_4.dll', 'xinput9_1_0.dll', 'xinput1_3.dll']});
    assert.deepStrictEqual(none.pad.open(), {ok: false, reason: 'bind'});
    assert.strictEqual(none.log.dlls.length, 3);
    assert.deepStrictEqual(build({bindThrows: true}).pad.open(), {ok: false, reason: 'bind'});
    const bare = new PadInput({load: () => ({load() {}})});
    assert.deepStrictEqual(bare.open(), {ok: false, reason: 'load'});
});

test('only the configured bit is looked at', () => {
    const {pad} = build({pads: {0: {wButtons: 0x2000 | 0x0010}}}); // B + Menu, not A
    pad.open();
    assert.strictEqual(pad.isDown(A), false);
    assert.strictEqual(pad.isDown(1), true, 'B');
    assert.strictEqual(pad.isDown(9), true, 'Menu');
});

test('an analog trigger counts only past its threshold', () => {
    const {pad} = build({pads: {0: {wButtons: 0, bLeftTrigger: 30}}});
    pad.open();
    assert.strictEqual(pad.isDown(LT), false, 'a resting trigger is not a press');
    const {pad: pressed} = build({pads: {0: {wButtons: 0, bLeftTrigger: 200}}});
    pressed.open();
    assert.strictEqual(pressed.isDown(LT), true);
});

test('with no controller, the slots are scanned at PAD_SCAN_INTERVAL, not every tick', () => {
    const {pad, log, time} = build({pads: {}});
    pad.open();
    assert.strictEqual(pad.isDown(A), false);
    assert.strictEqual(log.calls.length, PAD_SLOTS);
    time.now += PAD_SCAN_INTERVAL - 1;
    assert.strictEqual(pad.isDown(A), false);
    assert.strictEqual(log.calls.length, PAD_SLOTS, 'no read inside the interval');
    time.now += 1;
    pad.isDown(A);
    assert.strictEqual(log.calls.length, 2 * PAD_SLOTS);
    assert.strictEqual(pad.status().scans, 2);
});

test('once found, one slot per tick; unplugged, back to scanning', () => {
    const pads = {2: {wButtons: 0x1000}};
    const {pad, log} = build({pads});
    pad.open();
    assert.strictEqual(pad.isDown(A), true);
    assert.deepStrictEqual(log.calls, [0, 1, 2]);
    log.calls.length = 0;
    pad.isDown(A);
    pad.isDown(A);
    assert.deepStrictEqual(log.calls, [2, 2]);
    delete pads[2];
    assert.strictEqual(pad.isDown(A), false, 'an unplugged pad reads as up');
    assert.strictEqual(pad.status().slot, null);
});

test('a call that throws answers null and is counted, never thrown', () => {
    const {pad} = build({callThrows: true});
    pad.open();
    assert.strictEqual(pad.isDown(A), null);
    assert.strictEqual(pad.readAll(), null);
    assert.strictEqual(pad.status().errors, 2);
});

test('any other XInput error code is "not connected"', () => {
    const {pad} = build({rc: 5});
    pad.open();
    assert.deepStrictEqual(pad.readSlot(0), {connected: false, gamepad: null});
    assert.strictEqual(pad.isDown(A), false);
});

test('readAll() gives every connected pad, for the recorder only', () => {
    const {pad} = build({pads: {0: {wButtons: 1}, 3: {wButtons: 2}}});
    pad.open();
    assert.deepStrictEqual(pad.readAll(), [{wButtons: 1}, {wButtons: 2}]);
});

test('status() is availability, a slot and counters — never a reading', () => {
    const {pad} = build({pads: {1: {wButtons: 0xffff, sThumbLX: 1234}}});
    pad.open();
    pad.isDown(A);
    const status = pad.status();
    assert.deepStrictEqual(Object.keys(status).sort(), ['available', 'errors', 'reads', 'reason', 'scans', 'slot']);
    assert.strictEqual(status.slot, 1);
    assert.ok(!JSON.stringify(status).includes('1234'));
});

test('destroy() unbinds and forgets the slot', () => {
    const {pad} = build({pads: {0: {wButtons: 0x1000}}});
    pad.open();
    pad.isDown(A);
    pad.destroy();
    assert.strictEqual(pad.isDown(A), null);
    assert.strictEqual(pad.status().slot, null);
});
