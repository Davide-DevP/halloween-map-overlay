const {test} = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const {EventEmitter} = require('events');

/*
 * The detector **loop**, driven end to end: the real `MapDetector` scheduler
 * and state machine, the real `DetectorWorkerHost`, and a scripted child in
 * place of the utility process.
 *
 * Why this file exists. Every defect it covers was reproduced by an
 * independent review with the real classes wired together, while a 997-test
 * suite passed: each one lived in the seam *between* the scheduler and the
 * host, which no test of either half on its own could see. The worst of them —
 * two overlapping requests leaving a promise pending for ever — killed
 * automatic detection for the rest of the session without writing a single log
 * line.
 *
 * `electron` is stubbed for the duration of the `require`: `MapDetector`
 * registers IPC handlers in its constructor and reads `app.getPath` for its
 * log directory. Without a path the event log disables itself, and `app-log`
 * keeps everything in its ring buffer, so nothing here writes a file.
 */
const electronStub = {
    ipcMain: {handle() {}, on() {}},
    app: {on() {}, getVersion: () => '0.0.0-test'}
};
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === 'electron') return electronStub;
    return originalLoad.call(this, request, ...rest);
};
const MapDetector = require('../src/core/map-detector');
const DetectorWorkerHost = require('../src/core/map-detector/worker-host');
Module._load = originalLoad;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A window the detector will consider "the game", as a reply's `window`. */
const GAME_WINDOW = {
    present: true, pid: 4242, minimized: false,
    rect: {x: 0, y: 0, width: 1920, height: 1080},
    captured: {width: 1920, height: 1080}
};

/**
 * A child that answers every grab after `delayMs` — or holds the answer until
 * a test releases it, which is how an overlap is arranged deterministically.
 */
function scriptedChild(opts) {
    const o = opts || {};
    const child = new EventEmitter();
    child.killed = false;
    child.grabs = 0;
    child.held = [];
    child.postMessage = (message) => {
        if (message.type === 'ping') {
            child.emit('message', {data: {id: message.id, type: 'ping', ok: true, gc: 'available'}});
            return;
        }
        if (message.type !== 'grab') return;
        child.grabs++;
        const answer = () => {
            if (child.killed) return;
            child.emit('message', {data: Object.assign({
                id: message.id, type: 'grab', window: GAME_WINDOW,
                gate: false, match: null, menu: null, timings: {total: 2, gc: 1}
            }, o.reply || {})});
        };
        if (child.hold) child.held.push(answer);
        else setTimeout(answer, o.delayMs == null ? 5 : o.delayMs);
    };
    child.release = () => {
        const waiting = child.held.splice(0);
        for (const answer of waiting) answer();
    };
    child.kill = () => { child.killed = true; child.emit('exit', 0); };
    return child;
}

/** A detector wired to a real host, with its log captured rather than written. */
function loopWith(child, over) {
    const host = new DetectorWorkerHost({fork: () => child, timeoutMs: 500, startTimeoutMs: 800});
    const settings = {
        get: (key) => ({mapDetection: true, hideInMenu: true}[key]),
        set() {}
    };
    const detector = new MapDetector({send() {}, isDestroyed: () => true}, settings,
        Object.assign({frames: host}, over || {}));
    const lines = [];
    detector.log = {write: (event, fields) => lines.push({event, fields: fields || {}}), close() {}};
    return {detector, host, lines};
}

test('an overlapping Tab-mode grab does not kill the detector loop', async () => {
    // Reproduced end to end before the fix: one `grabGate()` landing while a
    // tick's grab was in flight left the tick's promise pending for ever,
    // `detector.busy` stuck true, **zero ticks in the following four seconds**,
    // and nothing in any log. The user's only cure was restarting the app.
    const child = scriptedChild({});
    child.hold = true;
    const {detector, host} = loopWith(child);
    detector.start();
    // Wait for the tick's grab to be in flight, then overlap it.
    for (let i = 0; i < 50 && !host.inflight; i++) await sleep(5);
    assert.ok(host.inflight, 'the first tick never asked for a frame');
    assert.strictEqual(detector.busy, true);

    const tab = detector.grabGate();
    child.hold = false;
    child.release();
    const tabReply = await Promise.race([tab, sleep(1000).then(() => 'HUNG')]);
    assert.notStrictEqual(tabReply, 'HUNG', "Tab mode's grab never came back");
    assert.strictEqual(tabReply.window.present, true);

    // The loop is still alive: `busy` was released and the next tick ran.
    await sleep(60);
    assert.strictEqual(detector.busy, false, 'the loop is stuck busy');
    const before = child.grabs;
    await sleep(900);                       // one 700 ms game-cadence tick
    assert.ok(child.grabs > before, 'the loop stopped ticking after an overlap');
    detector.destroy();
});

test('switching detection off while a grab is in flight does not wedge it', async () => {
    // `stop()` leaves a tick awaiting its reply. That tick belongs to the run
    // that is ending: it must not clear the *next* run's busy flag, and the
    // next run must not inherit a busy flag from it.
    const child = scriptedChild({});
    child.hold = true;
    const {detector, host} = loopWith(child);
    detector.start();
    for (let i = 0; i < 50 && !host.inflight; i++) await sleep(5);
    assert.strictEqual(detector.busy, true);

    detector.stop();
    assert.strictEqual(detector.busy, false, 'stop() left the loop busy for ever');
    // The in-flight request was answered (with "no frame"), not abandoned.
    await sleep(20);

    const restarted = scriptedChild({});
    host.forkFn = () => restarted;
    detector.start();
    await sleep(60);
    assert.ok(restarted.grabs > 0, 'the loop never ticked again');
    assert.strictEqual(detector.running, true);
    detector.destroy();
});

test('"no frame this tick" is not "the game is not running"', async () => {
    // A stop, a restart backoff or a timed-out request answers `aborted`. The
    // window is unknown, not absent: reading it as absent logged a window edge,
    // told Tab mode the window was lost and dropped the cadence to the 2 s idle
    // one — all because main could not ask.
    const child = scriptedChild({});
    const {detector, host, lines} = loopWith(child);
    detector.start();
    await sleep(60);
    assert.strictEqual(detector.windowSeen, true);
    lines.length = 0;

    const lost = [];
    detector.tabMode = {onLost: (reason) => lost.push(reason), syncWithSettings() {}};
    host.grab = async () => ({type: 'grab', aborted: true, reason: 'timeout', window: null, gate: false});
    await detector.tick();

    assert.strictEqual(detector.windowSeen, true, 'a lost answer was read as a lost window');
    assert.ok(!lines.some(l => l.event === 'window'), 'a window edge was logged for a missing answer');
    // Tab mode is still told, because no answer over live gameplay means the
    // markers come down.
    assert.deepStrictEqual(lost, ['no-frame']);
    detector.destroy();
});

test('a worker fault is logged as a fault, not as "game not found"', async () => {
    // A worker-level throw answers with an error and **no window at all**. The
    // window was read first, so the tick reported the game as closed, said so
    // at most once a minute, and the real fault was never written down — while
    // the three-strikes fallback took its time.
    const child = scriptedChild({});
    const {detector, host, lines} = loopWith(child);
    detector.start();
    await sleep(60);
    lines.length = 0;
    host.grab = async () => ({
        type: 'grab', fatal: true, error: 'Cannot find module node-screenshots', gate: false
    });
    await detector.tick();

    const errors = lines.filter(l => l.event === 'error');
    assert.strictEqual(errors.length, 1, 'the worker fault was never logged');
    assert.match(errors[0].fields.message, /node-screenshots/);
    detector.destroy();
});

test('main does not collect for a frame it never held', async () => {
    // The collection belongs where the frame is. In worker mode main used to
    // run a 1-3 ms `gc.collect()` on every captured tick for a buffer that was
    // in another process, which is exactly the blocking work the move existed
    // to remove.
    const child = scriptedChild({});
    const {detector} = loopWith(child);
    detector.start();
    await sleep(60);
    // The number on the timing line is the worker's, reported in its reply.
    assert.strictEqual(detector.lastGcMs, 1);
    detector.destroy();
});

test('the loop keeps counts, not a second copy of every template', () => {
    // Main used to hold a fully prepared template set — thumbnails, gradients
    // and NCC statistics — purely to print how many there were. The matching
    // happens in the worker, which prepares its own.
    const child = scriptedChild({});
    const {detector} = loopWith(child);
    assert.ok(detector.templateKeys.length > 0);
    assert.ok(detector.variantCount >= detector.templateKeys.length);
    assert.strictEqual(detector.templates, undefined, 'main is still keeping the thumbnails');
    detector.destroy();
});

test('a tick with no answer keeps the game cadence', async () => {
    // Both "no frame this tick" and a failed capture used to return *before*
    // the cadence was chosen, so they fell back to the 2 s "the game is not
    // running" interval. One timeout during a Tab press then cost the player
    // two seconds of not looking, with the game window sitting right there.
    const child = scriptedChild({});
    const {detector, host} = loopWith(child);
    detector.start();
    await sleep(60);
    assert.strictEqual(detector.windowSeen, true);

    for (const reply of [
        {type: 'grab', aborted: true, reason: 'timeout', window: null, gate: false},
        {type: 'grab', fatal: true, error: 'capture: the window went away', gate: false}
    ]) {
        const armed = [];
        detector.schedule = (delay) => armed.push(delay);
        host.grab = async () => reply;
        await detector.tick();
        assert.deepStrictEqual(armed, [700],
            `the loop dropped to the idle cadence after ${reply.aborted ? 'an aborted' : 'a failed'} tick`);
    }

    // …but a tick that has never seen the window still waits the idle 2 s:
    // having the switch on with the game closed has to stay free.
    detector.windowSeen = null;
    const armed = [];
    detector.schedule = (delay) => armed.push(delay);
    host.grab = async () => ({type: 'grab', aborted: true, reason: 'stopped', window: null, gate: false});
    await detector.tick();
    assert.deepStrictEqual(armed, [2000]);
    detector.destroy();
});
