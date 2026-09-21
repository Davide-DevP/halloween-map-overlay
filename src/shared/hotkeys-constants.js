'use strict';

/**
 * Shared hotkey definitions and pure helpers used by both the main and the
 * renderer process. Pure tier — no electron import. Why every default carries
 * Alt, and the migration onto them: docs/agents/hotkeys.md.
 */

/**
 * `descriptionKey` is what the UI and the conflict messages use; the plain
 * English `description` is the fallback for anything with no catalogue at hand
 * (a log line, a headless caller).
 *
 * @type {Object<string, {id: string, defaultAccelerator: string, description: string, descriptionKey: string, action: string}>}
 */
const SYSTEM_HOTKEY_DEFS = {
    'toggle-map': {
        id: 'toggle-map',
        defaultAccelerator: 'CommandOrControl+Alt+H',
        description: 'Show / hide the current map',
        descriptionKey: 'hotkeys.action.toggle-map',
        action: 'toggle-map'
    },
    'rotate-map': {
        id: 'rotate-map',
        defaultAccelerator: 'CommandOrControl+Alt+R',
        description: 'Rotate the map by 90 degrees',
        descriptionKey: 'hotkeys.action.rotate-map',
        action: 'rotate-map'
    },
    'next-map': {
        id: 'next-map',
        defaultAccelerator: 'CommandOrControl+Alt+Right',
        description: 'Show the next map',
        descriptionKey: 'hotkeys.action.next-map',
        action: 'next-map'
    },
    'prev-map': {
        id: 'prev-map',
        defaultAccelerator: 'CommandOrControl+Alt+Left',
        description: 'Show the previous map',
        descriptionKey: 'hotkeys.action.prev-map',
        action: 'prev-map'
    },
    // Not the same as toggle-map: this one also makes the auto-detector forget
    // what it last saw, so pressing Tab on the *same* map detects it again.
    'clear-map': {
        id: 'clear-map',
        defaultAccelerator: 'CommandOrControl+Alt+D',
        description: 'Clear the map and re-detect',
        descriptionKey: 'hotkeys.action.clear-map',
        action: 'clear-map'
    },
    'opacity-up': {
        id: 'opacity-up',
        defaultAccelerator: 'CommandOrControl+Alt+Up',
        description: 'Make the overlay more opaque',
        descriptionKey: 'hotkeys.action.opacity-up',
        action: 'opacity-up'
    },
    'opacity-down': {
        id: 'opacity-down',
        defaultAccelerator: 'CommandOrControl+Alt+Down',
        description: 'Make the overlay more transparent',
        descriptionKey: 'hotkeys.action.opacity-down',
        action: 'opacity-down'
    },
    'size-up': {
        id: 'size-up',
        defaultAccelerator: 'CommandOrControl+Alt+Shift+Up',
        description: 'Make the overlay bigger',
        descriptionKey: 'hotkeys.action.size-up',
        action: 'size-up'
    },
    'size-down': {
        id: 'size-down',
        defaultAccelerator: 'CommandOrControl+Alt+Shift+Down',
        description: 'Make the overlay smaller',
        descriptionKey: 'hotkeys.action.size-down',
        action: 'size-down'
    },
    'toggle-markers': {
        id: 'toggle-markers',
        defaultAccelerator: 'CommandOrControl+Alt+M',
        description: 'Show / hide the map markers',
        descriptionKey: 'hotkeys.action.toggle-markers',
        action: 'toggle-markers'
    }
};

/** Map action IDs to the settings keys they persist under. */
const ACTION_TO_SETTING_KEY = {
    'toggle-map': 'hotkeyToggleMap',
    'rotate-map': 'hotkeyRotateMap',
    'next-map': 'hotkeyNextMap',
    'prev-map': 'hotkeyPrevMap',
    'clear-map': 'hotkeyClearMap',
    'opacity-up': 'hotkeyOpacityUp',
    'opacity-down': 'hotkeyOpacityDown',
    'size-up': 'hotkeySizeUp',
    'size-down': 'hotkeySizeDown',
    'toggle-markers': 'hotkeyToggleMarkers'
};

/**
 * Unbound is the empty string, never a missing key: the back-fill in
 * `core/settings.js` would hand the default back on the next start.
 */
const UNBOUND_ACCELERATOR = '';

/**
 * Holds no key combination? Whitespace counts as unbound, or a hand-edited
 * `" "` becomes a phantom entry in the conflict banner.
 */
function isUnbound(accelerator) {
    return typeof accelerator !== 'string' || accelerator.trim() === '';
}

/**
 * What is stored, the shipped default when nothing is, and nothing at all when
 * the user unbound it — a three-way distinction `stored || default` cannot
 * make. Main and the renderer's table both call it, so the two cannot disagree.
 * @param {*} stored value held under the action's `ACTION_TO_SETTING_KEY`
 * @returns {string} an accelerator, or `UNBOUND_ACCELERATOR`
 */
function resolveSystemAccelerator(stored, defaultAccelerator) {
    // Only a string carries intent; a missing key or a null is an absence.
    if (typeof stored !== 'string') return defaultAccelerator || UNBOUND_ACCELERATOR;
    const trimmed = stored.trim();
    return trimmed === '' ? UNBOUND_ACCELERATOR : trimmed;
}

// The clamps are also the Settings sliders' `min`/`max` in `src/index.html`;
// keep the two in step.
const OPACITY_STEP = 0.1;
const OPACITY_MIN = 0.1;
const OPACITY_MAX = 1.0;
const SIZE_STEP = 25;
const SIZE_MIN = 50;
const SIZE_MAX = 800;

/**
 * Nudge the overlay opacity by whole tenths, rounded to one decimal: 0.1 is not
 * binary-representable, so repeated addition walks off the slider's own grid.
 * @param {number} current stored opacity (anything unusable falls back to 0.5)
 * @param {number} delta   signed multiple of OPACITY_STEP
 */
function stepOpacity(current, delta) {
    const base = Number.isFinite(parseFloat(current)) ? parseFloat(current) : 0.5;
    const next = Math.round((base + delta) * 10) / 10;
    return Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, next));
}

/**
 * Nudge the overlay width in whole pixels, clamped to the slider's own range.
 * @param {number} current stored size (anything unusable falls back to 250)
 * @param {number} delta   signed multiple of SIZE_STEP
 */
function stepSize(current, delta) {
    const parsed = parseInt(current, 10);
    const base = Number.isFinite(parsed) ? parsed : 250;
    return Math.min(SIZE_MAX, Math.max(SIZE_MIN, base + delta));
}

/** Only the number row can be handed out as a default map binding. */
const MAX_DEFAULT_MAP_HOTKEYS = 9;

/** One constant, because `shared/hotkey-migration.js` needs the same prefix. */
const MAP_HOTKEY_PREFIX = 'CommandOrControl+Alt+';

/**
 * First-run `hotkeys.json`: Ctrl+Alt+1..9 to the first nine **shipped** maps in
 * catalogue order, so a new map gets its number without a code change and an
 * imported one cannot steal it. The id generator is injected for the tests.
 * Why: docs/agents/hotkeys.md § Defaults and the migration onto them.
 * @param {Array<{key: string, name: string, custom: boolean}>} catalog
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
        bindings[`${MAP_HOTKEY_PREFIX}${slot}`] = {id: makeId(), mapKey: entry.key};
    }
    return bindings;
}

/** Electron accelerator → human readable: `Ctrl+Shift+P` → `Ctrl + Shift + P`. */
function acceleratorToDisplay(accel) {
    if (!accel) return '';
    return accel
        .replace('CommandOrControl', 'Ctrl')
        .replace('Command', 'Cmd')
        .replace('Control', 'Ctrl')
        .replace(/\+/g, ' + ');
}

/*
 * Key capture. A browser `KeyboardEvent.key` is NOT an Electron accelerator
 * name, and `globalShortcut.register` *throws* on one it cannot parse; this is
 * the one place that gap is bridged.
 * Why: docs/agents/hotkeys.md § Priority, conflicts and registration.
 */

/** Keys that only ever act as modifiers — never the "main" key of a binding. */
const MODIFIER_ONLY_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'OS', 'Hyper', 'Super']);

/** Every modifier token Electron's parser accepts; it is case-insensitive. */
const ACCELERATOR_MODIFIERS = new Set([
    'command', 'cmd', 'control', 'ctrl', 'commandorcontrol', 'cmdorctrl',
    'alt', 'option', 'altgr', 'shift', 'super', 'meta'
]);

/**
 * At least one modifier: Electron registers a bare `H` globally, and with
 * `nodeIntegration: true` the renderer's own guard is not a trust boundary, so
 * the main-process IPC handlers check this too.
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
    // "+" is the accelerator separator, so it has to be spelled out.
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

/** Or null when that key cannot be part of a global shortcut. */
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
 * Turn a keydown into an Electron accelerator; at least one modifier is
 * required — see `hasModifier`.
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
    UNBOUND_ACCELERATOR,
    MAX_DEFAULT_MAP_HOTKEYS,
    MAP_HOTKEY_PREFIX,
    MODIFIER_ONLY_KEYS,
    ACCELERATOR_MODIFIERS,
    OPACITY_STEP,
    OPACITY_MIN,
    OPACITY_MAX,
    SIZE_STEP,
    SIZE_MIN,
    SIZE_MAX,
    stepOpacity,
    stepSize,
    hasModifier,
    isUnbound,
    resolveSystemAccelerator,
    buildDefaultMapHotkeys,
    acceleratorToDisplay,
    acceleratorKeyName,
    keyEventToAccelerator
};
