const fs = require('fs');
const path = require('path');

/**
 * The append-only text log both of this app's logs are built on.
 *
 * Extracted from `map-detector/log.js` in 0.3.2, when the app grew a second
 * log (`app.log`) with the same shape and the same hard rules. The detector's
 * log stays a separate *file* — its volume is an order of magnitude higher and
 * mixing the two would push the interesting lines out of `app.log` within a
 * single match — but the writer is now one implementation.
 *
 * Hard rules, unchanged from the detector's log:
 * - **No frames, no pixels, no paths under the user's profile.** Only
 *   decisions, keys, scores and timings. `src/shared/redact.js` is what turns
 *   a path that slipped into an error message into `~/…`.
 * - **It must never break its caller.** Every write is wrapped; a full disk or
 *   a file a virus scanner is holding open costs a log line, not a tick.
 * - No electron import: the directory is injected, which is also what lets the
 *   tests drive it against a temp folder.
 *
 * Two write modes:
 * - **Unbuffered** (`flushMs: 0`, the detector's): `appendFileSync` per line.
 *   One line per ~700 ms tick, and losing the last line of a session would
 *   lose exactly the line that explains the crash.
 * - **Buffered** (`flushMs: 500`, `app.log`): lines are queued and written in
 *   one batch. A burst (a slider moving writes a `setting` line per pixel)
 *   becomes a single append instead of thirty. Everything that shuts the app
 *   down calls `flush()` first, and the crash handler flushes before it writes
 *   the crash file, so a buffered line is never lost to a crash.
 */

/** Rotate once the file would pass this. One backup is kept. */
const MAX_BYTES = 512 * 1024;
const BACKUP_SUFFIX = '.1';

/**
 * One log line: ISO timestamp, an optional level, the event name, then
 * `key=value` pairs.
 *
 * Values are stringified defensively — a value with a space or a newline in it
 * (a map key, an error message) would otherwise break the one-event-per-line
 * shape that makes the file readable and greppable.
 *
 * @param {string} event
 * @param {?Object} fields
 * @param {number|Date} [at] epoch ms or Date
 * @param {?string} [level] `info`/`warn`/`error`; omitted entirely when falsy,
 *   which is what keeps `detector.log` lines exactly as they were.
 * @returns {string} the line, newline included
 */
function formatLine(event, fields, at = Date.now(), level = null) {
    const time = (at instanceof Date ? at : new Date(at)).toISOString();
    const parts = [time];
    if (level) parts.push(String(level).replace(/\s+/g, '-'));
    parts.push(String(event || 'event').replace(/\s+/g, '-'));
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

class RotatingLog {

    /**
     * @param {?string} dir userData (or any writable directory); a falsy dir
     *   disables the log rather than throwing.
     * @param {{limit?: number, name?: string, flushMs?: number,
     *          ringSize?: number, failMessage?: string}} [opts]
     */
    constructor(dir, opts = {}) {
        this.dir = dir || null;
        this.limit = opts.limit || MAX_BYTES;
        this.name = opts.name || 'app.log';
        this.file = this.dir ? path.join(this.dir, this.name) : null;
        this.backup = this.file ? this.file + BACKUP_SUFFIX : null;
        /** Cached size, so a 700 ms loop does not stat the file every tick. */
        this.size = null;
        /** One console complaint per process if the log cannot be written. */
        this.failed = false;
        this.failMessage = opts.failMessage || `The log ${this.name} could not be written:`;
        /** 0 = append synchronously per line. */
        this.flushMs = opts.flushMs || 0;
        /** Lines waiting for the next flush (buffered mode only). */
        this.queue = [];
        this.timer = null;
        /**
         * Last N lines, in memory, whatever the write mode. This is what the
         * crash report carries: by the time the process is going down, reading
         * the file back is the last thing worth attempting.
         */
        this.ringSize = opts.ringSize || 0;
        this.ring = [];
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
     * @param {?string} [level]
     */
    write(event, fields, level) {
        const line = formatLine(event, fields, Date.now(), level);
        if (this.ringSize > 0) {
            this.ring.push(line);
            if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize);
        }
        if (!this.file) return;
        if (this.flushMs > 0) {
            this.queue.push(line);
            this.schedule();
            return;
        }
        this.append(line);
    }

    /** Arm the flush timer. `unref` so a pending flush never holds the app up. */
    schedule() {
        if (this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.flush();
        }, this.flushMs);
        if (typeof this.timer.unref === 'function') this.timer.unref();
    }

    /** Write everything queued, right now. Never throws. */
    flush() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (!this.queue.length) return;
        const text = this.queue.join('');
        this.queue.length = 0;
        this.append(text);
    }

    /**
     * Append raw text, rotating first if it would not fit. Never throws: a
     * failure costs the line and one console complaint per process.
     * @param {string} text
     */
    append(text) {
        if (!this.file || !text) return;
        const bytes = Buffer.byteLength(text);
        try {
            if (shouldRotate(this.currentSize(), bytes, this.limit)) this.rotate();
            fs.appendFileSync(this.file, text);
            this.size = this.currentSize() + bytes;
        } catch (err) {
            if (!this.failed) {
                this.failed = true;
                console.error(this.failMessage, err && err.message);
            }
        }
    }

    /**
     * The last `count` lines still in memory, oldest first. Empty unless the
     * log was built with a `ringSize`.
     * @param {number} [count]
     * @returns {string[]}
     */
    recent(count) {
        if (!count || count >= this.ring.length) return this.ring.slice();
        return this.ring.slice(this.ring.length - count);
    }

    /**
     * `<name>` → `<name>.1`, replacing any previous backup, and start a fresh
     * file. The old backup is removed first: `rename` over an existing file is
     * fine on both platforms, but an EPERM from a virus scanner holding the
     * backup open would otherwise lose the rotation *and* the new line.
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

module.exports = RotatingLog;
module.exports.formatLine = formatLine;
module.exports.formatValue = formatValue;
module.exports.shouldRotate = shouldRotate;
module.exports.MAX_BYTES = MAX_BYTES;
module.exports.BACKUP_SUFFIX = BACKUP_SUFFIX;
