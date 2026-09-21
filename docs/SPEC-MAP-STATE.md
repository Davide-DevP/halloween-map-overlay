# SPEC-MAP-STATE — the map state moves to main, and the main window becomes disposable

Status: implemented in the 0.7 working tree.
Read with [`docs/agents/architecture.md`](agents/architecture.md),
[`overlay-windows.md`](agents/overlay-windows.md),
[`hotkeys.md`](agents/hotkeys.md), [`detection.md`](agents/detection.md) and
[`memory.md`](agents/memory.md).

## 1. Why

`docs/MEMORY-REPORT-2.md` §3.3 measured ~32 MB of private working set — about a
quarter of the app's RAM in the in-match state — sitting in the main window's
renderer while that window is hidden in the tray. It was rejected there, not
because the memory is not real, but because **the in-match feature set lived in
that renderer**: `src/js/maps.js` owned `currentKey`/`lastKey`, every system and
per-map hotkey handler, `show-map-command` (the detector's only route to the
overlay), `menu-hide-map`, the `map-detector-shown` report the menu clear is
gated on, and the markers toggle. Destroying that renderer took the whole match
with it.

This spec is the deliberate version of that work, in two halves that ship
together but are independently useful:

1. **The match-time logic moves into the main process.** A pure reducer
   (`src/shared/map-state.js`) holds every decision; a thin controller
   (`src/core/map-controller.js`) performs the effects. The main window's
   renderer becomes a **view**: it asks main for the state on load, renders it,
   sends intents, and receives pushes.
2. **The main window becomes destroyable while it is hidden in the tray**
   (`unloadWindowInTray`, default **true**; the setting was **removed in 1.0** and
   the unload is always on — docs/agents/settings-and-onboarding.md § Two
   settings the app decides), because nothing depends on it any
   more.

A side effect that is worth as much as the memory: the overlay's independence
from the main window's renderer gets **stronger**. Today a renderer crash loses
`currentKey`/`lastKey` (the reloaded renderer starts at `""` while main still
believes the old map is up — VERIFICATION-6 finding 4, patched by an extra
`map-detector-shown` on load). After this change the state is in main, so a
renderer crash loses *nothing*: the overlay keeps its map, the hotkeys keep
working through the reload, and the menu clear stays correctly gated.

## 2. Inventory — what the main-window renderer owned, and who owns it now

### 2.1 Channels the renderer *listened* on (`ipcRenderer.on`)

| Channel | Sent by | Was | Now |
|---|---|---|---|
| `show-map-command` | detector tick, CLI second instance | `src/js/maps.js` matched the key against its catalogue copy, decided with `shouldApplyDetected`, sent `map-change` | **Gone.** `MapDetector` calls `MapController.detected(key)`; `index.js`'s `second-instance` calls `MapController.select(key, 'cli')`. Both work with no window. |
| `hotkey-pressed` (map hotkeys) | `core/hotkeys.js` | renderer resolved the map key and sent `map-change` | **Gone.** `registerCustomHotkeys` calls `MapController.select(mapKey, 'hotkey')`. |
| `toggle-map` | `core/hotkeys.js` | renderer toggled `currentKey`/`lastKey` | **Gone as a command.** `MapController.action('toggle-map')`. A *notification* `hotkey-action` (`{action}`) is still pushed to the window, for the welcome tour's "try it" acknowledgement only. |
| `rotate-map`, `next-map`, `prev-map`, `clear-map`, `toggle-markers`, `opacity-up/down`, `size-up/down` | `core/hotkeys.js` | renderer: wrote the setting, synced the slider, re-sent the map, toasted | **Gone.** `MapController.action(<id>)`. The slider sync is now a `map-state` push the open Settings modal reacts to; the toast is main's. |
| `menu-hide-map` | detector's menu clear | renderer hid the map if one was showing | **Gone.** `MapController.menuHide()`. |
| `map-packs-updated` | `core/map-packs.js` | renderer refreshed its catalogue copy | **Unchanged** (it is a view concern). The controller also refreshes its own catalogue snapshot. |
| `map-detector-status` | detector | home-page switch + Settings | **Unchanged.** Dropped while unloaded; the renderer asks with `map-detector-status` on load. |
| `hotkey-updated`, `system-hotkeys-updated`, `hotkey-conflicts` | `core/hotkeys.js` | tables + banner | **Unchanged.** Dropped while unloaded; the renderer asks on load. |
| `update-message`, `update-ready`, `update-installing`, `update-install-result`, `update-check-state` | `MainWindow` | toasts, banner, updating view | **Unchanged**, plus the drop/queue policy in §6. |
| `language-changed` | `core/language.js` | re-render | **Unchanged** (the overlay and OBS copies are unaffected). |

### 2.2 Channels the renderer *sent* (`ipcRenderer.send` / `invoke`)

| Channel | Was | Now |
|---|---|---|
| `map-change` | **the** way a map reached the overlay | Kept, but only for the **settings preview** (`{preview: true}` + raw base64 rendered in the renderer's canvas). Everything else goes through `MapController` → `MainWindow.applyMapChange()`, which is the same function the IPC handler calls. |
| `map-detector-shown` | the renderer told the detector what the overlay shows | **Gone.** `MapController` calls `MapDetector.noteShown()` directly. The 0.3.3 rule is unchanged — the menu clear is still gated on *what the overlay actually shows*, whoever put it there — it is simply no longer a round trip through a process that can die. |
| `map-detector-applied` | the renderer told the detector what it did with a `show-map-command` | **Gone.** `MapController` calls `MapDetector.noteApplied()`. |
| `map-detector-reset` | `clear-map` told the detector to forget | **Gone.** `MapController` calls `MapDetector.resetLastDetected()`. |
| `obs-open` | open the OBS window | **Unchanged**, but the "re-send the current map afterwards" half is now an intent (`{type: 'refresh'}`). |
| everything else (`set-setting`, `save-hotkeys`, `create-diagnostic-report`, …) | | **Unchanged** — all of it is a user action taken *in* the window, so the window is alive by definition. |

### 2.3 New channels

| Channel | Direction | Purpose |
|---|---|---|
| `get-map-state` (`invoke`) | renderer → main | The view's load-time fetch: `{currentKey, lastKey, previewActive}`. |
| `map-intent` (`send`) | renderer → main | One channel for every user intent from the view: `{type, …}` (see §3.2). |
| `map-state` (`on`) | main → renderer | The push after every state change: `{currentKey, lastKey, previewActive, source}`. |
| `hotkey-action` (`on`) | main → renderer | Notification only (`{action}`); the welcome tour listens for `toggle-map`. |
| `refresh-preview` (`on`) | main → renderer | "A map was applied while your preview is up — re-send the sample image." Replaces the renderer-internal `options.sendPreview()` call inside `sendMap`. |
| `window-busy` (`send`) | renderer → main | `{reason, on}` — the view telling main it must not be torn down right now (§5.2). |
| `update-banner-shown` (`send`) | renderer → main | The update banner has actually been in front of a person: the window has **focus**, not merely `document.visibilityState === 'visible'` (a window built hidden paints, and therefore reports itself visible, with Electron's default `paintWhenInitiallyHidden`). |
| `update-banner-dismissed` (`send`) | renderer → main | "Later" was pressed. Kept in main, because the window it was pressed in is destroyed in the tray and a flag in the renderer put the banner back on every reopen. `get-pending-update` now answers `{version, dismissed}`. |

## 3. The pure reducer — `src/shared/map-state.js`

Same shape as `shared/tab-mode-rules.js` / `core/tab-mode.js` and
`shared/hotkeys-rules.js` / `core/hotkeys.js`: **state + intent → new state +
effects**. It imports `map-catalog` (pure) and `hotkeys-constants` (pure) and
nothing else.

### 3.1 State

```js
{currentKey: '',    // what the overlay shows; '' = hidden
 lastKey: '',       // last map put up, so toggle-map can restore it
 previewActive: false}
```

### 3.2 Intents

`select` (a click, a per-map hotkey, the CLI), `detected` (the detector),
`toggle`, `next`, `prev`, `clear`, `menu-hide`, `hide`, `rotate`, `opacity`,
`size`, `toggle-markers`, `refresh`, `preview-start`, `preview-stop`.

`catalog-changed` exists as a named case that does **nothing**, and has no
caller. A map pack landing or a custom image being deleted does not change what
is on the overlay, and the controller holds no catalogue snapshot to refresh —
it asks `MapLibrary` on every dispatch, and `MapLibrary` owns the cache. The
stale-key problem is handled where it matters instead (§3.5). The case is kept
so the next reader does not have to rediscover that answer.

### 3.3 Effects

`apply` (put a key — or `''` — on the overlay, with `source` and an optional
`mapLabel`), `setting`, `toast`, `detector-reset`, `detector-applied`,
`refresh-preview`, `missing` (log only). The controller turns each into a call;
nothing else in the app decides anything about the map.

`apply` is also what tells the detector what is on screen: the controller calls
`MapDetector.noteShown()` after every `apply` that is not a preview, exactly as
`Maps.sendMap` used to send `map-detector-shown` on every send. `noteShown`
already collapses repeats.

**`apply` can fail, and the state follows the overlay rather than leading it.**
`MainWindow.applyMapChange` is async (it reads a PNG) and answers a boolean.
`false` means the map never reached the overlay — the file was deleted or
locked under the app, the payload was not an image, or a **later** call
overtook this one (`mapChangeSeq`, so a held `next-map` cannot leave the
overlay one map behind). On a `false` the controller puts the state back to
what it was before that dispatch and re-reports `noteShown`, because a
`currentKey` naming a map the player cannot see is what makes the gallery
highlight, `toggle-map` and the detector's menu clear all disagree with the
screen. The rollback is skipped when something has already been applied since,
so it can never fight a map the player has just put up.

### 3.4 Behaviour that is deliberately identical

- **A manual pick does not stop detection.** Main still sends every accepted
  match (throttled per key in the detector) and the *decision* — "is this map
  already on the overlay?" — is still `shouldApplyDetected(currentKey, key)`.
  It has simply moved from the renderer into `map-state.js`. The
  `lastDetected` comparison that made a manual pick permanent in 0.3.0 is still
  **not** what gates the send; the long comment in `map-detector.js` stands.
- **`map-detector-shown` semantics.** The menu clear is gated on what the
  overlay shows, not on what the detector recognised.
- **`map-change` source attribution** (`click` / `hotkey` / `cli` / `detector` /
  `settings` / `preview` / `hide`) and the collapse of identical consecutive
  `map-change` log lines (`MainWindow.lastLoggedMap`) are untouched.
- **Custom maps**: the key is a name the user typed. Blob/object-URL handling
  stays in the renderer (`Maps.thumbnail`, gallery only); `app.log` still logs a
  custom map as `(custom)` and `detector.log` as `Custom/(custom)`.
- **The preview** (`{preview: true}`) is still the only thing that forces the
  raw-base64 path and still never reaches the OBS window.

### 3.5 Behaviour that changes, on purpose

1. **A stored key is resolved before it is sent.** `toggle-map` restoring
   `lastKey`, and `rotate`/`opacity`/`size` falling back to it, used to send the
   stored key blind. If that map had left the catalogue (an uninstalled pack, a
   deleted custom image), main could not resolve it, treated it as base64,
   `imageSize` threw and **nothing happened at all**. The reducer resolves those
   keys and toasts `hotkeys.error.mapMissing` for `toggle-map`; for the setting
   hotkeys the setting still lands and the re-send is simply not made.
2. **`toggle-markers` never puts a hidden map back.** It is the one setting
   hotkey that does *not* fall back to `lastKey` (`withSetting(…, {restore:
   false})`). The other three are aimed at the picture, so "make it bigger" with
   nothing on screen reasonably means "put it back and make it bigger" — and
   that is 0.6.0's behaviour, kept for parity. A marker switch is a switch on a
   *layer of* the picture: turning markers on must not be the thing that draws a
   map the player deliberately hid, or that the menu clear took away when the
   match ended, back over their game. The setting still lands and the toast
   still goes out.
3. **`toggle-map` with nothing ever shown is a no-op** rather than re-hiding an
   already hidden overlay (one fewer `map-change` log line).
4. **A second launch with no `show-map=` argument restores the window.** It used
   to do nothing at all in the running instance. With `show-map=` the map is
   applied and the window is left alone, which is what a stream deck wants.

## 4. The controller — `src/core/map-controller.js`

Thin and impure. It holds the state, the settings, `MainWindow` and (injected,
because it is built later) the detector. It owns:

- `get-map-state`, `map-intent` IPC;
- `select`/`detected`/`menuHide`/`action` — the entry points for the hotkeys,
  the detector and the CLI;
- executing effects: `MainWindow.applyMapChange()`, `Settings.set()`,
  `MainWindow.sendUpdate()`, `MapDetector.noteShown/noteApplied/resetLastDetected`;
- rolling the state back when an apply answers `false` (§3.3);
- pushing `map-state` to the window when there is one.

It holds **no catalogue snapshot**: `catalog()` asks `MapLibrary` on every
dispatch, and `MapLibrary` owns the cache (invalidated by `user-data.js` and by
a pack install). That is why there is nothing for a `catalogChanged()` to do.

**Every entry point works with no window.** `MainWindow.applyMapChange()` talks
to the overlay and the OBS windows, which are separate `BrowserWindow`s with
their own renderers.

## 5. Unloading the main window

### 5.1 The setting

`unloadWindowInTray`, **default `true`**, Settings › General, next to
"Use the graphics card to draw the app". With it off the window behaves exactly
as it did in 0.6.

> **Removed in 1.0.** There is no setting and no switch: the unload is always
> on, a leftover `false` is ignored rather than migrated, and
> `shouldUnloadMainWindow` has no `setting` input. Why:
> docs/agents/settings-and-onboarding.md § Two settings the app decides.

### 5.2 The decision — `shouldUnloadMainWindow()` in `src/shared/window-unload.js`

Pure, and it answers `{unload: boolean, reason: string}` so the reason can be
logged. It refuses ("not now") when:

| reason | condition |
|---|---|
| `setting-off` | `unloadWindowInTray` is not `true` — **gone in 1.0** |
| `no-window` | there is no window to unload |
| `visible` | the window is on screen |
| `minimized` | minimised to the taskbar rather than hidden to the tray. **`isMinimized()` alone cannot tell the two apart**: with minimize-to-tray on, the − button minimises first and the `minimize` handler then hides, and Windows keeps reporting the hidden window as minimised. `MainWindow.unloadVerdict()` therefore counts a window as minimised only while `hiddenAt` is 0 (no `hide` event). Until 1.0 it did not, and on the owner's machine — who sends the app to the tray with the − button — the window was **never** unloaded, in 0.7.0 either: found on 2026-09-21 by sampling the processes during a match (the main-window renderer, ~110 MB working set, was still alive after 90 s in the tray, and `app.log` had no `main-window state=unloaded` line since the feature shipped). The test that "covered" this had modelled the bug itself (`minimized = true` + `hide()` expected to keep the window). |
| `busy` | the view reported a busy reason: **any open modal**, the Settings modal, the welcome tour, a diagnostic report, a custom-map import |
| `recording` | the hotkey bind dialog is recording (`Hotkeys.suspended`) |
| `update-banner` | an update is downloaded and its banner has not been in front of a person yet |
| `installing` | an install is under way |
| `quitting` | `app.isQuiting` |
| `grace` | less than `UNLOAD_GRACE_MS` (45 s) since the window was hidden |

Two things keep the busy set honest, because a reason that is never cleared is
a window that is never unloaded:

- `did-start-loading` on the main window's `webContents` **clears the whole
  set**. Every load starts with a renderer that has reported nothing, so a
  crash reload (or an F5 in dev) cannot strand a `settings` that the dead
  renderer set.
- `Hotkeys.applyRegistration` calls `scheduleUnload` whenever `suspended`
  moves, including from the `SUSPEND_MAX_MS` watchdog. Otherwise a bind dialog
  whose "resume" never arrived would block the unload until the next time the
  window happened to be hidden.

### 5.3 The mechanics

- `MainWindow` listens for its own `hide`/`show` and schedules/cancels a timer.
- On unload: `win.__hmoUnloading = true`, `win.destroy()`, `window = null`. The
  `closed` handler's `overlayWindow.close()` / `obsWindow.close()` is skipped
  for a window carrying that flag — **that guard is the whole safety of this
  feature**. The flag lives on the *window object*, not on `MainWindow`,
  because Electron does not promise `closed` is emitted synchronously from
  `destroy()`; a flag cleared in a `finally` could already be false by the time
  the handler runs, and the overlay would go down mid-match.
- **A real close is a real shutdown, and says so.** The other branch of that
  same `closed` handler sets `app.isQuiting`, runs `runShutdownHooks()` (which
  takes the overlay, the Tab-map window, the detector and the tray, in that
  order), closes the OBS window and calls `app.quit()`. It does **not** leave
  it to `window-all-closed`: that only fires when every `BrowserWindow` is
  gone, and `TabOverlayWindow` is a lazy third window nobody there closes. With
  `minimizeToTray` off (the default) and Tab-map mode on, clicking X closed the
  overlay and the OBS window, left the Tab window alive, and the process stayed
  resident with the detector, the hotkeys and the key trigger running behind a
  **dead** overlay that Tray › Show could never bring back.
- `show()` rebuilds the window. Two guards on it: it **returns immediately when
  `app.isQuiting`** (a second instance or an `update-downloaded` during
  `finishInstall`'s deferred quit must not build a renderer while the installer
  is taking over), and the one-time startup work (`cleanStaleUpdateHelpers()`,
  `checkUpdates()`) runs on the **first** construction only, so opening the
  window from the tray is not a new network request.
- `render-process-gone` is ignored for a window carrying `__hmoUnloading`, so
  two ordinary unloads 46 s apart cannot trip the "died twice in 60 s → write a
  crash file and quit" policy.
- **Rebuilt only by a user action**: a tray click, the tray's *Show* item, or a
  second instance launched with no `show-map=` argument. Nothing in the app
  rebuilds it on its own. Rebuilding it *hidden* for a downloaded update was
  tried and removed: a window built with Electron's default
  `paintWhenInitiallyHidden` reports `document.visibilityState === 'visible'`
  on its first load, so it answered `update-banner-shown` from a window nobody
  had seen and was torn down again 45 s later — a renderer build mid-match for
  nothing. The banner survives on its own, because the renderer pulls
  `get-pending-update` on every load and the tray item is there regardless.

### 5.4 What it is observable by

`app.log` and `system.txt` record the edges:

```
main-window state=unloaded reason=tray hiddenMs=45012
main-window state=loaded reason=tray-click
```

`system.txt`'s `[health]` section gains `main window = loaded|unloaded` and
`unloadWindowInTray = on|off` (that line is **gone in 1.0**; the state lines stay).

## 6. Toasts while the window is gone

`MainWindow.sendUpdate(message, {keep})`. With no window:

| class | examples | policy |
|---|---|---|
| **kept** | `settings.error.writeFailed`, `update.installFailed`, the map-pack "N new maps" toast, Tab-mode's "the key state cannot be read on this PC" | queued (at most 5, deduped by key, oldest dropped) and flushed on the next load |
| **dropped** | `toast.markersOn/Off`, `toast.opacity`, `toast.size`, `hotkeys.error.mapMissing`, every `update.checking/available/downloading/upToDate/downloaded/checkFailed` progress line | dropped — they describe something the user just did or is being told twice (the update banner and the tray item both survive) |
| **not a toast at all** | the hotkey-defaults migration notice, the crash notice, the pending update, the hotkey conflicts | already **pull**-based (`get-hotkey-notice`, `get-crash-notice`, `get-pending-update`, `get-hotkey-conflicts`), so they survive any number of unloads by construction |

Anything a renderer asked for (`invoke` handlers, `save-hotkeys`, the diagnostic
report) is answered to a live window by definition.

The queue is **flushed one message at a time, 2.5 s apart**, and only into a
window that is actually visible. `src/js/status.js` is a single `#logStatus`
element with one shared auto-hide timer, so five sends in the same tick are
five overwrites and only the last is ever read; and a toast auto-hides on a
timer whether or not anybody is looking, so flushing into a hidden window
throws the queue away in a quieter way. The first goes out immediately, the
rest on `setTimeout`.

### 6.1 View state that is lost with the window, and what was done about it

| state | verdict |
|---|---|
| "Later" on the update banner | **moved to main** (`update-banner-dismissed`, returned by `get-pending-update`). It came back on every reopen otherwise. |
| an open modal with unsaved input (a file picked in *Add your own map*) | **prevented**: any open modal is a busy reason (`setBusy('modal')` from `shown.bs.modal`/`hidden.bs.modal`), not just the write that follows it. |
| the creator filter in the gallery | **accepted.** It resets to "all creators" when the window comes back. It is one dropdown, it is visible, and persisting it would mean a setting nobody asked for. |
| the scroll position, a half-typed custom map name with no file picked | **accepted**, same reasoning. |

## 7. `hotkeysGameOnly` with no main window

`core/foreground.js` classifies the foreground as `game` / `own` / `other` /
`unknown`, and our own windows count as `own` so a hotkey can be tried from
Settings. With the main window destroyed:

- `BrowserWindow.getFocusedWindow()` is `null` — the overlay is
  `focusable: false` and the Tab window uses `showInactive()`, so neither can
  ever be the focused window. Nothing changes.
- `classifyWindow` still returns `own` for any of this process's windows found
  in the enumeration, but none of them can hold the foreground, so the verdict
  is decided by the game exactly as before.
- Therefore: game in front → hotkeys registered; anything else in front →
  unregistered. Which is the whole point of the setting, and is what the player
  wants mid-match.

The one real change is that `browser-window-focus` can no longer fire for the
main window while it does not exist, which is correct: there is nothing to
alt-tab into.
