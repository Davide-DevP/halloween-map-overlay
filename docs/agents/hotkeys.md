# Hotkeys

[← AGENTS.md](../../AGENTS.md) · **Read before** touching `src/core/hotkeys.js`,
`src/shared/hotkeys-constants.js`, `hotkeys-rules.js`,
`hotkey-migration.js`, `src/core/foreground.js`, `src/js/hotkeys.js` or
`hotkeys.json`.

The Tab-map mode key trigger is **not** a hotkey and shares nothing with this
file — see [markers-and-tab-mode.md](markers-and-tab-mode.md).

## Where a pressed hotkey goes (0.7)

- **Every accelerator is handled in the main process.** Up to 0.6 the callback
  was `win.send(def.action)` and `src/js/maps.js` did the work, so *every hotkey
  in the product* stopped at the moment the main window's renderer was not
  there. It now goes to `Hotkeys.runAction(actionId)` → `MapController.action()`
  (a system hotkey) or `MapController.select(mapKey, 'hotkey')` (a per-map
  binding), and the decisions are the pure `shared/map-state.js`. That is what
  makes the tray unload possible — `docs/SPEC-MAP-STATE.md`.
- **`registerSystemHotkeys` no longer checks for a window.** It used to return
  early with "Main window not available, cannot set system hotkeys", which is
  precisely the dependency that had to go.
- `hotkey-action` (`{action}`) is still pushed to the window, as a
  **notification only**: the setup tutorial uses it to tick off its "try it" step.
  Nothing acts on it, and it is dropped when there is no window.
- A new system action therefore needs three things, not two: an entry in
  `SYSTEM_HOTKEY_DEFS`, a default in `DEFAULT_SETTINGS`, **and** an entry in
  `ACTION_INTENTS` in `shared/map-state.js` — a test asserts the first and the
  third agree, because an action with no intent would register and then
  silently do nothing.

## Defaults and the migration onto them

- **Five of the ten actions ship with no key at all (1.0).** The owner's call:
  ten default global combinations is too many for an app whose user has never
  rebound a shortcut, and the five that went are the ones a player does not
  need mid-match — **rotate map**, **more opaque**, **more transparent**,
  **bigger**, **smaller**. They lost only their *default*: every one is still a
  full system hotkey, listed in Settings › Hotkeys as *no key*, bindable with
  **Edit**, and the stepping code and IPC are untouched. The five that keep a
  default are **show / hide map**, **toggle markers**, **next map**,
  **previous map** and **clear & re-detect**, as do the per-map
  `Ctrl+Alt+1..9`. `ONBOARDING_HOTKEY_ACTIONS` in
  `shared/onboarding-rules.js` lists exactly those five, deliberately — the
  tour must not invite a press that does nothing.
  An unbound default is the **empty string** in both
  `SYSTEM_HOTKEY_DEFS.defaultAccelerator` and `DEFAULT_SETTINGS`, never a
  missing property: `core/settings.js` back-fills on `=== undefined`, and the
  `''`-is-unbound rule is the one every consumer already follows
  (§ Unbinding). `resolveSystemAccelerator(undefined, '')` is therefore
  unbound, and *that is the whole mechanism* — nothing else in the product has
  to know which defaults exist.
- **Those five sit in a collapsed *More keys* fold under the System table**
  (`details.adv#systemHotkeyMoreFold` in `src/index.html`, a second
  `<tbody id="systemHotkeyListMore">`), per the approved mockup: a list of ten
  rows, half of them saying *no key*, reads as a broken feature rather than
  as a choice. The split is the pure `systemHotkeyRows()` in
  `shared/hotkeys-rules.js` and it has **one** rule —
  `defaultUnbound && !bound`. A key the user actually holds is never folded
  away: not a rebind, and **not an upgraded install whose rotate the
  generation-2 migration pinned back onto Ctrl+Alt+R**, which is the case that
  makes "fold by default" and "fold by current state" different answers. The
  fold is `hide()`n outright when it would be empty — an empty fold with a
  heading is worse than no fold.
  `systemHotkeyRows()` also owns `isDefault`, because unbound-is-the-default is
  a rule and not a rendering detail (§ Unbinding, rule 4); the renderer's
  `systemHotkeyRow()` only draws what it is handed. `Hotkeys.startSystemHotkeyEdit()`,
  the exported `acceleratorKbd` and `Hotkeys.recordingHotkey` are load-bearing
  for the setup tutorial — the fold changed none of them, and neither should
  anything else.
- **Every default hotkey that exists is `Ctrl+Alt+…` (0.7).** Ctrl is crouch in the game
  and Ctrl+R / Ctrl+H / Ctrl+arrows / Ctrl+1..9 / Ctrl+Shift+D are browser,
  Discord and text-field shortcuts — a *global* accelerator takes them away
  system-wide. `Ctrl+Alt+<key>` is the Windows convention for an application's
  own global shortcuts (Discord, OBS and the GPU overlays default to it) and
  nothing in the game uses it.
  The size steps carry Shift as well because they share the arrows
  with opacity. `SYSTEM_HOTKEY_DEFS`, `DEFAULT_SETTINGS` and
  `MAP_HOTKEY_PREFIX` are the three places the values live and a test asserts
  they agree. **Never hard-code a combination in a user-visible string**: the
  two FAQ answers that name one take the live accelerator as a `{param}` and
  are rendered from `Hotkeys.updateHotkeyTexts()` (renderer) rather than from
  `data-i18n-html`, so they follow a rebind and an unbind.
  **`faq.inTheWay.a` is the one to watch**: four of its five `{param}`s are
  opacity/size actions, so on a fresh install it renders *no key* four times
  in one sentence. The renderer still passes all five params — a catalogue
  string that uses fewer simply ignores them — so the fix is the wording, in
  all six catalogues, not the call site.
- **Generations are numbered, and each one runs once.**
  `hotkeyDefaultsVersion` records which generation a file has seen;
  `HOTKEY_DEFAULTS_VERSION` is what this build ships. There are two:
  **1** = the move off plain Ctrl onto Ctrl+Alt (0.7.0, below), **2** = the five
  actions above stopped shipping with a default key (1.0). A file at 0 gets both
  in one start, in that order, under **one** stamp.
  Both the tables they move onto are **frozen historical data**:
  `LEGACY_SYSTEM_DEFAULTS` (the 0.6.0 set) and `V070_SYSTEM_DEFAULTS` (the
  0.7.0 set). The second one is not a duplicate of `SYSTEM_HOTKEY_DEFS` to be
  cleaned up — five of those are now `''`, so deriving generation 1's *target*
  from the live defaults would turn the 0.6.0 move into an **unbind**, and a
  user upgrading 0.6.0 → 1.0 in one step would lose Ctrl+R instead of gaining
  Ctrl+Alt+R.
- **Generation 2 writes the previous default out explicitly.** For every install
  that is **not** fresh, each of the five that the settings file holds *nothing*
  for is given its 0.7.0 combination as a stored value. Without it the new
  back-fill would hand `''` back and an upgrade would silently take a working
  binding away — the one thing this change is not allowed to do. Three rules:
  - **A stored value is never touched**, `''` included. A rebind stays, and an
    action the user deliberately unbound stays unbound.
  - **A pin that would collide is dropped** and the action is left unbound
    (`blocked`, reason `system:<id>` or `map:<stored spelling>`) rather than
    creating a conflict that would land in the banner.
  - **A pin is not a move.** It goes in `plan.pinned`, not `plan.moved`, so
    `migrated` stays false and no "your defaults moved" notice fires: for that
    user *nothing changed*. It is logged as `hotkey-defaults-pinned`, because it
    is still a write.
  - **The pins are merged with NO `rollback`** — the one writer in the app that
    must not have it, and the reverse of every other hotkey write on this page.
    A rollback restores the *previous in-memory* value, and for a pinned key
    that value is the `''` the back-fill invented: there is no "absent" to
    restore to, because `merge()` sees the key as present. So a transient write
    failure would leave `''` in memory, the next successful `set()` of any
    unrelated key would persist it (`Settings.write()` serialises the whole
    object) **without** the stamp, and the next start would read a stored
    string, pin nothing, and stamp — five hotkeys gone, silently and
    permanently, off one failed write. Keeping the pins in memory instead costs
    nothing: this session holds the real bindings, the next successful write
    carries them together with the stamp, and a start that never gets one
    recomputes the same plan from disk (`hotkey-defaults-deferred` records it).
    The single `merge()` is therefore **load-bearing**, not just the "two writes
    at most" rule: a stamp that could reach the disk without its pins *is* the
    permanent unbind. `test/hotkey-migration.test.js` runs the real
    `Settings.merge()` over a disk that refuses a write, and keeps a test of the
    `{rollback: true}` outcome so the trap cannot be walked back into.
  **Why the fix has to be at the write, not a heuristic in the plan.** The
  tempting alternative is to have generation 2 pin *over* a stored `''` when the
  install is old and unstamped. It cannot: nothing in the file distinguishes the
  two cases afterwards. A deliberate 0.6/0.7 unbind and a rolled-back pin both
  end up as `''` sitting in a file that holds all ten `hotkey*` keys (every
  `Settings` write serialises the full back-filled object, so "the other nine
  keys are present" is true of both) with `hotkeyDefaultsVersion` still at its
  pre-run value. Even "all five are `''` at once" is only *likely* to be the
  accident — it is exactly what a user who switched all five off by hand has.
  So the invariant is the other way round: **a stored `''` is never pinned
  over**, in any state, and a test asserts that across every version/fresh
  combination. Nothing has shipped with the rollback, so there is no field
  population to recover.
  **`Settings.fileSettings` exists for exactly this.** It is the parsed file
  *before* the back-fill, and it is the only way to tell "the file holds no key
  for rotate" from "the file stores `''` for rotate" — after the back-fill both
  are `''`, and the second is a decision that must survive. When a caller does
  not supply it the plan falls back to the back-filled object, which makes every
  `''` look stored and therefore **pins nothing**: un-unbinding an action the
  user switched off is the worse of the two mistakes.
  `DEFAULT_UNBOUND_ACTIONS` is hand-written like the other two tables, and a
  test asserts it is exactly the set of actions whose live default is unbound —
  so unbinding a sixth default without adding a generation fails the suite.
- **The 0.6.0 → 0.7.0 move is a pure, once-only migration.**
  `shared/hotkey-migration.js` → `planHotkeyDefaultsMigration({storedVersion,
  freshInstall, settings, fileSettings, mapHotkeys})`, applied by
  `Hotkeys.migrateDefaultHotkeys()` from the constructor. Four rules:
  a stored value that still equals the **0.6.0** default
  (`LEGACY_SYSTEM_DEFAULTS`) moves onto the **0.7.0** one
  (`V070_SYSTEM_DEFAULTS`) — both frozen historical data, do not derive either;
  a value the user changed, or unbound (`''`), is left alone; a `hotkeys.json`
  key that is exactly Control+1..9 becomes `CommandOrControl+Alt+<n>`; and a
  move that would collide with anything (checked with the §1/§2 rules) is
  **blocked and the old value kept**. Guarded by the `hotkeyDefaultsVersion`
  setting, whose *shipped default is deliberately `0`* — the back-fill in
  `core/settings.js` would otherwise make an old file look already-migrated.
  An action added **after** 0.6.0 (`toggle-markers`, Ctrl+Alt+M) has no entry in
  `LEGACY_SYSTEM_DEFAULTS` and is therefore skipped — there is no old value to
  move, and the missing key gets the shipped default from the back-fill, whose
  safety net is the `shadowed` report below. `test/hotkey-migration.test.js`
  lists those actions by hand (`ADDED_AFTER_060`) rather than deriving them,
  for the same reason the legacy table is hand-written.
  Four more details, each of which was a bug first:
  - `stamp` is `stored < version`, **not** `!==`: a file stamped by a newer
    build (the user downgraded) must be left alone, or the downgrade writes the
    older number back and the newer build re-runs its migration on the next
    upgrade.
  - `Settings.freshInstall` (was the settings file created by this very start?)
    skips **only the system halves** — both generations. The map half always
    runs, and is not gated on a generation number either: a user whose
    `settings-app.json` was deleted or reset while `hotkeys.json` survived has
    a genuinely fresh settings file *and* nine stale Ctrl+1..9 bindings, and
    skipping everything left those on the browser's tab shortcuts forever. A
    number binding an earlier run could not move is retried, which is safe
    because the plan is recomputed from disk. Generation 1 would be a no-op on
    a fresh file anyway; generation 2 would **not** — it is what gives the five
    their old keys back, and on a genuinely new install they must stay unbound.
  - **Two writes at most.** `hotkeys.json`, then **one** `merge()` carrying up
    to nine accelerators *and* the version stamp (`{rollback: true}`). It used
    to `set()` per key — ten synchronous rewrites of `settings-app.json` during
    startup. The stamp still only rides along if the file write it also covers
    landed, so a failed run is retried next start; retrying is safe because the
    plan is recomputed from disk.
  - The user is told once through `get-hotkey-notice`, which the renderer
    collects on load (the migration happens before there is a window to toast
    at). **Two wordings**, picked by `Hotkeys.defaultsMovedNotice`:
    `hotkeys.defaultsMoved` names the live toggle-map accelerator, and is only
    used when toggle-map's own move actually happened and it is bound;
    otherwise `hotkeys.defaultsMovedPlain`, with no accelerator clause. Saying
    *"the defaults moved off plain Ctrl — Ctrl + H now shows the map"* is a
    sentence contradicting itself, and it was reachable two ways (toggle-map's
    move blocked, so it is still on the old combination; or only map bindings
    moved at all).
  Logged as `hotkey-defaults-migrated`, with a `hotkey-defaults-kept` warning
  per blocked move.
- **First-run hotkeys**: `hotkeys.json` is written once, only when absent
  (`Hotkeys.ensureDefaultMapHotkeys`), from the pure
  `buildDefaultMapHotkeys(catalog, makeId)`, which hands
  Ctrl+Alt+1..Ctrl+Alt+9 to the first nine **shipped maps in catalogue order**
  (creator, then map name).
  There is deliberately no hand-maintained map list — a new map gets its number
  from the catalogue. A user who deleted every binding keeps it deleted.

## Accelerator normalisation

- **Every accelerator comparison is normalised** (`normalizeAccelerator` in
  `shared/hotkeys-rules.js`). Up to 0.6.0 they were raw string equality, so a
  hand-edited `Ctrl+R` did **not** collide with `CommandOrControl+R`,
  `Shift+Ctrl+R` did not collide with `Ctrl+Shift+R`, and the second `register`
  simply returned `false` and was reported as "taken by another application",
  blaming Discord for our own file. `acceleratorKey()` is the comparison key
  (canonical form, falling back to the lower-cased original for a string
  Electron cannot parse, `''` for unbound) and `sameAccelerator()` the
  predicate; both are used by `systemConflict`, `findMapConflict`, the reset
  check, the shadow check, `ownAccelerators()`, the duplicate check and the
  renderer's *Reset*-enabled test. **What is stored on disk is never rewritten
  to normalise it** — compare normalised, register what is stored.

  **The rules mirror Electron's real parser, read from the pinned version's
  source, not the docs** (v40.10.6:
  `shell/browser/ui/accelerator_util.cc` → `StringToAccelerator`, and
  `shell/common/keyboard_util.cc` → `KeyboardCodeFromStr` /
  `KeyboardCodeFromCharCode` / `KeyboardCodeFromKeyIdentifier`). Five findings,
  and the first three are all counter-intuitive:
  - **Empty segments are dropped, not errors** (`base::SPLIT_WANT_NONEMPTY`
    plus `TRIM_WHITESPACE`). So `Ctrl++R` *is* `Ctrl+R`, `+R` is `R`, and
    `Ctrl++` and `+` are invalid because they leave no key token at all. The
    intuitive reading — `Ctrl++` means Ctrl plus the `+` key — is wrong.
  - **Several key tokens are legal and the last wins**: the parser's loop ORs
    modifier flags and lets anything else *overwrite* `key`. `Ctrl+A+B` is
    `Ctrl+B`, and `Ctrl+Nonsense+A` is `Ctrl+A` (an unknown token is only
    fatal when nothing valid follows). Replicated rather than rejected: a
    `hotkeys.json` holding `Ctrl+A+B` really does register Ctrl+B and really
    can collide with another entry's Ctrl+B.
  - **A key token can carry an implicit Shift.** `KeyboardCodeFromCharCode`
    returns a `shifted_char` for the shifted US punctuation and
    `StringToAccelerator` then ORs in `EF_SHIFT_DOWN`, so `Ctrl+!` *is*
    `Ctrl+Shift+1` and `Ctrl+Plus` *is* `Ctrl+Shift+=`. `SHIFTED_KEYS` is that
    table transcribed (`! @ # $ % ^ & * ( ) _ + : " < > ? { } | ~` and
    `plus`). This is reachable from the UI — recording Ctrl+Shift+1 gives
    `KeyboardEvent.key === '!'`, so the app stores
    `CommandOrControl+Shift+!`. The char→keycode map is hard-coded US *inside
    Electron*, so folding by it is exactly what Electron does rather than a
    layout guess; which physical key produces `!` is a separate question.
  - **`cmd`, `command`, `meta` and `super` are one modifier** — all four
    resolve to `VKEY_COMMAND` → `EF_COMMAND_DOWN` (the Win key on Windows), so
    the canonical token is `Super`. They are still **never** folded into
    Control: `cmdorctrl` is `VKEY_CONTROL` off macOS, so `Cmd+R` and `Ctrl+R`
    genuinely differ here. (On macOS `cmdorctrl` would join the Super group;
    `process.platform` is deliberately not consulted, because a stored value
    has to mean the same thing whatever machine reads the file.)
  - Non-ASCII is refused outright, and `Esc`/`Escape` + `Enter`/`Return` are
    one key each.

## Priority, conflicts and registration

- **Hotkey priority**: system hotkeys register first. Saving a per-map hotkey
  that matches a system one is refused (`Hotkeys.systemConflict`), and a stale
  colliding entry already in `hotkeys.json` is skipped at registration *and*
  reported in the status toast, so it is never silently inert. Two `hotkeys.json`
  entries that are *different spellings of one combination* (`Ctrl+1` and
  `CommandOrControl+1` — JSON allows that) are also skipped, reason
  `duplicate`, rather than being blamed on another application.

- **A re-bind replaces the entry it is *equivalent* to, not the one spelled
  identically.** `save-hotkeys` finds the old entry with `findMapConflict` and
  deletes it under its stored spelling before writing the new one; saving
  `Ctrl+Alt+1` over a file holding `ctrl+alt+1` would otherwise leave two
  entries for one combination, the second of which can never register and
  lands in the banner as a `duplicate`. The binding's `id` is carried over, so
  the row in the Hotkeys tab is edited rather than replaced.

- **A `hotkey*` key missing from an old settings file gets the new default with
  no conflict check** — the back-fill in `core/settings.js` cannot consult
  anything. If a per-map binding already holds it, the system hotkey wins (it
  registers first, which is the documented priority) and the map binding is
  reported as `shadowed` in the banner, the toast and `system.txt`. That is the
  existing safety net and it is tested; the migration cannot do better, because
  a missing key has no old value to keep and unbinding an action the user never
  configured would be worse than a reported shadow.

- **Hotkey dry run vs. our own bindings.** `rejectIfUnregisterable` probes an
  accelerator with `globalShortcut.register` while the app's real bindings are
  live, so probing one we already hold returns `false` and used to produce a
  bogus "taken by another application" toast. It now returns early for anything
  in `ownAccelerators()` (system hotkeys + `hotkeys.json`) — which also means a
  successful save runs `loadKeys()` once instead of three times.
- **The modifier rule is enforced on both sides.** `keyEventToAccelerator`
  refuses a modifier-less binding in the renderer, and `save-hotkeys` /
  `save-system-hotkey` re-check with the pure `hasModifier()`. With
  `nodeIntegration: true` the renderer is not a trust boundary, and Electron
  will happily register a bare `H` globally.

- **Accelerators are never taken straight from the DOM.** A
  `KeyboardEvent.key` is not an Electron accelerator name (`ArrowRight` vs
  `Right`, `" "` vs `Space`, `"+"` vs `Plus`), and `globalShortcut.register`
  **throws** on a name it cannot parse — which aborts every registration after
  it in `loadKeys`, so one bad saved binding disables all remaining hotkeys on
  every future boot. Three layers stop that, keep all three:
  1. `keyEventToAccelerator` (pure, in `hotkeys-constants.js`, unit tested)
     translates the event and refuses unmapped keys *and* modifier-less ones.
  2. `Hotkeys.rejectIfUnregisterable` dry-runs `globalShortcut.register` in a
     try/catch before anything is written to settings or `hotkeys.json`.
     When the probe *throws* it calls `loadKeys()` before returning the
     error: Electron can drop an already-registered shortcut mid-throw, and a
     full re-register is the only cheap way back to a known state (a 1.2.x
     refactor removed that call as "undocumented"; it is deliberate).
  3. `Hotkeys.safeRegister` wraps every real `register` call, so even a file
     hand-edited to garbage only loses that one binding.

- **The bind dialog's map picker groups by a `Map`, never an object literal.**
  `byCreator[creator] || []` inherits from `Object.prototype`, so a creator
  folder called `constructor`, `toString` or `__proto__` yields a *function*
  (truthy) and the following `.push` throws a `TypeError` — which does not break
  that one map, it empties the whole picker for every map. A creator is a folder
  name under `maps/` or a downloaded pack's key half, so `src/js/hotkeys.js`
  gets to assume nothing about it.

## Only while the game is in front

- **Hotkeys only while the game is in front** (`hotkeysGameOnly`, default
  **true**, Settings › Hotkeys). `core/foreground.js` classifies the foreground
  as game / own / other / unknown and calls `Hotkeys.setActive()` **only on a
  change**; the pure decision is `shouldHotkeysBeActive({gameOnly, foreground,
  suspended})` and our own windows count, so a hotkey can be tried straight
  from the Settings window. Load-bearing details:
  - The mechanism is `node-screenshots`' `Window.isFocused()` — already in the
    installed 0.2.8 typings, so **no new dependency**. Measured with plain node
    on the dev machine: `Window.all()` 0.27 ms cold / 0.06-0.09 ms warm, the
    whole `all()` + `isFocused()` scan **0.06-0.32 ms**. At 1 s that is < 0.03 %
    of one core. It is **not** the capture path: nothing is captured. Cadence
    1000 ms with a game window, 2000 ms without, and no timer at all with the
    setting off. `setTimeout` chaining, never `setInterval`.
  - Own-window focus comes from `app.on('browser-window-focus'/'blur')`, not
    from the poll, so alt-tabbing into Settings takes effect at once.
  - **Two paths fail open** (→ `unknown` → hotkeys registered): an enumeration
    that throws, and an enumeration in which *no* window reports focus. The
    second one matters — that is what a game window the enumeration does not
    return looks like (**the game has no exclusive-fullscreen mode**, so that is
    *not* the cause; a window the OS keeps out of the enumeration, or the moment
    in an alt-tab when nothing owns the foreground, produces the same answer),
    and calling it `other` would switch
    the hotkeys off while the player is in the game with nothing on screen to
    explain it. Degrading to 0.6.0 behaviour is always the safe direction here.
    The user's escape hatch is the setting, and its help text says so.
  - `loadKeys()` honours `active`: while inactive it refreshes both renderer
    tables and registers nothing, so a hotkey edit from Settings cannot re-arm
    the set behind the setting's back.
  - **Deactivating touches neither `conflicts` nor `previousConflicts` and
    sends no `hotkey-conflicts`.** Clearing them would flash the home-page
    banner off and on with every alt-tab; rebuilding them would report phantom
    conflicts for bindings that are not registered; and resetting the baseline
    would make "log only new conflicts" produce a fresh set of lines on every
    activation.
  - `rejectIfUnregisterable`'s probe works in both states —
    register+unregister does not need our own bindings to be live, and the one
    case that did (probing something we hold) is the `ownAccelerators()` early
    return.
  - The overlay window cannot steal the foreground from the game: it is
    `focusable: false` + `skipTaskbar: true`, is created once in
    `createWindow()` and is only ever `setSize`/`setBounds`/`setPosition`ed
    afterwards — never `show()`n or `focus()`ed. Keep it that way.
  - **`ForegroundWatcher.destroy()` must not report.** `destroy()` runs from
    `before-quit`, which is also the update path, and `stop()` reports "the
    setting is off, so register everything" — i.e. a full `loadKeys()`, a dozen
    `globalShortcut.register` calls, *inside the quit handler* and while the
    installer is being handed control. The `destroyed` flag is set **before**
    `stop()` and gates `report`, `tick`, `schedule`, `start`, `evaluate` and
    `syncWithSettings`. Turning the setting off still reports (that one has to
    put the hotkeys back) — the two are tested against each other.
  - `app`, `BrowserWindow` and `Window` are **injectable** (third constructor
    argument) purely so `test/foreground.test.js` can exist. `require('electron')`
    outside Electron is a path string, so without injection the class could not
    be constructed at all and the lifecycle above would be untested. The real
    app never passes them.
  - `system.txt` prints `hotkeysGameOnly`, `hotkeys registered`, `foreground`
    and `game running` at the top of `[health]` (`Diagnostics.setHotkeyState`),
    because "the hotkeys do nothing" now has a second, legitimate cause — and
    `hotkeys suspended = yes` when the bind dialog is open, which is a third.

## The bind dialog stays over Settings

- **`#addHotkeyModal` is opened from code, never with `data-bs-toggle`.**
  Bootstrap 5's modal data API hides whatever modal is already open before
  showing the target, so a `data-bs-toggle` button inside Settings closed
  Settings and dropped the user on the home page after every map binding
  (reported by the owner on 2026-09-23, present since the first release).
  `bootstrap.Modal.getOrCreateInstance(el).show()` has no such step: the
  dialog stacks over Settings, as the system-hotkey edit path always did.
  Bootstrap still removes `modal-open` from `<body>` when the dialog closes,
  so the dialog's `hidden.bs.modal` handler puts it back while Settings is
  still shown — otherwise the page behind Settings becomes scrollable.

## Suspended while the bind dialog records

- **The global shortcuts are suspended while the bind dialog records.**
  Our own windows counting as "in front" is what makes a hotkey triable from
  Settings, and it is also what made **re-recording impossible**: an
  accelerator the app already holds is taken by `RegisterHotKey` before any
  window is told about the keystroke, so pressing the current *Rotate map*
  binding inside the dialog rotated the map instead of being recorded. Nobody
  could swap two bindings or move one out of the way. (Pre-existing, but
  `hotkeysGameOnly` made it the normal case rather than the lucky one.)
  - The renderer invokes `suspend-hotkeys` on `shown.bs.modal` / `hidden.bs.modal`
    (`Hotkeys.suspendGlobalHotkeys`), and on `visibilitychange` while the modal
    is open — minimize-to-tray hides the window with the modal still "open", so
    `hidden.bs.modal` never fires.
  - It **composes** with the foreground rather than replacing it:
    `Hotkeys.foregroundAllows` (from the watcher) and `Hotkeys.suspended` meet
    in `applyRegistration()` via the pure
    `hotkeysShouldBeRegistered({foregroundAllows, suspended})`. So closing the
    dialog while the game is not in front registers nothing, and alt-tabbing
    during a recording does not un-suspend. `shouldHotkeysBeActive` takes
    `suspended` too, and a test asserts the two never disagree.
  - **It always resumes.** Three nets: `hidden.bs.modal`, the `load-hotkeys` a
    reloaded renderer sends (a fresh renderer is not recording), and a
    `SUSPEND_MAX_MS` (2 min) watchdog that lifts it and logs a warning. Holding
    *no* hotkeys with nothing on screen to explain it is the worst failure this
    feature can have.
  - `rejectIfUnregisterable`'s probe works while suspended: register+unregister
    never needed our own bindings to be live.

## Unbinding

- **A system hotkey can be unbound** (Settings › Hotkeys › *Edit* → *Remove key*
  in the bind dialog, IPC `unbind-system-hotkey`). Since 2026-09-23 the button
  lives in `#addHotkeyModal`, shown only while a system hotkey is being edited
  (`#unbindHotkeyBtn`, left of *Save*); it sends the IPC and closes the dialog,
  and the rows keep *Edit* and *Reset* only — three text actions per row were
  too many. Map-hotkey rows keep their own *Delete*: they have no default to
  reset to. The tutorial's *change* opens the same dialog, so it gets the
  button too. Unbound is the **empty string** stored under the
  action's `ACTION_TO_SETTING_KEY`, not a deleted key: `core/settings.js`
  back-fills anything `undefined` from `DEFAULT_SETTINGS`, so a deleted key
  would come back as the shipped default on the next start. `DEFAULT_SETTINGS`
  itself is unchanged — a fresh install still gets every default. Three rules
  hold it together:
  1. `stored || def.defaultAccelerator` is **wrong** and is gone. The pure
     `resolveSystemAccelerator(stored, default)` is the single resolver
     (`''` → unbound, non-string/missing → default) and both
     `Hotkeys.getSystemHotkeys()` and `updateSystemHotkeysTable()` call it, so
     the table can never claim a binding that is not registered.
  2. **An empty string is never a held accelerator.** Everything that asks
     "is this taken?" or "register these" goes through
     `Hotkeys.boundSystemHotkeys()` (the pure `boundEntries`) —
     `registerSystemHotkeys` (a literal
     `globalShortcut.register('')` throws, which `safeRegister` would turn into
     a phantom conflict-banner entry), `ownAccelerators`, `systemConflict`
     and the `systemAccelerators` set in `registerCustomHotkeys`.
  3. **Reset now checks for conflicts.** `reset-system-hotkey` used to write
     the default blind, which was already wrong after a rebind and is far
     more likely now. Unbind show/hide, give Ctrl+Alt+H to a map, press Reset →
     refused with the usual `conflictMessage` / `hotkeys.error.usedByMap`. The
     rule itself is the pure `canResetToDefault`.
  4. **For the five that ship with no key, Reset *is* an unbind** and can never
     be refused: `canResetToDefault` with an unbound default asks
     `findSystemConflict`/`findMapConflict` about `''`, both of which return
     null because nothing conflicts with nothing. The write is
     `set(key, '')`, and it gets its own `hotkey-unbound` log line — otherwise
     `setting key=hotkeyRotateMap value=` reads like a write that lost its
     value, which is the same reason the Unbind path logs one.
  The Hotkeys tab shows a muted `hotkeys.notBound` label instead of a `<kbd>`,
  the dialog disables *Remove key* when already unbound, and the row disables *Reset* only when the
  row already **is** the default. That last one needs the two-branch test in
  `systemHotkeyRows()`: `sameAccelerator` says nothing equals unbound, so
  for a default-unbound action a plain comparison leaves *Reset* enabled and
  offering a combination that does not exist. Everywhere else unbound is still
  not the default, and *Reset* stays enabled.
  Editing works from the unbound state — recording a
  combination re-binds it. `system.txt` prints `(unbound)` rather than `""`,
  which now covers five actions on a fresh install rather than none.

## Hotkeys that change a setting

- **A system hotkey that changes a setting follows `rotate-map`.** `opacity-up`
  / `opacity-down` (0.1 steps, 0.1..1.0) and `size-up` / `size-down` (25 px
  steps, 50..800) all do the same four
  things, and since 0.7 they do them in `shared/map-state.js`'s `withSetting`:
  write the setting, re-send `currentKey || lastKey` so **main** recomputes the
  window bounds, toast the new value, and — through the `map-state` push — let
  an **open Settings modal** move its slider (`Options.syncFromSettings`; the
  renderer no longer writes the setting, so it has to follow rather than lead).
  Do not resize the overlay anywhere else — only `applyMapChange` knows the
  rotated bounding box.
- **`toggle-markers` is the one that does *not* fall back to `lastKey`.** The
  three above re-send `currentKey || lastKey`, which is 0.6.0 behaviour and is
  defensible for them: they are aimed at the picture, so "make it bigger" with
  nothing on screen reasonably means "put it back and make it bigger". A marker
  switch is a switch on a *layer of* the picture, and turning markers on must
  never be the thing that draws a map the player deliberately hid — or that the
  menu clear took away when the match ended — back over their game. It is
  `withSetting(…, {restore: false})` in `shared/map-state.js`, and it is
  tested.
  All four of these ship with **no default key** since 1.0 (§ Defaults), and the
  stepping, the clamps and the IPC are unchanged by that: the only difference is
  that nothing is registered until the user binds one. Which is also why the
  overlay's opacity and size have to stay reachable from Settings › Map —
  a sentence that tells the player to "press Ctrl+Alt+Up" is now wrong for a
  fresh install, and any user-visible text that names one of these must read
  the live binding through `Hotkeys.updateHotkeyTexts()` and cope with
  `hotkeys.notBound` coming back.
  The step arithmetic is pure (`stepOpacity`/`stepSize`) because `0.6 + 0.1` is
  `0.7000000000000001` and `0.7 + 0.1` is `0.7999999999999999`: without the
  round-to-one-decimal the stored opacity drifts off the slider's own grid after
  a couple of presses. The clamps are the slider `min`/`max` in
  `src/index.html`; keep the three in step.

## The conflict banner

(The health check lives with the rest of the field diagnostics —
[diagnostics.md](diagnostics.md) — but it is a hotkey rule, so it is written out
here.)

- **The hotkey-conflict health check is a banner, not a toast.** `safeRegister`
  records every failure on `Hotkeys.conflicts`, rebuilt from scratch on each
  `loadKeys()`; the toast is suppressed while `bulkLoading` is true, because a
  reload binds a dozen accelerators at once and five toasts a session is
  something a user learns to dismiss without reading. That gate covers the
  `systemShadowsMap` toast too. The renderer both listens for
  `hotkey-conflicts` and asks with `get-hotkey-conflicts`, since registration
  happens before the window finishes loading.
- **A conflict message's action name is a nested `msg`, not a string.**
  `Hotkeys.conflictMessage` builds `hotkeys.error.boundTo` with
  `msg(def.descriptionKey)` as a parameter, because main does not know which
  language the window is in: the inner noun has to be translated at the same
  moment as the sentence around it. Same rule for every `{key, params}` main
  hands back over IPC.
- **A persisting conflict is logged once, not once per reload.** `loadKeys()`
  runs at least twice per start (`createWindow`, then the renderer's
  `load-hotkeys`) and again after every hotkey edit. `noteConflict` skips the
  log line when the accelerator was already failing at the end of the previous
  load (`previousConflicts`), so a Discord user gets N lines on the first load
  and nothing after — a *new* conflict is still news. The banner is rebuilt
  from `conflicts` regardless.

See also: [settings-and-onboarding.md](settings-and-onboarding.md) for the
failed-write reporting and `{rollback: true}` that every hotkey writer uses,
and [map-packs.md](map-packs.md) for the next-free-`Ctrl+Alt+N` a downloaded
map is offered.
