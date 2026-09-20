const {test} = require('node:test');
const assert = require('node:assert');
const {
    DEFAULT_SETTINGS, MAP_LABEL_MODES, mapLabelMode, useHardwareAcceleration
} = require('../src/shared/settings-defaults');
const {ACTION_TO_SETTING_KEY} = require('../src/shared/hotkeys-constants');

test('the shipped defaults keep the app opt-in', () => {
    // Anything that captures, phones home or is on by default is a decision,
    // not an accident — these are asserted so flipping one is a visible diff.
    assert.strictEqual(DEFAULT_SETTINGS.mapDetection, false);
    assert.strictEqual(DEFAULT_SETTINGS.checkForUpdates, true);
    assert.strictEqual(DEFAULT_SETTINGS.hideInMenu, true);
    assert.strictEqual(DEFAULT_SETTINGS.mapLabel, 'auto');
    assert.strictEqual(DEFAULT_SETTINGS.language, 'system');
    // On by default, and that is the decision: a global shortcut is taken from
    // every other application on the machine, so the app holds its
    // combinations only while the game (or one of its own windows) is in front.
    assert.strictEqual(DEFAULT_SETTINGS.hotkeysGameOnly, true);
    // The welcome tour has not been seen yet in a brand-new file. Shipping
    // `true` would hide the tour from every new install; shipping it as
    // anything but a boolean would make `shouldShowOnboarding` read a
    // hand-edited value as an opinion.
    assert.strictEqual(DEFAULT_SETTINGS.onboardingDone, false);
    // **False**, and this one is load-bearing: the key is back-filled into an
    // existing settings file as well, and `core/settings.js` only ever sets it
    // on the start that creates the file. A shipped `true` would greet every
    // upgrading user with the tour.
    assert.strictEqual(DEFAULT_SETTINGS.onboardingPending, false);
});

test('every system hotkey setting key has a default, and no stray hotkey keys', () => {
    // The two files are the same list from two directions: a definition with
    // no stored default would report a binding in Settings › Hotkeys that is
    // not the one registered, and a leftover `hotkey*` key would be back-filled
    // forever with nothing reading it.
    const expected = new Set(Object.values(ACTION_TO_SETTING_KEY));
    const stored = Object.keys(DEFAULT_SETTINGS)
        // `hotkeyDefaultsVersion` is bookkeeping for the one-time move onto the
        // Ctrl+Alt defaults, not an accelerator.
        .filter(k => /^hotkey[A-Z]/.test(k) && k !== 'hotkeyDefaultsVersion');
    assert.deepStrictEqual(stored.sort(), [...expected].sort());
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

test('hardware acceleration is off by default, and that is a measured decision', () => {
    // `docs/MEMORY-REPORT-2.md`: with the GPU process reduced to a software
    // display compositor the in-match state loses ~14 MB of private working
    // set and ~59 MB of commit for no measurable CPU, and the overlay — a
    // still PNG plus an SVG, with no animation anywhere in `src/map/map.html`
    // — looks identical.
    // Flipping this back should be a visible diff, not a quiet edit.
    assert.strictEqual(DEFAULT_SETTINGS.hardwareAcceleration, false);
});

test('useHardwareAcceleration: a boolean is honoured, anything else is the default', () => {
    assert.strictEqual(useHardwareAcceleration(true), true);
    assert.strictEqual(useHardwareAcceleration(false), false);
    // `index.js` reads this **before** `app.whenReady()`, from a file a user
    // can hand-edit. A third state there would mean the app starts with or
    // without the GPU depending on how a JSON value happens to coerce.
    for (const bad of [null, undefined, '', 'true', 'false', 0, 1, {}, []]) {
        assert.strictEqual(useHardwareAcceleration(bad), DEFAULT_SETTINGS.hardwareAcceleration,
            String(bad));
    }
});
