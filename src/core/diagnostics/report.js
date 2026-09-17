'use strict';

const fs = require('fs');
const path = require('path');
const {buildZip} = require('./zip');

/**
 * The diagnostic report: one zip, built from a list of files and a list of
 * generated text blocks.
 *
 * No electron import. The caller (`src/core/diagnostics.js`) decides *which*
 * files and *where* — everything that needs `app.getPath` lives there — and
 * this function does the part worth testing: read what exists, skip what does
 * not, cap anything oversized, and write an archive that opens.
 *
 * Rules:
 * - **Never throws.** The button behind this exists for a user whose app is
 *   already misbehaving; an exception here would be the second thing that went
 *   wrong that minute.
 * - **A missing file is not an error.** `detector.log` only exists once
 *   auto-detect has run, `crash-*.txt` only after a crash, and a report from a
 *   healthy install is still worth having.
 * - **Nothing is collected that was not named by the caller.** No directory is
 *   walked, no glob is expanded here — the file list *is* the contract, which
 *   is what makes "no screenshots, no maps" checkable by reading one function.
 */

/** Anything bigger than this is included as its tail. */
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;

/** Two digits, the only formatting a file name needs. */
function pad(value) {
    return String(value).padStart(2, '0');
}

/**
 * `HalloweenMapOverlay-report-20260917-1423.zip`, in local time — the user
 * reads this name off their own Desktop and says "the 14:23 one".
 * @param {Date|number} [now]
 * @returns {string}
 */
function reportName(now = Date.now()) {
    const d = now instanceof Date ? now : new Date(now);
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    return `HalloweenMapOverlay-report-${stamp}.zip`;
}

/** Read a file, tail-truncated if it is unreasonably large. */
function readCapped(file, maxBytes) {
    const stat = fs.statSync(file);
    if (stat.size <= maxBytes) return fs.readFileSync(file);
    const handle = fs.openSync(file, 'r');
    try {
        const buffer = Buffer.alloc(maxBytes);
        fs.readSync(handle, buffer, 0, maxBytes, stat.size - maxBytes);
        return Buffer.concat([
            Buffer.from(`… truncated: only the last ${maxBytes} bytes of ${stat.size} are included …\n`, 'utf-8'),
            buffer
        ]);
    } finally {
        fs.closeSync(handle);
    }
}

/**
 * Build the report.
 *
 * @param {{files?: Array<string|{path: string, name?: string}>,
 *          texts?: Array<{name: string, text: string}>,
 *          outDir: string, now?: Date|number, name?: string,
 *          maxEntryBytes?: number}} options
 * @returns {{ok: boolean, path: ?string, name: ?string,
 *            entries: Array<{name: string, bytes: number}>,
 *            skipped: string[], error: ?string}}
 */
function buildDiagnosticReport(options = {}) {
    const {outDir, files = [], texts = [], now = Date.now(), maxEntryBytes = MAX_ENTRY_BYTES} = options;
    const result = {ok: false, path: null, name: null, entries: [], skipped: [], error: null};
    if (!outDir) {
        result.error = 'no output directory';
        return result;
    }

    const zipEntries = [];
    const used = new Set();
    /** Two sources with the same basename must not overwrite each other. */
    const uniqueName = (wanted) => {
        let name = wanted;
        let n = 2;
        while (used.has(name.toLowerCase())) {
            const ext = path.extname(wanted);
            name = `${path.basename(wanted, ext)}-${n}${ext}`;
            n++;
        }
        used.add(name.toLowerCase());
        return name;
    };

    for (const item of files) {
        const file = typeof item === 'string' ? item : (item && item.path);
        if (!file) continue;
        const wanted = (typeof item === 'object' && item.name) ? item.name : path.basename(file);
        try {
            if (!fs.existsSync(file)) {
                result.skipped.push(wanted);
                continue;
            }
            const data = readCapped(file, maxEntryBytes);
            const name = uniqueName(wanted);
            zipEntries.push({name, data, date: fs.statSync(file).mtime});
            result.entries.push({name, bytes: data.length});
        } catch (err) {
            // An unreadable file is one missing entry, not a failed report.
            result.skipped.push(wanted);
        }
    }

    for (const block of texts) {
        if (!block || !block.name) continue;
        const data = Buffer.from(block.text === undefined || block.text === null ? '' : String(block.text), 'utf-8');
        const name = uniqueName(block.name);
        zipEntries.push({name, data, date: now instanceof Date ? now : new Date(now)});
        result.entries.push({name, bytes: data.length});
    }

    const fileName = options.name || reportName(now);
    const target = path.join(outDir, fileName);
    try {
        fs.mkdirSync(outDir, {recursive: true});
        fs.writeFileSync(target, buildZip(zipEntries));
    } catch (err) {
        result.error = (err && err.message) || String(err);
        return result;
    }
    result.ok = true;
    result.path = target;
    result.name = fileName;
    return result;
}

module.exports = {buildDiagnosticReport, reportName, MAX_ENTRY_BYTES};
