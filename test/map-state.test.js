const {test} = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const {
    reduceMapState, intentForAction, alreadyShowing, INITIAL_STATE, ACTION_INTENTS
} = require(path.join(ROOT, 'src/shared/map-state'));
const {buildCatalog, mergeCustomMaps} = require(path.join(ROOT, 'src/core/map-catalog'));
const {shouldApplyDetected} = require(path.join(ROOT, 'src/shared/detector-rules'));
const {SYSTEM_HOTKEY_DEFS, OPACITY_STEP, SIZE_STEP} = require(path.join(ROOT, 'src/shared/hotkeys-constants'));

/*
 * `src/shared/map-state.js` — every decision that used to live in
 * `src/js/maps.js`, i.e. in the main window's renderer. That renderer is now
 * allowed not to exist (`unloadWindowInTray`), so these rules have to hold in
 * the main process on their own, and this file is where they are held.
 *
 * Nothing here touches electron, a window or a file: the catalogue and the
 * settings are plain data, exactly as the controller hands them over.
 */

const SHIPPED = [
    'deftyconchgaming/East Haddonfield.png',
    'deftyconchgaming/Haddonfield Heights.png',
    'deftyconchgaming/Smiths Grove.png'
];
const PACK = 'anothercreator/Ridgeview.png';
const CATALOG = mergeCustomMaps(buildCatalog(SHIPPED.concat([PACK])), ['My Own Map.png']);

const EAST = 'deftyconchgaming/East Haddonfield';
const HEIGHTS = 'deftyconchgaming/Haddonfield Heights';
const GROVE = 'deftyconchgaming/Smiths Grove';
const RIDGE = 'anothercreator/Ridgeview';
const CUSTOM = 'Custom/My Own Map';

/** Catalogue order is creator, then map name, with custom maps last. */
const ORDER = CATALOG.map(e => e.key);

function ctx(over) {
    return {
        catalog: CATALOG,
        settings: Object.assign({
            opacity: 0.5, size: 250, rotation: 0, markers: true
        }, over || {})
    };
}

function state(over) {
    return Object.assign({}, INITIAL_STATE, over || {});
}

/** The `apply` effect of a result, or null. */
function applied(result) {
    return result.effects.find(e => e.type === 'apply') || null;
}

function effectTypes(result) {
    return result.effects.map(e => e.type);
}

/* ────────────────────────────────────────────────────────────────────────────
 * The fixture itself
 * ──────────────────────────────────────────────────────────────────────────── */

test('the fixture catalogue has a pack map, three shipped maps and a custom one', () => {
    assert.deepStrictEqual(ORDER, [RIDGE, EAST, HEIGHTS, GROVE, CUSTOM]);
});

/* ────────────────────────────────────────────────────────────────────────────
 * select — a click, a per-map hotkey, the CLI
 * ──────────────────────────────────────────────────────────────────────────── */

test('select: a gallery click puts the map up and remembers it', () => {
    const r = reduceMapState(state(), {type: 'select', key: EAST, source: 'click'}, ctx());
    assert.deepStrictEqual(applied(r), {type: 'apply', key: EAST, source: 'click'});
    assert.strictEqual(r.state.currentKey, EAST);
    assert.strictEqual(r.state.lastKey, EAST);
});

test('select: the key is resolved through the catalogue, not trusted', () => {
    // A bare map name and a differently-cased key both resolve to the entry,
    // and it is the *catalogue* key that is applied.
    for (const query of ['Haddonfield Heights', 'DEFTYCONCHGAMING/haddonfield heights']) {
        const r = reduceMapState(state(), {type: 'select', key: query, source: 'cli'}, ctx());
        assert.strictEqual(applied(r).key, HEIGHTS, query);
    }
});

test('select: a per-map hotkey for a map that is gone says so; the CLI only logs it', () => {
    const hot = reduceMapState(state(), {type: 'select', key: 'Custom/Deleted', source: 'hotkey'}, ctx());
    assert.deepStrictEqual(effectTypes(hot), ['toast']);
    assert.strictEqual(hot.effects[0].message.key, 'hotkeys.error.mapMissing');
    assert.strictEqual(hot.state.currentKey, '');

    const cli = reduceMapState(state(), {type: 'select', key: 'Custom/Deleted', source: 'cli'}, ctx());
    assert.deepStrictEqual(effectTypes(cli), ['missing']);
});

test('select: a custom map is a map like any other', () => {
    const r = reduceMapState(state(), {type: 'select', key: CUSTOM, source: 'click'}, ctx());
    assert.strictEqual(applied(r).key, CUSTOM);
});

/* ────────────────────────────────────────────────────────────────────────────
 * detected — the detector's every-accepted-match stream
 * ──────────────────────────────────────────────────────────────────────────── */

test('detected: a new map switches, carries the catalogue name as its label, and reports back', () => {
    const r = reduceMapState(state({currentKey: EAST, lastKey: EAST}), {type: 'detected', key: HEIGHTS}, ctx());
    assert.deepStrictEqual(applied(r), {
        type: 'apply', key: HEIGHTS, source: 'detector', mapLabel: 'Haddonfield Heights'
    });
    assert.deepStrictEqual(r.effects.find(e => e.type === 'detector-applied'),
        {type: 'detector-applied', key: HEIGHTS, applied: true});
});

test('detected: the same map already on the overlay is ignored — no re-send, no label flash', () => {
    const r = reduceMapState(state({currentKey: HEIGHTS, lastKey: HEIGHTS}), {type: 'detected', key: HEIGHTS}, ctx());
    assert.strictEqual(applied(r), null);
    assert.deepStrictEqual(r.effects, [
        {type: 'detector-applied', key: HEIGHTS, applied: false, reason: 'same-as-current'}
    ]);
});

test('detected: a manual pick does not stop detection — the next match still switches', () => {
    // The 0.3.0 bug: comparing against the *detector's* last detection made a
    // manual pick permanent. The comparison is against what is on the overlay.
    let s = state();
    s = reduceMapState(s, {type: 'detected', key: EAST}, ctx()).state;
    s = reduceMapState(s, {type: 'select', key: GROVE, source: 'click'}, ctx()).state;
    assert.strictEqual(s.currentKey, GROVE);
    // The detector sees East Haddonfield again, which it has already reported
    // once — and it must still be applied, because the overlay moved on.
    const again = reduceMapState(s, {type: 'detected', key: EAST}, ctx());
    assert.strictEqual(applied(again).key, EAST);
});

test('detected: a key the catalogue does not know is reported as no-match', () => {
    const r = reduceMapState(state(), {type: 'detected', key: 'nobody/Nothing'}, ctx());
    assert.deepStrictEqual(r.effects, [
        {type: 'detector-applied', key: 'nobody/Nothing', applied: false, reason: 'no-match'}
    ]);
});

test('"already showing?" is still the one rule in detector-rules', () => {
    // The decision did not change when it moved out of the renderer; only the
    // caller did. A second copy of it here would be the thing to worry about.
    const cases = [['', EAST], [EAST, EAST], [EAST, HEIGHTS], [HEIGHTS, '']];
    for (const [current, key] of cases) {
        assert.strictEqual(alreadyShowing(current, key), !shouldApplyDetected(current, key),
            `${current || '(none)'} -> ${key || '(none)'}`);
    }
});

/* ────────────────────────────────────────────────────────────────────────────
 * toggle
 * ──────────────────────────────────────────────────────────────────────────── */

test('toggle: showing -> hidden, hidden -> the last map back', () => {
    const shown = state({currentKey: EAST, lastKey: EAST});
    const off = reduceMapState(shown, {type: 'toggle'}, ctx());
    assert.deepStrictEqual(applied(off), {type: 'apply', key: '', source: 'hotkey'});
    assert.strictEqual(off.state.currentKey, '');
    assert.strictEqual(off.state.lastKey, EAST, 'lastKey survives a hide');

    const on = reduceMapState(off.state, {type: 'toggle'}, ctx());
    assert.strictEqual(applied(on).key, EAST);
});

test('toggle: with nothing ever shown it does nothing at all', () => {
    const r = reduceMapState(state(), {type: 'toggle'}, ctx());
    assert.deepStrictEqual(r.effects, []);
});

test('toggle: a remembered map that has left the catalogue says so and is forgotten', () => {
    const r = reduceMapState(state({lastKey: 'Custom/Deleted'}), {type: 'toggle'}, ctx());
    assert.deepStrictEqual(effectTypes(r), ['toast']);
    assert.strictEqual(r.effects[0].message.key, 'hotkeys.error.mapMissing');
    assert.strictEqual(r.state.lastKey, '', 'a dead key is not kept for the next press');
});

/* ────────────────────────────────────────────────────────────────────────────
 * next / prev
 * ──────────────────────────────────────────────────────────────────────────── */

test('next / prev: walk catalogue order and wrap, across pack, shipped and custom maps', () => {
    let s = state();
    const seen = [];
    for (let i = 0; i < ORDER.length + 1; i += 1) {
        const r = reduceMapState(s, {type: 'next'}, ctx());
        s = r.state;
        seen.push(applied(r).key);
    }
    // Starting from nothing, `next` begins at the first map and wraps once.
    assert.deepStrictEqual(seen, ORDER.concat([ORDER[0]]));

    const back = reduceMapState(state({currentKey: ORDER[0]}), {type: 'prev'}, ctx());
    assert.strictEqual(applied(back).key, ORDER[ORDER.length - 1], 'prev wraps to the custom map');
});

test('next: while hidden it steps on from the last map, not from the beginning', () => {
    const r = reduceMapState(state({currentKey: '', lastKey: EAST}), {type: 'next'}, ctx());
    assert.strictEqual(applied(r).key, HEIGHTS);
});

test('next / prev: an empty catalogue does nothing rather than throwing', () => {
    const r = reduceMapState(state(), {type: 'next'}, {catalog: [], settings: {}});
    assert.deepStrictEqual(r.effects, []);
});

/* ────────────────────────────────────────────────────────────────────────────
 * clear, menu-hide, hide, refresh
 * ──────────────────────────────────────────────────────────────────────────── */

test('clear: hides, forgets the last map, and tells the detector to re-detect', () => {
    const r = reduceMapState(state({currentKey: EAST, lastKey: EAST}), {type: 'clear'}, ctx());
    assert.deepStrictEqual(effectTypes(r), ['detector-reset', 'apply']);
    assert.deepStrictEqual(applied(r), {type: 'apply', key: '', source: 'hotkey'});
    assert.strictEqual(r.state.lastKey, '', 'clear is not toggle-map: nothing is kept');
});

test('menu-hide: clears what is showing and keeps it for toggle-map', () => {
    const r = reduceMapState(state({currentKey: EAST, lastKey: EAST}), {type: 'menu-hide'}, ctx());
    assert.deepStrictEqual(applied(r), {type: 'apply', key: '', source: 'detector'});
    assert.strictEqual(r.state.lastKey, EAST);
});

test('menu-hide: with nothing on the overlay it is a no-op', () => {
    const r = reduceMapState(state({lastKey: EAST}), {type: 'menu-hide'}, ctx());
    assert.deepStrictEqual(r.effects, []);
});

test('hide: the home page button, with its own source', () => {
    const r = reduceMapState(state({currentKey: EAST}), {type: 'hide', source: 'click'}, ctx());
    assert.deepStrictEqual(applied(r), {type: 'apply', key: '', source: 'click'});
});

test('refresh: re-sends what is showing and never resurrects the last map', () => {
    const shown = reduceMapState(state({currentKey: EAST, lastKey: EAST}), {type: 'refresh', source: 'settings'}, ctx());
    assert.deepStrictEqual(applied(shown), {type: 'apply', key: EAST, source: 'settings'});

    const hidden = reduceMapState(state({currentKey: '', lastKey: EAST}), {type: 'refresh', source: 'settings'}, ctx());
    assert.strictEqual(applied(hidden).key, '', 'a settings change must not put a map back on screen');
});

/* ────────────────────────────────────────────────────────────────────────────
 * The four hotkeys that change a setting
 * ──────────────────────────────────────────────────────────────────────────── */

test('opacity: steps through the pure stepOpacity, clamps, re-sends and toasts', () => {
    const r = reduceMapState(state({currentKey: EAST, lastKey: EAST}),
        {type: 'opacity', delta: OPACITY_STEP}, ctx({opacity: 0.5}));
    assert.deepStrictEqual(r.effects[0], {type: 'setting', key: 'opacity', value: 0.6});
    assert.strictEqual(applied(r).key, EAST);
    assert.deepStrictEqual(r.effects[r.effects.length - 1].message,
        {key: 'toast.opacity', params: {percent: 60}});

    // The clamps are the slider's own min/max.
    const top = reduceMapState(state(), {type: 'opacity', delta: OPACITY_STEP}, ctx({opacity: 1.0}));
    assert.strictEqual(top.effects[0].value, 1.0);
    const bottom = reduceMapState(state(), {type: 'opacity', delta: -OPACITY_STEP}, ctx({opacity: 0.1}));
    assert.strictEqual(bottom.effects[0].value, 0.1);
});

test('opacity: repeated steps stay on the slider grid (the float-drift bug)', () => {
    let opacity = 0.5;
    for (let i = 0; i < 5; i += 1) {
        opacity = reduceMapState(state(), {type: 'opacity', delta: OPACITY_STEP}, ctx({opacity})).effects[0].value;
    }
    assert.strictEqual(opacity, 1.0);
});

test('size: 25 px steps, clamped to 50..800', () => {
    const r = reduceMapState(state({currentKey: EAST}), {type: 'size', delta: SIZE_STEP}, ctx({size: 250}));
    assert.deepStrictEqual(r.effects[0], {type: 'setting', key: 'size', value: 275});
    assert.deepStrictEqual(r.effects[r.effects.length - 1].message, {key: 'toast.size', params: {size: 275}});
    assert.strictEqual(reduceMapState(state(), {type: 'size', delta: SIZE_STEP}, ctx({size: 800})).effects[0].value, 800);
    assert.strictEqual(reduceMapState(state(), {type: 'size', delta: -SIZE_STEP}, ctx({size: 50})).effects[0].value, 50);
});

test('rotate: quarter turns, wrapping at 360, and no toast', () => {
    let rotation = 0;
    for (const expected of [90, 180, 270, 0]) {
        const r = reduceMapState(state({currentKey: EAST}), {type: 'rotate'}, ctx({rotation}));
        rotation = r.effects[0].value;
        assert.strictEqual(rotation, expected);
        assert.ok(!r.effects.some(e => e.type === 'toast'), 'rotate says nothing');
    }
});

test('markers: the master switch treats a file written before markers existed as "on"', () => {
    const off = reduceMapState(state({currentKey: EAST}), {type: 'toggle-markers'}, ctx({markers: undefined}));
    assert.deepStrictEqual(off.effects[0], {type: 'setting', key: 'markers', value: false});
    assert.deepStrictEqual(off.effects[off.effects.length - 1].message, {key: 'toast.markersOff'});

    const on = reduceMapState(state({currentKey: EAST}), {type: 'toggle-markers'}, ctx({markers: false}));
    assert.deepStrictEqual(on.effects[0], {type: 'setting', key: 'markers', value: true});
    assert.deepStrictEqual(on.effects[on.effects.length - 1].message, {key: 'toast.markersOn'});
});

test('rotate / opacity / size while hidden bring the last map back (0.6 behaviour)', () => {
    // Kept for parity: 0.6.0's `sendMap(currentKey || lastKey)` did this, and
    // these three are aimed at the picture — "make it bigger" with nothing on
    // screen reasonably means "put it back and make it bigger".
    for (const intent of [{type: 'opacity', delta: OPACITY_STEP},
        {type: 'size', delta: SIZE_STEP}, {type: 'rotate'}]) {
        const r = reduceMapState(state({currentKey: '', lastKey: EAST}), intent, ctx());
        assert.strictEqual(applied(r).key, EAST, intent.type);
        assert.strictEqual(r.state.currentKey, EAST, intent.type);
    }
});

test('the markers toggle NEVER puts a hidden map back on screen', () => {
    // The one exception to the rule above, and it is not a parity question: a
    // marker switch is a switch on a *layer of* the picture. Turning markers
    // on must not be the thing that draws a map the player deliberately hid —
    // or that the menu clear took away when the match ended — back over their
    // game. The setting still lands, so the next map is right.
    const hidden = state({currentKey: '', lastKey: EAST});
    const r = reduceMapState(hidden, {type: 'toggle-markers'}, ctx({markers: true}));
    assert.deepStrictEqual(r.effects[0], {type: 'setting', key: 'markers', value: false});
    assert.strictEqual(applied(r), null, 'nothing may reach the overlay');
    assert.strictEqual(r.state.currentKey, '', 'the overlay stays hidden');
    assert.strictEqual(r.state.lastKey, EAST, 'and the map is still remembered');
    // The toast still goes out — the player pressed a key and is owed an answer.
    assert.strictEqual(r.effects[r.effects.length - 1].message.key, 'toast.markersOff');
});

test('the markers toggle does re-send a map that IS showing', () => {
    const r = reduceMapState(state({currentKey: EAST, lastKey: EAST}),
        {type: 'toggle-markers'}, ctx({markers: true}));
    assert.strictEqual(applied(r).key, EAST, 'main has to rebuild the marker payload');
});

test('the markers toggle with nothing ever shown is just the setting and the toast', () => {
    const r = reduceMapState(state(), {type: 'toggle-markers'}, ctx({markers: true}));
    assert.deepStrictEqual(r.effects.map(e => e.type), ['setting', 'toast']);
});

test('a setting hotkey whose map has left the catalogue still writes the setting', () => {
    const r = reduceMapState(state({currentKey: '', lastKey: 'Custom/Deleted'}),
        {type: 'size', delta: SIZE_STEP}, ctx({size: 250}));
    assert.deepStrictEqual(r.effects[0], {type: 'setting', key: 'size', value: 275});
    assert.strictEqual(applied(r), null, 'nothing is sent to the overlay');
    assert.ok(r.effects.some(e => e.type === 'missing'));
    // Exactly one toast, and it is the one about the setting.
    const toasts = r.effects.filter(e => e.type === 'toast');
    assert.strictEqual(toasts.length, 1);
    assert.strictEqual(toasts[0].message.key, 'toast.size');
});

test('a setting hotkey with nothing showing and nothing remembered still writes it', () => {
    const r = reduceMapState(state(), {type: 'opacity', delta: -OPACITY_STEP}, ctx({opacity: 0.5}));
    assert.deepStrictEqual(r.effects[0], {type: 'setting', key: 'opacity', value: 0.4});
    assert.strictEqual(applied(r).key, '');
});

/* ────────────────────────────────────────────────────────────────────────────
 * The settings preview
 * ──────────────────────────────────────────────────────────────────────────── */

test('preview: while it is up, anything landing on the overlay asks for it again', () => {
    const started = reduceMapState(state({currentKey: EAST, lastKey: EAST}), {type: 'preview-start'}, ctx());
    assert.deepStrictEqual(started.effects, []);
    assert.strictEqual(started.state.previewActive, true);

    const detected = reduceMapState(started.state, {type: 'detected', key: HEIGHTS}, ctx());
    assert.ok(detected.effects.some(e => e.type === 'refresh-preview'),
        'a map arriving mid-preview must not replace the sample image on screen');
    assert.strictEqual(detected.state.currentKey, HEIGHTS, 'the real map is still tracked underneath');
});

test('preview: stopping it puts the real map back through the normal path', () => {
    const s = state({currentKey: HEIGHTS, lastKey: HEIGHTS, previewActive: true});
    const r = reduceMapState(s, {type: 'preview-stop'}, ctx());
    assert.deepStrictEqual(applied(r), {type: 'apply', key: HEIGHTS, source: 'preview'});
    // No second `refresh-preview`: the preview is over.
    assert.ok(!r.effects.some(e => e.type === 'refresh-preview'));
    assert.strictEqual(r.state.previewActive, false);
});

test('preview: stopping it with nothing underneath hides the overlay', () => {
    const r = reduceMapState(state({previewActive: true}), {type: 'preview-stop'}, ctx());
    assert.strictEqual(applied(r).key, '');
});

test('preview: stopping one that never started is a no-op', () => {
    assert.deepStrictEqual(reduceMapState(state(), {type: 'preview-stop'}, ctx()).effects, []);
});

/* ────────────────────────────────────────────────────────────────────────────
 * Housekeeping
 * ──────────────────────────────────────────────────────────────────────────── */

test('catalog-changed leaves the overlay exactly where it is', () => {
    const s = state({currentKey: CUSTOM, lastKey: CUSTOM});
    const r = reduceMapState(s, {type: 'catalog-changed'}, {catalog: [], settings: {}});
    assert.deepStrictEqual(r.effects, []);
    assert.strictEqual(r.state.currentKey, CUSTOM);
});

test('an unknown intent, a missing intent and a missing context are all no-ops', () => {
    assert.deepStrictEqual(reduceMapState(state(), {type: 'nonsense'}, ctx()).effects, []);
    assert.deepStrictEqual(reduceMapState(state(), null, ctx()).effects, []);
    assert.deepStrictEqual(reduceMapState(null, {type: 'toggle'}, null).effects, []);
});

test('a hand-mangled state is normalised rather than trusted', () => {
    const r = reduceMapState({currentKey: 7, lastKey: null, previewActive: 'yes'},
        {type: 'select', key: EAST, source: 'click'}, ctx());
    assert.strictEqual(r.state.currentKey, EAST);
    assert.strictEqual(r.state.lastKey, EAST);
    assert.strictEqual(r.state.previewActive, false);
});

/* ────────────────────────────────────────────────────────────────────────────
 * The hotkey action table
 * ──────────────────────────────────────────────────────────────────────────── */

test('every system hotkey action maps to an intent, and nothing else does', () => {
    // `core/hotkeys.js` hands the action id straight through, so a new system
    // hotkey with no entry here would register and then silently do nothing.
    assert.deepStrictEqual(Object.keys(ACTION_INTENTS).sort(), Object.keys(SYSTEM_HOTKEY_DEFS).sort());
    for (const id of Object.keys(SYSTEM_HOTKEY_DEFS)) {
        assert.ok(intentForAction(id), id);
    }
    assert.strictEqual(intentForAction('not-an-action'), null);
});

test('intentForAction hands out a fresh object each time', () => {
    const a = intentForAction('opacity-up');
    a.delta = 99;
    assert.strictEqual(intentForAction('opacity-up').delta, OPACITY_STEP);
});

test('the four setting hotkeys carry the step constants, in both directions', () => {
    assert.strictEqual(intentForAction('opacity-up').delta, OPACITY_STEP);
    assert.strictEqual(intentForAction('opacity-down').delta, -OPACITY_STEP);
    assert.strictEqual(intentForAction('size-up').delta, SIZE_STEP);
    assert.strictEqual(intentForAction('size-down').delta, -SIZE_STEP);
});
