# Architecture and code conventions

[← AGENTS.md](../../AGENTS.md) · **Read before** adding a module, moving logic between main and the
renderer, touching `map-library.js`/`map-catalog.js`, or changing the
`map-change` payload.

## Stack

| Layer | Tech |
|-------|------|
| Runtime | Electron 40 (Node.js, Chromium) |
| Frontend | HTML/CSS/JS, Bootstrap 5 (re-skinned), jQuery 4, Popper 2 |
| Fonts | `@fontsource-variable/geist` + `-geist-mono` (local, runtime deps) |
| Image sizing | `image-size` (runtime), `sharp` (dev only, map prep) |
| Screen capture | `node-screenshots` (runtime, prebuilt NAPI, asarUnpacked) — loaded **in the detector's `utilityProcess`**, not in main |
| Key state | `koffi` (runtime, prebuilt NAPI, asarUnpacked, MIT) — **one** `user32` call, Tab-map mode only, loaded lazily. The controller button is read by Chromium's Gamepad API in a hidden window, no native module |
| Build/packaging | electron-builder (NSIS + portable) |
| Package manager | npm |

## The module map

One line per file. The grouped short form is in `AGENTS.md`; this is the full
annotated list.

```
index.js                        → Entry point. Wayland → X11 respawn.
                                  Single-instance lock (`show-map=` arg).
                                  Builds every module and wires them together.
src/core/main-window.js         → Main BrowserWindow + IPC hub.
                                  `applyMapChange()` reads the image,
                                  sizes/positions the overlay, sends one
                                  `map-change` object to overlay + OBS. Also
                                  owns the **tray unload**: the window is
                                  destroyed while hidden and rebuilt on demand
                                  (0.7). Of the update flow it keeps only the
                                  IPC wiring and `installUpdate()` for the tray.
src/core/updater.js             → The whole update flow (`Updater`): the check,
                                  its stall watchdog, the download, the three
                                  install tiers and the helper hand-off. Window
                                  access is injected (`send`, `sendUpdate`,
                                  `getWindow`, `getTray`, `runShutdownHooks`)
                                  because the main window may not exist.
                                  `docs/agents/updater-and-installer.md`.
src/core/quitting.js            → `markQuitting()` / `clearQuitting()` /
                                  `isQuitting()`: the one process-wide "the app
                                  is on its way out" flag (replaced
                                  `app.isQuiting`). No electron import.
src/core/map-controller.js      → Which map is on the overlay, and every
                                  decision that changes it: the hotkeys, the
                                  detector, the CLI, the gallery. The impure
                                  half of `shared/map-state.js`. Works with
                                  **no window**. Spec:
                                  `docs/SPEC-MAP-STATE.md`.
src/shared/map-state.js         → PURE `reduceMapState(state, intent, ctx)` →
                                  `{state, effects}`: currentKey/lastKey,
                                  toggle, next/prev, clear-and-redetect, the
                                  menu hide, rotation/opacity/size steps, the
                                  markers toggle, the settings preview.
                                  Tested.
src/shared/window-unload.js     → PURE `shouldUnloadMainWindow()` — may the
                                  main window be destroyed right now, and if
                                  not, why not. Tested.
src/shared/window-size.js       → PURE main-window size: the default, the
                                  minimum, `clampWindowSize` against the work
                                  area, `sizeToPersist`. Tested.
src/core/overlay-window.js      → Transparent click-through always-on-top window.
src/core/overlay-position.js    → PURE positioning math (corner preset + glide %
                                  + rotated bounding box). Unit tested.
src/core/obs-window.js          → Green-background window for OBS capture.
src/core/map-library.js         → File-system side of the catalogue: maps root,
                                  directory listing, key → absolute path. Three
                                  roots since 0.7: maps/, map-packs/<dir>/ and
                                  userData custom/.
src/core/map-catalog.js         → PURE catalogue: build from a listing, fuzzy
                                  key matching, next/prev, custom merge. Tested.
src/core/map-packs.js           → **Map packs** (new/updated maps with no app
                                  release). The electron half: userData path,
                                  `checkForMapPacks`, the 24 h gate, the startup
                                  timer, `check-map-packs` IPC, the toast.
                                  Spec: `docs/SPEC-MAP-PACKS.md`.
src/core/map-pack-store.js      → Installed packs on disk: list + re-validate,
                                  read templates/markers, staging, the atomic
                                  rename swap, `state.json`. fs only. Tested.
src/core/map-pack-install.js    → Index → select → download → verify → install.
                                  fs only; the network is one injected
                                  function, so the whole install is tested with
                                  no net and no electron. Tested.
src/core/map-pack-fetch.js      → The one GET: `node:https`, allow-listed URL,
                                  byte caps, two timeouts, ≤2 re-validated
                                  redirects. Main process only.
src/shared/map-pack-rules.js    → PURE pack rules: file-name/key/URL validation,
                                  index + manifest + templates + markers
                                  schemas, bundled-vs-pack precedence
                                  (`mergeMapPacks`, `mergeTemplateSources`),
                                  the 24 h gate. Tested.
src/core/map-markers.js         → **Markers** (possible cellar/gate/car/gas-can
                                  locations). Validates the shipped
                                  `map-markers/markers.json` once at load with
                                  the *packs'* `validateMarkers`, owns the one
                                  `get-map-markers` IPC, and lets an installed
                                  pack's markers override a bundled map's.
                                  Spec: `docs/SPEC-MARKERS.md`.
src/core/map-markers/markers.json → Generated, committed, inside the asar (like
                                  templates.json). Written by
                                  `scripts/build-markers.js` from
                                  `maps-src/markers.json`; a test asserts the
                                  two agree.
src/shared/marker-rules.js      → PURE marker decisions: the four layers (order,
                                  colour, setting key, label key), which are
                                  drawn on which surface (`baked`), the Tab
                                  transform, the legend, `markerState`. Tested.
src/shared/marker-geometry.js   → PURE bracket geometry + the sqrt sizing curve
                                  (legible at 150 px, not huge at 800). Tested.
src/map/markers.js              → The SVG marker layer, shared by the overlay
                                  and the OBS renderers so a stream shows what
                                  the player sees.
src/core/tab-mode.js            → **Tab-map mode** (experimental, off by
                                  default): markers drawn over the game's *own*
                                  Tab map while — and only while — Tab is held.
                                  The fast loop, the window, the IPC. Every
                                  decision is pure.
src/core/tab-overlay-window.js  → The second transparent click-through
                                  always-on-top window. Same construction rules
                                  as `overlay-window.js`, lazily created.
src/map/tab.html, tab-renderer.js → That window's renderer: brackets on the
                                  panel square, legend in the game's own
                                  Objectives panel.
src/shared/tab-mode-rules.js    → PURE Tab-mode scheduler (`reduceTabMode`),
                                  cadences, the one-negative-gate debounce,
                                  physical px → DIPs (`gameRectToDip`), and the
                                  key trigger's decisions (`keyHintFor`,
                                  `resolveTriggerMethod`, `checkInterval`,
                                  `detectIntervalFor`). Tested.
src/core/key-trigger.js         → Tab-mode's **key-state trigger** (what it
                                  reads and why: `markers-and-tab-mode.md` §
                                  The key-state trigger). `open()` loads and
                                  proves the native path without reading a key;
                                  lazy, injectable loader, falls back to
                                  polling on any failure. Tested.
src/core/pad-window.js          → Hidden window for the Gamepad API: the one
                                  controller path. Exists only while a
                                  controller button is set (or being chosen);
                                  `backgroundThrottling: false`.
src/map/pad.html, pad-renderer.js → That window's renderer: polls only when
                                  told, sends edges only.
src/shared/pad-codes.js         → PURE standard-mapping codes, labels, "is
                                  this button down" and the one alias (the
                                  touchpad is View). Every pad is read. Tested.
src/shared/key-codes.js         → PURE `KeyboardEvent.code`/`key` → Windows
                                  virtual-key code, plus `vkLabel` and
                                  `resolveMapVk`. **Not** an accelerator — it
                                  shares nothing with `hotkeys-constants.js`.
                                  Tested.
scripts/build-markers.js        → Dev only: maps-src/markers.json → the shipped
                                  runtime file (`--check` in the test suite).
src/core/map-detector.js        → Automatic map detection loop (main process):
                                  the scheduler, the state machine and
                                  show-map-command. Since 0.7 it touches no
                                  pixels — it asks a frame source for a
                                  decision. IPC start/stop/status. Off by
                                  default.
src/core/map-detector/frame-source.js → The pixel work, as one module: find the
                                  game window, capture, raw Tab gate, grayscale
                                  only the regions that are matched, match.
                                  Returns numbers and keys, never pixels.
src/core/map-detector/worker.js → That frame source running in an Electron
                                  `utilityProcess`, so no capture blocks main.
                                  Speaks `parentPort` or `process.send`, which
                                  is how the tests reach it without Electron.
src/core/map-detector/worker-host.js → Main's side: lazy start, per-request
                                  timeout, restart backoff, and the automatic
                                  in-process fallback (the same frame source)
                                  reported in `system.txt`.
src/shared/detector-worker-rules.js → PURE worker timings, restart delays,
                                  stale-reply and mode decisions. Tested.
src/core/map-detector/matcher.js→ PURE matcher: grayscale, relative crop,
                                  64x64 area downsample, gradient magnitude,
                                  zero-mean NCC, Tab-screen gate, and the
                                  main-menu strip matcher. Tested.
src/core/map-detector/log.js    → Detector event log *policy*: `detector.log`,
                                  512 KB + one .1 backup, unbuffered. A thin
                                  subclass of `rotating-log.js`. Tested.
src/core/rotating-log.js        → The shared append-only writer both logs use:
                                  line format (+ optional level), rotation,
                                  buffered/unbuffered modes, in-memory ring
                                  buffer. fs only, no electron. Tested.
src/core/app-log.js             → **Singleton.** `app.log` in userData (1 MB +
                                  one .1, buffered 500 ms, 200-line ring):
                                  startup snapshot, map changes, hotkeys,
                                  settings, updates, errors. Owns the
                                  `uncaughtException`/`unhandledRejection`
                                  handlers and the crash file. `require` it and
                                  call `event()` — it is not injected.
src/core/diagnostics.js         → The "Create diagnostic report" IPC: the file
                                  list, `system.txt`, the crash notice.
src/core/diagnostics/zip.js     → PURE minimal zip writer + reader on
                                  `node:zlib` (no new dependency). Tested.
src/core/diagnostics/report.js  → `buildDiagnosticReport({files, texts, outDir})`
                                  → one zip. fs only, no electron. Tested.
src/core/diagnostics/crash.js   → `crash-*.txt`: format, list, prune to 5,
                                  `pendingCrash`. fs only, no electron. Tested.
src/shared/redact.js            → PURE `redactHome(text, home)` → `~`. Tested.
src/js/diagnostics.js           → Renderer: crash banner, hotkey-conflict
                                  banner, the report button.
src/shared/detector-rules.js    → PURE cadence + throttle + the renderer's
                                  "is this map already showing?" decision +
                                  the menu gate (`shouldWatchMenu`) + the
                                  game-window identification
                                  (`classifyWindow`/`pickGameWindow`, shared
                                  with `core/foreground.js`),
                                  shared by main and the renderer. Tested.
src/shared/detector-status.js   → PURE home-page status line: from main's
                                  `map-detector-status` push and what the line
                                  remembered, `{state, messageKey, params}`.
                                  `src/js/detector.js` only draws it. Tested.
src/core/map-detector/templates.json → Generated, committed. `format: 2`: a
                                  **list** of 64x64 thumbnails per map (one per
                                  view: Michael, civilian, …), keyed by
                                  catalogue key, plus a separate `menu` section
                                  (96x12 nav strip). `templateVariants()` also
                                  reads the pre-0.3.3 one-thumbnail shape.
src/core/hotkeys.js             → globalShortcut registration + hotkeys.json +
                                  the active/inactive switch. A thin caller
                                  around `shared/hotkeys-rules.js`. Its IPC is
                                  registered from two tables (`handle`/`on`)
                                  into named methods — `tab-mode.js` does the
                                  same — so each channel is one line to find.
src/core/foreground.js          → Is the game in front? ~1 s `Window.all()` +
                                  `isFocused()` poll (NO frame capture) plus
                                  Electron focus/blur, → `Hotkeys.setActive`.
                                  Deps injectable; `destroy()` never reports.
                                  Tested.
src/core/settings.js            → settings-app.json in userData, defaults merged.
                                  `write()/set()/merge()` return success and
                                  take `{rollback}`. Tested.
src/core/language.js            → Resolves the `language` setting against
                                  app.getLocale(); `get-language`/`set-language`
                                  IPC; what the tray translates with.
src/core/user-data.js           → userData `custom/` read/write/delete/list.
src/core/tray.js                → System tray icon and menu.
src/core/utils.js               → fs helpers (recursive listing, mkdir).
src/core/is-wayland.js          → Wayland session detection.
src/core/gc.js                  → One V8 collection on demand, for the detector
                                  loop only. `v8.setFlagsFromString` + a
                                  throw-away `vm` context, so no `--expose-gc`
                                  reaches the renderers. Node built-ins only.
                                  Tested. See `docs/agents/memory.md`.
src/shared/web-preferences.js   → PURE `webPreferences()` — the one object all
                                  five windows are built with. Tested.
src/shared/errors.js            → PURE `errorMessage(err)`: an Error's message,
                                  or the value stringified. Use it in every
                                  `catch` that logs.
src/shared/timers.js            → PURE `clearTimer(handle)` (returns null, so
                                  `this.t = clearTimer(this.t)`) and
                                  `unrefTimer(handle)` (a background timer never
                                  keeps the process alive).
src/shared/hotkeys-constants.js → PURE hotkey defs + first-run map-hotkey
                                  defaults + accelerator formatting +
                                  opacity/size step maths. Tested.
src/shared/hotkeys-rules.js     → PURE hotkey *decisions*: normalizeAccelerator
                                  (a transcription of Electron's own parser —
                                  see `docs/agents/hotkeys.md`) + acceleratorKey /
                                  sameAccelerator, bound entries, system/map
                                  conflict, reset check, shadowed + duplicate
                                  map bindings, ownAcceleratorKeys,
                                  shouldHotkeysBeActive +
                                  hotkeysShouldBeRegistered. Tested.
src/shared/hotkey-migration.js  → PURE one-time move onto the Ctrl+Alt defaults
                                  (`planHotkeyDefaultsMigration`). Tested.
src/shared/settings-defaults.js → PURE default settings + mapLabel enum +
                                  `useHardwareAcceleration`. Tested.
src/shared/map-placement.js     → PURE "where do you want to see the map?":
                                  the `tabMarkers`+`tabHidesMinimap` pair read
                                  and written as one of three choices
                                  (`placementFromSettings`,
                                  `settingsForPlacement`), which blocks each
                                  choice shows (`placementSections`), the
                                  auto-recognise switch's locked state
                                  (`autoDetectSwitchState`) and the markers
                                  master notice. Tested.
src/shared/onboarding-rules.js  → PURE setup-tutorial decisions: does it open
                                  (`shouldShowOnboarding` + `TOUR_VERSION`),
                                  step order/position,
                                  the hotkey rows it prints, the "try it"
                                  prompt (incl. the conflict branch), the
                                  last step's recap (`placementRecap`)
                                  and the three rules
                                  that keep the panel modal
                                  (`backgroundInertTargets`,
                                  `shouldRecaptureFocus`, `tabWrapTarget`).
                                  Tested.
src/shared/i18n.js              → PURE t(lang, key, params), msg(),
                                  translateMessage(), resolveLanguage(). Tested.
src/i18n/*.json                 → Flat dotted key → string catalogues (six).
src/shared/update-message.js    → PURE "Version X.Y.Z is ready." headline for
                                  the update banner, "Updating to X.Y.Z" for
                                  the 0.5.0 updating view, and the whole
                                  decision half of *Check for updates now*
                                  (`planManualUpdateCheck` + `manualCheckView`:
                                  button state and sentence per state). Tested.
src/core/update-helper.js       → App side of the themed updater: where the
                                  helper copy goes, the argument list, the
                                  window bounds, the ready-file handshake and
                                  the stale-copy sweep. fs only, no electron —
                                  the electron half is `core/updater.js`. Tested.
updater/*.cs                    → `hmo-updater.exe`: C#/WPF, code-only, built by
                                  `scripts/build-updater.js` with the csc.exe
                                  inside Windows. `Program` (args → window →
                                  ready-file), `UpdaterWindow` (the screen),
                                  `Runner` (the install, off the UI thread),
                                  `Theme` (the app.css tokens, transcribed),
                                  `Options`, `Log`, `Native`, `Strings`.
updater/strings.json            → The helper's en/it table. Generated into C# at
                                  build time; parity is tested from `npm test`.
updater/fonts/                  → Static Geist / Geist Mono TTFs + OFL. WPF
                                  cannot read the app's variable woff2 files.
scripts/build-updater.js        → Dev only: updater/*.cs → build/updater/.
src/index.html                  → Main window markup. No inline `<style>` and no
                                  `style=` attributes (the one exception is
                                  `#unset-pos`, which jQuery `.show()/.hide()`
                                  owns), no inline `onclick`. Navbar items are
                                  `<button class="nav-link">`, not `<a href="#">`.
                                  The tutorial's steps hold `<template
                                  data-borrow>` slots, not controls.
src/css/app.css                 → The whole theme. Design tokens on `:root`
                                  (warm off-black surfaces, ONE accent
                                  `--hmo-accent` #e8853a, radii, z-index scale,
                                  easing) followed by Bootstrap overrides. It
                                  re-skins Bootstrap rather than replacing it,
                                  so every `data-bs-*` hook still works. No blue
                                  and no green anywhere; `btn-primary` is the
                                  accent (the unused `btn-success` and other
                                  variant rules were dropped in the 2026-09-23
                                  pass), the alerts are quiet tinted panels
                                  with a left rule, and destructive red
                                  (`--hmo-danger*` tokens) is used for removals
                                  only. `#hotkeyToast` is coloured by
                                  `.is-ok` / `.is-error` (set in
                                  `src/js/hotkeys.js`), with no `!important`.
                                  Two traps: `--bs-alert-bg` holds a
                                  gradient here, so `.alert` must paint it with
                                  the `background` shorthand (Bootstrap's own
                                  `background-color: var(…)` goes transparent);
                                  and the navbar is `navbar-expand-md`, so its
                                  collapsed-menu rules stop at 767.98px — the
                                  default window is only 984px of viewport.
                                  `--hmo-text-mute` is tuned to ≥ 4.5:1 on the
                                  raised panel; do not darken it.
src/renderer.js                 → Renderer entry: builds the renderer modules.
src/js/maps.js                  → Gallery and the "showing" line. A **view**
                                  since 0.7: it asks main for the map state,
                                  posts intents and renders the pushes. It
                                  decides nothing.
src/js/busy.js                  → `setBusy(reason, on)` — "do not tear this
                                  window down right now" (Settings, the tour, a
                                  report, an import).
src/js/options.js               → Settings modal (Map + General tabs).
src/js/hotkeys.js               → Hotkeys tab: tables, editing, key capture.
src/js/custom.js                → "Add your own map" modal.
src/js/detector.js              → Home-page auto-detect switch + status line.
src/js/overlay-preview.js       → Canvas sample image for the Map tab.
src/js/onboarding.js            → First-run setup tutorial (`#tour`): six steps,
                                  focus trap, and the real Settings controls
                                  **borrowed** while it is open
                                  (`borrowControls`/`returnControls`). Owns only
                                  its own three markers.
src/js/settings.js              → Renderer mirror of the settings file.
src/js/i18n.js                  → Renderer i18n singleton: `t()`, `applyDom()`,
                                  `onChange()` re-render hooks.
src/js/status.js                → The `#logStatus` toast, shared by main's
                                  `update-message` and the renderer's own notices.
src/js/logger.js                → debugLog.
src/map/map.html, renderer.js   → Overlay window.
src/map/map_obs.html, renderer_obs.js → OBS window.
maps/<Creator>/<Map>.png        → Shipped maps (electron-builder extraResources).
                                  Currently one creator: `deftyconchgaming`.
maps-src/*.webp                 → Untouched originals; input to prepare-maps.
scripts/prepare-maps.js         → Dev only: crop maps-src → maps/, render icons.
scripts/prepare-detector.js     → Dev only: detection-fixtures → templates.json.
                                  Also exports `locatePanel` — the tests use it.
scripts/build-pack.js           → Dev only: one map image + its fixtures → a
                                  map pack in `packs/` + `packs/index.json`.
                                  Reuses `prepare-detector`'s own generator.
detection-fixtures/*.png        → Game screenshots: template sources and the
                                  detector's test matrix. Never packaged.
packs/index.json, packs/<map>/  → Published map packs. Served by GitHub raw,
                                  never packaged into the app.
test/                           → node:test unit tests for the pure modules.
```

## Conventions

- **No TypeScript, no bundler** — plain CommonJS (`require`/`module.exports`).
- **No context isolation** — `nodeIntegration: true`, `contextIsolation: false`.
  jQuery/Bootstrap are pulled in with `require` from `<script>` tags in the HTML.
  Bootstrap's CSS is loaded from `../node_modules/bootstrap/dist/css/` — it is a
  production dependency, so it is inside the asar in packaged builds. **Never
  add a CDN link**; the app must work offline. The two fonts follow the same
  rule: `@fontsource-variable/geist` (UI) and `@fontsource-variable/geist-mono`
  (`kbd`, hotkey bindings, numeric readouts) are **runtime** dependencies linked
  the same way, so electron-builder packages the woff2 files. The page CSP
  (`default-src 'self'`, `connect-src 'none'`) is what makes that not a matter
  of discipline; keep it as strict as it is.
- **IPC**: `ipcMain.handle`/`ipcMain.on` in main, `ipcRenderer.invoke`/`.on` in
  the renderer. The renderer never reads a map file itself; it asks main.
- **The main window's renderer is a view, and it is disposable.** Since 0.7 the
  map state and every decision that changes it live in the **main process**
  (`shared/map-state.js` + `core/map-controller.js`), and the window is
  destroyed while it sits in the tray. The full channel inventory, with the old
  and new owner of each one, is `docs/SPEC-MAP-STATE.md`; the three rules that
  matter when adding anything:
  1. **Nothing a match needs may live in the main window's renderer.** A
     hotkey, a detector switch, the menu clear and `show-map=` all have to work
     with `MainWindow.window === null`. If a new feature needs the window,
     it needs a *reason* in `shared/window-unload.js`, not a dependency.
  2. **Push and pull.** Anything main sends the window is dropped when there is
     no window. A notice that must survive is either **pulled** by the renderer
     on load (`get-map-state`, `get-pending-update`, `get-hotkey-notice`,
     `get-crash-notice`, `get-hotkey-conflicts`) or queued with
     `sendUpdate(message, {keep: true})`. Everything else is dropped on
     purpose — see `MainWindow.sendUpdate`.
  3. **The view sends intents, not commands.** One channel, `map-intent`; the
     answer is the `map-state` push.
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

- **Pure vs impure**: every module in `src/shared/` (among them
  `hotkeys-constants.js`, `hotkeys-rules.js`, `hotkey-migration.js`,
  `settings-defaults.js`, `map-placement.js`, `onboarding-rules.js`,
  `i18n.js`, `map-state.js`, `window-unload.js`, `window-size.js`, `update-message.js`,
  `detector-rules.js`, `detector-status.js`, `detector-worker-rules.js`,
  `tab-mode-rules.js`, `marker-rules.js`, `marker-geometry.js`,
  `key-codes.js`, `pad-codes.js`, `redact.js`, `map-pack-rules.js`,
  `errors.js`, `timers.js`, `escape-html.js`, `web-preferences.js`), plus
  `map-catalog.js`, `overlay-position.js`, `diagnostics/zip.js` and
  `map-detector/matcher.js`, import nothing from
  electron or `fs` (`i18n.js` requires the six JSON catalogues and nothing
  else; `map-pack-rules.js` imports *nothing at all*, which is why
  `mergeMapPacks` takes the catalogue's `sortCatalog` as an argument). Keep them
  that way. A second tier — `rotating-log.js`,
  `map-detector/log.js`, `diagnostics/report.js`, `diagnostics/crash.js`,
  `map-pack-store.js`, `map-pack-install.js` — uses
  `fs` but **never electron**: the directory is injected, which is exactly what
  lets a test drive them against `mkdtemp` (`map-pack-install.js` injects the
  *network* the same way, so the whole install is tested offline). Anything that
  needs `app.getPath`
  belongs in the electron-facing module above it (`app-log.js`,
  `diagnostics.js`, `map-detector.js`, `map-packs.js`). Those two tiers are the
  whole test suite; keep new logic on one of them. `map-library.js` is the
  fs-facing wrapper around `map-catalog.js`; put new file-system logic there.
  `core/settings.js` holds only the read/write/IPC half; the default values
  themselves live in the pure `shared/settings-defaults.js` so a test can check
  them against the hotkey definitions and the enums.
- **Name folding / matching**: `foldName`, `levenshtein` and
  `findClosestMapMatch` in `map-catalog.js` are the single source. Do not
  re-implement name normalisation or edit distance anywhere else.
  **The fuzzy (Levenshtein) stage is skipped for a qualified `Creator/Name`
  query.** Its bound is a fraction of the string's own length and every key in a
  creator's folder shares that whole prefix, so `…/Smiths Grove` was within 40 %
  of `…/East Haddonfield` and resolved to it — a `hotkeys.json` entry for a map
  that is *gone* (an uninstalled pack, a deleted custom image) silently put a
  **different** map on the overlay. The exact and substring stages still run, so
  the renamed-creator case is unaffected (its test passes unchanged), and
  `src/js/maps.js` now toasts `hotkeys.error.mapMissing` instead of doing
  nothing.
- **`map-change` payload**: `MainWindow.applyMapChange(map, opts)` is the one
  implementation. What it sends is **one object** per window (since the
  2026-09-23 refactor; positional arguments before): the overlay gets
  `{image, size, opacity, draggable, rotation, label, labelMode, markers,
  lang}`, the OBS window `{image, size, label, labelMode, markers, lang}` (and
  nothing at all for a `{preview: true}` change). Add a field to the object;
  never add a second channel (the label and the markers must never be able to
  describe a map that is not the one drawn).
  `MapController` calls it directly; the `map-change` **IPC**
  channel is kept for the settings preview alone, which is canvas-rendered in
  the renderer and therefore cannot be anything but raw base64.
  The payload is a catalogue key, a custom-map file name, or raw
  base64. Main resolves keys via `MapLibrary.resolveEntry()` (the entry, not
  just the path — the `always` map label needs the map's *name*, and
  re-deriving it from the payload would be a second chance to disagree with the
  catalogue) and treats anything it cannot resolve as base64.
  `{preview: true}` forces the base64 path (the settings preview is
  canvas-rendered in the renderer) and keeps the image off the OBS window so it
  can never leak into a stream. **`{preview: true}` must only ever be sent with
  real base64**: `Options.stopPreview` used to send it with the catalogue key,
  `imageSize` threw on the decoded garbage, and the overlay stayed on the
  sample map. It goes through the `preview-stop` intent instead, and main
  re-applies its own `currentKey`.

## Catalogue caching

- **Catalogue caching**: `MapLibrary` caches the listing. Anything that adds or
  deletes a custom map must call `invalidate()` — `user-data.js` already does.

## User text in markup

- **Escape user text before it reaches markup.** Custom map names are typed by
  the user and interpolated into the gallery, the custom list and the hotkey
  tables; with `nodeIntegration: true` an injected tag runs with Node access.
  Use `escapeHtml` (`src/shared/escape-html.js`) or build nodes with jQuery
  `.text()`/`.val()`/`.attr()`. Never interpolate a name raw.

## Process-level behaviour

- **Single instance**: `app.requestSingleInstanceLock()`; a second launch passes
  `show-map=<key>` to the running instance and quits. The running instance hands
  that key to `MapController.select(key, 'cli')`, so it works with the window
  torn down in the tray. A second launch with **no** `show-map=` is somebody
  trying to open the app again, so the running instance puts its window back
  (the second process still shows "it is already running").
- **Wayland**: detected at startup, respawns with `--ozone-platform=x11`.

See also: [overlay-windows.md](overlay-windows.md) for the window invariants,
[memory.md](memory.md) for `shared/web-preferences.js` and the measured memory
decisions, [hotkeys.md](hotkeys.md) for `shared/hotkeys-rules.js`'s
transcription of Electron's accelerator parser, and
[diagnostics.md](diagnostics.md) for the two logs.
