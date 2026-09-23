'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
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
    HELPER_EXE,
    HELPER_PREFIX,
    MIN_WIDTH,
    MIN_HEIGHT
} = require('../src/core/update-helper.js');

/** A throwaway directory, removed by the test that made it. */
function tempDir(name) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `hmo-test-${name}-`));
}

/** A fake `resources/updater` folder: exe, icon, fonts subdirectory. */
function fakeHelperTree(root) {
    const dir = path.join(root, 'updater');
    fs.mkdirSync(path.join(dir, 'fonts'), {recursive: true});
    fs.writeFileSync(path.join(dir, HELPER_EXE), 'MZ fake');
    fs.writeFileSync(path.join(dir, 'icon.png'), 'png');
    fs.writeFileSync(path.join(dir, 'fonts', 'Geist-Regular.ttf'), 'ttf');
    return root;
}

/** A spawn stand-in that records the call and behaves as the test asks. */
function fakeSpawn(behaviour = {}) {
    const calls = [];
    const child = {
        pid: behaviour.pid === undefined ? 4242 : behaviour.pid,
        killed: false,
        unrefCalled: false,
        handlers: {},
        on(event, handler) {
            this.handlers[event] = handler;
        },
        kill() {
            this.killed = true;
        },
        unref() {
            this.unrefCalled = true;
        }
    };
    const fn = (exe, args, options) => {
        calls.push({exe, args, options});
        if (behaviour.throws) throw new Error(behaviour.throws);
        if (behaviour.writesReady) {
            // The real helper writes it after its first frame; here, at once.
            const readyIndex = args.indexOf('--ready-file');
            fs.writeFileSync(args[readyIndex + 1], 'ready');
        }
        if (behaviour.returnsNothing) return null;
        return child;
    };
    fn.calls = calls;
    fn.child = child;
    return fn;
}

const BASE_ARGS = {
    installerPath: 'C:\\Users\\x\\AppData\\Local\\hmo-updater\\pending\\Setup 0.5.1.exe',
    installDir: 'C:\\Users\\x\\AppData\\Local\\Programs\\Halloween Map Overlay',
    appExe: 'C:\\Users\\x\\AppData\\Local\\Programs\\Halloween Map Overlay\\Halloween Map Overlay.exe',
    version: '0.5.1',
    lang: 'it',
    waitPid: 1234,
    bounds: {x: 100, y: 50, width: 1000, height: 720},
    logPath: 'C:\\Users\\x\\AppData\\Roaming\\Halloween Map Overlay\\updater.log',
    readyFile: 'C:\\Users\\x\\AppData\\Local\\hmo-updater\\helper-0.5.1-abc123\\ready'
};

// ── The command line ────────────────────────────────────────────────────────

test('buildUpdaterArgs: every switch updater/Options.cs requires, in pairs', () => {
    const args = buildUpdaterArgs(BASE_ARGS);
    // Nine required switches, each with a value, and nothing else.
    assert.strictEqual(args.length, 18);
    const pairs = {};
    for (let i = 0; i < args.length; i += 2) pairs[args[i]] = args[i + 1];
    assert.deepStrictEqual(pairs, {
        '--installer': BASE_ARGS.installerPath,
        '--install-dir': BASE_ARGS.installDir,
        '--app-exe': BASE_ARGS.appExe,
        '--version': '0.5.1',
        '--lang': 'it',
        '--wait-pid': '1234',
        '--bounds': '100,50,1000,720',
        '--log': BASE_ARGS.logPath,
        '--ready-file': BASE_ARGS.readyFile
    });
});

test('buildUpdaterArgs: anything that is not Italian is English', () => {
    const langOf = (lang) => {
        const args = buildUpdaterArgs(Object.assign({}, BASE_ARGS, {lang}));
        return args[args.indexOf('--lang') + 1];
    };
    // `updater/Options.cs` falls back to English on anything it does not know,
    // but sending it a value it has to guess about is how a table gains a third
    // language nobody wrote.
    for (const lang of ['en', 'de', '', null, undefined, 'IT']) {
        assert.strictEqual(langOf(lang), 'en', `lang=${lang}`);
    }
    assert.strictEqual(langOf('it'), 'it');
});

test('buildUpdaterArgs: bounds are whole numbers, because they are pixels', () => {
    const args = buildUpdaterArgs(Object.assign({}, BASE_ARGS, {
        bounds: {x: 100.4, y: -0.6, width: 1000.5, height: 719.2}
    }));
    assert.strictEqual(args[args.indexOf('--bounds') + 1], '100,-1,1001,719');
});

test('buildUpdaterArgs: a missing bounds object is four zeroes, not "undefined"', () => {
    const args = buildUpdaterArgs(Object.assign({}, BASE_ARGS, {bounds: null}));
    assert.strictEqual(args[args.indexOf('--bounds') + 1], '0,0,0,0');
});

test('buildUpdaterArgs: --no-activate only when the app window was not focused', () => {
    assert.ok(!buildUpdaterArgs(Object.assign({}, BASE_ARGS, {activate: true})).includes('--no-activate'));
    assert.ok(!buildUpdaterArgs(BASE_ARGS).includes('--no-activate'));
    assert.ok(buildUpdaterArgs(Object.assign({}, BASE_ARGS, {activate: false})).includes('--no-activate'));
});

// ── Placement ───────────────────────────────────────────────────────────────

const WORK_AREA = {x: 0, y: 0, width: 2560, height: 1392};

test('helperBounds: the app window is covered exactly', () => {
    assert.deepStrictEqual(
        helperBounds({x: 320, y: 180, width: 1000, height: 720}, WORK_AREA),
        {x: 320, y: 180, width: 1000, height: 720});
});

test('helperBounds: a window smaller than the minimum still gets a readable one', () => {
    const bounds = helperBounds({x: 10, y: 10, width: 400, height: 200}, WORK_AREA);
    assert.strictEqual(bounds.width, MIN_WIDTH);
    assert.strictEqual(bounds.height, MIN_HEIGHT);
    // The origin is kept: the helper's own clamp puts it back on a monitor.
    assert.strictEqual(bounds.x, 10);
});

test('helperBounds: hidden in the tray means centred on the primary display', () => {
    const bounds = helperBounds(null, WORK_AREA);
    assert.deepStrictEqual(bounds, {
        x: (2560 - MIN_WIDTH) / 2,
        y: (1392 - MIN_HEIGHT) / 2,
        width: MIN_WIDTH,
        height: MIN_HEIGHT
    });
});

test('helperBounds: the minimum is in DIPs, so a 150 % display gets 840x570 pixels', () => {
    const area = {x: 0, y: 0, width: 2880, height: 1620};
    assert.deepStrictEqual(helperBounds(null, area, 1.5), {x: 1020, y: 525, width: 840, height: 570});
    assert.deepStrictEqual(helperBounds({x: 10, y: 20, width: 600, height: 400}, area, 1.5),
        {x: 10, y: 20, width: 840, height: 570});
    // Garbage in, 100 % out.
    assert.deepStrictEqual(helperBounds(null, area, NaN), helperBounds(null, area));
});

test('helperBounds: a zero-sized window counts as hidden', () => {
    const bounds = helperBounds({x: 0, y: 0, width: 0, height: 0}, WORK_AREA);
    assert.strictEqual(bounds.width, MIN_WIDTH);
});

test('helperBounds: an offset work area is honoured (second monitor left of the first)', () => {
    const bounds = helperBounds(null, {x: -1920, y: 0, width: 1920, height: 1040});
    assert.strictEqual(bounds.x, Math.round(-1920 + (1920 - MIN_WIDTH) / 2));
});

// ── Where the working copy goes ─────────────────────────────────────────────

test('helperFolderName: prefix, version and a tail, all in one name', () => {
    assert.strictEqual(helperFolderName('0.5.1', 'a1b2c3'), 'helper-0.5.1-a1b2c3');
    assert.ok(helperFolderName('0.5.1', 'a1b2c3').startsWith(HELPER_PREFIX));
});

test('helperFolderName: a version off the release feed cannot escape the folder', () => {
    const name = helperFolderName('../../evil 0.5.1', 'aaaaaa');
    assert.strictEqual(name, 'helper-....evil0.5.1-aaaaaa');
    assert.ok(!name.includes('/') && !name.includes('\\'));
});

test('helperFolderName: two calls do not collide', () => {
    assert.notStrictEqual(helperFolderName('0.5.1'), helperFolderName('0.5.1'));
});

test('helperHome: electron-updater\'s own answer wins', () => {
    assert.strictEqual(helperHome({
        cacheDir: 'C:\\x\\halloween-map-overlay-updater',
        installerPath: 'C:\\somewhere\\else\\pending\\Setup.exe',
        localAppData: 'C:\\y',
        appName: 'z'
    }), 'C:\\x\\halloween-map-overlay-updater');
});

test('helperHome: the installer always sits in <cacheDir>\\pending\\', () => {
    // `DownloadedUpdateHelper.cacheDirForPendingUpdate`; this is the branch that
    // runs in practice, because the install only happens after a download.
    assert.strictEqual(
        helperHome({installerPath: 'C:\\Users\\x\\AppData\\Local\\hmo-updater\\pending\\Setup 0.5.1.exe'}),
        'C:\\Users\\x\\AppData\\Local\\hmo-updater');
});

test('helperHome: an installer somewhere else does not invent a cache directory', () => {
    // A hand-picked installer path must not make us write next to it.
    assert.strictEqual(helperHome({installerPath: 'D:\\Downloads\\Setup.exe'}), null);
    assert.strictEqual(
        helperHome({installerPath: 'D:\\Downloads\\Setup.exe', localAppData: 'C:\\la', appName: 'app'}),
        path.join('C:\\la', 'app-updater'));
});

test('helperHome: app-update.yml\'s name beats the derived one', () => {
    assert.strictEqual(
        helperHome({localAppData: 'C:\\la', cacheDirName: 'halloween-map-overlay-updater', appName: 'other'}),
        path.join('C:\\la', 'halloween-map-overlay-updater'));
});

test('helperHome: nothing usable is null, not a path under the drive root', () => {
    assert.strictEqual(helperHome({}), null);
    assert.strictEqual(helperHome(), null);
});

test('updaterCacheDirName: the one key we read out of app-update.yml', () => {
    const yml = [
        'provider: github',
        'owner: Davide-DevP',
        'repo: halloween-map-overlay',
        'updaterCacheDirName: halloween-map-overlay-updater',
        'publishAutoUpdate: true'
    ].join('\n');
    assert.strictEqual(updaterCacheDirName(yml), 'halloween-map-overlay-updater');
    assert.strictEqual(updaterCacheDirName('updaterCacheDirName: "quoted-updater"'), 'quoted-updater');
    assert.strictEqual(updaterCacheDirName('provider: github'), null);
    assert.strictEqual(updaterCacheDirName(null), null);
});

// ── The handshake ───────────────────────────────────────────────────────────

test('waitForReadyFile: true as soon as the file is there', async () => {
    let looks = 0;
    const ok = await waitForReadyFile({
        file: 'ready',
        fsImpl: {existsSync: () => ++looks >= 3},
        now: () => 0,
        sleep: async () => {},
        timeoutMs: 4000
    });
    assert.strictEqual(ok, true);
    assert.strictEqual(looks, 3);
});

test('waitForReadyFile: false once the budget is spent, and it really stops', async () => {
    let clock = 0;
    let sleeps = 0;
    const ok = await waitForReadyFile({
        file: 'ready',
        fsImpl: {existsSync: () => false},
        now: () => clock,
        sleep: async (ms) => {
            sleeps++;
            clock += ms;
        },
        pollMs: 100,
        timeoutMs: 4000
    });
    assert.strictEqual(ok, false);
    // 4000 / 100 sleeps, then the deadline check ends it — not an infinite loop
    // and not a single look either.
    assert.strictEqual(sleeps, 40);
});

test('waitForReadyFile: a helper that already exited is not waited on', async () => {
    let sleeps = 0;
    const ok = await waitForReadyFile({
        file: 'ready',
        fsImpl: {existsSync: () => false},
        now: () => 0,
        sleep: async () => {
            sleeps++;
        },
        isDead: () => true,
        timeoutMs: 4000
    });
    assert.strictEqual(ok, false);
    assert.strictEqual(sleeps, 0, 'the full four seconds must not be spent on a dead process');
});

test('waitForReadyFile: an unreadable temp directory is a "no", not a throw', async () => {
    const ok = await waitForReadyFile({
        file: 'ready',
        fsImpl: {
            existsSync() {
                throw new Error('EPERM');
            }
        },
        now: () => 0,
        sleep: async () => {},
        timeoutMs: 4000
    });
    assert.strictEqual(ok, false);
});

// ── Stale cleanup ───────────────────────────────────────────────────────────

test('staleHelperFolders: only our prefix, only older than the age', () => {
    const now = 10 * 60 * 60 * 1000;
    const hour = 60 * 60 * 1000;
    const entries = [
        {name: 'helper-0.5.1-aaa', mtimeMs: now - 2 * hour},
        {name: 'helper-0.5.1-bbb', mtimeMs: now - 30 * 60 * 1000},
        {name: 'hmo-rotating-log-xyz', mtimeMs: now - 5 * hour},
        {name: 'something-else', mtimeMs: 0},
        {name: 'helper-0.4.0-ccc', mtimeMs: 0}
    ];
    assert.deepStrictEqual(staleHelperFolders(entries, now, hour),
        ['helper-0.5.1-aaa', 'helper-0.4.0-ccc']);
});

test('cleanStaleHelpers: removes the old copies and leaves the fresh one', () => {
    const root = tempDir('stale');
    try {
        const old = path.join(root, 'helper-0.5.0-old111');
        const fresh = path.join(root, 'helper-0.5.1-new222');
        const alien = path.join(root, 'not-ours');
        for (const dir of [old, fresh, alien]) fs.mkdirSync(path.join(dir, 'fonts'), {recursive: true});
        fs.writeFileSync(path.join(old, HELPER_EXE), 'x');
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        fs.utimesSync(old, twoHoursAgo, twoHoursAgo);
        fs.utimesSync(alien, twoHoursAgo, twoHoursAgo);

        assert.strictEqual(cleanStaleHelpers({homeDir: root}), 1);
        assert.ok(!fs.existsSync(old));
        assert.ok(fs.existsSync(fresh));
        assert.ok(fs.existsSync(alien), 'only helper-* folders are ours to delete');
    } finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
});

test('cleanStaleHelpers: a temp directory that is not there never throws', () => {
    assert.strictEqual(cleanStaleHelpers({homeDir: path.join(os.tmpdir(), 'hmo-nope-' + Date.now())}), 0);
});

// ── Copying ─────────────────────────────────────────────────────────────────

test('copyHelper: exe, icon and the fonts subfolder all arrive', () => {
    const root = tempDir('copy');
    try {
        fakeHelperTree(root);
        const target = path.join(root, 'out');
        copyHelper(path.join(root, 'updater'), target);
        assert.ok(fs.existsSync(path.join(target, HELPER_EXE)));
        assert.ok(fs.existsSync(path.join(target, 'icon.png')));
        assert.strictEqual(fs.readFileSync(path.join(target, 'fonts', 'Geist-Regular.ttf'), 'utf-8'), 'ttf');
    } finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
});

// ── launchUpdater ───────────────────────────────────────────────────────────

test('launchUpdater: copies the helper, spawns it detached and waits for the file', async () => {
    const root = tempDir('launch-ok');
    try {
        fakeHelperTree(root);
        const spawnFn = fakeSpawn({writesReady: true});
        const result = await launchUpdater(Object.assign({}, BASE_ARGS, {
            resourcesPath: root,
            homeDir: root,
            random: 'abc123',
            spawnFn
        }));
        assert.strictEqual(result.ok, true, result.reason || '');
        assert.strictEqual(result.pid, 4242);
        assert.strictEqual(path.basename(result.dir), 'helper-0.5.1-abc123');
        // The copy, not the shipped folder — the shipped one is deleted by the
        // uninstaller while the helper is running.
        assert.strictEqual(result.exe, path.join(result.dir, HELPER_EXE));
        assert.notStrictEqual(path.dirname(result.exe), helperSourceDir(root));
        assert.ok(fs.existsSync(path.join(result.dir, 'fonts', 'Geist-Regular.ttf')));

        const call = spawnFn.calls[0];
        assert.strictEqual(call.exe, result.exe);
        assert.strictEqual(call.options.detached, true);
        assert.strictEqual(call.options.stdio, 'ignore');
        assert.ok(spawnFn.child.unrefCalled, 'the helper has to outlive the app');
        // The ready-file the helper was told to write is the one we watched.
        assert.strictEqual(call.args[call.args.indexOf('--ready-file') + 1], result.readyFile);
    } finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
});

test('launchUpdater: nowhere to put the copy declines instead of guessing', async () => {
    const root = tempDir('launch-nohome');
    try {
        fakeHelperTree(root);
        const spawnFn = fakeSpawn({writesReady: true});
        const result = await launchUpdater({
            resourcesPath: root,
            version: '0.5.1',
            // No homeDir, no cacheDir, and an installer that is not in a
            // `pending` folder: there is no cache directory to be had.
            installerPath: 'D:\\Downloads\\Setup.exe',
            spawnFn
        });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.reason, 'no-helper-home');
        assert.strictEqual(spawnFn.calls.length, 0);
    } finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
});

test('launchUpdater: no shipped helper is a clean "no", not a throw', async () => {
    const root = tempDir('launch-missing');
    try {
        const spawnFn = fakeSpawn({writesReady: true});
        const result = await launchUpdater(Object.assign({}, BASE_ARGS, {
            resourcesPath: root,
            homeDir: root,
            spawnFn
        }));
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.reason, 'helper-missing');
        assert.strictEqual(spawnFn.calls.length, 0);
    } finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
});

test('launchUpdater: a spawn that throws is reported, never raised', async () => {
    const root = tempDir('launch-throw');
    try {
        fakeHelperTree(root);
        const result = await launchUpdater(Object.assign({}, BASE_ARGS, {
            resourcesPath: root,
            homeDir: root,
            spawnFn: fakeSpawn({throws: 'EACCES'})
        }));
        assert.strictEqual(result.ok, false);
        assert.match(result.reason, /^spawn-threw: EACCES$/);
    } finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
});

test('launchUpdater: no ready-file within the budget kills the helper and gives up', async () => {
    const root = tempDir('launch-timeout');
    try {
        fakeHelperTree(root);
        const spawnFn = fakeSpawn({writesReady: false});
        let clock = 0;
        const result = await launchUpdater(Object.assign({}, BASE_ARGS, {
            resourcesPath: root,
            homeDir: root,
            spawnFn,
            // The injected clock is what keeps this test instant; the real
            // budget is 15 s.
            wait: {
                now: () => clock,
                sleep: async (ms) => {
                    clock += ms;
                }
            }
        }));
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.reason, 'no-ready-file');
        assert.ok(spawnFn.child.killed, 'a helper with no window must not be left running');
        assert.ok(!spawnFn.child.unrefCalled);
        // The kill can fail; the abort file is what stops a late helper from
        // starting a second installer once the app has taken the stock path.
        assert.ok(fs.existsSync(result.readyFile + '.abort'),
            'giving up on the helper must leave <ready-file>.abort behind');
    } finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
});

test('launchUpdater: an asynchronous spawn error ends the wait early', async () => {
    const root = tempDir('launch-async-error');
    try {
        fakeHelperTree(root);
        const spawnFn = fakeSpawn({writesReady: false});
        let clock = 0;
        const pending = launchUpdater(Object.assign({}, BASE_ARGS, {
            resourcesPath: root,
            homeDir: root,
            spawnFn,
            wait: {
                now: () => clock,
                sleep: async (ms) => {
                    clock += ms;
                }
            }
        }));
        // This is how Node reports a failed launch: asynchronously, on the
        // child. An unhandled 'error' event would be an uncaught exception.
        spawnFn.child.handlers.error(new Error('blocked by policy'));
        const result = await pending;
        assert.strictEqual(result.ok, false);
        assert.match(result.reason, /^spawn-failed: blocked by policy$/);
    } finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
});

test('launchUpdater: a helper that exits before writing the file is reported as such', async () => {
    const root = tempDir('launch-exit');
    try {
        fakeHelperTree(root);
        const spawnFn = fakeSpawn({writesReady: false});
        let clock = 0;
        const pending = launchUpdater(Object.assign({}, BASE_ARGS, {
            resourcesPath: root,
            homeDir: root,
            spawnFn,
            wait: {
                now: () => clock,
                sleep: async (ms) => {
                    clock += ms;
                }
            }
        }));
        spawnFn.child.handlers.exit(2);
        const result = await pending;
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.reason, 'helper-exited');
    } finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
});
