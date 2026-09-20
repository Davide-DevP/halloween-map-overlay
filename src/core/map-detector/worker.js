'use strict';

/**
 * The detector's **utility process**: a message adapter around
 * `frame-source.js`, and nothing else.
 *
 * Everything that touches pixels — the window enumeration, the capture, the Tab
 * gate, the luminance reduction, the NCCs and the explicit collection of the
 * 8 MB native buffers — happens here, off the main thread. Main keeps the
 * scheduler, the state machine, the logging and every window. What crosses back
 * is **numbers, keys and booleans**: a window rectangle, a gate verdict, a map
 * key with its scores, a menu score, timings.
 *
 * That makes the project's oldest privacy rule stronger rather than weaker. It
 * used to be "the frame never leaves the tick"; it is now "the frame never
 * leaves this process", and `test/detector-worker.test.js` asserts that no
 * reply carries a Buffer, a TypedArray or an ArrayBuffer. (Templates travel the
 * other way, in, as plain number arrays — they are the app's own data, not a
 * capture.)
 *
 * ## The two transports
 *
 * Electron's `utilityProcess` gives the child a `process.parentPort`
 * (`MessagePort` semantics: `on('message', {data})`, `postMessage`). Plain
 * Node's `child_process.fork` gives it `process.on('message', data)` and
 * `process.send`. The difference is ten lines at the bottom of this file and
 * nothing above it knows which one is in use — which is what lets the same
 * module be tested under plain Node.
 */

const FrameSource = require('./frame-source');

/**
 * The request handler, transport-free.
 *
 * @param {{source?: Object}} [deps]
 * @returns {{handle: (msg: Object) => Promise<?Object>, source: Object}}
 */
function createWorker(deps) {
    const d = deps || {};
    const gc = d.gc || null;
    const source = d.source || new FrameSource({gc});
    let stopped = false;

    /** `available` / `noop` / `none`, for main to put in `system.txt`. */
    const gcState = () => {
        if (!gc) return 'none';
        try {
            return gc.isAvailable && gc.isAvailable() ? 'available' : 'noop';
        } catch (err) {
            return 'noop';
        }
    };

    async function handle(message) {
        if (!message || typeof message !== 'object') return null;
        const id = message.id;
        switch (message.type) {
            case 'templates': {
                const info = source.setTemplates(message);
                return {
                    id, type: 'templates', ok: true,
                    keys: info.keys, variants: info.variants, gc: gcState()
                };
            }
            case 'grab': {
                if (stopped) return {id, type: 'grab', error: 'stopped'};
                try {
                    const result = await source.grab(message.want || {});
                    return Object.assign({id, type: 'grab'}, result);
                } catch (err) {
                    // A worker that throws must answer anyway: main's request
                    // would otherwise sit out its whole timeout for nothing.
                    //
                    // `fatal` is the difference between "this capture failed"
                    // and "this worker cannot do captures". Only the second
                    // kind counts towards abandoning the worker: a failed
                    // capture (reported by the frame source, not thrown) is an
                    // alt-tab or a display-mode change, and running it in main
                    // instead would have failed identically.
                    return {
                        id, type: 'grab', fatal: true,
                        error: String((err && err.message) || err).slice(0, 200)
                    };
                }
            }
            case 'ping':
                return {id, type: 'ping', ok: true, gc: gcState(), pid: process.pid};
            case 'stop':
                stopped = true;
                return {id, type: 'stop', ok: true};
            default:
                return {id, type: 'error', error: 'unknown-request'};
        }
    }

    return {handle, source};
}

/**
 * Wire the handler to whichever transport this process was started with.
 *
 * `utilityProcess` first, because that is the production one; `process.send` is
 * the plain-Node fork used by the integration test. Neither is set when this
 * module is merely `require`d (a unit test, or main loading it for the
 * in-process fallback), and then nothing is connected at all.
 */
function connect(worker) {
    const reply = (message) => {
        if (message === null || message === undefined) return;
        if (process.parentPort) process.parentPort.postMessage(message);
        else if (process.send) process.send(message);
    };
    const onMessage = (data) => {
        Promise.resolve(worker.handle(data)).then(reply).catch((err) => {
            reply({
                id: data && data.id, type: 'error', fatal: true,
                error: String((err && err.message) || err).slice(0, 200)
            });
        });
    };
    if (process.parentPort) {
        process.parentPort.on('message', (event) => onMessage(event.data));
        return true;
    }
    if (typeof process.send === 'function') {
        process.on('message', onMessage);
        return true;
    }
    return false;
}

/**
 * The on-demand collector — **in the child**, which is where the frames are.
 *
 * `node-screenshots` has no dispose API, so an 8 MB native buffer waits for V8
 * to collect a small wrapper object: unprompted, that is the 78 → 191 MB
 * oscillation `docs/MEMORY-REPORT-2.md` §4 measured. Moving the capture into
 * this process moved that oscillation with it, so the collector has to come
 * too, or the move traded a stutter for a leak.
 *
 * Required here rather than at the top of the file because `core/gc.js` flips a
 * V8 flag on first use, and a runtime that refuses is a no-op collector, not a
 * crash. It is only ever loaded in a process that is about to capture frames.
 */
function loadGc() {
    try {
        return require('../gc');
    } catch (err) {
        return null;
    }
}

module.exports = {createWorker, connect, loadGc};

// Started as a child: connect immediately. `require`d by main for the
// in-process fallback: neither transport exists, so nothing happens.
if (process.parentPort || (typeof process.send === 'function' && require.main === module)) {
    connect(createWorker({gc: loadGc()}));
}
