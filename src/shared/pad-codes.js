'use strict';

/**
 * PURE controller-button codes for the map key's **second input**. A code is
 * the W3C *standard gamepad* button index — the vocabulary of
 * `navigator.getGamepads()`, which is how every pad Chromium knows (Xbox,
 * DualShock, DualSense, generic) is read. *Not* an accelerator: it never
 * reaches the hotkey tables. One button per setting, read on every connected
 * pad; the label names both the Xbox and the PlayStation face because the
 * standard mapping cannot tell which.
 * Why: docs/agents/markers-and-tab-mode.md § The controller button.
 */

/** No button: the pad input is opt-in, so there is no default button. */
const NO_PAD_BUTTON = null;

/** Standard-mapping indices that need a name in code. */
const LEFT_TRIGGER = 6;
const RIGHT_TRIGGER = 7;
/** The PlayStation touchpad click: the same button as View, see below. */
const TOUCHPAD = 17;

/** The Guide/PS button: never offered — the platform overlay's own key. */
const GUIDE = 16;

/**
 * The game's map button is View on an Xbox pad and the touchpad on a
 * PlayStation pad, so the two are **one button** here: chosen as either, read
 * as both. A code that is another code's face maps to it. Why:
 * docs/agents/markers-and-tab-mode.md § The controller button.
 */
const MAP_BUTTON_ALIASES = new Map([[TOUCHPAD, 8]]);

/** Every button the app is willing to watch, in recording precedence. */
const PAD_BUTTONS = Object.freeze([
    {code: 8, label: 'View / Touchpad'},
    {code: 9, label: 'Menu / Options'},
    {code: 0, label: 'A / ✕'},
    {code: 1, label: 'B / ○'},
    {code: 2, label: 'X / □'},
    {code: 3, label: 'Y / △'},
    {code: 4, label: 'LB / L1'},
    {code: 5, label: 'RB / R1'},
    {code: LEFT_TRIGGER, label: 'LT / L2'},
    {code: RIGHT_TRIGGER, label: 'RT / R2'},
    {code: 10, label: 'LS / L3'},
    {code: 11, label: 'RS / R3'},
    {code: 12, label: 'D-pad ↑'},
    {code: 13, label: 'D-pad ↓'},
    {code: 14, label: 'D-pad ←'},
    {code: 15, label: 'D-pad →'}
].map(Object.freeze));

const BY_CODE = new Map(PAD_BUTTONS.map(b => [b.code, b]));

/**
 * A settings migration, not a read path: 1.1.0–1.1.2 stored an XInput button
 * bit. The four D-pad bits (1, 2, 4, 8) are ambiguous and read as the codes.
 */
const LEGACY_PAD_BITS = new Map([
    [0x0010, 9], [0x0020, 8], [0x0040, 10], [0x0080, 11], [0x0100, 4], [0x0200, 5],
    [0x1000, 0], [0x2000, 1], [0x4000, 2], [0x8000, 3], [0x10000, LEFT_TRIGGER], [0x20000, RIGHT_TRIGGER]
]);

/** Is this a code the app is willing to watch? Exactly one known button. */
function isWatchablePad(code) {
    return typeof code === 'number' && Number.isInteger(code) && BY_CODE.has(code);
}

/**
 * Normalise the stored `tabMarkerPad`: a legacy 1.1.x value becomes its code; a
 * hand-edited file naming the Guide button, a stick or nonsense is **no
 * button**, never a guess.
 * @returns {?number}
 */
function resolveMapPad(value) {
    const code = typeof value === 'number' ? value : parseInt(value, 10);
    if (isWatchablePad(code)) return code;
    if (MAP_BUTTON_ALIASES.has(code)) return MAP_BUTTON_ALIASES.get(code);
    if (LEGACY_PAD_BITS.has(code)) return LEGACY_PAD_BITS.get(code);
    return NO_PAD_BUTTON;
}

/**
 * The standard indices read for one stored code: the code itself and every
 * face that is the same button on another pad (View is also the touchpad).
 * @returns {number[]} empty for a code the app does not watch
 */
function watchCodes(code) {
    if (!isWatchablePad(code)) return [];
    const codes = [code];
    for (const [alias, target] of MAP_BUTTON_ALIASES) if (target === code) codes.push(alias);
    return codes;
}

/** What a stored code is called on screen. Never translated. @returns {string} */
function padLabel(code) {
    const button = BY_CODE.get(code);
    return button ? button.label : '';
}

/**
 * Is one button down in a **Gamepad API** reading? `buttons` is the standard
 * mapping's array; Chromium sets `pressed` past its own threshold for the
 * analog triggers. A pad with a non-standard mapping is read the same way —
 * the index is then that pad's own numbering, which the recorder also used.
 * @param {Array<{pressed?: boolean, value?: number}>} buttons
 */
function standardButtonDown(buttons, code) {
    const readable = isWatchablePad(code) || MAP_BUTTON_ALIASES.has(code);
    if (!readable || !Array.isArray(buttons)) return false;
    const b = buttons[code];
    if (!b) return false;
    if (typeof b.pressed === 'boolean') return b.pressed;
    return (Number(b.value) || 0) > 0.5;
}

/**
 * Is the **map button** down: the stored code or any of its other faces. The
 * watch reads this on every connected pad — a pad Windows shows twice
 * (Bluetooth and cable) or Steam's virtual copy of it is still the one pad.
 * Why: docs/agents/markers-and-tab-mode.md § The controller button.
 */
function mapButtonDown(buttons, code) {
    return watchCodes(code).some(c => standardButtonDown(buttons, c));
}

/**
 * For the recorder: the buttons held in a Gamepad API reading, in precedence
 * order, each face folded onto its button. One held button is a recording;
 * none or several is "keep waiting".
 * @returns {number[]} codes
 */
function heldStandardButtons(buttons) {
    return PAD_BUTTONS.filter(b => mapButtonDown(buttons, b.code)).map(b => b.code);
}

module.exports = {
    NO_PAD_BUTTON,
    LEFT_TRIGGER,
    RIGHT_TRIGGER,
    TOUCHPAD,
    GUIDE,
    PAD_BUTTONS,
    LEGACY_PAD_BITS,
    MAP_BUTTON_ALIASES,
    isWatchablePad,
    resolveMapPad,
    watchCodes,
    padLabel,
    standardButtonDown,
    mapButtonDown,
    heldStandardButtons
};
