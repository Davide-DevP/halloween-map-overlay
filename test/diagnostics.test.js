const {test, after} = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {installElectronStub} = require('./helpers/electron-stub');

/*
 * `core/diagnostics.js`: the *Create diagnostic report* IPC, the file list,
 * `system.txt` and the crash notice. The privacy oracle is `redactHome`
 * (AGENTS.md rule 3): every userData below lives under one temp root that
 * plays the user's home, so any absolute path that reaches the zip is caught,
 * as is a custom map name the user typed.
 */
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hmo-diagnostics-'));
after(() => fs.rmSync(HOME, {recursive: true, force: true}));

const SECRET = 'Jane Private Map';
// A controller's `Gamepad.id` names a device on the user's PC.
const PAD_SECRET = 'Janes Pad (STANDARD GAMEPAD Vendor: 054c Product: 09cc)';
const paths = {userData: HOME, desktop: HOME};
const shown = [];
const stub = installElectronStub({
    app: {getPath: (name) => (name === 'home' ? HOME : paths[name])},
    electron: {shell: {showItemInFolder: (p) => shown.push(p), openPath: async () => '', openExternal() {}}}
});
const appLog = require('../src/core/app-log');
const Diagnostics = require('../src/core/diagnostics');
const {LOG_FILES} = Diagnostics;
const {readZip} = require('../src/core/diagnostics/zip');
const {writeCrashReport} = require('../src/core/diagnostics/crash');
const {redactHome} = require('../src/shared/redact');
const {fakeSettings} = require('./helpers/fake-settings');

/** A userData that looks like a real one after a bad day. */
function build(over) {
    paths.userData = fs.mkdtempSync(path.join(HOME, 'userData-'));
    paths.desktop = fs.mkdtempSync(path.join(HOME, 'Desktop-'));
    const dir = paths.userData;
    appLog.init(dir);
    appLog.event('open-failed', {message: `ENOENT: open '${path.join(dir, 'custom', 'x.png')}'`});
    appLog.flush();
    fs.writeFileSync(path.join(dir, 'detector.log'), 'decision=none\n');
    fs.writeFileSync(path.join(dir, 'settings-app.json'), JSON.stringify({opacity: 0.5, tabMarkerPadId: PAD_SECRET}));
    fs.writeFileSync(path.join(dir, 'hotkeys.json'), JSON.stringify({
        'CommandOrControl+Alt+1': 'deftyconchgaming/Smiths Grove',
        'CommandOrControl+Alt+2': `Custom/${SECRET}`
    }));
    // Things that must never be collected.
    fs.mkdirSync(path.join(dir, 'custom'));
    fs.writeFileSync(path.join(dir, 'custom', `${SECRET}.png`), 'not a png');
    fs.writeFileSync(path.join(dir, 'screenshot.png'), 'pixels');
    writeCrashReport(dir, {at: Date.UTC(2026, 0, 1), message: `boom in ${dir}`, stack: 'at x', home: HOME});
    writeCrashReport(dir, {at: Date.UTC(2026, 0, 2), message: 'boom', stack: 'at y', home: HOME});
    const toasts = [];
    const settings = fakeSettings(Object.assign({hotkeyRotateMap: '', tabMarkerPadId: PAD_SECRET}, over));
    // system.txt reads the settings through the log's startup context.
    appLog.setContext({settings});
    const diagnostics = new Diagnostics({sendUpdate: (m) => toasts.push(m)}, settings);
    return {diagnostics, dir, toasts, settings};
}

function zipOf(name) {
    const file = [paths.desktop, paths.userData].map(d => path.join(d, name)).find(f => fs.existsSync(f));
    return readZip(fs.readFileSync(file));
}

test('the IPC surface: the report and the two crash-notice channels', () => {
    build();
    for (const channel of ['create-diagnostic-report', 'get-crash-notice', 'dismiss-crash-notice']) {
        assert.ok(stub.ipc.handlers.has(channel), channel);
    }
});

test('the report lands on the Desktop, says so, and is shown in its folder', async () => {
    const {toasts} = build();
    shown.length = 0;
    const answer = await stub.invoke('create-diagnostic-report');
    assert.strictEqual(answer.ok, true);
    assert.ok(fs.existsSync(path.join(paths.desktop, answer.name)));
    assert.deepStrictEqual(toasts, [{key: 'diagnostics.created', params: {file: answer.name}}]);
    assert.deepStrictEqual(shown, [path.join(paths.desktop, answer.name)]);
});

test('the zip holds the named list and nothing else: no images, no custom folder', async () => {
    const {dir, diagnostics} = build();
    const answer = await diagnostics.create();
    const names = zipOf(answer.name).map(e => e.name).sort();
    const crashes = fs.readdirSync(dir).filter(n => n.startsWith('crash-'));
    const present = LOG_FILES.filter(n => fs.existsSync(path.join(dir, n)));
    assert.deepStrictEqual(names, [...present, ...crashes, 'system.txt', 'hotkeys.json', 'settings-app.json'].sort());
    assert.ok(!LOG_FILES.includes('settings-app.json'), 'settings-app.json must go in redacted, not verbatim');
    assert.ok(!names.some(n => /\.png$/i.test(n)));
    assert.strictEqual(answer.entries, names.length);
});

test('rule 3: no entry carries a path under home, a custom map name or a controller id', async () => {
    const {diagnostics} = build();
    // The startup settings line is where the whole settings object reaches app.log.
    await appLog.logStartup();
    const answer = await diagnostics.create();
    for (const entry of zipOf(answer.name)) {
        const text = entry.data.toString('utf-8');
        assert.strictEqual(redactHome(text, HOME), text, `${entry.name} leaks a home path`);
        assert.ok(!text.includes(SECRET), `${entry.name} names a custom map`);
        assert.ok(!text.includes('Janes Pad'), `${entry.name} names a controller`);
    }
});

test('settings-app.json goes in with the chosen controller as (set)', async () => {
    const {diagnostics} = build();
    const text = diagnostics.redactedSettings();
    assert.deepStrictEqual(JSON.parse(text), {opacity: 0.5, tabMarkerPadId: '(set)'});
    const system = await diagnostics.systemText();
    assert.match(system, /^tabMarkerPadId = "\(set\)"$/m);
});

test('hotkeys.json goes in redacted, keeping the shipped map keys', async () => {
    const {diagnostics} = build();
    const text = diagnostics.redactedHotkeys();
    assert.match(text, /Custom\/\(custom\)/);
    assert.match(text, /deftyconchgaming\/Smiths Grove/);
});

test('no hotkeys.json is no entry, not an empty one', async () => {
    const {diagnostics, dir} = build();
    fs.unlinkSync(path.join(dir, 'hotkeys.json'));
    assert.strictEqual(diagnostics.redactedHotkeys(), null);
    const answer = await diagnostics.create();
    assert.ok(!zipOf(answer.name).some(e => e.name === 'hotkeys.json'));
});

test('an unreadable hotkeys.json does not put its path in the report', () => {
    const {diagnostics, dir} = build();
    const realRead = fs.readFileSync;
    fs.readFileSync = function (file, ...rest) {
        if (String(file).endsWith('hotkeys.json')) {
            throw new Error(`EBUSY: resource busy or locked, open '${path.join(dir, 'hotkeys.json')}'`);
        }
        return realRead.call(this, file, ...rest);
    };
    try {
        const text = diagnostics.redactedHotkeys();
        assert.strictEqual(redactHome(text, HOME), text, text);
    } finally {
        fs.readFileSync = realRead;
    }
});

test('a Desktop that cannot be written falls back to userData and says where', async () => {
    const {diagnostics, dir, toasts} = build();
    // A file where the folder should be: every write "into" it fails.
    const blocked = path.join(HOME, `not-a-folder-${Date.now()}`);
    fs.writeFileSync(blocked, '');
    paths.desktop = blocked;
    const answer = await diagnostics.create();
    assert.strictEqual(answer.ok, true);
    assert.ok(fs.existsSync(path.join(dir, answer.name)));
    assert.deepStrictEqual(toasts, [{key: 'diagnostics.createdFallback', params: {file: answer.name}}]);
});

test('system.txt: ASCII only, unbound hotkeys spelled out, every section present', async () => {
    const {diagnostics} = build();
    const text = await diagnostics.systemText();
    assert.ok(/^[\x00-\x7f]*$/.test(text), 'system.txt must be ASCII');
    for (const section of ['[app]', '[displays]', '[gpu]', '[settings]', '[health]',
        '[map packs]', '[markers]', '[crash files]']) {
        assert.ok(text.includes(`\n${section}\n`), section);
    }
    assert.match(text, /^hotkeyRotateMap = \(unbound\)$/m);
    assert.match(text, /^hotkeys = all registered$/m);
    assert.match(text, /^installed = \(none\)$/m);
    assert.match(text, /^controller button = none \(the controller is not read\)/m);
    assert.match(text, /^crash-2026-01-02T/m);
});

test('system.txt reports what the injected getters say', async () => {
    const {diagnostics} = build();
    diagnostics.setHealthCheck(() => [{accelerator: 'CommandOrControl+Alt+1', action: null, reason: 'taken'}]);
    diagnostics.setHotkeyState(() => ({gameOnly: true, active: false, foreground: 'other', gameRunning: false}));
    diagnostics.setWindowState(() => ({loaded: false, busy: ['modal']}));
    diagnostics.setDetectorSource(() => ({mode: 'in-process', reason: 'spawn-failed', restarts: 2}));
    diagnostics.setMapPacks(() => ({
        enabled: false, lastCheckAt: Date.UTC(2026, 8, 1), lastResult: 'failed', lastError: 'timeout',
        packs: [{key: 'someone/New Map', version: 3}], skipped: [{dir: 'broken', reason: 'hash'}]
    }));
    const text = await diagnostics.systemText();
    assert.match(text, /^hotkeys = 1 could not be registered$/m);
    assert.match(text, /^ {2}CommandOrControl\+Alt\+1 \(map hotkey\) - taken$/m);
    assert.match(text, /^hotkeysGameOnly = on$/m);
    assert.match(text, /^main window = unloaded$/m);
    assert.match(text, /^main window held by = modal$/m);
    assert.match(text, /^detector = in-process \(spawn-failed\), 2 restart\(s\)$/m);
    assert.match(text, /^checkForMapPacks = off$/m);
    assert.match(text, /^last result = failed \(timeout\)$/m);
    assert.match(text, /^installed = someone\/New Map v3$/m);
    assert.match(text, /^skipped = broken \(hash\)$/m);
});

test('a system.txt that fails is a line in the report, not a missing report', async () => {
    const {diagnostics} = build();
    diagnostics.setMarkers(() => { throw new Error('markers exploded'); });
    const answer = await diagnostics.create();
    assert.strictEqual(answer.ok, true);
    const system = zipOf(answer.name).find(e => e.name === 'system.txt').data.toString('utf-8');
    assert.match(system, /^system report failed: markers exploded/);
});

test('the crash notice offers the newest unseen crash, once dismissed never again', async () => {
    const {settings, dir} = build({lastCrashSeen: null});
    const newest = fs.readdirSync(dir).filter(n => n.startsWith('crash-')).sort().pop();
    assert.deepStrictEqual(await stub.invoke('get-crash-notice'), {file: newest});
    assert.deepStrictEqual(await stub.invoke('dismiss-crash-notice'), {ok: true});
    assert.strictEqual(settings.get('lastCrashSeen'), newest);
    assert.strictEqual(await stub.invoke('get-crash-notice'), null);
});

test('with no crash files there is nothing to offer or acknowledge', async () => {
    const {settings, dir} = build({lastCrashSeen: null});
    for (const name of fs.readdirSync(dir).filter(n => n.startsWith('crash-'))) fs.unlinkSync(path.join(dir, name));
    assert.strictEqual(await stub.invoke('get-crash-notice'), null);
    await stub.invoke('dismiss-crash-notice');
    assert.strictEqual(settings.get('lastCrashSeen'), null);
});
