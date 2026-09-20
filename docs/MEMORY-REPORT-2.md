# Memory footprint — measured, then reduced (post-0.6.0 working tree)

Follow-up to `docs/MEMORY-REPORT.md` (0.2.2, "no leak found"). That report
looked for a leak; this one asks a different question — **how much RAM does the
app actually cost while a match is being played, and how much of it can go
away** — because the owner plays on a 16 GB machine where the game leaves almost
nothing free, and the overlay runs for the whole match.

Date 2026-09-20. Binary under test: `dist/win-unpacked/Halloween Map Overlay.exe`
built from the working tree at `ac90632` + the uncommitted 0.7 work (map packs,
markers, Tab-map mode). Windows 11 Pro 26200, 12 logical CPUs, 16 GB. The game
was **not** running. The owner's installed copy was not running either (checked
before, between and after every run: 0 `Halloween Map Overlay.exe` processes
that were not mine).

## 0. Read this first: which number is the memory

The 0.2.2 report quoted **private bytes** ("~250–300 MB"). On Windows that
counter is *commit charge* — address space the process has reserved against RAM
+ pagefile — not the RAM the process is holding. The number that matches what
Task Manager calls "Memory", and the one that decides whether the game has room,
is the **private working set**: private pages actually resident.

For this app the two differ by a factor of two:

| in-match state, before any change | value |
|---|---|
| private working set (real RAM, private) | **131.6 MB** |
| private bytes (commit charge) | 268.4 MB |
| working set, summed over the five processes | 463.2 MB |

That last row is the misleading one: it counts the shared, file-backed pages of
the 214 MB executable, the asar and the system DLLs once **per process**, while
the OS holds them once. The difference between the two working-set numbers
(~330 MB across five processes) is almost entirely that double counting.

So the honest headline is that the app cost **~130 MB of RAM**, not 270 and not
460. Everything below reports all three (`pws` / `priv` / `ws`), because commit
charge still matters on a machine that is paging, and because `ws` is what a
reader comparing against the 0.2.2 report will reach for. The one to optimise is
`pws`.

## 1. Method

- Test instances only from `dist\win-unpacked`, always launched **detached**
  with `--user-data-dir=%LOCALAPPDATA%\hmo-memtest` (never the real userData,
  never anything under `%TEMP%` — see "Bitdefender, unsigned executables and
  `%TEMP%`" in AGENTS.md). The root PID was recorded at launch and only that
  tree was ever killed (`taskkill /F /T /PID <mine>`).
- Scratch settings file: `checkForUpdates: false`, `checkForMapPacks: false`
  (so no network request can enter the numbers), `minimizeToTray: true`,
  `onboardingDone: true`, `disableFaqPopup: true`.
- Process tree resolved from `Win32_Process` by root PID + `ParentProcessId`,
  each process labelled from its `--type=` switch. Per process:
  `WorkingSetPrivate` (`Win32_PerfRawData_PerfProc_Process`), `PrivateMemorySize64`
  and `WorkingSet64` (`Get-Process`), plus `TotalProcessorTime` deltas → % of
  **one** core. Three to eleven samples per state after a settle period of
  40–75 s; the tables quote the settled value.
- The app was driven through `--remote-debugging-port` + `Runtime.evaluate`
  (open Settings, walk its three tabs, open FAQ and Credits, click all four
  gallery cards, switch auto-detect on) rather than by hand, so every run
  reaches the same state. A control run without the debugging port gave the
  same numbers.
- **The GPU process is state-dependent and hysteretic**, which is why the runs
  exercise the UI: a launch that is minimised to the tray immediately leaves the
  GPU process at ~68 MB commit, while one where the main window has been used
  for a minute leaves it at 95–151 MB, and it does **not** give that back when
  the window is hidden. An early run that skipped the UI exercise measured
  GPU commit at 68 MB and a later one at 141 MB with no app action in between.
  Any comparison that does not fix this is noise.
- The owner's installed copy of the app was never touched. Only trees started
  by this work were killed, and every run ended with a check that no
  `Halloween Map Overlay.exe` process was left behind.

## 2. Before — four states

Private working set MB per process (`priv` / `ws` totals on the right).
"renderer A" is the main window, "renderer B" the overlay.

| state | main | gpu | net | rend A | rend B | **pws** | priv | ws |
|---|---|---|---|---|---|---|---|---|
| just started, home page | 37.0 | 19.7 | 6.9 | 30.5 | 22.2 | **116.3** | 239.7 | 429.9 |
| (a) home page, after the UI has been used | 38.4 | 30.8 | 6.7 | 32.9 | 23.8 | **132.6** | 273.5 | 464.7 |
| (d) Settings open | 38.7 | 29.2 | 6.7 | 32.9 | 23.5 | **131.0** | 273.9 | 463.0 |
| (c) auto-detect on (no game) | 38.0 | 29.2 | 6.7 | 32.9 | 23.6 | **130.4** | 273.7 | 460.9 |
| **(b) map on the overlay, minimised to tray, auto-detect on** | 39.8 | 29.0 | 6.7 | 32.6 | 23.5 | **131.6** | 268.4 | 463.2 |

Idle CPU in state (b), over a separate 5-minute run (11 samples, 30 s apart):
**mean 0.26 %, max 0.46 % of one core**, all of it in main — the 1 s
`setAlwaysOnTop` re-assert plus the detector's 2 s window enumeration.

Three things fall out of this table and they shaped everything that follows.

1. **Hiding the main window to the tray frees nothing.** Its renderer stays
   fully resident (32.6 MB) and the GPU process keeps the surfaces it allocated
   while the window was visible. State (b) is not cheaper than state (a).
2. **Opening Settings costs nothing** (+0 pws, ~+1 MB ws). There is no settings
   *window*: the modal, Bootstrap, jQuery and the whole settings DOM live in the
   main window's renderer and are parsed at load whether or not anyone opens
   them. The 0.2.2 report's "settings-window renderer ~40 MB" was that renderer.
3. **Auto-detect with no game running is free** (+0 pws, ~1 MB commit). The tick
   returns after one window enumeration, exactly as AGENTS.md says.

## 3. What was tried, and what it was worth

Every row is the in-match state (b), same driving script, same settle time.
Command-line switches were A/B'd against the same binary, so nothing here
depends on a rebuild.

| configuration | pws | Δ pws | priv | ws | idle CPU |
|---|---|---|---|---|---|
| baseline | 131.6 | — | 268.4 | 463.2 | 0.26 % mean |
| `--disable-gpu` | 112.7 | **−18.9** | 198.0 | 425.0 | unchanged (§3.1) |
| `--renderer-process-limit=1` | 113.0 | **−18.6** | 234.2 | 390.1 | unchanged |
| both | 101.7 | **−29.9** | 174.4 | 362.1 | unchanged |
| `--enable-features=NetworkServiceInProcess` | no change | 0 | — | — | — |

### 3.1 Hardware acceleration off — **shipped, default off**

`app.disableHardwareAcceleration()`. Chromium keeps a GPU process either way;
without acceleration it becomes a software display compositor and drops from
~29 MB pws / 88 MB commit to ~11 MB pws / 19 MB commit. Some of that moves into
the renderers (software raster tiles), which is why the net is −18.9 MB pws
rather than −18 in the GPU process alone.

- **No visual cost on the overlay.** Verified with a real desktop capture while
  a map was up: the transparent, click-through, always-on-top window composited
  correctly over another application, with the marker brackets and the map-name
  label drawn as usual. That is not luck — `src/map/map.html` has **no
  animation, no transition and no `@keyframes` at all**. It is a still PNG and
  an SVG. Dragging the overlay is `-webkit-app-region: drag`, i.e. an OS window
  move, and the corner/glide placement is `setPosition` from main; neither goes
  through the renderer's rasteriser.
- What it does cost is the **main window's** UI — the gallery's staggered
  fade-up and the modal transitions are rastered on the CPU. That window is
  looked at between matches and is hidden in the tray during one.
- **It costs no measurable CPU.** The decisive test is a *paired* one: the same
  binary, back to back, nothing else running on the machine, with only the
  `hardwareAcceleration` key different — 11 samples 30 s apart, map on the
  overlay, window in the tray, auto-detect on.

  | `hardwareAcceleration` | idle CPU, % of **one** core | pws | priv | ws |
  |---|---|---|---|---|
  | `true` | mean **0.24**, max 0.72 | 120 | 250.3 | 442.1 |
  | `false` (shipped) | mean **0.19**, max 0.31 | 106 | 191.5 | 405.2 |

  Two earlier runs on the *previous* build agree: 0.26 % mean with the GPU on
  (pws 121) against 0.21 % with it off (pws 107). So across four runs the
  difference is inside the sample-to-sample noise, and software compositing of
  a window that is not on screen showing a picture that never changes is, as it
  should be, free.

  One run does not fit and is called out rather than dropped: an early GPU-off
  run measured 0.64 % mean with a visible ramp to 1.65 % in its last samples.
  That run overlapped with `npm test` and several `node --test` invocations on
  the same machine. Its per-process breakdown put all of it in the browser
  process, which is what CPU contention there would look like; the paired run
  above, with the machine quiet, does not reproduce it.

Shipped as the setting `hardwareAcceleration`, **default `false`**, Settings ›
General. It is read in `index.js` *before* `app.whenReady()` (the call is
ignored afterwards), so it takes effect on the next start and the UI says so.
The escape hatch exists because software compositing is a per-machine question:
a GPU/driver combination where it looks or feels wrong is one switch away.

### 3.2 One renderer process — **measured, not shipped; see §7**

`--renderer-process-limit=1` puts the main window and the overlay (and the OBS
and Tab windows, when they exist) in a single renderer process: 5 processes
become 4, −18.6 MB pws, −73 MB ws, and **no CPU cost at all**. Electron 40 has
no `affinity` option any more and all our pages are `file://`, so this switch is
the only lever that does it.

It is not shipped because it contradicts a documented invariant. Today a death
in the main window's renderer leaves the overlay alive — AGENTS.md is explicit
that "the overlay has to survive, because the player is mid-match", and the
0.3.2 crash policy is built on the two being independent. With one process, a
renderer death takes the overlay down with the main window, and the overlay
comes back **blank** (main does not keep the last image) until the next map
change or a `toggle-map` press. 18.6 MB — about 0.1 % of 16 GB — is not worth
that mid-match. The owner can still try it by hand:
`"Halloween Map Overlay.exe" --renderer-process-limit=1`.

### 3.3 Tearing the main window's renderer down while in the tray — **rejected here, done in 0.7**

> **Superseded.** Everything below is the reasoning that rejected this *at the
> time of this report*, and it is kept because it is still the reason the work
> had to be done in a particular order. The rewrite it describes is what
> `docs/SPEC-MAP-STATE.md` specifies and what 0.7 ships: the map state, every
> hotkey and the detector's route to the overlay live in the main process
> (`shared/map-state.js` + `core/map-controller.js`), the renderer is a view,
> and the window is destroyed after 45 s in the tray behind the setting
> `unloadWindowInTray` (default **true**).
>
> **The saving is ESTIMATED, not measured.** The ~32 MB below is this report's
> own figure for renderer A in the in-match state; nobody has yet measured the
> app with the window actually gone, because no agent may launch Electron. The
> README's "roughly a quarter" is that same estimate. Until the owner measures
> it — the state to measure is: map on the overlay, auto-detect on, window in
> the tray for **more than five minutes**, so Windows has trimmed and the
> window has certainly been unloaded — quote it as an estimate and say so.
> `app.log` records `main-window state=unloaded reason=… hiddenMs=…` and
> `system.txt` prints `main window = loaded|unloaded`, so the run can be
> confirmed to have been in the right state.

The prize would be most of renderer A: ~32 MB pws. It is not safe, and not
"safe with care" — the architecture puts the in-match feature set *in that
renderer*. `src/js/maps.js` owns:

- `currentKey` / `lastKey` — what is on the overlay, and what `toggle-map`
  restores;
- every hotkey: `toggle-map`, `hotkey-pressed` (per-map bindings), `next-map`,
  `prev-map`, `rotate-map`, `clear-map`, `toggle-markers`, `opacity-up/down`,
  `size-up/down`;
- `show-map-command`, i.e. **the detector's only route to the overlay**, plus
  the `shouldApplyDetected` decision that AGENTS.md deliberately moved out of
  main ("main is not the judge of *changed*");
- `menu-hide-map`, and the `map-detector-shown` report that the menu clear is
  gated on.

With the renderer gone, every hotkey, auto-detect and the menu clear stop
working — i.e. everything the app does during a match. Navigating it to
`about:blank` is the same thing with extra steps.

Moving that logic to main is possible but it is a rewrite, not a tweak: a new
`core/map-state.js` owning `currentKey`/`lastKey` and the catalogue matching, a
pure module for the decisions that are currently in the renderer, the hotkey
dispatch re-pointed, `map-detector-shown` inverted (main would be telling
itself), the renderer demoted to a view that syncs from main, and each of the
invariants in AGENTS.md's `map-change` and detection sections re-established on
the other side. Call it 500–700 lines across six files plus tests, with the
reward being ~32 MB (~25 % of the app's RAM) and the risk being every hotkey in
the product. Worth doing deliberately as its own piece of work; not worth
doing halfway.

### 3.4 `webPreferences` — **shipped**

All four windows are now built from one `src/shared/web-preferences.js`, which
turns off what this app does not have: `spellcheck` (Electron's default is
**on**, and it builds a SpellCheckHost and loads a dictionary per renderer),
`webgl`, `enableWebSQL`.

**Measured honestly, it is worth nothing you can see.** The same 5½-minute
protocol with the graphics card *on*, before and after, gives 121 MB pws and
120 MB pws — about 1 MB, which is inside the sample-to-sample noise. It is kept
anyway because it costs nothing, it cannot regress a feature the app does not
have, and one builder means the fifth window cannot quietly go back to an inline
object; a test asserts all four use it. It is not counted in the headline.

`backgroundThrottling` is deliberately left at Electron's default: the main
window *should* be throttled while it sits in the tray, and its hotkeys arrive
as IPC, not timers.

### 3.5 Window lifetimes and process topology — **nothing to change**

- Each window gets its **own renderer process**; `webPreferences.affinity` is
  gone from Electron 40 (zero occurrences in `electron.d.ts`), and all four
  pages are `file://`, so §3.2's switch is the only way to merge them.
- The **OBS window** is already created on demand (`obs-open`) and the **Tab
  markers window** is already lazy (`TabOverlayWindow.ensure()`). Neither
  exists in any state measured here, so neither is in the numbers.
- The **overlay window** is created at startup and never re-created. Making it
  lazy would save ~23 MB pws in state (a) and **nothing at all in state (b)**,
  which is the state that matters, and it would break the invariant that
  AGENTS.md is explicit about: the overlay is created once in `createWindow()`
  and only ever `setSize`/`setBounds`/`setPosition`ed afterwards, never
  `show()`n, because a `show()` can steal the foreground from the game. Not
  done.
- `v8CacheOptions` is left alone: Electron's default is already `'code'`.

### 3.6 V8 / Chromium switches — **rejected**

- `--js-flags=--max-old-space-size=64` **was** measured, in the capture bench of
  §4, and it does bound the oscillation (peak 191 → 125 MB, mean 131 → 106 MB)
  by making V8 collect more often. It is strictly worse than §4's explicit
  collection (peak 80 MB, mean 79 MB) and it would apply the cap to every
  process. Not adopted. It was **not** measured in the packaged app: main's JS
  heap there is a few MB, so the cap is not what holds the memory in any of the
  four states above.
- `--enable-features=NetworkServiceInProcess` did **not** remove the network
  utility process (6.7 MB pws) — it was still in the tree with the flag set.
- `--in-process-gpu` and `--js-flags=--lite-mode` were not tried on the packaged
  app and are not recommended: the first trades process isolation for a few MB,
  and the second makes V8 jitless, which is the engine the detector's matcher —
  the app's one hot loop — runs in.
- Turning off features the app never uses (`disable-features` for media, WebRTC,
  background networking) was not pursued after the process table showed where
  the memory actually is: five processes whose floor is Chromium's own.

## 4. The detector's native buffer churn — **shipped, and the biggest single win**

`docs/MEMORY-REPORT.md` §3 recorded the main process's rss oscillating between
~60 and ~170 MB while the capture loop runs, because `node-screenshots` exposes
no dispose/free/close API at all: a 1080p frame is 7.6 MB of native RGBA, and it
is released by the NAPI finalizer only once V8 collects a small JS wrapper
object it has no pressure to collect. Up to eight frames were outstanding.

Reproduced here (plain node 24, 300 captures of a 1920x1032 window through the
exact runtime pipeline — `captureImage` → `toRaw` → `toGrayScaled` → `matchMap`),
and then measured against the mitigations:

| after each capture | rss min | rss mean | rss max | ms/iteration |
|---|---|---|---|---|
| nothing (current behaviour) | 78.5 | 131.2 | **191.2** | 88.1 |
| `--max-old-space-size=64`, no collection | 74.1 | 106.0 | 125.0 | 84.7 |
| collect every 4th tick | 94.5 | 111.0 | 127.7 | 85.0 |
| **collect every tick** | 78.1 | **79.4** | **79.9** | 89.0 |

The collection costs **1.06 ms min / 1.31 ms median / 3.89 ms p95 / 6.28 ms max**
over 200 ticks (3.2 ms median on the re-measurement below). In exchange the main
process's **peak drops by ~110 MB during a real match** and stops oscillating.

> **Correction (0.7).** This paragraph used to end "a tick already spends
> 6–11 ms of blocking JS in `toGrayScaled`, and AGENTS.md's budget … is ~30 ms,
> so this stays comfortably inside it". The first half was wrong and the
> conclusion therefore does not follow. Re-measured in plain node on the real
> fixtures, paced like the loop and with a fresh buffer per iteration:
> `toGrayScaled` is **25.8 ms median / 36.6 ms p95** on the general 1918×1079
> path (13.5 ms on the exact-3:1 1920×1080 fast path), `matchMap` **gated in**
> is 16.0 ms, and one Tab-screen tick was therefore **~46 ms median / 57 ms p95**
> of contiguous main-thread work — a gameplay tick ~29 ms. The old figures came
> from a warm-buffer microbenchmark and quoted `matchMap`'s *gated-out* cost.
> The **collection was never the problem** and is still inside the budget; the
> capture and the match were, and the loop was over AGENTS.md's ~30 ms trigger.
>
> **Both remedies the rule names then shipped in 0.7**, so those numbers are
> history: the tick now gates on the raw bytes and reduces only the regions it
> reads (gated-out gameplay tick 27.0 → **1.3 ms**, gated-in Tab tick 41.2 →
> **21.9 ms**, every matcher score bit-identical), and the whole pixel path —
> capture, gate, grayscale, match **and this collection** — runs in an Electron
> `utilityProcess`, so the rss oscillation this section measures is now the
> *worker's* and the main process never touches a frame. See
> `docs/agents/detection.md`, "The capture path".
>
> Whether the collection works *inside Electron* has still never been observed;
> since 0.7 the startup snapshot and `system.txt` print `gc = available|noop`,
> so the owner's next report answers it.

Shipped in `src/core/gc.js`, called at the end of a grab **only on a tick that
actually captured a frame** — a tick that found no game window allocated
nothing, and collecting every 2 s for nothing would be pure cost. Since 0.7 the
call site is `core/map-detector/frame-source.js`, which is to say it happens
wherever the frame does: in the utility process normally, in main only on the
fallback path. The
collection function is taken out of a throw-away `vm` context with
`v8.setFlagsFromString('--expose-gc')` flipped straight back off, rather than
`app.commandLine.appendSwitch('js-flags', '--expose-gc')`, so no renderer gets a
global `gc` and no other `js-flags` value is clobbered. `DEBUG=true` prints it
as `gc=Nms` on the per-tick timing line.

Two alternatives were considered and not taken:

- **Cropping before `toRaw`**, or capturing at a lower resolution. The Tab
  gate's regions and the map panel span most of the frame, every region in the
  matcher is expressed relative to the whole frame, and the whole test matrix is
  built on that — AGENTS.md ("The capture path — do not make it heavier") rules
  it out already. `node-screenshots` has no resize at all, only `crop`, and no
  way to ask the OS for a smaller capture. Measured since: `Image.crop` runs
  *after* the grab, and costs 3.5 ms of native crop to save 1.9 ms of copy.
  What 0.7 does instead is read fewer pixels out of the same buffer — the gate
  on the raw bytes, then grayscale for the regions that are actually matched.
- **Explicit nulling** of `image`/`raw`. They are already locals of `tick()` and
  nothing outlives the tick; the frames are not waiting on a JS reference, they
  are waiting on a collection. That is what §3 of the old report established and
  what the table above confirms.

**One caveat the owner's machine has to settle.** These numbers are from plain
node capturing another application's window, because the game was not running.
The pause inside Electron will be a little larger — its heap is bigger than
plain node's — though since 0.7 it is the *worker's* pause, not main's, so it
can no longer stutter the overlay. `DEBUG=true` prints `gc=Nms` on every tick, and a tick over
`SLOW_TICK_MS` still lands in `detector.log` as `slow-tick`, so one real match
with `DEBUG=true` answers it.

## 5. After — the same four states, rebuilt

Same binary path, same driving script, same settle times, `hardwareAcceleration`
at its shipped default (off).

| state | main | gpu | net | rend A | rend B | **pws** | priv | ws |
|---|---|---|---|---|---|---|---|---|
| just started, home page | 37.6 | 11.0 | 7.0 | 27.7 | 22.3 | **105.6** | 191.4 | 404.7 |
| (a) home page, after the UI has been used | 39.6 | 14.2 | 6.8 | 40.8 | 24.0 | **125.4** | 214.2 | 476.4 |
| (d) Settings open | 39.7 | 14.1 | 6.8 | 41.3 | 24.0 | **125.9** | 214.5 | 477.0 |
| (c) auto-detect on (no game) | 39.4 | 11.5 | 6.8 | 35.4 | 24.0 | **117.1** | 205.3 | 456.5 |
| **(b) map on the overlay, minimised to tray, auto-detect on** | 40.8 | 11.4 | 6.8 | 35.4 | 23.6 | **118.0** | 205.9 | 463.5 |

### Before / after, the state that matters

| in-match state (b), 75 s after minimising | before | after | Δ |
|---|---|---|---|
| **private working set** | 131.6 | **118.0** | **−13.6 MB (−10 %)** |
| private bytes (commit) | 268.4 | **205.9** | **−62.5 MB (−23 %)** |
| working set (summed) | 463.2 | 463.5 | +0.3 |
| processes | 5 | 5 | — |
| main process **peak** while the game is up (§4) | ~191 MB rss | **~80 MB rss** | **−110 MB** |

**A match lasts longer than 75 seconds, and that matters.** Windows keeps
trimming the working set of a window nobody is looking at. Sampled every 30 s
for 5½ minutes in the tray instead, the same state settles at:

| | pws after 5½ min in the tray |
|---|---|
| graphics card on | ~120 MB |
| graphics card off (shipped) | **~106 MB** |

Both figures are stable across the last eight samples of four separate runs, on
both the old and the new build, so ~106 MB is the number the owner will actually
see in Task Manager during a match. (One sample of one run dropped to 79 MB on a
single trim and then the run ended; it is not quoted, because it did not hold.)

Per process, where it went and where it came back:

| process | before | after | Δ pws |
|---|---|---|---|
| main (browser) | 39.8 | 40.8 | +1.0 |
| gpu | 29.0 | 11.4 | **−17.6** |
| network utility | 6.7 | 6.8 | +0.1 |
| renderer A (main window, in the tray) | 32.6 | 35.4 | **+2.8** |
| renderer B (overlay) | 23.5 | 23.6 | +0.1 |

The +2.8 MB in renderer A is the honest cost of software rasterisation: the main
window's tiles are rastered in its own renderer, and it keeps them after being
hidden to the tray. That is why the in-match win is −13.6 MB rather than the
−18.9 MB the `--disable-gpu` A/B suggested — that A/B was measured against the
same binary, so it did not include this build's other changes, and the two
runs differ slightly in how much of the main window had been drawn.

The summed working set barely moves. That is expected and is the point of §0:
what left is mostly commit charge and GPU-side allocation, while the
software-raster tiles are resident pages that stay.

## 6. What actually changed in the code

| change | file(s) | effect |
|---|---|---|
| `hardwareAcceleration` setting, default **off**, applied before `whenReady` | `index.js`, `src/shared/settings-defaults.js`, `src/index.html`, `src/js/options.js`, `src/i18n/*.json` | **−14 MB pws, −59 MB commit** in the settled tray state; no measurable CPU cost |
| collect after every capturing detector tick | `src/core/gc.js` (new), `src/core/map-detector.js` | **main-process peak 191 → 80 MB rss** during a match, for ~1.3 ms per tick |
| one `webPreferences` builder, `spellcheck`/`webgl`/`enableWebSQL` off | `src/shared/web-preferences.js` (new) + the four window modules | **not measurable** — ~1 MB, inside the noise. Kept because it cannot regress a feature that does not exist |

New tests: `test/gc.test.js`, `test/web-preferences.test.js`, and two cases in
`test/settings-defaults.test.js` pinning the default and `useHardwareAcceleration`.
`npm test` is green (759 tests).

## 7. How far Electron goes for this app, and what Tauri would really buy

No advocacy; the numbers, and what each of them is made of.

**Electron's floor, as this app is built.** The in-match state settles at
~106 MB of private working set. Of that, at the settled point:

- **~30 MB** is the browser (main) process: Node, V8 and Chromium's browser-side
  machinery. Nothing in the app's own code moves this.
- **~9 MB** is the GPU process reduced to a software display compositor. It
  cannot go to zero; Chromium starts it either way.
- **~3–7 MB** is the network utility process, for an app that makes at most two
  requests a day. `--enable-features=NetworkServiceInProcess` did not remove it.
- **~22–27 MB** is the main window's renderer, still resident in the tray.
- **~15–23 MB** is the overlay's renderer — the one process here that is
  genuinely doing the app's job during a match.

Two levers are left, both already priced above:
`--renderer-process-limit=1` (§3.2, −18.6 MB, costs the overlay's crash
isolation) and tearing the tray-hidden renderer down (§3.3, ~−25 MB, costs a
500–700 line refactor). Taking both would put a realistic Electron floor around
**~65–70 MB pws**. Below that is Chromium's own cost and the app cannot reach
it.

**What a Tauri rewrite would and would not save.** Tauri uses WebView2 on
Windows, which is Chromium — so a rewrite does *not* collapse to one process.
A Tauri build of this app would be a small Rust process plus WebView2's own
browser, GPU, renderer-per-window and utility processes. Realistically:

- The Rust core replaces Electron's ~30 MB main process with something in the
  8–15 MB range: no Node, no V8, no Chromium browser layer. **That is the real
  saving, and it is ~15–22 MB.**
- The renderers do not shrink much. They would still be Chromium renderers
  hosting the same DOM; dropping `nodeIntegration` saves a little.
- WebView2's browser and GPU processes replace Electron's. Same order.
- So the honest estimate is **~15–35 MB below Electron's floor**, not 200 —
  and most of it is the same ~25 MB that §3.3's refactor would win without
  changing the stack at all.

Where a rewrite *would* win outright, and it is not RAM:

- **Disk and update size.** ~214 MB of executable becomes ~10 MB. That is the
  pressure behind the whole map-pack design (a new map as a few hundred KB
  instead of a ~90 MB app update) and behind `spawnInstallerAtLowPriority()`,
  which exists because unpacking ~350 MB saturated the owner's disk badly enough
  to stutter the mouse.
- **The capture loop.** `xcap` — which is what `node-screenshots` wraps — would
  be called directly from Rust with the frame's lifetime owned by the code. §4's
  entire problem, and the workaround in `core/gc.js`, would simply not exist.
- **Startup time**, which was not measured here.

What it would cost, and this is the part the numbers do not show. Every
Windows-specific thing in the overlay is a hard-won invariant in this codebase,
and each one would have to be re-derived against WebView2: the `pop-up-menu`
always-on-top level re-asserted every second so a fullscreen game cannot push
the overlay behind it; `setIgnoreMouseEvents(true)` **without** `forward: true`
because the forwarded variant installs a WH_MOUSE_LL hook that stuttered the
cursor system-wide; `focusable: false` + `skipTaskbar: true` so the overlay
cannot steal the foreground from the game; the rotated bounding box; DIP→physical
conversion for the updater hand-over. A transparent, click-through, always-on-top
WebView2 over a fullscreen game is precisely the case where WebView2 and
Chromium-in-Electron differ most, and the overlay *is* the product — that is the
risk to weigh, not the megabytes. Add ~759 unit tests over the pure modules
(matcher, catalogue, hotkey rules, i18n, markers, map packs) to port, and the
C#/WPF themed updater's app-side half to rewrite.

**Summary in one line:** staying on Electron costs roughly 15–35 MB of RAM
against a Tauri rewrite — much of which §3.3 would recover without changing the
stack — and about 200 MB of disk and download; the rewrite's bill is re-proving
every overlay behaviour on a different web view.

## 8. What needs the owner's eyes in a real match

Everything above was measured with the game **not running**, because it was not
installed on the test machine. Three things therefore remain open and one
evening of play answers all of them.

1. **The detector's collection pause, on the real capture path.** §4's
   1.3 ms median / 6.3 ms worst is plain node capturing another window.
   Electron's main process has a larger heap. Run one session with
   `DEBUG=true`: every tick prints `gc=Nms` beside the existing
   `enumerate=/capture=/match=/total=`, and anything over `SLOW_TICK_MS` is
   already written to `detector.log` as `slow-tick`. If `gc` is routinely more
   than a few ms, move the call to every second or third capturing tick — the
   measured table in §4 shows what that costs (peak 128 MB instead of 80 MB).
2. **Software compositing over a fullscreen game.** The overlay was verified
   over an ordinary application, not over *Halloween: The Game* in
   borderless-fullscreen. The always-on-top / click-through / transparency
   behaviour is unchanged by this work, but the *rasteriser* under it is new.
   If the overlay ever looks wrong, flickers, or lands behind the game,
   **Settings › General › "Use the graphics card to draw the app"** is the one
   switch to flip, and that is what it is there for.
3. **Tab-map mode with the graphics card off.** Tab-map mode draws brackets on
   a second transparent window at a 450 ms cadence while Tab is held — the one
   part of this app that actually animates. It is experimental and off by
   default, it could not be exercised without the game, and it is the most
   likely place for software compositing to show a cost. Worth one look with
   the mode on.
