# The updater and the installer

[← AGENTS.md](../../AGENTS.md) · **Read before** touching `src/core/updater.js`,
`src/core/update-helper.js`, `src/shared/update-message.js`, anything in
`updater/`, `build/installer.nsh`, `scripts/build-updater.js` or the
`build.nsis` block of `package.json`.

Specs: `docs/SPEC-UPDATER.md`, `docs/BUILD.md`.

**Where the code lives (since the 2026-09-23 refactor).** The whole flow — the
check, its watchdog, the download, the three install tiers, the helper hand-off
— is the `Updater` class in `src/core/updater.js`. Everything window-shaped is
injected (`send`, `sendUpdate`, `getWindow`, `getTray`, `runShutdownHooks`),
because the main window may not exist when an update lands. `MainWindow` keeps
only the IPC wiring (`install-update`, `get-pending-update`,
`check-for-updates-now`, `get-update-check-state`, `update-banner-*`) and a
one-line `installUpdate()` the tray calls. The method names below are
`Updater`'s unless a class is named.

## Checking and downloading

- **Auto-update**: `electron-updater` against GitHub Releases
  (`Davide-DevP/halloween-map-overlay`), started from `checkUpdates()`
  4 s (`STARTUP_CHECK_DELAY_MS`) after the window first shows and reported
  through the `update-message` toast.
  **It downloads on its own and installs only on request.** `autoDownload` and
  `autoInstallOnAppQuit` are both set explicitly in `prepareUpdater()`, the second
  to `false`: 0.1.0 → 0.2.0 shipped with electron-updater's default quit
  handler and the silent NSIS run froze the machine for several seconds at the
  moment the owner closed the app. `update-downloaded` now stores
  `this.pendingUpdateVersion`, sends the `update-ready` `{version}` IPC (the
  renderer's persistent green banner, `#updateReady` in `src/index.html`) and
  tells the tray to grow a "Restart and update" item. The banner's button and
  that item both reach `Updater.installUpdate()` — the single installer
  trigger — the banner via `ipcMain.handle('install-update')`, the tray via
  `MainWindow.installUpdate()`. A renderer that loads after
  the download (reopened from the tray) asks with `get-pending-update` instead
  of waiting for the push. The install calls `markQuitting()`
  (`src/core/quitting.js`) first, or the window's `close` handler hides the
  window and `app.quit()` never completes (a tier-3 failure is the one path that
  calls `clearQuitting()`); then `runShutdownHooks()` stops the detector and
  destroys the tray, it launches the installer itself (see below) and quits.
  **electron-updater does the check and
  the download; it does not do the install.** "Later" in the banner is renderer-session state
  only — main and the tray keep the pending update. The
  `checkForUpdatesAndNotify` toast text is overridden too; its default promises
  an install on exit, which is now a lie.
  Guarded by `app.isPackaged` — **do not** redefine `app.isPackaged` to test it
  the way the reference did; build a real package instead. Also guarded by the
  `checkForUpdates` setting (default true, Settings › General). Every error path
  only logs: being offline must never be more than a toast.
  - **"Check for updates now"** (Settings › General, beside that switch) asks on
    demand, because the automatic check only ever runs at startup and an app
    left open for a week never hears about a release. `checkForUpdatesNow()` →
    `check-for-updates-now` IPC; the renderer also asks
    `get-update-check-state` when Settings opens and listens for
    `update-check-state` pushes. It deliberately **does not consult the
    `checkForUpdates` setting** — the switch governs the *automatic* check, and
    pressing the button is its own consent — and it never writes it. Every
    decision is the pure `planManualUpdateCheck`/`manualCheckView`
    (`shared/update-message.js`): dev build → "not available in a development
    build", portable → the same answer the startup check gives silently, a
    check already in flight (**the startup one counts**) → "already running",
    otherwise start one. `Updater.updateCheckState` is the single source of
    that in-flight answer; the updater events move it, so the button is
    disabled while the startup check or a download runs, and there is never a
    second `checkForUpdates()` in the air. The listener binding lives in
    `prepareUpdater()` (behind the module-level `listenersBound`) so the button works with
    the startup switch off without ever adding a second set of listeners.
    Logged as `update state=manual-check` — no URL, no path.
  - **The busy states have a watchdog**, or a download that dies without ever
    firing `error` leaves the state at `found` and the button disabled until
    the app is restarted. The rule is the pure `updateCheckStall()`
    (`CHECK_STALL_MS` 60 s for the request, `DOWNLOAD_STALL_MS` 120 s for the
    download) and it measures **silence, not elapsed time**:
    `download-progress` bumps `updateCheckActivityAt` on every tick, so a slow
    but progressing download keeps resetting it and is never cut off. A stall
    only moves the state to `failed` — nothing is cancelled, and a download
    that comes back to life still raises the banner. `resolveStalledUpdateCheck()`
    is called by the timer *and* by everything that acts on the state (both
    check paths, `get-update-check-state`), so a timer that never ran — a
    suspended laptop — cannot strand the button either. The automatic check
    also stands down on `isUpdateCheckOccupied()` both before and after its 4 s
    wait: `show()` re-runs it on every tray reopen. This and the **map-pack
  check** ([map-packs.md](map-packs.md)) are the app's **only** network
  requests — if you add another one, the README "Network use"
  section and the in-app FAQ both have to change. `hmo-updater.exe` makes none
  either: the only URL it knows is the releases page, and only `Process.Start`ed
  from the error screen's button, user-initiated like the Credits links.

## Launching the installer

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
  - **`autoRunAppAfterInstall` is what relaunches the app on the visible path,
    not `quitAndInstall`'s second argument.** `BaseUpdater.quitAndInstall(isSilent,
    isForceRunAfter)` calls
    `install(isSilent, isSilent ? isForceRunAfter : this.autoRunAppAfterInstall)`,
    so with `isSilent = false` the `true` we pass is ignored and that flag
    decides. It is already `true` by default and is pinned explicitly in
    `prepareUpdater()` so a library default cannot strand the user on a closed
    app; the same flag is why tier 3 relaunches at all.
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
  not call `app.quit()` before that. No file within **15 s**, a spawn error, a
  missing folder → log line, tier 2. That is what makes an antivirus block
  harmless, and it is the one invariant never to weaken.
  **The budget was 4 s until 1.3.1.** On 2026-09-23 the 1.2.0 → 1.3.0 update
  on the owner's PC logged `update-helper ok=no reason=no-ready-file ms=5321`
  and went to tier 2: the helper had been copied and spawned, was still alive
  at the deadline, and had written neither the ready-file nor its own first
  log line (`start`, which `Runner` writes right after `Show()`), so it was
  stalled *before* drawing — a cold CLR/WPF start, or an antivirus holding a
  freshly copied unsigned exe for analysis (Bitdefender flagged an unrelated
  script on the same machine fifteen minutes later). The two 2026-09-22 runs
  of the identical helper took 230 ms to the ready-file; no Windows Update,
  reboot-related or .NET ngen event explains the difference, so the cause is
  not pinned. The wait was raised to 15 s because it costs nothing on the
  happy path (the file ends it), a dead helper still ends it at once
  (`isDead`), and only a blocked helper pays it — once, before the stock
  installer. The "updating" view stays on screen for the whole wait.
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
  is only set once a tier has started, and tier 1 awaits for up to 15 s; banner +
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
  (`helperHome()`, and `Updater.updaterCacheDir()` asks
  `autoUpdater.downloadedUpdateHelper.cacheDir` first). It cannot run from
  `resources/updater` — NSIS deletes that during the update. See
  [§ Bitdefender](#bitdefender-unsigned-executables-and-temp--a-real-trap) for
  why `%TEMP%` is not an option.
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

## The NSIS build shape

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

## Bitdefender, unsigned executables and `%TEMP%` — a real trap

This section is the one place the incident is described; AGENTS.md rule 7 and
every other document point here. Found the hard way on the development
machine, twice in one session:

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

## The installer window is ours (0.3.4) — `build/installer.nsh`

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

See also: [releasing.md](releasing.md) for the procedure that publishes any of
this, and [i18n.md](i18n.md) for the helper's string table.
