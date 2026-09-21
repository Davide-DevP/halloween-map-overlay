const {test} = require('node:test');
const assert = require('node:assert');

const {
    HOTKEY_DEFAULTS_VERSION,
    LEGACY_SYSTEM_DEFAULTS,
    V070_SYSTEM_DEFAULTS,
    DEFAULT_UNBOUND_ACTIONS,
    LEGACY_MAP_HOTKEY_PREFIX,
    legacyMapNumber,
    planHotkeyDefaultsMigration
} = require('../src/shared/hotkey-migration');
const {
    SYSTEM_HOTKEY_DEFS,
    ACTION_TO_SETTING_KEY,
    MAP_HOTKEY_PREFIX,
    MAX_DEFAULT_MAP_HOTKEYS,
    isUnbound
} = require('../src/shared/hotkeys-constants');
const {DEFAULT_SETTINGS} = require('../src/shared/settings-defaults');
// The real class, for the write-failure sequence at the bottom of this file:
// its constructor needs Electron, but `merge()` is ordinary logic over an
// in-memory object plus one `write()` — the same trick as
// `test/settings-write.test.js`.
const Settings = require('../src/core/settings');

/** `core/hotkeys.js`'s `DEFAULTS_VERSION_KEY`, which cannot be required here. */
const VERSION_KEY = 'hotkeyDefaultsVersion';

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

/**
 * One call with both halves of what `core/settings.js` holds: the back-filled
 * object *and* the raw file, which generation 2 needs to tell "the file holds
 * no key" from "the file stores `''`".
 */
function planFor(file, over) {
    return planHotkeyDefaultsMigration(Object.assign({
        storedVersion: 0,
        freshInstall: false,
        settings: loaded(file || {}),
        fileSettings: Object.assign({}, file || {}),
        mapHotkeys: {}
    }, over || {}));
}

/** The settings keys of the five actions that now ship with no default key. */
const UNBOUND_SETTING_KEYS = DEFAULT_UNBOUND_ACTIONS.map(id => ACTION_TO_SETTING_KEY[id]);

/** What generation 2 writes when the file holds nothing for the five. */
function pinnedChanges(only) {
    const out = {};
    for (const actionId of (only || DEFAULT_UNBOUND_ACTIONS)) {
        out[ACTION_TO_SETTING_KEY[actionId]] = V070_SYSTEM_DEFAULTS[actionId];
    }
    return out;
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
        assert.notStrictEqual(legacy, V070_SYSTEM_DEFAULTS[actionId], actionId);
    }
    assert.strictEqual(HOTKEY_DEFAULTS_VERSION, 2);
    // The shipped default is deliberately behind the current version: that is
    // what makes an old file (back-filled to 0) distinguishable.
    assert.ok(DEFAULT_SETTINGS.hotkeyDefaultsVersion < HOTKEY_DEFAULTS_VERSION);
});

test('the 0.7.0 table is frozen historical data, not the live defaults', () => {
    // Generation 1 moves onto these and generation 2 writes them back out. If
    // it were derived from `SYSTEM_HOTKEY_DEFS` the five that now ship unbound
    // would make generation 1 an *unbind* — a 0.6.0 user upgrading in one step
    // would lose Ctrl+R instead of getting Ctrl+Alt+R.
    assert.deepStrictEqual(Object.keys(V070_SYSTEM_DEFAULTS).sort(),
        Object.keys(SYSTEM_HOTKEY_DEFS).sort());
    for (const accelerator of Object.values(V070_SYSTEM_DEFAULTS)) {
        assert.ok(accelerator && accelerator.startsWith('CommandOrControl+Alt+'), accelerator);
    }
    // Five of them no longer match the live default; the other five still do.
    const same = Object.keys(V070_SYSTEM_DEFAULTS)
        .filter(id => V070_SYSTEM_DEFAULTS[id] === SYSTEM_HOTKEY_DEFS[id].defaultAccelerator);
    assert.deepStrictEqual(same.sort(),
        ['clear-map', 'next-map', 'prev-map', 'toggle-map', 'toggle-markers']);
});

test('the generation-2 list is exactly the actions that now ship unbound', () => {
    // The guard that makes unbinding a sixth default impossible to do quietly:
    // a new default with no key and no new generation fails here, which is the
    // reminder that an existing install still has to keep its binding.
    const shipUnbound = Object.entries(SYSTEM_HOTKEY_DEFS)
        .filter(([, def]) => isUnbound(def.defaultAccelerator)).map(([id]) => id);
    assert.deepStrictEqual([...DEFAULT_UNBOUND_ACTIONS].sort(), shipUnbound.sort());
    assert.deepStrictEqual([...DEFAULT_UNBOUND_ACTIONS],
        ['rotate-map', 'opacity-up', 'opacity-down', 'size-up', 'size-down']);
    // Every one of them has a 0.7.0 value to write back out.
    for (const actionId of DEFAULT_UNBOUND_ACTIONS) {
        assert.ok(V070_SYSTEM_DEFAULTS[actionId], actionId);
        assert.ok(ACTION_TO_SETTING_KEY[actionId], actionId);
    }
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
    const result = planFor({}, {freshInstall: true});
    assert.strictEqual(result.migrated, false);
    // Nothing beyond the stamp: the five that ship with no key stay that way,
    // which is the whole point of a *new* installation.
    assert.deepStrictEqual(result.settingChanges, {});
    assert.deepStrictEqual(result.pinned, []);
    assert.strictEqual(result.mapChanged, false);
    assert.deepStrictEqual(result.moved, []);
    // Stamped so the next start does not look at it again.
    assert.strictEqual(result.stamp, true);
    assert.strictEqual(result.version, HOTKEY_DEFAULTS_VERSION);
});

test('an untouched 0.6.0 install moves every system hotkey and every number', () => {
    const plan = planHotkeyDefaultsMigration({
        storedVersion: 0,
        freshInstall: false,
        settings: loaded(untouched060()),
        fileSettings: untouched060(),
        mapHotkeys: legacyMapFile(4)
    });

    assert.strictEqual(plan.migrated, true);
    assert.deepStrictEqual(plan.blocked, []);
    // Every system action that 0.6.0 had lands on its **0.7.0** default — not
    // on the live one, or the five that now ship unbound would be unbound here
    // instead of moved. Nothing is pinned, because every one of them moved.
    const expected = {};
    for (const actionId of Object.keys(SYSTEM_HOTKEY_DEFS)) {
        if (ADDED_AFTER_060.includes(actionId)) continue;
        expected[ACTION_TO_SETTING_KEY[actionId]] = V070_SYSTEM_DEFAULTS[actionId];
    }
    assert.deepStrictEqual(plan.settingChanges, expected);
    assert.deepStrictEqual(plan.pinned, []);
    for (const actionId of DEFAULT_UNBOUND_ACTIONS) {
        assert.strictEqual(plan.settingChanges[ACTION_TO_SETTING_KEY[actionId]],
            V070_SYSTEM_DEFAULTS[actionId], actionId);
    }
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
    const plan = planFor(file);
    assert.ok(!('hotkeyRotateMap' in plan.settingChanges));
    assert.ok(!('hotkeyToggleMap' in plan.settingChanges));
    // The seven nobody touched still move…
    assert.strictEqual(Object.keys(plan.settingChanges).length, 7);
    assert.strictEqual(plan.migrated, true);
    // …and rotate is not *pinned* back onto Ctrl+Alt+R either: Alt+K is what
    // the user chose, and it is still a working binding.
    assert.deepStrictEqual(plan.pinned, []);
});

test('an unbound hotkey stays unbound', () => {
    const file = untouched060();
    file.hotkeyClearMap = '';
    file.hotkeySizeUp = '   ';
    const plan = planFor(file);
    assert.ok(!('hotkeyClearMap' in plan.settingChanges));
    assert.ok(!('hotkeySizeUp' in plan.settingChanges));
    assert.strictEqual(Object.keys(plan.settingChanges).length, 7);
    // `size-up` is one of the five that now ship with no key, so generation 2
    // could have written its old default back — but the file *holds* a value,
    // and a stored value is the user's own decision whatever it says.
    assert.deepStrictEqual(plan.pinned, []);
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
    const file = untouched060();
    const settings = loaded(file);
    const first = planHotkeyDefaultsMigration({
        storedVersion: 0, freshInstall: false, settings, fileSettings: file,
        mapHotkeys: legacyMapFile(4)
    });
    assert.strictEqual(first.migrated, true);

    // Apply it, exactly as `Hotkeys.migrateDefaultHotkeys()` does — to the file
    // as well, because `Settings.write()` persists the whole object.
    Object.assign(settings, first.settingChanges);
    Object.assign(file, first.settingChanges);
    settings.hotkeyDefaultsVersion = first.version;

    const second = planHotkeyDefaultsMigration({
        storedVersion: settings.hotkeyDefaultsVersion,
        freshInstall: false,
        settings,
        fileSettings: file,
        mapHotkeys: first.mapHotkeys
    });
    assert.strictEqual(second.migrated, false);
    assert.strictEqual(second.stamp, false);
    assert.deepStrictEqual(second.settingChanges, {});
    assert.deepStrictEqual(second.pinned, []);
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
    const plan = planFor(file);
    assert.strictEqual(plan.settingChanges.hotkeyRotateMap, 'CommandOrControl+Alt+R');
    assert.strictEqual(plan.settingChanges.hotkeyToggleMap, 'CommandOrControl+Alt+H');
    // Rotate *moved*; the other four of the five are absent from this file, so
    // generation 2 pins them instead — one composed run, two mechanisms.
    assert.deepStrictEqual(plan.pinned.map(p => p.id),
        ['opacity-up', 'opacity-down', 'size-up', 'size-down']);
    assert.deepStrictEqual(
        Object.fromEntries(Object.entries(plan.settingChanges)
            .filter(([key]) => UNBOUND_SETTING_KEYS.includes(key))),
        pinnedChanges());
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
    // Including generation 2, which is the one that could have written `''`:
    // it never does — it either writes a real combination or leaves the action
    // alone, so `settingChanges` can go straight to `globalShortcut.register`.
    for (const file of [untouched060(), {}]) {
        const plan = planFor(file, {mapHotkeys: legacyMapFile(9)});
        for (const value of Object.values(plan.settingChanges)) {
            assert.ok(typeof value === 'string' && value.trim() !== '', JSON.stringify(value));
        }
        for (const key of Object.keys(plan.mapHotkeys)) {
            assert.ok(key.startsWith(MAP_HOTKEY_PREFIX), key);
        }
    }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Generation 2: five actions stopped shipping with a default key
 *
 * The rule: a **new** installation gets none of the five, and every install
 * that is not new keeps exactly what it had. The discriminator is the raw file
 * — after the back-fill, "the file holds no key for rotate" and "the file
 * stores `''` for rotate" are the same `''`, and the second one is a user
 * decision that must survive.
 * ──────────────────────────────────────────────────────────────────────────── */

test('a 0.7.0 file that stores the old defaults keeps them and is not rewritten', () => {
    // The common upgrade: `Settings.write()` persists the whole back-filled
    // object, so a 0.7.0 install has all ten accelerators on disk. Nothing has
    // to change — `resolveSystemAccelerator` reads the stored value.
    const file = {hotkeyDefaultsVersion: 1};
    for (const [actionId, accelerator] of Object.entries(V070_SYSTEM_DEFAULTS)) {
        file[ACTION_TO_SETTING_KEY[actionId]] = accelerator;
    }
    const plan = planFor(file, {storedVersion: 1});
    assert.deepStrictEqual(plan.settingChanges, {});
    assert.deepStrictEqual(plan.pinned, []);
    assert.deepStrictEqual(plan.moved, []);
    assert.deepStrictEqual(plan.blocked, []);
    assert.strictEqual(plan.migrated, false);
    // Only the stamp moves, so the next start stops looking.
    assert.strictEqual(plan.stamp, true);
});

test('a 0.7.0 file with no key for the five gets the old defaults written out', () => {
    // The case the version bump exists for: with nothing stored, the *new*
    // back-fill hands `''` back and rotate would silently stop working. The old
    // default is written explicitly instead.
    const plan = planFor({hotkeyDefaultsVersion: 1}, {storedVersion: 1});
    assert.deepStrictEqual(plan.settingChanges, pinnedChanges());
    assert.deepStrictEqual(plan.pinned.map(p => p.id), [...DEFAULT_UNBOUND_ACTIONS]);
    assert.deepStrictEqual(plan.pinned.map(p => p.to),
        DEFAULT_UNBOUND_ACTIONS.map(id => V070_SYSTEM_DEFAULTS[id]));
    // A pin is **not** a move: `migrated` drives the "your defaults moved"
    // notice, and nothing moved — the user's keys are exactly where they were.
    assert.deepStrictEqual(plan.moved, []);
    assert.strictEqual(plan.migrated, false);
    assert.strictEqual(plan.stamp, true);
});

test('a rebound or deliberately unbound one of the five is left alone', () => {
    const file = {
        hotkeyDefaultsVersion: 1,
        hotkeyRotateMap: 'Alt+F9',   // rebound
        hotkeyOpacityUp: '',         // deliberately unbound
        hotkeySizeUp: '   '          // ditto, whitespace
        // opacity-down and size-down absent → pinned
    };
    const plan = planFor(file, {storedVersion: 1});
    assert.deepStrictEqual(plan.pinned.map(p => p.id), ['opacity-down', 'size-down']);
    assert.deepStrictEqual(plan.settingChanges,
        pinnedChanges(['opacity-down', 'size-down']));
    assert.ok(!('hotkeyRotateMap' in plan.settingChanges));
    assert.ok(!('hotkeyOpacityUp' in plan.settingChanges));
    assert.ok(!('hotkeySizeUp' in plan.settingChanges));
});

test('a pin that would collide is dropped, and the action stays unbound', () => {
    const file = {
        hotkeyDefaultsVersion: 1,
        // The user parked "clear map" on what rotate is about to be pinned to…
        hotkeyClearMap: 'ctrl+alt+r'
    };
    // …and a map binding sits on the old opacity-up default, in another spelling.
    const maps = {'alt+ctrl+up': {id: 'm1', mapKey: 'x/y'}};
    const plan = planFor(file, {storedVersion: 1, mapHotkeys: maps});

    assert.ok(!('hotkeyRotateMap' in plan.settingChanges), 'rotate must stay unbound');
    assert.ok(!('hotkeyOpacityUp' in plan.settingChanges), 'opacity-up must stay unbound');
    assert.deepStrictEqual(plan.pinned.map(p => p.id), ['opacity-down', 'size-up', 'size-down']);
    assert.deepStrictEqual(plan.blocked.map(b => b.reason).sort(),
        ['map:alt+ctrl+up', 'system:clear-map']);
    for (const entry of plan.blocked) assert.strictEqual(entry.kind, 'system');
});

test('two pins can never land on one combination', () => {
    // `effective` is updated as each pin is applied, which is what stops the
    // second one from being written onto the first. The five 0.7.0 values are
    // distinct, so this asserts the mechanism rather than an accident.
    const plan = planFor({hotkeyDefaultsVersion: 1}, {storedVersion: 1});
    const written = Object.values(plan.settingChanges);
    assert.strictEqual(new Set(written).size, written.length);
    assert.strictEqual(written.length, 5);
});

test('running generation 2 twice writes nothing the second time', () => {
    const file = {hotkeyDefaultsVersion: 1};
    const first = planFor(file, {storedVersion: 1});
    assert.strictEqual(first.pinned.length, 5);

    Object.assign(file, first.settingChanges);
    file.hotkeyDefaultsVersion = first.version;
    const second = planFor(file, {storedVersion: file.hotkeyDefaultsVersion});
    assert.strictEqual(second.stamp, false);
    assert.deepStrictEqual(second.settingChanges, {});
    assert.deepStrictEqual(second.pinned, []);
});

test('a 0.6.0 install upgrading straight to generation 2 keeps every binding', () => {
    // 0 → 2 in one start: generation 1 moves the nine 0.6.0 defaults, and
    // generation 2 finds the five already bound and does nothing. The net
    // effect for the user is the 0.7.0 set, unchanged.
    const file = untouched060();
    const plan = planFor(file, {storedVersion: 0, mapHotkeys: legacyMapFile(4)});

    assert.strictEqual(plan.migrated, true);
    assert.deepStrictEqual(plan.pinned, []);
    assert.deepStrictEqual(plan.blocked, []);
    for (const actionId of DEFAULT_UNBOUND_ACTIONS) {
        assert.strictEqual(plan.settingChanges[ACTION_TO_SETTING_KEY[actionId]],
            V070_SYSTEM_DEFAULTS[actionId], actionId);
    }
    // One stamp for both generations, so neither runs again.
    assert.strictEqual(plan.version, 2);
    assert.strictEqual(plan.stamp, true);

    // And the composed result is stable: apply it, run again, nothing happens.
    Object.assign(file, plan.settingChanges);
    file.hotkeyDefaultsVersion = plan.version;
    const again = planFor(file, {storedVersion: 2, mapHotkeys: plan.mapHotkeys});
    assert.strictEqual(again.stamp, false);
    assert.deepStrictEqual(again.settingChanges, {});
    assert.deepStrictEqual(again.pinned, []);
});

test('a 0.6.0 move that is blocked is not then pinned on top of it', () => {
    // Generation 1 could not move rotate off Ctrl+R (clear-map is parked on
    // Ctrl+Alt+R), so rotate is still bound — to the *old* combination. That is
    // a working binding, so generation 2 leaves it: pinning would be a second
    // attempt at the move generation 1 just refused.
    const file = untouched060();
    file.hotkeyClearMap = 'Ctrl+Alt+R';
    const plan = planFor(file, {storedVersion: 0});
    assert.ok(!('hotkeyRotateMap' in plan.settingChanges));
    assert.deepStrictEqual(plan.pinned, []);
    assert.ok(plan.blocked.some(b => b.id === 'rotate-map' && b.reason === 'system:clear-map'));
});

test('a fresh install is never pinned, whatever the stored version says', () => {
    for (const storedVersion of [0, 1]) {
        const plan = planFor({}, {freshInstall: true, storedVersion});
        assert.deepStrictEqual(plan.settingChanges, {}, String(storedVersion));
        assert.deepStrictEqual(plan.pinned, [], String(storedVersion));
    }
});

test('without the raw file nothing is pinned, rather than an unbind undone', () => {
    // `fileSettings` is how "no key" is told from a stored `''`. A caller that
    // cannot supply it (a test, an older call site) must degrade to the safe
    // direction: leave every one of the five as it reads. Un-unbinding an
    // action the user switched off would be the worse mistake.
    const plan = planHotkeyDefaultsMigration({
        storedVersion: 1, freshInstall: false, settings: loaded({}), mapHotkeys: {}
    });
    assert.deepStrictEqual(plan.settingChanges, {});
    assert.deepStrictEqual(plan.pinned, []);
    assert.strictEqual(plan.stamp, true);
});

test('a non-string in the file is an absence, so the old default is pinned', () => {
    // The same three-way rule `resolveSystemAccelerator` enforces: only a
    // string carries intent, so `null` in a hand-edited file is nothing stored.
    for (const junk of [null, 0, false, {}, []]) {
        const plan = planFor({hotkeyDefaultsVersion: 1, hotkeyRotateMap: junk}, {storedVersion: 1});
        assert.strictEqual(plan.settingChanges.hotkeyRotateMap,
            V070_SYSTEM_DEFAULTS['rotate-map'], JSON.stringify(junk));
    }
});

/** The full ten-key object a 0.7.0 install really has on disk. */
function fullV070File() {
    const file = {[VERSION_KEY]: 1};
    for (const [actionId, accelerator] of Object.entries(V070_SYSTEM_DEFAULTS)) {
        file[ACTION_TO_SETTING_KEY[actionId]] = accelerator;
    }
    return file;
}

test('a stored empty string is never pinned over, in any state whatsoever', () => {
    // The guarantee a deliberate unbind rests on. Asserted across every input
    // that could tempt a "recover it anyway" heuristic — because after the fact
    // **nothing distinguishes** a deliberate unbind from an accidental one,
    // which is exactly why the write side must never create one.
    for (const base of [{[VERSION_KEY]: 1}, {}, {[VERSION_KEY]: 0}, untouched060(), fullV070File()]) {
        for (const storedVersion of [0, 1]) {
            for (const freshInstall of [false, true]) {
                const file = Object.assign({}, base);
                // All five unbound at once: the shape a rolled-back pin used to
                // leave behind, and the shape of a user who switched all five
                // off by hand. They are the same file.
                for (const key of UNBOUND_SETTING_KEYS) file[key] = '';
                const plan = planFor(file, {storedVersion, freshInstall});
                const label = `${storedVersion}/${freshInstall}`;
                assert.deepStrictEqual(plan.pinned, [], label);
                for (const key of UNBOUND_SETTING_KEYS) {
                    assert.ok(!(key in plan.settingChanges), `${label} ${key}`);
                }
            }
        }
    }
});

test('the stamp and the pins are inseparable, so one merge carries both', () => {
    // `core/hotkeys.js` writes `settingChanges` + the stamp in a single
    // `merge()`. That is no longer only the "two writes at most" rule: a stamp
    // that could reach the disk without its pins *is* the permanent unbind.
    const plan = planFor({[VERSION_KEY]: 1}, {storedVersion: 1});
    assert.strictEqual(plan.stamp, true);
    assert.strictEqual(plan.pinned.length, 5);
    for (const entry of plan.pinned) {
        assert.strictEqual(plan.settingChanges[ACTION_TO_SETTING_KEY[entry.id]], entry.to, entry.id);
    }
});

/* ────────────────────────────────────────────────────────────────────────────
 * The write that fails
 *
 * The real `Settings.merge()` over a "disk" object that can refuse a write, so
 * the rollback rule under test is the shipped one rather than a model of it.
 * `write()` serialises the **whole** in-memory object — which is how a later
 * `set()` of an unrelated key persists everything sitting in memory, and the
 * step that turned one transient failure into a permanent unbind.
 * ──────────────────────────────────────────────────────────────────────────── */

/** One start of the app against `disk`, built the way `core/settings.js` does. */
function install(disk, writeOk) {
    const settings = Object.create(Settings.prototype);
    settings.notifier = null;
    settings.lastWarnAt = 0;
    settings.freshInstall = false;
    settings.fileSettings = Object.assign({}, disk);   // raw, before the back-fill
    settings.settings = loaded(disk);
    settings.writeOk = writeOk !== false;
    settings.write = function () {
        if (!this.writeOk) return false;
        for (const key of Object.keys(disk)) delete disk[key];
        Object.assign(disk, JSON.parse(JSON.stringify(this.settings)));
        return true;
    };
    return settings;
}

/**
 * `Hotkeys.migrateDefaultHotkeys()`'s settings half, verbatim.
 * @param {Object} [options] passed to `merge()`; the real call passes none, and
 *   `{rollback: true}` is only here to show what it would cost.
 */
function runMigration(settings, mapHotkeys, options) {
    const plan = planHotkeyDefaultsMigration({
        storedVersion: settings.get(VERSION_KEY),
        freshInstall: !!settings.freshInstall,
        settings: settings.settings,
        fileSettings: settings.fileSettings,
        mapHotkeys: mapHotkeys || {}
    });
    const changes = Object.assign({}, plan.settingChanges);
    if (plan.stamp) changes[VERSION_KEY] = plan.version;
    if (Object.keys(changes).length) settings.merge(changes, options);
    return plan;
}

test('a failed pin write is kept in memory and lands on the next write', () => {
    // The 0.7.0 file generation 2 exists for: stamped 1, and no key at all for
    // the five (never written since, or hand-trimmed).
    const disk = {[VERSION_KEY]: 1, hotkeyToggleMap: 'CommandOrControl+Alt+H'};
    const first = install(disk, false);                 // the disk refuses
    const plan = runMigration(first, {});
    assert.strictEqual(plan.pinned.length, 5);

    // Nothing reached the disk — neither the pins nor the stamp.
    assert.strictEqual(disk.hotkeyRotateMap, undefined);
    assert.strictEqual(disk[VERSION_KEY], 1);
    // But memory holds the real combinations, **not** `''`: this session keeps
    // its hotkeys, and there is no unbind for a later write to persist.
    for (const actionId of DEFAULT_UNBOUND_ACTIONS) {
        assert.strictEqual(first.get(ACTION_TO_SETTING_KEY[actionId]),
            V070_SYSTEM_DEFAULTS[actionId], actionId);
    }

    // Any later successful write serialises the whole object.
    first.writeOk = true;
    assert.strictEqual(first.merge({size: 300}), true);
    assert.strictEqual(disk.hotkeyRotateMap, V070_SYSTEM_DEFAULTS['rotate-map']);
    assert.strictEqual(disk[VERSION_KEY], HOTKEY_DEFAULTS_VERSION);

    // Next start: nothing left to do, and the five are still bound.
    const second = install(disk, true);
    const again = runMigration(second, {});
    assert.strictEqual(again.stamp, false);
    assert.deepStrictEqual(again.pinned, []);
    assert.deepStrictEqual(again.settingChanges, {});
    for (const actionId of DEFAULT_UNBOUND_ACTIONS) {
        assert.strictEqual(second.get(ACTION_TO_SETTING_KEY[actionId]),
            V070_SYSTEM_DEFAULTS[actionId], actionId);
    }
});

test('a failed pin write with no later write is simply retried next start', () => {
    const disk = {[VERSION_KEY]: 1};
    const first = install(disk, false);
    assert.strictEqual(runMigration(first, {}).pinned.length, 5);
    assert.deepStrictEqual(Object.keys(disk), [VERSION_KEY]);

    // The plan is recomputed from disk, so the second attempt is the first one.
    const second = install(disk, true);
    assert.strictEqual(runMigration(second, {}).pinned.length, 5);
    assert.strictEqual(disk.hotkeyRotateMap, V070_SYSTEM_DEFAULTS['rotate-map']);
    assert.strictEqual(disk[VERSION_KEY], HOTKEY_DEFAULTS_VERSION);
});

test('rolling the pins back would make one failed write a permanent unbind', () => {
    // Why the migration's `merge()` is the one writer in the app with **no**
    // `rollback`. There is no "absent" for a rollback to restore: the back-fill
    // already put `''` in memory, so rolling back *stores an unbind*.
    const disk = {[VERSION_KEY]: 1};
    const bad = install(disk, false);
    assert.strictEqual(runMigration(bad, {}, {rollback: true}).pinned.length, 5);
    assert.strictEqual(bad.get('hotkeyRotateMap'), '', 'rollback restores the back-filled ""');

    // One unrelated successful write and the unbind is on disk, with no stamp.
    bad.writeOk = true;
    bad.merge({size: 300});
    assert.strictEqual(disk.hotkeyRotateMap, '');
    assert.strictEqual(disk[VERSION_KEY], 1, 'the stamp was rolled back too');

    // The next start reads a stored string, so it pins nothing — and stamps, so
    // it never looks again. Five hotkeys gone, silently, for good.
    const next = install(disk, true);
    const plan = runMigration(next, {});
    assert.deepStrictEqual(plan.pinned, []);
    assert.strictEqual(plan.stamp, true);
    assert.strictEqual(next.get('hotkeyRotateMap'), '');
    assert.strictEqual(disk[VERSION_KEY], HOTKEY_DEFAULTS_VERSION);
});

test('a deliberate unbind survives the pipeline, failed write or not', () => {
    for (const writeOk of [true, false]) {
        // A 0.7.0 install — the full ten-key object — with rotate switched off
        // by hand. Byte for byte the shape the bug above produced, which is why
        // the fix is at the write and not a heuristic in the plan.
        const disk = fullV070File();
        disk.hotkeyRotateMap = '';
        const settings = install(disk, writeOk);
        const plan = runMigration(settings, {});

        assert.deepStrictEqual(plan.pinned, [], String(writeOk));
        assert.strictEqual(settings.get('hotkeyRotateMap'), '', String(writeOk));
        // The other four are stored values, so they are left alone as well.
        for (const actionId of DEFAULT_UNBOUND_ACTIONS.filter(id => id !== 'rotate-map')) {
            assert.strictEqual(settings.get(ACTION_TO_SETTING_KEY[actionId]),
                V070_SYSTEM_DEFAULTS[actionId], actionId);
        }
        if (writeOk) assert.strictEqual(disk.hotkeyRotateMap, '');
    }
});

test('an upgrade from 0.6.0 whose write fails still ends with every binding', () => {
    // Both generations in one start against a disk that refuses the first
    // write: generation 1 moves the nine, generation 2 pins nothing (they are
    // bound), and a later write persists the lot.
    const disk = untouched060();
    const first = install(disk, false);
    const plan = runMigration(first, {});
    assert.strictEqual(plan.migrated, true);
    assert.deepStrictEqual(plan.pinned, []);
    assert.strictEqual(first.get('hotkeyRotateMap'), V070_SYSTEM_DEFAULTS['rotate-map']);

    first.writeOk = true;
    first.merge({size: 300});
    const second = install(disk, true);
    const again = runMigration(second, {});
    assert.strictEqual(again.stamp, false);
    assert.deepStrictEqual(again.settingChanges, {});
    for (const [actionId, accelerator] of Object.entries(V070_SYSTEM_DEFAULTS)) {
        if (actionId === 'toggle-markers') continue;   // no 0.6.0 value to move
        assert.strictEqual(second.get(ACTION_TO_SETTING_KEY[actionId]), accelerator, actionId);
    }
});
