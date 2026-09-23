'use strict';

const fs = require('fs');
const path = require('path');
const {redactHome} = require('../../shared/redact');
const {errorMessage} = require('../../shared/errors');

/**
 * Crash files: one text file per fatal event, in userData next to the logs.
 * fs-only tier, no electron — the directory is injected, like the logs.
 * See `docs/agents/diagnostics.md`.
 */

const CRASH_PREFIX = 'crash-';
const CRASH_SUFFIX = '.txt';
/** Keep the five most recent; a crash loop must not fill the disk. */
const MAX_CRASH_FILES = 5;
/** Lines of `app.log` carried into the file. */
const RING_LINES = 200;

/**
 * `crash-2026-09-17T14-23-05-123Z.txt` — ISO with the illegal characters out,
 * so the files sort chronologically as plain strings. `lastCrashSeen` and
 * `pruneCrashFiles` rely on that: nothing a copied file could make lie.
 */
function crashFileName(at = Date.now()) {
    const iso = (at instanceof Date ? at : new Date(at)).toISOString();
    return CRASH_PREFIX + iso.replace(/:/g, '-').replace(/\./g, '-') + CRASH_SUFFIX;
}

function isCrashFile(name) {
    return typeof name === 'string' && name.startsWith(CRASH_PREFIX) && name.endsWith(CRASH_SUFFIX);
}

/**
 * The body of a crash file. PRIVACY: message, stack and log lines all go
 * through `redactHome` — the lines were redacted on their way into the log
 * already, but the rule is easier to keep with no exceptions.
 */
function formatCrashReport(info = {}) {
    const at = info.at instanceof Date ? info.at : new Date(info.at || Date.now());
    const home = info.home || null;
    const lines = [
        // ASCII only: a BOM-less text file double-clicked on Windows renders an
        // em dash as mojibake.
        'Halloween Map Overlay - crash report',
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

/** Oldest first; a missing directory is an empty list. File names, not paths. */
function listCrashFiles(dir) {
    if (!dir) return [];
    try {
        return fs.readdirSync(dir).filter(isCrashFile).sort();
    } catch (err) {
        return [];
    }
}

/** Delete all but the `keep` most recent. @returns {string[]} the names removed */
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

/** Never throws: this runs while the process is already on its way down. */
function writeCrashReport(dir, info = {}, keep = MAX_CRASH_FILES) {
    if (!dir) return {ok: false, name: null, path: null, error: 'no directory'};
    const name = crashFileName(info.at || Date.now());
    const target = path.join(dir, name);
    try {
        fs.mkdirSync(dir, {recursive: true});
        fs.writeFileSync(target, formatCrashReport(info), 'utf-8');
    } catch (err) {
        return {ok: false, name: null, path: null, error: errorMessage(err)};
    }
    pruneCrashFiles(dir, keep);
    return {ok: true, name, path: target, error: null};
}

/**
 * The newest crash file not yet acknowledged — a string comparison, since names
 * sort chronologically. An unknown `lastSeen` means *every* file is unseen,
 * which is the safe direction: the banner is dismissible, silence is not.
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
