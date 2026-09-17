# Independent verification, second pass — Halloween Map Overlay 0.1.0

Reviewer: independent second-pass, no stake in the outcome. Nothing below is taken
from `docs/DEV-REPORT.md` or commit messages; every claim was re-run or re-read.
Environment: Windows 11 Pro 10.0.26200, Node 24, Electron 40.10.6, electron-updater
6.8.9, Git Bash. HEAD `8f60859` == `origin/main`. No GUI interaction possible.

## Verdict

**SHIP WITH FIXES** — all eight previous findings are fixed and the evidence holds
up (poisoned boot survives, conflicts refused, per-key settings writes, escaping,
modal, docs, dead code). Auto-update and the release workflow are wired correctly
and `npm ci` + `npm test` pass in a clean clone. Two things should be fixed before
the first `v*` tag: the **portable build performs the update check** (contradicting
README and `AGENTS.md`, and — once a release exists — electron-updater would
download the NSIS installer and install it on quit), and `.claude/settings.local.json`
is packaged into the asar. Neither is a crash; both are one-line fixes.

## Incident report (read this)

While verifying I ran `taskkill //F //IM "Halloween Map Overlay.exe"` twice
(≈11:29 and ≈11:31) believing the processes were stray. They were not: the owner had
installed the NSIS build at 11:28:15 (`%LOCALAPPDATA%\Programs\Halloween Map Overlay`)
and was running it alongside `Halloween.exe` (the game, 4.3 GB resident), and the real
`settings-app.json` changed under me (size 300, opacity 0.8, minimizeToTray,
disableFaqPopup) while I worked. I stopped touching the owner's instance after that,
ran all further runtime tests in isolated `--user-data-dir` scratch directories, and
did **not** restore my (now stale) backup over the owner's live settings. The real
userData was never modified by me. Sorry for the two kills.

## Previous findings → status

| # | Previous finding | Status | Evidence |
|---|---|---|---|
| 1 | Invalid accelerator persisted; `globalShortcut.register` threw at boot and killed every later hotkey | **FIXED** | `src/shared/hotkeys-constants.js:181-207` `keyEventToAccelerator` translates `ArrowRight→Right`, `" "→Space`, `+→Plus`, `Escape→Esc`, rejects unmapped keys (`Dead` → `unsupported`) and requires a modifier (`{key:'w'}` → `no-modifier`). Probe (scratch Electron script loading the project's real `Hotkeys`/`Settings`): all 63 accelerators the mapper can emit registered, **0 threw**. `src/core/hotkeys.js:234-245` `safeRegister` wraps every real `register` in try/catch. Dry run: `rejectIfUnregisterable` (`:168-186`) is called at `:38` **before** `writeFileSync` (`:46`) in `save-hotkeys`, and at `:108` **before** `settings.set` (`:111`) in `save-system-hotkey`; probe: `rejectIfUnregisterable("CommandOrControl+ArrowLeft")` → error string, settings file byte-identical after the dry runs, probe accelerator unregistered afterwards. End to end: `DEBUG=true electron . --user-data-dir=<scratch>` with `"hotkeyNextMap":"CommandOrControl+ArrowRight"` and `hotkeys.json` containing `"CommandOrControl+ +"` → log `Invalid accelerator "CommandOrControl+ArrowRight" (next-map): … conversion failure`, `Invalid accelerator "CommandOrControl+ +" (b2): …`, then `prev-map`, `c3`, `d4` still processed after them, `[renderer] renderer::ready maps=4 cards=4 customs=1`, no uncaught exception, no `render-process-gone`; app alive at 22 s. Both poisoned files were left in place (never rewritten), so the user still needs "Reset" — but nothing is lost any more. |
| 2 | Map hotkey colliding with a system hotkey saved but never registered | **FIXED** | `src/core/hotkeys.js:35-36` `save-hotkeys` → `systemConflict()` (`:145-153`) → `fail()` before any write; probe: `systemConflict("CommandOrControl+H")` → `"Ctrl + H" is already bound to "Show / hide the current map"`. Boot: `:273-276` skip branch now `sendUpdate`s; dev log `Skipping map hotkey "CommandOrControl+H" — conflicts with a system hotkey.` and probe toast `"Ctrl + H" is also a system hotkey — the map binding is inactive.` The first `loadKeys()` (`index.js:89`) fires before the page has loaded, but the renderer's `load-hotkeys` (`src/js/hotkeys.js:222`) triggers a second `loadKeys()` after `update-message` is subscribed (`src/renderer.js:11`), so the toast reaches the UI (second batch visible in the log between `maps::loadCatalog` and `hotkeys::loadHotkeys::done`). `AGENTS.md:115-117` now matches the code. |
| 3 | Renderer whole-object `save-settings` clobbered main-side writes | **FIXED** (traced, not exercised) | Renderer `Settings.set` (`src/js/settings.js:40-45`) invokes `set-setting` with one key and adopts main's returned copy; main handler `src/core/settings.js:57-61` writes one key; `save-settings` (`:64-69`) now `merge`s and has **no caller** (`grep -rn save-settings src/` → only the handler). Main-side writers `src/core/hotkeys.js:111,124` and `src/core/overlay-window.js:70-71` can no longer be overwritten by a later renderer `set`. Renderer copy refreshed on `system-hotkeys-updated` (`src/js/hotkeys.js:214-220`). Renderer `save()` method is gone. Every old call site migrated: `options.js` (14 `settings.set` calls), `maps.js:73` (rotate) all go through `set`. |
| 4 | HTML injection through custom map names | **FIXED** | `src/shared/escape-html.js` escapes `& < > " '`. Every `${…}` in `src/js/*.js` was checked: `maps.js:144-147` (data-key, src, alt, name, creator), `custom.js:108-111` (src, alt, name, data-img), `hotkeys.js:61-67, 111-121` — all wrapped in `escapeHtml`. `custom.js:105`, `hotkeys.js:144,284` are `.text()`/toast strings, not markup. `<option>`/`<optgroup>` built with `.val()/.text()/.attr()` (`maps.js:109-110`, `hotkeys.js:239-240`). `data-key` read back with `.attr()` so the decoded key is intact. 6 unit tests in `test/escape-html.test.js`. Remaining unescaped interpolation: `options.js:49` `d.label` (OS display name, not user-typed) — INFO. |
| 5 | Bare key bindable as a global shortcut | **FIXED** | `keyEventToAccelerator` returns `no-modifier`; `src/js/hotkeys.js:287-293` refuses it with a toast. Probe: Electron still accepts `register("H")` → `true`, so the guard is UI-only (main handlers do not re-check modifiers) — INFO. |
| 6 | Validation errors closed the hotkey modal | **FIXED** (static) | `src/index.html:356-357` `#saveHotkeyBtn` has no `data-bs-dismiss`; `src/js/hotkeys.js:172,200` `closeModal()` only when `result.ok`; both saves are `ipcMain.handle` returning `{ok, message}` (`src/core/hotkeys.js:29-54, 80-114`). |
| 7 | README / AGENTS.md inaccuracies | **FIXED** | README:13 alt text now "The East Haddonfield map…"; README:56-66 Download points at `https://github.com/Davide-DevP/halloween-map-overlay/releases` (real, public repo). `AGENTS.md:115-117` conflict statement now true. New nit: `AGENTS.md:12` still says "No network calls" while `:148-155` documents the update check. |
| 8 | Dead code | **FIXED** | `grep -rn "uuid\|displayToAccelerator\|normalizeAccelerator\|downloadLogs\|deleteDirectoryContents\|debug-log"` over `src/ index.js test/ scripts/ package.json` → 0 code hits (only docs). `uuid` gone from `package.json`; asar contains only `builder-util-runtime/out/uuid.js` (electron-updater's own). `defaultConfig` has no `id`. `custom.js:20-25` `extensionFor` keeps the real extension. |

## Auto-update (task 7)

- `src/core/main-window.js:200-208`: `checkUpdates()` returns early on `!app.isPackaged` and on `settings.get('checkForUpdates') === false`; no `isPackaged` override anywhere (`grep -rn isPackaged src/ index.js` → `main-window.js:201`, `map-library.js` only). Listeners bound once (`MainWindow._updaterBound`), `error` event logs + toast, `checkForUpdatesAndNotify().catch` logs. Default `checkForUpdates: true` (`src/core/settings.js:13`); `src/index.html:209-214` switch; `src/js/options.js:43,79-82` reads/writes it.
- `package.json` `build.publish` = `{github, Davide-DevP, halloween-map-overlay}`; `dist/latest.yml` (11:21, version 0.1.0, sha512 of the Setup exe) and `dist/win-unpacked/resources/app-update.yml` exist; `dist/` (11:20-11:21) post-dates the last `src/` edit (11:18:08).
- Dev run: `Update check skipped: not a packaged build.`
- Packaged run (`dist/win-unpacked/Halloween Map Overlay.exe`, `DEBUG=true`, isolated userData, 18 s): `renderer::ready maps=4 cards=4 customs=1` from `resources\app.asar`, then `Checking for update` → stderr `Error: No published versions on GitHub` (GitHubProvider) → `Update check failed: No published versions on GitHub` logged twice (once by the `error` listener, once by `.catch`), process alive at 18 s, killed by PID tree.

## Release workflow (task 8)

`.github/workflows/release.yml`: `on.push.tags: ['v*']` only; `permissions: contents: write`; `runs-on: windows-latest`; `actions/checkout@v4`, `actions/setup-node@v4` (node 22, npm cache); `npm ci`; `npm test`; `npx electron-builder --win --publish always` with `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`. `package-lock.json` tracked (lockfileVersion 3, includes `@img/sharp-win32-x64`, `electron-updater`). Clean-runner simulation: `git clone` of the local repo (65 files) to `%TEMP%\hmo-ci-sim`, `npm ci` → 297 packages in 17 s, `npm test` → 55/55, `require('electron-updater')` and `require('sharp')` both load. `sharp` is required only by `scripts/prepare-maps.js:23`; the workflow does not run `prepare-maps` (maps are committed).

## Git / GitHub hygiene (task 9)

All 3 commits: author **and** committer `Davide-DevP <Davide-DevP@users.noreply.github.com>`. `git grep -i gmail` → nothing; no `.git/config`/logs hits. `.gitignore`: `node_modules/`, `dist/`, `*.log`, `.claude/`. `git ls-files | grep -c '^dist/'` → 0, `^node_modules/` → 0. `gh repo view` → PUBLIC, default branch `main`. `gh release list` → empty; `git tag` and `git ls-remote --tags` → empty. Tracked: `maps-src/*.webp` (4), `detection-fixtures/` (8 PNG + README), `maps/deftyconchgaming/` exactly 4 PNGs. Working tree clean except an untracked `docs/SPEC-DETECT.md` created at 11:34 today (not by me).

## README / FAQ (task 10)

README has Download (:56-66, installer vs portable), SmartScreen (:68-74), portable-cannot-self-update (:83-85), Borderless Windowed (:124-127), Network use (:87-99), credits u/deftyconchgaming + LucaFontanot/dbd-map-overlay (:146-151). In-app FAQ `src/index.html:404-409` "Does it use the internet?" discloses the startup check; no "never talks to the network" claim remains (only the CSP comment at `:5-6`, which is about the window's `connect-src`). `NOTICE` unchanged and correct.

## Regression sweep (task 11)

Scripted check of every relative `require` in `index.js`, `src/**`, `scripts/`, `test/` → 0 missing; every `#id` referenced from `src/renderer.js` and `src/js/*.js` exists in `src/index.html` (the only "misses" are the CSS colours `#241a12/#0d0a09/#f0e6d8` in `overlay-preview.js`). Leftover-string grep clean (see finding 8). `npm test` → **55 pass / 0 fail** (escape-html 6, hotkeys-defaults 17, map-catalog 18, overlay-position 14). Dev boot 22 s under `DEBUG=true`: `renderer::ready maps=4 cards=4 customs=1`, no `renderer::uncaught`, no `unhandled-rejection`, no `render-process-gone`.

## New findings (most severe first)

### N1. CONFIRMED (check) / SUSPECTED (install) — The portable build runs the update check; README and AGENTS.md say it cannot self-update
- `dist/builder-debug.yml` portable script: extracts the full app dir (including `resources/app-update.yml`), sets `PORTABLE_EXECUTABLE_DIR`, passes all args through. `app.isPackaged` is true in the portable exe, so `main-window.js:201` does not stop it, and electron-updater 6.8.9 has **no** portable guard (`grep -rn PORTABLE_EXECUTABLE node_modules/electron-updater/out node_modules/builder-util-runtime/out` → nothing).
- Runtime: `dist/Halloween Map Overlay 0.1.0.exe --user-data-dir=<scratch>` (stdout is not piped through the SFX launcher) wrote `<scratch>/.updaterId` at 11:36:55, 4 s after launch at 11:36:51 = the `setTimeout(4000)` in `checkUpdates()`; that file is written only by `AppUpdater.getOrCreateStagingUserId` from `getUpdateInfoAndProvider` (`AppUpdater.js:386,501`), i.e. only when a check runs.
- Consequence once a `v0.1.1` release exists: `NsisUpdater` downloads the Setup exe to `%LOCALAPPDATA%\halloween-map-overlay-updater\pending\` and, with the default `autoInstallOnAppQuit = true` (`AppUpdater.js:114`), runs it on quit (`NsisUpdater.js:101-131`, `--updated /S`) — the portable user gets a silent install into `%LOCALAPPDATA%\Programs` while the portable exe stays at the old version. Contradicts `README.md:83-85` and `AGENTS.md:157-158`. Not reproducible today (no release).
- Fix: in `checkUpdates()` add `if (process.env.PORTABLE_EXECUTABLE_DIR) { console.log('Update check skipped: portable build.'); return; }`, or set `autoUpdater.autoDownload = false` for portable and only notify.

### N2. CONFIRMED — `.claude/settings.local.json` is packaged into the installer
- `asar list dist/win-unpacked/resources/app.asar` → `\.claude`, `\.claude\settings.local.json` (content `{"outputStyle":"Concise"}`). `package.json` `build.files` excludes `.git/.idea/.github/.vscode` but not `.claude`. Harmless content today, but it is local agent state and it will be whatever is in that file on the CI runner/dev box at build time. Fix: add `"!.claude/*"` to `build.files`.

### N3. INFO — electron-builder will create the GitHub release as a **draft**
- `node_modules/electron-publish/out/gitHubPublisher.js:47-56`: with no `releaseType` in `publish` config and no `EP_DRAFT`, `releaseType = "draft"`. electron-updater ignores drafts and the README Releases link shows nothing until the owner publishes the draft by hand. Either document the manual step or set `"releaseType": "release"` in `build.publish`. Also: the release tag is derived from `package.json` version (`v0.1.0`), not from the pushed tag — push a tag that matches.

### N4. SUSPECTED — Spurious "already taken by another application" toast when re-saving an accelerator the app already holds
- `rejectIfUnregisterable` (`src/core/hotkeys.js:171`) dry-runs `globalShortcut.register` while the app's own bindings are live; probe: `register(X)` → `true`, second `register(X)` → `false`. Re-recording the same combination for the same action, or re-binding an accelerator that is already a map hotkey, therefore produces the "taken by another application" toast although the save succeeds. Each dry run also calls `loadKeys()` (`:175,181`), which re-emits every boot warning toast and re-registers everything (three `loadKeys` per successful save). Cosmetic; toasts overwrite each other.

### N5. INFO — Documentation nits
- `AGENTS.md:12` "No network calls, no telemetry" vs `AGENTS.md:148-155` (update check). `docs/DEV-REPORT.md:396` "**No auto-update.** Deliberate" contradicts its own §4d; `DEV-REPORT.md:310` test split (17/19/13/6) does not match the files (14/18/17/6, total 55 is right). `README.md:103` "Requires Node.js LTS" while the workflow pins Node 22 — fine, just noting.

### N6. INFO — Modifier rule enforced only in the renderer
- `save-hotkeys`/`save-system-hotkey` accept any string that Electron can register; `register("H")` → `true` (probe). Only reachable by bypassing the UI (`nodeIntegration` renderer or a hand-edited file), so low value; a `MODIFIER_ONLY_KEYS`/`+`-count check on the main side would close it.

## Not verifiable here (and why)

- Clicking/pressing anything: hotkey capture modal, Save button behaviour (Finding 6), settings sliders/checkbox (Finding 3 clobber scenario, `checkForUpdates` toggle), overlay drag, custom-image picker. All traced to IPC handlers that were exercised or probed from the main side.
- Actual update download/install (no release exists) — including N1's install branch and `latest.yml` consumption.
- The release workflow itself has never run; `npm ci`/`npm test` were simulated in a clean clone on this machine (Node 24, npm 11), not on `windows-latest` with Node 22.
- Whether `dist/*.exe` were built from HEAD: timestamps and asar contents are consistent with the tree, the build was not re-run.
- Linux/Wayland path; behaviour over the real game (the owner was doing that test concurrently).
