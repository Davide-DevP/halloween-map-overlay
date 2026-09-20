const {test} = require('node:test');
const assert = require('node:assert');

const ForegroundWatcher = require('../src/core/foreground');
const {FOREGROUND_GAME, FOREGROUND_OWN, FOREGROUND_OTHER, FOREGROUND_UNKNOWN} =
    require('../src/shared/hotkeys-rules');

/*
 * `core/foreground.js` is electron-facing, but the three things it touches —
 * `app`, `BrowserWindow` and `node-screenshots`' `Window` — are injectable
 * exactly so this file can exist. What is tested here is the **lifecycle**,
 * which is where the bug was: `destroy()` runs from `before-quit` (and from the
 * update path), and a `destroy()` that reported its verdict on the way out
 * turned into `Hotkeys.loadKeys()` re-registering a dozen global shortcuts
 * inside the quit handler.
 */

/** A window as the watcher reads one. */
function win(props) {
    const w = Object.assign({
        appName: '', title: '', minimized: false, width: 1920, height: 1080,
        pid: 7, focused: false
    }, props);
    return {
        appName: () => w.appName,
        title: () => w.title,
        isMinimized: () => w.minimized,
        width: () => w.width,
        height: () => w.height,
        pid: () => w.pid,
        isFocused: () => w.focused
    };
}

const GAME = {appName: 'Halloween', title: 'Halloween'};
const BROWSER = {appName: 'Floorp', title: 'news'};

/**
 * @param {Object} [options]
 * @param {Array} [options.windows] what `Window.all()` returns
 * @param {boolean} [options.ownFocused] what `BrowserWindow.getFocusedWindow()` says
 * @param {*} [options.gameOnly] the `hotkeysGameOnly` setting
 * @param {Error} [options.scanThrows] make `Window.all()` throw
 */
function build(options = {}) {
    const listeners = [];
    const calls = [];
    const fakeApp = {
        on(event, fn) {
            listeners.push({event, fn});
        },
        removeListener(event, fn) {
            const i = listeners.findIndex(l => l.event === event && l.fn === fn);
            if (i >= 0) listeners.splice(i, 1);
        },
        emit(event) {
            for (const l of listeners.slice()) if (l.event === event) l.fn();
        }
    };
    const deps = {
        app: fakeApp,
        BrowserWindow: {getFocusedWindow: () => (options.ownFocused ? {} : null)},
        Window: {
            all() {
                if (options.scanThrows) throw options.scanThrows;
                return (options.windows || []).map(win);
            }
        }
    };
    const settings = {get: (key) => (key === 'hotkeysGameOnly' ? options.gameOnly : undefined)};
    const watcher = new ForegroundWatcher(settings, (active) => calls.push(active), deps);
    return {watcher, calls, listeners, app: fakeApp};
}

test('the game in the foreground registers the hotkeys', () => {
    const {watcher, calls} = build({windows: [Object.assign({focused: true}, GAME)]});
    try {
        watcher.syncWithSettings();
        assert.strictEqual(watcher.foreground, FOREGROUND_GAME);
        assert.strictEqual(watcher.gameRunning, true);
        assert.deepStrictEqual(calls, [true]);
    } finally {
        watcher.destroy();
    }
});

test('somebody else in the foreground unregisters them', () => {
    const {watcher, calls} = build({windows: [Object.assign({focused: true}, BROWSER), GAME]});
    try {
        watcher.syncWithSettings();
        assert.strictEqual(watcher.foreground, FOREGROUND_OTHER);
        // The game is running, it just is not in front.
        assert.strictEqual(watcher.gameRunning, true);
        assert.deepStrictEqual(calls, [false]);
    } finally {
        watcher.destroy();
    }
});

test('one of our own windows counts as the game being in front', () => {
    const {watcher, calls} = build({windows: [Object.assign({focused: true}, BROWSER)], ownFocused: true});
    try {
        watcher.syncWithSettings();
        assert.strictEqual(watcher.foreground, FOREGROUND_OWN);
        assert.deepStrictEqual(calls, [true]);
    } finally {
        watcher.destroy();
    }
});

test('nothing focused, and a scan that throws, both fail open', () => {
    // An exclusive-fullscreen game window the enumeration does not return looks
    // exactly like "nothing is focused", and switching the hotkeys off while
    // the player is in the game is the worst outcome this feature can have.
    const nothing = build({windows: [BROWSER, GAME]});
    try {
        nothing.watcher.syncWithSettings();
        assert.strictEqual(nothing.watcher.foreground, FOREGROUND_UNKNOWN);
        assert.deepStrictEqual(nothing.calls, [true]);
    } finally {
        nothing.watcher.destroy();
    }

    const broken = build({scanThrows: new Error('no window list')});
    try {
        broken.watcher.syncWithSettings();
        assert.strictEqual(broken.watcher.foreground, FOREGROUND_UNKNOWN);
        assert.deepStrictEqual(broken.calls, [true]);
    } finally {
        broken.watcher.destroy();
    }
});

test('with the setting off nothing is polled and the hotkeys are always held', () => {
    const {watcher, calls} = build({gameOnly: false, windows: [Object.assign({focused: true}, BROWSER)]});
    try {
        watcher.syncWithSettings();
        assert.strictEqual(watcher.started, false);
        assert.strictEqual(watcher.timer, null);
        assert.deepStrictEqual(calls, [true]);
    } finally {
        watcher.destroy();
    }
});

test('the verdict is reported on a change only', () => {
    const {watcher, calls} = build({windows: [Object.assign({focused: true}, GAME)]});
    try {
        watcher.syncWithSettings();
        watcher.tick();
        watcher.tick();
        watcher.evaluate(FOREGROUND_OWN);
        // Four evaluations, all of them "yes" — one callback.
        assert.deepStrictEqual(calls, [true]);
    } finally {
        watcher.destroy();
    }
});

/* ────────────────────────────────────────────────────────────────────────────
 * destroy()
 * ──────────────────────────────────────────────────────────────────────────── */

test('destroy() does not report, so quitting cannot re-register the hotkeys', () => {
    // The bug: `destroy()` → `stop()` → `report()`, and `stop()` reports with
    // "the setting is off" (nothing is being watched any more), which is
    // `true`. Inside `before-quit` that became a full `loadKeys()` — a dozen
    // `globalShortcut.register` calls milliseconds before the process exits,
    // and on the update path while the installer is being handed control.
    const {watcher, calls} = build({windows: [Object.assign({focused: true}, BROWSER)]});
    watcher.syncWithSettings();
    assert.deepStrictEqual(calls, [false], 'inactive while a browser is in front');

    watcher.destroy();
    assert.deepStrictEqual(calls, [false], 'destroy() must add no callback of its own');
    assert.strictEqual(watcher.destroyed, true);
    assert.strictEqual(watcher.timer, null);
});

test('destroy() removes both app listeners', () => {
    const {watcher, listeners} = build({windows: [GAME]});
    assert.deepStrictEqual(listeners.map(l => l.event).sort(),
        ['browser-window-blur', 'browser-window-focus']);
    watcher.destroy();
    assert.deepStrictEqual(listeners, []);
});

test('a destroyed watcher stays destroyed', () => {
    const {watcher, calls, app} = build({windows: [Object.assign({focused: true}, GAME)]});
    watcher.syncWithSettings();
    calls.length = 0;
    watcher.destroy();

    // Everything that could bring it back to life is a no-op.
    watcher.syncWithSettings();
    watcher.start();
    watcher.tick();
    watcher.schedule(0);
    watcher.evaluate(FOREGROUND_GAME);
    watcher.report();
    // …including a focus event that arrived after the listeners were dropped.
    app.emit('browser-window-focus');
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(watcher.started, false);
    assert.strictEqual(watcher.timer, null);
    // And destroying twice is harmless.
    watcher.destroy();
});

test('turning the setting off *does* report, unlike destroy()', () => {
    // The distinction that makes the fix a fix rather than a mute button: the
    // user switching `hotkeysGameOnly` off has to put the hotkeys back.
    const {watcher, calls} = build({windows: [Object.assign({focused: true}, BROWSER)]});
    try {
        watcher.syncWithSettings();
        assert.deepStrictEqual(calls, [false]);
        watcher.stop();
        assert.deepStrictEqual(calls, [false, true]);
    } finally {
        watcher.destroy();
    }
});

test('state() is what the diagnostic report prints', () => {
    const {watcher} = build({windows: [Object.assign({focused: true}, GAME)]});
    try {
        watcher.syncWithSettings();
        assert.deepStrictEqual(watcher.state(), {
            gameOnly: true,
            watching: true,
            foreground: FOREGROUND_GAME,
            gameRunning: true,
            active: true
        });
    } finally {
        watcher.destroy();
    }
});
