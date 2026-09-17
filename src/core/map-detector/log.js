const RotatingLog = require('../rotating-log');

/**
 * The detector's event log.
 *
 * Why it exists: the loop's decisions are invisible from the outside. "It did
 * not switch" and "it switched twice" look identical to a player, and the
 * console only exists in a dev run. One appended line per decision, in
 * userData, is what makes a field report actionable — the owner opens the
 * folder and sends the file.
 *
 * Since 0.3.2 the writer itself lives in `src/core/rotating-log.js`, shared
 * with `app.log`. This file is the detector's *policy*: its own file name (the
 * two logs stay separate — a match writes far more detector lines than app
 * lines, and one file would bury the other), its 512 KB cap, and the
 * unbuffered write mode, because the line that explains a hang is the last one
 * written before it.
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

class DetectorLog extends RotatingLog {

    /**
     * @param {?string} dir userData (or any writable directory); a falsy dir
     *   disables the log rather than throwing.
     * @param {{limit?: number, name?: string}} [opts]
     */
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
