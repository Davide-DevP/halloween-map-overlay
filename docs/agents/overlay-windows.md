# Overlay, OBS and Tab windows

[← AGENTS.md](../../AGENTS.md) · **Read before** touching `src/core/overlay-window.js`,
`obs-window.js`, `tab-overlay-window.js`, `overlay-position.js`, the
`map-change` payload's label arguments, or anything about window focus, size
or DPI.

The four windows are built from one `webPreferences` object
(`src/shared/web-preferences.js`, see [memory.md](memory.md)); a test asserts
all four use the builder, so a fifth cannot quietly go back to an inline object.
The OBS window is the same picture on a green background, gets the same
`map-change` payload and the same marker module — a stream shows what the
player sees.

## Overlay invariants

- **Overlay quirks that must not be "cleaned up"** — each one is load-bearing:
  - `alwaysOnTop` level `pop-up-menu` on win32 (`screen-saver` is ignored there)
    and **re-asserted every second**, or a fullscreen game pushes it behind.
  - `setIgnoreMouseEvents(true)` **without** `forward: true`, `focusable: false`,
    `skipTaskbar: true` — otherwise the overlay eats the player's clicks.
    `forward: true` (what the reference uses) installs a WH_MOUSE_LL hook in
    this process on Windows; every mouse move then waits on our main thread,
    and the cursor stuttered system-wide for ~10 s during quit/update in
    0.2.3. The overlay needs no hover events, so the hook was pure cost.
    On quit and on install the overlay window is closed **first**
    (`runShutdownHooks()`, `before-quit`) for the same reason.
  - The window is sized to the **rotated** bounding box, `+5` px wide and
    `*1.1` tall, so rotated maps do not clip.

## The overlay does not depend on the main window

- **It survives the main window's renderer dying, and since 0.7 that costs
  nothing at all.** The two have always been separate `BrowserWindow`s with
  separate renderer processes (which is why `--renderer-process-limit=1` is
  measured and not shipped — [memory.md](memory.md)). What used to be lost with
  that renderer was the *state*: `currentKey`/`lastKey` lived in
  `src/js/maps.js`, so a reloaded renderer came back believing nothing was on
  the overlay while main still held the old map, and `map-detector-shown` had to
  be re-sent on load to stop the menu check clearing a map the renderer no
  longer knew about (VERIFICATION-6, finding 4). The state is in the main
  process now (`shared/map-state.js` + `core/map-controller.js`), so a renderer
  death loses nothing: the overlay keeps its map, every hotkey keeps working
  through the reload, and the menu clear stays correctly gated.
- **The main window is deliberately destroyed while it sits in the tray**
  (`unloadWindowInTray`, default true). Its `closed` handler has two branches
  and both are load-bearing:
  - **our own teardown** (the window carries `__hmoUnloading`) returns at once.
    Without that guard every tray unload would take the overlay down mid-match.
  - **a real close** sets `app.isQuiting`, runs `runShutdownHooks()`, closes
    the OBS window and calls `app.quit()` — it does **not** leave the shutdown
    to `window-all-closed`. That event needs *every* `BrowserWindow` gone, and
    `TabOverlayWindow` is a lazy third window nobody there closes: with
    `minimizeToTray` off (the default) and Tab-map mode on, clicking X closed
    the overlay and the OBS window, left the Tab window alive, and the process
    stayed in the tray with the detector, the hotkeys and the key trigger all
    running behind an overlay that had already been closed — and Tray › Show
    rebuilt a main window that could never put a map anywhere.

  See `docs/SPEC-MAP-STATE.md` §5.
- The overlay window itself is still created once in `createWindow()` and never
  re-created; making *it* lazy saves nothing in the state that matters and would
  break the focus rule below.

## Focus

- The overlay window cannot steal the foreground from the game, and that is
  load-bearing for `hotkeysGameOnly` — the rule and its reasoning are in
  [hotkeys.md](hotkeys.md) ("Hotkeys only while the game is in front"). It is
  also why the main window can be destroyed safely: with no main window, no
  window of ours can hold the foreground, so the `own` verdict simply stops
  occurring and the game decides.
- The Tab-map window follows the same construction rules, but uses
  `showInactive()` / `hide()`, never `show()` — see
  [markers-and-tab-mode.md](markers-and-tab-mode.md).

## The overlay label

- **The overlay label rides on the existing `map-change` payload.** It travels
  as the 6th and 7th arguments of the overlay's `map-change` (`mapLabel`,
  `labelMode`), never as a second IPC message — the overlay must never be able
  to name a map it is not showing. The `mapLabel` **setting** decides:
  - `auto` (default, the original behaviour): a label only when the caller sent
    one, which only an automatic detector switch does (`shared/map-state.js`'s
    `detected` intent passes `{mapLabel: entry.name}`, taken from the catalogue
    entry rather than from the matcher's key). `src/map/renderer.js` shows it for 3 s and
    clears it on the next `map-change` / `map-hide`. The settings preview is
    suppressed in this mode.
  - `always`: the caller's label, or the name main resolved from the catalogue.
    The overlay keeps it up (no timer).
  - `never`: main sends an empty label, so nothing downstream has to know.
  The OBS window gets the same two arguments and applies the same rule. The
  label is unrotated, bottom-aligned (it lives in the 10 % of extra height the
  rotated bounding box already has) and uses the map's own opacity.
  The settings preview *does* now carry a label (`overlay.sampleMap`) so
  `always` can be seen in the Overlay tab before it is turned on for real —
  main only forwards it in `always` mode.

## DPI

- **DPI**: `node-screenshots` rects are physical pixels, Electron bounds are
  DIPs. `core/tab-mode.js` reads each display's DIP `bounds` *and* its physical
  rect (`screen.dipToScreenRect`) and the pure `gameRectToDip` does the rest —
  tested at 100/125/150 % and on a second monitor. Both edges are rounded, not
  the origin and the size, or 125 % leaves a one-pixel strip of game uncovered.

## Also on the overlay

- Markers ride on the same `map-change` payload and are drawn by
  `src/map/markers.js` — [markers-and-tab-mode.md](markers-and-tab-mode.md).
- The `map-change` payload contract itself (keys, custom names, base64,
  `{preview: true}`) is in [architecture.md](architecture.md).
- The overlay window is closed first on quit and on install — see
  [updater-and-installer.md](updater-and-installer.md).
