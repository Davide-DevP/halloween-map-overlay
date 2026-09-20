'use strict';

const v8 = require('node:v8');
const vm = require('node:vm');

/**
 * A V8 collection on demand, for the **one** place that needs it: the map
 * detector's capture loop.
 *
 * Node built-ins only — no electron, no fs — so this sits in the tier the unit
 * tests can drive directly.
 *
 * ### Why this exists
 *
 * `node-screenshots` hands back an `Image` whose pixels are native memory with
 * no dispose/free/close API (`node_modules/node-screenshots/index.d.ts`): the
 * bytes are released by the NAPI finalizer once the JS wrapper is collected.
 * One 1080p frame is 7.6 MB of RGBA, and the loop captures one every 700 ms
 * while the game is up. The detector already drops its references as promptly
 * as the API allows (`image` and `raw` are locals of `tick()`), but V8 has no
 * reason to collect a handful of small wrapper objects, so the *native* buffers
 * pile up until something else forces a collection.
 *
 * Measured on this machine (plain node, 300 captures of a 1920x1032 window,
 * the exact `captureImage` → `toRaw` → `toGrayScaled` → `matchMap` pipeline):
 *
 * | after each capture | rss min | rss mean | rss max |
 * |--------------------|---------|----------|---------|
 * | nothing (0.2.2 behaviour) | 78.5 MB | 131.2 MB | **191.2 MB** |
 * | `collect()` every 4th tick | 94.5 MB | 111.0 MB | 127.7 MB |
 * | **`collect()` every tick** | 78.1 MB | **79.4 MB** | **79.9 MB** |
 *
 * i.e. it takes ~110 MB off the *peak* of the main process during a match, and
 * the mean stops oscillating altogether. The collection itself measured
 * **1.06 ms min / 1.31 ms median / 3.89 ms p95 / 6.28 ms max** — the main
 * process's own heap is only a few MB, so this is a small fraction of the
 * 6–11 ms of blocking JS a tick already costs, and nowhere near the ~30 ms
 * budget "The capture path — do not make it heavier" sets.
 *
 * ### Why the `vm` trick rather than `--expose-gc`
 *
 * `app.commandLine.appendSwitch('js-flags', '--expose-gc')` would hand a `gc()`
 * to **every** process, renderers included, and would collide with any other
 * `js-flags` value the app ever wants. `setFlagsFromString` + `runInNewContext`
 * takes the function out of one freshly created context and puts the flag back
 * immediately, so nothing outside this module can see it.
 *
 * Returns a no-op when V8 will not give the function up (a future runtime, a
 * hardened build): a detector that does not collect is 0.2.2 behaviour, which
 * is a documented oscillation rather than a fault.
 *
 * @returns {{collect: function(): void, available: boolean}} `collect` never
 *   throws and is never null; `available` is false when it is the no-op.
 */
function makeCollector() {
    const noop = {collect: () => {}, available: false};
    try {
        v8.setFlagsFromString('--expose-gc');
        const gc = vm.runInNewContext('gc');
        if (typeof gc !== 'function') return noop;
        return {
            collect: () => {
                try {
                    gc();
                } catch (err) {
                    // A collection that throws must never break a detector tick.
                }
            },
            available: true
        };
    } catch (err) {
        return noop;
    } finally {
        // Put the flag back whatever happened, so no *other* context in this
        // process ends up with a global `gc`.
        try {
            v8.setFlagsFromString('--no-expose-gc');
        } catch (err) {
            // Nothing to do: the flag is V8's, not ours.
        }
    }
}

/**
 * Built on the **first use**, not at require time.
 *
 * `v8.setFlagsFromString` is only documented as safe before the VM has
 * finished starting, and embedders are allowed to freeze V8's flags — Chromium
 * does that for some of them already. If a future Electron freezes this one,
 * `setFlagsFromString` is not an exception a `try/catch` can absorb: V8 aborts
 * the process with a FATAL. Building the collector at module load meant that
 * abort happened while `require('./map-detector')` ran, i.e. **during
 * startup, with automatic detection switched off**, and took the whole app
 * with it for a feature the user was not using. Built lazily, the blast radius
 * is the first detector tick of a user who turned the detector on — and
 * `MapDetector` requires this module lazily too, from `start()`.
 *
 * `null` until then; `ensure()` is the one place it is created.
 */
let shared = null;

function ensure() {
    if (!shared) shared = makeCollector();
    return shared;
}

module.exports = {
    /** Run one full V8 collection. Safe to call from anywhere; never throws. */
    collect: () => ensure().collect(),
    /**
     * False when this runtime would not give the collection function up, i.e.
     * `collect()` is the no-op fallback and the detector is back to the
     * oscillation `docs/MEMORY-REPORT.md` §3 measured. A test asserts it is
     * true, because falling back silently is the one failure mode here that
     * would leave 110 MB on the table with nothing to show for it.
     *
     * **This builds the collector**, so it is also the probe: the startup
     * snapshot and `system.txt` call it, which is the only record there has
     * ever been of whether the `vm` trick works inside Electron at all.
     */
    isAvailable: () => ensure().available,
    /** Has anything built it yet? For a test that cares about the laziness. */
    isBuilt: () => shared !== null,
    // Exported for the tests, which build a second, independent collector.
    makeCollector
};
