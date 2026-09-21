'use strict';

const zlib = require('node:zlib');

/**
 * A minimal ZIP writer (and matching reader) on `node:zlib`, scoped to exactly
 * what the report needs: a handful of small files, stored or deflated, no
 * directories, no encryption, no zip64. No `archiver` / `adm-zip` — see
 * `docs/agents/diagnostics.md`, which also holds the format traps.
 */

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
/** Deflate needs 2.0; store would be 1.0, but one version for both is simpler. */
const VERSION = 20;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
/** General-purpose bit 11: the file name is UTF-8. */
const FLAG_UTF8 = 0x0800;

/** CRC-32 (IEEE), table built once on first use. */
let CRC_TABLE = null;

function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c;
    }
    CRC_TABLE = table;
    return table;
}

/** @returns {number} unsigned CRC-32 */
function crc32(buffer) {
    const table = crcTable();
    let crc = -1;
    for (let i = 0; i < buffer.length; i++) {
        crc = (crc >>> 8) ^ table[(crc ^ buffer[i]) & 0xFF];
    }
    return (crc ^ -1) >>> 0;
}

/**
 * MS-DOS date/time, the only timestamp the base format has: 2-second
 * resolution from 1980, so anything older is clamped rather than wrapping.
 */
function dosDateTime(date) {
    const d = (date instanceof Date && !isNaN(date.getTime())) ? date : new Date();
    const year = Math.max(1980, d.getFullYear());
    const time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() / 2) & 0x1F);
    const dosDate = (((year - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
    return {time: time & 0xFFFF, date: dosDate & 0xFFFF};
}

function needsUtf8Flag(name) {
    return Buffer.byteLength(name, 'utf-8') !== name.length;
}

/**
 * Build a ZIP archive in memory. The local header carries the sizes and the CRC
 * up front (no data descriptor), which the strictest unpackers want.
 * @param {Array<{name: string, data: Buffer|string, date?: Date}>} entries
 */
function buildZip(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const entry of list) {
        const name = String((entry && entry.name) || '').replace(/^[\\/]+/, '').replace(/\\/g, '/');
        if (!name) continue;
        const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data === undefined || entry.data === null ? '' : String(entry.data), 'utf-8');
        const nameBytes = Buffer.from(name, 'utf-8');
        const {time, date} = dosDateTime(entry.date);
        const flags = needsUtf8Flag(name) ? FLAG_UTF8 : 0;

        let method = METHOD_STORE;
        let payload = raw;
        if (raw.length > 0) {
            // `deflateRawSync`, never `deflateSync`: method 8 is a **raw**
            // deflate stream, and a zlib header makes every tool refuse the file.
            const deflated = zlib.deflateRawSync(raw, {level: zlib.constants.Z_BEST_COMPRESSION});
            // Stored unless deflating actually helped: a "compressed" entry
            // that grew (an empty file becomes 2 bytes) looks broken.
            if (deflated.length < raw.length) {
                method = METHOD_DEFLATE;
                payload = deflated;
            }
        }
        const crc = crc32(raw);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(LOCAL_SIG, 0);
        local.writeUInt16LE(VERSION, 4);
        local.writeUInt16LE(flags, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(payload.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        local.writeUInt16LE(0, 28);
        locals.push(local, nameBytes, payload);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(CENTRAL_SIG, 0);
        central.writeUInt16LE(VERSION, 4);
        central.writeUInt16LE(VERSION, 6);
        central.writeUInt16LE(flags, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt16LE(time, 12);
        central.writeUInt16LE(date, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(payload.length, 20);
        central.writeUInt32LE(raw.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt16LE(0, 30); // extra
        central.writeUInt16LE(0, 32); // comment
        central.writeUInt16LE(0, 34); // disk number
        central.writeUInt16LE(0, 36); // internal attributes
        central.writeUInt32LE(0, 38); // external attributes
        central.writeUInt32LE(offset, 42);
        centrals.push(central, nameBytes);

        offset += local.length + nameBytes.length + payload.length;
    }

    const centralBuffer = Buffer.concat(centrals);
    const count = centrals.length / 2;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(0, 4);  // this disk
    eocd.writeUInt16LE(0, 6);  // disk with the central directory
    eocd.writeUInt16LE(count, 8);
    eocd.writeUInt16LE(count, 10);
    eocd.writeUInt32LE(centralBuffer.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20); // comment length

    return Buffer.concat([...locals, centralBuffer, eocd]);
}

/**
 * Read an archive from its central directory: the round-trip test then proves
 * the bytes are a real zip rather than that the writer agrees with itself.
 * Deliberately strict — an unknown field is an error, not a guess.
 */
function readZip(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error('not a zip: too short');
    let eocd = -1;
    // Scanned, not read at a fixed offset: a file pointed at by hand may carry
    // a trailing comment.
    for (let i = buffer.length - 22; i >= 0; i--) {
        if (buffer.readUInt32LE(i) === EOCD_SIG) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record');
    const count = buffer.readUInt16LE(eocd + 10);
    let pointer = buffer.readUInt32LE(eocd + 16);
    const out = [];
    for (let i = 0; i < count; i++) {
        if (buffer.readUInt32LE(pointer) !== CENTRAL_SIG) throw new Error(`corrupt central directory at entry ${i}`);
        const method = buffer.readUInt16LE(pointer + 10);
        const crc = buffer.readUInt32LE(pointer + 16);
        const compressedSize = buffer.readUInt32LE(pointer + 20);
        const size = buffer.readUInt32LE(pointer + 24);
        const nameLength = buffer.readUInt16LE(pointer + 28);
        const extraLength = buffer.readUInt16LE(pointer + 30);
        const commentLength = buffer.readUInt16LE(pointer + 32);
        const localOffset = buffer.readUInt32LE(pointer + 42);
        const name = buffer.toString('utf-8', pointer + 46, pointer + 46 + nameLength);
        pointer += 46 + nameLength + extraLength + commentLength;

        if (buffer.readUInt32LE(localOffset) !== LOCAL_SIG) throw new Error(`corrupt local header for ${name}`);
        const localNameLength = buffer.readUInt16LE(localOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + localNameLength + localExtraLength;
        const payload = buffer.subarray(start, start + compressedSize);
        let data;
        if (method === METHOD_STORE) data = Buffer.from(payload);
        else if (method === METHOD_DEFLATE) data = zlib.inflateRawSync(payload);
        else throw new Error(`unsupported compression method ${method} for ${name}`);
        if (data.length !== size) throw new Error(`size mismatch for ${name}: ${data.length} vs ${size}`);
        if (crc32(data) !== crc) throw new Error(`CRC mismatch for ${name}`);
        out.push({name, data, method, size, compressedSize});
    }
    return out;
}

module.exports = {
    buildZip,
    readZip,
    crc32,
    dosDateTime,
    METHOD_STORE,
    METHOD_DEFLATE
};
