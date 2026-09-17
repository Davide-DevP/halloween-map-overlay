const {test} = require('node:test');
const assert = require('node:assert');
const {
    SYSTEM_HOTKEY_DEFS,
    ACTION_TO_SETTING_KEY,
    MAX_DEFAULT_MAP_HOTKEYS,
    buildDefaultMapHotkeys,
    acceleratorToDisplay,
    acceleratorKeyName,
    keyEventToAccelerator,
    hasModifier,
    OPACITY_STEP,
    OPACITY_MIN,
    OPACITY_MAX,
    SIZE_STEP,
    SIZE_MIN,
    SIZE_MAX,
    stepOpacity,
    stepSize
} = require('../src/shared/hotkeys-constants');
const {buildCatalog} = require('../src/core/map-catalog');
const {DEFAULT_SETTINGS} = require('../src/shared/settings-defaults');

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

test('the system hotkeys are the documented ones', () => {
    assert.deepStrictEqual(Object.keys(SYSTEM_HOTKEY_DEFS),
        ['toggle-map', 'rotate-map', 'next-map', 'prev-map', 'clear-map',
            'opacity-up', 'opacity-down', 'size-up', 'size-down']);
    assert.strictEqual(SYSTEM_HOTKEY_DEFS['toggle-map'].defaultAccelerator, 'CommandOrControl+H');
    assert.strictEqual(SYSTEM_HOTKEY_DEFS['rotate-map'].defaultAccelerator, 'CommandOrControl+R');
    assert.strictEqual(SYSTEM_HOTKEY_DEFS['next-map'].defaultAccelerator, 'CommandOrControl+Right');
    assert.strictEqual(SYSTEM_HOTKEY_DEFS['prev-map'].defaultAccelerator, 'CommandOrControl+Left');
    assert.strictEqual(SYSTEM_HOTKEY_DEFS['clear-map'].defaultAccelerator, 'CommandOrControl+Shift+D');
    assert.strictEqual(SYSTEM_HOTKEY_DEFS['opacity-up'].defaultAccelerator, 'CommandOrControl+Up');
    assert.strictEqual(SYSTEM_HOTKEY_DEFS['opacity-down'].defaultAccelerator, 'CommandOrControl+Down');
    assert.strictEqual(SYSTEM_HOTKEY_DEFS['size-up'].defaultAccelerator, 'CommandOrControl+Shift+Up');
    assert.strictEqual(SYSTEM_HOTKEY_DEFS['size-down'].defaultAccelerator, 'CommandOrControl+Shift+Down');
});

test('every system hotkey ships a stored default accelerator', () => {
    // `Hotkeys.getSystemHotkeys()` reads the settings key, falling back to the
    // definition. The two must agree or a fresh install would report a binding
    // in Settings › Hotkeys that is not the one registered.
    for (const [actionId, def] of Object.entries(SYSTEM_HOTKEY_DEFS)) {
        const settingKey = ACTION_TO_SETTING_KEY[actionId];
        assert.strictEqual(DEFAULT_SETTINGS[settingKey], def.defaultAccelerator, actionId);
    }
});

test('every system hotkey default is registrable and carries a modifier', () => {
    const seen = new Set();
    for (const [actionId, def] of Object.entries(SYSTEM_HOTKEY_DEFS)) {
        assert.ok(hasModifier(def.defaultAccelerator), `${actionId}: ${def.defaultAccelerator}`);
        assert.ok(!seen.has(def.defaultAccelerator), `${def.defaultAccelerator} is bound twice`);
        seen.add(def.defaultAccelerator);
    }
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

test('first-run defaults bind Ctrl+1..Ctrl+N in catalogue order', () => {
    const defaults = buildDefaultMapHotkeys(catalog, counter());
    assert.deepStrictEqual(defaults, {
        'CommandOrControl+1': {id: 'id-1', mapKey: 'deftyconchgaming/East Haddonfield'},
        'CommandOrControl+2': {id: 'id-2', mapKey: 'deftyconchgaming/Haddonfield Heights'},
        'CommandOrControl+3': {id: 'id-3', mapKey: 'deftyconchgaming/Haddonfield Town Center'},
        'CommandOrControl+4': {id: 'id-4', mapKey: 'deftyconchgaming/Orange Grove Estates'}
    });
    // The bindings follow the catalogue, which is what next/prev cycles over —
    // there is no separate hand-maintained list to keep in step.
    assert.deepStrictEqual(Object.values(defaults).map(b => b.mapKey), catalog.map(e => e.key));
});

test('a new map needs no code change to get a default binding', () => {
    // Exactly what "drop a PNG into maps/<creator>/" produces.
    const grown = buildCatalog([
        'deftyconchgaming/East Haddonfield.png',
        'deftyconchgaming/Haddonfield Heights.png',
        'deftyconchgaming/Haddonfield Town Center.png',
        'deftyconchgaming/Orange Grove Estates.png',
        'deftyconchgaming/Zzz New Map.png'
    ]);
    const defaults = buildDefaultMapHotkeys(grown, counter());
    assert.strictEqual(Object.keys(defaults).length, 5);
    assert.strictEqual(defaults['CommandOrControl+5'].mapKey, 'deftyconchgaming/Zzz New Map');
});

test('no more than nine default bindings, whatever the catalogue holds', () => {
    const many = buildCatalog(
        Array.from({length: 14}, (_, i) => `deftyconchgaming/Map ${String.fromCharCode(65 + i)}.png`)
    );
    const defaults = buildDefaultMapHotkeys(many, counter());
    assert.strictEqual(MAX_DEFAULT_MAP_HOTKEYS, 9);
    assert.strictEqual(Object.keys(defaults).length, 9);
    assert.deepStrictEqual(Object.keys(defaults), Array.from({length: 9}, (_, i) => `CommandOrControl+${i + 1}`));
    assert.strictEqual(defaults['CommandOrControl+9'].mapKey, 'deftyconchgaming/Map I');
});

test('defaults never collide with a system hotkey', () => {
    // Nine numbers, so check the full Ctrl+1..Ctrl+9 range rather than only the
    // ones this catalogue happens to hand out.
    const many = buildCatalog(Array.from({length: 9}, (_, i) => `deftyconchgaming/Map ${String.fromCharCode(65 + i)}.png`));
    const defaults = buildDefaultMapHotkeys(many, counter());
    const system = new Set(Object.values(SYSTEM_HOTKEY_DEFS).map(d => d.defaultAccelerator));
    assert.strictEqual(Object.keys(defaults).length, 9);
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

// ─── Opacity / size steps ──────────────────────────────────────

test('stepOpacity walks whole tenths and clamps to 0.1..1.0', () => {
    assert.strictEqual(stepOpacity(0.5, OPACITY_STEP), 0.6);
    assert.strictEqual(stepOpacity(0.5, -OPACITY_STEP), 0.4);
    assert.strictEqual(stepOpacity(OPACITY_MAX, OPACITY_STEP), OPACITY_MAX);
    assert.strictEqual(stepOpacity(OPACITY_MIN, -OPACITY_STEP), OPACITY_MIN);
    // Stored values arrive from a range input, i.e. as strings.
    assert.strictEqual(stepOpacity("0.3", OPACITY_STEP), 0.4);
});

test('stepOpacity never drifts off the slider grid', () => {
    // 0.7 + 0.1 is 0.7999999999999999 in binary floating point; a stored value
    // like that no longer equals any step of the settings slider.
    let value = OPACITY_MIN;
    for (let i = 0; i < 9; i++) value = stepOpacity(value, OPACITY_STEP);
    assert.strictEqual(value, 1);
    for (let i = 0; i < 9; i++) value = stepOpacity(value, -OPACITY_STEP);
    assert.strictEqual(value, OPACITY_MIN);
    for (const v of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
        const up = stepOpacity(v, OPACITY_STEP);
        assert.strictEqual(Math.round(up * 10), up * 10, `${v} → ${up} is off the grid`);
    }
});

test('stepOpacity falls back to the default on an unusable stored value', () => {
    for (const bad of [null, undefined, "", "nonsense", NaN, {}]) {
        assert.strictEqual(stepOpacity(bad, OPACITY_STEP), 0.6, String(bad));
    }
});

test('stepSize moves in 25 px and clamps to the slider range', () => {
    assert.strictEqual(stepSize(250, SIZE_STEP), 275);
    assert.strictEqual(stepSize(250, -SIZE_STEP), 225);
    assert.strictEqual(stepSize(SIZE_MAX, SIZE_STEP), SIZE_MAX);
    assert.strictEqual(stepSize(SIZE_MIN, -SIZE_STEP), SIZE_MIN);
    assert.strictEqual(stepSize("125", SIZE_STEP), 150);
    for (const bad of [null, undefined, "", "nonsense", {}]) {
        assert.strictEqual(stepSize(bad, SIZE_STEP), 275, String(bad));
    }
});

test('the step bounds match the settings defaults and the slider range', () => {
    assert.strictEqual(SIZE_MIN, 50);
    assert.strictEqual(SIZE_MAX, 800);
    assert.strictEqual(SIZE_STEP, 25);
    assert.strictEqual(OPACITY_STEP, 0.1);
    // The shipped defaults have to be reachable from the steps, or the very
    // first press would jump the value onto a different grid.
    assert.strictEqual(stepSize(DEFAULT_SETTINGS.size, 0), DEFAULT_SETTINGS.size);
    assert.strictEqual(stepOpacity(DEFAULT_SETTINGS.opacity, 0), DEFAULT_SETTINGS.opacity);
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

test('hasModifier: accepts every modifier spelling Electron does', () => {
    const ok = [
        'CommandOrControl+H', 'CmdOrCtrl+1', 'Control+Alt+Delete', 'Ctrl+Shift+P',
        'Alt+F4', 'Shift+Space', 'Super+L', 'Command+Q', 'Cmd+Q', 'Meta+K',
        'Option+A', 'AltGr+B', 'commandorcontrol+h', 'CTRL+J'
    ];
    for (const accelerator of ok) assert.ok(hasModifier(accelerator), accelerator);
});

test('hasModifier: refuses bare keys and non-strings', () => {
    const bad = ['H', '1', 'F5', 'Space', 'Plus', 'MediaPlayPause', '', 'Shift', 'Alt', null, undefined, 42, {}];
    for (const accelerator of bad) assert.ok(!hasModifier(accelerator), String(accelerator));
});

test('hasModifier: every accelerator the key capture can emit has a modifier', () => {
    const events = [
        {ctrlKey: true, key: 'w'}, {altKey: true, key: 'F4'}, {shiftKey: true, key: ' '},
        {metaKey: true, key: 'ArrowRight'}, {ctrlKey: true, shiftKey: true, key: '+'}
    ];
    for (const event of events) {
        const {status, accelerator} = keyEventToAccelerator(event);
        assert.strictEqual(status, 'ok', JSON.stringify(event));
        assert.ok(hasModifier(accelerator), accelerator);
    }
    // ...and the one it refuses would not have passed hasModifier either
    assert.strictEqual(keyEventToAccelerator({key: 'w'}).status, 'no-modifier');
});
