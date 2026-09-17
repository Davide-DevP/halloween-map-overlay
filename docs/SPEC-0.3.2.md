# 0.3.2 — field diagnostics (spec)

Goal: when a friend says "it does not work", one click gives the owner
everything needed. Zero telemetry, negligible runtime cost.

## 1. App log — `app.log` in userData

- Same writer style as `src/core/map-detector/log.js` (append-only, buffered
  via `fs.appendFile` batches or a small in-memory queue flushed every 500 ms,
  rotate at 1 MB keeping one `.1`). Factor a shared pure `rotating-log.js`
  used by both logs; keep `detector.log` separate (its volume is higher).
- One line per event, ISO time, `level event k=v …`. Events:
  - `startup`: version, electron, platform/release, arch, locale, resolved
    language, displays (count, each bounds + scaleFactor), GPU (from
    `app.getGPUInfo('basic')`, best effort), packaged/portable, settings
    snapshot (all keys, no paths), maps in catalogue, custom count.
  - `map-change` (key, source: click/hotkey/cli/detector/preview/hide),
    `hotkey` (action), `hotkey-register-failed` (accelerator, action),
    `setting` (key, new value), `language`, `update` (each updater state incl.
    errors), `install-update`, `detector` start/stop (the detail stays in
    detector.log), `overlay` show/hide/move, `obs` open/close.
  - `error`: main `uncaughtException` / `unhandledRejection`,
    `render-process-gone`, `child-process-gone`, renderer `window.onerror` and
    `unhandledrejection` forwarded over IPC (`renderer-error`), with stack.
- Never log: file paths under the user profile (strip `app.getPath('home')` to
  `~`), custom map file names beyond the count, frames.

## 2. Crash report

- On main `uncaughtException`: write `crash-<ISO date>.txt` (version, message,
  stack, last 200 lines of app.log ring buffer kept in memory), then let the
  process exit (do not swallow). On `unhandledRejection`: log as error, keep
  running. On `render-process-gone` of the main window: log + reload the
  window once; second time in 60 s → crash file + quit.
- Next start: if a `crash-*.txt` newer than the last acknowledged one exists
  (store `lastCrashSeen` in settings), show a dismissible warning banner on
  the home page: "The app closed unexpectedly last time. Create a diagnostic
  report and send it." with a button that runs §3. Keep at most 5 crash files.

## 3. "Create diagnostic report" button (Settings → General, and the crash banner)

- Builds `HalloweenMapOverlay-report-<yyyyMMdd-HHmm>.zip` on the Desktop
  (`app.getPath('desktop')`, fallback userData) containing: `app.log` (+`.1`),
  `detector.log` (+`.1`), `settings-app.json`, `hotkeys.json`, every
  `crash-*.txt`, and `system.txt` (the startup block re-generated now + the
  health-check result from §4). No screenshots, no maps.
- Zip without a new dependency: Electron ships zlib; write a minimal store/
  deflate zip writer (`src/core/diagnostics/zip.js`, pure, tested with a
  round-trip through `node:zlib` inflate) — or use `node:zlib` + a 60-line
  local-file-header writer. No `archiver`/`adm-zip`.
- After writing: toast with the file name and `shell.showItemInFolder(path)`.
  Translated en/it. README: "Reporting a problem" section (3 steps).

## 4. Hotkey conflict warning (the one health check)

- At startup and after every hotkey reload, if any accelerator failed to
  register (`safeRegister` false), show a persistent (per-session) warning on
  the home page listing the combinations and "already used by another app
  (Discord, NVIDIA, …) — change it in Settings → Hotkeys". Log it. Do not
  toast it every reload; one banner, updated in place.

## 5. Not in scope

Diagnostics panel, log level setting, remote upload. Detector log unchanged.

## Tests

- rotating-log: rotation, size cap, failure tolerance.
- zip writer: round-trip of 3 files incl. an empty one and a 2 MB one.
- crash file: written with the ring buffer, capped at 5.
- i18n scan still green; key sets identical.

Version 0.3.2. Changelog entry.
