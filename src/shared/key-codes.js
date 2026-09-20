'use strict';

/**
 * PURE `KeyboardEvent` → **Windows virtual-key code**. Imports nothing.
 *
 * This is *not* an accelerator, and it deliberately shares nothing with
 * `hotkeys-constants.js`:
 *
 * - An **accelerator** is a combination the app asks Windows to *reserve*
 *   (`globalShortcut` → `RegisterHotKey`), which takes the key away from the
 *   game and has no key-up event at all. That is exactly what Tab-map mode's
 *   trigger must not do.
 * - A **virtual-key code** is a number the app hands to `GetAsyncKeyState` to
 *   ask "is this one key currently held?". Nothing is reserved, nothing is
 *   swallowed, and the key is still the game's.
 *
 * So the map key is one bare key with **no modifiers** (the game's map key is
 * a bare key), stored as a number, and it never appears in the system-hotkey
 * tables, the conflict checks or `hotkeys.json`.
 *
 * ## `keyCode` first, and why the "positional" story was wrong
 *
 * An earlier version preferred `KeyboardEvent.code` on the theory that Windows
 * virtual-key codes are positional. **They are not.** `VK_A`..`VK_Z` and the
 * `VK_OEM_*` codes follow the **active keyboard layout**, not the physical key:
 *
 *   - on AZERTY the key `code` calls `KeyQ` reports `VK_A` to Windows, so
 *     mapping `KeyQ` to 0x51 would have watched a key the player never pressed;
 *   - on the Italian layout (the owner's) the key `code` calls `Semicolon` is
 *     the `ò` key and Windows reports `VK_OEM_3` (0xC0), not `VK_OEM_1` (0xBA).
 *
 * In Chromium on Windows, `KeyboardEvent.keyCode` **is** the Windows virtual-key
 * code for the active layout — it is produced from the same `WM_KEYDOWN` the
 * game receives. So that is what is used, validated by `isWatchableVk` and
 * nothing else; `GetAsyncKeyState` then asks about exactly the key Windows said
 * was pressed. `code`/`key` remain as a fallback for a browser that reports no
 * `keyCode`, where a US-layout guess is better than refusing the key outright.
 *
 * The **label** comes from `KeyboardEvent.key`, for the same reason: only the
 * browser knows what the active layout calls that key. `vkLabel` is the
 * fallback when there is no stored label (an upgrade, a hand-edited file).
 *
 * Mouse buttons are out of scope: they never produce a `KeyboardEvent`, so
 * there is nothing here to map them from, and the help text says so.
 */

/** Tab. The game's default map key, and this app's default. */
const DEFAULT_MAP_VK = 0x09;

/** Either Alt. Queried *only* to ignore Alt+Tab — see `keyHintFor`. */
const VK_MENU = 0x12;

/**
 * Modifier keys, which a bare map key may never be.
 *
 * Not because the mapping could not produce them, but because holding a
 * modifier is not "opening the map": Shift, Ctrl and Alt are all held for other
 * reasons constantly, and Alt in particular is the one key this feature already
 * has to special-case.
 */
const MODIFIER_CODES = new Set([
    'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
    'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'AltGraph', 'OSLeft', 'OSRight'
]);

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'OS', 'Hyper', 'Super']);

/**
 * `KeyboardEvent.code` → virtual-key code, for everything that is not a plain
 * letter, digit or function key (those are ranges, handled below).
 *
 * The OEM values (`0xBA`..`0xDE`) are the US-layout positions, which is what
 * `GetAsyncKeyState` wants and what `code` names. A user on another layout gets
 * the physical key they pressed, which is the right answer — it is the key the
 * game sees too.
 */
const CODE_TO_VK = {
    Tab: 0x09,
    Backspace: 0x08,
    Enter: 0x0D,
    NumpadEnter: 0x0D,
    Escape: 0x1B,
    Space: 0x20,
    CapsLock: 0x14,
    NumLock: 0x90,
    ScrollLock: 0x91,
    Pause: 0x13,
    PrintScreen: 0x2C,
    Insert: 0x2D,
    Delete: 0x2E,
    Home: 0x24,
    End: 0x23,
    PageUp: 0x21,
    PageDown: 0x22,
    ArrowLeft: 0x25,
    ArrowUp: 0x26,
    ArrowRight: 0x27,
    ArrowDown: 0x28,
    NumpadAdd: 0x6B,
    NumpadSubtract: 0x6D,
    NumpadMultiply: 0x6A,
    NumpadDivide: 0x6F,
    NumpadDecimal: 0x6E,
    Semicolon: 0xBA,
    Equal: 0xBB,
    Comma: 0xBC,
    Minus: 0xBD,
    Period: 0xBE,
    Slash: 0xBF,
    Backquote: 0xC0,
    BracketLeft: 0xDB,
    Backslash: 0xDC,
    BracketRight: 0xDD,
    Quote: 0xDE,
    IntlBackslash: 0xE2
};

/** `KeyboardEvent.key` → virtual-key code, for the no-`code` fallback. */
const KEY_TO_VK = {
    Tab: 0x09,
    Backspace: 0x08,
    Enter: 0x0D,
    Escape: 0x1B,
    Esc: 0x1B,
    ' ': 0x20,
    Spacebar: 0x20,
    CapsLock: 0x14,
    NumLock: 0x90,
    ScrollLock: 0x91,
    Pause: 0x13,
    PrintScreen: 0x2C,
    Insert: 0x2D,
    Delete: 0x2E,
    Home: 0x24,
    End: 0x23,
    PageUp: 0x21,
    PageDown: 0x22,
    ArrowLeft: 0x25,
    ArrowUp: 0x26,
    ArrowRight: 0x27,
    ArrowDown: 0x28,
    ';': 0xBA,
    '=': 0xBB,
    ',': 0xBC,
    '-': 0xBD,
    '.': 0xBE,
    '/': 0xBF,
    '`': 0xC0,
    '[': 0xDB,
    '\\': 0xDC,
    ']': 0xDD,
    "'": 0xDE
};

/**
 * What a stored virtual-key code is called on screen. The display side of the
 * table above, so the Settings row can name a key the app only stores as a
 * number.
 */
const VK_LABEL = {
    0x08: 'Backspace',
    0x09: 'Tab',
    0x0D: 'Enter',
    0x13: 'Pause',
    0x14: 'Caps Lock',
    0x1B: 'Esc',
    0x20: 'Space',
    0x21: 'Page Up',
    0x22: 'Page Down',
    0x23: 'End',
    0x24: 'Home',
    0x25: '←',
    0x26: '↑',
    0x27: '→',
    0x28: '↓',
    0x2C: 'Print Screen',
    0x2D: 'Insert',
    0x2E: 'Delete',
    0x6A: 'Num *',
    0x6B: 'Num +',
    0x6D: 'Num -',
    0x6E: 'Num .',
    0x6F: 'Num /',
    0x90: 'Num Lock',
    0x91: 'Scroll Lock',
    0xBA: ';',
    0xBB: '=',
    0xBC: ',',
    0xBD: '-',
    0xBE: '.',
    0xBF: '/',
    0xC0: '`',
    0xDB: '[',
    0xDC: '\\',
    0xDD: ']',
    0xDE: '\'',
    0xE2: '\\'
};

/**
 * Is this a virtual-key code the app is willing to watch?
 *
 * The range is the documented 1..254 (0 is "no key", 0xFF is a reserved
 * multimedia placeholder), minus the modifiers — including the *combined*
 * Shift/Control/Alt codes, which a hand-edited settings file could hold.
 *
 * @param {*} vk
 * @returns {boolean}
 */
function isWatchableVk(vk) {
    if (typeof vk !== 'number' || !Number.isInteger(vk)) return false;
    if (vk < 0x01 || vk > 0xFE) return false;
    // 0x10-0x12 are the combined Shift/Control/Menu codes, 0xA0-0xA5 the
    // left/right ones, 0x5B-0x5C the Windows keys.
    if (vk >= 0x10 && vk <= 0x12) return false;
    if (vk >= 0xA0 && vk <= 0xA5) return false;
    if (vk === 0x5B || vk === 0x5C) return false;
    // Mouse buttons. They cannot be recorded here (no KeyboardEvent), but a
    // settings file could name one and `GetAsyncKeyState` would answer — which
    // would make the trigger fire on a click.
    if (vk >= 0x01 && vk <= 0x06) return false;
    return true;
}

/**
 * A keydown event → the virtual-key code to watch, or null.
 *
 * Null means "this key cannot be used", and the caller says so rather than
 * storing something that will never fire. Modifiers are refused, and so is a
 * key with a modifier held: the map key is a bare key, and recording
 * `Shift + M` would store `M` while the user believed they had bound the pair.
 *
 * @param {{keyCode?: number, code?: string, key?: string, shiftKey?: boolean,
 *          ctrlKey?: boolean, altKey?: boolean, metaKey?: boolean}} event
 * @returns {{vk: ?number, label: string, status: 'ok'|'modifier'|'with-modifier'|'unsupported'}}
 */
function keyEventToVk(event) {
    const e = event || {};
    const code = typeof e.code === 'string' ? e.code : '';
    const key = typeof e.key === 'string' ? e.key : '';

    if (MODIFIER_CODES.has(code) || MODIFIER_KEYS.has(key)) {
        return {vk: null, label: '', status: 'modifier'};
    }
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) {
        return {vk: null, label: '', status: 'with-modifier'};
    }

    // Chromium on Windows sets `keyCode` to the Windows virtual-key code for
    // the *active layout*, from the same `WM_KEYDOWN` the game sees. That is
    // the number `GetAsyncKeyState` wants, so it is preferred over any guess
    // made from `code`, which is positional and therefore wrong on any layout
    // but US.
    if (Number.isInteger(e.keyCode) && isWatchableVk(e.keyCode)) {
        return {vk: e.keyCode, label: labelFor(e.keyCode, key), status: 'ok'};
    }

    let vk = null;
    if (code) {
        if (Object.prototype.hasOwnProperty.call(CODE_TO_VK, code)) vk = CODE_TO_VK[code];
        else if (/^Key[A-Z]$/.test(code)) vk = code.charCodeAt(3);              // KeyW → 0x57
        else if (/^Digit[0-9]$/.test(code)) vk = 0x30 + Number(code[5]);        // Digit1 → 0x31
        else if (/^Numpad[0-9]$/.test(code)) vk = 0x60 + Number(code[6]);       // Numpad1 → 0x61
        else if (/^F([1-9]|1\d|2[0-4])$/.test(code)) vk = 0x6F + Number(code.slice(1)); // F1 → 0x70
    }
    if (vk === null && key) {
        if (Object.prototype.hasOwnProperty.call(KEY_TO_VK, key)) vk = KEY_TO_VK[key];
        else if (/^[a-z]$/i.test(key)) vk = key.toUpperCase().charCodeAt(0);
        else if (/^[0-9]$/.test(key)) vk = key.charCodeAt(0);
        else if (/^F([1-9]|1\d|2[0-4])$/.test(key)) vk = 0x6F + Number(key.slice(1));
    }
    if (vk === null || !isWatchableVk(vk)) return {vk: null, label: '', status: 'unsupported'};
    return {vk, label: labelFor(vk, key), status: 'ok'};
}

/**
 * What to call a key: what the browser says the *active layout* prints, with
 * the built-in table as the fallback.
 *
 * Only the browser knows that the key Windows calls `VK_OEM_3` prints `ò` on
 * an Italian keyboard — a virtual-key code alone cannot be turned back into a
 * name on anything but a US layout. Single characters are upper-cased so `m`
 * reads as `M`; multi-character names (`Tab`, `Enter`, `F5`) are taken as they
 * come, and a space is named rather than shown as one.
 *
 * @param {number} vk
 * @param {string} [key] `KeyboardEvent.key`
 * @returns {string}
 */
function labelFor(vk, key) {
    if (typeof key === 'string' && key && key !== 'Unidentified') {
        if (key === ' ') return 'Space';
        if (key.length === 1) return key.toUpperCase();
        // A named key the built-in table already spells more prettily (`Caps
        // Lock` rather than `CapsLock`) keeps the prettier spelling.
        const known = vkLabel(vk);
        if (known && known.replace(/\s+/g, '').toLowerCase() === key.replace(/\s+/g, '').toLowerCase()) {
            return known;
        }
        return key;
    }
    return vkLabel(vk);
}

/**
 * What to show for a stored virtual-key code. Never translated — it names a
 * physical key, like a map name names a map.
 * @param {*} vk
 * @returns {string} '' when the code is not one we watch
 */
function vkLabel(vk) {
    if (!isWatchableVk(vk)) return '';
    if (Object.prototype.hasOwnProperty.call(VK_LABEL, vk)) return VK_LABEL[vk];
    if (vk >= 0x41 && vk <= 0x5A) return String.fromCharCode(vk);               // A..Z
    if (vk >= 0x30 && vk <= 0x39) return String.fromCharCode(vk);               // 0..9
    if (vk >= 0x60 && vk <= 0x69) return 'Num ' + (vk - 0x60);
    if (vk >= 0x70 && vk <= 0x87) return 'F' + (vk - 0x6F);
    // Something watchable with no name of its own: show the number rather than
    // an empty row, so a hand-edited file is still readable in Settings.
    return '0x' + vk.toString(16).toUpperCase().padStart(2, '0');
}

/**
 * Normalise the stored `tabMarkerKey` setting.
 *
 * A file hand-edited to a modifier, a mouse button or nonsense falls back to
 * Tab rather than watching something that would fire on a click.
 *
 * @param {*} value
 * @returns {number}
 */
function resolveMapVk(value) {
    const vk = typeof value === 'number' ? value : parseInt(value, 10);
    return isWatchableVk(vk) ? vk : DEFAULT_MAP_VK;
}

module.exports = {
    DEFAULT_MAP_VK,
    VK_MENU,
    CODE_TO_VK,
    KEY_TO_VK,
    VK_LABEL,
    MODIFIER_CODES,
    MODIFIER_KEYS,
    isWatchableVk,
    keyEventToVk,
    labelFor,
    vkLabel,
    resolveMapVk
};
