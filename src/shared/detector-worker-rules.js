'use strict';

/** PURE rules for the detector's utility process. Imports nothing — *when to
 * give up*, *when to try again* and *what a reply may contain* are decisions,
 * the half testable without Electron. See `docs/agents/detection.md`. */

/** Reply deadline for the **gate-only** check Tab-map mode makes while its
 * markers are over the game: a request is ~21-25 ms measured, so this is an
 * order of magnitude of headroom, and deliberately short — brackets over live
 * gameplay must not linger, so that check would rather hear "no frame". */
const REQUEST_TIMEOUT_MS = 500;

/** The same deadline for an **ordinary** tick, where nothing drawn over the
 * game waits on the answer. 500 ms killed healthy children while the game was
 * starting. Why: docs/agents/detection.md § 2. Capture, gate, grayscale and
 * match run in a utility process. */
const ORDINARY_TIMEOUT_MS = 2000;

/** The same deadline for the **first** request after a fork: a cold child boots
 * a runtime and loads the native capture module first (60 ms under plain node,
 * far more with an antivirus watching every DLL), and charging that to the
 * ordinary budget abandons the worker over a start-up cost that was never a
 * fault. Any message from the child ends the grace period. */
const START_TIMEOUT_MS = 3000;

/** How long a child must have answered before its earlier restarts stop
 * counting — a session-long tally turns unrelated hiccups hours apart into
 * "this worker keeps crashing". */
const HEALTHY_RESET_MS = 60000;

/** How many requests may wait behind the one in flight — three callers with a
 * `busy` guard each, so this only stops a pathological caller growing an
 * unbounded list. Past it a request is answered with "no frame this tick". */
const MAX_QUEUED = 4;

/** Backoff before restarting a dead worker, and the cap. A child that crashes
 * on its first capture will crash on the next, so a tight retry loop would be a
 * fork bomb against the player's CPU; after three tries the in-process path
 * takes over for the session. */
const RESTART_DELAYS = [250, 1000, 4000];
const MAX_RESTARTS = RESTART_DELAYS.length;

/** How long to wait before the next restart, in ms, or null when the worker has
 * failed often enough to be given up on. */
function restartDelay(restarts) {
    const n = Number.isFinite(restarts) && restarts > 0 ? Math.floor(restarts) : 0;
    return n < RESTART_DELAYS.length ? RESTART_DELAYS[n] : null;
}

/**
 * Which implementation is in use, and why — "it works differently on my PC" has
 * to be answerable from `system.txt`, and a state that was never tried must not
 * be reported as a failure.
 * @param {{started: boolean, failed: ?string, supported: boolean,
 *          restarting?: boolean, stopped?: boolean}} state
 */
function resolveDetectorMode(state) {
    const s = state || {};
    if (s.failed) return {mode: 'in-process', reason: s.failed};
    if (s.supported === false) return {mode: 'in-process', reason: 'unsupported'};
    if (s.started) return {mode: 'worker', reason: 'worker'};
    // Between a crash and its restart the frames really do come from this
    // process; "not-started" would send a reader looking for a fault.
    if (s.restarting) return {mode: 'in-process', reason: 'restarting'};
    if (s.stopped) return {mode: 'in-process', reason: 'stopped'};
    return {mode: 'in-process', reason: 'not-started'};
}

/** May a worker's restart tally be forgiven?
 * @param {number} upMs how long the current child has been answering */
function shouldResetRestarts(upMs, restarts) {
    if (!Number.isFinite(upMs) || upMs < HEALTHY_RESET_MS) return false;
    return !Number.isFinite(restarts) || restarts > 0;
}

/** Is this reply the answer to the request main is waiting for? Request ids are
 * monotonic, and a reply with any other id is **stale** — one that timed out and
 * then arrived, or one from before a restart. An answer must never outlive its
 * question. */
function isCurrentReply(replyId, pendingId) {
    return typeof replyId === 'number' && typeof pendingId === 'number' && replyId === pendingId;
}

/**
 * Does this message carry pixels? The rule the worker exists to enforce — a
 * capture never leaves the process that took it — as a predicate the test
 * asserts over every reply the fixtures produce.
 *
 * A regression guard on a reply's *shape*, not a proof: it stops at
 * `MAX_DEPTH`, and a frame copied into a plain `Array` is pixels no type check
 * can see. What it can say is "small, and holds no buffer", which every
 * legitimate reply is — hence the length cap.
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
