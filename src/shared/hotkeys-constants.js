'use strict';

/**
 * Shared hotkey definitions and pure helpers used by both the main and the
 * renderer process. Plain CommonJS, no electron import — safe to unit test.
 */

/*
 * ─── Why every default carries Alt ──────────────────────────────────────────
 *
 * Up to 0.6.0 the defaults were plain Ctrl combinations, and every single one
 * of them was already taken by something the player is running:
 *
 * - **Ctrl is crouch** in most shooters, Halloween: The Game included, so a
 *   default that is Ctrl + anything fires while the player is crouching.
 * - Ctrl+R reloads a browser page, Ctrl+H opens its history, Ctrl+1..9 switch
 *   its tabs, Ctrl+Shift+D is a Discord shortcut, and Ctrl+arrow is word-wise
 *   caret movement in every text field on the machine. A *global* shortcut
 *   swallows the combination system-wide, so the app was taking them away from
 *   applications that were using them.
 *
 * `Ctrl+Alt+<key>` is the Windows convention for an application's own global
 * shortcuts (it is what Discord, OBS and the GPU overlays default to) and
 * nothing in the game uses it. The size steps need a fourth modifier because
 * they share the arrow keys with the opacity steps.
 *
 * Installs made before this change are moved onto the new defaults **once**,
 * and only where the user never touched the binding — see
 * `shared/hotkey-migration.js`.
 */

/**
 * `description` is the English name of the action and `descriptionKey` its
 * translation key. Both are kept: the key is what the UI and the conflict
 * messages use, the plain string is the fallback for anything that has no
 * catalogue at hand (a log line, a future headless caller) and it doubles as
 * documentation of what the action does right here in the definition.
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
    // Opacity and size from the keyboard: the overlay is adjusted mid-match,
    // when opening the settings modal means alt-tabbing out of the game.
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
    // Markers: the possible storm-cellar / gate / car / gas-can locations, on
    // the overlay and (in Tab-map mode) on the game's own map. One master
    // switch on a hotkey, because the decision "is this helping me right now?"
    // is made mid-match, when opening Settings means alt-tabbing out.
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

/*
 * ─── Bound / unbound ────────────────────────────────────────────────────────
 *
 * A system action may hold no key combination at all. Somebody who never wants
 * "Rotate map" would otherwise have to park it on *some* combination, which is
 * then swallowed system-wide — the very thing the feature is meant to avoid.
 */

/**
 * What an unbound system hotkey is stored as under its settings key.
 *
 * It has to be the empty string rather than a missing key: `core/settings.js`
 * back-fills every key that is `undefined` from `DEFAULT_SETTINGS`, so a
 * *deleted* key comes back as the shipped default on the next start. An empty
 * string is a value the back-fill leaves alone, which is what makes "I never
 * want this shortcut" survive a restart.
 */
const UNBOUND_ACCELERATOR = '';

/**
 * Does this *effective* accelerator hold no key combination?
 *
 * Whitespace counts as unbound as well: a hand-edited `" "` is not something
 * `globalShortcut.register` can parse, and treating it as a binding would put a
 * phantom entry in the conflict banner instead of simply leaving the action off.
 *
 * @param {*} accelerator
 * @returns {boolean}
 */
function isUnbound(accelerator) {
    return typeof accelerator !== 'string' || accelerator.trim() === '';
}

/**
 * The accelerator one system action is actually on: what is stored, the shipped
 * default when nothing is stored, and nothing at all when the user unbound it.
 *
 * That three-way distinction is the whole reason this helper exists. The old
 * `stored || def.defaultAccelerator` cannot tell "deliberately unbound" (`''`)
 * from "fresh install" (`undefined`) and turns the first back into the default
 * — in main at registration time *and* in the renderer's table. Both call this
 * instead, so the two can never disagree about what an action is bound to.
 *
 * @param {*} stored value held under the action's `ACTION_TO_SETTING_KEY`
 * @param {string} defaultAccelerator the definition's own default
 * @returns {string} an accelerator, or `UNBOUND_ACCELERATOR`
 */
function resolveSystemAccelerator(stored, defaultAccelerator) {
    // Only a string can carry the user's intent. Anything else (a missing key,
    // a null from a hand-edited settings file) is an absence, not a choice.
    if (typeof stored !== 'string') return defaultAccelerator || UNBOUND_ACCELERATOR;
    const trimmed = stored.trim();
    return trimmed === '' ? UNBOUND_ACCELERATOR : trimmed;
}

/*
 * ─── Overlay step hotkeys ───────────────────────────────────────────────────
 *
 * The bounds are shared: `src/js/maps.js` applies them when a hotkey fires and
 * `src/index.html` uses the same numbers for the Settings sliders, so the two
 * can never drift apart.
 */
const OPACITY_STEP = 0.1;
const OPACITY_MIN = 0.1;
const OPACITY_MAX = 1.0;
const SIZE_STEP = 25;
const SIZE_MIN = 50;
const SIZE_MAX = 800;

/**
 * Nudge the overlay opacity by whole tenths.
 *
 * 0.1 is not representable in binary floating point, so repeated addition walks
 * off the grid (0.7 + 0.1 = 0.7999999999999999) and the value stops matching a
 * slider step. Rounding to one decimal after every step keeps it on 0.1..1.0.
 *
 * @param {number} current stored opacity (anything unusable falls back to 0.5)
 * @param {number} delta   signed multiple of OPACITY_STEP
 * @returns {number}
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
 * @returns {number}
 */
function stepSize(current, delta) {
    const parsed = parseInt(current, 10);
    const base = Number.isFinite(parsed) ? parsed : 250;
    return Math.min(SIZE_MAX, Math.max(SIZE_MIN, base + delta));
}

/** Only the number row can be handed out as a default map binding. */
const MAX_DEFAULT_MAP_HOTKEYS = 9;

/**
 * Modifiers the first-run per-map bindings sit on, the number itself appended.
 *
 * Ctrl+1..Ctrl+9 (up to 0.6.0) are the browser's tab switchers, so the app was
 * taking nine of the most-used shortcuts on the machine away system-wide. One
 * constant because the migration in `shared/hotkey-migration.js` has to know
 * the same prefix.
 */
const MAP_HOTKEY_PREFIX = 'CommandOrControl+Alt+';

/**
 * Build the first-run contents of `hotkeys.json`: Ctrl+Alt+1..Ctrl+Alt+9 bound
 * to the first nine shipped maps **in catalogue order** (`buildCatalog` sorts
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
        bindings[`${MAP_HOTKEY_PREFIX}${slot}`] = {id: makeId(), mapKey: entry.key};
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
