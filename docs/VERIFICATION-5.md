# Verification 5 — 0.3.2 field diagnostics (independent review)

Reviewed HEAD `a401971` (version 0.3.2), commits `ce4d5f6..HEAD` (32 files,
+2625/−163). Spec: `docs/SPEC-0.3.2.md`. Nothing in `DEV-REPORT.md`, the commit
messages or the developer summary was taken on trust; every claim below was
re-derived from the code, the tests, a scratch script or a run of the packaged
build. Runtime checks used `dist/win-unpacked/Halloween Map Overlay.exe`
(asar `src/`, `index.js` and `package.json` version verified byte-identical to
HEAD), always with `--user-data-dir=<scratchpad>\ud1`, ≤ 20 s per instance,
killed by PID filtered on that path. No project file was modified except this
one; no commit, tag or push.

## Verdict: **DO NOT SHIP** (one blocking finding, small fix, needs a packaged re-run)

§1 (app log), §3 (report zip), §4 (hotkey banner), the crash-notice half of §2,
i18n, version, changelog and every regression check pass, and 216/216 tests
are green. But the spec's `render-process-gone` policy ("reload once, quit on
the second within 60 s") does not work in the packaged build: a main-window
renderer death makes the **whole app die natively within ~6 s, with no
`app.log` line, no crash file and therefore no crash notice on the next
start** — reproduced 4/4. That is a regression against 0.3.1 (where the
process survived a renderer crash) and it is the exact case the feature was
built to explain. The fix is a few lines (finding 1), but it has to be
re-verified in a packaged build, so not "ship with fixes".

## Spec-section table

| § | Item | Result | Evidence |
|---|------|--------|----------|
| 1 | `app.log`, shared writer, buffered, 1 MB + `.1`, events, redaction | **PASS** | `rotating-log.js:89-227` (queue + `unref`'d 500 ms timer `:160-167`, `appendFileSync` per batch `:186-199`, rotate `:218-226`, ring capped by `splice` `:146-149`); `app-log.js:38-42` (1 MB, 200 lines, 500 ms), `:104-124` every string field through `redactHome` (`scrub`); `init()` is the first `require` in `index.js:31-32` so `home` is set before any other module logs; crash formatter re-redacts each ring line (`crash.js:78`). Events present: `startup`/`startup-settings`/`startup-gpu`, `map-change` (`main-window.js:214-219` collapses same key+source), `hotkey`, `hotkey-register-failed`, `hotkeys-loaded`, `setting` (`settings.js:68`, only on change), `language`, `update` (5 states + error), `install-update`, `detector` start/stop, `overlay` show/hide/move, `obs` open/close, `crash-notice`, `diagnostic-report`, `shutdown`, `error` (renderer forwarded over `renderer-error`, `renderer.js:99-115`). Smoke log (6 starts, 25.8 KB): format `<ISO> <level> <event> k=v`, e.g. `2026-09-17T17:58:03.804Z info startup version=0.3.2 electron=40.10.6 … packaged=true portable=false displays=1 maps=4 customs=0 monitors=1920x1080@1`; `grep -iE 'users\\|users/|fisso|\.png'` over `app.log`, `detector.log` and the crash file → no match. Custom maps: `main-window.js:134-135` logs `(custom)`, `hotkeys.js:373-376` logs `action=map` (never the key or uuid); `entry.custom` is a real boolean (`map-catalog.js:67`). Settings snapshot holds no path (`settings-defaults.js:15-55`, all numbers/booleans/enums/accelerators/crash-file name). |
| 2 | Crash file on `uncaughtException`, exit; `unhandledRejection` lives; `render-process-gone` reload once → quit; notice banner; ≤ 5 files | **FAIL** (render-process-gone) / PASS (rest, by reading + runtime for the notice) | `app-log.js:262-266` → `fatal()` `:287-324`: log line, `flush()` (try/catch), `writeCrashReport` **sync** `writeFileSync` (`crash.js:128`) inside try, then `process.exit(1)`; nothing in the handler can re-enter it (a throw inside an `uncaughtException` listener ends the process, no loop; `exiting` guard `:318`). `unhandledRejection` `:268-276` only logs. Prune to 5 on every write (`crash.js:132`); scratch: 7 planted + 1 written → 5 remain, newest kept. `pendingCrash` `:149-155` string compare; scratch: `pendingCrash(null)`=newest, `(newest)`=null, `(older)`=newest. Runtime: planted `crash-2026-09-17T10-00-00-000Z.txt` → `crash-notice pending=yes file=crash-2026-09-17T10-00-00-000Z.txt`; with `lastCrashSeen` set to that name → `pending=no`; dismiss writes the newest name (`diagnostics.js:69-75`). Normal close is not a crash: run 3 (WM_CLOSE to the test PID's main window) logged `overlay action=hide` → `detector action=stop` → `shutdown` and no `render-process-gone` line. **Renderer death: see finding 1.** |
| 3 | Report zip on Desktop (fallback userData), file list, `system.txt`, toast + `showItemInFolder`, own zip writer, README | **PASS** (two LOW notes) | `LOG_FILES` constant `diagnostics.js:27-34` + `crash-*.txt` + generated `system.txt` (`:147-150`); `report.js` walks nothing (`:334-359`), never throws (`:363-369`), skips missing (`:339-342`), 4 MB tail cap (`:264,284-298`); Desktop → userData fallback `diagnostics.js:133-157`; `shell.showItemInFolder` `:173`. Zip built by scratch script from the smoke `ud1` with the real `buildDiagnosticReport`, opened by PowerShell `Expand-Archive`: 6 entries — `app.log` 25851 B (byte-identical to userData), `detector.log` 645, `settings-app.json` 358, `hotkeys.json` 540, `crash-…txt` 108, `system.txt` 33; `app.log.1`/`detector.log.1` correctly `skipped`; 3141 B archive. `zip.js` uses `deflateRawSync` (`:111`), stores what deflate would grow (`:114-117`), CRC/sizes up front; `readZip` cross-checks CRC (`:222`). No new dependency (`package.json` `dependencies` unchanged; `node:zlib` only). README "Reporting a problem" 3 steps + contents list present. |
| 4 | Hotkey-conflict banner, updated in place, logged, not a toast per reload | **PASS** (one LOW) | `hotkeys.js:298-331` `safeRegister` → `noteConflict` (dedupe per accelerator, `appLog.warn('hotkey-register-failed')`), toast suppressed while `bulkLoading` (`:305,309`), `conflicts` rebuilt each `loadKeys()` (`:386-400`), pushed as `hotkey-conflicts` and served by `get-hotkey-conflicts` (`:58`); renderer `js/diagnostics.js:225-228,239-245,261-270` — `.text()` on `#hotkeyConflictList`, `acceleratorToDisplay`, hides when empty, re-renders on `onChange`. Runtime (owner's instance held every accelerator): 13 × `warn hotkey-register-failed accelerator=… action=… reason=taken` and `hotkeys-loaded maps=4 conflicts=13`; per-map entries carry `action=map`, never a uuid or map name. Keys `hotkeyConflict.title/help` in both catalogues. |
| 5 | Out of scope: detector log unchanged | **PASS** | `map-detector/log.js` is now a 16-line subclass; `formatLine`/`formatValue`/`shouldRotate` in `rotating-log.js:52-87` are textually identical to the 0.3.1 functions (`git show ce4d5f6:src/core/map-detector/log.js:38-71`), level omitted when falsy (`:55`), `flushMs` 0 = `appendFileSync` per line (`:151-156`), 512 KB (`log.js:248`). Runtime line: `2026-09-17T17:59:54.388Z loop-start templates=4 gameMs=700 idleMs=2000 version=0.3.2` — same shape as 0.3.1, no level token. Test `rotating-log.test.js:24` asserts the no-level shape. |
| T | Tests listed in the spec | **PASS** | `npm test` → **216 pass / 0 fail** (3.5 s; previous pass 148). rotating-log: rotation across a buffered batch (`:93-112`), cap constants, write/flush failure tolerance (`:149-173`); zip: round trip of 3 files incl. empty and 2 MB (`diagnostics-zip.test.js:24`), raw-deflate check (`:47`), store-when-growing (`:68`); crash file with ring buffer (`diagnostics-report.test.js:145`), capped at 5 (`:183`), `pendingCrash` (`:232`), `redactHome` ×4. `node --test test/i18n.test.js` → 18 pass; key sets en/it 194 = 194 identical; the 9 new keys present in both with matching placeholders. |
| V | Version 0.3.2, changelog | **PASS** | `package.json:3`, `package-lock.json:3,9` (only lines changed in the lock); README `### 0.3.2` with four entries; asar `package.json` version 0.3.2. |
| R | Regression | **PASS** | `overlay-window.js` diff is three `appLog.event` lines only — `pop-up-menu` + 1 s re-assert, `setIgnoreMouseEvents(true)` without `forward`, `focusable:false`, `skipTaskbar` intact; `before-quit` still closes the overlay first then detector, tray, then `shutdown` + `flush()` (`index.js:148-157`; run 3 order confirmed on disk); `installUpdate` flushes before spawning (`main-window.js:593-594`). `detector-rules.js`/`matcher.js`/`overlay-position.js` untouched: 700/2000 ms, `MENU_TICKS_TO_HIDE = 3`, throttle 2000. `map-detector.js` diff = two `appLog.event` lines (start/stop). Asar: `src/i18n/en.json`, `it.json`, all diagnostics modules present; no `.claude`, `docs`, `test`, `detection-fixtures`, `scripts`, `maps-src`, `dist` entries (1098 entries listed). |

## Performance (task item 3)

- Detector ticks write nothing to `app.log` (only `start`/`stop`,
  `map-detector.js:208,262`); `detector.log` stays unbuffered as before.
- `map-change` from a slider drag collapses to one line per distinct
  key+source (`main-window.js:214-219`; `options.js:44-47` sends
  `source: 'settings'`).
- `setting` is one queued line per change (`settings.js:68`) — a drag is N
  lines in one 500 ms batch; the sync `writeFileSync` per pixel in
  `Settings.write()` is pre-existing, not new.
- `overlay move` rides on the existing `moved` handler (once per drag end),
  next to the two pre-existing sync settings writes.
- The only synchronous fs on a non-crash path is one `appendFileSync` per
  500 ms batch (`rotating-log.js:191`) when the queue is non-empty; the timer
  is `unref`'d and does fire in the packaged main process (the `crash-notice`
  line at +0.18 s after `logStartup()`'s explicit flush reached the disk).
- Ring buffer bounded at 200 (`rotating-log.js:148`). Zip build is sync
  (`deflateRawSync`, ≤ 4 MB per entry) but only on the button click.
- Quit: the last 500 ms are flushed explicitly in `before-quit`
  (`index.js:156`); one small append, no measurable delay (run 3 exited on its
  own within the 5 s wait).

## Findings (most severe first)

1. **CONFIRMED — BLOCKING. A main-window renderer death kills the whole app
   natively; nothing is logged, no crash file is written.**
   `src/core/main-window.js:279-301`: inside the `render-process-gone`
   handler the code calls `this.window.reload()` synchronously. Four packaged
   runs, each killing only renderer processes of the test PID (`Stop-Process`
   on children whose command line carries the scratch `--user-data-dir`):
   - run 2d (main renderer only, identified as the earliest-started child):
     handler ran (`Renderer process gone: { reason: 'crashed', exitCode: -1 }`
     on the captured stderr), then by t+6.5 s **every** process of the
     instance was gone — browser, GPU, utility and the untouched overlay
     renderer; `app.log` unchanged since startup, no `crash-*.txt`, no
     `shutdown` line.
   - run 2c: same, with a reloaded renderer visible for ~3 s first, then the
     same silent death; Electron printed a second "Renderer process crashed"
     with **no** second handler line, so the second death was never seen by JS.
   - runs 2 and 2b: browser exit code `-2147483645` = `0x80000003`
     (`STATUS_BREAKPOINT`, a Chromium `CHECK`), not `app.quit()`.
   Mechanism matches Electron issue #19887 ("App crash after render process
   crash" — navigating from inside the crash callback takes the main process
   down) and Electron PR #53924 ("post navigations started while a dead
   renderer is torn down"): a navigation issued while Chromium is still
   tearing the dead frame host down. Electron here is 40.10.6.
   Consequences: (a) 0.3.1 kept running after a renderer crash (dead window,
   overlay alive); 0.3.2 loses the overlay mid-game; (b) the queued
   `render-process-gone` line dies with the process, so the next start shows
   no crash notice and a report has nothing about it — the one case §2 exists
   for.
   *Fix:* (1) never navigate from inside the handler — defer:
   `setTimeout(() => { if (this.window && !this.window.isDestroyed()) this.window.reload(); }, 100)`
   (or `webContents.loadFile` on the next tick), keep the 60 s repeat logic;
   (2) `appLog.flush()` synchronously right after
   `appLog.error('render-process-gone', …)` — it is rare and cheap, and the
   line must be on disk before anything else happens; (3) rebuild and re-run
   the check: `scratchpad\run2d.ps1` (kills the earliest-started renderer,
   waits, then kills its replacement) must show the `render-process-gone
   repeat=no` line within 1 s, the reloaded window alive after 10 s, and on
   the second kill a `crash-*.txt`, `overlay hide`/`shutdown` lines and an
   exit on its own.
2. **SUSPECTED (by reading) — MEDIUM. Pre-existing unwrapped sync file writes
   reachable from synchronous handlers are now fatal.** With a
   `process.on('uncaughtException')` listener installed, Electron no longer
   shows its "A JavaScript error occurred in the main process" box and
   continues; the app writes a crash file and `process.exit(1)`s. Sync paths
   with no `try/catch`: `Settings.write()` `src/core/settings.js:77-80`
   (`writeFileSync`) reached from the overlay `moved` event
   (`overlay-window.js:78-79`) and from `ipcMain.on('reset-system-hotkey')`
   (`hotkeys.js:165`); `ipcMain.on('delete-hotkey')` `hotkeys.js:104`
   (`writeFileSync` on `hotkeys.json`). An `EPERM`/`EBUSY` from an antivirus
   or a sync client holding `settings-app.json` during a drag now ends the
   session (with a crash file, at least). Async handlers (`map-change`,
   `set-setting`, the detector tick) are safe: a throw there is a logged
   rejection. *Fix:* wrap `Settings.write()` and the two `hotkeys.json`
   writes in `try/catch` + `appLog.error('setting-write-failed', …)`.
3. **CONFIRMED — LOW. README claim "no custom map names" is not always true.**
   `hotkeys.json` goes into the zip verbatim (spec §3 asks for it) and each
   entry carries `mapKey` (`hotkeys.js:79-84`; sample in the smoke `ud1`:
   `"mapKey": "deftyconchgaming/East Haddonfield"`). A custom map bound to a
   hotkey puts `Custom/<user-typed name>` in the report. `README.md:238-239`
   says "no custom map names". *Fix:* either reword ("…except the name of a
   custom map you bound to a hotkey, which is in `hotkeys.json`") or write a
   redacted copy of `hotkeys.json` into the zip (`mapKey` → `Custom/(custom)`
   for `entry.custom`).
4. **CONFIRMED — LOW. The success toast says "Desktop" after the userData
   fallback.** `diagnostics.js:151-157` falls back to userData, `:171` still
   sends `diagnostics.created` = "Diagnostic report saved to your Desktop:
   {file}". *Fix:* second key (`diagnostics.createdFallback`, "saved next to
   the logs") or drop "to your Desktop" from the string (en + it).
5. **CONFIRMED — LOW. One toast still fires on every reload.**
   `hotkeys.js:363-366`: a map hotkey shadowed by a system hotkey both goes
   into the banner (`reason=shadowed`) and toasts
   `hotkeys.error.systemShadowsMap` on every `loadKeys()`, not gated on
   `bulkLoading` like the other two. Spec §4: "do not toast it every reload".
   *Fix:* `if (win && !this.bulkLoading)` on that line.
6. **CONFIRMED — LOW. Every start logs the conflict set twice.** `loadKeys()`
   runs from `createWindow()` (`index.js:124`) and again from the renderer's
   `load-hotkeys` on load; the smoke log has 2 × `hotkeys-loaded` and 2 × N
   `hotkey-register-failed` per start (12 and 156 lines over 6 starts). With
   one real conflict that is 2 lines per start — cosmetic, but a Discord user
   will grow a 1 MB log faster than intended. *Option:* skip the warn line
   when the accelerator was already in `conflicts` on the previous load.
7. **INFO. The overlay window's renderer death is unhandled.** Run 2c, kill A
   (overlay renderer): Electron's default "Renderer process crashed" on
   stderr, no `render-process-gone` listener on that `webContents`
   (`overlay-window.js`), nothing in `app.log`, overlay blank until the app is
   restarted. Not in the spec; worth one `appLog.error` and a
   `close()`+`show()` while touching finding 1.
8. **INFO. `child-process-gone` is logged at `error` level for every reason
   including `clean-exit`** (`main-window.js:305-313`). Zero lines appeared
   across six smoke starts and three quits, so no noise seen; consider
   skipping `clean-exit`.
9. **INFO. Italian.** The nine new strings read naturally
   (`L'ultima volta l'app si è chiusa da sola…`, `Chiudi l'avviso`,
   `Alcune scorciatoie non sono state registrate:`, `…Cambiale in
   Impostazioni → Scorciatoie.`, `Creazione del report diagnostico…`). No
   change needed; "Ignora" would be a slightly shorter "Dismiss" but "Chiudi
   l'avviso" is clearer.

## Runtime evidence (scratch userData, packaged build)

| run | action | result |
|-----|--------|--------|
| 1 | start, planted crash file, `lastCrashSeen` null | `crash-notice pending=yes file=crash-2026-09-17T10-00-00-000Z.txt`; startup block (3 lines), `startup-gpu vendor=0x10de device=0x2489 driver=32.0.16.1692`; 13 conflicts (owner's instance holds them) |
| 2 | `lastCrashSeen` = planted name, `mapDetection` on | `pending=no`; `detector.log` gains `loop-start … version=0.3.2` and `window-lost` in the 0.3.1 shape |
| 2, 2b, 2c, 2d | kill renderer(s) of the test PID | see finding 1 — 4/4 silent native death, nothing on disk |
| 3 | `WM_CLOSE` to the test PID's main window (hwnd found by PID + title) | `overlay action=hide` → `detector action=stop` → `shutdown`, app exited on its own, no `render-process-gone` line |
| zip | `buildDiagnosticReport` over `ud1`, `Expand-Archive` | 6 entries, `app.log` byte-identical, backups correctly skipped |

`git status` was clean before the review and shows only this file after it.

## Could not be verified

- The `uncaughtException` path at runtime in the packaged build: there is no
  way to raise one without editing a project file. Verified by reading only
  (sync crash-file write before `process.exit(1)`, no re-entry, rejection
  never exits).
- `system.txt` as generated by the app (`appLog.collect()` needs electron);
  the scratch zip carries a stub. Its contents were checked by reading
  `diagnostics.js:93-117` (`[app]`, `[displays]`, `[gpu]`, `[settings]` as
  JSON, `[health]`, `[crash files]`; no path-valued field exists).
- The report button's click flow end to end (IPC handler read, not clicked);
  `shell.showItemInFolder` not exercised.
- 0.3.1's own behaviour on a renderer kill for a side-by-side comparison
  (the only 0.3.1 build on this machine is the owner's installed app, which
  must not be touched); the statement that 0.3.1 kept the process alive rests
  on the old code having no handler and Electron's default of leaving a dead
  window.
- The `render-process-gone` `reason` on a normal close on Linux.
