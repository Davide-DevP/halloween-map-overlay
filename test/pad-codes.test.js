const {test} = require('node:test');
const assert = require('node:assert');

const P = require('../src/shared/pad-codes');
const {DEFAULT_SETTINGS} = require('../src/shared/settings-defaults');
const T = require('../src/shared/tab-mode-rules');

/*
 * The controller button is the map key's second input: a *standard gamepad*
 * button index, read through the Gamepad API for every pad Chromium knows,
 * never an accelerator. These are the decisions around it — what may be
 * stored, what counts as "down", what the recorder accepts, and which faces
 * are one button (View is the touchpad on a PlayStation pad).
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
    assert.strictEqual(P.resolveMapPad(P.LEFT_TRIGGER), P.LEFT_TRIGGER);
});

test('the touchpad is View: a 1.3.x file that stored 17 reads as the one map button', () => {
    // The game's map button is View on Xbox and the touchpad on PlayStation, so
    // a player who chose the touchpad on a DualSense and then plays through
    // Steam's virtual Xbox pad — or on an Xbox pad — does not choose again.
    assert.deepStrictEqual([...P.MAP_BUTTON_ALIASES], [[P.TOUCHPAD, VIEW]]);
    assert.strictEqual(P.resolveMapPad(P.TOUCHPAD), VIEW);
    assert.strictEqual(P.resolveMapPad('17'), VIEW);
    assert.strictEqual(P.isWatchablePad(P.TOUCHPAD), false, 'not a code of its own');
    assert.strictEqual(P.padLabel(P.TOUCHPAD), '');
    // What the watch reads for a stored code: the code and its other faces.
    assert.deepStrictEqual(P.watchCodes(VIEW), [VIEW, P.TOUCHPAD]);
    assert.deepStrictEqual(P.watchCodes(A), [A]);
    assert.deepStrictEqual(P.watchCodes(P.TOUCHPAD), []);
    assert.deepStrictEqual(P.watchCodes(null), []);
    assert.deepStrictEqual(P.watchCodes(P.GUIDE), []);
    // Every alias points at an offered button, and never at another alias.
    for (const [alias, target] of P.MAP_BUTTON_ALIASES) {
        assert.ok(P.isWatchablePad(target), `alias ${alias} → unwatchable ${target}`);
        assert.ok(!P.isWatchablePad(alias), `alias ${alias} is also offered`);
        assert.ok(!P.MAP_BUTTON_ALIASES.has(target), `alias chain at ${target}`);
    }
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
    // …and View names the touchpad, which is the same button to the game.
    assert.strictEqual(P.padLabel(VIEW), 'View / Touchpad');
    assert.ok(P.PAD_BUTTONS.every(b => b.code !== P.TOUCHPAD), 'the touchpad is not offered twice');
});

test('Gamepad API: "down" is the one button\'s `pressed`, with `value` as the fallback', () => {
    const buttons = (pressedIndex) => Array.from({length: 18}, (_, i) => ({pressed: i === pressedIndex, value: i === pressedIndex ? 1 : 0}));
    assert.strictEqual(P.standardButtonDown(buttons(VIEW), VIEW), true);
    assert.strictEqual(P.standardButtonDown(buttons(A), VIEW), false);
    // The raw read is exact: index 17 is index 17…
    assert.strictEqual(P.standardButtonDown(buttons(P.TOUCHPAD), VIEW), false);
    // …and the map button folds its faces: View stored, touchpad pressed, is down.
    assert.strictEqual(P.mapButtonDown(buttons(P.TOUCHPAD), VIEW), true);
    assert.strictEqual(P.mapButtonDown(buttons(VIEW), VIEW), true);
    assert.strictEqual(P.mapButtonDown(buttons(A), VIEW), false);
    assert.strictEqual(P.mapButtonDown(buttons(VIEW), A), false);
    // A short array (an Xbox pad has no index 17) is read as far as it goes.
    assert.strictEqual(P.mapButtonDown(buttons(VIEW).slice(0, 16), VIEW), true);
    assert.strictEqual(P.mapButtonDown(buttons(A).slice(0, 16), VIEW), false);
    assert.strictEqual(P.mapButtonDown(null, VIEW), false);
    assert.strictEqual(P.mapButtonDown(buttons(P.TOUCHPAD), P.TOUCHPAD), false, 'an alias is not a stored code');
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
    // The touchpad held is a recording of View: one button, whichever face.
    buttons[P.TOUCHPAD].pressed = true;
    assert.deepStrictEqual(P.heldStandardButtons(buttons), [VIEW]);
    buttons[VIEW].pressed = true;
    assert.deepStrictEqual(P.heldStandardButtons(buttons), [VIEW], 'two faces of one button are one');
    // Two buttons at once is reported as two, so the caller can refuse to guess.
    buttons[A].pressed = true;
    assert.deepStrictEqual(P.heldStandardButtons(buttons), [VIEW, A]);
    // The Guide/PS button is not a recordable press.
    assert.deepStrictEqual(P.heldStandardButtons(Object.assign([], buttons, {[A]: {pressed: false}, [VIEW]: {pressed: false}, [P.TOUCHPAD]: {pressed: false}, [P.GUIDE]: {pressed: true}})), []);
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
