const {test} = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const {EventEmitter} = require('events');
const Module = require('module');

/*
 * `core/main-window.js`'s **lifecycle**: the window being torn down while the
 * app sits in the tray, rebuilt on demand, and — the one that is not about
 * memory at all — closed for real.
 *
 * None of this can be driven through the real Electron, and all of it is
 * load-bearing: the tray unload is one `if` away from taking the overlay down
 * in the middle of a match, and the real close is one missing line away from
 * leaving the process resident with no window and a dead overlay.
 *
 * `require('electron')` outside Electron is a path string, so it is stubbed
 * before the module is loaded, as `test/tab-mode.test.js` does.
 */
const ROOT = path.join(__dirname, '..');
global.dirname = ROOT;
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmo-unload-'));

const IPC = {handlers: new Map(), listeners: new Map()};
const APP = {
    getPath: () => USER_DATA,
    getName: () => 'Halloween Map Overlay',
    getVersion: () => '0.7.0',
    getLocale: () => 'en-GB',
    isPackaged: false,
    isQuiting: false,
    quitCalls: 0,
    on() {},
    quit() { this.quitCalls += 1; }
};

/** Every window the stub has handed out, so "a third window is alive" is real. */
const WINDOWS = [];

class FakeBrowserWindow extends EventEmitter {
    constructor(options = {}) {
        super();
        this.options = options;
        this.destroyed = false;
        this.visible = options.show !== false;
        this.minimized = false;
        this.loadedFile = null;
        this.sent = [];
        this.webContents = new EventEmitter();
        this.webContents.send = (channel, ...args) => this.sent.push({channel, args});
        this.webContents.setWindowOpenHandler = () => {};
        this.webContents.openDevTools = () => {};
        this.webContents.isLoading = () => false;
        WINDOWS.push(this);
    }
    loadFile(file) { this.loadedFile = file; }
    setMenu() {}
    isDestroyed() { return this.destroyed; }
    isVisible() { return !this.destroyed && this.visible; }
    isMinimized() { return this.minimized; }
    isFocused() { return false; }
    getContentBounds() { return {x: 0, y: 0, width: 1000, height: 720}; }
    show() { this.visible = true; this.emit('show'); }
    hide() { this.visible = false; this.emit('hide'); }
    focus() {}
    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.emit('closed');
    }
    close() { this.destroy(); }
}

const realLoad = Module._load;
Module._load = function (request) {
    if (request === 'electron') {
        return {
            app: APP,
            BrowserWindow: FakeBrowserWindow,
            ipcMain: {
                handle(channel, fn) { IPC.handlers.set(channel, fn); },
                on(channel, fn) { IPC.listeners.set(channel, fn); }
            },
            screen: {
                getAllDisplays: () => [],
                getPrimaryDisplay: () => ({workArea: {x: 0, y: 0, width: 1920, height: 1040}, scaleFactor: 1}),
                dipToScreenRect: (win, rect) => rect
            },
            shell: {openPath: async () => '', openExternal() {}, showItemInFolder() {}}
        };
    }
    return realLoad.apply(this, arguments);
};

const MainWindow = require(path.join(ROOT, 'src/core/main-window'));
const {UNLOAD_GRACE_MS} = require(path.join(ROOT, 'src/shared/window-unload'));
const {DEFAULT_SETTINGS} = require(path.join(ROOT, 'src/shared/settings-defaults'));

/* ────────────────────────────────────────────────────────────────────────────
 * Doubles
 * ──────────────────────────────────────────────────────────────────────────── */

function fakeWindowDouble() {
    return {closed: 0, sent: [], close() { this.closed += 1; }, send(c) { this.sent.push(c); }};
}

function fakeSettings(over) {
    const values = Object.assign({}, DEFAULT_SETTINGS, over || {});
    return {values, get: (key) => values[key], all: () => values, set() { return true; }, settings: values};
}

function build(over) {
    APP.isQuiting = false;
    APP.quitCalls = 0;
    WINDOWS.length = 0;
    const overlay = fakeWindowDouble();
    const obs = fakeWindowDouble();
    const hooks = {
        tabDestroyed: 0,
        detectorStopped: 0,
        trayDestroyed: 0
    };
    const mainWindow = new MainWindow(obs, overlay, fakeSettings(over), null, {current: () => 'en'});
    mainWindow.setShutdownHooks({
        mapDetector: {stop() { hooks.detectorStopped += 1; }},
        tray: {destroy() { hooks.trayDestroyed += 1; }},
        tabMode: {destroy() { hooks.tabDestroyed += 1; }},
        hotkeys: {suspended: false}
    });
    // The update check is the one thing `show()` does that talks to the world.
    mainWindow.checkUpdates = () => {};
    mainWindow.cleanStaleUpdateHelpers = () => {};
    return {mainWindow, overlay, obs, hooks};
}

/** Pretend the window has been hidden long enough for the grace period. */
function agePastGrace(mainWindow) {
    mainWindow.hiddenAt = Date.now() - UNLOAD_GRACE_MS - 1000;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Closing the window for real
 * ──────────────────────────────────────────────────────────────────────────── */

test('closing the window shuts the app down explicitly, even with a third window alive', () => {
    const {mainWindow, overlay, obs, hooks} = build();
    mainWindow.show('startup');
    // Tab-map mode's lazy window: a third BrowserWindow nobody here closes.
    // It is what made `window-all-closed` stop firing — the process stayed
    // resident with the detector and the hotkeys running behind an overlay
    // that had already been closed, and Tray › Show rebuilt a window that
    // could never put a map anywhere.
    const tabWindow = new FakeBrowserWindow({show: false});
    assert.ok(!tabWindow.isDestroyed());

    mainWindow.window.close();

    assert.strictEqual(APP.isQuiting, true, 'the app must know it is quitting');
    assert.strictEqual(APP.quitCalls, 1, 'app.quit() was not called');
    assert.strictEqual(overlay.closed, 1, 'the overlay was not closed');
    assert.strictEqual(obs.closed, 1, 'the OBS window was not closed');
    assert.strictEqual(hooks.tabDestroyed, 1, 'the Tab-map window was not destroyed');
    assert.strictEqual(hooks.detectorStopped, 1);
    assert.strictEqual(hooks.trayDestroyed, 1);
});

test('the shutdown does not depend on window-all-closed firing', () => {
    // Same thing stated as the invariant rather than the symptom: nothing in
    // the close path may assume this is the last BrowserWindow.
    const {mainWindow, hooks} = build();
    mainWindow.show('startup');
    new FakeBrowserWindow({show: false});
    new FakeBrowserWindow({show: false});
    mainWindow.window.close();
    assert.strictEqual(APP.quitCalls, 1);
    assert.strictEqual(hooks.trayDestroyed, 1);
});

/* ────────────────────────────────────────────────────────────────────────────
 * The tray unload
 * ──────────────────────────────────────────────────────────────────────────── */

test('a tray unload destroys the window and leaves the overlay alone', () => {
    const {mainWindow, overlay, obs, hooks} = build();
    mainWindow.show('startup');
    const built = mainWindow.window;

    mainWindow.window.hide();
    agePastGrace(mainWindow);
    mainWindow.scheduleUnload('test');

    assert.ok(built.isDestroyed(), 'the window should have been destroyed');
    assert.strictEqual(mainWindow.window, null);
    assert.strictEqual(mainWindow.unloaded, true);
    // **The whole point.** None of this may happen mid-match.
    assert.strictEqual(overlay.closed, 0, 'the overlay went down with the window');
    assert.strictEqual(obs.closed, 0);
    assert.strictEqual(hooks.tabDestroyed, 0);
    assert.strictEqual(hooks.detectorStopped, 0);
    assert.strictEqual(hooks.trayDestroyed, 0);
    assert.strictEqual(APP.quitCalls, 0, 'the app must not quit');
    assert.strictEqual(APP.isQuiting, false);
});

test('an unloaded window is rebuilt by show(), and the startup work is not repeated', () => {
    const {mainWindow} = build();
    let checks = 0;
    mainWindow.checkUpdates = () => { checks += 1; };
    mainWindow.show('startup');
    assert.strictEqual(checks, 1);

    mainWindow.window.hide();
    agePastGrace(mainWindow);
    mainWindow.scheduleUnload('test');
    assert.strictEqual(mainWindow.window, null);

    mainWindow.show('tray-click');
    assert.ok(mainWindow.window, 'the window was not rebuilt');
    assert.strictEqual(mainWindow.window.loadedFile, 'src/index.html');
    // Reopening the window must not be a new GitHub request: the README and
    // the FAQ both describe the update check as "once at startup".
    assert.strictEqual(checks, 1, 'the update check ran again on a tray reopen');
});

test('the grace period is waited out rather than unloading on the hide', () => {
    const {mainWindow} = build();
    mainWindow.show('startup');
    const built = mainWindow.window;
    mainWindow.window.hide();
    assert.ok(!built.isDestroyed(), 'a quick tray round trip must not thrash the renderer');
    assert.notStrictEqual(mainWindow.unloadTimer, null, 'no timer was armed');
    // Coming back cancels it.
    mainWindow.window.show();
    assert.strictEqual(mainWindow.unloadTimer, null);
});

test('minimising to the taskbar is not hiding to the tray', () => {
    const {mainWindow} = build();
    mainWindow.show('startup');
    // No `hide()`: minimize-to-tray is off, the window sits on the taskbar.
    mainWindow.window.minimized = true;
    mainWindow.window.visible = false;
    mainWindow.scheduleUnload('test');
    assert.strictEqual(mainWindow.unloadTimer, null, 'nothing to wait for: it is not in the tray');
    assert.ok(mainWindow.window && !mainWindow.window.isDestroyed());
});

test('the minimise button with minimize-to-tray on does unload', () => {
    // The owner's real path: Windows minimises first, the `minimize` handler
    // then hides — and `isMinimized()` stays true on the hidden window.
    const {mainWindow} = build();
    mainWindow.show('startup');
    mainWindow.window.minimized = true;
    mainWindow.window.hide();
    agePastGrace(mainWindow);
    mainWindow.scheduleUnload('test');
    assert.strictEqual(mainWindow.window, null);
    assert.strictEqual(mainWindow.unloadState().unloaded, true);
});

test('a leftover unloadWindowInTray: false cannot keep the window forever', () => {
    // The option went in 1.0; a settings file that still carries it unloads
    // like every other, and nothing here reads the key at all.
    const {mainWindow} = build({unloadWindowInTray: false});
    mainWindow.show('startup');
    mainWindow.window.hide();
    agePastGrace(mainWindow);
    mainWindow.scheduleUnload('test');
    assert.ok(!mainWindow.window || mainWindow.window.isDestroyed());
    assert.strictEqual(mainWindow.unloaded, true);
    // The state lines in the diagnostic report survive; the setting line does
    // not, so nothing can print "off" about something that is always on.
    const state = mainWindow.unloadState();
    assert.ok(!Object.prototype.hasOwnProperty.call(state, 'setting'));
    assert.strictEqual(state.loaded, false);
});

test('an unloading window is not reported as a renderer crash', () => {
    // Two ordinary tray unloads 46 s apart would otherwise look like "the main
    // window died twice in 60 s" and take the whole app down mid-match.
    const {mainWindow} = build();
    mainWindow.show('startup');
    const built = mainWindow.window;
    mainWindow.window.hide();
    agePastGrace(mainWindow);
    mainWindow.scheduleUnload('test');
    // A destroyed window can still emit this on some platforms.
    built.webContents.emit('render-process-gone', {}, {reason: 'killed', exitCode: 1});
    assert.strictEqual(mainWindow.lastRendererGone, 0, 'the unload was counted as a crash');
    assert.strictEqual(APP.quitCalls, 0);
});

test('nothing builds a window on the way out', () => {
    const {mainWindow} = build();
    APP.isQuiting = true;
    mainWindow.show('second-instance');
    assert.strictEqual(mainWindow.window, null,
        'a window was built while the installer was taking over');
});

/* ────────────────────────────────────────────────────────────────────────────
 * What keeps the window alive
 * ──────────────────────────────────────────────────────────────────────────── */

test('a busy view keeps the window, and a reload clears the reason', () => {
    const {mainWindow} = build();
    mainWindow.show('startup');
    IPC.listeners.get('window-busy')({}, {reason: 'settings', on: true});
    mainWindow.window.hide();
    agePastGrace(mainWindow);
    mainWindow.scheduleUnload('test');
    assert.ok(mainWindow.window && !mainWindow.window.isDestroyed(), 'an open modal was ignored');

    // A renderer that died (or was reloaded) with the modal open would leave
    // that reason set forever and the window could never be unloaded again.
    mainWindow.window.webContents.emit('did-start-loading');
    assert.strictEqual(mainWindow.busyReasons.size, 0);
    agePastGrace(mainWindow);
    mainWindow.scheduleUnload('test');
    assert.strictEqual(mainWindow.window, null, 'the stale busy reason survived a reload');
});

test('a recording bind dialog keeps the window, and lifting it re-asks', () => {
    const {mainWindow} = build();
    mainWindow.show('startup');
    const hotkeys = mainWindow.shutdownHooks.hotkeys;
    hotkeys.suspended = true;
    mainWindow.window.hide();
    agePastGrace(mainWindow);
    mainWindow.scheduleUnload('test');
    assert.ok(mainWindow.window && !mainWindow.window.isDestroyed());

    // `Hotkeys.applyRegistration` calls `scheduleUnload` for exactly this: the
    // watchdog can lift a suspension whose "resume" never arrived, and nothing
    // else would ever ask again.
    hotkeys.suspended = false;
    agePastGrace(mainWindow);
    mainWindow.scheduleUnload('hotkeys-watchdog');
    assert.strictEqual(mainWindow.window, null);
});

test('a downloaded update keeps the window until the banner has been seen', () => {
    const {mainWindow} = build();
    mainWindow.show('startup');
    mainWindow.pendingUpdateVersion = '0.7.1';
    mainWindow.updateBannerShown = false;
    mainWindow.window.hide();
    agePastGrace(mainWindow);
    mainWindow.scheduleUnload('test');
    assert.ok(mainWindow.window && !mainWindow.window.isDestroyed());

    IPC.listeners.get('update-banner-shown')({});
    agePastGrace(mainWindow);
    mainWindow.scheduleUnload('test');
    assert.strictEqual(mainWindow.window, null);
});

test('"Later" is remembered in main, so the banner does not come back on every reopen', async () => {
    const {mainWindow} = build();
    mainWindow.show('startup');
    mainWindow.pendingUpdateVersion = '0.7.1';
    assert.deepStrictEqual(await IPC.handlers.get('get-pending-update')(),
        {version: '0.7.1', dismissed: false});
    IPC.listeners.get('update-banner-dismissed')({});
    assert.deepStrictEqual(await IPC.handlers.get('get-pending-update')(),
        {version: '0.7.1', dismissed: true});
    // …and a dismissed banner is no longer a reason to keep the window.
    mainWindow.window.hide();
    agePastGrace(mainWindow);
    mainWindow.scheduleUnload('test');
    assert.strictEqual(mainWindow.window, null);
});

/* ────────────────────────────────────────────────────────────────────────────
 * Toasts with no window
 * ──────────────────────────────────────────────────────────────────────────── */

test('an ordinary toast is dropped with no window; a kept one waits', () => {
    const {mainWindow} = build();
    mainWindow.sendUpdate({key: 'toast.markersOn'});
    assert.strictEqual(mainWindow.toastQueue.length, 0, 'a match-time toast should be dropped');
    mainWindow.sendUpdate({key: 'settings.error.writeFailed'}, {keep: true});
    assert.strictEqual(mainWindow.toastQueue.length, 1);
});

test('the queue is deduped by key and capped', () => {
    const {mainWindow} = build();
    for (let i = 0; i < 4; i++) mainWindow.sendUpdate({key: 'settings.error.writeFailed'}, {keep: true});
    assert.strictEqual(mainWindow.toastQueue.length, 1, 'one message repeated is one message');
    for (const key of ['a.b', 'c.d', 'e.f', 'g.h', 'i.j']) {
        mainWindow.sendUpdate({key}, {keep: true});
    }
    assert.strictEqual(mainWindow.toastQueue.length, 5);
    assert.strictEqual(mainWindow.toastQueue[4].key, 'i.j', 'the newest must survive');
});

test('the queue is flushed one at a time, not five into a single toast element', async () => {
    const {mainWindow} = build();
    mainWindow.sendUpdate({key: 'a.b'}, {keep: true});
    mainWindow.sendUpdate({key: 'c.d'}, {keep: true});
    mainWindow.show('tray-click');
    const win = mainWindow.window;
    // `src/js/status.js` is one element with one shared auto-hide timer, so
    // sending them back to back would mean only the last was ever read.
    const immediate = win.sent.filter(m => m.channel === 'update-message');
    assert.strictEqual(immediate.length, 1, 'the second toast should be spaced, not stacked');
    assert.strictEqual(mainWindow.toastQueue.length, 0, 'the queue was not taken');
    await new Promise(resolve => setTimeout(resolve, 30));
});

test('nothing is flushed into a window nobody can see', () => {
    const {mainWindow} = build();
    mainWindow.sendUpdate({key: 'a.b'}, {keep: true});
    mainWindow.show('test', {show: false});
    assert.strictEqual(mainWindow.window.sent.filter(m => m.channel === 'update-message').length, 0);
    assert.strictEqual(mainWindow.toastQueue.length, 1, 'the queue must be kept, not spent');
    // …and showing it later delivers.
    mainWindow.window.show();
    assert.strictEqual(mainWindow.window.sent.filter(m => m.channel === 'update-message').length, 1);
});

/* ────────────────────────────────────────────────────────────────────────────
 * The report
 * ──────────────────────────────────────────────────────────────────────────── */

test('unloadState is what system.txt prints', () => {
    const {mainWindow} = build();
    mainWindow.show('startup');
    // The **state** lines only since 1.0: the unload is always on, so a
    // `setting` line could only ever print "on".
    assert.deepStrictEqual(mainWindow.unloadState(),
        {loaded: true, unloaded: false, busy: []});
    IPC.listeners.get('window-busy')({}, {reason: 'report', on: true});
    assert.deepStrictEqual(mainWindow.unloadState().busy, ['report']);
    mainWindow.busyReasons.clear();
    mainWindow.window.hide();
    agePastGrace(mainWindow);
    mainWindow.scheduleUnload('test');
    assert.deepStrictEqual(mainWindow.unloadState(),
        {loaded: false, unloaded: true, busy: []});
});
