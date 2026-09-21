'use strict';

/**
 * PURE hotkey *decisions*; imports nothing but `hotkeys-constants.js`. Every
 * comparison goes through `normalizeAccelerator`, but **what is stored on disk
 * is never rewritten to normalise it**.
 *
 * That normalisation mirrors Electron's real parser, not the documentation —
 * transcribed from the pinned version's own source (v40.10.6),
 * `shell/browser/ui/accelerator_util.cc` (`StringToAccelerator`) and
 * `shell/common/keyboard_util.cc` (`KeyboardCodeFromStr` /
 * `KeyboardCodeFromCharCode` / `KeyboardCodeFromKeyIdentifier`). Keep that
 * pointer, and do not "simplify" it towards the documented behaviour.
 * Why, and the five counter-intuitive findings: docs/agents/hotkeys.md.
 */

const {
    isUnbound,
    resolveSystemAccelerator,
    SYSTEM_HOTKEY_DEFS,
    MAP_HOTKEY_PREFIX,
    MAX_DEFAULT_MAP_HOTKEYS
} = require('./hotkeys-constants');

/**
 * Modifier token (lower-cased) → the canonical token. `Cmd`/`Meta`/`Super` are
 * one token but **never** folded into Control, and `process.platform` is
 * deliberately not consulted.
 */
const MODIFIER_ALIASES = {
    'commandorcontrol': 'CommandOrControl',
    'cmdorctrl': 'CommandOrControl',
    'control': 'CommandOrControl',
    'ctrl': 'CommandOrControl',
    'command': 'Super',
    'cmd': 'Super',
    'alt': 'Alt',
    'option': 'Alt',
    'altgr': 'AltGr',
    'shift': 'Shift',
    'super': 'Super',
    'meta': 'Super'
};

/** Electron ignores modifier order, so a canonical form has to impose one. */
const MODIFIER_ORDER = ['CommandOrControl', 'Super', 'AltGr', 'Alt', 'Shift'];

/**
 * Shifted token → the unshifted key it really is, plus the Shift it brings.
 * Transcribed from `KeyboardCodeFromCharCode`; reachable from the UI.
 */
const SHIFTED_KEYS = {
    '!': '1',
    '@': '2',
    '#': '3',
    '$': '4',
    '%': '5',
    '^': '6',
    '&': '7',
    '*': '8',
    '(': '9',
    ')': '0',
    '_': '-',
    '+': '=',
    'plus': '=',
    ':': ';',
    '"': "'",
    '<': ',',
    '>': '.',
    '?': '/',
    '{': '[',
    '}': ']',
    '|': '\\',
    '~': '`'
};

/**
 * Key names Electron accepts, lower-cased → this app's canonical spelling.
 * `Escape`→`Esc` and `Enter`→`Return` fold, or `Ctrl+Esc` and `Ctrl+Escape`
 * would not collide. `Plus` belongs to `SHIFTED_KEYS`, being `Shift` + `=`.
 */
const KEY_ALIASES = {
    'space': 'Space',
    'tab': 'Tab',
    'capslock': 'Capslock',
    'numlock': 'Numlock',
    'scrolllock': 'Scrolllock',
    'backspace': 'Backspace',
    'delete': 'Delete',
    'insert': 'Insert',
    'return': 'Return',
    'enter': 'Return',
    'up': 'Up',
    'down': 'Down',
    'left': 'Left',
    'right': 'Right',
    'home': 'Home',
    'end': 'End',
    'pageup': 'PageUp',
    'pagedown': 'PageDown',
    'escape': 'Esc',
    'esc': 'Esc',
    'volumeup': 'VolumeUp',
    'volumedown': 'VolumeDown',
    'volumemute': 'VolumeMute',
    'medianexttrack': 'MediaNextTrack',
    'mediaprevioustrack': 'MediaPreviousTrack',
    'mediastop': 'MediaStop',
    'mediaplaypause': 'MediaPlayPause',
    'printscreen': 'PrintScreen',
    'numdec': 'numdec',
    'numadd': 'numadd',
    'numsub': 'numsub',
    'nummult': 'nummult',
    'numdiv': 'numdiv'
};

/** Punctuation Electron takes verbatim as a key, with no implicit Shift. */
const PUNCTUATION_KEYS = new Set([
    '-', '=', '[', ']', '\\', ';', "'", ',', '.', '/', '`'
]);

/**
 * @returns {?{key: string, shift: boolean}} `shift` is Electron's implicit
 *   `shifted_char` → `EF_SHIFT_DOWN`; null when the token is not a key at all
 */
function canonicalKeyName(token) {
    const lower = token.toLowerCase();
    // Shifted punctuation first, or the single-character branch takes `!` at
    // face value.
    if (Object.prototype.hasOwnProperty.call(SHIFTED_KEYS, token)) {
        return {key: SHIFTED_KEYS[token], shift: true};
    }
    if (Object.prototype.hasOwnProperty.call(SHIFTED_KEYS, lower)) {
        return {key: SHIFTED_KEYS[lower], shift: true};
    }
    if (Object.prototype.hasOwnProperty.call(KEY_ALIASES, lower)) {
        return {key: KEY_ALIASES[lower], shift: false};
    }
    if (/^num[0-9]$/.test(lower)) return {key: lower, shift: false};
    if (/^f([1-9]|1\d|2[0-4])$/.test(lower)) return {key: 'F' + lower.slice(1), shift: false};
    if (token.length === 1) {
        if (/[a-z]/i.test(token)) return {key: token.toUpperCase(), shift: false};
        if (/[0-9]/.test(token)) return {key: token, shift: false};
        if (PUNCTUATION_KEYS.has(token)) return {key: token, shift: false};
    }
    return null;
}

/**
 * One spelling for every way Electron accepts the same combination, so
 * `CommandOrControl+Shift+1` is the form of `Ctrl+!` *and* of `shift+ctrl+1`.
 * @returns {?string} null for anything Electron's own parser would refuse: not
 *   ASCII, or no key token at all (`Ctrl+Shift`, `Ctrl++`, `+`)
 */
function normalizeAccelerator(accelerator) {
    if (typeof accelerator !== 'string') return null;
    // eslint-disable-next-line no-control-regex
    if (/[^\x00-\x7F]/.test(accelerator)) return null;  // Electron: ASCII only

    // `SPLIT_WANT_NONEMPTY` + `TRIM_WHITESPACE`: empty segments vanish, so
    // `Ctrl++R` is `Ctrl+R` and `Ctrl++` has no key at all.
    const tokens = accelerator.split('+').map(part => part.trim()).filter(part => part !== '');
    if (!tokens.length) return null;

    const modifiers = [];
    const addModifier = (name) => {
        if (!modifiers.includes(name)) modifiers.push(name);
    };
    // Electron's loop: a modifier ORs its flag, **anything else** becomes the
    // key, so the last non-modifier token wins. Replicated, not rejected: a
    // stored `Ctrl+A+B` really does register Ctrl+B.
    let keyToken = null;
    for (const token of tokens) {
        const modifier = MODIFIER_ALIASES[token.toLowerCase()];
        if (modifier) addModifier(modifier);
        else keyToken = token;
    }
    if (keyToken === null) return null;

    const resolved = canonicalKeyName(keyToken);
    if (!resolved) return null;
    // `shifted_char` sets EF_SHIFT_DOWN whether or not Shift was also typed.
    if (resolved.shift) addModifier('Shift');

    modifiers.sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b));
    return modifiers.concat(resolved.key).join('+');
}

/**
 * The canonical form, falling back to the lower-cased original for something
 * Electron cannot parse, so it still matches itself.
 * @returns {string} `''` for anything unbound, which never matches anything
 */
function acceleratorKey(accelerator) {
    if (isUnbound(accelerator)) return '';
    return normalizeAccelerator(accelerator) || accelerator.trim().toLowerCase();
}

/** Two unbound values are **not** the same: nothing conflicts with nothing. */
function sameAccelerator(a, b) {
    const left = acceleratorKey(a);
    return left !== '' && left === acceleratorKey(b);
}

/**
 * Everything asking "is this taken?" goes through here: `register('')` throws,
 * and an `''` in a "taken" set collides with every other unbound action.
 * @returns {Array<[string, string]>} `[actionId, accelerator]`
 */
function boundEntries(effective) {
    if (!effective || typeof effective !== 'object') return [];
    return Object.entries(effective).filter(([, accelerator]) => !isUnbound(accelerator));
}

/**
 * @param {Object<string, string>} effective actionId → accelerator (`''` = unbound)
 * @param {?string} [exceptActionId] the action being re-bound or reset, which
 *   must not be found to conflict with itself
 * @returns {?string} the colliding system action id, or null
 */
function findSystemConflict(effective, accelerator, exceptActionId = null) {
    if (isUnbound(accelerator)) return null;
    for (const [actionId, held] of boundEntries(effective)) {
        if (actionId === exceptActionId) continue;
        if (sameAccelerator(held, accelerator)) return actionId;
    }
    return null;
}

/**
 * @returns {?string} the `hotkeys.json` entry that already holds this
 *   accelerator, in its **stored** spelling so a message can name what is in
 *   the file; null if there is none
 */
function findMapConflict(mapHotkeys, accelerator) {
    if (isUnbound(accelerator) || !mapHotkeys || typeof mapHotkeys !== 'object') return null;
    for (const stored of Object.keys(mapHotkeys)) {
        if (sameAccelerator(stored, accelerator)) return stored;
    }
    return null;
}

/**
 * The shipped default is not guaranteed free. Why: the doc § Unbinding, rule 3.
 * @param {{effective: Object<string, string>, mapHotkeys: Object, actionId: string, defaultAccelerator: string}} args
 * @returns {{ok: true}|{ok: false, kind: 'system', actionId: string}|{ok: false, kind: 'map', accelerator: string}}
 */
function canResetToDefault({effective, mapHotkeys, actionId, defaultAccelerator}) {
    const system = findSystemConflict(effective, defaultAccelerator, actionId);
    if (system) return {ok: false, kind: 'system', actionId: system};
    const map = findMapConflict(mapHotkeys, defaultAccelerator);
    if (map) return {ok: false, kind: 'map', accelerator: map};
    return {ok: true};
}

/**
 * The Hotkeys tab's System rows, split into the main table and the collapsed
 * *More keys* fold. **One** rule decides the fold, `defaultUnbound && !bound`:
 * a key the user actually holds is never hidden behind one. `isDefault` lives
 * here and not in the renderer because `sameAccelerator` says nothing equals
 * unbound, so a plain comparison leaves *Reset* offering a combination that
 * does not exist. Why: docs/agents/hotkeys.md § Defaults / § Unbinding.
 * @param {Object} [defs] the definition table; injected only by the tests
 */
function systemHotkeyRows(systemHotkeys, defs) {
    const stored = systemHotkeys && typeof systemHotkeys === 'object' ? systemHotkeys : {};
    const table = defs && typeof defs === 'object' ? defs : SYSTEM_HOTKEY_DEFS;
    const main = [];
    const more = [];
    for (const [actionId, def] of Object.entries(table)) {
        if (!def) continue;
        const accelerator = resolveSystemAccelerator(stored[actionId], def.defaultAccelerator);
        const bound = !isUnbound(accelerator);
        const defaultUnbound = isUnbound(def.defaultAccelerator);
        const row = {
            actionId,
            descriptionKey: def.descriptionKey,
            description: def.description,
            accelerator: bound ? accelerator : '',
            bound,
            isDefault: defaultUnbound ? !bound : sameAccelerator(accelerator, def.defaultAccelerator)
        };
        (defaultUnbound && !bound ? more : main).push(row);
    }
    return {main, more};
}

/**
 * The `hotkeys.json` entries a **system** hotkey shadows; they register second,
 * so they can never fire.
 * @returns {Array<{accelerator: string, actionId: string}>} stored spellings
 */
function shadowedMapBindings(effective, mapHotkeys) {
    if (!mapHotkeys || typeof mapHotkeys !== 'object') return [];
    const shadowed = [];
    for (const stored of Object.keys(mapHotkeys)) {
        const actionId = findSystemConflict(effective, stored);
        if (actionId) shadowed.push({accelerator: stored, actionId});
    }
    return shadowed;
}

/**
 * `hotkeys.json` keys that are different spellings of one combination: it can
 * hold `Ctrl+1` **and** `CommandOrControl+1`.
 * @returns {Array<{accelerator: string, first: string}>} the losing entries in
 *   file order, each with the entry that already claimed the combination
 */
function duplicateMapBindings(mapHotkeys) {
    if (!mapHotkeys || typeof mapHotkeys !== 'object') return [];
    const seen = new Map();
    const duplicates = [];
    for (const stored of Object.keys(mapHotkeys)) {
        const key = acceleratorKey(stored);
        if (key === '') continue;
        if (seen.has(key)) duplicates.push({accelerator: stored, first: seen.get(key)});
        else seen.set(key, stored);
    }
    return duplicates;
}

/**
 * Every *bound* system hotkey plus every `hotkeys.json` entry, as comparison
 * keys; `rejectIfUnregisterable` treats a member as already proven.
 */
function ownAcceleratorKeys(effective, mapHotkeys) {
    const held = new Set();
    for (const [, accelerator] of boundEntries(effective)) held.add(acceleratorKey(accelerator));
    if (mapHotkeys && typeof mapHotkeys === 'object') {
        for (const stored of Object.keys(mapHotkeys)) {
            const key = acceleratorKey(stored);
            if (key !== '') held.add(key);
        }
    }
    held.delete('');
    return held;
}

/**
 * Should a map a **map pack** just added get a default `Ctrl+Alt+N`, and which?
 * Four rules, each with its reason in docs/agents/map-packs.md.
 * @param {{mapKey: string, fileExists: boolean, mapHotkeys: Object,
 *          systemHotkeys: Object<string, string>,
 *          offeredKeys?: Array<string>, max?: number}} args
 * @returns {{accelerator: ?string, reason: string, remember: boolean}}
 *   `remember`: record this map as offered? False only for the transient "no
 *   file yet" case, so a race is not remembered as a decision.
 */
function planPackMapHotkey({mapKey, fileExists, mapHotkeys, systemHotkeys, offeredKeys, max} = {}) {
    const no = (reason, remember) => ({accelerator: null, reason, remember: !!remember});
    if (typeof mapKey !== 'string' || !mapKey) return no('no-map-key');
    if (!fileExists) return no('no-file');

    const stored = (mapHotkeys && typeof mapHotkeys === 'object') ? mapHotkeys : {};
    const entries = Object.keys(stored);
    if (!entries.length) return no('cleared', true);
    if ((offeredKeys || []).includes(mapKey)) return no('already-offered');
    for (const accelerator of entries) {
        const binding = stored[accelerator];
        if (binding && binding.mapKey === mapKey) return no('already-bound', true);
    }

    const taken = ownAcceleratorKeys(systemHotkeys, stored);
    const limit = Number.isInteger(max) && max > 0 ? max : MAX_DEFAULT_MAP_HOTKEYS;
    for (let n = 1; n <= limit; n++) {
        const candidate = `${MAP_HOTKEY_PREFIX}${n}`;
        if (taken.has(acceleratorKey(candidate))) continue;
        return {accelerator: candidate, reason: 'assign', remember: true};
    }
    return no('no-free-slot', true);
}

// What the foreground window is, as far as the hotkeys care. `unknown` = the
// window scan threw or reported no focused window.
const FOREGROUND_GAME = 'game';
const FOREGROUND_OWN = 'own';
const FOREGROUND_OTHER = 'other';
const FOREGROUND_UNKNOWN = 'unknown';

/**
 * Our own windows count as "in front", and an unknown foreground **registers**
 * rather than failing closed. Why: the doc § Only while the game is in front.
 * @param {{gameOnly: *, foreground: string, suspended: *}} state
 */
function shouldHotkeysBeActive({gameOnly, foreground, suspended} = {}) {
    if (suspended) return false;
    // Only an explicit `false` is off, like every default-on switch here.
    if (gameOnly === false) return true;
    return foreground === FOREGROUND_GAME
        || foreground === FOREGROUND_OWN
        || foreground === FOREGROUND_UNKNOWN;
}

/**
 * The foreground verdict composed with the bind dialog's suspension, kept
 * separate because the two have different owners; `shouldHotkeysBeActive` takes
 * `suspended` too and must agree with this.
 */
function hotkeysShouldBeRegistered({foregroundAllows, suspended} = {}) {
    if (suspended) return false;
    return !!foregroundAllows;
}

module.exports = {
    MODIFIER_ALIASES,
    MODIFIER_ORDER,
    KEY_ALIASES,
    SHIFTED_KEYS,
    normalizeAccelerator,
    acceleratorKey,
    sameAccelerator,
    boundEntries,
    findSystemConflict,
    findMapConflict,
    canResetToDefault,
    systemHotkeyRows,
    shadowedMapBindings,
    duplicateMapBindings,
    ownAcceleratorKeys,
    planPackMapHotkey,
    FOREGROUND_GAME,
    FOREGROUND_OWN,
    FOREGROUND_OTHER,
    FOREGROUND_UNKNOWN,
    shouldHotkeysBeActive,
    hotkeysShouldBeRegistered
};
