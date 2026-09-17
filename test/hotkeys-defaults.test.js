const {test} = require('node:test');
const assert = require('node:assert');
const {
    SYSTEM_HOTKEY_DEFS,
    ACTION_TO_SETTING_KEY,
    DEFAULT_MAP_HOTKEY_ORDER,
    buildDefaultMapHotkeys,
    acceleratorToDisplay,
    acceleratorKeyName,
    keyEventToAccelerator
} = require('../src/shared/hotkeys-constants');
const {buildCatalog} = require('../src/core/map-catalog');

const catalog = buildCatalog([
    'deftyconchgaming/East Haddonfield.png',
    'deftyconchgaming/Haddonfield Heights.png',
    'deftyconchgaming/Haddonfield Town Center.png',
    'deftyconchgaming/Orange Grove Estates.png'
]);

// Deterministic id generator so the expected output is exact.
function counter() {
    let n = 0;
    return () => `id-${++n}`;
}

test('the four system hotkeys are the documented ones', () => {
    assert.deepStrictEqual(Object.keys(SYSTEM_HOTKEY_DEFS), ['toggle-map', 'rotate-map', 'next-map', 'prev-map']);
    assert.strictEqual(SYSTEM_HOTKEY_DEFS['toggle-map'].defaultAccelerator, 'CommandOrControl+H');
    assert.strictEqual(SYSTEM_HOTKEY_DEFS['rotate-map'].defaultAccelerator, 'CommandOrControl+R');
    assert.strictEqual(SYSTEM_HOTKEY_DEFS['next-map'].defaultAccelerator, 'CommandOrControl+Right');
    assert.strictEqual(SYSTEM_HOTKEY_DEFS['prev-map'].defaultAccelerator, 'CommandOrControl+Left');
});

test('every system action persists under its own settings key', () => {
    assert.deepStrictEqual(Object.keys(ACTION_TO_SETTING_KEY).sort(), Object.keys(SYSTEM_HOTKEY_DEFS).sort());
    const settingKeys = Object.values(ACTION_TO_SETTING_KEY);
    assert.strictEqual(new Set(settingKeys).size, settingKeys.length);
});

test('each system action fires the IPC event named by its definition', () => {
    for (const [actionId, def] of Object.entries(SYSTEM_HOTKEY_DEFS)) {
        assert.strictEqual(def.id, actionId);
        assert.ok(def.action, `${actionId} has no action`);
    }
});

test('first-run defaults bind Ctrl+1..Ctrl+4 in the documented map order', () => {
    const defaults = buildDefaultMapHotkeys(catalog, counter());
    assert.deepStrictEqual(defaults, {
        'CommandOrControl+1': {id: 'id-1', mapKey: 'deftyconchgaming/East Haddonfield'},
        'CommandOrControl+2': {id: 'id-2', mapKey: 'deftyconchgaming/Haddonfield Heights'},
        'CommandOrControl+3': {id: 'id-3', mapKey: 'deftyconchgaming/Orange Grove Estates'},
        'CommandOrControl+4': {id: 'id-4', mapKey: 'deftyconchgaming/Haddonfield Town Center'}
    });
    assert.deepStrictEqual(DEFAULT_MAP_HOTKEY_ORDER, [
        'East Haddonfield',
        'Haddonfield Heights',
        'Orange Grove Estates',
        'Haddonfield Town Center'
    ]);
});

test('defaults never collide with a system hotkey', () => {
    const defaults = buildDefaultMapHotkeys(catalog, counter());
    const system = new Set(Object.values(SYSTEM_HOTKEY_DEFS).map(d => d.defaultAccelerator));
    for (const accel of Object.keys(defaults)) {
        assert.ok(!system.has(accel), `${accel} collides with a system hotkey`);
    }
});

test('a missing map leaves no gap in the numbering', () => {
    const partial = buildCatalog(['deftyconchgaming/East Haddonfield.png', 'deftyconchgaming/Orange Grove Estates.png']);
    assert.deepStrictEqual(buildDefaultMapHotkeys(partial, counter()), {
        'CommandOrControl+1': {id: 'id-1', mapKey: 'deftyconchgaming/East Haddonfield'},
        'CommandOrControl+2': {id: 'id-2', mapKey: 'deftyconchgaming/Orange Grove Estates'}
    });
});

test('custom maps never get a default binding', () => {
    const withCustom = catalog.concat([
        {key: 'Custom/East Haddonfield', creator: 'Custom', name: 'East Haddonfield', file: 'East Haddonfield.png', custom: true}
    ]);
    const defaults = buildDefaultMapHotkeys(withCustom, counter());
    assert.strictEqual(defaults['CommandOrControl+1'].mapKey, 'deftyconchgaming/East Haddonfield');
    assert.strictEqual(Object.keys(defaults).length, 4);
});

test('an empty catalogue produces no bindings', () => {
    assert.deepStrictEqual(buildDefaultMapHotkeys([], counter()), {});
    assert.deepStrictEqual(buildDefaultMapHotkeys(null, counter()), {});
});

test('accelerator display conversion', () => {
    assert.strictEqual(acceleratorToDisplay('CommandOrControl+Shift+P'), 'Ctrl + Shift + P');
    assert.strictEqual(acceleratorToDisplay('CommandOrControl+Right'), 'Ctrl + Right');
    assert.strictEqual(acceleratorToDisplay(''), '');
});

// ─── Key capture ───────────────────────────────────────────────
//
// globalShortcut.register THROWS on an accelerator it cannot parse, and a
// throw inside loadKeys aborts every registration after it. These names are
// therefore the difference between "one hotkey did not take" and "no hotkey
// works any more, on every future boot".

test('acceleratorKeyName maps browser key names Electron does not know', () => {
    assert.strictEqual(acceleratorKeyName('ArrowRight'), 'Right');
    assert.strictEqual(acceleratorKeyName('ArrowLeft'), 'Left');
    assert.strictEqual(acceleratorKeyName('ArrowUp'), 'Up');
    assert.strictEqual(acceleratorKeyName('ArrowDown'), 'Down');
    assert.strictEqual(acceleratorKeyName(' '), 'Space');
    assert.strictEqual(acceleratorKeyName('+'), 'Plus');
    assert.strictEqual(acceleratorKeyName('Escape'), 'Esc');
    assert.strictEqual(acceleratorKeyName('Enter'), 'Return');
});

test('acceleratorKeyName passes through the names Electron already accepts', () => {
    for (const key of ['Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown']) {
        assert.strictEqual(acceleratorKeyName(key), key);
    }
    assert.strictEqual(acceleratorKeyName('F1'), 'F1');
    assert.strictEqual(acceleratorKeyName('F24'), 'F24');
    assert.strictEqual(acceleratorKeyName('a'), 'A');
    assert.strictEqual(acceleratorKeyName('Z'), 'Z');
    assert.strictEqual(acceleratorKeyName('7'), '7');
    assert.strictEqual(acceleratorKeyName('-'), '-');
    assert.strictEqual(acceleratorKeyName('/'), '/');
});

test('acceleratorKeyName rejects modifiers and anything unmapped', () => {
    for (const key of ['Control', 'Shift', 'Alt', 'Meta', 'AltGraph']) {
        assert.strictEqual(acceleratorKeyName(key), null);
    }
    assert.strictEqual(acceleratorKeyName('F25'), null);
    assert.strictEqual(acceleratorKeyName('Unidentified'), null);
    assert.strictEqual(acceleratorKeyName('Dead'), null);
    assert.strictEqual(acceleratorKeyName('ContextMenu'), null);
    assert.strictEqual(acceleratorKeyName(''), null);
    assert.strictEqual(acceleratorKeyName(null), null);
    assert.strictEqual(acceleratorKeyName(undefined), null);
});

test('keyEventToAccelerator produces a registrable accelerator', () => {
    assert.deepStrictEqual(
        keyEventToAccelerator({ctrlKey: true, key: 'ArrowRight'}),
        {status: 'ok', accelerator: 'CommandOrControl+Right', display: 'Ctrl + Right', key: 'Right'}
    );
    assert.strictEqual(
        keyEventToAccelerator({ctrlKey: true, shiftKey: true, key: 'h'}).accelerator,
        'CommandOrControl+Shift+H'
    );
    assert.strictEqual(
        keyEventToAccelerator({altKey: true, key: ' '}).accelerator,
        'Alt+Space'
    );
    assert.strictEqual(
        keyEventToAccelerator({ctrlKey: true, altKey: true, shiftKey: true, metaKey: true, key: '1'}).accelerator,
        'CommandOrControl+Super+Alt+Shift+1'
    );
});

test('keyEventToAccelerator: modifiers alone stay pending, never stored', () => {
    const pending = keyEventToAccelerator({ctrlKey: true, key: 'Control'});
    assert.strictEqual(pending.status, 'pending');
    assert.strictEqual(pending.accelerator, '');
    assert.strictEqual(keyEventToAccelerator({key: ''}).status, 'pending');
    assert.strictEqual(keyEventToAccelerator({}).status, 'pending');
});

test('keyEventToAccelerator requires a modifier, so no bare key is bound globally', () => {
    const bare = keyEventToAccelerator({key: 'w'});
    assert.strictEqual(bare.status, 'no-modifier');
    assert.strictEqual(bare.accelerator, '');
    assert.strictEqual(keyEventToAccelerator({key: 'ArrowRight'}).status, 'no-modifier');
});

test('keyEventToAccelerator refuses keys Electron cannot parse', () => {
    const bad = keyEventToAccelerator({ctrlKey: true, key: 'Unidentified'});
    assert.strictEqual(bad.status, 'unsupported');
    assert.strictEqual(bad.accelerator, '');
    assert.strictEqual(keyEventToAccelerator({ctrlKey: true, key: 'F25'}).status, 'unsupported');
});

test('no accelerator ever carries a raw browser key name', () => {
    const events = [
        {ctrlKey: true, key: 'ArrowRight'}, {ctrlKey: true, key: 'ArrowLeft'},
        {ctrlKey: true, key: 'ArrowUp'}, {ctrlKey: true, key: 'ArrowDown'},
        {ctrlKey: true, key: ' '}, {ctrlKey: true, key: '+'},
        {ctrlKey: true, key: 'Escape'}, {ctrlKey: true, key: 'Enter'}
    ];
    for (const event of events) {
        const {accelerator} = keyEventToAccelerator(event);
        assert.ok(accelerator, `${event.key} produced no accelerator`);
        assert.ok(!/Arrow/.test(accelerator), `${accelerator} still contains a browser key name`);
        // A trailing or doubled separator is what made register() throw
        assert.ok(!/\+$/.test(accelerator), `${accelerator} ends in a separator`);
        assert.ok(!/\+\s|\s\+/.test(accelerator), `${accelerator} contains a spaced separator`);
        assert.ok(!accelerator.includes('++'), `${accelerator} contains an empty segment`);
    }
});
