# Memory and the measured performance decisions

[← AGENTS.md](../../AGENTS.md) · **Read before** "cleaning up" `src/core/gc.js`,
`src/shared/web-preferences.js`, the `hardwareAcceleration` setting, or
anything that looks like a spare allocation in the detector loop.

- **Memory: the three decisions, all measured.** Full numbers and everything
  that was rejected are in `docs/MEMORY-REPORT-2.md`; the short version, because
  each one looks like something to "clean up":
  - **The number to optimise is the private working set, not private bytes.**
    The 0.2.2 report's "250–300 MB private" is Windows *commit charge*. The RAM
    the app actually holds in the in-match state (map on the overlay, main
    window in the tray, auto-detect on) measured **131.6 MB** private working
    set against 268 MB commit and 463 MB working set — and **118.0 / 205.9 /
    463.5** after the changes below, settling to **~106 MB pws** once the window
    has been in the tray for a few minutes and Windows has trimmed it. Quote all
    three or quote the first; the summed working set is the misleading one,
    because it counts the 214 MB executable's shared pages once per process.
    **Always say how long the window had been hidden** — the same state reads
    118 MB at 75 s and 106 MB at 5½ min.
  - **`hardwareAcceleration` is a setting and its default is `false`.** Read in
    `index.js` **before `app.whenReady()`** — `app.disableHardwareAcceleration()`
    is ignored after that, which is why it is restart-only and why `Settings` is
    built above the window rather than inside `createWindow`. Worth
    **−14 MB pws and −59 MB of commit** in the settled in-match state, for **no
    measurable CPU** (a paired back-to-back pair of 5½-minute runs: 0.24 % of
    one core with it on, 0.19 % with it off; two more runs on the previous
    build agree) — and with no visible difference: `src/map/map.html` has no
    animation, transition or `@keyframes` at all (still PNG + SVG), the drag is
    `-webkit-app-region: drag` (an OS window move) and the placement is
    `setPosition` from main, so nothing the player looks at mid-match goes
    through the renderer's rasteriser. The main window's own UI *is* rastered on
    the CPU; it is hidden during a match.
  - **The detector collects after every tick that captured a frame**
    (`core/gc.js`, called at the end of a grab in
    `core/map-detector/frame-source.js` — i.e. **in the process that holds the
    frame**: the utility process normally, main only on the fallback path.
    `worker.js` loads the collector itself, and reports whether it works so
    `system.txt` can print `worker gc = available|noop`; a worker without one
    would have *moved* the oscillation below rather than removing it).
    `node-screenshots` has no
    dispose/free/close API, so a 7.6 MB native frame is only released when V8
    happens to collect its small JS wrapper — §3 of the old report measured up
    to eight outstanding and rss oscillating 78→191 MB. One collection per
    captured tick pins it at 78–80 MB for **1.3 ms median / 6.3 ms worst**, well
    inside the ~30 ms budget in "The capture path"
    ([detection.md](detection.md)). The function comes out of a
    throw-away `vm` context with `--expose-gc` flipped straight back off, *not*
    from `appendSwitch('js-flags')`, so no renderer gets a global `gc`. Do not
    move the call out of the `captured` guard: a tick with no game window
    allocates nothing.
  - **Since 0.7 that whole allocation lives in a second process.** Capture,
    gate, grayscale and match run in an Electron `utilityProcess`
    (`core/map-detector/worker.js`), started **lazily** — with auto-detect off
    and Tab-map mode off the process does not exist, and it is killed again when
    the switch goes off (a deliberate stop arms no restart, which it used to:
    a new child appeared 250 ms after the user turned detection off and stayed
    for the session). Its cost is the oscillation above rather than an
    addition to it: the frames used to be main's. Budget it as a bare Node
    child (~30–40 MB of its own private working set, plus the 7.6 MB frame and
    the ~1 MB of templates) that only exists while detection is running; the
    exact figure on the owner's machine is one of the things a packaged run
    still has to report. If the process cannot start, the same code runs in
    main and `system.txt` says so.
  - **Every window's `webPreferences` comes from `shared/web-preferences.js`**
    (`spellcheck`, `webgl`, `enableWebSQL` off — Electron defaults `spellcheck`
    to **on** and loads a dictionary per renderer). Measured worth: **~1 MB,
    inside the noise** — it is kept because it cannot regress a feature the app
    does not have, not because it moved the number, and it is not in the
    headline. A test asserts all four windows use the builder, so the fifth one
    cannot quietly go back to an inline object.
    `backgroundThrottling` is deliberately absent:
    throttling the tray-hidden main window is right, and its hotkeys arrive as
    IPC, not as timers.
  - **Tearing the main window's renderer down in the tray — done in 0.7, and
    only because the architecture moved first.** `docs/MEMORY-REPORT-2.md` §3.3
    rejected it: `src/js/maps.js` owned `currentKey`/`lastKey`, every hotkey,
    `show-map-command` and the `map-detector-shown` report, so destroying that
    renderer took the whole match with it. The prize was ~32 MB of private
    working set, about a quarter of the app's in-match RAM. The rewrite it asked
    for is `docs/SPEC-MAP-STATE.md`: the pure `shared/map-state.js` plus the
    thin `core/map-controller.js` now own the map state in **main**, the
    renderer is a view, and the window is destroyed after
    `UNLOAD_GRACE_MS` (45 s) in the tray — the decision is the pure
    `shared/window-unload.js`. **There is no setting since 1.0**: it was
    `unloadWindowInTray` (default true) in 0.7, and the switch needed a
    paragraph about memory to explain itself, which is exactly what
    docs/agents/settings-and-onboarding.md § The standing UX rule forbids.
    Nobody has a reason to prefer ~32 MB held for the session over a window
    that takes a moment to reopen, so the app decides. A leftover `false` in an
    existing settings file is ignored rather than migrated, and
    `unloadState()` no longer carries a `setting` for the report to print. Two rules keep it safe
    and both are load-bearing: the main window's `closed` handler skips its
    `overlayWindow.close()` when the window carries `__hmoUnloading`, and the
    one-time startup work (`checkUpdates`, the stale-helper sweep) is guarded by
    `startupTasksDone` so reopening the window is not a new network request.
    **The ~32 MB is an ESTIMATE, not a measurement** — it is this report's own
    figure for renderer A in the in-match state, and nobody has measured the app
    with the window actually gone, because no agent may launch it. Say
    "estimated" until the owner does. `app.log` records
    `main-window state=unloaded|loaded` with the reason and `system.txt` prints
    `main window = loaded|unloaded`, so a measurement run can at least be
    confirmed to have been in the right state (map on the overlay, auto-detect
    on, window in the tray for **more than five minutes**).
  - **`core/gc.js` is required lazily and now reports itself.** It flips a V8
    flag with `setFlagsFromString`; an embedder is allowed to freeze that, and a
    frozen flag is a V8 **FATAL**, not an exception a `try/catch` can absorb.
    Requiring it at module load put that in the startup path of every user,
    including everyone with the detector off — it is required from
    `MapDetector.start()` instead. And whether the trick works *inside Electron*
    had never been observed at all: the startup snapshot and `system.txt` print
    `gc = available|noop`, and `noop` means the ~110 MB peak is back.
  - **One thing that looks like a win and is not.**
    `--renderer-process-limit=1` saves a real 18.6 MB by putting every window in
    one renderer process, at the cost of the overlay no longer surviving a
    main-window renderer crash. Written up with its numbers rather than shipped.
    Note the unload above goes the *other* way on that invariant: with the map
    state in main, a main-window renderer death now costs nothing at all — the
    overlay keeps its map and the hotkeys never stop.

See also: [detection.md](detection.md) ("The capture path — do not make it
heavier") for the per-tick budget the collection has to fit inside, and
[overlay-windows.md](overlay-windows.md) for the windows the builder builds.
