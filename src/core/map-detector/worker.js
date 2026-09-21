'use strict';

/**
 * The detector's **utility process**: a message adapter around
 * `frame-source.js`, and nothing else. See `docs/agents/detection.md`.
 *
 * **The frame never leaves this process.** What crosses back is numbers, keys
 * and booleans, and `test/detector-worker.test.js` asserts no reply carries a
 * Buffer, a TypedArray or an ArrayBuffer. Templates travel the other way as
 * plain number arrays — build output, not a capture.
 *
 * Two transports, and the difference is the bottom of this file:
 * `utilityProcess` gives the child a `process.parentPort`, plain
 * `child_process.fork` gives it `process.send` — which is what lets the module
 * be tested under plain node.
 */

const FrameSource = require('./frame-source');

/** The request handler, transport-free.
 * @returns {{handle: (msg: Object) => Promise<?Object>, source: Object}} */
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
                    // Answer anyway, or main sits out its whole timeout for
                    // nothing. `fatal` means "this worker cannot do captures",
                    // not "this capture failed" — only the first counts towards
                    // abandoning the worker.
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

/** Wire the handler to whichever transport this process was started with.
 * Neither is set when the module is merely `require`d (a unit test, or main
 * loading it for the fallback), and then nothing is connected. */
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

/** The on-demand collector — **in the child**, which is where the frames are:
 * moving the capture here moved the 78 → 191 MB oscillation with it. Required
 * inside the function, never at the top, because `core/gc.js` flips a V8 flag
 * on first use. */
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
