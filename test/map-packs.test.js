const {test, after} = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {installElectronStub} = require('./helpers/electron-stub');

/*
 * `core/map-packs.js`, the electron half of map packs: the 24 h gate wiring,
 * the IPC surface, the toasts and what happens after a pack lands. The install
 * itself (`map-pack-install.js`) has its own suite; here it is replaced by a
 * scripted `checkForPacks`, so **no request is ever made** and every outcome is
 * chosen by the test. userData is a fresh temp dir per test.
 */
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hmo-map-packs-'));
after(() => fs.rmSync(TMP, {recursive: true, force: true}));

let userData = TMP;
const stub = installElectronStub({app: {getPath: () => userData}});

// Replace the network-facing install before `map-packs.js` destructures it.
const install = require(path.join(ROOT, 'src/core/map-pack-install'));
const NETWORK = {calls: [], next: null};
install.checkForPacks = async (opts) => {
    NETWORK.calls.push(opts);
    return typeof NETWORK.next === 'function' ? NETWORK.next(opts) : NETWORK.next;
};
const {fetchPackFile} = require(path.join(ROOT, 'src/core/map-pack-fetch'));
const MapPacks = require(path.join(ROOT, 'src/core/map-packs'));
const {RETRY_INTERVAL_MS} = require(path.join(ROOT, 'src/shared/map-pack-rules'));
const {acceleratorToDisplay} = require(path.join(ROOT, 'src/shared/hotkeys-constants'));
const {fakeSettings} = require('./helpers/fake-settings');

const HOUR = 60 * 60 * 1000;
const result = (over) => Object.assign(
    {ok: true, error: null, notPublished: false, installed: [], skipped: [], failed: []}, over);

function fakeMainWindow() {
    return {
        toasts: [],
        sent: [],
        sendUpdate(message, opts) { this.toasts.push({message, opts}); },
        send(channel, payload) { this.sent.push({channel, payload}); }
    };
}

function build(over, catalog) {
    userData = fs.mkdtempSync(path.join(TMP, 'u-'));
    NETWORK.calls.length = 0;
    NETWORK.next = result();
    const mainWindow = fakeMainWindow();
    const library = {
        invalidated: 0,
        getCatalog: () => (catalog || []).map(key => ({key})),
        invalidate() { this.invalidated += 1; }
    };
    const packs = new MapPacks(mainWindow, fakeSettings(over), library);
    return {packs, mainWindow, library};
}

const toastKeys = (mainWindow) => mainWindow.toasts.map(t => t.message.key);

test('the IPC surface is two invoke channels, and the button one is forced', async () => {
    const {packs} = build({checkForMapPacks: false});
    assert.ok(stub.ipc.handlers.has('check-map-packs'));
    assert.ok(stub.ipc.handlers.has('get-map-pack-state'));
    const state = await stub.invoke('get-map-pack-state');
    assert.deepStrictEqual(state.packs, []);
    assert.strictEqual(state.enabled, false);
    assert.strictEqual(state.lastResult, 'never');
    // The click is the consent: the switch being off does not stop it.
    const answer = await stub.invoke('check-map-packs');
    assert.strictEqual(answer.ok, true);
    assert.strictEqual(NETWORK.calls.length, 1);
    packs.destroy();
});

test('the one request goes through the allow-listed fetch and the pack store', async () => {
    const {packs} = build();
    await packs.check({force: true});
    const call = NETWORK.calls[0];
    assert.strictEqual(call.fetch, fetchPackFile);
    assert.strictEqual(call.store, packs.store);
    assert.strictEqual(call.store.dir, path.join(userData, 'map-packs'));
    assert.strictEqual(typeof call.probeImage, 'function');
});

test('with the switch off, nothing but the button makes a request', async () => {
    const {packs} = build({checkForMapPacks: false});
    const answer = await packs.check();
    assert.deepStrictEqual([answer.ok, answer.error], [false, 'disabled']);
    packs.scheduleStartupCheck(0);
    assert.strictEqual(packs.startupTimer, null);
    assert.strictEqual(NETWORK.calls.length, 0);
});

test('a successful check holds the next one off for 24 hours, on disk', async () => {
    const {packs} = build();
    assert.strictEqual((await packs.check()).ok, true);
    const onDisk = JSON.parse(fs.readFileSync(path.join(userData, 'map-packs', 'state.json'), 'utf-8'));
    assert.strictEqual(onDisk.lastResult, 'up-to-date');
    assert.ok(Math.abs(onDisk.lastCheckAt - Date.now()) < 5000);
    const again = await packs.check();
    assert.deepStrictEqual([again.ok, again.error], [false, 'too-soon']);
    // A new process reads the same file and agrees.
    const {packs: restarted} = build();
    fs.mkdirSync(path.join(userData, 'map-packs'), {recursive: true});
    fs.writeFileSync(path.join(userData, 'map-packs', 'state.json'), JSON.stringify(onDisk));
    assert.strictEqual((await restarted.check()).error, 'too-soon');
    assert.strictEqual(NETWORK.calls.length, 0);
});

test('a failed check is retried after an hour, not after a day', async () => {
    const {packs, mainWindow} = build();
    NETWORK.next = result({ok: false, error: 'network'});
    const answer = await packs.check();
    assert.deepStrictEqual([answer.ok, answer.error], [false, 'network']);
    assert.deepStrictEqual(toastKeys(mainWindow), [], 'a startup failure is silent');
    const state = packs.info();
    assert.deepStrictEqual([state.lastResult, state.lastError], ['failed', 'network']);
    assert.strictEqual((await packs.check()).error, 'too-soon');
    packs.store.writeState({lastCheckAt: Date.now() - RETRY_INTERVAL_MS - 1000});
    NETWORK.next = result();
    assert.strictEqual((await packs.check()).ok, true);
});

test('a 404 on the index is "nothing published", which shortens nothing', async () => {
    const {packs, mainWindow} = build();
    NETWORK.next = result({notPublished: true});
    await packs.check({force: true});
    assert.deepStrictEqual(toastKeys(mainWindow), ['mapPacks.checking', 'mapPacks.notPublished']);
    assert.strictEqual(packs.info().lastResult, 'not-published');
    packs.store.writeState({lastCheckAt: Date.now() - 2 * HOUR});
    assert.strictEqual((await packs.check()).error, 'too-soon');
});

test('the button says what happened, every time', async () => {
    const {packs, mainWindow} = build();
    await packs.check({force: true});
    NETWORK.next = result({ok: false, error: 'timeout'});
    await packs.check({force: true});
    assert.deepStrictEqual(toastKeys(mainWindow), [
        'mapPacks.checking', 'mapPacks.upToDate', 'mapPacks.checking', 'mapPacks.failed'
    ]);
    // Kept for the next window: the check can land while the window is unloaded.
    for (const toast of mainWindow.toasts) assert.deepStrictEqual(toast.opts, {keep: true});
});

test('a second check while one is running answers busy and sends nothing', async () => {
    const {packs} = build();
    let release;
    NETWORK.next = () => new Promise(resolve => { release = () => resolve(result()); });
    const first = packs.check({force: true});
    const second = await packs.check({force: true});
    assert.strictEqual(second.error, 'busy');
    assert.strictEqual(NETWORK.calls.length, 1);
    release();
    assert.strictEqual((await first).ok, true);
    assert.strictEqual(packs.checking, false);
});

test('an install that throws is a failed check, never a thrown one', async () => {
    const {packs, mainWindow} = build();
    NETWORK.next = () => { throw new Error('boom'); };
    const answer = await packs.check({force: true});
    assert.deepStrictEqual([answer.ok, answer.error], [false, 'threw']);
    assert.strictEqual(packs.checking, false, 'the busy flag must come back down');
    assert.deepStrictEqual(toastKeys(mainWindow), ['mapPacks.checking', 'mapPacks.failed']);
});

test('a new map is made visible everywhere and offered the next number key', async () => {
    const {packs, mainWindow, library} = build();
    const reloads = [];
    const hotkeys = {
        loads: 0,
        offered: [],
        assignPackMapHotkey(key, already) {
            this.offered.push({key, already});
            return {remember: true, accelerator: 'CommandOrControl+Alt+5'};
        },
        loadKeys() { this.loads += 1; }
    };
    packs.setDetector({reloadTemplates: () => reloads.push(1)});
    packs.setHotkeys(hotkeys);
    NETWORK.next = result({installed: [{key: 'someone/New Map'}]});
    await packs.check();
    assert.strictEqual(library.invalidated, 1);
    assert.strictEqual(reloads.length, 1);
    assert.deepStrictEqual(hotkeys.offered, [{key: 'someone/New Map', already: []}]);
    assert.strictEqual(hotkeys.loads, 1);
    assert.deepStrictEqual(mainWindow.toasts[0].message, {
        key: 'mapPacks.installedOneBound',
        params: {map: 'New Map', accelerator: acceleratorToDisplay('CommandOrControl+Alt+5')}
    });
    assert.deepStrictEqual(mainWindow.sent, [{channel: 'map-packs-updated', payload: {installed: 1}}]);
    // Remembered beside the packs, so a deleted binding never comes back.
    assert.deepStrictEqual(packs.store.state().offeredHotkeys, ['someone/New Map']);
    assert.strictEqual(packs.info().lastResult, 'installed:1');
});

test('a pack that replaces a map the catalogue already had is not a new map', async () => {
    const {packs, mainWindow} = build({}, ['deftyconchgaming/East Haddonfield']);
    const hotkeys = {calls: 0, assignPackMapHotkey() { this.calls += 1; return {}; }};
    packs.setHotkeys(hotkeys);
    NETWORK.next = result({installed: [{key: 'deftyconchgaming/east haddonfield'}]});
    await packs.check();
    assert.strictEqual(hotkeys.calls, 0, 'case is folded, as the catalogue merge folds it');
    assert.deepStrictEqual(mainWindow.toasts[0].message,
        {key: 'mapPacks.installedOne', params: {map: 'east haddonfield'}});
});

test('several packs at once are one toast with a count', async () => {
    const {packs, mainWindow} = build();
    NETWORK.next = result({installed: [{key: 'a/One'}, {key: 'b/Two'}]});
    await packs.check();
    assert.deepStrictEqual(mainWindow.toasts.map(t => t.message),
        [{key: 'mapPacks.installedMany', params: {count: 2}}]);
});

test('a detector or hotkeys object without the method is not wired in', () => {
    const {packs} = build();
    packs.setDetector({});
    packs.setHotkeys({loadKeys() {}});
    assert.strictEqual(packs.detector, null);
    assert.strictEqual(packs.hotkeys, null);
    assert.deepStrictEqual(packs.assignHotkeys([{key: 'a/B'}], new Set()), []);
});

test('the startup check runs later, quietly, and destroy() cancels it', async () => {
    const {packs, mainWindow} = build();
    packs.scheduleStartupCheck(60 * 1000);
    assert.ok(packs.startupTimer, 'a timer is armed');
    packs.destroy();
    assert.strictEqual(packs.startupTimer, null);

    packs.scheduleStartupCheck(1);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.strictEqual(NETWORK.calls.length, 1);
    assert.deepStrictEqual(toastKeys(mainWindow), [], 'no "checking" toast at startup');
});

test('the startup check is skipped outright inside the 24 hour window', () => {
    const {packs} = build();
    packs.store.writeState({lastCheckAt: Date.now() - HOUR, lastResult: 'up-to-date'});
    packs.scheduleStartupCheck(1);
    assert.strictEqual(packs.startupTimer, null);
});
