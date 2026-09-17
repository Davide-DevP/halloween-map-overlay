# AGENTS.md — Halloween Map Overlay

## Project

Transparent in-game map overlay for **Halloween: The Game**. Electron desktop
app (Windows first, Linux works). Four community maps ship inside the app; the
user picks one and it appears on a click-through always-on-top window. OBS
window with a green background for streamers.

- **License**: Apache-2.0
- **Derived from**: `LucaFontanot/dbd-map-overlay` (Apache-2.0) — see `NOTICE`
- **Scope rule**: this is a *static map viewer*. No network calls, no telemetry,
  no screen capture, no memory reading, nothing that touches the game process.
  Anything that would need one of those is out of scope, not a TODO.

## Stack

| Layer | Tech |
|-------|------|
| Runtime | Electron 40 (Node.js, Chromium) |
| Frontend | HTML/CSS/JS, Bootstrap 5, jQuery 4, Popper 2 |
| Image sizing | `image-size` (runtime), `sharp` (dev only, map prep) |
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
src/js/overlay-preview.js       → Canvas sample image for the Overlay tab.
src/js/settings.js              → Renderer mirror of the settings file.
src/js/logger.js                → debugLog.
src/map/map.html, renderer.js   → Overlay window.
src/map/map_obs.html, renderer_obs.js → OBS window.
maps/<Creator>/<Map>.png        → Shipped maps (electron-builder extraResources).
                                  Currently one creator: `deftyconchgaming`.
maps-src/*.webp                 → Untouched originals; input to prepare-maps.
scripts/prepare-maps.js         → Dev only: crop maps-src → maps/, render icons.
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
- **Pure vs impure**: `map-catalog.js`, `overlay-position.js` and
  `hotkeys-constants.js` import nothing from electron or `fs`. Keep them that
  way — they are the only parts covered by tests. `map-library.js` is the
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
  `buildDefaultMapHotkeys(catalog, makeId)`. A user who deleted every binding
  keeps it deleted.
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
  to replace; that is stated in the README.

## Commands

```bash
npm install
npm start              # dev run (DEBUG=true opens devtools and the menu)
npm test               # node --test over test/**/*.test.js
npm run prepare-maps   # crop maps-src/*.webp → maps/, render build+app icons
npm run build:win      # NSIS installer + portable exe into dist/
```

## Releasing

`.github/workflows/release.yml` runs on a pushed `v*` tag only — nothing is
published by an ordinary push to `main`. It runs `npm ci`, `npm test`, then
`npx electron-builder --win --publish always` with the workflow's own
`GITHUB_TOKEN` (needs `permissions: contents: write`).

```bash
# 1. bump "version" in package.json
git commit -am "Release 0.1.1"
git push
git tag v0.1.1 && git push --tags     # this is what triggers the release
```

The tag must match the `package.json` version, or electron-builder uploads
artifacts to a release whose name disagrees with the app. Watch the run before
telling anyone to download: a failed publish still creates a draft release.

## Adding maps

1. Drop the source image in `maps-src/` and add its stem → display name to
   `MAP_NAMES` in `scripts/prepare-maps.js`, **or** put a finished PNG straight
   into `maps/<Creator>/<Map Name>.png`.
2. `npm run prepare-maps` if you went through `maps-src/`. Then *look at the
   output PNGs* — the crop is detected from the image, not hard-coded, so a
   differently framed source can crop wrong.
3. A new folder under `maps/` is automatically a new creator; the home creator
   filter un-hides itself once there is more than one.
4. To give a new map a default Ctrl+N binding, add its name to
   `DEFAULT_MAP_HOTKEY_ORDER` in `src/shared/hotkeys-constants.js` (this only
   affects installs that have no `hotkeys.json` yet).
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
