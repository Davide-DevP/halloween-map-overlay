# SPEC — Map markers and Tab-map mode

Where a storm cellar, an escape gate, a car or a gas can **may** appear, drawn
over the corner overlay and — experimentally — over the game's own Tab map.

Status: implemented (0.7 batch). Code:
`src/shared/marker-rules.js`, `src/shared/marker-geometry.js`,
`src/shared/tab-mode-rules.js` (all pure),
`src/core/map-markers.js`, `src/core/tab-mode.js`,
`src/core/tab-overlay-window.js`, `src/map/markers.js`,
`src/map/tab.html` + `tab-renderer.js`, `scripts/build-markers.js`.
Tests: `test/marker-rules.test.js`, `test/marker-geometry.test.js`,
`test/tab-mode-rules.test.js`, `test/tab-gate.test.js`.

---

## 1. What a marker is, and is not

Every point is a **possible** location: the game activates a varying subset
each match. Nothing in the app ever claims otherwise — the legend says
"possible location", the legend's second line says a different subset is active
each match, and the README repeats it.

Provenance is in `maps-src/markers.json` `_about`, and the scripts that
produced it are in `maps-src/marker-tools/`:

- `cellar` / `gate` / `car` — extracted by Hough circle detection from the
  rings **already drawn on** u/deftyconchgaming's map images.
- `gas` — traced from the same author's separate gas-spawn maps
  (`maps-src/gas-spawns.json`). Credit: u/deftyconchgaming.
- `tab` — an affine fit registering the community map's boundary silhouette
  against the game's own Tab panel, IoU 0.96–0.98, cross-checked against real
  discovered exits in `maps-src/tab-reference/` to 3–5 px on a 762 px panel.

## 2. `baked` — the rings that are already there

On the four bundled images the author drew the cellar / gate / car rings into
the PNG. Drawing them again on the corner minimap would **double every one of
them**, which is the single most visible way this feature could look broken. The
game's own Tab map has none of them.

So the data says *where a layer already exists* rather than removing it:

```json
{"layers": {…}, "baked": ["cellar", "gate", "car"], "tab": {"sx": …, "tx": …, "sy": …, "ty": …}}
```

- corner minimap → `baked` layers are skipped. On a bundled map that leaves
  **gas only**.
- in-game Tab map → nothing is baked, so **all four** are drawn.
- a pack built from a clean image simply omits `baked` and gets all four in
  both places, with no code change.

`baked` is optional and defaults to "nothing", which is what makes adding it
backwards compatible: a `markers.json` published before it existed still
validates and still means the same thing.

## 3. Where the data lives

| file | what |
|---|---|
| `maps-src/markers.json` | the **authoring** format: `tab: {ax, bx, ay, by}`, `imageSize`, `iou`, `_about` |
| `src/core/map-markers/markers.json` | the **runtime** file, generated and committed |
| a pack's `markers.json` | the same runtime format, one map (`docs/SPEC-MAP-PACKS.md` §2) |

`npm run build-markers` converts the first into the second; `--check` compares
without writing and `test/marker-rules.test.js` asserts the two agree, so a
position cannot drift from what the marker tools measured. Two things change on
the way across and nothing else: the Tab transform is respelled
`{sx, tx, sy, ty}` (**one** spelling at runtime), and `baked` is added.

It lives under `src/`, not in `maps/`: `maps/` is an `extraResources` directory
whose *listing* is the catalogue, so a stray `.json` there is a file
`buildCatalog` would have to learn to ignore. A `require`d JSON under `src/` is
packaged by `build.files` with no entry of its own — the same way
`map-detector/templates.json` already ships.

**One validator for both**: `shared/map-pack-rules.js` `validateMarkers`. The
bundled file's entries are validated once at load (`core/map-markers.js`), and a
bad entry is dropped with a log line rather than reaching the renderer.

**One channel for both**: `get-map-markers`. A pack's markers override the
bundled ones for the same key, exactly as its image and its templates do.

## 4. The look — approved variant B

Four reticle corner brackets per marker, `dist/marker-variants/variant-B-brackets.png`.

| layer | colour | shape |
|---|---|---|
| cellar | `#e0605a` | brackets |
| gate | `#4fc58a` | brackets |
| car | `#5fb4ea` | brackets |
| gas | `#f0cf55` | brackets rotated 45°, ×0.78 |

**Hollow on purpose.** On the Tab map the game draws its own icon on an exit the
player has discovered, and it has to show *through* ours.

**SVG, not canvas**, and the viewBox is in **rendered** pixels rather than the
image's own coordinates: a canvas would be re-rasterised on every size change
and blurry at any non-1 scale, and an image-space viewBox would multiply the
stroke widths by the CSS scale and undo the sizing curve below.

**The sizing curve** (`shared/marker-geometry.js`): everything scales with
`sqrt(extent / 250)`, anchored on the default 250 px overlay and clamped at both
ends. A fixed *proportion* is 13 px across at 150 px and 72 px at 800 px — three
markers would swallow a street; a fixed *pixel* size disappears at 800 and
covers half the map at 150. The same function serves the Tab panel, where the
extent is the panel's own side (~786 px at 1080p).

| overlay size | half-extent | stroke |
|---|---|---|
| 150 px | 8.7 px | 1.24 px |
| 250 px | 11.25 px | 1.6 px |
| 800 px | 20.1 px | 2.86 px |

The OBS window draws the **same payload** with the same module, so a stream
shows what the player sees. The OBS object leaves out only what the overlay
window itself needs — `opacity`, `draggable`, `rotation` (the OBS window has no
rotation) — and never carries the settings preview.

Markers ride on the existing `map-change` payload, never on a channel of their
own — the same rule the map name follows, for the same reason: the overlay must
never be able to draw one map's cellars over another map's image.

## 5. Tab-map mode (experimental, `tabMarkers`, default false)

While the player **holds** Tab the game shows a big fixed map with the player's
own arrow on it; the corner minimap has no player position, so drawing the
markers onto the game's map is strictly more useful. A second transparent,
click-through, non-focusable, always-on-top window is laid over the **game
window's** rectangle and the brackets are placed by `TAB_PANEL_REL` × the map's
`tab` transform. The legend goes in the empty lower-left of the game's own
Objectives panel (`TAB_LEGEND_REL`, relative to the frame like every other
region).

### 5.1 The window

Identical construction rules to `overlay-window.js`, and here they matter more:
`hotkeysGameOnly` (default on) registers the global shortcuts only while the
game is in front, so a window of ours that steals the foreground would
unregister the player's hotkeys mid-match. `focusable: false`,
`skipTaskbar: true`, `setIgnoreMouseEvents(true)` **without** `forward: true`,
`alwaysOnTop` at `pop-up-menu` re-asserted every second, and **never**
`show()`n or `focus()`ed. Created lazily, on the first start of the mode, and
`close()` marks it gone **for good** so a late `set-tab-markers` or a detector
restart during quit cannot rebuild it while the installer is taking over.

**Hiding is `hide()`, showing is `showInactive()`.** Electron 40's own typings
are explicit: `show()` "Shows and gives focus to the window", `showInactive()`
"Shows the window but doesn't focus on it". An earlier version hid by
collapsing the window to 0x0 and claimed that was parity with the corner
overlay — it was not: `overlay-window.js` never resizes to hide, its *renderer*
sets the image width to zero. So the real mechanism (`setBounds` on a frameless
`resizable: false` window) was documented as proven and was in fact exercised
nowhere. The `tab-hide` message to the renderer remains the **fast** path; the
window hide is the **authoritative** one, and it is what still works when the
renderer is slow or hung. `render-process-gone` hides the window too and tells
`TabMode`, which used to go on believing the markers were fine while a dead
renderer's last frame sat over the game.

**The game window must be a plain borderless window.** The markers are placed
against the window rectangle while their positions are fractions of the
*captured frame*; for a window with a border and a title bar those differ and
every marker would sit offset by the border, so `noteRect` refuses to draw and
Settings says why. Compensating would mean deriving the client area from
numbers this app does not have, i.e. guessing. (The game has no
exclusive-fullscreen mode at all, so the caveat this section used to carry was
about a state that cannot occur.)

### 5.2 DPI

`node-screenshots` reports a window rectangle in **physical** pixels; Electron
places a window in **DIPs**. On a single 100 % display those are the same
numbers, which is why this is easy to get wrong and only ever seen by somebody
with a second or a scaled monitor. `core/tab-mode.js` reads each display's DIP
`bounds` **and** its physical rectangle (`screen.dipToScreenRect`), and the
pure, tested `gameRectToDip` picks the display and does the arithmetic —
100 % / 125 % / 150 %, side by side, negative coordinates included. Both edges
are rounded rather than the origin and the size, or a 125 % display leaves a
one-pixel strip of game uncovered.

### 5.3 Latency, measured

`node-screenshots` **cannot capture less than a whole window**: `Image.crop`
exists but runs on the image the grab already produced. Measured on the dev
machine in plain node against a real 1920x1032 window, 25–30 ticks each:

| tick | capture (async native) | `toRaw` | blocking JS | wall |
|---|---|---|---|---|
| today's full detector tick | 17.6 ms | 2.6 ms | 5.5 ms | 26.8 ms |
| `toGrayScaled(640)` + gate | 17.3 ms | 2.5 ms | 5.5 ms | 25.9 ms |
| crop to the gate box first | 17.8 ms | +3.6 ms crop | 0.7 ms | 1.34 ms | 23.4 ms |
| **gate off the raw buffer** | 17.4 ms | 2.5 ms | **1.40 ms** | **21.3 ms** |
| …its early-out (left panel only) | — | — | 1.34 ms | — |

So the fast check is `captureImage()` → `toRaw()` → `tabGateFromRaw`, which
reads only the two gate regions (21.9 % of the frame) straight off the RGBA
bytes and allocates **nothing** on the JS heap (heapUsed flat at 3.58 MB over
60 ticks). Cropping first is a net loss — 3.6 ms of native crop to save 1.9 ms
of copy — and it buys no blocking JS either, because the gate reads the same
number of source pixels whichever buffer they are in.

`tabGateFromRaw` is asserted to give the **same verdict** as
`TAB_SCREEN_GATE` on every committed fixture, and `rawRegionFraction` to agree
with `tabScreenFeatures` to 1e-9.

Native RGBA churn is the one real cost: `toRaw` of a 1080p window is ~8 MB per
tick and V8 reclaims external memory lazily (measured: `external` 25 → 70 MB
over 60 ticks, settling on the next collection). At 150 ms that is ~53 MB/s of
native allocation while the Tab screen is up, i.e. for one or two seconds per
match. The existing detector already pays the same per tick at 700 ms.

### 5.4 Cadences

- `FAST_INTERVAL` **150 ms** while the markers are shown: 1.40 ms of blocking
  JS every 150 ms is **0.9 % of one core**, and the 21.3 ms wall time is a
  seventh of the interval, so a slow capture can never queue ticks.
- `DETECT_INTERVAL` **450 ms**, replacing the detector's 700 ms **only while
  this mode is running**: 700 ms is what decides how long markers take to
  *appear*, and a 1 s Tab press fits one tick at 700 ms and two at 450 ms —
  worst-case appearance latency drops from ~730 ms to ~480 ms. It costs
  5.5 ms/700 ms (0.8 % of a core) → 5.5 ms/450 ms (1.2 %). The idle cadence
  (2 s, no capture at all) is untouched.
- `HIDE_AFTER_NEGATIVE` **1**. The argument for 2 is a false negative on a real
  Tab screen; measured, that barely exists — the gate separates 0.99 from
  0.27–0.65 on the dark fraction and 0.09–0.11 from 0.000 on the name box, and
  the four killer-view reference frames *with the game's own discovered-exit
  icons on them* pass at 0.986–0.995 / 0.084–0.115. The costs are asymmetric:
  hiding one tick early costs 150 ms of missing markers the player has just
  stopped looking at; hiding one tick late costs 150 ms of brackets painted
  over the game they *are* looking at, and at 2 that becomes 300 ms. When in
  doubt, hide.

### 5.5 The scheduler

A pure reducer, `reduceTabMode(state, event)` → `{state, effects}`
(`shared/tab-mode-rules.js`). `setTimeout` chaining, never `setInterval`;
`busy` so a slow capture cannot queue ticks.

| event | effect |
|---|---|
| `match` (drawable) | show, start the fast loop |
| `match` (not drawable) | **hide** — one map's markers must never sit on another map |
| `gate` up | keep up, check again in `FAST_INTERVAL` |
| `gate` down | hide (after `HIDE_AFTER_NEGATIVE`) |
| `lost` | hide at once |
| `stop` | hide, stay down |
| `hint` `down` | ask for a capture; *or*, when `shouldShowProvisionally` said yes, show provisionally too (§5.5b) |
| `hint` `up` | hide at once |

**Nothing is ever shown for a map the screen has not been read on.** The
markers go up only after a map has been accepted *on a frame that passed the
Tab gate*; a gate pass alone says "a Tab screen", not "this map", and with
nothing shown the fast loop is not even scheduled. The optimistic show (§5.5b)
is an exception to the *waiting*, not to that rule: it needs a press on that
very map to have been confirmed by the gate already, it is drawn provisionally,
and it is taken down again within 550 ms unless the gate confirms it too.

### 5.5a Staleness — an answer must not outlive the question

A capture takes ~27 ms and the player can release the key inside it. Two races
were reproduced:

- **the quick tap** — key-down starts the confirming capture, key-up lands
  while it is still running (so the hide is a *no-op*, nothing is showing yet),
  the capture resolves and shows. Only the periodic check removed them, ~500 ms
  later. Field log: `down 104 ms · up 167 ms · tab-show 188 ms · tab-hide 772 ms`.
- **the detector tick in flight** — the player releases, the markers come down,
  and then a tick that began *before* the release reports a match with no
  key-down behind it at all (~4 % of releases).

Both are fixed by one idea with two faces:

- **an epoch**, bumped by `invalidate()` on every hide *and* on every
  `lost`/`stop`/key-up/negative gate — even when nothing was on screen to hide,
  which is exactly the quick-tap case. `confirm()` and `check()` remember it
  when they start and drop their result after **every** `await` if it moved.
  The same guard stops a slow *negative* gate hiding a fresh show.
- **`lastHideAt`**, for results from the **detector**, which cannot know the
  epoch but does know when its tick began: `onMatch` takes that `startedAt` and
  refuses anything older than the last hide.

On top of that, in the key method a `match` is refused unless the key is *still
down* (`keyStillDown()`), re-checked after every await. `status().stale` counts
the refusals — a trickle is normal (a quick tap always produces one), a flood
means captures are far slower than they should be.

`test/tab-mode.test.js` drives these interleavings against injected doubles (a
detector whose capture resolves when the test says so, a fake trigger, a fake
window, a controlled clock). Neutralising either guard makes three of those
tests fail, which is how they were checked.

### 5.5b The optimistic show (`tabMarkersInstant`, default **true**)

The owner's field log — 39 presses of a packaged build — measured the markers
appearing **320–530 ms** after the key went down, median **353**. That is not
the app being slow: the game *fades its own map in over 250–330 ms*, and the
Tab gate correctly says "not the map screen" for the whole of that fade. The
confirming retries (`CONFIRM_RETRY_DELAYS`, §5.7) got the app to answer on the
first frame that passes; they cannot make the frame arrive sooner.

So, from the **second** press of a match onwards, the markers go up on the
key-down edge, in a **provisional** state, and fade in over 300 ms with an
ease-in curve — i.e. alongside the game's own fade. The confirming capture runs
in parallel, unchanged.

Four conditions, all in the pure `shouldShowProvisionally`:

1. the **key trigger** is the method in use (the polling path has no edge to be
   early about) and the game is the foreground window — already guaranteed by
   `keyHintFor` and the trigger's ordering, and asserted here anyway;
2. **a press has been confirmed on this same map, recently.**
   `TabMode.confirmedKey` is the answer — a Tab press that the *screen gate*
   accepted — and it arms after the **first** confirmed press of a match,
   whoever produced it. The detector's `lastDetected` is a **veto**, not a
   requirement: when it names a *different* map the memory is stale and is
   dropped, and `null` is simply the detector having nothing to say
   (`confirm()` asks `detector.grabMatch()` directly and never writes
   `lastDetected`, so requiring it would delay the fast path by an arbitrary
   number of presses for no gain);
3. `buildPayload` gives something to draw for that map;
4. the game window's rectangle converts to valid, unclamped bounds.

Outcomes:

- **confirmed** (`match` for the same key) — the state becomes certain and
  **nothing is re-sent**: re-placing the same payload would restart the fade
  from zero, a flicker at the exact moment the app became sure. A match for a
  *different* key replaces the payload without a fade. `tab-confirmed ms=…`.
- **key-up, `lost`, `stop`, any existing hide reason** — instant, exactly as
  before, and the deadline is cancelled with them.
- **nothing within `PROVISIONAL_DEADLINE_MS` = 550 ms** — hidden
  (`tab-hide reason=unconfirmed`) *and* the memory is forgotten, so the next
  press is the slow, certain one again. That is what makes a player pressing
  the key where the map does not open (the chat, the pause menu, the end
  screen) flash **at most once**. If the key is **still held**, the ordinary
  slow path is started again for that same press (fresh `confirmAttempts`, one
  `confirmNow()`), so a genuine press merely slower than the deadline ends in
  markers rather than in *show, hide, re-show when the detector next ticks*.
- **a negative gate before the deadline does not hide, and does not invalidate
  either.** The gate is *expected* to be negative during the game's fade — that
  is the whole point. The `invalidates` decision is therefore taken **after**
  the reduce and asks "did this event actually take the markers down": a
  negative gate that answered `fading` must not cancel the deadline, the
  retries or the confirming capture, because that combination left the guess on
  screen for the rest of the hold. After confirmation `HIDE_AFTER_NEGATIVE`
  applies unchanged.

The invariant is untouched: **markers may never linger over gameplay.** A
provisional show is bounded by a `setTimeout` of this mode's own, which does
not depend on the frame source answering — a worker that has died, is
restarting or never replies cannot hold a guess on screen — *plus* every
existing hide path, *plus* a belt-and-braces check at the end of every
`dispatch`: a state that is still `provisional` with no deadline armed hides
itself with `unconfirmed`. 550 ms clears the measured fade (330 ms) and a
confirmation that really happens (the owner's log has one at 530 ms; the
attempts land at ~0/95/190/285/380/475 ms), and it is still about half a
second, which is the whole price of a wrong guess. The ease-in curve is the
other half of that price: at 100 ms the markers are ~6 % opaque, so most of a
flash is never seen.

`MEMORY_KEEPING_HIDE_REASONS` is the allow-list — only `key-up` and `released`
keep the memory, and **only when the show they ended had been confirmed**. A
hide that ends a still-*provisional* show forgets whatever the reason, because
the press it ended proved nothing: a tap shorter than the game's own fade
releases the key before any capture can answer, and keeping the memory there
would let every tap in a chat window flash. Everything else (a window that
moved, a failed capture, the menu, the game closing, a rebound key, an expired
deadline) forgets too, and buys the fast path back the moment one press is
confirmed again. The safe direction here is the slow path, because the slow
path cannot flash.

**The memory also ages out.** `CONFIRMED_MEMORY_MS` = 5 minutes, refreshed by
every confirmation (`confirmedMemoryFresh`, pure, with the caller's clock). It
never fires during play — a player reads the map every few seconds — and it
exists for the one case nothing else covers: a match that ends and another that
begins on a *different* map, without the main menu ever being recognised and
without the game window ever going away, where `confirmedKey` and
`lastDetected` can both still name the old one. The residual hazard is then a
single faded show of the wrong map for at most 550 ms, replaced by the right
payload the moment the capture answers.

Counters: `status().provisional` / `.unconfirmed`, printed in `system.txt`'s
`[markers]` section beside the setting and the deadline.

### 5.6 Everything that takes the markers down

Auto-detect stopping · the game window disappearing, minimising, **moving or
resizing** (the panel is a fraction of the window, so a window that moved has
its markers in the wrong place) · an empty or failed capture · a detector tick
that threw · main-menu detection · a dead Tab-window renderer · a window
rectangle that had to be clamped to its display · a capture that is not the
window rectangle · the markers master switch **or any layer switch**
(`Settings.onChange`, §6) · the mode's own switch · quit and update
(`runShutdownHooks`, `before-quit`, before the detector — it is the second
always-on-top window).

**It requires auto-detect**: the switch is disabled with the reason on screen
while auto-detect is off, because the map is only known because the detector
recognised it. If the map is not recognised, or has no `tab` transform, or has
no marker data, nothing is drawn and the corner minimap remains the fallback.

### 5.7 The key-state trigger

Implemented. `src/core/key-trigger.js` + the pure `keyHintFor`,
`resolveTriggerMethod`, `checkInterval` and `detectIntervalFor`.

While — and only while — Tab-map mode is running, the app asks Windows whether
**one** key is held: the game's map key (`tabMarkerKey`, default Tab,
configurable because the game lets players rebind it). Key-down asks for one
confirming capture; key-up hides at once.

| | key trigger | polling (the fallback) |
|---|---|---|
| notices the Tab screen | 30 ms key poll + one capture | the detector's own tick |
| appears after | ~30 ms + ~27 ms confirm ≈ **60 ms** | up to ~480 ms |
| hides after | ~30 ms (the up edge) | up to 150 ms |
| periodic capture while shown | 500 ms safety net | **150 ms** (it *is* the mechanism) |
| detector cadence | 700 ms (unchanged) | 450 ms |

#### What is read, and what is not

`GetAsyncKeyState(vk)` answers one question about one virtual-key code. It is
not a hook, it receives nothing, it cannot see characters and it cannot
enumerate the keyboard.

**The foreground is read first, and no key is read unless the game is the
window in front.** That ordering is the difference between "the app reads a key
while the game is running" and "the app asks about one key only while you are
in the game", and the second is what the README, the FAQ and the help text say
— so it has to be what the code does, not a property of how the answer is used
later. It costs 302 ns to guard 28 ns, which at 30 ms is 0.001 % of one core.

Then, and only then, **two** codes are ever queried:

- the map key;
- `VK_MENU` (either Alt), and **only while the map key reads as down**, so
  Alt+Tab is not mistaken for the player opening the map.

**The loop itself runs only while the mode is on, the markers master switch is
on, the game window exists and the user has not forced polling** — all four
checked in `applyMethod()`, which is the single place that decides. It used to
gate on "enabled" alone, and `onWindow(false)` is an *edge* that never fires if
the window was absent all along: turning the mode on with the game closed
polled the key forever, contradicting the README.

Deliberately not used: `globalShortcut` / `RegisterHotKey` (it *reserves* the
combination, so the game would stop seeing its own map key, and it has no
key-up at all — the half that matters most here); a keyboard hook
(`SetWindowsHookEx`, `uiohook`, `iohook`), which would put every keystroke on
the machine through this process; `GetKeyboardState`, which returns all 256
keys at once.

The map key is a **virtual-key code**, not an accelerator: it is a number, it
lives nowhere near `SYSTEM_HOTKEY_DEFS`, `hotkeys.json` or the conflict checks,
and `shared/key-codes.js` is its own small mapping.

**`KeyboardEvent.keyCode` is what it uses**, because in Chromium on Windows
that *is* the Windows virtual-key code for the active layout, produced from the
same `WM_KEYDOWN` the game receives. An earlier version preferred
`KeyboardEvent.code` on the theory that virtual-key codes are positional —
**they are not**: `VK_A`..`VK_Z` and the `VK_OEM_*` codes follow the layout, so
on AZERTY the physical `KeyQ` reports `VK_A` and on the Italian layout (the
owner's) the key `code` calls `Semicolon` is `ò` and reports `VK_OEM_3` (0xC0),
not `VK_OEM_1` (0xBA). `code`/`key` remain only as a fallback for a browser
that reports no `keyCode`. The **label** comes from `KeyboardEvent.key` and is
stored beside the code (`tabMarkerKeyLabel`), because only the browser knows
what the active layout calls that key; `vkLabel` is the fallback for an upgrade
or a hand-edited file and is correct only on a US keyboard.

Modifiers and mouse buttons are refused — a mouse button cannot even be
recorded (no `KeyboardEvent`), but a hand-edited file could name one and
`GetAsyncKeyState` would answer, so `isWatchableVk` refuses it at load.

The only thing about a key that ever reaches a log is the **edge of that one
key**: `tab-key state=down|up reason=…` in `detector.log`.

#### Measured (plain node, dev machine)

```
require('koffi')                           7.7 ms   once, lazily
koffi.load('user32.dll') + 3 func binds    0.19 ms  once
GetAsyncKeyState                             28 ns/call
GetForegroundWindow + …ThreadProcessId      302 ns/call
```

At the 30 ms poll one `GetAsyncKeyState` is **0.00009 % of one core**; the
foreground pair would be 0.001 % even if it ran every tick. Verified end to end
against a synthesised 400 ms Tab press: the down edge was seen 15 ms late and
the up edge 8 ms late, and 194 idle ticks cost a worst single tick of 0.54 ms
(timer noise, not the call). Heap flat.

#### 5.7.1 The controller button (1.1; one path since 2026-09-23)

Implemented. `src/core/pad-window.js` + `src/map/pad.html` / `pad-renderer.js`,
the pure `shared/pad-codes.js` and `foldMapInputs`. The map key gets **one
optional second input**: a controller button (`tabMarkerPad`, default `null` =
none), read through **Chromium's Gamepad API** in a hidden window — the only
input in the app that may have two bindings, and the second one is *only* for
players on a pad. A pad player gets the same ~60 ms path as a keyboard player;
the polling fallback (~480 ms) was rejected for them as "waiting for the
markers".

**History.** 1.1 read the button through koffi → `XInputGetState` inside the
key trigger's tick. The first field test (a DualShock 4 player, 1.1.0–1.1.2)
showed a PlayStation pad through Steam Input never becomes an XInput device for
Halloween — `joy.cpl` with the game open listed only the physical Xbox pad —
so 1.2 added the Gamepad API window as a second path. On 2026-09-23 the owner
retired XInput: the Gamepad API reads Xbox pads as well, and keeping two paths
cost ~1150 lines for one button.

**What is read.** Chromium reads every pad it knows — DualShock 4, DualSense,
Xbox, generic — through Raw Input with `RIDEV_INPUTSINK`, i.e. without focus,
and the "user gesture" it wants before exposing gamepads is a button press *on
the pad*, not on the page. The window is built only while a button is set (or
being chosen) and closed again otherwise, with `backgroundThrottling: false`
because Chromium samples gamepads only for a visible page and Electron reports
a hidden window's page as hidden unless throttling is off (the one deviation
from `shared/web-preferences.js`'s default; `docs/agents/memory.md`). The
renderer polls `navigator.getGamepads()` at `KEY_POLL_INTERVAL` **only while
main says so** (`pad-watch {on, code}`: trigger running, button set, game
in front — sent on the foreground *edge* from `KeyTrigger.noteForeground`) and
sends **edges** of the one button (`pad-edge`), never a reading. Main folds
that level into the key trigger's tick (`KeyTrigger.setApiPadDown`), where it
counts only while the game is the foreground window. With no button set the
controller is never read and the window does not exist.

**Which controller: every one.** *Choose button…* answers with the button
alone (`pad-recorded {code}`) and the watch reads that button on **every
connected pad** (`mapButtonDown` over `navigator.getGamepads()`). 1.3.0–1.3.2
remembered the pad pressed on by its `Gamepad.id` (`tabMarkerPadId`) and, with
two or more pads, read only that one; a field case retired it after 1.3.2 — a
DualSense connected over Bluetooth *and* USB is two pads to Chromium, and a game
launched from Steam Big Picture adds Steam's virtual Xbox pad while Steam takes
the physical one, so the remembered pad was the silent one. The stale key is
still redacted in older files (`docs/agents/diagnostics.md`) and read by
nothing. The reasoning and the field numbers:
`docs/agents/markers-and-tab-mode.md` § The controller button.

**View is the touchpad.** The game's map button is View on an Xbox pad and the
touchpad click on a PlayStation pad, so the app offers them as **one** button,
*View / Touchpad*: index 17 is an alias of 8 (`MAP_BUTTON_ALIASES`) — chosen as
either face, stored as 8 (a 1.3.x file holding 17 resolves to 8), read as both
(`watchCodes`). A player who chose the touchpad on a DualSense and later plays
on an Xbox pad, or through Steam's virtual Xbox pad, does not choose again.

**Either input held is "down"** (`foldMapInputs`): a key released while the
button is still held is not an edge, and vice versa. **Alt vetoes only the
keyboard** — Alt+Tab is a keyboard gesture, and a pad button held while Alt
happens to be down is still the player opening the map.

**The pad's failure is its own.** If the hidden window cannot be built
(`PadWindow.failed`), the keyboard half carries on untouched, nothing falls
back to polling, Settings appends *"The controller button cannot be used …"*
and `system.txt` says the window could not be created.

**Recording** (*Choose button…*) is the one time the pad is read outside the
game: for at most `PAD_RECORD_TIMEOUT` (15 s) the renderer waits for **exactly
one** held button (two at once is a hand on its way somewhere) and main answers
the Settings renderer `{ok, code, label}` — never the id; `no-controller`,
`timeout`, `unavailable` and `cancelled`/`replaced` are the refusals, each
with its own toast, and the outcome (reason and a pad count — never a button or
a pad) goes to `app.log`. Esc or a second click cancels through
`cancel-tab-marker-pad`; **losing focus does not**, so a player can Alt+Tab to
the game and press there (1.1.2's reason for this — that Steam's virtual pad
comes and goes with the foreground — turned out wrong, but the no-blur cancel
and the 15 s cost nothing). `set-tab-marker-pad` validates the code in main
like `set-tab-marker-key`.

A stored code is the **standard-mapping index** (0 = A/✕ … 8 = View, which
is also the touchpad, 17); 1.1.x's stored bits are migrated (`LEGACY_PAD_BITS`).
**Labels** name both faces — `A / ✕`, `View / Touchpad`, `LB / L1` — because
the standard mapping cannot say which pad is plugged in. The Guide button is
not offered: it is the platform overlay's key.
Labels are never translated (they name physical buttons); only *None* is.

Reading raw HID reports in main was rejected as a far broader statement about
what the app reads, and it would have re-implemented Chromium's mappings. The
hidden window's memory cost has not been measured.

#### "Is the game in front?"

Read with `GetForegroundWindow` + `GetWindowThreadProcessId` and compared
against the game's pid — which comes from the **detector's own** window read
(`MapDetector.gameWindowInfo()` / the `onWindow` edge), so there is no second
`Window.all()` enumeration anywhere near the 30 ms loop. Measured: the pid
Windows reports for the focused window and `node-screenshots`' `pid()` agree.

Chosen over the foreground watcher's last verdict because that verdict is up to
1 s stale and refreshing it costs an enumeration — exactly what must not happen
every 30 ms. And read only when it can matter (the key reads as down), so an
idle tick is a single 28 ns call.

#### Why a press can never show markers by itself

Tab is pressed in menus, in chat, in the lobby, and to move focus in every
window on the machine. So a `down` edge causes exactly one thing:
`TabMode.confirm()` — one capture, the raw-buffer gate, and (only if that
passes) `matchMap` to identify the map. It costs what one ordinary detector tick
costs, against a 450 ms poll that pays it whether anything was pressed or not. A
press that is not the map screen stops at the gate after 1.4 ms of blocking JS.

**Retried while the key is still held**, at `CONFIRM_RETRY_DELAYS` =
`[50, 50, 50, 50, 50, 100]` ms, each counted from the end of the previous
attempt (the pure `confirmRetryDelay`); the first schedule, +60 / +90 / +150 ms,
was superseded after the 0.7.0 field log showed the game's fade takes
250–330 ms — see `docs/agents/markers-and-tab-mode.md` § Measured constants. The game fades its Tab
screen in, so the capture on the down edge can genuinely be too early; with one
attempt and no retry the next chance was the detector's 700 ms tick, which is
**slower than the polling path's 450 ms** — the trigger would have made the
feature worse in exactly the case it was added for. A confirmation that arrives
while another capture is in flight is **queued**, not dropped (`confirmQueued`),
because a press that silently did nothing is indistinguishable from a broken
feature.

`keyHintFor` is the pure reading→hint decision, and all three of its refusals
resolve to *"the key is not down"* rather than to "ignore this": Alt held, the
game not in front, and the trigger disabled all **hide** if something was
showing. The safe direction is always to take the markers away.

#### The safety check survives the trigger

At 500 ms rather than 150. The up edge normally gets there within 30 ms, so
this is the net under a key-up this process never saw: a suspended process, a
remote-desktop session that resets the keyboard state, a driver leaving the
physical key stuck. There is always a capture-based check running, however
cheap the trigger is.

#### Three states, because two lied

The first field run of a packaged build had the game **closed**, and logged

```
tab-mode-start method=polling reason=unavailable keyMs=30 checkMs=150 detectMs=450 vk=9
```

with no `tab-key-trigger` line at all. Every one of those is wrong: nothing had
been probed (so "unavailable" was a claim about something never tried), the
polling cadences were reported although the key method would be used the moment
the game started, and koffi had never been loaded — which meant the antivirus
test the run was for exercised nothing.

The cause was one conflation: since the "do not poll without a game window" fix,
the trigger is only *started* when a game window exists, and `methodInfo()`
computed availability as `running && usable`. "Does the native path work?" and
"is it polling right now?" are different questions.

So `resolveTriggerMethod` returns one of **three** states:

| state | when | Settings says |
|---|---|---|
| `key` | the trigger is running | "Using your map key (Tab) — …" |
| `key-waiting` | usable *or not yet probed*, no game window (`no-game`) or momentarily not polling (`idle`) | "Ready — your map key (Tab) will be used as soon as the game is running. Nothing is being read in the meantime." |
| `polling` | `forced`, or a probe that really failed (`load`/`bind`/`probe`/`call`) | "…because you asked for it" / "…not available on this PC" |

`available === false` — never `!available` — so "not probed yet" is not
"broken". `checkInterval('key-waiting')` is the **safety** cadence and
`detectIntervalFor` returns **null**: with no game window there is nothing to
capture, and claiming a 450 ms override in that state is the same class of lie.
The `tab-mode-start` line prints every cadence field, with **`0`** for one that
is not in effect (`keyMs=0` on the polling path, `detectMs=0` with no faster
detection), plus `game=yes|no` and, since 1.1, `pad=yes|no`.

#### The probe reads no key

`KeyTrigger.open()` (called `probe()` until the 2026-09-23 refactor; the log
field and the failure reason are still `probe`) loads koffi, binds `user32` and
makes **one**
`GetForegroundWindow()` call — no arguments, a window handle back, nothing about
the keyboard. It runs whenever the key method is wanted, **including with the
game closed**, so availability is known from the first run, appears in Settings
and is logged once as `tab-key-trigger available=yes where=probe`. It does
**not** start the poll and does **not** call `GetAsyncKeyState`; verified in
plain node by counting the bound calls (`probe-check.js`: exactly
`["GetForegroundWindow"]`, poll not running, a second `open()` cached at zero calls).

It used to probe with `GetAsyncKeyState`, which meant "is the native path
available?" could not be answered without reading a key — and the help text
promises keys are read only while the game is in front. Hence the change of
call, not just of timing.

The user-facing wording was corrected to match: switching the mode on "checks
once that Windows lets it ask at all — that check reads no key". The welcome
tour's sentence (`onboarding.detect.tab.privacy`) is about *keys* only and
stays true unchanged.

#### Failure is automatic and visible

koffi is `require`d **lazily**, on the first `start()`, so a user who never
turns the mode on never loads a native FFI module. Every step is wrapped and
each failure has its own reason: `load` (package missing or blocked), `bind`
(`user32` or a symbol), `probe` (the first call throws), `call` (it starts
failing later — Bitdefender has killed unsigned processes on the owner's machine
before, see `docs/agents/updater-and-installer.md`). Any of them → the polling path, one `app.log` warning,
one `detector.log` line, and **one** translated toast per session
(`tabMarkers.fallback`). The notice belongs to a probe that **failed**, never to
a game that is merely not running yet — that distinction is the whole point of
`key-waiting`. `markerTrigger: 'polling'` is the user's own escape hatch, and
there is deliberately no "off": the mode always has a way to work.

Which method is in use appears in Settings under the switch and in `system.txt`
(`tab mode method = key (key)` / `polling (load)` / `polling (forced)`) together
with the trigger's counters and error count.

## 6. Settings, hotkey, diagnostics

Settings › Overlay gains two groups: **Markers** (master switch, four per-layer
switches, legend switch, opacity 0.1–1.0) and **Markers on the in-game map
(experimental)**. *(1.0 rebuilt that UI: the Map tab has one choice — "where do
you want to see the map?" — over `tabMarkers`+`tabHidesMinimap`, the four
layers and the legend are chips, the master switch is only reachable through
Ctrl+Alt+M, and the two long help texts moved into the FAQ. Every setting and
every IPC handler below is unchanged. See
docs/agents/settings-and-onboarding.md.)* Every marker setting defaults to **on** and is read as
`!== false`, so a settings file written before markers existed behaves like the
shipped defaults; `tabMarkers` needs an explicit `true`.

`tabMarkers` has its **own** IPC handler (`set-tab-markers`) rather than going
through `set-setting`, for the same reason `mapDetection` and `hotkeysGameOnly`
do: main has to act on it — a window and a capture loop start or stop in the
same breath. So do `set-tab-marker-key` and `set-marker-trigger`.

**`Settings.onChange(keys)`** covers the ones that *cannot* have their own
handler because the renderer writes them through the generic `set-setting`:
`markers` (which Ctrl+Alt+M toggles), the four layer switches, `markerLegend`,
`markerOpacity` and `tabHidesMinimap`. `tabMarkersInstant` (§5.5b) goes through
the same generic setter but needs no reaction at all: main reads it on the next
key-down edge, and rebuilding the live payload for it would re-send one
mid-fade. Without it the master switch never started or stopped Tab
mode at all — starting with `markers: false` left it off and turning them back
on did not bring it back — and a layer switched off mid-hold stayed on screen
until the next periodic check, while an opacity change never reached the window
at all. `TabMode.onSettingsChanged` now syncs the mode, and rebuilds the live
payload in place (or hides, if there is nothing left to draw).

Tab-mode's group also holds **Game's map key** (a capture button, recorded on
the *button* rather than on `document` so it cannot fight `src/js/hotkeys.js`'s
recording listener, with `preventDefault` so pressing Tab does not just move
focus) and **Do not read the key state** — in 1.0 *Use the other method*, under
*Something not working?* — plus a line naming the method in use.
`set-tab-marker-key` and `set-marker-trigger` are their own IPC handlers for
the same reason as `set-tab-markers`: main re-points or stops a running trigger,
and it validates the virtual-key code the renderer sends — with
`nodeIntegration: true` the renderer is not a trust boundary, and
`GetAsyncKeyState` would answer for a mouse button. Since 1.1 the same group
holds **Controller button** (§5.7.1): `set-tab-marker-pad` (a code or `null`),
`record-tab-marker-pad` (main's hidden pad window waits for the press on any
pad) and `cancel-tab-marker-pad`. Both rows appear in Settings › Map
and in the setup tutorial's key step, through the same recorders.

System hotkey **Show / hide markers**, default `CommandOrControl+Alt+M`,
through `SYSTEM_HOTKEY_DEFS` like every other one (so the tables, the conflict
checks, unbinding and the reset all work unchanged). It has **no legacy
default**: the action did not exist in 0.6.0, so `planHotkeyDefaultsMigration`
skips it and `core/settings.js` back-fills the shipped default — the documented
behaviour for a new key, whose safety net is the `shadowed` report.

`system.txt` gains a `[markers]` section: every switch, the opacity, which maps
carry marker data, and Tab-mode's setting / active / showing state, its
cadences, its counters and its **last fast-check timings** — including
`tabMarkersInstant`, the 550 ms deadline and the provisional / unconfirmed
counts. `detector.log` gains `tab-mode-start`, `tab-mode-stop`, `tab-show`
(with `provisional=yes|no`), `tab-confirmed` (with `ms=` since the key went
down), `tab-forget`, `tab-hide` (with the reason, `unconfirmed` among them) and
`tab-size-mismatch` — decisions only, no pixels, and the show/hide lines are
edges rather than ticks.

## 7. Privacy

Unchanged in kind: the game's own window is sampled, nothing is stored and
nothing is sent. The frame never leaves the tick — no disk, no network — and
the only thing derived from it that survives is a boolean ("was that still the
Tab screen?"). No new **network** request, so the README "Network use" section
and the FAQ's count of outside contacts are unchanged.

Stronger since 0.7: this mode no longer owns a capture at all. It asks the
detector (`grabGate()` / `grabMatch()`), which asks the frame source, which
normally runs in the detector's `utilityProcess` — so the frame never leaves
that process either, and the boolean crosses the boundary alone. A test asserts
no message carries a Buffer, a TypedArray or an ArrayBuffer.

Two things did change and both are stated in the README, the FAQ and the
setting's own help text:

- **How often the window is captured with Tab mode on.** With the key trigger:
  the detector's usual 700 ms, plus one capture per map-key press, plus a
  500 ms safety check while the markers are up. On the polling fallback: 450 ms
  plus 150 ms while shown. The trigger is therefore *less* capturing than the
  fallback, not more.
- **The app reads one key's state.** Only while Tab-map mode is on, only the
  key the user configured (plus Alt, only while that key reads as down), and
  only as the yes/no question "is it held right now?". It does not receive,
  record or see any other key; there is no hook and nothing is reserved, so the
  key still belongs to the game. The only trace is the edge of that one key in
  `detector.log`.
