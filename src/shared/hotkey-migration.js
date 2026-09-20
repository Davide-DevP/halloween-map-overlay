'use strict';

/**
 * PURE one-time migration onto the Ctrl+Alt default hotkeys.
 *
 * 0.6.0 and everything before it shipped plain Ctrl defaults — Ctrl+H, Ctrl+R,
 * Ctrl+arrows, Ctrl+Shift+D, Ctrl+1..9. Ctrl is crouch in the game and every
 * one of those combinations is a browser, Discord or text-field shortcut, and
 * a *global* shortcut takes it away from all of them. The defaults moved to
 * Ctrl+Alt (see `SYSTEM_HOTKEY_DEFS`), and an existing install has to come
 * along — but only where the user never expressed an opinion.
 *
 * The three rules, in order of how much they matter:
 *
 * 1. **A value the user chose is never touched.** Only a stored accelerator
 *    that still equals the *old* default moves. An unbound action (`''`) stays
 *    unbound: switching a hotkey off is the strongest opinion there is.
 * 2. **A migration never creates a conflict.** Each move is checked against
 *    the state as it stands *after* the previous moves, both against the other
 *    system actions and against `hotkeys.json`. A blocked move keeps the old
 *    value, which at least still works.
 * 3. **It runs once**, and a fresh install is not "migrated" at all — every
 *    value in a brand-new settings file is already a new default, so there
 *    would be nothing to move, but saying so explicitly keeps the first-run
 *    path from depending on that coincidence.
 *
 * The decision is pure so all six of those cases are unit tested; the writing
 * half is `Hotkeys.migrateDefaultHotkeys()`.
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

/**
 * The generation of defaults the current code ships. Stored under
 * `hotkeyDefaultsVersion`; a settings file holding less than this has not been
 * through the migration below yet.
 */
const HOTKEY_DEFAULTS_VERSION = 1;

/**
 * The defaults as they were **up to and including 0.6.0**.
 *
 * Frozen and written out by hand rather than derived from anything: this is
 * historical data, and the whole migration hangs on "does the stored value
 * still equal what that version shipped?". Deriving it would make it follow
 * the next change to the real defaults and quietly stop matching.
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
 * Is this stored `hotkeys.json` key one of the legacy number bindings — i.e.
 * exactly Control plus one digit 1-9, in any spelling?
 * @param {string} stored
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
 *
 * @param {Object} args
 * @param {*} args.storedVersion value of the `hotkeyDefaultsVersion` setting
 * @param {boolean} args.freshInstall true when the settings file was created by
 *   this very start, i.e. there is no previous install to migrate
 * @param {Object} args.settings the settings object as loaded (already
 *   back-filled from `DEFAULT_SETTINGS`, exactly as `core/settings.js` hands it
 *   over)
 * @param {Object<string, {id: string, mapKey: string}>} args.mapHotkeys parsed
 *   `hotkeys.json` (`{}` when there is none)
 * @returns {{
 *   version: number,
 *   stamp: boolean,
 *   migrated: boolean,
 *   settingChanges: Object<string, string>,
 *   mapHotkeys: Object,
 *   mapChanged: boolean,
 *   moved: Array<{kind: string, id: string, from: string, to: string}>,
 *   blocked: Array<{kind: string, id: string, from: string, to: string, reason: string}>
 * }}
 *   `stamp` = the version setting needs writing. `migrated` = something
 *   actually moved, which is the only case worth telling the user about.
 *   `mapHotkeys` is the **new** file contents (the same object identity as the
 *   input when nothing changed, so a caller can skip the write on `mapChanged`).
 */
function planHotkeyDefaultsMigration({storedVersion, freshInstall, settings, mapHotkeys}) {
    const version = HOTKEY_DEFAULTS_VERSION;
    const stored = Number.isInteger(storedVersion) ? storedVersion : 0;
    const source = settings && typeof settings === 'object' ? settings : {};
    const file = mapHotkeys && typeof mapHotkeys === 'object' ? mapHotkeys : {};
    // `stored < version`, not `!==`: a settings file stamped by a *newer*
    // build (the user downgraded) must be left completely alone. Writing the
    // older number back would be the migration running backwards, and the
    // newer build would then re-run its own on the next upgrade.
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

    // A second run must be a no-op, and so must a downgrade: only a settings
    // file from before this version is looked at, and the stamp is what makes
    // it exactly once.
    if (!stamp) return nothing;

    // The state the decisions are taken against, updated as moves are applied
    // so two moves can never land on one combination.
    const effective = {};
    for (const [actionId, def] of Object.entries(SYSTEM_HOTKEY_DEFS)) {
        effective[actionId] = resolveSystemAccelerator(source[ACTION_TO_SETTING_KEY[actionId]], def.defaultAccelerator);
    }

    const settingChanges = {};
    const moved = [];
    const blocked = [];

    // On a **fresh install** only the system half is skipped. Every value in a
    // brand-new settings file is already a new default, so the loop below would
    // find nothing to move anyway — but the map half still has work to do: a
    // user who deleted (or reset) `settings-app.json` while keeping their
    // `hotkeys.json` has a fresh settings file *and* nine stale Ctrl+1..9
    // bindings, and skipping the whole migration left those permanently on the
    // browser's tab shortcuts.
    for (const [actionId, def] of (freshInstall ? [] : Object.entries(SYSTEM_HOTKEY_DEFS))) {
        const legacy = LEGACY_SYSTEM_DEFAULTS[actionId];
        const target = def.defaultAccelerator;
        // An action whose default did not change (a future migration will have
        // several of these) has nothing to do.
        if (!legacy || sameAccelerator(legacy, target)) continue;

        const current = effective[actionId];
        // Unbound stays unbound. Anything that is not the old default is the
        // user's own choice and is left exactly where it is.
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

    // `hotkeys.json`: Ctrl+<n> → Ctrl+Alt+<n>, insertion order preserved so
    // the file still reads 1..9 top to bottom. Rebuilt rather than mutated —
    // a key cannot be renamed in place without reordering the object.
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
