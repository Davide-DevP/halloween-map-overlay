const {test, after} = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {EventEmitter} = require('events');
const sharp = require('sharp');


// The code under test un-refs its timers (they must never keep the *app* alive),
// so a test awaiting one of them leaves the event loop empty. Node 24 waits for
// the test's promise anyway; Node 22 — what the release workflow runs — cancels
// the test ('Promise resolution is still pending but the event loop has already
// resolved'). One ref'd timer for the life of the file makes both behave alike.
const keepAlive = setInterval(() => {}, 1000);
after(() => clearInterval(keepAlive));

const M = require('../src/core/map-detector/matcher');
const FrameSource = require('../src/core/map-detector/frame-source');
const {createWorker} = require('../src/core/map-detector/worker');
const DetectorWorkerHost = require('../src/core/map-detector/worker-host');
const R = require('../src/shared/detector-worker-rules');
const TEMPLATE_FILE = require('../src/core/map-detector/templates.json');
const {FIXTURES, listFixtures} = require('../scripts/prepare-detector');

/*
 * The detector's capture, gate, grayscale and match moved into an Electron
 * `utilityProcess`, so that the main thread never blocks on a frame. Electron
 * cannot be launched from a test, so the seam is the transport: the host takes
 * an injected `fork`, and the tests below run the **real worker module** — the
 * same file the utility process runs — through a fake port pair. What is
 * exercised is therefore the real handler, the real frame source and the real
 * matcher; only `utilityProcess.fork` itself is stood in for.
 *
 * The privacy rule this move is worth the most for is also asserted here: the
 * frame never leaves the process that captured it, so **no reply may carry a
 * Buffer, a TypedArray or an ArrayBuffer**.
 */

const SIZE = TEMPLATE_FILE.size;
const TEMPLATE_PAYLOAD = {
    templates: TEMPLATE_FILE.templates,
    menu: TEMPLATE_FILE.menu,
    size: SIZE
};

/** A fixture as the fake `node-screenshots` window will hand it over. */
async function fixtureFrame(file, size) {
    let image = sharp(path.join(FIXTURES, file));
    if (size) image = image.resize(size[0], size[1], {fit: 'fill'});
    const {data, info} = await image.ensureAlpha().raw().toBuffer({resolveWithObject: true});
    return {raw: data, width: info.width, height: info.height};
}

/** A `Window.all()` stand-in holding one window that looks like the game. */
function fakeWindows(frame, over) {
    const o = over || {};
    if (o.none) return () => [];
    return () => [{
        appName: () => 'Halloween',
        title: () => 'Halloween: The Game',
        isMinimized: () => !!o.minimized,
        x: () => 0,
        y: () => 0,
        width: () => frame.width,
        height: () => frame.height,
        pid: () => o.pid || 1234,
        captureImage: () => {
            if (o.captureThrows) return Promise.reject(new Error('capture failed'));
            return Promise.resolve({
                width: o.emptyCapture ? 0 : frame.width,
                height: o.emptyCapture ? 0 : frame.height,
                toRaw: () => Promise.resolve(frame.raw)
            });
        }
    }];
}

/**
 * The fake transport: two emitters wired to each other, with the **real**
 * worker handler on the far side. `postMessage` on the host reaches the
 * worker's `handle`, and its reply comes back as a `message` event — the same
 * shape `utilityProcess` delivers (`{data}`).
 */
function fakePort(source) {
    const worker = createWorker({source});
    const child = new EventEmitter();
    child.postMessage = (message) => {
        // Asynchronous, like the real thing: a reply must never arrive before
        // the caller has finished sending.
        Promise.resolve(worker.handle(message)).then((reply) => {
            if (reply) child.emit('message', {data: reply});
        });
    };
    child.kill = () => child.emit('exit', 0);
    child.worker = worker;
    return child;
}

/** A host wired to the fake transport, with the real worker behind it. */
function hostWith(source, opts) {
    const o = opts || {};
    let child = null;
    const host = new DetectorWorkerHost({
        fork: () => {
            child = o.forkThrows ? (() => { throw new Error('fork refused'); })() : fakePort(source);
            return child;
        },
        timeoutMs: o.timeoutMs || 200
    });
    host.setTemplates(TEMPLATE_PAYLOAD);
    return {host, child: () => child};
}

/* ────────────────────────────────────────────────────────────────────────────
 * The pure rules
 * ──────────────────────────────────────────────────────────────────────────── */

test('the mode is worker, or in-process with a reason — never a guess', () => {
    assert.deepStrictEqual(R.resolveDetectorMode({started: true, failed: null, supported: true}),
        {mode: 'worker', reason: 'worker'});
    assert.deepStrictEqual(R.resolveDetectorMode({started: false, failed: null, supported: true}),
        {mode: 'in-process', reason: 'not-started'});
    assert.deepStrictEqual(R.resolveDetectorMode({started: false, failed: null, supported: false}),
        {mode: 'in-process', reason: 'unsupported'});
    for (const failed of ['fork: refused', 'crashed', 'unsupported']) {
        assert.deepStrictEqual(R.resolveDetectorMode({started: true, failed, supported: true}),
            {mode: 'in-process', reason: failed});
    }
    assert.strictEqual(R.resolveDetectorMode(null).mode, 'in-process');
});

test('restarts back off and then stop', () => {
    assert.strictEqual(R.restartDelay(0), R.RESTART_DELAYS[0]);
    for (let i = 0; i < R.RESTART_DELAYS.length; i++) {
        assert.strictEqual(R.restartDelay(i), R.RESTART_DELAYS[i]);
    }
    // A child that crashes on the first capture crashes on the next one too,
    // so the loop is bounded and the in-process path takes over.
    assert.strictEqual(R.restartDelay(R.MAX_RESTARTS), null);
    assert.strictEqual(R.restartDelay(99), null);
    // Growing, never shrinking.
    for (let i = 1; i < R.RESTART_DELAYS.length; i++) {
        assert.ok(R.RESTART_DELAYS[i] > R.RESTART_DELAYS[i - 1]);
    }
});

test('a stale reply is not the answer to the current question', () => {
    assert.strictEqual(R.isCurrentReply(7, 7), true);
    assert.strictEqual(R.isCurrentReply(6, 7), false);
    for (const bad of [undefined, null, '7', NaN]) {
        assert.strictEqual(R.isCurrentReply(bad, 7), false, String(bad));
    }
});

test('carriesPixels finds a buffer wherever it is hiding', () => {
    assert.strictEqual(R.carriesPixels({a: 1, b: 'two', c: [3, {d: false}]}), false);
    assert.strictEqual(R.carriesPixels(null), false);
    assert.strictEqual(R.carriesPixels(Buffer.alloc(4)), true);
    assert.strictEqual(R.carriesPixels(new Float32Array(4)), true);
    assert.strictEqual(R.carriesPixels(new ArrayBuffer(4)), true);
    assert.strictEqual(R.carriesPixels({a: {b: {c: [new Uint8Array(1)]}}}), true);
    // Plain number arrays are fine — that is how templates travel IN.
    assert.strictEqual(R.carriesPixels({templates: {k: [[0.1, 0.2]]}}), false);
});

/* ────────────────────────────────────────────────────────────────────────────
 * The real worker, through the fake port
 * ──────────────────────────────────────────────────────────────────────────── */

test('the worker answers with decisions, and the fixtures agree with in-process', async () => {
    for (const file of ['tab-fullscreen-haddonfield-heights.png', 'gameplay-killer.png', 'menu-main.png']) {
        const frame = await fixtureFrame(file, null);
        const source = new FrameSource({windows: fakeWindows(frame), ownPid: 999});
        source.setTemplates(TEMPLATE_PAYLOAD);
        const {host} = hostWith(source);
        const viaWorker = await host.grab({menu: true});

        // The same frame source run directly — which is exactly what the
        // in-process fallback does.
        const direct = new FrameSource({windows: fakeWindows(frame), ownPid: 999});
        direct.setTemplates(TEMPLATE_PAYLOAD);
        const inProcess = await direct.grab({menu: true});

        assert.strictEqual(viaWorker.gate, inProcess.gate, `${file}: gate`);
        assert.deepStrictEqual(viaWorker.match, inProcess.match, `${file}: match`);
        assert.deepStrictEqual(viaWorker.menu, inProcess.menu, `${file}: menu`);
        assert.strictEqual(viaWorker.window.present, true, `${file}: window`);
        host.destroy();
    }
});

test('the worker reproduces the matcher exactly, fixture by fixture', async () => {
    // The phase-1 equality test, but through the transport: the scores that
    // reach main must be the ones `matchMap` produced.
    const prepared = M.prepareTemplates(TEMPLATE_FILE.templates, SIZE);
    for (const file of listFixtures()) {
        const frame = await fixtureFrame(file, null);
        const source = new FrameSource({windows: fakeWindows(frame), ownPid: 999});
        source.setTemplates(TEMPLATE_PAYLOAD);
        const {host} = hostWith(source);
        const reply = await host.grab({menu: true});

        const outW = 640;
        const outH = Math.max(1, Math.round(640 * frame.height / frame.width));
        const gray = M.toGrayScaled(frame.raw, frame.width, frame.height, outW, outH, 'rgba');
        assert.strictEqual(reply.gate, M.TAB_SCREEN_GATE(gray, outW, outH), `${file}: gate`);
        if (reply.gate) {
            const expected = M.matchMap(gray, outW, outH, prepared, {size: SIZE, report: true, gate: false});
            assert.strictEqual(reply.match.key, expected.key, `${file}: key`);
            assert.strictEqual(reply.match.score, expected.score, `${file}: score`);
            assert.strictEqual(reply.match.margin, expected.margin, `${file}: margin`);
            assert.strictEqual(reply.match.acceptedBy, expected.acceptedBy, `${file}: acceptedBy`);
            assert.strictEqual(reply.match.panelMean, expected.panelMean, `${file}: panelMean`);
        }
        host.destroy();
    }
});

test('NO reply ever carries pixels', async () => {
    // The whole point of the move, asserted rather than trusted. Every fixture,
    // every want, every reply.
    for (const file of listFixtures()) {
        const frame = await fixtureFrame(file, null);
        const source = new FrameSource({windows: fakeWindows(frame), ownPid: 999});
        source.setTemplates(TEMPLATE_PAYLOAD);
        const worker = createWorker({source});
        for (const want of [{menu: true}, {menu: false}, {match: false}]) {
            const reply = await worker.handle({id: 1, type: 'grab', want});
            assert.strictEqual(R.carriesPixels(reply), false,
                `${file} ${JSON.stringify(want)}: a reply carried pixels`);
            // …and it is not empty either: a reply with nothing in it would
            // pass the test above for the wrong reason.
            assert.ok(reply.window, `${file}: no window in the reply`);
            assert.ok(reply.timings, `${file}: no timings in the reply`);
        }
    }
});

test('a gate-only grab does no matching at all', async () => {
    const frame = await fixtureFrame('tab-fullscreen-haddonfield-heights.png', null);
    const source = new FrameSource({windows: fakeWindows(frame), ownPid: 999});
    source.setTemplates(TEMPLATE_PAYLOAD);
    const reply = await source.grab({match: false});
    assert.strictEqual(reply.gate, true, 'the gate still runs');
    assert.strictEqual(reply.match, null, 'a gate-only grab matched anyway');
    assert.strictEqual(reply.menu, null);
});

test('no game window is an answer, not an error', async () => {
    const source = new FrameSource({windows: fakeWindows(null, {none: true}), ownPid: 999});
    source.setTemplates(TEMPLATE_PAYLOAD);
    const {host} = hostWith(source);
    const reply = await host.grab({menu: true});
    assert.strictEqual(reply.window.present, false);
    assert.strictEqual(reply.gate, false);
    assert.strictEqual(reply.match, null);
    assert.ok(reply.timings.total >= 0);
    host.destroy();
});

test('a capture that fails is reported, not thrown', async () => {
    const frame = await fixtureFrame('gameplay-killer.png', null);
    for (const over of [{captureThrows: true}, {emptyCapture: true}]) {
        const source = new FrameSource({windows: fakeWindows(frame, over), ownPid: 999});
        source.setTemplates(TEMPLATE_PAYLOAD);
        const {host} = hostWith(source);
        const reply = await host.grab({});
        assert.ok(reply.error, JSON.stringify(over));
        assert.strictEqual(reply.window.present, true);
        assert.strictEqual(R.carriesPixels(reply), false);
        host.destroy();
    }
});

/* ────────────────────────────────────────────────────────────────────────────
 * The host's lifecycle
 * ──────────────────────────────────────────────────────────────────────────── */

test('a fork that throws falls back to in-process, once', async () => {
    const frame = await fixtureFrame('tab-fullscreen-haddonfield-heights.png', null);
    const host = new DetectorWorkerHost({
        fork: () => { throw new Error('utilityProcess refused'); },
        timeoutMs: 100
    });
    host.setTemplates(TEMPLATE_PAYLOAD);
    // The in-process source it falls back to still needs a window to look at.
    host.local = new FrameSource({windows: fakeWindows(frame), ownPid: 999});
    host.local.setTemplates(TEMPLATE_PAYLOAD);

    const reply = await host.grab({});
    assert.strictEqual(reply.window.present, true, 'the fallback produced nothing');
    assert.strictEqual(reply.gate, true);
    const info = host.modeInfo();
    assert.strictEqual(info.mode, 'in-process');
    assert.match(info.reason, /fork/);
    host.destroy();
});

test('a worker that never answers times out — with no capture in main', async () => {
    const frame = await fixtureFrame('tab-fullscreen-haddonfield-heights.png', null);
    const silent = new EventEmitter();
    silent.postMessage = () => {};           // swallows everything
    silent.kill = () => silent.emit('exit', 0);
    const host = new DetectorWorkerHost({
        fork: () => silent, timeoutMs: 40, startTimeoutMs: 60
    });
    host.setTemplates(TEMPLATE_PAYLOAD);
    let localGrabs = 0;
    host.local = {
        setTemplates() {},
        grab: async () => { localGrabs++; return {window: {present: true}, gate: false}; }
    };

    const started = Date.now();
    const reply = await host.grab({});
    // The scheduler gets an answer — "no frame this tick" — and quickly.
    assert.ok(Date.now() - started < 2000, 'the request did not time out');
    assert.strictEqual(reply.aborted, true);
    assert.strictEqual(reply.reason, 'timeout');
    // …and it is an answer about the *request*, not about the game window: a
    // timeout must not look like "the game is not running".
    assert.strictEqual(reply.window, null);
    // A timed-out request never becomes a main-process capture. That is the
    // difference between the declared in-process mode (which `system.txt`
    // reports) and quietly loading the capture module into main.
    assert.strictEqual(localGrabs, 0, 'main captured a frame behind the mode');
    host.destroy();
});

test('the first request after a fork is given the cold start, not the tick budget', async () => {
    // A child has to boot a runtime and load a native module before it can
    // answer anything. Charging that to the ordinary per-request timeout kills
    // healthy workers on a loaded machine, three times, and then abandons them.
    const slow = new EventEmitter();
    let answered = 0;
    slow.postMessage = (message) => {
        if (message.type !== 'grab') return;     // no ping answer: still cold
        setTimeout(() => {
            answered++;
            slow.emit('message', {data: {id: message.id, type: 'grab', window: {present: false}, gate: false}});
        }, 120);
    };
    slow.kill = () => slow.emit('exit', 0);
    const host = new DetectorWorkerHost({fork: () => slow, timeoutMs: 30, startTimeoutMs: 400});
    const reply = await host.grab({});
    assert.strictEqual(answered, 1);
    assert.strictEqual(reply.aborted, undefined, 'a cold start was treated as a wedged child');
    assert.strictEqual(host.restarts, 0);
    assert.strictEqual(host.timeouts, 0);
    host.destroy();
});

test('a stale reply is ignored', async () => {
    const frame = await fixtureFrame('gameplay-killer.png', null);
    const source = new FrameSource({windows: fakeWindows(frame), ownPid: 999});
    source.setTemplates(TEMPLATE_PAYLOAD);
    const child = fakePort(source);
    const host = new DetectorWorkerHost({fork: () => child, timeoutMs: 200});
    host.setTemplates(TEMPLATE_PAYLOAD);
    host.start();
    // An answer to a question nobody asked — a request that timed out and then
    // arrived, or one from before a restart.
    child.emit('message', {data: {id: 9999, type: 'grab', gate: true}});
    const reply = await host.grab({});
    assert.strictEqual(reply.gate, false, 'a stale reply was taken as the answer');
    host.destroy();
});

test('templates are re-sent to a restarted worker', async () => {
    const frame = await fixtureFrame('tab-fullscreen-haddonfield-heights.png', null);
    let forks = 0;
    const sources = [];
    const host = new DetectorWorkerHost({
        fork: () => {
            forks++;
            const source = new FrameSource({windows: fakeWindows(frame), ownPid: 999});
            sources.push(source);
            return fakePort(source);
        },
        timeoutMs: 200
    });
    host.setTemplates(TEMPLATE_PAYLOAD);
    await host.grab({});
    assert.strictEqual(forks, 1);
    // The first worker had its templates: it produced a match.
    assert.ok(Object.keys(sources[0].templates).length > 0, 'the worker was never seeded');
    host.destroy();
});

test('destroy() stops the worker and never starts another', async () => {
    const frame = await fixtureFrame('gameplay-killer.png', null);
    let forks = 0;
    const host = new DetectorWorkerHost({
        fork: () => {
            forks++;
            const source = new FrameSource({windows: fakeWindows(frame), ownPid: 999});
            source.setTemplates(TEMPLATE_PAYLOAD);
            return fakePort(source);
        },
        timeoutMs: 200
    });
    host.setTemplates(TEMPLATE_PAYLOAD);
    await host.grab({});
    assert.strictEqual(forks, 1);
    host.destroy();
    // A late request after quit must not build a second process while the
    // installer is taking over.
    host.local = new FrameSource({windows: fakeWindows(frame, {none: true}), ownPid: 999});
    await host.grab({});
    assert.strictEqual(forks, 1, 'a worker was started after destroy()');
});

test('the worker module really runs as a forked child and answers', async (t) => {
    /*
     * The one thing the fake port cannot check: that `worker.js` loads and
     * connects **as a child process**, from its real path, and that the reply
     * comes back over a message channel.
     *
     * `child_process.fork` is the stand-in for `utilityProcess.fork`, and the
     * difference between them is confined to the ten-line `connect()` adapter
     * at the bottom of `worker.js`: `process.parentPort.on('message', {data})`
     * + `postMessage` for Electron, `process.on('message', data)` +
     * `process.send` for Node. Everything above that line — the handler, the
     * frame source, the matcher — is the same code on both. What this proves is
     * the module graph (including `node-screenshots` being loadable from a
     * child) and the request/reply shape; what it cannot prove is
     * `utilityProcess` itself, which needs Electron.
     *
     * The child finds no window called "Halloween", so the honest answer is
     * `present: false` — which is exactly the reply shape main has to handle.
     */
    const {fork} = require('child_process');
    const workerPath = path.join(__dirname, '..', 'src', 'core', 'map-detector', 'worker.js');
    const child = fork(workerPath, [], {stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
    const replies = [];
    const done = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('the forked worker never answered')), 20000);
        child.on('message', (message) => {
            replies.push(message);
            if (message.type === 'grab') {
                clearTimeout(timer);
                resolve();
            }
        });
        child.on('error', (err) => { clearTimeout(timer); reject(err); });
        child.on('exit', (code) => {
            if (!replies.some(r => r.type === 'grab')) {
                clearTimeout(timer);
                reject(new Error('the forked worker exited early, code ' + code));
            }
        });
    });
    child.send({id: 1, type: 'templates', ...TEMPLATE_PAYLOAD});
    child.send({id: 2, type: 'grab', want: {menu: true}});
    try {
        await done;
    } finally {
        child.kill();
    }

    const templates = replies.find(r => r.type === 'templates');
    assert.ok(templates && templates.ok, 'the child did not accept the templates');
    assert.ok(templates.keys > 0, 'the child loaded no templates');
    const grab = replies.find(r => r.type === 'grab');
    assert.strictEqual(grab.id, 2, 'the reply did not carry its request id');
    assert.ok(grab.window, 'no window in the reply');
    assert.ok(grab.timings, 'no timings in the reply');
    // And the rule, across a real process boundary this time.
    assert.strictEqual(R.carriesPixels(grab), false, 'a real child sent pixels back');
});

test('a worker that keeps failing is abandoned for the in-process path', async () => {
    // The failure that cannot be seen from main: `node-screenshots` not
    // loading inside the child. Every grab would fail forever while the
    // in-process path worked perfectly, so a run of errors gives the worker up.
    const frame = await fixtureFrame('tab-fullscreen-haddonfield-heights.png', null);
    const broken = new FrameSource({
        windows: () => { throw new Error('Cannot find module node-screenshots'); },
        ownPid: 999
    });
    broken.setTemplates(TEMPLATE_PAYLOAD);
    const host = new DetectorWorkerHost({fork: () => fakePort(broken), timeoutMs: 200});
    host.setTemplates(TEMPLATE_PAYLOAD);
    host.local = new FrameSource({windows: fakeWindows(frame), ownPid: 999});
    host.local.setTemplates(TEMPLATE_PAYLOAD);

    let last = null;
    for (let i = 0; i < 4; i++) last = await host.grab({});
    const info = host.modeInfo();
    assert.strictEqual(info.mode, 'in-process', 'the broken worker was kept');
    assert.match(info.reason, /errors/);
    // …and the last grab came from the in-process path, which works.
    assert.strictEqual(last.window.present, true);
    assert.strictEqual(last.gate, true);
    host.destroy();
});

test('status says which implementation is in use', async () => {
    const frame = await fixtureFrame('gameplay-killer.png', null);
    const source = new FrameSource({windows: fakeWindows(frame), ownPid: 999});
    source.setTemplates(TEMPLATE_PAYLOAD);
    const {host} = hostWith(source);
    await host.grab({});
    const status = host.status();
    assert.strictEqual(status.mode, 'worker');
    assert.strictEqual(status.reason, 'worker');
    assert.strictEqual(status.restarts, 0);
    assert.ok(status.timeoutMs > 0);
    host.destroy();
});

test('the worker script is where the host looks for it, and is packaged', () => {
    // Two packaging regressions this catches without launching a build:
    // the entry point moving or being renamed, and someone adding an `!src/*`
    // style exclusion that would leave `utilityProcess.fork` with no file to
    // run inside the asar. The fallback would cover it — silently, and at the
    // cost of the whole point of the move.
    const host = new DetectorWorkerHost();
    assert.ok(fs.existsSync(host.workerPath), 'worker.js is missing');
    const rel = path.relative(path.join(__dirname, '..'), host.workerPath)
        .split(path.sep).join('/');
    assert.strictEqual(rel, 'src/core/map-detector/worker.js');

    const pkg = require('../package.json');
    const files = (pkg.build && pkg.build.files) || [];
    for (const pattern of files) {
        assert.ok(
            !/^!src(\/|$)/.test(pattern),
            'package.json build.files excludes src: ' + pattern
        );
    }
    // The capture module the worker loads is native, so its binaries must stay
    // outside the asar whichever process requires them.
    const unpack = (pkg.build && pkg.build.asarUnpack) || [];
    assert.ok(
        unpack.some((p) => p.includes('node-screenshots')),
        'node-screenshots binaries are no longer asarUnpacked'
    );
});

/* ────────────────────────────────────────────────────────────────────────────
 * Concurrency, lifecycle, and the defects an independent review reproduced
 *
 * Every test below stands for a fault that was found by *driving* the real
 * host rather than by reading it — 997 tests passed while all of them were
 * live, so each one is here as a permanent witness.
 * ──────────────────────────────────────────────────────────────────────────── */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A child that answers after `delayMs`, tagging its replies so a test can tell
 * *which* request an answer belongs to.
 */
function scriptedChild(delayMs, opts) {
    const o = opts || {};
    const child = new EventEmitter();
    child.killed = false;
    child.sent = [];
    child.postMessage = (message) => {
        child.sent.push(message);
        if (message.type === 'ping' && !o.silentPing) {
            child.emit('message', {data: {id: message.id, type: 'ping', ok: true, gc: o.gc || 'available'}});
            return;
        }
        if (message.type !== 'grab') return;
        if (o.silent) return;
        setTimeout(() => {
            if (child.killed) return;
            child.emit('message', {
                data: {
                    id: message.id, type: 'grab', tag: message.want && message.want.tag,
                    window: {
                        present: true, pid: 7, rect: {x: 0, y: 0, width: 800, height: 600},
                        captured: {width: 800, height: 600}
                    },
                    gate: false, match: null, menu: null, timings: {total: 1}
                }
            });
        }, delayMs);
    };
    child.kill = () => {
        child.killed = true;
        if (o.exitDelay != null) setTimeout(() => child.emit('exit', 1), o.exitDelay);
    };
    return child;
}

/** A host whose in-process fallback is a counter rather than a real capture. */
function countingLocal(host) {
    const calls = [];
    host.local = {
        setTemplates() {},
        grab: async (want) => { calls.push(want); return {tag: 'LOCAL', window: {present: false}}; }
    };
    return calls;
}

test('two overlapping grabs both get answered, in both orders', async () => {
    // The critical one. `pending` used to be a single slot: a second request
    // overwrote it, the first reply was dropped as stale, and the first
    // request's own timeout returned without resolving anything. That promise
    // never settled, the caller's `busy` flag stayed true with it, and
    // auto-detect was dead until the app was restarted — with nothing in any
    // log. The detector tick and Tab mode each guard only themselves, so at
    // 450 ms and 150 ms they overlap within seconds.
    for (const order of [['tick', 'tab'], ['tab', 'tick']]) {
        const host = new DetectorWorkerHost({fork: () => scriptedChild(20), timeoutMs: 500});
        countingLocal(host);
        const first = host.grab({tag: order[0]});
        const second = host.grab({tag: order[1]});
        const settled = await Promise.race([
            Promise.all([first, second]),
            sleep(1500).then(() => 'HUNG')
        ]);
        assert.notStrictEqual(settled, 'HUNG', `a promise never settled (${order.join(' then ')})`);
        // Each caller got the answer to its **own** question.
        assert.strictEqual(settled[0].tag, order[0]);
        assert.strictEqual(settled[1].tag, order[1]);
        assert.strictEqual(host.restarts, 0, 'an overlap was treated as a fault');
        host.destroy();
    }
});

test('requests are served one at a time, in order', async () => {
    const child = scriptedChild(15);
    const host = new DetectorWorkerHost({fork: () => child, timeoutMs: 500});
    const replies = await Promise.all([
        host.grab({tag: 'a'}), host.grab({tag: 'b'}), host.grab({tag: 'c'})
    ]);
    assert.deepStrictEqual(replies.map(r => r.tag), ['a', 'b', 'c']);
    // One capture in flight at a time: two frames in the worker at once is two
    // 8 MB buffers and twice the CPU for no more information.
    const grabs = child.sent.filter(m => m.type === 'grab');
    assert.strictEqual(grabs.length, 3);
    assert.ok(grabs.every((m, i) => i === 0 || m.id > grabs[i - 1].id));
    host.destroy();
});

test('a request waiting behind a timeout is answered too', async () => {
    const host = new DetectorWorkerHost({
        fork: () => scriptedChild(0, {silent: true}), timeoutMs: 40, startTimeoutMs: 60
    });
    countingLocal(host);
    const first = host.grab({tag: 'a'});
    const second = host.grab({tag: 'b'});
    const settled = await Promise.race([
        Promise.all([first, second]), sleep(1500).then(() => 'HUNG')
    ]);
    assert.notStrictEqual(settled, 'HUNG', 'a queued request was forgotten');
    assert.strictEqual(settled[0].aborted, true);
    assert.strictEqual(settled[1].aborted, true);
    host.destroy();
});

test('a deliberate stop is not a crash', async () => {
    // A plain stop used to go through `killChild` → `onExit` → "the worker
    // died": a warning in app.log, a restart counted, and a **new child forked
    // 250 ms after the user switched detection off**, alive for the rest of the
    // session. Three toggles and the host declared itself permanently crashed,
    // so `system.txt` reported a crash that never happened.
    const forks = [];
    const host = new DetectorWorkerHost({
        fork: () => { const c = scriptedChild(5); forks.push(c); return c; }, timeoutMs: 200
    });
    for (let i = 0; i < 4; i++) {
        host.start();
        await host.grab({});
        host.stop();
        assert.strictEqual(host.child, null);
        assert.strictEqual(host.restartTimer, null, 'a stop armed a restart');
        assert.strictEqual(host.restarts, 0, 'a stop counted as a crash');
        assert.strictEqual(host.failed, null);
        await sleep(300);                       // longer than the first backoff
        assert.strictEqual(host.child, null, 'a child came back after a stop');
        assert.strictEqual(forks.length, i + 1, 'a stop re-forked the worker');
    }
    assert.deepStrictEqual(host.modeInfo(), {mode: 'in-process', reason: 'stopped'});
    host.destroy();
});

test('nothing is captured in main after a stop or a destroy', async () => {
    // `stop()` used to resolve the in-flight request with null, and `grab()`
    // then fell through to the in-process path: one more capture after the user
    // switched detection off, and at quit or update `node-screenshots` loaded
    // into main — the exact thing the shutdown hook exists to prevent.
    for (const finish of ['stop', 'destroy']) {
        const host = new DetectorWorkerHost({fork: () => scriptedChild(20), timeoutMs: 500});
        const local = countingLocal(host);
        const inflight = host.grab({});
        host[finish]();
        const reply = await inflight;
        assert.strictEqual(reply.aborted, true, finish);
        const after = await host.grab({});
        assert.strictEqual(after.aborted, true, finish);
        assert.strictEqual(local.length, 0, `main captured a frame after ${finish}()`);
        host.destroy();
    }
});

test('a late exit from a replaced child is ignored', async () => {
    // A process wedged in a native call dies *slowly*: its real `exit` arrives
    // long after the kill, by which time the restart has happened. Unbound,
    // that event nulled the **new** child without killing it — one more fork,
    // one more restart counted, and a live process nobody owned.
    const kids = [];
    let n = 0;
    const host = new DetectorWorkerHost({
        fork: () => {
            n++;
            const child = n === 1
                ? scriptedChild(0, {silent: true, silentPing: true, exitDelay: 300})
                : scriptedChild(5);
            kids.push(child);
            return child;
        },
        timeoutMs: 40, startTimeoutMs: 60
    });
    countingLocal(host);
    const first = await host.grab({});
    assert.strictEqual(first.aborted, true);
    assert.strictEqual(host.restarts, 1);
    await sleep(320);                                  // the 250 ms restart fires
    assert.strictEqual(host.child, kids[1], 'the worker did not come back');
    await sleep(200);                                  // the first child's real exit
    assert.strictEqual(host.child, kids[1], 'a dead child took the live one with it');
    assert.strictEqual(host.restarts, 1, 'a late exit was counted as a crash');
    assert.strictEqual(kids[1].killed, false);
    assert.strictEqual(kids.length, 2, 'an extra worker was forked');
    host.destroy();
});

test('the restart backoff is not pre-empted by the next tick', async () => {
    const forks = [];
    const host = new DetectorWorkerHost({
        fork: () => { const c = scriptedChild(5); forks.push(c); return c; }, timeoutMs: 200
    });
    const local = countingLocal(host);
    host.start();
    host.restarts = 2;                                 // next delay: 4000 ms
    forks[0].emit('exit', 1);
    assert.ok(host.restartTimer, 'no restart was armed');
    // The next tick arrives 50 ms later and must not re-fork: waiting out the
    // backoff is the whole point of having one.
    await sleep(50);
    const reply = await host.grab({});
    assert.strictEqual(forks.length, 1, 'the backoff was bypassed');
    assert.strictEqual(reply.tag, 'LOCAL', 'the tick was not served meanwhile');
    assert.strictEqual(local.length, 1);
    // …and it says so, rather than reporting a worker that was never started.
    assert.deepStrictEqual(host.modeInfo(), {mode: 'in-process', reason: 'restarting'});
    host.destroy();
});

test('a failing capture is not a failing worker', async () => {
    // An alt-tab or a display-mode change fails captures for a second or two.
    // Counting those towards the fallback abandoned the worker for the rest of
    // the session, although the in-process path would have failed identically.
    const child = new EventEmitter();
    child.postMessage = (m) => {
        if (m.type !== 'grab') return;
        child.emit('message', {data: {
            id: m.id, type: 'grab', error: 'capture: window is gone',
            window: {present: true, pid: 3, rect: null}, gate: false
        }});
    };
    child.kill = () => child.emit('exit', 0);
    const host = new DetectorWorkerHost({fork: () => child, timeoutMs: 200});
    const local = countingLocal(host);
    for (let i = 0; i < 6; i++) {
        const reply = await host.grab({});
        assert.ok(reply.error, 'the capture error was swallowed');
    }
    assert.strictEqual(host.failed, null, 'failed captures abandoned the worker');
    assert.strictEqual(local.length, 0);
    host.destroy();
});

test('a worker whose handler keeps throwing is abandoned', async () => {
    // The one failure that cannot be seen from here: `node-screenshots` not
    // loading inside the child. The worker tags that kind `fatal`.
    const child = new EventEmitter();
    child.postMessage = (m) => {
        if (m.type !== 'grab') return;
        child.emit('message', {data: {
            id: m.id, type: 'grab', fatal: true, error: 'Cannot find module node-screenshots'
        }});
    };
    child.killed = false;
    child.kill = () => { child.killed = true; child.emit('exit', 0); };
    const host = new DetectorWorkerHost({fork: () => child, timeoutMs: 200});
    const local = countingLocal(host);
    let last = null;
    for (let i = 0; i < 3; i++) last = await host.grab({});
    assert.strictEqual(last.tag, 'LOCAL', 'the in-process path never took over');
    assert.strictEqual(host.modeInfo().mode, 'in-process');
    assert.match(host.modeInfo().reason, /errors/);
    assert.strictEqual(local.length, 1);
    // A worker that is written off still has to be stopped, or it goes on
    // running with the native capture module loaded — and it must not be
    // restarted afterwards either.
    assert.strictEqual(child.killed, true, 'the abandoned worker was left running');
    assert.strictEqual(host.restartTimer, null, 'a give-up armed a restart');
    assert.strictEqual(host.restarts, 0);
    host.destroy();
});

test('a give-up says which of the two it was', async () => {
    const host = new DetectorWorkerHost({
        fork: () => scriptedChild(0, {silent: true, silentPing: true}),
        timeoutMs: 20, startTimeoutMs: 30
    });
    countingLocal(host);
    host.restarts = R.MAX_RESTARTS;            // the next death is the last one
    const reply = await host.grab({});
    assert.strictEqual(reply.aborted, true);
    assert.strictEqual(host.modeInfo().reason, 'timeouts',
        'a child that would not answer was reported as a crash');
    host.destroy();
});

test('a worker that has been healthy for a minute is forgiven its restarts', () => {
    // `restarts` used to be a session-long tally, so four unlucky moments hours
    // apart added up to "this worker keeps crashing".
    assert.strictEqual(R.shouldResetRestarts(R.HEALTHY_RESET_MS - 1, 2), false);
    assert.strictEqual(R.shouldResetRestarts(R.HEALTHY_RESET_MS, 2), true);
    assert.strictEqual(R.shouldResetRestarts(9e9, 0), false, 'nothing to forgive');
    const host = new DetectorWorkerHost({fork: () => scriptedChild(1), timeoutMs: 200});
    host.restarts = 2;
    host.childStartedAt = Date.now() - R.HEALTHY_RESET_MS - 1;
    host.noteHealthy();
    assert.strictEqual(host.restarts, 0);
    host.destroy();
});

test('the fallback reason never carries the user home directory', () => {
    // `detector.log` travels inside the diagnostic report and is not run
    // through the app log's redaction, and a module-resolution failure quotes a
    // path that starts at the user's home directory.
    const host = new DetectorWorkerHost({fork: () => scriptedChild(1)});
    const home = require('os').homedir();
    host.fail('errors: Cannot find module ' + home + '\\app\\node_modules\\x.node');
    assert.ok(!host.failed.includes(home), 'the home path reached detector.log');
    assert.match(host.failed, /~/);
    host.destroy();
});

test('the worker collects its own frames, and says whether it can', async () => {
    // The move put the capture in the child and left the collector behind: the
    // child showed the 78 → 191 MB oscillation `core/gc.js` exists to remove,
    // while main went on collecting for a frame it never held.
    const {loadGc} = require('../src/core/map-detector/worker');
    const gc = loadGc();
    assert.ok(gc && typeof gc.collect === 'function', 'the worker cannot load the collector');
    const worker = createWorker({gc});
    assert.strictEqual(worker.source.gc, gc, 'the frame source was built without a collector');
    const ack = await worker.handle({id: 1, type: 'ping'});
    assert.ok(ack.gc === 'available' || ack.gc === 'noop');

    // …and main hears about it, which is what `system.txt` prints.
    const host = new DetectorWorkerHost({fork: () => scriptedChild(5, {gc: 'available'}), timeoutMs: 200});
    await host.grab({});
    assert.strictEqual(host.status().gc, 'available');
    // The in-process fallback captures the same frames and must collect them
    // too; it is given the collector main resolved.
    host.setGc(gc);
    assert.strictEqual(host.localSource().gc, gc);
    host.destroy();
});

test('a reply may not carry an array big enough to hide a frame in', () => {
    // `carriesPixels` is a regression guard on the *shape* of a reply, not a
    // proof: pixels copied into a plain number array are invisible to any type
    // check. A legitimate reply is small, so the length cap is what closes it.
    const small = new Array(R.MAX_REPLY_ARRAY).fill(0.5);
    assert.strictEqual(R.carriesPixels({scores: small}), false);
    assert.strictEqual(R.carriesPixels({scores: small.concat([0.5])}), true);
});

test('a gate-only request never waits out a cold start', async () => {
    // `match: false` is asked only while Tab-map mode's markers are drawn over
    // the game. Giving that one the start-up grace of a child that is still
    // booting is how brackets were once left on screen for 3.4 seconds: the
    // right answer for it is "no frame", quickly, so they come down.
    const host = new DetectorWorkerHost({
        fork: () => scriptedChild(0, {silent: true, silentPing: true}),
        timeoutMs: 60, startTimeoutMs: 3000
    });
    countingLocal(host);
    const started = Date.now();
    const reply = await host.grab({match: false});
    const waited = Date.now() - started;
    assert.strictEqual(reply.aborted, true);
    assert.strictEqual(reply.reason, 'timeout');
    assert.ok(waited < 1000, `the gate check waited ${waited} ms for a cold child`);
    host.destroy();
});
