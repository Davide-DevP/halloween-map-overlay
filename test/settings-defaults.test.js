const {test} = require('node:test');
const assert = require('node:assert');
const {DEFAULT_SETTINGS, MAP_LABEL_MODES, mapLabelMode} = require('../src/shared/settings-defaults');

test('the shipped defaults keep the app opt-in', () => {
    // Anything that captures, phones home or is on by default is a decision,
    // not an accident — these are asserted so flipping one is a visible diff.
    assert.strictEqual(DEFAULT_SETTINGS.mapDetection, false);
    assert.strictEqual(DEFAULT_SETTINGS.checkForUpdates, true);
    assert.strictEqual(DEFAULT_SETTINGS.hideInMenu, true);
    assert.strictEqual(DEFAULT_SETTINGS.mapLabel, 'auto');
    assert.strictEqual(DEFAULT_SETTINGS.language, 'system');
});

test('every enum default is one of its own allowed values', () => {
    assert.ok(MAP_LABEL_MODES.includes(DEFAULT_SETTINGS.mapLabel));
    assert.deepStrictEqual(MAP_LABEL_MODES, ['auto', 'always', 'never']);
});

test('mapLabelMode normalises anything a hand-edited file could hold', () => {
    for (const mode of MAP_LABEL_MODES) assert.strictEqual(mapLabelMode(mode), mode);
    for (const bad of [null, undefined, '', 'Always', 'sometimes', 0, 1, true, {}, []]) {
        assert.strictEqual(mapLabelMode(bad), 'auto', String(bad));
    }
});

test('the defaults object has no undefined values', () => {
    // `Settings` fills a missing key from here with `=== undefined` as the
    // test, so an undefined default would be re-applied on every start and
    // could never be overridden.
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        assert.notStrictEqual(value, undefined, key);
    }
});
