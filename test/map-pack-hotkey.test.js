const {test} = require('node:test');
const assert = require('node:assert');

const {planPackMapHotkey} = require('../src/shared/hotkeys-rules');
const {
    MAP_HOTKEY_PREFIX, MAX_DEFAULT_MAP_HOTKEYS, SYSTEM_HOTKEY_DEFS, ACTION_TO_SETTING_KEY
} = require('../src/shared/hotkeys-constants');
const {DEFAULT_SETTINGS} = require('../src/shared/settings-defaults');

/*
 * A number key for a map that arrived after the first run.
 *
 * `hotkeys.json` is written exactly once, so before this a downloaded map
 * never got a `Ctrl+Alt+N`: the file already existed by the time the pack
 * landed. The decision is pure; `Hotkeys.assignPackMapHotkey` does the writing
 * through the single `hotkeys.json` writer, and `core/map-packs.js` calls it
 * only for keys the catalogue did not already hold.
 */

const KEY = 'someone/New Map';

/** The shipped system map, as `Hotkeys.getSystemHotkeys()` builds it. */
function shippedSystemHotkeys(over) {
    const map = {};
    for (const actionId of Object.keys(SYSTEM_HOTKEY_DEFS)) {
        map[actionId] = DEFAULT_SETTINGS[ACTION_TO_SETTING_KEY[actionId]];
    }
    return Object.assign(map, over || {});
}

/** `hotkeys.json` holding Ctrl+Alt+1..n. */
function bindings(n, startAt) {
    const out = {};
    for (let i = (startAt || 1); i < (startAt || 1) + n; i++) {
        out[`${MAP_HOTKEY_PREFIX}${i}`] = {id: `id-${i}`, mapKey: `c/Map ${i}`};
    }
    return out;
}

function plan(over) {
    return planPackMapHotkey(Object.assign({
        mapKey: KEY,
        fileExists: true,
        mapHotkeys: bindings(4),
        systemHotkeys: shippedSystemHotkeys(),
        offeredKeys: []
    }, over || {}));
}

/* ────────────────────────────────────────────────────────────────────────── */

test('the next free number is handed out', () => {
    const result = plan();
    assert.strictEqual(result.accelerator, `${MAP_HOTKEY_PREFIX}5`);
    assert.strictEqual(result.reason, 'assign');
    assert.ok(result.remember);
    // A gap is filled rather than skipped: the lowest free slot wins.
    const gapped = bindings(4);
    delete gapped[`${MAP_HOTKEY_PREFIX}2`];
    assert.strictEqual(plan({mapHotkeys: gapped}).accelerator, `${MAP_HOTKEY_PREFIX}2`);
});

test('no hotkeys.json yet: nothing is written, and it is not remembered', () => {
    // `loadKeys()` has not run its first-run write (or it failed). Writing here
    // would either race it or leave a file holding *only* the pack map, which
    // `ensureDefaultMapHotkeys` would then never fill in — and the pack map is
    // in the catalogue, so the ordinary first-run path gives it a number.
    const result = plan({fileExists: false, mapHotkeys: {}});
    assert.strictEqual(result.accelerator, null);
    assert.strictEqual(result.reason, 'no-file');
    assert.strictEqual(result.remember, false, 'a race must not be remembered as a decision');
});

test('an existing but EMPTY file means "I cleared them"', () => {
    // A user who deleted every map binding has said what they want; a new map
    // must not re-arm a global accelerator behind them.
    const result = plan({mapHotkeys: {}});
    assert.strictEqual(result.accelerator, null);
    assert.strictEqual(result.reason, 'cleared');
    assert.ok(result.remember, 'and it is never offered again');
});

test('one offer per map, ever', () => {
    // The caller remembers this outside `hotkeys.json`, because the whole
    // point is that a binding the user *deleted* must not come back.
    const result = plan({offeredKeys: ['x/Other', KEY]});
    assert.strictEqual(result.accelerator, null);
    assert.strictEqual(result.reason, 'already-offered');
    assert.strictEqual(result.remember, false, 'it is already in the list');
});

test('a map that already has a binding is left alone', () => {
    const held = Object.assign(bindings(2), {
        [`${MAP_HOTKEY_PREFIX}7`]: {id: 'x', mapKey: KEY}
    });
    const result = plan({mapHotkeys: held});
    assert.strictEqual(result.accelerator, null);
    assert.strictEqual(result.reason, 'already-bound');
    assert.ok(result.remember);
});

test('it can never collide with a system hotkey', () => {
    // A user who put "Rotate map" on Ctrl+Alt+3 must not have it shadowed by a
    // map binding, and the comparison is the project's normalised one — so
    // `ctrl+alt+3` and `CommandOrControl+Alt+3` are the same combination.
    for (const spelling of ['CommandOrControl+Alt+1', 'ctrl+alt+1', 'Alt+Ctrl+1', 'CmdOrCtrl+Alt+1']) {
        const result = plan({
            mapHotkeys: {},
            systemHotkeys: shippedSystemHotkeys({'rotate-map': spelling})
        });
        // The file is empty, so this is the "cleared" rule — use a non-empty
        // one to reach the slot search.
        assert.strictEqual(result.reason, 'cleared', spelling);
    }
    const result = plan({
        mapHotkeys: {[`${MAP_HOTKEY_PREFIX}1`]: {id: 'a', mapKey: 'c/One'}},
        systemHotkeys: shippedSystemHotkeys({'rotate-map': 'shift+ALT+ctrl+2'})
    });
    // 1 is taken by the map binding; 2 is NOT taken — Shift makes it a
    // different combination, exactly as Electron sees it.
    assert.strictEqual(result.accelerator, `${MAP_HOTKEY_PREFIX}2`);

    const blocked = plan({
        mapHotkeys: {[`${MAP_HOTKEY_PREFIX}1`]: {id: 'a', mapKey: 'c/One'}},
        systemHotkeys: shippedSystemHotkeys({'rotate-map': 'alt+ctrl+2'})
    });
    assert.strictEqual(blocked.accelerator, `${MAP_HOTKEY_PREFIX}3`);
});

test('it can never collide with an existing map binding, however it is spelled', () => {
    // JSON allows `Ctrl+Alt+5` and `CommandOrControl+Alt+5` side by side, and
    // Electron considers them one accelerator.
    const held = {
        'ctrl+alt+1': {id: 'a', mapKey: 'c/One'},
        'Alt+CommandOrControl+2': {id: 'b', mapKey: 'c/Two'},
        'CmdOrCtrl+Alt+3': {id: 'c', mapKey: 'c/Three'}
    };
    assert.strictEqual(plan({mapHotkeys: held}).accelerator, `${MAP_HOTKEY_PREFIX}4`);
});

test('an unbound system hotkey does not reserve a number', () => {
    // `''` is not a held accelerator — `boundEntries` drops it — or every
    // unbound action would block a slot.
    const result = plan({
        mapHotkeys: {[`${MAP_HOTKEY_PREFIX}1`]: {id: 'a', mapKey: 'c/One'}},
        systemHotkeys: shippedSystemHotkeys({'rotate-map': '', 'toggle-map': ''})
    });
    assert.strictEqual(result.accelerator, `${MAP_HOTKEY_PREFIX}2`);
});

test('a full number row is simply no offer', () => {
    const full = bindings(MAX_DEFAULT_MAP_HOTKEYS);
    const result = plan({mapHotkeys: full});
    assert.strictEqual(result.accelerator, null);
    assert.strictEqual(result.reason, 'no-free-slot');
    assert.ok(result.remember, 'so a slot freeing up later does not resurrect it');
    // Only the number row is ever handed out.
    assert.strictEqual(Object.keys(full).length, 9);
});

test('rubbish in is no offer, not a throw', () => {
    for (const args of [undefined, {}, {mapKey: ''}, {mapKey: 7, fileExists: true}]) {
        const result = planPackMapHotkey(args);
        assert.strictEqual(result.accelerator, null, JSON.stringify(args));
        assert.strictEqual(result.remember, false);
    }
    // A `hotkeys.json` that parsed to something odd is "cleared", not a crash.
    assert.strictEqual(plan({mapHotkeys: 'nonsense'}).reason, 'cleared');
    assert.strictEqual(plan({mapHotkeys: null}).reason, 'cleared');
    // An entry with no mapKey is still an entry, so the file is not "cleared".
    assert.strictEqual(plan({mapHotkeys: {'Ctrl+Alt+1': null}}).accelerator,
        `${MAP_HOTKEY_PREFIX}2`);
});

test('the slot limit is the documented one, and overridable for a test', () => {
    assert.strictEqual(MAX_DEFAULT_MAP_HOTKEYS, 9);
    const result = plan({mapHotkeys: bindings(2), max: 2});
    assert.strictEqual(result.reason, 'no-free-slot');
    assert.strictEqual(plan({mapHotkeys: bindings(1), max: 2}).accelerator, `${MAP_HOTKEY_PREFIX}2`);
});
