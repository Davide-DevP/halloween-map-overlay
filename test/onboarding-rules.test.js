const {test} = require('node:test');
const assert = require('node:assert');

const {
    TOUR_VERSION,
    ONBOARDING_STEPS,
    ONBOARDING_HOTKEY_ACTIONS,
    INERT_EXEMPT_IDS,
    seenVersion,
    shouldShowOnboarding,
    stepIndex,
    stepPosition,
    nextStep,
    previousStep,
    onboardingHotkeyRows,
    isConflicting,
    onboardingConflictList,
    onboardingTryIt,
    onboardingMapHotkeys,
    ONBOARDING_MAP_HOTKEY_SAMPLE,
    placementRecap,
    backgroundInertTargets,
    shouldRecaptureFocus,
    tabWrapTarget
} = require('../src/shared/onboarding-rules');
const {SYSTEM_HOTKEY_DEFS, ACTION_TO_SETTING_KEY, isUnbound} = require('../src/shared/hotkeys-constants');
const {DEFAULT_SETTINGS} = require('../src/shared/settings-defaults');
const {MAP_PLACEMENTS} = require('../src/shared/map-placement');
const {CATALOGUES, LANGUAGES, has} = require('../src/shared/i18n');

/* ────────────────────────────────────────────────────────────────────────────
 * Should it open?
 * ──────────────────────────────────────────────────────────────────────────── */

test('the version marker ships behind TOUR_VERSION, so an old file is owed it', () => {
    // The whole once-per-version mechanism rests on this: the back-fill puts
    // `tourSeenVersion: 0` into every *existing* settings file too.
    assert.strictEqual(DEFAULT_SETTINGS.tourSeenVersion, 0);
    assert.ok(TOUR_VERSION > DEFAULT_SETTINGS.tourSeenVersion);
    assert.strictEqual(Number.isInteger(TOUR_VERSION), true);
});

test('a fresh install is owed the tutorial', () => {
    assert.strictEqual(shouldShowOnboarding({onboardingPending: true, tourSeenVersion: 0}), true);
    // …and it is owed it even if some earlier session stamped the version:
    // `onboardingPending` means "this user has never been greeted".
    assert.strictEqual(shouldShowOnboarding({onboardingPending: true, tourSeenVersion: TOUR_VERSION}), true);
});

test('an existing 0.7 install sees the new tutorial exactly once', () => {
    // The upgrade case. `onboardingPending` was back-filled false and
    // `onboardingDone` may well be true, but the version marker is behind.
    assert.strictEqual(shouldShowOnboarding({
        onboardingPending: false,
        onboardingDone: true,
        tourSeenVersion: 0
    }), true);
    // Stamped on finish or skip — and then left alone for ever.
    assert.strictEqual(shouldShowOnboarding({
        onboardingPending: false,
        onboardingDone: true,
        tourSeenVersion: TOUR_VERSION
    }), false);
});

test('a completed tutorial does not open again', () => {
    assert.strictEqual(shouldShowOnboarding({
        onboardingPending: false,
        tourSeenVersion: TOUR_VERSION
    }), false);
    // A marker from the future (a downgrade) is still "seen".
    assert.strictEqual(shouldShowOnboarding({
        onboardingPending: false,
        tourSeenVersion: TOUR_VERSION + 7
    }), false);
});

test('pressing Next six times changes nothing, so a quit mid-tutorial is the only replay', () => {
    // Nothing is stamped until Finish or Skip, so a quit, a crash or an update
    // restart mid-tutorial leaves `onboardingPending` true and the marker
    // behind — both of which ask for it again.
    assert.strictEqual(shouldShowOnboarding({onboardingPending: true, tourSeenVersion: 0}), true);
    assert.strictEqual(shouldShowOnboarding({onboardingPending: false, tourSeenVersion: 0}), true);
});

test('only a literal true counts for the pending marker', () => {
    for (const pending of ['true', 1, {}, [], 'yes']) {
        assert.strictEqual(shouldShowOnboarding({
            onboardingPending: pending,
            tourSeenVersion: TOUR_VERSION
        }), false, JSON.stringify(pending));
    }
});

test('onboardingDone can no longer suppress the tutorial on its own', () => {
    // 0.7 gated on it; 1.0 does not, or nobody who finished the old tour would
    // ever see the new one.
    assert.strictEqual(shouldShowOnboarding({onboardingDone: true, tourSeenVersion: 0}), true);
});

test('a hand-edited version marker reads as 0, i.e. "show it once"', () => {
    // Garbage must not be able to suppress it for ever; it costs one tutorial.
    for (const junk of ['2', 'nope', null, undefined, NaN, Infinity, -1, {}, [], true]) {
        assert.strictEqual(seenVersion(junk), 0, JSON.stringify(junk));
        assert.strictEqual(shouldShowOnboarding({tourSeenVersion: junk}), true, JSON.stringify(junk));
    }
    // A float is floored rather than rejected.
    assert.strictEqual(seenVersion(2.9), 2);
    assert.strictEqual(seenVersion(0), 0);
    assert.strictEqual(seenVersion(5), 5);
});

test('a missing or junk state shows the tutorial rather than swallowing it', () => {
    // The opposite default from 0.7: with a version marker, "I cannot tell"
    // means "this install has not seen this version".
    for (const state of [undefined, null, {}, 'nope', 42]) {
        assert.strictEqual(shouldShowOnboarding(state), true, JSON.stringify(state));
    }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Which step next?
 * ──────────────────────────────────────────────────────────────────────────── */

test('the steps are the six the design calls for, in order', () => {
    assert.deepStrictEqual([...ONBOARDING_STEPS],
        ['welcome', 'where', 'setup', 'layers', 'hotkeys', 'done']);
    // Frozen: the renderer holds step ids in `data-tour-step` attributes and a
    // reordering at runtime would silently show the wrong section.
    assert.ok(Object.isFrozen(ONBOARDING_STEPS));
});

test('the choice comes before what it configures', () => {
    // The ordering is the argument: step 3 shows the corner controls, the map
    // key or both depending on step 2, so step 2 has to come first. The layers
    // step then precedes the hotkeys step, so the "show / hide the points" row
    // lands on something just explained.
    assert.ok(stepIndex('where') < stepIndex('setup'));
    assert.ok(stepIndex('layers') < stepIndex('hotkeys'));
    // No separate step for the experimental mode: it is one of the three cards.
    assert.strictEqual(stepIndex('tab'), -1);
    assert.strictEqual(stepIndex('detect'), -1);
    assert.strictEqual(stepIndex('markers'), -1);
    assert.strictEqual(stepIndex('placement'), -1);
});

test('next/previous walk the sequence and stop at both ends', () => {
    assert.strictEqual(previousStep('welcome'), null);
    assert.strictEqual(nextStep('welcome'), 'where');
    assert.strictEqual(nextStep('where'), 'setup');
    assert.strictEqual(nextStep('setup'), 'layers');
    assert.strictEqual(nextStep('layers'), 'hotkeys');
    assert.strictEqual(nextStep('hotkeys'), 'done');
    // `null` from the last step is how the caller knows Next means "finish".
    assert.strictEqual(nextStep('done'), null);
    assert.strictEqual(previousStep('done'), 'hotkeys');
    assert.strictEqual(previousStep('where'), 'welcome');
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
    assert.deepStrictEqual(stepPosition('setup'), {
        id: 'setup', index: 2, number: 3, total, first: false, last: false
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
        assert.strictEqual(nextStep(junk), 'where');
        assert.strictEqual(previousStep(junk), null);
    }
});

/* ────────────────────────────────────────────────────────────────────────────
 * The hotkeys step
 * ──────────────────────────────────────────────────────────────────────────── */

test('the listed actions are exactly the ones that ship with a key', () => {
    assert.deepStrictEqual([...ONBOARDING_HOTKEY_ACTIONS],
        ['toggle-map', 'toggle-markers', 'next-map', 'prev-map', 'clear-map']);
    for (const actionId of ONBOARDING_HOTKEY_ACTIONS) {
        assert.ok(SYSTEM_HOTKEY_DEFS[actionId], `${actionId} is not a system hotkey`);
    }
    assert.strictEqual(ONBOARDING_HOTKEY_ACTIONS[0], 'toggle-map');
    // Derived from the defaults rather than asserted by hand: the step must not
    // teach a combination the app ships without.
    const bound = Object.keys(SYSTEM_HOTKEY_DEFS)
        .filter(id => !isUnbound(SYSTEM_HOTKEY_DEFS[id].defaultAccelerator));
    assert.deepStrictEqual([...ONBOARDING_HOTKEY_ACTIONS].sort(), bound.sort());
    // Still a subset, not the whole table — the tutorial is not the manual.
    assert.ok(ONBOARDING_HOTKEY_ACTIONS.length < Object.keys(SYSTEM_HOTKEY_DEFS).length);
});

test('every row carries the action id the inline "change" needs', () => {
    // The step opens the **real** bind dialog rather than growing a second key
    // recorder, and that dialog is addressed by action id.
    for (const row of onboardingHotkeyRows({})) {
        assert.ok(SYSTEM_HOTKEY_DEFS[row.actionId], row.actionId);
    }
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
    // The whole point: the defaults already moved twice (0.7, 1.0) and every one
    // of them is rebindable, so nothing user-visible may hard-code a
    // combination.
    const rows = onboardingHotkeyRows({'toggle-map': 'CommandOrControl+Alt+F8'});
    assert.strictEqual(rows[0].accelerator, 'CommandOrControl+Alt+F8');
    assert.strictEqual(rows[0].bound, true);
    // …and the untouched ones still read as the default.
    const next = rows.find(r => r.actionId === 'next-map');
    assert.strictEqual(next.accelerator, SYSTEM_HOTKEY_DEFS['next-map'].defaultAccelerator);
});

test('an unbound action says "no key" and claims no accelerator', () => {
    for (const unbound of ['', '   ', '\t']) {
        const rows = onboardingHotkeyRows({'next-map': unbound});
        const row = rows.find(r => r.actionId === 'next-map');
        assert.strictEqual(row.bound, false, JSON.stringify(unbound));
        assert.strictEqual(row.accelerator, '');
        // The same string the Hotkeys table uses, so the two cannot disagree.
        assert.strictEqual(row.labelKey, 'hotkeys.notBound');
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
    const elsewhere = onboardingTryIt({}, [{accelerator: 'CommandOrControl+Alt+F13'}]);
    assert.strictEqual(elsewhere.promptKey, 'onboarding.hotkeys.tryIt');
});

/* ────────────────────────────────────────────────────────────────────────────
 * "Each map has its own key too"
 *
 * The step used to say "each map has its own number", which is only true of a
 * fresh install: the map keys live in `hotkeys.json` and are the user's to
 * change, so the sentence names the real ones or does not name any.
 * ──────────────────────────────────────────────────────────────────────────── */

const MAP_KEYS = {
    'CommandOrControl+Alt+1': {id: 'a', mapKey: 'deftyconchgaming/East Haddonfield'},
    'CommandOrControl+Alt+2': {id: 'b', mapKey: 'deftyconchgaming/Haddonfield Heights'},
    'CommandOrControl+Alt+3': {id: 'c', mapKey: 'deftyconchgaming/Haddonfield Town Center'},
    'CommandOrControl+Alt+4': {id: 'd', mapKey: 'deftyconchgaming/Orange Grove Estates'}
};

test('the map-key line names the bound keys, in file order, capped at the sample', () => {
    const answer = onboardingMapHotkeys(MAP_KEYS);
    assert.strictEqual(answer.promptKey, 'onboarding.hotkeys.maps');
    assert.deepStrictEqual(answer.keys,
        ['CommandOrControl+Alt+1', 'CommandOrControl+Alt+2', 'CommandOrControl+Alt+3']);
    assert.strictEqual(answer.keys.length, ONBOARDING_MAP_HOTKEY_SAMPLE);
    // A rebound file is followed, not the shipped defaults.
    assert.deepStrictEqual(onboardingMapHotkeys({'Alt+F5': {id: 'x', mapKey: 'a/One'}}).keys,
        ['Alt+F5']);
});

test('fewer than the sample is fine; the line just names those', () => {
    const two = onboardingMapHotkeys({
        'Alt+F5': {id: 'x', mapKey: 'a/One'},
        'Alt+F6': {id: 'y', mapKey: 'a/Two'}
    });
    assert.deepStrictEqual(two.keys, ['Alt+F5', 'Alt+F6']);
    assert.strictEqual(two.promptKey, 'onboarding.hotkeys.maps');
});

test('no map keys at all changes the sentence instead of showing an empty chip', () => {
    for (const store of [{}, undefined, null, 'nope', 7, []]) {
        const answer = onboardingMapHotkeys(store);
        assert.deepStrictEqual(answer.keys, [], JSON.stringify(store));
        assert.strictEqual(answer.promptKey, 'onboarding.hotkeys.maps.none');
    }
});

test('a broken row is not a key worth teaching', () => {
    // A hand-edited `hotkeys.json` can hold anything; a row with no map would
    // name a combination that does nothing.
    const answer = onboardingMapHotkeys({
        '': {id: 'a', mapKey: 'a/One'},
        '   ': {id: 'b', mapKey: 'a/Two'},
        'Alt+F7': null,
        'Alt+F8': {id: 'c'},
        'Alt+F9': {id: 'd', mapKey: '   '},
        'Alt+F10': {id: 'e', mapKey: 7},
        'Alt+F11': {id: 'f', mapKey: 'a/Three'}
    });
    assert.deepStrictEqual(answer.keys, ['Alt+F11']);
});

test('one combination spelled two ways is named once', () => {
    // `sameAccelerator`, not string equality — the same rule the conflict list
    // and the "try it" branch use.
    const answer = onboardingMapHotkeys({
        'CommandOrControl+Alt+1': {id: 'a', mapKey: 'a/One'},
        'ctrl+alt+1': {id: 'b', mapKey: 'a/Two'},
        'Alt+F9': {id: 'c', mapKey: 'a/Three'}
    });
    assert.deepStrictEqual(answer.keys, ['CommandOrControl+Alt+1', 'Alt+F9']);
});

/* ────────────────────────────────────────────────────────────────────────────
 * The recap on the last step
 * ──────────────────────────────────────────────────────────────────────────── */

test('the recap names the choice that was actually made', () => {
    assert.deepStrictEqual(placementRecap('corner'),
        {placement: 'corner', labelKey: 'onboarding.recap.corner'});
    assert.deepStrictEqual(placementRecap('tab'),
        {placement: 'tab', labelKey: 'onboarding.recap.tab'});
    assert.deepStrictEqual(placementRecap('both'),
        {placement: 'both', labelKey: 'onboarding.recap.both'});
});

test('the recap has one string per placement and nothing else', () => {
    const keys = new Set(MAP_PLACEMENTS.map(p => placementRecap(p).labelKey));
    assert.strictEqual(keys.size, MAP_PLACEMENTS.length);
    for (const junk of ['nope', null, undefined, 7]) {
        assert.strictEqual(placementRecap(junk).labelKey, 'onboarding.recap.corner',
            JSON.stringify(junk));
    }
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

test('everything behind the tutorial goes inert except the four exemptions', () => {
    // The regression this prevents: the page behind the backdrop stayed
    // tabbable, so Enter could press a map card nobody can see.
    const children = [
        {id: '', className: 'grain'},
        {id: 'loadingOverlay', className: 'loading-overlay'},
        {id: 'updatingOverlay', className: 'loading-overlay updating-overlay d-none'},
        {id: '', className: 'navbar navbar-expand-md'},
        {id: '', className: 'container'},
        {id: 'settings', className: 'modal fade'},
        {id: 'addHotkeyModal', className: 'modal fade'},
        {id: 'hotkeyToast', className: 'toast'},
        {id: 'faqModal', className: 'modal fade'},
        {id: 'tour', className: 'tour d-none'},
        {id: 'logStatus', className: 'alert note-accent logalert'},
        {id: '', className: ''}
    ];
    assert.deepStrictEqual(backgroundInertTargets(children), [1, 2, 3, 4, 5, 11]);
    // Named rather than positional, so the intent survives a reshuffle.
    const kept = backgroundInertTargets(children).map(i => children[i].id || children[i].className);
    for (const exempt of ['tour', 'logStatus', 'grain', 'addHotkeyModal', 'hotkeyToast', 'faqModal']) {
        assert.ok(!kept.includes(exempt), exempt);
    }
});

test('the inert exemptions are the elements that keep working above the tutorial', () => {
    // The bind dialog, its toast and the FAQ are exempt because the tutorial
    // opens the real ones rather than growing copies of its own.
    assert.deepStrictEqual([...INERT_EXEMPT_IDS],
        ['tour', 'logStatus', 'addHotkeyModal', 'hotkeyToast', 'faqModal']);
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

test('focus is pulled back only while the tutorial is open and only from outside', () => {
    assert.strictEqual(shouldRecaptureFocus({open: true, insidePanel: false}), true);
    assert.strictEqual(shouldRecaptureFocus({open: true, insidePanel: true}), false);
    // Closed: the tutorial is in the middle of handing focus back to whatever
    // opened it, and fighting that would trap the keyboard on a hidden panel.
    assert.strictEqual(shouldRecaptureFocus({open: false, insidePanel: false}), false);
    for (const state of [undefined, null, {}, 'nope']) {
        assert.strictEqual(shouldRecaptureFocus(state), false, JSON.stringify(state));
    }
    // `insidePanel` is only "inside" when it is literally true — the caller
    // passes a possibly-null relatedTarget through a `contains` check.
    assert.strictEqual(shouldRecaptureFocus({open: true, insidePanel: 'yes'}), true);
});

test('the bind dialog gets focus to itself while it is open', () => {
    // Two focus traps fighting over the keyboard left the key recorder unable
    // to be focused at all, so the tutorial stands down for the real dialog.
    assert.strictEqual(shouldRecaptureFocus({open: true, insidePanel: false, dialogOpen: true}), false);
    assert.strictEqual(shouldRecaptureFocus({open: true, insidePanel: true, dialogOpen: true}), false);
    // Only a literal true stands it down.
    for (const value of ['yes', 1, {}, null, undefined]) {
        assert.strictEqual(shouldRecaptureFocus({open: true, insidePanel: false, dialogOpen: value}),
            true, JSON.stringify(value));
    }
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

test('every key this module hands out is translated in every language', () => {
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
        'hotkeyConflict.help'
    ]);
    for (const row of onboardingHotkeyRows({'next-map': ''})) {
        keys.add(row.descriptionKey);
        if (row.labelKey) keys.add(row.labelKey);
    }
    keys.add(onboardingTryIt({}).promptKey);
    keys.add(onboardingTryIt({'toggle-map': ''}).promptKey);
    keys.add(onboardingTryIt({}, [{accelerator: SYSTEM_HOTKEY_DEFS['toggle-map'].defaultAccelerator}]).promptKey);
    keys.add(onboardingMapHotkeys(MAP_KEYS).promptKey);
    keys.add(onboardingMapHotkeys({}).promptKey);
    for (const placement of MAP_PLACEMENTS) keys.add(placementRecap(placement).labelKey);
    for (const key of keys) {
        for (const lang of LANGUAGES) {
            assert.ok(has(lang, key), `${lang}: ${key}`);
        }
    }
});

test('every step has a title and a body string in every catalogue', () => {
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
