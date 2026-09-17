const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RotatingLog = require('../src/core/rotating-log');
const {formatLine, shouldRotate, MAX_BYTES} = RotatingLog;

/** A throwaway directory per test; never the real userData. */
function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'hmo-rotating-log-'));
}

/* ────────────────────────────────────────────────────────────────────────────
 * The line format — the level is the only thing the shared writer added
 * ──────────────────────────────────────────────────────────────────────────── */

test('formatLine: a level sits between the time and the event', () => {
    const line = formatLine('startup', {version: '0.3.2'}, Date.UTC(2026, 8, 17, 12, 0, 0), 'info');
    assert.strictEqual(line, '2026-09-17T12:00:00.000Z info startup version=0.3.2\n');
});

test('formatLine: no level is the detector.log shape, unchanged', () => {
    const line = formatLine('match', {key: 'a/One'}, 0);
    assert.strictEqual(line, '1970-01-01T00:00:00.000Z match key=a/One\n');
    // Explicitly passing a falsy level must behave the same, not print "null".
    assert.strictEqual(formatLine('match', {key: 'a/One'}, 0, null), line);
    assert.strictEqual(formatLine('match', {key: 'a/One'}, 0, ''), line);
});

test('formatLine: a level with whitespace cannot split the line', () => {
    const line = formatLine('e', null, 0, 'very bad');
    assert.strictEqual(line.split('\n').length, 2, line);
    assert.ok(line.includes('very-bad'), line);
});

/* ────────────────────────────────────────────────────────────────────────────
 * Buffered writing
 * ──────────────────────────────────────────────────────────────────────────── */

test('buffered: nothing hits the disk until the flush', () => {
    const dir = tempDir();
    try {
        const log = new RotatingLog(dir, {name: 'app.log', flushMs: 500});
        log.write('one', null, 'info');
        log.write('two', null, 'info');
        assert.strictEqual(fs.existsSync(path.join(dir, 'app.log')), false,
            'a buffered write must not touch the file');
        log.flush();
        const lines = fs.readFileSync(path.join(dir, 'app.log'), 'utf-8').trim().split('\n');
        assert.strictEqual(lines.length, 2);
        assert.ok(lines[0].includes('info one'), lines[0]);
        assert.ok(lines[1].includes('info two'), lines[1]);
        // A second flush with an empty queue must not write an empty line.
        log.flush();
        assert.strictEqual(fs.readFileSync(path.join(dir, 'app.log'), 'utf-8').trim().split('\n').length, 2);
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
});

test('buffered: the timer flushes on its own', async () => {
    const dir = tempDir();
    try {
        const log = new RotatingLog(dir, {name: 'app.log', flushMs: 10});
        log.write('tick', null, 'info');
        await new Promise(resolve => setTimeout(resolve, 60));
        assert.ok(fs.existsSync(path.join(dir, 'app.log')), 'the scheduled flush never ran');
        assert.ok(fs.readFileSync(path.join(dir, 'app.log'), 'utf-8').includes('tick'));
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
});

test('unbuffered: every line is on disk immediately', () => {
    // What detector.log relies on: the last line before a hang is the line
    // that explains it, so it cannot be sitting in a queue.
    const dir = tempDir();
    try {
        const log = new RotatingLog(dir, {name: 'detector.log'});
        log.write('loop-start', {templates: 4});
        assert.ok(fs.readFileSync(path.join(dir, 'detector.log'), 'utf-8').includes('loop-start templates=4'));
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Rotation and the size cap
 * ──────────────────────────────────────────────────────────────────────────── */

test('the size cap holds across a buffered batch', () => {
    // The whole batch is one append, so the rotation decision has to be made
    // on the batch's size, not on one line's.
    const dir = tempDir();
    try {
        const log = new RotatingLog(dir, {name: 'app.log', flushMs: 500, limit: 300});
        for (let i = 0; i < 200; i++) {
            log.write('event', {n: i, padding: 'xxxxxxxxxxxxxxxxxxxx'}, 'info');
            if (i % 5 === 0) log.flush();
        }
        log.flush();
        const file = path.join(dir, 'app.log');
        assert.ok(fs.statSync(file).size <= 300 + 200, 'the live file grew unbounded');
        assert.ok(fs.existsSync(file + '.1'), 'no backup was kept');
        assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['app.log', 'app.log.1']);
        assert.ok(fs.readFileSync(file, 'utf-8').includes('n=199'), 'the newest events were lost');
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
});

test('shouldRotate and the default limit are what the detector expects', () => {
    assert.strictEqual(MAX_BYTES, 512 * 1024);
    assert.strictEqual(shouldRotate(0, 5000, 1000), false);
    assert.strictEqual(shouldRotate(991, 10, 1000), true);
});

/* ────────────────────────────────────────────────────────────────────────────
 * The ring buffer — what a crash report carries
 * ──────────────────────────────────────────────────────────────────────────── */

test('the ring buffer keeps the last N lines and no more', () => {
    const log = new RotatingLog(null, {ringSize: 3});
    for (let i = 0; i < 10; i++) log.write('e', {n: i}, 'info');
    const recent = log.recent();
    assert.strictEqual(recent.length, 3);
    assert.ok(recent[0].includes('n=7'), recent[0]);
    assert.ok(recent[2].includes('n=9'), recent[2]);
    assert.strictEqual(log.recent(2).length, 2);
    assert.strictEqual(log.recent(50).length, 3);
});

test('the ring buffer fills even when the file is disabled', () => {
    // An app whose userData is unwritable still crashes, and the ring buffer
    // is the only context the crash file would have.
    const log = new RotatingLog(null, {ringSize: 5});
    assert.strictEqual(log.isEnabled(), false);
    log.write('boom', {why: 'no dir'}, 'error');
    assert.strictEqual(log.recent().length, 1);
    assert.ok(log.recent()[0].includes('error boom'));
});

/* ────────────────────────────────────────────────────────────────────────────
 * Failure tolerance
 * ──────────────────────────────────────────────────────────────────────────── */

test('a write failure costs a line, not a throw', () => {
    const dir = tempDir();
    try {
        const log = new RotatingLog(path.join(dir, 'does', 'not', 'exist'), {name: 'app.log'});
        assert.doesNotThrow(() => log.write('event', {a: 1}, 'info'));
        assert.strictEqual(log.failed, true);
        // …and it keeps not throwing afterwards, without a second complaint.
        assert.doesNotThrow(() => log.write('event', {a: 2}, 'info'));
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
});

test('a failing flush does not throw either', () => {
    const dir = tempDir();
    try {
        const log = new RotatingLog(path.join(dir, 'nope'), {name: 'app.log', flushMs: 500});
        log.write('event', null, 'info');
        assert.doesNotThrow(() => log.flush());
        assert.strictEqual(log.failed, true);
        assert.strictEqual(log.queue.length, 0, 'a failed batch must not be retried forever');
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
});

test('no directory disables the file half silently', () => {
    const log = new RotatingLog(null);
    assert.strictEqual(log.isEnabled(), false);
    assert.doesNotThrow(() => log.write('event', {a: 1}, 'info'));
    assert.doesNotThrow(() => log.flush());
});
