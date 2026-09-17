# AGENTS.md — Halloween Map Overlay

## Project

Transparent in-game map overlay for **Halloween: The Game**. Electron desktop
app (Windows first, Linux works). Four community maps ship inside the app; the
user picks one and it appears on a click-through always-on-top window. OBS
window with a green background for streamers.

- **License**: Apache-2.0
- **Derived from**: `LucaFontanot/dbd-map-overlay` (Apache-2.0) — see `NOTICE`
- **Scope rule**: this is a *map viewer*. No telemetry, no memory reading,
  nothing that touches the game process. It makes exactly two kinds of outside
  contact, both opt-out/opt-in and both documented in the README and the in-app
  FAQ: the GitHub Releases update check (on by default, Settings › General) and
  the automatic map detection's screen capture (**off** by default, home-page
  switch). Adding a third needs the README "Network use" / "Auto-detect"
  sections and the FAQ changed in the same commit. Anything that would need to
  read the game's memory or inject into it is out of scope, not a TODO.

## Stack

| Layer | Tech |
|-------|------|
| Runtime | Electron 40 (Node.js, Chromium) |
| Frontend | HTML/CSS/JS, Bootstrap 5, jQuery 4, Popper 2 |
| Image sizing | `image-size` (runtime), `sharp` (dev only, map prep) |
| Screen capture | `node-screenshots` (runtime, prebuilt NAPI, asarUnpacked) |
| Build/packaging | electron-builder (NSIS + portable) |
| Package manager | npm |

## Architecture

```
index.js                        → Entry point. Wayland → X11 respawn.
                                  Single-instance lock (`show-map=` arg).
                                  Builds every module and wires them together.
src/core/main-window.js         → Main BrowserWindow + IPC hub. `map-change`
                                  reads the image, sizes/positions the overlay,
                                  forwards base64 to overlay + OBS windows.
src/core/overlay-window.js      → Transparent click-through always-on-top window.
src/core/overlay-position.js    → PURE positioning math (corner preset + glide %
                                  + rotated bounding box). Unit tested.
src/core/obs-window.js          → Green-background window for OBS capture.
src/core/map-library.js         → File-system side of the catalogue: maps root,
                                  directory listing, key → absolute path.
src/core/map-catalog.js         → PURE catalogue: build from a listing, fuzzy
                                  key matching, next/prev, custom merge. Tested.
src/core/map-detector.js        → Automatic map detection loop (main process):
                                  node-screenshots game-window capture →
                                  matcher → show-map-command.
                                  IPC start/stop/status. Off by default.
src/core/map-detector/matcher.js→ PURE matcher: grayscale, relative crop,
                                  64x64 area downsample, gradient magnitude,
                                  zero-mean NCC, Tab-screen gate. Tested.
src/core/map-detector/templates.json → Generated, committed. 64x64 thumbnail
                                  per map, keyed by catalogue key.
src/core/hotkeys.js             → globalShortcut registration + hotkeys.json.
src/core/settings.js            → settings-app.json in userData, defaults merged.
src/core/user-data.js           → userData `custom/` read/write/delete/list.
src/core/tray.js                → System tray icon and menu.
src/core/utils.js               → fs helpers (recursive listing, mkdir).
src/core/is-wayland.js          → Wayland session detection.
src/shared/hotkeys-constants.js → PURE hotkey defs + first-run map-hotkey
                                  defaults + accelerator formatting. Tested.
src/index.html                  → Main window markup (dark Bootstrap).
src/renderer.js                 → Renderer entry: builds the renderer modules.
src/js/maps.js                  → Gallery, current map, hotkey/CLI dispatch.
src/js/options.js               → Settings modal (General + Overlay tabs).
src/js/hotkeys.js               → Hotkeys tab: tables, editing, key capture.
src/js/custom.js                → "Add custom image" modal.
src/js/detector.js              → Home-page auto-detect switch + status line.
src/js/overlay-preview.js       → Canvas sample image for the Overlay tab.
src/js/settings.js              → Renderer mirror of the settings file.
src/js/logger.js                → debugLog.
src/map/map.html, renderer.js   → Overlay window.
src/map/map_obs.html, renderer_obs.js → OBS window.
maps/<Creator>/<Map>.png        → Shipped maps (electron-builder extraResources).
                                  Currently one creator: `deftyconchgaming`.
maps-src/*.webp                 → Untouched originals; input to prepare-maps.
scripts/prepare-maps.js         → Dev only: crop maps-src → maps/, render icons.
scripts/prepare-detector.js     → Dev only: detection-fixtures → templates.json.
                                  Also exports `locatePanel` — the tests use it.
detection-fixtures/*.png        → Game screenshots: template sources and the
                                  detector's test matrix. Never packaged.
test/                           → node:test unit tests for the pure modules.
```

## Key patterns

- **No TypeScript, no bundler** — plain CommonJS (`require`/`module.exports`).
- **No context isolation** — `nodeIntegration: true`, `contextIsolation: false`.
  jQuery/Bootstrap are pulled in with `require` from `<script>` tags in the HTML.
  Bootstrap's CSS is loaded from `../node_modules/bootstrap/dist/css/` — it is a
  production dependency, so it is inside the asar in packaged builds. **Never
  add a CDN link**; the app must work offline.
- **IPC**: `ipcMain.handle`/`ipcMain.on` in main, `ipcRenderer.invoke`/`.on` in
  the renderer. The renderer never reads a map file itself; it asks main.
- **Map key format**: `Creator/Map Name` — no realm level, no extension,
  case-insensitive. The folder name *is* the creator, and the shipped maps are
  by u/deftyconchgaming, so keys read `deftyconchgaming/East Haddonfield`.
  Custom (user-imported) maps use the reserved creator `Custom` and live flat
  in userData `custom/`. Renaming a creator folder does **not** break existing
  `hotkeys.json` entries: `findClosestMapMatch` still resolves them on the map
  name (covered by a test).
- **Maps root**: `app.isPackaged ? path.join(process.resourcesPath, "maps")
  : path.join(global.dirname, "maps")` (`map-library.js`). `global.dirname` is
  set at the top of `index.js`.
- **Pure vs impure**: `map-catalog.js`, `overlay-position.js`,
  `hotkeys-constants.js` and `map-detector/matcher.js` import nothing from
  electron or `fs`. Keep them that way — they are the only parts covered by
  tests. `map-library.js` is the
  fs-facing wrapper around `map-catalog.js`; put new file-system logic there.
- **Name folding / matching**: `foldName`, `levenshtein` and
  `findClosestMapMatch` in `map-catalog.js` are the single source. Do not
  re-implement name normalisation or edit distance anywhere else.
- **`map-change` payload**: a catalogue key, a custom-map file name, or raw
  base64. Main resolves keys via `MapLibrary.resolve()` and treats anything it
  cannot resolve as base64. `{preview: true}` forces the base64 path (the
  settings preview is canvas-rendered in the renderer) and keeps the image off
  the OBS window so it can never leak into a stream.
- **Overlay quirks that must not be "cleaned up"** — each one is load-bearing:
  - `alwaysOnTop` level `pop-up-menu` on win32 (`screen-saver` is ignored there)
    and **re-asserted every second**, or a fullscreen game pushes it behind.
  - `setIgnoreMouseEvents(true, {forward: true})`, `focusable: false`,
    `skipTaskbar: true` — otherwise the overlay eats the player's clicks.
  - The window is sized to the **rotated** bounding box, `+5` px wide and
    `*1.1` tall, so rotated maps do not clip.
- **Catalogue caching**: `MapLibrary` caches the listing. Anything that adds or
  deletes a custom map must call `invalidate()` — `user-data.js` already does.
- **First-run hotkeys**: `hotkeys.json` is written once, only when absent
  (`Hotkeys.ensureDefaultMapHotkeys`), from the pure
  `buildDefaultMapHotkeys(catalog, makeId)`, which hands Ctrl+1..Ctrl+9 to the
  first nine **shipped maps in catalogue order** (creator, then map name).
  There is deliberately no hand-maintained map list — a new map gets its number
  from the catalogue. A user who deleted every binding keeps it deleted.
- **Hotkey priority**: system hotkeys register first. Saving a per-map hotkey
  that matches a system one is refused (`Hotkeys.systemConflict`), and a stale
  colliding entry already in `hotkeys.json` is skipped at registration *and*
  reported in the status toast, so it is never silently inert.
- **Accelerators are never taken straight from the DOM.** A
  `KeyboardEvent.key` is not an Electron accelerator name (`ArrowRight` vs
  `Right`, `" "` vs `Space`, `"+"` vs `Plus`), and `globalShortcut.register`
  **throws** on a name it cannot parse — which aborts every registration after
  it in `loadKeys`, so one bad saved binding disables all remaining hotkeys on
  every future boot. Three layers stop that, keep all three:
  1. `keyEventToAccelerator` (pure, in `hotkeys-constants.js`, unit tested)
     translates the event and refuses unmapped keys *and* modifier-less ones.
  2. `Hotkeys.rejectIfUnregisterable` dry-runs `globalShortcut.register` in a
     try/catch before anything is written to settings or `hotkeys.json`.
  3. `Hotkeys.safeRegister` wraps every real `register` call, so even a file
     hand-edited to garbage only loses that one binding.
- **Escape user text before it reaches markup.** Custom map names are typed by
  the user and interpolated into the gallery, the custom list and the hotkey
  tables; with `nodeIntegration: true` an injected tag runs with Node access.
  Use `escapeHtml` (`src/shared/escape-html.js`) or build nodes with jQuery
  `.text()`/`.val()`/`.attr()`. Never interpolate a name raw.
- **Settings `get()` vs `raw()`**: the renderer's `Settings.get()` turns a
  stored `0`/`false`/`""` into `null`. Use `raw()` wherever a falsy value is
  meaningful (glide 0, rotation 0, monitor 0, every checkbox).
- **Settings are written one key at a time** (`set-setting`), never as a whole
  object. Main writes some keys itself and the renderer never reads them back —
  system hotkey accelerators (`core/hotkeys.js`) and `overlayX`/`overlayY` on
  drag (`overlay-window.js`). Posting the renderer's cached object would revert
  those the next time any slider moved. `save-settings` merges for the same
  reason, and `src/js/hotkeys.js` refreshes the renderer copy whenever
  `system-hotkeys-updated` arrives.
- **Single instance**: `app.requestSingleInstanceLock()`; a second launch passes
  `show-map=<key>` to the running instance and quits.
- **Wayland**: detected at startup, respawns with `--ozone-platform=x11`.
- **Auto-update**: `electron-updater` against GitHub Releases
  (`Davide-DevP/halloween-map-overlay`), started from `MainWindow.checkUpdates()`
  4 s after the window shows and reported through the `update-message` toast.
  Guarded by `app.isPackaged` — **do not** redefine `app.isPackaged` to test it
  the way the reference did; build a real package instead. Also guarded by the
  `checkForUpdates` setting (default true, Settings › General). Every error path
  only logs: being offline must never be more than a toast. This is the app's
  **only** network request — if you add another one, the README "Network use"
  section and the in-app FAQ both have to change.
- **Only the NSIS build self-updates.** The portable exe has nothing installed
  to replace; that is stated in the README. `app.isPackaged` is true in the
  portable build as well and electron-updater 6.x has **no** portable guard of
  its own, so `checkUpdates()` returns early when
  `process.env.PORTABLE_EXECUTABLE_DIR` is set (electron-builder's portable
  launcher always sets it). Without that check the portable user would get the
  NSIS installer downloaded and silently installed on quit while the portable
  exe stayed at the old version.
- **Hotkey dry run vs. our own bindings.** `rejectIfUnregisterable` probes an
  accelerator with `globalShortcut.register` while the app's real bindings are
  live, so probing one we already hold returns `false` and used to produce a
  bogus "taken by another application" toast. It now returns early for anything
  in `ownAccelerators()` (system hotkeys + `hotkeys.json`) — which also means a
  successful save runs `loadKeys()` once instead of three times.
- **The modifier rule is enforced on both sides.** `keyEventToAccelerator`
  refuses a modifier-less binding in the renderer, and `save-hotkeys` /
  `save-system-hotkey` re-check with the pure `hasModifier()`. With
  `nodeIntegration: true` the renderer is not a trust boundary, and Electron
  will happily register a bare `H` globally.

## Automatic map detection (phase 2)

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
  have it, two do not).
- **Two signals, not one.** The score is the mean of the NCC on luminance and
  the NCC on Sobel gradient magnitude. Luminance alone separates the maps
  (margin ~0.22) but leaves the runner-up at ~0.775 — right under the 0.80
  accept threshold, which is far too close for a real screen capture. With the
  gradient term the runner-up drops to ~0.50 and the margin doubles to ~0.49.
  Do not "simplify" this back to one signal.
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
- **Detection never fights the user.** A manual pick does not stop the loop; the
  loop only acts on a map *different* from `lastDetected`. Poll **2000 ms** while
  searching, **5000 ms** after a hit.
- **`clear-map` (Ctrl+Shift+D) is not `toggle-map`.** It hides the map *and*
  sends `map-detector-reset`, which clears `lastDetected` and schedules an
  immediate tick. Without the reset, hiding a detected map would leave the
  overlay blank for the rest of the match: the loop would keep seeing the same
  map, decide nothing changed, and never re-show it.
- **The overlay label rides on the existing `map-change` payload.** An automatic
  switch passes `{mapLabel}` from `Maps.sendMap` → main → the overlay's
  `map-change` as a 6th argument; `src/map/renderer.js` shows it for 3 s at the
  map's own opacity and clears it on the next `map-change` or `map-hide`. It is
  deliberately *not* a second IPC message — the overlay must never be able to
  name a map it is not showing. Manual picks send no label, and the settings
  preview never carries one.
- **Home-page status line**: "Off" / "Watching for the in-game map (Tab)…" /
  "Detected <Map> at HH:MM", driven by the `map-detector-status` push plus one
  `invoke` at startup.
- **`DEBUG=true` logs `enumerate=… capture=… match=… total=…` per tick** and an
  event-loop peak-drift line every 10 s. That instrumentation is what caught the
  original capture backend; leave it in.
- **Never keep a frame.** No disk, no network, nothing beyond the tick.

### The capture path — do not make it heavier

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

Where the remaining time goes (mean over 10 real 1080p window captures):
`Window.all()` 0.2 ms · `captureImage()` 16.6 ms (async, native — it does not
block the event loop) · `toRaw()` 2.3 ms · `toGrayScaled()` 5.6–11 ms ·
`matchMap()` 0.1–0.9 ms. So the JS that actually blocks the main thread is
~6–11 ms per tick.

Rules that keep it there:

- **`toGrayScaled` is the hot spot** — it is the only thing that touches all 2 M
  captured pixels. It fuses the luma conversion and the box average into one
  pass on purpose; splitting it back into `toGray` + `resample` doubles the
  reads and allocates an 8 MB intermediate. It also has a whole-number fast path
  (1920→640 and 1080→360 are both exactly 3:1, so that is what a borderless
  1080p game actually takes): 5.6 ms on the fast path, ~11 ms on the general
  one. A test asserts the two agree.
- **`node-screenshots` has no resize**, only `crop`. Cropping before `toRaw`
  would cut the pass down further, but the gate regions (left panel, name box)
  and the map panel span most of the frame, and cropping would invalidate the
  full-frame-relative regions the whole test suite is built on. Not worth it at
  6–11 ms.
- **No game window → return immediately.** Leaving the switch on while the game
  is closed costs one 0.2 ms window enumeration every 2 s. The "not found" state
  is logged at most once a minute (`logState`).
- If the JS half ever does grow past ~30 ms, move the loop into an Electron
  `utilityProcess` and pass results back over its MessagePort rather than
  trimming the match.

**Finding the game window** (`findGameWindow`): match on `appName()`, not
`title()`. Titles produce false positives constantly — during development a
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

## Adding a map (data only — no code change)

The game is getting more maps; adding one must never need an edit to a source
file. The whole procedure:

1. Put the overlay image at `maps/<Creator>/<Map Name>.png` (or drop the source
   in `maps-src/` and run `npm run prepare-maps` — see "Adding maps" below).
2. Put one Tab (Objectives) screenshot at
   `detection-fixtures/tab-<slug>.png`, where `<slug>` is the map name
   lower-cased with non-alphanumerics turned into hyphens
   (`Haddonfield Town Center` → `tab-haddonfield-town-center.png`). A full
   1920x1080 frame or a crop of the two panels both work — `locatePanel` finds
   the panel either way.
3. `npm run prepare-detector` → rewrites `src/core/map-detector/templates.json`.
4. `npm test` → the new map is already covered; the fixture list *is* the test
   matrix.
5. Credit the author in the Credits modal (`src/index.html`), `README.md` and
   `NOTICE` if the creator is new.

Everything else follows automatically: the gallery and the creator filter read
the `maps/` listing, `next`/`prev` cycle over the catalogue, the first nine maps
in catalogue order get Ctrl+1..Ctrl+9 on a fresh install, and the matcher
iterates over whatever `templates.json` holds.

Naming rules that make that work, do not break them:
- `detection-fixtures/tab-<slug>.png` → template source **and** a positive test.
- `detection-fixtures/tab-fullscreen-<slug>.png` → an extra full-frame positive
  test for that same map; **not** used as a template source (so a map can have
  both a crop and a full frame without producing two templates).
- Any other `detection-fixtures/*.png` → a **negative**: the detector must
  return null for it. That is where gameplay and menu screenshots go.
- The slug is resolved against the real catalogue with `findClosestMapMatch`,
  the project's single name matcher, so the creator comes from the `maps/`
  folder and the key can never drift. A slug that matches no map is ignored by
  the generator and fails `test/map-detector.test.js`
  ("every map in maps/ has a detection fixture").

## Commands

```bash
npm install
npm start              # dev run (DEBUG=true opens devtools and the menu)
npm test               # node --test over test/**/*.test.js
npm run prepare-maps   # crop maps-src/*.webp → maps/, render build+app icons
npm run prepare-detector # detection-fixtures/tab-*.png → templates.json
npm run build:win      # NSIS installer + portable exe into dist/
```

## Releasing

`.github/workflows/release.yml` runs on a pushed `v*` tag only — nothing is
published by an ordinary push to `main`. It runs `npm ci`, `npm test`, then
`npx electron-builder --win --publish always` with the workflow's own
`GITHUB_TOKEN` (needs `permissions: contents: write`).

**The procedure, in order. Nothing else publishes anything.**

```bash
# 1. bump "version" in package.json — say to 0.2.1
npm test                              # must be green; the workflow reruns it
git commit -am "Release 0.2.1"
git push                              # publishes nothing on its own
git tag v0.2.1                        # the tag MUST be "v" + package.json version
git push --tags                       # this, and only this, triggers the release
```

The tag must equal `v` + the `package.json` version. electron-builder derives
the GitHub release name from `package.json`, **not** from the pushed tag, so a
mismatch uploads the artifacts to a release whose name disagrees with the app.
`build.publish.releaseType` is `"release"`, so the release is published rather
than left as a draft (electron-builder's default is `draft`, which
electron-updater ignores and which shows nothing on the Releases page). Watch
the run before telling anyone to download.

Gotcha: the very first push, the one `gh repo create --source . --push` makes,
is rejected if it contains a workflow file — *"refusing to allow an OAuth App
to create or update workflow `.github/workflows/release.yml` without `workflow`
scope"* — even though an ordinary `git push` of the same file to the
now-existing repo goes through with the same token. If it bites again, push the
first commit without `.github/`, then commit and push the workflow separately.
Should a later push hit the scope wall for real:
`gh auth refresh -h github.com -s workflow` (needs a browser confirmation from
the account owner).

The workflow has **never actually run** — no tag has been pushed yet, by
instruction. Treat the first `v*` tag as the test of it and watch the run.

## Adding maps — the map image half

See "Adding a map (data only)" above for the whole procedure; this is just the
image step.

1. Drop the source image in `maps-src/` and add its stem → display name to
   `MAP_NAMES` in `scripts/prepare-maps.js`, **or** put a finished PNG straight
   into `maps/<Creator>/<Map Name>.png` (no code change at all).
2. `npm run prepare-maps` if you went through `maps-src/`. Then *look at the
   output PNGs* — the crop is detected from the image, not hard-coded, so a
   differently framed source can crop wrong.
3. A new folder under `maps/` is automatically a new creator; the home creator
   filter un-hides itself once there is more than one.
4. Default Ctrl+N bindings need no edit: the first nine shipped maps in
   catalogue order get them (fresh installs only, i.e. no `hotkeys.json` yet).
5. Credit the author in the Credits modal (`src/index.html`), `README.md` and
   `NOTICE`.

## Map crop detection

`scripts/prepare-maps.js` finds the map square by **mean luminance**, not by the
drawn frame: the letterbox around the square is flat grey (~45), the square is
near-black. It scans inward from each edge and stops at the first row/column
that is not letterbox, so bright content in the middle of the map (a white
title, a lit street) cannot break it. Only then does it look a few pixels
further in for a drawn frame line to sit just inside. An earlier attempt keyed
on the bright frame instead — two of the four sources have no frame at all, so
it did not work.

---

## Self-Updating Rule

**AGENTS.md is the source of truth for agentic onboarding.** Every time an agent
(human or AI) discovers a pattern, convention, or architectural decision that is
not documented here — or corrects an outdated entry — it MUST update this file.
Specifically:

1. **Before starting any task**: Read `AGENTS.md` to understand the project.
2. **After completing any task**: If you learned something that would help the
   next agent, add it to `AGENTS.md` under the relevant section. If no section
   fits, add a new one.
3. **On discovering stale information**: Correct it immediately. Do not work
   around outdated docs.
4. **Keep it concise**: One-liners preferred. This file is read by agents, not
   humans seeking tutorials. No fluff.
5. **Never remove the self-updating rule**: This clause must survive all edits.

*Last updated: 2026-09-17*
