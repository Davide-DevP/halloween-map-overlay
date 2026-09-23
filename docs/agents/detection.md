# Automatic map detection

[← AGENTS.md](../../AGENTS.md) · **Read before** touching `src/core/map-detector.js`,
`src/core/map-detector/matcher.js`, `src/shared/detector-rules.js`,
`templates.json`, anything in `detection-fixtures/`, or any capture code.

Opt-in (`mapDetection`, default **false**, switch on the home page). Spec:
`docs/SPEC-DETECT.md`.

- **Two halves.** `map-detector/matcher.js` is pure arithmetic over a luminance
  buffer and holds every threshold and region; `map-detector.js` is the loop,
  the capture and the IPC. Keep new logic on the pure side — it is the only
  half with tests.
- **Regions are relative to the captured frame**, so 1280x720, 1920x1080 and
  2560x1440 all work with no per-resolution code. They were measured from
  `tab-fullscreen-haddonfield-heights.png` (1919x1078), where the Tab screen's
  panels are drawn with a 1 px frame line of luminance exactly 21/28 on black:
  map panel frame cols 875/876 and 1663/1664, rows 145/146 and 933/934, so its
  interior is x 877..1662, y 147..932 — an exact 786x786 square. `MAP_PANEL_REL`
  is that square **inset 10 px** (x 887..1652, y 157..922 = 766x766). The inset
  absorbs the few-pixel differences between the hand-made fixture crops *and*
  excludes the near-white 1 px highlight rectangle the game draws 8 px inside
  the frame while the cursor is over the map panel (two of the four fixtures
  have it, two do not). The same scan locates the **left (objectives) panel** on
  the same rows, frame cols 255/256 and 843/844, which is where
  `LEFT_PANEL_REL` (fs x 257..842, y 250..929, its lower ~2/3) comes from.
  `matcher.js` also keeps `TAB_PANEL_REL` — the same interior **without** the
  inset — because Tab-map mode's `tab` transform is a fraction of the *full*
  786x786 square: two names for one measurement, deliberately.
- **Two signals, not one.** The score is the mean of the NCC on luminance and
  the NCC on Sobel gradient magnitude. Luminance alone separates the maps
  (margin ~0.22) but leaves the runner-up at ~0.775 — right under the 0.80
  accept threshold, which is far too close for a real screen capture. With the
  gradient term the runner-up drops to ~0.50 and the margin doubles to ~0.49.
  Do not "simplify" this back to one signal.
- **A map has one template per view** (0.3.3). The Tab map panel is drawn
  differently for the civilian role (light street map, red boundary, grid
  letters, building numbers) than for Michael (dark blue plan); layout and
  orientation are identical. The civilian panel also carries **random**
  decoration — glow spots over houses, the player arrow — which is why the
  gradient half of the score matters: a soft blob is almost no edge. Measured:
  three house-sized glows cost ~0.05 (0.95 → 0.91), absurd ones ~0.12, and the
  runner-up stays near 0.47 throughout. See `templateVariants` and the fixture
  rules below.
- **Acceptance has two branches, and both need a margin** (`acceptMatch`, pure,
  0.3.3): `score >= 0.80 && margin >= 0.10` **or** `score >= 0.60 && margin >=
  0.15`. The second exists because of the owner's 0.3.2 field log: every Tab
  press in a *civilian* match scored 0.68-0.72 with the right map 0.27-0.31
  ahead and nothing was ever sent. All four maps now ship both views, so this
  branch is **best effort** for the *next* view nobody has sent a screenshot
  of, not a guarantee. The stand-in for that case is a civilian frame matched
  with its own variant removed, and it measures (full res / 640x360, margins):
  0.2194/0.2228, **0.1956**/0.2036, 0.2792/0.2826, 0.2493/0.2528 — which is why
  the lead is 0.15 and not the 0.20 0.3.3 first shipped with (VERIFICATION-6,
  finding 1: at 0.20 one of the four was rejected at full resolution and another
  passed by 0.004). 0.15 is still ~3x the worst negative margin (0.052 with the
  Tab gate off) and 0.32 under the score floor. The committed negatives, scored with the Tab
  gate off, reach 0.09/0.13/0.28 with margins ≤ 0.035, so they miss both halves
  of the second branch by an order of magnitude — a test asserts that fixture by
  fixture, and the printed score table carries both thresholds in its header.
  Do **not** replace the pair with a single lower `MIN_SCORE`: a dim frame that
  correlates weakly with *everything* has a small margin, which is exactly what
  the second condition catches. The result carries `acceptedBy` ('score' /
  'margin') and it is logged as `by=` on the `match` line.
- **Small alignment search.** A capture can be a few pixels off (a window's
  client area, a screenshot that lost a row); a 2 % vertical slip alone takes a
  correct match from 0.99 to 0.68. `matchMap` therefore tries `DEFAULT_OFFSETS`
  (dy ±1/±2 %, dx ±1.5 %) and each template keeps its best. Lowering the
  threshold instead would let wrong maps through too.
- **The Tab-screen gate runs first** so ordinary gameplay never reaches NCC:
  ≥90 % of the lower left panel must be near-black *and* ≥2 % of the map-name
  box must be bright. Measured separation: 0.99 vs 0.27–0.65 and 0.09–0.11 vs
  0.00. The darkness test is a *fraction*, not a mean, on purpose — it was
  written when the capture was the whole display and the app's own overlay
  landed in it; a bright patch over a tenth of the region would wreck a mean.
  Capturing only the game window removes that particular hazard, but the
  robustness is free, so keep it.
- **Cadence: 700 ms while the game window exists, 2000 ms when it does not**
  (`shared/detector-rules.js`, `tickInterval`). There is no post-detection
  discount any more. 0.3.0 polled 2000/5000 ms and the owner's field report was
  "the switch sometimes did not happen, or took so long I picked the map by
  hand": a Tab press lasts 1-2 s and fell between ticks. Measured cost of the
  new cadence on a 1920x1080 frame (headless bench over the real
  `toGrayScaled` + `matchMap`, 20 ticks each):

  | frame | blocking JS per tick | one core at 700 ms | event-loop peak drift |
  |---|---|---|---|
  | ordinary gameplay (fails the Tab gate) | **~29 ms** | ~4 % | 12 ms |
  | Tab screen (full NCC over the installed templates) | **~46 ms median, 57 ms p95** | ~7 % | 25 ms |

  Plus ~17 ms of *async native* capture that does not block the loop. **These
  numbers replace the 6.2 / 21.8 ms pair this table used to carry**, which came
  from a warm-buffer microbenchmark; the re-measurement, what it means for the
  ~30 ms budget (it is over it) and the post-0.7.0 item it produces are in
  "The capture path — do not make it heavier" below. It is still only the
  second or two per match that the player is actually holding Tab — but that is
  also when the game is busiest.
- **Detection never fights the user, and the loop is not the judge of
  "changed".** A manual pick does not stop it. The loop offers **every accepted
  match** to `core/map-controller.js`, throttled to one per key per 2000 ms
  (`SendThrottle`, so a held Tab does not spam it), and the **map state** drops
  it when `currentKey === key` (no re-send, no label flash) and reports the
  verdict back through `MapDetector.noteApplied()` for the log. 0.3.0 compared
  `match.key !== lastDetected` inside the loop, which is *not* what is on the
  overlay: after a manual pick, the same map detected again looked unchanged
  and was never re-applied. `lastDetected` now only gates the menu clear and
  drives the status line. `shouldApplyDetected()` is pure and tested.
  **Until 0.7 the judge was `src/js/maps.js`, i.e. the main window's renderer,
  and the messages were `show-map-command` / `map-detector-applied`.** The rule
  is identical; it moved into the main process (`shared/map-state.js`) so that
  auto-detect keeps working with the window torn down in the tray — see
  `docs/SPEC-MAP-STATE.md`.
- **`clear-map` (Ctrl+Alt+D) is not `toggle-map`.** It hides the map *and*
  calls `resetLastDetected()`, which clears `lastDetected` and schedules an
  immediate tick. Without the reset, hiding a detected map would leave the
  overlay blank for the rest of the match: the loop would keep seeing the same
  map, decide nothing changed, and never re-show it.

The overlay's map label rides on the detector's `map-change` —
[overlay-windows.md](overlay-windows.md).

- **Home-page status line**: "Off" / "Watching for the in-game map (Tab)…" /
  "Back in menu — map cleared" / "Detected <Map> at HH:MM", driven by the
  `map-detector-status` push plus one `invoke` at startup. The decision is the
  pure `detectorStatusView(memory, status)` in `src/shared/detector-status.js`
  (tested); `src/js/detector.js` keeps the returned memory so it can re-render
  the line in a new language, and only translates and draws.
- **The main menu ends the match** — always on since 1.0; it was the optional
  `hideInMenu` (default true, Settings › General) up to 0.7. `matcher.js` carries a second template — the menu's navigation
  strip, `MENU_STRIP_REL` = x 45..760, y 20..68 at 1919x1079, measured off
  `detection-fixtures/menu-main.png` by scanning the top-left corner (row means
  jump from ~0.6/255 above the strip to 9-41/255 across it and back by row 66;
  the `Q` badge peaks at x 50-60 and the `E` badge at x 730-745, both ~82/255 on
  near-black) and then rounded outward a couple of pixels — in its own `menu`
  section of `templates.json`, keyed by nothing so it can never be a candidate
  in the map match. It is a **96x12** thumbnail, not 64x64: the strip is ~15:1
  and squashing it square throws away the horizontal detail that is the whole
  signal, while 96x12 still averages several source pixels per cell at the
  640 px frame the detector works on (the strip is ~238x16 there).
  Scoring is the same luminance+gradient NCC; threshold `MENU_MIN_SCORE`
  0.75 against measured positives 0.962–1.000 and a best negative of 0.417.
  `gradientMagnitude(thumb, width, height)` takes a height now — it defaults to
  `width`, so the square map calls are unchanged.
  Four guards, all load-bearing:
  1. **Only on a tick that failed the Tab gate.** `matchMap` is called with
     `{report: true}` so `gated` is visible; a Tab screen never reaches the menu
     matcher, and an accepted match resets the counter.
  2. **Only while a map is on the overlay** — `shownKey`, not `lastDetected`
     (0.3.3). `core/map-controller.js` calls `noteShown(key|null)` after
     **every** apply, hides included, and the loop keeps it whether or not it
     is running; `shouldWatchMenu(shownKey)` is the pure gate — it takes the key alone, because
     a map from the last match still on the overlay in the menu is a bug, not a
     preference (docs/agents/settings-and-onboarding.md § Two settings the app
     decides).
     (Until 0.7 that report was the renderer's `map-detector-shown` IPC. Same
     rule, one process closer — and it can no longer be stale, because the
     process that knows and the process that asks are the same one.)
     0.3.2 gated on `lastDetected`, i.e. "did the loop recognise a map?", and
     the field log shows the hole: through an evening of party matches the
     matcher accepted nothing, the maps were picked by hand, `lastDetected`
     stayed null and the menu matcher never ran once — not one `menu-streak`
     line. `lastDetected` is now only the status line and the "changed" flag.
     `menu-clear` clears `shownKey` optimistically and the controller confirms
     a moment later. Keys reaching `detector.log` go through `logKey()` —
     `detector.log` is in the diagnostic zip and a custom map's key is a name
     the user typed.
  3. **A transition, not just a count** — `MenuStreak` in the pure rules
     module. Three *consecutive* menu ticks (`MENU_TICKS_TO_HIDE`; a loading
     screen sweeps past the menu layout, and at 700 ms three is ~2.1 s of
     steady menu), **and** the game must have been seen away from the menu
     since the current map went up (`sawNonMenu`: cleared by `noteShown()`,
     set by any non-menu gated-out frame and by `noteMatch()`). Without that
     second half, a map picked by hand while the menu is already on screen —
     the obvious moment to pick one — was cleared 2.1 s later, and again after
     the next pick (VERIFICATION-6, finding 2). The three cases are unit
     tested: pick-in-menu → no clear; match → menu → clear; pick-in-menu →
     leave → return → clear.
  4. **It hides through the map controller** (`MapController.menuHide()`), not
     straight at the overlay window, so the map state keeps owning `currentKey`
     and Ctrl+Alt+H still restores the map. `lastDetected` is cleared for the
     same reason `clear-map` clears it: otherwise the next match on the same map
     would look unchanged and the overlay would stay blank.
- **`DEBUG=true` logs `enumerate=… capture=… match=… total=…` per tick** and an
  event-loop peak-drift line every 10 s. That instrumentation is what caught the
  original capture backend; leave it in.
- **Never keep a frame.** No disk, no network, nothing beyond the tick. The
  event log is the one thing the detector writes, and it holds **decisions
  only**: ISO time, event name, map key, score/margin, tick ms. A test asserts
  a written line carries exactly the fields it was handed and nothing else.
- **`detector.log` in userData**, appended by `map-detector/log.js`: loop
  start/stop, game window found/lost (edges only), every accepted match
  (`by=score|margin`), every frame that passed the Tab gate without an accepted
  map (`no-match … gate=in panelMean=…`, the map panel's own mean luminance, so
  a dimmed or slipped panel is diagnosable without a frame), every change of
  the map on the overlay (`shown key=…`, throttled to changes), every menu
  streak change, every menu clear, every match offered to the controller
  (`send`), the map state's `applied`/`same-as-current` answer, and capture
  errors. Not gated on DEBUG —
  it exists so the owner can send it after a session that misbehaved
  (**Settings › General › Open log folder** → `shell.openPath(userData)`, IPC
  `open-log-folder`). Rotated at 512 KB keeping one `.1` backup. Since 0.3.2 the writer
  itself is `core/rotating-log.js`, shared with `app.log`; this file is only the
  detector's policy (name, cap, unbuffered writes).
  A write failure is logged once and never breaks a tick.

## The capture path — do not make it heavier

`node-screenshots` (`Window.all()` → `captureImage()` → `toRaw()`), **not**
Electron's `desktopCapturer`. That is not a preference, it is the whole reason
this feature is usable:

| | `desktopCapturer.getSources` (first attempt) | `node-screenshots` window capture |
|---|---|---|
| per tick | 286–518 ms | **26–37 ms** |
| main-thread event-loop peak drift | 152–246 ms | **15–16 ms** (= idle baseline) |
| game not running | full-screen grab anyway | **0.2 ms** — nothing to capture |

`desktopCapturer.getSources` grabs and scales *every* display on the main
thread; at a 2 s poll it froze the machine visibly. Do not go back to it, and do
not add a second per-tick capture.

### The real numbers, and what was done about them

The figures in this section used to read "~6–11 ms of blocking JS per tick".
**They were wrong**, and wrong in the direction that matters: taken from a
microbenchmark that reused one warm buffer, quoting `toGrayScaled` and
`matchMap` in isolation rather than as the one contiguous block of main-thread
work they actually form, and quoting `matchMap`'s *gated-out* cost (a frame that
is not a Tab screen, where the match exits after the gate) as if it were the
cost of a match.

Re-measured in plain node against the real fixtures — fresh buffer per
iteration, paced like the loop, ≥100 iterations — the tick was **~46 ms median /
57 ms p95** on a Tab screen and **~29 ms** on an ordinary gameplay frame: past
the budget at both ends, during the one or two seconds per match when the player
is holding Tab, i.e. exactly when the game is busiest too. Two things were done
in 0.7, in this order.

#### 1. Ask the cheap question first, and reduce only what is read

The tick used to reduce the **whole** frame to 640×360 of luminance before
asking anything, then throw it away on every frame that is not a Tab screen —
which is almost all of them. Now:

1. **`tabGateFromRaw` runs on the raw capture bytes** (~1.4 ms; it reads the
   21.9 % of the frame the gate regions cover, and allocates nothing).
   Verdict-identical to the old `TAB_SCREEN_GATE` path on every fixture.
2. **Gated out** — nothing is reduced at all, unless the menu matcher is wanted
   (`shownKey` alone, decided before any pixel work), and then
   only its 715×48 strip (~2.4 % of the frame).
3. **Gated in** — luminance for the map panel plus its alignment margins only
   (`regionSearchBox` over `DEFAULT_OFFSETS`), about a third of the frame.
4. **Templates are prepared once at load** (`prepareTemplates`): each variant's
   gradient magnitude and its NCC statistics used to be recomputed *per tick* —
   the gradients once per variant, the statistics once per variant × alignment
   offset, fifteen times over.

**Every number the matcher sees is bit-identical**, and that is not a hope:
`test/detector-equality.test.js` runs the old pipeline and the new one over
every committed fixture at native / 1280×720 / 2560×1440 / 640×360 and asserts
equality of the gate verdict, every per-map score, the winner, the runner-up,
the margin, `acceptedBy`, `panelMean` and the menu verdict — 85 checks. An
independent re-run against the genuine pre-change modules widened that to 20
fixtures × 15 sizes, 5,740 `Object.is` checks. It can be exact because each
output cell of `toGrayScaled` depends only on its own source box (so
`toGrayScaledRegion` computes the same cells from the same bytes), and because
the NCC statistics are accumulated in the same order.

**The gate is the one exception, and it is a verdict, not a number.**
`tabGateFromRaw` reads the raw bytes with its own rounding rather than the
reduced 640-px luminance, so the two can differ in the last place on the
name-box *fraction*. Every score, margin and decision the matcher produces is
identical; the **gate verdict** is identical on every real frame and differed on
exactly two of those 5,740 checks — one hand-cropped fixture stretched to a
non-native aspect ratio, whose fraction sat on the 0.02 threshold (0.0235/0.0222
against 0.0170/0.0199). Both of those frames were rejected at 0.38 either way.
So: *scores bit-identical, gate verdict-identical on frames the game can
actually produce.* Do not write "bit-identical" of the gate.

| tick | before (med / p95) | after (med / p95) | |
|---|---|---|---|
| gated-**out** gameplay tick, menu not wanted | 27.0 / 35.1 ms | **1.3 / 2.4 ms** | 20.8× |
| gated-**out** gameplay tick, menu wanted | 30.8 / 34.7 ms | **6.0 / 8.1 ms** | 5.1× |
| Tab-mode's gate-only check | 40.4 / 43.6 ms | **1.4 / 1.7 ms** | 29× |
| gated-**in**, 1919×1079 general path, 4 maps × 2 | 41.2 / 46.0 ms | **21.9 / 23.9 ms** | 1.9× |
| gated-**in**, 1919×1079, 8 maps × 3 (24 variants) | 51.6 / 57.2 ms | **24.9 / 27.7 ms** | 2.1× |
| gated-**in**, exact 1920×1080 fast path, 4 maps × 2 | 25.2 / 30.9 ms | **16.7 / 23.0 ms** | 1.5× |
| gated-**in**, exact 1920×1080, 8 maps × 3 | 35.4 / 40.8 ms | **19.7 / 21.6 ms** | 1.8× |

One run, one machine, one method: plain node, a fresh buffer per iteration,
20 ms paced, 120 iterations with the first ten dropped, the old path being the
genuine pre-change `matcher.js`. Quote the whole table or none of it — the
earlier "menu wanted" figure of 19.4 ms was from a harness whose old path
gated out *before* the menu matcher, i.e. it was not measuring the menu at all.

The common case — a gameplay tick, every 700 ms for the whole of a match — is
now 1.3 ms.

This section is the **one place** these numbers live; AGENTS.md rule 6 and the
specs quote the headline and link here. The 2026-09-23 matcher pass cut the
gated-in paths further; its numbers are a separate A/B on a loaded machine and
sit under *The budget, restated* below — do not mix the two tables.

#### What was *not* done, and why

**`matchMap` scores every variant of every map on every gated-in frame**, so
its cost is linear in installed variants — but see *Why there is no early exit*
below for what that term is actually worth: the **fixed** cost dominates, and
the linear part is ~0.10 ms per variant. Two ways to remove it were tried on
the fixtures and **rejected as unsafe**:

- **Coarse-to-fine** (rank every template at the zero offset, then run the full
  15-offset search for the top K). Measured: ranking by the zero offset picks a
  **different winner on 5 of 20 fixtures**, changes the margin on 9, and flips
  the accept/reject decision on 2. That is what the theory predicts — the
  alignment search exists *because* a misaligned frame scores 0.68 instead of
  0.99, so ranking by the un-aligned score ranks by the very thing the search
  was added to correct.
- **Verify-the-current-map first** (score only the shown map, then a cheap pass
  over the rest). The margin condition needs the runner-up's *best over all
  offsets*; a zero-offset pass only bounds that from below, so "verified" could
  accept where the full search rejects. There is no cheap upper bound on an NCC
  over offsets, so this cannot be made exact.

Neither can ship without changing accept/reject decisions, and the thresholds
are where they are for the reasons this file spends a section on. `LIMITS.variants`
remains what bounds the growth. The scaling problem is answered instead by
getting the work off the main thread entirely.

#### Why there is no early exit

A third shape was built and measured for 1.0 and then removed: score the
recently recognised maps first and stop once the leader is bright enough that no
unscored map could overtake it. **The measurement is the reason it is not
here.** `matchMap` on a 640×360 window of a 1920×1080 frame, one pool per
process, a fresh window per iteration, 5 ms paced, 160 iterations with the first
30 dropped:

| pool | median | p95 |
|---|---|---|
| **no templates at all** (the fixed cost) | **6.82 ms** | 7.05 ms |
| 4 maps / 8 variants — what ships today | 7.60 ms | 7.71 ms |
| 14 maps / 28 variants | 9.61 ms | 9.81 ms |
| 24 maps / 48 variants — `LIMITS.variants`, the ceiling | 11.52 ms | 11.73 ms |

So the **fixed** term is ~6.8 ms — the 15 alignment views, their gradient
magnitudes and the panel mean, none of which an early exit can touch — and a
template variant costs **~0.10 ms** on top. Skipping three of the four maps
saves ~0.6 ms today and ~4.7 ms at the variant cap. That bought ~250 lines, a
per-session recency list inside the pixel process, and a new field in the pack
schema.

It also had a hole, which is the other half of the answer. Safety rested on
"every unscored map is *measured* far enough away from this one", but the
measurement was recorded **per key, not per pair**, and nothing bound a
measurement to the templates it was taken against: a pack measured against the
1.0 bundle plus a map bundled *later* left both keys looking "measured" while
that pair had never been compared, and the exit was allowed. A probe with
tone-bent clones turned a full-table **reject** (0.965 against 0.965) into an
**accept** whose winner depended on the recency order. "Provably identical" was
an empirical margin, not a proof.

**If the per-tick cost ever has to come down, the fixed 6.8 ms is the target**
— `DEFAULT_OFFSETS` is 15 views for one panel — not the ~0.10 ms per variant.
The 2026-09-23 pass did exactly that (scratch buffers, precomputed resample
weights: fixed cost 10.6 → 5.9 ms in its own A/B, *The budget, restated*).
The separation between the maps is still measured, but as a build-time check
with no runtime half; see *Map similarity is a build-time check* below.

#### 2. Capture, gate, grayscale and match run in a utility process

Since 0.7 the whole pixel path — window enumeration, capture, gate, luminance,
the NCCs and the explicit collection — runs in an Electron `utilityProcess`
(`core/map-detector/worker.js`). **Main never blocks on a frame.** It keeps the
scheduler (the `setTimeout` chain, every cadence, the "a request is in flight"
guard), the state (`lastDetected`, `shownKey`, the menu streak and its
transition rule), Tab-map mode's reducer and epochs, and every log line and
every window.

- `core/map-detector/frame-source.js` is the pixel work, as one module. It runs
  in the worker **and** in main when there is no worker, so the fallback is the
  same code rather than a second implementation.
- `core/map-detector/worker-host.js` is main's side: lazy start (only while
  something actually needs frames — a user with auto-detect off never pays for a
  second process), stop when nothing does, restart with backoff (250 / 1000 /
  4000 ms, then give up), a per-request timeout so a child that is alive but not
  answering cannot wedge the scheduler, and stale replies dropped by request id.
  The timeout is three numbers (`shared/detector-worker-rules.js`): **2000 ms**
  for an ordinary tick (`ORDINARY_TIMEOUT_MS`), **500 ms** for the gate-only
  check (`REQUEST_TIMEOUT_MS`) and a **3000 ms** grace for the first request
  after a fork (`START_TIMEOUT_MS` — that one is paying for the child's
  start-up, and charging it to the tick budget killed healthy workers). The
  ordinary tick used to share the 500 ms: in a 0.7.0 field log both timeouts of
  the session fell in the five seconds in which the game was *starting* (window
  enumeration and capture stall while the GPU driver is busy), each one killed a
  healthy child, and a third would have abandoned the worker for the session. A
  slow answer there costs nothing — the scheduler chains on the reply — so it
  gets room.
- **Requests queue: one in flight, the rest in order, each with its own timer
  and its own promise.** The callers — the tick, Tab mode's confirming grab and
  its safety check — only guard themselves, so at 450 ms and 150 ms they overlap
  within seconds. A single `pending` slot lost the first caller's promise the
  moment a second request arrived: it never settled, the caller's `busy` flag
  stayed true with it, and automatic detection was dead until the app was
  restarted, with nothing in any log. Replies are **not** coalesced onto one
  capture: an answer from a frame taken before the question was asked is the
  mirror image of the staleness bug Tab mode's epochs exist to prevent.
- **A request that cannot be answered resolves as "no frame this tick"**
  (`aborted`, with a reason) rather than quietly capturing in main. Callers check
  `aborted` and `error` **before** `window`: a fault that arrives without a
  window otherwise reads as "the game is not running", which is then what the log
  says while the real cause goes unrecorded. Such a tick also keeps the **game**
  cadence while the window was last seen present — the 2 s interval means "the
  game is not running", and one timeout during a Tab press must not cost two
  seconds of not looking.
- **A gate-only request (`match: false`) never gets the start-up grace.** It is
  asked only while Tab-map mode's markers are drawn over the game, and brackets
  over live gameplay are the one thing that must not linger: it would rather be
  told "no frame" on its own 500 ms timeout and take them down. (Tab mode also
  keeps a deadline of its own — see
  [markers-and-tab-mode.md](markers-and-tab-mode.md).)
- **A deliberate stop is not a crash.** It arms no restart, counts towards no
  give-up and captures nothing afterwards — and neither does a quit, which is
  why `node-screenshots` is never pulled into main on the way out.
- **The child collects its own frames.** `worker.js` loads `core/gc.js` and the
  frame source runs one collection per captured frame, where the 8 MB buffer
  actually is; main runs none at all in worker mode. The child reports whether
  its collector works and `system.txt` prints `worker gc = available|noop`.
- **Restarts decay.** A child that has answered for a minute has its earlier
  restarts forgiven, so four unlucky moments hours apart no longer add up to
  "this worker keeps crashing" for the rest of the session. A give-up says which
  it was: `crashed` or `timeouts`.
- **Only numbers and keys cross.** `test/detector-worker.test.js` asserts that
  no reply carries a Buffer, a TypedArray or an ArrayBuffer, for every fixture
  and every request shape, including across a real `child_process.fork`.
  Templates travel the other way as plain number arrays — they are build output,
  not a capture. The same fixtures are matched *through the transport* and
  asserted equal to `matchMap` called directly.
- Tab-map mode's confirming grab and its safety check go through the same source
  (`detector.grabMatch()` / `grabGate()`), so they are off the main thread too.
- Falling back to in-process is automatic and reported: `utilityProcess` missing,
  a fork that throws, a child that crashes past the backoff, or **three *fatal*
  replies in a row** — the worker's handler throwing, which is the case that
  cannot be seen from main (`node-screenshots` not loading inside the child). A
  failed *capture* is not fatal and is never counted: an alt-tab or a
  display-mode change fails captures for a second or two and the in-process path
  would have failed identically. The fallback is logged once and `system.txt`
  prints `detector = worker` or `detector = in-process (reason)`.

**What this does not change**: the worker's CPU is still the player's CPU, and
the phase-1 numbers above are what it costs *there* — which is why they were
worth having first. What it changes is that none of it lands on the thread that
draws the overlay.

**How to know it is actually working**, because most of it is invisible:
`detector-source mode=worker` is written immediately after the fork and proves
only that a process was created. The proof is the *absence* of trouble plus one
positive line:

- ordinary `match … tickMs=` lines in `detector.log` in the 20–30 ms range, and
  **no** `worker-timeout`, `worker-restart` or `worker-fallback` anywhere in the
  file;
- `system.txt` reading `detector = worker` with no restart or timeout count
  after it;
- `worker gc = available` in `system.txt` — that line only exists if a child
  answered a handshake, so it is the one thing that cannot be printed by a
  worker that never ran;
- a second process in Task Manager while auto-detect is on, and **not** one
  after it is switched off.

### The budget, restated

- **Main thread: ~0 ms per tick.** Main posts a message and later handles a small
  object. Anything that would put pixel work back on it needs a written reason.
- **Worker: ~30 ms of blocking JS per tick** — the old budget, now applying to
  the child. A gated-out tick is 1.3 ms and a gated-in one 22 ms at 1919×1079,
  so there is room. `matchMap` is linear in installed variants, but the term is
  small: ~0.10 ms each against a ~6.8 ms fixed cost, so the whole 48-variant
  budget is under 5 ms of it (*Why there is no early exit* above).
  `LIMITS.variants` is what bounds it.
- **The collection runs in the worker, inside that budget** (`gc.collect()`,
  3.2 ms, once per captured frame). It has to be *there*: the 8 MB native buffer
  is there, and a worker that does not collect is the 78 → 191 MB oscillation
  `docs/MEMORY-REPORT-2.md` §4 measured, moved rather than removed. Main runs no
  collection at all in worker mode — it never held the frame. Whether the trick
  works inside Electron has still never been observed, so `system.txt` prints
  both `detector gc = …` (main's probe, and what the fallback would use) and
  `worker gc = …` (what the child reported). `core/gc.js` is required **lazily**
  in both processes: it flips a V8 flag with `setFlagsFromString`, an embedder is
  allowed to freeze that, and a frozen flag is a V8 FATAL rather than an
  exception — which must not be able to happen during startup for a feature that
  is off by default.

**2026-09-23 dedup/scratch-buffers pass.** `toGrayScaled` now delegates to
`toGrayScaledRegion`; `gradientMagnitude` indexes the interior directly;
`matchMap`/`matchMenu` resample straight out of the window into reused scratch
thumbnails (no crop copy, no per-view allocation, ~0.5 MB held by the matching
process); `resample` computes column weights once per call. Median ms, measured
as an interleaved A/B in one process on a loaded machine (compare within this
note, not with the tables above): gated-in 1919×1079 **21.7 → 18.0**, exact
1920×1080 **17.3 → 13.1**, `matchMap` fixed cost **10.6 → 5.9**, 4 maps × 2
**12.1 → 7.5**, menu tick unchanged at 5.4. Split on the general tick: the dedup
and the gradient −1.9, the scratch buffers −0.9, the column weights −0.9. Every
score is bit-identical to the pre-pass matcher (90,830 `Object.is` checks); both
sides of `detector-equality.test.js` share these kernels, so
`test/matcher-kernels.test.js` pins them against the old loops.

Rules that keep the path from getting heavier still:

- **`toGrayScaled` is the hot spot** — it is the only thing that touches source
  pixels in bulk. It fuses the luma conversion and the box average into one pass
  on purpose; splitting it back into `toGray` + `resample` doubles the reads and
  allocates an 8 MB intermediate. It also has a whole-number fast path (1920→640
  and 1080→360 are both exactly 3:1, so that is what a borderless 1080p game at
  exactly that resolution takes): 13.5 ms full-frame on the fast path against
  25.8 ms on the general one. A test asserts the two agree. The general path is
  the **common** case — a 1918×1079 client area is what a real borderless window
  reports — and since 0.7 `toGrayScaledRegion` is what actually runs, over a
  third of the frame or less.
- **`node-screenshots` has no resize**, only `crop`, and `Image.crop` runs
  *after* the grab. Measured: cropping before `toRaw` costs 3.5 ms of native crop
  to save 1.9 ms of copy, and buys no blocking JS at all, because the gate reads
  the same source pixels either way. Not worth it.
- **No game window → return immediately.** Leaving the switch on while the game
  is closed costs one 0.2 ms window enumeration every 2 s. The "not found" state
  is logged at most once a minute (`logState`).

**Finding the game window**: the *decision* is the pure `classifyWindow` /
`pickGameWindow` in `shared/detector-rules.js` (shared with
`core/foreground.js`, which must not have a second opinion about what the
game's window is); `frameSource.findGameWindow` (in
`core/map-detector/frame-source.js`, so it runs wherever the capture runs) is
the property reads around it. Match on `appName()`, not `title()`. Titles produce false positives constantly — during development a
terminal window called "Halloween The Game mappe" (the project folder) matched
`/halloween/i` on its title, as would any browser tab about the game. The title
is consulted only when the OS gives no app name at all. An exact
`Halloween`/`Halloween.exe` app name beats a looser match. Also excluded: our
own windows (the main window is literally called "Halloween Map Overlay", so
`OWN_NAME` and a `process.pid` check are both needed), minimized windows
(Windows returns a stale or empty image), and anything under 320x240.

**Packaging**: `node-screenshots` ships prebuilt NAPI binaries, so there is no
compile step, but the `.node` files cannot live inside the asar —
`build.asarUnpack` covers `node_modules/node-screenshots/**/*.node` and
`node_modules/node-screenshots-*/**/*.node`. The loader does
`require('node-screenshots-win32-x64-msvc')`, so it is that second pattern that
matters on Windows. `package-lock.json` carries every platform's optional
package, so `npm ci` on the `windows-latest` runner installs the win32-x64 one
with no extra step.

## Map similarity is a build-time check

The acceptance thresholds rest on the maps' Tab panels being far apart, and
nothing used to verify that: the four shipped maps sit 0.4–0.5 apart because
they share an art style, not because anything checked. A new map that is really
an existing one re-cut — or a night, snow or seasonal version of it — would
score far higher, and the honest failure there is a *second gallery entry for
one map*, which no runtime code can fix.

So both generators measure it and print the matrix. Nothing at runtime reads
the result: there is no field in the pack schema, no section in
`templates.json`, and no behaviour keyed on it. **The warning is the product.**

- `SIMILAR_MAP_SCORE = 0.70` lives in `scripts/prepare-detector.js`, with the
  tool, so no runtime module carries a constant nothing in the app uses.
  0.196 above every wrong pair measured so far and below the 0.80 accept floor,
  so it can only fire on something that really looks like the same map.
- `npm run prepare-detector` prints the shipped maps' matrix and warns on a
  pair; `npm run build-pack` prints one new map against **every** map a user
  could already hold (the bundled templates plus every pack in `packs/`, which
  is why the index and `packs/` have to agree) and warns. `--dry-run` shows it
  without writing.
- Both score through `matchMap` itself — no second implementation of a score.
  A frame is scored the **higher** of two registrations, the runtime path
  (`MAP_PANEL_REL` plus the 15-offset search) and the panel `locatePanel`
  finds, so no rule is needed about full frame versus hand-made crop, and
  erring high is the safe direction for a warning.
- Frames are every `tab-*` fixture (`tab-fullscreen-*` included) **plus every
  stored template variant**. The stored thumbnails are what make the matrix
  two-directional: a pack's own Tab screenshots are not in this repository — and
  must not be, since `detection-fixtures/` *is* the bundled template set — so
  its 64×64 variants are the only frame of it there is.

Measured today (17 fixtures + 8 stored variants, 4 maps): worst right-map score
**0.9461**, best wrong-map score **0.5041**, **no pairs**. The owner's field log
of 1186 matches never saw a second-best above 0.509.
`test/detector-similarity.test.js` asserts the separation and the threshold's
place in the gap, and flags a deliberately cloned pack. What an author does
about a flagged pair is in
[maps-authoring.md](maps-authoring.md) § When two maps score alike.

## Fixture naming rules

These are what make "adding a map" a data-only change
([maps-authoring.md](maps-authoring.md)); do not break them:

- `detection-fixtures/tab-<slug>.png` → template source **and** a positive test.
  **Several `tab-*` fixtures may resolve to one map** — anything ending in the
  slug, by convention `tab-<role>-<slug>.png` (`tab-civilian-east-haddonfield`).
  Each becomes a **template variant** of that map (`buildVariantsForKey`), and
  `matchMap` scores a key as the **max** over its variants. Not an average:
  the civilian and Michael views of one panel are different pictures (measured
  0.69-0.76 against each other), and averaging them produces a template that
  matches neither. 0.3.2 kept the first fixture and warned about the rest.
- `detection-fixtures/tab-fullscreen-<slug>.png` → an extra full-frame positive
  test for that same map; **not** used as a template source (so a map can have
  both a crop and a full frame without producing two templates).
- `detection-fixtures/menu-<name>.png` → a **main-menu** positive, and the first
  in sort order is the menu template's source. Still a map-matcher negative.
- Any other `detection-fixtures/*.png` → a **negative**: the detector must
  return null for it, and it must not look like the menu either. That is where
  gameplay screenshots go.
- The slug is resolved against the real catalogue with `findClosestMapMatch`,
  the project's single name matcher, so the creator comes from the `maps/`
  folder and the key can never drift. A slug that matches no map is ignored by
  the generator and fails `test/map-detector.test.js`
  ("every map in maps/ has a detection fixture").

## Two neighbours: `core/gc.js` and `core/foreground.js`

Both live next to the detector without being part of the capture path, and both
have their reasoning elsewhere — this section only says where, plus the one
thing that is written down nowhere else.

- **`core/gc.js`** — one V8 collection on demand, for the process that holds the
  captured frame. Every measurement (78.5 / 131.2 / **191.2** MB rss with no
  collection, 78.1 / 79.4 / 79.9 MB collecting every tick; the collection itself
  1.06 ms min / 1.31 median / 3.89 p95 / 6.28 max) is in
  `docs/MEMORY-REPORT-2.md` §4 and summarised in [memory.md](memory.md). The
  constraint the code carries is the **lazy build** — why is in
  [the utility-process section above](#2-capture-gate-grayscale-and-match-run-in-a-utility-process)
  and in [memory.md](memory.md).
- **`core/foreground.js`** — the `hotkeysGameOnly` poll. Its rules, cadences and
  fail-open cases are in [hotkeys.md](hotkeys.md); it shares only
  `classifyWindow` with the detector, and **it captures nothing**, so the budget
  above does not apply to it. The one thing kept here is what was *rejected*
  when it was written: `node-screenshots`' `Window.isFocused()` was chosen
  because the alternatives were all worse — a new native module for
  `GetForegroundWindow`, a `powershell`/`tasklist` child process per tick
  (hundreds of milliseconds and a visible process spawn), or Electron's
  `desktopCapturer`, which is the very thing the detector was moved off.

See also: [markers-and-tab-mode.md](markers-and-tab-mode.md) (the fast Tab
gate, the 700 → 450 ms cadence and the key trigger that replaces it),
[map-packs.md](map-packs.md) (a pack's templates are merged once at load) and
[memory.md](memory.md) (one V8 collection per captured tick).
