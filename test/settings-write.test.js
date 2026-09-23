const {test} = require('node:test');
const assert = require('node:assert');

const Settings = require('../src/core/settings');

/*
 * `Settings`' constructor needs `app.getPath('userData')` and registers IPC
 * handlers, so it cannot run outside Electron — but `set()` and `merge()` are
 * ordinary logic over an in-memory object plus one call to `write()`, and the
 * rollback rule is exactly the kind of thing that has to be pinned down.
 *
 * So the object is built from the prototype with the two fields those methods
 * touch, and `write()` is replaced by a stub that says whether the disk
 * accepted it. Nothing is written anywhere.
 */
function harness(initial, writeOk) {
    const settings = Object.create(Settings.prototype);
    settings.settings = Object.assign({}, initial);
    settings.notifier = null;
    settings.lastWarnAt = 0;
    settings.writes = 0;
    settings.write = function () {
        this.writes++;
        return writeOk;
    };
    return settings;
}

test('set: a successful write keeps the new value and says so', () => {
    const s = harness({hotkeyRotateMap: 'CommandOrControl+Alt+R'}, true);
    assert.strictEqual(s.set('hotkeyRotateMap', 'Alt+K'), true);
    assert.strictEqual(s.get('hotkeyRotateMap'), 'Alt+K');
});

test('set: a failed write says so, and leaves the value in memory by default', () => {
    // The overlay's drag handler depends on this: `overlayX`/`overlayY` are
    // where the window actually *is*, the next drag tick writes again a few
    // milliseconds later, and reverting them mid-drag would make the stored
    // position chase the cursor backwards.
    const s = harness({overlayX: 100}, false);
    assert.strictEqual(s.set('overlayX', 250), false);
    assert.strictEqual(s.get('overlayX'), 250);
});

test('set with rollback: a failed write puts the previous value back', () => {
    // Without this, `save-system-hotkey` answers "could not be saved" and the
    // rejected accelerator stays in memory — so the next `loadKeys()` (an
    // alt-tab away and back is enough) registers the binding the user was just
    // told was refused, and the Hotkeys table shows it until a restart.
    const s = harness({hotkeyRotateMap: 'CommandOrControl+Alt+R'}, false);
    assert.strictEqual(s.set('hotkeyRotateMap', 'Alt+K', {rollback: true}), false);
    assert.strictEqual(s.get('hotkeyRotateMap'), 'CommandOrControl+Alt+R');
});

test('set with rollback: unbinding that fails does not leave the action dead', () => {
    const s = harness({hotkeyClearMap: 'CommandOrControl+Alt+D'}, false);
    assert.strictEqual(s.set('hotkeyClearMap', '', {rollback: true}), false);
    assert.strictEqual(s.get('hotkeyClearMap'), 'CommandOrControl+Alt+D');
});

test('set with rollback: the game-only switch cannot drift from the file', () => {
    // The UI flips the switch back on a failure; memory has to flip back too,
    // or main polls (or stops polling) for a setting the file does not hold
    // and the diagnostic report disagrees with what the user is looking at.
    const s = harness({hotkeysGameOnly: true}, false);
    assert.strictEqual(s.set('hotkeysGameOnly', false, {rollback: true}), false);
    assert.strictEqual(s.get('hotkeysGameOnly'), true);
});

test('set with rollback: a key that was not there is removed again', () => {
    // `= undefined` would read as "unset" but would still be an own property,
    // which is not the state we came from.
    const s = harness({}, false);
    assert.strictEqual(s.set('hotkeyDefaultsVersion', 1, {rollback: true}), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(s.settings, 'hotkeyDefaultsVersion'), false);
});

test('set with rollback: a successful write is unaffected', () => {
    const s = harness({hotkeysGameOnly: true}, true);
    assert.strictEqual(s.set('hotkeysGameOnly', false, {rollback: true}), true);
    assert.strictEqual(s.get('hotkeysGameOnly'), false);
});

test('merge: one write for every key, and the whole batch rolls back together', () => {
    // This is what the hotkey-defaults migration uses: up to nine accelerators
    // plus the version stamp used to be ten separate synchronous rewrites of
    // settings-app.json during startup.
    const before = {hotkeyToggleMap: 'CommandOrControl+H', hotkeyRotateMap: 'CommandOrControl+R'};
    const ok = harness(before, true);
    assert.strictEqual(ok.merge({
        hotkeyToggleMap: 'CommandOrControl+Alt+H',
        hotkeyRotateMap: 'CommandOrControl+Alt+R',
        hotkeyDefaultsVersion: 1
    }), true);
    assert.strictEqual(ok.writes, 1, 'one write, not three');
    assert.strictEqual(ok.get('hotkeyToggleMap'), 'CommandOrControl+Alt+H');
    assert.strictEqual(ok.get('hotkeyDefaultsVersion'), 1);

    const failed = harness(before, false);
    assert.strictEqual(failed.merge({
        hotkeyToggleMap: 'CommandOrControl+Alt+H',
        hotkeyRotateMap: 'CommandOrControl+Alt+R',
        hotkeyDefaultsVersion: 1
    }, {rollback: true}), false);
    assert.strictEqual(failed.writes, 1);
    // Every key back where it was — including the one that did not exist, so a
    // half-migrated settings object cannot outlive the failed write.
    assert.deepStrictEqual(failed.settings, before);
});

test('merge: without rollback the values stay, as before', () => {
    const s = harness({a: 1}, false);
    assert.strictEqual(s.merge({a: 2, b: 3}), false);
    assert.deepStrictEqual(s.settings, {a: 2, b: 3});
});

test('merge: junk is a no-op write, never a throw', () => {
    for (const junk of [null, undefined, 42, 'nope']) {
        const s = harness({a: 1}, true);
        assert.strictEqual(s.merge(junk, {rollback: true}), true, String(junk));
        assert.deepStrictEqual(s.settings, {a: 1});
    }
});

/*
 * ─── Reading the file ───────────────────────────────────────────────────────
 */

test('parseFile: an ordinary settings object comes back as itself', () => {
    assert.deepStrictEqual(Settings.parseFile('{"size":250,"opacity":0.5}'), {size: 250, opacity: 0.5});
});

test('parseFile: valid JSON that is not an object is defaults, not a crash', () => {
    // `null`, `[]`, `3` and `"x"` all *parse*, so the constructor's try/catch
    // never fired for them — and the back-fill immediately after it does
    // `this.settings[key] = …`, which throws a TypeError on `null` (and
    // quietly builds a settings object out of an array or a boxed number for
    // the rest). That throw happens in the constructor, **before**
    // `app.whenReady()` and before the crash handlers are installed, so the
    // app simply failed to start: no window, no crash file, every single time,
    // until the user found and deleted a file they do not know exists.
    for (const text of ['null', '[]', '[1,2,3]', '3', '"nope"', 'true']) {
        assert.deepStrictEqual(Settings.parseFile(text), {}, text);
    }
});

test('parseFile: the back-fill survives everything parseFile can return', () => {
    // The shape the constructor actually relies on: whatever comes back can be
    // written to with a string key.
    const {DEFAULT_SETTINGS} = require('../src/shared/settings-defaults');
    for (const text of ['null', '[]', '{}', '{"size":1}']) {
        const parsed = Settings.parseFile(text);
        for (const key in DEFAULT_SETTINGS) {
            if (parsed[key] === undefined) parsed[key] = DEFAULT_SETTINGS[key];
        }
        assert.strictEqual(parsed.size !== undefined, true, text);
    }
});

test('parseFile: malformed JSON still throws, so the caller can log it', () => {
    // The existing try/catch around the read is what reports this one; taking
    // the throw away here would make a truncated file silently indistinguish-
    // able from a fresh install.
    assert.throws(() => Settings.parseFile('{"size":'), SyntaxError);
});

test('set: the chosen controller reaches app.log as (set) or (none), never its id', () => {
    const appLog = require('../src/core/app-log');
    const s = harness({tabMarkerPadId: null}, true);
    s.set('tabMarkerPadId', 'Private Pad (STANDARD GAMEPAD Vendor: 054c Product: 09cc)');
    s.set('tabMarkerPadId', null);
    const lines = appLog.recent().filter(l => l.includes('key=tabMarkerPadId'));
    assert.strictEqual(lines.length, 2, lines.join('\n'));
    assert.match(lines[0], /value=\(set\)/);
    assert.match(lines[1], /value=\(none\)/);
    assert.ok(!lines.join('').includes('Private Pad'));
    // The stored value is the real one: only the log is redacted.
    assert.strictEqual(s.get('tabMarkerPadId'), null);
});
