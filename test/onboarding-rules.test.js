const {test} = require('node:test');
const assert = require('node:assert');

const {
    ONBOARDING_STEPS,
    ONBOARDING_HOTKEY_ACTIONS,
    INERT_EXEMPT_IDS,
    shouldShowOnboarding,
    stepIndex,
    stepPosition,
    nextStep,
    previousStep,
    onboardingHotkeyRows,
    isConflicting,
    onboardingConflictList,
    onboardingTryIt,
    tabMarkersSwitchState,
    backgroundInertTargets,
    shouldRecaptureFocus,
    tabWrapTarget
} = require('../src/shared/onboarding-rules');
const {SYSTEM_HOTKEY_DEFS, ACTION_TO_SETTING_KEY} = require('../src/shared/hotkeys-constants');
const {DEFAULT_SETTINGS} = require('../src/shared/settings-defaults');
const {CATALOGUES, LANGUAGES, has} = require('../src/shared/i18n');

/* ────────────────────────────────────────────────────────────────────────────
 * Should it open?
 * ──────────────────────────────────────────────────────────────────────────── */

test('the tour opens by itself only for an install that is owed it', () => {
    assert.strictEqual(shouldShowOnboarding({onboardingPending: true, onboardingDone: false}), true);
    // The shipped default for `onboardingDone` is what a brand-new settings
    // file holds; `onboardingPending` is set on top of it by core/settings.js.
    assert.strictEqual(shouldShowOnboarding({
        onboardingPending: true,
        onboardingDone: DEFAULT_SETTINGS.onboardingDone
    }), true);
});

test('an existing install is never interrupted, whatever onboardingDone holds', () => {
    // The rule that matters most. An upgrade has `onboardingPending` back-filled
    // from DEFAULT_SETTINGS as false, so the answer is no however the other
    // flag reads — including the `false` the same back-fill just gave it.
    for (const done of [false, true, undefined, null, 0, '']) {
        assert.strictEqual(shouldShowOnboarding({onboardingPending: false, onboardingDone: done}), false,
            `onboardingDone=${String(done)}`);
    }
    assert.strictEqual(shouldShowOnboarding({
        onboardingPending: DEFAULT_SETTINGS.onboardingPending,
        onboardingDone: DEFAULT_SETTINGS.onboardingDone
    }), false);
});

test('an abandoned first run is greeted on the next start', () => {
    // The reason this is a stored marker and not `Settings.freshInstall`: a
    // quit, a crash or an update restart before Skip/Finish leaves a settings
    // file behind, so "the file did not exist when we started" is false from
    // then on — but the tour was never actually shown. The marker survives.
    assert.strictEqual(shouldShowOnboarding({onboardingPending: true, onboardingDone: false}), true);
});

test('a completed tour does not open again', () => {
    // Skipping on the first step writes `onboardingDone`; the rest of that
    // session (and every later one) must be left alone.
    assert.strictEqual(shouldShowOnboarding({onboardingPending: true, onboardingDone: true}), false);
    // …and it stays shut once the marker has been cleared as well.
    assert.strictEqual(shouldShowOnboarding({onboardingPending: false, onboardingDone: true}), false);
});

test('only a literal true counts, on both flags', () => {
    // A hand-edited settings file must not be able to suppress the tour with a
    // truthy non-boolean, nor summon it on an install that was never owed one.
    for (const done of ['true', 'yes', 1, {}, []]) {
        assert.strictEqual(shouldShowOnboarding({onboardingPending: true, onboardingDone: done}), true,
            `onboardingDone=${JSON.stringify(done)}`);
    }
    for (const pending of ['true', 1, {}, [], undefined, null]) {
        assert.strictEqual(shouldShowOnboarding({onboardingPending: pending, onboardingDone: false}), false,
            `onboardingPending=${JSON.stringify(pending)}`);
    }
});

test('a missing or junk state never opens the tour', () => {
    for (const state of [undefined, null, {}, 'nope', 42]) {
        assert.strictEqual(shouldShowOnboarding(state), false, JSON.stringify(state));
    }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Which step next?
 * ──────────────────────────────────────────────────────────────────────────── */

test('the steps are the six the design calls for, in order', () => {
    assert.deepStrictEqual([...ONBOARDING_STEPS],
        ['welcome', 'placement', 'markers', 'hotkeys', 'detect', 'done']);
    // Frozen: the renderer holds step ids in `data-tour-step` attributes and a
    // reordering at runtime would silently show the wrong section.
    assert.ok(Object.isFrozen(ONBOARDING_STEPS));
});

test('markers come after placement and before the hotkeys that toggle them', () => {
    // The ordering is the argument: the markers step explains what a mark is,
    // and the hotkeys step immediately after lists the combination that turns
    // them off. Swapping the two would introduce the shortcut first.
    assert.ok(stepIndex('markers') > stepIndex('placement'));
    assert.ok(stepIndex('markers') < stepIndex('hotkeys'));
    // Tab-map mode lives *inside* the auto-detect step rather than after it:
    // it cannot work with auto-detect off, so there is no step of its own.
    assert.strictEqual(stepIndex('tab'), -1);
    assert.strictEqual(nextStep('detect'), 'done');
});

test('next/previous walk the sequence and stop at both ends', () => {
    assert.strictEqual(previousStep('welcome'), null);
    assert.strictEqual(nextStep('welcome'), 'placement');
    assert.strictEqual(nextStep('placement'), 'markers');
    assert.strictEqual(nextStep('markers'), 'hotkeys');
    assert.strictEqual(nextStep('hotkeys'), 'detect');
    assert.strictEqual(nextStep('detect'), 'done');
    // `null` from the last step is how the caller knows Next means "finish".
    assert.strictEqual(nextStep('done'), null);
    assert.strictEqual(previousStep('done'), 'detect');
    assert.strictEqual(previousStep('placement'), 'welcome');
});

test('next and previous are each other’s inverse all the way along', () => {
    for (let i = 0; i < ONBOARDING_STEPS.length - 1; i++) {
        const id = ONBOARDING_STEPS[i];
        assert.strictEqual(previousStep(nextStep(id)), id, id);
    }
});

test('the step position is what the "Step N of M" line needs', () => {
    const total = ONBOARDING_STEPS.length;
    assert.strictEqual(total, 6);
    assert.deepStrictEqual(stepPosition('welcome'), {
        id: 'welcome', index: 0, number: 1, total, first: true, last: false
    });
    assert.deepStrictEqual(stepPosition('markers'), {
        id: 'markers', index: 2, number: 3, total, first: false, last: false
    });
    assert.deepStrictEqual(stepPosition('done'), {
        id: 'done', index: total - 1, number: total, total, first: false, last: true
    });
});

test('an unknown step falls back to the first one instead of throwing', () => {
    assert.strictEqual(stepIndex('nope'), -1);
    for (const junk of ['nope', '', null, undefined, 3, {}]) {
        const position = stepPosition(junk);
        assert.strictEqual(position.id, 'welcome', JSON.stringify(junk));
        assert.strictEqual(position.first, true);
        assert.strictEqual(nextStep(junk), 'placement');
        assert.strictEqual(previousStep(junk), null);
    }
});

/* ────────────────────────────────────────────────────────────────────────────
 * The hotkeys step
 * ──────────────────────────────────────────────────────────────────────────── */

test('the listed actions all exist and lead with the one the step invites', () => {
    assert.deepStrictEqual([...ONBOARDING_HOTKEY_ACTIONS],
        ['toggle-map', 'next-map', 'prev-map', 'rotate-map', 'toggle-markers']);
    for (const actionId of ONBOARDING_HOTKEY_ACTIONS) {
        assert.ok(SYSTEM_HOTKEY_DEFS[actionId], `${actionId} is not a system hotkey`);
    }
    assert.strictEqual(ONBOARDING_HOTKEY_ACTIONS[0], 'toggle-map');
    // Still a curated subset, not the whole table — the tour is not the manual.
    assert.ok(ONBOARDING_HOTKEY_ACTIONS.length < Object.keys(SYSTEM_HOTKEY_DEFS).length);
});

test('the markers hotkey is listed live, like every other row', () => {
    // It is a system hotkey like the rest, so it is rebindable and unbindable
    // and the row must follow — the reason nothing user-visible may hard-code a
    // combination.
    const fresh = onboardingHotkeyRows({}).find(r => r.actionId === 'toggle-markers');
    assert.strictEqual(fresh.accelerator, SYSTEM_HOTKEY_DEFS['toggle-markers'].defaultAccelerator);
    const rebound = onboardingHotkeyRows({'toggle-markers': 'Alt+F9'})
        .find(r => r.actionId === 'toggle-markers');
    assert.strictEqual(rebound.accelerator, 'Alt+F9');
    const unbound = onboardingHotkeyRows({'toggle-markers': ''})
        .find(r => r.actionId === 'toggle-markers');
    assert.strictEqual(unbound.bound, false);
    assert.strictEqual(unbound.labelKey, 'hotkeys.notBound');
});

/* ────────────────────────────────────────────────────────────────────────────
 * Markers on the in-game map
 * ──────────────────────────────────────────────────────────────────────────── */

test('the Tab-map switch is usable only with both prerequisites on', () => {
    assert.deepStrictEqual(
        tabMarkersSwitchState({autoDetect: true, markers: true, tabMarkers: false}),
        {enabled: true, checked: false, reasonKey: null});
    assert.deepStrictEqual(
        tabMarkersSwitchState({autoDetect: true, markers: true, tabMarkers: true}),
        {enabled: true, checked: true, reasonKey: null});
});

test('auto-detect off disables it with Settings’ own explanation', () => {
    // The same catalogue string Settings shows for the same state, so the two
    // cannot drift into explaining it two different ways.
    const state = tabMarkersSwitchState({autoDetect: false, markers: true, tabMarkers: false});
    assert.strictEqual(state.enabled, false);
    assert.strictEqual(state.reasonKey, 'settings.tabMarkers.needsDetect');
});

test('markers off disables it too, and says which switch to go back to', () => {
    // With the master switch off there is nothing to draw anywhere, and
    // core/tab-mode.js takes the mode down for it — so a switch the tour let
    // you turn on would do nothing visible.
    const state = tabMarkersSwitchState({autoDetect: true, markers: false, tabMarkers: false});
    assert.strictEqual(state.enabled, false);
    assert.strictEqual(state.reasonKey, 'onboarding.detect.tab.needsMarkers');
});

test('auto-detect is the reason named first when both are off', () => {
    // One sentence at a time, and this is the one the user hits first: the
    // auto-detect switch is on the very same step.
    const state = tabMarkersSwitchState({autoDetect: false, markers: false, tabMarkers: false});
    assert.strictEqual(state.reasonKey, 'settings.tabMarkers.needsDetect');
});

test('markers follow the "only an explicit false is off" rule', () => {
    // A settings file written before markers existed has no key at all, and
    // must read as on — the same rule `isLayerEnabled` applies.
    for (const markers of [true, undefined, null, 1, 'yes']) {
        assert.strictEqual(
            tabMarkersSwitchState({autoDetect: true, markers, tabMarkers: false}).enabled, true,
            JSON.stringify(markers));
    }
    assert.strictEqual(
        tabMarkersSwitchState({autoDetect: true, markers: false, tabMarkers: false}).enabled, false);
});

test('the Tab-map switch reports the stored setting even while disabled', () => {
    // The tour never shows a switch in a position the settings file does not
    // hold; "disabled" is about what can be changed, not about what is true.
    const state = tabMarkersSwitchState({autoDetect: false, markers: true, tabMarkers: true});
    assert.strictEqual(state.checked, true);
    assert.strictEqual(state.enabled, false);
    // …and only a literal true is on, so a hand-edited file cannot tick it.
    for (const value of ['true', 1, {}, [], undefined, null]) {
        assert.strictEqual(
            tabMarkersSwitchState({autoDetect: true, markers: true, tabMarkers: value}).checked,
            false, JSON.stringify(value));
    }
});

test('a missing or junk Tab-map state is disabled, never enabled by accident', () => {
    for (const state of [undefined, null, {}, 'nope', 7]) {
        const answer = tabMarkersSwitchState(state);
        assert.strictEqual(answer.enabled, false, JSON.stringify(state));
        assert.strictEqual(answer.checked, false);
        assert.strictEqual(answer.reasonKey, 'settings.tabMarkers.needsDetect');
    }
});

test('an empty store shows the shipped defaults, not blanks', () => {
    const rows = onboardingHotkeyRows({});
    assert.strictEqual(rows.length, ONBOARDING_HOTKEY_ACTIONS.length);
    for (const row of rows) {
        const def = SYSTEM_HOTKEY_DEFS[row.actionId];
        assert.strictEqual(row.accelerator, def.defaultAccelerator, row.actionId);
        assert.strictEqual(row.bound, true);
        assert.strictEqual(row.labelKey, null);
        assert.strictEqual(row.descriptionKey, def.descriptionKey);
        assert.strictEqual(row.settingKey, ACTION_TO_SETTING_KEY[row.actionId]);
    }
});

test('the rows follow a rebind rather than the defaults', () => {
    // The whole point: the defaults already moved once (0.7) and every one of
    // them is rebindable, so nothing user-visible may hard-code a combination.
    const rows = onboardingHotkeyRows({'toggle-map': 'CommandOrControl+Alt+F8'});
    assert.strictEqual(rows[0].accelerator, 'CommandOrControl+Alt+F8');
    assert.strictEqual(rows[0].bound, true);
    // …and the untouched ones still read as the default.
    assert.strictEqual(rows[1].accelerator, SYSTEM_HOTKEY_DEFS['next-map'].defaultAccelerator);
});

test('an unbound action says "Not bound" and claims no accelerator', () => {
    for (const unbound of ['', '   ', '\t']) {
        const rows = onboardingHotkeyRows({'rotate-map': unbound});
        const rotate = rows.find(r => r.actionId === 'rotate-map');
        assert.strictEqual(rotate.bound, false, JSON.stringify(unbound));
        assert.strictEqual(rotate.accelerator, '');
        // The same string the Hotkeys table uses, so the two cannot disagree.
        assert.strictEqual(rotate.labelKey, 'hotkeys.notBound');
    }
});

test('a non-string stored value is an absence, so the default shows', () => {
    // `null` in a hand-edited file is "nothing stored", not "unbound" — the
    // same three-way rule `resolveSystemAccelerator` enforces everywhere else.
    for (const junk of [null, undefined, 0, false, {}]) {
        const rows = onboardingHotkeyRows({'next-map': junk});
        const next = rows.find(r => r.actionId === 'next-map');
        assert.strictEqual(next.accelerator, SYSTEM_HOTKEY_DEFS['next-map'].defaultAccelerator,
            JSON.stringify(junk));
        assert.strictEqual(next.bound, true);
    }
});

test('a missing or junk store still renders every row', () => {
    for (const store of [undefined, null, 'nope', 7]) {
        const rows = onboardingHotkeyRows(store);
        assert.strictEqual(rows.length, ONBOARDING_HOTKEY_ACTIONS.length, JSON.stringify(store));
        assert.ok(rows.every(r => r.bound), JSON.stringify(store));
    }
});

test('the "try it" hint names the live show/hide binding', () => {
    const fresh = onboardingTryIt({});
    assert.deepStrictEqual(fresh, {
        bound: true,
        conflicting: false,
        accelerator: SYSTEM_HOTKEY_DEFS['toggle-map'].defaultAccelerator,
        promptKey: 'onboarding.hotkeys.tryIt'
    });
    const rebound = onboardingTryIt({'toggle-map': 'Alt+Shift+M'});
    assert.strictEqual(rebound.accelerator, 'Alt+Shift+M');
    assert.strictEqual(rebound.promptKey, 'onboarding.hotkeys.tryIt');
    // No conflict list at all is not a conflict.
    for (const conflicts of [undefined, null, [], 'nope', 7]) {
        assert.strictEqual(onboardingTryIt({}, conflicts).promptKey, 'onboarding.hotkeys.tryIt',
            JSON.stringify(conflicts));
    }
});

test('with show/hide unbound the hint changes sentence instead of showing a blank cap', () => {
    const unbound = onboardingTryIt({'toggle-map': ''});
    assert.deepStrictEqual(unbound, {
        bound: false,
        conflicting: false,
        accelerator: '',
        promptKey: 'onboarding.hotkeys.tryIt.unbound'
    });
    // An unbound action cannot be "taken by another app" either — there is no
    // combination to take.
    const withConflicts = onboardingTryIt({'toggle-map': ''}, [{accelerator: 'CommandOrControl+Alt+H'}]);
    assert.strictEqual(withConflicts.promptKey, 'onboarding.hotkeys.tryIt.unbound');
    assert.strictEqual(withConflicts.conflicting, false);
});

test('a show/hide binding another app owns says so instead of inviting a dead press', () => {
    // Without this branch the first thing a new user is told to try does
    // nothing, and the banner that would explain why is behind the backdrop.
    const taken = onboardingTryIt({}, [{accelerator: SYSTEM_HOTKEY_DEFS['toggle-map'].defaultAccelerator}]);
    assert.deepStrictEqual(taken, {
        bound: true,
        conflicting: true,
        accelerator: SYSTEM_HOTKEY_DEFS['toggle-map'].defaultAccelerator,
        promptKey: 'onboarding.hotkeys.tryIt.taken'
    });
    // Compared as accelerators, not as strings: these are one combination.
    const spelled = onboardingTryIt({'toggle-map': 'CommandOrControl+Alt+H'}, [{accelerator: 'ctrl+alt+h'}]);
    assert.strictEqual(spelled.promptKey, 'onboarding.hotkeys.tryIt.taken');
    // A conflict on a *different* action leaves the invitation alone.
    const elsewhere = onboardingTryIt({}, [{accelerator: 'CommandOrControl+Alt+R'}]);
    assert.strictEqual(elsewhere.promptKey, 'onboarding.hotkeys.tryIt');
});

/* ────────────────────────────────────────────────────────────────────────────
 * Conflicts
 * ──────────────────────────────────────────────────────────────────────────── */

test('isConflicting compares combinations, not spellings', () => {
    const conflicts = [{accelerator: 'Ctrl+Alt+H', action: 'toggle-map', reason: 'taken'}];
    assert.strictEqual(isConflicting('CommandOrControl+Alt+H', conflicts), true);
    assert.strictEqual(isConflicting('Alt+CommandOrControl+H', conflicts), true);
    assert.strictEqual(isConflicting('CommandOrControl+Alt+R', conflicts), false);
});

test('isConflicting: an unbound action and a junk list are never a conflict', () => {
    for (const accelerator of ['', '  ', null, undefined, 7]) {
        assert.strictEqual(isConflicting(accelerator, [{accelerator: 'Ctrl+Alt+H'}]), false,
            JSON.stringify(accelerator));
    }
    for (const conflicts of [undefined, null, [], 'nope', 7, [null], [{}], [{accelerator: ''}]]) {
        assert.strictEqual(isConflicting('CommandOrControl+Alt+H', conflicts), false,
            JSON.stringify(conflicts));
    }
});

test('the conflict list keeps report order and drops duplicate spellings', () => {
    const list = onboardingConflictList([
        {accelerator: 'CommandOrControl+Alt+H'},
        {accelerator: 'Ctrl+Alt+H'},
        {accelerator: 'CommandOrControl+Alt+R'},
        {accelerator: ''},
        null,
        {},
        {accelerator: 'Alt+CommandOrControl+R'}
    ]);
    // One entry per *combination*, in the order it was first reported, and the
    // spelling that was reported first is the one shown.
    assert.deepStrictEqual(list, ['CommandOrControl+Alt+H', 'CommandOrControl+Alt+R']);
});

test('the conflict list is empty for anything that is not a list of entries', () => {
    for (const conflicts of [undefined, null, 'nope', 7, {}, []]) {
        assert.deepStrictEqual(onboardingConflictList(conflicts), [], JSON.stringify(conflicts));
    }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Keeping the panel modal
 * ──────────────────────────────────────────────────────────────────────────── */

test('everything behind the tour goes inert except the panel, the toast and the grain', () => {
    // The regression this prevents: the page behind the backdrop stayed
    // tabbable, so Enter could press a map card nobody can see.
    const children = [
        {id: '', className: 'grain'},
        {id: 'loadingOverlay', className: 'loading-overlay'},
        {id: 'updatingOverlay', className: 'loading-overlay updating-overlay d-none'},
        {id: '', className: 'navbar navbar-expand-md'},
        {id: '', className: 'container'},
        {id: 'settings', className: 'modal fade'},
        {id: 'tour', className: 'tour d-none'},
        {id: 'logStatus', className: 'alert note-accent logalert'},
        {id: '', className: ''}
    ];
    assert.deepStrictEqual(backgroundInertTargets(children), [1, 2, 3, 4, 5, 8]);
    // Named rather than positional, so the intent survives a reshuffle.
    const kept = backgroundInertTargets(children).map(i => children[i].id || children[i].className);
    assert.ok(!kept.some(name => name === 'tour' || name === 'logStatus' || name === 'grain'));
});

test('the inert exemptions are the two elements drawn above the tour', () => {
    assert.deepStrictEqual([...INERT_EXEMPT_IDS], ['tour', 'logStatus']);
    assert.ok(Object.isFrozen(INERT_EXEMPT_IDS));
});

test('backgroundInertTargets survives junk children and a junk list', () => {
    for (const children of [undefined, null, 'nope', 7, {}]) {
        assert.deepStrictEqual(backgroundInertTargets(children), [], JSON.stringify(children));
    }
    // An element with no id and a non-string className (an inline <svg>) is
    // still background: it must not throw and must not be exempt.
    assert.deepStrictEqual(backgroundInertTargets([null, {}, {id: 7, className: 7}]), [0, 1, 2]);
});

test('focus is pulled back only while the tour is open and only from outside', () => {
    assert.strictEqual(shouldRecaptureFocus({open: true, insidePanel: false}), true);
    assert.strictEqual(shouldRecaptureFocus({open: true, insidePanel: true}), false);
    // Closed: the tour is in the middle of handing focus back to whatever
    // opened it, and fighting that would trap the keyboard on a hidden panel.
    assert.strictEqual(shouldRecaptureFocus({open: false, insidePanel: false}), false);
    for (const state of [undefined, null, {}, 'nope']) {
        assert.strictEqual(shouldRecaptureFocus(state), false, JSON.stringify(state));
    }
    // `insidePanel` is only "inside" when it is literally true — the caller
    // passes a possibly-null relatedTarget through a `contains` check.
    assert.strictEqual(shouldRecaptureFocus({open: true, insidePanel: 'yes'}), true);
});

test('Tab wraps at both ends and leaves the middle to the browser', () => {
    const at = (state) => tabWrapTarget(Object.assign({insidePanel: true, shiftKey: false}, state));
    assert.strictEqual(at({atLast: true}), 'first');
    assert.strictEqual(at({atFirst: true}), null);
    assert.strictEqual(at({}), null);
    assert.strictEqual(at({shiftKey: true, atFirst: true}), 'last');
    assert.strictEqual(at({shiftKey: true, atLast: true}), null);
    assert.strictEqual(at({shiftKey: true}), null);
});

test('Tab from outside the panel repairs the trap in the direction of travel', () => {
    // The self-healing case: focus escaped (a click with no focusable ancestor,
    // or an `inert` the engine ignored) and the next Tab must come back rather
    // than walk the page behind the backdrop.
    assert.strictEqual(tabWrapTarget({insidePanel: false, shiftKey: false}), 'first');
    assert.strictEqual(tabWrapTarget({insidePanel: false, shiftKey: true}), 'last');
    for (const state of [undefined, null, {}, 'nope']) {
        assert.strictEqual(tabWrapTarget(state), 'first', JSON.stringify(state));
    }
});

/* ────────────────────────────────────────────────────────────────────────────
 * The strings the module names itself
 * ──────────────────────────────────────────────────────────────────────────── */

test('every key this module hands out is translated in both languages', () => {
    // `test/i18n.test.js` scans the source for keys, but these travel out of
    // here as data; asserting them from the values as well means a renamed
    // catalogue key cannot slip past by still matching the regex.
    const keys = new Set([
        'hotkeys.notBound',
        'onboarding.hotkeys.tryIt',
        'onboarding.hotkeys.tryIt.unbound',
        'onboarding.hotkeys.tryIt.taken',
        // The step's own conflict banner reuses the home page's two strings
        // rather than wording it a second way.
        'hotkeyConflict.title',
        'hotkeyConflict.help',
        // …and the Tab-map switch reuses Settings' own "needs auto-detect".
        'settings.tabMarkers.needsDetect',
        'onboarding.detect.tab.needsMarkers'
    ]);
    for (const state of [
        {autoDetect: false, markers: true},
        {autoDetect: true, markers: false}
    ]) {
        const reason = tabMarkersSwitchState(state).reasonKey;
        if (reason) keys.add(reason);
    }
    for (const row of onboardingHotkeyRows({'rotate-map': ''})) {
        keys.add(row.descriptionKey);
        if (row.labelKey) keys.add(row.labelKey);
    }
    keys.add(onboardingTryIt({}).promptKey);
    keys.add(onboardingTryIt({'toggle-map': ''}).promptKey);
    keys.add(onboardingTryIt({}, [{accelerator: SYSTEM_HOTKEY_DEFS['toggle-map'].defaultAccelerator}]).promptKey);
    for (const key of keys) {
        for (const lang of LANGUAGES) {
            assert.ok(has(lang, key), `${lang}: ${key}`);
        }
    }
});

test('every step has a title and a body string in both catalogues', () => {
    // The step sections are static markup, so a missing string would render an
    // empty panel rather than fail anywhere else.
    for (const step of ONBOARDING_STEPS) {
        for (const suffix of ['title', 'body']) {
            const key = `onboarding.${step}.${suffix}`;
            for (const lang of LANGUAGES) {
                assert.ok(CATALOGUES[lang][key], `${lang}: ${key}`);
            }
        }
    }
});
