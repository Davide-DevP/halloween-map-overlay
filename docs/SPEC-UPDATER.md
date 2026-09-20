# 0.5.0 — themed updater (spec)

Goal: installing an update looks like the app, not like Windows. One continuous
screen: app "updating" view → `hmo-updater.exe` at the same window bounds with
real steps and a real progress bar → the new version's loading overlay. The
stock NSIS banner is never seen on the happy path, and **no user can ever be
stranded on an old version because of this feature** (§5).

Non-goals: replacing NSIS (it keeps doing uninstall / unpack / shortcuts /
differential download), code signing, any new network contact. The scope rule
in AGENTS.md is unchanged: the helper makes **zero** network requests.

## 1. The helper — `updater/` → `hmo-updater.exe`

- C#, **WPF, code-only (no XAML, no msbuild, no NuGet)**, target .NET
  Framework 4.x that ships in Windows 10/11. Compiled with the system
  `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe` by
  `scripts/build-updater.js` (`npm run build-updater`) into
  `build/updater/` (git-ignored output): `hmo-updater.exe` + `fonts/` + `icon.png`.
  `/target:winexe`, `/platform:anycpu`, an app manifest with
  `asInvoker` + per-monitor DPI awareness, the app icon as Win32 icon, and
  assembly metadata (product name, version from package.json).
- Shipped through `build.extraResources` (`build/updater` → `resources/updater`).
  `npm run build` / `build:win` run `build-updater` first; `release.yml` gets a
  "Build updater" step before "Build" (verify `csc.exe` exists on
  `windows-latest`; fail the job loudly if not).
- Fonts: static **Geist** Regular/Medium/SemiBold and **Geist Mono** Regular/Medium
  TTFs (WPF cannot use variable fonts or woff2) from the official
  `vercel/geist-font` release, committed under `updater/fonts/` with their OFL
  licence text; loaded at runtime from the folder next to the exe
  (`new FontFamily(new Uri(dir), "./#Geist")`). Missing font → Segoe UI, never a crash.
- Look: copy the tokens from `src/css/app.css` (bg `#14100f` family, panel,
  hairline, accent `#e8853a`, text / dim / mute, radii, easing
  `cubic-bezier(.22,.61,.36,1)`, 150–250 ms). Borderless window, warm radial
  ambient at the top, procedural grain, Windows 11 rounded corners via
  `DwmSetWindowAttribute` (ignore failure on Windows 10), fade-in ~200 ms /
  fade-out ~350 ms. Centered composition that mirrors the app's
  `#loadingOverlay`: icon, headline "Updating to 0.5.1", step line, thin accent
  progress bar, percent in Geist Mono with tabular figures, a quiet sub-line
  ("The app reopens by itself."). Step list: *Closing the app* → *Removing the
  previous version* → *Installing* → *Starting*. Honour the system
  "show animations" setting (`SystemParameters.ClientAreaAnimation`).
  Draggable by its body; no close button while installing; never topmost over
  other apps (do not steal focus from a game — `ShowActivated = false` if the
  app window was not focused).
- Strings: English + Italian in one C# table; language comes from `--lang`.
  A unit test must assert the two tables have the same keys (parse the C# file
  or keep the strings in `updater/strings.json` read at runtime — developer's
  choice, but parity is tested from `npm test`).
- Arguments (all required unless noted): `--installer <path>` `--install-dir <path>`
  `--app-exe <path>` `--version <x.y.z>` `--lang <en|it>` `--wait-pid <pid>`
  `--bounds x,y,w,h` (physical px; clamp to a visible monitor, min 560×380)
  `--log <path>` `--ready-file <path>`. Extra modes: `--demo` (simulated run of
  ~12 s, no installer, for screenshots; `--demo-fail` shows the error state).
  Unknown/missing args → log + exit code 2 before showing anything.

### Sequence

1. Parse args, open log, show the window, then **create `--ready-file`**
   (the handshake — §5). Step *Closing the app*.
2. Measure `S0` = total bytes under `--install-dir` (background thread).
3. Wait for `--wait-pid` to exit (max 20 s; then carry on — the NSIS
   app-running check will deal with it).
4. Start the installer: `"<installer>" /S --updated --force-run`, process
   priority class **Idle** (that is what gives it low I/O priority — see
   `spawnInstallerAtLowPriority()` in `main-window.js` for why this matters).
5. Progress while it runs, polled ~every 400 ms off the UI thread, from the
   size of `--install-dir`: shrinking = *Removing the previous version*
   (maps to 0 → 15 %), growing toward `S0` = *Installing* (15 → 97 %).
   Monotonic, eased on screen, never 100 % before the installer exits. While
   NSIS unpacks to `%TEMP%` the folder does not change: **measure what a real
   update does** and tune the mapping (a slow capped creep during a stall is
   acceptable; a bar that sits at one value for 20 s is not, and neither is a
   fake bar unrelated to reality). Folder unreadable → indeterminate bar.
6. Installer exit code 0 **and** `--app-exe` exists → 100 %, *Starting*. NSIS
   relaunches the app itself (`--force-run`). Wait for a process whose main
   module is `--app-exe` to have a visible main window (max 20 s); if none
   appears by 8 s, start `--app-exe` ourselves. Then fade out and exit 0.
7. Anything else → **error state** in the same window: what happened in one
   plain sentence, the log path, and two buttons — *Open the download page*
   (`https://github.com/Davide-DevP/halloween-map-overlay/releases/latest`,
   via the shell — user-initiated, like the Credits links) and *Close*. If
   `--app-exe` still exists, *Close* relaunches the old version.
8. Log every step with timings to `--log` (`updater.log` in the app's log
   folder, plain text, no user paths beyond what app.log already allows —
   reuse the `~` redaction idea). `src/core/diagnostics/report.js` adds
   `updater.log` to the zip (missing file is not an error).

## 2. App side — `src/core/update-helper.js` (+ `main-window.js`)

- New module, **pure where possible and unit tested**: locate the shipped
  helper (`process.resourcesPath/updater`), copy the folder to
  `<temp>/hmo-updater-<version>-<random>/` (the install dir is wiped during the
  update, so it cannot run in place), build the argument list, spawn detached
  (`stdio: 'ignore'`, `unref`), poll for the ready-file.

  > **Amended during implementation (and this is what shipped).** The copy does
  > **not** go under `%TEMP%`. It goes into electron-updater's own cache
  > directory, `%LOCALAPPDATA%\<updaterCacheDirName>\helper-<version>-<random>\`,
  > beside the `pending\` folder the installer was downloaded into. Reason,
  > measured on the development machine: starting an unsigned NSIS installer
  > from a folder under `%TEMP%` made Bitdefender's Advanced Threat Defense
  > block "all applications involved", kill the launching process tree and
  > corrupt the installer's PE header. Running unsigned executables out of the
  > user's temp directory is a malware shape; the updater cache is where
  > electron-updater has always downloaded and run that same installer. The
  > stale-copy sweep moved with it (`helper-*`, never anything else in that
  > directory). Everything else in this section is unchanged.
- `installUpdate()` becomes: themed path first; on **any** failure fall
  through to today's `spawnInstallerAtLowPriority()` (stock banner), then to
  `quitAndInstall` exactly as now. Keep all three tiers and the existing
  comments' reasoning intact.
- Handshake: the app quits **only after** the ready-file appears. No ready-file
  within **4 s**, or spawn error, or helper folder missing → kill the helper if
  it is alive, `appLog.error('update-helper', …)`, use the stock path. This is
  what makes an antivirus block harmless.
- Pass the main window's bounds in physical pixels (`screen.dipToScreenRect`)
  and whether it was focused/visible; if the window is hidden in the tray, the
  helper centres itself on the primary display at 560×380.
- On startup (packaged, non-portable): best-effort delete of stale
  `<temp>/hmo-updater-*` folders older than an hour (amended: `helper-*` inside
  the updater cache). Never throws.
- Portable build: unchanged, no updater involvement.

## 3. Renderer — the hand-over

- Pressing **Restart and update** (banner) immediately shows a full-window
  "updating" view built from the existing loading-overlay styles (icon,
  "Updating to X.Y.Z", thin accent bar, indeterminate), so the helper appears
  on top of an identical picture. If the install falls back or fails, the view
  is removed and the existing failure toast shows. The tray item takes the same
  path (window may be hidden — fine).
- New strings in `en.json` + `it.json`; everything through `t()`.

## 4. Docs

README (How updates work / FAQ entry / Changelog 0.5.0), in-app FAQ
`faq.updates.*` if the wording no longer matches, `docs/BUILD.md` (csc
prerequisite, `build-updater`), `NOTICE` (static Geist TTFs, OFL), AGENTS.md's
architecture map and `docs/agents/updater-and-installer.md` (the handshake
rule, traps found). `build/installer.nsh`
stays: it is still what the fallback path and a first install show.

## 5. Safety rules (non-negotiable)

1. Three tiers, each falling through to the next: themed helper → stock
   low-priority installer → `quitAndInstall`.
2. The app never quits for an update before it has proof the helper is on
   screen (ready-file) or the stock installer has been spawned.
3. The helper never deletes or writes anything inside `--install-dir`; only the
   NSIS installer does.
4. The helper always ends in one of: new app running, old app relaunched, or a
   visible error with a download link. It never exits silently on failure and
   never hangs forever (global watchdog: 10 min → error state).
5. No network, no telemetry, no elevation.

## 6. Verification the developer must do

- `npm test` green; new unit tests for `update-helper.js` (arg building, temp
  naming, handshake timeout logic with injected fs/clock, stale cleanup) and
  string parity.
- Visual: screenshots of `--demo` and `--demo-fail` in en + it, at the app's
  default bounds and at 560×380, compared side by side with the app's loading
  overlay; iterate until they read as the same screen.
- **Real end-to-end update, twice, without touching the owner's real install**
  (`%LOCALAPPDATA%\Programs\Halloween Map Overlay` and its userData are
  off-limits): build test installers with a different product name / appId
  (`-c.productName="HMO Updater Test" -c.appId=com.halloweenthegame.mapoverlay.test
  -c.extraMetadata.version=…`), install version A, then drive the helper
  against installer B with the test app running (and the app-side launch +
  handshake through a harness kept outside the repo). Measure the folder-size
  curve from the log and tune §1.5 from it. Prove the fallback: rename the
  helper exe / block the ready-file and show the stock path still updates.
  Uninstall the test product and remove its folders at the end.
- Report whether Bitdefender (installed on this PC, hostile to unsigned exes)
  interfered at any point, and exactly how.
