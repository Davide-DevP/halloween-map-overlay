'use strict';

const os = require('os');
const path = require('path');

const appLog = require('../app-log');
const FrameSource = require('./frame-source');
const {redactHome} = require('../../shared/redact');
const {
    REQUEST_TIMEOUT_MS, ORDINARY_TIMEOUT_MS, START_TIMEOUT_MS, MAX_QUEUED,
    restartDelay, resolveDetectorMode, shouldResetRestarts, isCurrentReply
} = require('../../shared/detector-worker-rules');

/**
 * Consecutive **fatal** replies before the worker is abandoned.
 *
 * "Fatal" means the worker's own handler threw — the case that cannot be
 * diagnosed from here and that the in-process path would survive:
 * `node-screenshots` failing to load inside the child. A capture that fails
 * (`capture:`, `empty-capture`, `toRaw:`) is *not* fatal and is never counted:
 * those are the ordinary two seconds of an alt-tab or a display-mode change,
 * they are reported by the frame source rather than thrown, and running them
 * here instead would have failed in exactly the same way.
 */
const ERRORS_BEFORE_FALLBACK = 3;

/**
 * Main's side of the detector's utility process.
 *
 * One interface, two implementations: `grab(want)` answers with decisions, and
 * the caller does not know or care whether the pixels were touched in a child
 * process or here. That is what makes the fallback free — swapping the object
 * is the whole of it — and it is why `map-detector.js` and `tab-mode.js` both
 * go through this rather than each owning a capture.
 *
 * What main keeps: the scheduler, every cadence, the state machine, the menu
 * streak, Tab mode's reducer and epochs, all logging and all windows. What the
 * worker gets: the capture and the arithmetic. **Only numbers cross.**
 *
 * ### One request at a time
 *
 * The callers are independent — the detector tick, Tab mode's confirming grab,
 * Tab mode's safety check — and each only guards itself. They *will* overlap
 * (at 450 ms and 150 ms, within seconds). So requests queue here: one in
 * flight, the rest in order, each with its own timer and each resolving its own
 * promise. A single `pending` slot lost the first caller's promise for good the
 * moment a second request arrived, and a promise that never settles takes the
 * caller's `busy` flag with it — the detector went silent until the app was
 * restarted, with nothing in the log.
 *
 * Replies are **not** coalesced onto one capture: an answer from a frame taken
 * before the question was asked is the mirror of the staleness bug Tab mode's
 * epochs exist to prevent, and 25 ms of queueing is cheaper than reasoning
 * about it.
 *
 * ### Never a capture in main by accident
 *
 * The in-process path is a *declared mode*, visible in `system.txt`, not
 * something a timeout quietly falls into. A request that cannot be answered by
 * the worker resolves as **"no frame this tick"** (`aborted`), which every
 * caller handles as "no answer" already. Main captures only when the mode says
 * it does: the worker failed, is unsupported, or is waiting out a restart.
 *
 * ### Lifecycle
 *
 *   - **started lazily**, when detection (or Tab-map mode) actually needs a
 *     frame — a user who never turns auto-detect on never pays for a second
 *     process;
 *   - **stopped** when nothing needs it any more, and a deliberate stop is not
 *     a crash: it arms no restart and counts towards no give-up;
 *   - restarted with backoff after a crash, three times, and then the
 *     in-process path takes over for the rest of the session — unless the
 *     child has since been healthy for a minute, in which case the tally is
 *     forgiven;
 *   - a per-request timeout, so a child that is alive but not answering cannot
 *     wedge the scheduler, with a longer grace period for the first request
 *     after a fork (that one is paying for the child's start-up);
 *   - stale replies dropped by request id, and events from a child that is no
 *     longer ours ignored entirely.
 */
class DetectorWorkerHost {

    /**
     * @param {{fork?: Function, workerPath?: string, timeoutMs?: number,
     *          startTimeoutMs?: number, log?: Function, gc?: Object}} [deps]
     *   `fork` returns a port-like `{postMessage, on, once, kill}`; injected so
     *   `test/detector-worker.test.js` can run the **real** worker module
     *   through a fake port pair, which is the only way to exercise this
     *   without Electron.
     */
    constructor(deps) {
        const d = deps || {};
        this.forkFn = d.fork || null;
        this.workerPath = d.workerPath || path.join(__dirname, 'worker.js');
        this.timeoutMs = d.timeoutMs || REQUEST_TIMEOUT_MS;
        // An injected timeout (the tests) applies to both kinds of request.
        this.ordinaryTimeoutMs = d.timeoutMs || ORDINARY_TIMEOUT_MS;
        this.startTimeoutMs = d.startTimeoutMs
            || Math.max(START_TIMEOUT_MS, this.timeoutMs);
        this.logLine = typeof d.log === 'function' ? d.log : null;
        this.gc = d.gc || null;

        this.child = null;
        this.started = false;
        /** Has the current child said anything at all yet? */
        this.ready = false;
        /** When the current child was forked, for the restart-tally decay. */
        this.childStartedAt = 0;
        /** Whether the child's own collector works, as the child reported it. */
        this.workerGc = null;
        /** Why the worker is not in use, or null. */
        this.failed = null;
        this.restarts = 0;
        this.timeouts = 0;
        this.errorRun = 0;
        this.restartTimer = null;
        this.nextId = 1;
        /** The request the child is answering right now, or null. */
        this.inflight = null;
        /** Requests waiting their turn, in order. */
        this.queue = [];
        /** Why the child is being killed, so a give-up can be labelled truthfully. */
        this.lastKill = null;
        /** The templates, kept so a restarted worker can be re-seeded. */
        this.templatePayload = null;
        /** The in-process implementation, built only if it is ever needed. */
        this.local = null;
        /**
         * Does anything want frames? `null` = never said (a direct caller, as
         * in the tests), `true` between `start()` and `stop()`, `false` after a
         * stop. A `false` here is what stops a capture being started in main
         * *after* the user switched detection off.
         */
        this.wanted = null;
        /** True while a deliberate stop is being carried out: not a crash. */
        this.stopping = false;
        /** True while the worker is being given up on: no restart, no logging it. */
        this.failing = false;
        this.stopped = false;
    }

    /** @returns {{mode: 'worker'|'in-process', reason: string}} */
    modeInfo() {
        return resolveDetectorMode({
            started: this.started && !!this.child,
            failed: this.failed,
            supported: this.supported(),
            restarting: !!this.restartTimer,
            stopped: this.wanted === false || this.stopped
        });
    }

    /** Is a utility process available at all in this build? */
    supported() {
        if (this.forkFn) return true;
        try {
            const {utilityProcess} = require('electron');
            return !!(utilityProcess && typeof utilityProcess.fork === 'function');
        } catch (err) {
            return false;
        }
    }

    /** The in-process fallback, built on first use. */
    localSource() {
        if (!this.local) {
            // The same collector the worker uses: the fallback captures the
            // same 8 MB frames and `node-screenshots` still has no dispose API,
            // so a fallback that does not collect is the 78 → 191 MB
            // oscillation `core/gc.js` exists to remove.
            this.local = new FrameSource({gc: this.gc});
            if (this.templatePayload) this.local.setTemplates(this.templatePayload);
        }
        return this.local;
    }

    /**
     * The on-demand collector, handed over once `map-detector.js` has resolved
     * it (lazily, from `start()` — requiring `core/gc.js` has consequences).
     */
    setGc(gc) {
        this.gc = gc || null;
        if (this.local) this.local.gc = this.gc;
    }

    /**
     * Install (or replace) the template set. Kept so a restarted worker is
     * re-seeded without waiting for a pack install.
     * @param {{templates: Object, menu: ?Object, size: number}} payload
     */
    setTemplates(payload) {
        this.templatePayload = payload;
        if (this.local) this.local.setTemplates(payload);
        if (this.child) this.post({id: this.nextId++, type: 'templates', ...payload});
    }

    /** Start the child, if one is wanted and possible. Never throws. */
    start() {
        this.wanted = true;
        this.stopping = false;
        if (this.stopped || this.child || this.failed) return this.modeInfo();
        if (!this.supported()) {
            this.fail('unsupported');
            return this.modeInfo();
        }
        try {
            this.child = this.forkFn
                ? this.forkFn(this.workerPath)
                : require('electron').utilityProcess.fork(this.workerPath, [], {
                    // The child needs no stdio of its own: everything it would
                    // ever say goes through main's loggers, by design.
                    stdio: 'ignore',
                    serviceName: 'hmo-detector'
                });
        } catch (err) {
            this.fail('fork: ' + ((err && err.message) || err));
            return this.modeInfo();
        }
        this.started = true;
        this.ready = false;
        this.childStartedAt = Date.now();
        this.lastKill = null;
        this.attach(this.child);
        if (this.templatePayload) {
            this.post({id: this.nextId++, type: 'templates', ...this.templatePayload});
        }
        // The handshake: it answers `ready` (which ends the first request's
        // longer grace period) and reports whether the child's own collector
        // works, which is otherwise invisible from here.
        this.post({id: this.nextId++, type: 'ping'});
        appLog.event('detector-worker', {action: 'start'});
        this.log('worker-start', {restarts: this.restarts});
        // Anything that queued up while there was no child goes now.
        this.pump();
        return this.modeInfo();
    }

    /**
     * Wire one child's events — and ignore them once it is not ours any more.
     *
     * A process wedged in a native call dies *slowly*: its real `exit` arrives
     * long after the kill, by which time the restart has already happened. Left
     * unbound, that late event nulled the **new** child without killing it —
     * one more fork, one more restart counted, and a live process nobody owned.
     */
    attach(child) {
        const onMessage = (event) => {
            if (this.child !== child) return;
            // `utilityProcess` delivers `{data}`; a plain fork delivers the
            // object itself. One line, so nothing above has to know.
            const message = event && event.data !== undefined ? event.data : event;
            this.onReply(message);
        };
        if (typeof child.on === 'function') {
            child.on('message', onMessage);
            child.on('exit', (code) => this.onExit(child, code));
            child.on('error', (err) => this.onExit(child, -1, err));
        }
    }

    post(message) {
        const child = this.child;
        if (!child) return false;
        try {
            child.postMessage(message);
            return true;
        } catch (err) {
            // Unreachable but quite possibly still running: kill it, or it
            // becomes an orphan holding the native capture module open.
            this.killChild('post-failed');
            return false;
        }
    }

    onReply(message) {
        if (!message || typeof message !== 'object') return;
        // Any message at all proves the child booted, which is the whole of the
        // handshake: from here on a request that does not answer inside the
        // ordinary timeout really is a wedged child rather than a slow start.
        this.ready = true;
        if (message.type === 'ping' || message.type === 'templates') {
            if (typeof message.gc === 'string') this.workerGc = message.gc;
            return;
        }
        const waiting = this.inflight;
        if (!waiting) return;
        // Stale replies — a request that timed out and then arrived, or one
        // from before a restart — are dropped. An answer must not outlive its
        // question; the same rule Tab mode's epoch enforces.
        if (!isCurrentReply(message.id, waiting.id)) return;
        this.settle(waiting, message);
    }

    /**
     * One request, queued. Always resolves: with the worker's reply, or with
     * "no frame this tick".
     * @returns {Promise<Object>}
     */
    enqueue(want, limitMs) {
        return new Promise((resolve) => {
            if (this.queue.length >= MAX_QUEUED) {
                resolve(abortedReply('busy'));
                return;
            }
            this.queue.push({want, resolve, id: 0, timer: null, done: false, limitMs: limitMs || 0});
            this.pump();
        });
    }

    /** Send the next queued request, if the child is free. */
    pump() {
        if (this.inflight || !this.queue.length) return;
        if (!this.child) {
            // No worker to ask and no capture in main: whoever is waiting is
            // told there is no frame this tick.
            const orphans = this.queue.splice(0);
            for (const waiter of orphans) this.settle(waiter, abortedReply('no-worker'));
            return;
        }
        const waiter = this.queue.shift();
        waiter.id = this.nextId++;
        this.inflight = waiter;
        // A request may set its own deadline, and one does: the gate-only check
        // Tab-map mode makes **while its markers are on screen**. That one may
        // never wait out a cold start — brackets over live gameplay are the one
        // thing that must not linger, so it would rather be told "no frame" and
        // take them down. Everything else gets the start-up grace.
        const limit = waiter.limitMs || (this.ready ? this.ordinaryTimeoutMs : this.startTimeoutMs);
        waiter.limit = limit;
        waiter.timer = setTimeout(() => this.onTimeout(waiter), limit);
        if (waiter.timer.unref) waiter.timer.unref();
        if (!this.post({id: waiter.id, type: 'grab', want: waiter.want || {}})) {
            this.settle(waiter, abortedReply('post-failed'));
        }
    }

    /** Resolve one waiter, exactly once, and start the next. */
    settle(waiter, reply) {
        if (!waiter || waiter.done) return;
        waiter.done = true;
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.timer = null;
        if (this.inflight === waiter) this.inflight = null;
        waiter.resolve(reply);
        this.pump();
    }

    onTimeout(waiter) {
        if (waiter.done) return;
        this.timeouts++;
        this.log('worker-timeout', {
            ms: waiter.limit || this.timeoutMs,
            queued: this.queue.length
        });
        appLog.warn('detector-worker', {action: 'timeout', ms: waiter.limit || this.timeoutMs});
        // A child that does not answer is a child that is wedged. Killing it
        // takes the normal restart path — and answers everything waiting,
        // including this request, as "no frame". Marked first so that *this*
        // request is told it timed out rather than that the worker went away:
        // the two need different things looked at.
        waiter.timedOut = true;
        this.killChild('timeout');
        this.settle(waiter, abortedReply('timeout'));
    }

    onExit(child, code, err) {
        // A late exit from a child that has already been replaced is not news.
        if (child && this.child !== child) return;
        const wasChild = this.child;
        this.child = null;
        this.started = false;
        this.ready = false;
        const reason = this.stopping || this.stopped ? 'stopped' : 'worker-exit';
        const waiting = this.queue.splice(0);
        if (this.inflight) waiting.unshift(this.inflight);
        this.inflight = null;
        // Every waiter is answered — with "no frame", never by quietly
        // capturing in main behind the user's back.
        for (const waiter of waiting) {
            this.settle(waiter, abortedReply(waiter.timedOut ? 'timeout' : reason));
        }
        // Nothing comes back from a deliberate stop, a shutdown, or a worker
        // that has just been given up on: arming a restart there would log a
        // recovery that is not going to happen.
        if (!wasChild || this.stopped || this.stopping || this.failing || this.failed) return;
        appLog.warn('detector-worker', {
            action: 'exit', code, message: (err && err.message) || ''
        });
        const delay = restartDelay(this.restarts);
        if (delay === null) {
            // Say which of the two it was: a child that keeps dying and one
            // that keeps not answering need different things looked at.
            this.fail(this.lastKill === 'timeout' ? 'timeouts' : 'crashed');
            return;
        }
        this.restarts++;
        this.log('worker-restart', {attempt: this.restarts, inMs: delay});
        this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            if (!this.stopped && !this.failed && this.wanted !== false) this.start();
        }, delay);
        if (this.restartTimer.unref) this.restartTimer.unref();
    }

    /** Give up on the child for the rest of the session. */
    fail(reason) {
        if (this.failed) return;
        // `detector.log` is not run through the app log's redaction, and a
        // module-resolution failure quotes a path that starts at the user's
        // home directory.
        this.failed = redactHome(String(reason), os.homedir());
        this.started = false;
        appLog.warn('detector-worker', {action: 'fallback', reason: this.failed});
        this.log('worker-fallback', {reason: this.failed});
        console.error('Map detection: running the capture in-process:', this.failed);
    }

    /**
     * One request. Always resolves — with the worker's answer, with the
     * in-process one when the mode says main is doing the capturing, or with
     * "no frame this tick".
     *
     * @param {{menu?: boolean, match?: boolean}} want
     * @returns {Promise<Object>}
     */
    async grab(want) {
        // Switched off, or shutting down: nothing is captured anywhere. This is
        // the difference between "the worker could not answer" and "nobody
        // should be capturing at all", and it is why quitting no longer pulls
        // the native capture module into the main process.
        if (this.stopped || this.stopping || this.wanted === false) {
            return abortedReply('stopped');
        }
        // Lazily start — but never during a restart backoff: pre-empting the
        // wait is how a crashing child got re-forked 78 ms after it died.
        if (!this.child && !this.failed && !this.restartTimer) this.start();
        if (this.child || this.queue.length || this.inflight) {
            // `match: false` is the "is the Tab screen still up?" check, asked
            // only while markers are drawn over the game. It keeps the ordinary
            // per-request timeout even on a child that has not said hello yet.
            const gateOnly = !!(want && want.match === false);
            const reply = await this.enqueue(want, gateOnly ? this.timeoutMs : 0);
            if (!reply || reply.aborted) return reply || abortedReply('no-worker');
            if (reply.error) return this.noteError(reply, want);
            this.errorRun = 0;
            this.noteHealthy();
            return reply;
        }
        // The declared in-process modes: failed, unsupported, or waiting out a
        // restart. `modeInfo()` says so and `system.txt` prints it.
        return this.localSource().grab(want);
    }

    /**
     * A reply that carries an error. Ordinary capture failures pass straight
     * through — the in-process path would have failed identically. Only a run
     * of **fatal** ones (the worker's handler threw) gives the worker up.
     */
    noteError(reply, want) {
        if (!reply.fatal) return reply;
        this.errorRun += 1;
        if (this.errorRun < ERRORS_BEFORE_FALLBACK) return reply;
        // Killed **before** it is written off, and with the restart machinery
        // disarmed: a worker that is being abandoned must still be stopped, or
        // it goes on running with the native capture module loaded.
        this.failing = true;
        this.killChild('failed');
        this.fail('errors: ' + String(reply.error).slice(0, 80));
        return this.localSource().grab(want);
    }

    /** A worker that has been answering for a minute has earned a clean slate. */
    noteHealthy() {
        if (!this.restarts) return;
        if (!shouldResetRestarts(Date.now() - this.childStartedAt, this.restarts)) return;
        this.log('worker-healthy', {forgave: this.restarts});
        this.restarts = 0;
    }

    killChild(reason) {
        const child = this.child;
        if (!child) return;
        this.lastKill = reason || 'kill';
        try {
            if (typeof child.kill === 'function') child.kill();
        } catch (err) {
            /* it is going away either way */
        }
        this.onExit(child, -2);
    }

    /** Stop the child. Called when nothing needs frames any more, and on quit. */
    stop() {
        this.wanted = false;
        this.stopping = true;
        if (this.restartTimer) clearTimeout(this.restartTimer);
        this.restartTimer = null;
        if (this.child) {
            this.post({id: this.nextId++, type: 'stop'});
            this.killChild('stop');
            appLog.event('detector-worker', {action: 'stop'});
        } else {
            const waiting = this.queue.splice(0);
            if (this.inflight) waiting.unshift(this.inflight);
            this.inflight = null;
            for (const waiter of waiting) this.settle(waiter, abortedReply('stopped'));
        }
        this.child = null;
        this.started = false;
        this.ready = false;
        this.stopping = false;
    }

    /** Quit or update: never come back. */
    destroy() {
        this.stop();
        this.stopped = true;
        this.local = null;
    }

    log(event, fields) {
        if (this.logLine) this.logLine(event, fields || {});
    }

    /** What `system.txt` prints. */
    status() {
        const info = this.modeInfo();
        return {
            mode: info.mode,
            reason: info.reason,
            restarts: this.restarts,
            timeouts: this.timeouts,
            timeoutMs: this.timeoutMs,
            // What the child said about its own collector: `available`, `noop`,
            // or null when no child has answered yet.
            gc: this.workerGc,
            supported: this.supported()
        };
    }
}

/**
 * "No frame this tick."
 *
 * Not an error and not a window verdict: the question could not be put to the
 * worker. Callers must check `aborted` **before** reading `window`, or a stop
 * looks exactly like the game having been closed.
 */
function abortedReply(reason) {
    return {
        type: 'grab',
        aborted: true,
        reason: reason || 'aborted',
        window: null,
        gate: false,
        match: null,
        menu: null,
        timings: null
    };
}

module.exports = DetectorWorkerHost;
module.exports.abortedReply = abortedReply;
