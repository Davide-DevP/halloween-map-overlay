# AGENTS.md — Halloween Map Overlay

Entry point for every agent here. Read **this whole file**, then the one
document from the [index](#index--read-before-touching) that covers what you are
about to touch: [`docs/agents/`](docs/agents/) carries the reasoning, and the
reasoning is what stops the next agent from undoing a fix.

## Project

Transparent in-game map overlay for **Halloween: The Game**. Electron desktop
app (Windows first, Linux works). Four community maps ship inside the app; the
user picks one and it appears on a click-through always-on-top window. OBS
window with a green background for streamers.

- **License**: Apache-2.0
- **Derived from**: `LucaFontanot/dbd-map-overlay` (Apache-2.0) — see `NOTICE`
- **Stack**: Electron 40, plain CommonJS (no TypeScript, no bundler), Bootstrap 5
  + jQuery 4, `node-screenshots`, `koffi`, electron-builder (NSIS + portable),
  npm. Full table and the annotated module list:
  [`docs/agents/architecture.md`](docs/agents/architecture.md).

## The non-negotiable rules

Every change must respect all of these.

1. **Scope rule**: this is a *map viewer*. No telemetry, no memory reading,
   nothing that touches the game process. It makes exactly four kinds of outside
   contact, all opt-out/opt-in and all documented in the README and the in-app
   FAQ: the GitHub Releases update check and the **map-pack check** (both on by
   default, behind **one** switch since 1.0 — Settings › General › *Look for
   news by itself*; the pack check is a GET of one public file on
   `raw.githubusercontent.com`, at most once per 24 h, see
   `docs/SPEC-MAP-PACKS.md`), the automatic map detection's screen capture
   (**off** by default, the home-page switch and Settings › Map, which are one
   setting) and — since 0.7 — Tab-map mode's
   **key-state read** (**off** by default, Settings › Map › *Where do you want
   to see the map?*: one `user32`
   `GetAsyncKeyState` for the *one* key the user configured, plus Alt only while
   that key reads down, plus — since 1.1, only with a controller button set —
   one `XInputGetState` whose one bit is looked at; no hook, nothing reserved,
   nothing received, see `docs/SPEC-MARKERS.md` §5.7 and §5.7.1). Adding a
   fifth needs the README
   "Network use" / "Auto-detect" sections and the FAQ changed in the same commit.
2. **Nothing that reads or injects into the game**, and no feature that gives a
   player information the game does not show them: a marker is a *possible*
   location, never a live one. Memory reading is out of scope, not a TODO.
3. **Never log a pixel, a path or user text.** No frame ever reaches disk or the
   network; every string that reaches `app.log` goes through `redactHome`; a
   custom map's key is a name the user typed, so it is logged as `(custom)`.
   [`docs/agents/diagnostics.md`](docs/agents/diagnostics.md).
4. **Pure logic lives in `src/shared` (or the fs-only tier) and has tests.**
   Those two tiers are the whole test suite; keep new logic on one of them and
   keep `require('electron')` out of them.
   [`docs/agents/architecture.md`](docs/agents/architecture.md).
5. **i18n parity.** Everything user-facing goes through `src/shared/i18n.js`
   (six catalogues: en, it, es, de, fr, pt-BR); `test/i18n.test.js` fails on a
   missing key, an unused catalogue string, a key set or order that differs
   between catalogues, a dropped `{param}` or HTML tag, a string still equal to
   English, an untranslated control in `src/index.html` and an English fallback
   there that no longer matches `en.json`. Never hard-code a hotkey combination
   in a user-visible string. [`docs/agents/i18n.md`](docs/agents/i18n.md).
6. **No pixel work on the main thread; ~30 ms of blocking JS per tick in the
   worker.** Since 0.7 capture, gate, grayscale and match run in an Electron
   `utilityProcess` (`core/map-detector/worker.js`, started lazily, with an
   automatic in-process fallback); **only numbers and keys cross the boundary**,
   and a test asserts no reply carries pixels. Main keeps the scheduler, the
   state machine and the windows — and a request that cannot be answered is "no
   frame this tick", never a quiet capture in main. The tick itself also got
   cheaper: gate first on the raw bytes, then reduce only the regions that are
   read — a gated-out gameplay tick went 27.0 → **1.3 ms**, a gated-in Tab tick
   41.2 → **21.9 ms**, with every matcher **score** bit-identical and the gate
   verdict-identical on real frames (`test/detector-equality.test.js`).
   `matchMap` scores every installed variant on every gated-in frame, but
   measure before optimising that: the **fixed** cost is ~6.8 ms (the 15
   alignment views and their gradients) and a variant is **~0.10 ms**, so the
   whole 48-variant cap is under 5 ms. Three ways to skip work were tried and
   rejected — coarse-to-fine and verify-the-current-map-first change decisions,
   and an early exit on a "these maps are far apart" measurement bought ~0.6 ms
   today for a per-pair safety claim the data could not support. Never add a
   second per-tick capture, never go back to `desktopCapturer`, and do not put
   pixel work back on main.
   [`docs/agents/detection.md`](docs/agents/detection.md).
7. **Never run an unsigned executable out of `%TEMP%`**, in a test or in the
   product. Bitdefender's Advanced Threat Defense fired on exactly that shape on
   the development machine: it killed the whole launching process tree (the
   terminal included), neutralised the installer by lower-casing its `MZ`
   signature, and on another run silently dropped that installer's registry
   writes, so later updates had no `UninstallString`. The same file run from
   `dist/` was fine — which is why the updater helper's working copy lives in
   electron-updater's cache under `%LOCALAPPDATA%`. Nothing is whitelisted; the
   design avoids the shapes that look like malware.
   [`docs/agents/updater-and-installer.md`](docs/agents/updater-and-installer.md).
8. **Do not launch Electron, the packaged app, the installer or the updater
   helper from an agent session** — `npm start`, `npm run build:win` and any
   `.exe` are for the owner at a real desk (see rule 7, and an Electron window
   cannot be verified from here anyway). Reason from the pure modules and
   `npm test`.
9. **Node is not on the agent's `PATH`.** Prefix it:
   `PATH="/c/Program Files/nodejs:$PATH"` (Node 24, installed with winget).
10. **Releases are tag-driven and nothing else publishes anything.** Bump
    `version` in `package.json`, `npm test`, commit, push, then push a tag that
    is exactly `v` + that version; `.github/workflows/release.yml` does the rest.
    Never bump a version or tag unless you were asked to.
    [`docs/agents/releasing.md`](docs/agents/releasing.md).

## Architecture map

One line per module, grouped. The annotated version — every quirk, every
"why" — is [`docs/agents/architecture.md`](docs/agents/architecture.md).

```
Entry and windows
  index.js                      Entry point; Wayland→X11 respawn; single-instance lock; wires everything
  src/core/main-window.js       Main BrowserWindow + IPC hub; `applyMapChange`; the update flow; the tray unload
  src/core/map-controller.js    Which map is on the overlay: hotkeys, detector, CLI, gallery. No window needed
  src/shared/map-state.js       PURE state + intent → state + effects (the whole match-time logic)
  src/shared/window-unload.js   PURE `shouldUnloadMainWindow()` — may the window be destroyed right now
  src/core/overlay-window.js    Transparent click-through always-on-top window
  src/core/overlay-position.js  PURE positioning math (corner preset + glide + rotated box)
  src/core/obs-window.js        Green-background window for OBS capture
  src/core/tab-overlay-window.js  The second transparent window, for Tab-map mode
  src/shared/web-preferences.js PURE `webPreferences()` — the one object all four windows use
  src/core/tray.js, is-wayland.js  System tray icon and menu; Wayland session detection
Catalogue and maps
  src/core/map-library.js       fs side of the catalogue: three roots, listing, key → path
  src/core/map-catalog.js       PURE catalogue: build, fuzzy key matching, next/prev, custom merge
  src/core/user-data.js, utils.js  userData `custom/` read/write/delete/list; fs helpers
  maps/<Creator>/<Map>.png      Shipped maps (electron-builder extraResources)
Map packs
  src/core/map-packs.js         The electron half: userData path, the 24 h gate, IPC, the toast
  src/core/map-pack-store.js    Installed packs on disk: list, re-validate, staging, atomic swap
  src/core/map-pack-install.js  Index → select → download → verify → install (network injected)
  src/core/map-pack-fetch.js    The one GET: `node:https`, allow-listed URL, byte caps, timeouts
  src/shared/map-pack-rules.js  PURE pack rules: validation, schemas, precedence, the 24 h gate
  packs/index.json, packs/<map>/  Published packs; served by GitHub raw, never packaged
Markers and Tab-map mode
  src/core/map-markers.js       Validates the shipped markers, owns `get-map-markers`
  src/core/map-markers/markers.json  Generated + committed, inside the asar
  src/shared/marker-rules.js    PURE marker decisions: layers, `baked`, Tab transform, legend
  src/shared/marker-geometry.js PURE bracket geometry + the sqrt sizing curve
  src/map/markers.js            The SVG marker layer, shared by overlay and OBS
  src/core/tab-mode.js          Tab-map mode: the fast loop, the window, the IPC
  src/map/tab.html, tab-renderer.js  That window's renderer
  src/shared/tab-mode-rules.js  PURE Tab-mode scheduler, cadences, DIP conversion, key decisions
  src/core/key-trigger.js       koffi → `user32` `GetAsyncKeyState` for one configured key (+ the pad, same tick)
  src/shared/key-codes.js       PURE `KeyboardEvent` → Windows virtual-key code (not an accelerator)
  src/core/pad-input.js         koffi → `XInputGetState`: the map key's optional controller button
  src/shared/pad-codes.js       PURE controller-button codes, labels, "is this bit down"
Detection
  src/core/map-detector.js      The loop, the state machine and the IPC. Off by default
  src/core/map-detector/frame-source.js  The pixel work: window, capture, gate, grayscale, match
  src/core/map-detector/worker.js        That source, inside a `utilityProcess` — pixels stay here
  src/core/map-detector/worker-host.js   Main's side: lazy start, timeout, backoff, fallback
  src/shared/detector-worker-rules.js    PURE worker timings, restart delays, mode reporting
  src/core/map-detector/matcher.js  PURE matcher: grayscale, crop, NCC, Tab gate, menu strip
  src/core/map-detector/templates.json  Generated + committed; `format: 2`, one list per map
  src/shared/detector-rules.js  PURE cadence, throttle, menu gate, game-window identification
  src/core/foreground.js        Is the game in front? ~1 s poll, no capture → `Hotkeys.setActive`
  src/core/gc.js                One V8 collection on demand, for the detector loop only
Hotkeys
  src/core/hotkeys.js           globalShortcut registration + hotkeys.json + the active switch
  src/shared/hotkeys-constants.js  PURE defs, first-run map defaults, formatting, step maths
  src/shared/hotkeys-rules.js   PURE decisions: normalisation, conflicts, shadowing, registration
  src/shared/hotkey-migration.js   PURE one-time move onto the Ctrl+Alt defaults
Settings, onboarding, i18n
  src/core/settings.js          settings-app.json in userData; `write/set/merge` report success
  src/shared/settings-defaults.js  PURE defaults + mapLabel enum + `useHardwareAcceleration`
  src/shared/map-placement.js   PURE "where do you want to see the map?" over `tabMarkers`+`tabHidesMinimap`
  src/shared/onboarding-rules.js   PURE setup-tutorial decisions + `TOUR_VERSION`
  src/core/language.js          Resolves `language` against `app.getLocale()`; the tray's language
  src/shared/i18n.js            PURE `t()`, `msg()`, `translateMessage()`, `resolveLanguage()`
  src/i18n/*.json               Flat dotted key → string catalogues (6 languages)
  src/shared/escape-html.js     PURE `escapeHtml` — user text never reaches markup raw
Logging and diagnostics
  src/core/app-log.js           **Singleton** `app.log` + the crash handlers and crash file
  src/core/rotating-log.js      The shared append-only writer both logs use
  src/core/map-detector/log.js  `detector.log` policy (512 KB, unbuffered, decisions only)
  src/core/diagnostics.js       The "Create diagnostic report" IPC: file list, system.txt
  src/core/diagnostics/zip.js, report.js  PURE zip writer/reader on `node:zlib`; `buildDiagnosticReport`
  src/core/diagnostics/crash.js    `crash-*.txt`: format, list, prune to 5, `pendingCrash`
  src/shared/redact.js          PURE `redactHome` / `redactCustomMapKeys`
Updater and installer
  src/shared/update-message.js  PURE update headlines + the whole *Check for updates now* decision
  src/core/update-helper.js     App side of the themed updater: copy, args, bounds, handshake
  updater/*.cs                  `hmo-updater.exe`: C#/WPF, code-only
  updater/strings.json, fonts/  The helper's en/it table (generated into C#); static Geist TTFs + OFL
  build/installer.nsh           Our text on the one-click installer's SpiderBanner
Renderer
  src/index.html                Main window markup (no inline `<style>`, no `style=`)
  src/css/app.css               The whole theme: tokens on `:root`, then Bootstrap overrides
  src/renderer.js               Renderer entry: builds the renderer modules
  src/js/maps.js                Gallery + the "showing" line. A VIEW: asks main, posts intents, renders pushes
  src/js/busy.js                `setBusy()` / `watchModals()` — "do not tear this window down right now"
  src/js/options.js             Settings modal (General + Overlay tabs)
  src/js/hotkeys.js             Hotkeys tab: tables, editing, key capture
  src/js/custom.js              "Add custom image" modal
  src/js/detector.js            Home-page auto-detect switch + status line
  src/js/overlay-preview.js     Canvas sample image for the Overlay tab
  src/js/onboarding.js          First-run setup tutorial (`#tour`)
  src/js/settings.js            Renderer mirror of the settings file
  src/js/i18n.js                Renderer i18n singleton: `t()`, `applyDom()`, `onChange()`
  src/js/diagnostics.js         Crash banner, hotkey-conflict banner, the report button
  src/js/status.js, logger.js   The `#logStatus` toast; debugLog
  src/map/map.html + renderer.js, map_obs.html + renderer_obs.js  The overlay and OBS windows
Dev-only scripts and data
  scripts/prepare-maps.js       maps-src → maps/, render icons (crop detected, not hard-coded)
  scripts/prepare-detector.js   detection-fixtures → templates.json; exports `locatePanel`
  scripts/build-markers.js      maps-src/markers.json → the shipped runtime file (`--check`)
  scripts/build-pack.js         One map image + fixtures → a pack in `packs/`
  scripts/build-updater.js      updater/*.cs → build/updater/
  scripts/probe-pad.js          Plain-node check: which controller button XInput sees on this PC
  maps-src/*.webp, detection-fixtures/*.png  Untouched map originals; game screenshots (template sources + test matrix)
  test/                         node:test unit tests for the pure and fs-only modules
```

## Commands

```bash
npm install
npm start              # dev run (DEBUG=true opens devtools and the menu) — owner only, see rule 8
npm test               # node --test over test/**/*.test.js
npm run prepare-maps   # crop maps-src/*.webp → maps/, render build+app icons
npm run prepare-detector # detection-fixtures/tab-*.png → templates.json
npm run build-markers  # maps-src/markers.json → src/core/map-markers/markers.json
npm run build-pack -- --key … --image … --fixture …  # one map pack into packs/
npm run build-updater  # updater/*.cs → build/updater/hmo-updater.exe (csc.exe)
npm run build:win      # build-updater, then NSIS installer + portable into dist/
```

## Index — read before touching

| Document | What is in it | Read before touching |
|---|---|---|
| [architecture.md](docs/agents/architecture.md) | The annotated module map, the stack table, CommonJS/no-context-isolation/CSP, IPC, **the main window's renderer is a disposable view**, map key format, maps root, the pure-vs-impure tiers, name folding, the `map-change` payload, catalogue caching, escaping, single-instance, Wayland | any new module, moving logic between main and the renderer, `map-library.js`/`map-catalog.js`, the `map-change` payload |
| [overlay-windows.md](docs/agents/overlay-windows.md) | Overlay quirks that must not be "cleaned up", focus rules, the overlay label, DPI, the OBS window | `overlay-window.js`, `obs-window.js`, `tab-overlay-window.js`, `overlay-position.js`, window size/focus/DPI |
| [hotkeys.md](docs/agents/hotkeys.md) | Ctrl+Alt defaults and the migration, accelerator normalisation against Electron's own parser, priority and conflicts, `hotkeysGameOnly`, suspension while recording, unbinding, the conflict banner | `core/hotkeys.js`, `hotkeys-constants.js`, `hotkeys-rules.js`, `hotkey-migration.js`, `foreground.js`, `js/hotkeys.js`, `hotkeys.json` |
| [settings-and-onboarding.md](docs/agents/settings-and-onboarding.md) | Failed-write reporting, `{rollback: true}`, `get()` vs `raw()`, one key at a time, **the settings reference** (what each key is, the explicit-`false` rule), **the one "where do you want to see the map?" choice**, the two settings the app now decides for itself, the whole first-run setup tutorial and its `TOUR_VERSION` | `core/settings.js`, `settings-defaults.js`, `map-placement.js`, `js/options.js`, `js/settings.js`, `js/onboarding.js`, `onboarding-rules.js` |
| [detection.md](docs/agents/detection.md) | Regions, the two signals, the acceptance thresholds, the Tab gate, cadence, the menu clear, `detector.log`, **the capture path budget and the utility process**, **why there is no early exit and the build-time map-similarity check**, finding the game window, fixture naming, the two neighbours `gc.js` and `foreground.js` | `map-detector.js`, `matcher.js`, `frame-source.js`, `worker.js`, `worker-host.js`, `detector-rules.js`, `templates.json`, `detection-fixtures/`, any capture code |
| [markers-and-tab-mode.md](docs/agents/markers-and-tab-mode.md) | `baked`, one validator, SVG sizing, Tab-map mode, the key-state trigger and its privacy ordering, **the controller button** (the map key's second input, XInput, why not HID), staleness epochs, **the measured constants** (every cadence and deadline, with the rejected values) and **the reproduced races** | `map-markers.js`, `marker-rules.js`, `marker-geometry.js`, `map/markers.js`, `tab-mode.js`, `key-trigger.js`, `key-codes.js`, `pad-input.js`, `pad-codes.js`, `tab-mode-rules.js` |
| [map-packs.md](docs/agents/map-packs.md) | The trust root, allow-list validation, atomic install and rollback, precedence over bundled maps, directory collisions, the 24 h gate, the offered hotkey, the build-time similarity warning | `map-packs.js`, `map-pack-*.js`, `map-pack-rules.js`, `build-pack.js`, `packs/` |
| [diagnostics.md](docs/agents/diagnostics.md) | Two logs and one writer, redaction, the crash policy (including the `render-process-gone` trap), the report zip | `app-log.js`, `rotating-log.js`, `diagnostics*`, `redact.js`, `js/diagnostics.js`, any crash handler |
| [i18n.md](docs/agents/i18n.md) | The mechanism, the six languages and how to add one, the locale rule, what is deliberately untranslated, the per-language glossaries, the markup attributes and their tested fallbacks, re-rendering, resolution in main | `shared/i18n.js`, `js/i18n.js`, `core/language.js`, `src/i18n/*.json`, any user-visible string |
| [maps-authoring.md](docs/agents/maps-authoring.md) | Adding a map with no code change, the image half, crop detection, locating the map panel in a fixture, marker data, shipping as a pack instead, what to do when two maps score alike | adding a map, `prepare-maps.js`, `prepare-detector.js`, `maps/`, `maps-src/` |
| [updater-and-installer.md](docs/agents/updater-and-installer.md) | The check and the download, the idle-priority install, the themed helper and its handshake, the NSIS build shape, the Bitdefender trap, our installer window | `main-window.js`'s update code, `update-helper.js`, `update-message.js`, `updater/`, `build/installer.nsh`, `build.nsis` |
| [releasing.md](docs/agents/releasing.md) | The workflow, the procedure in order, the tag rule, the `gh` scope gotcha | tagging, `.github/workflows/release.yml`, `version` in `package.json` |
| [memory.md](docs/agents/memory.md) | The measured memory decisions, how to quote the numbers, the tray unload (no setting since 1.0) and the one "win" that is not | `gc.js`, `web-preferences.js`, `hardwareAcceleration`, `shared/window-unload.js`, anything that looks like a spare allocation |

Specs are the source of truth where they overlap these documents: `docs/SPEC.md`,
`SPEC-0.3.md`, `SPEC-0.3.2.md`, `SPEC-DETECT.md`, `SPEC-MARKERS.md`,
`SPEC-MAP-PACKS.md`, `SPEC-MAP-STATE.md` (the map state in main + the tray
unload, with the full IPC inventory), `SPEC-UPDATER.md`, `BUILD.md`.
Measurements and audits:
`docs/MEMORY-REPORT-2.md`, `docs/VERIFICATION*.md`, `docs/DEV-REPORT.md`.

---

## Self-Updating Rule

**These documents are the source of truth for agentic onboarding.** Every time
an agent (human or AI) discovers a pattern, convention, or architectural
decision that is not documented here — or corrects an outdated entry — it MUST
update them.

1. **Before starting any task**: read this file, then the `docs/agents/`
   document the index points at for the area you are about to touch.
2. **After completing any task**: if you learned something that would help the
   next agent, add it to **the area document**, not to this file. This file only
   grows when a rule becomes non-negotiable for *every* change, or when a new
   area document appears.
3. **Keep the index accurate**: a new document, a renamed heading or a moved
   subject means the index table above changes in the same commit. An index row
   pointing at a document that does not say what it claims is a bug.
4. **Cross-link, never duplicate**: state a fact once, in the document that owns
   it, and link to it from the others. Where a `docs/SPEC-*.md` says the same
   thing, the spec is the source — link to it and keep only what it does not say.
5. **On discovering stale information**: correct it immediately. Do not work
   around outdated docs.
6. **Comments state constraints; documents carry the reasoning.** In code, a
   comment says *why this line must stay as it is* in one to three lines and
   points at the area document (`Why: docs/agents/<area>.md § <heading>`).
   History, measurements, rejected alternatives and how a bug was found go in
   the document, never in the code (0.7.x cleanup: `src/` went from 46 % to
   24 % comment lines with the AST unchanged).
7. **Keep the reasoning**: the "why" is the point. Tighten narration of history
   if you must, but keep the dates, versions and measurements that explain a
   constraint.
8. **Never remove the self-updating rule**: this clause must survive all edits.

*Last updated: 2026-09-22, release 1.1.2 (the controller button). Split into `AGENTS.md` + `docs/agents/` at 0.7.0
(Ctrl+Alt defaults, accelerator normalisation against Electron's own parser,
`hotkeysGameOnly`, suspension while recording, settings-write reporting +
rollback, map packs, markers and Tab-map mode, and the map state moving into
main so the main window can be unloaded in the tray — `docs/SPEC-MAP-STATE.md`).
Content as of the 1.0 settings simplification: one "where do you want to see the
map?" choice over `tabMarkers`+`tabHidesMinimap` (`src/shared/map-placement.js`),
the layer chips, one switch and one button for both network checks,
`unloadWindowInTray` and `hideInMenu` removed in favour of the app deciding, and
the welcome tour rebuilt as a six-step setup tutorial with a `TOUR_VERSION`
stamp — [`docs/agents/settings-and-onboarding.md`](docs/agents/settings-and-onboarding.md).*
