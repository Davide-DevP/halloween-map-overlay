'use strict';
const Module = require('module');

/*
 * One `require('electron')` stand-in for the tests that load a `src/core`
 * module outside Electron (where `require('electron')` is only a path string).
 * Install it BEFORE requiring the module under test; the recorders it returns
 * are the ones every IPC/globalShortcut call lands in.
 *
 *   const stub = installElectronStub({userData: dir, electron: {screen: …}});
 *   stub.ipc.handlers.get('channel')   // what `ipcMain.handle` registered
 *   stub.restore()                     // put the real loader back
 *
 * `userData: null` gives an `app` with no `getPath` at all, which is how a
 * module is told "no directory, keep everything in memory".
 * `app` entries are merged into the default app; any other `electron` entry
 * (BrowserWindow, screen, shell, utilityProcess, …) replaces the default.
 */
function installElectronStub(options) {
    const opts = options || {};
    const ipc = {handlers: new Map(), listeners: new Map()};
    const shortcuts = {registered: new Set(), refuse: new Set(), throwOn: new Set()};

    const userData = opts.userData;
    const app = {
        getName: () => 'Halloween Map Overlay',
        getVersion: () => opts.version || '0.0.0-test',
        getLocale: () => 'en-GB',
        isPackaged: false,
        quitCalls: 0,
        on() {},
        quit() { this.quitCalls += 1; }
    };
    if (userData !== null) {
        const dir = userData || require('path').join(__dirname, '..', 'nonexistent-userdata');
        const paths = Object.assign({userData: dir}, opts.paths || {});
        app.getPath = (name) => (name in paths ? paths[name] : dir);
    }
    Object.assign(app, opts.app || {});

    const electron = Object.assign({
        app,
        ipcMain: {
            handle(channel, fn) { ipc.handlers.set(channel, fn); },
            on(channel, fn) { ipc.listeners.set(channel, fn); },
            removeHandler(channel) { ipc.handlers.delete(channel); }
        },
        globalShortcut: {
            register(accelerator) {
                if (shortcuts.throwOn.has(accelerator)) throw new Error('bad accelerator');
                if (shortcuts.refuse.has(accelerator)) return false;
                shortcuts.registered.add(accelerator);
                return true;
            },
            unregister(accelerator) { shortcuts.registered.delete(accelerator); },
            unregisterAll() { shortcuts.registered.clear(); },
            isRegistered(accelerator) { return shortcuts.registered.has(accelerator); }
        },
        shell: {openPath: async () => '', openExternal() {}, showItemInFolder() {}}
    }, opts.electron || {});

    const realLoad = Module._load;
    Module._load = function (request) {
        if (request === 'electron') return electron;
        return realLoad.apply(this, arguments);
    };

    return {
        electron,
        app,
        ipc,
        shortcuts,
        /** Invoke a registered `ipcMain.handle` channel as the renderer would. */
        invoke(channel, ...args) {
            const fn = ipc.handlers.get(channel);
            if (!fn) throw new Error(`no handler for ${channel}`);
            return fn({sender: null}, ...args);
        },
        restore() { Module._load = realLoad; }
    };
}

/**
 * Make `require(request)` return `value` (or throw it, if it is an Error) —
 * for a native module such as `koffi` that must not load in a test.
 * @returns {() => void} restore
 */
function stubModule(request, value) {
    const realLoad = Module._load;
    Module._load = function (name) {
        if (name === request) {
            if (value instanceof Error) throw value;
            return value;
        }
        return realLoad.apply(this, arguments);
    };
    return () => { Module._load = realLoad; };
}

module.exports = {installElectronStub, stubModule};
