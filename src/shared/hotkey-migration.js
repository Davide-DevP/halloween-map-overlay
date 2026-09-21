'use strict';

/**
 * PURE one-time migration of an existing install onto the Ctrl+Alt default
 * hotkeys: a value the user chose (an unbound `''` included) is never touched,
 * a colliding move is blocked, and it runs once. Writing half:
 * `Hotkeys.migrateDefaultHotkeys()`.
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
const HOTKEY_DEFAULTS_VERSION = 1;

/**
 * The defaults **up to and including 0.6.0**: frozen historical data, written
 * out by hand and never derived, or it would follow the next change to the real
 * defaults and stop matching.
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

/** The per-map bindings 0.6.0 handed out on first run: Ctrl+1 .. Ctrl+9. */
const LEGACY_MAP_HOTKEY_PREFIX = 'CommandOrControl+';

/**
 * Is this stored key exactly Control plus one digit 1-9, in any spelling?
 * @returns {?number} the digit, or null
 */
function legacyMapNumber(stored) {
    const normalized = acceleratorKey(stored);
    for (let n = 1; n <= MAX_DEFAULT_MAP_HOTKEYS; n++) {
        if (normalized === acceleratorKey(`${LEGACY_MAP_HOTKEY_PREFIX}${n}`)) return n;
    }
    return null;
}

/**
 * Work out what a migration would change. Changes nothing itself.
 * @param {*} args.storedVersion value of the `hotkeyDefaultsVersion` setting
 * @param {boolean} args.freshInstall the settings file was created by this very
 *   start, so there is no previous install to migrate
 * @param {Object} args.settings the loaded settings, already back-filled from
 *   `DEFAULT_SETTINGS` as `core/settings.js` hands them over
 * @param {Object<string, {id: string, mapKey: string}>} args.mapHotkeys parsed
 *   `hotkeys.json` (`{}` when there is none)
 * @returns {{version: number, stamp: boolean, migrated: boolean,
 *   settingChanges: Object<string, string>, mapHotkeys: Object,
 *   mapChanged: boolean,
 *   moved: Array<{kind: string, id: string, from: string, to: string}>,
 *   blocked: Array<{kind: string, id: string, from: string, to: string, reason: string}>}}
 *   `stamp` = the version setting needs writing; `migrated` = something moved,
 *   the only case worth a notice; `mapHotkeys` is the **new** file contents,
 *   the same object identity as the input when `mapChanged` is false.
 */
function planHotkeyDefaultsMigration({storedVersion, freshInstall, settings, mapHotkeys}) {
    const version = HOTKEY_DEFAULTS_VERSION;
    const stored = Number.isInteger(storedVersion) ? storedVersion : 0;
    const source = settings && typeof settings === 'object' ? settings : {};
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
        blocked: []
    };

    if (!stamp) return nothing;

    // Updated as moves are applied, so two moves cannot land on one combination.
    const effective = {};
    for (const [actionId, def] of Object.entries(SYSTEM_HOTKEY_DEFS)) {
        effective[actionId] = resolveSystemAccelerator(source[ACTION_TO_SETTING_KEY[actionId]], def.defaultAccelerator);
    }

    const settingChanges = {};
    const moved = [];
    const blocked = [];

    // A **fresh install** skips only the system half; the map half always runs.
    // Why: the doc, same section.
    for (const [actionId, def] of (freshInstall ? [] : Object.entries(SYSTEM_HOTKEY_DEFS))) {
        const legacy = LEGACY_SYSTEM_DEFAULTS[actionId];
        const target = def.defaultAccelerator;
        // No legacy entry = an action added after 0.6.0: nothing to move.
        if (!legacy || sameAccelerator(legacy, target)) continue;

        const current = effective[actionId];
        // Unbound stays unbound; anything that is not the old default is the
        // user's own choice.
        if (isUnbound(current) || !sameAccelerator(current, legacy)) continue;

        const systemClash = findSystemConflict(effective, target, actionId);
        if (systemClash) {
            blocked.push({kind: 'system', id: actionId, from: current, to: target, reason: 'system:' + systemClash});
            continue;
        }
        const mapClash = findMapConflict(file, target);
        if (mapClash) {
            blocked.push({kind: 'system', id: actionId, from: current, to: target, reason: 'map:' + mapClash});
            continue;
        }

        effective[actionId] = target;
        settingChanges[ACTION_TO_SETTING_KEY[actionId]] = target;
        moved.push({kind: 'system', id: actionId, from: current, to: target});
    }

    // Ctrl+<n> → Ctrl+Alt+<n>. Rebuilt rather than mutated, so insertion order
    // survives and the file still reads 1..9 top to bottom.
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
        blocked
    };
}

module.exports = {
    HOTKEY_DEFAULTS_VERSION,
    LEGACY_SYSTEM_DEFAULTS,
    LEGACY_MAP_HOTKEY_PREFIX,
    legacyMapNumber,
    planHotkeyDefaultsMigration
};
