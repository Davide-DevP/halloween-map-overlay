const {test} = require('node:test');
const assert = require('node:assert');
const gc = require('../src/core/gc');

test('collect() is a function that never throws', () => {
    assert.strictEqual(typeof gc.collect, 'function');
    // Called repeatedly, exactly as a detector tick would.
    for (let i = 0; i < 3; i++) gc.collect();
});

test('a collection really is available on this runtime', () => {
    // Not merely "it did not throw": the whole point of the module is that the
    // detector's 7.6 MB native frames are released between ticks, and a silent
    // fall back to the no-op would put the 191 MB peak back with nothing to
    // show for it. If this ever fails on a future Electron, the fix is a
    // different mechanism, not a smaller assertion.
    assert.strictEqual(gc.isAvailable(), true);
});

test('the global is not left exposed', () => {
    // `makeCollector` flips `--expose-gc` on to take the function out of a
    // throw-away context and flips it straight back off. A `gc` left on the
    // real global would be a surprise for every other module in the process,
    // and for the renderers if this file were ever required there.
    assert.strictEqual(typeof globalThis.gc, 'undefined');
});

test('a second collector can be built independently', () => {
    const second = gc.makeCollector();
    assert.strictEqual(typeof second.collect, 'function');
    assert.strictEqual(second.available, true);
    second.collect();
    assert.strictEqual(typeof globalThis.gc, 'undefined');
});

/**
 * Allocate a big buffer in its **own** function frame and hand back only a
 * `WeakRef` to it.
 *
 * Both halves matter. A `let` in the test body stays reachable from the live
 * frame for as long as the test runs, whatever it is set to afterwards; and a
 * `WeakRef` created in a job keeps its target alive until that job ends, by
 * specification (`KeepDuringJob`), so the reference has to be made here and
 * the caller has to let the current job finish before asking.
 */
function allocateWeak(bytes) {
    const buffer = Buffer.allocUnsafe(bytes);
    // Touch it so nothing can optimise the allocation away entirely.
    buffer[0] = 1;
    return new WeakRef(buffer);
}

test('collecting actually reclaims an unreachable allocation', async () => {
    // The mechanism this module exists for, in miniature: drop the only
    // reference to a big buffer and check the collection reclaims it rather
    // than waiting for V8 to feel like it.
    //
    // **This asserts on reachability, not on a memory counter.**
    // `process.memoryUsage().external` was the obvious thing to measure and it
    // is racy: V8 frees ArrayBuffer backing stores on a concurrent sweeper
    // thread, so the counter can still be high the instant `collect()` returns
    // even though the collection did exactly what it was asked. It failed that
    // way once on a shared CI runner — and this suite gates the tag-triggered
    // release, so a test that fails one run in fifty is worse than no test.
    // A `WeakRef` that has been cleared is a fact, not a sample.
    const ref = allocateWeak(64 * 1024 * 1024);
    assert.notStrictEqual(ref.deref(), undefined, 'the buffer should still be alive here');
    // Let the job that created the WeakRef end, or its target is kept alive.
    await new Promise(resolve => setImmediate(resolve));
    for (let i = 0; i < 5 && ref.deref() !== undefined; i++) {
        gc.collect();
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.strictEqual(ref.deref(), undefined,
        'the buffer was still reachable after five collections');
});

test('the collector is built on first use, not at require time', () => {
    // `core/gc.js` flips a V8 flag with `setFlagsFromString`, which an embedder
    // is allowed to freeze — and a frozen flag is a V8 FATAL, not an exception.
    // Doing that at module load put it in the startup path of every user,
    // including everyone with automatic detection switched off. It is built on
    // the first `collect()`/`isAvailable()` instead, and `map-detector.js`
    // requires the module itself only from `start()`.
    //
    // The tests above have already used it, so all this can check is that the
    // hook exists and agrees with itself; the laziness that matters is
    // asserted at the call site, in the detector's source, below.
    assert.strictEqual(typeof gc.isBuilt, 'function');
    assert.strictEqual(gc.isBuilt(), true, 'the tests above should have built it');
});

test('the detector does not require the collector at module load', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'core', 'map-detector.js'), 'utf-8');
    // A top-level `const gc = require('./gc')` is exactly what this forbids.
    assert.ok(!/^const\s+gc\s*=\s*require\(/m.test(source),
        "map-detector.js requires ./gc at module load; it must be required from start()");
    assert.ok(/require\('\.\/gc'\)/.test(source), 'map-detector.js should still use the collector');
});
