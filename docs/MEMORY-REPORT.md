# Memory / resource review — Halloween Map Overlay 0.2.2

> **Historical, not maintained.** A record of what was true when it was written; names, paths and numbers may be stale.
> Current facts live in the `docs/agents/` document that owns them (see AGENTS.md).

**Verdict: NO LEAK FOUND.** Memory grows ~0.3 MB per `map-change` in the main process and in the overlay renderer, but a renderer GC returns both to baseline (measured after ~130 changes), the detection loop is flat, and the code review found no unbounded structure; one minor, user-action-bounded object-URL strand is noted.

Date 2026-09-17. Reviewer: independent agent. Binary under test: `dist/win-unpacked/Halloween Map Overlay.exe` built 13:17 from `c3f12ff` (HEAD during review; `f3168b7` "Run the update installer at idle priority" was committed by another agent at 14:00 while this ran — it changes only the install path, adds no timers/listeners, still calls `mapDetector.stop()` before quit, and is not in the tested binary). Working tree was clean at every check; no file looked mid-edit.

## Setup

- Windows 11 Pro 26200, 12 logical CPUs, 16 GB. The game was **not** running (app logged "game window not found"). The owner's installed app was not running either (0 `Halloween Map Overlay.exe` processes before, during and after).
- Test instances only from `dist\win-unpacked` with `--user-data-dir=<scratch>` (verified: `hotkeys.json`, Chromium caches and the single-instance `lockfile` appeared in the scratch dir). Trees identified by root PID + `ParentProcessId`; killed with `taskkill /F /T /PID`.
- Settings: `{"mapDetection": true|false, "checkForUpdates": false}` — the update check was disabled (deviation from the brief) so no GitHub request/download could enter the numbers.
- Sampler: `Get-Process` `WorkingSet64`, `PrivateMemorySize64` (private bytes), `TotalProcessorTime` deltas → % of **one** core, every 15 s (10 s in the fast stress). Tree = main, gpu-process, network utility, 2 renderers. The renderer created second (overlay window, `createWindow()` order) is the one that receives `map-change`.
- Map changes were injected with second instances `... --user-data-dir=<same> "show-map=<key>"` cycling the four keys; every launch exited on its own with code 0 (0.27–0.37 s in warm-up, ~3.2 s during the sampled soak, ~2.0 s in the stress runs; 0 survivors after the un-awaited run). Main logged `Opening map:` 22 + 36 + 96 = 154 times in total.

## 1. Soak, detection ON, 6 min, map-change every 20 s (18 + 4 warm-up changes)

| t (min) | procs | WS MB | Private MB | CPU % (1 core) |
|---|---|---|---|---|
| 0.00 | 5 | 439.4 | 251.1 | – |
| 1.02 | 5 | 444.0 | 255.3 | 0.82 |
| 3.03 | 5 | 448.6 | 260.0 | 0.10 |
| 6.07 | 5 | 453.8 | 265.7 | 0.21 |

Slope of total private bytes: **+2.04 MB/min** (first half 2.43, second half 1.63 MB/min); min/max 251.1/268.5; no plateau inside 6 min. Mean CPU 0.83 % of one core (main 0.67 %, gpu 0.09 %, renderers ≤0.06 %).

| pid | process | priv 0 m | 1 m | 3 m | 6 m | slope MB/min |
|---|---|---|---|---|---|---|
| 6840 | main | 79.8 | 81.6 | 83.8 | 85.9 | 0.84 |
| 22588 | renderer (overlay) | 38.9 | 40.9 | 43.0 | 46.0 | 1.01 |
| 19040 | renderer (main window) | 40.2 | 40.2 | 40.4 | 40.4 | 0.04 |
| 23184 | gpu-process | 75.7 | 76.1 | 76.4 | 77.1 | 0.16 |
| 19032 | utility NetworkService | 16.4 | 16.4 | 16.4 | 16.4 | 0.00 |

All growth sits in main (+6.1 MB / 22 changes = 0.28 MB per change) and the overlay renderer (+7.1 MB = 0.32 MB per change); the detector tick itself (2 s `Window.all()` enumeration, no capture because no game) contributes nothing visible — see run 2 and the stress runs.

## 2. Soak, detection OFF, 2 min, no map changes

| t (min) | procs | WS MB | Private MB | CPU % (1 core) |
|---|---|---|---|---|
| 0.00 | 5 | 472.1 | 302.4 | – |
| 1.02 | 5 | 457.3 | 301.9 | 0.31 |
| 2.02 | 5 | 457.1 | 302.1 | 2.48 |

Private bytes flat (302.4 → 302.1; main settled 86.1 → 78.8 in the first 30 s, gpu 110 → 126). Idle CPU: total 0.0–0.3 % for t = 30–76 s; the last three samples (t = 91–121 s) show 2.4–3.5 % in the **main** process only, with no test activity of mine — not attributed (the 1 s `setAlwaysOnTop` is included in all samples, so it is ≤0.3 % at most). Mean over the run 1.38 %.

## 2b. Map-change stress on the OFF instance (not requested; run to settle the growth of run 1)

- 36 changes in 3 min (one every 5 s): main 78.7 → 90.7 MB, overlay renderer 37.9 → 47.8 MB, other three flat; CPU mean 2.3 %.
- 96 changes in 4 min (one every 2.5 s, 10 s sampling), private MB (main / overlay renderer / total):

| t s | 0 | 61 | 122 | 183 | 214 | 224 | 234 | 264 |
|---|---|---|---|---|---|---|---|---|
| main | 89.9 | 101.1 | 106.4 | 113.5 | 117.8 | **84.5** | 83.5 | 82.2 |
| overlay renderer | 47.6 | 57.7 | 65.6 | 71.9 | 75.4 | 77.7 | **45.5** | 41.7 |
| total | 284 | 307 | 321 | 335 | 343 | 312 | 279 | 274 |

Linear growth of ~0.3 MB per change in each of the two processes for ~85 changes, then a renderer GC released it all while changes were still arriving: total ended at 274 MB, **below** the run's starting 284 MB, and the overlay renderer at 41.7 MB, ~its fresh value. The mechanism fits `new Blob([...])` per change (`src/map/renderer.js:38`): the blob bytes live in the browser (main) process' blob storage until the renderer's `Blob` wrapper is garbage collected; `revokeObjectURL` (line 35) is done correctly but only drops the URL registration. Bounded by GC, not a leak.

## 3. Capture + match loop in isolation (plain Node 24, `--expose-gc`, 300 iterations, 50 ms spacing)

Script: `Window.all()` → pick largest visible non-minimized window (Discord, 1920x1032) → `captureImage()` → `toRaw()` (7.6 MB RGBA) → `toGrayScaled(raw, w, h, 640, 344, 'rgba')` → `matchMap(gray, 640, 344, templates, {size})`, the exact runtime pipeline of `map-detector.js:233-297`.

| point | rss MB | heapUsed MB | external MB | arrayBuffers MB |
|---|---|---|---|---|
| before | 38.6 | 4.5 | 1.9 | 0.2 |
| iter 50 | 151.1 | 3.7 | 61.9 | 1.0 |
| iter 100 | 77.1 | 3.7 | 19.0 | 2.2 |
| iter 150 | 149.8 | 3.7 | 61.5 | 6.9 |
| iter 200 | 172.6 | 3.7 | 70.4 | 6.4 |
| iter 250 | 92.5 | 3.7 | 27.6 | 1.2 |
| iter 300 | 92.5 | 3.7 | 27.6 | 1.2 |
| after gc / +2 s | 61.2 | 3.7 | 10.3 | 1.0 |

300 iterations in 16.8 s; mean per iteration capture+toRaw 24.4 ms, toGrayScaled 6.9 ms, matchMap 0.20 ms. `heapUsed` is flat; `rss`/`external` oscillate between ~60 and ~170 MB (up to ~8 frames of native pixel buffers awaiting finalization — `global.gc()` runs the collection but NAPI finalizers release the native memory afterwards) and fall back to 61 MB / 10 MB. No monotonic trend: **stable**.

`node_modules/node-screenshots/index.d.ts`: `Image`, `Monitor`, `Window` expose **no** dispose/free/close API; native memory is released by the NAPI finalizer when the JS object is collected. The runtime holds `image` and `raw` only as locals of `tick()` (`src/core/map-detector.js:279`, `:290`) and keeps nothing from the frame beyond the tick (only `lastTiming`, `:298`, a single replaced object), so references are dropped as promptly as the API allows.

## 4. Code review

Ordered most severe first. Nothing CONFIRMED as a leak.

1. **SUSPECTED, minor, bounded by user actions** — `src/js/maps.js:111` `invalidateCache()` replaces `this.thumbnails = {}` without revoking the object URLs it created at `:137` (`URL.createObjectURL(new Blob([data]))`, one per catalogue entry, 220–313 KB each for the shipped PNGs). Every custom-map add/delete strands one set of blob URLs in the main-window renderer for the window's lifetime. Not time-driven, not exercised by the soak; ~1 MB per add/delete with the current 4 maps.
2. **OBSERVED, not a leak** — per-`map-change` accumulation of ~0.3 MB in main + ~0.3 MB in the overlay renderer until a renderer GC (run 2b). `src/core/main-window.js:139` and `:144` also build the base64 string twice per change (two ~400 KB strings, transient). The OBS renderer (`src/map/renderer_obs.js:3-9`) has the same revoke-then-create pattern and would behave the same; it was not open during the tests.
3. **OK** — object URLs: `src/map/renderer.js:34-39` and `src/map/renderer_obs.js:4-9` revoke the previous URL before creating the next on every change; the `map-hide` path keeps the last URL (one blob, replaced on the next change).
4. **OK** — `ipcRenderer.on` registrations happen once: `src/js/maps.js:45-90` inside `init()` called from the constructor (`:22`); `src/js/detector.js:24` inside `init()` called once from `src/renderer.js:56`; `src/renderer.js:13`, `:35`; `src/js/hotkeys.js:209`, `:214` inside `loadHotkeys()` (called once at `src/renderer.js:55`); `$(document).on('keydown'|'click')` at `src/js/hotkeys.js:260`, `:299` inside `loadCapture()`, called once (`:207`). Gallery/table handlers are attached to freshly built elements after `.empty()` (`src/js/maps.js:142-171`, `src/js/hotkeys.js:128-133` with `.off('click')`).
5. **OK** — detector timer chain: `schedule()` clears any pending timer before setting one (`src/core/map-detector.js:199-200`), so at most one timer exists; `tick()` is guarded by `busy` (`:262-263`) and always reschedules from `finally` (`:325-327`), which is a no-op once `running` is false (`:198`); `resetLastDetected()`'s `schedule(0)` (`:122`) during an in-flight tick just fires a tick that returns on `busy`. `stop()` clears the tick timer and the DEBUG-only lag interval (`:179-183`) and is called from `before-quit` (`index.js:117`) and from the update install path (`main-window.js:318` in `c3f12ff`; `runShutdownHooks()` in `f3168b7`). Both `stop()`/`start()` are idempotent (`:141`, `:184`).
6. **OK** — status/timing structures are scalars or one replaced object: `lastTiming` (`:298`), `lastErrorAt`/`lastMissingAt` timestamps used by the 60 s `logState` throttle (`:215-220`), `lastDetected/lastAt/lastScore`. Templates are built once as `Float32Array` in the constructor (`:88-91`). The 200 ms lag probe only exists with `DEBUG=true` (`:161`).
7. **OK** — overlay window: the 1 s `setAlwaysOnTop` interval (`src/core/overlay-window.js:58-62`) is cleared in `close()` (`:108-111`), and `show()` returns early while the window exists (`:21-24`), so a second interval cannot be created on Windows (only `close()` destroys the window). Measured cost is inside the ≤0.3 % idle main-process CPU of run 2. Theoretical edge only: if the window were destroyed by some other path, `show()` would overwrite `_alwaysOnTopInterval` and orphan the old interval (which then only runs an `isDestroyed()` check).
8. **OK** — `globalShortcut.unregisterAll()` is the first line of `loadKeys()` (`src/core/hotkeys.js:311-312`), so every reload starts from zero; the dry-run probe unregisters its test binding (`:200`).
9. **OK** — toast timeout cleared before re-arm (`src/renderer.js:15-18`); overlay label timer cleared before re-arm and on hide (`src/map/renderer.js:18-30`, `:59`); the 15 s FAQ-warning timer (`src/renderer.js:76`) is one-shot.
10. **OK** — no growing log arrays anywhere: logging is `console.*` only, and the repeating detector states are throttled to once a minute (`map-detector.js:215-220`). `src/js/logger.js` is a plain `console.debug` pass-through.
11. **OK** — other checked spots: updater listeners bound once via `MainWindow._updaterBound` (`main-window.js:263`); tray menu rebuilt only on `setUpdatePending` (`tray.js:45`), not periodically; `MapLibrary` caches one catalogue array (`map-library.js:66-71`); `Settings.set` on overlay drag writes the file twice per `moved` event (`overlay-window.js:70-71`) — I/O churn, not memory.

## Not measured / limitations

- The real in-Electron capture path: the game was not running, so every tick returned after `Window.all()` (`map-detector.js:233-236`). node-screenshots' `appName()` is the executable's localized version-info description (it reported "Esplora risorse" for Explorer), so a renamed helper cannot be made to match `/^halloween(\.exe)?$/i`. The capture + match memory behaviour is covered only by run 3 (plain Node, 300 captures of a different 1920x1032 window).
- Detection hits (`show-map-command` with `mapLabel`, the 3 s label timer) and the 5 s post-detection cadence.
- The OBS window (`renderer_obs.js`) was never opened; the settings preview path (`options.js:185`) and custom-map add/delete (finding 1) were not exercised.
- Runs were 6/2/3/4 min; nothing longer. GC timing in the overlay renderer was observed once (after ~85 rapid changes); at the real cadence of a few changes per match the accumulation before that GC stays in the tens of MB at most.
- Idle-CPU 2.4–3.5 % in main during the last 45 s of run 2 is unexplained (no test input of mine at that time; possible user mouse/keyboard activity on the desktop was not tracked).

## Cleanup

Test trees 6840 (ON) and 10912 (OFF) were killed with `taskkill /F /T`; final check: 0 processes from `dist\win-unpacked`, 0 with the scratch `--user-data-dir`, 0 sampler/cycler PowerShell children, 0 `Halloween.exe` helper, and 0 `Halloween Map Overlay.exe` processes of any origin on the machine. Scratch files live under the session scratchpad (`memrev\`), nothing was written to the real userData or to any project file other than this report.
