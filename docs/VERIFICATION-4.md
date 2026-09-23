# Verification 4 — 0.3.0 feature batch (independent review)

> **Historical, not maintained.** A record of what was true when it was written; names, paths and numbers may be stale.
> Current facts live in the `docs/agents/` document that owns them (see AGENTS.md).

Reviewed HEAD `d8348b6` (== `origin/main`), commits `3f64a53..HEAD` (5 commits,
40 files, +3831/−364). Spec: `docs/SPEC-0.3.md`. Nothing in `DEV-REPORT.md`,
the commit messages or the developer summary was taken on trust; every claim
below was re-derived from the code, the tests or a run. No project source was
modified; the only file this pass writes is this one. Scratch work lived in the
session scratchpad. `git status` was clean before and after every step.

## Verdict: **SHIP**

All four features are implemented as specified, 148/148 tests pass, the build
in `dist/` is byte-identical (modulo CRLF) to HEAD, both language runs are
clean, and no regression was found. The findings are documentation/comment
inaccuracies, one untranslated `aria-label`, and Italian wording polish (JSON
only, optional before tagging — the i18n test guards the key set). One
untested risk (menu false positive on the Tab "Player List" tab / pause menu)
is bounded by the threshold margin and the two-tick rule and needs a fixture,
not a code change.

## Per-feature table

| # | Feature | Result | Evidence |
|---|---------|--------|----------|
| 1 | Menu auto-hide | **PASS** | `matcher.js:79-84` `MENU_STRIP_REL` (x 45..760, y 20..68 of 1919x1079, measured from `menu-main.png`); template in its own `menu` section (`prepare-detector.js:299-304`, `templates.json` top-level keys `size,note,templates,menu`; test at `map-detector.test.js:483` asserts `templates` has no `menu` key); `npm run prepare-detector` reproduced the file byte-for-byte (md5 `3f58694a…` before and after, `git status` empty); runtime: `map-detector.js:55` `MENU_TICKS_TO_HIDE = 2`, `:339` runs `checkMenu` only when `match.gated`, `:390` only when `lastDetected`, `:389` `hideInMenu === false` opts out, `:409-411` two consecutive positives, `:416` `lastDetected = null`, `:423` `menu-hide-map` → `maps.js:114-118` `sendMap("")` → `main-window.js:81-82` `map-hide` to overlay and OBS; `settings-defaults.js:29` `hideInMenu: true`; switch `index.html:258-264` (`data-i18n`), `options.js:66,121-123`; status `detector.js:84-86` → `detector.menu`. Score table below: worst positive 0.9625 (+0.2125), best negative 0.4165 (−0.3335), both ≥ 0.15 from 0.75 (asserted at `map-detector.test.js:551-554`). |
| 2 | Opacity/size hotkeys | **PASS** | `hotkeys-constants.js:57-85` four defs in `SYSTEM_HOTKEY_DEFS`, `:88-98` settings keys, `:108-113` step/clamp constants (0.1 / 0.1..1.0, 25 / 50..800), `:125-129` `stepOpacity` rounds to one decimal (0.7+0.1 → 0.8, tested at `hotkeys-defaults.test.js:167-179`); defaults persisted in `settings-defaults.js:46-49` and asserted equal to the defs (`hotkeys-defaults.test.js:52-60`); conflict-checked with every other system hotkey and every map hotkey (`core/hotkeys.js:115-128`); registered in the same loop as the others (`core/hotkeys.js:294-298`); renderer `maps.js:123-147`: `settings.set` → slider `.val()` if present → `sendMap(currentKey || lastKey)` (main recomputes bounds) → `showStatus(t('toast.opacity'/'toast.size'))`; slider max 800 (`index.html:288`); no collision with Ctrl+1..9 / H / R / Left / Right / Shift+D (`hotkeys-defaults.test.js:62-69,122-132`); Hotkeys tab iterates all defs (`js/hotkeys.js:140-158`), Reset → `reset-system-hotkey` → `def.defaultAccelerator` (`core/hotkeys.js:138-149`). README table `:43-46` + FAQ `faq.inTheWay.a`. |
| 3 | Persistent map label | **PASS** | `settings-defaults.js:32,53,61-63` `mapLabel: 'auto'`, `mapLabelMode()` normaliser (tested); select `index.html:319-326`, `options.js:160-163`; rule in main `main-window.js:164-168`: `always` → caller label or resolved catalogue name, `auto` → caller label only and never for the preview, `never` → `''`; only the detector supplies a label (`maps.js:69`); overlay `renderer.js:25-41,62,69` — shown at the map's `opacity`, 3 s timer unless `always`, cleared on `map-hide`; `map.html:31-45` absolute, `bottom: 2px`, not inside the rotated `<img>`, `pointer-events: none`; OBS `renderer_obs.js:16-32,44,51`, `map_obs.html:20-29` same rule. Preview carries `t('overlay.sampleMap')` (`options.js:241`). **Crash fix confirmed**: `stopPreview` (`options.js:244-253`) now goes through `maps.sendMap(currentKey || "")` instead of `map-change` with `{preview:true}`; and `imageSize` is wrapped at `main-window.js:105-109` (`catch` → `console.error` + `return`), so a key decoded as base64 can no longer throw out of the handler. |
| 4 | Italian UI | **PASS** | `shared/i18n.js` imports only the two JSON files (`:30-31`); `resolveLanguage` (`:130-133`) `it*` prefix → it; `core/language.js:29-35,39-42` resolves `system` with `app.getLocale()` in main, pushes `language-changed` + tray rebuild (`index.js:73-76`); `en.json`/`it.json` 200 lines each, identical key sets (test `:221-225`), placeholders matched (`:227-239`); scan regexes `i18n.test.js:161-171` cover `t('…')`, `t(lang,'…')`, `this.t('…')`, `msg('…')`, `data-i18n*="…"`, `…Key: '…'`; **executed in a scratch copy**: adding `t('bogus.not.here')` → 1 fail "missing translations: en/it: bogus.not.here (src\js\status.js)"; adding an unused key → 1 fail "unused catalogue keys: orphan.unused". Live re-render: `maps.js:33-37` (gallery, creator filter, current-map line), `js/hotkeys.js:32-39` (both tables, map picker placeholder, modal title), `custom.js:34`, `detector.js:24` (last status re-rendered), `options.js:90` (monitor labels), `renderer.js:41-44` (update banner). Runtime: `i18n::applyDom it elements=88` / `… en elements=88`. Map/creator names untouched (`maps.js:255-256`, `populateMapSelect` uses `.text(e.name)`). `data-i18n-html` used on 17 elements, all catalogue keys (`index.html:167,195,261,344,472-530`). Own greps: zero `sendUpdate('literal')` in `src/core`, zero literal `showStatus/showToast/alert/.text("…")` except the product name; tray uses `t()` (`tray.js:67,78,87`). |

## Tests

`npm test` → **148 pass / 0 fail / 0 skipped**, 3.8 s (previous pass: 98).
`node --test test/i18n.test.js` alone → 18 pass.

Map-detector table as printed by the suite (unchanged from VERIFICATION-3
except the added `menu-main.png` negatives):

```
fixture                                             expected                detected                            score    runner-up  margin
window 1920x1080 → 640x360 (runtime path)           Haddonfield Heights     Haddonfield Heights                 0.9853   0.5009     0.4845
window 1280x720 → 640x360 (runtime path)            Haddonfield Heights     Haddonfield Heights                 0.9909   0.5008     0.4900
window 2560x1440 → 640x360 (runtime path)           Haddonfield Heights     Haddonfield Heights                 0.9872   0.5010     0.4862
tab-fullscreen-haddonfield-heights.png              Haddonfield Heights     Haddonfield Heights                 0.9959   0.5041     0.4919
tab-east-haddonfield.png                            East Haddonfield        East Haddonfield                    1.0000   0.5010     0.4990
tab-haddonfield-heights.png                         Haddonfield Heights     Haddonfield Heights                 1.0000   0.5010     0.4990
tab-haddonfield-town-center.png                     Haddonfield Town Center Haddonfield Town Center             1.0000   0.4833     0.5167
tab-orange-grove-estates.png                        Orange Grove Estates    Orange Grove Estates                1.0000   0.4578     0.5422
tab-fullscreen-haddonfield-heights.png @ 1280x720   Haddonfield Heights     Haddonfield Heights                 0.9932   0.5033     0.4899
tab-fullscreen-haddonfield-heights.png @ 2560x1440  Haddonfield Heights     Haddonfield Heights                 0.9935   0.5047     0.4888
tab-fullscreen-haddonfield-heights.png @ 640x360    Haddonfield Heights     Haddonfield Heights                 0.9908   0.5021     0.4887
tab-fullscreen-haddonfield-heights.png shifted -2%  Haddonfield Heights     Haddonfield Heights                 0.9959   0.4995     0.4964
tab-fullscreen-haddonfield-heights.png shifted -1%  Haddonfield Heights     Haddonfield Heights                 0.9959   0.5041     0.4919
tab-fullscreen-haddonfield-heights.png shifted +1%  Haddonfield Heights     Haddonfield Heights                 0.9959   0.5041     0.4919
tab-fullscreen-haddonfield-heights.png shifted +2%  Haddonfield Heights     Haddonfield Heights                 0.9959   0.5041     0.4919
gameplay-civilian.png                               null                    GATED OUT                           —        —          —
gameplay-killer.png                                 null                    GATED OUT                           —        —          —
menu-main.png                                       null                    GATED OUT                           —        —          —
gameplay-civilian.png (gate off)                    null                    Haddonfield Heights (rejected)      0.0948   0.0789     0.0160
gameplay-killer.png (gate off)                      null                    East Haddonfield (rejected)         0.1345   0.1233     0.0113
menu-main.png (gate off)                            null                    East Haddonfield (rejected)         0.2794   0.2447     0.0347
```

Main-menu detector table (accept at 0.75):

```
fixture                                             expected    menu?     score     margin to threshold
menu-main.png                                       menu        menu      1.0000    +0.2500
gameplay-civilian.png                               not menu    no        0.0278    -0.7222
gameplay-killer.png                                 not menu    no        0.0848    -0.6652
tab-east-haddonfield.png                            not menu    no        0.0992    -0.6508
tab-fullscreen-haddonfield-heights.png              not menu    no        0.4165    -0.3335
tab-haddonfield-heights.png                         not menu    no        0.1546    -0.5954
tab-haddonfield-town-center.png                     not menu    no        0.1429    -0.6071
tab-orange-grove-estates.png                        not menu    no        0.1149    -0.6351
menu-main.png @ 1920x1080                           menu        menu      0.9847    +0.2347
menu-main.png @ 1280x720                            menu        menu      0.9910    +0.2410
menu-main.png @ 2560x1440                           menu        menu      0.9975    +0.2475
menu-main.png @ 640x360                             menu        menu      0.9625    +0.2125
menu-main.png → 640x360 (runtime path)              menu        menu      0.9675    +0.2175
```

Fixture discovery: `menu-*.png` → menu positive and map negative
(`prepare-detector.js:85`, `map-detector.test.js:35-38`); any other non-`tab-`
PNG is a negative for both matchers. Adding a negative fixture is data-only.

## Findings (most severe first)

1. **SUSPECTED — untested false-positive surface for the menu matcher.**
   Cropping the top-left 900x110 px of the fixtures shows the in-game Tab
   screen has its own `Q`/`E` tab strip ("OBJECTIVES / PLAYER LIST"), shifted
   right so its `Q` badge sits where the menu template's `E` badge is — which
   is why the full-frame Tab fixture is the best negative at 0.4165. The
   "Player List" (E) tab has no fixture: its left panel is probably not black,
   so it would fail the Tab gate and *reach* the menu matcher while
   `lastDetected` is set. The pause menu has no fixture either. With a 0.33
   margin and the two-consecutive-tick rule (5–10 s of steady menu, see #2),
   a spurious clear is unlikely but not measured. *Fix (data only):* capture
   `detection-fixtures/playerlist-tab.png` and `pause-menu.png` (any name not
   starting with `tab-`/`menu-`); the suite picks them up as negatives with no
   code change.
2. **CONFIRMED (LOW) — comment overstates the reaction time.**
   `src/core/map-detector.js:51-53` says "Two ticks is 2 s of menu at the
   search cadence", but `checkMenu` only runs while `lastDetected` is set
   (`:390`), and then the cadence is `DETECTED_INTERVAL` = 5000 ms (`:296`).
   The overlay clears 5–10 s after the menu appears. Behaviour is fine (spec
   asks only for two consecutive ticks); fix the comment.
3. **CONFIRMED (LOW) — README sentence slightly wrong.** `README.md:89-90`
   "it only ever acts on a map it detected itself": if the player picks a map
   by hand *after* a detection, `lastDetected` is still set and the menu clears
   the manual pick too (`maps.js:114-118` hides whatever is current). This is
   what the spec asks for ("only while `lastDetected` is set"); reword to "only
   after auto-detect has recognised a map in this match".
4. **CONFIRMED (LOW) — one untranslated accessibility string.**
   `src/index.html:133` `aria-label="Toggle navigation"` on the navbar
   toggler. `applyDom` already supports `data-i18n-aria-label`
   (`js/i18n.js:54-58`); add the attribute and a key. Not visible on screen.
5. **CONFIRMED (trivial) — stale comment.** `src/core/hotkeys.js:218`
   "the four system hotkeys" (there are nine).
6. **INFO — spec-conformant behaviours worth knowing.** (a) Ctrl+↑/↓ and
   Ctrl+Shift+↑/↓ re-send `currentKey || lastKey` (`maps.js:136,145`), so after
   Ctrl+H hid the overlay a nudge brings the map back — identical to
   `rotate-map`, as the spec requires. (b) In `auto` label mode every
   `map-change` settles the label (`renderer.js:60-62`), so a nudge within the
   3 s window ends the detector's name early. Cosmetic.

No security regression: every new DOM insertion of a map/creator/user string
goes through `.text()`/`.val()` or `escapeHtml` (`maps.js:209-217`,
`js/hotkeys.js:94-104,266-276`, `custom.js:110-116`, `renderer.js:35`,
`renderer_obs.js:26`); `innerHTML` is only used by `applyDom` for
`data-i18n-html` keys from the two bundled catalogues.

## Italian — wording review

Overall natural, consistently "tu", game terms kept (Tab, overlay, hotkey with
feminine agreement throughout, "Borderless Windowed (finestra senza bordi)").
Map/creator names untouched. No translation reverses a meaning; two shift it
slightly (#9, #12). Suggested rewordings, in priority order:

| # | Key | Current | Suggested |
|---|-----|---------|-----------|
| 1 | `detector.menu` | Tornato al menu — mappa rimossa | Di nuovo nel menu — mappa tolta *(dangling participle)* |
| 2 | `credits.disclaimer` | Non affiliata, approvata o collegata agli sviluppatori o agli editori di… | Non è affiliata agli sviluppatori o agli editori di *Halloween: The Game*, né approvata da loro o collegata a loro. *("approvata … agli" is ungrammatical)* |
| 3 | `settings.minimizeToTray`, `.help`, `faq.updates.a` | barra di sistema | area di notifica *(Windows' own Italian term for the tray)* |
| 4 | `settings.language.system` | Come il sistema | Lingua di sistema |
| 5 | `home.fullscreenNotice` | …così l'overlay resta davanti | …così l'overlay resta in primo piano |
| 6 | `update.ready.body`, `faq.updates.a` | lavora parecchio il disco / lavora il disco per qualche secondo | usa molto il disco / usa il disco per qualche secondo |
| 7 | `settings.hideInMenu.help`, `faq.autodetect.a` | l'overlay si svuota da solo | la mappa sparisce dall'overlay da sola |
| 8 | `settings.hideInMenu` (+ #1, `clear-map`) | Rimuovi / rimossa / Togli / si svuota | one verb for "clear": **Togli** la mappa … / mappa **tolta** |
| 9 | `custom.empty` | Nessuna immagine personale. | Nessuna immagine personalizzata. *("personale" = personal, not custom)* |
| 10 | `custom.title`, `nav.custom` | Aggiungi immagine *(same as the button)* | Aggiungi immagine personalizzata |
| 11 | `settings.hideFaqPopup` | Nascondi l'avviso schermo intero | Nascondi l'avviso sullo schermo intero |
| 12 | `faq.internet.a` | nessuna analisi | nessuna statistica d'uso *("analisi" does not mean analytics)* |
| 13 | `settings.overlay.previewNotice` | …Le modifiche qui si applicano subito a quella. | Mentre questa scheda è aperta l'overlay mostra un'immagine di prova; le modifiche fatte qui si vedono subito lì. |
| 14 | `settings.setPositionWarning` | Se dimentichi di chiudere il posizionamento | Se dimentichi di terminare il posizionamento |
| 15 | `credits.basedOn` / `faq.ban.a` / `faq.updates.a2` | usata secondo la Apache License 2.0 / che ha già dentro di sé / elimina quel costo | usata nei termini della licenza Apache 2.0 / inclusi nell'app / elimina quel rallentamento |

Minor consistency: `settings.monitor` "Monitor" vs `settings.monitor.label`
"Schermo {index}"; `settings.checkForUpdates.help` "Disattivala" agrees with
"richiesta" but the switch is "il controllo" → "Disattiva il controllo…".
`hotkeys.action.toggle-map` drops "current" (harmless).

## Regression checks

- Overlay click-through: `overlay-window.js:58` `setIgnoreMouseEvents(true)`
  with no `{forward: true}`; `:13-15` only the set-position mode flips it.
- Quit/install order: `index.js:129-133` `before-quit` closes the overlay
  first, then stops the detector, then destroys the tray;
  `main-window.js:352-370` `runShutdownHooks` same order before the installer.
- Detector loop: `map-detector.js:12,14,296` 2000/5000 ms chosen from
  `lastDetected`, `setTimeout` chaining unchanged; `checkMenu` adds one
  25-offset NCC on a 96x12 thumbnail only on gated-out frames while a map is
  known. Runtime peak event-loop drift 15–16 ms (same as before).
- `desktopCapturer`: only in comments (`map-detector.js:67,185`).
- Dependencies: `git diff 3f64a53..HEAD -- package.json` changes the version
  line only; lock file root lines `:3` and `:9` are `0.3.0`.
- Build: `dist/win-unpacked/resources/app.asar` 15:06:51, both 0.3.0 exes
  15:07, HEAD committed 15:04:45; `latest.yml` version 0.3.0. Extracted the
  asar and diffed against `git archive HEAD`: `src/` and `index.js` identical
  (modulo CRLF); `package.json` differs only by electron-builder stripping
  `scripts`/`build`/dev fields. `@electron/asar list`: `src\i18n\en.json`,
  `src\i18n\it.json` present; no `.claude`, `docs/`, `test/`,
  `detection-fixtures/` entries (1087 entries, 1033 under `node_modules`).
  Not rebuilt — it is current.

## Runtime

`node_modules\electron\dist\electron.exe .` with `DEBUG=true` and
`--user-data-dir=<scratch>\ud-<lang>` holding
`{"mapDetection": true, "language": "<lang>"}`, 18 s each, then every process
whose command line contains that scratch dir was killed by PID (6 per run,
none left; the owner's installed app was not touched).

- **it**: `Map detection started (4 templates, every 2000 ms).` → one
  `game window not found` line → `[renderer] i18n::applyDom it elements=88` →
  `detector::init {"running":true,…,"templates":4,"inMenu":false}` →
  `renderer::ready maps=4 cards=4 customs=1` → drift 16 ms. **stderr empty**,
  no `renderer::uncaught`, no `unhandled-rejection`.
- **en**: identical sequence with `i18n::applyDom en elements=88`, drift
  15 ms, stderr empty.

## Git

`git ls-remote origin`: `main` = `d8348b6` = local HEAD; tags on the remote
and locally are exactly `v0.2.0 … v0.2.4` (`v0.2.4` = `3f64a53`, the base of
this batch); no `v0.3.0` tag. All five commits author **and** committer
`Davide-DevP <Davide-DevP@users.noreply.github.com>`. Working tree clean
(also after `npm run prepare-detector`, the asar extraction and the runtime
runs). README `:299-320` has a `## Changelog › 0.3.0` with the four items;
the hotkey table `:43-46`, `## Language` `:63-69`, the menu paragraph
`:85-90` and `## The map name on the overlay` `:114-120` match the code
(except finding #3). AGENTS.md gained the per-feature rules and a
`## Translation` section.

## Not verified here

- A real detection or a real menu clear: the game was not running, so no
  capture, no `Map detected:` / `Main menu detected` line, no label drawn on a
  live overlay. The label position/opacity and the OBS label are verified from
  the CSS/JS only.
- Hotkey presses, slider sync, the settings modal, the tray menu text and the
  language select were traced through IPC handlers, not clicked (no GUI
  interaction). The installed app on this machine already holds the global
  shortcuts, so the test instances could not have registered them anyway.
- Menu-matcher behaviour on the Tab "Player List" tab, the pause menu, loading
  screens and menu tabs other than the fixture's "MULTIPLAYER" highlight (see
  finding #1).
- `app.getLocale()` on a real Italian Windows: `resolveLanguage` is unit-tested
  for `it`, `it-IT`, `it-CH`, `it_IT`, but `system` was not exercised on an
  Italian OS; both runs pinned the language explicitly.
- Linux/Wayland path and the NSIS/portable exes (built, not executed).
