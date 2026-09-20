const {test} = require('node:test');
const assert = require('node:assert');

const {
    normalizeAccelerator,
    acceleratorKey,
    sameAccelerator,
    boundEntries,
    findSystemConflict,
    findMapConflict,
    canResetToDefault,
    shadowedMapBindings,
    duplicateMapBindings,
    ownAcceleratorKeys,
    FOREGROUND_GAME,
    FOREGROUND_OWN,
    FOREGROUND_OTHER,
    FOREGROUND_UNKNOWN,
    shouldHotkeysBeActive,
    hotkeysShouldBeRegistered,
    MODIFIER_ALIASES,
    MODIFIER_ORDER
} = require('../src/shared/hotkeys-rules');
const {
    SYSTEM_HOTKEY_DEFS, UNBOUND_ACCELERATOR, ACCELERATOR_MODIFIERS, keyEventToAccelerator
} = require('../src/shared/hotkeys-constants');

/* ────────────────────────────────────────────────────────────────────────────
 * normalizeAccelerator
 *
 * Up to 0.6.0 every conflict check was raw string equality, so a hand-edited
 * `Ctrl+R` in hotkeys.json did not collide with the `CommandOrControl+R` a
 * system action held — while Electron registers them as one combination, so
 * the second registration failed and was reported as "taken by another
 * application". These are the spellings that has to survive.
 * ──────────────────────────────────────────────────────────────────────────── */

test('normalizeAccelerator: every Control spelling folds into one token', () => {
    for (const spelling of ['Ctrl+R', 'Control+R', 'CmdOrCtrl+R', 'CommandOrControl+R',
        'ctrl+r', 'CONTROL+R', 'cmdorctrl+R', ' Ctrl + R ']) {
        assert.strictEqual(normalizeAccelerator(spelling), 'CommandOrControl+R', spelling);
    }
});

test('normalizeAccelerator: Alt/Option and Super/Meta fold too, AltGr does not', () => {
    assert.strictEqual(normalizeAccelerator('Option+K'), 'Alt+K');
    assert.strictEqual(normalizeAccelerator('Alt+K'), 'Alt+K');
    assert.strictEqual(normalizeAccelerator('Meta+K'), 'Super+K');
    assert.strictEqual(normalizeAccelerator('Super+K'), 'Super+K');
    assert.strictEqual(normalizeAccelerator('AltGr+K'), 'AltGr+K');
});

test('normalizeAccelerator: Cmd/Command/Meta/Super are one modifier, never Control', () => {
    // Confirmed against electron v40.10.6 `shell/common/keyboard_util.cc`:
    // "cmd", "command", "meta" and "super" all resolve to `VKEY_COMMAND`, and
    // `StringToAccelerator` maps that to a single `EF_COMMAND_DOWN` (the Win
    // key on Windows). So all four really are the same accelerator.
    const canonical = 'Super+K';
    for (const spelling of ['Cmd+K', 'Command+K', 'Meta+K', 'Super+K', 'cmd+k', 'COMMAND+K']) {
        assert.strictEqual(normalizeAccelerator(spelling), canonical, spelling);
    }
    assert.ok(sameAccelerator('Cmd+R', 'Super+R'));
    // But `cmdorctrl` is `VKEY_CONTROL` off macOS, so these stay different.
    assert.notStrictEqual(normalizeAccelerator('Cmd+R'), normalizeAccelerator('Ctrl+R'));
    assert.ok(!sameAccelerator('Cmd+R', 'CommandOrControl+R'));
});

test('normalizeAccelerator: modifier order does not matter', () => {
    const canonical = 'CommandOrControl+Alt+Shift+Up';
    for (const spelling of ['Ctrl+Alt+Shift+Up', 'Shift+Ctrl+Alt+Up', 'Alt+Shift+Control+Up',
        'shift+alt+cmdorctrl+up', 'CommandOrControl+Shift+Alt+UP']) {
        assert.strictEqual(normalizeAccelerator(spelling), canonical, spelling);
    }
    // Which is exactly the pair that used to slip past a string comparison.
    assert.ok(sameAccelerator('Shift+Ctrl+R', 'Ctrl+Shift+R'));
    assert.ok(sameAccelerator('Ctrl+R', 'CommandOrControl+R'));
    assert.ok(sameAccelerator('ctrl+r', 'CommandOrControl+R'));
});

test('normalizeAccelerator: a repeated modifier is one modifier', () => {
    assert.strictEqual(normalizeAccelerator('Ctrl+Control+R'), 'CommandOrControl+R');
    assert.strictEqual(normalizeAccelerator('Alt+Option+Ctrl+R'), 'CommandOrControl+Alt+R');
});

test('normalizeAccelerator: the modifier order is the documented one', () => {
    assert.deepStrictEqual(MODIFIER_ORDER,
        ['CommandOrControl', 'Super', 'AltGr', 'Alt', 'Shift']);
    assert.strictEqual(normalizeAccelerator('Shift+Alt+Super+Ctrl+P'),
        'CommandOrControl+Super+Alt+Shift+P');
});

test('normalizeAccelerator: key names get a canonical case', () => {
    assert.strictEqual(normalizeAccelerator('Ctrl+h'), 'CommandOrControl+H');
    assert.strictEqual(normalizeAccelerator('Ctrl+RIGHT'), 'CommandOrControl+Right');
    assert.strictEqual(normalizeAccelerator('Ctrl+pageup'), 'CommandOrControl+PageUp');
    assert.strictEqual(normalizeAccelerator('Ctrl+f5'), 'CommandOrControl+F5');
    assert.strictEqual(normalizeAccelerator('Ctrl+F24'), 'CommandOrControl+F24');
    assert.strictEqual(normalizeAccelerator('Ctrl+num7'), 'CommandOrControl+num7');
    assert.strictEqual(normalizeAccelerator('Ctrl+NUMDEC'), 'CommandOrControl+numdec');
    assert.strictEqual(normalizeAccelerator('Ctrl+space'), 'CommandOrControl+Space');
    assert.strictEqual(normalizeAccelerator('Ctrl+printscreen'), 'CommandOrControl+PrintScreen');
});

test('normalizeAccelerator: Esc/Escape and Enter/Return are one key each', () => {
    assert.strictEqual(normalizeAccelerator('Ctrl+Escape'), 'CommandOrControl+Esc');
    assert.strictEqual(normalizeAccelerator('Ctrl+Esc'), 'CommandOrControl+Esc');
    assert.strictEqual(normalizeAccelerator('Ctrl+Enter'), 'CommandOrControl+Return');
    assert.strictEqual(normalizeAccelerator('Ctrl+Return'), 'CommandOrControl+Return');
    assert.ok(sameAccelerator('Alt+Escape', 'Alt+Esc'));
});

test('normalizeAccelerator: "Plus" is the `=` key with Shift, as Electron has it', () => {
    // `KeyboardCodeFromKeyIdentifier` (electron v40.10.6) has
    // `{"plus", {VKEY_OEM_PLUS, '+'}}` — the `=` key, with a `shifted_char`
    // that makes `StringToAccelerator` OR in `EF_SHIFT_DOWN`. So `Ctrl+Plus`
    // and `Ctrl+Shift+=` are one and the same registration.
    assert.strictEqual(normalizeAccelerator('Ctrl+Plus'), 'CommandOrControl+Shift+=');
    assert.strictEqual(normalizeAccelerator('ctrl+plus'), 'CommandOrControl+Shift+=');
    assert.strictEqual(normalizeAccelerator('Ctrl+Shift+Plus'), 'CommandOrControl+Shift+=');
    assert.ok(sameAccelerator('Ctrl+Plus', 'Ctrl+Shift+='));
    // And plain `=` is the unshifted key, which is a different accelerator.
    assert.strictEqual(normalizeAccelerator('Ctrl+='), 'CommandOrControl+=');
    assert.ok(!sameAccelerator('Ctrl+Plus', 'Ctrl+='));
});

test('normalizeAccelerator: empty segments vanish, exactly as Electron drops them', () => {
    // `base::SplitStringPiece(..., base::SPLIT_WANT_NONEMPTY)` in
    // `StringToAccelerator`: empty tokens are **dropped**, not errors. Which
    // means the intuitive readings are all wrong, and these are the real ones.
    assert.strictEqual(normalizeAccelerator('Ctrl++R'), 'CommandOrControl+R');
    assert.ok(sameAccelerator('Ctrl++R', 'CommandOrControl+R'));
    assert.strictEqual(normalizeAccelerator('+R'), 'R');
    assert.strictEqual(normalizeAccelerator('Ctrl+++Alt+R'), 'CommandOrControl+Alt+R');
    // `Ctrl++` and `+` leave no key token at all, so Electron logs
    // "doesn't contain a valid key" and returns false.
    assert.strictEqual(normalizeAccelerator('Ctrl++'), null);
    assert.strictEqual(normalizeAccelerator('+'), null);
    assert.strictEqual(normalizeAccelerator('++'), null);
    assert.strictEqual(normalizeAccelerator('Ctrl+'), null);
});

test('normalizeAccelerator: several key tokens — the last one wins', () => {
    // Electron's loop puts every non-modifier token into `key`, overwriting,
    // so `Ctrl+A+B` is a perfectly valid `Ctrl+B`. Replicated rather than
    // rejected: a hand-edited `hotkeys.json` holding it really does register
    // Ctrl+B and really can collide with another entry's Ctrl+B.
    assert.strictEqual(normalizeAccelerator('Ctrl+A+B'), 'CommandOrControl+B');
    assert.ok(sameAccelerator('Ctrl+A+B', 'Ctrl+B'));
    // An unrecognised token is only fatal if nothing valid follows it.
    assert.strictEqual(normalizeAccelerator('Ctrl+Nonsense+A'), 'CommandOrControl+A');
    assert.strictEqual(normalizeAccelerator('Hyper+R'), 'R');
    assert.strictEqual(normalizeAccelerator('Ctrl+A+Nonsense'), null);
});

test('normalizeAccelerator: shifted punctuation is its unshifted key plus Shift', () => {
    // Transcribed from `KeyboardCodeFromCharCode`: `!` is `{VKEY_1, '!'}` and
    // `StringToAccelerator` ORs in EF_SHIFT_DOWN for any `shifted_char`. This
    // is reachable straight from the UI — recording Ctrl+Shift+1 on a US
    // layout gives `KeyboardEvent.key === '!'`, so the app stores
    // `CommandOrControl+Shift+!` and must see it as the same binding.
    const pairs = [
        ['!', '1'], ['@', '2'], ['#', '3'], ['$', '4'], ['%', '5'],
        ['^', '6'], ['&', '7'], ['*', '8'], ['(', '9'], [')', '0'],
        ['_', '-'], [':', ';'], ['"', "'"], ['<', ','], ['>', '.'],
        ['?', '/'], ['{', '['], ['}', ']'], ['|', '\\'], ['~', '`']
    ];
    for (const [shifted, base] of pairs) {
        assert.strictEqual(normalizeAccelerator('Ctrl+' + shifted),
            `CommandOrControl+Shift+${base}`, shifted);
        // Both spellings of the same registration, and the one the key capture
        // actually produces.
        assert.ok(sameAccelerator('Ctrl+' + shifted, 'Ctrl+Shift+' + base), shifted);
        assert.ok(sameAccelerator('CommandOrControl+Shift+' + shifted, 'Ctrl+Shift+' + base), shifted);
        // …and the unshifted key is still a different accelerator.
        assert.ok(!sameAccelerator('Ctrl+' + shifted, 'Ctrl+' + base), shifted);
    }
});

test('normalizeAccelerator: unshifted punctuation passes through', () => {
    for (const key of ['-', '=', '[', ']', ';', "'", ',', '.', '/', '\\', '`']) {
        assert.strictEqual(normalizeAccelerator('Ctrl+' + key), 'CommandOrControl+' + key, key);
    }
});

test('normalizeAccelerator: non-ASCII is refused, like Electron refuses it', () => {
    // `StringToAccelerator` bails on `!base::IsStringASCII(shortcut)` before
    // it looks at anything else.
    for (const value of ['Ctrl+é', 'Ctrl+Ω', 'Ctrl+日', 'Ctrl+ R']) {
        assert.strictEqual(normalizeAccelerator(value), null, value);
    }
});

test('normalizeAccelerator: a modifier-less key is still an accelerator', () => {
    // `hasModifier` is what refuses those; normalisation only says whether
    // Electron could parse the string.
    assert.strictEqual(normalizeAccelerator('H'), 'H');
    assert.strictEqual(normalizeAccelerator('f1'), 'F1');
});

test('normalizeAccelerator: unparseable input is null, never a guess', () => {
    const bad = [
        '', '   ', '++', 'Ctrl+',
        'Ctrl+Shift',          // no key at all, only modifiers
        'Shift',               // ditto
        'Ctrl+Nonsense', 'Ctrl+F25', 'Ctrl+ArrowRight', 'Ctrl+num10',
        null, undefined, 42, {}, [], true
    ];
    for (const value of bad) {
        assert.strictEqual(normalizeAccelerator(value), null, JSON.stringify(value) || String(value));
    }
});

test('the modifier tokens this app knows are exactly the ones hasModifier knows', () => {
    // `hasModifier` (hotkeys-constants) and `MODIFIER_ALIASES` (here) both have
    // to list every modifier spelling Electron accepts. One of them missing an
    // alias means either a modifier-less binding slips through or a normalised
    // form treats a modifier as the key.
    assert.deepStrictEqual(Object.keys(MODIFIER_ALIASES).sort(),
        [...ACCELERATOR_MODIFIERS].sort());
});

test('acceleratorKey: an unparseable string still matches itself', () => {
    // A garbage binding goes into the conflict banner, so it must not silently
    // become "the same" as a different garbage binding — nor as a real one.
    assert.strictEqual(acceleratorKey('Ctrl+ArrowRight'), 'ctrl+arrowright');
    assert.ok(sameAccelerator('Ctrl+ArrowRight', 'ctrl+ArrowRight'));
    assert.ok(!sameAccelerator('Ctrl+ArrowRight', 'Ctrl+ArrowLeft'));
    assert.ok(!sameAccelerator('Ctrl+ArrowRight', 'CommandOrControl+Right'));
});

test('acceleratorKey / sameAccelerator: nothing is ever equal to unbound', () => {
    for (const value of ['', '   ', null, undefined, 0, {}]) {
        assert.strictEqual(acceleratorKey(value), '', String(value));
    }
    assert.ok(!sameAccelerator('', ''));
    assert.ok(!sameAccelerator(UNBOUND_ACCELERATOR, UNBOUND_ACCELERATOR));
    assert.ok(!sameAccelerator('Ctrl+R', ''));
    assert.ok(!sameAccelerator('', 'Ctrl+R'));
});

test('every shipped default is already in canonical form', () => {
    // Not cosmetic: `settings-defaults.js` stores these verbatim and the
    // migration compares a stored value against them, so a default that was
    // not canonical would be one more spelling to think about.
    for (const [actionId, def] of Object.entries(SYSTEM_HOTKEY_DEFS)) {
        assert.strictEqual(normalizeAccelerator(def.defaultAccelerator), def.defaultAccelerator, actionId);
    }
});

/* ────────────────────────────────────────────────────────────────────────────
 * The system hotkey map
 * ──────────────────────────────────────────────────────────────────────────── */

const EFFECTIVE = {
    'toggle-map': 'CommandOrControl+Alt+H',
    'rotate-map': 'CommandOrControl+Alt+R',
    'clear-map': UNBOUND_ACCELERATOR
};

test('boundEntries: only the actions that hold a combination', () => {
    assert.deepStrictEqual(boundEntries(EFFECTIVE).map(([id]) => id), ['toggle-map', 'rotate-map']);
    // An empty string must never look like a held accelerator:
    // globalShortcut.register('') throws, and an '' in a "taken" set would make
    // every unbound action collide with every other one.
    assert.ok(!boundEntries(EFFECTIVE).some(([, a]) => a === ''));
    assert.deepStrictEqual(boundEntries(null), []);
    assert.deepStrictEqual(boundEntries({a: '  '}), []);
});

test('findSystemConflict: normalised, with a self-exception', () => {
    assert.strictEqual(findSystemConflict(EFFECTIVE, 'ctrl+alt+h'), 'toggle-map');
    assert.strictEqual(findSystemConflict(EFFECTIVE, 'Alt+Shift+Ctrl+H'), null);
    assert.strictEqual(findSystemConflict(EFFECTIVE, 'Shift+Ctrl+Alt+H'), null);
    assert.strictEqual(findSystemConflict(EFFECTIVE, 'Control+Alt+R'), 'rotate-map');
    // The action being re-bound or reset must not conflict with itself.
    assert.strictEqual(findSystemConflict(EFFECTIVE, 'Ctrl+Alt+R', 'rotate-map'), null);
    // An unbound action holds nothing, so nothing collides with it.
    assert.strictEqual(findSystemConflict(EFFECTIVE, ''), null);
    assert.strictEqual(findSystemConflict(EFFECTIVE, 'Ctrl+Alt+Q'), null);
});

test('findMapConflict: returns the key as the file spells it', () => {
    const file = {'ctrl+alt+1': {id: 'a', mapKey: 'x/y'}, 'CommandOrControl+Alt+2': {id: 'b', mapKey: 'x/z'}};
    // The *stored* spelling comes back so a message can name what is actually
    // in the file rather than a canonical form the user never typed.
    assert.strictEqual(findMapConflict(file, 'CommandOrControl+Alt+1'), 'ctrl+alt+1');
    assert.strictEqual(findMapConflict(file, 'Alt+Ctrl+2'), 'CommandOrControl+Alt+2');
    assert.strictEqual(findMapConflict(file, 'Ctrl+Alt+3'), null);
    assert.strictEqual(findMapConflict(file, ''), null);
    assert.strictEqual(findMapConflict(null, 'Ctrl+Alt+1'), null);
});

test('canResetToDefault: free, taken by another action, taken by a map', () => {
    const def = SYSTEM_HOTKEY_DEFS['rotate-map'].defaultAccelerator;

    assert.deepStrictEqual(canResetToDefault({
        effective: {'rotate-map': 'Alt+K'}, mapHotkeys: {}, actionId: 'rotate-map', defaultAccelerator: def
    }), {ok: true});

    // Unbind rotate, give its default to another action, press Reset.
    assert.deepStrictEqual(canResetToDefault({
        effective: {'rotate-map': '', 'clear-map': 'ctrl+alt+r'},
        mapHotkeys: {}, actionId: 'rotate-map', defaultAccelerator: def
    }), {ok: false, kind: 'system', actionId: 'clear-map'});

    // …or to a map, in a spelling string equality would have missed.
    assert.deepStrictEqual(canResetToDefault({
        effective: {'rotate-map': ''},
        mapHotkeys: {'Alt+Ctrl+R': {id: 'a', mapKey: 'x/y'}},
        actionId: 'rotate-map', defaultAccelerator: def
    }), {ok: false, kind: 'map', accelerator: 'Alt+Ctrl+R'});

    // Resetting an action that is *already* on its default is not a conflict
    // with itself.
    assert.deepStrictEqual(canResetToDefault({
        effective: {'rotate-map': def}, mapHotkeys: {}, actionId: 'rotate-map', defaultAccelerator: def
    }), {ok: true});
});

test('shadowedMapBindings: system hotkeys win, whatever the spelling', () => {
    const file = {
        'ctrl+alt+h': {id: 'a', mapKey: 'x/y'},
        'CommandOrControl+Alt+7': {id: 'b', mapKey: 'x/z'}
    };
    assert.deepStrictEqual(shadowedMapBindings(EFFECTIVE, file),
        [{accelerator: 'ctrl+alt+h', actionId: 'toggle-map'}]);
    // An unbound system action shadows nothing.
    assert.deepStrictEqual(shadowedMapBindings({'clear-map': ''}, file), []);
    assert.deepStrictEqual(shadowedMapBindings(EFFECTIVE, null), []);
});

test('duplicateMapBindings: two spellings of one combination in one file', () => {
    // JSON cannot hold a key twice, but it can hold these two — and Electron
    // considers them one accelerator, so the second register() came back false
    // and blamed another application for our own file.
    const file = {
        'CommandOrControl+Alt+1': {id: 'a', mapKey: 'x/1'},
        'ctrl+alt+1': {id: 'b', mapKey: 'x/2'},
        'Alt+Ctrl+1': {id: 'c', mapKey: 'x/3'},
        'CommandOrControl+Alt+2': {id: 'd', mapKey: 'x/4'}
    };
    assert.deepStrictEqual(duplicateMapBindings(file), [
        {accelerator: 'ctrl+alt+1', first: 'CommandOrControl+Alt+1'},
        {accelerator: 'Alt+Ctrl+1', first: 'CommandOrControl+Alt+1'}
    ]);
    assert.deepStrictEqual(duplicateMapBindings({'Ctrl+Alt+1': {}, 'Ctrl+Alt+2': {}}), []);
    assert.deepStrictEqual(duplicateMapBindings(null), []);
});

test('ownAcceleratorKeys: normalised, and never the empty string', () => {
    const file = {'ctrl+alt+1': {id: 'a', mapKey: 'x/y'}};
    const held = ownAcceleratorKeys(EFFECTIVE, file);
    assert.deepStrictEqual([...held].sort(), [
        'CommandOrControl+Alt+1', 'CommandOrControl+Alt+H', 'CommandOrControl+Alt+R'
    ]);
    assert.ok(!held.has(''));
    // Which is the point: `rejectIfUnregisterable` skips its dry run for
    // anything in here, and an '' in the set would skip the one check that
    // keeps an unparseable accelerator out of the settings file.
    assert.ok(held.has(acceleratorKey('Alt+Ctrl+1')));
});

/* ────────────────────────────────────────────────────────────────────────────
 * hotkeysGameOnly
 * ──────────────────────────────────────────────────────────────────────────── */

test('shouldHotkeysBeActive: with the setting off the hotkeys are always held', () => {
    for (const foreground of [FOREGROUND_GAME, FOREGROUND_OWN, FOREGROUND_OTHER, FOREGROUND_UNKNOWN]) {
        assert.strictEqual(shouldHotkeysBeActive({gameOnly: false, foreground}), true, foreground);
    }
});

test('shouldHotkeysBeActive: with it on, only the game and our own windows', () => {
    assert.strictEqual(shouldHotkeysBeActive({gameOnly: true, foreground: FOREGROUND_GAME}), true);
    // Our own windows count so a hotkey can be tried straight from Settings ›
    // Hotkeys, which is where somebody who just rebound one is standing.
    assert.strictEqual(shouldHotkeysBeActive({gameOnly: true, foreground: FOREGROUND_OWN}), true);
    assert.strictEqual(shouldHotkeysBeActive({gameOnly: true, foreground: FOREGROUND_OTHER}), false);
});

test('shouldHotkeysBeActive: an unreadable foreground fails open', () => {
    // A machine whose window list cannot be read must still have hotkeys;
    // failing closed would look exactly like the app being broken.
    assert.strictEqual(shouldHotkeysBeActive({gameOnly: true, foreground: FOREGROUND_UNKNOWN}), true);
});

test('shouldHotkeysBeActive: default-on, like every other switch in this app', () => {
    // Only an explicit `false` turns it off, so a settings file written before
    // the setting existed behaves like the default.
    for (const gameOnly of [undefined, null, true, 1, 'yes']) {
        assert.strictEqual(shouldHotkeysBeActive({gameOnly, foreground: FOREGROUND_OTHER}), false, String(gameOnly));
    }
    assert.strictEqual(shouldHotkeysBeActive({}), false);
    assert.strictEqual(shouldHotkeysBeActive(), false);
});

test('the key capture and the normaliser agree on a shifted number row', () => {
    // The end-to-end version of the shifted-punctuation rule: this is what the
    // renderer really stores when somebody records Ctrl+Shift+1 on a US layout,
    // and it has to be recognised as the binding it will actually register.
    const recorded = keyEventToAccelerator({ctrlKey: true, shiftKey: true, key: '!'});
    assert.strictEqual(recorded.status, 'ok');
    assert.strictEqual(recorded.accelerator, 'CommandOrControl+Shift+!');
    assert.strictEqual(normalizeAccelerator(recorded.accelerator), 'CommandOrControl+Shift+1');
    assert.ok(sameAccelerator(recorded.accelerator, 'CommandOrControl+Shift+1'));
    // So a map binding stored either way is one binding, not two.
    assert.deepStrictEqual(
        duplicateMapBindings({
            'CommandOrControl+Shift+!': {id: 'a', mapKey: 'x/1'},
            'CommandOrControl+Shift+1': {id: 'b', mapKey: 'x/2'}
        }).map(d => d.accelerator),
        ['CommandOrControl+Shift+1']
    );
});

/* ────────────────────────────────────────────────────────────────────────────
 * Suspension (the recording dialog)
 * ──────────────────────────────────────────────────────────────────────────── */

test('hotkeysShouldBeRegistered: a suspension beats the foreground', () => {
    assert.strictEqual(hotkeysShouldBeRegistered({foregroundAllows: true, suspended: false}), true);
    // The case the whole thing exists for: the Settings window is in front, so
    // the foreground says yes, and the dialog still has to get the keystroke.
    assert.strictEqual(hotkeysShouldBeRegistered({foregroundAllows: true, suspended: true}), false);
    assert.strictEqual(hotkeysShouldBeRegistered({foregroundAllows: false, suspended: true}), false);
    assert.strictEqual(hotkeysShouldBeRegistered({foregroundAllows: false, suspended: false}), false);
    assert.strictEqual(hotkeysShouldBeRegistered({}), false);
    assert.strictEqual(hotkeysShouldBeRegistered(), false);
});

test('shouldHotkeysBeActive: suspended wins over every other input', () => {
    // Including the two that otherwise force a `true`: the setting being off,
    // and an unreadable foreground failing open.
    for (const state of [
        {gameOnly: false, foreground: FOREGROUND_GAME},
        {gameOnly: false, foreground: FOREGROUND_OTHER},
        {gameOnly: true, foreground: FOREGROUND_GAME},
        {gameOnly: true, foreground: FOREGROUND_OWN},
        {gameOnly: true, foreground: FOREGROUND_UNKNOWN}
    ]) {
        assert.strictEqual(shouldHotkeysBeActive(state), true, JSON.stringify(state));
        assert.strictEqual(shouldHotkeysBeActive(Object.assign({suspended: true}, state)), false,
            JSON.stringify(state));
    }
});

test('the two decisions agree wherever both have the inputs', () => {
    // `shouldHotkeysBeActive` is the whole decision in one call;
    // `hotkeysShouldBeRegistered` composes it from the two halves that have
    // different owners (the watcher polls, the renderer records). They must not
    // be able to disagree.
    for (const gameOnly of [true, false]) {
        for (const foreground of [FOREGROUND_GAME, FOREGROUND_OWN, FOREGROUND_OTHER, FOREGROUND_UNKNOWN]) {
            for (const suspended of [true, false]) {
                const whole = shouldHotkeysBeActive({gameOnly, foreground, suspended});
                const composed = hotkeysShouldBeRegistered({
                    foregroundAllows: shouldHotkeysBeActive({gameOnly, foreground}),
                    suspended
                });
                assert.strictEqual(composed, whole, `${gameOnly} ${foreground} ${suspended}`);
            }
        }
    }
});

/* ────────────────────────────────────────────────────────────────────────────
 * A `hotkey*` key missing from an old settings file
 * ──────────────────────────────────────────────────────────────────────────── */

test('a back-filled default that a map binding holds is reported, not silent', () => {
    // A settings file written before `clear-map` existed has no
    // `hotkeyClearMap`, so the back-fill hands it the new default with no
    // conflict check — and the user may already have a map on it. The system
    // hotkey wins (it registers first), which is the documented priority, so
    // the guarantee that matters is that the shadowed map binding is *reported*
    // rather than being silently inert.
    const effective = {'clear-map': SYSTEM_HOTKEY_DEFS['clear-map'].defaultAccelerator};
    const mapHotkeys = {'ctrl+alt+d': {id: 'a', mapKey: 'deftyconchgaming/East Haddonfield'}};
    assert.deepStrictEqual(shadowedMapBindings(effective, mapHotkeys),
        [{accelerator: 'ctrl+alt+d', actionId: 'clear-map'}]);
    // And it is found in the "everything we hold" set, so a later save of the
    // same combination is refused rather than double-booked.
    assert.ok(ownAcceleratorKeys(effective, mapHotkeys).has(acceleratorKey('Ctrl+Alt+D')));
});
