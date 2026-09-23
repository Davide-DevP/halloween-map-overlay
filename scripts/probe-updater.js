'use strict';

/**
 * Dev-only: how long does `hmo-updater.exe` take to show itself on this PC?
 *
 * Reproduces the app's own launch shape — a fresh copy of the helper in
 * electron-updater's cache directory under %LOCALAPPDATA%, spawned detached,
 * timed until its ready-file appears — with `--demo`, so no installer runs and
 * nothing is touched. Prints one line per run. Run it from a terminal of your
 * own, never from an agent session: an antivirus that dislikes the helper
 * kills the whole launching process tree.
 * Why: docs/agents/updater-and-installer.md § Testing an update locally.
 *
 *   node scripts/probe-updater.js [--runs 3] [--source <dir with hmo-updater.exe>]
 *
 * The source defaults to the installed app's `resources/updater`, then to
 * `build/updater` (after `npm run build-updater`).
 */

const fs = require('fs');
const path = require('path');
const {spawn} = require('child_process');
const {
    copyHelper, helperFolderName, helperHome, waitForReadyFile, HELPER_EXE
} = require('../src/core/update-helper');

const APP_NAME = 'halloween-map-overlay';
const PROBE_TIMEOUT_MS = 30000;

function arg(name, fallback) {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function defaultSource() {
    const installed = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Halloween Map Overlay', 'resources', 'updater');
    if (fs.existsSync(path.join(installed, HELPER_EXE))) return installed;
    const built = path.join(__dirname, '..', 'build', 'updater');
    if (fs.existsSync(path.join(built, HELPER_EXE))) return built;
    return null;
}

async function probe(source, home, run) {
    const dir = path.join(home, helperFolderName(`probe${run}`));
    copyHelper(source, dir);
    const readyFile = path.join(dir, 'ready');
    const logPath = path.join(dir, 'u.log');
    const args = ['--demo', '--version', 'probe', '--lang', 'en',
        '--bounds', '200,150,1000,720', '--log', logPath, '--ready-file', readyFile];
    const started = Date.now();
    const child = spawn(path.join(dir, HELPER_EXE), args, {cwd: dir, detached: true, stdio: 'ignore'});
    let exited = false;
    child.on('exit', () => { exited = true; });
    child.on('error', () => { exited = true; });
    const ready = await waitForReadyFile({file: readyFile, timeoutMs: PROBE_TIMEOUT_MS, isDead: () => exited});
    const ms = Date.now() - started;
    let firstLog = '(no log line)';
    try {
        const first = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).find(Boolean);
        if (first) firstLog = first.slice(0, 70);
    } catch (err) { /* no log yet */ }
    console.log(`run ${run}: ready=${ready ? 'yes' : 'no'} exited=${exited ? 'yes' : 'no'} ms=${ms} first-log=${firstLog}`);
    try { child.kill(); } catch (err) { /* already gone */ }
    // Let the window close before the next fresh copy.
    await new Promise(resolve => setTimeout(resolve, 1500));
    try { fs.rmSync(dir, {recursive: true, force: true}); } catch (err) { console.log(`  (could not remove ${dir}: ${err.message})`); }
}

async function main() {
    const runs = Math.max(1, parseInt(arg('--runs', '3'), 10) || 3);
    const source = arg('--source', defaultSource());
    if (!source || !fs.existsSync(path.join(source, HELPER_EXE))) {
        console.error('No hmo-updater.exe found. Install the app, or run `npm run build-updater`, or pass --source <dir>.');
        process.exit(1);
    }
    const home = helperHome({localAppData: process.env.LOCALAPPDATA, appName: APP_NAME});
    if (!home) {
        console.error('LOCALAPPDATA is not set.');
        process.exit(1);
    }
    fs.mkdirSync(home, {recursive: true});
    console.log(`helper: ${path.join(source, HELPER_EXE)}`);
    console.log(`copies go under: ${home}`);
    console.log(`the app gives up after ${require('../src/core/update-helper').READY_TIMEOUT_MS} ms; the probe waits ${PROBE_TIMEOUT_MS}`);
    for (let run = 1; run <= runs; run++) await probe(source, home, run);
}

main().catch((err) => {
    console.error(err && err.stack || err);
    process.exit(1);
});
