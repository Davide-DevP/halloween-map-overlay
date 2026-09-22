'use strict';

/**
 * PURE controller-button codes for the map key's **second input**. A code is
 * the W3C *standard gamepad* button index — the vocabulary of
 * `navigator.getGamepads()`, which is how every pad Chromium knows (Xbox,
 * DualShock, DualSense, generic) is read — with the matching XInput bit kept
 * beside it for the `XInputGetState` path. *Not* an accelerator: it never
 * reaches the hotkey tables. One button per setting; the label names both the
 * Xbox and the PlayStation face because neither path can tell which pad it is.
 * Why: docs/agents/markers-and-tab-mode.md § The controller button.
 */

/** No button: the pad input is opt-in, so there is no default button. */
const NO_PAD_BUTTON = null;

/** XInput's own `XINPUT_GAMEPAD_TRIGGER_THRESHOLD`: below it a trigger is up. */
const TRIGGER_THRESHOLD = 30;

/** Standard-mapping indices with no XInput bit: the triggers and the touchpad. */
const LEFT_TRIGGER = 6;
const RIGHT_TRIGGER = 7;
const TOUCHPAD = 17;

/** The Guide/PS button: never offered — the game's own overlay key. */
const GUIDE = 16;

/**
 * Every button the app is willing to watch, in recording precedence. `code` is
 * the standard-mapping index; `xinput` its `wButtons` bit, `0` where XInput has
 * none (the triggers are analog there, the touchpad does not exist).
 */
const PAD_BUTTONS = Object.freeze([
    {code: 8, xinput: 0x0020, label: 'View / Share'},
    {code: TOUCHPAD, xinput: 0, label: 'Touchpad'},
    {code: 9, xinput: 0x0010, label: 'Menu / Options'},
    {code: 0, xinput: 0x1000, label: 'A / ✕'},
    {code: 1, xinput: 0x2000, label: 'B / ○'},
    {code: 2, xinput: 0x4000, label: 'X / □'},
    {code: 3, xinput: 0x8000, label: 'Y / △'},
    {code: 4, xinput: 0x0100, label: 'LB / L1'},
    {code: 5, xinput: 0x0200, label: 'RB / R1'},
    {code: LEFT_TRIGGER, xinput: 0, label: 'LT / L2'},
    {code: RIGHT_TRIGGER, xinput: 0, label: 'RT / R2'},
    {code: 10, xinput: 0x0040, label: 'LS / L3'},
    {code: 11, xinput: 0x0080, label: 'RS / R3'},
    {code: 12, xinput: 0x0001, label: 'D-pad ↑'},
    {code: 13, xinput: 0x0002, label: 'D-pad ↓'},
    {code: 14, xinput: 0x0004, label: 'D-pad ←'},
    {code: 15, xinput: 0x0008, label: 'D-pad →'}
].map(Object.freeze));

const BY_CODE = new Map(PAD_BUTTONS.map(b => [b.code, b]));

/**
 * 1.1.0–1.1.2 stored the XInput bit itself. Every such value that is not also
 * a standard index maps back to its button; the four D-pad bits (1, 2, 4, 8)
 * are ambiguous and read as the new codes (B, X, LB, View) — those three
 * releases lasted a day, and the one field install had View (0x0020 = 32).
 */
const LEGACY_XINPUT = new Map([
    [0x0010, 9], [0x0020, 8], [0x0040, 10], [0x0080, 11], [0x0100, 4], [0x0200, 5],
    [0x1000, 0], [0x2000, 1], [0x4000, 2], [0x8000, 3], [0x10000, LEFT_TRIGGER], [0x20000, RIGHT_TRIGGER]
]);

/** Is this a code the app is willing to watch? Exactly one known button. */
function isWatchablePad(code) {
    return typeof code === 'number' && Number.isInteger(code) && BY_CODE.has(code);
}

/**
 * Normalise the stored `tabMarkerPad`: a legacy XInput bit becomes its code; a
 * hand-edited file naming the Guide button, a stick or nonsense is **no
 * button**, never a guess.
 * @returns {?number}
 */
function resolveMapPad(value) {
    const code = typeof value === 'number' ? value : parseInt(value, 10);
    if (isWatchablePad(code)) return code;
    if (LEGACY_XINPUT.has(code)) return LEGACY_XINPUT.get(code);
    return NO_PAD_BUTTON;
}

/** What a stored code is called on screen. Never translated. @returns {string} */
function padLabel(code) {
    const button = BY_CODE.get(code);
    return button ? button.label : '';
}

/**
 * Is one button down in an **XInput** reading? Everything else in the reading
 * is ignored here — the one bit is the whole question. The touchpad has no
 * XInput face and is never down on this path.
 * @param {{wButtons?, bLeftTrigger?, bRightTrigger?}} gamepad
 */
function padButtonDown(gamepad, code) {
    const g = gamepad || {};
    if (!isWatchablePad(code)) return false;
    if (code === LEFT_TRIGGER) return (Number(g.bLeftTrigger) || 0) > TRIGGER_THRESHOLD;
    if (code === RIGHT_TRIGGER) return (Number(g.bRightTrigger) || 0) > TRIGGER_THRESHOLD;
    const mask = BY_CODE.get(code).xinput;
    return mask !== 0 && ((Number(g.wButtons) || 0) & mask) !== 0;
}

/**
 * Is one button down in a **Gamepad API** reading? `buttons` is the standard
 * mapping's array; Chromium sets `pressed` past its own threshold for the
 * analog triggers. A pad with a non-standard mapping is read the same way —
 * the index is then that pad's own numbering, which the recorder also used.
 * @param {Array<{pressed?: boolean, value?: number}>} buttons
 */
function standardButtonDown(buttons, code) {
    if (!isWatchablePad(code) || !Array.isArray(buttons)) return false;
    const b = buttons[code];
    if (!b) return false;
    if (typeof b.pressed === 'boolean') return b.pressed;
    return (Number(b.value) || 0) > 0.5;
}

/**
 * For the recorder: the buttons held in an XInput reading, in precedence
 * order. One held button is a recording; none or several is "keep waiting".
 * @returns {number[]} codes
 */
function heldPadButtons(gamepad) {
    return PAD_BUTTONS.filter(b => padButtonDown(gamepad, b.code)).map(b => b.code);
}

/** The same for a Gamepad API reading. @returns {number[]} codes */
function heldStandardButtons(buttons) {
    return PAD_BUTTONS.filter(b => standardButtonDown(buttons, b.code)).map(b => b.code);
}

module.exports = {
    NO_PAD_BUTTON,
    TRIGGER_THRESHOLD,
    LEFT_TRIGGER,
    RIGHT_TRIGGER,
    TOUCHPAD,
    GUIDE,
    PAD_BUTTONS,
    LEGACY_XINPUT,
    isWatchablePad,
    resolveMapPad,
    padLabel,
    padButtonDown,
    standardButtonDown,
    heldPadButtons,
    heldStandardButtons
};
