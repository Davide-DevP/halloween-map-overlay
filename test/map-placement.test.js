const {test} = require('node:test');
const assert = require('node:assert');

const {
    MAP_PLACEMENTS,
    isPlacement,
    normalisePlacement,
    placementFromSettings,
    settingsForPlacement,
    placementNeedsDetection,
    placementSections,
    autoDetectSwitchState,
    shouldStartDetection,
    markerMasterNotice
} = require('../src/shared/map-placement');
const {DEFAULT_SETTINGS} = require('../src/shared/settings-defaults');

/**
 * `src/shared/map-placement.js` — the one "where do you want to see the map?"
 * choice over the two keys it replaced. The pair has to round-trip exactly, or
 * the card that is ticked is not the mode that is running.
 */

test('the three placements are the three the UI offers, in card order', () => {
    assert.deepStrictEqual([...MAP_PLACEMENTS], ['corner', 'tab', 'both']);
    for (const p of MAP_PLACEMENTS) assert.strictEqual(isPlacement(p), true);
    for (const junk of ['Corner', '', null, undefined, 0, {}, 'minimap']) {
        assert.strictEqual(isPlacement(junk), false, JSON.stringify(junk));
    }
});

test('anything unrecognised is the corner, never a fourth state', () => {
    for (const junk of ['nope', '', null, undefined, 7, {}, []]) {
        assert.strictEqual(normalisePlacement(junk), 'corner', JSON.stringify(junk));
    }
    for (const p of MAP_PLACEMENTS) assert.strictEqual(normalisePlacement(p), p);
});

test('placementFromSettings: the stored pair read as one choice', () => {
    assert.strictEqual(placementFromSettings({tabMarkers: false, tabHidesMinimap: false}), 'corner');
    assert.strictEqual(placementFromSettings({tabMarkers: true, tabHidesMinimap: true}), 'tab');
    assert.strictEqual(placementFromSettings({tabMarkers: true, tabHidesMinimap: false}), 'both');
});

test('placementFromSettings: tabMarkers off is the corner whatever else is stored', () => {
    // A file left behind by someone who tried the experimental mode and went
    // back is a corner user, not a user with no map at all.
    assert.strictEqual(placementFromSettings({tabMarkers: false, tabHidesMinimap: true}), 'corner');
    assert.strictEqual(placementFromSettings({}), 'corner');
    assert.strictEqual(placementFromSettings(null), 'corner');
    assert.strictEqual(placementFromSettings(undefined), 'corner');
    assert.strictEqual(placementFromSettings('nonsense'), 'corner');
    // Only a literal `true` counts, so a hand-edited "yes" cannot switch it on.
    assert.strictEqual(placementFromSettings({tabMarkers: 'yes'}), 'corner');
    assert.strictEqual(placementFromSettings({tabMarkers: 1}), 'corner');
});

test('placementFromSettings: only a literal true hides the corner overlay', () => {
    assert.strictEqual(placementFromSettings({tabMarkers: true, tabHidesMinimap: 'yes'}), 'both');
    assert.strictEqual(placementFromSettings({tabMarkers: true}), 'both');
    assert.strictEqual(placementFromSettings({tabMarkers: true, tabHidesMinimap: null}), 'both');
});

test('settingsForPlacement always names both keys', () => {
    assert.deepStrictEqual(settingsForPlacement('corner'), {tabMarkers: false, tabHidesMinimap: false});
    assert.deepStrictEqual(settingsForPlacement('tab'), {tabMarkers: true, tabHidesMinimap: true});
    assert.deepStrictEqual(settingsForPlacement('both'), {tabMarkers: true, tabHidesMinimap: false});
    // Naming both is what keeps switching back from leaving the other behind.
    for (const p of MAP_PLACEMENTS) {
        assert.deepStrictEqual(Object.keys(settingsForPlacement(p)).sort(),
            ['tabHidesMinimap', 'tabMarkers']);
    }
});

test('settingsForPlacement: junk writes the corner', () => {
    for (const junk of ['nope', null, undefined, 3]) {
        assert.deepStrictEqual(settingsForPlacement(junk),
            {tabMarkers: false, tabHidesMinimap: false}, JSON.stringify(junk));
    }
});

test('the pair round-trips both ways', () => {
    for (const p of MAP_PLACEMENTS) {
        assert.strictEqual(placementFromSettings(settingsForPlacement(p)), p, p);
    }
    for (const tabMarkers of [true, false]) {
        for (const tabHidesMinimap of [true, false]) {
            const stored = {tabMarkers, tabHidesMinimap};
            const placement = placementFromSettings(stored);
            const written = settingsForPlacement(placement);
            assert.strictEqual(placementFromSettings(written), placement,
                JSON.stringify(stored));
        }
    }
});

test('the shipped defaults are the corner', () => {
    assert.strictEqual(placementFromSettings(DEFAULT_SETTINGS), 'corner');
});

test('placementNeedsDetection: only the two game-map modes', () => {
    assert.strictEqual(placementNeedsDetection('corner'), false);
    assert.strictEqual(placementNeedsDetection('tab'), true);
    assert.strictEqual(placementNeedsDetection('both'), true);
    assert.strictEqual(placementNeedsDetection('nope'), false);
    assert.strictEqual(placementNeedsDetection(null), false);
});

test('placementSections: what each choice shows', () => {
    assert.deepStrictEqual(placementSections('corner'),
        {corner: true, gameMap: false, troubleshooting: false});
    assert.deepStrictEqual(placementSections('tab'),
        {corner: false, gameMap: true, troubleshooting: true});
    assert.deepStrictEqual(placementSections('both'),
        {corner: true, gameMap: true, troubleshooting: true});
    // Junk shows the corner block and nothing about the game's own map.
    assert.deepStrictEqual(placementSections('nope'),
        {corner: true, gameMap: false, troubleshooting: false});
});

test('placementSections: every choice leaves at least one map on screen', () => {
    for (const p of MAP_PLACEMENTS) {
        const sections = placementSections(p);
        assert.ok(sections.corner || sections.gameMap, p);
    }
});

test('autoDetectSwitchState: locked on for a game-map mode that is running', () => {
    for (const p of ['tab', 'both']) {
        assert.deepStrictEqual(autoDetectSwitchState(p, true), {
            checked: true,
            disabled: true,
            blocked: false,
            reasonKey: 'settings.autoDetect.lockedHelp'
        }, p);
    }
});

test('autoDetectSwitchState: a stored game-map mode with the loop off tells the truth', () => {
    // The rule that keeps the app opt-in (AGENTS.md rule 1): 0.7 could store
    // `{tabMarkers: true, mapDetection: false}`, and nothing may switch a screen
    // capture on without a click — so the switch reports **off**, stays usable,
    // and `blocked` is what puts a button in front of the user.
    for (const p of ['tab', 'both']) {
        for (const running of [false, undefined, null, 'yes', 1]) {
            assert.deepStrictEqual(autoDetectSwitchState(p, running), {
                checked: false,
                disabled: false,
                blocked: true,
                reasonKey: 'settings.autoDetect.blockedHelp'
            }, `${p}/${JSON.stringify(running)}`);
        }
    }
});

test('autoDetectSwitchState: an ordinary switch on the corner', () => {
    assert.deepStrictEqual(autoDetectSwitchState('corner', true),
        {checked: true, disabled: false, blocked: false, reasonKey: 'settings.autoDetect.help'});
    assert.deepStrictEqual(autoDetectSwitchState('corner', false),
        {checked: false, disabled: false, blocked: false, reasonKey: 'settings.autoDetect.help'});
    // `checked` reports the loop, never the setting: a start main refused must
    // not leave a ticked box behind.
    assert.strictEqual(autoDetectSwitchState('corner', 'yes').checked, false);
    assert.strictEqual(autoDetectSwitchState('corner', null).checked, false);
});

test('autoDetectSwitchState: it is never both disabled and blocked', () => {
    // "Disabled" means the user must not change it; "blocked" means only the
    // user can. Both at once would be a dead end.
    for (const p of [...MAP_PLACEMENTS, 'nope', null]) {
        for (const running of [true, false]) {
            const state = autoDetectSwitchState(p, running);
            assert.ok(!(state.disabled && state.blocked), `${p}/${running}`);
            // A locked switch always claims to be on, and only when it is.
            assert.strictEqual(state.disabled, state.checked && running === true
                && placementNeedsDetection(p));
        }
    }
});

test('a blocked state is exactly the one shouldStartDetection would act on', () => {
    // The two have to agree, or the button either does nothing or appears when
    // there is nothing to do.
    for (const p of [...MAP_PLACEMENTS, 'nope']) {
        for (const running of [true, false]) {
            assert.strictEqual(autoDetectSwitchState(p, running).blocked,
                shouldStartDetection(p, running), `${p}/${running}`);
        }
    }
});

test('shouldStartDetection: only when the placement needs it and it is off', () => {
    assert.strictEqual(shouldStartDetection('tab', false), true);
    assert.strictEqual(shouldStartDetection('both', false), true);
    assert.strictEqual(shouldStartDetection('tab', true), false);
    assert.strictEqual(shouldStartDetection('both', true), false);
    // Choosing the corner never *stops* a detector switched on for its own sake.
    assert.strictEqual(shouldStartDetection('corner', true), false);
    assert.strictEqual(shouldStartDetection('corner', false), false);
});

test('markerMasterNotice: only an explicit false is "hidden right now"', () => {
    assert.deepStrictEqual(markerMasterNotice(false), {hidden: true});
    assert.deepStrictEqual(markerMasterNotice(true), {hidden: false});
    // A settings file written before the key existed behaves like the default.
    assert.deepStrictEqual(markerMasterNotice(undefined), {hidden: false});
    assert.deepStrictEqual(markerMasterNotice(null), {hidden: false});
    assert.deepStrictEqual(markerMasterNotice(0), {hidden: false});
});
