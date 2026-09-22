# Markers and Tab-map mode

[← AGENTS.md](../../AGENTS.md) · **Read before** touching `src/core/map-markers.js`,
`src/shared/marker-rules.js`, `marker-geometry.js`, `src/map/markers.js`,
`src/core/tab-mode.js`, `tab-overlay-window.js`, `src/map/tab-renderer.js`,
`src/core/key-trigger.js`, `src/shared/key-codes.js`, `src/core/pad-input.js`,
`src/shared/pad-codes.js`, `src/shared/tab-mode-rules.js`,
`maps-src/markers.json` or `scripts/build-markers.js`.

Spec: `docs/SPEC-MARKERS.md`. The places the game **may** put a storm cellar, an
escape gate, a car or a gas can — a varying subset is active each match, which
is why every string says "possible location". Data provenance is in
`maps-src/markers.json` `_about`; the gas positions are u/deftyconchgaming's.

- **`baked` is the rule that keeps it honest.** On the four bundled images the
  author drew the cellar / gate / car rings into the PNG, so the corner minimap
  draws **gas only** there — drawing them again would double every ring. The
  game's own Tab map has none of them, so all four are drawn there. The data
  says *where a layer already exists* rather than removing it, and a pack built
  from a clean image simply omits `baked` and gets all four in both places.
  Optional and defaulting to "nothing", which is what makes it backwards
  compatible with a `markers.json` published before it existed.
- **One shape, one validator, one channel.** The shipped file is in the *pack*
  format, so `shared/map-pack-rules.js` `validateMarkers` checks a bundled map
  and a pack map alike, and `get-map-markers` answers for both with a pack
  winning on a shared key. The authoring file spells the Tab transform
  `{ax, bx, ay, by}`; `scripts/build-markers.js` converts it to the pack's
  `{sx, tx, sy, ty}` **once, at build time** — one spelling at runtime.
- **It lives under `src/`, not in `maps/`.** `maps/`'s *listing* is the
  catalogue, so a stray `.json` there is a file `buildCatalog` would have to
  learn to ignore; a `require`d JSON under `src/` is packaged with no
  `build.files` entry of its own, exactly like `templates.json`.
- **Markers ride on the `map-change` payload**, never a channel of their own —
  the same rule as the map name, for the same reason: the overlay must never be
  able to draw one map's cellars over another map's image. The OBS window gets
  the same payload and the same module (`src/map/markers.js`).
- **SVG in rendered-pixel space.** An image-space `viewBox` would multiply the
  stroke widths by the CSS scale and undo the sizing curve; a canvas would be
  re-rasterised on every size change and blurry at any non-1 scale. The curve
  itself is `sqrt(extent / 250)`, clamped, so a marker is legible at 150 px and
  not huge at 800 — a fixed proportion is 13 px at 150 and 72 px at 800. Gas
  cans are the same brackets **rotated 45° and scaled 0.78**, so the one layer
  that is nowhere on the bundled images is also the one that does not read as a
  ring. The brackets are **hollow** so the game's own discovered-exit icon shows
  through ours, and each sits over a dark halo because the game draws the Tab
  map pale for civilians and dark blue for Michael. The layer colours are
  deliberately *not* `app.css` design tokens: they have to read against grass,
  asphalt and both of those renderings, not against this app's surfaces.
- **Layer decisions live in `shared/marker-rules.js`.** A layer is off only on
  an explicit `false`, so a settings file written before markers existed behaves
  like the shipped defaults (the same rule `hideInMenu` uses). A layer with no
  points is dropped rather than shown as an empty legend chip. `tabLayers`
  **clips** a point the per-map affine fit puts outside the panel rather than
  clamping it — a clamped point would land on the game's own objectives or
  player list — and none of the four bundled maps produces one.
- **`tabHidesMinimap`** (off by default) suppresses the corner overlay while
  Tab-map mode runs. Since 1.0 it is not a switch of its own: with `tabMarkers`
  it forms the one "where do you want to see the map?" choice — `tab` is the
  pair on, `both` is `tabMarkers` alone (`shared/map-placement.js`,
  docs/agents/settings-and-onboarding.md). Tied to `enabled`, never to the setting alone: if the mode
  cannot run — auto-detect off, the markers master switch off — the corner
  minimap is the only map the player has and it must come back.
- **Tab-map mode is experimental and off by default** (`tabMarkers`), and it
  **requires auto-detect** — the map is only known because the detector
  recognised it, so choosing either of the two game's-map placements switches
  auto-detect on and locks it there (`autoDetectSwitchState`), and the mode
  stops when the detector stops. The second window
  follows `overlay-window.js`'s rules exactly, and here they matter more:
  `hotkeysGameOnly` means a window of ours that steals the foreground
  unregisters the player's hotkeys mid-match. **`showInactive()` / `hide()`**,
  never `show()` — Electron 40's typings say `show()` "Shows and gives focus",
  `showInactive()` "Shows the window but doesn't focus on it". (It used to hide
  by collapsing to 0x0 and claimed parity with the corner overlay; the corner
  overlay never resizes to hide, so that mechanism was exercised nowhere.) The
  renderer's `tab-hide` stays the fast path, the window hide is the
  authoritative one, and `render-process-gone` hides *and* tells `TabMode`.
  **The game has no exclusive-fullscreen mode**, so there is no such caveat;
  what does stop it is a window with a border and a title bar, where the
  capture is not the window rectangle and every marker would sit offset — then
  nothing is drawn and Settings says why. A `webContents.send` before the page's
  handlers exist is simply lost and `loadFile` is asynchronous, so the window
  holds the last payload and flushes it on `did-finish-load` — but only while
  `bounds` is still set, or a first load that finishes after the Tab screen is
  gone would draw exactly the lingering this feature must not do.
- **`Settings.onChange(keys)`** is how the markers master switch (only
  Ctrl+Alt+M since 1.0) and the layer chips reach main: the renderer writes them
  through the generic
  `set-setting` (Ctrl+Alt+M included), so nothing used to tell Tab mode. The
  master switch now starts and stops it, a layer or opacity change mid-hold
  rebuilds the live payload, and an empty payload hides immediately.
- **Nothing is ever shown on a guess.** Only after the detector accepted a map
  *on a frame that passed the Tab gate*. A gate pass alone says "a Tab screen",
  not "this map".
- **The fast check is `captureImage()` → `toRaw()` → `tabGateFromRaw`**, which
  reads only the two gate regions (21.9 % of the frame) straight off the RGBA
  bytes: measured **1.40 ms** of blocking JS, allocating nothing on the JS heap.
  A test asserts it gives the same verdict as `TAB_SCREEN_GATE` on every
  fixture. `node-screenshots` **cannot capture less than a whole window** —
  `Image.crop` runs after the grab, and cropping first was measured as a net
  loss (3.6 ms of crop to save 1.9 ms of copy). Since 0.7 that 1.40 ms is not
  main's either: this mode does **not** own a capture, it asks the detector
  (`detector.grabGate()` / `grabMatch()`), which asks the frame source, which
  normally lives in the detector's `utilityProcess`. One capture path, one
  process, one set of privacy rules — see [detection.md](detection.md).
  Deliberately **not** `matchMap`: identifying the map again would cost 16–22 ms
  of blocking JS a tick and answer a question nobody asked, because the map
  cannot change while one press is held.
- **Every cadence and deadline is measured, not chosen** — the numbers, what
  each one bounds and the values that were tried and rejected are in
  [Measured constants](#measured-constants) below, which is the **only** place
  they are written down. `setTimeout` chaining, never `setInterval`; the idle
  2 s cadence is untouched.
- **One negative gate hides** (`HIDE_AFTER_NEGATIVE = 1`): a false negative
  barely exists, a false positive is brackets over live gameplay. When in
  doubt, hide. Also hidden at once by: a window that moved, minimised or
  vanished, an empty or failed capture, a tick that threw, the main menu, the
  markers master switch, quit and update.
- **The scheduler is a pure reducer** (`reduceTabMode`) and takes **hint**
  events alongside timer ticks: `down` asks for an immediate check and can
  never show anything on a map the screen has not been read on — the screen
  gate stays the only thing that puts markers up in the first place — and `up`
  hides at once.
- **The optimistic show** (`tabMarkersInstant`, on by default,
  `docs/SPEC-MARKERS.md` §5.5b). The game fades its own Tab map in and the gate
  correctly refuses the whole fade, which is why a confirmed show was always a
  third of a second late. From the *second* press of a match the markers go up
  on the key edge, **provisionally**, and fade in over 300 ms with an ease-in
  curve; the confirming capture runs in parallel exactly as before. The timings
  are in [Measured constants](#measured-constants). Things not to undo:
  - **`confirmedKey` is what arms it**, after the *first* confirmed press —
    `TabMode.confirm()` goes straight to `detector.grabMatch()` and never
    updates the detector's `lastDetected`, so requiring the detector to agree
    would delay the fast path by an arbitrary number of presses. `lastDetected`
    is a **veto** instead: a *different* map forgets and refuses, `null` means
    nothing. What bounds the stale-memory hazard is `CONFIRMED_MEMORY_MS`,
    refreshed by every confirmation (pure `confirmedMemoryFresh`).
  - **A negative gate must not hide a provisional show — and must not
    `invalidate()` either.** The gate is *expected* to be negative during the
    fade; `PROVISIONAL_DEADLINE_MS` is what bounds it instead. This was a real
    bug:
    `invalidates` was decided *before* the reduce, so a negative gate (the
    detector's own tick sends them, and so does `check()`) cancelled the
    deadline, the retry chain and the confirming capture while the reducer kept
    `showing/provisional` — markers for the whole hold, or for ever on a missed
    key-up. It is now decided **after** the reduce, and the `fading` reason is
    the one that does not invalidate. End of `dispatch` has a belt-and-braces
    check: still `provisional` with no deadline armed → hide `unconfirmed`.
  - **The deadline is a plain `setTimeout` of this mode's own**, not a reply to
    anything: that is what stops a dead or wedged worker holding a guess up.
    Injectable (`deps.provisionalMs`) so the tests do not wait it out per case.
    When it fires with the key still down it restarts the ordinary slow path
    for that press, or a genuine slow press reads as show/hide/re-show.
  - **A confirmation for the same map re-sends nothing** — re-placing the same
    payload restarts the CSS transition and flickers at the exact moment the
    app became sure. Only a provisional show carries `fade: true`, which is
    also why `onSettingsChanged` skips the live re-place while provisional (an
    *empty* payload still hides at once).
  - **An unconfirmed deadline forgets the memory**, and so does *any* hide that
    ends a still-provisional show (`MEMORY_KEEPING_HIDE_REASONS` is `key-up`
    and `released`, and they only apply to a confirmed show) — so a player
    pressing the key in chat, or tapping it repeatedly, flashes **once**.
  - **A loss that means the match itself is over forgets the memory even with
    nothing on screen** (`MATCH_OVER_REASONS`: the menu, a window that is
    absent, gone or minimised, the mode no longer able to run) — the main menu
    is recognised long after the player stopped pressing the key. A window that
    moved, a capture that failed or a frame that never came are faults *inside*
    a match: they hide, and the reducer's own rule decides the memory.
    `noteKnownMap` and `expireConfirmed` run on the key-down edge as a **state**
    test, not as edges — an edge already consumed cannot be consulted again, and
    this has to be right on every press. `confirmedMemoryFresh` answers *no* to
    a clock that went backwards (a time change, a suspend/resume) rather than
    "infinitely fresh".
  - `schedule()` clears only the check timer now: a provisional show needs the
    safety loop *and* the confirm retries running side by side, and
    `scheduleConfirmRetry`/`drainQueuedConfirm` test `settled()` rather than
    `showing`.
## The key-state trigger

`core/key-trigger.js` is what produces the scheduler's key **hints**, and it is
the preferred method. koffi → `user32` `GetAsyncKeyState(vk)` for **one** key,
the `tabMarkerKey` setting (default Tab, configurable because the game lets
players rebind it). Markers appear ~60 ms after the press instead of up to
~480 ms; the per-call costs and the poll interval are in
[Measured constants](#measured-constants).

  - **The loop runs only while the mode is on, the markers master switch is on,
    the game window exists and polling is not forced** — all four in
    `applyMethod()`, the single place that decides. Gating on "enabled" alone
    was a real bug: `onWindow(false)` is an *edge* that never fires if the
    window was absent all along, so turning the mode on with the game closed
    polled the key forever, contradicting the README.
  - **The foreground is read FIRST and no key is read unless the game is in
    front.** That ordering *is* the privacy promise — "only while you are in
    the game" has to be what the code does, not a property of how the answer is
    used later. It costs 302 ns to guard 28 ns, 0.001 % of a core at 30 ms, so
    there is no performance argument for reordering it either.
  - **Exactly two virtual keys are ever queried**: the map key, and `VK_MENU`
    **only while the map key reads down** (so Alt+Tab is not the player opening
    the map). Nothing about any key is logged but the edges of that one key
    (`tab-key state=… reason=…`, plus `source=pad` on a down edge that came
    from the controller — see [The controller button](#the-controller-button),
    the one other input read in this tick).
  - **Not** `globalShortcut`/`RegisterHotKey` — it *reserves* the combination,
    so the game would stop seeing its own map key, and there is no key-up at
    all. **Not** a keyboard hook (`SetWindowsHookEx`, `uiohook`) — that puts
    every keystroke on the machine through this process. **Not**
    `GetKeyboardState`, which returns all 256 keys at once.
  - **A press only ever buys a capture** (`TabMode.confirm()`: gate, then
    `matchMap`). Tab is pressed in menus, chat and lobbies; the picture still
    has to say "this map panel, this map". A press that is not the map screen
    stops at the gate and is **retried while the key is still held**
    (`CONFIRM_RETRY_DELAYS`; the schedule and the rejected one are in
    [Measured constants](#measured-constants)), because one attempt would leave
    the next chance to the 700 ms tick — *slower* than the 450 ms path the
    trigger replaced. A confirm that lands while another capture runs is
    queued, not dropped.
  - **An answer must not outlive its question**, and **this mode keeps
    capture deadlines of its own** — the two halves of the staleness machinery,
    written out with the races that produced them in
    [The reproduced races](#the-reproduced-races) below.
  - **"No frame this tick" is not a negative gate.** The frame source answers
    `aborted` when it could not ask at all (the loop was stopped, the worker is
    restarting, the request timed out) and `error` when the capture failed; both
    are checked **before** `window`, because a fault that arrives without a
    window otherwise reads as "the game is not running". A confirming press with
    no answer shows nothing; a safety check with no answer takes the markers
    down, which is the same rule as everywhere else here — when in doubt, hide.
  - **Every refusal resolves to "the key is not down"**, not to "ignore": Alt
    held, the game not in front, the trigger disabled — each *hides* if
    something was showing. `keyHintFor` is that pure decision.
  - **Foreground** comes from `GetForegroundWindow` + `GetWindowThreadProcessId`
    compared against the pid the **detector** already read (`gameWindowInfo()` /
    the `onWindow` edge; measured: `node-screenshots`' `pid()` and the pid
    Windows reports for the focused window agree) — never a second `Window.all()` near a 30 ms loop, and
    never the foreground watcher's ≤1 s-stale verdict. Read only while the key
    reads down, so an idle tick is one `GetAsyncKeyState`.
  - **With the trigger healthy the polling costs are dropped**: the detector
    stays at 700 ms (`detectIntervalFor`) and the periodic capture becomes a
    `SAFETY_INTERVAL` **safety** check rather than `FAST_INTERVAL` — the net
    under a key-up this process never saw (a suspended process, a remote session
    that resets the keyboard, a stuck physical key). There is always a
    capture-based check running.
  - **koffi is `require`d lazily, on the first `start()`**, and every step is
    wrapped with its own reason (`load`/`bind`/`probe`/`call`). Any failure →
    the polling path, one `app.log` warning, one `detector.log` line and **one**
    translated toast per session. `markerTrigger: 'polling'` is the user's
    escape hatch; there is deliberately no "off". The method in use is in
    Settings and in `system.txt`.
  - **Three method states, because two lied** (`resolveTriggerMethod`): `key`
    (running and reading the map key), `key-waiting` (the key method *is* the
    method; it is waiting for a game window and nothing is being read) and
    `polling` (forced by the user, or `load`/`bind`/`probe`/`call` failed). The
    first field run of a packaged build had the game closed and reported
    `method=polling reason=unavailable`, which Settings renders as "not
    available on this PC" — about a path that had never been tried. So
    availability is a separate question from whether the loop runs: `probe()`
    answers it whenever the key method is wanted, *including with the game
    closed*, and `KeyTrigger.status().available` stays **tri-state** (`null` =
    never probed), because flattening that into `false` is the same lie.
    **The probe reads no key**: `GetForegroundWindow()` takes no arguments and
    says nothing about the keyboard, and it exercises exactly what has to work
    (koffi loaded, `user32` bound, a `__stdcall` returns). `key-waiting` reports
    the *safety* cadence and no detector override, so no log line ever prints a
    number that is not in effect.
  - **The map key is a number, not an accelerator** (`shared/key-codes.js`).
    It uses **`KeyboardEvent.keyCode`**, which in Chromium on Windows *is* the
    Windows virtual-key code for the active layout. `code` is **not**
    positional-equivalent — `VK_A`..`VK_Z` and `VK_OEM_*` follow the layout, so
    AZERTY's physical `KeyQ` is `VK_A` and the Italian `ò` key (`code:
    Semicolon`) is `VK_OEM_3`, not `VK_OEM_1`. The *label* is stored separately
    (`tabMarkerKeyLabel`, from `KeyboardEvent.key`) because a VK cannot be
    named on a non-US layout. It never goes near
    `SYSTEM_HOTKEY_DEFS`, `hotkeys.json` or the conflict checks, and
    `isWatchableVk` refuses modifiers and mouse buttons — a mouse button cannot
    be recorded, but a hand-edited file could name one and `GetAsyncKeyState`
    would answer. The capture control records on the **button**, not on
    `document`, so it cannot fight `src/js/hotkeys.js`'s recording listener,
    and `preventDefault` stops Tab merely moving focus.
  - `asarUnpack` covers `node_modules/koffi/**/*.node` **and**
    `node_modules/@koromix/**/*.node`: the binary actually loaded is the
    prebuilt optional package `@koromix/koffi-win32-x64`, which is what makes
    this a no-compile dependency. `package-lock.json` carries every platform's,
    so `npm ci` on the runner needs nothing extra.

## The controller button

The map key's **second input** (1.1): `tabMarkerPad`, one XInput button read
by `core/pad-input.js` inside the key trigger's own tick. The spec owns the
design — `docs/SPEC-MARKERS.md` §5.7.1 — and this section keeps only what an
agent must not undo:

  - **It is the one binding in the app that may have two inputs**, and it
    exists because a pad player on the polling path waits ~480 ms for markers
    the keyboard player gets in ~60 ms. The owner rejected "make polling the
    controller path" on exactly that latency. Do not offer a pad binding for
    any hotkey: those go through `globalShortcut`, which has no controller.
  - **Read order is foreground → key → Alt → pad**, in `KeyTrigger.tick()`.
    The pad read is gated on the same foreground answer as the key, and
    `test/key-trigger.test.js` counts `XInputGetState` calls while the game is
    not in front (zero) and with no button configured (never opened).
  - **`foldMapInputs` is where the two become one.** Alt vetoes the keyboard
    press only; a pad press with Alt down is a press. Any read that answers
    `null` (a throw) is "not down".
  - **The pad's failure is the pad's alone.** `PadInput.fail()` marks it
    unusable and the tick skips it from then on; it never calls
    `giveUp()`, never triggers `fallBackToPolling`, never toasts. Settings
    appends `settings.tabMarkers.method.padUnavailable` when a set button
    has `pad.available === false`, and `system.txt` prints the reason. Keep
    those two apart from the key trigger's `available`.
  - **Anonymous koffi structs.** A named `koffi.struct('X', …)` is process-
    global and a second `open()` after a `bind` failure would throw on the
    redefinition. `sizeof` is 16, checked against real `xinput1_4.dll`.
  - **Slot policy** is "first connected pad, then that slot only". An empty
    slot costs ~15 µs on XInput 1.4, so the four-slot scan is rate-limited to
    `PAD_SCAN_INTERVAL` and never runs at the key cadence; the test asserts
    the call sequence `[0,1,2,3]` then `[2,2]`.
  - **Recording runs in main** (`record-tab-marker-pad`), because the
    renderer has no XInput and the Gamepad API needs a focused window with a
    gesture. It waits for exactly one held button; the renderer's recorder
    (`Options.attachMapPadRecorder`) is shared with the tutorial like the key
    recorder, cancels on blur/Esc/second click, and stores through
    `set-tab-marker-pad` so main validates the code.
  - **PlayStation pads are seen only through Steam or DS4Windows**, and the
    Steam virtual pad exists only while a Steam game is running — so every
    string that says "no controller found" says to open the game first. Do
    not "fix" that by reading HID: it was rejected as a broader read than
    the app should make. `scripts/probe-pad.js` is the plain-node check for
    a PC and its pad.

## Measured constants

**This section owns these numbers.** The code keeps one line per constant —
what it is and its unit — and points here; the measurement, the field-log
figures and the values that were tried and rejected live only here. Measured on
the dev machine in plain node against a real 1920x1032 window
(`node-screenshots` 0.2.8), 25–30 ticks each, unless a row says otherwise.

### Cadences and deadlines (`shared/tab-mode-rules.js`)

| Constant | Value | What it bounds | The measurement behind it |
|---|---|---|---|
| `FAST_INTERVAL` | 150 ms | the show/hide loop on the polling path, and therefore how long markers can outlive a release at one tick | the check is **1.40 ms** of blocking JS (0.9 % of one core at this interval) and **21.3 ms** wall — a seventh of the interval, so a slow capture can never queue ticks behind itself |
| `DETECT_INTERVAL` | 450 ms | the detector's cadence *only while this mode runs on the polling path*, i.e. how long markers take to **appear** | a full detector tick is 17.6 ms capture + 2.6 ms `toRaw` + 5.5 ms blocking JS = 26.8 ms wall. A 1 s press fits one tick at 700 ms and two at 450, so the worst case drops ~730 → ~480 ms, for 0.8 % → 1.2 % of a core |
| `HIDE_AFTER_NEGATIVE` | 1 | consecutive negative gates before the markers come down | the Tab gate separates 0.99 from 0.27–0.65 on the dark fraction and 0.09–0.11 from 0.000 on the name box (`matcher.js`), and the four killer-view reference frames *with the game's own discovered-exit icons on them* still pass at 0.986–0.995 / 0.084–0.115. A false negative costs one tick of missing markers the player has stopped looking at; a false positive costs 150 ms — at two, 300 ms — of brackets over live gameplay. **2 was rejected on that asymmetry.** Non-arithmetic failures (empty capture, vanished window) are `lost`, not a negative gate, so they do not depend on this number |
| `KEY_POLL_INTERVAL` | 30 ms | how often the map key's state is read while the trigger runs | one `GetAsyncKeyState` through koffi is **28 ns**, so this is 0.00009 % of one core — four orders of magnitude under the capture path it replaces. Checked end to end against a synthesised 400 ms press: the down edge was seen 15 ms late and the up edge 8 ms late, so a realistic 1–3 s hold cannot be missed. **Not lower**: a 1 ms timer in an Electron main process costs more in timer bookkeeping than the call it would make |
| `PAD_SCAN_INTERVAL` | 1000 ms | how often the four XInput slots are scanned while **no** controller is connected (with one connected, its slot alone is read every `KEY_POLL_INTERVAL`) | `XInputGetState` on an empty slot is **~15 µs** on `xinput1_4.dll` (200-call average, dev machine), so a scan is 60 µs; at the key cadence it would be 0.2 % of a core for a pad that is not there, at 1 s it is 0.006 %. A pad plugged in is noticed within a second, which is far under the time it takes to reach the game's map screen |
| `PAD_RECORD_TIMEOUT` | 10 s | how long *Choose button…* waits for one held controller button | long enough to pick the pad up and find the button, short enough that a pad that is not there (a PlayStation pad with no Steam game open) answers *no controller* rather than a hung button |
| `SAFETY_INTERVAL` | 500 ms | the periodic capture once the trigger is healthy, and `confirm()`'s own grab deadline | the trigger normally gets there first (within 30 ms), so this costs 1.4 ms of blocking JS twice a second — 0.3 % of one core — and bounds a key-up this process never saw at half a second instead of a whole match. 150 ms would be the polling figure and is pure cost here |
| `CONFIRM_RETRY_DELAYS` | 50 ms × 5, then 100 ms | retries of the confirming capture while the key is still held | each delay plus the ~45 ms a capture takes puts the looks at roughly 0 / 95 / 190 / 285 / 380 / 475 ms. **60 / 90 / 150 was the first schedule and was rejected**: the owner's field log (39 presses) showed the game's fade takes **250–330 ms**, so the first two looks always came too early and the third sat right on the edge — markers appeared 320–530 ms after the press, median 353. Evenly spaced looks catch the first frame that passes instead of the first one the schedule happens to land on |
| `PROVISIONAL_DEADLINE_MS` | 550 ms | how long markers may stay up with **no** capture having confirmed them | the same field log has confirmations as late as **530 ms**, and the last retry is answered at ~520 ms, so **450 was rejected** — it cut the slowest genuine presses off just before the screen proved them right, a *show, hide, re-show*. 550 is still about half a second, so a press in chat or the pause menu, where nothing will ever confirm, is a flash rather than a display; with the ease-in fade its first ~100 ms are all but invisible |
| `CONFIRMED_MEMORY_MS` | 5 min | the age of a "a press was confirmed on this map" memory | far longer than a match's worth of presses — a player reads the map every few seconds — so it never costs anything during play, and it bounds the one hazard nothing else covers: a match that ends and another that begins on a *different* map with no main menu recognised and no window change, which `lastDetected` can name the old map right through. Not a heartbeat: every confirmation refreshes it |
| `STATE_LOG_INTERVAL` | 30 s | how often a *repeating* condition (no game window, a capture that keeps failing) may reach `detector.log` | show/hide decisions are logged on the edge, so they are already one line per transition and are not throttled |

The renderer's optimistic fade is **300 ms** with an ease-in curve
(`.is-fading` in `src/map/tab.html`), chosen to sit inside the game's own
250–330 ms fade so the markers arrive with the map rather than before it.

### Marker geometry (`shared/marker-geometry.js`)

Everything scales with `sqrt(extent / REFERENCE_EXTENT)`, so doubling the map
grows a marker ~1.41x while halving its share of the map. The two obvious rules
were both rejected: a fixed **proportion** of the map (e.g. 9 %) is 13 px across
at a 150 px overlay and 72 px at 800 — three markers would swallow a street —
while a fixed **pixel** size disappears at 800 and covers half the map at 150.

| Constant | Value | What it is |
|---|---|---|
| `REFERENCE_EXTENT` | 250 | the overlay width the numbers were drawn for (the shipped default, where the approved mock-up was made) |
| `REFERENCE_HALF` | 11.25 | half the side of the square the four brackets sit on, at the reference extent |
| `REFERENCE_STROKE` | 1.6 | bracket stroke at the reference extent |
| `ARM_RATIO` | 0.42 | how far each L runs along its side, as a fraction of `half` |
| `MIN`/`MAX_EXTENT` | 50 / 1600 | keeps the curve inside the range it was fitted on |
| `MIN`/`MAX_HALF`, `MIN`/`MAX_STROKE` | 5 / 26, 1 / 3.2 | so a hand-edited `size` cannot produce a hairline or a blob |
| `GAS_SCALE`, `GAS_ROTATION` | 0.78, 45° | the gas variant. Smaller *because* it is rotated: a diamond's corners reach further than a square's for the same half-extent |

The overlay's own range is `SIZE_MIN`/`SIZE_MAX` (50–800 px) in
`shared/hotkeys-constants.js`; on the in-game Tab map the extent is the panel's
own side, ~786 px at 1080p. One rule, two surfaces.

## The reproduced races

**This section owns the long form**; the enforcing lines in
`core/tab-mode.js` carry a two-line statement of the rule and point here. Every
one of these was reproduced, not imagined, and all of them are the same failure:
*markers left over live gameplay*.

- **An answer must not outlive its question.** A capture is ~27 ms of wall clock
  — since 0.7 a round trip to the worker, which is *more* elapsed time, not less
  — and the player can let go inside it. `TabMode` therefore keeps an **epoch**,
  bumped by `invalidate()` on every hide *and* every
  `lost`/`stop`/key-up/negative gate **even with nothing on screen**, which
  `confirm()` and `check()` re-check after **every** `await`; plus
  **`lastHideAt`** for detector results, which cannot know our epoch but do
  carry the `startedAt` of their tick. In the key method a `match` is also
  refused unless the key is *still down*. The two races: a quick tap
  (`down 104 · up 167 · show 188 · hide 772` — half a second of brackets over
  gameplay, because the key-up landed mid-capture, the hide was a no-op since
  nothing was showing yet, and then the capture resolved and showed), and a
  detector tick already in flight at the release (~4 % of them).
  `status().stale` counts the refusals.
- **A dead or slow frame source must not hold markers up** (`grabWithin`). The
  frame source has a timeout, but it is the *source's*, and it is generous to a
  child that is still booting — right for a 700 ms detection loop, wrong for
  brackets drawn over live gameplay. So the safety check is bounded by its own
  cadence and the confirming press by `SAFETY_INTERVAL`; past that the answer is
  "no frame", which hides. Reproduced at **3.4 s** of markers over gameplay
  without it: a worker that died mid-hold, a missed key-up, and a replacement
  that would not boot. The trade-off is deliberate — a frame source slower than
  the cadence costs a flicker, since the next positive check re-shows, while one
  that never answers used to cost seconds of wrong information.
- **`invalidate()` is decided *after* the reduce.** It used to be decided
  before, which was right while every negative gate hid — but a negative gate
  during a provisional show is the game's own fade and deliberately hides
  *nothing*, so invalidating there cancelled the deadline, the retry chain and
  the confirming capture in flight while the reducer kept `showing/provisional`:
  markers for the whole hold, or for ever on a missed key-up. The question is
  now "did this event actually take the markers down", and `fading` is the one
  reason that means "no, on purpose".
- **The end-of-`dispatch` guard.** *A provisional state must always have
  something that will end it.* Reaching the end of `dispatch` still provisional
  with no deadline armed means some path cancelled the timer without taking the
  markers down — which is exactly what the bug above did — so the safe answer is
  to hide (`tab-deadline-lost`, then `lost reason=unconfirmed`), not to hope. It
  costs one comparison per dispatch and it is the last thing standing between a
  bug here and brackets over live gameplay.
- **"No frame this tick" is not a negative gate**, and a dead renderer is not a
  hidden window: `tab-overlay-window.js` `hide()`s on `render-process-gone` and
  calls `onRendererGone`, because forgetting `bounds` alone used to leave the
  last painted frame on an always-on-top window while `TabMode` still believed
  the markers were fine.

## DPI

The physical-pixel → DIP conversion Tab mode needs is written out in
[overlay-windows.md](overlay-windows.md).

## What is logged

- `system.txt` gains a `[markers]` section (every switch, which maps carry
  data, Tab mode's state, cadences, counters and last timings, plus the
  optimistic show's setting, deadline and provisional/unconfirmed counts);
  `detector.log` gains `tab-mode-start`/`-stop`, `tab-show` (with
  `provisional=yes|no`), `tab-confirmed` (`ms=` since the key went down),
  `tab-forget`, `tab-hide` (with a reason, `unconfirmed` among them) and
  `tab-size-mismatch` — edges only, decisions only, no pixels.

See also: [detection.md](detection.md) (the gate, the matcher and the cadence
this mode borrows), [overlay-windows.md](overlay-windows.md) (window
construction and the `map-change` payload), [map-packs.md](map-packs.md) (a
pack's `markers.json`, same validator) and
[maps-authoring.md](maps-authoring.md) (authoring marker data).
