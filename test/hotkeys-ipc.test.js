const {test} = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const Module = require('module');

/*
 * `core/hotkeys.js`'s IPC surface, driven through the channels the renderer
 * uses: the validation order, the `hotkeys.json` writes and the rollback-backed
 * system writes. `electron` is stubbed before the module loads, as
 * `test/tab-mode.test.js` does; `globalShortcut` records instead of binding.
 */
const ROOT = path.join(__dirname, '..');
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmo-hotkeys-ipc-'));
const HOTKEY_FILE = path.join(USER_DATA, 'hotkeys.json');

const IPC = {handlers: new Map(), listeners: new Map()};
const SHORTCUTS = {registered: new Set(), refuse: new Set(), throwOn: new Set()};

const realLoad = Module._load;
Module._load = function (request) {
    if (request === 'electron') {
        return {
            app: {getPath: () => USER_DATA},
            ipcMain: {
                handle(channel, fn) { IPC.handlers.set(channel, fn); },
                on(channel, fn) { IPC.listeners.set(channel, fn); }
            },
            globalShortcut: {
                register(accelerator) {
                    if (SHORTCUTS.throwOn.has(accelerator)) throw new Error('bad accelerator');
                    if (SHORTCUTS.refuse.has(accelerator)) return false;
                    SHORTCUTS.registered.add(accelerator);
                    return true;
                },
                unregister(accelerator) { SHORTCUTS.registered.delete(accelerator); },
                unregisterAll() { SHORTCUTS.registered.clear(); }
            }
        };
    }
    return realLoad.apply(this, arguments);
};

const Hotkeys = require(path.join(ROOT, 'src/core/hotkeys'));
const {DEFAULT_SETTINGS} = require(path.join(ROOT, 'src/shared/settings-defaults'));
const {HOTKEY_DEFAULTS_VERSION} = require(path.join(ROOT, 'src/shared/hotkey-migration'));
const {ACTION_TO_SETTING_KEY} = require(path.join(ROOT, 'src/shared/hotkeys-constants'));

function fakeSettings(over) {
    const values = Object.assign({}, DEFAULT_SETTINGS,
        {hotkeyDefaultsVersion: HOTKEY_DEFAULTS_VERSION}, over || {});
    return {
        values,
        settings: values,
        fileSettings: values,
        writes: [],
        failWrites: false,
        get(key) { return values[key]; },
        all() { return values; },
        set(key, value, opts) {
            this.writes.push({key, value, opts});
            if (this.failWrites) return false;
            values[key] = value;
            return true;
        },
        merge(changes) { Object.assign(values, changes); return true; }
    };
}

function fakeMainWindow() {
    return {
        toasts: [],
        sent: [],
        sendUpdate(message) { this.toasts.push(message); },
        send(channel, payload) { this.sent.push({channel, payload}); },
        scheduleUnload() {}
    };
}

function build(over) {
    IPC.handlers.clear();
    IPC.listeners.clear();
    SHORTCUTS.registered.clear();
    SHORTCUTS.refuse.clear();
    SHORTCUTS.throwOn.clear();
    // An empty object, not a missing file: no first-run defaults to wade through.
    fs.writeFileSync(HOTKEY_FILE, '{}');
    const settings = fakeSettings(over);
    const mainWindow = fakeMainWindow();
    const hotkeys = new Hotkeys(mainWindow, settings, {getCatalog: () => []});
    return {hotkeys, settings, mainWindow};
}

const invoke = (channel, ...args) => IPC.handlers.get(channel)({}, ...args);
const emit = (channel, ...args) => IPC.listeners.get(channel)({}, ...args);
const readFile = () => JSON.parse(fs.readFileSync(HOTKEY_FILE, 'utf-8'));

test('every channel is registered from the table', () => {
    build();
    for (const channel of ['get-hotkey-conflicts', 'get-hotkey-notice', 'set-hotkeys-game-only',
        'suspend-hotkeys', 'save-hotkeys', 'get-system-hotkeys', 'save-system-hotkey']) {
        assert.ok(IPC.handlers.has(channel), `no handler for ${channel}`);
    }
    for (const channel of ['load-hotkeys', 'delete-hotkey', 'reset-system-hotkey', 'unbind-system-hotkey']) {
        assert.ok(IPC.listeners.has(channel), `no listener for ${channel}`);
    }
});

test('save-hotkeys writes the map binding under mapKey and registers it', async () => {
    build();
    const result = await invoke('save-hotkeys', {hotkey: 'Ctrl+Alt+9', mapKey: 'a/B'});
    assert.strictEqual(result.ok, true);
    const saved = readFile();
    assert.strictEqual(saved['Ctrl+Alt+9'].mapKey, 'a/B');
    assert.ok(SHORTCUTS.registered.has('Ctrl+Alt+9'));
});

test('save-hotkeys refuses in order: both fields, a modifier, a system conflict', async () => {
    const {hotkeys} = build();
    assert.strictEqual((await invoke('save-hotkeys', {hotkey: 'Ctrl+Alt+9'})).message.key,
        'hotkeys.error.pickBoth');
    assert.strictEqual((await invoke('save-hotkeys', {hotkey: 'H', mapKey: 'a/B'})).message.key,
        'hotkeys.error.noModifier');
    const [, systemAccel] = hotkeys.boundSystemHotkeys()[0];
    assert.strictEqual((await invoke('save-hotkeys', {hotkey: systemAccel, mapKey: 'a/B'})).message.key,
        'hotkeys.error.boundTo');
    assert.deepStrictEqual(readFile(), {}, 'a refusal wrote the file');
});

test('an accelerator Electron cannot parse is refused, and every binding is re-registered', async () => {
    // A throw mid-register may have dropped one of our bindings, so the
    // refusal reloads them all. Why: docs/agents/hotkeys.md § Priority, conflicts and registration.
    const {mainWindow} = build();
    SHORTCUTS.throwOn.add('Ctrl+Alt+Nope');
    const loadsBefore = mainWindow.sent.filter(m => m.channel === 'hotkey-updated').length;
    const result = await invoke('save-hotkeys', {hotkey: 'Ctrl+Alt+Nope', mapKey: 'a/B'});
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.message.key, 'hotkeys.error.unregisterable');
    assert.strictEqual(mainWindow.sent.filter(m => m.channel === 'hotkey-updated').length, loadsBefore + 1);
});

test('save-system-hotkey refuses a combination a map already holds', async () => {
    build();
    await invoke('save-hotkeys', {hotkey: 'Ctrl+Alt+9', mapKey: 'a/B'});
    const result = await invoke('save-system-hotkey', {actionId: 'toggle-map', accelerator: 'Ctrl+Alt+9'});
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.message.key, 'hotkeys.error.usedByMap');
});

test('save-system-hotkey writes with rollback and reports a failed write', async () => {
    const {settings} = build();
    const ok = await invoke('save-system-hotkey', {actionId: 'toggle-map', accelerator: 'Ctrl+Alt+F9'});
    assert.strictEqual(ok.ok, true);
    const write = settings.writes[settings.writes.length - 1];
    assert.deepStrictEqual(write.opts, {rollback: true});
    settings.failWrites = true;
    const failed = await invoke('save-system-hotkey', {actionId: 'toggle-map', accelerator: 'Ctrl+Alt+F10'});
    assert.strictEqual(failed.message.key, 'hotkeys.error.saveFailed');
    assert.strictEqual((await invoke('save-system-hotkey', {actionId: 'nope', accelerator: 'Ctrl+Alt+F10'}))
        .message.key, 'hotkeys.error.unknownAction');
});

test('unbind stores the empty string; an unknown action is ignored', () => {
    const {settings, mainWindow} = build();
    emit('unbind-system-hotkey', {actionId: 'toggle-map'});
    assert.strictEqual(settings.values[ACTION_TO_SETTING_KEY['toggle-map']], '');
    assert.strictEqual(mainWindow.toasts.pop().key, 'hotkeys.unbound');
    const writes = settings.writes.length;
    emit('unbind-system-hotkey', {actionId: 'nope'});
    assert.strictEqual(settings.writes.length, writes);
});

test('delete-hotkey removes the entry by id', async () => {
    const {mainWindow} = build();
    await invoke('save-hotkeys', {hotkey: 'Ctrl+Alt+9', mapKey: 'a/B', id: 'fixed-id'});
    emit('delete-hotkey', 'fixed-id');
    assert.deepStrictEqual(readFile(), {});
    assert.strictEqual(mainWindow.toasts.pop().key, 'hotkeys.deleted');
});

test('the notice is handed over once', async () => {
    const {hotkeys} = build();
    hotkeys.pendingNotice = {key: 'hotkeys.defaultsMovedPlain'};
    assert.deepStrictEqual(await invoke('get-hotkey-notice'), {key: 'hotkeys.defaultsMovedPlain'});
    assert.strictEqual(await invoke('get-hotkey-notice'), null);
});
