const {test} = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');

const {buildZip, readZip, crc32, METHOD_STORE, METHOD_DEFLATE} = require('../src/core/diagnostics/zip');

/* ────────────────────────────────────────────────────────────────────────────
 * CRC-32 — the one arithmetic detail a reader will reject the file over
 * ──────────────────────────────────────────────────────────────────────────── */

test('crc32 matches the published check values', () => {
    // "123456789" → 0xCBF43926 is the IEEE check value every CRC-32
    // implementation is verified against.
    assert.strictEqual(crc32(Buffer.from('123456789')), 0xCBF43926);
    assert.strictEqual(crc32(Buffer.alloc(0)), 0);
    // Unsigned, always: a signed result writes as 0xFFFFFFFF-ish garbage.
    assert.ok(crc32(Buffer.from([0xFF, 0xFF, 0xFF, 0xFF])) >= 0);
});

/* ────────────────────────────────────────────────────────────────────────────
 * The round trip the spec asks for: three files, one empty, one 2 MB
 * ──────────────────────────────────────────────────────────────────────────── */

test('round trip: three files including an empty one and a 2 MB one', () => {
    const big = Buffer.alloc(2 * 1024 * 1024);
    // Not zeros: an all-zero 2 MB file compresses to nothing and would prove
    // very little about the deflate path.
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + (i >> 7)) & 0xFF;
    const entries = [
        {name: 'app.log', data: Buffer.from('2026-09-17T12:00:00.000Z info startup version=0.3.2\n', 'utf-8')},
        {name: 'empty.log', data: Buffer.alloc(0)},
        {name: 'detector.log', data: big}
    ];
    const zip = buildZip(entries);
    const read = readZip(zip);

    assert.deepStrictEqual(read.map(e => e.name), ['app.log', 'empty.log', 'detector.log']);
    for (let i = 0; i < entries.length; i++) {
        assert.ok(read[i].data.equals(entries[i].data), `${entries[i].name} did not survive the round trip`);
        assert.strictEqual(read[i].size, entries[i].data.length);
    }
    // An empty file is stored, never "compressed" into two bytes of deflate.
    assert.strictEqual(read[1].method, METHOD_STORE);
    assert.strictEqual(read[1].compressedSize, 0);
});

test('round trip: the payload is a raw deflate stream node can inflate on its own', () => {
    // The mistake this catches is `deflateSync` instead of `deflateRawSync`:
    // method 8 in a zip has no zlib header, and every unpacker refuses a file
    // that has one. Inflating the bytes directly, without our reader, is the
    // only way to prove it.
    const text = Buffer.from('log line\n'.repeat(500), 'utf-8');
    const zip = buildZip([{name: 'a.log', data: text}]);
    const read = readZip(zip);
    assert.strictEqual(read[0].method, METHOD_DEFLATE, 'repetitive text should have been deflated');

    // Locate the payload by hand from the local header, exactly as a third
    // party tool would.
    assert.strictEqual(zip.readUInt32LE(0), 0x04034b50);
    const nameLength = zip.readUInt16LE(26);
    const extraLength = zip.readUInt16LE(28);
    const compressedSize = zip.readUInt32LE(18);
    const start = 30 + nameLength + extraLength;
    const inflated = zlib.inflateRawSync(zip.subarray(start, start + compressedSize));
    assert.ok(inflated.equals(text));
});

test('an entry that deflate would grow is stored instead', () => {
    // Random bytes do not compress; a "compressed" entry larger than the
    // original is a lie the reader has to undo for nothing.
    const random = Buffer.alloc(4096);
    for (let i = 0; i < random.length; i++) random[i] = (Math.random() * 256) | 0;
    const read = readZip(buildZip([{name: 'noise.bin', data: random}]));
    assert.strictEqual(read[0].method, METHOD_STORE);
    assert.ok(read[0].data.equals(random));
});

test('a string entry is written as UTF-8', () => {
    const read = readZip(buildZip([{name: 'system.txt', data: 'città — piccolo'}]));
    assert.strictEqual(read[0].data.toString('utf-8'), 'città — piccolo');
});

/* ────────────────────────────────────────────────────────────────────────────
 * Shape of the archive
 * ──────────────────────────────────────────────────────────────────────────── */

test('the end-of-central-directory record counts the entries', () => {
    const zip = buildZip([
        {name: 'one.txt', data: 'one'},
        {name: 'two.txt', data: 'two'}
    ]);
    const eocd = zip.length - 22;
    assert.strictEqual(zip.readUInt32LE(eocd), 0x06054b50);
    assert.strictEqual(zip.readUInt16LE(eocd + 8), 2);
    assert.strictEqual(zip.readUInt16LE(eocd + 10), 2);
    // The central directory has to start where the record says it does.
    const offset = zip.readUInt32LE(eocd + 16);
    assert.strictEqual(zip.readUInt32LE(offset), 0x02014b50);
});

test('an empty archive is still a valid zip', () => {
    // A report from a brand new install with nothing to collect must not be a
    // file no unpacker will open.
    const zip = buildZip([]);
    assert.strictEqual(zip.length, 22);
    assert.deepStrictEqual(readZip(zip), []);
});

test('backslashes and leading slashes are normalised out of entry names', () => {
    // A zip path separator is "/", and a leading one makes the entry absolute,
    // which unpackers either refuse or, worse, obey.
    const read = readZip(buildZip([{name: '/logs\\app.log', data: 'x'}]));
    assert.strictEqual(read[0].name, 'logs/app.log');
});

test('readZip rejects something that is not one of ours', () => {
    assert.throws(() => readZip(Buffer.from('not a zip at all, not even close')), /not a zip/);
    assert.throws(() => readZip(Buffer.alloc(4)), /too short/);
    // A corrupted payload must fail loudly rather than return silent garbage.
    const zip = buildZip([{name: 'a.log', data: 'log line\n'.repeat(500)}]);
    zip[40] = zip[40] ^ 0xFF;
    assert.throws(() => readZip(zip));
});
