const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DetectorLog = require('../src/core/map-detector/log');
const {formatLine, shouldRotate, MAX_BYTES, LOG_NAME} = DetectorLog;

/** A throwaway directory per test; never the real userData. */
function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'hmo-detector-log-'));
}

/* ────────────────────────────────────────────────────────────────────────────
 * The line format
 * ──────────────────────────────────────────────────────────────────────────── */

test('formatLine: ISO time, event, then key=value pairs', () => {
    const line = formatLine('match', {key: 'a/One', score: 0.9123, tickMs: 24}, Date.UTC(2026, 8, 17, 12, 0, 0));
    assert.strictEqual(line, '2026-09-17T12:00:00.000Z match key=a/One score=0.912 tickMs=24\n');
});

test('formatLine: one event is always exactly one line', () => {
    const line = formatLine('error', {message: 'boom\nsecond line'}, 0);
    assert.strictEqual(line.split('\n').length, 2, line);
    assert.ok(line.includes('"boom second line"'), line);
});

test('formatLine: a value with a space is quoted, a plain one is not', () => {
    const line = formatLine('match', {key: 'deftyconchgaming/East Haddonfield', changed: 'yes'}, 0);
    assert.ok(line.includes('key="deftyconchgaming/East Haddonfield"'), line);
    assert.ok(line.includes('changed=yes'), line);
});

test('formatLine: null and undefined fields are dropped, 0 and false are not', () => {
    const line = formatLine('menu-streak', {ticks: 0, score: null, of: undefined, kept: false}, 0);
    assert.ok(line.includes('ticks=0'), line);
    assert.ok(!line.includes('score='), line);
    assert.ok(!line.includes('of='), line);
    assert.ok(line.includes('kept=false'), line);
});

test('formatLine: no fields at all is still a valid line', () => {
    assert.strictEqual(formatLine('loop-stop', null, 0), '1970-01-01T00:00:00.000Z loop-stop\n');
});

/* ────────────────────────────────────────────────────────────────────────────
 * Rotation
 * ──────────────────────────────────────────────────────────────────────────── */

test('shouldRotate: only once the limit would actually be passed', () => {
    assert.strictEqual(shouldRotate(100, 10, 1000), false);
    assert.strictEqual(shouldRotate(990, 10, 1000), false);
    assert.strictEqual(shouldRotate(991, 10, 1000), true);
});

test('shouldRotate: an empty file is never rotated, however long the line', () => {
    // Rotating on the very first write would throw the previous run away for
    // nothing.
    assert.strictEqual(shouldRotate(0, 5000, 1000), false);
    assert.strictEqual(shouldRotate(-1, 5000, 1000), false);
});

test('the default limit is 512 KB', () => {
    assert.strictEqual(MAX_BYTES, 512 * 1024);
});

test('DetectorLog: rotates at the limit and keeps exactly one backup', () => {
    const dir = tempDir();
    try {
        const log = new DetectorLog(dir, {limit: 200});
        for (let i = 0; i < 40; i++) log.write('tick', {n: i});
        const file = path.join(dir, LOG_NAME);
        const backup = file + '.1';
        assert.ok(fs.existsSync(file));
        assert.ok(fs.existsSync(backup));
        assert.ok(fs.statSync(file).size <= 200, 'live file over the limit');
        assert.ok(fs.statSync(backup).size <= 200, 'backup over the limit');
        // One backup, not a growing pile.
        const files = fs.readdirSync(dir).sort();
        assert.deepStrictEqual(files, [LOG_NAME, LOG_NAME + '.1']);
        // The most recent events survived the rotation.
        assert.ok(fs.readFileSync(file, 'utf-8').includes('n=39'));
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
});

test('DetectorLog: appends, and the cached size tracks the file', () => {
    const dir = tempDir();
    try {
        const log = new DetectorLog(dir);
        log.write('loop-start', {templates: 4});
        log.write('match', {key: 'a/One', score: 0.98});
        const text = fs.readFileSync(path.join(dir, LOG_NAME), 'utf-8');
        const lines = text.trim().split('\n');
        assert.strictEqual(lines.length, 2);
        assert.ok(lines[0].includes('loop-start templates=4'), lines[0]);
        assert.ok(lines[1].includes('match key=a/One score=0.980'), lines[1]);
        assert.strictEqual(log.size, Buffer.byteLength(text));
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
});

test('DetectorLog: a missing directory costs a line, not a crash', () => {
    // A write failure must never break a detection tick.
    const dir = tempDir();
    try {
        const log = new DetectorLog(path.join(dir, 'does', 'not', 'exist'));
        assert.doesNotThrow(() => log.write('match', {key: 'a/One'}));
        assert.strictEqual(log.failed, true);
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
});

test('DetectorLog: no directory disables it silently', () => {
    const log = new DetectorLog(null);
    assert.strictEqual(log.isEnabled(), false);
    assert.doesNotThrow(() => log.write('match', {key: 'a/One'}));
});

test('DetectorLog: no frame, no pixel — only the fields it is given', () => {
    // The rule the whole feature rests on. A field the caller never passes
    // cannot appear, and the writer adds nothing of its own but the time.
    const dir = tempDir();
    try {
        const log = new DetectorLog(dir);
        log.write('match', {key: 'a/One', score: 0.98, margin: 0.4, tickMs: 22});
        const line = fs.readFileSync(path.join(dir, LOG_NAME), 'utf-8').trim();
        const fields = line.split(' ').slice(2).map(p => p.split('=')[0]);
        assert.deepStrictEqual(fields, ['key', 'score', 'margin', 'tickMs']);
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
});
