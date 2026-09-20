'use strict';

/**
 * PURE rules for the detector's utility process. Imports nothing.
 *
 * The transport is Electron's and the capture is native, but *when to give up*,
 * *when to try again* and *what a reply is allowed to contain* are decisions —
 * and decisions are the half that can be tested without either.
 */

/**
 * How long main waits for one reply before treating the worker as wedged.
 *
 * A capture is ~17 ms of native work and the whole request is ~21-25 ms
 * measured, so this is an order of magnitude of headroom. It exists for the
 * case where the child is alive but not answering — a native call blocked on a
 * driver, a machine paging hard — because the alternative is a scheduler that
 * never fires again. Deliberately shorter than the 700 ms idle cadence, so a
 * timed-out request cannot overlap the next one.
 */
const REQUEST_TIMEOUT_MS = 500;

/**
 * The same clock for an **ordinary** tick — one with nothing drawn over the
 * game that is waiting on it. The 500 ms above now only guards the gate-only
 * check Tab-map mode makes while its markers are up.
 *
 * Field log, 0.7.0 test build: both timeouts of the session fell in the five
 * seconds in which the game was *starting* (window enumeration and capture
 * stall while the GPU driver is busy), each one killed a healthy child, and a
 * third would have abandoned the worker for the session. A slow answer there
 * costs nothing — the scheduler chains on the reply — so it gets room.
 */
const ORDINARY_TIMEOUT_MS = 2000;

/**
 * The same clock, but for the **first** request after a fork.
 *
 * A cold child has to boot a runtime and load the native capture module before
 * it can answer anything: 60 ms under plain node, and a real `utilityProcess`
 * on a machine that is loading a match with an antivirus watching every DLL can
 * take far longer. Charging that start-up to the first request's 500 ms budget
 * kills a perfectly good worker, counts a restart, and does it again on the
 * next tick — three times, and then the worker is abandoned for a start-up cost
 * that was never a fault. The handshake below (any message from the child,
 * including its `templates` acknowledgement) ends this grace period, so it
 * applies once per child rather than once per request.
 */
const START_TIMEOUT_MS = 3000;

/**
 * How long a child must have been answering before its earlier restarts stop
 * counting towards giving up.
 *
 * `restarts` used to be a session-long tally: four unlucky moments hours apart
 * — a display-mode change, a machine paging during a map load — added up to
 * "this worker keeps crashing" and the in-process path for the rest of the
 * session, labelled with a crash that never happened. A worker that has run
 * healthily for this long has demonstrably recovered.
 */
const HEALTHY_RESET_MS = 60000;

/**
 * How many requests may wait behind the one in flight.
 *
 * The callers are the detector tick, Tab mode's confirming grab and Tab mode's
 * safety check, each with a `busy` guard of its own, so three is already the
 * ceiling in practice; the limit exists so that a pathological caller queues
 * work rather than growing an unbounded list. Past it a request is answered
 * with "no frame this tick", which every caller already has to handle.
 */
const MAX_QUEUED = 4;

/**
 * Backoff before restarting a worker that died, in ms, and then the cap.
 *
 * A child that crashes on the first capture will crash on the next one too, so
 * retrying in a tight loop would be a fork bomb against the player's CPU. Three
 * tries with growing gaps, and then the in-process path takes over for the rest
 * of the session — which always works, because it is the implementation the app
 * shipped with.
 */
const RESTART_DELAYS = [250, 1000, 4000];
const MAX_RESTARTS = RESTART_DELAYS.length;

/**
 * How long to wait before restart number `n` (1-based), or null when the
 * worker has failed often enough that it should be given up on.
 *
 * @param {number} restarts how many restarts have already been attempted
 * @returns {?number}
 */
function restartDelay(restarts) {
    const n = Number.isFinite(restarts) && restarts > 0 ? Math.floor(restarts) : 0;
    return n < RESTART_DELAYS.length ? RESTART_DELAYS[n] : null;
}

/**
 * Which implementation is in use, and why.
 *
 * Exactly the same shape as Tab mode's `resolveTriggerMethod`, and for the same
 * reason: "it works differently on my PC" has to be answerable from
 * `system.txt`, and a state that was never tried must not be reported as a
 * failure.
 *
 * @param {{started: boolean, failed: ?string, supported: boolean,
 *          restarting?: boolean, stopped?: boolean}} state
 * @returns {{mode: 'worker'|'in-process', reason: string}}
 */
function resolveDetectorMode(state) {
    const s = state || {};
    if (s.failed) return {mode: 'in-process', reason: s.failed};
    if (s.supported === false) return {mode: 'in-process', reason: 'unsupported'};
    if (s.started) return {mode: 'worker', reason: 'worker'};
    // Between a crash and its restart the frames really do come from this
    // process, and saying "not-started" for a worker that is coming back in a
    // second would send a reader looking for a fault that is not there.
    if (s.restarting) return {mode: 'in-process', reason: 'restarting'};
    if (s.stopped) return {mode: 'in-process', reason: 'stopped'};
    return {mode: 'in-process', reason: 'not-started'};
}

/**
 * May a worker's restart tally be forgiven?
 *
 * @param {number} upMs how long the current child has been answering
 * @param {number} [restarts] the tally; nothing to forgive at zero
 * @returns {boolean}
 */
function shouldResetRestarts(upMs, restarts) {
    if (!Number.isFinite(upMs) || upMs < HEALTHY_RESET_MS) return false;
    return !Number.isFinite(restarts) || restarts > 0;
}

/**
 * Is this reply the answer to the request main is waiting for?
 *
 * Request ids are monotonic, and a reply whose id is not the current one is a
 * **stale** answer: a request that timed out and then arrived, or one from
 * before a worker restart. Acting on it would be the same class of bug as
 * Tab-map mode showing markers from a capture that started before the key came
 * up — an answer outliving its question.
 *
 * @param {number} replyId
 * @param {number} pendingId
 * @returns {boolean}
 */
function isCurrentReply(replyId, pendingId) {
    return typeof replyId === 'number' && typeof pendingId === 'number' && replyId === pendingId;
}

/**
 * Does this message carry pixels?
 *
 * The rule the worker exists to enforce: a capture never leaves the process
 * that took it. Templates travel *in* as plain arrays of numbers — they are the
 * app's own data, generated at build time — and everything that comes *out* is
 * numbers, strings and booleans. This is the predicate the test asserts over
 * every reply the fixtures produce, rather than a comment hoping it stays true.
 *
 * **What it is and is not.** It is a regression guard on the shape of a reply,
 * not a proof: it stops looking past `MAX_DEPTH`, and a frame copied into a
 * plain `Array` of numbers is pixels that no type check can recognise. What it
 * *can* say is "this reply is small and holds no buffer", which is the property
 * every legitimate reply has — hence the length cap: a reply carries a window
 * rectangle, a few scores and a few timings, never more than a few dozen
 * numbers, so an array past the cap is treated as pixels whatever it holds.
 *
 * @param {*} value
 * @param {number} [depth]
 * @returns {boolean}
 */
const MAX_DEPTH = 8;
const MAX_REPLY_ARRAY = 64;

function carriesPixels(value, depth) {
    const level = depth || 0;
    if (level > MAX_DEPTH) return false;
    if (value === null || value === undefined) return false;
    if (typeof value !== 'object') return false;
    if (ArrayBuffer.isView(value)) return true;
    if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return true;
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return true;
    if (Array.isArray(value)) {
        if (value.length > MAX_REPLY_ARRAY) return true;
        return value.some(v => carriesPixels(v, level + 1));
    }
    for (const key of Object.keys(value)) {
        if (carriesPixels(value[key], level + 1)) return true;
    }
    return false;
}

module.exports = {
    REQUEST_TIMEOUT_MS,
    ORDINARY_TIMEOUT_MS,
    START_TIMEOUT_MS,
    HEALTHY_RESET_MS,
    MAX_QUEUED,
    MAX_REPLY_ARRAY,
    RESTART_DELAYS,
    MAX_RESTARTS,
    restartDelay,
    resolveDetectorMode,
    shouldResetRestarts,
    isCurrentReply,
    carriesPixels
};
