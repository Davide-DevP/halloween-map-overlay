const {test} = require('node:test');
const assert = require('node:assert');
const path = require('path');
const {installElectronStub} = require('./helpers/electron-stub');
const {fakeSettings: makeFakeSettings} = require('./helpers/fake-settings');

/*
 * `src/core/tab-mode.js` — the impure half of Tab-map mode, and the half where
 * every show/hide race lives: a capture that resolves after the player has let
 * go, a detector tick already in flight when the markers come down, a settings
 * change mid-hold. None of that can be driven through the real Electron, the
 * real screen or a real keyboard, and none of it was covered. So the class
 * takes its dependencies as an injected fourth argument (exactly as
 * `core/foreground.js` does, and for exactly the same reason) and this file
 * drives the interleavings by hand.
 *
 * `require('electron')` outside Electron is a path string, so the two modules
 * that reach for it get `test/helpers/electron-stub.js` before `tab-mode` loads.
 */
const ROOT = path.join(__dirname, '..');
installElectronStub({electron: {
    screen: null,
    BrowserWindow: function () { throw new Error('the test must inject an overlay'); }
}});
const TabMode = require(path.join(ROOT, 'src/core/tab-mode'));
const {
    FAST_INTERVAL, SAFETY_INTERVAL, CONFIRM_RETRY_DELAYS, CONFIRMED_MEMORY_MS
} = require(path.join(ROOT, 'src/shared/tab-mode-rules'));
const BUNDLED = require(path.join(ROOT, 'src/core/map-markers/markers.json'));

const KEY = 'deftyconchgaming/Haddonfield Heights';
const RECT = {x: 0, y: 0, width: 1920, height: 1080};

/* ────────────────────────────────────────────────────────────────────────────
 * Doubles
 * ──────────────────────────────────────────────────────────────────────────── */

const TAB_BASE = {
    tabMarkers: true,
    markers: true,
    markerLegend: true,
    markerOpacity: 0.9,
    markerLayerCellar: true,
    markerLayerGate: true,
    markerLayerCar: true,
    markerLayerGas: true,
    markerTrigger: 'auto',
    tabMarkerKey: 9
};
const fakeSettings = (over) => makeFakeSettings(over, {base: TAB_BASE});

/** The window double: records what it was asked to do. */
function fakeOverlay() {
    return {
        calls: [],
        bounds: null,
        destroyed: false,
        ensure() { this.calls.push('ensure'); return true; },
        place(bounds, payload) {
            this.calls.push('place');
            this.bounds = bounds;
            this.payload = payload;
            return true;
        },
        hide() { this.calls.push('hide'); this.bounds = null; },
        close() { this.calls.push('close'); this.destroyed = true; },
        isShowing() { return !!this.bounds; }
    };
}

/** The key trigger double — no koffi, no keyboard. */
function fakeTrigger() {
    return {
        running: false,
        usable: true,
        wasDown: false,
        reason: null,
        gamePid: null,
        mapVk: 9,
        counters: {polls: 0, downs: 0, ups: 0, errors: 0},
        started: 0,
        stopped: 0,
        probes: 0,
        /** Load + bind + one harmless call. Never starts the poll. */
        open() {
            this.probes++;
            return this.usable === false
                ? {ok: false, reason: this.reason}
                : {ok: true, reason: null};
        },
        start() { this.running = true; this.started++; return true; },
        stop() { this.running = false; this.wasDown = false; this.stopped++; },
        destroy() { this.stop(); },
        setMapVk(vk) { this.mapVk = vk; },
        setMapPad(code) { this.mapPad = code; },
        setApiPadDown(down) { this.apiPadDown = down; },
        setGamePid(pid) { this.gamePid = pid; },
        status() { return {available: this.usable, running: this.running, vk: this.mapVk}; },
        /** Drive an edge the way the real one does. */
        press() { this.wasDown = true; this.onHint('down', 'down'); },
        release() { this.wasDown = false; this.onHint('up', 'up'); }
    };
}

/**
 * The hidden pad window double: `next` is what *Choose button…* answers,
 * and every watch it was told about is recorded.
 */
function fakePadWindow() {
    return {
        recording: null,
        next: {ok: false, reason: 'no-controller'},
        watches: [],
        records: 0,
        cancelled: [],
        closed: 0,
        ensure() { return true; },
        setWatch(on, code) { this.watches.push({on, code}); },
        record() { this.records++; return Promise.resolve(this.next); },
        cancelRecord(why) { this.cancelled.push(why); return true; },
        close() { this.closed++; },
        destroy() {},
        status() { return {exists: true, failed: false, padsSeen: 2}; }
    };
}

/**
 * A detector double whose capture resolves when the test says so, which is what
 * makes the interleavings expressible at all.
 */
function fakeDetector(over) {
    const o = over || {};
    let releaseCapture = null;
    /**
     * The frame source's reply shape. Since the capture moved into the utility
     * process, Tab mode asks the detector for *decisions* — `grabMatch()` and
     * `grabGate()` — rather than finding and capturing a window itself. The
     * interleavings are still expressible because the reply can be held.
     */
    const reply = (withMatch) => ({
        window: o.noWindow
            ? {present: false, pid: null, rect: null}
            : {present: true, pid: o.pid || 4242, rect: RECT, minimized: false,
                captured: {width: RECT.width, height: RECT.height}},
        gate: o.gate === false ? false : true,
        match: withMatch && o.gate !== false
            ? {key: KEY, score: 0.99, second: 0.5, margin: 0.49, accepted: true,
                acceptedBy: 'score', panelMean: 0.2}
            : null,
        menu: null,
        timings: {enumerate: 0, capture: 20, match: 5, total: 25}
    });
    const grab = (withMatch) => new Promise(resolve => {
        releaseCapture = () => resolve(reply(withMatch));
        if (!o.hold) releaseCapture();
    });
    return {
        running: true,
        templates: {[KEY]: [new Float32Array(64 * 64)]},
        size: 64,
        /**
         * The map *the detector* currently knows the game is on. Settable,
         * because it is what the main menu clears and what a new match
         * replaces, and Tab mode's optimistic show is only allowed when its own
         * memory and this agree. `undefined` in the options means "the detector
         * has recognised KEY", which is the ordinary in-match state.
         */
        lastDetected: o.lastDetected === undefined ? KEY : o.lastDetected,
        log: {lines: [], write(event, fields) { this.lines.push({event, fields}); }},
        isRunning() { return this.running; },
        status() { return {running: this.running, lastDetected: this.lastDetected}; },
        gameWindowInfo() { return {present: o.present !== false, pid: o.pid || 4242}; },
        grabMatch() { return grab(true); },
        grabGate() { return grab(false); },
        /** Let a held capture finish. */
        finishCapture() { if (releaseCapture) releaseCapture(); }
    };
}

/** A TabMode wired to doubles, with a clock the test controls. */
function build(over) {
    const o = over || {};
    const settings = o.settings || fakeSettings(o.settingValues);
    const overlay = o.overlay || fakeOverlay();
    const trigger = o.trigger || fakeTrigger();
    const detector = o.detector || fakeDetector(o.detectorOpts);
    let clock = 1000;
    const mode = new TabMode(settings, {markers: () => BUNDLED.maps[KEY]}, {current: () => 'en'}, {
        ipcMain: {handle() {}, on() {}},
        screen: {
            getPrimaryDisplay: () => ({id: 1}),
            getAllDisplays: () => [{
                id: 1,
                bounds: {x: 0, y: 0, width: 1920, height: 1080},
                scaleFactor: 1
            }],
            dipToScreenRect: (win, r) => r
        },
        overlay,
        trigger,
        padWindow: o.padWindow,
        now: () => clock,
        // The optimistic show's deadline is a **real** timer on purpose — its
        // whole job is to be independent of whether the frame source ever
        // answers — so the tests shorten it rather than stub it out. 40 ms is
        // long enough for several `await`s to interleave and short enough that
        // a dozen cases cost half a second.
        provisionalMs: o.provisionalMs || 40
    });
    mode.setDetector(detector);
    return {
        mode, settings, overlay, trigger, detector,
        tick: (ms) => { clock += ms || 1; },
        now: () => clock
    };
}

const flush = () => new Promise(resolve => setImmediate(resolve));
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** Press, match, release: one full confirmed press, which arms the fast path. */
function confirmOnce(h) {
    h.trigger.press();
    h.mode.onMatch(KEY, RECT, {width: RECT.width, height: RECT.height}, h.now());
    h.trigger.release();
}

/* ────────────────────────────────────────────────────────────────────────────
 * F1 — nothing computed before a hide may be shown after it
 * ──────────────────────────────────────────────────────────────────────────── */

test('a quick tap cannot leave markers on screen', async () => {
    // Reproduced from the field log: key-down at 104 ms starts a confirming
    // capture; key-up at 167 ms hides *nothing* (the markers are not up yet);
    // the capture resolves at 188 ms and used to show them; only the 500 ms
    // safety check took them away again at 772 ms. Half a second of brackets
    // over live gameplay, from a tap.
    const h = build({detectorOpts: {hold: true}});
    h.mode.start();
    h.trigger.press();
    await flush();
    // The capture is in flight. The player lets go.
    h.tick(60);
    h.trigger.release();
    // …and only now does the capture resolve.
    h.detector.finishCapture();
    await flush();
    await flush();
    assert.strictEqual(h.mode.isShowing(), false, 'markers went up after the key was released');
    assert.ok(!h.overlay.calls.includes('place'), 'the window was placed after a key-up');
    assert.ok(h.mode.counters.stale > 0, 'the stale result was not counted');
});

test('a detector tick already in flight cannot re-show after a hide', async () => {
    // The other half of the same race, and the one with no key-down behind it
    // at all: the detector's own 700 ms tick captures, the player releases, the
    // markers come down, and then the tick finishes and reports a match.
    const h = build();
    h.mode.start();
    h.trigger.press();
    const startedAt = h.now();
    // The tick began now; the markers then come down.
    h.tick(30);
    h.trigger.release();
    h.tick(10);
    // The tick finishes and reports what it saw *before* the release.
    h.mode.onMatch(KEY, RECT, {width: RECT.width, height: RECT.height}, startedAt);
    assert.strictEqual(h.mode.isShowing(), false, 'a tick from before the hide put the markers back');
    assert.ok(h.mode.counters.stale > 0);
});

test('a match with the key already up is refused even when it is fresh', async () => {
    // Belt to the timestamp's braces: in the key method a match that is not
    // backed by a key that is still held is not something to show, whatever
    // its clock says.
    const h = build();
    h.mode.start();
    h.trigger.press();
    h.trigger.release();
    h.mode.onMatch(KEY, RECT, {width: RECT.width, height: RECT.height}, h.now());
    assert.strictEqual(h.mode.isShowing(), false);
});

test('a fresh match while the key is held does show', async () => {
    // The control for the three tests above: the guards must not simply refuse
    // everything.
    const h = build();
    h.mode.start();
    h.trigger.press();
    h.mode.onMatch(KEY, RECT, {width: RECT.width, height: RECT.height}, h.now());
    assert.strictEqual(h.mode.isShowing(), true);
    assert.ok(h.overlay.calls.includes('place'));
    assert.strictEqual(h.mode.counters.stale, 0);
});

test('a stale negative gate cannot hide a fresh show', async () => {
    // The same rule in the other direction: a slow safety check whose negative
    // answer lands after a newer positive one would take markers down that had
    // just gone up.
    const h = build();
    h.mode.start();
    h.trigger.press();
    h.mode.onMatch(KEY, RECT, {width: RECT.width, height: RECT.height}, h.now());
    assert.strictEqual(h.mode.isShowing(), true);
    const epochBefore = h.mode.epoch;
    // Something hides and something else re-shows…
    h.trigger.release();
    h.trigger.press();
    h.mode.onMatch(KEY, RECT, {width: RECT.width, height: RECT.height}, h.now());
    assert.strictEqual(h.mode.isShowing(), true);
    assert.notStrictEqual(h.mode.epoch, epochBefore, 'the hide did not bump the epoch');
});

test('a key change strands a capture that was already running', async () => {
    const h = build({detectorOpts: {hold: true}});
    h.mode.start();
    h.trigger.press();
    await flush();
    // The user rebinds the map key while the confirmation is in flight.
    h.mode.invalidate();
    h.detector.finishCapture();
    await flush();
    await flush();
    assert.strictEqual(h.mode.isShowing(), false);
});

test('stop() strands an in-flight capture even with nothing on screen', async () => {
    const h = build({detectorOpts: {hold: true}});
    h.mode.start();
    h.trigger.press();
    await flush();
    h.mode.stop();
    h.mode.start();
    h.detector.finishCapture();
    await flush();
    await flush();
    assert.strictEqual(h.mode.isShowing(), false, 'the old run overtook the new one');
});

/* ────────────────────────────────────────────────────────────────────────────
 * F2 — the key is only polled when there is a game to poll it for
 * ──────────────────────────────────────────────────────────────────────────── */

test('the key is not polled with the game closed', () => {
    // Turning the mode on with the game closed used to poll forever, because
    // `onWindow(false)` is an *edge* that never fires when the window was
    // absent all along.
    const h = build({detectorOpts: {present: false}});
    h.mode.start();
    assert.strictEqual(h.trigger.running, false, 'the key was polled with no game window');
    // …and it starts as soon as the window appears.
    h.mode.onWindow(true, 4242);
    assert.strictEqual(h.trigger.running, true);
    // …and stops again when it goes.
    h.mode.onWindow(false, null);
    assert.strictEqual(h.trigger.running, false);
});

test('with the game closed the app says "waiting", not "unavailable"', () => {
    // The first packaged run, as a test: game shut, mode switched on. It used
    // to log `method=polling reason=unavailable … detectMs=450` — three
    // falsehoods in one line — and Settings would have said the key state was
    // not available on this PC.
    const h = build({detectorOpts: {present: false}});
    h.mode.start();
    const status = h.mode.status();
    assert.strictEqual(status.method, 'key-waiting');
    assert.strictEqual(status.methodReason, 'no-game');
    assert.strictEqual(status.gameWindow, false);
    // Nothing fast is in effect, because there is nothing to capture.
    assert.strictEqual(status.detectMs, 0, 'a 450 ms override was claimed with no game');
    assert.strictEqual(status.checkMs, SAFETY_INTERVAL);
    assert.strictEqual(h.mode.wantsFasterDetection(), false);
    // …and no fallback notice was shown, because nothing failed.
    assert.strictEqual(h.mode.fallbackNoticed, false);
});

test('the native path is probed with the game closed, without reading a key', () => {
    // The other half of the field report: because the trigger was only ever
    // *started* when a game window existed, koffi was never loaded at all — so
    // the owner's antivirus test exercised nothing.
    const h = build({detectorOpts: {present: false}});
    h.mode.start();
    assert.ok(h.trigger.probes > 0, 'the native binding was never probed');
    assert.strictEqual(h.trigger.running, false, 'probing must not start the poll');
});

test('game closed → game running → the key method re-arms everything', () => {
    const h = build({detectorOpts: {present: false}});
    h.mode.start();
    assert.strictEqual(h.mode.method(), 'key-waiting');
    assert.strictEqual(h.mode.checkMs(), SAFETY_INTERVAL);

    // The game starts.
    h.mode.onWindow(true, 4242);
    assert.strictEqual(h.mode.method(), 'key');
    assert.strictEqual(h.mode.status().methodReason, 'key');
    assert.strictEqual(h.trigger.running, true);
    assert.strictEqual(h.mode.checkMs(), SAFETY_INTERVAL);
    assert.strictEqual(h.mode.wantsFasterDetection(), false);
    // …and it really works from there: a press and a match show the markers.
    h.trigger.press();
    h.mode.onMatch(KEY, RECT, {width: RECT.width, height: RECT.height}, h.now());
    assert.strictEqual(h.mode.isShowing(), true);

    // The game closes again: markers down, poll stopped, back to waiting.
    h.mode.onLost('no-window');
    h.mode.onWindow(false, null);
    assert.strictEqual(h.mode.isShowing(), false);
    assert.strictEqual(h.trigger.running, false);
    assert.strictEqual(h.mode.method(), 'key-waiting');
});

test('a probe that fails is what shows the fallback notice', () => {
    // …and it is shown even with the game closed, because that is a real
    // finding about this PC — unlike "the game is not running yet".
    const notices = [];
    const trigger = fakeTrigger();
    trigger.usable = false;
    trigger.reason = 'load';
    const h = build({trigger, detectorOpts: {present: false}});
    h.mode.setNotifier((message) => notices.push(message));
    h.mode.start();
    assert.strictEqual(h.mode.method(), 'polling');
    assert.strictEqual(h.mode.status().methodReason, 'load');
    assert.strictEqual(notices.length, 1, 'the fallback notice was not shown');
    // The polling cadences really are the ones in effect now.
    assert.strictEqual(h.mode.checkMs(), FAST_INTERVAL);
    // …and it is said once, not once per re-evaluation.
    h.mode.applyMethod();
    h.mode.applyMethod();
    assert.strictEqual(notices.length, 1);
});

test('no notice is shown merely because the game is not running', () => {
    const notices = [];
    const h = build({detectorOpts: {present: false}});
    h.mode.setNotifier((message) => notices.push(message));
    h.mode.start();
    h.mode.onWindow(false, null);
    h.mode.applyMethod();
    assert.deepStrictEqual(notices, []);
});

test('the key is not polled while the markers master switch is off', () => {
    const h = build({settingValues: {markers: false}});
    h.mode.start();
    assert.strictEqual(h.trigger.running, false);
});

test('"polling only" stops the key being read at all', () => {
    const h = build({settingValues: {markerTrigger: 'polling'}});
    h.mode.start();
    assert.strictEqual(h.trigger.running, false);
    assert.strictEqual(h.mode.method(), 'polling');
    assert.strictEqual(h.mode.checkMs(), FAST_INTERVAL);
});

test('the method decides the cadences', () => {
    const h = build();
    h.mode.start();
    assert.strictEqual(h.mode.method(), 'key');
    assert.strictEqual(h.mode.checkMs(), SAFETY_INTERVAL);
    // With the trigger the detector keeps its ordinary 700 ms.
    assert.strictEqual(h.mode.wantsFasterDetection(), false);
    h.settings.set('markerTrigger', 'polling');
    h.mode.applyMethod();
    assert.strictEqual(h.mode.checkMs(), FAST_INTERVAL);
    assert.strictEqual(h.mode.wantsFasterDetection(), true);
});

/* ────────────────────────────────────────────────────────────────────────────
 * F3 — the markers master switch, and live changes mid-hold
 * ──────────────────────────────────────────────────────────────────────────── */

test('the markers master switch starts and stops the mode', () => {
    // Ctrl+Alt+M writes `markers` through the generic `set-setting`, and
    // nothing used to tell this class: starting with markers off left the mode
    // stopped, and turning them back on did not start it.
    const h = build({settingValues: {markers: false}});
    h.mode.syncWithSettings();
    assert.strictEqual(h.mode.enabled, false);
    h.settings.set('markers', true);
    assert.strictEqual(h.mode.enabled, true, 'the master switch did not start the mode');
    h.settings.set('markers', false);
    assert.strictEqual(h.mode.enabled, false, 'the master switch did not stop the mode');
});

test('switching markers off while they are showing hides them at once', () => {
    const h = build();
    h.mode.start();
    h.trigger.press();
    h.mode.onMatch(KEY, RECT, {width: RECT.width, height: RECT.height}, h.now());
    assert.strictEqual(h.mode.isShowing(), true);
    h.settings.set('markers', false);
    assert.strictEqual(h.mode.isShowing(), false, 'they waited for the next check');
    assert.ok(h.overlay.calls.includes('hide'));
});

test('a layer switched off mid-hold rebuilds the payload in place', () => {
    const h = build();
    h.mode.start();
    h.trigger.press();
    h.mode.onMatch(KEY, RECT, {width: RECT.width, height: RECT.height}, h.now());
    const before = h.overlay.payload.layers.map(l => l.id);
    assert.ok(before.includes('car'));
    h.settings.set('markerLayerCar', false);
    assert.strictEqual(h.mode.isShowing(), true, 'one layer off should not hide everything');
    assert.ok(!h.overlay.payload.layers.map(l => l.id).includes('car'), 'the payload was not rebuilt');
});

test('an opacity change mid-hold reaches the window', () => {
    const h = build();
    h.mode.start();
    h.trigger.press();
    h.mode.onMatch(KEY, RECT, {width: RECT.width, height: RECT.height}, h.now());
    assert.strictEqual(h.overlay.payload.opacity, 0.9);
    h.settings.set('markerOpacity', 0.4);
    assert.strictEqual(h.overlay.payload.opacity, 0.4);
});

test('switching every layer off hides rather than drawing nothing', () => {
    const h = build();
    h.mode.start();
    h.trigger.press();
    h.mode.onMatch(KEY, RECT, {width: RECT.width, height: RECT.height}, h.now());
    for (const key of ['markerLayerCellar', 'markerLayerGate', 'markerLayerCar', 'markerLayerGas']) {
        h.settings.set(key, false);
    }
    assert.strictEqual(h.mode.isShowing(), false);
});

/* ────────────────────────────────────────────────────────────────────────────
 * F8 — retries while the key is held
 * ──────────────────────────────────────────────────────────────────────────── */

test('a confirmation that arrives while a capture runs is queued, not dropped', async () => {
    const h = build({detectorOpts: {hold: true}});
    h.mode.start();
    h.trigger.press();
    await flush();
    assert.strictEqual(h.mode.busy, true);
    // A second request lands mid-capture.
    h.mode.confirmNow();
    assert.strictEqual(h.mode.confirmQueued, true, 'the second press was dropped');
});

test('the retry schedule is bounded and only runs while the key is held', () => {
    const h = build();
    h.mode.start();
    h.trigger.press();
    h.mode.clearTimer();
    // The budget is the immediate attempt plus `CONFIRM_RETRY_DELAYS.length`
    // retries, and then it stops: a key held for three seconds does not need a
    // fourth look, because the 500 ms safety check takes over.
    h.mode.confirmAttempts = CONFIRM_RETRY_DELAYS.length + 1;
    h.mode.scheduleConfirmRetry();
    assert.strictEqual(h.mode.confirmTimer, null, 'it retried past the end of the schedule');
    // …and a released key stops it even with retries left.
    h.mode.confirmAttempts = 1;
    h.trigger.release();
    h.mode.scheduleConfirmRetry();
    assert.strictEqual(h.mode.confirmTimer, null, 'it retried after the key came up');
    // …as does having the markers already on screen.
    h.trigger.press();
    h.mode.onMatch(KEY, RECT, {width: RECT.width, height: RECT.height}, h.now());
    h.mode.clearTimer();
    h.mode.confirmAttempts = 1;
    h.mode.scheduleConfirmRetry();
    assert.strictEqual(h.mode.confirmTimer, null, 'it retried while already showing');
});

test('a fresh press starts a fresh retry budget', () => {
    const h = build();
    h.mode.start();
    h.mode.confirmAttempts = 3;
    // The press resets the budget and then spends the first attempt on the
    // immediate confirmation, so one is the fresh state.
    h.trigger.press();
    assert.strictEqual(h.mode.confirmAttempts, 1);
});

/* ────────────────────────────────────────────────────────────────────────────
 * Everything that takes the markers down
 * ──────────────────────────────────────────────────────────────────────────── */

test('every loss hides immediately', () => {
    for (const reason of ['no-window', 'minimized', 'moved', 'menu', 'capture-error', 'detector-error']) {
        const h = build();
        h.mode.start();
        h.trigger.press();
        h.mode.onMatch(KEY, RECT, {width: RECT.width, height: RECT.height}, h.now());
        assert.strictEqual(h.mode.isShowing(), true, reason);
        h.mode.onLost(reason);
        assert.strictEqual(h.mode.isShowing(), false, reason);
    }
});

test('the detector stopping takes the markers down and stops the key', () => {
    const h = build();
    h.mode.start();
    h.trigger.press();
    h.mode.onMatch(KEY, RECT, {width: RECT.width, height: RECT.height}, h.now());
    h.detector.running = false;
    h.mode.syncWithSettings();
    assert.strictEqual(h.mode.isShowing(), false);
    assert.strictEqual(h.trigger.running, false);
});

test('a dead renderer hides and stops believing the markers are up', () => {
    const h = build();
    h.mode.start();
    h.trigger.press();
    h.mode.onMatch(KEY, RECT, {width: RECT.width, height: RECT.height}, h.now());
    assert.strictEqual(h.mode.isShowing(), true);
    h.overlay.onRendererGone('crashed');
    assert.strictEqual(h.mode.isShowing(), false);
});

test('a bordered window is not drawn on at all', () => {
    // The capture is not the window rectangle, so every marker would sit
    // offset by the border. "Nearly right" over the game's own map is worse
    // than nothing, because the player cannot tell it is wrong.
    const h = build();
    h.mode.start();
    h.trigger.press();
    h.mode.onMatch(KEY, RECT, {width: RECT.width - 16, height: RECT.height - 39}, h.now());
    assert.strictEqual(h.mode.isShowing(), false);
    assert.strictEqual(h.mode.status().sizeMismatch, true);
});

test('destroy() closes the window for good', () => {
    const h = build();
    h.mode.start();
    h.mode.destroy();
    assert.strictEqual(h.mode.destroyed, true);
    assert.ok(h.overlay.calls.includes('close'));
    // A late `set-tab-markers` — or a detector restart during quit — must not
    // build a second always-on-top window while the installer takes over.
    const calls = h.overlay.calls.length;
    h.mode.syncWithSettings();
    h.mode.start();
    assert.strictEqual(h.overlay.calls.length, calls, 'the window came back after destroy()');
    assert.strictEqual(h.mode.isActive(), false);
});

test('status reports the method, the key and the counters', () => {
    const h = build();
    h.mode.start();
    const status = h.mode.status();
    assert.strictEqual(status.setting, true);
    assert.strictEqual(status.method, 'key');
    assert.strictEqual(status.mapVk, 9);
    assert.strictEqual(status.checkMs, SAFETY_INTERVAL);
    assert.strictEqual(status.gameWindow, true);
    assert.strictEqual(typeof status.stale, 'number');
    assert.strictEqual(typeof status.retries, 'number');
});

/* ────────────────────────────────────────────────────────────────────────────
 * The markers must never linger, whatever the frame source is doing
 * ──────────────────────────────────────────────────────────────────────────── */

test('a safety check that is never answered still takes the markers down', async () => {
    // Three things at once, reproduced at **3.4 seconds** of brackets over live
    // gameplay: the worker died while the markers were up, the key-up was
    // missed (so only the safety net could hide them), and the replacement
    // child never finished booting — so the request sat out the *start-up*
    // grace period rather than the ordinary timeout.
    //
    // The frame source's timeout is the frame source's business. This mode
    // draws over the game, so it keeps a deadline of its own: its own cadence.
    // The press is answered normally — it is the *check* that is left hanging,
    // with the key-up missed, which is the only way the markers can be left on
    // screen at all.
    const opts = {hold: false};
    const h = build({detectorOpts: opts});
    h.mode.start();
    h.trigger.press();
    await flush();
    h.mode.onMatch(KEY, RECT, {width: RECT.width, height: RECT.height}, h.now());
    assert.strictEqual(h.mode.isShowing(), true);
    assert.strictEqual(h.mode.checkMs(), SAFETY_INTERVAL);
    assert.strictEqual(h.mode.busy, false);
    opts.hold = true;

    // The safety check runs — and nothing ever answers it.
    const started = Date.now();
    const check = h.mode.check();
    await new Promise(resolve => setTimeout(resolve, SAFETY_INTERVAL + 120));
    await check;
    const waited = Date.now() - started;

    assert.strictEqual(h.mode.isShowing(), false, 'the markers stayed up with no answer');
    assert.ok(h.overlay.calls.includes('hide'));
    assert.ok(waited < SAFETY_INTERVAL * 3,
        `the hide waited ${waited} ms — the frame source's start-up grace, not this mode's cadence`);
    // …and the loop is not wedged behind it either.
    assert.strictEqual(h.mode.busy, false);
    // A late answer to that dead question must not put them back up.
    h.detector.finishCapture();
    await flush();
    await flush();
    assert.strictEqual(h.mode.isShowing(), false, 'a late reply re-showed the markers');
});

test('a confirming press that is never answered does not wedge the mode', async () => {
    // The mirror case, and the cheaper one: a press can only ever *show*, and
    // the epoch already stops it showing late. What must not happen is `busy`
    // being held for the frame source's whole start-up grace while the key is
    // down, because that is the flag the retry schedule queues behind.
    const h = build({detectorOpts: {hold: true}});
    h.mode.start();
    h.trigger.press();
    await flush();
    assert.strictEqual(h.mode.busy, true);
    await new Promise(resolve => setTimeout(resolve, SAFETY_INTERVAL + 120));
    assert.strictEqual(h.mode.busy, false, 'a slow frame source wedged the confirming press');
    assert.strictEqual(h.mode.isShowing(), false, 'nothing is ever shown without an answer');
    h.detector.finishCapture();
    await flush();
    await flush();
    assert.strictEqual(h.mode.isShowing(), false);
});

/* ────────────────────────────────────────────────────────────────────────────
 * tabHidesMinimap — the corner overlay steps aside only while the mode runs
 * ──────────────────────────────────────────────────────────────────────────── */

test('the corner overlay is hidden only while the mode is running and the setting is on', () => {
    const h = build({settingValues: {tabHidesMinimap: true}});
    const corner = {suppressed: null, setSuppressed(on) { this.suppressed = on; }};
    h.mode.setCornerOverlay(corner);
    assert.strictEqual(corner.suppressed, false, 'not running yet: the corner overlay is the only map');
    h.mode.start();
    assert.strictEqual(corner.suppressed, true);
    h.settings.set('tabHidesMinimap', false);
    assert.strictEqual(corner.suppressed, false, 'the switch acts at once');
    h.settings.set('tabHidesMinimap', true);
    assert.strictEqual(corner.suppressed, true);
    // Auto-detect switched off: this mode stops, so the corner overlay returns.
    h.mode.stop();
    assert.strictEqual(corner.suppressed, false);
    h.mode.start();
    h.mode.destroy();
    h.mode.syncCornerOverlay();
    assert.strictEqual(corner.suppressed, false, 'never left hidden by a quit');
});

test('the corner overlay is left alone by default', () => {
    const h = build();
    const corner = {suppressed: null, setSuppressed(on) { this.suppressed = on; }};
    h.mode.setCornerOverlay(corner);
    h.mode.start();
    assert.strictEqual(corner.suppressed, false);
});

/* ────────────────────────────────────────────────────────────────────────────
 * The optimistic show — `tabMarkersInstant`
 *
 * The owner's field log (39 presses) measured the markers appearing 320-530 ms
 * after the key went down, median 353, because the game fades its own map in
 * over 250-330 ms and the screen gate says no until that fade ends. From the
 * *second* press of a match onwards the markers now go up on the key edge and
 * fade in alongside it, while the same confirming capture runs in parallel.
 *
 * Everything below is the half of that which must not go wrong: markers may
 * never linger over gameplay, and they may never belong to another map.
 * ──────────────────────────────────────────────────────────────────────────── */

test('the first press of a match is never provisional; the second is', async () => {
    const h = build({detectorOpts: {hold: true}});
    h.mode.start();
    // Nothing has been confirmed, so the press buys a capture and nothing else
    // — exactly as it always did, and the capture is being held here, so if
    // anything were drawn it could only have been a guess.
    h.trigger.press();
    await flush();
    assert.strictEqual(h.mode.isShowing(), false, 'the very first press guessed');
    assert.strictEqual(h.mode.counters.provisional, 0);
    h.detector.finishCapture();
    await flush();
    await flush();
    assert.strictEqual(h.mode.isShowing(), true);
    assert.strictEqual(h.mode.state.provisional, false);
    assert.strictEqual(h.mode.state.confirmedKey, KEY);

    // …and now the second press. The capture is held again, so the markers on
    // screen are there on the strength of the key edge alone.
    h.trigger.release();
    assert.strictEqual(h.mode.isShowing(), false);
    h.trigger.press();
    assert.strictEqual(h.mode.isShowing(), true, 'the second press still waited for a capture');
    assert.strictEqual(h.mode.state.provisional, true);
    assert.strictEqual(h.mode.counters.provisional, 1);
    // The renderer is told to fade it in; nothing else ever carries that flag.
    assert.strictEqual(h.overlay.payload.fade, true);
});

test('a confirmation does not re-send the payload, and is logged with its timing', async () => {
    const h = build();
    h.mode.start();
    confirmOnce(h);
    h.trigger.press();
    assert.strictEqual(h.mode.state.provisional, true);
    const places = h.overlay.calls.filter(c => c === 'place').length;
    h.tick(120);
    h.mode.onMatch(KEY, RECT, {width: RECT.width, height: RECT.height}, h.now());
    assert.strictEqual(h.mode.state.provisional, false, 'the confirmation did not settle it');
    assert.strictEqual(h.mode.isShowing(), true);
    assert.strictEqual(h.overlay.calls.filter(c => c === 'place').length, places,
        'the payload was re-sent, which would restart the fade mid-animation');
    const line = h.detector.log.lines.filter(l => l.event === 'tab-confirmed').pop();
    assert.ok(line, 'no tab-confirmed line');
    assert.strictEqual(line.fields.ms, 120);
});

test('a provisional show with no confirmation comes down at the deadline, and forgets', async () => {
    // `gate: false`: every capture says "that is not the Tab screen", which is
    // exactly what the key being pressed in the chat or the pause menu looks
    // like. Nothing will ever confirm this press.
    const h = build({detectorOpts: {gate: false}});
    h.mode.start();
    confirmOnce(h);
    h.trigger.press();
    assert.strictEqual(h.mode.isShowing(), true);
    // Nothing confirms it — the player pressed the key in the chat, or the
    // pause menu, where the map never opens.
    await wait(h.mode.provisionalMs + 40);
    assert.strictEqual(h.mode.isShowing(), false, 'a guess was left on screen');
    assert.strictEqual(h.mode.counters.unconfirmed, 1);
    const hide = h.detector.log.lines.filter(l => l.event === 'tab-hide').pop();
    assert.strictEqual(hide.fields.reason, 'unconfirmed');
    // …and the memory went with it, so a third press is slow and certain
    // again: repeated presses where the map does not open flash **once**.
    assert.strictEqual(h.mode.state.confirmedKey, null);
    h.trigger.release();
    h.trigger.press();
    assert.strictEqual(h.mode.isShowing(), false, 'it flashed a second time');
    assert.strictEqual(h.mode.counters.provisional, 1);
});

test('a wedged frame source cannot keep a provisional show up', async () => {
    // The deadline is a timer of this mode's own, not a reply to a question:
    // the worker can have died, be restarting or simply never answer, and the
    // markers still come down. This is the same promise as `grabWithin`, one
    // layer further out.
    const h = build({detectorOpts: {hold: true}});
    h.mode.start();
    confirmOnce(h);
    h.detector.finishCapture();
    await flush();
    h.trigger.press();
    assert.strictEqual(h.mode.isShowing(), true);
    await wait(h.mode.provisionalMs + 40);
    assert.strictEqual(h.mode.isShowing(), false, 'a capture that never answered held them up');
    assert.strictEqual(h.mode.counters.unconfirmed, 1);
    // A late answer to that dead question must not put them back either.
    h.detector.finishCapture();
    await flush();
    await flush();
    assert.strictEqual(h.mode.isShowing(), false);
});

test('a key-up during a provisional show hides at once, and a late match cannot re-show', async () => {
    const h = build({detectorOpts: {hold: true}});
    h.mode.start();
    confirmOnce(h);
    h.detector.finishCapture();
    await flush();
    h.trigger.press();
    assert.strictEqual(h.mode.isShowing(), true);
    const startedAt = h.now();
    h.tick(30);
    h.trigger.release();
    assert.strictEqual(h.mode.isShowing(), false, 'the key-up waited for something');
    assert.ok(h.overlay.calls.includes('hide'));
    // The confirming capture resolves *after* the release — the F1 race, now
    // with something actually on screen to be wrong about.
    h.detector.finishCapture();
    await flush();
    await flush();
    assert.strictEqual(h.mode.isShowing(), false, 'a stale confirmation re-showed them');
    // …and a detector tick from before the release is refused too.
    h.mode.onMatch(KEY, RECT, {width: RECT.width, height: RECT.height}, startedAt);
    assert.strictEqual(h.mode.isShowing(), false);
    assert.ok(h.mode.counters.stale > 0);
});

test('a negative gate does not take a provisional show down before the deadline', async () => {
    // The gate is *expected* to say no while the game fades its map in, which
    // is the whole reason the markers went up early. After the confirmation the
    // ordinary rule is back: one negative gate hides.
    const h = build({detectorOpts: {gate: false}});
    h.mode.start();
    confirmOnce(h);
    h.trigger.press();
    assert.strictEqual(h.mode.isShowing(), true);
    const epoch = h.mode.epoch;
    h.mode.dispatch({type: 'gate', up: false});
    assert.strictEqual(h.mode.isShowing(), true, 'the fade was mistaken for gameplay');
    assert.strictEqual(h.mode.state.provisional, true);
    // …and it must not have quietly disarmed everything that can *end* the
    // provisional state. This was the bug: `invalidates` was decided before the
    // reduce, so a negative gate cancelled the deadline, the retry chain and
    // the confirming capture while the reducer kept the markers up — and every
    // later negative gate answered "fading" too, so nothing short of a key-up
    // ever took them down again.
    assert.ok(h.mode.provisionalTimer, 'the negative gate cancelled the deadline');
    assert.strictEqual(h.mode.epoch, epoch, 'the negative gate stranded the confirming capture');
    // Which is proved the only way that matters: they come down on their own.
    await wait(h.mode.provisionalMs + 40);
    assert.strictEqual(h.mode.isShowing(), false, 'the markers outlived their deadline');
    assert.strictEqual(h.mode.counters.unconfirmed, 1);

    // Once confirmed, one negative gate hides, exactly as it always did. (The
    // key is still held — the deadline hid the markers, it did not end the
    // press — so a match that finally arrives is drawn.)
    h.mode.onMatch(KEY, RECT, {width: RECT.width, height: RECT.height}, h.now());
    assert.strictEqual(h.mode.isShowing(), true);
    h.mode.dispatch({type: 'gate', up: false});
    assert.strictEqual(h.mode.isShowing(), false, 'a confirmed show survived a negative gate');
});

test('a negative gate from the detector\'s own tick cannot strand a provisional show', async () => {
    // The detector sends these at its ordinary cadence (`notifyTabMode('onGate',
    // …)`), so this arrives in plain gameplay with no test poking at it.
    const h = build({detectorOpts: {gate: false}});
    h.mode.start();
    confirmOnce(h);
    h.trigger.press();
    h.mode.onGate(false);
    h.mode.onGate(false);
    assert.strictEqual(h.mode.isShowing(), true, 'the fade was mistaken for gameplay');
    assert.ok(h.mode.provisionalTimer);
    await wait(h.mode.provisionalMs + 40);
    assert.strictEqual(h.mode.isShowing(), false);
});

test('a negative safety check cannot strand a provisional show either', async () => {
    // The other producer of negative gates: this mode's own periodic check,
    // which under a provisional show is running at the same time as the
    // confirming capture.
    const h = build({detectorOpts: {gate: false}});
    h.mode.start();
    confirmOnce(h);
    h.trigger.press();
    await flush();
    await h.mode.check();
    assert.strictEqual(h.mode.isShowing(), true, 'the check hid the game\'s own fade');
    assert.ok(h.mode.provisionalTimer, 'the check cancelled the deadline');
    await wait(h.mode.provisionalMs + 60);
    assert.strictEqual(h.mode.isShowing(), false);
    assert.strictEqual(h.mode.counters.unconfirmed, 1);
});

test('falling back to polling mid-show still leaves the deadline in charge', async () => {
    // The trigger can stop working after it has worked — and it does so *while*
    // a provisional show is up, taking the key-up edge that would normally hide
    // it with it. The deadline is what is left.
    const h = build({detectorOpts: {gate: false}});
    h.mode.start();
    confirmOnce(h);
    h.trigger.press();
    assert.strictEqual(h.mode.isShowing(), true);
    // What `KeyTrigger.giveUp()` does before it calls back.
    h.trigger.usable = false;
    h.trigger.reason = 'call';
    h.mode.fallBackToPolling('call');
    assert.strictEqual(h.mode.method(), 'polling');
    await wait(h.mode.provisionalMs + 40);
    assert.strictEqual(h.mode.isShowing(), false, 'the markers survived the fallback');
    assert.strictEqual(h.mode.counters.unconfirmed, 1);
});

test('a provisional state can never outlive its deadline, even if something cancels it', async () => {
    // Belt and braces for the class of bug above: whatever cancels the timer
    // without taking the markers down, the next dispatch hides them. Simulated
    // directly, because the point is to survive a mistake nobody predicted.
    const h = build({detectorOpts: {gate: false}});
    h.mode.start();
    confirmOnce(h);
    h.trigger.press();
    assert.strictEqual(h.mode.state.provisional, true);
    h.mode.clearProvisionalDeadline();
    h.mode.dispatch({type: 'gate', up: true});
    assert.strictEqual(h.mode.isShowing(), false, 'a provisional show with no deadline stayed up');
    assert.strictEqual(h.mode.counters.unconfirmed, 1);
});

test('a deadline that expires with the key still held restarts the slow path', async () => {
    // A genuine press can simply be slower than the deadline. Hiding and then
    // leaving it to the detector's next 700 ms tick would read as
    // show 0 ms → hide → re-show ~1150 ms, which is worse than never having
    // guessed. So the ordinary, certain path starts again for the same press.
    const gated = {gate: false};
    const h = build({detectorOpts: gated});
    h.mode.start();
    confirmOnce(h);
    h.trigger.press();
    assert.strictEqual(h.mode.isShowing(), true);
    await wait(h.mode.provisionalMs + 40);
    assert.strictEqual(h.mode.isShowing(), false);
    // The key is still down, so a fresh confirmation is in flight against the
    // new epoch — and when the game's map finally does pass the gate, it shows.
    assert.ok(h.mode.confirmAttempts > 0, 'the press was abandoned at the deadline');
    gated.gate = true;
    await h.mode.confirm();
    await flush();
    assert.strictEqual(h.mode.isShowing(), true, 'a slow but genuine press never recovered');
    assert.strictEqual(h.mode.state.provisional, false);
});

test('short unconfirmed taps flash exactly once', async () => {
    // The pause menu, the chat, the end screen: the key is pressed repeatedly
    // and the map never opens. The first tap is allowed its guess; the key-up
    // that ends a still-unconfirmed show forgets the memory, so every tap after
    // it takes the slow path and shows nothing at all.
    const h = build({detectorOpts: {gate: false}});
    h.mode.start();
    confirmOnce(h);
    for (let i = 0; i < 5; i++) {
        h.trigger.press();
        h.trigger.release();
        await flush();
    }
    assert.strictEqual(h.mode.counters.provisional, 1,
        'every tap flashed, not just the first');
    assert.strictEqual(h.mode.isShowing(), false);
});

test('the confirming retries keep running under a provisional show', async () => {
    // They matter *more* here than on the ordinary path: without a confirmation
    // the markers come down again at the deadline, so a press whose first
    // capture was too early depends on them entirely. `scheduleConfirmRetry`
    // used to refuse whenever anything was on screen.
    const h = build({detectorOpts: {gate: false}});
    h.mode.start();
    h.trigger.press();
    h.mode.onMatch(KEY, RECT, {width: RECT.width, height: RECT.height}, h.now());
    h.trigger.release();
    h.trigger.press();
    await flush();
    await flush();
    assert.strictEqual(h.mode.state.provisional, true);
    assert.ok(h.mode.confirmTimer, 'no retry was scheduled while the markers were provisional');
    // …and the periodic safety check was armed in the same breath, without
    // cancelling that retry.
    assert.ok(h.mode.timer, 'the safety loop was not started under a provisional show');
});

test('the optimistic memory is dropped when the match ends or the map changes', () => {
    // The main menu: the detector clears its map and tells us.
    let h = build();
    h.mode.start();
    confirmOnce(h);
    h.detector.lastDetected = null;
    h.mode.onLost('menu');
    assert.strictEqual(h.mode.state.confirmedKey, null);
    h.trigger.press();
    assert.strictEqual(h.mode.isShowing(), false, 'a new match started with the old map remembered');

    // The game window going away.
    h = build();
    h.mode.start();
    confirmOnce(h);
    h.mode.onWindow(false, null);
    assert.strictEqual(h.mode.state.confirmedKey, null);

    // The mode being switched off and on.
    h = build();
    h.mode.start();
    confirmOnce(h);
    h.mode.stop();
    h.mode.start();
    assert.strictEqual(h.mode.state.confirmedKey, null);

    // The map key being rebound.
    h = build();
    h.mode.start();
    confirmOnce(h);
    h.mode.dispatch({type: 'lost', reason: 'key-changed'});
    assert.strictEqual(h.mode.state.confirmedKey, null);
});

test('a settings change mid-fade does not re-place the payload, but an empty one still hides', () => {
    // `place()` carries no `fade` flag, so re-sending here would snap markers
    // that are still a guess to full opacity. The confirmation, or the next
    // press, picks the change up.
    const h = build({detectorOpts: {gate: false}});
    h.mode.start();
    confirmOnce(h);
    h.trigger.press();
    assert.strictEqual(h.mode.state.provisional, true);
    const places = h.overlay.calls.filter(c => c === 'place').length;
    h.settings.set('markerLayerCar', false);
    assert.strictEqual(h.overlay.calls.filter(c => c === 'place').length, places,
        'the payload was re-sent mid-fade');
    assert.strictEqual(h.mode.isShowing(), true);
    // Nothing left to draw is still an immediate hide — that rule is older
    // than this feature and is not weakened by it.
    for (const key of ['markerLayerCellar', 'markerLayerGate', 'markerLayerGas']) {
        h.settings.set(key, false);
    }
    assert.strictEqual(h.mode.isShowing(), false);
});

test('the fast path arms after the first confirmed press, detector or no detector', () => {
    // `confirm()` asks `detector.grabMatch()` directly and never writes the
    // detector's `lastDetected`, so requiring the detector to agree would have
    // delayed the fast path by an arbitrary number of presses. Our own
    // `confirmedKey` — a press the *screen gate* accepted — is the answer.
    const h = build({detectorOpts: {lastDetected: null}});
    h.mode.start();
    confirmOnce(h);
    assert.strictEqual(h.mode.state.confirmedKey, KEY);
    h.trigger.press();
    assert.strictEqual(h.mode.isShowing(), true, 'the second press still waited');
    assert.strictEqual(h.mode.counters.provisional, 1);
});

test('a detector naming a different map is a veto, and costs the memory', () => {
    const h = build();
    h.mode.start();
    confirmOnce(h);
    // A new match, on a map the detector has since recognised. Whatever we
    // confirmed was confirmed about the old one.
    h.detector.lastDetected = 'someone/Another Map';
    h.trigger.press();
    assert.strictEqual(h.mode.isShowing(), false, 'the old map was drawn over the new one');
    assert.strictEqual(h.mode.state.confirmedKey, null, 'the stale memory was kept');
    // …and it is a state test, not an edge: a second press with the detector
    // still naming the other map is refused too.
    h.trigger.release();
    h.mode.onMatch(KEY, RECT, {width: RECT.width, height: RECT.height}, h.now());
    h.trigger.release();
    h.trigger.press();
    assert.strictEqual(h.mode.isShowing(), false);
    assert.strictEqual(h.mode.state.confirmedKey, null);
});

test('the memory ages out, and every confirmation refreshes it', () => {
    const h = build();
    h.mode.start();
    confirmOnce(h);
    assert.strictEqual(h.mode.confirmedAt, h.now());
    // Four and a half minutes later, still the same match: nothing has changed.
    h.tick(4.5 * 60 * 1000);
    h.trigger.press();
    assert.strictEqual(h.mode.isShowing(), true);
    // That press was confirmed, so the clock starts again from there.
    h.mode.onMatch(KEY, RECT, {width: RECT.width, height: RECT.height}, h.now());
    assert.strictEqual(h.mode.confirmedAt, h.now());
    h.trigger.release();
    h.tick(4.5 * 60 * 1000);
    h.trigger.press();
    assert.strictEqual(h.mode.isShowing(), true, 'a refreshed memory expired anyway');
    h.trigger.release();

    // …but past five minutes with nothing confirmed, it is gone. This is the
    // bound on "a new match on another map that nothing else noticed".
    h.tick(CONFIRMED_MEMORY_MS + 1);
    h.trigger.press();
    assert.strictEqual(h.mode.isShowing(), false, 'a five-minute-old memory was acted on');
    assert.strictEqual(h.mode.state.confirmedKey, null);
});

test('the setting off means nothing is ever shown early', () => {
    const h = build({settingValues: {tabMarkersInstant: false}});
    h.mode.start();
    confirmOnce(h);
    h.trigger.press();
    assert.strictEqual(h.mode.isShowing(), false, 'the switch did nothing');
    assert.strictEqual(h.mode.counters.provisional, 0);
    assert.strictEqual(h.mode.status().instant, false);
    // …and it can be switched back on without a restart.
    h.settings.set('tabMarkersInstant', true);
    h.trigger.release();
    h.trigger.press();
    assert.strictEqual(h.mode.isShowing(), true);
});

test('the polling path never shows anything early', () => {
    // There is no key edge to be early about: on that path the capture is the
    // only signal, and the capture is the thing being pre-empted.
    const h = build({settingValues: {markerTrigger: 'polling'}});
    h.mode.start();
    h.trigger.press();
    h.mode.onMatch(KEY, RECT, {width: RECT.width, height: RECT.height}, h.now());
    h.mode.dispatch({type: 'hint', key: 'up'});
    h.mode.onKeyHint('down');
    assert.strictEqual(h.mode.isShowing(), false);
    assert.strictEqual(h.mode.counters.provisional, 0);
});

test('a map with no bounds to draw into is never shown early', () => {
    const h = build();
    h.mode.start();
    confirmOnce(h);
    // The window rectangle this mode last saw is gone (the game closed and
    // reopened between the two presses, and nothing has re-measured it).
    h.mode.rect = null;
    h.trigger.press();
    assert.strictEqual(h.mode.isShowing(), false);
});

test('status and the counters report the optimistic show', async () => {
    // Gated out, so the press stays a guess right up to its deadline.
    const h = build({detectorOpts: {gate: false}});
    h.mode.start();
    confirmOnce(h);
    h.trigger.press();
    const status = h.mode.status();
    assert.strictEqual(status.instant, true);
    assert.strictEqual(status.provisionalShowing, true);
    assert.strictEqual(status.confirmedKey, KEY);
    assert.strictEqual(status.provisional, 1);
    assert.strictEqual(status.unconfirmed, 0);
    assert.strictEqual(status.provisionalMs, h.mode.provisionalMs);
    const show = h.detector.log.lines.filter(l => l.event === 'tab-show').pop();
    assert.strictEqual(show.fields.provisional, 'yes');
    assert.strictEqual(show.fields.key, KEY, 'the log named the hint, not the map');
    await wait(h.mode.provisionalMs + 40);
    assert.strictEqual(h.mode.status().unconfirmed, 1);
    assert.strictEqual(h.mode.status().provisionalShowing, false);
});

/* ────────────────────────────────────────────────────────────────────────────
 * The controller button: one path, read on every connected pad
 * ──────────────────────────────────────────────────────────────────────────── */

const VIEW_BUTTON = 8;
const PAD_ID = 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)';

test('Choose button… goes through the pad window alone, and answers with the button only', async () => {
    const padWindow = fakePadWindow();
    const {mode, settings, trigger} = build({padWindow});
    assert.strictEqual(trigger.recordPad, undefined, 'the trigger has no recorder of its own');
    // A pad window that still named the pad it was pressed on: the name goes no further.
    padWindow.next = {ok: true, code: VIEW_BUTTON, label: 'View / Touchpad', id: PAD_ID};
    const answer = await mode.recordPad();
    assert.strictEqual(padWindow.records, 1);
    assert.deepStrictEqual(answer, {ok: true, code: VIEW_BUTTON, label: 'View / Touchpad'});
    // Nothing is stored until Settings stores the button, and then only the button.
    assert.ok(!settings.writes.some(w => w.key === "tabMarkerPad"), "stored before Settings asked");
    mode.setMapPadButton(VIEW_BUTTON);
    assert.strictEqual(settings.get('tabMarkerPad'), VIEW_BUTTON);
    assert.strictEqual(trigger.mapPad, VIEW_BUTTON);
    assert.ok(!settings.writes.some(w => w.key === 'tabMarkerPadId'), 'no pad is chosen any more (after 1.3.2)');
    // A failed recording stores nothing and answers with its reason.
    padWindow.next = {ok: false, reason: 'timeout'};
    assert.deepStrictEqual(await mode.recordPad(), {ok: false, reason: 'timeout'});
    mode.destroy();
});

test('a 1.3.x file that chose the touchpad on one pad reads View on every pad', async () => {
    // The field case (2026-09-23): a DualSense shown twice by Windows (Bluetooth
    // and cable), then Steam's virtual Xbox pad — the chosen id matched none of
    // them and the button went silent. docs/agents/markers-and-tab-mode.md.
    const padWindow = fakePadWindow();
    const {mode, settings, trigger} = build({padWindow, settingValues: {tabMarkerPad: 17, tabMarkerPadId: PAD_ID}});
    assert.strictEqual(mode.mapPad(), VIEW_BUTTON);
    assert.strictEqual(mode.status().mapPadLabel, 'View / Touchpad');
    trigger.running = true;
    trigger.foreground = true;
    mode.syncPadWatch();
    const last = padWindow.watches[padWindow.watches.length - 1];
    assert.deepStrictEqual(last, {on: true, code: VIEW_BUTTON}, 'no pad id reaches the window');
    // The stale id is never read, and removing the button does not touch it either.
    mode.setMapPadButton(null);
    assert.strictEqual(settings.get('tabMarkerPad'), null);
    assert.ok(!settings.writes.some(w => w.key === 'tabMarkerPadId'));
    mode.destroy();
});

test('the pad window is told the button, in the game only, and the status never names a pad', () => {
    const padWindow = fakePadWindow();
    const {mode, trigger} = build({padWindow, settingValues: {tabMarkerPad: VIEW_BUTTON, tabMarkerPadId: PAD_ID}});
    trigger.running = true;
    trigger.foreground = false;
    mode.syncPadWatch();
    assert.deepStrictEqual(padWindow.watches[padWindow.watches.length - 1], {on: false, code: VIEW_BUTTON});
    trigger.foreground = true;
    mode.syncPadWatch();
    assert.deepStrictEqual(padWindow.watches[padWindow.watches.length - 1], {on: true, code: VIEW_BUTTON});
    const status = mode.status();
    assert.strictEqual('mapPadChosen' in status, false);
    assert.ok(!JSON.stringify(status).includes(PAD_ID), 'the id reached the status');
    mode.destroy();
});
