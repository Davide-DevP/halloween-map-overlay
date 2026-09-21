'use strict';

/**
 * PURE one-time migrations of an existing install onto a new generation of
 * default hotkeys: a value the user chose (`''` included) is never touched, a
 * colliding change is blocked, and each generation runs once.
 * Why: docs/agents/hotkeys.md § Defaults and the migration onto them.
 */

const {
    SYSTEM_HOTKEY_DEFS,
    ACTION_TO_SETTING_KEY,
    MAP_HOTKEY_PREFIX,
    MAX_DEFAULT_MAP_HOTKEYS,
    isUnbound,
    resolveSystemAccelerator
} = require('./hotkeys-constants');
const {acceleratorKey, sameAccelerator, findSystemConflict, findMapConflict} = require('./hotkeys-rules');

/** Generation of defaults this build ships; stored as `hotkeyDefaultsVersion`. */
const HOTKEY_DEFAULTS_VERSION = 2;

/** Generation 1: plain Ctrl → Ctrl+Alt (0.7.0). */
const V_CTRL_ALT = 1;
/** Generation 2: five actions stopped shipping with a default key. */
const V_UNBOUND_FIVE = 2;

/**
 * The defaults **up to and including 0.6.0** — frozen historical data: derive
 * them and they would follow the next change to the real defaults.
 */
const LEGACY_SYSTEM_DEFAULTS = Object.freeze({
    'toggle-map': 'CommandOrControl+H',
    'rotate-map': 'CommandOrControl+R',
    'next-map': 'CommandOrControl+Right',
    'prev-map': 'CommandOrControl+Left',
    'clear-map': 'CommandOrControl+Shift+D',
    'opacity-up': 'CommandOrControl+Up',
    'opacity-down': 'CommandOrControl+Down',
    'size-up': 'CommandOrControl+Shift+Up',
    'size-down': 'CommandOrControl+Shift+Down'
});

/**
 * The defaults **0.7.0 shipped**: frozen for the same reason and never derived
 * from `SYSTEM_HOTKEY_DEFS` — five of those are `''` now, so deriving would
 * turn generation 1 into an unbind.
 */
const V070_SYSTEM_DEFAULTS = Object.freeze({
    'toggle-map': 'CommandOrControl+Alt+H',
    'rotate-map': 'CommandOrControl+Alt+R',
    'next-map': 'CommandOrControl+Alt+Right',
    'prev-map': 'CommandOrControl+Alt+Left',
    'clear-map': 'CommandOrControl+Alt+D',
    'opacity-up': 'CommandOrControl+Alt+Up',
    'opacity-down': 'CommandOrControl+Alt+Down',
    'size-up': 'CommandOrControl+Alt+Shift+Up',
    'size-down': 'CommandOrControl+Alt+Shift+Down',
    'toggle-markers': 'CommandOrControl+Alt+M'
});

/**
 * The actions that stopped shipping with a default key in generation 2. Listed
 * by hand like the tables above; a test asserts it is exactly the set whose
 * live default is unbound, so unbinding a sixth needs a new generation.
 */
const DEFAULT_UNBOUND_ACTIONS = Object.freeze([
    'rotate-map', 'opacity-up', 'opacity-down', 'size-up', 'size-down'
]);

/** The per-map bindings 0.6.0 handed out on first run: Ctrl+1 .. Ctrl+9. */
const LEGACY_MAP_HOTKEY_PREFIX = 'CommandOrControl+';

/** The digit of a stored `Control+1..9`, in any spelling, or null. */
function legacyMapNumber(stored) {
    const normalized = acceleratorKey(stored);
    for (let n = 1; n <= MAX_DEFAULT_MAP_HOTKEYS; n++) {
        if (normalized === acceleratorKey(`${LEGACY_MAP_HOTKEY_PREFIX}${n}`)) return n;
    }
    return null;
}

/**
 * Work out what a migration would change. Changes nothing itself.
 * @param {*} args.storedVersion the `hotkeyDefaultsVersion` setting
 * @param {boolean} args.freshInstall the settings file was created by this start
 * @param {Object} args.settings loaded settings, back-filled from the defaults
 * @param {Object} [args.fileSettings] the same file **before** the back-fill:
 *   generation 2 needs it to tell "no key" from a stored `''`, and without it
 *   nothing is pinned
 * @param {Object} args.mapHotkeys parsed `hotkeys.json` (`{}` when there is none)
 * @returns {Object} `stamp` = the version setting needs writing; `migrated` =
 *   something *moved* — a generation-2 `pinned` entry keeps a binding where the
 *   user already had it, so it is deliberately not a move. `mapHotkeys` is the
 *   new file contents, the input's own object identity when `mapChanged` is false.
 */
function planHotkeyDefaultsMigration({storedVersion, freshInstall, settings, fileSettings, mapHotkeys}) {
    const version = HOTKEY_DEFAULTS_VERSION;
    const stored = Number.isInteger(storedVersion) ? storedVersion : 0;
    const source = settings && typeof settings === 'object' ? settings : {};
    // Falling back to the back-filled object means every `''` looks stored, so
    // a caller with no raw file pins nothing rather than un-unbinding an action.
    const raw = fileSettings && typeof fileSettings === 'object' ? fileSettings : source;
    const file = mapHotkeys && typeof mapHotkeys === 'object' ? mapHotkeys : {};
    // `stored < version`, not `!==`: a file stamped by a *newer* build (the
    // user downgraded) must be left alone.
    const stamp = stored < version;
    const nothing = {
        version,
        stamp,
        migrated: false,
        settingChanges: {},
        mapHotkeys: file,
        mapChanged: false,
        moved: [],
        pinned: [],
        blocked: []
    };

    if (!stamp) return nothing;

    // Updated as changes are applied: two of them cannot land on one combination.
    const effective = {};
    for (const [actionId, def] of Object.entries(SYSTEM_HOTKEY_DEFS)) {
        effective[actionId] = resolveSystemAccelerator(source[ACTION_TO_SETTING_KEY[actionId]], def.defaultAccelerator);
    }

    const settingChanges = {};
    const moved = [];
    const pinned = [];
    const blocked = [];

    /** Is `target` free for `actionId`? Pushes a `blocked` entry if not. */
    const claim = (actionId, target, from) => {
        const systemClash = findSystemConflict(effective, target, actionId);
        if (systemClash) {
            blocked.push({kind: 'system', id: actionId, from, to: target, reason: 'system:' + systemClash});
            return false;
        }
        const mapClash = findMapConflict(file, target);
        if (mapClash) {
            blocked.push({kind: 'system', id: actionId, from, to: target, reason: 'map:' + mapClash});
            return false;
        }
        effective[actionId] = target;
        settingChanges[ACTION_TO_SETTING_KEY[actionId]] = target;
        return true;
    };

    // ── Generation 1: the 0.6.0 defaults move onto the 0.7.0 ones. A fresh
    // install skips only the system half; the map half always runs.
    const runCtrlAlt = !freshInstall && stored < V_CTRL_ALT;
    for (const actionId of (runCtrlAlt ? Object.keys(SYSTEM_HOTKEY_DEFS) : [])) {
        const legacy = LEGACY_SYSTEM_DEFAULTS[actionId];
        const target = V070_SYSTEM_DEFAULTS[actionId];
        // No legacy entry = an action added after 0.6.0: nothing to move.
        if (!legacy || !target || sameAccelerator(legacy, target)) continue;

        const current = effective[actionId];
        // Unbound stays unbound; anything else than the old default is a choice.
        if (isUnbound(current) || !sameAccelerator(current, legacy)) continue;

        if (claim(actionId, target, current)) {
            moved.push({kind: 'system', id: actionId, from: current, to: target});
        }
    }

    // ── Generation 2: five actions stopped shipping with a default key. On any
    // install that is not fresh the 0.7.0 default is written out explicitly
    // where the file holds nothing — the back-fill would hand `''` back instead.
    const runUnboundFive = !freshInstall && stored < V_UNBOUND_FIVE;
    for (const actionId of (runUnboundFive ? DEFAULT_UNBOUND_ACTIONS : [])) {
        // Already holding a combination — stored, or moved by generation 1.
        if (!isUnbound(effective[actionId])) continue;
        // **A stored `''` is never pinned over**: a string in the file is a
        // decision — a rebind, or a deliberate unbind.
        if (typeof raw[ACTION_TO_SETTING_KEY[actionId]] === 'string') continue;
        const target = V070_SYSTEM_DEFAULTS[actionId];
        if (!target) continue;
        // Taken meanwhile? Leave it unbound rather than create a conflict.
        if (claim(actionId, target, '')) pinned.push({kind: 'system', id: actionId, to: target});
    }

    // Ctrl+<n> → Ctrl+Alt+<n>. Rebuilt, not mutated, so the file still reads
    // 1..9 top to bottom. Not gated on a generation: a binding an earlier run
    // could not move is retried, and the plan is recomputed from disk.
    const nextMap = {};
    let mapChanged = false;
    for (const [stored_, binding] of Object.entries(file)) {
        const number = legacyMapNumber(stored_);
        const target = number === null ? null : `${MAP_HOTKEY_PREFIX}${number}`;
        if (target === null
            || findMapConflict(nextMap, target)
            || findMapConflict(file, target)
            || findSystemConflict(effective, target)) {
            if (target !== null) {
                blocked.push({kind: 'map', id: stored_, from: stored_, to: target, reason: 'taken'});
            }
            nextMap[stored_] = binding;
            continue;
        }
        nextMap[target] = binding;
        mapChanged = true;
        moved.push({kind: 'map', id: stored_, from: stored_, to: target});
    }

    return {
        version,
        stamp: true,
        migrated: moved.length > 0,
        settingChanges,
        mapHotkeys: mapChanged ? nextMap : file,
        mapChanged,
        moved,
        pinned,
        blocked
    };
}

module.exports = {
    HOTKEY_DEFAULTS_VERSION,
    LEGACY_SYSTEM_DEFAULTS,
    V070_SYSTEM_DEFAULTS,
    DEFAULT_UNBOUND_ACTIONS,
    LEGACY_MAP_HOTKEY_PREFIX,
    legacyMapNumber,
    planHotkeyDefaultsMigration
};
