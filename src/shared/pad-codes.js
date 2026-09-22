'use strict';

/**
 * PURE controller-button codes for the map key's **second input**: a number
 * for `XInputGetState`, *not* an accelerator, so it never reaches the hotkey
 * tables. One button per setting; the label names both the Xbox and the
 * PlayStation face of it because XInput cannot tell which pad is plugged in.
 * Why: docs/agents/markers-and-tab-mode.md § The controller button.
 */

/** No button: the pad input is opt-in, so there is no default button. */
const NO_PAD_BUTTON = null;

/** XInput's own `XINPUT_GAMEPAD_TRIGGER_THRESHOLD`: below it a trigger is up. */
const TRIGGER_THRESHOLD = 30;

/** The two analog triggers, given codes outside the 16-bit button word. */
const LEFT_TRIGGER = 0x10000;
const RIGHT_TRIGGER = 0x20000;

/**
 * Every button the app is willing to watch, in recording precedence. The
 * `mask` is XInput's `wButtons` bit; the triggers have none. The Guide button
 * is not here: `XInputGetState` does not report it.
 */
const PAD_BUTTONS = Object.freeze([
    {code: 0x0020, mask: 0x0020, label: 'View / Share'},
    {code: 0x0010, mask: 0x0010, label: 'Menu / Options'},
    {code: 0x1000, mask: 0x1000, label: 'A / ✕'},
    {code: 0x2000, mask: 0x2000, label: 'B / ○'},
    {code: 0x4000, mask: 0x4000, label: 'X / □'},
    {code: 0x8000, mask: 0x8000, label: 'Y / △'},
    {code: 0x0100, mask: 0x0100, label: 'LB / L1'},
    {code: 0x0200, mask: 0x0200, label: 'RB / R1'},
    {code: LEFT_TRIGGER, mask: 0, label: 'LT / L2'},
    {code: RIGHT_TRIGGER, mask: 0, label: 'RT / R2'},
    {code: 0x0040, mask: 0x0040, label: 'LS / L3'},
    {code: 0x0080, mask: 0x0080, label: 'RS / R3'},
    {code: 0x0001, mask: 0x0001, label: 'D-pad ↑'},
    {code: 0x0002, mask: 0x0002, label: 'D-pad ↓'},
    {code: 0x0004, mask: 0x0004, label: 'D-pad ←'},
    {code: 0x0008, mask: 0x0008, label: 'D-pad →'}
].map(Object.freeze));

const BY_CODE = new Map(PAD_BUTTONS.map(b => [b.code, b]));

/** Is this a code the app is willing to watch? Exactly one known button. */
function isWatchablePad(code) {
    return typeof code === 'number' && Number.isInteger(code) && BY_CODE.has(code);
}

/**
 * Normalise the stored `tabMarkerPad`: a hand-edited file naming two buttons,
 * a stick or nonsense is **no button**, never a guess.
 * @returns {?number}
 */
function resolveMapPad(value) {
    const code = typeof value === 'number' ? value : parseInt(value, 10);
    return isWatchablePad(code) ? code : NO_PAD_BUTTON;
}

/** What a stored code is called on screen. Never translated. @returns {string} */
function padLabel(code) {
    const button = BY_CODE.get(code);
    return button ? button.label : '';
}

/**
 * Is one button down in an XInput gamepad reading? Everything else in the
 * reading is ignored here — the one bit is the whole question.
 * @param {{wButtons?, bLeftTrigger?, bRightTrigger?}} gamepad
 */
function padButtonDown(gamepad, code) {
    const g = gamepad || {};
    if (!isWatchablePad(code)) return false;
    if (code === LEFT_TRIGGER) return (Number(g.bLeftTrigger) || 0) > TRIGGER_THRESHOLD;
    if (code === RIGHT_TRIGGER) return (Number(g.bRightTrigger) || 0) > TRIGGER_THRESHOLD;
    return ((Number(g.wButtons) || 0) & code) !== 0;
}

/**
 * For the recorder: the buttons held in a reading, in precedence order. One
 * held button is a recording; none or several is "keep waiting", so a button
 * pressed on the way to another is not stored by mistake.
 * @returns {number[]} codes
 */
function heldPadButtons(gamepad) {
    return PAD_BUTTONS.filter(b => padButtonDown(gamepad, b.code)).map(b => b.code);
}

module.exports = {
    NO_PAD_BUTTON,
    TRIGGER_THRESHOLD,
    LEFT_TRIGGER,
    RIGHT_TRIGGER,
    PAD_BUTTONS,
    isWatchablePad,
    resolveMapPad,
    padLabel,
    padButtonDown,
    heldPadButtons
};
