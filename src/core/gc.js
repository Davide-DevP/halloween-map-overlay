'use strict';

const v8 = require('node:v8');
const vm = require('node:vm');

/**
 * A V8 collection on demand, for the one place that needs it: the detector's
 * capture loop, where `node-screenshots`' native frames (7.6 MB each, no
 * dispose API) are freed only once V8 collects their small JS wrappers.
 * Measurements and what they buy: `docs/agents/memory.md`.
 *
 * The `vm` trick — `setFlagsFromString`, `runInNewContext`, flag straight back
 * off — rather than `appendSwitch('js-flags', '--expose-gc')`, which would give
 * **every** process a global `gc`. A runtime that refuses yields a no-op.
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
                    /* a collection that throws must never break a tick */
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
            /* the flag is V8's, not ours */
        }
    }
}

/** Built on **first use**, never at require time: an embedder may freeze V8's
 * flags, and a frozen flag makes `setFlagsFromString` a V8 FATAL rather than a
 * catchable exception — which at module load would abort startup for every
 * user, including the majority with detection switched off. */
let shared = null;

function ensure() {
    if (!shared) shared = makeCollector();
    return shared;
}

module.exports = {
    /** Run one full V8 collection. Safe to call from anywhere; never throws. */
    collect: () => ensure().collect(),
    /** False when `collect()` is the no-op. **Calling it builds the collector**,
     * so it doubles as the probe `system.txt` prints: the only record of
     * whether the trick works inside Electron at all. */
    isAvailable: () => ensure().available,
    /** Has anything built it yet? For a test that cares about the laziness. */
    isBuilt: () => shared !== null,
    // Exported for the tests, which build a second, independent collector.
    makeCollector
};
