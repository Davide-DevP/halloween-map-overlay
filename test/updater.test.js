const {test, afterEach} = require('node:test');
const assert = require('node:assert');
const {EventEmitter} = require('events');
const {installElectronStub, stubModule} = require('./helpers/electron-stub');
const {fakeSettings} = require('./helpers/fake-settings');

/*
 * `core/updater.js`, the two paths `test/main-window-unload.test.js` does not
 * reach through the window: the stall watchdog's timing and the three-tier
 * install. `electron-updater` is a scripted double and tiers 1 and 2 are
 * replaced on the instance, so **nothing is ever spawned** (AGENTS.md rules 7
 * and 8). Timers and the clock are node:test's mock timers.
 */
const stub = installElectronStub({userData: null});
const autoUpdater = Object.assign(new EventEmitter(), {
    calls: {check: 0, notify: [], quitAndInstall: []},
    nextCheck: null,
    quitThrows: false,
    downloadedUpdateHelper: null,
    checkForUpdates() { this.calls.check += 1; return Promise.resolve(this.nextCheck); },
    checkForUpdatesAndNotify(opts) { this.calls.notify.push(opts); return Promise.resolve(null); },
    quitAndInstall(...args) {
        if (this.quitThrows) throw new Error('quitAndInstall failed');
        this.calls.quitAndInstall.push(args);
    }
});
stubModule('electron-updater', {autoUpdater});
const Updater = require('../src/core/updater');
const quitting = require('../src/core/quitting');
const {CHECK_STALL_MS, DOWNLOAD_STALL_MS} = require('../src/shared/update-message');

afterEach(() => {
    quitting.clearQuitting();
    stub.app.isPackaged = false;
    stub.app.quitCalls = 0;
    autoUpdater.calls = {check: 0, notify: [], quitAndInstall: []};
    autoUpdater.nextCheck = null;
    autoUpdater.quitThrows = false;
});

function build(over) {
    const record = {sent: [], toasts: [], shutdowns: 0, tiers: []};
    const updater = new Updater({
        settings: fakeSettings(over),
        language: {current: () => 'en'},
        send: (channel, payload) => record.sent.push({channel, payload}),
        sendUpdate: (message, opts) => record.toasts.push({message, opts}),
        getWindow: () => null,
        getTray: () => null,
        runShutdownHooks: () => { record.shutdowns += 1; }
    });
    return {updater, record};
}

const states = (record) => record.sent.filter(s => s.channel === 'update-check-state').map(s => s.payload.state);
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

// `autoUpdater`'s listeners are bound once per process, to the first Updater.
const shared = build();
shared.updater.prepareUpdater();

/* ────────────────────────────────────────────────────────────────────────────
 * The stall watchdog
 * ──────────────────────────────────────────────────────────────────────────── */

test('a check that goes silent is failed after CHECK_STALL_MS, not before', (t) => {
    t.mock.timers.enable({apis: ['setTimeout', 'Date'], now: 1_000_000});
    const {updater, record} = build();
    updater.setUpdateCheckState('checking');
    t.mock.timers.tick(CHECK_STALL_MS - 1);
    assert.strictEqual(updater.updateCheckState, 'checking');
    t.mock.timers.tick(1);
    assert.strictEqual(updater.updateCheckState, 'failed');
    assert.deepStrictEqual(record.toasts.map(x => x.message.key), ['update.checkFailed']);
    assert.deepStrictEqual(states(record), ['checking', 'failed']);
    assert.strictEqual(updater.updateCheckWatchdog, null, 'a settled state holds no timer');
});

test('a download is given DOWNLOAD_STALL_MS of silence, and progress resets it', (t) => {
    t.mock.timers.enable({apis: ['setTimeout', 'Date'], now: 2_000_000});
    const {updater, record} = shared;
    record.sent.length = 0;
    record.toasts.length = 0;
    autoUpdater.emit('update-available', {version: '9.9.9'});
    assert.strictEqual(updater.updateCheckState, 'found');
    t.mock.timers.tick(DOWNLOAD_STALL_MS - 1000);
    autoUpdater.emit('download-progress', {percent: 40});
    t.mock.timers.tick(DOWNLOAD_STALL_MS - 1000);
    assert.strictEqual(updater.updateCheckState, 'found', 'progress is liveness');
    t.mock.timers.tick(1000);
    assert.strictEqual(updater.updateCheckState, 'failed');
    // A download that comes back to life still raises the banner.
    autoUpdater.emit('update-downloaded', {version: '9.9.9', downloadedFile: 'x.exe'});
    assert.strictEqual(updater.updateCheckState, 'downloaded');
    assert.deepStrictEqual(updater.pendingUpdate(), {version: '9.9.9', dismissed: false});
    updater.pendingUpdateVersion = null;
    updater.setUpdateCheckState('idle');
});

test('a timer that never ran (a suspended laptop) is caught by the next click', async (t) => {
    t.mock.timers.enable({apis: ['setTimeout', 'Date'], now: 3_000_000});
    const {updater} = build();
    updater.setUpdateCheckState('checking');
    t.mock.timers.setTime(3_000_000 + CHECK_STALL_MS + 5);
    const answer = await updater.checkForUpdatesNow();
    assert.strictEqual(updater.updateCheckState, 'failed');
    assert.strictEqual(answer.state, 'devBuild', 'the click is still answered as a click');
});

test('a state that is not busy arms no watchdog', (t) => {
    t.mock.timers.enable({apis: ['setTimeout', 'Date']});
    const {updater} = build();
    for (const state of ['idle', 'upToDate', 'failed', 'downloaded']) {
        updater.setUpdateCheckState(state);
        assert.strictEqual(updater.updateCheckWatchdog, null, state);
    }
});

/* ────────────────────────────────────────────────────────────────────────────
 * The checks
 * ──────────────────────────────────────────────────────────────────────────── */

test('the automatic check never runs in dev, with the setting off, or while one is busy', (t) => {
    t.mock.timers.enable({apis: ['setTimeout', 'Date']});
    build().updater.checkUpdates();
    stub.app.isPackaged = true;
    build({checkForUpdates: false}).updater.checkUpdates();
    const busy = build();
    busy.updater.setUpdateCheckState('found');
    busy.updater.checkUpdates();
    t.mock.timers.tick(10000);
    assert.deepStrictEqual(autoUpdater.calls.notify, []);
});

test('the automatic check waits its startup delay, then asks once, in the user language', (t) => {
    t.mock.timers.enable({apis: ['setTimeout', 'Date']});
    stub.app.isPackaged = true;
    build().updater.checkUpdates();
    assert.strictEqual(autoUpdater.calls.notify.length, 0);
    t.mock.timers.tick(4000);
    assert.strictEqual(autoUpdater.calls.notify.length, 1);
    const notify = autoUpdater.calls.notify[0];
    assert.ok(typeof notify.title === 'string' && notify.title && !notify.title.startsWith('update.'));
});

test('the button: a check that neither finds nor denies is failed, never "up to date"', async () => {
    stub.app.isPackaged = true;
    const {updater} = build();
    autoUpdater.nextCheck = null;
    assert.strictEqual((await updater.checkForUpdatesNow()).state, 'failed');
    autoUpdater.nextCheck = {updateInfo: {version: '2.0.0'}, downloadPromise: Promise.resolve()};
    assert.deepStrictEqual(await updater.checkForUpdatesNow(), {state: 'found', version: '2.0.0'});
    updater.setUpdateCheckState('idle');
});

/* ────────────────────────────────────────────────────────────────────────────
 * The three-tier install
 * ──────────────────────────────────────────────────────────────────────────── */

/** An updater with a pending version and tiers 1 and 2 scripted. */
function installable(tier1, tier2) {
    const built = build();
    const {updater, record} = built;
    updater.pendingUpdateVersion = '2.0.0';
    updater.startThemedUpdater = async () => { record.tiers.push(1); return tier1(); };
    updater.spawnInstallerAtLowPriority = () => { record.tiers.push(2); return tier2(); };
    return built;
}

test('tier 1: the themed helper took over, the app quits a turn later', async () => {
    const {updater, record} = installable(() => true, () => true);
    assert.deepStrictEqual(await updater.installUpdate(), {ok: true, themed: true});
    assert.deepStrictEqual(record.tiers, [1]);
    assert.strictEqual(quitting.isQuitting(), true, 'quitting before the quit, or the close handler hides');
    assert.deepStrictEqual(record.sent[0], {channel: 'update-installing', payload: {version: '2.0.0'}});
    assert.strictEqual(stub.app.quitCalls, 0, 'deferred, so the IPC reply is flushed');
    await nextTurn();
    assert.deepStrictEqual([record.shutdowns, stub.app.quitCalls], [1, 1]);
});

test('tier 2: the helper failed, the stock installer runs and the view gets out of the way', async () => {
    const {updater, record} = installable(() => false, () => true);
    assert.deepStrictEqual(await updater.installUpdate(), {ok: true, themed: false});
    assert.deepStrictEqual(record.tiers, [1, 2]);
    assert.ok(record.sent.some(s => s.channel === 'update-install-result' && s.payload.ok === true));
    assert.deepStrictEqual(autoUpdater.calls.quitAndInstall, []);
    await nextTurn();
});

test('tier 3: both failed (one by throwing), electron-updater installs', async () => {
    const {updater, record} = installable(() => { throw new Error('helper'); }, () => false);
    assert.deepStrictEqual(await updater.installUpdate(), {ok: true, themed: false});
    assert.deepStrictEqual(record.tiers, [1, 2]);
    assert.deepStrictEqual(autoUpdater.calls.quitAndInstall, [[false, true]]);
    assert.strictEqual(record.shutdowns, 1);
    assert.strictEqual(quitting.isQuitting(), true);
});

test('all three failed: the app stays, says so, and can try again', async () => {
    autoUpdater.quitThrows = true;
    const {updater, record} = installable(() => false, () => false);
    assert.deepStrictEqual(await updater.installUpdate(), {ok: false, themed: false});
    assert.strictEqual(quitting.isQuitting(), false, 'the quitting flag is taken back');
    assert.strictEqual(updater.installStarted, false);
    assert.deepStrictEqual(record.toasts.at(-1), {message: {key: 'update.installFailed'}, opts: {keep: true}});
    assert.deepStrictEqual(record.sent.at(-1), {channel: 'update-install-result', payload: {ok: false, themed: false}});
});

test('single flight: the banner and the tray pressed together start one install', async () => {
    let release;
    const {updater, record} = installable(() => new Promise(r => { release = r; }), () => false);
    const first = updater.installUpdate();
    const second = updater.installUpdate();
    assert.strictEqual(first, second);
    release(true);
    await first;
    assert.deepStrictEqual(record.tiers, [1]);
    await nextTurn();
    assert.deepStrictEqual(await updater.installUpdate(), {ok: true, themed: true}, 'already started');
    assert.deepStrictEqual(record.tiers, [1]);
});

test('nothing pending: nothing is tried', async () => {
    const {updater, record} = installable(() => true, () => true);
    updater.pendingUpdateVersion = null;
    assert.deepStrictEqual(await updater.installUpdate(), {ok: false, themed: false});
    assert.deepStrictEqual([record.tiers, record.sent], [[], []]);
});
