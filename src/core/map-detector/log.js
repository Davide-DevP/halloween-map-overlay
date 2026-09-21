const RotatingLog = require('../rotating-log');

/**
 * `detector.log`'s **policy** only — the writer is the shared
 * `core/rotating-log.js`. Its own file name (a match writes far more detector
 * lines than app lines, and one file would bury the other), a 512 KB cap, and
 * unbuffered writes, because the line that explains a hang is the last one
 * written before it. **Never a frame or a pixel**: scores, keys, margins and
 * timings only, and every write is wrapped so a full disk costs a log line and
 * not a tick. See `docs/agents/detection.md`.
 */

/** Rotate once the file would pass this. One backup is kept. */
const MAX_BYTES = 512 * 1024;
const LOG_NAME = 'detector.log';

class DetectorLog extends RotatingLog {

    /** @param {?string} dir userData; falsy disables the log rather than throwing */
    constructor(dir, opts = {}) {
        super(dir, {
            limit: MAX_BYTES,
            name: LOG_NAME,
            failMessage: 'Map detection: the event log could not be written:',
            ...opts
        });
    }
}

module.exports = DetectorLog;
module.exports.formatLine = RotatingLog.formatLine;
module.exports.shouldRotate = RotatingLog.shouldRotate;
module.exports.MAX_BYTES = MAX_BYTES;
module.exports.LOG_NAME = LOG_NAME;
