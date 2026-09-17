'use strict';

/**
 * Shared hotkey definitions and pure helpers used by both the main and the
 * renderer process. Plain CommonJS, no electron import — safe to unit test.
 */

/** @type {Object<string, {id: string, defaultAccelerator: string, description: string, action: string}>} */
const SYSTEM_HOTKEY_DEFS = {
    'toggle-map': {
        id: 'toggle-map',
        defaultAccelerator: 'CommandOrControl+H',
        description: 'Show / hide the current map',
        action: 'toggle-map'
    },
    'rotate-map': {
        id: 'rotate-map',
        defaultAccelerator: 'CommandOrControl+R',
        description: 'Rotate the map by 90 degrees',
        action: 'rotate-map'
    },
    'next-map': {
        id: 'next-map',
        defaultAccelerator: 'CommandOrControl+Right',
        description: 'Show the next map',
        action: 'next-map'
    },
    'prev-map': {
        id: 'prev-map',
        defaultAccelerator: 'CommandOrControl+Left',
        description: 'Show the previous map',
        action: 'prev-map'
    }
};

/** Map action IDs to the settings keys they persist under. */
const ACTION_TO_SETTING_KEY = {
    'toggle-map': 'hotkeyToggleMap',
    'rotate-map': 'hotkeyRotateMap',
    'next-map': 'hotkeyNextMap',
    'prev-map': 'hotkeyPrevMap'
};

/**
 * Map names, in the order the shipped Ctrl+1..Ctrl+N defaults are handed out
 * on first run. This is presentation order for the default bindings only —
 * next/prev cycling follows the catalogue's own (alphabetical) order.
 */
const DEFAULT_MAP_HOTKEY_ORDER = [
    'East Haddonfield',
    'Haddonfield Heights',
    'Orange Grove Estates',
    'Haddonfield Town Center'
];

/**
 * Build the first-run contents of `hotkeys.json`: Ctrl+1..Ctrl+N bound to the
 * shipped maps in `DEFAULT_MAP_HOTKEY_ORDER`. Pure — the id generator is
 * injected so the result is reproducible in tests.
 *
 * Numbers are handed out consecutively to the maps that are actually present,
 * so a missing map leaves no gap in the bindings.
 *
 * @param {Array<{key: string, name: string, custom: boolean}>} catalog
 * @param {() => string} makeId
 * @returns {Object<string, {id: string, mapKey: string}>} accelerator → binding
 */
function buildDefaultMapHotkeys(catalog, makeId) {
    const bindings = {};
    if (!Array.isArray(catalog) || catalog.length === 0) return bindings;

    let slot = 0;
    for (const wanted of DEFAULT_MAP_HOTKEY_ORDER) {
        const entry = catalog.find(e =>
            !e.custom && String(e.name).toLowerCase() === wanted.toLowerCase());
        if (!entry) continue;
        slot++;
        // Only the number row can be bound this way.
        if (slot > 9) break;
        bindings[`CommandOrControl+${slot}`] = {id: makeId(), mapKey: entry.key};
    }
    return bindings;
}

/**
 * Electron accelerator → human readable.
 * "CommandOrControl+Shift+P" → "Ctrl + Shift + P"
 */
function acceleratorToDisplay(accel) {
    if (!accel) return '';
    return accel
        .replace('CommandOrControl', 'Ctrl')
        .replace('Command', 'Cmd')
        .replace('Control', 'Ctrl')
        .replace(/\+/g, ' + ');
}

/*
 * ─── Key capture ───────────────────────────────────────────────────────────
 *
 * A browser `KeyboardEvent.key` is NOT an Electron accelerator key name, and
 * `globalShortcut.register` *throws* on a name it does not understand — which
 * takes down every registration after it. The browser says `ArrowRight`,
 * `" "`, `Escape`; Electron wants `Right`, `Space`, `Esc`. This translation is
 * the single place that gap is bridged; it is pure so it can be unit tested.
 */

/** Keys that only ever act as modifiers — never the "main" key of a binding. */
const MODIFIER_ONLY_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'OS', 'Hyper', 'Super']);

/** `KeyboardEvent.key` → Electron accelerator key name, where they differ. */
const KEY_TO_ACCELERATOR = {
    'ArrowUp': 'Up',
    'ArrowDown': 'Down',
    'ArrowLeft': 'Left',
    'ArrowRight': 'Right',
    ' ': 'Space',
    'Spacebar': 'Space',
    // "+" is the accelerator separator, so it has to be spelled out
    '+': 'Plus',
    'Escape': 'Esc',
    'Esc': 'Esc',
    'Enter': 'Return',
    'Tab': 'Tab',
    'Backspace': 'Backspace',
    'Delete': 'Delete',
    'Del': 'Delete',
    'Insert': 'Insert',
    'Ins': 'Insert',
    'Home': 'Home',
    'End': 'End',
    'PageUp': 'PageUp',
    'PageDown': 'PageDown',
    'CapsLock': 'Capslock',
    'NumLock': 'Numlock',
    'ScrollLock': 'Scrolllock',
    'PrintScreen': 'PrintScreen',
    'AudioVolumeUp': 'VolumeUp',
    'AudioVolumeDown': 'VolumeDown',
    'AudioVolumeMute': 'VolumeMute',
    'MediaTrackNext': 'MediaNextTrack',
    'MediaTrackPrevious': 'MediaPreviousTrack',
    'MediaStop': 'MediaStop',
    'MediaPlayPause': 'MediaPlayPause'
};

/** Punctuation Electron takes verbatim as an accelerator key. */
const ACCELERATOR_PUNCTUATION = new Set([
    '~', '!', '@', '#', '$', '%', '^', '&', '*', '(', ')',
    '-', '_', '=', '[', ']', '{', '}', '\\', '|',
    ';', ':', "'", '"', ',', '<', '.', '>', '/', '?'
]);

/**
 * Electron accelerator name for one `KeyboardEvent.key`, or null when that key
 * cannot be part of a global shortcut.
 */
function acceleratorKeyName(key) {
    if (typeof key !== 'string' || key === '') return null;
    if (MODIFIER_ONLY_KEYS.has(key)) return null;
    if (Object.prototype.hasOwnProperty.call(KEY_TO_ACCELERATOR, key)) return KEY_TO_ACCELERATOR[key];
    if (/^F([1-9]|1\d|2[0-4])$/.test(key)) return key;
    if (key.length === 1) {
        if (/[a-z]/i.test(key)) return key.toUpperCase();
        if (/[0-9]/.test(key)) return key;
        if (ACCELERATOR_PUNCTUATION.has(key)) return key;
    }
    return null;
}

/**
 * Turn a keydown into an Electron accelerator.
 *
 * At least one modifier is required: a bare `W` registers globally and would
 * swallow that key in the game as well as everywhere else.
 *
 * @param {{ctrlKey?: boolean, altKey?: boolean, shiftKey?: boolean, metaKey?: boolean, key?: string}} event
 * @returns {{status: 'ok'|'pending'|'unsupported'|'no-modifier', accelerator: string, display: string, key: string}}
 *   `pending` = only modifiers held so far, keep listening.
 */
function keyEventToAccelerator(event) {
    const e = event || {};
    const modifiers = [];
    if (e.ctrlKey) modifiers.push('CommandOrControl');
    if (e.metaKey) modifiers.push('Super');
    if (e.altKey) modifiers.push('Alt');
    if (e.shiftKey) modifiers.push('Shift');

    const key = typeof e.key === 'string' ? e.key : '';
    const prefix = modifiers.join('+');

    if (key === '' || MODIFIER_ONLY_KEYS.has(key)) {
        return {
            status: 'pending',
            accelerator: '',
            display: prefix ? acceleratorToDisplay(prefix) + ' + …' : '',
            key
        };
    }

    const name = acceleratorKeyName(key);
    if (!name) return {status: 'unsupported', accelerator: '', display: '', key};
    if (!modifiers.length) return {status: 'no-modifier', accelerator: '', display: '', key: name};

    const accelerator = modifiers.concat(name).join('+');
    return {status: 'ok', accelerator, display: acceleratorToDisplay(accelerator), key: name};
}

module.exports = {
    SYSTEM_HOTKEY_DEFS,
    ACTION_TO_SETTING_KEY,
    DEFAULT_MAP_HOTKEY_ORDER,
    MODIFIER_ONLY_KEYS,
    buildDefaultMapHotkeys,
    acceleratorToDisplay,
    acceleratorKeyName,
    keyEventToAccelerator
};
