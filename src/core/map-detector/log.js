const fs = require('fs');
const path = require('path');

/**
 * The detector's event log.
 *
 * Why it exists: the loop's decisions are invisible from the outside. "It did
 * not switch" and "it switched twice" look identical to a player, and the
 * console only exists in a dev run. One appended line per decision, in
 * userData, is what makes a field report actionable — the owner opens the
 * folder and sends the file.
 *
 * Hard rules:
 * - **No frames, no pixels, ever.** Only scores, keys, margins and timings.
 * - **It must never break detection.** Every write is wrapped; a full disk or a
 *   locked file costs a log line, not a tick.
 * - No electron import: the directory is injected, which is also what lets the
 *   tests drive it against a temp folder.
 */

/** Rotate once the file would pass this. One backup is kept. */
const MAX_BYTES = 512 * 1024;
const LOG_NAME = 'detector.log';
const BACKUP_SUFFIX = '.1';

/**
 * One log line: ISO timestamp, event name, then `key=value` pairs.
 *
 * Values are stringified defensively — a value with a space or a newline in it
 * (a map key, an error message) would otherwise break the one-event-per-line
 * shape that makes the file readable and greppable.
 *
 * @param {string} event
 * @param {?Object} fields
 * @param {number|Date} [at] epoch ms or Date
 * @returns {string} the line, newline included
 */
function formatLine(event, fields, at = Date.now()) {
    const time = (at instanceof Date ? at : new Date(at)).toISOString();
    const parts = [time, String(event || 'event').replace(/\s+/g, '-')];
    for (const [key, value] of Object.entries(fields || {})) {
        if (value === undefined || value === null) continue;
        parts.push(`${key}=${formatValue(value)}`);
    }
    return parts.join(' ') + '\n';
}

/** Numbers stay bare, anything with whitespace gets quoted. */
function formatValue(value) {
    if (typeof value === 'number') {
        return Number.isInteger(value) ? String(value) : value.toFixed(3);
    }
    const text = String(value).replace(/[\r\n]+/g, ' ');
    return /[\s"]/.test(text) ? `"${text.replace(/"/g, "'")}"` : text;
}

/**
 * Would appending `addition` bytes push the file past the limit?
 *
 * An empty file is never rotated, however big the line is: rotating on the
 * first write would throw away the previous run's log for nothing.
 *
 * @param {number} size current file size in bytes
 * @param {number} addition bytes about to be appended
 * @param {number} [limit]
 * @returns {boolean}
 */
function shouldRotate(size, addition, limit = MAX_BYTES) {
    if (!(size > 0)) return false;
    return size + addition > limit;
}

class DetectorLog {

    /**
     * @param {?string} dir userData (or any writable directory); a falsy dir
     *   disables the log rather than throwing.
     * @param {{limit?: number, name?: string}} [opts]
     */
    constructor(dir, opts = {}) {
        this.dir = dir || null;
        this.limit = opts.limit || MAX_BYTES;
        this.name = opts.name || LOG_NAME;
        this.file = this.dir ? path.join(this.dir, this.name) : null;
        this.backup = this.file ? this.file + BACKUP_SUFFIX : null;
        /** Cached size, so a 700 ms loop does not stat the file every tick. */
        this.size = null;
        /** One console complaint per process if the log cannot be written. */
        this.failed = false;
    }

    /** @returns {boolean} */
    isEnabled() {
        return !!this.file;
    }

    /** Current size in bytes, 0 when the file does not exist yet. */
    currentSize() {
        if (this.size !== null) return this.size;
        try {
            this.size = fs.statSync(this.file).size;
        } catch (err) {
            this.size = 0;
        }
        return this.size;
    }

    /**
     * Append one event. Never throws.
     * @param {string} event
     * @param {?Object} [fields]
     */
    write(event, fields) {
        if (!this.file) return;
        const line = formatLine(event, fields);
        const bytes = Buffer.byteLength(line);
        try {
            if (shouldRotate(this.currentSize(), bytes, this.limit)) this.rotate();
            fs.appendFileSync(this.file, line);
            this.size = this.currentSize() + bytes;
        } catch (err) {
            if (!this.failed) {
                this.failed = true;
                console.error('Map detection: the event log could not be written:', err && err.message);
            }
        }
    }

    /**
     * `detector.log` → `detector.log.1`, replacing any previous backup, and
     * start a fresh file. The old backup is removed first: `rename` over an
     * existing file is fine on both platforms, but an EPERM from a virus
     * scanner holding the backup open would otherwise lose the rotation *and*
     * the new line.
     */
    rotate() {
        try {
            if (fs.existsSync(this.backup)) fs.unlinkSync(this.backup);
        } catch (err) {
            // Keep going: the rename below may still succeed.
        }
        fs.renameSync(this.file, this.backup);
        this.size = 0;
    }
}

module.exports = DetectorLog;
module.exports.formatLine = formatLine;
module.exports.shouldRotate = shouldRotate;
module.exports.MAX_BYTES = MAX_BYTES;
module.exports.LOG_NAME = LOG_NAME;
