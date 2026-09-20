const test = require('node:test');
const assert = require('node:assert');

const {
    updateReadyHeadline, manualCheckView, planManualUpdateCheck,
    isUpdateCheckBusy, isUpdateCheckOccupied, updateCheckStall,
    UPDATE_CHECK_STATES, CHECK_STALL_MS, DOWNLOAD_STALL_MS
} = require('../src/shared/update-message');
const {translateMessage, LANGUAGES} = require('../src/shared/i18n');

test('names the version it was given', () => {
    assert.strictEqual(updateReadyHeadline('en', '0.2.1'), 'Version 0.2.1 is ready.');
    assert.strictEqual(updateReadyHeadline('en', '1.0.0-beta.2'), 'Version 1.0.0-beta.2 is ready.');
});

test('trims surrounding whitespace', () => {
    assert.strictEqual(updateReadyHeadline('en', '  0.3.0\n'), 'Version 0.3.0 is ready.');
});

test('falls back when the version is missing or not a version', () => {
    for (const bad of [undefined, null, '', '   ', 42, {}, '<img src=x onerror=alert(1)>', 'a b', '"0.1.0"']) {
        assert.strictEqual(updateReadyHeadline('en', bad), 'A new version is ready.',
            `expected the fallback for ${JSON.stringify(bad)}`);
    }
});

test('speaks the language it is given, and names the version in both', () => {
    const italian = updateReadyHeadline('it', '0.3.0');
    assert.ok(italian.includes('0.3.0'), italian);
    assert.notStrictEqual(italian, updateReadyHeadline('en', '0.3.0'));
    assert.notStrictEqual(updateReadyHeadline('it'), updateReadyHeadline('en'));
    // An unknown language falls back to English rather than showing a key.
    // 'zz' rather than a real code — 'de' used to be safe and is now shipped.
    assert.ok(!LANGUAGES.includes('zz'));
    assert.strictEqual(updateReadyHeadline('zz', '0.3.0'), updateReadyHeadline('en', '0.3.0'));
});

/* ────────────────────────────────────────────────────────────────────────────
 * "Check for updates now" — Settings › General
 *
 * The button itself can only be watched in a packaged build against a real
 * release feed, so every decision it makes is here instead.
 * ──────────────────────────────────────────────────────────────────────────── */

const PACKAGED = {packaged: true, portable: false};

test('a click starts a check when there is nothing in the way', () => {
    assert.deepStrictEqual(
        planManualUpdateCheck({...PACKAGED, state: 'idle'}),
        {start: true, state: 'checking'});
    // After an answer — either answer — the button works again.
    for (const state of ['upToDate', 'failed']) {
        assert.deepStrictEqual(
            planManualUpdateCheck({...PACKAGED, state}),
            {start: true, state: 'checking'}, state);
    }
});

test('the startup switch is not consulted: the click is its own consent', () => {
    // There is deliberately no `checkForUpdates` input to this function. The
    // only way that setting could reach a decision here is by being passed,
    // and a stray property must not change the answer either.
    assert.deepStrictEqual(
        planManualUpdateCheck({...PACKAGED, state: 'idle', checkForUpdates: false}),
        {start: true, state: 'checking'});
});

test('a check already in flight is answered, not started a second time', () => {
    // Including the startup check, which moves the same state.
    for (const state of ['checking', 'found']) {
        assert.deepStrictEqual(
            planManualUpdateCheck({...PACKAGED, state}),
            {start: false, state: 'busy'}, state);
    }
    // And an update that is already downloaded needs no further request.
    assert.deepStrictEqual(
        planManualUpdateCheck({...PACKAGED, state: 'downloaded'}),
        {start: false, state: 'downloaded'});
});

test('a dev run and the portable build answer instead of pretending', () => {
    assert.deepStrictEqual(
        planManualUpdateCheck({packaged: false, portable: false, state: 'idle'}),
        {start: false, state: 'devBuild'});
    // The dev answer wins even in a portable-looking environment, and neither
    // of them ever starts a check.
    assert.deepStrictEqual(
        planManualUpdateCheck({packaged: false, portable: true, state: 'idle'}),
        {start: false, state: 'devBuild'});
    assert.deepStrictEqual(
        planManualUpdateCheck({packaged: true, portable: true, state: 'idle'}),
        {start: false, state: 'portableBuild'});
    assert.deepStrictEqual(planManualUpdateCheck(), {start: false, state: 'devBuild'});
});

test('the button is disabled for exactly the in-flight states', () => {
    for (const state of UPDATE_CHECK_STATES) {
        const busy = ['checking', 'found', 'busy'].includes(state);
        assert.strictEqual(isUpdateCheckBusy(state), busy, state);
        assert.strictEqual(manualCheckView(state).disabled, busy, state);
    }
    assert.strictEqual(isUpdateCheckBusy('nonsense'), false);
    assert.strictEqual(manualCheckView('nonsense').disabled, false);
});

test('every state has a sentence, in both languages, and idle has none', () => {
    assert.strictEqual(manualCheckView('idle').message, null);
    assert.strictEqual(manualCheckView(undefined).message, null);
    for (const state of UPDATE_CHECK_STATES) {
        if (state === 'idle') continue;
        const {message} = manualCheckView(state, '0.7.0');
        assert.ok(message && message.key, state);
        for (const lang of LANGUAGES) {
            const text = translateMessage(lang, message);
            assert.ok(text && text.trim().length > 0, `${lang}: ${state}`);
            // A key that reached the UI is a missing translation, not a string.
            assert.notStrictEqual(text, message.key, `${lang}: ${state}`);
        }
    }
});

test('the outcome names the version, and drops one that is not a version', () => {
    assert.ok(translateMessage('en', manualCheckView('upToDate', '0.6.0').message).includes('0.6.0'));
    assert.ok(translateMessage('it', manualCheckView('upToDate', '0.6.0').message).includes('0.6.0'));
    assert.ok(translateMessage('en', manualCheckView('found', '0.7.0').message).includes('0.7.0'));
    // Same guard as the banner headline: the version comes off the release
    // feed, so anything implausible falls back to a version-less wording.
    for (const bad of [undefined, null, '', '   ', 42, {}, '<img src=x onerror=alert(1)>', 'a b']) {
        assert.strictEqual(manualCheckView('upToDate', bad).message.key,
            'update.manual.upToDateUnknown', JSON.stringify(bad));
        assert.strictEqual(manualCheckView('found', bad).message.key,
            'update.manual.foundUnknown', JSON.stringify(bad));
    }
});

test('the automatic check stands down for a check in flight or a ready update', () => {
    // `show()` re-runs it on every tray reopen, and its 4 s timer fires into
    // whatever the button has started meanwhile.
    for (const state of ['checking', 'found', 'busy', 'downloaded']) {
        assert.strictEqual(isUpdateCheckOccupied(state), true, state);
    }
    for (const state of ['idle', 'upToDate', 'failed', 'devBuild', 'portableBuild', 'nonsense']) {
        assert.strictEqual(isUpdateCheckOccupied(state), false, state);
    }
    // Every busy state is occupied, by construction.
    for (const state of UPDATE_CHECK_STATES) {
        if (isUpdateCheckBusy(state)) assert.ok(isUpdateCheckOccupied(state), state);
    }
});

test('the watchdog only watches the states that can hang', () => {
    for (const state of UPDATE_CHECK_STATES) {
        const {stalled, waitMs} = updateCheckStall({state, lastActivityAt: 1000, now: 1000});
        assert.strictEqual(stalled, false, state);
        // A busy state is always being timed; nothing else is ever armed.
        assert.strictEqual(waitMs > 0, isUpdateCheckBusy(state), state);
    }
    // The check gets seconds, the download gets minutes — it is a big file.
    assert.strictEqual(updateCheckStall({state: 'checking', lastActivityAt: 0, now: 0}).waitMs,
        CHECK_STALL_MS);
    assert.strictEqual(updateCheckStall({state: 'found', lastActivityAt: 0, now: 0}).waitMs,
        DOWNLOAD_STALL_MS);
    assert.ok(DOWNLOAD_STALL_MS > CHECK_STALL_MS);
});

test('a silent check or download is given up on, not left disabled forever', () => {
    // The bug this exists for: the download dies, no `error` event ever
    // arrives, and the button stays disabled until the app is restarted.
    const dead = updateCheckStall({
        state: 'found', lastActivityAt: 1000, now: 1000 + DOWNLOAD_STALL_MS});
    assert.deepStrictEqual(dead, {stalled: true, state: 'failed', waitMs: 0});
    // And the button comes back, which is the whole point.
    assert.strictEqual(manualCheckView(dead.state).disabled, false);
    const noAnswer = updateCheckStall({
        state: 'checking', lastActivityAt: 1000, now: 1000 + CHECK_STALL_MS + 1});
    assert.deepStrictEqual(noAnswer, {stalled: true, state: 'failed', waitMs: 0});
});

test('a download that is merely slow is never cut off', () => {
    // `download-progress` is the liveness signal, and every tick moves
    // `lastActivityAt` — so ten minutes of steady progress never stalls.
    let lastActivityAt = 1000;
    for (let tick = 1; tick <= 20; tick++) {
        const now = 1000 + tick * 30000;
        const verdict = updateCheckStall({state: 'found', lastActivityAt, now});
        assert.strictEqual(verdict.stalled, false, `tick ${tick}`);
        assert.ok(verdict.waitMs > 0, `tick ${tick}`);
        lastActivityAt = now;
    }
    // One second short of the limit is still alive; the limit itself is not.
    assert.strictEqual(updateCheckStall({
        state: 'found', lastActivityAt: 1000, now: 1000 + DOWNLOAD_STALL_MS - 1000}).stalled,
        false);
});

test('a nonsense or backwards clock waits another period rather than killing it', () => {
    // A suspended laptop, a clock correction, or a state that was set before
    // anything recorded a timestamp. Declaring a live download dead on
    // arithmetic would be the one unrecoverable answer.
    for (const args of [
        {state: 'found', lastActivityAt: undefined, now: 5000},
        // 0 is the field's initial value: busy before anything was recorded.
        {state: 'found', lastActivityAt: 0, now: 5000},
        {state: 'found', lastActivityAt: null, now: 5000},
        {state: 'found', lastActivityAt: NaN, now: 5000},
        {state: 'found', lastActivityAt: 9000, now: 5000},
        {state: 'found', lastActivityAt: 5000, now: undefined}
    ]) {
        const verdict = updateCheckStall(args);
        assert.strictEqual(verdict.stalled, false, JSON.stringify(args));
        assert.strictEqual(verdict.waitMs, DOWNLOAD_STALL_MS, JSON.stringify(args));
    }
    assert.deepStrictEqual(updateCheckStall(), {stalled: false, state: undefined, waitMs: 0});
});

test('a failure says one sentence — never the error, never a path', () => {
    const text = translateMessage('en', manualCheckView('failed').message);
    assert.ok(!/[\\/]/.test(text), text);
    assert.ok(!/\berror\b/i.test(text) || !text.includes('Error:'), text);
    // The two "this build cannot update" answers are plain sentences too.
    assert.ok(!/[\\/]/.test(translateMessage('en', manualCheckView('devBuild').message)));
    assert.ok(!/[\\/]/.test(translateMessage('en', manualCheckView('portableBuild').message)));
});
