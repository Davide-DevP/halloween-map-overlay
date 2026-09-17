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
    },
    // Not the same as toggle-map: this one also makes the auto-detector forget
    // what it last saw, so pressing Tab on the *same* map detects it again.
    'clear-map': {
        id: 'clear-map',
        defaultAccelerator: 'CommandOrControl+Shift+D',
        description: 'Clear the map and re-detect',
        action: 'clear-map'
    }
};

/** Map action IDs to the settings keys they persist under. */
const ACTION_TO_SETTING_KEY = {
    'toggle-map': 'hotkeyToggleMap',
    'rotate-map': 'hotkeyRotateMap',
    'next-map': 'hotkeyNextMap',
    'prev-map': 'hotkeyPrevMap',
    'clear-map': 'hotkeyClearMap'
};

/** Only the number row can be handed out as a default map binding. */
const MAX_DEFAULT_MAP_HOTKEYS = 9;

/**
 * Build the first-run contents of `hotkeys.json`: Ctrl+1..Ctrl+9 bound to the
 * first nine shipped maps **in catalogue order** (`buildCatalog` already sorts
 * by creator then map name, and `nextMap`/`prevMap` cycle in that same order,
 * so the numbers follow the gallery). Pure — the id generator is injected so
 * the result is reproducible in tests.
 *
 * There is deliberately no per-map list here: adding a map to `maps/` must not
 * require a code change. Numbers are handed out consecutively to whatever the
 * catalogue holds, so nothing has to be renumbered by hand either. Imported
 * (Custom) maps never get a default binding — they are the user's own and a new
 * import would otherwise silently steal a number.
 *
 * @param {Array<{key: string, name: string, custom: boolean}>} catalog
 * @param {() => string} makeId
 * @returns {Object<string, {id: string, mapKey: string}>} accelerator → binding
 */
function buildDefaultMapHotkeys(catalog, makeId) {
    const bindings = {};
    if (!Array.isArray(catalog) || catalog.length === 0) return bindings;

    let slot = 0;
    for (const entry of catalog) {
        if (!entry || entry.custom) continue;
        slot++;
        if (slot > MAX_DEFAULT_MAP_HOTKEYS) break;
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

/**
 * Every modifier token Electron's accelerator parser accepts, lower-cased
 * (the parser is case-insensitive).
 */
const ACCELERATOR_MODIFIERS = new Set([
    'command', 'cmd', 'control', 'ctrl', 'commandorcontrol', 'cmdorctrl',
    'alt', 'option', 'altgr', 'shift', 'super', 'meta'
]);

/**
 * Does this accelerator carry at least one modifier?
 *
 * Electron happily registers a bare `H` globally, which would then be
 * swallowed in the game and in every other application. `keyEventToAccelerator`
 * refuses modifier-less bindings when the user records one, but that guard
 * lives in the renderer, and with `nodeIntegration: true` the renderer is not a
 * trust boundary — the main-process IPC handlers check this too.
 *
 * @param {string} accelerator
 * @returns {boolean}
 */
function hasModifier(accelerator) {
    if (typeof accelerator !== 'string' || !accelerator) return false;
    const parts = accelerator.split('+');
    // The last part is the key itself; "+" as a key is spelled "Plus".
    return parts.slice(0, -1).some(part => ACCELERATOR_MODIFIERS.has(part.trim().toLowerCase()));
}

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
    MAX_DEFAULT_MAP_HOTKEYS,
    MODIFIER_ONLY_KEYS,
    ACCELERATOR_MODIFIERS,
    hasModifier,
    buildDefaultMapHotkeys,
    acceleratorToDisplay,
    acceleratorKeyName,
    keyEventToAccelerator
};
