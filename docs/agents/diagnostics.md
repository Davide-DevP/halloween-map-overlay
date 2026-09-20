# Field diagnostics: logs, crashes and the report

[← AGENTS.md](../../AGENTS.md) · **Read before** touching `src/core/app-log.js`,
`rotating-log.js`, `src/core/diagnostics.js`, `diagnostics/zip.js`,
`report.js`, `crash.js`, `src/shared/redact.js`, `src/js/diagnostics.js`
or any crash/exception handler.

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

- **The renderer never writes the log.** It has `nodeIntegration: true` and
  could, but two processes appending to one file with two size caches lose
  lines at the rotation boundary. `window.onerror` and `unhandledrejection` are
  forwarded over `renderer-error` and main writes them.

- **Three lines were added in 0.7, all because something became invisible.**
  `[health]` gains `unloadWindowInTray = on|off` and
  `main window = loaded|unloaded` (plus `main window held by = …` when a busy
  reason is stopping the teardown), because the window is now destroyed while
  the app sits in the tray and "it took a moment to open" / "a toast never
  appeared" both start there; `app.log` carries the edges themselves as
  `main-window state=unloaded reason=… hiddenMs=…`. And `detector gc =
  available|noop` (also in the startup snapshot), because `core/gc.js`'s
  `vm`/`setFlagsFromString` trick has never been observed working *inside
  Electron* and a silent fall back to the no-op costs ~110 MB of peak during a
  match with nothing on screen to say so.

The hotkey-conflict health check is part of this feature; its rules are with
the rest of the hotkey logic in [hotkeys.md](hotkeys.md). `detector.log`'s own
policy (what the detector writes, and the "no frames, no pixels" rule) is in
[detection.md](detection.md); the `[markers]` and `[map packs]` sections of
`system.txt` are in [markers-and-tab-mode.md](markers-and-tab-mode.md) and
[map-packs.md](map-packs.md).
