const {test} = require('node:test');
const assert = require('node:assert');

const {
    HOTKEY_DEFAULTS_VERSION,
    LEGACY_SYSTEM_DEFAULTS,
    LEGACY_MAP_HOTKEY_PREFIX,
    legacyMapNumber,
    planHotkeyDefaultsMigration
} = require('../src/shared/hotkey-migration');
const {
    SYSTEM_HOTKEY_DEFS,
    ACTION_TO_SETTING_KEY,
    MAP_HOTKEY_PREFIX,
    MAX_DEFAULT_MAP_HOTKEYS
} = require('../src/shared/hotkeys-constants');
const {DEFAULT_SETTINGS} = require('../src/shared/settings-defaults');

/**
 * A settings object shaped exactly as `core/settings.js` hands it over: the
 * file's own values with every missing key back-filled from DEFAULT_SETTINGS.
 * @param {Object} file what is really on disk
 */
function loaded(file) {
    const settings = Object.assign({}, file);
    for (const key in DEFAULT_SETTINGS) {
        if (settings[key] === undefined) settings[key] = DEFAULT_SETTINGS[key];
    }
    return settings;
}

/** The settings file a 0.6.0 install that nobody touched would hold. */
function untouched060() {
    const file = {};
    for (const [actionId, accelerator] of Object.entries(LEGACY_SYSTEM_DEFAULTS)) {
        file[ACTION_TO_SETTING_KEY[actionId]] = accelerator;
    }
    return file;
}

/** The `hotkeys.json` a 0.6.0 first run wrote for the four shipped maps. */
function legacyMapFile(count = 4) {
    const file = {};
    for (let n = 1; n <= count; n++) {
        file[`${LEGACY_MAP_HOTKEY_PREFIX}${n}`] = {id: `id-${n}`, mapKey: `deftyconchgaming/Map ${n}`};
    }
    return file;
}

/**
 * Actions that did **not** exist in 0.6.0 and therefore have no legacy default.
 *
 * The migration skips them (`if (!legacy) continue`) because there is no old
 * value to move: a settings file from 0.6.0 simply has no key for them, and
 * `core/settings.js` back-fills the shipped default with no conflict check —
 * the documented behaviour, whose safety net is the `shadowed` report.
 * Listed here by hand for the same reason `LEGACY_SYSTEM_DEFAULTS` is: it is a
 * statement about history, and deriving it would make the assertion below
 * vacuous.
 */
const ADDED_AFTER_060 = ['toggle-markers'];

test('the legacy table is the 0.6.0 default set, action for action', () => {
    // It is historical data and must not follow the live defaults, or the
    // "did the user touch this?" test would quietly stop matching anything.
    // Every action except the ones added later has a legacy value…
    assert.deepStrictEqual(Object.keys(LEGACY_SYSTEM_DEFAULTS).sort(),
        Object.keys(SYSTEM_HOTKEY_DEFS).filter(id => !ADDED_AFTER_060.includes(id)).sort());
    // …and the later ones are really absent from it, not merely equal to their
    // current default, which is what makes the migration skip them.
    for (const id of ADDED_AFTER_060) {
        assert.ok(Object.prototype.hasOwnProperty.call(SYSTEM_HOTKEY_DEFS, id), id);
        assert.strictEqual(LEGACY_SYSTEM_DEFAULTS[id], undefined, id);
    }
    for (const [actionId, legacy] of Object.entries(LEGACY_SYSTEM_DEFAULTS)) {
        assert.notStrictEqual(legacy, SYSTEM_HOTKEY_DEFS[actionId].defaultAccelerator, actionId);
    }
    assert.strictEqual(HOTKEY_DEFAULTS_VERSION, 1);
    // The shipped default is deliberately behind the current version: that is
    // what makes an old file (back-filled to 0) distinguishable.
    assert.ok(DEFAULT_SETTINGS.hotkeyDefaultsVersion < HOTKEY_DEFAULTS_VERSION);
});

test('legacyMapNumber recognises Ctrl+1..9 in any spelling and nothing else', () => {
    for (let n = 1; n <= MAX_DEFAULT_MAP_HOTKEYS; n++) {
        assert.strictEqual(legacyMapNumber(`CommandOrControl+${n}`), n);
        assert.strictEqual(legacyMapNumber(`ctrl+${n}`), n);
        assert.strictEqual(legacyMapNumber(`Control+${n}`), n);
    }
    // Not a legacy number binding: an extra modifier, the wrong digit, a
    // letter, the new form, garbage.
    for (const value of ['CommandOrControl+Alt+1', 'CommandOrControl+Shift+1', 'CommandOrControl+0',
        'Alt+1', 'CommandOrControl+A', 'Ctrl+num1', '', 'nonsense']) {
        assert.strictEqual(legacyMapNumber(value), null, value);
    }
});

/* ────────────────────────────────────────────────────────────────────────────
 * The six cases the spec names
 * ──────────────────────────────────────────────────────────────────────────── */

test('a fresh install is not migrated, only stamped', () => {
    const plan = planHotkeyDefaultsMigration({
        storedVersion: 0,
        freshInstall: true,
        settings: loaded({}),
        mapHotkeys: {}
    });
    assert.strictEqual(plan.migrated, false);
    assert.deepStrictEqual(plan.settingChanges, {});
    assert.strictEqual(plan.mapChanged, false);
    assert.deepStrictEqual(plan.moved, []);
    // Stamped so the next start does not look at it again.
    assert.strictEqual(plan.stamp, true);
    assert.strictEqual(plan.version, HOTKEY_DEFAULTS_VERSION);
});

test('an untouched 0.6.0 install moves every system hotkey and every number', () => {
    const plan = planHotkeyDefaultsMigration({
        storedVersion: 0,
        freshInstall: false,
        settings: loaded(untouched060()),
        mapHotkeys: legacyMapFile(4)
    });

    assert.strictEqual(plan.migrated, true);
    assert.deepStrictEqual(plan.blocked, []);
    // Every system action that 0.6.0 had lands on its new default; an action
    // added later is not "moved" at all — it never had an old value.
    const expected = {};
    for (const [actionId, def] of Object.entries(SYSTEM_HOTKEY_DEFS)) {
        if (ADDED_AFTER_060.includes(actionId)) continue;
        expected[ACTION_TO_SETTING_KEY[actionId]] = def.defaultAccelerator;
    }
    assert.deepStrictEqual(plan.settingChanges, expected);
    // …and the four number bindings keep their ids, their maps and their order.
    assert.strictEqual(plan.mapChanged, true);
    assert.deepStrictEqual(Object.keys(plan.mapHotkeys),
        [1, 2, 3, 4].map(n => `${MAP_HOTKEY_PREFIX}${n}`));
    assert.deepStrictEqual(plan.mapHotkeys[`${MAP_HOTKEY_PREFIX}3`],
        {id: 'id-3', mapKey: 'deftyconchgaming/Map 3'});
    assert.strictEqual(plan.moved.length, 9 + 4);
});

test('a hotkey the user changed is left exactly where it is', () => {
    const file = untouched060();
    file.hotkeyRotateMap = 'Alt+K';                  // rebound by hand
    file.hotkeyToggleMap = 'CommandOrControl+Shift+H'; // ditto
    const plan = planHotkeyDefaultsMigration({
        storedVersion: 0, freshInstall: false, settings: loaded(file), mapHotkeys: {}
    });
    assert.ok(!('hotkeyRotateMap' in plan.settingChanges));
    assert.ok(!('hotkeyToggleMap' in plan.settingChanges));
    // The seven nobody touched still move.
    assert.strictEqual(Object.keys(plan.settingChanges).length, 7);
    assert.strictEqual(plan.migrated, true);
});

test('an unbound hotkey stays unbound', () => {
    const file = untouched060();
    file.hotkeyClearMap = '';
    file.hotkeySizeUp = '   ';
    const plan = planHotkeyDefaultsMigration({
        storedVersion: 0, freshInstall: false, settings: loaded(file), mapHotkeys: {}
    });
    assert.ok(!('hotkeyClearMap' in plan.settingChanges));
    assert.ok(!('hotkeySizeUp' in plan.settingChanges));
    assert.strictEqual(Object.keys(plan.settingChanges).length, 7);
});

test('a migration never creates a conflict — the old value is kept', () => {
    const file = untouched060();
    // The user has already parked "clear map" on what is about to become the
    // *rotate* default. Moving rotate there would put two actions on one
    // combination and the second registration would fail into the banner.
    file.hotkeyClearMap = 'Ctrl+Alt+R';
    // …and a map binding sits on the new toggle default, in another spelling.
    const maps = {'alt+ctrl+h': {id: 'm1', mapKey: 'x/y'}};

    const plan = planHotkeyDefaultsMigration({
        storedVersion: 0, freshInstall: false, settings: loaded(file), mapHotkeys: maps
    });

    assert.ok(!('hotkeyRotateMap' in plan.settingChanges), 'rotate must not move onto clear-map');
    assert.ok(!('hotkeyToggleMap' in plan.settingChanges), 'toggle must not move onto a map binding');
    assert.deepStrictEqual(plan.blocked.map(b => b.id).sort(), ['rotate-map', 'toggle-map']);
    assert.deepStrictEqual(plan.blocked.map(b => b.reason).sort(),
        ['map:alt+ctrl+h', 'system:clear-map']);
    // Everything that could move still did: nine actions, minus clear-map
    // (the user changed it), minus the two that were blocked.
    assert.strictEqual(plan.migrated, true);
    assert.strictEqual(Object.keys(plan.settingChanges).length, 6);
});

test('a map binding is kept when its new number is already taken', () => {
    const maps = {
        'CommandOrControl+1': {id: 'a', mapKey: 'x/1'},
        // Already on the target, so the first one has nowhere to go.
        'CommandOrControl+Alt+1': {id: 'b', mapKey: 'x/2'},
        'CommandOrControl+2': {id: 'c', mapKey: 'x/3'}
    };
    const plan = planHotkeyDefaultsMigration({
        storedVersion: 0, freshInstall: false, settings: loaded({}), mapHotkeys: maps
    });
    assert.strictEqual(plan.mapHotkeys['CommandOrControl+1'].id, 'a');
    assert.strictEqual(plan.mapHotkeys['CommandOrControl+Alt+1'].id, 'b');
    assert.strictEqual(plan.mapHotkeys[`${MAP_HOTKEY_PREFIX}2`].id, 'c');
    assert.ok(plan.blocked.some(b => b.kind === 'map' && b.from === 'CommandOrControl+1'));
});

test('a map binding is kept when a system hotkey would shadow its new number', () => {
    // Contrived but possible: the user put a system action on Ctrl+Alt+3.
    const file = untouched060();
    file.hotkeyRotateMap = 'CommandOrControl+Alt+3';
    const plan = planHotkeyDefaultsMigration({
        storedVersion: 0, freshInstall: false, settings: loaded(file),
        mapHotkeys: {'CommandOrControl+3': {id: 'a', mapKey: 'x/3'}}
    });
    assert.ok(plan.mapHotkeys['CommandOrControl+3']);
    assert.strictEqual(plan.mapChanged, false);
    assert.ok(plan.blocked.some(b => b.kind === 'map' && b.to === `${MAP_HOTKEY_PREFIX}3`));
});

test('the second run is a no-op', () => {
    const settings = loaded(untouched060());
    const first = planHotkeyDefaultsMigration({
        storedVersion: 0, freshInstall: false, settings, mapHotkeys: legacyMapFile(4)
    });
    assert.strictEqual(first.migrated, true);

    // Apply it, exactly as `Hotkeys.migrateDefaultHotkeys()` does.
    Object.assign(settings, first.settingChanges);
    settings.hotkeyDefaultsVersion = first.version;

    const second = planHotkeyDefaultsMigration({
        storedVersion: settings.hotkeyDefaultsVersion,
        freshInstall: false,
        settings,
        mapHotkeys: first.mapHotkeys
    });
    assert.strictEqual(second.migrated, false);
    assert.strictEqual(second.stamp, false);
    assert.deepStrictEqual(second.settingChanges, {});
    assert.strictEqual(second.mapChanged, false);
    assert.strictEqual(second.mapHotkeys, first.mapHotkeys);
});

test('a future version stamp is left alone — including the stamp itself', () => {
    // Downgrading must not run a migration backwards, and must not write the
    // older number back either: `stamp` was `stored !== version`, which is
    // true for a *newer* file, so the downgrade stamped it down and the newer
    // build would then re-run its own migration on the next upgrade.
    const plan = planHotkeyDefaultsMigration({
        storedVersion: HOTKEY_DEFAULTS_VERSION + 5,
        freshInstall: false,
        settings: loaded(untouched060()),
        mapHotkeys: legacyMapFile(4)
    });
    assert.strictEqual(plan.migrated, false);
    assert.strictEqual(plan.mapChanged, false);
    assert.strictEqual(plan.stamp, false, 'a newer file must not be stamped backwards');
    assert.deepStrictEqual(plan.settingChanges, {});
});

test('the exact current version is not stamped again either', () => {
    const plan = planHotkeyDefaultsMigration({
        storedVersion: HOTKEY_DEFAULTS_VERSION,
        freshInstall: false,
        settings: loaded(untouched060()),
        mapHotkeys: legacyMapFile(4)
    });
    assert.strictEqual(plan.stamp, false);
    assert.strictEqual(plan.migrated, false);
});

/* ────────────────────────────────────────────────────────────────────────────
 * A fresh settings file next to an old hotkeys.json
 * ──────────────────────────────────────────────────────────────────────────── */

test('freshInstall skips the system half but still migrates the map bindings', () => {
    // `settings-app.json` deleted or reset (a "start over", a sync client, a
    // profile copied without it) while `hotkeys.json` survived: the settings
    // file is genuinely fresh, and nine stale Ctrl+1..9 bindings are still
    // sitting on the browser's tab shortcuts. Skipping the whole migration
    // left them there permanently.
    const plan = planHotkeyDefaultsMigration({
        storedVersion: 0,
        freshInstall: true,
        settings: loaded({}),
        mapHotkeys: legacyMapFile(4)
    });
    assert.strictEqual(plan.mapChanged, true);
    assert.deepStrictEqual(Object.keys(plan.mapHotkeys),
        [1, 2, 3, 4].map(n => `${MAP_HOTKEY_PREFIX}${n}`));
    assert.strictEqual(plan.mapHotkeys[`${MAP_HOTKEY_PREFIX}2`].id, 'id-2');
    assert.strictEqual(plan.migrated, true);
    // The system half is untouched: a fresh settings file already holds the new
    // defaults, so there is nothing there to move.
    assert.deepStrictEqual(plan.settingChanges, {});
    assert.strictEqual(plan.stamp, true);
});

test('freshInstall leaves the system hotkeys alone even if the file looks old', () => {
    // Belt and braces: the system half is skipped because it *is* the fresh
    // half, not because the values happen to already be new.
    const plan = planHotkeyDefaultsMigration({
        storedVersion: 0,
        freshInstall: true,
        settings: loaded(untouched060()),
        mapHotkeys: {}
    });
    assert.deepStrictEqual(plan.settingChanges, {});
    assert.strictEqual(plan.migrated, false);
});

test('a genuine first run still has nothing to migrate', () => {
    // No settings file *and* no hotkeys.json — `ensureDefaultMapHotkeys` writes
    // the new Ctrl+Alt+N bindings straight afterwards.
    const plan = planHotkeyDefaultsMigration({
        storedVersion: 0, freshInstall: true, settings: loaded({}), mapHotkeys: {}
    });
    assert.strictEqual(plan.migrated, false);
    assert.strictEqual(plan.mapChanged, false);
    assert.deepStrictEqual(plan.moved, []);
    assert.strictEqual(plan.stamp, true);
});

test('a freshInstall map migration never collides with a system default', () => {
    // The system half is skipped, so the map half is checked against the
    // *effective* (back-filled) system map — not against nothing.
    const plan = planHotkeyDefaultsMigration({
        storedVersion: 0,
        freshInstall: true,
        settings: loaded({hotkeyRotateMap: `${MAP_HOTKEY_PREFIX}3`}),
        mapHotkeys: {'CommandOrControl+3': {id: 'a', mapKey: 'x/3'}}
    });
    assert.ok(plan.mapHotkeys['CommandOrControl+3']);
    assert.strictEqual(plan.mapChanged, false);
    assert.ok(plan.blocked.some(b => b.kind === 'map' && b.to === `${MAP_HOTKEY_PREFIX}3`));
});

test('a hand-edited spelling of an old default still counts as untouched', () => {
    const file = {hotkeyRotateMap: 'ctrl+r', hotkeyToggleMap: 'Control+H'};
    const plan = planHotkeyDefaultsMigration({
        storedVersion: 0, freshInstall: false, settings: loaded(file), mapHotkeys: {}
    });
    assert.strictEqual(plan.settingChanges.hotkeyRotateMap, 'CommandOrControl+Alt+R');
    assert.strictEqual(plan.settingChanges.hotkeyToggleMap, 'CommandOrControl+Alt+H');
});

test('the plan never touches a hotkeys.json entry that is not a number binding', () => {
    const maps = {
        'CommandOrControl+Shift+K': {id: 'a', mapKey: 'Custom/mine'},
        'Alt+F9': {id: 'b', mapKey: 'x/y'},
        'CommandOrControl+ArrowRight': {id: 'c', mapKey: 'x/z'}   // hand-edited garbage
    };
    const plan = planHotkeyDefaultsMigration({
        storedVersion: 0, freshInstall: false, settings: loaded({}), mapHotkeys: maps
    });
    assert.strictEqual(plan.mapChanged, false);
    assert.strictEqual(plan.mapHotkeys, maps);
    assert.deepStrictEqual(plan.blocked.filter(b => b.kind === 'map'), []);
});

test('nothing in a plan is ever an empty or unparseable accelerator', () => {
    const plan = planHotkeyDefaultsMigration({
        storedVersion: 0, freshInstall: false,
        settings: loaded(untouched060()), mapHotkeys: legacyMapFile(9)
    });
    for (const value of Object.values(plan.settingChanges)) {
        assert.ok(typeof value === 'string' && value.trim() !== '');
    }
    for (const key of Object.keys(plan.mapHotkeys)) {
        assert.ok(key.startsWith(MAP_HOTKEY_PREFIX), key);
    }
});
