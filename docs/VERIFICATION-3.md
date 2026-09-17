# Independent verification, third pass — Halloween Map Overlay 0.2.0 (phase 2: automatic map detection)

Reviewer: independent, no stake in the outcome. `docs/DEV-REPORT.md` and commit messages were not used as evidence; every claim below was re-run or re-read. Environment: Windows 11 Pro 10.0.26200, Node 24.19.0, Electron 40, Git Bash. HEAD `35caa07` == `origin/main`. No GUI interaction possible; the game was **not** running during this pass (the owner's installed app was left untouched — every Electron instance below ran with its own `--user-data-dir` and was killed by PID tree only).

## Verdict

**SHIP** — the detector does what the spec and the docs say, all six previous findings are fixed, tests pass (98/98) with the margins reproduced, the packaged build loads the native capture module from `app.asar.unpacked`, and adding a map is genuinely data-only (verified in a clean clone, including the correct test failure for an ambiguous template). The one code-vs-doc mismatch (the "5 s after detection" poll period, F1) is a one-line correction to make in the release commit; nothing blocks the `v0.2.0` tag.

## Previous findings (VERIFICATION-2 N1–N6) → status

| # | Finding | Status | Evidence |
|---|---|---|---|
| N1 | Portable build ran the update check | **FIXED** | `src/core/main-window.js:216-219` `if (process.env.PORTABLE_EXECUTABLE_DIR) { console.log('Update check skipped: portable build.'); return; }` before the settings check and before any `autoUpdater` call. |
| N2 | `.claude/settings.local.json` packaged into the asar | **FIXED** | `package.json` `build.files` now has `"!.claude/*"`, `"!.claude/**"`. `npx @electron/asar list dist/win-unpacked/resources/app.asar` (rebuilt 12:41, 1078 entries) → 0 entries matching `claude`; also 0 entries for `detection-fixtures`, `docs`, `scripts`, `test`. `app.asar.unpacked/node_modules/node-screenshots-win32-x64-msvc/node-screenshots.win32-x64-msvc.node` is present on disk (plus its `package.json`). |
| N3 | Release would be created as a draft | **FIXED** | `package.json` `build.publish.releaseType: "release"`; `AGENTS.md` "Releasing" documents why. |
| N4 | Spurious "already taken" toast + triple `loadKeys` on save | **FIXED** (static) | `src/core/hotkeys.js:184-185` `rejectIfUnregisterable` returns `null` immediately for anything in `ownAccelerators()` (`:210-214`, system hotkeys + `hotkeys.json`); the success path no longer calls `loadKeys()` (`:197-203`). |
| N5 | Doc contradictions | **FIXED** | `AGENTS.md:12-19` now states the two outside contacts (update check, opt-in capture); `DEV-REPORT.md:666` "No auto-update" struck through and superseded; `grep -n "No network calls" AGENTS.md` → nothing. Remaining nits are listed under F3. |
| N6 | Modifier rule only enforced in the renderer | **FIXED** | `src/core/hotkeys.js:36-38` (`save-hotkeys`) and `:97-99` (`save-system-hotkey`) both `fail()` on `!hasModifier(...)` before any write; `hasModifier` is the pure helper in `hotkeys-constants.js`, covered by 3 tests. |

## Phase-2 findings (most severe first)

### F1. CONFIRMED (low) — "5 s after a detection" is only true while the Tab screen stays open
- `src/core/map-detector.js:264` re-initialises `let interval = SEARCH_INTERVAL` on every tick and only sets `DETECTED_INTERVAL` at `:308` inside the match branch. The first tick after the player closes the Tab screen gates out (`:303-306`) and reschedules at 2000 ms. In practice the loop polls every 2 s for the whole match; the 5 s period applies only to consecutive ticks that still see the same Tab screen.
- Contradicts `README.md:67-69` ("every 5 seconds once it has recognised a map"), `AGENTS.md` ("Poll 2000 ms while searching, 5000 ms after a hit") and `docs/SPEC-DETECT.md:78` (which still says 4000 ms). The user-facing privacy sentences (FAQ, README "Does it take screenshots?") say "every 2 seconds", which is what happens, so the mismatch is in the conservative direction.
- Fix: either drop the 5 s claim from README/AGENTS, or keep a `this.lastDetected ? DETECTED_INTERVAL : SEARCH_INTERVAL` default at `:264` so the documented behaviour is the real one (the `clear-map` reset already schedules an immediate tick, so responsiveness after Ctrl+Shift+D is unaffected).

### F2. INFO — `prepare-detector` output is content-idempotent but always writes LF
- In a fresh clone (`core.autocrlf=true` on this machine) the checked-out `templates.json` has CRLF; `npm run prepare-detector` on unchanged fixtures rewrote it with LF (`scripts/prepare-detector.js:250` writes `'\n'`). `git status` then shows ` M src/core/map-detector/templates.json` while `git diff --stat` is **empty** (Git's "LF will be replaced by CRLF" warning). The committed blob is LF (`git ls-files --eol` → `i/lf w/lf`), so nothing changes in a commit; it only looks modified until Git touches the file. Not a bug; a `.gitattributes` line (`*.json text eol=lf`) would remove the confusion.

### F3. INFO — Stale comments/spec lines
- `src/core/settings.js:14-15`: "it takes a screenshot of the selected display every 1.5 s" — it captures the game window every 2 s.
- `docs/SPEC-DETECT.md:78` "4000 ms after a successful detection" (code: 5000) and `:146` "(`desktopCapturer` works when packaged)" — the revised capture section of the same file bans `desktopCapturer`. Spec, not user-facing.
- The two "stutter" mentions in `src/core/map-detector.js:55,156` are code comments explaining why `desktopCapturer` was dropped, not leftover claims; `src/index.html:6` "no network calls" is the CSP comment about the window's `connect-src` (same as last pass).

### F4. INFO — `map-detector-reset` while a capture is in flight loses the "immediate" tick
- `resetLastDetected()` (`map-detector.js:122`) calls `schedule(0)`; if a tick is mid-`await` (`busy`), the 0 ms tick returns at `:262` without rescheduling and the in-flight tick's `finally` (`:325`) reschedules at its own interval (2–5 s). The reset itself (`lastDetected = null`) still takes effect, so the same map is re-detected on the next tick; only the "now rather than in 5 s" promise slips. Harmless.

### F5. INFO — Test coverage shape
- The four `cropped fixture:` tests match the template against the very pixels it was generated from (`test/map-detector.test.js:292-306`: `locatePanel` + `cutSquare` = the generator's cut), hence the 1.0000 scores. The non-trivial positives (0.985–0.996 with runner-up ~0.50) all come from the single full-frame fixture, i.e. from Haddonfield Heights only. The gate and negatives are exercised on all three non-Tab fixtures. Worth a full-frame fixture per map when the owner has them; not a blocker.

## Detector code review (task 3) — checked, no defects

- No `desktopCapturer` anywhere in `index.js`, `src/`, `scripts/`, `test/` (only two explanatory comments). Capture is `Window.all()` → `captureImage()` → `toRaw()` (`map-detector.js:233,277,288`).
- `findGameWindow` (`:231-259`): skips minimized, `pid === process.pid`, `< 320x240`, and anything whose `appName + title` matches `/map\s*overlay/i`; exact `/^halloween(\.exe)?$/i` on **appName** wins; a looser app-name match is a fallback; the **title** is consulted only when `appName` is empty. Verified on this machine with the perf script: the terminal window titled "◑ Halloween The Game mappe" enumerates with appName "Windows Terminal Host" and is not selected. The installed game's `Halloween.exe` (`...\steamapps\common\Halloween\Ravage\Binaries\Win64\`) has `FileDescription='Halloween'`, which is the string node-screenshots reports as appName for the other processes seen ("Esplora risorse", "Floorp", "Slack"), so the exact-match branch is expected to hit when the game runs (not observed live — game not running).
- No game window → `logState('lastMissingAt', …)` and return (`:269-275`); `logState` (`:215-220`) suppresses repeats for 60 s. Dev run: 16 ticks in 32 s produced exactly one "game window not found" line.
- Chained `setTimeout` (`:197-201`), 2000 ms searching, 5000 ms after a hit (see F1 for the caveat); `busy` flag prevents overlap; `tick()` wraps everything in `try/catch/finally` (`:266-326`) — an error is throttled via `logState` and the loop reschedules.
- Switch only on `match.key !== this.lastDetected` (`:311-320`); manual picks never touch the detector (`src/js/maps.js` `sendMap` does not talk to it); `clear-map` → renderer `ipcRenderer.send('map-detector-reset')` (`maps.js:90-94`) → `resetLastDetected()` (`map-detector.js:110,114-123`).
- Nothing persists a frame: `image`/`raw` are locals of `tick()`; only `lastTiming`, `lastScore`, `lastAt`, `lastDetected` survive; no `fs`, no `net`, no `fetch` in the detector files.
- `stop()` clears the timer and the lag probe, sets `running=false`; an in-flight tick checks `this.running` after each `await` (`:278,289`) and `schedule()` is a no-op when stopped. `index.js:111-114` calls `mapDetector.stop()` on `before-quit`.
- `mapDetection` default `false` (`src/core/settings.js:16`); `index.js:93` `syncWithSettings()` at `whenReady` → starts at launch when true (confirmed at runtime: "Map detection started (4 templates, every 2000 ms)." before the renderer was ready).
- Matcher: `ncc` (`matcher.js:309-323`) returns 0 for zero variance and clamps to [-1,1] (test "constant image gives 0, not NaN" passes); gate thresholds `:95-98` (dark ≥ 0.90 at level 0.06, name box ≥ 0.02 bright at 0.35) sit between the measured 0.99 vs ≤0.65 and 0.09 vs 0.00; `DEFAULT_OFFSETS` (`:81-84`) 15 offsets, dy ±2 %, dx ±1.5 %; `cropRegion` (`:221-232`) clamps every offset region inside the frame, so a shifted region can never index out of bounds.
- `templates.json` keys == catalogue keys (`test "templates.json: one 64x64 template per template fixture, keyed by catalogue key"` also asserts the keys equal the fixture set); `size: 64`, 4 × 4096 values.

## Tests (task 1)

`npm test` → **98 pass / 0 fail** (escape-html 6, hotkeys-defaults 23, map-catalog 18, map-detector 37, overlay-position 14), 2.5 s. Fixture table as printed by the suite:

```
fixture                                             expected                detected                  score    runner-up  margin
window 1920x1080 → 640x360 (runtime path)           Haddonfield Heights     Haddonfield Heights       0.9853   0.5009     0.4845
window 1280x720 → 640x360 (runtime path)            Haddonfield Heights     Haddonfield Heights       0.9909   0.5008     0.4900
window 2560x1440 → 640x360 (runtime path)           Haddonfield Heights     Haddonfield Heights       0.9872   0.5010     0.4862
tab-fullscreen-haddonfield-heights.png              Haddonfield Heights     Haddonfield Heights       0.9959   0.5041     0.4919
tab-east-haddonfield.png                            East Haddonfield        East Haddonfield          1.0000   0.5010     0.4990
tab-haddonfield-heights.png                         Haddonfield Heights     Haddonfield Heights       1.0000   0.5010     0.4990
tab-haddonfield-town-center.png                     Haddonfield Town Center Haddonfield Town Center   1.0000   0.4833     0.5167
tab-orange-grove-estates.png                        Orange Grove Estates    Orange Grove Estates      1.0000   0.4578     0.5422
tab-fullscreen-haddonfield-heights.png @ 1280x720   Haddonfield Heights     Haddonfield Heights       0.9932   0.5033     0.4899
tab-fullscreen-haddonfield-heights.png @ 2560x1440  Haddonfield Heights     Haddonfield Heights       0.9935   0.5047     0.4888
tab-fullscreen-haddonfield-heights.png @ 640x360    Haddonfield Heights     Haddonfield Heights       0.9908   0.5021     0.4887
tab-fullscreen-haddonfield-heights.png shifted -2%  Haddonfield Heights     Haddonfield Heights       0.9959   0.4995     0.4964
tab-fullscreen-haddonfield-heights.png shifted -1%  Haddonfield Heights     Haddonfield Heights       0.9959   0.5041     0.4919
tab-fullscreen-haddonfield-heights.png shifted +1%  Haddonfield Heights     Haddonfield Heights       0.9959   0.5041     0.4919
tab-fullscreen-haddonfield-heights.png shifted +2%  Haddonfield Heights     Haddonfield Heights       0.9959   0.5041     0.4919
gameplay-civilian.png                               null                    GATED OUT                 —        —          —
gameplay-killer.png                                 null                    GATED OUT                 —        —          —
menu-main.png                                       null                    GATED OUT                 —        —          —
gameplay-civilian.png (gate off)                    null                    Haddonfield Heights (rejected) 0.0948 0.0789 0.0160
gameplay-killer.png (gate off)                      null                    East Haddonfield (rejected)    0.1345 0.1233 0.0113
menu-main.png (gate off)                            null                    East Haddonfield (rejected)    0.2794 0.2447 0.0347
```

## Data-only map addition (task 4)

Fresh `git clone` of the repo into `%TEMP%\hmo-clone-sim` (HEAD `35caa07`), `npm ci` (clean), then:

- **A. Unchanged fixtures:** `npm run prepare-detector` → same four templates, same panel offsets as the committed file (`dx/dy` 257/146, 255/148, 261/149, 251/146); `git diff --stat` empty (see F2 for the EOL note). Idempotent in content.
- **B. Fake 5th map:** copied `East Haddonfield.png` → `maps/deftyconchgaming/Test Map.png` and `tab-east-haddonfield.png` → `detection-fixtures/tab-test-map.png`. `npm run prepare-detector` printed `tab-test-map.png 766x766 at 630,11 (dx=257 dy=146) -> deftyconchgaming/Test Map` and wrote **5 templates**; keys: the four originals + `deftyconchgaming/Test Map`. No source file edited.
- **C. `npm test`:** the suite discovered the new fixture on its own (`cropped fixture: tab-test-map.png detects Test Map` appeared) and **failed, correctly**, on exactly the two ambiguous tests: `tab-east-haddonfield.png detects East Haddonfield` → "not accepted" (margin 0 against the duplicate) and `tab-test-map.png detects Test Map` → detected `East Haddonfield` instead. Every other test passed; exit code 1. A duplicate template cannot slip through silently.
- Clone deleted afterwards; the project tree was not touched (`git status` clean before this file was written).

## Runtime (task 5)

- **Dev** (`node_modules\electron\dist\electron.exe .`, PID 15676, `DEBUG=true`, `--user-data-dir=<scratch>/ud-dev` with `{"mapDetection": true}`, 32 s): stdout `Update check skipped: not a packaged build.` → `Map detection started (4 templates, every 2000 ms).` → one `Map detection: game window not found — is Halloween: The Game running?` (no repeat in 32 s) → `[renderer] detector::init {"running":true,…,"templates":4}` → `renderer::ready maps=4 cards=4 customs=1` → `event-loop peak drift over the last 10 s: 24 / 16 / 15 ms`. **stderr empty**, no `renderer::uncaught`, no `unhandled-rejection`. Alive at 32 s; killed with `taskkill /F /T /PID 15676` (6 processes, all children of that PID). No per-tick `enumerate=… capture=…` lines — they are only emitted after a capture, and the game was not running.
- **Packaged**: `dist/` predated the last source change (`app.asar` 12:31:48 < `src/index.html` 12:34:26; the commits after the previous build touched `AGENTS.md`, `README.md`, `DEV-REPORT.md`, `src/index.html`), so `npm run build:win` was re-run first (exit 0, 12:41; `latest.yml` version 0.2.0). Then `dist\win-unpacked\Halloween Map Overlay.exe` (PID 18552, same flags, `ud-pkg`, 32 s): `Map detection started (4 templates, every 2000 ms).`, one "game window not found" line (so `Window.all()` — the native module from `app.asar.unpacked` — ran without error), `renderer::ready maps=4 cards=4 customs=1` from `resources\app.asar`, drift 16 / 14 / 15 ms, `Checking for update` → the expected `Error: No published versions on GitHub` on stderr (no release exists) logged twice as before. Alive at 32 s; killed by PID tree.

## Performance (task 6)

Scratch Node 24 script (not Electron) requiring the project's `node-screenshots` and `matcher.js`, 10 iterations per window, medians. `Window.all()`: 5 windows in 0.31 ms. Machine was also running electron-builder at the time.

| window (1920x1032, 3:1 fast path) | `captureImage()` | `toRaw()` | `toGrayScaled` → 640x344 | `matchMap` |
|---|---|---|---|---|
| Floorp (first non-minimized) | **18.5 ms** (16.5–20.6) | **2.5 ms** | **5.5 ms** (5.3–8.8) | **0.25 ms** (0.11–1.81) |
| Windows Terminal ("◑ Halloween The Game mappe") | **17.1 ms** (16.4–18.7) | **2.6 ms** | **5.4 ms** (5.3–7.4) | **0.13 ms** |

Consistent with the claimed 16.6 / 2.3 / 5.6 / 0.1–0.9 ms. The JS that blocks the main thread per tick is ~6 ms on the fast path; the Electron lag probe confirmed 14–24 ms peak drift with the loop running (idle baseline).

## Renderer (task 7)

- `src/js/detector.js:26-35` switch → `invoke('map-detector-start'|'map-detector-stop')` (which persist `mapDetection` in main, `map-detector.js:95-104`); `:24` `map-detector-status` push → `render()`; `:37` one `invoke('map-detector-status')` at init. Status strings "Off" / "Watching for the in-game map (Tab)…" / "Detected <Map> at HH:MM" (`:62,66,75`, `.text()`).
- Overlay label: `src/map/renderer.js:16-31` `showLabel(name, opacity)` sets `opacity` from the map's own opacity, hides after `LABEL_MS = 3000`; called with the 6th `map-change` arg (`:52`) and with `""` on `map-hide` (`:59`); `#mapLabel` exists in `src/map/map.html:46` with `pointer-events: none`. Main only forwards the label when `!opts.preview` and it is a string (`main-window.js:119`), and sends `''` when `hideOverlay` is on (`:123`). Only `show-map-command` with `fromDetector` produces one (`maps.js:54`).
- `clear-map` in `SYSTEM_HOTKEY_DEFS` (`hotkeys-constants.js:36-41`, `CommandOrControl+Shift+D`), settings key `hotkeyClearMap` (`settings.js:27`), registered by `registerSystemHotkeys` (`core/hotkeys.js:281-286`), handled by `ipcRenderer.on('clear-map')` (`maps.js:90-94`), listed in the Hotkeys tab (`src/js/hotkeys.js:106` iterates the defs).
- Scripted check: 106 `require` calls, 0 missing relative modules; external packages all in `package.json` and installed; every `#id` referenced from `src/renderer.js`, `src/js/*.js`, `src/map/renderer*.js` exists in the corresponding HTML; all five system actions have a renderer handler.

## Docs (task 8)

- README `:8-13`, `:51-85` (Auto-detect), `:208-212` FAQ and `src/index.html:421-427` all say: off by default, captures **the game's own window** every 2 s **only while the game is running**, compared locally, nothing stored or sent. `grep -rniE "KNOWN ISSUE|never takes screenshots|no network calls"` over README/AGENTS/src/NOTICE → nothing user-facing (see F3).
- README hotkey table `:33-43`: Ctrl+H, Ctrl+R, Ctrl+→, Ctrl+←, **Ctrl+Shift+D**, then Ctrl+1..4 in catalogue order (East Haddonfield, Haddonfield Heights, Haddonfield Town Center, Orange Grove Estates) — matches the runtime line `Wrote default map hotkeys: CommandOrControl+1..4`.
- "Adding a map": README `:170-193` and AGENTS.md "Adding a map (data only — no code change)" describe the same four steps that task 4 exercised (`maps/<Creator>/<Map>.png`, `detection-fixtures/tab-<slug>.png`, `npm run prepare-detector`, `npm test`), and the "map with no fixture fails the suite" claim is backed by the test at `map-detector.test.js:433-441`.
- `package.json` version `0.2.0`; `.github/workflows/release.yml` unchanged since the previous pass (tags `v*` only, `contents: write`, `windows-latest`, Node 22, `npm ci` → `npm test` → `electron-builder --win --publish always`), valid YAML.

## Git hygiene (task 9)

`git fetch` → HEAD `35caa07` == `origin/main`. All 8 commits author **and** committer `Davide-DevP <Davide-DevP@users.noreply.github.com>`. `git tag` empty, `git ls-remote --tags origin` empty, `gh release list` empty. `git status --porcelain` clean before this report was written (the only change this pass makes to the tree is this file). `dist/` is git-ignored and was rebuilt.

## Not verifiable here (and why)

- A real detection: the game was not running, so no `captureImage()` of `Halloween.exe`, no per-tick `enumerate=… capture=… match=…` line inside Electron, no overlay label on screen, no `Map detected:` line. The appName match rests on the exe's `FileDescription='Halloween'` and on node-screenshots reporting `FileDescription` for the other processes observed. Whether EasyAntiCheat (the game ships `start_protected_game.exe`) interferes with window capture was not tested.
- Clicking the switch, the toast, the Hotkeys tab — all traced to IPC handlers that were exercised from the main side or by the runtime status push.
- The release workflow has still never run; `npm ci` + `npm test` were simulated in a clean clone on this machine (Node 24, npm 11), not on `windows-latest`/Node 22.
- Linux/Wayland path; the NSIS installer and portable exe were built (12:41) but not executed.
