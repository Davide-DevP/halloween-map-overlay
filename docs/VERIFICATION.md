# Independent verification — Halloween Map Overlay 0.1.0

> **Historical, not maintained.** A record of what was true when it was written; names, paths and numbers may be stale.
> Current facts live in the `docs/agents/` document that owns them (see AGENTS.md).

Reviewer: independent, no stake in the outcome. Every claim in `docs/DEV-REPORT.md`
was re-run or re-read; nothing below is taken from that report.
Environment: Windows 11 Pro 10.0.26200, Node 24, Electron 40 (`node_modules/electron`),
Git Bash. No GUI interaction was possible; see "Not verifiable" at the end.

## Verdict

**SHIP WITH FIXES** — the ported overlay, catalogue, CLI path, build and packaging
all work as claimed, but the hotkey-recording UI can persist an invalid accelerator
that throws at boot and silently disables every later hotkey until the user finds
"Reset" (Finding 1), and a per-map hotkey that collides with a system hotkey is
accepted but never registered (Finding 2), contradicting `AGENTS.md`.

## Acceptance criteria (SPEC §4)

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | `npm start` opens main window with 4 cards; click shows map on overlay; Ctrl+H / Ctrl+R / Ctrl+←→ / Ctrl+1..4 | PASS for what is observable; key presses NOT VERIFIABLE | `DEBUG=true electron .` → `[renderer] renderer::ready maps=4 cards=4 customs=1`; no `Failed to register`, no `render-process-gone`, no uncaught exception; 6 electron processes. Second instance `electron . "show-map=deftyconchgaming/Orange Grove Estates"` → first instance logged `Opening map: …`, `Image dimensions: { height: 607, width: 608, type: 'png' }`, `Calculated overlay size: { width: 255, height: 275 }`, `Overlay position setting: 1`. Renderer handlers `toggle-map`/`rotate-map`/`next-map`/`prev-map`/`hotkey-pressed` (src/js/maps.js:116-143) all end in `sendMap()` → `ipcRenderer.send('map-change')` (traced). `hotkeys.json` on disk after first run: Ctrl+1..4 → East Haddonfield, Haddonfield Heights, Orange Grove Estates, Haddonfield Town Center. Actual key presses cannot be injected here. |
| 2 | `npm test` passes | PASS | `npm test` → `ℹ tests 42 ℹ pass 42 ℹ fail 0` (17 overlay-position + 18 map-catalog + 7 hotkeys-defaults by name count; node:test reports 42). |
| 3 | Custom map import PNG/JPG/WEBP shows under "Custom" | PARTIAL — fs half PASS, UI half NOT VERIFIABLE | Dropped a PNG into `%APPDATA%/halloween-map-overlay/custom/My Test Map.png`, started app → `maps::loadCatalog 5`, `cards=5`; `show-map=My Test Map` → resolved from `custom/` and sized (`601x591`). The file-picker → `FileReader` → `write-custom-data` path (src/js/custom.js:25-58) was not exercised (needs a GUI). |
| 4 | `npm run build:win` → NSIS + portable with maps in `resources/maps/` | PASS | `dist/Halloween Map Overlay Setup 0.1.0.exe` (96,640,926 B), `dist/Halloween Map Overlay 0.1.0.exe` (96,388,377 B); `dist/win-unpacked/resources/maps/deftyconchgaming/` has exactly the 4 PNGs, no `detection-fixtures`. `asar list`: 817 entries = `index.js`, `package.json`, `AGENTS.md`, `LICENSE`, `NOTICE`, `README.md`, `src/` (27 files) and `node_modules/` {@popperjs/core, bootstrap, image-size, jquery, uuid} only; 0 entries for maps/maps-src/docs/test/scripts/dist/build/detection-fixtures. Packaged exe smoke-run with `DEBUG=true`: `renderer::ready maps=4 cards=4` from `resources\app.asar\src\js\logger.js` and `show-map=orange grove` via second instance resolved 608x607 — `process.resourcesPath` branch works. Build not re-run (dist consistent). |
| 5 | No network calls at runtime | PASS | `grep -rn http src/ index.js` → only the CSP `<meta http-equiv>` and the two `target="_blank"` credit links (index.html:427, 429), routed through `shell.openExternal` by `setWindowOpenHandler` (main-window.js:169-172). No `fetch(`, `XMLHttpRequest`, `require('http'|'https'|'net')`. CSP `connect-src 'none'` on the main window. |
| 6 | `AGENTS.md` accurate | FAIL (one false statement, rest accurate) | AGENTS.md "Hotkey priority" says "saving a conflicting one is refused with a toast". `src/core/hotkeys.js:27-49` (`save-hotkeys`) has no system-hotkey conflict check; reproduced (Finding 2). Module list, key format, maps-root rule, overlay quirks, `get()`/`raw()` trap and first-run rule were all checked against code and are correct. |

## Findings (most severe first)

### 1. CONFIRMED — Recording an arrow key (or Space, `+`, …) as a system hotkey persists an invalid accelerator; `globalShortcut.register` then throws at every boot and all later hotkeys are lost
- `src/js/hotkeys.js:436-438` pushes raw `e.key` (`ArrowRight`, `ArrowLeft`, `" "`, `+`, `CapsLock`…) into the recorded string; `displayToAccelerator` (`src/shared/hotkeys-constants.js:335-343`) only rewrites `Ctrl`/`Cmd`. Electron wants `Right`/`Left`/`Space`/`Plus`.
- `src/core/hotkeys.js:75-110` (`save-system-hotkey`) writes the accelerator to settings with no validation, then `loadKeys()`.
- `src/core/hotkeys.js:180` `globalShortcut.register(...)` is not wrapped: probe (`electron` script in scratchpad) → `register("CommandOrControl+ArrowRight") THREW: Error processing argument at index 0, conversion failure`. Same for `"CommandOrControl+"` (Space) and `"CommandOrControl+ +"`.
- Reproduced end to end by setting `"hotkeyNextMap":"CommandOrControl+ArrowRight"` in `settings-app.json` and starting the app: `UnhandledPromiseRejectionWarning: TypeError: … conversion failure from CommandOrControl+ArrowRight at Hotkeys.registerSystemHotkeys (src/core/hotkeys.js:180) at Hotkeys.loadKeys (…:223) at createWindow (index.js:89)`. Because registration is sequential, `prev-map` and all four Ctrl+1..4 map hotkeys were never registered and the renderer never received `hotkey-updated` (map hotkey table shows "No map hotkeys bound."). This persists on every restart until the user presses "Reset" on that row.
- Why it matters here more than in the reference: this port ships **Ctrl+Left/Right** as defaults, so re-recording an arrow key is the most likely edit a user makes.
- Fix: translate `e.key` to Electron names (`Arrow*`→`Right/Left/Up/Down`, `" "`→`Space`, `+`→`Plus`, `Escape`→`Esc`, reject unmapped keys), require at least one modifier, and in `save-system-hotkey`/`save-hotkeys` dry-run `globalShortcut.register` inside `try/catch` (then unregister) before persisting; wrap the two `register` calls in `registerSystemHotkeys`/`registerCustomHotkeys` in `try/catch` so one bad entry cannot take the rest down.

### 2. CONFIRMED — Per-map hotkey colliding with a system hotkey is saved ("Hotkey saved.") but never registered
- `src/core/hotkeys.js:27-49` (`save-hotkeys`) checks nothing against `getSystemHotkeys()`; `registerCustomHotkeys` (`:201-205`) skips it with only `console.warn`, no `sendUpdate`.
- Reproduced: `hotkeys.json` with `"CommandOrControl+H": {mapKey: …}` → boot log `Skipping map hotkey "CommandOrControl+H" — conflicts with a system hotkey.` twice, renderer shows the binding in the Maps table as if active.
- `AGENTS.md` ("saving a conflicting one is refused with a toast") is wrong on this point (AC6).
- Fix: in `save-hotkeys`, refuse when `Object.values(getSystemHotkeys()).includes(hotkey)` and `sendUpdate` a conflict message (mirror of the check at `:100-105`); also `sendUpdate` from the skip branch. Update `AGENTS.md` if the behaviour is kept.

### 3. SUSPECTED (traced, inherited from reference) — Renderer settings mirror clobbers main-side settings writes
- `src/js/settings.js:277-280` sends the renderer's **whole** settings object on every `set()`; `src/core/settings.js:412-416, 428-433` replaces `this.settings` with it. The renderer copy is loaded once (`src/renderer.js:28`) and never refreshed.
- Main-side writes that bypass the renderer: `settings.set(settingKey, accelerator)` on system-hotkey save/reset (`src/core/hotkeys.js:107,120`) and `overlayX`/`overlayY` on drag (`src/core/overlay-window.js:180-181`).
- Consequence: change a system hotkey (or drag the overlay in draggable mode), then touch any slider/checkbox in Settings or press Ctrl+R (`src/js/maps.js:136` also goes through the renderer `set`) → the stale copy is written back; the hotkey change reverts on next restart, the dragged position reverts on the next `map-change` (`main-window.js:83-84` reads `overlayX || 0`).
- Same pattern exists in the reference, so it is not a port regression, but it directly undermines the "all rebindable" claim in the README.
- Fix: make `save-settings` merge keys instead of replacing, or have the renderer send `{key, value}`; refresh the renderer copy on `system-hotkeys-updated`.

### 4. SUSPECTED — HTML injection through custom map names (self-XSS with `nodeIntegration: true`)
- `src/js/custom.js:40-43` only strips `/`, `\` and `.` from the user-typed name. The name/key is then interpolated unescaped into markup: `src/js/maps.js:203-206` (`data-key="${entry.key}"`, `${entry.name}`), `src/js/custom.js:84-87`, `src/js/hotkeys.js:239-242`, `src/js/maps.js:171` (creator select).
- A name containing `"` breaks `data-key` (card click then sends a truncated key); a name containing `<img src=x onerror=…>` executes with Node access. Only the local user can type it, so severity is low, but it is a two-line fix.
- Fix: build these nodes with jQuery `.text()`/`.attr()` or an escape helper.

### 5. CONFIRMED (static + probe) — A single unmodified key can be bound as a global shortcut
- `src/js/hotkeys.js:426-443` accepts a keydown with no Ctrl/Alt/Shift/Meta; probe shows `register("H") -> true`. Binding e.g. `W` would swallow that key system-wide, including in the game. Inherited from the reference. Fix: require a modifier in the capture handler (fold into Finding 1's fix).

### 6. CONFIRMED (static) — Validation errors in the hotkey modal close the modal anyway
- `src/index.html:346` `#saveHotkeyBtn` has `data-bs-dismiss="modal"`; `saveHotkeyToFile`/`saveSystemHotkey` (`src/js/hotkeys.js:336-376`) show the "Pick both…"/"No key combination recorded." toast after Bootstrap has already started closing the modal, and `restoreModalDefaults` clears the recorded key. Fix: remove `data-bs-dismiss` and hide the modal programmatically only on success.

### 7. CONFIRMED — Documentation inaccuracies (minor)
- `README.md` "Download" section points to "the releases page of this repository"; per SPEC §2 there is no repository or release yet.
- `README.md` hero image alt text says "Four maps…" but shows only East Haddonfield.
- `AGENTS.md` conflict-toast statement (see Finding 2).
- Otherwise README, NOTICE and Credits modal match SPEC §5: "Maps by u/deftyconchgaming", Reddit link `https://www.reddit.com/r/TheHalloweenGame/comments/1wauwcx/`, Apache-2.0 derivation from LucaFontanot/dbd-map-overlay with `LICENSE` + `NOTICE` (per-file list present). README and the in-app FAQ + startup banner tell users to use Borderless Windowed.

### 8. INFO — Dead / vestigial code
- `src/js/logger.js:304-319` `downloadLogs` — never called.
- `src/core/utils.js:286-303` `deleteDirectoryContents` — never called.
- `src/core/settings.js:369` default `id: uuid.v4()` — lobby-era identifier persisted to `settings-app.json` for no purpose; `uuid` is a runtime dependency (in the asar) only for this line.
- `src/js/logger.js:321` `debug-log` IPC listener — nothing sends it.
- `src/shared/hotkeys-constants.js:346` `normalizeAccelerator` — used only by tests.
- `src/js/custom.js:46` always writes `<name>.png` even for JPG/WEBP bytes; works (image-size sniffs content) but the file names lie.

## What was verified clean

- `src/core/overlay-window.js`, `overlay-position.js`, `utils.js`, `is-wayland.js`, `src/map/map.html`, `src/map/renderer.js`, `renderer_obs.js`, `test/overlay-position.test.js`: byte-identical to the reference (`diff`). All listed quirks intact: transparent + frameless + `focusable:false` + `skipTaskbar` + `alwaysOnTop`, `pop-up-menu` on win32 re-asserted every 1 s and cleared in `close()`, `setIgnoreMouseEvents(true,{forward:true})`, `setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true})`, `set-mouse-drag` toggling click-through, `overlayX/Y` persisted on `moved`.
- `src/core/main-window.js` `map-change`: same logic as the reference (rotated bounding box `+5`/`*1.1`, `computeOverlayPosition` unless draggable, `preview` never forwarded to OBS) plus `MapLibrary.resolve`, `imageSize` try/catch and debug gating. `map_obs.html` fix (loads `renderer_obs.js`) is real.
- `src/core/map-library.js`: maps root `app.isPackaged ? resourcesPath/maps : dirname/maps` (packaged branch exercised); custom `custom/` merged (exercised). `read-map-image` only ever joins a catalogue entry's own file name — no traversal. `read/write/delete-custom-data` apply `path.basename` — no traversal.
- Fuzzy matching: 26 typo/variant inputs for the four names all resolved to the intended map (`Hadonfield Hights`, `Haddonfield Town Centre`, `Ornage Grove Estates`, `Community/…` stale key, etc.); `zzzz`, `Halloween`, `""` → null; `show-map=zzzz-nonsense` at runtime → `maps::show-map-command::no-match`, no error. Ambiguous bare `Haddonfield` → East Haddonfield (first in order) — acceptable.
- Corrupt `hotkeys.json` → `readHotkeyFile` returns `{}` with a console error; corrupt `settings-app.json` → defaults. Neither crashes.
- Renderer: every `#id` referenced from `src/renderer.js` and `src/js/*.js` exists in `src/index.html` (scripted cross-check, 0 missing); `renderer.js` is loaded at the end of `<body>`, so constructor-time bindings find their elements; no `require` of removed modules; CSP meta present and no CSP violation forwarded under `DEBUG`.
- Leftover sweep (`dbd|dead by daylight|lucaservers|realm|lobby|tesseract|streamdeck|autoUpdater|electron-updater|axios|tom-select|font-awesome`): only the required attribution line in the Credits modal.
- Images: all four crops are tight (no grey letterbox), title, legend and "N" marker present on each; `src/images/icon.png` is a plain 256 px pumpkin on a dark rounded square.
- Defaults cannot put the overlay off-screen: `position:1`, `glideX/Y:null`, `monitor:0` with fallback to `displays[0]`.

## Not verifiable here (and why)

- Actual key presses (Ctrl+H/R/←/→/1..4), card clicks, sliders, drag-to-position, the hotkey capture modal and the custom-image file picker: no input injection or screen capture is available. The IPC handlers each of those reaches were traced to `map-change` and the `map-change` path itself was exercised through the CLI (dev and packaged).
- Always-on-top over *Halloween: The Game* in borderless windowed mode: the game is not installed here; the behaviour is the unchanged reference implementation.
- Linux/Wayland respawn: Windows only.
- Whether the `dist/` binaries were produced from the current source: `dist/` timestamps (10:57) post-date the last `src/` edit (10:56) and the asar contents match the tree, but the build was not re-run.
