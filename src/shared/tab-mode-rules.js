'use strict';

/**
 * PURE rules for **Tab-map mode** (experimental, off by default).
 *
 * While the player holds Tab the game draws a big fixed map with the player's
 * own arrow on it. In this mode the app draws the marker brackets and a legend
 * straight over *that* map, in a second transparent click-through window, for
 * exactly as long as the Tab screen is up.
 *
 * Nothing here touches electron, `fs`, a timer or a pixel. It holds the two
 * decisions the feature lives or dies by:
 *
 *   1. **The scheduler** (`reduceTabMode`) — when to look again, when to show
 *      and, above all, when to hide. Markers left over live gameplay are the
 *      failure that matters; every rule below leans towards hiding. It also
 *      owns the one place the feature is allowed to *guess*
 *      (`shouldShowProvisionally`), and the deadline that bounds the guess.
 *   2. **The DPI conversion** (`gameRectToDip`) — `node-screenshots` reports a
 *      window rectangle in **physical** pixels, Electron places a window in
 *      **DIPs**, and on a mixed-DPI desktop the two differ per monitor. Getting
 *      this wrong puts the markers on the wrong monitor, which is why it is
 *      pure and unit tested across 100 % / 125 % / 150 %.
 *
 * ## Cadences, measured rather than chosen
 *
 * Measured on the dev machine in plain node against a real 1920x1032 window
 * (`node-screenshots` 0.2.8), 25-30 ticks each:
 *
 * | tick | capture (async native) | toRaw | blocking JS | wall |
 * |---|---|---|---|---|
 * | today's full detector tick | 17.6 ms | 2.6 ms | 5.5 ms | 26.8 ms |
 * | fast Tab check (gate read off the raw buffer) | 17.4 ms | 2.5 ms | **1.40 ms** | **21.3 ms** |
 * | …its early-out (left panel only) | — | — | 1.34 ms | — |
 *
 * `node-screenshots` **cannot capture less than a whole window**: `Image.crop`
 * exists but runs on the image the grab already produced. Cropping to the gate
 * box before `toRaw` was measured too — it saves 1.9 ms of `toRaw` and costs
 * 3.5 ms of `crop`, i.e. it is a net loss — so the fast check captures the
 * window and reads the gate straight off the raw RGBA buffer, touching only the
 * two gate regions (21.9 % of the frame) and allocating nothing on the JS heap.
 *
 *  - `FAST_INTERVAL` **150 ms**: 1.40 ms of blocking JS every 150 ms is **0.9 %
 *    of one core**, and the 21.3 ms wall time is a seventh of the interval, so
 *    a slow capture can never queue ticks behind itself. It also bounds how
 *    long markers can outlive a Tab release at one tick — see the debounce.
 *  - `DETECT_INTERVAL` **450 ms**, replacing the normal 700 ms *only while this
 *    mode is on and running*: 700 ms is what decides how long markers take to
 *    **appear**, and a 1 s Tab press only fits one tick at 700 ms. 450 ms fits
 *    two, halving the worst case from ~730 ms to ~480 ms. It costs 5.5 ms per
 *    700 ms (0.8 % of a core) → 5.5 ms per 450 ms (1.2 %), which is the whole
 *    price of the change and it is only paid with the mode on.
 */

/** Fast "is the Tab screen still up?" cadence, while markers are shown. */
const FAST_INTERVAL = 150;

/** The detector's cadence while Tab mode is on — see the table above. */
const DETECT_INTERVAL = 450;

/**
 * Consecutive negative gates before the markers are taken down. **One.**
 *
 * The argument for two is a false negative on a real Tab screen; the argument
 * for one is markers sitting over live gameplay. Measured, the first hazard
 * barely exists: the Tab gate separates 0.99 from 0.27-0.65 on the dark
 * fraction and 0.09-0.11 from 0.000 on the name box (`matcher.js`), and the
 * four killer-view reference frames with the game's own discovered-exit icons
 * on them pass at 0.986-0.995 / 0.084-0.115. The ways a check can go wrong
 * *other* than the arithmetic — an empty capture, a window that vanished — are
 * handled as `lost`, not as a negative gate, so they do not depend on this
 * number either.
 *
 * The costs are asymmetric. Hiding one tick early costs 150 ms of missing
 * markers that come back on the next positive check and which the player, who
 * has just released Tab, is not looking at. Hiding one tick late costs 150 ms
 * of brackets painted over the game the player *is* looking at — and at two
 * that becomes 300 ms. When in doubt, hide.
 */
const HIDE_AFTER_NEGATIVE = 1;

/* ────────────────────────────────────────────────────────────────────────────
 * The key trigger (0.7) — and the two methods it chooses between
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * How often the map key's state is read while the trigger is running.
 *
 * Measured with plain node on the dev machine: one `GetAsyncKeyState` through
 * koffi costs **28 ns**, so at 30 ms this is 0.00009 % of one core — four
 * orders of magnitude under the capture path it replaces. 30 ms was checked
 * end to end against a synthesised 400 ms Tab press: the down edge was seen
 * 15 ms late and the up edge 8 ms late, so a realistic 1-3 s hold cannot be
 * missed and the release is acted on within one tick.
 *
 * Not lower: the point of the trigger is that it is free, and a 1 ms timer in
 * an Electron main process costs more in timer bookkeeping than the call it
 * would make.
 */
const KEY_POLL_INTERVAL = 30;

/**
 * The **safety** cadence while markers are shown and the key trigger is
 * healthy: the screen gate, twice a second.
 *
 * With the trigger working, show and hide are both edge-driven, so this is not
 * how the markers come down — it is the net under a key-up this process never
 * saw. That can happen: the game window can take the key-up while our process
 * is suspended, a remote-desktop session can reset the keyboard state, and
 * `GetAsyncKeyState` reports the *physical* key, which a driver can get stuck.
 * Markers left over live gameplay is the failure that matters, so there is
 * always a check running, however cheap the trigger is.
 *
 * 500 ms rather than 150: the trigger normally gets there first (within 30 ms),
 * so this costs 1.4 ms of blocking JS twice a second — 0.3 % of one core — and
 * bounds the worst case at half a second instead of a whole match.
 */
const SAFETY_INTERVAL = 500;

/**
 * Retries of the confirming capture while the map key is **still held**, as
 * delays from the previous attempt.
 *
 * The first confirmation happens on the key-down edge, which can easily be
 * *too early*: the game fades its Tab screen in, so a capture 30 ms after the
 * press may still show gameplay. One attempt and nothing else would then leave
 * the next chance to the detector's own 700 ms tick — **slower than the polling
 * path's 450 ms**, i.e. the trigger would have made the feature worse in
 * exactly the case it was added for.
 *
 * So: a look every 50 ms (plus the ~45 ms each capture takes) for the first
 * half second, then one last at +100. The first schedule was 60 / 90 / 150, and
 * the owner's field log (39 presses) showed why that was wrong: the game's fade
 * takes 250-330 ms, so the first two looks always came too early and the third
 * sat right on the edge — markers appeared 320-530 ms after the press, median
 * 353. Evenly spaced looks catch the first frame that passes instead of the
 * first one the schedule happens to land on. Each retry costs the same as one
 * detector tick, runs in the worker, and only happens while the key is down and
 * nothing is showing yet; after the last one the 500 ms safety check takes over.
 */
const CONFIRM_RETRY_DELAYS = [50, 50, 50, 50, 50, 100];

/* ────────────────────────────────────────────────────────────────────────────
 * The optimistic show (0.7) — `tabMarkersInstant`
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * How long markers may stay up **without** a capture having confirmed them.
 *
 * The retry schedule above exists because the confirming capture on the
 * key-down edge is usually too early: the owner's field log (39 presses)
 * measured the game's own fade at **250-330 ms**, and the markers therefore
 * appeared 320-530 ms after the press, median 353. That delay is not the app
 * being slow — it is the app politely waiting for a screen that is already on
 * its way.
 *
 * So, from the *second* press of a match onwards (the first one still has to
 * earn it — see `shouldShowProvisionally`), the markers go up on the key-down
 * edge in a **provisional** state and fade in over ~300 ms alongside the
 * game's own fade. The confirming capture runs exactly as before, in parallel.
 *
 * 550 ms is the whole budget for that gamble, and it is what keeps the
 * feature's one non-negotiable invariant — *markers may never linger over
 * gameplay* — true even when everything else fails:
 *
 *  - It clears a **confirmation that really happens**. The owner's log has
 *    confirmations as late as **530 ms** after the press, and the confirming
 *    attempts land at roughly 0 / 95 / 190 / 285 / 380 / 475 ms (each retry
 *    delay plus the ~45 ms the capture itself takes), so the last look is
 *    answered at ~520 ms. 450 would have cut the slowest genuine presses off
 *    just before the screen proved them right — a *show, hide, re-show*, which
 *    is worse than having waited.
 *  - It is still about half a second, so a press in chat or the pause menu —
 *    where the map never opens and nothing will ever confirm — is a *flash*,
 *    not a display. With the ease-in fade the first ~100 ms of that flash are
 *    all but invisible.
 *  - It is enforced by a **timer of this mode's own**, not by the answer to a
 *    capture. A worker that has died, is restarting or never replies cannot
 *    hold provisional markers up: the deadline does not depend on it, and
 *    nothing but a hide is allowed to cancel it.
 *
 * A deadline that expires also **forgets** the memory that allowed the gamble
 * (`forgetConfirmedMap`), so a player mashing the key in a lobby flashes at
 * most once and then goes back to the slow, certain path — and, if the key is
 * *still held*, the caller restarts that slow path for the same press rather
 * than leaving it to the detector's next 700 ms tick.
 */
const PROVISIONAL_DEADLINE_MS = 550;

/**
 * How long a "a press was confirmed on this map" memory is worth acting on.
 *
 * The memory is cleared by everything that says a match ended — the main menu,
 * the game window going away, the mode stopping, a hide that was not simply
 * the player letting go. But there is one case none of those cover: a match
 * that ends and another that begins, on a *different* map, without the main
 * menu ever being recognised and without the game window ever disappearing.
 * The detector's own `lastDetected` can name the old map right through that,
 * so "both halves agree" agrees on something stale.
 *
 * Five minutes is the bound on it. It is far longer than a match's worth of
 * Tab presses — a player reads the map every few seconds — so it never costs
 * anything during play, and it means a memory can only ever be *that* stale.
 * The residual hazard is one faded show of the wrong map for at most
 * `PROVISIONAL_DEADLINE_MS`, replaced by the right payload the moment the
 * confirming capture answers.
 *
 * It is not a heartbeat: every confirmation refreshes it, so a match that runs
 * for an hour keeps the fast path for the whole hour.
 */
const CONFIRMED_MEMORY_MS = 5 * 60 * 1000;

/**
 * Hide reasons after which the "a press was confirmed on this map" memory
 * survives — i.e. the *only* two that mean "the same match is still running
 * and the player simply let go of the key".
 *
 * Everything else forgets, deliberately: the safe direction here is the slow
 * path, because the slow path cannot flash. A window that moved, a capture
 * that failed, a frame that never came, the main menu, the game closing, a
 * deadline that expired — after any of those the next press pays the ordinary
 * 320-530 ms again, and buys the fast path back the moment one press is
 * confirmed.
 *
 * **And they only apply to a show that was confirmed.** A hide that ends a
 * show still in the *provisional* state forgets whatever the reason, because
 * the press it ended proved nothing: a tap shorter than the game's own fade
 * releases the key before any capture can confirm, and keeping the memory
 * there would let every tap in a chat window flash. The cost is one slow press
 * after a genuine tap shorter than ~300 ms, which is a press whose markers
 * the player did not stay to read anyway.
 */
const MEMORY_KEEPING_HIDE_REASONS = ['key-up', 'released'];

/**
 * How long to wait before confirmation attempt `attempt` (1-based), or null
 * when there are no retries left.
 *
 * @param {number} attempt how many attempts have already been made
 * @returns {?number} ms from now
 */
function confirmRetryDelay(attempt) {
    if (!isFiniteNumber(attempt) || attempt < 1) return CONFIRM_RETRY_DELAYS[0];
    const index = Math.floor(attempt) - 1;
    return index < CONFIRM_RETRY_DELAYS.length ? CONFIRM_RETRY_DELAYS[index] : null;
}

/** The `markerTrigger` setting: let the app choose, or force the polling path. */
const TRIGGER_MODES = ['auto', 'polling'];

/**
 * Which method is actually in use.
 *
 * **Three states, because two lied.** The first field run of a packaged build
 * had the game closed, and the app reported `method=polling reason=unavailable`
 * — which Settings renders as *"reading the key state is not available on this
 * PC"*. Nothing had been tried; the trigger simply had no game window to watch
 * and so had never been started. Alarming, false, and it made the whole
 * antivirus test meaningless, because koffi was never loaded.
 *
 * So:
 *
 * - **`key`** — the trigger is running and reading the map key.
 * - **`key-waiting`** — the key method is what will be used; it is waiting for
 *   the game. Nothing is being read at all. `available` is *not* false here:
 *   either the probe succeeded, or nothing has been probed yet.
 * - **`polling`** — and the reason is always specific: `forced` (the user
 *   asked), or `load` / `bind` / `probe` / `call` from the native path. The
 *   polling path is the complete implementation and remains the reference
 *   behaviour, so this is a change of method, not a loss of the feature.
 *
 * `polling` is also the user's escape hatch, and it is deliberately not called
 * "off": there is no state in which Tab-map mode has no way to work.
 *
 * @param {{mode: *, available: ?boolean, running: ?boolean,
 *          gameWindow: ?boolean, reason: ?string}} state
 *   `available` is `false` only when a probe actually failed; `undefined` means
 *   "not probed yet".
 * @returns {{method: 'key'|'key-waiting'|'polling', reason: string}}
 */
function resolveTriggerMethod(state) {
    // No state at all is a caller bug, and the safe answer to a caller bug is
    // the path that always works *and* the faster safety cadence — `key-waiting`
    // would report the 500 ms net while the 150 ms loop was the thing actually
    // holding the markers up.
    if (!state || typeof state !== 'object') return {method: 'polling', reason: 'unavailable'};
    const {mode, available, running, gameWindow, reason} = state;
    if (mode === 'polling') return {method: 'polling', reason: 'forced'};
    // `=== false`, not `!available`: "not probed yet" is not "broken". Saying
    // *unavailable* when nothing has been tried is the field bug this state
    // machine was rewritten for.
    if (available === false) return {method: 'polling', reason: reason || 'unavailable'};
    if (running) return {method: 'key', reason: 'key'};
    // Usable (or untried) but not polling: there is nothing to poll for. The
    // key method **is** the method — it is simply waiting for the game.
    return {method: 'key-waiting', reason: gameWindow ? 'idle' : 'no-game'};
}

/** Normalise a stored `markerTrigger` value. */
function triggerMode(value) {
    return TRIGGER_MODES.includes(value) ? value : 'auto';
}

/**
 * The cadence of the periodic check, given the method in use.
 *
 * In `polling` it *is* the show/hide mechanism, so it is the fast one; with the
 * key trigger it is only the safety net described above.
 *
 * @param {'key'|'polling'} method
 * @returns {number} ms
 */
function checkInterval(method) {
    // `key-waiting` gets the key cadence too. It cannot matter — this loop only
    // runs while markers are shown, and nothing can be shown without a game
    // window — but reporting the *fast* cadence in that state would print a
    // number that is not in effect, which is the class of lie this whole
    // three-state change is about.
    return method === 'key' || method === 'key-waiting' ? SAFETY_INTERVAL : FAST_INTERVAL;
}

/**
 * Does the detector need to poll faster than its usual 700 ms?
 *
 * Only for the polling path: 450 ms is what buys a shorter *appearance*
 * latency when a capture is the only way to notice the Tab screen. With the key
 * trigger the appearance is edge-driven (~30 ms + one confirming capture), so
 * the override is pure cost and is dropped — which is the main measurable win
 * of the trigger, not the 28 ns.
 *
 * @param {{running: boolean, method: string}} state
 * @returns {?number} the override in ms, or null for "leave it alone"
 */
function detectIntervalFor(state) {
    const {running, method} = state || {};
    if (!running) return null;
    // Only the polling path needs it. `key-waiting` explicitly does not: with
    // no game window the detector is on its 2 s idle cadence and captures
    // nothing anyway, and the moment the game appears the key method takes
    // over — so overriding to 450 ms there would be a cost paid for a path
    // that is never going to run.
    return method === 'polling' ? DETECT_INTERVAL : null;
}

/**
 * One reading of the map key → the hint to feed the reducer, or nothing.
 *
 * Pure, so every rule below is testable without koffi, without a keyboard and
 * without Electron. Three of them are refusals, and **all three resolve to
 * "the key is not down"** rather than to "ignore this reading" — because the
 * safe direction is always to hide:
 *
 * - **The game is not the foreground window.** Tab moves focus in a browser,
 *   in chat and in every form on the machine. A key read while the player is
 *   elsewhere means nothing — and the caller does not even *read* the key in
 *   that case, so this is checked first here too, mirroring the order the
 *   trigger asks its questions in.
 * - **Alt is held.** Alt+Tab is Windows switching windows, not the player
 *   opening the map. `VK_MENU` is the *only* other key this feature ever asks
 *   about, and only while the map key itself reads as down.
 * - **The trigger is not the active method.** Belt and braces: a stale timer
 *   after a fallback must not produce hints.
 *
 * A `down` hint only ever *asks for a check*; the screen gate is what shows
 * anything (see `reduceTabMode`). An `up` hint hides immediately, which is why
 * the refusals above are allowed to produce one.
 *
 * @param {{down: boolean, alt: boolean, foreground: boolean, wasDown: boolean,
 *          enabled?: boolean}} reading
 * @returns {{hint: ?('down'|'up'), down: boolean, reason: string}}
 *   `down` is the state to remember for the next reading.
 */
function keyHintFor(reading) {
    const r = reading || {};
    const wasDown = !!r.wasDown;
    let down = !!r.down;
    let reason = down ? 'down' : 'up';
    if (r.enabled === false) { down = false; reason = 'disabled'; }
    else if (!r.foreground) { down = false; reason = 'not-foreground'; }
    else if (down && r.alt) { down = false; reason = 'alt'; }
    if (down === wasDown) return {hint: null, down, reason: 'unchanged'};
    return {hint: down ? 'down' : 'up', down, reason};
}

/* ────────────────────────────────────────────────────────────────────────────
 * The scheduler
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The reducer's state. Keys, a counter and two flags — no timers, no handles.
 *
 *  - `showing` / `key` / `negatives` — as they always were.
 *  - `provisional` — the markers are up, but only because the key went down
 *    and this map had been confirmed before. Nothing has looked at the screen
 *    yet. The caller holds them to `PROVISIONAL_DEADLINE_MS`.
 *  - `confirmedKey` — the map a Tab press has been **confirmed** on since this
 *    memory was last cleared, and therefore the only map that may ever be
 *    shown provisionally. Null means "the next press takes the slow path".
 */
function initialTabModeState() {
    return {showing: false, key: null, negatives: 0, provisional: false, confirmedKey: null};
}

function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Drop the "a press was confirmed on this map" memory, leaving everything else
 * — what is on screen, the counters, the loop — exactly as it was.
 *
 * Deliberately **not** an event of the reducer: the caller uses it from places
 * that must not disturb a timer (the detector's known map changing under us,
 * the game window going away while nothing is showing), and routing it through
 * `reduceTabMode` would make those places re-arm or clear the loops as a side
 * effect. The decision is still here, which is what matters.
 *
 * @param {Object} state
 * @returns {Object} the same object when there was nothing to forget
 */
function forgetConfirmedMap(state) {
    const current = state || initialTabModeState();
    if (!current.confirmedKey) return current;
    return Object.assign({}, current, {confirmedKey: null});
}

/**
 * Is a "a press was confirmed on this map" memory still worth acting on?
 *
 * See `CONFIRMED_MEMORY_MS`. Pure, and the clock is the caller's, so a test
 * can be five minutes old without waiting five minutes.
 *
 * A clock that went **backwards** (a system time change, a suspend/resume)
 * answers *no* rather than "infinitely fresh": every refusal here costs one
 * slow press, and every wrong yes costs a faded show of possibly the wrong
 * map.
 *
 * @param {number} confirmedAt when the last confirmation landed; 0 = never
 * @param {number} now
 * @param {number} [maxAgeMs]
 * @returns {boolean}
 */
function confirmedMemoryFresh(confirmedAt, now, maxAgeMs) {
    if (!isFiniteNumber(confirmedAt) || confirmedAt <= 0) return false;
    if (!isFiniteNumber(now)) return false;
    const limit = isFiniteNumber(maxAgeMs) && maxAgeMs > 0 ? maxAgeMs : CONFIRMED_MEMORY_MS;
    const age = now - confirmedAt;
    return age >= 0 && age <= limit;
}

/**
 * May the markers go up **now**, on the key-down edge, before anything has
 * looked at the screen?
 *
 * Every one of these is a reason the gamble is safe *and* worth taking, and
 * they are checked in the order in which they answer "why not":
 *
 * 1. **`instant`** — the user may switch the whole thing off
 *    (`tabMarkersInstant`, default on). Off means "always wait": nothing can
 *    flash, at the cost of about a third of a second.
 * 2. **`method === 'key'`** — only the key trigger produces a key-down *edge*
 *    at all. The polling path has no edge to be optimistic about: its only
 *    signal is the capture, and the capture is the thing being pre-empted.
 * 3. **`foreground`** — the game must be the window in front. This is already
 *    true of every `down` hint (`keyHintFor` resolves a reading taken outside
 *    the game to "up", and `core/key-trigger.js` does not even read the key
 *    unless `GetForegroundWindow`'s pid is the game's), and it is stated here
 *    anyway, because a rule that is only true by someone else's construction
 *    is a rule that stops being true when that construction changes.
 * 4. **Nothing is showing** — a provisional show is a *start*, never an
 *    update to markers that are already up.
 * 5. **`mapKey`, and it is the confirmed one** — the app has to know which map
 *    this match is on, and a press must have been confirmed on *that same map*
 *    since the memory was last cleared. This is what makes the **first** Tab
 *    press of a match exactly as slow, and exactly as certain, as it has
 *    always been: there is nothing to be optimistic with until the screen has
 *    been read once.
 * 6. **`drawable`** — a payload exists (markers, a Tab transform, at least one
 *    layer on). "Show nothing, faster" is not a feature.
 * 7. **`bounds`** — the game window's rectangle is known and converts to a
 *    valid, unclamped place to draw. A clamped rectangle means "somewhere
 *    nobody chose", which is the one thing worse than late markers.
 *
 * @param {{showing: boolean, provisional: boolean, confirmedKey: ?string}} state
 * @param {{instant?: boolean, method?: string, foreground?: boolean,
 *          mapKey?: ?string, drawable?: boolean, bounds?: boolean}} context
 * @returns {{show: boolean, key: ?string, reason: string}}
 */
function shouldShowProvisionally(state, context) {
    const s = state || initialTabModeState();
    const c = context || {};
    const no = (reason) => ({show: false, key: null, reason});
    // `=== false`, not `!c.instant`: a caller that has not read the setting yet
    // must not silently get the *off* behaviour, which is the shape of bug
    // `resolveTriggerMethod` was rewritten for.
    if (c.instant === false) return no('off');
    if (c.method !== 'key') return no('method');
    if (!c.foreground) return no('not-foreground');
    if (s.showing) return no('showing');
    const key = c.mapKey || null;
    if (!key) return no('no-map');
    if (s.confirmedKey !== key) return no('first-press');
    if (!c.drawable) return no('not-drawable');
    if (!c.bounds) return no('no-bounds');
    return {show: true, key, reason: 'ok'};
}

/**
 * One step of the Tab-mode scheduler.
 *
 * A pure reducer over `(state, event)`. The caller owns the timer and the
 * windows; this decides *what* should happen and hands back both the next state
 * and the effects to apply, so the whole show/hide policy is unit testable
 * without Electron, without a capture and without waiting 150 ms for anything.
 *
 * Events:
 *   - `{type: 'match', key, drawable}` — the ordinary detector accepted a map
 *     on a frame that passed the Tab gate. `drawable` is "this map has markers
 *     and a Tab transform, and at least one layer is switched on"; a map we
 *     cannot draw takes the markers **down** rather than leaving the previous
 *     map's on screen.
 *   - `{type: 'gate', up}` — the result of one fast check.
 *   - `{type: 'lost', reason}` — the game window disappeared, minimised, moved
 *     or resized, the capture failed, auto-detect stopped, the main menu was
 *     recognised, or the app is quitting. Always an immediate hide.
 *   - `{type: 'hint', key: 'down'|'up', provisional?, mapKey?}` — one edge of
 *     the key-state trigger (see below). `provisional: true` is the caller
 *     saying "`shouldShowProvisionally` said yes for `mapKey`".
 *   - `{type: 'stop'}` — the mode was switched off.
 *
 * Effects: `{show, hide, checkNow, nextCheckMs, reason}`. `nextCheckMs` is
 * `null` when the fast loop should not be running at all — the caller chains a
 * `setTimeout`, never a `setInterval`, so a slow capture cannot queue ticks.
 *
 * ## The key-state seam
 *
 * The owner may later drive this from the game's map key (Tab by default, and
 * user-configurable) read with a key-**state** query rather than polled pixels.
 * That arrives here as a `hint`, alongside — not instead of — the timer ticks:
 *
 *   - `down` asks for an immediate check (`checkNow`). On its own it **never
 *     shows anything**: a key press is not evidence that the Tab screen is up
 *     — the player may be typing in chat, or in a menu, or the key may be
 *     bound to something else in that match. The one exception is the
 *     *optimistic* show, and it is not an exception to that rule: it needs a
 *     press on this very map to have been confirmed **by the screen gate**
 *     already, it is drawn provisionally, and it is taken down again within
 *     `PROVISIONAL_DEADLINE_MS` unless the gate confirms it too. Nothing is
 *     ever shown for a map the screen has never been read on.
 *   - `up` hides at once — the one case where the key is better evidence than a
 *     capture, because it is instantaneous and the capture is 150 ms behind.
 *
 * The polling path below is complete without either, and stays the fallback.
 * Nothing in this project reads a key; this is the shape that would let it.
 *
 * @param {{showing: boolean, key: ?string, negatives: number,
 *          provisional: boolean, confirmedKey: ?string}} state
 * @param {{type: string, key?: *, drawable?: boolean, up?: boolean,
 *          reason?: string, provisional?: boolean, mapKey?: ?string}} event
 * @param {{fastMs?: number, hideAfterNegative?: number}} [opts]
 * @returns {{state: Object, effects: {show: boolean, hide: boolean,
 *           checkNow: boolean, nextCheckMs: ?number, key: ?string, reason: string,
 *           provisional: boolean, confirmed: boolean}}}
 */
function reduceTabMode(state, event, opts) {
    const o = opts || {};
    const fastMs = isFiniteNumber(o.fastMs) ? o.fastMs : FAST_INTERVAL;
    const hideAfter = isFiniteNumber(o.hideAfterNegative) && o.hideAfterNegative >= 1
        ? Math.floor(o.hideAfterNegative) : HIDE_AFTER_NEGATIVE;
    const current = state || initialTabModeState();
    const type = event && event.type;

    const keep = (next, effects) => ({
        state: Object.assign({}, current, next),
        effects: Object.assign({
            show: false, hide: false, checkNow: false, nextCheckMs: null, key: null, reason: '',
            // True only on the one show that goes up without having been seen:
            // the caller flags the payload so the renderer fades it in, counts
            // it, and arms the deadline that bounds it.
            provisional: false,
            // True on the `match` that turns a provisional show into a certain
            // one. Nothing visible changes; it is the moment worth logging.
            confirmed: false
        }, effects)
    });
    const down = (reason) => keep(
        {
            showing: false, key: null, negatives: 0, provisional: false,
            // The optimistic memory survives only a hide that means "the same
            // match is still running and the key came up" — and only when what
            // it ended had actually been confirmed. See
            // `MEMORY_KEEPING_HIDE_REASONS`.
            confirmedKey: (!current.provisional && MEMORY_KEEPING_HIDE_REASONS.includes(reason))
                ? current.confirmedKey : null
        },
        {hide: current.showing, nextCheckMs: null, reason}
    );

    switch (type) {
        case 'match': {
            if (!event.drawable) {
                // A recognised map we cannot draw (no markers, no Tab
                // transform, or every layer switched off). Taking the previous
                // map's markers down is the only honest answer — leaving them
                // would put one map's cellars on another map.
                return down('not-drawable');
            }
            const changed = current.key !== event.key;
            return keep(
                {
                    showing: true, key: event.key, negatives: 0, provisional: false,
                    // A confirmed press is exactly what earns this map the fast
                    // path next time.
                    confirmedKey: event.key
                },
                {
                    // Already up and for the same map: **nothing is re-sent**.
                    // A provisional show is mid-fade when its confirmation
                    // lands, and re-placing the same payload would restart that
                    // animation from zero — the markers would appear to flicker
                    // at the exact moment the app became sure of them. A
                    // *different* map is replaced, without a fade, because that
                    // payload is new information rather than the same one.
                    show: !current.showing || changed,
                    confirmed: current.provisional,
                    nextCheckMs: fastMs,
                    key: event.key,
                    reason: current.provisional ? 'confirmed' : (changed ? 'match' : 'same')
                }
            );
        }
        case 'gate': {
            if (!current.showing) {
                // Nothing is up, so the fast loop has no job: the ordinary
                // detector is what finds the Tab screen and the map on it. A
                // gate pass alone must never show markers — it says "a Tab
                // screen", not "this map".
                return keep({negatives: 0}, {nextCheckMs: null, reason: 'idle'});
            }
            if (event.up) return keep({negatives: 0}, {nextCheckMs: fastMs, key: current.key, reason: 'still-up'});
            if (current.provisional) {
                // A negative gate is *expected* while a provisional show is
                // up: the whole reason the markers went up early is that the
                // game has not finished fading its map in, and a screen that is
                // still fading is exactly what the gate says no to. Hiding here
                // would undo the feature at the one moment it is doing its job.
                // The deadline — a timer of the caller's own, independent of
                // any capture — is what bounds this state instead, and the
                // ordinary rules resume the moment it is confirmed.
                return keep({negatives: 0}, {nextCheckMs: fastMs, key: current.key, reason: 'fading'});
            }
            const negatives = current.negatives + 1;
            if (negatives < hideAfter) {
                return keep({negatives}, {nextCheckMs: fastMs, key: current.key, reason: 'negative'});
            }
            return down('released');
        }
        case 'hint': {
            if (event.key === 'up') return down('key-up');
            if (event.key !== 'down') return keep({}, {nextCheckMs: current.showing ? fastMs : null, reason: 'hint'});
            if (event.provisional === true && !current.showing && event.mapKey) {
                // The optimistic show. The caller has already asked
                // `shouldShowProvisionally` — that is what `event.provisional`
                // means — so this branch only records it and asks for the
                // confirming capture *as well*, exactly as an ordinary press
                // would. Nothing here replaces the screen gate: it replaces
                // *waiting* for the screen gate.
                return keep(
                    {showing: true, key: event.mapKey, negatives: 0, provisional: true},
                    {
                        show: true, provisional: true, checkNow: true, nextCheckMs: fastMs,
                        key: event.mapKey, reason: 'provisional'
                    }
                );
            }
            // Ask for a check *now*; the gate still decides. While markers are
            // already up this is a no-op beyond keeping the loop alive.
            return keep({}, {
                checkNow: !current.showing,
                nextCheckMs: current.showing ? fastMs : null,
                key: current.key,
                reason: 'key-down'
            });
        }
        case 'lost':
            return down((event && event.reason) || 'lost');
        case 'stop':
            return down('stopped');
        default:
            return keep({}, {nextCheckMs: current.showing ? fastMs : null, reason: 'ignored'});
    }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Physical pixels → DIPs
 * ──────────────────────────────────────────────────────────────────────────── */

/** Do two rectangles overlap at all? */
function overlapArea(a, b) {
    const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
}

function isRect(rect) {
    return !!rect && isFiniteNumber(rect.x) && isFiniteNumber(rect.y)
        && isFiniteNumber(rect.width) && isFiniteNumber(rect.height)
        && rect.width > 0 && rect.height > 0;
}

/**
 * Which display a physical rectangle is on.
 *
 * The centre first, because that is what "the window is on this monitor" means
 * to a person; the largest overlap when the centre is nowhere (a window pulled
 * past the edge of the desktop); the primary display as the last resort.
 *
 * @param {{x, y, width, height}} rect physical pixels
 * @param {Array<{bounds, physical, scaleFactor, primary?: boolean}>} displays
 * @returns {?Object}
 */
function displayForRect(rect, displays) {
    const list = (displays || []).filter(d => d && isRect(d.physical) && isRect(d.bounds));
    if (!list.length) return null;
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    for (const display of list) {
        const p = display.physical;
        if (cx >= p.x && cx < p.x + p.width && cy >= p.y && cy < p.y + p.height) return display;
    }
    let best = null;
    let bestArea = 0;
    for (const display of list) {
        const area = overlapArea(rect, display.physical);
        if (area > bestArea) { bestArea = area; best = display; }
    }
    if (best) return best;
    return list.find(d => d.primary) || list[0];
}

/**
 * A game-window rectangle in **physical** pixels → Electron window bounds in
 * **DIPs**.
 *
 * `node-screenshots` reports `x()/y()/width()/height()` in physical pixels of
 * the virtual desktop; `BrowserWindow.setBounds` takes DIPs. On a single 100 %
 * display those are the same numbers, which is exactly why this is easy to get
 * wrong and only ever seen by somebody with a second monitor or a scaled one.
 *
 * Each display is given with **both** rectangles — its DIP `bounds` (what
 * `screen.getAllDisplays()` returns) and its `physical` rectangle (what
 * `screen.dipToScreenRect(null, bounds)` returns) — so the arithmetic is a
 * per-display offset and scale rather than a guess about how Windows lays out
 * a mixed-DPI desktop. The impure caller does the two `screen` reads; the
 * decision is here, where a test can drive 100 % / 125 % / 150 % side by side.
 *
 * Rounded to integers: Electron bounds are integers, and rounding the origin
 * and the far edge separately (rather than the origin and the size) keeps the
 * window's right and bottom edges where the game's are — otherwise a 125 %
 * display can leave a one-pixel strip of game uncovered.
 *
 * @param {{x, y, width, height}} rect physical pixels
 * @param {Array<{bounds, physical, scaleFactor, primary?: boolean}>} displays
 * @returns {?{x: number, y: number, width: number, height: number, scaleFactor: number}}
 */
function gameRectToDip(rect, displays) {
    if (!isRect(rect)) return null;
    const display = displayForRect(rect, displays);
    if (!display) return null;
    const scale = isFiniteNumber(display.scaleFactor) && display.scaleFactor > 0 ? display.scaleFactor : 1;
    const toDipX = (px) => display.bounds.x + (px - display.physical.x) / scale;
    const toDipY = (py) => display.bounds.y + (py - display.physical.y) / scale;
    const left = Math.round(toDipX(rect.x));
    const top = Math.round(toDipY(rect.y));
    const right = Math.round(toDipX(rect.x + rect.width));
    const bottom = Math.round(toDipY(rect.y + rect.height));
    // Clamped to the display, as defence in depth. The window rectangle comes
    // from another library and is not this app's arithmetic, so a rectangle
    // that reaches far outside the desktop — a game mid-resize, a
    // `node-screenshots` reply from a window that was closing — must not become
    // an always-on-top window spanning the whole virtual desktop. The clamp can
    // only ever shrink what is drawn; it never moves a marker, because a
    // clamped bounds is a rectangle the markers were not going to be visible
    // in anyway.
    const b = display.bounds;
    const clampX = (v) => Math.min(Math.max(v, b.x), b.x + b.width);
    const clampY = (v) => Math.min(Math.max(v, b.y), b.y + b.height);
    const cl = clampX(left), cr = clampX(right);
    const ct = clampY(top), cb = clampY(bottom);
    return {
        x: cl,
        y: ct,
        width: Math.max(1, cr - cl),
        height: Math.max(1, cb - ct),
        scaleFactor: scale,
        // True when the clamp actually did something, so the caller can decline
        // to draw rather than draw somewhere it did not intend.
        clamped: cl !== left || ct !== top || cr !== right || cb !== bottom
    };
}

/**
 * Has the game window moved or changed size since the last check?
 *
 * Any change hides the markers until the next positive check: the panel square
 * is a fraction of the window, so a window that moved has markers in the wrong
 * place, and "wrong place" over live gameplay is the failure this feature must
 * not have. Compared exactly — there is no tolerance to tune, because a window
 * that has not moved reports the same four integers.
 *
 * @param {?Object} a
 * @param {?Object} b
 * @returns {boolean}
 */
function rectChanged(a, b) {
    if (!a || !b) return true;
    return a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height;
}

module.exports = {
    FAST_INTERVAL,
    DETECT_INTERVAL,
    HIDE_AFTER_NEGATIVE,
    KEY_POLL_INTERVAL,
    SAFETY_INTERVAL,
    CONFIRM_RETRY_DELAYS,
    confirmRetryDelay,
    PROVISIONAL_DEADLINE_MS,
    CONFIRMED_MEMORY_MS,
    MEMORY_KEEPING_HIDE_REASONS,
    shouldShowProvisionally,
    forgetConfirmedMap,
    confirmedMemoryFresh,
    TRIGGER_MODES,
    resolveTriggerMethod,
    triggerMode,
    checkInterval,
    detectIntervalFor,
    keyHintFor,
    initialTabModeState,
    reduceTabMode,
    displayForRect,
    gameRectToDip,
    rectChanged
};
