'use strict';

const fs = require('fs');
const path = require('path');
const {redactHome} = require('../../shared/redact');

/**
 * Crash files: one text file per fatal event, written in userData next to the
 * logs, and the small amount of bookkeeping around them.
 *
 * No electron import — the directory is injected, which is what lets the tests
 * drive this against a temp folder, exactly like the logs.
 *
 * Why a separate file at all, when `app.log` already carries the error line:
 * an `uncaughtException` takes the process with it, so the last thing written
 * to the log is the crash itself and the *context* — the two hundred lines
 * that led there — is only in memory. The crash file is that context, frozen
 * at the moment it still existed. It is also what makes "the app closed
 * unexpectedly last time" answerable on the next start without parsing a log.
 *
 * The name carries the time (`crash-2026-09-17T14-23-05-123Z.txt`) so the
 * files sort chronologically as plain strings, which is what `lastCrashSeen`
 * compares against and what `pruneCrashFiles` orders by. No `Date` parsing, no
 * `stat` calls, nothing that a copied or restored file could make lie.
 */

const CRASH_PREFIX = 'crash-';
const CRASH_SUFFIX = '.txt';
/** Keep the five most recent; a crash loop must not fill the disk. */
const MAX_CRASH_FILES = 5;
/** Lines of `app.log` carried into the file. */
const RING_LINES = 200;

/** `crash-2026-09-17T14-23-05-123Z.txt` — ISO with the illegal characters out. */
function crashFileName(at = Date.now()) {
    const iso = (at instanceof Date ? at : new Date(at)).toISOString();
    return CRASH_PREFIX + iso.replace(/:/g, '-').replace(/\./g, '-') + CRASH_SUFFIX;
}

function isCrashFile(name) {
    return typeof name === 'string' && name.startsWith(CRASH_PREFIX) && name.endsWith(CRASH_SUFFIX);
}

/**
 * The body of a crash file.
 *
 * Everything that could carry a path — the message, the stack — goes through
 * `redactHome` first. The log lines have already been redacted on their way
 * into the log, but they are passed through again: the cost is nothing and the
 * rule is easier to keep when it has no exceptions.
 *
 * @param {{version?: string, electron?: string, platform?: string, arch?: string,
 *          kind?: string, message?: string, stack?: string, recent?: string[],
 *          at?: Date|number, home?: string}} info
 * @returns {string}
 */
function formatCrashReport(info = {}) {
    const at = info.at instanceof Date ? info.at : new Date(info.at || Date.now());
    const home = info.home || null;
    const lines = [
        'Halloween Map Overlay — crash report',
        `time      ${at.toISOString()}`,
        `version   ${info.version || 'unknown'}`,
        `electron  ${info.electron || 'unknown'}`,
        `platform  ${info.platform || 'unknown'} ${info.arch || ''}`.trimEnd(),
        `kind      ${info.kind || 'uncaughtException'}`,
        '',
        'message',
        redactHome(info.message || '(none)', home),
        '',
        'stack',
        redactHome(info.stack || '(none)', home),
        '',
        `last ${RING_LINES} log lines`
    ];
    const recent = Array.isArray(info.recent) ? info.recent : [];
    const tail = recent.length > RING_LINES ? recent.slice(recent.length - RING_LINES) : recent;
    for (const line of tail) lines.push(redactHome(String(line).replace(/\n+$/, ''), home));
    return lines.join('\n') + '\n';
}

/**
 * Crash files in `dir`, oldest first. Never throws — a missing directory is an
 * empty list.
 * @param {string} dir
 * @returns {string[]} file names, not paths
 */
function listCrashFiles(dir) {
    if (!dir) return [];
    try {
        return fs.readdirSync(dir).filter(isCrashFile).sort();
    } catch (err) {
        return [];
    }
}

/**
 * Delete all but the `keep` most recent crash files.
 * @returns {string[]} the names removed
 */
function pruneCrashFiles(dir, keep = MAX_CRASH_FILES) {
    const files = listCrashFiles(dir);
    if (files.length <= keep) return [];
    const doomed = files.slice(0, files.length - keep);
    const removed = [];
    for (const name of doomed) {
        try {
            fs.unlinkSync(path.join(dir, name));
            removed.push(name);
        } catch (err) {
            // A file someone has open is not worth failing a crash write over.
        }
    }
    return removed;
}

/**
 * Write one crash file and prune the pile. Never throws: this runs while the
 * process is already on its way down.
 * @returns {{ok: boolean, name: ?string, path: ?string, error: ?string}}
 */
function writeCrashReport(dir, info = {}, keep = MAX_CRASH_FILES) {
    if (!dir) return {ok: false, name: null, path: null, error: 'no directory'};
    const name = crashFileName(info.at || Date.now());
    const target = path.join(dir, name);
    try {
        fs.mkdirSync(dir, {recursive: true});
        fs.writeFileSync(target, formatCrashReport(info), 'utf-8');
    } catch (err) {
        return {ok: false, name: null, path: null, error: (err && err.message) || String(err)};
    }
    pruneCrashFiles(dir, keep);
    return {ok: true, name, path: target, error: null};
}

/**
 * The newest crash file the user has not been told about yet.
 *
 * Names sort chronologically, so "newer than the last acknowledged one" is a
 * string comparison. An unknown `lastSeen` (a fresh install, a hand-edited
 * settings file) means *every* crash file is unseen, which is the safe
 * direction: the banner is dismissible and the alternative is silence about a
 * crash that really happened.
 *
 * @param {string} dir
 * @param {?string} lastSeen the stored `lastCrashSeen` file name
 * @returns {?string} the file name, or null when there is nothing to report
 */
function pendingCrash(dir, lastSeen) {
    const files = listCrashFiles(dir);
    if (!files.length) return null;
    const newest = files[files.length - 1];
    if (lastSeen && String(lastSeen) >= newest) return null;
    return newest;
}

module.exports = {
    crashFileName,
    isCrashFile,
    formatCrashReport,
    listCrashFiles,
    pruneCrashFiles,
    writeCrashReport,
    pendingCrash,
    CRASH_PREFIX,
    CRASH_SUFFIX,
    MAX_CRASH_FILES,
    RING_LINES
};
