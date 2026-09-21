# Settings and the first-run welcome tour

[← AGENTS.md](../../AGENTS.md) · **Read before** touching `src/core/settings.js`,
`src/shared/settings-defaults.js`, `src/js/options.js`,
`src/js/settings.js`, `src/js/onboarding.js` or
`src/shared/onboarding-rules.js`.

## The Settings window is not guaranteed to exist

Since 0.7 the main window is **destroyed** while the app sits in the tray
(`unloadWindowInTray`, default true — `docs/SPEC-MAP-STATE.md` §5). Two
consequences for anything in this document:

- **Nothing in Settings, the tour or the mirrors may be the owner of a
  behaviour.** The four settings a hotkey can change (`rotation`, `opacity`,
  `size`, `markers`) are written by `shared/map-state.js` in main; an open
  Settings modal *follows* through `Options.syncFromSettings()` on a `map-state`
  push. It is not the writer any more, and it must not become one again.
- **Work with state in the renderer reports itself busy** so the window is not
  taken away underneath it: `setBusy(reason, on)` from `src/js/busy.js`, called
  for the Settings modal, the welcome tour, a diagnostic report and a custom-map
  import — plus a blanket `modal` reason for **any** open Bootstrap modal
  (`watchModals()`, wired once in `renderer.js`), because a file picked in *Add
  custom image* only exists in this window and the `import` reason covers the
  write, not the picking. Always clear a reason in a `finally` — one that is
  never cleared keeps the window alive forever. The hotkey bind dialog needs no
  reason of its own: main already knows it is recording (`Hotkeys.suspended`),
  and `Hotkeys.applyRegistration` re-asks whenever that moves, so the
  `SUSPEND_MAX_MS` watchdog lifting a stuck suspension is not a dead end.
  Main clears the whole set on `did-start-loading`, so a renderer that died
  with a modal open cannot strand it.
- **Nothing in the window may be the last copy of something.** "Later" on the
  update banner used to be a flag in `renderer.js` and came back on every
  reopen; it lives in main now. Deliberately *not* preserved: the gallery's
  creator filter, the scroll position, a half-typed custom map name with no
  file picked — all visible, all one action to redo.

## Writing settings

- **A failed settings write is not silent.** `Settings.write()`/`set()`/
  `merge()` return a boolean, every hotkey IPC handler that answers `ok(...)`
  answers `fail(...)` instead when the write failed, and the user gets the
  translated `settings.error.writeFailed` toast through
  `Settings.setNotifier()` (wired in `index.js`, because `Settings` is built
  before the window). **Throttled to one warning per 30 s** and never thrown:
  the overlay `moved` handler writes on every drag tick, so an unthrottled
  warning would be a toast per pixel. `Hotkeys.writeHotkeyFile()` is the single
  `hotkeys.json` writer and returns the same way.
- **`set()`/`merge()` take an opt-in `{rollback: true}`, and the hotkey writers
  use it.** Reporting a failure is not enough on its own: `set()` mutates
  memory before writing, so `save-system-hotkey` answered "could not be saved"
  while the rejected accelerator stayed in the settings object — and the next
  `loadKeys()` (an alt-tab away and back is enough) registered the binding the
  user had just been told was refused, showing it in the Hotkeys table until a
  restart. Save, reset, unbind and the `hotkeysGameOnly` switch all roll back;
  the migration's `merge()` does too. The overlay drag deliberately does
  **not**: `overlayX`/`overlayY` are where the window actually is, the next
  drag tick writes again milliseconds later, and reverting them mid-drag would
  make the stored position chase the cursor backwards. That is the whole reason
  it is opt-in rather than the default.

  Two mechanics of the writers worth knowing before touching them. A rollback
  for a key that was **not** there `delete`s it rather than setting
  `undefined`: an `undefined` own property reads as "unset" to `get()` but is
  not the state the write started from. And `merge()` guards the object it is
  handed on the assignment as well as on the key list, because
  `Object.assign(settings, 'nope')` would quietly add `{0: 'n', 1: 'o', …}` to
  `settings-app.json`; it also notifies only the keys whose value actually
  moved, so a `save-settings` that re-posts everything does not look like every
  setting changing at once.
- **`write()` is synchronous and wrapped, and both halves are deliberate.**
  Synchronous, so a settings write cannot race the next one. Wrapped, because
  an EPERM from an antivirus or a sync client holding `settings-app.json` open
  would otherwise reach main's `uncaughtException` handler and end the session
  mid-match — and the overlay's drag handler writes through here on every tick,
  which is exactly where such a lock shows up. Losing one write is survivable;
  losing the app mid-match is not.

- **`JSON.parse` alone is not enough to read the file** — `Settings.parseFile`
  (static and pure, so it is testable without an Electron `app`) also rejects
  anything that is not a plain object. `null`, `[]`, `3` and `"x"` are all
  *valid* JSON, so the `try/catch` around the read never fires for them, and the
  constructor's back-fill then throws a TypeError on `null` (or quietly builds a
  settings object out of an array or a boxed number). That throw happens
  **before `app.whenReady()` and before `appLog.installCrashHandlers()`**, so
  the app simply fails to start — no window, no crash file, on every start,
  until the user finds and deletes a file they do not know exists. An array is
  rejected explicitly because `typeof [] === 'object'`.
- **Settings `get()` vs `raw()`**: the renderer's `Settings.get()` turns a
  stored `0`/`false`/`""` into `null`. Use `raw()` wherever a falsy value is
  meaningful (glide 0, rotation 0, monitor 0, every checkbox).
- **Settings are written one key at a time** (`set-setting`), never as a whole
  object. Main writes some keys itself and the renderer never reads them back —
  system hotkey accelerators (`core/hotkeys.js`) and `overlayX`/`overlayY` on
  drag (`overlay-window.js`). `hotkeysGameOnly` has its **own** handler
  (`set-hotkeys-game-only`) rather than going through `set-setting`, because
  main has to act on it: the foreground watcher starts or stops and the
  shortcuts are registered or dropped in the same breath — the same reason
  `mapDetection` has `map-detector-start`/`-stop`. Posting the renderer's cached object would revert
  those the next time any slider moved. `save-settings` merges for the same
  reason, and `src/js/hotkeys.js` refreshes the renderer copy whenever
  `system-hotkeys-updated` arrives.

A `hotkey*` key missing from an old settings file gets the new default with no
conflict check — the rule and its safety net are in [hotkeys.md](hotkeys.md).
`hardwareAcceleration` must be read before `app.whenReady()`, which is why
`Settings` is built above the window; see [memory.md](memory.md).

## Settings reference

`src/shared/settings-defaults.js` carries **a one-line note where the name does
not say it** — what the setting is, and its unit. Anything that needs more than
that is here. A key absent from a
user's file is filled in from `DEFAULT_SETTINGS` on every start, so adding one is
backwards compatible and removing one is not; and no value in that file is a path
or user text, which is why `core/settings.js` may log every change.

- **The "only an explicit `false` is off" rule.** Every default-on switch is read
  as `raw(key) !== false`, in main and in the renderer alike, so a settings file
  written before the setting existed behaves like the shipped default. That
  covers `checkForUpdates`, `checkForMapPacks`, `hideInMenu`, `markers` and its
  four `markerLayer*` keys, `markerLegend`, `tabMarkersInstant`,
  `hotkeysGameOnly` and `unloadWindowInTray`. The pure `isLayerEnabled` applies
  the same rule to the marker layers on the other side.
- **A setting written from two places must be written as the same *type*.**
  `size`, `opacity` and `rotation` are numbers: `shared/map-state.js` writes them
  as numbers when the hotkeys move them, and a range input hands back a
  **string**, so `src/js/options.js` goes through `parseInt`/`parseFloat`. A file
  holding `"275"` one day and `275` the next makes `stepSize`'s input, the
  diagnostic report and any future comparison depend on which side wrote last.
- **`onboardingPending`'s shipped default must stay `false`.** The back-fill puts
  the key into an *existing* settings file too, so an upgrade is never
  interrupted; only `core/settings.js` sets it, once, on the start that creates
  the file. `onboardingDone` is what stops the tour opening twice — see the tour
  section below.
- **`hotkeyDefaultsVersion`'s shipped default is deliberately `0`**, i.e. behind
  `HOTKEY_DEFAULTS_VERSION`, so the back-fill cannot make an old file look
  already-migrated. [hotkeys.md](hotkeys.md) owns the migration itself, and the
  `hotkey*` accelerator defaults, which a test asserts agree with
  `SYSTEM_HOTKEY_DEFS`.
- **`lastCrashSeen` is a file name, not a timestamp** — the newest `crash-*.txt`
  the user has already been shown the home-page notice for. The names sort
  chronologically and cannot disagree with the files on disk; `null` means "never
  seen one", so any crash file present at startup raises the banner.
  [diagnostics.md](diagnostics.md) owns the crash policy.
- **`mapDetection` ships off** and is the one setting that turns on a screen
  capture; `hideInMenu` only ever acts while it is on.
  [detection.md](detection.md).
- **`tabMarkers` ships off** and needs `mapDetection`; `tabMarkerKey` is a
  **Windows virtual-key code** (9 = Tab), never an accelerator and never
  registered, and `tabMarkerKeyLabel` stores what the *browser* called that key
  because a virtual-key code cannot be turned back into a name on anything but a
  US layout. `markerTrigger` picks `auto` (the key trigger, falling back to
  polling) or `polling`. `markerOpacity` is separate from the overlay's own
  `opacity`: the map is a backdrop, the markers are the thing being read.
  [markers-and-tab-mode.md](markers-and-tab-mode.md) and
  `docs/SPEC-MARKERS.md` own the rest, including `tabMarkersInstant`'s
  second-press rule and `tabHidesMinimap`.
- **`hardwareAcceleration` ships off and `unloadWindowInTray` ships on** — both
  measured decisions, with the numbers in [memory.md](memory.md). A change to
  the first needs a restart (`app.disableHardwareAcceleration()` is ignored once
  the app is ready), which is why `useHardwareAcceleration` treats any
  non-boolean as the shipped default: a hand-edited file must not put the app in
  a third state. When the second may actually happen is the pure
  `shared/window-unload.js`.
- **`language` is `'system'` or a catalogue code**, resolved once in main against
  `app.getLocale()` — [i18n.md](i18n.md). `mapLabel` is the `MAP_LABEL_MODES`
  enum (`auto`/`always`/`never`), normalised by `mapLabelMode` so a file
  hand-edited to nonsense cannot make the overlay do something undefined.

## The first-run welcome tour

- **The first-run welcome tour** (`#tour`, `src/js/onboarding.js`, decisions in
  the pure `shared/onboarding-rules.js`). Six steps — language, placement,
  **markers**, hotkeys, auto-detect (**with Tab-map mode inside it**), done — in
  a panel inside the main window, **not** a second `BrowserWindow`.
  `ONBOARDING_STEPS` is the list and `src/index.html` carries one
  `[data-tour-step]` section per id; the step indicator's total is derived, so
  adding one is a one-line change here plus a section there. Markers are a step
  of their own because "a marker is a *possible* location" is the app's single
  most misreadable claim, and they come **before** the hotkeys step so the
  *Show / hide markers* row lands on something just explained. Tab-map mode is
  *inside* the auto-detect step rather than after it, because it cannot work
  with auto-detect off. Rules that hold it together:
  - It opens by itself only when `shouldShowOnboarding({onboardingPending,
    onboardingDone})` says so. **Two stored flags, not `Settings.freshInstall`.**
    `core/settings.js` sets `onboardingPending` once, on the start that creates
    the settings file ("this user is owed the tour"); `onboardingDone` is
    written when it is finished or skipped. `freshInstall` on its own was true
    for exactly one session, so a first run abandoned before Skip or Finish — a
    quit, a crash, an update restart — looked like an existing install
    afterwards and was never greeted. An upgrade still never sees it: the
    back-fill gives an existing file `onboardingPending: false`, which is why
    that default must stay `false`. Reopened from **Settings › General › Show
    the welcome tour**, which closes the Settings modal first — one focus trap
    at a time.
  - **No parallel state.** Its selects and its slider are *mirrors*: a change
    writes the value into the real control in Settings and fires its `input`
    event, so `src/js/options.js` does the saving, the overlay refresh and the
    glide snap. The auto-detect switch goes through `Detector.setEnabled`, the
    home-page switch's own path (and `Detector.onStatus` keeps the two boxes in
    step). The placement step borrows `Options.startPreview()`, so the real
    overlay shows the same sample map as the Overlay tab. `syncMirror` copies
    the real control's `disabled` state too — `.trigger()` runs a handler
    whether or not its element is disabled.
  - The only settings it owns are those two, and they have **their own IPC
    handlers** (`set-onboarding-done`, which clears `onboardingPending` in the
    same breath, beside `get-onboarding-state`) because `set-setting` answers
    with the settings object and cannot report a failed write. On a failure the
    tour is still marked done **in memory**: the throttled
    `settings.error.writeFailed` toast has already said so, and a panel that
    reopens on top of a user who dismissed it would be worse. It can only come
    back on a later start if `settings-app.json` could not be written at all —
    the one state in which the pending marker keeps being re-set anyway, and in
    which nothing else the user changes survives a restart either.
  - **Ordering against the rest of the first minute**: it opens last, from the
    `#loadingOverlay` slide-up callback, after the crash notice, the
    hotkey-conflict banner, the update banner and `get-hotkey-notice` have been
    collected, so none of them lands on top of it. Two of those cannot happen
    on a fresh install at all. `--hmo-z-tour` (1085) puts it above the Bootstrap
    modals and deliberately **below** `--hmo-z-toast`, so the write-failure
    warning stays readable.
  - **Every key it handles is caught on the `#tour` element, never on
    `document`** — `src/js/hotkeys.js` owns a `document` keydown listener while
    it is recording a combination, and the two must not swallow each other's
    keys. The handler also returns early on `hotkeys.recordingHotkey`. Esc and
    Skip both mark it done, and a backdrop click only pulls focus back in
    (losing the tour to a stray click would be worse than one more click to
    skip it).
  - **A keydown listener on the panel is only reached while focus is inside
    it**, so being modal takes three more things, and all three are needed.
    Without them a click on a paragraph, a table or an alert moved focus to
    `<body>` (no focusable ancestor), after which Esc was dead and Tab walked
    the page *behind* the backdrop — Enter on an invisible map card changing
    the overlay. 1. `tabindex="-1"` on `#tour`, so such a click lands focus on
    the dialog. 2. `inert` on every other top-level region while the tour is
    open (`backgroundInertTargets`; the exemptions are `#tour`, `#logStatus`
    and `.grain`, and `setBackgroundInert(false)` — reached by every close path
    — undoes exactly the elements it set). 3. A `document`
    `focusin`/`focusout` guard (`shouldRecaptureFocus`) that puts focus back on
    the panel whenever it leaves; `focusout` with a null `relatedTarget` is the
    case no keydown listener could see. `focusin`, deliberately **not** a
    second `document` keydown listener, so there is nothing for the hotkey
    recorder to collide with. For the same reason the auto-detect switch is
    **never `disabled` while it waits** (a busy flag instead): disabling the
    focused element blurs it and took the trap down with it.
  - **Tab-map mode's switch is disabled with the reason on screen** unless both
    its prerequisites hold — the pure `tabMarkersSwitchState({autoDetect,
    markers, tabMarkers})`. Auto-detect off reuses **Settings' own**
    `settings.tabMarkers.needsDetect`, so the two cannot explain one state two
    ways; the markers master switch off gets its own string, and the fix is one
    step back. `checked` always reports the stored setting, disabled or not. The
    switch follows the auto-detect switch on the same step live (redrawn from
    `Detector.onStatus`, not only on entry), and it writes through the **real**
    `#tabMarkersCheck` (`mirrorCheck` → its `input` handler → `set-tab-markers`),
    so main still starts and stops the window and the loop. The map key is
    *named* live — read from the `<kbd>` `Options.renderMapKey` already fills,
    because only the browser knows what the active layout calls a virtual-key
    code — but the capture control is deliberately **not** duplicated in the
    tour.
  - **The hotkeys step lists five of the ten system actions**
    (`ONBOARDING_HOTKEY_ACTIONS`, in reading order). Clear and the four
    opacity/size steps are refinements nobody needs in the first minute and the
    full table is one click away; `toggle-map` is first because it is the one
    the step invites the user to press, and `toggle-markers` is last because the
    step above it has just explained what a marker is.
  - **The hotkeys step carries its own conflict warning** (`#tourHotkeyConflict`,
    from `onboardingConflictList`, plus the `tryIt.taken` branch of
    `onboardingTryIt`). The home-page banner is behind the backdrop, so without
    it the first thing a new user is told to press does nothing and the
    explanation is hidden under the panel giving the instruction. Same two
    catalogue strings as the banner; the list comes from `Diagnostics.conflicts`
    and re-renders on the `hotkey-conflicts` push.

See also: [i18n.md](i18n.md) (the tour's language step),
[markers-and-tab-mode.md](markers-and-tab-mode.md) (`Settings.onChange(keys)`,
the markers switches) and [detection.md](detection.md) (the auto-detect switch
the tour mirrors).
