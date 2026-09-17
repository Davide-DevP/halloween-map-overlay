# Halloween The Game Map Overlay — Analysis & Spec

Analysis of the reference project `LucaFontanot/dbd-map-overlay` (Apache-2.0, Electron)
and the specification for its port to **Halloween: The Game** (Steam appid 3219630).

Reference clone: see `docs/REFERENCE.md` for the path used during development.

## 1. What the reference app does

Electron desktop app (plain CommonJS, no bundler, `nodeIntegration: true`,
`contextIsolation: false`). Three windows:

| Window | File | Purpose |
|---|---|---|
| Main | `src/index.html` + `src/renderer.js` | Map gallery, settings modal, hotkeys UI |
| Overlay | `src/map/map.html` + `src/map/renderer.js` | Transparent, frameless, always-on-top, click-through window that shows the current map image |
| OBS | `src/map/map_obs.html` | Same image on a green (#00ff00) background for chroma-key capture |

Main-process modules (`src/core/`):

- `main-window.js` — IPC hub. On `map-change` it reads the image (from userData
  `photo/` or `custom/` dir, or a base64 payload), measures it with `image-size`,
  resizes/positions the overlay window on the chosen monitor, and forwards the image
  (base64) to overlay + OBS windows with size/opacity/draggable/rotation settings.
- `overlay-window.js` — creates the transparent overlay (`alwaysOnTop` level
  `pop-up-menu` on Windows, re-asserted every second so a fullscreen game does not
  cover it; `setIgnoreMouseEvents(true, {forward:true})`; toggled off via
  `set-mouse-drag` IPC when the user drags it into place; saves `overlayX/Y`).
- `overlay-position.js` — pure math (corner preset 1–4 + glide X/Y % + rotated
  bounding box). Unit-tested with `node:test`.
- `hotkeys.js` — `globalShortcut` registration. Three system actions
  (check-lobby, toggle-map, rotate-map) stored in settings, plus user "map hotkeys"
  (`hotkeys.json` in userData: accelerator → mapKey) with conflict checks.
- `settings.js` — JSON file `settings-app.json` in userData, defaults merged.
- `tray.js`, `obs-window.js`, `user-data.js` (read/write/delete/list files in
  userData `photo/` and `custom/`), `utils.js`, `is-wayland.js` (Linux respawn
  with `--ozone-platform=x11`).
- `map-detector*` — OCR (tesseract.js + node-screenshots + sharp) that screenshots
  the DBD window and reads the Realm/Map name on the loading screen.
- `stream-deck.js` — Stream Controller (Linux) config generator.

Renderer (`src/js/`): `images.js` (syncs maps from a GitHub branch via
`images.json` MD5 manifest, builds Creator/Realm/Map dictionary, gallery + fuzzy
search), `options.js` (settings modal incl. live preview image), `hotkeys.js`
(UI + key capture), `custom.js` (import own images), `lobby.js`/`api.js`/`jspow.js`
(remote lobby sync via dbdmap.lucaservers.com), `privacy.js` (fetches FAQ/changelog/
credits markdown from GitHub raw at runtime), `overlay-preview.js`.

## 2. What is different for Halloween: The Game

- Only **4 maps** at launch: East Haddonfield, Haddonfield Heights, Orange Grove
  Estates, Haddonfield Town Center. No realm hierarchy, one community creator.
- Map images are already in this repo (`maps/*.webp`, 1080x607, lossy VP8).
  Each image has the actual square map framed at roughly x=237..843 on a dark
  letterbox; the useful overlay area is that square.
- No loading-screen fixtures for HTG exist, so OCR auto-detection cannot be
  built or tested. Nothing of the DBD OCR pipeline transfers.
- No backend, no GitHub asset branch, no releases yet.

## 3. Decisions (keep / drop / change)

### Keep (port as-is, renamed)
- Electron + plain CommonJS architecture, three windows, IPC patterns.
- Overlay behaviour: transparent, click-through, always-on-top re-assert loop,
  monitor selection, size, opacity, corner preset + glide sliders, rotation
  (0/90/180/270 + hotkey), draggable "set position" mode, hide overlay,
  minimize-to-tray, tray icon, single-instance lock with `show-map=` CLI arg.
- `overlay-position.js` and its tests (unchanged).
- Hotkeys: system hotkeys stored in settings + custom per-map hotkeys in
  `hotkeys.json`, with conflict detection. Key capture UI.
- OBS window (green background).
- Custom map import (userData `custom/`), list + delete.
- Settings preview image while the Overlay tab is open.
- Wayland detection/respawn (cheap, keeps Linux working).
- `AGENTS.md` with the self-updating rule, adapted to this project.

### Drop
- OCR map detection and its deps: `tesseract.js`, `node-screenshots`, `sharp`
  (runtime), `cron`, all `map-detector*` files, fixtures and tests, the
  "Detection" tab, OCR language modal, `preferredCreator`, `detectInCustoms`.
- Lobby manager, `api.js`, `jspow.js`, `axios`, `token`/`id` registration.
- Remote map sync (`images.json`, GitHub raw), `picture-hash.js`,
  `.github/workflows/images-deploy.yml`, userData `photo/` cache.
- Stream Deck tab and `stream-deck.js`, `streamdeck.js`.
- `electron-updater` (no release feed yet). Leave a TODO in AGENTS.md.
- Runtime-fetched FAQ/Changelog/Credits/Privacy markdown (`privacy.js`, `marked`,
  `github-markdown.min.css`). Replace with small static in-app modals.
- Tom Select (only needed for hundreds of maps). Plain `<select>` is enough.
- i18n JSON for map names (4 English names).
- Realm level. Map key becomes `Creator/MapName` (still case-insensitive, no
  extension, closest match on unknown key).

### Change / add
- **Maps ship inside the app**: `maps/<Creator>/<Map>.png` is packaged via
  electron-builder `extraResources` and read from `process.resourcesPath`
  (packaged) or the repo dir (dev). No download step, no loading spinner.
- **Crop the four source images** once, at build-prep time, to the map square
  (drop the letterbox) and store them lossless (PNG). Keep the originals under
  `maps-src/` so the crop can be re-run. Script: `scripts/prepare-maps.js` using
  `sharp` as a **devDependency** only.
- **System hotkeys**: `toggle-map` (Ctrl+H), `rotate-map` (Ctrl+R),
  **new** `next-map` (Ctrl+Right) and `prev-map` (Ctrl+Left) cycling the 4 maps
  in a fixed order. Remove `check-lobby`.
- **Per-map hotkey defaults**: Ctrl+1..Ctrl+4 pre-bound to the four maps on first
  run (written to `hotkeys.json` if it does not exist).
- App identity: productName "Halloween Map Overlay", appId
  `com.halloweenthegame.mapoverlay`, package name `halloween-map-overlay`,
  version 0.1.0. New icon (SVG rasterised to `build/icon.png` 512x512 by the
  prepare script, also copied to `src/images/icon.png`).
- Credits modal: maps by u/deftyconchgaming (r/TheHalloweenGame), source post
  https://www.reddit.com/r/TheHalloweenGame/comments/1wauwcx/ ; app based on
  DBD Map Overlay by LucaFontanot (Apache-2.0, keep `LICENSE` + NOTICE line).
  The maps creator folder is `maps/deftyconchgaming/`.
- UI language: English (community tool). Home shows the 4 map cards large, a
  search box is unnecessary but a creator select must remain functional if more
  creators are added later (folder = creator).

## 4. Acceptance criteria

1. `npm install` then `npm start` opens the main window with 4 map cards; clicking
   one shows it on the transparent overlay at the configured corner; `Ctrl+H`
   hides/shows, `Ctrl+R` rotates, `Ctrl+Left/Right` cycle, `Ctrl+1..4` jump.
2. `npm test` passes (overlay-position tests + new tests for the pure map
   catalogue/matching module and hotkey defaults).
3. Custom map import works with PNG/JPG/WEBP and shows in the gallery under
   "Custom".
4. `npm run build:win` produces an NSIS installer and a portable exe in `dist/`
   with the maps inside `resources/maps/`. If code-signing/symlink issues block
   the build on this machine, document the exact error in `docs/BUILD.md`.
5. No network calls at runtime (grep for `http` in `src/` finds only external
   links opened via `shell.openExternal`).
6. `AGENTS.md` describes the new architecture accurately.

## 5. Credits (authoritative)

- Map images: **u/deftyconchgaming** on r/TheHalloweenGame —
  https://www.reddit.com/r/TheHalloweenGame/comments/1wauwcx/
- App derived from **DBD Map Overlay** by LucaFontanot (Apache-2.0).
