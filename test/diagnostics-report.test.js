const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {buildDiagnosticReport, reportName} = require('../src/core/diagnostics/report');
const {readZip} = require('../src/core/diagnostics/zip');
const {
    crashFileName, formatCrashReport, listCrashFiles, pruneCrashFiles,
    writeCrashReport, pendingCrash, MAX_CRASH_FILES
} = require('../src/core/diagnostics/crash');
const {redactHome, redactCustomMapKeys} = require('../src/shared/redact');
const {CUSTOM_CREATOR} = require('../src/core/map-catalog');

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'hmo-diagnostics-'));
}

function names(zipPath) {
    return readZip(fs.readFileSync(zipPath)).map(e => e.name).sort();
}

/* ────────────────────────────────────────────────────────────────────────────
 * The report itself
 * ──────────────────────────────────────────────────────────────────────────── */

test('reportName is the minute the user will recognise on their Desktop', () => {
    const name = reportName(new Date(2026, 8, 17, 14, 3));
    assert.strictEqual(name, 'HalloweenMapOverlay-report-20260917-1403.zip');
    // Local time, not UTC: the user reads it off their own clock.
    assert.match(reportName(), /^HalloweenMapOverlay-report-\d{8}-\d{4}\.zip$/);
});

test('buildDiagnosticReport: collects what exists, skips what does not', () => {
    const dir = tempDir();
    try {
        const source = path.join(dir, 'data');
        fs.mkdirSync(source);
        fs.writeFileSync(path.join(source, 'app.log'), 'one\ntwo\n');
        fs.writeFileSync(path.join(source, 'settings-app.json'), '{"size":250}');
        const out = path.join(dir, 'out');

        const result = buildDiagnosticReport({
            files: [
                path.join(source, 'app.log'),
                path.join(source, 'app.log.1'),      // never existed
                path.join(source, 'settings-app.json')
            ],
            texts: [{name: 'system.txt', text: 'version = 0.3.2\n'}],
            outDir: out
        });

        assert.strictEqual(result.ok, true);
        assert.deepStrictEqual(result.skipped, ['app.log.1']);
        assert.deepStrictEqual(names(result.path), ['app.log', 'settings-app.json', 'system.txt']);
        const entries = readZip(fs.readFileSync(result.path));
        assert.strictEqual(entries.find(e => e.name === 'app.log').data.toString(), 'one\ntwo\n');
        assert.strictEqual(entries.find(e => e.name === 'system.txt').data.toString(), 'version = 0.3.2\n');
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
});

test('buildDiagnosticReport: nothing at all still produces a readable zip', () => {
    // A brand new install with no logs yet must not hand the user a broken file.
    const dir = tempDir();
    try {
        const result = buildDiagnosticReport({files: [path.join(dir, 'nope.log')], outDir: path.join(dir, 'out')});
        assert.strictEqual(result.ok, true);
        assert.deepStrictEqual(names(result.path), []);
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
});

test('buildDiagnosticReport: two sources with the same name do not overwrite each other', () => {
    const dir = tempDir();
    try {
        fs.mkdirSync(path.join(dir, 'a'));
        fs.mkdirSync(path.join(dir, 'b'));
        fs.writeFileSync(path.join(dir, 'a', 'app.log'), 'A');
        fs.writeFileSync(path.join(dir, 'b', 'app.log'), 'B');
        const result = buildDiagnosticReport({
            files: [path.join(dir, 'a', 'app.log'), path.join(dir, 'b', 'app.log')],
            outDir: dir
        });
        assert.deepStrictEqual(names(result.path), ['app-2.log', 'app.log']);
        const entries = readZip(fs.readFileSync(result.path));
        assert.strictEqual(entries.find(e => e.name === 'app.log').data.toString(), 'A');
        assert.strictEqual(entries.find(e => e.name === 'app-2.log').data.toString(), 'B');
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
});

test('buildDiagnosticReport: an oversized file is included as its tail', () => {
    const dir = tempDir();
    try {
        const file = path.join(dir, 'huge.log');
        fs.writeFileSync(file, 'x'.repeat(5000) + 'THE-END');
        const result = buildDiagnosticReport({files: [file], outDir: dir, maxEntryBytes: 1000});
        const entry = readZip(fs.readFileSync(result.path))[0];
        const text = entry.data.toString('utf-8');
        assert.ok(text.includes('truncated'), 'a truncated file must say so');
        assert.ok(text.endsWith('THE-END'), 'the tail is the interesting end');
        assert.ok(entry.size < 2000, `kept ${entry.size} bytes`);
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
});

test('buildDiagnosticReport: an unwritable output directory is reported, not thrown', () => {
    // The button behind this exists for a user whose app is already
    // misbehaving; an exception would be the second thing to go wrong.
    const dir = tempDir();
    try {
        const file = path.join(dir, 'blocker');
        fs.writeFileSync(file, 'I am a file, not a directory');
        const result = buildDiagnosticReport({files: [], outDir: path.join(file, 'out')});
        assert.strictEqual(result.ok, false);
        assert.ok(result.error, 'no reason given');
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
});

test('buildDiagnosticReport: no output directory is a failed result, not a crash', () => {
    const result = buildDiagnosticReport({files: []});
    assert.strictEqual(result.ok, false);
});

/* ────────────────────────────────────────────────────────────────────────────
 * Crash files
 * ──────────────────────────────────────────────────────────────────────────── */

test('crashFileName sorts chronologically as a plain string', () => {
    const early = crashFileName(Date.UTC(2026, 8, 17, 9, 0, 0));
    const late = crashFileName(Date.UTC(2026, 8, 17, 14, 0, 0));
    assert.ok(early < late, `${early} !< ${late}`);
    assert.match(early, /^crash-2026-09-17T09-00-00-000Z\.txt$/);
    // No ":" — Windows will not create such a file at all.
    assert.ok(!early.includes(':'));
});

test('formatCrashReport carries the ring buffer and the stack', () => {
    const text = formatCrashReport({
        version: '0.3.2',
        electron: '40.4.1',
        platform: 'win32',
        arch: 'x64',
        message: 'boom',
        stack: 'Error: boom\n    at nowhere',
        recent: ['line one\n', 'line two\n'],
        at: new Date(Date.UTC(2026, 8, 17, 12, 0, 0))
    });
    assert.ok(text.includes('2026-09-17T12:00:00.000Z'), text);
    assert.ok(text.includes('0.3.2'));
    assert.ok(text.includes('boom'));
    assert.ok(text.includes('at nowhere'));
    assert.ok(text.includes('line one'));
    assert.ok(text.includes('line two'));
    // The log lines keep one line each — they arrive with their newline on.
    assert.ok(!text.includes('line one\n\n'), text.slice(-120));
});

test('formatCrashReport redacts the home directory out of the stack', () => {
    const text = formatCrashReport({
        message: 'ENOENT: no such file, open C:\\Users\\Marco\\AppData\\Roaming\\x',
        stack: 'at Object.<anonymous> (C:/Users/Marco/app/index.js:1:1)',
        recent: ['read c:\\users\\marco\\thing\n'],
        home: 'C:\\Users\\Marco'
    });
    assert.ok(!/marco/i.test(text), text);
    assert.ok(text.includes('~'), text);
});

test('formatCrashReport survives being handed nothing', () => {
    const text = formatCrashReport();
    assert.ok(text.includes('crash report'));
    assert.ok(text.includes('(none)'));
});

test('writeCrashReport keeps at most five files, newest kept', () => {
    const dir = tempDir();
    try {
        for (let hour = 0; hour < 8; hour++) {
            const written = writeCrashReport(dir, {
                at: new Date(Date.UTC(2026, 8, 17, hour, 0, 0)),
                message: `crash ${hour}`,
                recent: [`line ${hour}\n`]
            });
            assert.strictEqual(written.ok, true, written.error || '');
        }
        const files = listCrashFiles(dir);
        assert.strictEqual(files.length, MAX_CRASH_FILES);
        assert.strictEqual(files.length, 5);
        // The five *newest* — hours 3..7.
        assert.ok(files[0].includes('T03-'), files[0]);
        assert.ok(files[4].includes('T07-'), files[4]);
        assert.ok(fs.readFileSync(path.join(dir, files[4]), 'utf-8').includes('crash 7'));
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
});

test('listCrashFiles ignores everything that is not a crash file', () => {
    const dir = tempDir();
    try {
        fs.writeFileSync(path.join(dir, 'app.log'), '');
        fs.writeFileSync(path.join(dir, 'crash-notes.md'), '');
        fs.writeFileSync(path.join(dir, crashFileName(0)), '');
        assert.deepStrictEqual(listCrashFiles(dir), [crashFileName(0)]);
        // A missing directory is an empty list, never a throw.
        assert.deepStrictEqual(listCrashFiles(path.join(dir, 'gone')), []);
        assert.deepStrictEqual(listCrashFiles(null), []);
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
});

test('pruneCrashFiles leaves a pile under the limit alone', () => {
    const dir = tempDir();
    try {
        for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(dir, crashFileName(Date.UTC(2026, 8, 17, i))), '');
        assert.deepStrictEqual(pruneCrashFiles(dir, 5), []);
        assert.strictEqual(listCrashFiles(dir).length, 3);
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
});

test('pendingCrash: only a crash newer than the acknowledged one', () => {
    const dir = tempDir();
    try {
        assert.strictEqual(pendingCrash(dir, null), null, 'no files, nothing pending');
        const older = crashFileName(Date.UTC(2026, 8, 17, 9));
        const newer = crashFileName(Date.UTC(2026, 8, 17, 14));
        fs.writeFileSync(path.join(dir, older), '');
        fs.writeFileSync(path.join(dir, newer), '');
        // Never acknowledged anything: the newest one is pending.
        assert.strictEqual(pendingCrash(dir, null), newer);
        // Acknowledged the older one: still pending.
        assert.strictEqual(pendingCrash(dir, older), newer);
        // Acknowledged the newest: silence, on this start and every later one.
        assert.strictEqual(pendingCrash(dir, newer), null);
        // A stored name from the future (a restored settings file) is silence,
        // not a banner on every boot.
        assert.strictEqual(pendingCrash(dir, crashFileName(Date.UTC(2027, 0, 1))), null);
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Path redaction — the rule the whole feature rests on
 * ──────────────────────────────────────────────────────────────────────────── */

test('redactHome matches both separator spellings and ignores case', () => {
    const home = 'C:\\Users\\Marco';
    assert.strictEqual(redactHome('C:\\Users\\Marco\\Desktop\\a.png', home), '~\\Desktop\\a.png');
    assert.strictEqual(redactHome('C:/Users/Marco/Desktop/a.png', home), '~/Desktop/a.png');
    assert.strictEqual(redactHome('c:\\users\\marco\\x', home), '~\\x');
    assert.strictEqual(redactHome('at (C:/Users/Marco/a) and (C:\\Users\\Marco\\b)', home), 'at (~/a) and (~\\b)');
});

test('redactHome leaves everything else alone', () => {
    assert.strictEqual(redactHome('nothing to hide', 'C:\\Users\\Marco'), 'nothing to hide');
    assert.strictEqual(redactHome('C:\\Users\\Marco', null), 'C:\\Users\\Marco');
    assert.strictEqual(redactHome('C:\\Users\\Marco', ''), 'C:\\Users\\Marco');
    assert.strictEqual(redactHome(null, 'C:\\Users\\Marco'), '');
    assert.strictEqual(redactHome(42, 'C:\\Users\\Marco'), '42');
});

test('redactHome: a home directory with regex metacharacters is a literal', () => {
    // "C:\Users\a+b(1)" must not become a pattern that matches "C:\Users\ab".
    const home = 'C:\\Users\\a+b(1)';
    assert.strictEqual(redactHome('C:\\Users\\a+b(1)\\x', home), '~\\x');
    assert.strictEqual(redactHome('C:\\Users\\ab\\x', home), 'C:\\Users\\ab\\x');
});

test('redactHome tolerates a trailing separator on the home path', () => {
    assert.strictEqual(redactHome('/home/marco/x', '/home/marco/'), '~/x');
});

/* ────────────────────────────────────────────────────────────────────────────
 * Custom map names in hotkeys.json — the file goes into the report verbatim
 * ──────────────────────────────────────────────────────────────────────────── */

test('redactCustomMapKeys: a custom map name never reaches the report', () => {
    const file = JSON.stringify({
        'CommandOrControl+1': {id: 'a', mapKey: 'deftyconchgaming/East Haddonfield'},
        'CommandOrControl+2': {id: 'b', mapKey: 'Custom/marco private notes'}
    }, null, 2);
    const redacted = redactCustomMapKeys(file, CUSTOM_CREATOR);
    assert.ok(!redacted.includes('marco'), redacted);
    assert.ok(redacted.includes('Custom/(custom)'), redacted);
    // The shipped key is the diagnostic value and must survive untouched.
    assert.ok(redacted.includes('deftyconchgaming/East Haddonfield'), redacted);
    // …and the result is still the JSON a reader expects.
    const parsed = JSON.parse(redacted);
    assert.strictEqual(parsed['CommandOrControl+2'].mapKey, 'Custom/(custom)');
    assert.strictEqual(parsed['CommandOrControl+1'].id, 'a');
});

test('redactCustomMapKeys: the name stops at the closing quote, not later', () => {
    const file = '{"k": {"mapKey": "Custom/a name", "id": "keep-me"}}';
    const redacted = redactCustomMapKeys(file);
    assert.strictEqual(redacted, '{"k": {"mapKey": "Custom/(custom)", "id": "keep-me"}}');
});

test('redactCustomMapKeys: a name with an escaped quote cannot end the match early', () => {
    const file = JSON.stringify({k: {mapKey: 'Custom/say "hi" marco'}});
    const redacted = redactCustomMapKeys(file);
    assert.ok(!redacted.includes('marco'), redacted);
    assert.strictEqual(JSON.parse(redacted).k.mapKey, 'Custom/(custom)');
});

test('redactCustomMapKeys: a file that will not parse is still redacted', () => {
    // A corrupt hotkeys.json is itself worth seeing in a report, which is why
    // the redaction is textual rather than a parse-and-rewrite.
    const broken = '{"k": {"mapKey": "Custom/marco secret"';
    const redacted = redactCustomMapKeys(broken);
    assert.ok(!redacted.includes('marco'), redacted);
    assert.throws(() => JSON.parse(redacted));
});

test('redactCustomMapKeys: nothing custom means nothing changes', () => {
    const file = '{"CommandOrControl+1": {"id": "a", "mapKey": "deftyconchgaming/Haddonfield"}}';
    assert.strictEqual(redactCustomMapKeys(file), file);
    assert.strictEqual(redactCustomMapKeys(null), '');
    assert.strictEqual(redactCustomMapKeys(''), '');
});

test('the reserved creator the redaction keys on is the catalogue\'s own', () => {
    // If `CUSTOM_CREATOR` is ever renamed, this redaction must follow it
    // rather than keep matching a string nothing produces any more.
    assert.strictEqual(CUSTOM_CREATOR, 'Custom');
});
