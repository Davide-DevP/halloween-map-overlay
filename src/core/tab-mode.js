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

/**
 * Settings that change what is on screen *right now* while markers are shown.
 *
 * `markers` and the per-layer switches decide whether there is anything to
 * draw at all; `markerOpacity`/`markerLegend` change how it looks. All of them
 * used to be noticed only at the next periodic check — up to half a second
 * later — or, for `markers`, not at all, because `src/js/maps.js` writes it
 * through the generic `set-setting` and nothing told this class.
 */
const LIVE_MARKER_SETTINGS = ['markers', 'markerOpacity', 'markerLegend', 'tabMarkerKey']
    .concat(MARKER_LAYERS.map(layer => layer.settingKey));

/**
 * Losses that mean **the match itself is over**, rather than one bad frame.
 *
 * Only these forget the optimistic memory from outside the reducer: the game's
 * window went away, the detector recognised the main menu, the mode can no
 * longer run at all. A window that moved, a capture that failed or a frame that
 * never arrived are faults *inside* a match — they take any markers down, as
 * they always did, but the reducer's own rule already decides what happens to
 * the memory when something was actually on screen.
 */
const MATCH_OVER_REASONS = ['menu', 'no-window', 'window-gone', 'minimized', 'inactive', 'markers-off'];

/**
 * What a key may be *called* on screen.
 *
 * The name comes from the browser's `KeyboardEvent.key`, which knows the active
 * layout — a virtual-key code alone cannot be turned back into a name on a
 * non-US keyboard. It is therefore text this app did not write, and it is shown
 * in Settings and printed in `system.txt`, so it is bounded and stripped of
 * anything that is not a plain key name.
 *
 * @param {*} value
 * @returns {?string}
 */
function sanitiseKeyLabel(value) {
    if (typeof value !== 'string') return null;
    const cleaned = value.replace(/[^\x20-\x7E -ɏ]/g, '').trim().slice(0, 16);
    return cleaned || null;
}

const debug = process.env.DEBUG === 'true';

/**
 * How often a repeating condition (no game window, a capture that keeps
 * failing) may reach `detector.log`. Show/hide decisions are logged on the
 * edge, so they are already one line per transition.
 */
const STATE_LOG_INTERVAL = 30000;

/**
 * **Tab-map mode** (experimental, off by default) — the electron half.
 *
 * While the player holds Tab the game draws a big fixed map with the player's
 * own arrow on it; the corner minimap has no player position, so drawing the
 * markers onto the game's map is strictly more useful. This class puts them
 * there for exactly as long as that screen is up.
 *
 * ## Two methods, and the second one is the fallback
 *
 * - **`key`** (preferred). A 30 ms `GetAsyncKeyState` poll of *one* key — the
 *   game's map key — through `core/key-trigger.js`. The down edge asks for one
 *   confirming capture (`confirmNow`), the up edge hides at once, and the
 *   periodic capture drops to a 500 ms safety check. Measured: 28 ns per key
 *   read, and the markers appear ~60 ms after the key goes down instead of up
 *   to ~480 ms.
 * - **`polling`**. The complete implementation this shipped with, and the
 *   automatic fallback: a 150 ms gate check while shown and the detector at
 *   450 ms. Nothing about the feature depends on the trigger existing — if
 *   koffi cannot load, a bind throws, or an antivirus blocks the native module,
 *   the mode keeps working and says which method it is using.
 *
 * It owns three things and delegates every decision:
 *
 * - **the periodic check** — `setTimeout` chaining, one capture and the Tab
 *   gate read straight off the raw buffer (1.4 ms of blocking JS; see
 *   `matcher.js` `tabGateFromRaw`). `busy` means a slow capture can never queue
 *   ticks behind itself.
 * - **the window** — `tab-overlay-window.js`, which must never take the
 *   foreground from the game.
 * - **nothing else**: what to show, when to look again and when to hide are the
 *   pure `reduceTabMode`; which method is in use is `resolveTriggerMethod`;
 *   what one key reading means is `keyHintFor`; physical pixels → DIPs is
 *   `gameRectToDip`.
 *
 * Rules that are not negotiable:
 *
 * - **It requires auto-detect.** The map is only known because the detector
 *   recognised it, so the switch is disabled with an explanation while
 *   auto-detect is off, and `stop()` runs when the detector stops.
 * - **Nothing is ever shown for a map the screen has not been read on.** The
 *   markers go up only after a frame that passed the Tab gate produced an
 *   accepted map. A gate pass on its own says "a Tab screen", not "this map"; a
 *   key press says even less — Tab is pressed in menus, in chat and in every
 *   lobby — so a `down` hint only ever *asks for a capture*.
 *
 *   The one thing 0.7 adds on top is the **optimistic show**
 *   (`tabMarkersInstant`, on by default), and it does not weaken that rule: it
 *   needs a press on *this very map* to have been confirmed by the gate
 *   already, recently, and it draws the markers **provisionally** —
 *   faded in over ~300 ms alongside the game's own fade, with a 550 ms
 *   deadline of its own. The confirming capture runs in parallel exactly as
 *   before; if it does not agree in time the markers come down
 *   (`tab-hide reason=unconfirmed`) and the map loses the fast path until a
 *   press is confirmed again. The first Tab of every match is as slow, and as
 *   certain, as it has always been.
 * - **When in doubt, hide.** One negative gate, a window that moved, a window
 *   that vanished or minimised, a failed capture, the main menu, the detector
 *   stopping, markers switched off, a key-up, Alt going down, the game losing
 *   the foreground, quit — all of them take the markers down at once. Markers
 *   over live gameplay is the failure that matters.
 */
class TabMode {

    /**
     * @param {Object} settings
     * @param {Object} mapMarkers `core/map-markers.js`
     * @param {?Object} language for the legend's strings
     * @param {{ipcMain?, screen?, overlay?, trigger?, now?}} [deps] injected
     *   **purely so `test/tab-mode.test.js` can exist**, exactly as
     *   `core/foreground.js` injects `app`/`BrowserWindow`/`Window`. This class
     *   is where every show/hide race lives — an in-flight capture racing a
     *   key-up, a detector tick finishing after a hide — and those interleavings
     *   cannot be driven through the real Electron, the real screen or a real
     *   keyboard. The app never passes this argument.
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
         * The optimistic show's deadline, injectable for the same reason the
         * clock is: it is a **real** `setTimeout` — deliberately, because its
         * whole job is to be independent of whether anything ever answers —
         * and a test that had to wait 550 ms per case to prove the markers come
         * down would be a test nobody runs.
         */
        this.provisionalMs = typeof d.provisionalMs === 'number' && d.provisionalMs > 0
            ? d.provisionalMs : PROVISIONAL_DEADLINE_MS;
        /** `MapDetector`, injected — it owns the game-window lookup and the log. */
        this.detector = null;
        this.overlay = d.overlay || new TabOverlayWindow();

        this.enabled = false;
        this.timer = null;
        this.busy = false;
        this.state = initialTabModeState();
        /** The game window rect (physical px) the markers were placed against. */
        this.rect = null;
        this.lastStateLogAt = 0;
        /** Last fast-check timings, for `system.txt`. */
        this.lastTiming = null;
        /** How many fast checks and how many hides this session — diagnostics. */
        this.counters = {checks: 0, shows: 0, hides: 0, stale: 0, retries: 0, provisional: 0, unconfirmed: 0};
        /** Whether the capture size disagreed with the window rect (logged once). */
        this.sizeMismatchLogged = false;
        /** Does the detector currently see a game window? Edge-reported by it. */
        this.gameWindowPresent = false;
        /** Whether the "using the slower method" notice has been shown. */
        this.fallbackNoticed = false;
        /** Where the notice goes; injected from index.js like every other toast. */
        this.notifier = null;
        /** Set by `destroy()`: nothing may rebuild the window after a quit. */
        this.destroyed = false;

        /**
         * ─── Staleness: the epoch, and when the markers last came down ──────
         *
         * A capture takes ~27 ms and the player can release the key inside
         * that. Without these two, an answer computed *before* a hide could
         * arrive *after* it and put the markers back up over live gameplay,
         * where only the next periodic check (up to 500 ms) would remove them.
         * Reproduced both ways: a quick tap (key-up lands mid-capture, so the
         * hide is a no-op because nothing was showing yet, and then the capture
         * resolves and shows), and a detector tick already in flight when the
         * player releases.
         *
         * So every operation that reads the screen remembers `epoch` when it
         * *starts*, and anything that means "nothing from before now may be
         * shown" bumps it. `lastHideAt` is the same rule for results that come
         * from the **detector**, which cannot know our epoch but does know when
         * its tick began.
         */
        this.epoch = 0;
        this.lastHideAt = 0;
        /** Confirmation attempts made for the current key press (F8 retries). */
        this.confirmAttempts = 0;
        /** A confirmation asked for while another capture was in flight. */
        this.confirmQueued = false;
        this.confirmTimer = null;

        /**
         * ─── The optimistic show ────────────────────────────────────────────
         *
         * `provisionalTimer` is the hard stop under markers that went up on a
         * key edge alone: it is armed when they do and it fires whatever the
         * frame source is (or is not) doing, so a worker that has died, is
         * restarting or simply never replies cannot leave a guess on screen.
         * `provisionalAt` is when the key went down, which is what
         * `tab-confirmed ms=` measures against.
         *
         * `knownKey` is the detector's own idea of which map is on screen, as
         * of the last time this class looked. It is compared rather than
         * trusted: when it changes — a different map, or the main menu clearing
         * it — the memory that allows an optimistic show is dropped, because
         * whatever was confirmed was confirmed about the old one.
         */
        this.provisionalTimer = null;
        this.provisionalAt = 0;
        this.knownKey = null;
        /**
         * When the last confirmation landed, so the memory can go stale.
         * Refreshed by every `match` — the confirming capture's, the detector's
         * own tick's, and the one that settles a provisional show alike.
         */
        this.confirmedAt = 0;

        const self = this;
        /**
         * The key-state trigger. Constructed now but **not loaded**: koffi is
         * `require`d on the first `start()`, so a user who never turns this mode
         * on never loads a native FFI module at all.
         */
        this.trigger = d.trigger || new KeyTrigger({
            onHint: (hint, reason) => self.onKeyHint(hint, reason),
            mapVk: this.mapVk(),
            log: (event, fields) => self.log(event, fields)
        });
        if (d.trigger) {
            // An injected trigger still has to reach us.
            this.trigger.onHint = (hint, reason) => self.onKeyHint(hint, reason);
        }
        // A dead renderer leaves whatever it last painted on an always-on-top
        // window. The window hides itself; this is what stops this class going
        // on believing the markers are fine.
        this.overlay.onRendererGone = (reason) => {
            self.invalidate();
            self.dispatch({type: 'lost', reason: 'renderer-gone'});
            self.log('tab-hide', {reason: 'renderer-gone', detail: reason || ''});
        };
        // A call that starts failing after working once: fall back mid-session
        // rather than stop reacting to the key.
        this.trigger.onUnavailable = (why) => self.fallBackToPolling(why);

        // The generic `set-setting` path writes `markers`, the per-layer
        // switches and the opacity — the Ctrl+Alt+M hotkey goes through it too
        // — and nothing used to tell this class. So the master switch never
        // started or stopped the mode, and a layer switched off mid-hold stayed
        // on screen. One hook, registered here rather than in `index.js`, so
        // the wiring cannot be forgotten.
        if (settings && typeof settings.onChange === 'function') {
            settings.onChange((keys) => self.onSettingsChanged(keys));
        }

        // Its own handler rather than `set-setting`, for the same reason
        // `mapDetection` and `hotkeysGameOnly` have one: main has to *act* on
        // it — a second window and a capture loop start or stop in the same
        // breath — and the renderer posting the setting alone would leave the
        // two out of step until the next restart.
        this.ipcMain.handle('set-tab-markers', async (event, value) => {
            const on = value === true;
            if (self.settings) self.settings.set('tabMarkers', on);
            self.syncWithSettings();
            return self.status();
        });
        this.ipcMain.handle('get-tab-marker-state', async () => self.status());
        // The map key. Its own handler because the running trigger has to be
        // pointed at the new key in the same breath, and because the renderer
        // sends a *virtual-key code* that has to be validated here — with
        // `nodeIntegration: true` the renderer is not a trust boundary, and
        // `GetAsyncKeyState` would happily answer for a mouse button.
        this.ipcMain.handle('set-tab-marker-key', async (event, vk, label) => {
            const resolved = resolveMapVk(vk);
            if (self.settings) {
                self.settings.set('tabMarkerKey', resolved);
                // What the key is *called* comes from the browser, which knows
                // the active layout; the virtual-key code alone cannot be
                // turned back into a name on a non-US keyboard. Bounded and
                // stripped of anything that is not a printable key name —
                // it is shown in Settings and printed in `system.txt`.
                self.settings.set('tabMarkerKeyLabel', sanitiseKeyLabel(label));
            }
            self.trigger.setMapVk(resolved);
            // A key change while the markers are up would leave them waiting
            // for an up-edge on a key nobody is watching any more — and any
            // capture already in flight for the *old* key must not land.
            self.invalidate();
            self.dispatch({type: 'lost', reason: 'key-changed'});
            appLog.event('tab-markers', {action: 'map-key', vk: resolved});
            return self.status();
        });
        // "Polling only" — the user's escape hatch. Same reasoning as
        // `set-tab-markers`: main switches methods, it does not just store a
        // preference.
        this.ipcMain.handle('set-marker-trigger', async (event, mode) => {
            const resolved = triggerMode(mode);
            if (self.settings) self.settings.set('markerTrigger', resolved);
            self.applyMethod();
            return self.status();
        });
    }

    /**
     * The corner minimap's window. A player who reads the game's own Tab map
     * may not want the corner one at all (`tabHidesMinimap`, off by default).
     */
    setCornerOverlay(overlayWindow) {
        this.cornerOverlay = overlayWindow || null;
        this.syncCornerOverlay();
    }

    /**
     * Tied to `enabled`, not to the `tabMarkers` setting: if this mode cannot
     * run — auto-detect off, the master marker switch off — the corner minimap
     * is the only map the player has, and it must come back.
     */
    syncCornerOverlay() {
        if (!this.cornerOverlay) return;
        const hide = this.enabled === true && !this.destroyed
            && !!this.settings && this.settings.get('tabHidesMinimap') === true;
        this.cornerOverlay.setSuppressed(hide);
    }

    /**
     * A settings key changed somewhere in the app.
     *
     * Three different things have to happen and they are easy to conflate:
     * the **master switch** starts or stops the whole mode (it is what
     * Ctrl+Alt+M toggles, through the generic `set-setting`); a **layer or
     * opacity** change only re-draws what is already up; and anything that
     * makes the payload empty has to hide *now* rather than at the next check.
     *
     * @param {string[]} keys the keys that were written
     */
    onSettingsChanged(keys) {
        if (this.destroyed) return;
        const changed = Array.isArray(keys) ? keys : [keys];
        if (changed.includes('tabHidesMinimap')) this.syncCornerOverlay();
        // `tabMarkersInstant` is deliberately **not** in the list below. It
        // changes nothing about what is on screen — `instantWanted()` reads it
        // fresh on the next key-down edge — and rebuilding the live payload for
        // it would re-send one mid-fade, which is the single thing the
        // optimistic show is careful not to do.
        if (!changed.some(key => LIVE_MARKER_SETTINGS.includes(key) || key === 'tabMarkers')) return;
        // `wanted()` covers both `markers` and `tabMarkers`, so the master
        // switch now starts and stops this mode like every other way in.
        const wasEnabled = this.enabled;
        this.syncWithSettings();
        if (!this.enabled || !this.state.showing) return;
        if (!wasEnabled) return;
        // Still showing: rebuild the payload in place. A layer switched off, a
        // legend hidden or an opacity nudge mid-hold used to wait for the next
        // periodic check, and an opacity change was never re-sent at all.
        const payload = this.buildPayload(this.state.key);
        if (!payload) {
            this.dispatch({type: 'lost', reason: 'markers-off'});
            return;
        }
        // Nothing left to draw still hides at once, above — but a payload that
        // is merely *different* must not be re-sent while the markers are still
        // a guess: `place()` carries no `fade` flag, so it would snap them to
        // full opacity mid-fade, on a show that may be about to be taken down
        // again. The confirmation, or the next press, picks the change up.
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

    /**
     * Where the "using the slower method" notice goes. Injected, because the
     * main window is built before this class in `index.js` — the same shape
     * `Settings.setNotifier` uses.
     * @param {?Function} fn
     */
    setNotifier(fn) {
        this.notifier = typeof fn === 'function' ? fn : null;
    }

    /** The map key to watch, validated. */
    mapVk() {
        return resolveMapVk(this.settings ? this.settings.get('tabMarkerKey') : null);
    }

    /** The `markerTrigger` setting, normalised. */
    triggerMode() {
        return triggerMode(this.settings ? this.settings.get('markerTrigger') : null);
    }

    /**
     * Which method is in use right now — the pure `resolveTriggerMethod`.
     *
     * `key` only while the trigger is genuinely polling; `key-waiting` while it
     * is usable (or not yet probed) but has no game window to watch; `polling`
     * only when the user asked for it or the native path actually failed. So
     * the cadences below can never be the fast-trigger ones without the trigger
     * really being there, and "unavailable" is never said about something that
     * was never tried.
     *
     * @returns {'key'|'key-waiting'|'polling'}
     */
    method() {
        return this.methodInfo().method;
    }

    /** @returns {{method: 'key'|'key-waiting'|'polling', reason: string}} */
    methodInfo() {
        return resolveTriggerMethod({
            mode: this.triggerMode(),
            // Availability and "is it running" are two different questions, and
            // conflating them is what made the app claim the key state was
            // unavailable whenever the game happened to be closed.
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
     * "Nothing computed before this moment may be shown."
     *
     * Bumps the epoch every in-flight read remembers, and stamps the time the
     * detector's results are compared against. Called on every hide and on
     * every deliberate teardown, so a capture that resolves afterwards is
     * dropped instead of resurrecting the markers.
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
     * The optimistic show's hard stop, cancelled.
     *
     * Only ever called where the provisional state has *ended* — a hide, a
     * confirmation, a teardown. Nothing that leaves the markers up is allowed
     * to cancel it, which is the rule a negative gate broke: the gate does not
     * hide a provisional show (it is the game's fade), so `invalidate()`ing on
     * it used to take the deadline, the retry chain and the in-flight
     * confirmation away and leave the guess on screen until the key came up.
     */
    clearProvisionalDeadline() {
        if (!this.provisionalTimer) return;
        clearTimeout(this.provisionalTimer);
        this.provisionalTimer = null;
    }

    /**
     * Start the clock on a provisional show.
     *
     * A plain `setTimeout`, on purpose: everything else in this class is driven
     * by an answer from the frame source, and the one thing this timer exists
     * to survive is a frame source that never answers. It is re-armed rather
     * than extended — one press, one deadline.
     *
     * When it fires with the key **still held**, the press is not abandoned:
     * the markers come down (they were never confirmed, so they had no right
     * to be up) and the ordinary, certain path is started again for that same
     * press. Without that, a genuine press that is merely slower than the
     * deadline would read as *show at 0 ms, hide at the deadline, re-show when
     * the detector's own 700 ms tick next lands* — a flicker where waiting
     * would have been better.
     */
    armProvisionalDeadline() {
        this.clearProvisionalDeadline();
        this.provisionalTimer = setTimeout(() => {
            this.provisionalTimer = null;
            if (!this.state.showing || !this.state.provisional) return;
            this.counters.unconfirmed++;
            // Down they go, and the memory goes with them (the reducer's own
            // rule — `unconfirmed` is not a memory-keeping reason), so the next
            // press is the slow, certain one again. That is what makes a player
            // pressing the key in chat or the pause menu flash **once**.
            this.dispatch({type: 'lost', reason: 'unconfirmed'});
            // `dispatch` has just invalidated everything in flight, so this
            // starts from a clean budget against the new epoch.
            if (this.method() === 'key' && this.keyStillDown() && this.isActive() && this.wanted()) {
                this.confirmAttempts = 0;
                this.confirmNow();
            }
        }, this.provisionalMs);
        if (this.provisionalTimer.unref) this.provisionalTimer.unref();
    }

    /** Markers are up **and** a capture has proved they belong there. */
    settled() {
        return this.state.showing && !this.state.provisional;
    }

    /** The optimistic show, unless the user asked to always wait. */
    instantWanted() {
        return !(this.settings && this.settings.get('tabMarkersInstant') === false);
    }

    /**
     * The detector's own idea of which map the game is on, or null.
     *
     * It is the half of "which map is this" that gets **cleared** for us: the
     * menu clear sets it back to null, and so does the detector stopping. Our
     * own `confirmedKey` is the half that proves a Tab press really produced
     * this map's markers — the confirming capture goes straight to the frame
     * source (`grabMatch`) and never updates the detector's state. So this one
     * is a **veto**, not a requirement: see `knownMapKey()`.
     */
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
     * The map an optimistic show may be drawn for.
     *
     * **`confirmedKey` is the answer**, because it is the only one that means
     * what this feature needs it to mean: a Tab press on that map was accepted
     * by the screen gate. It arms after the *first* confirmed press of a match,
     * whoever produced it — `confirm()` goes straight to `detector.grabMatch()`
     * and never updates the detector's `lastDetected`, so waiting for the
     * detector to agree would have delayed the fast path by an arbitrary number
     * of presses for no gain.
     *
     * The detector's `lastDetected` is used only as a **veto**: when it names a
     * map at all and it is a *different* one, the memory is stale and is
     * dropped (`noteKnownMap`). `null` is not a veto — it is the detector
     * having nothing to say, which is its state for most of a match on this
     * path.
     *
     * What bounds the remaining hazard — a match that ends and another that
     * begins on a different map with no main menu and no window change in
     * between, where both halves can agree on something stale — is the age of
     * the memory (`CONFIRMED_MEMORY_MS`, `expireConfirmed`), plus the fact that
     * a wrong guess is one faded show of at most `PROVISIONAL_DEADLINE_MS`,
     * replaced by the right payload as soon as the capture answers.
     *
     * @returns {?string}
     */
    knownMapKey() {
        const confirmed = this.state.confirmedKey;
        if (!confirmed) return null;
        const known = this.detectorMapKey();
        return !known || known === confirmed ? confirmed : null;
    }

    /**
     * Is the detector naming a *different* map? Then forget what was confirmed.
     *
     * A **state** test rather than an edge, for the same reason `applyMethod()`
     * is one: an edge that has already been consumed cannot be consulted again,
     * and this has to be right on every press, not only on the press after a
     * change. Called on the key-down edge, where the answer is about to be
     * acted on, so it costs one `status()` per press.
     */
    noteKnownMap() {
        const known = this.detectorMapKey();
        this.knownKey = known;
        if (known && this.state.confirmedKey && known !== this.state.confirmedKey) {
            this.forgetConfirmed('map-changed');
        }
    }

    /**
     * Drop a memory that has simply got old.
     *
     * The clock is `this.now`, so a test can be five minutes old without
     * waiting; the rule is the pure `confirmedMemoryFresh`. Every confirmation
     * refreshes `confirmedAt`, so this never fires during play — it exists for
     * the gap between two matches that nothing else notices.
     */
    expireConfirmed() {
        if (!this.state.confirmedKey) return;
        if (confirmedMemoryFresh(this.confirmedAt, this.now(), CONFIRMED_MEMORY_MS)) return;
        this.forgetConfirmed('expired');
    }

    /**
     * Drop the memory that allows an optimistic show, without touching what is
     * on screen or either loop. The decision is the pure `forgetConfirmedMap`.
     * @param {string} reason for the log
     */
    forgetConfirmed(reason) {
        if (!this.state.confirmedKey) return;
        this.state = forgetConfirmedMap(this.state);
        this.log('tab-forget', {reason});
    }

    /**
     * Is the map key held right now?
     *
     * Only meaningful with the key trigger running; on the polling path there
     * is no key to ask about, so this answers `true` and the staleness rules
     * carry the weight on their own.
     */
    keyStillDown() {
        if (this.method() !== 'key') return true;
        return this.trigger.running === true && this.trigger.wasDown === true;
    }

    /** Are the markers on screen right now? */
    isShowing() {
        return this.state.showing;
    }

    /**
     * How long between periodic checks: the 150 ms show/hide loop on the
     * polling path, the 500 ms safety net with the trigger. Pure
     * (`checkInterval`).
     */
    checkMs() {
        return checkInterval(this.method());
    }

    /**
     * A grab with a deadline **of this mode's own**.
     *
     * The frame source has a timeout, but it is the *source's*: a request to a
     * child that has not finished booting is given the start-up grace, which is
     * right for the detector's 700 ms loop and wrong here. This mode draws
     * brackets over live gameplay, and the one thing they must never do is
     * linger — so a check that has not been answered within its own cadence is
     * treated as "no frame", which takes them down. Reproduced at 3.4 s before
     * this existed: a worker that died mid-hold, a missed key-up, and a
     * replacement that would not boot.
     *
     * A rejection is passed through, so the callers' `catch` still means what
     * it meant. A reply that arrives after the deadline is dropped, not acted
     * on — the same rule as everywhere else here.
     *
     * @param {Promise<Object>} promise
     * @param {number} ms
     * @returns {Promise<Object>}
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

    /**
     * Should the detector poll faster than its usual 700 ms?
     *
     * Only on the polling path, where a capture is the only way to notice the
     * Tab screen at all. With the key trigger the appearance is edge-driven, so
     * the 450 ms override is dropped — which is the main measurable saving of
     * the trigger, rather than the 28 ns of the key read itself. Pure
     * (`detectIntervalFor`).
     */
    wantsFasterDetection() {
        return detectIntervalFor({running: this.isActive(), method: this.method()}) !== null;
    }

    /** Follow the setting and the detector. Called at boot and on every change. */
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
        // The window is built now rather than on the first Tab press: creating a
        // BrowserWindow takes tens of milliseconds, and the whole point of the
        // feature is that the markers are there before the player has finished
        // reading the map.
        this.overlay.ensure();
        // Where the game is, before deciding whether to watch its key at all.
        this.refreshGameWindow();
        // …and only now is koffi loaded. A user who never turns this mode on
        // never pulls a native FFI module into the process.
        this.applyMethod();
        const info = this.methodInfo();
        this.log('tab-mode-start', {
            method: info.method,
            reason: info.reason,
            // Only the cadences that are actually in effect. The first field
            // log read `method=polling … detectMs=450` with the game closed,
            // where neither half of that was true.
            keyMs: info.method === 'polling' ? 0 : KEY_POLL_INTERVAL,
            checkMs: this.checkMs(),
            detectMs: this.wantsFasterDetection() ? DETECT_INTERVAL : 0,
            game: this.gameWindowPresent ? 'yes' : 'no',
            vk: this.mapVk()
        });
    }

    /**
     * Start or stop the key trigger to match the setting, and tell the user
     * **once** if the fast path is not available.
     *
     * Called from `start()`, when the "polling only" setting changes, and after
     * a mid-session failure. It never throws: the polling path is always there.
     */
    /**
     * Seed the game-window state from the detector.
     *
     * `onWindow` is an **edge**, so a mode switched on between two edges would
     * otherwise never learn that the game is already running. Called when the
     * mode starts, and never afterwards: an edge is fresher than a poll, and
     * re-reading here would undo an `onWindow` that had just arrived.
     */
    refreshGameWindow() {
        if (!this.detector || typeof this.detector.gameWindowInfo !== 'function') return;
        const info = this.detector.gameWindowInfo();
        this.gameWindowPresent = !!info.present;
        this.trigger.setGamePid(info.present ? info.pid : null);
    }

    applyMethod() {
        // Two separate questions, and running them together is what produced a
        // false "not available on this PC" in the field.
        //
        // 1. **Does the native path work?** Answered by a probe that loads
        //    koffi, binds `user32` and makes one `GetForegroundWindow()` call —
        //    no key is read. Done whenever the key method is wanted, *including
        //    with the game closed*, so Settings can tell the truth and the
        //    answer is in `app.log` from the first run.
        // 2. **Should the key be polled right now?** Only with a game window to
        //    watch. `onWindow(false)` is an *edge* that never fires when the
        //    window was absent all along, so this is a state test, not an
        //    event; `wanted()` covers the markers master switch, which was the
        //    same hole from the other side.
        const wantsKey = this.enabled && !this.destroyed && this.wanted()
            && this.triggerMode() !== 'polling';
        if (wantsKey) {
            this.trigger.setMapVk(this.mapVk());
            // The one-time notice belongs *here* — to a probe that really
            // failed — and not to a game that merely is not running yet.
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
        // The periodic check's cadence depends on the method, so a change has
        // to re-arm a loop that is already running.
        if (this.state.showing) this.schedule(this.checkMs());
    }

    /** A trigger that worked and then stopped working. */
    fallBackToPolling(why) {
        if (!this.enabled) return;
        this.trigger.stop();
        this.noticeFallback(why || 'call');
        // Back to the 150 ms loop straight away: with the key trigger gone,
        // that is the only thing that will take the markers down.
        if (this.state.showing) this.schedule(this.checkMs());
    }

    /**
     * One translated notice per session, never a toast per tick.
     *
     * The user is told because the feature still *works* but differently (a
     * little more capturing, a slightly later appearance) — and because
     * "it behaves differently on my PC" is otherwise unanswerable. `msg()`, so
     * the renderer translates it on arrival like every other main-process
     * message.
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
        // Explicitly, as well as through `dispatch`: a stop with nothing on
        // screen still has to strand any capture already in flight, or a
        // stop()/start() pair can be overtaken by the old one's result.
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

    /**
     * Quit, update, or the app shutting down. Closes the window for good.
     *
     * `destroyed` is what makes it *for good*: `runShutdownHooks()` runs from
     * `before-quit` and from the update path, and a `set-tab-markers` from a
     * renderer that has not gone away yet — or the detector stopping and
     * starting during the same teardown — must not build a second always-on-top
     * window while the installer is taking over.
     */
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

    /**
     * Only the periodic check's timer.
     *
     * `schedule()` used to go through `clearTimer()`, which also killed a
     * pending confirmation retry. That was harmless while "showing" meant
     * "confirmed" — retries do not run once the markers are up — but a
     * provisional show is up *and* still waiting to be confirmed, and the two
     * loops have to run side by side for the whole point of it to work.
     */
    clearCheckTimer() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    /** A key label as Settings and `system.txt` may show it. */
    keyLabel() {
        const stored = this.settings ? this.settings.get('tabMarkerKeyLabel') : null;
        return sanitiseKeyLabel(stored) || '';
    }

    /* ── The detector's side of the conversation ─────────────────────────── */

    /**
     * The ordinary detector accepted a map on a frame that passed the Tab gate.
     *
     * **Two refusals before anything is drawn**, and both are races that were
     * reproduced rather than imagined:
     *
     * 1. *The result is older than the last hide.* The detector's tick takes
     *    ~27 ms and the player can release the key inside it; the hide then
     *    lands first and this arrives afterwards with no key-down behind it,
     *    putting the markers back over live gameplay until the next periodic
     *    check. `startedAt` is when the tick began, so anything from before
     *    `lastHideAt` is dropped.
     * 2. *The key is no longer held.* In the key method a `match` that is not
     *    backed by a key that is still down is not something to show, whatever
     *    its timestamp says.
     *
     * @param {string} key the catalogue key
     * @param {?{x, y, width, height}} rect the game window, physical pixels
     * @param {?{width: number, height: number}} [captured] the captured frame's
     *   own size, so a capture that is not the window rect is visible
     * @param {?number} [startedAt] when the capture this came from began
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
            // The capture is not the window rectangle (a bordered window), so
            // every marker would sit offset by the border. Drawing "nearly
            // right" over the game's own map is worse than not drawing.
            this.dispatch({type: 'lost', reason: 'size-mismatch'});
            return;
        }
        this.dispatch({type: 'match', key, drawable: !!payload}, payload, rect);
    }

    /**
     * One of the detector's own ticks: it either passed the Tab gate (`up`) or
     * did not. A free extra signal at the detector's cadence — the fast loop
     * remains the one that matters.
     * @param {boolean} up
     */
    onGate(up) {
        if (!this.isActive()) return;
        if (!this.state.showing) return;
        this.dispatch({type: 'gate', up: !!up});
    }

    /**
     * Something made the markers unsafe: the game window is gone or minimised,
     * the detector stopped, the main menu was recognised, a capture failed.
     * @param {string} reason
     */
    onLost(reason) {
        const why = reason || 'lost';
        // A loss that means the *match* ended costs the optimistic memory even
        // with nothing on screen — which is the usual case, because the main
        // menu is recognised long after the player stopped pressing Tab. The
        // early return below is unchanged otherwise: a `lost` with nothing up
        // and no loop running must not bump the epoch, or a detector fault
        // arriving mid-press would strand the confirmation it was racing.
        if (MATCH_OVER_REASONS.includes(why)) this.forgetConfirmed(why);
        if (!this.state.showing && !this.timer) return;
        this.dispatch({type: 'lost', reason: why});
    }

    /**
     * The detector found, or lost, the game's window.
     *
     * The key trigger has nothing to do without a game window — and the pid it
     * compares the foreground against comes from that window — so it is
     * stopped and started with it. Edge-reported by the detector, so this is
     * not a per-tick cost.
     *
     * @param {boolean} present
     * @param {?number} pid the game's process id, from the same window read
     */
    onWindow(present, pid) {
        this.gameWindowPresent = !!present;
        this.trigger.setGamePid(present ? pid : null);
        // The game's window going away ends whatever match was running, so the
        // next press has to earn its markers from the screen again.
        if (!present) this.forgetConfirmed('no-window');
        if (!this.enabled) return;
        // Both directions go through `applyMethod`, which is the one place
        // that decides whether the key may be polled at all.
        this.applyMethod();
    }

    /**
     * One edge of the map key, from `core/key-trigger.js`.
     *
     * `down` asks for **one** confirming capture. On a map the screen has never
     * been read on it can show nothing at all: Tab is pressed in menus, in chat
     * and in every lobby, and the screen gate is the only thing that knows
     * whether the game's map is actually up. On a map a press has already been
     * confirmed on it may *also* put the markers up provisionally
     * (`provisionalShow`), faded in and on a 550 ms deadline, while that same
     * capture decides. `up` hides at once — the one case where the key is
     * better evidence than a capture, because it is instantaneous while the
     * next capture is up to `checkMs()` away.
     *
     * @param {'down'|'up'} key
     * @param {string} [reason] why the reading resolved that way ('alt',
     *   'not-foreground', …) — for the log only.
     */
    onKeyHint(key, reason) {
        if (!this.isActive()) return;
        if (debug) console.log(`tab-markers: key ${key}${reason ? ` (${reason})` : ''}`);
        if (key !== 'down') {
            this.dispatch({type: 'hint', key});
            return;
        }
        // A fresh press starts a fresh retry budget (see `confirmRetryDelay`).
        this.confirmAttempts = 0;
        // Two ways the memory can be wrong, checked before it is acted on: the
        // detector is naming a different map, or it is simply old.
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
     * Is this press one the markers may go up for *immediately*?
     *
     * The decision is the pure `shouldShowProvisionally`; everything here is
     * the evidence it asks for. The two impure answers are the payload (is
     * there anything to draw for this map, with the switches as they are right
     * now?) and the bounds (does the game's last known rectangle still convert
     * to a real, unclamped place on a real display?).
     *
     * `foreground: true` is not an assumption. A `down` hint only ever comes
     * from `core/key-trigger.js`, which reads `GetForegroundWindow` **before**
     * it reads any key and does not read the key at all unless the window in
     * front belongs to the game's pid; `keyHintFor` then resolves every other
     * reading to "up". So the arrival of this edge *is* the foreground
     * evidence. It is passed rather than assumed inside the rule, because the
     * rule has to keep saying what it requires.
     *
     * @returns {?{key: string, payload: Object}} null when this press takes the
     *   ordinary, certain path
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
        // The flag the renderer fades on, and the only payload that ever
        // carries it: a confirmation never re-sends one, so the animation is
        // never restarted by the app becoming sure.
        return {key: decision.key, payload: Object.assign({}, payload, {fade: true})};
    }

    /* ── The reducer and its effects ─────────────────────────────────────── */

    /**
     * Run one event through the pure reducer and apply what it asks for.
     *
     * @param {Object} event
     * @param {?Object} [payload] the marker payload, for a `match`
     * @param {?Object} [rect] the game window rect, for a `match`
     */
    dispatch(event, payload, rect) {
        const before = this.state.showing;
        const {state, effects} = reduceTabMode(this.state, event, {
            // 150 ms on the polling path, where this loop *is* the show/hide
            // mechanism; 500 ms with the key trigger, where it is the safety
            // net under a key-up this process never saw.
            fastMs: this.checkMs(),
            hideAfterNegative: HIDE_AFTER_NEGATIVE
        });
        this.state = state;
        // Every confirmation refreshes the memory's age, whichever path
        // produced it (`confirm()`, a detector tick, or the one that settles a
        // provisional show).
        if (event.type === 'match' && this.state.confirmedKey) this.confirmedAt = this.now();

        // Anything that means "the markers must not be up" also means "nothing
        // computed before now may put them back". Bumped even when there was
        // nothing on screen to hide: a quick tap releases the key *while the
        // confirming capture is still running*, so the hide is a no-op and the
        // capture is the thing that has to be stopped.
        //
        // **Decided after the reduce, not before it.** A negative gate used to
        // invalidate unconditionally, which was right while every negative gate
        // hid — but a negative gate during a provisional show is the game's own
        // fade and deliberately hides *nothing*. Invalidating there cancelled
        // the deadline, the retry chain and the confirming capture in flight
        // and left the guess on screen for the rest of the hold, or for ever on
        // a missed key-up: the exact failure this feature must not have. So the
        // question is now "did this event actually take the markers down", and
        // the `fading` branch is the one answer that means "no, on purpose".
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
            // A guess that came good. Nothing visible happens here — the
            // payload is deliberately *not* re-sent for the same map — so this
            // line is the only record that the optimistic path was used and how
            // long the screen took to agree with it.
            this.log('tab-confirmed', {
                key: this.state.key || '',
                ms: Math.max(0, Math.round(this.now() - this.provisionalAt))
            });
        }
        if (effects.show && payload) {
            const bounds = this.boundsFor(rect || this.rect);
            // `clamped` means the window rectangle reached outside the display
            // it is on — a game mid-resize, or a rectangle from a window that
            // was closing. Drawing into the clamped box would put the markers
            // somewhere nobody chose, so it counts as "no honest place to
            // draw", exactly like no bounds at all.
            if (!bounds || bounds.clamped) {
                // The `lost` reduce clears `showing`, `provisional` and the
                // memory, and `invalidate()` clears the deadline and strands
                // anything in flight — so this early return cannot leave a
                // provisional state behind with nothing to end it. The only
                // thing it skips is `confirmNow()`, and a press with nowhere
                // honest to draw has nothing to confirm.
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
                    // `this.state.key`, not `event.key`: a provisional show
                    // arrives on a `hint`, whose `key` is the word "down".
                    key: this.state.key || '',
                    layers: payload.layers.length,
                    points: payload.layers.reduce((n, l) => n + l.points.length, 0),
                    provisional: effects.provisional ? 'yes' : 'no'
                });
                if (debug) console.log(`tab-markers: shown for "${this.state.key}"`
                    + `${effects.provisional ? ' (provisional)' : ''}`);
            }
            if (effects.provisional) {
                // Armed whether or not the window took the payload: state that
                // says "provisional" must always have something that will end
                // it, and a `place()` that failed is one more reason to.
                this.provisionalAt = this.now();
                this.armProvisionalDeadline();
            }
        } else if (this.state.showing && !before) {
            // Showing was requested with nothing to draw — should not happen
            // (the reducer only shows on `drawable`, and an optimistic show is
            // only asked for once `buildPayload` has answered), but it must not
            // leave the state claiming markers are up, provisionally or not.
            this.state = Object.assign({}, this.state,
                {showing: false, key: null, provisional: false});
        }

        // A provisional show is no longer provisional — confirmed, or taken
        // down by any of the paths above — so nothing is left counting down.
        if (!this.state.provisional) this.clearProvisionalDeadline();

        // …and the other direction, which is the invariant itself: **a
        // provisional state must always have something that will end it.** If
        // this is ever reached still provisional with no deadline armed, some
        // path has cancelled the timer without taking the markers down — which
        // is what a negative gate did — and the safe answer to that is to hide,
        // not to hope. It costs one comparison per dispatch and it is the last
        // thing standing between a bug here and brackets over live gameplay.
        if (this.state.provisional && !this.provisionalTimer) {
            this.counters.unconfirmed++;
            this.log('tab-deadline-lost', {key: this.state.key || ''});
            this.dispatch({type: 'lost', reason: 'unconfirmed'});
            return;
        }

        if (effects.checkNow) {
            // A key-down edge. This is the **confirming** capture, not the
            // periodic gate check: an optimistic show has already put
            // *something* on screen, but only the capture can say it belongs
            // there, and without one the deadline takes it down again.
            this.confirmNow();
            // An optimistic show also starts the periodic loop straight away,
            // which an ordinary press does not — there are markers up to keep
            // an eye on. `schedule()` leaves the retry timer alone.
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
        // Like every other loop in this project (the key trigger, the pack
        // check, the retry): a background poll must never be the reason a
        // process stays alive.
        if (this.timer.unref) this.timer.unref();
    }

    /* ── The confirming capture (the key trigger's half) ─────────────────── */

    /**
     * One full capture, gate and match, run because the map key just went down.
     *
     * This is the *only* thing a key press causes, and it is what makes the
     * trigger safe: a press on its own proves nothing — Tab is pressed in
     * menus, in chat, in the lobby and to move focus in every window on the
     * machine — so the picture on screen still has to say "this is the map
     * panel, and it is *this* map" before a single bracket is drawn.
     *
     * It costs what one ordinary detector tick costs (~27 ms wall, ~22 ms of
     * blocking JS on a frame that passes the gate), **once per Tab press**,
     * against a 450 ms poll that pays it repeatedly whether the player pressed
     * anything or not.
     *
     * Fired and forgotten: a rejection is not an error, it is "that press was
     * not the map".
     */
    confirmNow() {
        this.confirm().catch(err => {
            console.error('Tab markers: confirmation failed:', err && err.message);
        });
    }

    /**
     * Try again shortly, while the key is still down.
     *
     * The game fades its Tab screen in, so the capture on the key-down edge can
     * genuinely be too early. Without this the next chance would be the
     * detector's 700 ms tick — slower than the polling path's 450 ms, i.e. the
     * trigger would have made the feature *worse* in the case it exists for.
     * The schedule itself is the pure `confirmRetryDelay` (60 / 150 / 300 ms
     * after the press).
     */
    scheduleConfirmRetry() {
        if (this.confirmTimer) return;
        // `settled()`, not `showing`: markers put up optimistically are on
        // screen and still need confirming — they are the reason the retries
        // matter most, because without one they come down again at the
        // deadline.
        if (!this.isActive() || this.settled() || !this.keyStillDown()) return;
        const delay = confirmRetryDelay(this.confirmAttempts);
        if (delay === null) return;
        this.confirmTimer = setTimeout(() => {
            this.confirmTimer = null;
            // Re-checked on arrival: the key may have gone up, or the markers
            // may already be confirmed, in the meantime.
            if (!this.isActive() || this.settled() || !this.keyStillDown()) return;
            this.counters.retries++;
            this.confirmNow();
        }, delay);
        if (this.confirmTimer.unref) this.confirmTimer.unref();
    }

    async confirm() {
        if (this.busy) {
            // Queued, not dropped: a press that lands while the periodic check
            // is mid-capture used to be thrown away, and the player's press
            // then did nothing at all.
            this.confirmQueued = true;
            return;
        }
        if (!this.isActive() || !this.wanted()) return;
        if (!this.keyStillDown()) return;
        this.busy = true;
        // Everything below is compared against this. A hide — from a key-up, a
        // lost window, the menu — bumps the epoch, and each `await` below is a
        // point at which that can have happened.
        const epoch = this.epoch;
        const started = this.now();
        this.confirmAttempts++;
        const stale = () => this.epoch !== epoch || !this.isActive() || !this.keyStillDown();
        try {
            // One request to the detector's frame source, which normally means
            // the utility process: capture, gate and — only if the gate passes
            // — the match. Not a pixel of it happens on this thread, and the
            // epoch is re-checked on the way back because the player can let go
            // during the ~25 ms it takes.
            // Bounded by this mode's own safety cadence: a confirming press can
            // only ever *show*, and the epoch already stops it showing late —
            // but a slow start must not hold `busy` for seconds while the key is
            // down, because that is the flag the retry schedule queues behind.
            const reply = await this.grabWithin(this.detector.grabMatch(), SAFETY_INTERVAL);
            if (stale()) { this.counters.stale++; return; }
            // "No frame this tick" (the loop was stopped, the worker is
            // restarting, the request timed out) and a frame source that threw
            // are both **no answer**, and neither is a statement about the game
            // window. Checked before `window` is read, or a worker fault is
            // logged as "the game is not running" and nothing says otherwise.
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
                // Too early, most likely: the game is still fading the screen
                // in. Look again while the key is held.
                this.scheduleConfirmRetry();
                return;
            }
            const match = reply.match;
            if (!match) return;
            this.lastTiming = reply.timings || {enumerate: 0, capture: 0, gate: 0, total: this.now() - started};
            // One last look before drawing: a key-up can have been processed
            // while the reply was in flight.
            if (stale()) { this.counters.stale++; return; }
            if (!match.accepted) {
                // A Tab screen whose map is not recognised: nothing is drawn
                // and the corner minimap stays the fallback, which is exactly
                // what the polling path does too.
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

    /** A confirmation that arrived while a capture was in flight. */
    drainQueuedConfirm() {
        if (!this.confirmQueued) return;
        this.confirmQueued = false;
        if (!this.isActive() || this.settled() || !this.keyStillDown()) return;
        this.confirmNow();
    }

    /* ── The periodic check ──────────────────────────────────────────────── */

    /**
     * "Is the Tab screen still up?", as cheaply as it can be asked.
     *
     * One window enumeration (0.2 ms), one capture (~17 ms of *async native*
     * work that does not block the event loop), one `toRaw` (~2.5 ms, same),
     * and the gate read off the two gate regions of that buffer — 1.4 ms of
     * blocking JS, no allocation. Deliberately **not** `matchMap`: identifying
     * the map again would cost 16-22 ms of blocking JS per tick and would
     * answer a question nobody asked, since the map cannot change while one Tab
     * press is held.
     *
     * Its *cadence* is what the two methods differ in:
     *   - `polling` (150 ms) — this loop **is** how the markers come down.
     *   - `key` (500 ms) — the key-up edge normally takes them down within
     *     30 ms, and this is the net under a key-up this process never saw: a
     *     suspended process, a remote-desktop session that resets the keyboard
     *     state, a driver that leaves the physical key stuck. There is always a
     *     check running, however cheap the trigger is.
     */
    async check() {
        this.timer = null;
        if (this.busy) {
            // A capture is still in flight (a slow one, or the confirming one a
            // key-down asked for). Come back rather than returning: returning
            // would drop the chain, and this loop is the safety net that has to
            // keep running whatever else is happening.
            if (this.state.showing) this.schedule(this.checkMs());
            return;
        }
        if (!this.isActive()) {
            // Auto-detect stopped, or the mode was switched off, between two
            // ticks. Hiding here rather than returning early is what makes the
            // markers go away instead of sitting there until something else
            // happens to notice.
            this.dispatch({type: 'lost', reason: 'inactive'});
            return;
        }
        if (!this.wanted()) {
            // The markers master switch (the hotkey, or Settings) went off.
            this.dispatch({type: 'lost', reason: 'markers-off'});
            return;
        }
        if (!this.state.showing) return;
        this.busy = true;
        // Same staleness rule as `confirm()`, in the other direction: a slow
        // capture whose *negative* gate lands after a fresh show would take
        // markers down that a newer answer had just put up.
        const epoch = this.epoch;
        const started = this.now();
        try {
            // Capture and gate only — no luminance, no NCC. The cheapest thing
            // the frame source can be asked for, and it happens off this
            // thread.
            // The markers are on screen while this runs, so the deadline is the
            // cadence itself: an answer that has not come by the time the next
            // check is due is no answer, and no answer means take them down.
            const reply = await this.grabWithin(this.detector.grabGate(), this.checkMs());
            if (!this.isActive() || !this.state.showing || this.epoch !== epoch) {
                if (this.epoch !== epoch) this.counters.stale++;
                return;
            }
            // No answer at all — the loop was stopped, the worker is
            // restarting, the request timed out, or the frame source threw.
            // Over live gameplay that means take the markers down, and it is
            // checked before `window` so that a fault is logged as a fault
            // rather than as "the game is not running".
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
                // The panel square is a fraction of the window, so a window
                // that moved has its markers in the wrong place. Down they go
                // until the next positive check re-places them.
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
            // A capture that threw is not a negative gate — it is no answer at
            // all, and "no answer" over live gameplay means take them down.
            this.logState('capture failed: ' + ((err && err.message) || String(err)));
            this.dispatch({type: 'lost', reason: 'capture-error'});
        } finally {
            this.busy = false;
            this.drainQueuedConfirm();
        }
    }

    /* ── Geometry and payload ────────────────────────────────────────────── */

    /**
     * Remember the rect the markers are placed against, and check it is the
     * rectangle the capture actually came from.
     *
     * The marker positions are fractions of the **captured frame**, and the
     * window is placed at the **window rect**. For a borderless window those
     * are the same rectangle; for a window with a border and a title bar they
     * are not, and every marker would sit offset by exactly that much.
     *
     * It used to log the difference and draw anyway. It now refuses: "nearly
     * right" over the game's own map is worse than nothing, because the player
     * cannot tell it is wrong. Compensating would mean deriving the client area
     * from numbers this app does not have, which would be a guess.
     *
     * @returns {boolean} false when the markers must not be drawn
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

    /**
     * A game-window rect in physical pixels → Electron window bounds in DIPs.
     *
     * The two `screen` reads are here; the arithmetic is the pure, tested
     * `gameRectToDip`. `dipToScreenRect(null, …)` is Electron's own per-display
     * conversion, so a mixed-DPI desktop is handled by the platform rather than
     * by an assumption about how Windows lays one out.
     *
     * @param {?{x, y, width, height}} rect
     * @returns {?{x, y, width, height}}
     */
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
     * The marker payload for one map, or null when it cannot be drawn.
     *
     * Null means "no Tab transform for this map", "no marker data", "markers
     * off" or "every layer off" — and in every one of those cases the corner
     * minimap stays the fallback and this window draws nothing. A wrong overlay
     * on the game's own map would be worse than no overlay.
     *
     * @param {string} key
     * @returns {?{layers: Array, legend: boolean, opacity: number, lang: string}}
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
            // The optimistic show: whether it is allowed, whether what is on
            // screen right now is a guess, which map has earned the fast path
            // and how long a guess may live.
            instant: this.instantWanted(),
            provisionalShowing: this.state.provisional,
            confirmedKey: this.state.confirmedKey,
            provisionalMs: this.provisionalMs,
            // Which of the two methods is in use, and why — the first thing to
            // read when the feature "behaves differently on my PC".
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
            // How many answers arrived after the markers had already come down
            // — the race F1 was about. A steady trickle is normal (a quick tap
            // always produces one); a flood means something is much slower than
            // it should be.
            stale: this.counters.stale,
            retries: this.counters.retries,
            // How many shows were optimistic, and how many of those the screen
            // never agreed with. A steady trickle of `unconfirmed` is the
            // player pressing the key where the map does not open (chat, the
            // pause menu); a number close to `provisional` means the gamble is
            // not paying off on this machine and the switch should go off.
            provisional: this.counters.provisional,
            unconfirmed: this.counters.unconfirmed,
            lastTiming: this.lastTiming,
            trigger: this.trigger.status()
        };
    }
}

module.exports = TabMode;
