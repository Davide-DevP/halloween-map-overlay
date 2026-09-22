const {test} = require('node:test');
const assert = require('node:assert');

const P = require('../src/shared/pad-codes');
const {DEFAULT_SETTINGS} = require('../src/shared/settings-defaults');
const T = require('../src/shared/tab-mode-rules');

/*
 * The controller button is the map key's second input: a number for
 * `XInputGetState`, never an accelerator. These are the decisions around it —
 * what may be stored, what counts as "down", what the recorder accepts.
 */

test('the pad button ships unset, and junk resolves to unset — never to a guess', () => {
    assert.strictEqual(DEFAULT_SETTINGS.tabMarkerPad, null);
    assert.strictEqual(P.NO_PAD_BUTTON, null);
    for (const bad of [null, undefined, '', 'A', 0, -1, 0x0400, 0x3000, 0x30000, 1.5, {}, []]) {
        assert.strictEqual(P.resolveMapPad(bad), null, JSON.stringify(bad));
    }
    // A stored code comes back as itself, as a number or a string.
    assert.strictEqual(P.resolveMapPad(0x0020), 0x0020);
    assert.strictEqual(P.resolveMapPad('4096'), 0x1000);
    assert.strictEqual(P.resolveMapPad(P.LEFT_TRIGGER), P.LEFT_TRIGGER);
});

test('every offered button is one XInput bit, or one trigger, and has a label', () => {
    const seen = new Set();
    for (const button of P.PAD_BUTTONS) {
        assert.ok(P.isWatchablePad(button.code));
        assert.ok(!seen.has(button.code), 'duplicate code');
        seen.add(button.code);
        assert.ok(button.label && P.padLabel(button.code) === button.label);
        if (button.mask) {
            assert.strictEqual(button.mask, button.code);
            assert.strictEqual(button.mask & (button.mask - 1), 0, 'one bit');
        } else {
            assert.ok(button.code === P.LEFT_TRIGGER || button.code === P.RIGHT_TRIGGER);
        }
    }
    // The Guide button is not on offer: XInputGetState does not report it.
    assert.strictEqual(P.isWatchablePad(0x0400), false);
    assert.strictEqual(P.padLabel(0x0400), '');
    // Both faces of the pad are named, because XInput cannot say which one is plugged in.
    assert.strictEqual(P.padLabel(0x1000), 'A / ✕');
    assert.strictEqual(P.padLabel(0x0020), 'View / Share');
});

test('"down" is the one configured bit; a trigger counts past XInput\'s own threshold', () => {
    assert.strictEqual(P.padButtonDown({wButtons: 0x1000}, 0x1000), true);
    assert.strictEqual(P.padButtonDown({wButtons: 0x1000 | 0x0020}, 0x0020), true);
    assert.strictEqual(P.padButtonDown({wButtons: 0x2000}, 0x1000), false);
    assert.strictEqual(P.padButtonDown({wButtons: 0}, 0x1000), false);
    assert.strictEqual(P.padButtonDown({bLeftTrigger: P.TRIGGER_THRESHOLD}, P.LEFT_TRIGGER), false);
    assert.strictEqual(P.padButtonDown({bLeftTrigger: P.TRIGGER_THRESHOLD + 1}, P.LEFT_TRIGGER), true);
    assert.strictEqual(P.padButtonDown({bRightTrigger: 255}, P.RIGHT_TRIGGER), true);
    // A code the app does not watch is never down, whatever the reading says.
    assert.strictEqual(P.padButtonDown({wButtons: 0xFFFF, bLeftTrigger: 255, bRightTrigger: 255}, 0x0400), false);
    assert.strictEqual(P.padButtonDown(null, 0x1000), false);
    assert.strictEqual(P.padButtonDown({}, null), false);
});

test('the recorder sees the held buttons in precedence order, and nothing else', () => {
    assert.deepStrictEqual(P.heldPadButtons({wButtons: 0}), []);
    assert.deepStrictEqual(P.heldPadButtons({wButtons: 0x1000}), [0x1000]);
    // Two at once is reported as two, so the caller can refuse to guess.
    assert.deepStrictEqual(P.heldPadButtons({wButtons: 0x1000 | 0x0020}), [0x0020, 0x1000]);
    assert.deepStrictEqual(P.heldPadButtons({bRightTrigger: 200}), [P.RIGHT_TRIGGER]);
    // Sticks are not buttons: a moved stick records nothing.
    assert.deepStrictEqual(P.heldPadButtons({sThumbLX: 32000, sThumbLY: -32000}), []);
});

test('either input held is "down"; Alt vetoes only the keyboard', () => {
    assert.deepStrictEqual(T.foldMapInputs({key: true}), {down: true, alt: false, source: 'key'});
    assert.deepStrictEqual(T.foldMapInputs({pad: true}), {down: true, alt: false, source: 'pad'});
    assert.deepStrictEqual(T.foldMapInputs({key: true, pad: true}), {down: true, alt: false, source: 'key'});
    assert.deepStrictEqual(T.foldMapInputs({}), {down: false, alt: false, source: null});
    assert.deepStrictEqual(T.foldMapInputs(null), {down: false, alt: false, source: null});
    // Alt+Tab is a keyboard gesture: the keyboard press is vetoed downstream…
    const vetoed = T.foldMapInputs({key: true, alt: true});
    assert.deepStrictEqual(vetoed, {down: true, alt: true, source: 'key'});
    assert.strictEqual(T.keyHintFor(Object.assign({foreground: true}, vetoed)).down, false);
    // …but the controller is not Alt+Tab, so Alt happening to be down changes nothing.
    const pad = T.foldMapInputs({key: true, alt: true, pad: true});
    assert.deepStrictEqual(pad, {down: true, alt: false, source: 'pad'});
    assert.strictEqual(T.keyHintFor(Object.assign({foreground: true}, pad)).down, true);
    assert.strictEqual(T.keyHintFor(Object.assign({foreground: true}, T.foldMapInputs({pad: true, alt: true}))).down, true);
    // A failed read (null) is "not down", never "down".
    assert.strictEqual(T.foldMapInputs({key: null, pad: null}).down, false);
});

test('the pad cadences sit where the design needs them', () => {
    assert.strictEqual(T.PAD_SLOTS, 4);
    // A scan is four calls, so it may not run at the key poll's cadence.
    assert.ok(T.PAD_SCAN_INTERVAL >= 10 * T.KEY_POLL_INTERVAL);
    // Long enough to pick the pad up, short enough to give up on a missing one.
    assert.ok(T.PAD_RECORD_TIMEOUT >= 5000 && T.PAD_RECORD_TIMEOUT <= 30000);
});
