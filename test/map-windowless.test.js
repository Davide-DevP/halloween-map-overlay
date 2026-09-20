const {test, before} = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const Module = require('module');

/*
 * The whole in-match path, with **no main window and no way to build one**.
 *
 * `test/map-controller.test.js` drives the controller against a *fake*
 * `MainWindow`, so it proves the controller's own bookkeeping and nothing
 * about what actually reaches the overlay. This file is the other half: the
 * **real** `MainWindow.applyMapChange`, the **real** `MapController`, the
 * **real** `MapLibrary` reading the shipped PNGs off disk and the **real**
 * `MapMarkers`, with `MainWindow.window === null` and a `BrowserWindow`
 * constructor that throws if anything so much as tries.
 *
 * That is the state the app is in for the length of a match once the window
 * has been unloaded in the tray (`unloadWindowInTray`, 0.7), and the claim
 * this batch of work rests on is that everything a player uses still works
 * there. Only the two overlay-facing windows are doubles, because they are the
 * things being asserted about.
 *
 * `require('electron')` outside Electron is a path string, so it is stubbed
 * before anything is loaded — the same shape `test/tab-mode.test.js` uses.
 */

const ROOT = path.join(__dirname, '..');
// `MapLibrary.mapsRoot` reads this for an unpackaged build.
global.dirname = ROOT;

const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmo-windowless-'));

/** Every display the stub knows about: one 1920x1080 at 100 %. */
const DISPLAY = {
    id: 1,
    label: 'Test',
    scaleFactor: 1,
    displayFrequency: 60,
    bounds: {x: 0, y: 0, width: 1920, height: 1080},
    workArea: {x: 0, y: 0, width: 1920, height: 1040}
};

const IPC = {handlers: new Map(), listeners: new Map()};
let browserWindowAttempts = 0;

const realLoad = Module._load;
Module._load = function (request) {
    if (request === 'electron') {
        return {
            app: {
                getPath: (name) => (name === 'userData' ? USER_DATA : USER_DATA),
                getName: () => 'Halloween Map Overlay',
                getVersion: () => '0.7.0',
                getLocale: () => 'en-GB',
                isPackaged: false,
                isQuiting: false,
                on() {},
                quit() {}
            },
            // **The point of the file.** Nothing in a match may build a window.
            BrowserWindow: function () {
                browserWindowAttempts += 1;
                throw new Error('a window was created during a match');
            },
            ipcMain: {
                handle(channel, fn) { IPC.handlers.set(channel, fn); },
                on(channel, fn) { IPC.listeners.set(channel, fn); }
            },
            screen: {
                getAllDisplays: () => [DISPLAY],
                getPrimaryDisplay: () => DISPLAY,
                dipToScreenRect: (win, rect) => rect
            },
            shell: {openPath: async () => '', openExternal() {}, showItemInFolder() {}}
        };
    }
    return realLoad.apply(this, arguments);
};

const MainWindow = require(path.join(ROOT, 'src/core/main-window'));
const MapController = require(path.join(ROOT, 'src/core/map-controller'));
const MapLibrary = require(path.join(ROOT, 'src/core/map-library'));
const MapMarkers = require(path.join(ROOT, 'src/core/map-markers'));
const {DEFAULT_SETTINGS} = require(path.join(ROOT, 'src/shared/settings-defaults'));
const {MARKER_LAYERS} = require(path.join(ROOT, 'src/shared/marker-rules'));

const EAST = 'deftyconchgaming/East Haddonfield';
const HEIGHTS = 'deftyconchgaming/Haddonfield Heights';

/* ────────────────────────────────────────────────────────────────────────────
 * Doubles — only the two windows the overlay actually is
 * ──────────────────────────────────────────────────────────────────────────── */

function recordingWindow() {
    return {
        sent: [],
        size: null,
        position: null,
        bounds: null,
        send(channel, ...args) { this.sent.push({channel, args}); },
        setSize(width, height) { this.size = {width, height}; },
        setBounds(b) { this.bounds = b; },
        setPosition(x, y) { this.position = {x, y}; },
        getBounds() { return this.size ? {width: this.size.width, height: this.size.height} : {width: 0, height: 0}; },
        close() {},
        show() {}
    };
}

/** A settings object with the real `get`/`all`/`set` contract, no file. */
function fakeSettings(over) {
    const values = Object.assign({}, DEFAULT_SETTINGS, over || {});
    return {
        values,
        written: [],
        get: (key) => values[key],
        all: () => values,
        set(key, value) { values[key] = value; this.written.push({key, value}); return true; },
        settings: values
    };
}

let overlay;
let obs;
let mainWindow;
let controller;
let settings;
let detector;

function fakeDetector() {
    return {
        shown: [],
        reports: [],
        resets: 0,
        noteShown(key) { this.shown.push(key); },
        noteApplied(info) { this.reports.push(info); },
        resetLastDetected() { this.resets += 1; }
    };
}

/**
 * How many `applyMapChange` calls have not answered yet.
 *
 * `settle()` waits on this rather than on a number of event-loop turns: the
 * call reads a PNG through the libuv thread pool, so "a few `setImmediate`s"
 * is a guess that is right on an idle laptop and wrong on a busy CI runner.
 * Counting the promises is a fact.
 */
let pending = 0;

function build(over) {
    overlay = recordingWindow();
    obs = recordingWindow();
    settings = fakeSettings(over);
    const library = new MapLibrary();
    const markers = new MapMarkers();
    mainWindow = new MainWindow(obs, overlay, settings, library, {current: () => 'en'});
    mainWindow.setMapMarkers(markers);
    // The state the app is in for a whole match once the window has gone.
    mainWindow.window = null;
    pending = 0;
    const realApply = mainWindow.applyMapChange.bind(mainWindow);
    mainWindow.applyMapChange = (...args) => {
        pending += 1;
        return realApply(...args).finally(() => { pending -= 1; });
    };
    controller = new MapController(mainWindow, settings, library);
    detector = fakeDetector();
    controller.setDetector(detector);
}

/** Wait for every in-flight `applyMapChange`, plus the controller's own tail. */
async function settle() {
    await until(() => pending === 0, 'the map change to finish');
    // The rollback runs in a `.then` on that promise, so give the microtask
    // queue and one macrotask turn to drain before anything is asserted.
    await new Promise(resolve => setImmediate(resolve));
}

/** Poll a condition rather than guessing at a number of turns. */
async function until(fn, label, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (fn()) return;
        await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.fail(`timed out waiting for ${label}`);
}

/** The last `map-change` the overlay received, decoded into named fields. */
function lastOverlayChange() {
    for (let i = overlay.sent.length - 1; i >= 0; i--) {
        const entry = overlay.sent[i];
        if (entry.channel !== 'map-change') continue;
        const [img, size, opacity, draggable, rotation, mapLabel, labelMode, markers, lang] = entry.args;
        return {img, size, opacity, draggable, rotation, mapLabel, labelMode, markers, lang};
    }
    return null;
}

function lastObsChange() {
    for (let i = obs.sent.length - 1; i >= 0; i--) {
        const entry = obs.sent[i];
        if (entry.channel !== 'map-change') continue;
        const [img, size, mapLabel, labelMode, markers, lang] = entry.args;
        return {img, size, mapLabel, labelMode, markers, lang};
    }
    return null;
}

function channels(win) {
    return win.sent.map(e => e.channel);
}

before(() => {
    // The catalogue has to have found the shipped maps, or every assertion
    // below would pass vacuously against an empty list.
    const library = new MapLibrary();
    const keys = library.getCatalog().map(e => e.key);
    assert.ok(keys.includes(EAST) && keys.includes(HEIGHTS),
        `the shipped maps were not found: ${keys.join(', ')}`);
});

/* ────────────────────────────────────────────────────────────────────────────
 * Every in-match entry point, windowless
 * ──────────────────────────────────────────────────────────────────────────── */

test('a detector match reaches the overlay AND the OBS window, with the label and the markers', async () => {
    build({mapLabel: 'auto'});
    controller.detected(HEIGHTS);
    await settle();

    const change = lastOverlayChange();
    assert.ok(change, 'the overlay received no map-change');
    assert.ok(change.img.length > 1000, 'the image payload is not a real PNG');
    assert.strictEqual(change.size, DEFAULT_SETTINGS.size);
    assert.strictEqual(change.opacity, DEFAULT_SETTINGS.opacity);
    assert.strictEqual(change.rotation, DEFAULT_SETTINGS.rotation);
    // An automatic switch names the map, and the name is the catalogue's.
    assert.strictEqual(change.mapLabel, 'Haddonfield Heights');
    assert.strictEqual(change.labelMode, 'auto');
    assert.strictEqual(change.lang, 'en');
    // The markers ride on the same payload, and this map has data.
    assert.ok(change.markers, 'no marker payload');
    assert.ok(change.markers.layers.length > 0);
    for (const layer of change.markers.layers) {
        assert.ok(MARKER_LAYERS.some(l => l.id === layer.id), `unknown layer ${layer.id}`);
    }
    assert.ok(change.markers.imageWidth > 0 && change.markers.imageHeight > 0);

    // The stream shows what the player sees.
    const stream = lastObsChange();
    assert.strictEqual(stream.img, change.img);
    assert.strictEqual(stream.mapLabel, 'Haddonfield Heights');
    assert.deepStrictEqual(stream.markers, change.markers);

    // The overlay was sized and placed by main.
    assert.ok(overlay.size.width > DEFAULT_SETTINGS.size, 'the overlay was not sized');
    assert.ok(overlay.position, 'the overlay was not positioned');

    // The detector was told, and its verdict recorded.
    assert.deepStrictEqual(detector.shown, [HEIGHTS]);
    assert.deepStrictEqual(detector.reports, [{type: 'detector-applied', key: HEIGHTS, applied: true}]);
    assert.strictEqual(browserWindowAttempts, 0, 'something tried to build a window');
});

test('next-map walks the catalogue and each step really reaches the overlay', async () => {
    build();
    const seen = [];
    for (let i = 0; i < 3; i++) {
        controller.action('next-map');
        await settle();
        seen.push(lastOverlayChange().img.slice(0, 64));
    }
    assert.strictEqual(new Set(seen).size, 3, 'three different maps should have been sent');
    assert.strictEqual(browserWindowAttempts, 0);
});

test('opacity and size hotkeys re-send the map with the new values', async () => {
    build();
    controller.select(EAST, 'hotkey');
    await settle();
    const before = lastOverlayChange();

    controller.action('opacity-up');
    await settle();
    const louder = lastOverlayChange();
    assert.ok(louder.opacity > before.opacity, 'the opacity did not move');
    assert.strictEqual(louder.img, before.img, 'the same map should be re-sent');

    controller.action('size-up');
    await settle();
    const bigger = lastOverlayChange();
    assert.strictEqual(bigger.size, before.size + 25);
    // The window has to be re-measured for the new size, not just re-sent.
    assert.ok(overlay.size.width > bigger.size, 'the overlay window was not resized');
});

test('rotate re-sends the map and the overlay window follows the rotated bounding box', async () => {
    build();
    controller.select(EAST, 'hotkey');
    await settle();
    const upright = {...overlay.size};

    controller.action('rotate-map');
    await settle();
    assert.strictEqual(lastOverlayChange().rotation, 90);
    assert.notDeepStrictEqual(overlay.size, upright,
        'the overlay window should be re-sized for the rotated map');
});

test('toggle-map hides both windows and brings the same map back', async () => {
    build();
    controller.select(EAST, 'click');
    await settle();

    controller.action('toggle-map');
    await settle();
    assert.strictEqual(channels(overlay)[channels(overlay).length - 1], 'map-hide');
    assert.strictEqual(channels(obs)[channels(obs).length - 1], 'map-hide');
    assert.strictEqual(detector.shown[detector.shown.length - 1], null);

    const hidden = overlay.sent.length;
    controller.action('toggle-map');
    await settle();
    assert.ok(overlay.sent.length > hidden);
    assert.ok(lastOverlayChange().img.length > 1000, 'the map did not come back');
});

test('the menu clear takes the map off both windows', async () => {
    build();
    controller.detected(EAST);
    await settle();
    controller.menuHide();
    await settle();
    assert.strictEqual(channels(overlay)[channels(overlay).length - 1], 'map-hide');
    assert.strictEqual(channels(obs)[channels(obs).length - 1], 'map-hide');
});

test('clear-and-redetect hides and resets the detector', async () => {
    build();
    controller.detected(EAST);
    await settle();
    controller.action('clear-map');
    await settle();
    assert.strictEqual(detector.resets, 1);
    assert.strictEqual(channels(overlay)[channels(overlay).length - 1], 'map-hide');
});

test('the markers toggle rebuilds the payload without re-showing a hidden map', async () => {
    build();
    controller.select(EAST, 'click');
    await settle();
    assert.ok(lastOverlayChange().markers, 'markers should start on');

    controller.action('toggle-markers');
    await settle();
    assert.strictEqual(lastOverlayChange().markers, null, 'the markers should be gone');

    // …and with nothing on the overlay it must not put a map back.
    controller.action('toggle-map');
    await settle();
    const hidden = overlay.sent.length;
    controller.action('toggle-markers');
    await settle();
    assert.strictEqual(overlay.sent.length, hidden,
        'toggling markers must never put a hidden map back on the game');
    assert.strictEqual(settings.get('markers'), true, 'the setting still has to land');
});

test('`hideOverlay` sends an empty image and no markers, and still keeps OBS working', async () => {
    build({hideOverlay: true});
    controller.select(EAST, 'click');
    await settle();
    assert.strictEqual(lastOverlayChange().img, '');
    assert.strictEqual(lastOverlayChange().markers, null);
    assert.ok(lastObsChange().img.length > 1000, 'the OBS window is not affected by hideOverlay');
});

test('`mapLabel: always` names a hand-picked map from the catalogue', async () => {
    build({mapLabel: 'always'});
    controller.select(EAST, 'click');
    await settle();
    assert.strictEqual(lastOverlayChange().mapLabel, 'East Haddonfield');
    assert.strictEqual(lastObsChange().mapLabel, 'East Haddonfield');
});

test('`mapLabel: never` sends an empty label even for a detector switch', async () => {
    build({mapLabel: 'never'});
    controller.detected(HEIGHTS);
    await settle();
    assert.strictEqual(lastOverlayChange().mapLabel, '');
});

test('a per-map hotkey for a map that is gone touches neither window', async () => {
    build();
    controller.select('Custom/Deleted By The User', 'hotkey');
    await settle();
    assert.deepStrictEqual(overlay.sent, []);
    assert.deepStrictEqual(obs.sent, []);
    assert.strictEqual(controller.currentKey(), '');
});

test('a map file that vanishes under the app rolls the state back', async () => {
    build();
    controller.select(EAST, 'click');
    await settle();
    assert.strictEqual(controller.currentKey(), EAST);

    // The catalogue still says the map is there; the read fails.
    const realRead = fs.promises.readFile;
    fs.promises.readFile = async () => {
        const err = new Error('ENOENT: no such file or directory');
        err.code = 'ENOENT';
        throw err;
    };
    try {
        controller.select(HEIGHTS, 'click');
        await settle();
    } finally {
        fs.promises.readFile = realRead;
    }

    // Nothing new reached the overlay, and the state, the gallery highlight
    // and the detector all still name the map that IS on screen.
    assert.strictEqual(controller.currentKey(), EAST,
        'a failed read must not leave the state naming a map that is not showing');
    assert.strictEqual(detector.shown[detector.shown.length - 1], EAST);
});

test('a later map change wins over an earlier one that is still reading', async () => {
    build();
    // Hold the first read open until the second has finished.
    const realRead = fs.promises.readFile;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let first = true;
    fs.promises.readFile = async (...args) => {
        if (first) {
            first = false;
            await gate;
        }
        return realRead(...args);
    };
    try {
        controller.select(EAST, 'click');        // starts, blocks on the gate
        controller.select(HEIGHTS, 'click');     // overtakes it
        // The second one is not gated, so it lands first.
        await until(() => lastOverlayChange() !== null, 'the second map to land');
        const won = lastOverlayChange();
        release();
        await settle();
        // The slow first call came back last and must have dropped everything.
        assert.strictEqual(lastOverlayChange().img, won.img,
            'a stale map change put the previous map back on the overlay');
    } finally {
        fs.promises.readFile = realRead;
    }
    assert.strictEqual(controller.currentKey(), HEIGHTS);
});

test('the settings preview never reaches the OBS window', async () => {
    build({mapLabel: 'always'});
    const png = fs.readFileSync(path.join(ROOT, 'maps', 'deftyconchgaming', 'East Haddonfield.png'))
        .toString('base64');
    const obsBefore = obs.sent.length;
    await mainWindow.applyMapChange(png, {preview: true, mapLabel: 'Sample'});
    assert.strictEqual(obs.sent.length, obsBefore, 'the preview leaked into the stream');
    assert.strictEqual(lastOverlayChange().mapLabel, 'Sample');
    assert.strictEqual(lastOverlayChange().markers, null, 'the preview is not a catalogue map');
});

test('nothing in a match ever tried to build a window', () => {
    assert.strictEqual(browserWindowAttempts, 0);
    assert.strictEqual(mainWindow.window, null);
});
