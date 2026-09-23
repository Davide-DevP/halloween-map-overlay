const {test} = require('node:test');
const assert = require('node:assert');

const P = require('../src/shared/pad-codes');
const {DEFAULT_SETTINGS} = require('../src/shared/settings-defaults');
const T = require('../src/shared/tab-mode-rules');

/*
 * The controller button is the map key's second input: a *standard gamepad*
 * button index, read through the Gamepad API for every pad Chromium knows,
 * never an accelerator. These are the decisions around it — what may be
 * stored, what counts as "down", what the recorder accepts, which of several
 * pads is read and what the chosen one is called on screen.
 */

const VIEW = 8;
const A = 0;

test('the pad button ships unset, and junk resolves to unset — never to a guess', () => {
    assert.strictEqual(DEFAULT_SETTINGS.tabMarkerPad, null);
    assert.strictEqual(P.NO_PAD_BUTTON, null);
    for (const bad of [null, undefined, '', 'A', -1, 18, 0x0400, 0x3000, 0x30000, 1.5, {}, []]) {
        assert.strictEqual(P.resolveMapPad(bad), null, JSON.stringify(bad));
    }
    // A stored code comes back as itself, as a number or a string.
    assert.strictEqual(P.resolveMapPad(VIEW), VIEW);
    assert.strictEqual(P.resolveMapPad('0'), A);
    assert.strictEqual(P.resolveMapPad(P.TOUCHPAD), P.TOUCHPAD);
    assert.strictEqual(P.resolveMapPad(P.LEFT_TRIGGER), P.LEFT_TRIGGER);
});

test('a 1.1.0–1.1.2 file, which stored the old button bit, still names the same button', () => {
    // The one field install had View (0x0020); every unambiguous bit migrates.
    assert.strictEqual(P.resolveMapPad(0x0020), VIEW);
    // 0x0010 is also the Guide index (16), which the app never stores: it is Menu.
    assert.strictEqual(P.resolveMapPad(0x0010), 9);
    assert.strictEqual(P.resolveMapPad(P.GUIDE), 9);
    assert.strictEqual(P.resolveMapPad(0x1000), A);
    assert.strictEqual(P.resolveMapPad(0x8000), 3);
    assert.strictEqual(P.resolveMapPad(0x0100), 4);
    assert.strictEqual(P.resolveMapPad(0x0080), 11);
    assert.strictEqual(P.resolveMapPad(0x10000), P.LEFT_TRIGGER);
    assert.strictEqual(P.resolveMapPad(0x20000), P.RIGHT_TRIGGER);
    // The D-pad bits collide with the new codes and read as the new codes.
    assert.strictEqual(P.resolveMapPad(1), 1);
    assert.strictEqual(P.resolveMapPad(8), VIEW);
    for (const [legacy, code] of P.LEGACY_PAD_BITS) {
        assert.ok(P.isWatchablePad(code), `legacy ${legacy} maps to an unwatchable ${code}`);
        assert.ok(!P.isWatchablePad(legacy), `legacy ${legacy} is also a live code`);
    }
});

test('every offered button is a standard index with a label, and the Guide button is not offered', () => {
    const seen = new Set();
    for (const button of P.PAD_BUTTONS) {
        assert.ok(P.isWatchablePad(button.code));
        assert.ok(button.code >= 0 && button.code <= 17 && button.code !== P.GUIDE);
        assert.ok(!seen.has(button.code), 'duplicate code');
        seen.add(button.code);
        assert.ok(button.label && P.padLabel(button.code) === button.label);
        assert.deepStrictEqual(Object.keys(button).sort(), ['code', 'label']);
    }
    assert.strictEqual(P.isWatchablePad(P.GUIDE), false);
    assert.strictEqual(P.padLabel(P.GUIDE), '');
    // Both faces of the pad are named, because the standard mapping cannot say which one is plugged in.
    assert.strictEqual(P.padLabel(A), 'A / ✕');
    assert.strictEqual(P.padLabel(VIEW), 'View / Share');
    assert.strictEqual(P.padLabel(P.TOUCHPAD), 'Touchpad');
});

test('Gamepad API: "down" is the one button\'s `pressed`, with `value` as the fallback', () => {
    const buttons = (pressedIndex) => Array.from({length: 18}, (_, i) => ({pressed: i === pressedIndex, value: i === pressedIndex ? 1 : 0}));
    assert.strictEqual(P.standardButtonDown(buttons(VIEW), VIEW), true);
    assert.strictEqual(P.standardButtonDown(buttons(P.TOUCHPAD), P.TOUCHPAD), true);
    assert.strictEqual(P.standardButtonDown(buttons(A), VIEW), false);
    // A button object with no `pressed` (an odd mapping) is read by value.
    assert.strictEqual(P.standardButtonDown([{value: 0.9}], A), true);
    assert.strictEqual(P.standardButtonDown([{value: 0.2}], A), false);
    // Short arrays, junk and the Guide button are never down.
    assert.strictEqual(P.standardButtonDown([], VIEW), false);
    assert.strictEqual(P.standardButtonDown(null, VIEW), false);
    assert.strictEqual(P.standardButtonDown(buttons(P.GUIDE), P.GUIDE), false);
});

test('the recorder sees the held buttons in precedence order, and nothing else', () => {
    // The second controller path is gone for good (2026-09-23).
    for (const gone of ['padButtonDown', 'heldPadButtons', 'TRIGGER_THRESHOLD']) {
        assert.strictEqual(P[gone], undefined, gone);
    }
    const buttons = Array.from({length: 18}, () => ({pressed: false, value: 0}));
    assert.deepStrictEqual(P.heldStandardButtons(buttons), []);
    buttons[P.TOUCHPAD].pressed = true;
    assert.deepStrictEqual(P.heldStandardButtons(buttons), [P.TOUCHPAD]);
    // Two at once is reported as two, so the caller can refuse to guess.
    buttons[VIEW].pressed = true;
    assert.deepStrictEqual(P.heldStandardButtons(buttons), [VIEW, P.TOUCHPAD]);
    // The Guide/PS button is not a recordable press.
    assert.deepStrictEqual(P.heldStandardButtons(Object.assign([], buttons, {[VIEW]: {pressed: false}, [P.TOUCHPAD]: {pressed: false}, [P.GUIDE]: {pressed: true}})), []);
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

test('the recording timeout sits where the design needs it', () => {
    for (const gone of ['PAD_SLOTS', 'PAD_SCAN_INTERVAL', 'combineRecordings']) {
        assert.strictEqual(T[gone], undefined, gone);
    }
    // Long enough to Alt+Tab back to the game and press, short enough to give up on a missing pad.
    assert.ok(T.PAD_RECORD_TIMEOUT >= 10000 && T.PAD_RECORD_TIMEOUT <= 30000);
});

/* ────────────────────────────────────────────────────────────────────────────
 * Which controller: chosen by pressing, read by id only when it matters
 * ──────────────────────────────────────────────────────────────────────────── */

const DS4 = 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)';
// Chromium's own id for an Xbox pad: the word in it is Chromium's, not ours.
const XBOX = 'Xbox 360 Controller (XInput STANDARD GAMEPAD)';

test('the chosen pad ships unset, and a stored id that is not one resolves to none', () => {
    assert.strictEqual(DEFAULT_SETTINGS.tabMarkerPadId, null);
    for (const bad of [null, undefined, '', '   ', 42, {}, [], 'x'.repeat(P.PAD_ID_MAX + 1)]) {
        assert.strictEqual(P.resolvePadId(bad), null, JSON.stringify(bad));
    }
    assert.strictEqual(P.resolvePadId(DS4), DS4);
});

test('one pad is read whatever its id: there is nothing to choose between', () => {
    const one = [{id: 'renamed by Steam Input'}];
    assert.deepStrictEqual(P.padsToRead(one, DS4), one);
    assert.deepStrictEqual(P.padsToRead(one, null), one);
    assert.deepStrictEqual(P.padsToRead([], DS4), []);
    assert.deepStrictEqual(P.padsToRead(null, DS4), []);
    // Empty slots in `getGamepads()` are not pads.
    assert.deepStrictEqual(P.padsToRead([null, one[0], undefined], DS4), one);
});

test('with two or more pads only the chosen one is read, and none if it is gone', () => {
    const ds4 = {id: DS4};
    const xbox = {id: XBOX};
    assert.deepStrictEqual(P.padsToRead([xbox, ds4], DS4), [ds4]);
    assert.deepStrictEqual(P.padsToRead([xbox, ds4], XBOX), [xbox]);
    // Two identical pads share an id: both are "the chosen one".
    const twin = {id: DS4};
    assert.deepStrictEqual(P.padsToRead([ds4, xbox, twin], DS4), [ds4, twin]);
    // The chosen pad unplugged, two others left: none is read, never a guess.
    assert.deepStrictEqual(P.padsToRead([xbox, {id: 'Generic USB Joystick'}], DS4), []);
    // No pad chosen yet (a button set before the choice existed): every pad, as before.
    assert.deepStrictEqual(P.padsToRead([xbox, ds4], null), [xbox, ds4]);
});

test('the controller name drops Chromium\'s suffix and stays short', () => {
    assert.strictEqual(P.padDisplayName(DS4), 'Wireless Controller');
    assert.strictEqual(P.padDisplayName(XBOX), 'Xbox 360 Controller');
    assert.strictEqual(P.padDisplayName('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'),
        'DualSense Wireless Controller');
    assert.strictEqual(P.padDisplayName('USB Gamepad (Vendor: 0079 Product: 0011)'), 'USB Gamepad');
    assert.strictEqual(P.padDisplayName('054c-05c4-Wireless Controller'), 'Wireless Controller');
    // A parenthesis that is part of the name stays.
    assert.strictEqual(P.padDisplayName('Pad (Blue)'), 'Pad (Blue)');
    const long = P.padDisplayName('A'.repeat(100));
    assert.strictEqual(long.length, P.PAD_NAME_MAX);
    assert.ok(long.endsWith('…'));
    assert.strictEqual(P.padDisplayName('Pad\u0000\nOne'), 'Pad One');
    // Nothing readable left: the caller's translated fallback.
    for (const empty of ['', '   ', '(STANDARD GAMEPAD Vendor: 054c Product: 09cc)', null, undefined, 7]) {
        assert.strictEqual(P.padDisplayName(empty, 'Your controller'), 'Your controller', String(empty));
    }
    assert.strictEqual(P.padDisplayName(''), '');
});
