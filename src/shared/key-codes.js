'use strict';

/**
 * PURE `KeyboardEvent` → **Windows virtual-key code** — a number for
 * `GetAsyncKeyState`, *not* an accelerator, so it never reaches the
 * system-hotkey tables, the conflict checks or `hotkeys.json`. **`keyCode`
 * first**, because virtual-key codes are *not* positional; `code`/`key` are a
 * fallback for a browser that reports no `keyCode`, and the **label** comes
 * from `KeyboardEvent.key` because only the browser knows the active layout.
 * Why: docs/agents/markers-and-tab-mode.md § The key-state trigger.
 */

/** Tab. The game's default map key, and this app's default. */
const DEFAULT_MAP_VK = 0x09;

/** Either Alt. Queried *only* to ignore Alt+Tab — see `keyHintFor`. */
const VK_MENU = 0x12;

/** Modifiers, which a bare map key may never be: holding one is not "open map". */
const MODIFIER_CODES = new Set([
    'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
    'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'AltGraph', 'OSLeft', 'OSRight'
]);

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'OS', 'Hyper', 'Super']);

/**
 * `KeyboardEvent.code` → VK, for what is not a letter, digit or function key
 * (those are ranges, below). The OEM values are US-layout positions, which is
 * all `code` can name — so this table is only the no-`keyCode` fallback.
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

/** What a stored virtual-key code is called on screen. */
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
 * Is this a VK the app is willing to watch? The documented 1..254 (0 is "no
 * key", 0xFF a reserved placeholder), minus the modifiers and mouse buttons.
 */
function isWatchableVk(vk) {
    if (typeof vk !== 'number' || !Number.isInteger(vk)) return false;
    if (vk < 0x01 || vk > 0xFE) return false;
    // Combined Shift/Control/Menu, then left/right, then the Windows keys.
    if (vk >= 0x10 && vk <= 0x12) return false;
    if (vk >= 0xA0 && vk <= 0xA5) return false;
    if (vk === 0x5B || vk === 0x5C) return false;
    // Mouse buttons cannot be *recorded* (no KeyboardEvent), but a hand-edited
    // file could name one and `GetAsyncKeyState` would answer on a click.
    if (vk >= 0x01 && vk <= 0x06) return false;
    return true;
}

/**
 * A keydown event → the VK to watch, or null so the caller can say "this key
 * cannot be used" rather than store something that will never fire. A key with
 * a modifier held is refused too: recording `Shift + M` would store `M` while
 * the user believed they had bound the pair.
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

    // Preferred over any guess from `code`, which is wrong off a US layout.
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
 * the table as fallback. Single characters are upper-cased, a space is named.
 * @param {string} [key] `KeyboardEvent.key`
 */
function labelFor(vk, key) {
    if (typeof key === 'string' && key && key !== 'Unidentified') {
        if (key === ' ') return 'Space';
        if (key.length === 1) return key.toUpperCase();
        // Keep the table's prettier spelling (`Caps Lock`, not `CapsLock`).
        const known = vkLabel(vk);
        if (known && known.replace(/\s+/g, '').toLowerCase() === key.replace(/\s+/g, '').toLowerCase()) {
            return known;
        }
        return key;
    }
    return vkLabel(vk);
}

/**
 * What to show for a stored VK. Never translated — it names a physical key.
 * @returns {string} '' when the code is not one we watch
 */
function vkLabel(vk) {
    if (!isWatchableVk(vk)) return '';
    if (Object.prototype.hasOwnProperty.call(VK_LABEL, vk)) return VK_LABEL[vk];
    if (vk >= 0x41 && vk <= 0x5A) return String.fromCharCode(vk);               // A..Z
    if (vk >= 0x30 && vk <= 0x39) return String.fromCharCode(vk);               // 0..9
    if (vk >= 0x60 && vk <= 0x69) return 'Num ' + (vk - 0x60);
    if (vk >= 0x70 && vk <= 0x87) return 'F' + (vk - 0x6F);
    // Watchable but unnamed: the number beats an empty row in Settings.
    return '0x' + vk.toString(16).toUpperCase().padStart(2, '0');
}

/**
 * Normalise the stored `tabMarkerKey`: a file hand-edited to a modifier, a
 * mouse button or nonsense falls back to Tab.
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
