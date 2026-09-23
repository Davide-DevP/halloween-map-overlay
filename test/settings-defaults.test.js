const {test} = require('node:test');
const assert = require('node:assert');
const {
    DEFAULT_SETTINGS, MAP_LABEL_MODES, NEWS_CHECK_KEYS,
    mapLabelMode, useHardwareAcceleration, newsCheckState, settingsForNewsCheck
} = require('../src/shared/settings-defaults');
const {ACTION_TO_SETTING_KEY} = require('../src/shared/hotkeys-constants');

test('the shipped defaults keep the app opt-in', () => {
    // Anything that captures, phones home or is on by default is a decision,
    // not an accident — these are asserted so flipping one is a visible diff.
    assert.strictEqual(DEFAULT_SETTINGS.mapDetection, false);
    assert.strictEqual(DEFAULT_SETTINGS.checkForUpdates, true);
    assert.strictEqual(DEFAULT_SETTINGS.mapLabel, 'auto');
    assert.strictEqual(DEFAULT_SETTINGS.language, 'system');
    // On by default, and that is the decision: a global shortcut is taken from
    // every other application on the machine, so the app holds its
    // combinations only while the game (or one of its own windows) is in front.
    assert.strictEqual(DEFAULT_SETTINGS.hotkeysGameOnly, true);
    // The setup tutorial has not been seen yet in a brand-new file. Shipping
    // `true` would hide the tour from every new install; shipping it as
    // anything but a boolean would make `shouldShowOnboarding` read a
    // hand-edited value as an opinion.
    assert.strictEqual(DEFAULT_SETTINGS.onboardingDone, false);
    // **False**, and this one is load-bearing: the key is back-filled into an
    // existing settings file as well, and `core/settings.js` only ever sets it
    // on the start that creates the file. A shipped `true` would greet every
    // upgrading user with the tour.
    assert.strictEqual(DEFAULT_SETTINGS.onboardingPending, false);
    // **Zero**, and behind `TOUR_VERSION`: the back-fill reaches existing files
    // too, which is exactly how an install that already had 0.7 is shown the
    // rewritten tutorial once. `test/onboarding-rules.test.js` owns that rule.
    assert.strictEqual(DEFAULT_SETTINGS.tourSeenVersion, 0);
    // Two settings the app decides for itself since 1.0: the tray unload
    // (docs/agents/memory.md) and the menu clear (docs/agents/detection.md).
    // A key absent from the defaults is never back-filled, so nothing reads it.
    for (const gone of ['unloadWindowInTray', 'hideInMenu']) {
        assert.ok(!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, gone), gone);
    }
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

test('hardware acceleration is off by default, and that is a measured decision', () => {
    // Tripwire for a measured default: docs/agents/memory.md (hardwareAcceleration).
    assert.strictEqual(DEFAULT_SETTINGS.hardwareAcceleration, false);
});

/* ────────────────────────────────────────────────────────────────────────────
 * The one "Check for updates automatically" switch over two stored keys
 * ──────────────────────────────────────────────────────────────────────────── */

test('the news switch stands for exactly the two keys that open a socket', () => {
    assert.deepStrictEqual([...NEWS_CHECK_KEYS], ['checkForUpdates', 'checkForMapPacks']);
    for (const key of NEWS_CHECK_KEYS) {
        assert.strictEqual(DEFAULT_SETTINGS[key], true, key);
    }
});

test('the news switch is on when EITHER request is still being made', () => {
    // The rule that keeps the app honest about its network use (AGENTS.md
    // rule 1). An 0.7 file with `{checkForUpdates: true, checkForMapPacks:
    // false}` still asks GitHub on every start, so a switch reading "off" over
    // it would be a lie — the earlier "both" test got this backwards.
    assert.strictEqual(newsCheckState({checkForUpdates: true, checkForMapPacks: false}).checked, true);
    assert.strictEqual(newsCheckState({checkForUpdates: false, checkForMapPacks: true}).checked, true);
    assert.strictEqual(newsCheckState({checkForUpdates: true, checkForMapPacks: true}).checked, true);
    assert.strictEqual(newsCheckState({checkForUpdates: false, checkForMapPacks: false}).checked, false);
});

test('the news switch follows the "only an explicit false is off" rule', () => {
    // A file written before either key existed makes both requests.
    for (const settings of [{}, null, undefined, 'nope', 7, {checkForUpdates: 1}]) {
        assert.strictEqual(newsCheckState(settings).checked, true, JSON.stringify(settings));
    }
    assert.strictEqual(newsCheckState(DEFAULT_SETTINGS).checked, true);
});

test('switching the news switch off has to reach both keys', () => {
    // Otherwise the request the user just denied still happens.
    assert.deepStrictEqual(settingsForNewsCheck(false),
        {checkForUpdates: false, checkForMapPacks: false});
    assert.deepStrictEqual(settingsForNewsCheck(true),
        {checkForUpdates: true, checkForMapPacks: true});
    // Only a literal true is on, and both keys are always named.
    for (const junk of ['yes', 1, {}, null, undefined]) {
        assert.deepStrictEqual(settingsForNewsCheck(junk),
            {checkForUpdates: false, checkForMapPacks: false}, JSON.stringify(junk));
    }
});

test('the news switch round-trips through its own state', () => {
    for (const on of [true, false]) {
        assert.strictEqual(newsCheckState(settingsForNewsCheck(on)).checked, on, String(on));
    }
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

test('no controller button is set in a new file, and no pad is ever chosen', () => {
    // docs/agents/markers-and-tab-mode.md § The controller button.
    assert.strictEqual(DEFAULT_SETTINGS.tabMarkerPad, null);
    assert.strictEqual('tabMarkerPadId' in DEFAULT_SETTINGS, false, 'retired after 1.3.2: every pad is read');
});
