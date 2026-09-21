'use strict';

const electron = require('electron');

const appLog = require('./app-log');
const TabOverlayWindow = require('./tab-overlay-window');
const KeyTrigger = require('./key-trigger');
const {
    DEFAULT_SIZE
} = require('./map-detector/matcher');
const {tabLayers, markerState, MARKER_LAYERS} = require('../shared/marker-rules');
const {msg} = require('../shared/i18n');
const {resolveMapVk} = require('../shared/key-codes');
const {
    FAST_INTERVAL, DETECT_INTERVAL, HIDE_AFTER_NEGATIVE, KEY_POLL_INTERVAL, SAFETY_INTERVAL,
    PROVISIONAL_DEADLINE_MS, CONFIRMED_MEMORY_MS,
    initialTabModeState, reduceTabMode, gameRectToDip, rectChanged, confirmRetryDelay,
    resolveTriggerMethod, triggerMode, checkInterval, detectIntervalFor,
    shouldShowProvisionally, forgetConfirmedMap, confirmedMemoryFresh
} = require('../shared/tab-mode-rules');

/** Settings that change what is on screen *right now*, so they re-place it. */
const LIVE_MARKER_SETTINGS = ['markers', 'markerOpacity', 'markerLegend', 'tabMarkerKey']
    .concat(MARKER_LAYERS.map(layer => layer.settingKey));

/**
 * Losses meaning **the match is over** — the only ones that forget the
 * optimistic memory from outside the reducer. A fault *inside* a match hides
 * and lets the reducer decide.
 */
const MATCH_OVER_REASONS = ['menu', 'no-window', 'window-gone', 'minimized', 'inactive', 'markers-off'];

/**
 * A key's on-screen name comes from the browser, so it is text this app did not
 * write: bounded and stripped before it is shown. @returns {?string}
 */
function sanitiseKeyLabel(value) {
    if (typeof value !== 'string') return null;
    const cleaned = value.replace(/[^\x20-\x7E -ɏ]/g, '').trim().slice(0, 16);
    return cleaned || null;
}

const debug = process.env.DEBUG === 'true';

/** How often a repeating condition may reach the log; edges are not throttled. */
const STATE_LOG_INTERVAL = 30000;

/**
 * ELECTRON tier: **Tab-map mode** (off by default). It owns the periodic check
 * and the window; `shared/tab-mode-rules.js` owns every decision. Three rules
 * no change here may break: it **requires auto-detect**; **nothing is shown
 * for a map the screen has not been read on**; **when in doubt, hide**.
 * Why, the measurements and the reproduced races:
 * docs/agents/markers-and-tab-mode.md.
 */
class TabMode {

    /**
     * @param {{ipcMain?, screen?, overlay?, trigger?, now?}} [deps] injected so
     *   the tests can drive the show/hide races the real Electron, screen and
     *   keyboard cannot. The app never passes it.
     */
    constructor(settings, mapMarkers, language, deps) {
        const d = deps || {};
        this.settings = settings;
        this.mapMarkers = mapMarkers;
        this.language = language || null;
        this.ipcMain = d.ipcMain || electron.ipcMain;
        this.screen = d.screen || electron.screen;
        /** Injectable clock, so a test can make "before the last hide" exact. */
        this.now = typeof d.now === 'function' ? d.now : () => Date.now();
        /**
         * The optimistic show's deadline (ms): a **real** `setTimeout`, whose
         * job is independence from whether anything answers. Injectable.
         */
        this.provisionalMs = typeof d.provisionalMs === 'number' && d.provisionalMs > 0
            ? d.provisionalMs : PROVISIONAL_DEADLINE_MS;
        this.detector = null;
        this.overlay = d.overlay || new TabOverlayWindow();

        this.enabled = false;
        this.timer = null;
        this.busy = false;
        this.state = initialTabModeState();
        /** The game window rect (physical px) the markers were placed against. */
        this.rect = null;
        this.lastStateLogAt = 0;
        this.lastTiming = null;
        this.counters = {checks: 0, shows: 0, hides: 0, stale: 0, retries: 0, provisional: 0, unconfirmed: 0};
        this.sizeMismatchLogged = false;
        /** Does the detector see a game window? Edge-reported by it. */
        this.gameWindowPresent = false;
        this.fallbackNoticed = false;
        this.notifier = null;
        /** Set by `destroy()`: nothing may rebuild the window after a quit. */
        this.destroyed = false;

        /**
         * **Staleness: what keeps markers off live gameplay.** Every screen
         * read remembers `epoch` at its **start** and re-checks after every
         * `await`; `lastHideAt` is the same rule for detector results, which
         * know their tick's start but not our epoch. See that doc § The reproduced races.
         */
        this.epoch = 0;
        this.lastHideAt = 0;
        this.confirmAttempts = 0;
        /** A confirmation asked for while another capture was in flight. */
        this.confirmQueued = false;
        this.confirmTimer = null;

        /** The hard stop under a key-edge show: it fires whatever else does not. */
        this.provisionalTimer = null;
        /** When the key went down — what `tab-confirmed ms=` measures against. */
        this.provisionalAt = 0;
        /** The detector's map at the last look, compared not trusted: change = forget. */
        this.knownKey = null;
        /** When the last confirmation landed, so the memory can go stale. */
        this.confirmedAt = 0;

        const self = this;
        /** Constructed now but **not loaded**: koffi waits for `start()`. */
        this.trigger = d.trigger || new KeyTrigger({
            onHint: (hint, reason) => self.onKeyHint(hint, reason),
            mapVk: this.mapVk(),
            log: (event, fields) => self.log(event, fields)
        });
        if (d.trigger) {
            // An injected trigger still has to reach us.
            this.trigger.onHint = (hint, reason) => self.onKeyHint(hint, reason);
        }
        // The window hides itself on a dead renderer; this tells the class.
        this.overlay.onRendererGone = (reason) => {
            self.invalidate();
            self.dispatch({type: 'lost', reason: 'renderer-gone'});
            self.log('tab-hide', {reason: 'renderer-gone', detail: reason || ''});
        };
        // Fall back mid-session rather than stop reacting to the key.
        this.trigger.onUnavailable = (why) => self.fallBackToPolling(why);

        // The master switch, the layers and the opacity go through the generic
        // `set-setting` (the Show/hide-markers hotkey included), so this hook is
        // the only thing that tells this class.
        if (settings && typeof settings.onChange === 'function') {
            settings.onChange((keys) => self.onSettingsChanged(keys));
        }

        // Its own handler: main has to *act* on it, not just store it.
        this.ipcMain.handle('set-tab-markers', async (event, value) => {
            const on = value === true;
            if (self.settings) self.settings.set('tabMarkers', on);
            self.syncWithSettings();
            return self.status();
        });
        this.ipcMain.handle('get-tab-marker-state', async () => self.status());
        // The renderer's *virtual-key code* is validated here: with
        // `nodeIntegration: true` it is no trust boundary, and
        // `GetAsyncKeyState` would answer for a mouse button.
        this.ipcMain.handle('set-tab-marker-key', async (event, vk, label) => {
            const resolved = resolveMapVk(vk);
            if (self.settings) {
                self.settings.set('tabMarkerKey', resolved);
                self.settings.set('tabMarkerKeyLabel', sanitiseKeyLabel(label));
            }
            self.trigger.setMapVk(resolved);
            // Markers up at a key change would await an unwatched up-edge.
            self.invalidate();
            self.dispatch({type: 'lost', reason: 'key-changed'});
            appLog.event('tab-markers', {action: 'map-key', vk: resolved});
            return self.status();
        });
        // "Polling only" — the user's escape hatch; main switches methods here.
        this.ipcMain.handle('set-marker-trigger', async (event, mode) => {
            const resolved = triggerMode(mode);
            if (self.settings) self.settings.set('markerTrigger', resolved);
            self.applyMethod();
            return self.status();
        });
    }

    setCornerOverlay(overlayWindow) {
        this.cornerOverlay = overlayWindow || null;
        this.syncCornerOverlay();
    }

    /**
     * Tied to `enabled`, never the setting alone: if this mode cannot run the
     * corner minimap is the player's only map and must come back.
     */
    syncCornerOverlay() {
        if (!this.cornerOverlay) return;
        const hide = this.enabled === true && !this.destroyed
            && !!this.settings && this.settings.get('tabHidesMinimap') === true;
        this.cornerOverlay.setSuppressed(hide);
    }

    /**
     * A settings key changed. Three easily conflated things: the **master
     * switch** starts or stops the mode, a layer or opacity change only
     * re-draws, an emptied payload hides *now*.
     */
    onSettingsChanged(keys) {
        if (this.destroyed) return;
        const changed = Array.isArray(keys) ? keys : [keys];
        if (changed.includes('tabHidesMinimap')) this.syncCornerOverlay();
        // `tabMarkersInstant` is **not** in the list: it would re-send mid-fade.
        if (!changed.some(key => LIVE_MARKER_SETTINGS.includes(key) || key === 'tabMarkers')) return;
        const wasEnabled = this.enabled;
        this.syncWithSettings();
        if (!this.enabled || !this.state.showing) return;
        if (!wasEnabled) return;
        const payload = this.buildPayload(this.state.key);
        if (!payload) {
            this.dispatch({type: 'lost', reason: 'markers-off'});
            return;
        }
        // A merely *different* payload must not be re-sent while the markers
        // are a guess: `place()` carries no `fade`, so it snaps them to full.
        if (this.state.provisional) return;
        if (this.rect) {
            const bounds = this.boundsFor(this.rect);
            if (bounds && !bounds.clamped) this.overlay.place(bounds, payload);
        }
    }

    /** `MapDetector`: the game-window lookup, the event log and `isRunning()`. */
    setDetector(detector) {
        this.detector = detector || null;
    }

    /** Where the fallback notice goes; injected, the main window predates this. */
    setNotifier(fn) {
        this.notifier = typeof fn === 'function' ? fn : null;
    }

    mapVk() {
        return resolveMapVk(this.settings ? this.settings.get('tabMarkerKey') : null);
    }

    triggerMode() {
        return triggerMode(this.settings ? this.settings.get('markerTrigger') : null);
    }

    /** @returns {'key'|'key-waiting'|'polling'} the pure `resolveTriggerMethod`. */
    method() {
        return this.methodInfo().method;
    }

    /** @returns {{method: 'key'|'key-waiting'|'polling', reason: string}} */
    methodInfo() {
        return resolveTriggerMethod({
            mode: this.triggerMode(),
            // `!== false`: conflating availability with "is it running" made
            // the app claim the key state was unavailable with the game closed.
            available: this.trigger.usable !== false,
            running: this.trigger.running === true,
            gameWindow: this.gameWindowPresent,
            reason: this.trigger.reason
        });
    }

    /** The setting, whatever the detector is doing. */
    wanted() {
        return !!(this.settings && this.settings.get('tabMarkers') === true
            && markerState(this.settings.all()).enabled);
    }

    /** On *and* usable: the mode needs the detector to name the map. */
    isActive() {
        return this.enabled && !this.destroyed && !!(this.detector && this.detector.isRunning());
    }

    /**
     * "Nothing computed before now may be shown." On every hide and teardown,
     * so a capture resolving afterwards cannot resurrect the markers.
     */
    invalidate() {
        this.epoch++;
        this.lastHideAt = this.now();
        this.confirmQueued = false;
        this.confirmAttempts = 0;
        if (this.confirmTimer) {
            clearTimeout(this.confirmTimer);
            this.confirmTimer = null;
        }
        this.clearProvisionalDeadline();
    }

    /**
     * The hard stop, cancelled. **Only where the provisional state has ended**:
     * nothing that leaves the markers up may cancel it (same doc § The reproduced races).
     */
    clearProvisionalDeadline() {
        if (!this.provisionalTimer) return;
        clearTimeout(this.provisionalTimer);
        this.provisionalTimer = null;
    }

    /**
     * Start the clock on a provisional show. A plain `setTimeout`, on purpose:
     * the one thing it exists to survive is a frame source that never answers.
     * Re-armed, never extended. Firing with the key **still held** restarts the
     * ordinary path, or a slow press reads as show / hide / re-show.
     */
    armProvisionalDeadline() {
        this.clearProvisionalDeadline();
        this.provisionalTimer = setTimeout(() => {
            this.provisionalTimer = null;
            if (!this.state.showing || !this.state.provisional) return;
            this.counters.unconfirmed++;
            // The memory goes too, so a press in chat flashes **once**.
            this.dispatch({type: 'lost', reason: 'unconfirmed'});
            // `dispatch` invalidated everything: a clean budget, new epoch.
            if (this.method() === 'key' && this.keyStillDown() && this.isActive() && this.wanted()) {
                this.confirmAttempts = 0;
                this.confirmNow();
            }
        }, this.provisionalMs);
        if (this.provisionalTimer.unref) this.provisionalTimer.unref();
    }

    /** Up **and** proved by a capture, as against merely provisional. */
    settled() {
        return this.state.showing && !this.state.provisional;
    }

    instantWanted() {
        return !(this.settings && this.settings.get('tabMarkersInstant') === false);
    }

    /** The detector's `lastDetected` — the half that is **cleared** for us. */
    detectorMapKey() {
        if (!this.detector || typeof this.detector.status !== 'function') return null;
        try {
            const status = this.detector.status();
            return (status && status.lastDetected) || null;
        } catch (err) {
            return null;
        }
    }

    /**
     * The map an optimistic show may be drawn for: **`confirmedKey`**, with
     * `lastDetected` only a **veto** because `confirm()` never updates it.
     */
    knownMapKey() {
        const confirmed = this.state.confirmedKey;
        if (!confirmed) return null;
        const known = this.detectorMapKey();
        return !known || known === confirmed ? confirmed : null;
    }

    /**
     * Is the detector naming a *different* map? Then forget. A **state** test,
     * not an edge: a consumed edge cannot be consulted on the next press.
     */
    noteKnownMap() {
        const known = this.detectorMapKey();
        this.knownKey = known;
        if (known && this.state.confirmedKey && known !== this.state.confirmedKey) {
            this.forgetConfirmed('map-changed');
        }
    }

    /**
     * Drop a memory that got old. Every confirmation refreshes `confirmedAt`,
     * so this fires only in a gap between matches nothing else notices.
     */
    expireConfirmed() {
        if (!this.state.confirmedKey) return;
        if (confirmedMemoryFresh(this.confirmedAt, this.now(), CONFIRMED_MEMORY_MS)) return;
        this.forgetConfirmed('expired');
    }

    /** Drop the optimistic memory, screen and loops untouched; `reason` logs. */
    forgetConfirmed(reason) {
        if (!this.state.confirmedKey) return;
        this.state = forgetConfirmedMap(this.state);
        this.log('tab-forget', {reason});
    }

    /**
     * Is the map key held? On the polling path there is no key, so this answers
     * `true` and the staleness rules carry the weight alone.
     */
    keyStillDown() {
        if (this.method() !== 'key') return true;
        return this.trigger.running === true && this.trigger.wasDown === true;
    }

    isShowing() {
        return this.state.showing;
    }

    /** The periodic check's interval: 150 ms polling, 500 ms with the trigger. */
    checkMs() {
        return checkInterval(this.method());
    }

    /**
     * A grab with a deadline **of this mode's own**, the source's being
     * generous to a booting child. Unanswered within `ms` = "no frame" = hide.
     * A rejection passes through; a reply after the deadline is dropped.
     */
    grabWithin(promise, ms) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                resolve({
                    type: 'grab', aborted: true, reason: 'deadline',
                    window: null, gate: false, match: null, menu: null, timings: null
                });
            }, ms);
            if (timer.unref) timer.unref();
            promise.then(
                (reply) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    resolve(reply);
                },
                (err) => {
                    if (settled) return;              // late failure: already answered
                    settled = true;
                    clearTimeout(timer);
                    reject(err);
                }
            );
        });
    }

    /** Should the detector poll faster? Only on the polling path. */
    wantsFasterDetection() {
        return detectIntervalFor({running: this.isActive(), method: this.method()}) !== null;
    }

    /** Follow the setting and the detector. */
    syncWithSettings() {
        if (this.wanted() && this.detector && this.detector.isRunning()) this.start();
        else this.stop();
        this.syncCornerOverlay();
    }

    start() {
        if (this.enabled || this.destroyed) return;
        this.enabled = true;
        this.syncCornerOverlay();
        this.state = initialTabModeState();
        this.rect = null;
        this.knownKey = null;
        this.confirmedAt = 0;
        this.counters = {checks: 0, shows: 0, hides: 0, stale: 0, retries: 0, provisional: 0, unconfirmed: 0};
        appLog.event('tab-markers', {action: 'start'});
        // Built now, not on the first press: a BrowserWindow takes tens of ms.
        this.overlay.ensure();
        this.refreshGameWindow();
        this.applyMethod();
        const info = this.methodInfo();
        this.log('tab-mode-start', {
            method: info.method,
            reason: info.reason,
            // Only the cadences actually in effect; see `resolveTriggerMethod`.
            keyMs: info.method === 'polling' ? 0 : KEY_POLL_INTERVAL,
            checkMs: this.checkMs(),
            detectMs: this.wantsFasterDetection() ? DETECT_INTERVAL : 0,
            game: this.gameWindowPresent ? 'yes' : 'no',
            vk: this.mapVk()
        });
    }

    /**
     * Seed the game-window state, because `onWindow` is an **edge** a mode
     * switched on between two would never see. At `start()` only: re-reading
     * would undo an edge that had just arrived.
     */
    refreshGameWindow() {
        if (!this.detector || typeof this.detector.gameWindowInfo !== 'function') return;
        const info = this.detector.gameWindowInfo();
        this.gameWindowPresent = !!info.present;
        this.trigger.setGamePid(info.present ? info.pid : null);
    }

    /**
     * The **single place** that decides whether the key may be polled, keeping
     * "does the native path work" (probed even with the game closed) apart from
     * "should it be polled now" (only with a game window). Both gates are
     * **state** tests, never events: `onWindow(false)` never fires if the
     * window was absent all along, and gating on `enabled` polled for ever.
     */
    applyMethod() {
        const wantsKey = this.enabled && !this.destroyed && this.wanted()
            && this.triggerMode() !== 'polling';
        if (wantsKey) {
            this.trigger.setMapVk(this.mapVk());
            // The notice belongs to a failed probe, not to a closed game.
            if (!this.trigger.probe().ok) this.noticeFallback(this.trigger.reason || 'unavailable');
        }
        const shouldPoll = wantsKey && this.gameWindowPresent;
        if (!shouldPoll) {
            this.trigger.stop();
        } else if (!this.trigger.start()) {
            this.noticeFallback(this.trigger.reason || 'unavailable');
        }
        const info = this.methodInfo();
        appLog.event('tab-markers', {action: 'method', method: info.method, reason: info.reason});
        // The cadence depends on the method, so a change re-arms a live loop.
        if (this.state.showing) this.schedule(this.checkMs());
    }

    fallBackToPolling(why) {
        if (!this.enabled) return;
        this.trigger.stop();
        this.noticeFallback(why || 'call');
        // Back to the fast loop: it is now the only thing that will hide them.
        if (this.state.showing) this.schedule(this.checkMs());
    }

    /**
     * One translated notice per session, never per tick: the feature still
     * works, differently, and that is otherwise unanswerable for the user.
     */
    noticeFallback(why) {
        if (this.fallbackNoticed) return;
        this.fallbackNoticed = true;
        appLog.warn('tab-markers', {action: 'fallback', reason: why});
        this.log('tab-key-fallback', {reason: why});
        if (this.notifier) this.notifier(msg('tabMarkers.fallback'));
    }

    stop() {
        const wasEnabled = this.enabled;
        this.clearTimer();
        this.trigger.stop();
        this.dispatch({type: 'stop'});
        // As well as through `dispatch`: a stop with nothing on screen must
        // still strand a capture in flight, or stop()/start() is overtaken.
        this.invalidate();
        this.enabled = false;
        this.rect = null;
        this.knownKey = null;
        this.confirmedAt = 0;
        this.syncCornerOverlay();
        if (wasEnabled) {
            appLog.event('tab-markers', {action: 'stop'});
            this.log('tab-mode-stop', {
                checks: this.counters.checks,
                shows: this.counters.shows,
                keyDowns: this.trigger.counters.downs
            });
        }
    }

    /** Quit or update. `destroyed` is *for good*: no second window, ever. */
    destroy() {
        this.destroyed = true;
        this.clearTimer();
        this.invalidate();
        this.trigger.destroy();
        this.state = initialTabModeState();
        this.enabled = false;
        this.rect = null;
        this.knownKey = null;
        this.confirmedAt = 0;
        this.overlay.close();
    }

    clearTimer() {
        this.clearCheckTimer();
        if (this.confirmTimer) clearTimeout(this.confirmTimer);
        this.confirmTimer = null;
        this.clearProvisionalDeadline();
    }

    /** Only the check timer: a provisional show needs the retries running too. */
    clearCheckTimer() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    keyLabel() {
        const stored = this.settings ? this.settings.get('tabMarkerKeyLabel') : null;
        return sanitiseKeyLabel(stored) || '';
    }

    /* ── The detector's side of the conversation ─────────────────────────── */

    /**
     * The detector accepted a map on a frame that passed the Tab gate. **Two
     * refusals before anything is drawn**, both reproduced races: a result
     * older than `lastHideAt`, and a key no longer held.
     * @param {?{x, y, width, height}} rect the game window, physical pixels
     * @param {?{width, height}} [captured] the frame's own size, physical px
     * @param {?number} [startedAt] ms, when that capture began
     */
    onMatch(key, rect, captured, startedAt) {
        if (!this.isActive()) return;
        if (typeof startedAt === 'number' && startedAt < this.lastHideAt) {
            this.counters.stale++;
            this.log('tab-stale', {source: 'detector', reason: 'older-than-hide'});
            return;
        }
        if (!this.keyStillDown()) {
            this.counters.stale++;
            this.log('tab-stale', {source: 'detector', reason: 'key-up'});
            return;
        }
        const payload = this.buildPayload(key);
        if (rect && !this.noteRect(rect, captured)) {
            this.dispatch({type: 'lost', reason: 'size-mismatch'});
            return;
        }
        this.dispatch({type: 'match', key, drawable: !!payload}, payload, rect);
    }

    /** A free extra gate signal; the fast loop remains the one that matters. */
    onGate(up) {
        if (!this.isActive()) return;
        if (!this.state.showing) return;
        this.dispatch({type: 'gate', up: !!up});
    }

    /** Something made the markers unsafe. @param {string} reason for the log. */
    onLost(reason) {
        const why = reason || 'lost';
        // A *match-over* loss costs the memory even with nothing on screen, but
        // a `lost` with nothing up must not bump the epoch, or a fault
        // mid-press strands the confirmation it races.
        if (MATCH_OVER_REASONS.includes(why)) this.forgetConfirmed(why);
        if (!this.state.showing && !this.timer) return;
        this.dispatch({type: 'lost', reason: why});
    }

    /**
     * The detector found, or lost, the game's window. The trigger starts and
     * stops with it and takes its foreground `pid` from that same read.
     */
    onWindow(present, pid) {
        this.gameWindowPresent = !!present;
        this.trigger.setGamePid(present ? pid : null);
        // The window going away ends the match; the next press re-earns it.
        if (!present) this.forgetConfirmed('no-window');
        if (!this.enabled) return;
        this.applyMethod();
    }

    /**
     * One edge of the map key. `down` asks for **one** confirming capture and
     * may *also* show provisionally; `up` hides. `reason` is for the log only.
     */
    onKeyHint(key, reason) {
        if (!this.isActive()) return;
        if (debug) console.log(`tab-markers: key ${key}${reason ? ` (${reason})` : ''}`);
        if (key !== 'down') {
            this.dispatch({type: 'hint', key});
            return;
        }
        this.confirmAttempts = 0;
        // Two ways the memory can be wrong: a different map, or simply old.
        this.noteKnownMap();
        this.expireConfirmed();
        const optimistic = this.provisionalShow();
        if (!optimistic) {
            this.dispatch({type: 'hint', key});
            return;
        }
        this.dispatch(
            {type: 'hint', key: 'down', provisional: true, mapKey: optimistic.key},
            optimistic.payload,
            this.rect
        );
    }

    /**
     * May the markers go up for this press *immediately*?
     * `shouldShowProvisionally` decides; this gathers its evidence, and
     * `foreground: true` is no assumption — `core/key-trigger.js` reads no key
     * unless the game is in front. Null = take the certain path.
     */
    provisionalShow() {
        const mapKey = this.knownMapKey();
        const payload = mapKey ? this.buildPayload(mapKey) : null;
        const bounds = this.rect ? this.boundsFor(this.rect) : null;
        const decision = shouldShowProvisionally(this.state, {
            instant: this.instantWanted(),
            method: this.method(),
            foreground: true,
            mapKey,
            drawable: !!payload,
            bounds: !!(bounds && !bounds.clamped)
        });
        if (!decision.show) {
            if (debug) console.log(`tab-markers: not provisional (${decision.reason})`);
            return null;
        }
        // The only payload that carries `fade`: confirmations re-send nothing.
        return {key: decision.key, payload: Object.assign({}, payload, {fade: true})};
    }

    /* ── The reducer and its effects ─────────────────────────────────────── */

    /** One event through the reducer; `payload`/`rect` are for a show. */
    dispatch(event, payload, rect) {
        const before = this.state.showing;
        const {state, effects} = reduceTabMode(this.state, event, {
            fastMs: this.checkMs(),
            hideAfterNegative: HIDE_AFTER_NEGATIVE
        });
        this.state = state;
        // Every confirmation refreshes the memory's age, whatever produced it.
        if (event.type === 'match' && this.state.confirmedKey) this.confirmedAt = this.now();

        // Bumped even with nothing on screen, and **decided after the reduce**:
        // the question is "did this event actually hide them", and `fading` is
        // the one answer meaning "no, on purpose".
        const negativeGate = event.type === 'gate' && !event.up;
        const invalidates = event.type === 'lost' || event.type === 'stop'
            || (event.type === 'hint' && event.key === 'up')
            || (negativeGate && effects.reason !== 'fading');
        if (invalidates) this.invalidate();

        if (effects.hide) {
            this.counters.hides++;
            this.overlay.hide();
            this.log('tab-hide', {reason: effects.reason});
            if (debug) console.log(`tab-markers: hidden (${effects.reason})`);
        }
        if (effects.confirmed) {
            // Nothing is re-sent, so this is the only record of the guess.
            this.log('tab-confirmed', {
                key: this.state.key || '',
                ms: Math.max(0, Math.round(this.now() - this.provisionalAt))
            });
        }
        if (effects.show && payload) {
            const bounds = this.boundsFor(rect || this.rect);
            // `clamped` = the rect reached outside its display, so drawing puts
            // markers somewhere nobody chose: no honest place, like no bounds.
            if (!bounds || bounds.clamped) {
                // `lost` + `invalidate()` clear `provisional` and the deadline.
                this.state = reduceTabMode(this.state, {type: 'lost', reason: 'no-bounds'},
                    {fastMs: this.checkMs(), hideAfterNegative: HIDE_AFTER_NEGATIVE}).state;
                this.invalidate();
                this.overlay.hide();
                this.log('tab-hide', {reason: bounds ? 'bounds-clamped' : 'no-bounds'});
                this.clearTimer();
                return;
            }
            if (this.overlay.place(bounds, payload)) {
                this.counters.shows++;
                if (effects.provisional) this.counters.provisional++;
                this.log('tab-show', {
                    // `state.key`, not `event.key`: a provisional show arrives
                    // on a `hint`, whose `key` is the word "down".
                    key: this.state.key || '',
                    layers: payload.layers.length,
                    points: payload.layers.reduce((n, l) => n + l.points.length, 0),
                    provisional: effects.provisional ? 'yes' : 'no'
                });
                if (debug) console.log(`tab-markers: shown for "${this.state.key}"`
                    + `${effects.provisional ? ' (provisional)' : ''}`);
            }
            if (effects.provisional) {
                // Armed even if `place()` failed — see the guard below.
                this.provisionalAt = this.now();
                this.armProvisionalDeadline();
            }
        } else if (this.state.showing && !before) {
            // Should not happen, but must not leave the state claiming markers.
            this.state = Object.assign({}, this.state,
                {showing: false, key: null, provisional: false});
        }

        if (!this.state.provisional) this.clearProvisionalDeadline();

        // The invariant itself: **a provisional state must always have
        // something that will end it.** No deadline armed means a path
        // cancelled the timer without hiding, so hide rather than hope.
        if (this.state.provisional && !this.provisionalTimer) {
            this.counters.unconfirmed++;
            this.log('tab-deadline-lost', {key: this.state.key || ''});
            this.dispatch({type: 'lost', reason: 'unconfirmed'});
            return;
        }

        if (effects.checkNow) {
            // The **confirming** capture: only it can say they belong there.
            this.confirmNow();
            // An optimistic show starts the loop at once: markers to watch.
            if (effects.nextCheckMs !== null) this.schedule(effects.nextCheckMs);
        } else if (effects.nextCheckMs === null) {
            this.clearTimer();
        } else {
            this.schedule(effects.nextCheckMs);
        }
    }

    /** `setTimeout` chaining, never `setInterval`. */
    schedule(delay) {
        if (!this.isActive()) return;
        this.clearCheckTimer();
        this.timer = setTimeout(() => this.check(), delay);
        // A background poll must never be the reason a process stays alive.
        if (this.timer.unref) this.timer.unref();
    }

    /* ── The confirming capture (the key trigger's half) ─────────────────── */

    /**
     * One capture, gate and match because the key went down — **the only thing
     * a press causes**, which is what makes the trigger safe. Fired and
     * forgotten: a rejection means "that press was not the map".
     */
    confirmNow() {
        this.confirm().catch(err => {
            console.error('Tab markers: confirmation failed:', err && err.message);
        });
    }

    /** Retry while the key is held: the game's fade makes the first look early. */
    scheduleConfirmRetry() {
        if (this.confirmTimer) return;
        // `settled()`, not `showing`: an optimistic show is up and still needs
        // confirming, or it comes down at the deadline.
        if (!this.isActive() || this.settled() || !this.keyStillDown()) return;
        const delay = confirmRetryDelay(this.confirmAttempts);
        if (delay === null) return;
        this.confirmTimer = setTimeout(() => {
            this.confirmTimer = null;
            // Re-checked on arrival: the key may have gone up meanwhile.
            if (!this.isActive() || this.settled() || !this.keyStillDown()) return;
            this.counters.retries++;
            this.confirmNow();
        }, delay);
        if (this.confirmTimer.unref) this.confirmTimer.unref();
    }

    async confirm() {
        if (this.busy) {
            // Queued, not dropped: a press landing mid-capture would do nothing.
            this.confirmQueued = true;
            return;
        }
        if (!this.isActive() || !this.wanted()) return;
        if (!this.keyStillDown()) return;
        this.busy = true;
        // Compared after every `await` below: a hide can land at any of them.
        const epoch = this.epoch;
        const started = this.now();
        this.confirmAttempts++;
        const stale = () => this.epoch !== epoch || !this.isActive() || !this.keyStillDown();
        try {
            // Bounded: `busy` is the flag the retries queue behind.
            const reply = await this.grabWithin(this.detector.grabMatch(), SAFETY_INTERVAL);
            if (stale()) { this.counters.stale++; return; }
            // `aborted`/`error` are **no answer**, not a statement about the
            // window, so they precede it — or a fault reads as "not running".
            if (reply.aborted) {
                this.logState('no frame for the confirming press: ' + reply.reason);
                return;
            }
            if (reply.error) {
                this.logState('confirmation capture failed: ' + reply.error);
                return;
            }
            const win = reply.window || {present: false};
            if (!win.present) {
                this.dispatch({type: 'lost', reason: 'no-window'});
                return;
            }
            if (win.minimized || !win.rect) return;
            const rect = win.rect;
            if (!reply.gate) {
                const spent = this.now() - started;
                this.lastTiming = reply.timings || {enumerate: 0, capture: 0, gate: spent, total: spent};
                this.log('tab-key-confirm', {result: 'gated', attempt: this.confirmAttempts, tickMs: spent});
                // Too early, most likely: the game is still fading the screen in.
                this.scheduleConfirmRetry();
                return;
            }
            const match = reply.match;
            if (!match) return;
            this.lastTiming = reply.timings || {enumerate: 0, capture: 0, gate: 0, total: this.now() - started};
            // One last look: a key-up can have landed while the reply flew.
            if (stale()) { this.counters.stale++; return; }
            if (!match.accepted) {
                // A Tab screen whose map is unrecognised: draw nothing.
                this.log('tab-key-confirm', {
                    result: 'no-match',
                    attempt: this.confirmAttempts,
                    score: match.score,
                    margin: match.margin,
                    tickMs: this.lastTiming.total
                });
                this.scheduleConfirmRetry();
                return;
            }
            this.log('tab-key-confirm', {
                result: 'match',
                attempt: this.confirmAttempts,
                key: match.key,
                score: match.score,
                tickMs: this.lastTiming.total
            });
            this.onMatch(match.key, rect, win.captured || null, started);
        } catch (err) {
            this.logState('confirmation capture failed: ' + ((err && err.message) || String(err)));
        } finally {
            this.busy = false;
            this.drainQueuedConfirm();
        }
    }

    drainQueuedConfirm() {
        if (!this.confirmQueued) return;
        this.confirmQueued = false;
        if (!this.isActive() || this.settled() || !this.keyStillDown()) return;
        this.confirmNow();
    }

    /* ── The periodic check ──────────────────────────────────────────────── */

    /**
     * "Is the Tab screen still up?", as cheaply as possible. **Not** `matchMap`:
     * the map cannot change during one press, so re-identifying it would cost
     * 16-22 ms a tick to answer a question nobody asked.
     */
    async check() {
        this.timer = null;
        if (this.busy) {
            // Re-schedule rather than return: returning drops the chain, and
            // this loop is the safety net that has to keep running.
            if (this.state.showing) this.schedule(this.checkMs());
            return;
        }
        if (!this.isActive()) {
            // **Hiding**, not returning, or the markers sit there unnoticed.
            this.dispatch({type: 'lost', reason: 'inactive'});
            return;
        }
        if (!this.wanted()) {
            this.dispatch({type: 'lost', reason: 'markers-off'});
            return;
        }
        if (!this.state.showing) return;
        this.busy = true;
        // The staleness rule the other way round: a slow capture whose
        // *negative* gate lands after a fresh show would hide what a newer
        // answer had just put up.
        const epoch = this.epoch;
        const started = this.now();
        try {
            // Markers are up while this runs, so the deadline is the cadence:
            // no answer by the next check means take them down.
            const reply = await this.grabWithin(this.detector.grabGate(), this.checkMs());
            if (!this.isActive() || !this.state.showing || this.epoch !== epoch) {
                if (this.epoch !== epoch) this.counters.stale++;
                return;
            }
            // No answer means take them down; before `window`, as in `confirm`.
            if (reply.aborted) {
                this.logState('no frame for the safety check: ' + reply.reason);
                this.dispatch({type: 'lost', reason: 'no-frame'});
                return;
            }
            if (reply.error) {
                this.logState('capture failed: ' + reply.error);
                this.dispatch({type: 'lost', reason: 'capture-error'});
                return;
            }
            const win = reply.window || {present: false};
            if (!win.present) {
                this.dispatch({type: 'lost', reason: 'no-window'});
                return;
            }
            if (win.minimized) {
                this.dispatch({type: 'lost', reason: 'minimized'});
                return;
            }
            if (!win.rect) {
                this.dispatch({type: 'lost', reason: 'window-gone'});
                return;
            }
            if (rectChanged(win.rect, this.rect)) {
                // The panel is a fraction of the window: moved = wrong place.
                this.rect = win.rect;
                this.dispatch({type: 'lost', reason: 'moved'});
                return;
            }
            if (!win.captured) {
                this.dispatch({type: 'lost', reason: 'empty-capture'});
                return;
            }
            this.lastTiming = reply.timings || {enumerate: 0, capture: 0, gate: 0, total: this.now() - started};
            this.counters.checks++;
            this.dispatch({type: 'gate', up: !!reply.gate});
        } catch (err) {
            // A capture that threw is not a negative gate, it is no answer.
            this.logState('capture failed: ' + ((err && err.message) || String(err)));
            this.dispatch({type: 'lost', reason: 'capture-error'});
        } finally {
            this.busy = false;
            this.drainQueuedConfirm();
        }
    }

    /* ── Geometry and payload ────────────────────────────────────────────── */

    /**
     * Remember the rect the markers are placed against, and check the capture
     * came from it: positions are fractions of the **captured frame** while the
     * window sits at the **window rect**, which a border makes differ. It
     * **refuses** rather than draw "nearly right" — false = do not draw.
     */
    noteRect(rect, captured) {
        this.rect = rect;
        if (!captured) return true;
        const off = Math.abs(captured.width - rect.width) > 2
            || Math.abs(captured.height - rect.height) > 2;
        if (!off) {
            this.sizeMismatch = false;
            return true;
        }
        this.sizeMismatch = true;
        if (!this.sizeMismatchLogged) {
            this.sizeMismatchLogged = true;
            this.log('tab-size-mismatch', {
                captureW: captured.width, captureH: captured.height,
                windowW: rect.width, windowH: rect.height
            });
            appLog.warn('tab-markers', {action: 'size-mismatch'});
        }
        return false;
    }

    /** Physical pixels → DIPs: the `screen` reads here, the maths in the rules. */
    boundsFor(rect) {
        if (!rect) return null;
        let displays;
        try {
            const primaryId = this.screen.getPrimaryDisplay().id;
            displays = this.screen.getAllDisplays().map(display => ({
                bounds: display.bounds,
                physical: this.screen.dipToScreenRect(null, display.bounds),
                scaleFactor: display.scaleFactor,
                primary: display.id === primaryId
            }));
        } catch (err) {
            console.error('Tab markers: could not read the displays:', err && err.message);
            return null;
        }
        return gameRectToDip(rect, displays);
    }

    /**
     * The payload for one map, or null when it cannot be drawn — then the
     * corner minimap stays the fallback, a wrong overlay being worse than none.
     * @returns {?{layers, legend, opacity, lang}}
     */
    buildPayload(key) {
        if (!this.mapMarkers || !this.settings) return null;
        const state = markerState(this.settings.all());
        if (!state.enabled) return null;
        const markers = this.mapMarkers.markers(key);
        if (!markers) return null;
        const layers = tabLayers({markers, settings: this.settings.all()});
        if (!layers.length) return null;
        return {
            layers,
            legend: state.legend,
            opacity: state.opacity,
            lang: this.language ? this.language.current() : 'en'
        };
    }

    /* ── Logging ─────────────────────────────────────────────────────────── */

    /** Through the detector's own log, so the whole chain is in one file. */
    log(event, fields) {
        if (this.detector && this.detector.log && typeof this.detector.log.write === 'function') {
            this.detector.log.write(event, fields || {});
        }
    }

    /** A repeating condition must not fill the log. */
    logState(message) {
        const now = Date.now();
        if (now - this.lastStateLogAt < STATE_LOG_INTERVAL) return;
        this.lastStateLogAt = now;
        console.error('Tab markers:', message);
    }

    /** What `system.txt` and the Settings line print. */
    status() {
        const info = this.methodInfo();
        return {
            setting: !!(this.settings && this.settings.get('tabMarkers') === true),
            active: this.isActive(),
            showing: this.state.showing,
            key: this.state.key,
            instant: this.instantWanted(),
            provisionalShowing: this.state.provisional,
            confirmedKey: this.state.confirmedKey,
            provisionalMs: this.provisionalMs,
            method: info.method,
            methodReason: info.reason,
            triggerMode: this.triggerMode(),
            mapVk: this.mapVk(),
            mapKeyLabel: this.keyLabel(),
            gameWindow: this.gameWindowPresent,
            sizeMismatch: !!this.sizeMismatch,
            keyMs: KEY_POLL_INTERVAL,
            checkMs: this.checkMs(),
            fastMs: FAST_INTERVAL,
            safetyMs: SAFETY_INTERVAL,
            detectMs: this.wantsFasterDetection() ? DETECT_INTERVAL : 0,
            hideAfterNegative: HIDE_AFTER_NEGATIVE,
            checks: this.counters.checks,
            shows: this.counters.shows,
            hides: this.counters.hides,
            // Answers after a hide: a trickle is normal, a flood is not.
            stale: this.counters.stale,
            retries: this.counters.retries,
            // `unconfirmed` near `provisional` = the gamble is not paying off.
            provisional: this.counters.provisional,
            unconfirmed: this.counters.unconfirmed,
            lastTiming: this.lastTiming,
            trigger: this.trigger.status()
        };
    }
}

module.exports = TabMode;
