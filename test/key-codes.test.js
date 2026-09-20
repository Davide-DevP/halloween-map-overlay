const {test} = require('node:test');
const assert = require('node:assert');

const K = require('../src/shared/key-codes');
const {DEFAULT_SETTINGS} = require('../src/shared/settings-defaults');
const {SYSTEM_HOTKEY_DEFS, ACTION_TO_SETTING_KEY} = require('../src/shared/hotkeys-constants');

/*
 * The map key is a **virtual-key code**, not an accelerator, and the distinction
 * is the whole reason this module exists: an accelerator is a combination the
 * app asks Windows to *reserve* (which would take the key away from the game and
 * gives no key-up), a virtual-key code is a number handed to `GetAsyncKeyState`
 * to ask "is this one key held?".
 */

test('the default is Tab, and it is what the settings file ships', () => {
    assert.strictEqual(K.DEFAULT_MAP_VK, 0x09);
    assert.strictEqual(DEFAULT_SETTINGS.tabMarkerKey, 0x09);
    assert.strictEqual(K.vkLabel(K.DEFAULT_MAP_VK), 'Tab');
});

test('the map key is nowhere near the system hotkey tables', () => {
    // It must never be registered, so it must never look like a system action.
    assert.ok(!Object.prototype.hasOwnProperty.call(SYSTEM_HOTKEY_DEFS, 'tab-marker-key'));
    for (const settingKey of Object.values(ACTION_TO_SETTING_KEY)) {
        assert.notStrictEqual(settingKey, 'tabMarkerKey');
    }
    // …and it is a number, not an accelerator string, so nothing that expects
    // an accelerator could be handed it by accident.
    assert.strictEqual(typeof DEFAULT_SETTINGS.tabMarkerKey, 'number');
});

test('only Alt is ever asked about besides the map key', () => {
    assert.strictEqual(K.VK_MENU, 0x12);
});

/* ────────────────────────────────────────────────────────────────────────────
 * code → VK
 * ──────────────────────────────────────────────────────────────────────────── */

test('letters, digits, numpad and function keys map by range', () => {
    const vk = (code) => K.keyEventToVk({code}).vk;
    assert.strictEqual(vk('KeyA'), 0x41);
    assert.strictEqual(vk('KeyM'), 0x4D);
    assert.strictEqual(vk('KeyZ'), 0x5A);
    assert.strictEqual(vk('Digit0'), 0x30);
    assert.strictEqual(vk('Digit9'), 0x39);
    assert.strictEqual(vk('Numpad0'), 0x60);
    assert.strictEqual(vk('Numpad9'), 0x69);
    assert.strictEqual(vk('F1'), 0x70);
    assert.strictEqual(vk('F12'), 0x7B);
    assert.strictEqual(vk('F24'), 0x87);
});

test('the named keys the game might use map explicitly', () => {
    const vk = (code) => K.keyEventToVk({code}).vk;
    assert.strictEqual(vk('Tab'), 0x09);
    assert.strictEqual(vk('CapsLock'), 0x14);
    assert.strictEqual(vk('Space'), 0x20);
    assert.strictEqual(vk('Enter'), 0x0D);
    assert.strictEqual(vk('NumpadEnter'), 0x0D);
    assert.strictEqual(vk('Backquote'), 0xC0);
    assert.strictEqual(vk('Semicolon'), 0xBA);
    assert.strictEqual(vk('ArrowUp'), 0x26);
    assert.strictEqual(vk('Insert'), 0x2D);
});

test('`code` wins over `key`, so the physical key is what is stored', () => {
    // On a French layout the key where Q sits reports `code: 'KeyA'` and
    // `key: 'q'`. Windows virtual-key codes are positional in the same way, so
    // the `code` is the closer match — and it is the key the game sees too.
    assert.strictEqual(K.keyEventToVk({code: 'KeyA', key: 'q'}).vk, 0x41);
    // …and `key` is the fallback when there is no `code` at all.
    assert.strictEqual(K.keyEventToVk({key: 'q'}).vk, 0x51);
    assert.strictEqual(K.keyEventToVk({key: 'Tab'}).vk, 0x09);
    assert.strictEqual(K.keyEventToVk({key: 'F5'}).vk, 0x74);
    assert.strictEqual(K.keyEventToVk({key: ';'}).vk, 0xBA);
});

test('a modifier is refused, and refusing it keeps the recorder listening', () => {
    // `modifier` is the *common* case — the user presses Shift on the way to
    // the key they meant — so it is its own status, distinct from an error.
    for (const code of ['ShiftLeft', 'ControlRight', 'AltLeft', 'MetaLeft', 'OSLeft']) {
        const r = K.keyEventToVk({code});
        assert.strictEqual(r.status, 'modifier', code);
        assert.strictEqual(r.vk, null, code);
    }
    for (const key of ['Shift', 'Control', 'Alt', 'Meta', 'AltGraph']) {
        assert.strictEqual(K.keyEventToVk({key}).status, 'modifier', key);
    }
});

test('a key with a modifier held is refused rather than silently stripped', () => {
    // Recording Shift+M must not store M: the user would believe they had
    // bound the pair, and the trigger would fire on a bare M.
    for (const flag of ['shiftKey', 'ctrlKey', 'altKey', 'metaKey']) {
        const event = {code: 'KeyM', key: 'M'};
        event[flag] = true;
        const r = K.keyEventToVk(event);
        assert.strictEqual(r.status, 'with-modifier', flag);
        assert.strictEqual(r.vk, null, flag);
    }
});

test('an unmappable key is refused', () => {
    for (const event of [{}, {code: 'Nonsense'}, {key: 'Unidentified'},
        {code: 'MediaPlayPause'}, {code: 'BrowserHome'}, {key: '€'}, {code: 'F25'}]) {
        const r = K.keyEventToVk(event);
        assert.strictEqual(r.status, 'unsupported', JSON.stringify(event));
        assert.strictEqual(r.vk, null);
    }
    assert.strictEqual(K.keyEventToVk(null).status, 'unsupported');
});

test('every accepted code produces a watchable vk and a label', () => {
    const codes = Object.keys(K.CODE_TO_VK)
        .concat(['KeyA', 'KeyM', 'Digit3', 'Numpad5', 'F1', 'F13']);
    for (const code of codes) {
        const r = K.keyEventToVk({code});
        assert.strictEqual(r.status, 'ok', code);
        assert.ok(K.isWatchableVk(r.vk), `${code} → ${r.vk}`);
        assert.ok(r.label.length > 0, `${code} has no label`);
        assert.strictEqual(r.label, K.vkLabel(r.vk), code);
    }
});

/* ────────────────────────────────────────────────────────────────────────────
 * What may be watched at all
 * ──────────────────────────────────────────────────────────────────────────── */

test('mouse buttons and modifiers can never be watched', () => {
    // They cannot be *recorded* (no KeyboardEvent), but a hand-edited settings
    // file could name one — and `GetAsyncKeyState` would answer, which would
    // make the trigger fire on a click or on every Shift.
    for (const vk of [0x01, 0x02, 0x04, 0x05, 0x06]) {
        assert.strictEqual(K.isWatchableVk(vk), false, `mouse 0x${vk.toString(16)}`);
    }
    for (const vk of [0x10, 0x11, 0x12, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x5B, 0x5C]) {
        assert.strictEqual(K.isWatchableVk(vk), false, `modifier 0x${vk.toString(16)}`);
    }
    for (const vk of [0, -1, 0xFF, 0x100, 1.5, NaN, '9', null, undefined, {}]) {
        assert.strictEqual(K.isWatchableVk(vk), false, String(vk));
    }
    assert.strictEqual(K.isWatchableVk(0x09), true);
    assert.strictEqual(K.isWatchableVk(0x4D), true);
});

test('resolveMapVk falls back to Tab for anything unusable', () => {
    assert.strictEqual(K.resolveMapVk(0x4D), 0x4D);
    assert.strictEqual(K.resolveMapVk('77'), 0x4D);
    for (const bad of [null, undefined, 0, 0x01, 0x10, 0xFF, 'nonsense', {}, NaN, -5]) {
        assert.strictEqual(K.resolveMapVk(bad), K.DEFAULT_MAP_VK, String(bad));
    }
});

test('vkLabel names every watchable code and nothing else', () => {
    assert.strictEqual(K.vkLabel(0x4D), 'M');
    assert.strictEqual(K.vkLabel(0x31), '1');
    assert.strictEqual(K.vkLabel(0x61), 'Num 1');
    assert.strictEqual(K.vkLabel(0x70), 'F1');
    assert.strictEqual(K.vkLabel(0x87), 'F24');
    assert.strictEqual(K.vkLabel(0x14), 'Caps Lock');
    // Nothing for a code that may not be watched — the row would be a lie.
    assert.strictEqual(K.vkLabel(0x10), '');
    assert.strictEqual(K.vkLabel(0x01), '');
    assert.strictEqual(K.vkLabel(null), '');
    // A watchable code with no name of its own still prints something, so a
    // hand-edited file is readable in Settings rather than showing a blank.
    assert.match(K.vkLabel(0x07), /^0x07$/);
});

test('the two tables agree with each other on the keys they share', () => {
    // `code` and `key` both offer Tab, Enter, the arrows and the punctuation;
    // they must not disagree about which number that is.
    for (const [name, vk] of Object.entries(K.KEY_TO_VK)) {
        if (!Object.prototype.hasOwnProperty.call(K.CODE_TO_VK, name)) continue;
        assert.strictEqual(K.CODE_TO_VK[name], vk, name);
    }
    // Every value in both tables is something we are willing to watch.
    for (const [name, vk] of Object.entries(K.CODE_TO_VK)) {
        assert.ok(K.isWatchableVk(vk), `CODE_TO_VK.${name} = ${vk}`);
    }
    for (const [name, vk] of Object.entries(K.KEY_TO_VK)) {
        assert.ok(K.isWatchableVk(vk), `KEY_TO_VK["${name}"] = ${vk}`);
    }
});
