# 0.3.0 — feature batch (spec)

Owner-approved on 2026-09-17. Four features, all opt-in or non-intrusive.
Order of implementation: 2, 4, 1, 5 (cheapest first; 5 touches every string).

## 1. Hide the overlay when the player is back in the main menu

- Signal: the main menu (`detection-fixtures/menu-main.png`) has a static
  navigation strip top-left ("MICHAEL'S STORY · MULTIPLAYER · CHARACTERS ·
  GRAVEYARD", ≈ x 90–700, y 25–60 at 1080p; measure it). Build one template
  `menu` in `templates.json` (a separate section, not a map key) from that
  region using the same gradient+luminance NCC as the map matcher. The 3D scene
  behind it varies, the strip does not.
- Runtime: only while auto-detect is on and `lastDetected` is set. A tick whose
  frame fails the Tab gate additionally runs the menu matcher on the strip
  region. Two consecutive positive ticks → `map-hide` on the overlay and OBS
  window, `lastDetected = null` (so the next Tab press re-detects even the
  same map), status "Back in menu — map cleared". One positive tick does
  nothing (avoids flicker on transitions).
- Setting `hideInMenu` (bool, default true), switch in Settings → General,
  under the auto-detect explanation.
- Tests: `menu-main.png` → menu = true; all four Tab fixtures, both gameplay
  fixtures → menu = false; margin printed. The fixture test discovery must
  treat `menu-*.png` as menu positives.

## 2. Hotkeys for opacity and size

- System hotkeys (editable like the others, conflict-checked, in
  `SYSTEM_HOTKEY_DEFS`):
  - `opacity-up` Ctrl+Up, `opacity-down` Ctrl+Down: step 0.1, clamp 0.1..1.0.
  - `size-up` Ctrl+Shift+Up, `size-down` Ctrl+Shift+Down: step 25 px, clamp
    50..800 (extend the Settings slider max to 800 to match).
- Handler: update the setting, re-send the current map exactly like
  `rotate-map` does (main recomputes the window bounds), toast "Opacity 70 %" /
  "Size 325 px". Settings modal sliders reflect the new value if open.
- README hotkey table, FAQ, AGENTS.md.

## 3. (renumbered from 4) Persistent map name on the overlay

- Setting `mapLabel`: `"auto"` (current behaviour: 3 s after an automatic
  switch), `"always"` (name always visible under/over the map, same opacity as
  the map, small, no background), `"never"`. Default `"auto"`.
- Settings → Overlay: a select. The label follows rotation? No — keep it
  unrotated, positioned at the bottom of the overlay window, so it stays
  readable. Preview image in the Overlay tab shows the label when "always".
- The OBS window shows the label under the same rule.

## 4. (renumbered from 5) Italian UI

- Setting `language`: `"system"` (default; resolved with `app.getLocale()`,
  `it*` → it, everything else → en), `"en"`, `"it"`. Select in Settings →
  General; change applies live (re-translate the DOM) — no restart.
- Mechanism (no framework): `src/i18n/en.json` + `src/i18n/it.json` flat
  key → string with `{param}` placeholders; `src/shared/i18n.js` pure
  `t(lang, key, params)` with fallback to `en` then to the key; static HTML
  gets `data-i18n="key"` (text) and `data-i18n-title`/`data-i18n-placeholder`
  where needed; dynamic strings in the renderer call `t()`.
- Main-process messages: every `sendUpdate('literal')` becomes
  `sendUpdate({key, params})` and the renderer translates. Same for
  `map-detector-status` texts and hotkey conflict messages. Grep for every
  literal user-facing string in `src/core/*.js` and `src/js/*.js`; none may
  remain untranslated. Map names and creator names are NOT translated. The
  tray menu (main process) uses `t()` with the current language.
- Tests: `t()` fallback behaviour; a test that every key used in the code
  (`grep -o "t('[^']*'"` over src and `data-i18n="..."` in HTML) exists in
  both JSON files, and that both files have the same key set.
- Italian copy: natural, short, "tu" form, game terms unchanged (Tab, overlay,
  hotkey, Borderless Windowed → "finestra senza bordi").

## Version

0.3.0. README changelog section lists the four items. Release procedure per
AGENTS.md; the owner pushes the tag.
