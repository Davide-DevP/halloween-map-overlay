'use strict';

/**
 * PURE controller-button codes for the map key's **second input**. A code is
 * the W3C *standard gamepad* button index — the vocabulary of
 * `navigator.getGamepads()`, which is how every pad Chromium knows (Xbox,
 * DualShock, DualSense, generic) is read. *Not* an accelerator: it never
 * reaches the hotkey tables. One button per setting; the label names both the
 * Xbox and the PlayStation face because the standard mapping cannot tell which.
 * Why: docs/agents/markers-and-tab-mode.md § The controller button.
 */

/** No button: the pad input is opt-in, so there is no default button. */
const NO_PAD_BUTTON = null;

/** Standard-mapping indices that need a name in code. */
const LEFT_TRIGGER = 6;
const RIGHT_TRIGGER = 7;
const TOUCHPAD = 17;

/** The Guide/PS button: never offered — the platform overlay's own key. */
const GUIDE = 16;

/** Longest controller name shown in Settings; Chromium's ids run past 80. */
const PAD_NAME_MAX = 40;

/** Longest `Gamepad.id` stored; anything longer is not a real id. */
const PAD_ID_MAX = 256;

/** Every button the app is willing to watch, in recording precedence. */
const PAD_BUTTONS = Object.freeze([
    {code: 8, label: 'View / Share'},
    {code: TOUCHPAD, label: 'Touchpad'},
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
    if (LEGACY_PAD_BITS.has(code)) return LEGACY_PAD_BITS.get(code);
    return NO_PAD_BUTTON;
}

/**
 * Normalise the stored `tabMarkerPadId` — the `Gamepad.id` of the controller
 * the button was chosen on. Not a string, empty or absurdly long is **none**.
 * @returns {?string}
 */
function resolvePadId(value) {
    if (typeof value !== 'string') return null;
    if (!value.trim() || value.length > PAD_ID_MAX) return null;
    return value;
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
    if (!isWatchablePad(code) || !Array.isArray(buttons)) return false;
    const b = buttons[code];
    if (!b) return false;
    if (typeof b.pressed === 'boolean') return b.pressed;
    return (Number(b.value) || 0) > 0.5;
}

/**
 * For the recorder: the buttons held in a Gamepad API reading, in precedence
 * order. One held button is a recording; none or several is "keep waiting".
 * @returns {number[]} codes
 */
function heldStandardButtons(buttons) {
    return PAD_BUTTONS.filter(b => standardButtonDown(buttons, b.code)).map(b => b.code);
}

/**
 * Which connected pads the watch reads. One pad is read whatever its id
 * (Steam Input can change an id between sessions); with two or more, only the
 * chosen one — and none if it is not there. No id stored is every pad.
 * Why: docs/agents/markers-and-tab-mode.md § The controller button.
 * @param {Array<{id?: string}>} list
 * @param {?string} id
 */
function padsToRead(list, id) {
    const pads = Array.isArray(list) ? list.filter(Boolean) : [];
    if (pads.length <= 1) return pads;
    const wanted = resolvePadId(id);
    if (wanted === null) return pads;
    return pads.filter(p => p.id === wanted);
}

/**
 * A short on-screen name from a `Gamepad.id`: Chromium's `(STANDARD GAMEPAD
 * Vendor: 054c Product: 09cc)`-style suffix dropped, capped at `PAD_NAME_MAX`.
 * @returns {string} `fallback` when nothing readable is left
 */
function padDisplayName(id, fallback = '') {
    if (typeof id !== 'string') return fallback;
    let name = id
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s*\([^()]*\b(?:STANDARD GAMEPAD|Vendor:\s*[0-9a-f]+|Product:\s*[0-9a-f]+)[^()]*\)\s*$/i, '')
        // Firefox-style `054c-09cc-` prefix, in case an id ever arrives that way.
        .replace(/^[0-9a-f]{4}-[0-9a-f]{4}-/i, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!name) return fallback;
    if (name.length > PAD_NAME_MAX) name = name.slice(0, PAD_NAME_MAX - 1).trimEnd() + '…';
    return name;
}

module.exports = {
    NO_PAD_BUTTON,
    LEFT_TRIGGER,
    RIGHT_TRIGGER,
    TOUCHPAD,
    GUIDE,
    PAD_NAME_MAX,
    PAD_ID_MAX,
    PAD_BUTTONS,
    LEGACY_PAD_BITS,
    isWatchablePad,
    resolveMapPad,
    resolvePadId,
    padLabel,
    standardButtonDown,
    heldStandardButtons,
    padsToRead,
    padDisplayName
};
