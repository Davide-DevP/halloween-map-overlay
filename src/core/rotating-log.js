const fs = require('fs');
const path = require('path');

/**
 * The append-only text writer both logs are built on — fs-only tier, no
 * electron (the directory is injected, which is what lets the tests drive it
 * against a temp folder). See `docs/agents/diagnostics.md`.
 *
 * **No frames, no pixels, no paths under the user's profile**, and **it never
 * breaks its caller**: a full disk costs a log line, not a tick.
 */

/** Rotate once the file would pass this. One backup is kept. */
const MAX_BYTES = 512 * 1024;
const BACKUP_SUFFIX = '.1';

/**
 * One line: ISO timestamp, optional level, event name, `key=value` pairs.
 * `at` is epoch ms or a Date; a falsy `level` is omitted entirely, which is
 * what keeps `detector.log` lines exactly as they were.
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

/** Whitespace gets quoted: one event per line is what keeps the file greppable. */
function formatValue(value) {
    if (typeof value === 'number') {
        return Number.isInteger(value) ? String(value) : value.toFixed(3);
    }
    const text = String(value).replace(/[\r\n]+/g, ' ');
    return /[\s"]/.test(text) ? `"${text.replace(/"/g, "'")}"` : text;
}

/**
 * Would appending `addition` bytes push a file of `size` bytes past `limit`? An
 * empty file is never rotated: the first write would throw away the last run.
 */
function shouldRotate(size, addition, limit = MAX_BYTES) {
    if (!(size > 0)) return false;
    return size + addition > limit;
}

class RotatingLog {

    /**
     * A falsy `dir` disables the log rather than throwing. `opts.flushMs: 0`
     * appends per line (`detector.log`), 500 batches them (`app.log`).
     */
    constructor(dir, opts = {}) {
        this.dir = dir || null;
        this.limit = opts.limit || MAX_BYTES;
        this.name = opts.name || 'app.log';
        this.file = this.dir ? path.join(this.dir, this.name) : null;
        this.backup = this.file ? this.file + BACKUP_SUFFIX : null;
        /** Cached, so a 700 ms loop does not stat the file every tick. */
        this.size = null;
        this.failed = false;
        this.failMessage = opts.failMessage || `The log ${this.name} could not be written:`;
        this.flushMs = opts.flushMs || 0;
        this.queue = [];
        this.timer = null;
        /**
         * Last N lines, in memory whatever the write mode: this is what the
         * crash report carries, because by then reading the file back is the
         * last thing worth attempting.
         */
        this.ringSize = opts.ringSize || 0;
        this.ring = [];
    }

    isEnabled() {
        return !!this.file;
    }

    /** Bytes, 0 when the file does not exist yet. */
    currentSize() {
        if (this.size !== null) return this.size;
        try {
            this.size = fs.statSync(this.file).size;
        } catch (err) {
            this.size = 0;
        }
        return this.size;
    }

    /** Append one event. Never throws. */
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

    /** Rotates first if the text would not fit. Never throws. */
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

    /** Oldest first; empty unless the log was built with a `ringSize`. */
    recent(count) {
        if (!count || count >= this.ring.length) return this.ring.slice();
        return this.ring.slice(this.ring.length - count);
    }

    /**
     * `<name>` → `<name>.1`. The old backup is removed **first**: an EPERM from
     * a scanner holding it open would lose the rotation *and* the new line.
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
