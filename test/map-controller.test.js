const {test} = require('node:test');
const assert = require('node:assert');
const path = require('path');
const {installElectronStub} = require('./helpers/electron-stub');
const {fakeSettings: makeFakeSettings} = require('./helpers/fake-settings');

/*
 * `src/core/map-controller.js` — the impure half of the map state, and the
 * half whose whole point is that **it works with no main window**.
 *
 * Up to 0.7 every one of these paths went through `src/js/maps.js`, i.e.
 * through the main window's renderer: a hotkey, a detector match, the menu
 * clear, `show-map=` from a second instance. That is what made the window
 * load-bearing for a match and what `docs/MEMORY-REPORT-2.md` §3.3 refused to
 * tear down. Every test below therefore runs with `MainWindow.window === null`
 * — the state the app is in while the player is in a match with the app in the
 * tray — and asserts the overlay is still driven.
 *
 * `require('electron')` outside Electron is a path string, so it is stubbed
 * before anything is loaded (`test/helpers/electron-stub.js`).
 */
const ROOT = path.join(__dirname, '..');
const {ipc: IPC} = installElectronStub();
const MapController = require(path.join(ROOT, 'src/core/map-controller'));
const {buildCatalog} = require(path.join(ROOT, 'src/core/map-catalog'));
const {SYSTEM_HOTKEY_DEFS} = require(path.join(ROOT, 'src/shared/hotkeys-constants'));

const CATALOG = buildCatalog([
    'deftyconchgaming/East Haddonfield.png',
    'deftyconchgaming/Haddonfield Heights.png',
    'deftyconchgaming/Smiths Grove.png'
]);
const EAST = 'deftyconchgaming/East Haddonfield';
const HEIGHTS = 'deftyconchgaming/Haddonfield Heights';
const GROVE = 'deftyconchgaming/Smiths Grove';

/* ────────────────────────────────────────────────────────────────────────────
 * Doubles
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A `MainWindow` with **no window**, which is the whole point: `send` and
 * `sendUpdate` drop silently (the real one does too), and `applyMapChange`
 * still reaches the overlay, because the overlay is a different window with a
 * renderer of its own.
 */
function fakeMainWindow() {
    return {
        window: null,
        applied: [],
        toasts: [],
        pushes: [],
        applyMapChange(map, opts) { this.applied.push({map, opts: opts || {}}); },
        sendUpdate(message) { if (this.window) this.toasts.push(message); },
        send(channel, payload) { if (this.window) this.pushes.push({channel, payload}); }
    };
}

const fakeSettings = (over) => makeFakeSettings(over,
    {base: {opacity: 0.5, size: 250, rotation: 0, markers: true}});

function fakeDetector() {
    return {
        shown: [],
        appliedReports: [],
        resets: 0,
        noteShown(key) { this.shown.push(key); },
        noteApplied(info) { this.appliedReports.push(info); },
        resetLastDetected() { this.resets += 1; }
    };
}

function build(over) {
    const mainWindow = fakeMainWindow();
    const settings = fakeSettings(over);
    const detector = fakeDetector();
    const controller = new MapController(mainWindow, settings, {getCatalog: () => CATALOG});
    controller.setDetector(detector);
    return {controller, mainWindow, settings, detector};
}

/** The last thing that reached the overlay. */
function lastApplied(mainWindow) {
    return mainWindow.applied[mainWindow.applied.length - 1] || null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * With no main window at all
 * ──────────────────────────────────────────────────────────────────────────── */

test('a per-map hotkey reaches the overlay with no window', () => {
    const {controller, mainWindow} = build();
    controller.select(EAST, 'hotkey');
    assert.deepStrictEqual(lastApplied(mainWindow), {map: EAST, opts: {source: 'hotkey'}});
});

test('every system hotkey action runs with no window', () => {
    const {controller, mainWindow, settings} = build();
    controller.select(EAST, 'hotkey');
    const before = mainWindow.applied.length;

    for (const id of Object.keys(SYSTEM_HOTKEY_DEFS)) {
        assert.strictEqual(controller.action(id), true, id);
    }
    assert.ok(mainWindow.applied.length > before, 'the overlay was driven');
    // The four that change a setting all wrote one.
    const keys = settings.writes.map(w => w.key);
    for (const key of ['rotation', 'opacity', 'size', 'markers']) {
        assert.ok(keys.includes(key), key);
    }
    assert.strictEqual(controller.action('not-an-action'), false);
});

test('toggle-map with no window: hide, then bring the same map back', () => {
    const {controller, mainWindow} = build();
    controller.select(EAST, 'hotkey');
    controller.action('toggle-map');
    assert.strictEqual(lastApplied(mainWindow).map, '');
    controller.action('toggle-map');
    assert.strictEqual(lastApplied(mainWindow).map, EAST);
});

test('the detector drives the overlay with no window, and is told what happened', () => {
    const {controller, mainWindow, detector} = build();
    controller.detected(HEIGHTS);
    assert.deepStrictEqual(lastApplied(mainWindow),
        {map: HEIGHTS, opts: {source: 'detector', mapLabel: 'Haddonfield Heights'}});
    assert.deepStrictEqual(detector.appliedReports, [{type: 'detector-applied', key: HEIGHTS, applied: true}]);

    // The same match again is ignored — no second apply, and the log still
    // gets the line that says so.
    controller.detected(HEIGHTS);
    assert.strictEqual(mainWindow.applied.length, 1);
    assert.strictEqual(detector.appliedReports[1].reason, 'same-as-current');
});

test('the detector is told what the overlay shows after every apply, hides included', () => {
    // This is the 0.3.3 rule the menu clear is gated on: what is on the
    // overlay, whoever put it there. It used to be an IPC round trip through
    // the renderer (`map-detector-shown`).
    const {controller, detector} = build();
    controller.select(EAST, 'click');
    controller.detected(GROVE);
    controller.action('toggle-map');
    assert.deepStrictEqual(detector.shown, [EAST, GROVE, null]);
});

test('the menu clear goes through the controller, so toggle-map still knows the map', () => {
    const {controller, mainWindow, detector} = build();
    controller.select(EAST, 'click');
    controller.menuHide();
    assert.deepStrictEqual(lastApplied(mainWindow), {map: '', opts: {source: 'detector'}});
    assert.strictEqual(detector.shown[detector.shown.length - 1], null);
    // `lastKey` survives the menu clear, exactly as it did in the renderer.
    controller.action('toggle-map');
    assert.strictEqual(lastApplied(mainWindow).map, EAST);
});

test('clear-and-redetect tells the detector to forget, then hides', () => {
    const {controller, mainWindow, detector} = build();
    controller.select(EAST, 'click');
    controller.action('clear-map');
    assert.strictEqual(detector.resets, 1);
    assert.strictEqual(lastApplied(mainWindow).map, '');
    // Nothing to bring back: clear is not toggle-map.
    controller.action('toggle-map');
    assert.strictEqual(mainWindow.applied.length, 2, 'toggle-map after clear does nothing');
});

test('a toast produced with no window is dropped, not thrown', () => {
    const {controller, mainWindow} = build();
    controller.select('Custom/Deleted', 'hotkey');
    assert.deepStrictEqual(mainWindow.applied, []);
    assert.deepStrictEqual(mainWindow.toasts, []);
});

test('nothing is pushed to a window that is not there', () => {
    const {controller, mainWindow} = build();
    controller.select(EAST, 'hotkey');
    assert.deepStrictEqual(mainWindow.pushes, []);
});

/* ────────────────────────────────────────────────────────────────────────────
 * With a window
 * ──────────────────────────────────────────────────────────────────────────── */

test('with a window, every change is pushed and an apply carries its source', () => {
    const {controller, mainWindow} = build();
    mainWindow.window = {};
    controller.select(EAST, 'click');
    const push = mainWindow.pushes.find(p => p.channel === 'map-state');
    assert.deepStrictEqual(push.payload, {currentKey: EAST, lastKey: EAST, previewActive: false, source: 'click'});
});

test('a push with no apply behind it carries no source, so the view leaves set-position alone', () => {
    const {controller, mainWindow} = build();
    mainWindow.window = {};
    controller.dispatch({type: 'preview-start'});
    const push = mainWindow.pushes.find(p => p.channel === 'map-state');
    assert.strictEqual(push.payload.source, undefined);
    assert.strictEqual(push.payload.previewActive, true);
});

test('a map landing mid-preview asks the view to put the sample image back', () => {
    const {controller, mainWindow} = build();
    mainWindow.window = {};
    controller.dispatch({type: 'preview-start'});
    controller.detected(EAST);
    assert.ok(mainWindow.pushes.some(p => p.channel === 'refresh-preview'));
});

test('a toast reaches a window that is there', () => {
    const {controller, mainWindow} = build();
    mainWindow.window = {};
    controller.action('toggle-markers');
    assert.strictEqual(mainWindow.toasts.length, 1);
    assert.strictEqual(mainWindow.toasts[0].key, 'toast.markersOff');
});

/* ────────────────────────────────────────────────────────────────────────────
 * The IPC surface and the failure modes
 * ──────────────────────────────────────────────────────────────────────────── */

test('the view can fetch the state and post intents', async () => {
    const {controller, mainWindow} = build();
    controller.select(HEIGHTS, 'click');
    // The handlers registered by the *last* controller built are the ones in
    // the map; that is this one.
    assert.deepStrictEqual(await IPC.handlers.get('get-map-state')(),
        {currentKey: HEIGHTS, lastKey: HEIGHTS, previewActive: false});
    IPC.listeners.get('map-intent')({}, {type: 'hide', source: 'click'});
    assert.strictEqual(lastApplied(mainWindow).map, '');
});

test('a catalogue that throws is an empty catalogue, not a dead hotkey', () => {
    const mainWindow = fakeMainWindow();
    const controller = new MapController(mainWindow, fakeSettings(), {
        getCatalog() { throw new Error('the packs folder is unreadable'); }
    });
    controller.select(EAST, 'hotkey');
    assert.deepStrictEqual(mainWindow.applied, [], 'nothing resolved, nothing sent');
});

test('an effect that throws does not take the rest of the dispatch with it', () => {
    // A global-shortcut callback that throws is an `uncaughtException`, which
    // since 0.3.2 ends the session with a crash file. Losing one map change is
    // survivable; losing the app mid-match is not.
    const mainWindow = fakeMainWindow();
    const settings = fakeSettings();
    settings.set = () => { throw new Error('settings-app.json is locked'); };
    const controller = new MapController(mainWindow, settings, {getCatalog: () => CATALOG});
    controller.select(EAST, 'click');
    assert.doesNotThrow(() => controller.action('opacity-up'));
    // The setting failed, but the map was still re-sent.
    assert.strictEqual(lastApplied(mainWindow).map, EAST);
});

test('a controller with no detector at all still drives the overlay', () => {
    const mainWindow = fakeMainWindow();
    const controller = new MapController(mainWindow, fakeSettings(), {getCatalog: () => CATALOG});
    controller.select(EAST, 'hotkey');
    controller.action('clear-map');
    assert.strictEqual(lastApplied(mainWindow).map, '');
});

test('a custom map key never reaches the log', () => {
    // `runEffect`'s `missing` line is the one place a stored key is written
    // down, and a custom map's key is a name the user typed.
    const {controller} = build();
    assert.strictEqual(controller.logKey('Custom/My Secret Map'), '(custom)');
    assert.strictEqual(controller.logKey(EAST), EAST);
    assert.strictEqual(controller.logKey(''), '');
});
