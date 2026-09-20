# Markers and Tab-map mode

[← AGENTS.md](../../AGENTS.md) · **Read before** touching `src/core/map-markers.js`,
`src/shared/marker-rules.js`, `marker-geometry.js`, `src/map/markers.js`,
`src/core/tab-mode.js`, `tab-overlay-window.js`, `src/map/tab-renderer.js`,
`src/core/key-trigger.js`, `src/shared/key-codes.js`,
`src/shared/tab-mode-rules.js`, `maps-src/markers.json` or
`scripts/build-markers.js`.

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
  not huge at 800 — a fixed proportion is 13 px at 150 and 72 px at 800.
- **Tab-map mode is experimental and off by default** (`tabMarkers`), and it
  **requires auto-detect** — the map is only known because the detector
  recognised it, so the switch is disabled with the reason on screen while
  auto-detect is off, and it stops when the detector stops. The second window
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
  nothing is drawn and Settings says why.
- **`Settings.onChange(keys)`** is how the markers master switch and the layer
  switches reach main: the renderer writes them through the generic
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
- **Cadences, measured**: fast **150 ms** while shown (0.9 % of one core, and
  a seventh of the interval, so ticks cannot queue); the detector's **700 → 450
  ms** *only while this mode runs* (1 s of Tab fits one tick at 700 and two at
  450, so worst-case appearance drops ~730 → ~480 ms, for 0.8 % → 1.2 % of a
  core); idle 2 s untouched. `setTimeout` chaining, never `setInterval`.
- **One negative gate hides** (`HIDE_AFTER_NEGATIVE = 1`). The gate separates
  0.99 from 0.27–0.65 and 0.09–0.11 from 0.000, and the four killer-view
  reference frames *with the game's own discovered-exit icons on them* pass at
  0.986–0.995 / 0.084–0.115, so a false negative barely exists — while a false
  *positive* is 150 ms (or, at two, 300 ms) of brackets over live gameplay.
  When in doubt, hide. Also hidden at once by: a window that moved, minimised
  or vanished, an empty or failed capture, a tick that threw, the main menu,
  the markers master switch, quit and update.
- **The scheduler is a pure reducer** (`reduceTabMode`) and takes **hint**
  events alongside timer ticks: `down` asks for an immediate check and can
  never show anything on a map the screen has not been read on — the screen
  gate stays the only thing that puts markers up in the first place — and `up`
  hides at once.
- **The optimistic show** (`tabMarkersInstant`, on by default,
  `docs/SPEC-MARKERS.md` §5.5b). The game fades its own Tab map in over
  **250–330 ms** and the gate correctly refuses the whole fade, which is why
  the field log measured markers at 320–530 ms after the press (median 353).
  From the *second* press of a match the markers go up on the key edge,
  **provisionally**, and fade in over 300 ms with an ease-in curve; the
  confirming capture runs in parallel exactly as before. Things not to undo:
  - **`confirmedKey` is what arms it**, after the *first* confirmed press —
    `TabMode.confirm()` goes straight to `detector.grabMatch()` and never
    updates the detector's `lastDetected`, so requiring the detector to agree
    would delay the fast path by an arbitrary number of presses. `lastDetected`
    is a **veto** instead: a *different* map forgets and refuses, `null` means
    nothing. What bounds the stale-memory hazard is `CONFIRMED_MEMORY_MS`
    (5 min, refreshed by every confirmation, pure `confirmedMemoryFresh`).
  - **A negative gate must not hide a provisional show — and must not
    `invalidate()` either.** The gate is *expected* to be negative during the
    fade; the 550 ms deadline is what bounds it instead. This was a real bug:
    `invalidates` was decided *before* the reduce, so a negative gate (the
    detector's own tick sends them, and so does `check()`) cancelled the
    deadline, the retry chain and the confirming capture while the reducer kept
    `showing/provisional` — markers for the whole hold, or for ever on a missed
    key-up. It is now decided **after** the reduce, and the `fading` reason is
    the one that does not invalidate. End of `dispatch` has a belt-and-braces
    check: still `provisional` with no deadline armed → hide `unconfirmed`.
  - **The deadline is a plain `setTimeout` of this mode's own**, not a reply to
    anything: that is what stops a dead or wedged worker holding a guess up.
    Injectable (`deps.provisionalMs`) so the tests do not wait 550 ms a case.
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
  - `schedule()` clears only the check timer now: a provisional show needs the
    safety loop *and* the confirm retries running side by side, and
    `scheduleConfirmRetry`/`drainQueuedConfirm` test `settled()` rather than
    `showing`.
- **The key-state trigger** (`core/key-trigger.js`) is what produces those
  hints, and it is the preferred method. koffi → `user32`
  `GetAsyncKeyState(vk)` for **one** key, the `tabMarkerKey` setting (default
  Tab, configurable because the game lets players rebind it). Measured: **28 ns
  per call** (0.00009 % of one core at 30 ms), `require('koffi')` 7.7 ms once,
  and a synthesised 400 ms press was seen down +15 ms / up +8 ms. Markers
  appear ~60 ms after the press instead of up to ~480 ms.
  - **The loop runs only while the mode is on, the markers master switch is on,
    the game window exists and polling is not forced** — all four in
    `applyMethod()`, the single place that decides. Gating on "enabled" alone
    was a real bug: `onWindow(false)` is an *edge* that never fires if the
    window was absent all along, so turning the mode on with the game closed
    polled the key forever, contradicting the README.
  - **The foreground is read FIRST and no key is read unless the game is in
    front.** That ordering *is* the privacy promise — "only while you are in
    the game" has to be what the code does, not a property of how the answer is
    used later. 302 ns guarding 28 ns, i.e. 0.001 % of a core at 30 ms.
  - **Exactly two virtual keys are ever queried**: the map key, and `VK_MENU`
    **only while the map key reads down** (so Alt+Tab is not the player opening
    the map). Nothing about any key is logged but the edges of that one key
    (`tab-key state=… reason=…`).
  - **Not** `globalShortcut`/`RegisterHotKey` — it *reserves* the combination,
    so the game would stop seeing its own map key, and there is no key-up at
    all. **Not** a keyboard hook (`SetWindowsHookEx`, `uiohook`) — that puts
    every keystroke on the machine through this process. **Not**
    `GetKeyboardState`, which returns all 256 keys at once.
  - **A press only ever buys a capture** (`TabMode.confirm()`: gate, then
    `matchMap`). Tab is pressed in menus, chat and lobbies; the picture still
    has to say "this map panel, this map". A press that is not the map screen
    stops at the gate after 1.4 ms — and is **retried at +60/+90/+150 ms while
    the key is still held**, because the game fades the screen in and one
    attempt left the next chance to the 700 ms tick, i.e. *slower* than the
    450 ms path the trigger replaced. A confirm that lands while another
    capture runs is queued, not dropped.
  - **An answer must not outlive its question.** A capture is ~27 ms of wall
    clock — since 0.7 a round trip to the worker, which is *more* elapsed time,
    not less — and the player can let go inside it, so `TabMode` keeps an
    **epoch** (bumped by
    `invalidate()` on every hide *and* every `lost`/`stop`/key-up/negative
    gate, even with nothing on screen) which `confirm()`/`check()` re-check
    after **every** `await`, plus **`lastHideAt`** for detector results, which
    carry the `startedAt` of their tick. In the key method a `match` is also
    refused unless the key is *still down*. Two reproduced races: a quick tap
    (`down 104 · up 167 · show 188 · hide 772` — half a second of brackets over
    gameplay) and a detector tick already in flight at the release (~4 % of
    them). `status().stale` counts the refusals.
  - **This mode keeps a deadline of its own** (`grabWithin`). The frame source
    has a timeout, but it is the *source's*, and it is generous to a child that
    is still booting — right for a 700 ms detection loop, wrong for brackets
    drawn over live gameplay. The safety check is therefore bounded by its own
    cadence (500 ms with the trigger, 150 ms on the polling path) and the
    confirming press by the 500 ms safety interval; past that the answer is "no
    frame", which hides. Reproduced at **3.4 s** of markers over gameplay
    without it: a worker that died mid-hold, a missed key-up, and a replacement
    that would not boot. The trade-off is deliberate — a frame source slower
    than the cadence costs a flicker (the next positive check re-shows), a frame
    source that never answers used to cost seconds of wrong information.
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
    (302 ns) compared against the pid the **detector** already read
    (`gameWindowInfo()` / the `onWindow` edge) — never a second `Window.all()`
    near a 30 ms loop, and never the foreground watcher's ≤1 s-stale verdict.
    Read only while the key reads down, so an idle tick is one 28 ns call.
  - **With the trigger healthy the polling costs are dropped**: the detector
    stays at 700 ms (`detectIntervalFor`) and the periodic capture becomes a
    500 ms **safety** check rather than 150 ms — the net under a key-up this
    process never saw (a suspended process, a remote session that resets the
    keyboard, a stuck physical key). There is always a capture-based check
    running.
  - **koffi is `require`d lazily, on the first `start()`**, and every step is
    wrapped with its own reason (`load`/`bind`/`probe`/`call`). Any failure →
    the polling path, one `app.log` warning, one `detector.log` line and **one**
    translated toast per session. `markerTrigger: 'polling'` is the user's
    escape hatch; there is deliberately no "off". The method in use is in
    Settings and in `system.txt`.
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
