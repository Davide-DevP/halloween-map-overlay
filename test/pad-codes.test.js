const {test} = require('node:test');
const assert = require('node:assert');

const P = require('../src/shared/pad-codes');
const {DEFAULT_SETTINGS} = require('../src/shared/settings-defaults');
const T = require('../src/shared/tab-mode-rules');

/*
 * The controller button is the map key's second input: a *standard gamepad*
 * button index, read through the Gamepad API for every pad Chromium knows and
 * through XInput for the Xbox-shaped ones, never an accelerator. These are the
 * decisions around it — what may be stored, what counts as "down" on each
 * path, what the recorder accepts, how two recorders become one answer.
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

test('a 1.1.0–1.1.2 file, which stored the XInput bit, still names the same button', () => {
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
    for (const [legacy, code] of P.LEGACY_XINPUT) {
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
        if (button.xinput) assert.strictEqual(button.xinput & (button.xinput - 1), 0, 'one bit');
        else assert.ok([P.LEFT_TRIGGER, P.RIGHT_TRIGGER, P.TOUCHPAD].includes(button.code));
    }
    assert.strictEqual(P.isWatchablePad(P.GUIDE), false);
    assert.strictEqual(P.padLabel(P.GUIDE), '');
    // Both faces of the pad are named, because neither path can say which one is plugged in.
    assert.strictEqual(P.padLabel(A), 'A / ✕');
    assert.strictEqual(P.padLabel(VIEW), 'View / Share');
    assert.strictEqual(P.padLabel(P.TOUCHPAD), 'Touchpad');
});

test('XInput: "down" is the one configured bit; a trigger counts past XInput\'s own threshold', () => {
    assert.strictEqual(P.padButtonDown({wButtons: 0x1000}, A), true);
    assert.strictEqual(P.padButtonDown({wButtons: 0x1000 | 0x0020}, VIEW), true);
    assert.strictEqual(P.padButtonDown({wButtons: 0x2000}, A), false);
    assert.strictEqual(P.padButtonDown({wButtons: 0}, A), false);
    assert.strictEqual(P.padButtonDown({bLeftTrigger: P.TRIGGER_THRESHOLD}, P.LEFT_TRIGGER), false);
    assert.strictEqual(P.padButtonDown({bLeftTrigger: P.TRIGGER_THRESHOLD + 1}, P.LEFT_TRIGGER), true);
    assert.strictEqual(P.padButtonDown({bRightTrigger: 255}, P.RIGHT_TRIGGER), true);
    // The touchpad has no XInput face: never down on this path, whatever is set.
    assert.strictEqual(P.padButtonDown({wButtons: 0xFFFF, bLeftTrigger: 255, bRightTrigger: 255}, P.TOUCHPAD), false);
    assert.strictEqual(P.padButtonDown({wButtons: 0xFFFF}, P.GUIDE), false);
    assert.strictEqual(P.padButtonDown(null, A), false);
    assert.strictEqual(P.padButtonDown({}, null), false);
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

test('the recorders see the held buttons in precedence order, and nothing else', () => {
    assert.deepStrictEqual(P.heldPadButtons({wButtons: 0}), []);
    assert.deepStrictEqual(P.heldPadButtons({wButtons: 0x1000}), [A]);
    // Two at once is reported as two, so the caller can refuse to guess.
    assert.deepStrictEqual(P.heldPadButtons({wButtons: 0x1000 | 0x0020}), [VIEW, A]);
    assert.deepStrictEqual(P.heldPadButtons({bRightTrigger: 200}), [P.RIGHT_TRIGGER]);
    // Sticks are not buttons: a moved stick records nothing.
    assert.deepStrictEqual(P.heldPadButtons({sThumbLX: 32000, sThumbLY: -32000}), []);
    const buttons = Array.from({length: 18}, () => ({pressed: false, value: 0}));
    assert.deepStrictEqual(P.heldStandardButtons(buttons), []);
    buttons[P.TOUCHPAD].pressed = true;
    assert.deepStrictEqual(P.heldStandardButtons(buttons), [P.TOUCHPAD]);
    buttons[VIEW].pressed = true;
    assert.deepStrictEqual(P.heldStandardButtons(buttons), [VIEW, P.TOUCHPAD]);
    // The Guide/PS button is not a recordable press.
    assert.deepStrictEqual(P.heldStandardButtons(Object.assign([], buttons, {[VIEW]: {pressed: false}, [P.TOUCHPAD]: {pressed: false}, [P.GUIDE]: {pressed: true}})), []);
});

test('two recorders, one answer: the first ok wins, else the most informative refusal', () => {
    const ok = {ok: true, code: VIEW, label: 'View / Share'};
    assert.deepStrictEqual(T.combineRecordings([{ok: false, reason: 'unavailable'}, ok]), ok);
    assert.deepStrictEqual(T.combineRecordings([ok, {ok: true, code: A, label: 'A / ✕'}]), ok);
    // A pad that was seen but not pressed says more than "no controller"…
    assert.deepStrictEqual(T.combineRecordings([{ok: false, reason: 'no-controller'}, {ok: false, reason: 'timeout'}]),
        {ok: false, reason: 'timeout'});
    // …which says more than a path that could not run at all.
    assert.deepStrictEqual(T.combineRecordings([{ok: false, reason: 'unavailable'}, {ok: false, reason: 'no-controller'}]),
        {ok: false, reason: 'no-controller'});
    assert.deepStrictEqual(T.combineRecordings([{ok: false, reason: 'unavailable'}, {ok: false, reason: 'unavailable'}]),
        {ok: false, reason: 'unavailable'});
    assert.deepStrictEqual(T.combineRecordings([]), {ok: false, reason: 'unavailable'});
    assert.deepStrictEqual(T.combineRecordings(null), {ok: false, reason: 'unavailable'});
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
    // Long enough to Alt+Tab back to the game and press, short enough to give up on a missing pad.
    assert.ok(T.PAD_RECORD_TIMEOUT >= 10000 && T.PAD_RECORD_TIMEOUT <= 30000);
});
