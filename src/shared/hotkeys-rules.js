'use strict';

/**
 * PURE hotkey *decisions*. Imports nothing but `hotkeys-constants.js`.
 *
 * `core/hotkeys.js` imports electron, so everything it decided itself was
 * untestable: which entries of the effective system map are bound, whether an
 * accelerator collides with one of them, whether an action may be reset to its
 * default, which `hotkeys.json` entries a system hotkey shadows. Those rules
 * live here now and `core/hotkeys.js` is a thin caller around them.
 *
 * The other half of this file is `normalizeAccelerator`. Every comparison in
 * the app goes through it, because up to 0.6.0 they were raw string equality:
 * a `hotkeys.json` hand-edited to `Ctrl+R` did not collide with the
 * `CommandOrControl+R` a system action held, `Shift+Ctrl+R` did not collide
 * with `Ctrl+Shift+R`, and `ctrl+r` collided with nothing at all — while
 * Electron registers all four as the same combination, so the second
 * registration failed and produced a phantom "taken by another application".
 *
 * **What is stored on disk is never rewritten just to normalise it.** The
 * comparison is normalised; the registration uses the stored spelling, which
 * Electron parses perfectly well. A migration that rewrote everybody's
 * `hotkeys.json` to canonical spelling would be a lot of risk for no
 * behaviour.
 */

const {isUnbound, MAP_HOTKEY_PREFIX, MAX_DEFAULT_MAP_HOTKEYS} = require('./hotkeys-constants');

/*
 * ─── Accelerator normalisation ──────────────────────────────────────────────
 *
 * This mirrors Electron's real parser, not the documentation. Read from the
 * pinned version's own source (electron v40.10.6):
 *
 * - `shell/browser/ui/accelerator_util.cc`, `StringToAccelerator`
 * - `shell/common/keyboard_util.cc`, `KeyboardCodeFromStr` /
 *   `KeyboardCodeFromCharCode` / `KeyboardCodeFromKeyIdentifier`
 *
 * What that code actually does, and every point of it matters here:
 *
 * 1. Non-ASCII is rejected outright.
 * 2. It splits on `+` with `base::SPLIT_WANT_NONEMPTY` and `TRIM_WHITESPACE`,
 *    so **empty segments are dropped, not errors**: `Ctrl++R` is `Ctrl+R`,
 *    `+R` is `R`, and `Ctrl++` is just `Ctrl` — which has no key and is
 *    therefore invalid.
 * 3. It loops over every token. A token that resolves to a modifier keycode
 *    adds its flag; **anything else overwrites the key**. So several
 *    non-modifier tokens are legal and the *last* one wins (`Ctrl+A+B` is
 *    `Ctrl+B`), and an unrecognised token is only fatal if nothing valid
 *    follows it (`Ctrl+Nonsense+A` is `Ctrl+A`).
 * 4. `cmd`, `command`, `meta` and `super` all resolve to `VKEY_COMMAND` — one
 *    single modifier. `ctrl` and `control` resolve to `VKEY_CONTROL`, and
 *    `cmdorctrl`/`commandorcontrol` to `VKEY_COMMAND` on macOS and
 *    `VKEY_CONTROL` everywhere else.
 * 5. A key token may carry an **implicit Shift**: `KeyboardCodeFromCharCode`
 *    returns a `shifted_char` for the shifted US punctuation, and
 *    `StringToAccelerator` then ORs in `EF_SHIFT_DOWN`. So `Ctrl+!` *is*
 *    `Ctrl+Shift+1`, and `Ctrl+Plus` *is* `Ctrl+Shift+=`.
 */

/**
 * Modifier token (lower-cased) → the canonical token this app compares with.
 *
 * `Cmd`/`Command`/`Meta`/`Super` are one token because Electron resolves all
 * four to `VKEY_COMMAND` → `EF_COMMAND_DOWN` (on Windows, the Win key). They
 * are still **never** folded into Control: `cmdorctrl` is `VKEY_CONTROL` off
 * macOS, so `Cmd+R` and `Ctrl+R` really are different accelerators here.
 *
 * (On macOS `cmdorctrl` would join this group instead. This app is packaged
 * for Windows and runs on Linux; `process.platform` is deliberately not
 * consulted, because the *stored* value has to mean the same thing in a
 * settings file whatever machine reads it.)
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

/**
 * The order canonical modifiers are printed in. Electron does not care about
 * the order it is given, so `Shift+Ctrl+R` and `Ctrl+Shift+R` are the same
 * binding — which means a canonical form has to impose one.
 */
const MODIFIER_ORDER = ['CommandOrControl', 'Super', 'AltGr', 'Alt', 'Shift'];

/**
 * Shifted key token → the unshifted key it really is, plus the Shift it brings.
 *
 * Transcribed from `KeyboardCodeFromCharCode` in `shell/common/keyboard_util.cc`
 * — every `case` there whose second tuple element is set. `!` is `{VKEY_1,
 * '!'}`, i.e. the `1` key with Shift; `plus` is `{VKEY_OEM_PLUS, '+'}`, i.e.
 * the `=` key with Shift.
 *
 * This is **reachable from the UI**, which is why it is not a curiosity:
 * recording Ctrl+Shift+1 on a US layout gives `KeyboardEvent.key === '!'`, so
 * `keyEventToAccelerator` stores `CommandOrControl+Shift+!` — and without this
 * table that would not be recognised as the same binding as a stored
 * `CommandOrControl+Shift+1`, while Electron registers one and the same hotkey
 * for both.
 *
 * The character→keycode mapping is a **US layout** one, and it is hard-coded
 * that way inside Electron: the accelerator's identity therefore follows this
 * table on every layout, even though which physical key produces `!` does not.
 * So folding by this table is exactly what Electron does, not an approximation
 * of it.
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
 * Key names Electron accepts, lower-cased → the spelling this app canonicalises
 * to. Two pairs are genuine aliases of one physical key and fold together, or
 * `Ctrl+Esc` and `Ctrl+Escape` would not collide: `Escape`→`Esc` and
 * `Enter`→`Return` (which is also what `keyEventToAccelerator` emits).
 * `Plus` is absent on purpose — it is in `SHIFTED_KEYS`, being `Shift` + `=`.
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
 * Resolve one key token the way `KeyboardCodeFromStr` does.
 *
 * @param {string} token
 * @returns {?{key: string, shift: boolean}} `shift` is Electron's implicit
 *   `shifted_char` → `EF_SHIFT_DOWN`; null when the token is not a key at all.
 */
function canonicalKeyName(token) {
    const lower = token.toLowerCase();
    // Shifted punctuation first: it is really another key plus Shift, and the
    // single-character branch below would otherwise take `!` at face value.
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
 * One canonical spelling for every way Electron would accept the same key
 * combination: modifier aliases folded, duplicate modifiers dropped, modifiers
 * in a fixed order, an implicit Shift made explicit, the key in canonical case.
 *
 * `CommandOrControl+Alt+Shift+Up` is the canonical form of `Ctrl+Alt+Shift+Up`,
 * `shift+alt+ctrl+up`, `CmdOrCtrl+Option+Shift+UP` and
 * `Control+Alt+Shift+Up`; `CommandOrControl+Shift+1` is the canonical form of
 * `Ctrl+!` *and* of `Ctrl+Shift+1`.
 *
 * @param {*} accelerator
 * @returns {?string} null for anything Electron's own parser would refuse: not
 *   ASCII, or no key token at all (`Ctrl+Shift`, `Ctrl++`, `+`).
 */
function normalizeAccelerator(accelerator) {
    if (typeof accelerator !== 'string') return null;
    // eslint-disable-next-line no-control-regex
    if (/[^\x00-\x7F]/.test(accelerator)) return null;  // Electron: ASCII only

    // `SPLIT_WANT_NONEMPTY` + `TRIM_WHITESPACE`: empty segments vanish, so
    // `Ctrl++R` is `Ctrl+R` and `Ctrl++` is a lone `Ctrl` with no key.
    const tokens = accelerator.split('+').map(part => part.trim()).filter(part => part !== '');
    if (!tokens.length) return null;

    const modifiers = [];
    const addModifier = (name) => {
        if (!modifiers.includes(name)) modifiers.push(name);
    };
    // Electron's loop: a modifier token ORs its flag, **anything else** becomes
    // the key — so the last non-modifier token wins and earlier ones are simply
    // overwritten. Replicated rather than rejected, because a `hotkeys.json`
    // holding `Ctrl+A+B` really does register Ctrl+B and really can collide
    // with another entry's Ctrl+B.
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
 * The string two accelerators are compared *by*.
 *
 * Normally the canonical form. When an accelerator cannot be parsed — a
 * hand-edited `Ctrl+Nonsense`, which `safeRegister` will drop into the
 * conflict banner — it falls back to the lower-cased original so that such a
 * string still matches itself (and so two different unparseable strings do not
 * silently become one conflict).
 *
 * @param {*} accelerator
 * @returns {string} `''` for anything unbound, which never matches anything
 */
function acceleratorKey(accelerator) {
    if (isUnbound(accelerator)) return '';
    return normalizeAccelerator(accelerator) || accelerator.trim().toLowerCase();
}

/**
 * Are these two accelerators the same key combination as far as Electron is
 * concerned? Two unbound values are **not** "the same": nothing conflicts with
 * "no combination at all", in either direction.
 */
function sameAccelerator(a, b) {
    const left = acceleratorKey(a);
    return left !== '' && left === acceleratorKey(b);
}

/*
 * ─── The system hotkey map ──────────────────────────────────────────────────
 */

/**
 * The entries of an effective system map (`actionId → accelerator`) that
 * actually hold a key combination.
 *
 * Everything that asks "is this taken?" or "register these" goes through here
 * rather than the raw map: an unbound action carries `''`, and an empty string
 * must never count as a held accelerator —`globalShortcut.register('')` throws,
 * and an `''` in a "taken" set would make every unbound action collide with
 * every other one.
 *
 * @param {Object<string, string>} effective
 * @returns {Array<[string, string]>} `[actionId, accelerator]`
 */
function boundEntries(effective) {
    if (!effective || typeof effective !== 'object') return [];
    return Object.entries(effective).filter(([, accelerator]) => !isUnbound(accelerator));
}

/**
 * Which system action already holds this accelerator.
 *
 * @param {Object<string, string>} effective actionId → accelerator (`''` = unbound)
 * @param {*} accelerator
 * @param {?string} [exceptActionId] the action being re-bound or reset, which
 *   must not be found to conflict with itself.
 * @returns {?string} the colliding action id, or null
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
 * Which `hotkeys.json` entry already holds this accelerator.
 *
 * @param {Object<string, *>} mapHotkeys the parsed `hotkeys.json`
 * @param {*} accelerator
 * @returns {?string} the **stored** key (its own spelling, so a message can
 *   name what is actually in the file), or null
 */
function findMapConflict(mapHotkeys, accelerator) {
    if (isUnbound(accelerator) || !mapHotkeys || typeof mapHotkeys !== 'object') return null;
    for (const stored of Object.keys(mapHotkeys)) {
        if (sameAccelerator(stored, accelerator)) return stored;
    }
    return null;
}

/**
 * May this action be put back on its shipped default?
 *
 * `reset-system-hotkey` used to write the default blind, which was already
 * wrong after a rebind and became much more likely once an action could be
 * unbound: unbind "Rotate map", give its combination to a map, press Reset and
 * two things end up on one accelerator — the second registration then fails
 * into the conflict banner, which is a worse outcome than refusing and saying
 * why.
 *
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
 * The `hotkeys.json` entries a **system** hotkey holds the same combination as.
 *
 * System hotkeys register first, so these map bindings can never fire. They
 * are skipped at registration and reported, rather than being silently inert.
 *
 * @param {Object<string, string>} effective
 * @param {Object<string, *>} mapHotkeys
 * @returns {Array<{accelerator: string, actionId: string}>} `accelerator` is the
 *   stored spelling from the file
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
 * `hotkeys.json` keys that are different spellings of one combination.
 *
 * JSON cannot hold the same key twice, but it can hold `Ctrl+1` **and**
 * `CommandOrControl+1`, which Electron considers one accelerator: the first
 * registers, the second comes back `false` and used to be reported as "taken
 * by another application". The later duplicates are skipped instead.
 *
 * @param {Object<string, *>} mapHotkeys
 * @returns {Array<{accelerator: string, first: string}>} the losing entries,
 *   in file order, each with the entry that already claimed the combination
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
 * Every combination this app binds, as comparison keys: every *bound* system
 * hotkey plus every `hotkeys.json` entry.
 *
 * `Hotkeys.rejectIfUnregisterable` treats a member of this set as "already
 * proven registrable" and skips the dry run — the probe happens while our own
 * bindings are live, so probing one we hold returns `false` and produced a
 * bogus "taken by another application" toast.
 *
 * @param {Object<string, string>} effective
 * @param {Object<string, *>} mapHotkeys
 * @returns {Set<string>}
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

/*
 * ─── A number key for a map that arrived after the first run ────────────────
 */

/**
 * Should a map that a **map pack** just added get a default `Ctrl+Alt+N`, and
 * which one?
 *
 * `hotkeys.json` is written exactly once, by `ensureDefaultMapHotkeys`, so
 * before this existed a downloaded map never got a number: the file already
 * existed by the time the pack landed, and the first-run defaults had been
 * handed out to the maps that shipped in the build. A map arriving a week later
 * was a second-class map forever.
 *
 * Four rules, and each one exists because the alternative is worse:
 *
 * 1. **No file, no offer.** A missing `hotkeys.json` means `loadKeys()` has not
 *    run its first-run write yet (or that write failed). Writing here would
 *    either race it or produce a file holding *only* the pack map, which
 *    `ensureDefaultMapHotkeys` would then never fill in. The pack map is in the
 *    catalogue, so the ordinary first-run path gives it a number anyway.
 * 2. **An existing but empty file means "I cleared them".** A user who deleted
 *    every map binding has said what they want; a new map must not re-arm nine
 *    global accelerators behind them.
 * 3. **One offer per map, ever.** The caller remembers which keys have been
 *    offered (in the pack store's state file, not in `hotkeys.json`), because a
 *    binding the user *deleted* must not come back on the next start. This is
 *    the same principle as rule 2, one map at a time.
 * 4. **It can never create a conflict.** The candidate is compared with the
 *    project's own normalised comparison against every *bound* system hotkey
 *    and every entry already in `hotkeys.json` — so a user who put Ctrl+Alt+3
 *    on something themselves gets 4, and a user who rebound "Rotate map" onto
 *    Ctrl+Alt+5 never has it shadowed. Out of free slots is simply no offer.
 *
 * @param {{mapKey: string, fileExists: boolean, mapHotkeys: Object,
 *          systemHotkeys: Object<string, string>,
 *          offeredKeys?: Array<string>, max?: number}} args
 * @returns {{accelerator: ?string, reason: string, remember: boolean}}
 *   `remember` says whether the caller should record this map as offered:
 *   false only for the transient "there is no file yet" case, so that a genuine
 *   decision is never taken twice and a race is not remembered as one.
 */
function planPackMapHotkey({mapKey, fileExists, mapHotkeys, systemHotkeys, offeredKeys, max} = {}) {
    const no = (reason, remember) => ({accelerator: null, reason, remember: !!remember});
    if (typeof mapKey !== 'string' || !mapKey) return no('no-map-key');
    if (!fileExists) return no('no-file');

    const stored = (mapHotkeys && typeof mapHotkeys === 'object') ? mapHotkeys : {};
    const entries = Object.keys(stored);
    if (!entries.length) return no('cleared', true);
    if ((offeredKeys || []).includes(mapKey)) return no('already-offered');
    // Already bound — by the first-run defaults, or by the user, or by an
    // earlier version of this same pack.
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

/*
 * ─── Hotkeys only while the game is in front ────────────────────────────────
 */

/** What the foreground window is, as far as the hotkeys care. */
const FOREGROUND_GAME = 'game';
/** One of this app's own windows — Settings, the OBS window. */
const FOREGROUND_OWN = 'own';
/** Somebody else's window: a browser, Discord, the desktop. */
const FOREGROUND_OTHER = 'other';
/** The foreground could not be determined (the window scan threw). */
const FOREGROUND_UNKNOWN = 'unknown';

/**
 * Should the global shortcuts be registered right now?
 *
 * With `hotkeysGameOnly` on, the combinations belong to whatever application
 * is in front unless that is the game — **or one of our own windows**, so a
 * hotkey can still be tried from the Settings window, which is exactly where
 * somebody who just rebound one is standing.
 *
 * An unknown foreground registers them. Failing closed would mean a machine
 * whose window list cannot be read has no hotkeys at all and no way to tell
 * why; failing open is the pre-0.7 behaviour, which is merely not the
 * improvement.
 *
 * `suspended` wins over all of it — see `hotkeysShouldBeRegistered`.
 *
 * @param {{gameOnly: *, foreground: string, suspended: *}} state
 * @returns {boolean}
 */
function shouldHotkeysBeActive({gameOnly, foreground, suspended} = {}) {
    if (suspended) return false;
    // Only an explicit `false` turns the setting off, like every other
    // default-on switch in this app.
    if (gameOnly === false) return true;
    return foreground === FOREGROUND_GAME
        || foreground === FOREGROUND_OWN
        || foreground === FOREGROUND_UNKNOWN;
}

/**
 * Compose the foreground verdict with a temporary, explicit suspension.
 *
 * The suspension exists for the **key-recording dialog**. Our own windows
 * count as "the game is in front" so that a hotkey can be tried from Settings,
 * and that is exactly what made re-recording impossible: a global accelerator
 * the app is already holding is swallowed by the OS before any window sees the
 * keystroke, so the dialog never received it and the bound action fired
 * instead. Nobody could swap two bindings or move one out of the way. While
 * the dialog is recording, the app therefore holds **nothing**.
 *
 * Kept separate from the foreground decision (rather than folded into it)
 * because the two have different owners: `core/foreground.js` polls and knows
 * only about windows, the renderer's modal knows only about recording, and
 * `Hotkeys` is where they meet. `shouldHotkeysBeActive` accepts `suspended`
 * too, so a caller holding all three inputs gets the same answer in one call.
 *
 * @param {{foregroundAllows: *, suspended: *}} state
 * @returns {boolean}
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
