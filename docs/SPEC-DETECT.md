# Phase 2 — Automatic map detection (spec)

> Revised 2026-09-23 to match the code; the measured reasoning is in docs/agents/detection.md.

Goal: when the player opens the in-game map (Tab, "Objectives" tab), the overlay
switches to that map by itself. Opt-in, off by default.

## 1. Facts about the game (from `detection-fixtures/`, see its README)

- The loading screen is black with a cutscene: it never shows the map name.
  Detection can only use the Tab screen.
- The Tab screen at 1920x1080 (`tab-fullscreen-haddonfield-heights.png`) has two
  dark panels on a blurred background:
  - left panel ≈ x 252–845, y 140–935, with the map name in a framed box at
    ≈ x 300–547, y 160–203 (uppercase, light serif on near-black);
  - right panel ≈ x 871–1670, y 140–935, containing the full map, same
    orientation as the community maps, with dynamic markers (`?` icons, player
    arrow) but no coloured annotations.
- The four cropped fixtures (`tab-<map>.png`, ~1400x784) are those two panels
  at native scale, so the right ~57% of each crop is the map panel of that map.
- The objectives list (top-left) also appears during normal gameplay
  (`gameplay-*.png`); only the framed name box and the map panel are unique to
  the Tab screen.
- The main menu (`menu-main.png`) has large serif uppercase text top-left too.

## 2. Approach: image similarity on the map panel (no OCR, no native deps)

The signal: zero-mean normalized cross-correlation (NCC) between a 64x64
grayscale thumbnail of the map panel region of the current screen and the
reference thumbnails — a **list of variants per map** (one per view: Michael,
civilian, …). Each comparison is the average of two NCCs, one on luminance and
one on its gradient magnitude (edges separate the maps that share a layout;
luminance alone left a runner-up at ~0.775 against the 0.80 threshold).

Why not OCR: tesseract.js needs asar-unpacked WASM + a language file and
either a runtime download (network) or a bundled 4 MB file; with only 4 very
different layouts NCC on a 64x64 thumbnail separates them with a large margin
and costs microseconds. OCR can be added later as a second signal if real-world
tests show ambiguity.

Capture backend (revised 2026-09-17 after a real test): `desktopCapturer.
getSources` was tried first and froze the whole PC at every tick, so it is
banned. Use `node-screenshots` (runtime dep, NAPI prebuilt, same as the
reference project): find the game window (`Halloween.exe`, title/appName
matches /halloween/i, not our own window, not minimized) and capture ONLY that
window with the async `captureImage()`; when the game window does not exist,
do nothing that tick (zero cost when not playing). Downscale as early as
possible; DEBUG-log the per-tick capture+match time (target < 30 ms). If the
main thread still stutters, run the loop in an Electron `utilityProcess`.
Regions are relative to the captured window image, not the display.

### 2.1 Pure module `src/core/map-detector/matcher.js` (no electron, no fs)

- `toGray` / `toGrayScaled` / `toGrayScaledRegion` → `Float32Array` luminance
  (the last two fuse the luma conversion and the box average; the region form
  is what the tick runs).
- `cropRegion(gray, w, h, rel)` with `rel = {x, y, w, h}` in 0..1 of the frame.
- `downsample` / `resample` → area-averaged thumbnails; `gradientMagnitude`.
- `ncc(a, b)` → zero-mean normalized cross-correlation in [-1, 1].
- `matchMap(frameGray, w, h, templates, opts)` →
  `{key, score, second, margin, scores, accepted, acceptedBy, panelMean}` or
  `null`. Region = `MAP_PANEL_REL`, measured from the fullscreen fixture as the
  panel interior inset 10 px: `{x: 887/1919, y: 157/1078, w: 766/1919,
  h: 766/1078}`. It is sampled at **15 alignments** (`DEFAULT_OFFSETS`,
  dx ∈ {−0.015, 0, 0.015} × dy ∈ {−0.02 … 0.02}), because a 2 % vertical slip
  alone drops a correct match 0.99 → 0.68. Each map scores its best variant at
  its best alignment.
- **The accept rule has two branches** (`acceptMatch`, which returns the
  branch's name as `acceptedBy`):
  - `score` ≥ **0.80** and `score − second` ≥ **0.10** (`'score'`) — a solo
    Tab screen measures ~0.99 / 0.49;
  - `score` ≥ **0.60** and `score − second` ≥ **0.15** (`'margin'`) — a dim
    party Tab screen, or a view no template has seen, measures ~0.70 / 0.29.
    Both conditions must hold, so a merely dark frame cannot pass; never
    replace the pair with one lower minimum score.
- `TAB_SCREEN_GATE`: a cheap pre-check that the frame is a Tab screen at all.
  It is a **fraction**, not a mean luminance: ≥ **90 %** of the lower left
  panel (`LEFT_PANEL_REL`) is darker than 0.06, AND ≥ **2 %** of the map-name
  box (`NAME_BOX_REL`) is at or above 0.35. A mean would be moved past any
  threshold by a bright patch over a tenth of the region (our own overlay).
  Measured separation: dark fraction 0.990–0.995 on Tab vs 0.27–0.65 elsewhere;
  name-box fraction 0.088–0.114 vs 0.000. `tabGateFromRaw` computes the same
  verdict straight off the raw capture bytes. Matching is skipped when the gate
  fails, so normal gameplay never reaches NCC.
- `matchMenu`: the main-menu strip (`MENU_STRIP_REL`, a 96x12 thumbnail, 25
  alignments, accept at 0.75) — the input to the menu clear in §2.3.

### 2.2 Templates `src/core/map-detector/templates.json`

Generated by `scripts/prepare-detector.js` (uses `sharp`, dev only) from the
`detection-fixtures/tab-*.png` screenshots: locate the map panel in each
(`locatePanel`), grayscale, downsample to 64x64, round to 3 decimals. The file
is `{format: 2, size: 64, templates: {"<catalogue key>": [[4096 floats], …]},
menu: …}`: a **list** of thumbnails per map, one per view, plus the 96x12 menu
strip. `templateVariants()` still reads the pre-0.3.3 one-thumbnail shape. The
file is committed; running the script must be idempotent.

### 2.3 Runtime `src/core/map-detector.js` (main process)

- `MapDetector(mainWindow, settings)` with `start()`, `stop()`, `isRunning()`.
- Loop with `setTimeout` chaining (not `setInterval`). Cadence
  (`tickInterval` in `src/shared/detector-rules.js`): **700 ms while the game
  window exists** (a Tab press lasts one or two seconds, so that is two ticks
  inside the shortest realistic one), **2000 ms while it does not** (one 0.2 ms
  window enumeration, no capture). There is **deliberately no slower
  post-detection cadence**: the player can change map at any time. Tab-map mode
  may pass a faster game cadence (450 ms); the idle one is never changed.
- Each tick: locate the game window via `node-screenshots` `Window.all()`;
  if absent, skip (log "game window not found" at most once per minute);
  otherwise capture that window, gate, reduce only the matched regions, match.
  Never keep frames; never write them to disk; never send them anywhere.
- On an accepted match: call `MapController.detected(key)` (the map state in
  main decides whether anything changes — `docs/SPEC-MAP-STATE.md`), remember
  `lastDetected`, and send `map-detector-status` `{state: 'detected', key, at}`.
  The same key is offered at most once per `SEND_THROTTLE` (2000 ms).
- **The menu clear**: `MENU_TICKS_TO_HIDE` (3) consecutive menu-matching ticks
  (~2.1 s) while a map is on the overlay → `MapController.menuHide()`. Always
  on since 1.0 (`hideInMenu` was removed).
- Manual map pick by the user (card click, hotkey) does NOT stop detection
  (unlike the reference); it just changes what is shown. Detection only sets
  the map when it sees a *different* map than `lastDetected`. Rationale: the
  user asked for "open Tab once and the overlay is right"; if they override
  manually, the next Tab press with the same map should not fight them.
- Errors (capture failed, display gone) are logged once per minute max, never
  thrown; the loop keeps going.
- IPC: `map-detector-start`, `map-detector-stop`, `map-detector-status`
  (invoke → `{running, lastDetected, lastAt, lastScore, templates, inMenu}`).
  The home page's status line is decided by the pure
  `src/shared/detector-status.js`.
- Setting `mapDetection` (bool, default **false**) persists the switch; when
  true the detector starts at app launch.

### 2.4 UI

- Home page: a switch "Auto-detect map (open the in-game map with Tab)" with a
  small status line: "Off" / "Watching…" / "Detected East Haddonfield 12:04".
  *(1.0 relabelled it "Recognise the map automatically" and gave it a second copy on
  Settings › Map, the same setting through the same `Detector.setEnabled`; the
  two game's-map placements lock both on. See
  docs/agents/settings-and-onboarding.md § Where do you want to see the map?)*
- Settings → General: nothing new (the switch is on the home page).
- FAQ + README: update the privacy text. It must now say: with auto-detect on,
  the app captures the game window (every 700 ms while the game is running),
  compares it locally against bundled thumbnails, keeps nothing and sends
  nothing; off by default. Remove/replace the sentence "never takes
  screenshots".
- Add "Auto-detect" to the hotkeys? No. Keep the switch only.

### 2.5 Tests `test/map-detector.test.js` (node:test, decode PNG with `sharp`)

Required outcomes, using `detection-fixtures/`:

| Fixture | Expected |
|---|---|
| `tab-fullscreen-haddonfield-heights.png` (full frame path) | `deftyconchgaming/Haddonfield Heights`, margin ≥ 0.10 |
| `tab-east-haddonfield.png` (crop; feed its map panel through the same downsample) | East Haddonfield |
| `tab-haddonfield-heights.png` | Haddonfield Heights |
| `tab-orange-grove-estates.png` | Orange Grove Estates |
| `tab-haddonfield-town-center.png` | Haddonfield Town Center |
| `gameplay-killer.png`, `gameplay-civilian.png`, `menu-main.png` (full frame) | `null` (gate or score) |

Plus: the fullscreen fixture scaled to 1280x720 and 2560x1440 with `sharp`
must still detect Haddonfield Heights (relative regions are resolution
independent for 16:9). Unit tests for `ncc` (identical → 1, inverted → -1,
constant image → 0 without NaN) and `downsample`.

Note the four `tab-<map>.png` crops are NOT full frames: the test must crop the
map panel from the crop with crop-relative coordinates measured by the
developer, not with `MAP_PANEL_REL`.

## 3. Packaging

- `templates.json` lives in `src/` (inside the asar).
- `node-screenshots` is the only new runtime dependency; its `.node` binaries
  must be `asarUnpack`ed (`node_modules/node-screenshots/**/*.node`,
  `node_modules/node-screenshots-*/**/*.node`). `sharp` stays dev-only.
- Version bump to 0.2.0.

## 4. Acceptance

1. `npm test` passes including the fixture table above.
2. `npm start` with `mapDetection: true` logs a capture tick without errors
   on this machine (the Tab screen will not be present, expect "no match").
3. Packaged build runs the loop (the node-screenshots binary loads from `app.asar.unpacked`).
4. README/FAQ privacy text updated; `docs/agents/detection.md` documents the detector.
5. Reviewer can run the fixture tests and reproduce the margins.

## 5. Addendum (0.7) — where the pixel work runs

This spec's §2.3 put the loop in the main process and left the escape hatch
"if the main thread still stutters, run the loop in an Electron
`utilityProcess`". It stuttered, and the move was made. What changed, and what
did not:

- **The decisions are unchanged.** Regions, both signals, the thresholds, the
  gate, the cadences and the acceptance table are exactly as specified in §2.
  `test/detector-equality.test.js` asserts the numbers the matcher sees are
  **bit-identical** to the pre-0.7 pipeline on every fixture at four
  resolutions. The **gate** is verdict-identical rather than bit-identical: it
  now reads the raw bytes with its own rounding, which differed on two of 5,740
  checks in an independent re-run — one hand-cropped fixture stretched to a
  non-native aspect ratio, sitting on the name-box threshold, rejected at 0.38
  either way.
- **The tick asks the cheap question first.** `tabGateFromRaw` runs on the raw
  capture bytes (~1.4 ms, no allocation) and only the regions that will actually
  be matched are reduced to luminance. §2.1's "downscale as early as possible"
  now means "downscale as *little* as possible". The measured before/after is
  in docs/agents/detection.md § The capture path.
- **`src/core/map-detector/frame-source.js`** owns everything that touches
  pixels: find the window, capture, gate, grayscale, `matchMap`, `matchMenu`.
- **`worker.js`** runs that module inside `utilityProcess.fork`, and
  **`worker-host.js`** is main's side: lazy start, per-request deadlines
  (`src/shared/detector-worker-rules.js`: 500 ms for Tab-map mode's gate-only
  check, 2000 ms for an ordinary tick, 3000 ms for the first request after a
  fork), restart backoff, automatic fallback to running the same frame source
  in-process. `system.txt` prints `detector = worker | in-process (reason)`.
- **Only numbers and keys cross the process boundary**, in both directions
  except for the templates going in. This is a stronger form of the privacy
  rule in §2.3 and the README: while the worker is running, a frame does not
  merely stay out of the log, it never reaches the process that owns the
  windows, the settings and the network. (On the declared fallback the capture
  is back in main, exactly as it was before 0.7 — the README says so rather than
  promising the stronger thing unconditionally.) A test asserts no reply carries
  a Buffer, a TypedArray or an ArrayBuffer.
- **Requests queue, one in flight**, each with its own timer and promise; a
  request that cannot be answered resolves as "no frame this tick" rather than
  becoming a main-process capture. A deliberate stop is not a crash and arms no
  restart. The child loads `core/gc.js` itself, because the frames it must
  release are its own.
- **By design, not open**: `matchMap` is linear in installed map variants.
  Coarse-to-fine prefiltering was measured on the fixtures and rejected — it
  changes the winner on 5 of 20 and flips the accept/reject decision on 2, so
  it cannot be had without changing this spec's acceptance rules.
  `LIMITS.variants` (48) in the map-pack spec is what bounds the cost; why there
  is no early exit either is docs/agents/detection.md § Why there is no early exit.
