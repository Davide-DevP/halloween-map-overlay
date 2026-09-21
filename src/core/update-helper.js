'use strict';

const fs = require('fs');
const path = require('path');
const {spawn} = require('child_process');

/**
 * The app side of the themed updater (`hmo-updater.exe`) — tier 1 of
 * `MainWindow.installUpdate()`. fs-only tier: **no electron import**, so every
 * path, bound and clock is injected. **Failing is cheap by construction**: the
 * app does not quit until the helper has written its ready-file, so a missing
 * folder, a quarantined exe or a slow start all end as a log line and the stock
 * installer. docs/SPEC-UPDATER.md §5, docs/agents/updater-and-installer.md.
 */

const HELPER_DIR_NAME = 'updater';
const HELPER_EXE = 'hmo-updater.exe';

/** The stale cleanup keys on this, inside a cache that also holds `pending/`. */
const HELPER_PREFIX = 'helper-';

/**
 * 4 s is generous for a 90 KB WPF process and unnoticeable to a user. It is
 * also the whole antivirus story: a blocked exe never writes the file, the wait
 * expires, and the update happens the old way.
 */
const READY_TIMEOUT_MS = 4000;
const READY_POLL_MS = 100;

/** `<ready-file>.abort`; `updater/Runner.cs` (`AbortSuffix`) has the same literal. */
const ABORT_SUFFIX = '.abort';

/** Stale helper copies are swept on the next start. */
const STALE_MS = 60 * 60 * 1000;

/** The helper clamps to this too; both sides agree with docs/SPEC-UPDATER.md §1. */
const MIN_WIDTH = 560;
const MIN_HEIGHT = 380;

/** Where electron-builder puts `build.extraResources`. */
function helperSourceDir(resourcesPath) {
    return path.join(resourcesPath, HELPER_DIR_NAME);
}

/**
 * `helper-0.5.1-a3f19c`: the version says which update left a stray folder
 * behind, and the random tail keeps two attempts from sharing a directory one
 * of them is about to delete.
 */
function helperFolderName(version, random) {
    const clean = String(version || '0.0.0').replace(/[^0-9A-Za-z._-]/g, '');
    const tail = random || Math.random().toString(16).slice(2, 8);
    return `${HELPER_PREFIX}${clean}-${tail}`;
}

/** electron-builder always writes this key into `resources/app-update.yml`. */
const CACHE_DIR_NAME_KEY = /^updaterCacheDirName:\s*(.+)$/m;

/** No YAML dependency: the file is generated and this is its only key we read. */
function updaterCacheDirName(yml) {
    if (typeof yml !== 'string') return null;
    const match = yml.match(CACHE_DIR_NAME_KEY);
    if (!match) return null;
    const value = match[1].trim().replace(/^['"]|['"]$/g, '');
    return value || null;
}

/**
 * Where the working copy of the helper lives: **electron-updater's own cache
 * directory**, the folder that already holds `pending\<Setup>.exe`.
 *
 * **Never `%TEMP%`, and that is not a preference.** An unsigned installer run
 * from there made Bitdefender's ATD kill the whole launching process tree and
 * neutralise the installer file: it is a textbook malware shape, and a
 * heuristic cannot tell us from it. The updater cache is the one location with
 * evidence that this is tolerated — docs/agents/updater-and-installer.md.
 *
 * The four branches below are in order of how much they are trusted, from the
 * library's own answer down to electron-updater's last resort.
 * @returns {?string} null when nothing usable was supplied
 */
function helperHome(options = {}) {
    const {cacheDir, installerPath, localAppData, appName, cacheDirName} = options;
    if (cacheDir) return cacheDir;
    if (installerPath) {
        const parent = path.dirname(installerPath);
        if (path.basename(parent).toLowerCase() === 'pending') return path.dirname(parent);
    }
    if (localAppData && cacheDirName) return path.join(localAppData, cacheDirName);
    if (localAppData && appName) return path.join(localAppData, `${appName}-updater`);
    return null;
}

/**
 * Over the app's own window in **physical pixels** (the caller does the
 * `dipToScreenRect`), or centred on the primary display at the minimum size
 * when the app is hidden in the tray.
 *
 * @param {number} [scaleFactor] the display's scale (1.5 at 150 %). The helper
 *   *lays out* in DIPs — at 150 % a 560x380 px window is 373x253 DIPs and the
 *   error state does not fit — so the minimum is 560x380 **DIPs**, scaled here.
 */
function helperBounds(windowRect, primaryWorkArea, scaleFactor) {
    const area = primaryWorkArea || {x: 0, y: 0, width: 1920, height: 1080};
    const scale = Number(scaleFactor) >= 1 ? Math.min(4, Number(scaleFactor)) : 1;
    const minWidth = Math.round(MIN_WIDTH * scale);
    const minHeight = Math.round(MIN_HEIGHT * scale);
    if (!windowRect || !windowRect.width || !windowRect.height) {
        return {
            x: Math.round(area.x + (area.width - minWidth) / 2),
            y: Math.round(area.y + (area.height - minHeight) / 2),
            width: minWidth,
            height: minHeight
        };
    }
    return {
        x: Math.round(windowRect.x),
        y: Math.round(windowRect.y),
        width: Math.max(minWidth, Math.round(windowRect.width)),
        height: Math.max(minHeight, Math.round(windowRect.height))
    };
}

/**
 * In the order `updater/Options.cs` documents, and tested because no compiler
 * checks the two sides agree: a renamed switch shows up only as a helper that
 * exits 2 and an update that quietly took the stock path.
 */
function buildUpdaterArgs(options) {
    const {installerPath, installDir, appExe, version, lang, waitPid, bounds, logPath, readyFile} = options;
    const b = bounds || {};
    const args = [
        '--installer', String(installerPath),
        '--install-dir', String(installDir),
        '--app-exe', String(appExe),
        '--version', String(version),
        '--lang', lang === 'it' ? 'it' : 'en',
        '--wait-pid', String(waitPid),
        '--bounds', [b.x, b.y, b.width, b.height].map(n => Math.round(Number(n) || 0)).join(','),
        '--log', String(logPath),
        '--ready-file', String(readyFile)
    ];
    // Only when our window was not the focused one: the player may be in a
    // match, and stealing focus there is worse than a plain installer.
    if (options.activate === false) args.push('--no-activate');
    return args;
}

/**
 * The helper cannot run from `resources/updater`: NSIS uninstalls the old
 * version first, so the exe would be deleted under the running process — and a
 * folder that is a process's image path cannot be removed at all.
 */
function copyHelper(from, to, fsImpl = fs) {
    fsImpl.mkdirSync(to, {recursive: true});
    for (const entry of fsImpl.readdirSync(from, {withFileTypes: true})) {
        const source = path.join(from, entry.name);
        const target = path.join(to, entry.name);
        if (entry.isDirectory()) copyHelper(source, target, fsImpl);
        else fsImpl.copyFileSync(source, target);
    }
}

/**
 * The handshake the whole safety story rests on. `fsImpl`, `now` and `sleep`
 * are injected so a test can prove the timeout without waiting four seconds.
 * @returns {Promise<boolean>} true when the file appeared in time
 */
async function waitForReadyFile(options) {
    const {
        file,
        timeoutMs = READY_TIMEOUT_MS,
        pollMs = READY_POLL_MS,
        fsImpl = fs,
        now = Date.now,
        sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
        isDead = () => false
    } = options;
    const deadline = now() + timeoutMs;
    for (;;) {
        try {
            if (fsImpl.existsSync(file)) return true;
        } catch (err) {
            // An unreadable temp directory is a "no" like any other.
            return false;
        }
        // A helper that already exited will never write the file.
        if (isDead()) return false;
        if (now() >= deadline) return false;
        await sleep(pollMs);
    }
}

/**
 * The prefix filter is a **safety rule**, not an optimisation: this list
 * deletes directories inside a cache that also holds `pending/`.
 */
function staleHelperFolders(entries, now, maxAgeMs = STALE_MS) {
    return entries
        .filter(entry => entry && typeof entry.name === 'string' && entry.name.startsWith(HELPER_PREFIX))
        .filter(entry => (now - Number(entry.mtimeMs || 0)) > maxAgeMs)
        .map(entry => entry.name);
}

/**
 * Housekeeping, not a guarantee, and it **never throws**: it runs on the
 * startup path, where a thrown error would be an app that does not start.
 * @returns {number} how many folders were removed
 */
function cleanStaleHelpers(options = {}) {
    const {homeDir, now = Date.now(), maxAgeMs = STALE_MS, fsImpl = fs} = options;
    let removed = 0;
    if (!homeDir) return 0;
    try {
        const entries = fsImpl.readdirSync(homeDir, {withFileTypes: true})
            .filter(entry => entry.isDirectory())
            .map(entry => {
                let mtimeMs = 0;
                try {
                    mtimeMs = fsImpl.statSync(path.join(homeDir, entry.name)).mtimeMs;
                } catch (err) {
                    // Gone between readdir and stat: the removal will no-op.
                    mtimeMs = 0;
                }
                return {name: entry.name, mtimeMs};
            });
        for (const name of staleHelperFolders(entries, now, maxAgeMs)) {
            try {
                fsImpl.rmSync(path.join(homeDir, name), {recursive: true, force: true});
                removed++;
            } catch (err) {
                // Still running, or locked by a scanner; retried next start.
            }
        }
    } catch (err) {
        // No cache directory yet (nothing downloaded) is the normal case.
    }
    return removed;
}

/** **No ready-file, no quit** — the caller's entire contract
 * (docs/SPEC-UPDATER.md §5 Safety rules, rule 2). */
async function launchUpdater(options) {
    const {
        resourcesPath,
        version,
        readyTimeoutMs = READY_TIMEOUT_MS,
        fsImpl = fs,
        spawnFn = spawn,
        random
    } = options;

    const result = {ok: false, reason: null, dir: null, exe: null, args: null, pid: null, readyFile: null};

    const home = options.homeDir || helperHome(options);
    if (!home) {
        result.reason = 'no-helper-home';
        return result;
    }

    const source = helperSourceDir(resourcesPath);
    const sourceExe = path.join(source, HELPER_EXE);
    try {
        if (!fsImpl.existsSync(sourceExe)) {
            result.reason = 'helper-missing';
            return result;
        }
    } catch (err) {
        result.reason = 'helper-unreadable';
        return result;
    }

    const dir = path.join(home, helperFolderName(version, random));
    try {
        copyHelper(source, dir, fsImpl);
    } catch (err) {
        result.reason = `copy-failed: ${(err && err.message) || err}`;
        return result;
    }
    result.dir = dir;
    result.exe = path.join(dir, HELPER_EXE);
    result.readyFile = path.join(dir, 'ready');

    const args = buildUpdaterArgs(Object.assign({}, options, {readyFile: result.readyFile}));
    result.args = args;

    let child;
    let exited = false;
    try {
        child = spawnFn(result.exe, args, {
            // Detached + `unref`: the helper has to outlive this process, which
            // is the very thing it watches go away (`--wait-pid`).
            detached: true,
            stdio: 'ignore',
            windowsHide: false,
            cwd: dir
        });
    } catch (err) {
        result.reason = `spawn-threw: ${(err && err.message) || err}`;
        return result;
    }
    if (!child) {
        result.reason = 'spawn-returned-nothing';
        return result;
    }
    // `spawn` reports a failed launch asynchronously and an unhandled `error`
    // event is an uncaught exception.
    let spawnError = null;
    if (typeof child.on === 'function') {
        child.on('error', (err) => {
            spawnError = (err && err.message) || String(err);
            exited = true;
        });
        child.on('exit', () => {
            exited = true;
        });
    }
    result.pid = child.pid || null;

    const ready = await waitForReadyFile(Object.assign({
        file: result.readyFile,
        timeoutMs: readyTimeoutMs,
        fsImpl,
        isDead: () => exited
    }, options.wait || {}));

    if (!ready) {
        result.reason = spawnError ? `spawn-failed: ${spawnError}` : (exited ? 'helper-exited' : 'no-ready-file');
        // **Before anything else**: a merely *slow* helper would see
        // `--wait-pid` exit and start a second, silent installer on top of the
        // stock one. The kill below is the first line of defence; this file
        // still holds when the kill does not (`Runner.cs` checks for it).
        try {
            fsImpl.writeFileSync(result.readyFile + ABORT_SUFFIX, 'abort');
        } catch (err) {
            // Best effort; the kill is still coming.
        }
        // Do not leave a window-less process holding the working folder.
        try {
            if (!exited && typeof child.kill === 'function' && child.kill() === false) {
                result.reason += ' (kill failed)';
            }
        } catch (err) {
            // Already gone.
        }
        return result;
    }

    try {
        if (typeof child.unref === 'function') child.unref();
    } catch (err) {
        // Nothing to do; the app is quitting anyway.
    }
    result.ok = true;
    return result;
}

module.exports = {
    launchUpdater,
    buildUpdaterArgs,
    helperBounds,
    helperHome,
    updaterCacheDirName,
    helperSourceDir,
    helperFolderName,
    staleHelperFolders,
    cleanStaleHelpers,
    waitForReadyFile,
    copyHelper,
    HELPER_DIR_NAME,
    HELPER_EXE,
    HELPER_PREFIX,
    ABORT_SUFFIX,
    READY_TIMEOUT_MS,
    STALE_MS,
    MIN_WIDTH,
    MIN_HEIGHT
};
