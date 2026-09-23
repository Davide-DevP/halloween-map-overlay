const {test, after} = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {installElectronStub} = require('./helpers/electron-stub');

/*
 * `core/app-log.js`: the singleton, the privacy choke point (every string
 * field through `redactHome`, AGENTS.md rule 3) and the crash file. Every
 * instance below is pointed at a fresh temp dir; the real userData is never
 * touched. The fake home is full of regex metacharacters on purpose.
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hmo-app-log-'));
after(() => fs.rmSync(TMP, {recursive: true, force: true}));

const HOME = 'C:\\Users\\Jane (Doe)+';
let userData = TMP;
const stub = installElectronStub({
    app: {getPath: (name) => (name === 'home' ? HOME : userData)}
});
const appLog = require('../src/core/app-log');
const {AppLog, LOG_NAME, RING_LINES} = appLog;
const {redactHome} = require('../src/shared/redact');
const {isCrashFile} = require('../src/core/diagnostics/crash');

function fresh() {
    userData = fs.mkdtempSync(path.join(TMP, 'u-'));
    return {log: new AppLog().init(), dir: userData};
}

const readLog = (dir) => fs.readFileSync(path.join(dir, LOG_NAME), 'utf-8');
const leaksHome = (text) => redactHome(text, HOME) !== text;

test('the module is one shared instance, not a factory', () => {
    assert.ok(appLog instanceof AppLog);
    assert.strictEqual(require('../src/core/app-log'), appLog);
});

test('before init() nothing reaches the disk, but the ring buffer has it', () => {
    const log = new AppLog();
    log.event('early', {step: 'constructing'});
    assert.strictEqual(log.file(), null);
    assert.match(log.recent().join(''), /early step=constructing/);
});

test('init() with no argument writes under userData, init(dir) where it is told', () => {
    const {log, dir} = fresh();
    assert.strictEqual(log.file(), path.join(dir, LOG_NAME));
    const other = fs.mkdtempSync(path.join(TMP, 'explicit-'));
    const explicit = new AppLog().init(other);
    explicit.event('here');
    explicit.flush();
    assert.match(readLog(other), / info here\n/);
});

test('every string field is redacted, in both separator spellings and any case', () => {
    const {log, dir} = fresh();
    log.event('open', {file: 'C:\\Users\\Jane (Doe)+\\AppData\\x.png'});
    log.warn('open', {file: 'c:/users/jane (doe)+/Desktop/y.png'});
    log.error('boom', {stack: `Error: nope\n    at ${HOME}\\app\\index.js:1:1`, code: 7});
    log.flush();
    const text = readLog(dir);
    assert.strictEqual(leaksHome(text), false, text);
    assert.match(text, /file=~\\AppData\\x\.png/);
    assert.match(text, /code=7/, 'numbers pass through untouched');
});

test('a multi-line value is one line in the file', () => {
    const {log, dir} = fresh();
    log.error('boom', {stack: 'a\nb\nc'});
    log.flush();
    assert.strictEqual(readLog(dir).trim().split('\n').length, 1);
});

test('a non-string field (an Error, an array, a nested object) is redacted too', () => {
    const {log, dir} = fresh();
    const err = new Error(`open '${HOME}\\a.png' failed`);
    log.error('nested', {err, files: [`${HOME}\\b.png`], deep: {path: `${HOME}\\c.png`}});
    log.flush();
    const text = readLog(dir);
    assert.strictEqual(leaksHome(text), false, text);
    assert.match(text, /a\.png/);
    assert.match(text, /b\.png/);
    assert.match(text, /c\.png/);
});

test('the renderer reports errors through main, redacted', () => {
    const {log, dir} = fresh();
    const report = stub.ipc.listeners.get('renderer-error');
    assert.strictEqual(typeof report, 'function');
    report({}, {kind: 'error', message: 'x', stack: `at file:///${HOME.replace(/\\/g, '/')}/a.js`, line: 3});
    log.flush();
    const text = readLog(dir);
    assert.match(text, /where=renderer/);
    assert.strictEqual(leaksHome(text), false, text);
});

test('the ring buffer holds the last RING_LINES lines, redacted', () => {
    const {log} = fresh();
    for (let i = 0; i < RING_LINES + 25; i++) log.event('tick', {i, at: HOME});
    const recent = log.recent();
    assert.strictEqual(recent.length, RING_LINES);
    assert.match(recent[recent.length - 1], new RegExp(`i=${RING_LINES + 24}`));
    assert.strictEqual(leaksHome(recent.join('')), false);
});

test('fatal() writes a redacted crash file next to the log and can leave the process up', () => {
    const {log, dir} = fresh();
    log.event('before-the-crash', {where: `${HOME}\\x`});
    const err = new Error(`ENOENT: open '${HOME}\\AppData\\hotkeys.json'`);
    const name = log.fatal('uncaughtException', err, {quit: false});
    assert.ok(isCrashFile(name), name);
    const crash = fs.readFileSync(path.join(dir, name), 'utf-8');
    assert.match(crash, /kind {6}uncaughtException/);
    assert.match(crash, /before-the-crash/, 'the ring buffer is in the crash file');
    assert.strictEqual(leaksHome(crash), false, crash);
    assert.strictEqual(leaksHome(readLog(dir)), false);
});

test('fatal() with no directory records nothing on disk and does not throw', () => {
    const log = new AppLog();
    assert.strictEqual(log.fatal('uncaughtException', 'plain string', {quit: false}), null);
});

test('collect() counts custom maps and never names them', async () => {
    const {log} = fresh();
    log.setContext({
        mapLibrary: {getCatalog: () => [
            {key: 'deftyconchgaming/Smiths Grove'},
            {key: 'Custom/My Secret Name', custom: true}
        ]},
        settings: {get: () => null, settings: {opacity: 0.5}},
        language: {current: () => 'it'}
    });
    const info = await log.collect();
    assert.strictEqual(info.app.maps, 1);
    assert.strictEqual(info.app.customs, 1);
    assert.strictEqual(info.app.language, 'it');
    assert.deepStrictEqual(info.settings, {opacity: 0.5});
    assert.ok(!JSON.stringify(info).includes('My Secret Name'));
});

test('collect() survives no screen, no GPU info and a catalogue that throws', async () => {
    const {log} = fresh();
    log.setContext({mapLibrary: {getCatalog() { throw new Error('locked'); }}});
    const info = await log.collect();
    assert.deepStrictEqual(info.displays, []);
    assert.ok(info.gpu.error, 'getGPUInfo is missing here, so gpu carries the error');
    assert.strictEqual(info.app.maps, 0);
});

test('logStartup() writes three greppable events and flushes them', async () => {
    const {log, dir} = fresh();
    log.setContext({});
    await log.logStartup();
    const events = readLog(dir).trim().split('\n').map(l => l.split(' ')[2]);
    assert.deepStrictEqual(events, ['startup', 'startup-settings', 'startup-gpu']);
});
