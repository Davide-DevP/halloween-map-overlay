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
| Frontend | HTML/CSS/JS, Bootstrap 5 (re-skinned), jQuery 4, Popper 2 |
| Fonts | `@fontsource-variable/geist` + `-geist-mono` (local, runtime deps) |
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
                                  the menu gate (`shouldWatchMenu`),
                                  shared by main and the renderer. Tested.
src/core/map-detector/templates.json → Generated, committed. `format: 2`: a
                                  **list** of 64x64 thumbnails per map (one per
                                  view: Michael, civilian, …), keyed by
                                  catalogue key, plus a separate `menu` section
                                  (96x12 nav strip). `templateVariants()` also
                                  reads the pre-0.3.3 one-thumbnail shape.
src/core/hotkeys.js             → globalShortcut registration + hotkeys.json.
src/core/settings.js            → settings-app.json in userData, defaults merged.
src/core/language.js            → Resolves the `language` setting against
                                  app.getLocale(); `get-language`/`set-language`
                                  IPC; what the tray translates with.
src/core/user-data.js           → userData `custom/` read/write/delete/list.
src/core/tray.js                → System tray icon and menu.
src/core/utils.js               → fs helpers (recursive listing, mkdir).
src/core/is-wayland.js          → Wayland session detection.
src/shared/hotkeys-constants.js → PURE hotkey defs + first-run map-hotkey
                                  defaults + accelerator formatting +
                                  opacity/size step maths. Tested.
src/shared/settings-defaults.js → PURE default settings + mapLabel enum. Tested.
src/shared/i18n.js              → PURE t(lang, key, params), msg(),
                                  translateMessage(), resolveLanguage(). Tested.
src/i18n/en.json, it.json       → Flat dotted key → string catalogues.
src/shared/update-message.js    → PURE "Version X.Y.Z is ready." headline for
                                  the update banner and "Updating to X.Y.Z" for
                                  the 0.5.0 updating view. Tested.
src/core/update-helper.js       → App side of the themed updater: where the
                                  helper copy goes, the argument list, the
                                  window bounds, the ready-file handshake and
                                  the stale-copy sweep. fs only, no electron —
                                  the electron half is `MainWindow`. Tested.
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
                                  owns).
src/css/app.css                 → The whole theme. Design tokens on `:root`
                                  (warm off-black surfaces, ONE accent
                                  `--hmo-accent` #e8853a, radii, z-index scale,
                                  easing) followed by Bootstrap overrides. It
                                  re-skins Bootstrap rather than replacing it,
                                  so every `data-bs-*` hook still works. No blue
                                  and no green anywhere; `btn-success` /
                                  `btn-primary` both map to the accent, the
                                  alerts are quiet tinted panels with a left
                                  rule, and destructive red is used for removals
                                  only. Two traps: `--bs-alert-bg` holds a
                                  gradient here, so `.alert` must paint it with
                                  the `background` shorthand (Bootstrap's own
                                  `background-color: var(…)` goes transparent);
                                  and the navbar is `navbar-expand-md`, so its
                                  collapsed-menu rules stop at 767.98px — the
                                  default window is only 984px of viewport.
                                  `--hmo-text-mute` is tuned to ≥ 4.5:1 on the
                                  raised panel; do not darken it.
src/renderer.js                 → Renderer entry: builds the renderer modules.
src/js/maps.js                  → Gallery, current map, hotkey/CLI dispatch.
src/js/options.js               → Settings modal (General + Overlay tabs).
src/js/hotkeys.js               → Hotkeys tab: tables, editing, key capture.
src/js/custom.js                → "Add custom image" modal.
src/js/detector.js              → Home-page auto-detect switch + status line.
src/js/overlay-preview.js       → Canvas sample image for the Overlay tab.
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
  add a CDN link**; the app must work offline. The two fonts follow the same
  rule: `@fontsource-variable/geist` (UI) and `@fontsource-variable/geist-mono`
  (`kbd`, hotkey bindings, numeric readouts) are **runtime** dependencies linked
  the same way, so electron-builder packages the woff2 files. The page CSP
  (`default-src 'self'`, `connect-src 'none'`) is what makes that not a matter
  of discipline; keep it as strict as it is.
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
  `hotkeys-constants.js`, `settings-defaults.js`, `i18n.js`,
  `update-message.js`, `detector-rules.js`, `redact.js`,
  `diagnostics/zip.js` and `map-detector/matcher.js`
  import nothing from
  electron or `fs` (`i18n.js` requires the two JSON catalogues and nothing
  else). Keep them that way. A second tier — `rotating-log.js`,
  `map-detector/log.js`, `diagnostics/report.js`, `diagnostics/crash.js` — uses
  `fs` but **never electron**: the directory is injected, which is exactly what
  lets a test drive them against `mkdtemp`. Anything that needs `app.getPath`
  belongs in the electron-facing module above it (`app-log.js`,
  `diagnostics.js`, `map-detector.js`). Those two tiers are the whole test
  suite; keep new logic on one of them. `map-library.js` is the
  fs-facing wrapper around `map-catalog.js`; put new file-system logic there.
  `core/settings.js` holds only the read/write/IPC half; the default values
  themselves live in the pure `shared/settings-defaults.js` so a test can check
  them against the hotkey definitions and the enums.
- **Name folding / matching**: `foldName`, `levenshtein` and
  `findClosestMapMatch` in `map-catalog.js` are the single source. Do not
  re-implement name normalisation or edit distance anywhere else.
- **`map-change` payload**: a catalogue key, a custom-map file name, or raw
  base64. Main resolves keys via `MapLibrary.resolveEntry()` (the entry, not
  just the path — the `always` map label needs the map's *name*, and
  re-deriving it from the payload would be a second chance to disagree with the
  catalogue) and treats anything it cannot resolve as base64.
  `{preview: true}` forces the base64 path (the settings preview is
  canvas-rendered in the renderer) and keeps the image off the OBS window so it
  can never leak into a stream. **`{preview: true}` must only ever be sent with
  real base64**: `Options.stopPreview` used to send it with the catalogue key,
  `imageSize` threw on the decoded garbage, and the overlay stayed on the
  sample map. It goes through `Maps.sendMap` instead.
- **Overlay quirks that must not be "cleaned up"** — each one is load-bearing:
  - `alwaysOnTop` level `pop-up-menu` on win32 (`screen-saver` is ignored there)
    and **re-asserted every second**, or a fullscreen game pushes it behind.
  - `setIgnoreMouseEvents(true)` **without** `forward: true`, `focusable: false`,
    `skipTaskbar: true` — otherwise the overlay eats the player's clicks.
    `forward: true` (what the reference uses) installs a WH_MOUSE_LL hook in
    this process on Windows; every mouse move then waits on our main thread,
    and the cursor stuttered system-wide for ~10 s during quit/update in
    0.2.3. The overlay needs no hover events, so the hook was pure cost.
    On quit and on install the overlay window is closed **first**
    (`runShutdownHooks()`, `before-quit`) for the same reason.
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
  **It downloads on its own and installs only on request.** `autoDownload` and
  `autoInstallOnAppQuit` are both set explicitly in `checkUpdates()`, the second
  to `false`: 0.1.0 → 0.2.0 shipped with electron-updater's default quit
  handler and the silent NSIS run froze the machine for several seconds at the
  moment the owner closed the app. `update-downloaded` now stores
  `this.pendingUpdateVersion`, sends the `update-ready` `{version}` IPC (the
  renderer's persistent green banner, `#updateReady` in `src/index.html`) and
  tells the tray to grow a "Restart and update" item. The banner's button and
  that item both reach `MainWindow.installUpdate()` — the single installer
  trigger — via `ipcMain.handle('install-update')`. A renderer that loads after
  the download (reopened from the tray) asks with `get-pending-update` instead
  of waiting for the push. `installUpdate()` sets `app.isQuiting = true` first,
  or the window's `close` handler hides the window and `app.quit()` never
  completes; then it stops the detector, destroys the tray, launches the
  installer itself (see below) and quits. **electron-updater does the check and
  the download; it does not do the install.** "Later" in the banner is renderer-session state
  only — main and the tray keep the pending update. The
  `checkForUpdatesAndNotify` toast text is overridden too; its default promises
  an install on exit, which is now a lie.
  Guarded by `app.isPackaged` — **do not** redefine `app.isPackaged` to test it
  the way the reference did; build a real package instead. Also guarded by the
  `checkForUpdates` setting (default true, Settings › General). Every error path
  only logs: being offline must never be more than a toast. This is the app's
  **only** network request — if you add another one, the README "Network use"
  section and the in-app FAQ both have to change. `hmo-updater.exe` makes none
  either: the only URL it knows is the releases page, and only `Process.Start`ed
  from the error screen's button, user-initiated like the Credits links.
- **The installer runs at idle priority, launched by us, not by
  electron-updater.** `NsisUpdater.doInstall` spawns it at normal priority, and
  unpacking ~350 MB (7z to temp, copy into the install dir, Defender reading
  every file) saturates the disk hard enough to make the owner's mouse cursor
  stutter for seconds — I/O, not CPU (Discord audio stayed clean).
  `spawnInstallerAtLowPriority()` therefore runs
  `cmd.exe /c start "" /LOW /B "<installer>" --updated --force-run` with
  `{detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true}`
  then `unref()`. Details that are all load-bearing:
  - `start /LOW` = `IDLE_PRIORITY_CLASS`, and Windows derives the **I/O**
    priority from the priority class — that is the whole point. Node's `spawn`
    has no priority option, and `os.setPriority` only works after the fact (it
    is still called on `child.pid`, which is the transient cmd, as a freebie).
  - `""` is the title `start` always eats first; drop it and the quoted
    installer path becomes the window title and nothing runs.
  - `/B` suppresses a new **console** only — a GUI app still shows its window,
    so the one-click installer's progress dialog appears as before (verified
    with `start "" /LOW /B notepad.exe` → visible window, `PriorityClass` Idle).
  - `windowsVerbatimArguments: true` is what makes a path with spaces work; the
    args mirror `NsisUpdater.doInstall` for non-silent + force-run (`--updated`,
    `--force-run`, **no** `/S`). `/D=` and `--package-file=` are only added
    there for a custom install dir or a web installer; this build has neither.
  - The **relaunched app does not inherit idle priority**: `StartApp`
    (`templates/nsis/common.nsh`) uses `${StdUtils.ExecShellAsUser}`, so the new
    instance is started by the shell, not as a child of the installer.
  - The installer path comes from the `update-downloaded` event's
    `info.downloadedFile` (`electron-updater/out/types.d.ts`
    `UpdateDownloadedEvent`), stored as `pendingInstallerPath`; the fallback is
    `autoUpdater.downloadedUpdateHelper.file`.
  - Non-win32, no path, missing file or a throw → fall back to
    `autoUpdater.quitAndInstall(false, true)` and log why. A `spawn` failure is
    reported **asynchronously** via an `'error'` event, so the child gets a
    listener — an unhandled one is an uncaught exception.
  - `installStarted` guards a double click on the banner; electron-updater's own
    `quitAndInstallCalled` no longer covers us.
- **Only the NSIS build self-updates.** The portable exe has nothing installed
  to replace; that is stated in the README. `app.isPackaged` is true in the
  portable build as well and electron-updater 6.x has **no** portable guard of
  its own, so `checkUpdates()` returns early when
  `process.env.PORTABLE_EXECUTABLE_DIR` is set (electron-builder's portable
  launcher always sets it). Without that check the portable user would be
  offered the NSIS installer, and installing it would leave the portable exe
  they actually launched at the old version.
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
- **A system hotkey that changes a setting follows `rotate-map`.** `opacity-up`
  / `opacity-down` (Ctrl+Up/Down, 0.1 steps, 0.1..1.0) and `size-up` /
  `size-down` (Ctrl+Shift+Up/Down, 25 px steps, 50..800) all do the same four
  things in `src/js/maps.js`: write the setting, sync the Settings slider if it
  exists, re-send the current map so **main** recomputes the window bounds, and
  toast the new value. Do not resize the overlay from the renderer — only
  `map-change` knows the rotated bounding box.
  The step arithmetic is pure (`stepOpacity`/`stepSize`) because `0.6 + 0.1` is
  `0.7000000000000001` and `0.7 + 0.1` is `0.7999999999999999`: without the
  round-to-one-decimal the stored opacity drifts off the slider's own grid after
  a couple of presses. The clamps are the slider `min`/`max` in
  `src/index.html`; keep the three in step.

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
  | ordinary gameplay (fails the Tab gate) | 6.2 ms mean (5.7-9.4) | **0.9 %** | 12 ms |
  | Tab screen (full NCC over 4 templates x 15 offsets) | 21.8 ms mean (19.8-42.2) | **3.1 %** | 25 ms |

  Plus ~17 ms of *async native* capture that does not block the loop. Note the
  0.1-0.9 ms figure quoted below for `matchMap()` is the **gated-out** case;
  a frame that passes the Tab gate costs ~16 ms, and that is the number that
  matters at this cadence. It is still only the second or two per match that
  the player is actually holding Tab.
- **Detection never fights the user, and main is not the judge of "changed".**
  A manual pick does not stop the loop. Main sends `show-map-command` for
  **every accepted match**, throttled to one per key per 2000 ms
  (`SendThrottle`, so a held Tab does not spam IPC), and `src/js/maps.js`
  drops it when `currentKey === key` (no re-send, no label flash) and reports
  the verdict back on `map-detector-applied` for the log. 0.3.0 compared
  `match.key !== lastDetected` in main, which is *not* what is on the overlay:
  after a manual pick, the same map detected again looked unchanged and was
  never re-applied. `lastDetected` now only gates the menu clear and drives the
  status line. `shouldApplyDetected()` is pure and tested.
- **`clear-map` (Ctrl+Shift+D) is not `toggle-map`.** It hides the map *and*
  sends `map-detector-reset`, which clears `lastDetected` and schedules an
  immediate tick. Without the reset, hiding a detected map would leave the
  overlay blank for the rest of the match: the loop would keep seeing the same
  map, decide nothing changed, and never re-show it.
- **The overlay label rides on the existing `map-change` payload.** It travels
  as the 6th and 7th arguments of the overlay's `map-change` (`mapLabel`,
  `labelMode`), never as a second IPC message — the overlay must never be able
  to name a map it is not showing. The `mapLabel` **setting** decides:
  - `auto` (default, the original behaviour): a label only when the caller sent
    one, which only an automatic detector switch does (`Maps.sendMap` passes
    `{mapLabel: entry.name}`). `src/map/renderer.js` shows it for 3 s and
    clears it on the next `map-change` / `map-hide`. The settings preview is
    suppressed in this mode.
  - `always`: the caller's label, or the name main resolved from the catalogue.
    The overlay keeps it up (no timer).
  - `never`: main sends an empty label, so nothing downstream has to know.
  The OBS window gets the same two arguments and applies the same rule. The
  label is unrotated, bottom-aligned (it lives in the 10 % of extra height the
  rotated bounding box already has) and uses the map's own opacity.
  The settings preview *does* now carry a label (`overlay.sampleMap`) so
  `always` can be seen in the Overlay tab before it is turned on for real —
  main only forwards it in `always` mode.
- **Home-page status line**: "Off" / "Watching for the in-game map (Tab)…" /
  "Back in menu — map cleared" / "Detected <Map> at HH:MM", driven by the
  `map-detector-status` push plus one `invoke` at startup. The renderer keeps
  the last status so it can re-render the line in a new language.
- **The main menu ends the match** (`hideInMenu`, default **true**, Settings ›
  General). `matcher.js` carries a second template — the menu's navigation
  strip, `MENU_STRIP_REL` = x 45..760, y 20..68 at 1919x1079, measured off
  `detection-fixtures/menu-main.png` — in its own `menu` section of
  `templates.json`, keyed by nothing so it can never be a candidate in the map
  match. It is a **96x12** thumbnail, not 64x64: the strip is ~15:1 and
  squashing it square throws away the horizontal detail that is the whole
  signal. Scoring is the same luminance+gradient NCC; threshold `MENU_MIN_SCORE`
  0.75 against measured positives 0.962–1.000 and a best negative of 0.417.
  `gradientMagnitude(thumb, width, height)` takes a height now — it defaults to
  `width`, so the square map calls are unchanged.
  Four guards, all load-bearing:
  1. **Only on a tick that failed the Tab gate.** `matchMap` is called with
     `{report: true}` so `gated` is visible; a Tab screen never reaches the menu
     matcher, and an accepted match resets the counter.
  2. **Only while a map is on the overlay** — `shownKey`, not `lastDetected`
     (0.3.3). The renderer sends `map-detector-shown` `{key|null}` from **every**
     `Maps.sendMap`, hides included, and main keeps it whether or not the loop
     is running; `shouldWatchMenu(shownKey, hideInMenu)` is the pure gate.
     0.3.2 gated on `lastDetected`, i.e. "did the loop recognise a map?", and
     the field log shows the hole: through an evening of party matches the
     matcher accepted nothing, the maps were picked by hand, `lastDetected`
     stayed null and the menu matcher never ran once — not one `menu-streak`
     line. `lastDetected` is now only the status line and the "changed" flag.
     `menu-clear` clears `shownKey` optimistically; the renderer confirms a
     moment later, and it also reports its state once on load, so a renderer
     that came back from a crash reload cannot leave `shownKey` stale. Keys
     reaching `detector.log` go through `logKey()` — `detector.log` is in the
     diagnostic zip and a custom map's key is a name the user typed.
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
  4. **It hides through the renderer** (`menu-hide-map` → `Maps.sendMap("")`),
     not straight at the overlay window, so `Maps` keeps owning `currentKey` and
     Ctrl+H still restores the map. `lastDetected` is cleared for the same
     reason `clear-map` clears it: otherwise the next match on the same map
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
  streak change, every menu clear, every `show-map-command` sent, the
  renderer's `applied`/`same-as-current` answer, and capture errors. Not gated on DEBUG —
  it exists so the owner can send it after a session that misbehaved
  (**Settings › General › Open log folder** → `shell.openPath(userData)`, IPC
  `open-log-folder`). Rotated at 512 KB keeping one `.1` backup. Since 0.3.2 the writer
  itself is `core/rotating-log.js`, shared with `app.log`; this file is only the
  detector's policy (name, cap, unbuffered writes).
  A write failure is logged once and never breaks a tick.

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

## Field diagnostics (0.3.2)

Spec: `docs/SPEC-0.3.2.md`. Built for one sentence — *"it does not work"* — from
a friend who is not going to run a command. Zero telemetry: everything is a
local file, and the user decides whether to send it.

- **Two logs, one writer.** `rotating-log.js` is the writer; `detector.log`
  (512 KB, unbuffered, decisions only) and `app.log` (1 MB, buffered 500 ms,
  200-line ring buffer) are separate *files* on purpose — a single match writes
  far more detector lines than app lines and one file would bury the other.
  Line format: `<ISO> [level] <event> k=v …`, one event per line always. A level
  is optional so detector lines are byte-identical to what 0.3.1 wrote.
- **Never log a path, a frame, or user text.** Every string value that reaches
  `app.log` goes through `redactHome` (`shared/redact.js`, tested against both
  separator spellings and a home directory full of regex metacharacters), so a
  stack trace or an `ENOENT` becomes `~/…`. A map key is logged only when it is
  a *shipped* map; a custom map is `(custom)`, because its key is a name the
  user typed. Custom maps appear as a **count** in the startup snapshot and
  nowhere else. The detector's "no frames, no pixels" rule is unchanged.
- **`appLog` is a singleton, not an injected dependency.** Nearly every module
  in `src/core` logs something and several are built before the one that would
  own the logger. `require('./app-log')` and call `event()`/`warn()`/`error()`.
  `init()` (from `index.js`, before anything else) points it at userData;
  before that, writes land in the ring buffer only, which is deliberate — a
  crash during module construction still has context.
- **`map-change` carries a `source`** (click/hotkey/cli/detector/preview/
  settings/hide) from the renderer, because only the renderer knows which it
  was, and "the map changed and I did not do it" is a real support question.
  Main collapses consecutive identical `key`+`source` pairs into one line: a
  slider drag re-sends the same map once per pixel.
- **Crash policy**, and each half is deliberate:
  - `uncaughtException` → log, flush, write `crash-<ISO>.txt` (version, message,
    stack, the 200-line ring buffer), then `process.exit(1)`. **Not swallowed**:
    an app that keeps running after an unhandled throw in main is in an unknown
    state, and "it just froze" is what that looks like from outside.
  - `unhandledRejection` → logged as an error, the app lives. A rejected promise
    nobody awaited is usually one broken feature, not a broken process.
  - `render-process-gone` → reload the window **once** (a lone renderer death is
    normally a GPU hiccup); a second within 60 s is a crash loop, so it becomes
    a crash file and a quit. `reason === 'clean-exit'` is not a crash.
  - **Never navigate from inside a `render-process-gone` handler.** This is the
    one that bites. A synchronous `webContents.reload()` there kills the
    *entire app* on Electron 40.10.6: browser, GPU, utility **and the untouched
    overlay renderer**, gone within ~6 s, exit code `0x80000003`
    (`STATUS_BREAKPOINT`, a Chromium `CHECK`), with no JS running afterwards —
    so the queued log line never reaches disk and the next start shows no crash
    notice. Reproduced 4/4 on packaged builds; it is Electron issue #19887 and
    the fix in PR #53924 (post the navigation after the dead frame host is torn
    down). `MainWindow.scheduleRendererReload()` therefore defers with a 100 ms
    `setTimeout` and re-checks `isDestroyed()`; the overlay window does the
    same. Note the failure mode is *worse than doing nothing*: 0.3.1 had no
    handler and survived a renderer death with a dead window and a live
    overlay.
  - `appLog.flush()` runs **synchronously** right after the
    `render-process-gone` line. It is rare, it is one small append, and the
    whole value of the line is that it outlives whatever happens next.
  - At most 5 crash files. The name carries the time and sorts chronologically
    as a plain string — `lastCrashSeen` (a setting) is compared against it with
    `>=`, no date parsing, nothing a copied file can make lie.
- **A `process.on('uncaughtException')` listener changes what a sync write
  costs.** Electron's default was a dialog and a living app; now an unhandled
  throw in main writes a crash file and exits. So **every synchronous fs write
  reachable from a synchronous handler must be wrapped**: `Settings.write()`
  (the overlay `moved` handler calls it on every drag) and both `hotkeys.json`
  writes are, and a new one must be. `ipcMain.handle` bodies are safe — a throw
  there is a rejected invoke — which is why `user-data.js` needs nothing.
- **The report is a file list, not a directory walk.** `LOG_FILES` in
  `diagnostics.js` plus the `crash-*.txt` plus two generated texts
  (`system.txt` and a redacted `hotkeys.json`) — so "no screenshots, no maps"
  is checkable by reading one constant.
- **`hotkeys.json` is redacted on its way into the zip**, which is why it is
  *not* in `LOG_FILES`: every entry names the map it is bound to, and a custom
  map's key is `Custom/` + a name the user typed. `redactCustomMapKeys`
  (`shared/redact.js`, pure, keyed on the catalogue's own `CUSTOM_CREATOR`)
  rewrites those to `Custom/(custom)`. Textual, not parse-and-rewrite: a
  `hotkeys.json` that will not parse is itself worth seeing in a report and has
  to be redacted too. The README's "no custom map names" is a promise, so it is
  kept rather than softened.
- **The success toast names the folder the file is actually in.**
  `diagnostics.created` (Desktop) vs `diagnostics.createdFallback` (next to the
  logs) — after the userData fallback, saying "Desktop" sends the user looking
  where the file is not.
  `buildDiagnosticReport({files, texts, outDir})` is fs-only and never throws;
  a missing file is a `skipped` entry, not a failure. Desktop, falling back to
  userData (a redirected OneDrive Desktop must not lose the report).
- **The zip writer is ours** (`diagnostics/zip.js`, `node:zlib`). No
  `archiver`/`adm-zip` — a new runtime dependency is not worth a hundred-line
  format in an app that ships 350 MB per update. Two traps it already avoids,
  both covered by tests: method 8 needs `deflateRawSync` (a zlib header makes
  every unpacker refuse the file), and an entry deflate would *grow* is stored.
  `readZip` exists so the round-trip test proves the bytes are a real archive
  rather than proving the writer agrees with itself.
- **The hotkey-conflict health check is a banner, not a toast.** `safeRegister`
  records every failure on `Hotkeys.conflicts`, rebuilt from scratch on each
  `loadKeys()`; the toast is suppressed while `bulkLoading` is true, because a
  reload binds a dozen accelerators at once and five toasts a session is
  something a user learns to dismiss without reading. That gate covers the
  `systemShadowsMap` toast too. The renderer both listens for
  `hotkey-conflicts` and asks with `get-hotkey-conflicts`, since registration
  happens before the window finishes loading.
- **A persisting conflict is logged once, not once per reload.** `loadKeys()`
  runs at least twice per start (`createWindow`, then the renderer's
  `load-hotkeys`) and again after every hotkey edit. `noteConflict` skips the
  log line when the accelerator was already failing at the end of the previous
  load (`previousConflicts`), so a Discord user gets N lines on the first load
  and nothing after — a *new* conflict is still news. The banner is rebuilt
  from `conflicts` regardless.
- **The renderer never writes the log.** It has `nodeIntegration: true` and
  could, but two processes appending to one file with two size caches lose
  lines at the rotation boundary. `window.onerror` and `unhandledrejection` are
  forwarded over `renderer-error` and main writes them.

## Translation (English + Italian)

`src/shared/i18n.js` is the whole mechanism: two flat JSON catalogues, dotted
keys, `{param}` placeholders, no framework. Setting `language` = `system`
(default), `en`, `it`.

- **Everything user-facing goes through it.** The test
  `test/i18n.test.js` scans the source for keys and fails on a key with no
  translation, on a catalogue string nothing uses, on a key set that differs
  between the two files, on a `{param}` one language dropped, and on a
  `<label>`/`<button>`/`<option>`/`<th>`/`<hN>` in `src/index.html` with no
  `data-i18n`. Nothing in the test names a key — the source *is* the list.
- **Not translated, on purpose**: map names, creator names, the product name
  ("Halloween Map Overlay" in the title bar, the nav brand, the preview canvas),
  the OBS window title (renaming it would break users' existing OBS sources),
  OS-supplied display names, and the two language names in the picker (marked
  `data-i18n-ignore`, which is also how the test is told an element is exempt).
- **Static markup**: `data-i18n` (text), `data-i18n-html` (strings containing
  `<kbd>`/`<strong>`/`<a>` — the FAQ and the longer help paragraphs),
  `data-i18n-title`, `data-i18n-placeholder`, `data-i18n-aria-label`. The `-html`
  form only ever inserts our own catalogue strings; everything else still goes
  through `escapeHtml`.
- **Main never sends English.** `sendUpdate('…')` is `sendUpdate(msg('key'))`
  and the renderer translates on arrival (`translateMessage`), so a toast that
  is already on screen when the language changes is not stranded. The same for
  the `{ok, message}` an IPC handler returns to the hotkey toast. The exceptions
  are the two things **main draws itself** — the tray menu and the
  "already running" dialog — which use `Language.t()` / `t(lang, …)`.
- **A parameter can itself be a message.** `"X is already bound to <action>"` is
  one sentence with a translatable noun inside it, and main does not know the
  window's language, so the inner half travels as `{key}` too and `t()` resolves
  it in the same pass. See `conflictMessage` in `src/core/hotkeys.js`.
- **`SYSTEM_HOTKEY_DEFS` carries both** `description` (English, the fallback and
  the documentation) and `descriptionKey`. A test asserts they agree, so the
  two cannot drift.
- **Dynamic content must re-render.** `i18n.onChange(cb)` in the renderer: the
  gallery, both hotkey tables, the custom list, the detector status line, the
  monitor picker, the update banner and the cached preview canvas all register
  one. Anything built with `t()` at render time and *not* registered keeps the
  old language until something else touches it.
- **Resolution happens in main**, once (`src/core/language.js`,
  `app.getLocale()` → `it*` → it). The renderer asks with `get-language`, writes
  with `set-language`, and main pushes `language-changed` to the window and
  rebuilds the tray from the same callback. The second-instance branch in
  `index.js` has no `Settings`, so it uses
  `Language.languageWithoutSettings()`, which reads the file directly rather
  than registering a second set of IPC handlers in a process that is quitting.
- `DEBUG=true` logs `i18n::applyDom <lang> elements=N` — a DOM that was not
  translated otherwise looks exactly like a DOM that happens to be English.

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

## Commands

```bash
npm install
npm start              # dev run (DEBUG=true opens devtools and the menu)
npm test               # node --test over test/**/*.test.js
npm run prepare-maps   # crop maps-src/*.webp → maps/, render build+app icons
npm run prepare-detector # detection-fixtures/tab-*.png → templates.json
npm run build-updater  # updater/*.cs → build/updater/hmo-updater.exe (csc.exe)
npm run build:win      # build-updater, then NSIS installer + portable into dist/
```

## Releasing

`.github/workflows/release.yml` runs on a pushed `v*` tag only — nothing is
published by an ordinary push to `main`. It runs `npm ci`, `npm test`, then
`npx electron-builder --win --publish always` with the workflow's own
`GITHUB_TOKEN` (needs `permissions: contents: write`).

**The NSIS build is `oneClick: true`, `perMachine: false`, and that is load
bearing for the update flow.** `installSection.nsh` relaunches the app after a
one-click install when `${ifNot} ${Silent}` **or** `${isForceRun}`; the
*assisted* branch (`oneClick: false`) does so only when `isForceRun` **and**
`Silent`. So a visible (non-silent) install under the old assisted installer
would have left the user staring at a finish page with the app closed. Visible
install and automatic relaunch therefore come as a pair — changing either one
back breaks the other. `perMachine: false` with `oneClick: true` also drops
`INSTALL_MODE_PER_ALL_USERS_REQUIRED` (`NsisTarget.js:445`, which the assisted
build always defined), so the self-update no longer raises a UAC prompt — an
unattended prompt would have stalled the update behind a dialog nobody sees.
Note `allowToChangeInstallationDirectory` must be `false`: electron-builder
refuses `oneClick: true` together with it.

## The themed updater (0.5.0) — `updater/` + `src/core/update-helper.js`

Spec: `docs/SPEC-UPDATER.md`. Installing an update looks like the app: the
renderer's *Updating to X.Y.Z* view → `hmo-updater.exe` at the same window
bounds → the new version's loading overlay. The stock NSIS banner is never seen
on the happy path. **Nobody can be stranded on an old version by this feature.**

- **Three tiers, in `installUpdate()`**, each falling through to the next:
  themed helper (`/S`, silent NSIS) → `spawnInstallerAtLowPriority()` (the
  visible one-click installer, 0.2.3 behaviour, unchanged) →
  `autoUpdater.quitAndInstall`. Tiers 2 and 3 were not touched; only the order.
- **The handshake is the whole safety story.** `launchUpdater()` resolves
  `ok: true` only after the helper has written its ready-file, and the app does
  not call `app.quit()` before that. No file within **4 s**, a spawn error, a
  missing folder → log line, tier 2. That is what makes an antivirus block
  harmless, and it is the one invariant never to weaken.
  The helper writes the file from `UpdaterWindow.Ready`, which fires after the
  first frame **and** the fade-in — not right after `Show()`. Writing it earlier
  takes the app's identical picture away while the helper is still at opacity 0,
  and the user sees the desktop for a fifth of a second.
- **The other half of the handshake is `<ready-file>.abort`.** When the app
  gives up on the helper it writes that file *before* killing it and moving to
  tier 2; `Runner.AbortedByApp()` checks it after `--wait-pid` exits and leaves
  quietly (exit 3). Without it, a helper that was merely slow and survived the
  kill would see the app quit and start a second, silent installer on top of
  the stock one. Likewise the helper writes **no** ready-file once it has
  already failed (`RaiseReady` checks `_allowClose`): `Runner` starts before the
  fade-in ends, and an app that quits for a helper showing an error screen has
  skipped a fallback that would have worked.
- **`installUpdate()` is single-flight** (`installInFlight`). `installStarted`
  is only set once a tier has started, and tier 1 awaits for up to 4 s; banner +
  tray inside that window used to spawn two helpers.
- **The helper's minimum size is 560x380 DIPs, not pixels.** `helperBounds`
  takes the primary display's `scaleFactor`; WPF lays out in DIPs, so 560 px at
  150 % is 373 DIPs and the error state does not fit.
- **The helper's own relaunch passes `--updated`**, like NSIS's `StartApp`. A
  second instance with *no* argument shows the "already running" box
  (`index.js`), which is what a slow-to-show first instance would have produced.
- **The working copy does NOT go in `%TEMP%`.** It goes in electron-updater's
  own cache directory, `%LOCALAPPDATA%\<updaterCacheDirName>\helper-<version>-<random>\`,
  next to the `pending\` folder the installer was downloaded into
  (`helperHome()`, and `MainWindow.updaterCacheDir()` asks
  `autoUpdater.downloadedUpdateHelper.cacheDir` first). It cannot run from
  `resources/updater` — NSIS deletes that during the update. See the Bitdefender
  trap below for why `%TEMP%` is not an option.
- **`getContentBounds()`, not `getBounds()`,** and converted with
  `screen.dipToScreenRect`. The main window has a native frame, so the outer
  rectangle is ~32 px taller than the page; a helper centred in it draws the
  same picture ~16 px lower and the hand-over visibly jumps.
- **The two screens are one picture, so the numbers are duplicated on purpose.**
  `.updating-*` in `app.css` carries the same 84 px mark and the same
  24/9/20/(12+16)/18 px gaps as `updater/UpdaterWindow.cs`, the same
  `<460 px` compact rules, and `line-height: 1.3` instead of Bootstrap's 1.5
  because a WPF `TextBlock` is exactly one font line box tall — with 1.5 the
  three CSS boxes were together 8 px taller and, the column being centred, the
  mark and the headline sat 4 px off. Verified by comparing row bands of the two
  renders; they now agree within 1 px. **Change one, change the other.**
  `test/updater-strings.test.js` asserts the *words* match as well.
- **The progress mapping is measured, and mostly not from the folder size.**
  Sampling a real uninstall and a real install of a 562 MB test product every
  400 ms:
  - uninstall: full for **6.6 s**, then 562 MB → 0 *between two samples* (one
    `RMDir /r`, a metadata operation). A cliff, not a ramp.
  - install: 0 for the first **6.1 s** (NSIS writing and unpacking the payload
    in `%TEMP%`, invisible here), then 47 KB → 260 MB → 559 MB → 562 MB between
    6.5 s and 11.0 s. The copy is ~4.5 s of the 11.
  - the same work at the idle priority the helper uses: **27.4 s** end to end.

  So the size is 100 %, then 0, then 100 % again in three samples. The first two
  phases are therefore driven by the **clock**, with an *exponential approach*
  (`Runner.Approach`) rather than a linear creep with a cap: it never arrives,
  so the bar is never frozen, and it can never overrun into the next phase.
  Only the copy is size-driven, and it gets the last ~25 %.
  The **combined** update was finally observed through the helper (verification
  run, 562 MB product): folder full for ~8 s, cliff to 0, a ~3.5 s stall, the
  copy in **under 1 s**, and then **4-9.5 s more** before the installer exits
  (shortcuts, registry, deleting 7z-out and old-install from `%TEMP%` at idle
  priority). So the copy is capped at 90 % and a third exponential approach
  (`TailCapPercent` 99, `TailTau` 8 s, log event `copied`) covers that tail —
  the first mapping parked the bar on 97 % for 9.5 s. Also measured:
  `Process.Start` on a never-scanned 292 MB installer took **28 s** under
  Bitdefender; the bar is indeterminate for that stretch.
  `RemoveGiveUp` (25 s) exists because an install whose registry entry is
  missing never uninstalls anything and the folder never shrinks at all.
- **Never claim the old version can be relaunched just because the exe exists.**
  An installer killed during `CopyFiles` leaves the 214 MB executable on disk
  with `resources\` still missing; launching it does nothing at all (measured —
  the process starts and exits with no window). `Runner.Relaunchable()` checks
  for `resources\app.asar`, and the error screen says "finish it from the
  download page" instead of offering a button that would do nothing.
  Re-running the installer over that state repairs it completely (measured).
- **Strings are generated, not read at runtime.** `scripts/build-updater.js`
  turns `updater/strings.json` into `Strings.g.cs` with every non-ASCII
  character escaped as `\uXXXX`, because csc's default source encoding follows
  the machine's ANSI codepage and an `è` in a .cs file is a coin toss between a
  laptop and a CI runner. It also means a missing or corrupt JSON cannot strand
  a user mid-update.
- **WPF specifics that are load-bearing**: `AllowsTransparency = false` (a
  layered window gets no DWM decoration, so it would lose the Windows 11 rounded
  corners *and* the shadow); `SetWindowPos` in physical pixels, applied both in
  `SourceInitialized` and `ContentRendered` (WPF re-applies its own DIP
  Width/Height when the window is first shown); `EasingMode = EaseIn` on the
  cubic-bezier easing or the base class mirrors every curve; the trailing
  separator on the fonts `Uri` or `"./#Geist"` resolves against the exe's folder
  and finds nothing.
- **Debug switches**, documented in `docs/BUILD.md`: `--demo`, `--demo-fail`,
  `--screenshot <path> [--screenshot-after <ms>]` (RenderTargetBitmap, then
  exit). The app never passes them.

### Bitdefender, unsigned executables and `%TEMP%` — a real trap

Found the hard way on the development machine, twice in one session:

- Running the freshly built **unsigned NSIS installer with `/S` from a folder
  under `%TEMP%`** made Bitdefender's Advanced Threat Defense fire
  *"Malicious behavior blocked … blocked all applications involved"*
  (`SuspiciousBehavior.22E1418466DA1`). It killed the whole launching process
  tree — including the terminal that started it — and neutralised the installer
  by lower-casing its `MZ` signature to `mz`, so it could never run again.
  The same installer run from `dist/` was fine. **Never run an unsigned
  executable out of `%TEMP%`**, in a test or in the product; that is why the
  helper's working copy lives in the updater cache, where electron-updater has
  always downloaded and run the installer.
- Bitdefender also **silently dropped that installer's registry writes**: the
  key under `HKCU\Software\<APP_GUID>` and the `…\Uninstall\<GUID>` key were
  created with *no values*. The app installed and ran, but NSIS then had no
  `UninstallString`, so later updates never uninstalled the old version and
  overwrote it in place. `RemoveGiveUp` in `Runner.cs` exists for exactly that
  shape, and it is worth remembering when a user reports "the update did
  nothing" with no Add/Remove Programs entry.
- It also denied recreating a specific scratch file path it had already acted
  on (`EPERM` on rename, `Permission denied` on write), while a different file
  name in the same folder worked.

None of this is worked around in the product, and nothing is whitelisted; the
design simply avoids the shapes that look like malware.

### The installer window is ours (0.3.4) — `build/installer.nsh`

The one-click installer has no wizard pages to theme: `oneClick.nsh` inserts
only `MUI_PAGE_INSTFILES` and `common.nsh` sets `ShowInstDetails nevershow`.
What the user actually looks at is the **SpiderBanner** dialog
`installSection.nsh` puts up right after the section starts. Dumping the only
`RT_DIALOG` (id 104, 254x78 dlu) out of
`nsis-resources-3.4.1/plugins/x86-unicode/SpiderBanner.dll` gives the whole
canvas — and electron-builder uses one control of five:

| id | control | rect (dlu) | who fills it |
|---|---|---|---|
| 1025 | static `SS_ICON` | 10,10 20x20 | `nsis.installerHeaderIcon` → `HEADER_ICO` |
| 1000 | static | 40,10 204x11 | template: `$(installing)`; **us**: the headline |
| 1002 | static | 40,22 204x11 | empty in the template; **us**: the sub-line |
| 1003 | static | 10,38 234x18 | still empty — free real estate |
| 1001 | `msctls_progress32` | 10,59 234x11 | the progress bar |

`build/installer.nsh` (named explicitly as `nsis.include`, though the file name
is also electron-builder's default) defines three things:

- `customHeader` — the eight `LangString`s. It is inserted **after**
  `!insertmacro addLangs`, which is the point at which `${LANG_ENGLISH}` and
  `${LANG_ITALIAN}` exist. `nsis.installerLanguages` is pinned to `en_US`,
  `it_IT` (the two the app speaks) so no other language table can reference an
  unset string; NSIS picks the one matching the OS and falls back to the first.
- `customCheckAppRunning` — the only hook that runs **while the banner is up
  and before the 350 MB unpack**. `customInit` is in `.onInit` (no GUI yet) and
  `customInstall` runs after the files are already in place, so neither can
  touch the banner in time. This hook *replaces* the stock app-running check, so
  the file re-inserts `IS_POWERSHELL_AVAILABLE` + `_CHECK_APP_RUNNING` itself —
  and does the UI first, because `IS_POWERSHELL_AVAILABLE` shells out to
  PowerShell twice and costs about a second. Defining the macro also disables
  the `!ifmacrondef customCheckAppRunning` guard in
  `include/allowOnlyOneInstallerInstance.nsh` that normally supplies
  `getProcessInfo.nsh` and `Var pid`; the file provides both.
- `hmoBannerText` — finds the banner the same way the template does (second
  `#32770` child of `$HWNDPARENT`) and `WM_SETTEXT`s controls 1000 and 1002.
  Guarded by `!ifndef BUILD_UNINSTALLER` (`uninstaller.nsh` inserts
  `CHECK_APP_RUNNING` too), `!ifdef ONE_CLICK` and `${IfNot} ${Silent}`.

Two traps:

- **makensis runs with `-WX`.** Redefining the stock `installing` message would
  be "LangString set multiple times", i.e. a failed build. New ids only.
- **The strings are not greppable in the built exe.** `SetCompressor zlib`
  (`NsisTarget.js:267`) means the NSIS header — string table and language
  tables — is raw-deflate compressed. To prove text is in an installer: find the
  `firstheader` (the `0xDEADBEEF` + `NullsoftInst` signature, ~85 KB in), read
  the `int` 28 bytes later, `zlib.inflateRawSync` that block, then search the
  result for the UTF-16LE string. Done for 0.3.4; all eight strings, the
  `installerHeaderico.ico` file name and the absence of the German/Spanish
  stock messages were confirmed that way.

Wording branches on `${isUpdated}` — the same `--updated` flag
`spawnInstallerAtLowPriority()` passes — so a first install does not claim to be
updating. Control 1002 does not wrap: keep a sub-line under ~55 characters.

`build/icon.ico` is electron-builder's own PNG→ICO conversion of
`build/icon.png`, copied out of `<output>/.icon-ico/icon.ico` from an earlier
build (7 PNG-compressed entries, 16→256). Regenerate it the same way after
`npm run prepare-maps` changes the icon; it feeds `nsis.installerIcon`,
`installerHeaderIcon` and `uninstallerIcon`.

**`build.compression: "store"` barely does anything for the NSIS target —
measured, not assumed.** It was set to kill the several-second 100 % CPU spike
the owner felt while the 0.1.0 → 0.2.0 installer unpacked its ~350 MB payload.
electron-builder reads it (`packager.compression`) and does pass
`-XSetCompress off` to makensis, so the NSIS stub itself is stored — but the
**app payload is not**: `NsisTarget.buildAppPackage` routes the archive through
`configureDifferentialAwareArchiveOptions`
(`app-builder-lib/out/targets/differentialUpdateInfoBuilder.js`), which
hard-assigns `compression = "normal"`, `dictSize = 1`, `solid = false` with the
comment "do not allow to change compression level to avoid different packages".
The payload 7z is therefore always `-mx=9 -md=1m -ms=off`. Measured on 0.2.1:

| build | installer |
|---|---|
| `compression: "store"` (tried in 0.2.1, reverted) | 93.6 MB |
| `ELECTRON_BUILDER_COMPRESSION_LEVEL=0` on top | 112.8 MB — `-mx=0` is pushed but `-md=1m` keeps LZMA on |
| 0.2.0, no `compression` key | 92.7 MB |

win-unpacked is 348 MB, so none of those is a stored payload. The **only**
switch that really stores it is `nsis.differentialPackage: false`, and
`NsisTarget.js` makes the `Setup.exe.blockmap` conditional on that same flag
(line ~308), so it also throws away differential updates: every future update
would download the whole installer. The two goals are mutually exclusive as
electron-builder stands. The key was therefore **removed again** rather than
left in pretending to do something. The install's cost is mostly disk anyway
(~350 MB unpacked to temp, then copied), which no compression setting changes;
0.2.1 makes that cost *visible* with a one-click installer window instead of
trying to make it smaller, and 0.2.3 makes it cheap for everything *else* on the
machine by running the installer at idle priority. Do not re-add `compression`
expecting a faster install.

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

*Last updated: 2026-09-18 (0.5.1)*
