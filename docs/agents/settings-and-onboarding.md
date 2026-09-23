# Settings and the first-run setup tutorial

[← AGENTS.md](../../AGENTS.md) · **Read before** touching `src/core/settings.js`,
`src/shared/settings-defaults.js`, `src/shared/map-placement.js`,
`src/js/options.js`, `src/js/settings.js`, `src/js/onboarding.js` or
`src/shared/onboarding-rules.js`.

## The standing UX rule (owner, non-negotiable)

The app is for an **average player who knows nothing about PCs, performance or
internals**. That rule decided the whole 1.0 shape of this window, so every
change here is measured against it:

- **The label is what the player gets, in their words, never the mechanism.**
  "Visibility", not "Opacity". "Keep it running near the clock", not
  "Minimize to tray". No *process*, *polling*, *GPU*, *RAM*, *foreground*,
  *overlay window*, *accelerator* or *tray* in anything user-visible.
- **Help is one short sentence, two at most.** A switch that needs a paragraph
  belongs under *Something not working?* — or should not exist.
- **Do not ask the user what the app can decide.** Two settings were removed in
  1.0 for exactly that reason (below).
- **Technical honesty lives in the FAQ**, reached by a short *What does the app
  read?* link, not in the control's help text. The long privacy explanation of
  the map key moved out of Settings into `faq.reads.a` in 1.0 for that reason;
  the FAQ answer leads with plain words and keeps the technical sentence for
  last.

1.0 replaced 21 switches on two tabs with **one choice, three switches and five
chips** in the open, **six** switches behind four closed *Something not working?*
/ *Other adjustments* folds, and **two removed outright**. Do not add a switch in
the open without taking one away.

## The Settings window is not guaranteed to exist

Since 0.7 the main window is **destroyed** while the app sits in the tray
(`docs/SPEC-MAP-STATE.md` §5; always on since 1.0 — see *Two settings the app
decides* below). Two consequences for anything in this document:

- **Nothing in Settings or the tutorial may be the owner of a
  behaviour.** The four settings a hotkey can change (`rotation`, `opacity`,
  `size`, `markers`) are written by `shared/map-state.js` in main; an open
  Settings modal *follows* through `Options.syncFromSettings()` on a `map-state`
  push. It is not the writer any more, and it must not become one again.
- **Work with state in the renderer reports itself busy** so the window is not
  taken away underneath it: `setBusy(reason, on)` from `src/js/busy.js`, called
  for the Settings modal, the setup tutorial, a diagnostic report and a custom-map
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
  covers `checkForUpdates`, `checkForMapPacks`, `markers` and its
  four `markerLayer*` keys, `markerLegend`, `tabMarkersInstant` and
  `hotkeysGameOnly`. The pure `isLayerEnabled` applies
  the same rule to the marker layers on the other side.
- **A setting written from two places must be written as the same *type*.**
  `size`, `opacity` and `rotation` are numbers: `shared/map-state.js` writes them
  as numbers when the hotkeys move them, and a range input hands back a
  **string**, so `src/js/options.js` goes through `parseInt`/`parseFloat`. A file
  holding `"275"` one day and `275` the next makes `stepSize`'s input, the
  diagnostic report and any future comparison depend on which side wrote last.
- **`onboardingPending`'s shipped default must stay `false`.** The back-fill puts
  the key into an *existing* settings file too, so an upgrade is never
  interrupted by the "this user has never been greeted" marker; only
  `core/settings.js` sets it, once, on the start that creates the file.
  **`tourSeenVersion`'s shipped default must stay `0`**, i.e. behind
  `TOUR_VERSION`, and here the back-fill reaching existing files is exactly the
  point: it is what shows an upgrading install the rewritten tutorial once. See
  the tutorial section below.
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
  capture. It is no longer a switch of its own on the Map tab: the *Recognise
  the map by itself* switch there and the home page's are the same setting, and
  the two game's-map placements lock it on. [detection.md](detection.md).
- **`tabMarkers` ships off** and needs `mapDetection`; `tabMarkerKey` is a
  **Windows virtual-key code** (9 = Tab), never an accelerator and never
  registered, and `tabMarkerKeyLabel` stores what the *browser* called that key
  because a virtual-key code cannot be turned back into a name on anything but a
  US layout. `tabMarkerPad` (1.1) is the map key's optional **second input**,
  a controller button as a **standard gamepad index** from
  `shared/pad-codes.js` (1.1.x stored a different button bit; `resolveMapPad`
  migrates it), `null` = none — the only binding with two inputs, and never a hotkey
  ([markers-and-tab-mode.md § The controller button](markers-and-tab-mode.md#the-controller-button)).
  `tabMarkerPadId` (2026-09-23) is the `Gamepad.id` of the controller that
  button was pressed on in *Choose button…*, `null` = none chosen (any pad is
  read). Main stores it from the recording itself, never from the renderer, and
  clears it with the button; it only matters with two or more pads connected.
  It names a device, so it never reaches a log or a report verbatim: `(set)` /
  `(none)` ([diagnostics.md](diagnostics.md), "a device id").
  `markerTrigger` picks `auto` (the key trigger, falling back to
  polling) or `polling`. `markerOpacity` is separate from the overlay's own
  `opacity`: the map is a backdrop, the markers are the thing being read.
  [markers-and-tab-mode.md](markers-and-tab-mode.md) and
  `docs/SPEC-MARKERS.md` own the rest, including `tabMarkersInstant`'s
  second-press rule and `tabHidesMinimap`.
- **`hardwareAcceleration` ships off** — a measured decision, with the numbers in
  [memory.md](memory.md). A change needs a restart
  (`app.disableHardwareAcceleration()` is ignored once the app is ready), which
  is why `useHardwareAcceleration` treats any non-boolean as the shipped
  default: a hand-edited file must not put the app in a third state.
- **`language` is `'system'` or a catalogue code**, resolved once in main against
  `app.getLocale()` — [i18n.md](i18n.md). `mapLabel` is the `MAP_LABEL_MODES`
  enum (`auto`/`always`/`never`), normalised by `mapLabelMode` so a file
  hand-edited to nonsense cannot make the overlay do something undefined.

## Where do you want to see the map?

The first thing on the Map tab, and step 2 of the tutorial, is **one radio group
of three cards** — corner / on the game's own map (tagged *in testing*) / both —
where 0.7 had three independent switches (`tabMarkers`, `tabHidesMinimap` and
*Auto-detect map*) that let a user tick a combination which could not run.

- **It is not a setting.** The pure `shared/map-placement.js` reads it out of
  the pair it replaced and writes it back: `corner` = `tabMarkers: false`,
  `tab` = `{tabMarkers: true, tabHidesMinimap: true}`, `both` =
  `{tabMarkers: true, tabHidesMinimap: false}`. Adding a stored `mapPlacement`
  would need a migration and would let the two disagree; `placementFromSettings`
  / `settingsForPlacement` round-trip instead, and a test drives all four
  stored combinations through both directions. `tabMarkers: false` is always
  `corner`, whatever `tabHidesMinimap` holds — that file belongs to someone who
  tried the experimental mode and went back, not to someone with no map at all.
- **`settingsForPlacement` always names both keys**, so switching back cannot
  leave the other one behind.
- **The order of the writes is load-bearing** and `Options.applyPlacement` owns
  it: detection first (`core/tab-mode.js` refuses to start without it, so
  writing `tabMarkers` while the loop is off does nothing), then
  `tabHidesMinimap` through the generic setter (`TabMode` picks it up from
  `settings.onChange`), then `set-tab-markers` — which is the handler that
  actually starts the second window and the loop. **Nothing is written until the
  loop is really running**, so a detector that refuses just leaves the stored
  choice alone and `syncPlacement()` puts the cards back on it, with a toast
  saying why. It is also called **only from a user action**.
  Two quick clicks: `applyPlacement` takes a `placementSeq` ticket and queues
  `writePlacement` on `placementChain`, so the two writes of one card can never
  interleave with another card's, and a queued call whose ticket has moved on
  drops out at the top. The staleness checks all sit **before the first write** —
  once `tabHidesMinimap` has been written the pair is finished to the end,
  because half of it stored is half a choice, and `tabMarkers` without its
  partner is a mode the user did not pick.
- **One source of truth.** `Options.placement()` and `Onboarding.placement()`
  both derive from the stored settings on every read — nothing caches it — and
  `syncPlacement()` sets the checked radio from that. A cached copy let Settings
  show `corner` selected over the tab-mode blocks after a change made in the
  tutorial, and clicking the already-checked card then fired no `change` at all.
- **The *Recognise the map automatically* switch is one setting in two controls**:
  the Map tab's `#autoDetectCheck` (which the tutorial's layers step borrows —
  it is the same element) and the home page's. Both go
  through `Detector.setEnabled`, and both draw from the pure
  `autoDetectSwitchState(placement, running)`, which has **three** states:
  - `corner` → an ordinary switch.
  - `tab`/`both` **and the loop running** → on and `disabled`, with the reason
    on screen. The home page's is the one that could silently break the
    placement, so it is locked the same way (`Detector.setPlacementLock`, with
    `#mapDetectionLocked` carrying the one-line reason) — *not* reverted to
    `corner` behind the user's back from a different page.
  - `tab`/`both` **and the loop off** → `blocked`: off, still usable, with its
    own reason and a *Switch it on* button. 0.7 could store
    `{tabMarkers: true, mapDetection: false}`, and **nothing may start a screen
    capture without a click** (AGENTS.md rule 1, and the README's "nothing is
    written unless you change something"). So this state *reflects* reality and
    invites a press; it never repairs itself by writing. `shouldStartDetection`
    and `blocked` are asserted to be the same predicate.

  `checked` reports the **loop**, never the setting, so a start main refused
  cannot leave a ticked box.
- **`placementSections` decides what is on screen**: `tab` hides the corner
  block (there is no corner map), `corner` hides the game's-map key and the
  *Something not working?* fold that only that mode needs. A test asserts every
  choice leaves at least one map somewhere.
- **The corner block has one button where 1.0 found two.** *Move it with the
  mouse…* is the old *Overlay draggable* switch and *Set position* merged: it
  writes `draggable: true` **and** lets the overlay catch the mouse; *Leave it
  there* only gives the clicks back, so the hand-placed position stays; and
  `#glideReset` is the one way back to the preset — it ends the drag, writes
  `draggable: false` and snaps both glide sliders to the corner.
  `Options.applyDragState` disables the corner preset, the two glide sliders and
  the monitor picker while it is on and shows `#movedByHandNote`, because those
  three cannot mean anything over a window the user placed by hand. The
  tutorial's step 3 borrows the pickers but not that note, so it carries its
  own (`#tourCornerLocked`, shown from the real picker's `disabled`): a
  greyed-out control with no explanation is reachable every time the tutorial
  is reopened later.

## What to show

The four marker layers and the legend are **chips**, not five switches with a
paragraph each. Two consequences:

- **The master `markers` switch is not a control on this tab any more.**
  Ctrl+Alt+M (`toggle-markers`) is what flips it, in main, and it must keep
  working. The one state the chips cannot explain — every chip on, nothing on
  screen — is called out instead: `markerMasterNotice(markers)` shows a note and
  a *Show the points* button above the chips whenever `markers === false`.
  `Options.syncFromSettings()` re-renders it on the `map-state` push, which is
  how the hotkey's effect reaches an open modal.
- **"Points", not "markers", in every user-visible string.** A deliberate
  simplification, one word per language, recorded in
  [i18n.md](i18n.md) § Per-language glossary. `markers.layer.*` (the full
  "… — possible location") still belongs to the legend and the overlay;
  `markers.chip.*` is the one-word form.

## Two settings the app decides

`unloadWindowInTray` and `hideInMenu` were removed in 1.0 — not defaulted, not
hidden: **removed from `DEFAULT_SETTINGS`, so nothing back-fills them and
nothing reads them.** A leftover `false` in an existing file is ignored rather
than migrated.

- **The tray unload is always on.** `shouldUnloadMainWindow` has no `setting`
  input and `KEEP_REASONS` has no `setting-off`; every other refusal is intact.
  Nobody has a reason to prefer ~25 MB held for the life of the session over a
  window that takes a moment to reopen, and the switch needed a paragraph about
  memory to explain itself. `MainWindow.unloadState()` keeps the **state** lines
  the diagnostic report prints (`main window = loaded|unloaded`, `main window
  held by = …`) and no longer carries a `setting`, so nothing can print "off"
  about something that is always on. [memory.md](memory.md).
- **The menu clear is always on.** `shouldWatchMenu(shownKey)` takes the key
  alone. A map from the last match still sitting on the overlay in the main menu
  is a bug, not a preference. [detection.md](detection.md).

## The first-run setup tutorial

The **setup tutorial** (`#tour`, `src/js/onboarding.js`, decisions in the pure
`shared/onboarding-rules.js`) was a five-step *tour* in 0.7 and is a **tutorial**
since 1.0: the owner's rule is that it must let a user configure everything
without ever opening Settings. Six steps — language, where the map goes, set it
up, what to show, hotkeys, done — in a panel inside the main window, **not** a
second `BrowserWindow`. `ONBOARDING_STEPS` is the list and `src/index.html`
carries one `[data-tour-step]` section per id; the step indicator's total is
derived, so adding one is a one-line change here plus a section there.

Why that order: step 2's choice decides what step 3 even shows
(`placementSections`), and step 4 comes before step 5 so the *Show / hide the
points* row lands on something just explained. There is no step of its own for
the experimental mode — it is one of the three cards on step 2.

Rules that hold it together:

- **When it opens: `shouldShowOnboarding({onboardingPending, tourSeenVersion})`.**
  Two reasons, and `onboardingDone` is deliberately **not** one of them any more.
  - `onboardingPending` is "this user has never been greeted".
    `core/settings.js` sets it once, on the start that creates the settings
    file. `freshInstall` on its own was true for exactly one session, so a first
    run abandoned before Skip or Finish — a quit, a crash, an update restart —
    looked like an existing install afterwards and was never greeted. The marker
    survives that.
  - `tourSeenVersion < TOUR_VERSION` is the once-per-version rule.
    `TOUR_VERSION` is 2 (the 1.0 rewrite); `tourSeenVersion` ships `0`, and here
    the back-fill reaching **existing** files is the point — that is how an
    install which already finished the 0.7 tour is shown the new one once. Bump
    `TOUR_VERSION` only when the tutorial changes enough that everybody should
    see it again.
  - **A missing or hand-edited marker reads as 0** (`seenVersion`), i.e. "show it
    once". The 0.7 rule defaulted the other way; with a version marker, "I
    cannot tell" costing one tutorial is better than suppressing it for ever.
  - Both markers are stamped by the **one** `set-onboarding-done` handler, on
    Finish **and** on Skip: `onboardingDone: true`, `onboardingPending: false`,
    `tourSeenVersion: TOUR_VERSION`. It has its own handler (beside
    `get-onboarding-state`) because `set-setting` answers with the settings
    object and cannot report a failed write. On a failure the tutorial is still
    marked done **in memory**: the throttled `settings.error.writeFailed` toast
    has already said so, and a panel that reopens on top of a user who dismissed
    it would be worse. It can only come back on a later start if
    `settings-app.json` could not be written at all — the one state in which
    nothing else the user changes survives a restart either.
  - Reopened from **Settings › General › See the setup guide again**, which
    closes the Settings modal first — one focus trap at a time.
- **No parallel state, and that is what makes "pressing Next six times changes
  nothing" true.** Settings › Map (and General, for the language and the
  news-check switch) holds the **only copy** of every control the tutorial
  shows. Each tutorial step has `<template data-borrow="<id>">` slots in
  `src/index.html`; `Onboarding.borrowControls()` on `open()` moves each named
  element into its slot (leaving a comment node where it came from) and
  `returnControls()` on `close()` puts it back. So there is one element, one
  handler and one write path per setting: `src/js/options.js` does the saving,
  the overlay refresh, the glide snap, the placement write order
  (`applyPlacement`) and the map-key recorder. Borrowing is safe only because
  `open()` closes the Settings modal first — no control is ever needed in two
  places at once. The tutorial follows the writes rather than making them:
  `Options.onPlacementApplied(callback)` re-renders it after a card's writes
  have landed, and it holds *no* placement of its own —
  `Onboarding.placement()` re-reads it from the settings file every time.
  (Up to 1.2.0 these were *mirrors* — `#tour*` copies kept in step by
  `mirrorCheck`/`syncMirror` and a second `attachMapKeyRecorder('#tourMapKeyBtn')`
  call; the 2026-09-23 refactor, commit 4713636, replaced them with borrowing.)
- **Step 4 carries the same markers notice as Settings** (`markerMasterNotice`,
  through the real `#markersShowBtn`), because `toggle-markers` can be unbound —
  and then the tutorial would show five ticked chips over an empty overlay with
  no way back.
- **Step 3 borrows `Options.startPreview()`**, so the real overlay shows the same
  sample map as the Map tab — but only while that step is actually showing the
  corner half (`placementSections(...).corner`). With `tab` chosen there is no
  corner map to preview.
- **Step 5 opens the real bind dialog.** Each row's *change* calls
  `Hotkeys.startSystemHotkeyEdit(actionId)`, so the suspension, the conflict
  check, the rollback and the toast are all the ones that already exist — there
  is no second key recorder. Three consequences, all needed: `#addHotkeyModal`
  and `#hotkeyToast` are in `INERT_EXEMPT_IDS` (and the toast was moved to be a
  direct child of `<body>` for it, which is also why it now needs a `z-index` of
  its own); the tutorial records the dialog on **`show.bs.modal`, not `shown`** —
  Bootstrap moves focus into the dialog *before* `shown`, so a guard armed there
  still pulled it back to `#tour` and Esc reached neither; and `onKeyDown`
  returns early while one is open, so Esc belongs to the dialog.
  `restoreDialogFocus()` then puts the keyboard back on the row that opened it,
  re-found by action id because `renderHotkeys` rebuilds the rows. `#faqModal` is
  exempt for the same reason (*What does the app read?*).
- **What is open is a `Set` (`openDialogs`), not a flag.** Two dialogs must not
  be able to clear each other's state, and a `show` another listener
  `preventDefault()`s emits *nothing* afterwards — so the id is dropped again on
  the next animation frame unless the element really took `.show`, and on
  `hide` as well as `hidden` (focus leaves during the fade, and the guard has to
  be allowed to catch it). A flag that sticks would leave the panel unable to
  take focus back at all.
- **The dialogs need a layer of their own.** `#tour` sits at `--hmo-z-tour`
  (1085) and Bootstrap's `.modal` / `.modal-backdrop` at 1055 / 1050, and all of
  them are children of `<body>` — so without help the bind dialog and the FAQ
  open **under** the panel: invisible, while the key recorder swallows every key
  and the global hotkeys are suspended. `body.is-touring` (set in `open()`,
  removed in `close()`) lifts them to `--hmo-z-tour-backdrop` (1086) and
  `--hmo-z-tour-modal` (1088), still below `--hmo-z-toast`. Two details that
  look like tidying and are not:
  - the rule names `#addHotkeyModal` and `#faqModal` **one by one**, never
    `.modal`. Reopening the tutorial from Settings otherwise raised the *fading*
    Settings modal to 1088 — on top of the panel for the length of its 0.3 s
    transition.
  - `open()` **awaits** `closeSettingsModal()` (on `hidden.bs.modal`, with a
    600 ms deadline so a transition that never finishes cannot block the
    tutorial) before adding `is-touring`, so the two are never up together.
    That is also what makes the generic backdrop rule safe.
- **`returnFocus` has to be given back to something visible.**
  `Onboarding.focusable()` checks `offsetParent`/`getClientRects()` as well as
  `document.body.contains()`: whatever opened the tutorial from Settings is
  *inside the modal the tutorial just closed*, and focusing a hidden element
  puts focus on `<body>`, after which Tab restarts at the top of the page. The
  fallback is `#settingsLink` in the nav — the menu item that leads back to
  where the user was.
- **The hotkeys step lists exactly the actions that ship with a key**
  (`ONBOARDING_HOTKEY_ACTIONS`, in reading order), and a test derives that set
  from `SYSTEM_HOTKEY_DEFS` rather than repeating it: the step must not teach a
  combination the app ships without. `toggle-map` is first because it is the one
  the step invites the user to press.
- **The line under that table names the *real* map keys** —
  `onboardingMapHotkeys(hotkeys.json)` hands back up to three of them (in file
  order, de-duplicated with `sameAccelerator`, rows with no map skipped) and
  `#tourHotkeyMaps` is rendered from JS with `acceleratorKbd`, like
  `#tourTryIt`. "Each map has its own number" was only true of a fresh install.
  With none bound the step swaps to `onboarding.hotkeys.maps.none`, which takes
  no parameter, rather than printing an empty chip. The map keys arrive on the
  `hotkey-updated` push, so the step redraws on it as well as on
  `hotkey-conflicts`.
- **The hotkeys step carries its own conflict warning** (`#tourHotkeyConflict`,
  from `onboardingConflictList`, plus the `tryIt.taken` branch of
  `onboardingTryIt`). The home-page banner is behind the backdrop, so without it
  the first thing a new user is told to press does nothing and the explanation is
  hidden under the panel giving the instruction. Same two catalogue strings as
  the banner; the list comes from `Diagnostics.conflicts` and re-renders on the
  `hotkey-conflicts` push.
- **Step 6 recaps the choice** with the pure `placementRecap(placement)`, which
  hands back a `labelKey` per placement — one literal key per branch, because
  `test/i18n.test.js` finds a key held as data by the `…Key: '<dotted>'` shape.
- **Ordering against the rest of the first minute**: it opens last, from the
  `#loadingOverlay` slide-up callback, after the crash notice, the
  hotkey-conflict banner, the update banner and `get-hotkey-notice` have been
  collected, so none of them lands on top of it. `--hmo-z-tour` (1085) puts it
  above the Bootstrap modals and deliberately **below** `--hmo-z-toast`, so the
  write-failure warning stays readable.
- **Every key it handles is caught on the `#tour` element, never on `document`**
  — `src/js/hotkeys.js` owns a `document` keydown listener while it is recording
  a combination, and the two must not swallow each other's keys. The handler
  returns early on `hotkeys.recordingHotkey`, on `options.recordingMapKey` (the
  map-key recorder is armed on a button *inside* the panel, and Tab is a
  perfectly ordinary key to record) and on `dialogOpen`. Esc and Skip both mark
  it done, and a backdrop click only pulls focus back in (losing the tutorial to
  a stray click would be worse than one more click to skip it).
- **A keydown listener on the panel is only reached while focus is inside it**,
  so being modal takes three more things, and all three are needed. Without them
  a click on a paragraph, a table or an alert moved focus to `<body>` (no
  focusable ancestor), after which Esc was dead and Tab walked the page *behind*
  the backdrop — Enter on an invisible map card changing the overlay.
  1. `tabindex="-1"` on `#tour`, so such a click lands focus on the dialog.
  2. `inert` on every other top-level region while it is open
  (`backgroundInertTargets`; the exemptions are `#tour`, `#logStatus`,
  `#addHotkeyModal`, `#hotkeyToast`, `#faqModal` and `.grain`, and
  `setBackgroundInert(false)` — reached by every close path — undoes exactly the
  elements it set). 3. A `document` `focusin`/`focusout` guard
  (`shouldRecaptureFocus`) that puts focus back on the panel whenever it leaves;
  `focusout` with a null `relatedTarget` is the case no keydown listener could
  see. `focusin`, deliberately **not** a second `document` keydown listener, so
  there is nothing for the hotkey recorder to collide with. For the same reason
  the auto-recognise switch is **never `disabled` while it waits**
  (`Options.detectBusy` drops a re-entrant click instead): disabling the
  focused element blurs it and took the trap down with it. When the placement
  lock *does* have to disable it, `Options.syncPlacement()` first moves focus
  to the enclosing `#tour` or `.modal`.

See also: [i18n.md](i18n.md) (the tutorial's language step),
[markers-and-tab-mode.md](markers-and-tab-mode.md) (`Settings.onChange(keys)`,
the marker settings) and [detection.md](detection.md) (the auto-recognise switch
the tutorial borrows).
