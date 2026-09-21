const {test} = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const {
    shouldUnloadMainWindow, UNLOAD_GRACE_MS, KEEP_REASONS
} = require(path.join(ROOT, 'src/shared/window-unload'));
const {DEFAULT_SETTINGS} = require(path.join(ROOT, 'src/shared/settings-defaults'));

/*
 * `src/shared/window-unload.js` — may the main window be destroyed right now?
 *
 * Every `false` below is something a user would notice losing, which is why
 * the decision is a tested function rather than a condition inside a timer.
 */

const NOW = 1_700_000_000_000;

/** The ordinary "hidden in the tray for a minute" case. */
function ok(over) {
    return Object.assign({
        hasWindow: true,
        visible: false,
        minimized: false,
        hiddenAt: NOW - 60000,
        now: NOW
    }, over || {});
}

test('hidden in the tray past the grace period: unload', () => {
    assert.deepStrictEqual(shouldUnloadMainWindow(ok()), {unload: true, reason: 'tray', waitMs: 0});
});

test('there is no setting any more: a stored one cannot switch it off', () => {
    // `unloadWindowInTray` was an option until 1.0 and is now always on. A file
    // that still carries it — including a `false` — behaves like every other.
    assert.ok(!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, 'unloadWindowInTray'));
    for (const value of [false, true, undefined, null, 'yes', 1]) {
        assert.strictEqual(shouldUnloadMainWindow(ok({setting: value})).unload, true, String(value));
    }
    assert.ok(!KEEP_REASONS.includes('setting-off'));
});

test('a visible window is never torn down', () => {
    assert.strictEqual(shouldUnloadMainWindow(ok({visible: true})).reason, 'visible');
});

test('minimised to the taskbar is not hidden in the tray', () => {
    // The window is still on the user's desktop and restoring it has to be
    // instant, so only a tray hide counts.
    assert.strictEqual(shouldUnloadMainWindow(ok({minimized: true})).reason, 'minimized');
});

test('there is nothing to do with no window', () => {
    assert.strictEqual(shouldUnloadMainWindow(ok({hasWindow: false})).reason, 'no-window');
});

test('the grace period is waited out, and the wait is reported so the timer can be armed', () => {
    const early = shouldUnloadMainWindow(ok({hiddenAt: NOW - 1000}));
    assert.strictEqual(early.unload, false);
    assert.strictEqual(early.reason, 'grace');
    assert.strictEqual(early.waitMs, UNLOAD_GRACE_MS - 1000);

    // Exactly at the boundary it goes.
    assert.strictEqual(shouldUnloadMainWindow(ok({hiddenAt: NOW - UNLOAD_GRACE_MS})).unload, true);
    // …and a custom grace of 0 means "as soon as it is hidden", which is what
    // the controller test drives.
    assert.strictEqual(shouldUnloadMainWindow(ok({hiddenAt: NOW, graceMs: 0})).unload, true);
});

test('the grace period is long enough for a tray round trip and short enough for a match', () => {
    assert.ok(UNLOAD_GRACE_MS >= 30000 && UNLOAD_GRACE_MS <= 60000, String(UNLOAD_GRACE_MS));
});

test('work with state in the renderer keeps the window: settings, the tour, a report, an import', () => {
    for (const reason of ['settings', 'tour', 'report', 'import']) {
        assert.strictEqual(shouldUnloadMainWindow(ok({busy: [reason]})).reason, 'busy', reason);
    }
    // A Set is what `MainWindow` actually holds.
    assert.strictEqual(shouldUnloadMainWindow(ok({busy: new Set(['settings'])})).reason, 'busy');
    // An empty one is not busy.
    assert.strictEqual(shouldUnloadMainWindow(ok({busy: new Set()})).unload, true);
    assert.strictEqual(shouldUnloadMainWindow(ok({busy: []})).unload, true);
});

test('the hotkey bind dialog keeps the window while it is recording', () => {
    assert.strictEqual(shouldUnloadMainWindow(ok({recording: true})).reason, 'recording');
});

test('a downloaded update keeps the window until its banner has been seen', () => {
    assert.strictEqual(shouldUnloadMainWindow(ok({updatePending: true})).reason, 'update-banner');
    assert.strictEqual(
        shouldUnloadMainWindow(ok({updatePending: true, updateBannerShown: true})).unload, true);
});

test('an install and a quit both keep the window', () => {
    assert.strictEqual(shouldUnloadMainWindow(ok({installing: true})).reason, 'installing');
    assert.strictEqual(shouldUnloadMainWindow(ok({quitting: true})).reason, 'quitting');
});

test('quitting and installing win over everything else, so nothing races the shutdown', () => {
    const during = ok({quitting: true, installing: true, visible: true, busy: ['settings']});
    assert.strictEqual(shouldUnloadMainWindow(during).reason, 'quitting');
});

test('no input at all is a refusal, not a crash', () => {
    assert.strictEqual(shouldUnloadMainWindow(undefined).unload, false);
    assert.strictEqual(shouldUnloadMainWindow({}).unload, false);
});

test('a window that was never hidden has no hiddenAt to measure from', () => {
    assert.strictEqual(shouldUnloadMainWindow(ok({hiddenAt: 0})).unload, false);
});

test('every reason the decision can give is documented in KEEP_REASONS', () => {
    const cases = [
        ok({hasWindow: false}), ok({quitting: true}), ok({installing: true}),
        ok({visible: true}), ok({minimized: true}), ok({busy: ['settings']}), ok({recording: true}),
        ok({updatePending: true}), ok({hiddenAt: NOW})
    ];
    for (const input of cases) {
        const verdict = shouldUnloadMainWindow(input);
        assert.ok(KEEP_REASONS.includes(verdict.reason), verdict.reason);
    }
});
