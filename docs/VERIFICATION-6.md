# Verification 6 — 0.3.3 detector: civilian variants, margin accept, menu gate on the shown map (independent review)

Reviewed HEAD `6b2ea22` (= `origin/main`, version 0.3.3), detector commits
`89b372e..HEAD` (22 files; the code is all in `14d87b7`, `6b2ea22` is
AGENTS.md/README wording only). Nothing in the commit messages, AGENTS.md or
the developer summary was taken on trust: every number below was re-derived
from `npm test`, a scratch script over the real `matcher.js`, the owner's
0.3.2 `detector.log`, or a run of the packaged build. The packaged build
`dist/win-unpacked` (23:17) predates the HEAD commit (23:20) but its asar
`src/core/map-detector.js`, `matcher.js`, `templates.json`,
`shared/detector-rules.js`, `js/maps.js`, `main-window.js`,
`overlay-window.js`, `hotkeys.js`, `settings.js`, `diagnostics.js`, both i18n
catalogues and `index.js` are byte-identical to the HEAD blobs (asar
`package.json` is electron-builder's trimmed copy, version 0.3.3), so no
rebuild was needed. Runtime checks used
`--user-data-dir=<scratchpad>\v6\ud6`, one 17 s instance, killed by PID
(`Win32_Process` filtered on that path, 5 processes, 0 left). No project file
was modified except this one; `templates.json` was regenerated and came back
identical; no commit, tag or push.

## Verdict: **SHIP** (one documentation correction recommended, no code change, no rebuild)

All four claims hold in the code, the tests and the packaged build; the field
diagnosis is reproduced by replaying the civilian frames against the 0.3.2
template set (0.674–0.767 vs the log's 0.680–0.715); 271/271 tests pass; the
generator is idempotent; the per-tick cost with 8 variants is 9 ms on a
gated-in frame against a ~30 ms budget. The one real finding is that the
"safety net" story for the margin branch is overstated in AGENTS.md and the
`matcher.js` comment (finding 1): with a map's own civilian variant removed,
the measured margins are 0.196–0.283, not 0.249–0.305, and one of the four
views is rejected at full resolution. That does not affect 0.3.3 as shipped —
every map has both views committed and scores 0.94–1.00 on them — but the
numbers in the design notes are wrong and should be fixed before someone
relies on them.

## Claims table

| # | Claim | Result | Evidence |
|---|-------|--------|----------|
| 1 | Acceptance: `score ≥ 0.80 && margin ≥ 0.10` **or** `score ≥ 0.60 && margin ≥ 0.20`, in one place | **PASS** | `matcher.js:87-88,120-121` (the four constants); `acceptMatch` `:544-553` is the only place that compares them; `matchMap` `:629` calls it and no longer holds its own comparison; `map-detector.js` only reads `match.accepted`/`acceptedBy`. Tests `:465-502` cover both branches, the "both halves" requirement and that `matchMap` honours overrides. Field numbers: 63 of the 64 `no-match` lines in the owner's log (0.680–0.715 / margin 0.272–0.310) are accepted by the margin branch, the one outlier (`score=-0.021 second=-0.082 margin=0.061`) by neither. Negatives with the gate off: max score 0.2794, max margin 0.0516 (table below) — below both halves of the margin branch, asserted per fixture at `test/map-detector.test.js:442-461`. |
| 2 | `templates.json` format 2, list of variants per key, max over variants, 8 civilian fixtures, backward-compatible reader | **PASS** | File: `format: 2`, 4 keys × 2 variants × 4096 floats, `menu` 96×12 unchanged; 89b372e's file had no `format` and flat 4096-arrays. `templateVariants` `matcher.js:515-523` accepts flat arrays, lists and `Float32Array`; exercised by `test:662-680` (format 1 flat, format 2 list, typed, empties). `matchMap` `:616-621` takes the max over variants (never a mean). Fixtures: all 8 `tab-civilian-*` / `tab-fullscreen-civilian-*` files present (1.1–1.9 MB; full frames 1916–1919 × 1078–1079, crops ~1410×790), README section "Civilian view" present. Generator: `npm run prepare-detector` → `git status` unchanged (idempotent); variant order is fixture sort order, so **variant 0 is the civilian view, variant 1 is Michael's** (`prepare-detector.js:281-286`; confirmed by NCC 1.000 of variant 1 against the 0.3.2 template). |
| 3 | Menu clear gated on the map **shown** (`map-detector-shown` from the renderer), not `lastDetected` | **PASS** | Every path that changes the overlay goes through `Maps.sendMap` (`src/js/maps.js:263-292`), which sends `map-detector-shown {key or null}` on every call including hides (`:282`): gallery click `:243`, `#hide` `:53`, `show-map-command` (CLI + detector) `:86`, `hotkey-pressed` `:98`, `toggle-map` (Ctrl+H) `:103/105`, `rotate-map` `:115`, `next/prev` `:172`, `clear-map` `:128`, `menu-hide-map` `:137`, opacity/size nudges `:156/165`, settings re-send `options.js:47`, preview end `options.js:262`. Custom maps are ordinary catalogue entries and take the same click path; `logKey()` (`map-detector.js:59-62`) writes them as `Custom/(custom)`. Main: `ipcMain.on('map-detector-shown')` is registered in the constructor `:204` (so it works while the loop is off); `noteShown` `:221-229` collapses repeats, resets `menuTicks`, clears `inMenu`, logs `shown key=`. `shouldWatchMenu(shownKey, hideInMenu)` `detector-rules.js:129-132` is pure and tested (`rules.test.js:134-152`). `checkMenu` `:553-601`: gate → 3-tick streak → clears `lastDetected/lastAt/lastScore`, sets `shownKey = null` optimistically, resets the throttle, logs `menu-clear was=`, sends `menu-hide-map`, which the renderer turns into `sendMap("")` keeping `lastKey` for Ctrl+H (`maps.js:134-138`). Runtime: `shown key="…Haddonfield Heights"` then `shown key="…Haddonfield Town Center"`; a third `show-map=` of the same key produced no line. |
| 4 | `no-match` logs `gate=in panelMean=`, `match` logs `by=` | **PASS** (by reading; no game on this machine) | `map-detector.js:467-474` writes `score, second, margin, gate:'in', panelMean, tickMs`; `:489-496` writes `by: match.acceptedBy || 'score'`. `panelMean` is the unshifted panel's mean (`matcher.js:604-606`), asserted against `cropRegion` at `test:504-516`; `formatValue` prints it with 3 decimals. `loop-start` gained `variants=` (`:278`): runtime line `loop-start templates=4 variants=8 gameMs=700 idleMs=2000 version=0.3.3`. |

## 1. Tests

`npm test` → **271 pass / 0 fail / 0 skipped** (10.4 s; VERIFICATION-5 had 216).
Both score tables as printed by `test/map-detector.test.js`, unedited:

```
  Map detector — fixture scores (score = mean of luminance NCC and gradient NCC)
  accept: score >= 0.8 with margin >= 0.1, OR score >= 0.6 with margin >= 0.2 (the civilian/party case — see acceptMatch)
  templates: East Haddonfield variants=2  ·  Haddonfield Heights variants=2  ·  Haddonfield Town Center variants=2  ·  Orange Grove Estates variants=2

  fixture                                             expected                detected                            score    runner-up  margin    by
  --------------------------------------------------------------------------------------------------------------------------------------------------
  window 1920x1080 → 640x360 (runtime path)           East Haddonfield        East Haddonfield                    0.9613   0.4678     0.4936    score
                                                      East Haddonfield=0.9613  Haddonfield Heights=0.4601  Haddonfield Town Center=0.4678  Orange Grove Estates=0.3796
  window 1280x720 → 640x360 (runtime path)            East Haddonfield        East Haddonfield                    0.9655   0.4677     0.4978    score
                                                      East Haddonfield=0.9655  Haddonfield Heights=0.4620  Haddonfield Town Center=0.4677  Orange Grove Estates=0.3801
  window 2560x1440 → 640x360 (runtime path)           East Haddonfield        East Haddonfield                    0.9625   0.4678     0.4947    score
                                                      East Haddonfield=0.9625  Haddonfield Heights=0.4607  Haddonfield Town Center=0.4678  Orange Grove Estates=0.3799
  tab-fullscreen-civilian-east-haddonfield.png        East Haddonfield        East Haddonfield                    0.9699   0.4685     0.5014    score
                                                      East Haddonfield=0.9699  Haddonfield Heights=0.4630  Haddonfield Town Center=0.4685  Orange Grove Estates=0.3806
  tab-fullscreen-civilian-haddonfield-heights.png     Haddonfield Heights     Haddonfield Heights                 0.9447   0.5017     0.4430    score
                                                      East Haddonfield=0.4946  Haddonfield Heights=0.9447  Haddonfield Town Center=0.5017  Orange Grove Estates=0.4169
  tab-fullscreen-civilian-haddonfield-town-center.png Haddonfield Town Center Haddonfield Town Center             0.9490   0.4831     0.4659    score
                                                      East Haddonfield=0.4831  Haddonfield Heights=0.4521  Haddonfield Town Center=0.9490  Orange Grove Estates=0.3768
  tab-fullscreen-civilian-orange-grove-estates.png    Orange Grove Estates    Orange Grove Estates                0.9539   0.4151     0.5388    score
                                                      East Haddonfield=0.3967  Haddonfield Heights=0.4151  Haddonfield Town Center=0.4145  Orange Grove Estates=0.9539
  tab-fullscreen-haddonfield-heights.png              Haddonfield Heights     Haddonfield Heights                 0.9959   0.5041     0.4919    score
                                                      East Haddonfield=0.4995  Haddonfield Heights=0.9959  Haddonfield Town Center=0.5041  Orange Grove Estates=0.4584
  tab-civilian-east-haddonfield.png                   East Haddonfield        East Haddonfield                    1.0000   0.4686     0.5313    score
                                                      East Haddonfield=1.0000  Haddonfield Heights=0.4661  Haddonfield Town Center=0.4686  Orange Grove Estates=0.3534
  tab-civilian-haddonfield-heights.png                Haddonfield Heights     Haddonfield Heights                 1.0000   0.4960     0.5040    score
                                                      East Haddonfield=0.4960  Haddonfield Heights=1.0000  Haddonfield Town Center=0.4738  Orange Grove Estates=0.4178
  tab-civilian-haddonfield-town-center.png            Haddonfield Town Center Haddonfield Town Center             1.0000   0.4689     0.5311    score
                                                      East Haddonfield=0.4689  Haddonfield Heights=0.4465  Haddonfield Town Center=1.0000  Orange Grove Estates=0.3758
  tab-civilian-orange-grove-estates.png               Orange Grove Estates    Orange Grove Estates                1.0000   0.4178     0.5822    score
                                                      East Haddonfield=0.3821  Haddonfield Heights=0.4178  Haddonfield Town Center=0.4028  Orange Grove Estates=1.0000
  tab-east-haddonfield.png                            East Haddonfield        East Haddonfield                    1.0000   0.5010     0.4990    score
                                                      East Haddonfield=1.0000  Haddonfield Heights=0.5010  Haddonfield Town Center=0.4708  Orange Grove Estates=0.4067
  tab-haddonfield-heights.png                         Haddonfield Heights     Haddonfield Heights                 1.0000   0.5010     0.4990    score
                                                      East Haddonfield=0.5010  Haddonfield Heights=1.0000  Haddonfield Town Center=0.4833  Orange Grove Estates=0.4577
  tab-haddonfield-town-center.png                     Haddonfield Town Center Haddonfield Town Center             1.0000   0.4833     0.5167    score
                                                      East Haddonfield=0.4708  Haddonfield Heights=0.4833  Haddonfield Town Center=1.0000  Orange Grove Estates=0.4171
  tab-orange-grove-estates.png                        Orange Grove Estates    Orange Grove Estates                1.0000   0.4578     0.5422    score
                                                      East Haddonfield=0.4069  Haddonfield Heights=0.4578  Haddonfield Town Center=0.4171  Orange Grove Estates=1.0000
  tab-fullscreen-civilian-east-haddonfield.png @ 1280x720East Haddonfield        East Haddonfield                    0.9687   0.4660     0.5027    score
                                                      East Haddonfield=0.9687  Haddonfield Heights=0.4645  Haddonfield Town Center=0.4660  Orange Grove Estates=0.3802
  tab-fullscreen-civilian-haddonfield-heights.png @ 1280x720Haddonfield Heights     Haddonfield Heights                 0.9397   0.4995     0.4402    score
                                                      East Haddonfield=0.4944  Haddonfield Heights=0.9397  Haddonfield Town Center=0.4995  Orange Grove Estates=0.4157
  tab-fullscreen-civilian-haddonfield-town-center.png @ 1280x720Haddonfield Town Center Haddonfield Town Center             0.9465   0.4813     0.4652    score
                                                      East Haddonfield=0.4813  Haddonfield Heights=0.4538  Haddonfield Town Center=0.9465  Orange Grove Estates=0.3771
  tab-fullscreen-civilian-orange-grove-estates.png @ 1280x720Orange Grove Estates    Orange Grove Estates                0.9503   0.4150     0.5352    score
                                                      East Haddonfield=0.3969  Haddonfield Heights=0.4150  Haddonfield Town Center=0.4144  Orange Grove Estates=0.9503
  tab-fullscreen-haddonfield-heights.png @ 1280x720   Haddonfield Heights     Haddonfield Heights                 0.9932   0.5033     0.4899    score
                                                      East Haddonfield=0.4991  Haddonfield Heights=0.9932  Haddonfield Town Center=0.5033  Orange Grove Estates=0.4569
  tab-fullscreen-civilian-east-haddonfield.png @ 2560x1440East Haddonfield        East Haddonfield                    0.9688   0.4696     0.4993    score
                                                      East Haddonfield=0.9688  Haddonfield Heights=0.4615  Haddonfield Town Center=0.4696  Orange Grove Estates=0.3811
  tab-fullscreen-civilian-haddonfield-heights.png @ 2560x1440Haddonfield Heights     Haddonfield Heights                 0.9458   0.5010     0.4448    score
                                                      East Haddonfield=0.4945  Haddonfield Heights=0.9458  Haddonfield Town Center=0.5010  Orange Grove Estates=0.4172
  tab-fullscreen-civilian-haddonfield-town-center.png @ 2560x1440Haddonfield Town Center Haddonfield Town Center             0.9486   0.4840     0.4646    score
                                                      East Haddonfield=0.4840  Haddonfield Heights=0.4528  Haddonfield Town Center=0.9486  Orange Grove Estates=0.3770
  tab-fullscreen-civilian-orange-grove-estates.png @ 2560x1440Orange Grove Estates    Orange Grove Estates                0.9599   0.4163     0.5436    score
                                                      East Haddonfield=0.3969  Haddonfield Heights=0.4145  Haddonfield Town Center=0.4163  Orange Grove Estates=0.9599
  tab-fullscreen-haddonfield-heights.png @ 2560x1440  Haddonfield Heights     Haddonfield Heights                 0.9935   0.5047     0.4888    score
                                                      East Haddonfield=0.4991  Haddonfield Heights=0.9935  Haddonfield Town Center=0.5047  Orange Grove Estates=0.4589
  tab-fullscreen-civilian-east-haddonfield.png @ 640x360East Haddonfield        East Haddonfield                    0.9657   0.4673     0.4984    score
                                                      East Haddonfield=0.9657  Haddonfield Heights=0.4621  Haddonfield Town Center=0.4673  Orange Grove Estates=0.3805
  tab-fullscreen-civilian-haddonfield-heights.png @ 640x360Haddonfield Heights     Haddonfield Heights                 0.9437   0.5003     0.4433    score
                                                      East Haddonfield=0.4974  Haddonfield Heights=0.9437  Haddonfield Town Center=0.5003  Orange Grove Estates=0.4191
  tab-fullscreen-civilian-haddonfield-town-center.png @ 640x360Haddonfield Town Center Haddonfield Town Center             0.9460   0.4833     0.4627    score
                                                      East Haddonfield=0.4833  Haddonfield Heights=0.4547  Haddonfield Town Center=0.9460  Orange Grove Estates=0.3786
  tab-fullscreen-civilian-orange-grove-estates.png @ 640x360Orange Grove Estates    Orange Grove Estates                0.9573   0.4211     0.5363    score
                                                      East Haddonfield=0.4013  Haddonfield Heights=0.4211  Haddonfield Town Center=0.4182  Orange Grove Estates=0.9573
  tab-fullscreen-haddonfield-heights.png @ 640x360    Haddonfield Heights     Haddonfield Heights                 0.9908   0.5021     0.4887    score
                                                      East Haddonfield=0.4987  Haddonfield Heights=0.9908  Haddonfield Town Center=0.5021  Orange Grove Estates=0.4571
  tab-fullscreen-civilian-east-haddonfield.png shifted -2%East Haddonfield        East Haddonfield                    0.9699   0.4685     0.5014    score
                                                      East Haddonfield=0.9699  Haddonfield Heights=0.4630  Haddonfield Town Center=0.4685  Orange Grove Estates=0.3806
  tab-fullscreen-civilian-east-haddonfield.png shifted -1%East Haddonfield        East Haddonfield                    0.9699   0.4685     0.5014    score
                                                      East Haddonfield=0.9699  Haddonfield Heights=0.4630  Haddonfield Town Center=0.4685  Orange Grove Estates=0.3806
  tab-fullscreen-civilian-east-haddonfield.png shifted +1%East Haddonfield        East Haddonfield                    0.9699   0.4685     0.5014    score
                                                      East Haddonfield=0.9699  Haddonfield Heights=0.4630  Haddonfield Town Center=0.4685  Orange Grove Estates=0.3806
  tab-fullscreen-civilian-east-haddonfield.png shifted +2%East Haddonfield        East Haddonfield                    0.9699   0.4685     0.5014    score
                                                      East Haddonfield=0.9699  Haddonfield Heights=0.4630  Haddonfield Town Center=0.4685  Orange Grove Estates=0.3806
  gameplay-civilian.png                               null                    GATED OUT                           —        —          —         —
  gameplay-killer.png                                 null                    GATED OUT                           —        —          —         —
  menu-main.png                                       null                    GATED OUT                           —        —          —         —
  gameplay-civilian.png (gate off)                    null                    Haddonfield Heights (rejected)      0.1361   0.0845     0.0516    none
                                                      East Haddonfield=0.0845  Haddonfield Heights=0.1361  Haddonfield Town Center=0.0680  Orange Grove Estates=0.0546
  gameplay-killer.png (gate off)                      null                    East Haddonfield (rejected)         0.1600   0.1560     0.0040    none
                                                      East Haddonfield=0.1600  Haddonfield Heights=0.1500  Haddonfield Town Center=0.1144  Orange Grove Estates=0.1560
  menu-main.png (gate off)                            null                    East Haddonfield (rejected)         0.2794   0.2564     0.0230    none
                                                      East Haddonfield=0.2794  Haddonfield Heights=0.2564  Haddonfield Town Center=0.2044  Orange Grove Estates=0.1347


  Main-menu detector — fixture scores (accept at 0.75)

  fixture                                             expected    menu?     score     margin to threshold
  --------------------------------------------------------------------------------------------------------------
  menu-main.png                                       menu        menu      1.0000    +0.2500
  gameplay-civilian.png                               not menu    no        0.0278    -0.7222
  gameplay-killer.png                                 not menu    no        0.0848    -0.6652
  tab-civilian-east-haddonfield.png                   not menu    no        0.1231    -0.6269
  tab-civilian-haddonfield-heights.png                not menu    no        0.1549    -0.5951
  tab-civilian-haddonfield-town-center.png            not menu    no        0.0715    -0.6785
  tab-civilian-orange-grove-estates.png               not menu    no        0.1359    -0.6141
  tab-east-haddonfield.png                            not menu    no        0.0992    -0.6508
  tab-fullscreen-civilian-east-haddonfield.png        not menu    no        0.1575    -0.5925
  tab-fullscreen-civilian-haddonfield-heights.png     not menu    no        0.1660    -0.5840
  tab-fullscreen-civilian-haddonfield-town-center.png not menu    no        0.1853    -0.5647
  tab-fullscreen-civilian-orange-grove-estates.png    not menu    no        0.1464    -0.6036
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

## 2. Acceptance rule, re-derived from the table

- 35 positive rows, all accepted, all `by=score`: min score **0.9397**, max
  runner-up **0.5047**, **min margin 0.4402**
  (`tab-fullscreen-civilian-haddonfield-heights.png @ 1280x720`: 0.9397 vs
  0.4995). No positive is anywhere near either branch's edge.
- 3 negative rows (gate off): scores 0.1361 / 0.1600 / 0.2794, margins
  0.0516 / 0.0040 / 0.0230. The score branch needs 0.80, the margin branch
  needs 0.60 **and** 0.20; the worst negative misses the margin branch by
  0.32 on score and 0.15 on margin. With the gate on all three are `GATED
  OUT` and never scored.
- Wrong-map variant within 0.20 of the right one? Per-variant scores on the
  five full-frame positives at runtime resolution (scratch script, best over
  the 15 offsets): the highest score any **other** map's variant reaches is
  **0.501** (Town Center's Michael variant on the Michael Heights frame);
  the right map's best variant is ≥ 0.944 everywhere. The closest
  "competitor" to a frame is always the *same* map's other view (0.674–0.767),
  which is the same key and so not a runner-up. So, on the committed data,
  no: the smallest gap between the right map and any wrong-map variant is
  0.44.
- The one shape the margin branch could let through is a frame that
  correlates ~0.6 with one map and ≤ 0.4 with the rest; nothing in the
  fixtures or the field log looks like that (the log's only odd gated-in
  frame scored −0.02).

## 3. Variants, generator, per-tick cost

- Format and reader: see claim 2. `map-detector.js:160-165` converts each
  variant to `Float32Array` once at construction (`variantCount` = 8).
- Idempotent: `npm run prepare-detector` rewrote `templates.json`
  (`4 templates, 8 variants, 64x64, plus the menu strip`) and `git status`
  showed only the pre-existing `.gitignore` change. The test at `:636-651`
  asserts the same thing per variant (≤ 0.0006).
- Cost path: per tick `matchMap` builds 15 offset views (crop + downsample +
  Sobel) **once**, then per key per variant computes the template's Sobel once
  (`:616`) and 15 × 2 NCCs over 4096 floats. The template gradients are
  recomputed every tick rather than cached at load — 8 Sobel passes over
  64×64, well under 0.1 ms, not worth a cache.
- Measured (scratch `replay.js`, real `matchMap`, 640×360 luminance frame
  built by the real `toGrayScaled`, 200 calls each, this machine):

  | case | mean | median | p95 | max |
  |---|---|---|---|---|
  | gated-in, **8 variants** (0.3.3) | **9.06 ms** | 8.99 | 9.49 | 13.8 |
  | gated-in, 4 variants (0.3.2 set) | 9.73 ms | 7.72 | 12.75 | 14.0 |
  | gated-out (gameplay frame), 8 variants | 0.19 ms | 0.18 | 0.21 | 2.8 |

  The second variant set costs ~1.3 ms per gated-in tick (median). AGENTS.md's
  budget is the "~30 ms of blocking JS → move to a utilityProcess" line, and
  its own 0.3.1 bench quotes ~16–22 ms for the gated-in match; 9 ms is well
  inside both. `toGrayScaled` is unchanged by this diff: 5.55 ms on an exact
  1920×1080 → 640×360 capture (matches AGENTS.md's 5.6), **27.4 ms** on the
  1919×1078 window-sized fixture (general path; AGENTS.md says ~11 ms — see
  finding 5, pre-existing).

## 4. Menu gate trace

Covered in claim 3. Additional edges:

- **Ctrl+H while a map is shown.** `toggle-map` → `sendMap("")` →
  `map-detector-shown {null}` → `shouldWatchMenu` false → the menu matcher
  does not run while the overlay is hidden, so nothing is cleared; Ctrl+H
  again restores `lastKey` and reports it. Acceptable: there is nothing on
  screen to clear, and it matches the README ("only while a map is on the
  overlay"). The player who hides with Ctrl+H, goes to the menu, and presses
  Ctrl+H in the next match gets the old map back — same as 0.3.2.
- **App start with detection on.** No map is restored at startup (`Maps`
  starts with `currentKey = ""`; nothing in `main-window.js`/`settings.js`
  restores one), so `shownKey` is null until the first `sendMap`. Fine.
- **Loop stop/start.** `stop()` (`:316-327`) clears `lastDetected`,
  `menuTicks`, `inMenu` and the throttle but keeps `shownKey`; `start()`
  does not touch it — a map picked before the switch is turned on is known.
- **Optimistic clear.** After `menu-clear` sets `shownKey = null`, the
  renderer's own `map-detector-shown {null}` is a repeat and is not logged.
  `menu-hide-map` returns early when `currentKey === ""`.
- **Streak reset on pick.** `noteShown` zeroes `menuTicks` on any change, so a
  pick two ticks into a streak survives that streak — but see finding 2 for
  what happens ~2.1 s later if the menu is still up.

## 5. Civilian fixtures

All 8 files present (listing above). `detection-fixtures/README.md` has the
"Civilian view" section, the `tab-<role>-<slug>` rule, the three-tab strip
note and the 0.07–0.19 menu figure, which the table confirms (civilian
fixtures score 0.0715–0.1853 against the menu template, threshold 0.75; the
worst menu negative is still the Michael full frame at 0.4165). "Random glow"
test `test:546-583`: adds three soft radial bumps (r = 3 cells, +0.3) to the
civilian frame's own thumbnail and asserts ≥ 0.90 against its key's variants;
then with five-cell +0.45 bumps asserts `acceptMatch` still accepts against
the best other map. Note it starts from the *fullscreen* fixture whose crop is
the template source (same screenshot), so the baseline is ~0.97, and the
glows are synthetic on the 64×64 thumbnail; it is a robustness bound, not
independent data.

## 6. Field replay (runtime path: full frame → `toGrayScaled` 640×360 → `matchMap`)

| frame | 0.3.3 templates (8 variants) | 0.3.2 templates (4 Michael, from `89b372e`) | 0.3.2 rule | 0.3.3 rule on the 0.3.2 numbers |
|---|---|---|---|---|
| civilian East Haddonfield | 0.9654 / second 0.4677 / margin 0.4977, by=score | 0.6905 / 0.4106 / 0.2799 | reject | accept (margin) |
| civilian Haddonfield Heights | 0.9436 / 0.4995 / 0.4441, by=score | 0.7031 / 0.4995 / **0.2036** | reject | accept (margin, by 0.004) |
| civilian Haddonfield Town Center | 0.9458 / 0.4843 / 0.4615, by=score | 0.7669 / 0.4624 / 0.3045 | reject | accept (margin) |
| civilian Orange Grove Estates | 0.9575 / 0.4210 / 0.5366, by=score | 0.6738 / 0.4210 / 0.2528 | reject | accept (margin) |
| Michael Haddonfield Heights | 0.9912 / 0.5010 / 0.4901, by=score | 0.9912 / 0.5010 / 0.4901 | accept | accept (score) |

`panelMean` of the civilian panels 0.24–0.28 vs 0.095 for Michael's — the
`no-match` field would have told the story on its own. The 0.3.2 set
reproduces the log: log 0.680–0.715 (63 lines, mode 0.70/0.41/0.29) vs replay
0.674–0.767, runner-up 0.41–0.50 vs log 0.39–0.42 — inside ±0.1 on every
frame; the diagnosis ("civilian view, right map first, under the bar") is
confirmed. The log's two accepted matches (0.992/0.995, 19:52 and 19:53) were
Michael's view and cleared correctly in the menu; after the manual picks
(20:23 onwards) there is no `menu-streak` line, which is claim 3's bug.

## 7. Runtime (packaged, `ud6`, `{"mapDetection": true}`)

`detector.log`:
```
2026-09-17T21:31:13.321Z loop-start templates=4 variants=8 gameMs=700 idleMs=2000 version=0.3.3
2026-09-17T21:31:13.343Z window-lost
2026-09-17T21:31:20.264Z shown key="deftyconchgaming/Haddonfield Heights"
2026-09-17T21:31:23.281Z shown key="deftyconchgaming/Haddonfield Town Center"
```
Second instances `show-map=…Heights`, `…Town Center`, `…Town Center` (same
`--user-data-dir`; the third produced no `shown` line). `app.log`:
`map-change … source=cli` twice, `crash-notice pending=no`, no `error`. stderr
empty. Killed by PID at 17 s. (A first attempt with unquoted arguments split
the key at the space and resolved every call to Haddonfield Heights via
`findClosestMapMatch` — harness error, not the app's.)

## 8. Regression

- Cadence `GAME_INTERVAL 700` / `IDLE_INTERVAL 2000`, `MENU_TICKS_TO_HIDE 3`,
  `SEND_THROTTLE 2000` (`detector-rules.js:29-61`), asserted in
  `rules.test.js`. `overlay-window.js`, `main-window.js`, `hotkeys.js`,
  `settings.js` are **not** in `89b372e..HEAD`; the crash-handler fix from
  VERIFICATION-5 finding 1 is in `89b372e` (`main-window.js:312-338`: log,
  `appLog.flush()`, deferred reload) — not re-run here, out of scope.
- No new dependency: `package.json` diff is the version line only; lock diff
  is its two root `version` lines. Asar: 1103 entries, 0 under `.claude`,
  `docs`, `test`, `detection-fixtures`, `scripts`, `maps-src`, `dist`.
- i18n: en 195 = it 195 keys, identical sets; **no** new key in
  `89b372e..HEAD` (the `diagnostics.createdFallback` key came with 0.3.2's
  fixes in `a401971`).
- README: "Auto-detect" and FAQ updated, `### 0.3.3` changelog with four
  accurate entries; `detection-fixtures/README.md` updated. AGENTS.md updated
  (but see finding 1).
- Version 0.3.3 in `package.json:3` and `package-lock.json:3,9`; asar
  `package.json` 0.3.3.
- `git rev-parse HEAD origin/main` → both `6b2ea22`. Working tree: only
  ` M .gitignore` — one added line `.release-upload/` (a local staging folder
  for the new `gh release upload` step in `release.yml`), unrelated to the
  detector, harmless, uncommitted.

## Findings (most severe first)

1. **CONFIRMED — MEDIUM (documentation; the shipped behaviour is fine).
   The margin branch is not the safety net AGENTS.md says it is.**
   `AGENTS.md:362-367` and `matcher.js:90-119` state that the civilian
   frames "with their own variant removed" score 0.6631–0.7623 with margins
   **0.2493–0.3052** and "are accepted". Re-measured with the real matcher
   (own civilian variant removed, other maps' variants kept):

   | frame | full-res score / margin | 640×360 score / margin |
   |---|---|---|
   | East Haddonfield | 0.6879 / 0.2194 | 0.6905 / 0.2228 |
   | Haddonfield Heights | 0.6972 / **0.1956 → rejected** | 0.7031 / **0.2036** |
   | Haddonfield Town Center | 0.7623 / 0.2792 | 0.7669 / 0.2826 |
   | Orange Grove Estates | 0.6644 / 0.2493 | 0.6738 / 0.2528 |

   The scores match the doc; the margins do not (min 0.196, not 0.249), and
   Heights fails at full resolution and passes by 0.004 at runtime resolution.
   So for "the next view nobody has sent a screenshot of", the branch is a
   coin toss on two of the four known maps, not a guarantee. 0.3.3 itself is
   unaffected because all four civilian variants are committed (0.94–0.97).
   *Fix:* correct the two comments to the measured numbers and call the
   branch best-effort. If a real safety margin is wanted,
   `DEFAULT_MARGIN_MIN_MARGIN = 0.15` would accept all four unseen-view cases
   (min 0.196) while staying 3× above the worst negative margin (0.052) — a
   judgement call, not required for this release.
2. **CONFIRMED — LOW (behaviour change, documented, intended). A map picked
   by hand while the main menu is on screen is cleared ~2.1 s later, every
   time.** `checkMenu` gates on `shownKey` alone; `noteShown` resets the
   streak but grants no grace, so pick → 3 menu ticks → `menu-clear` → pick
   again → cleared again, as long as the navigation strip is visible. 0.3.2's
   comment promised "a manual pick made outside a match is never taken away";
   the README now says the opposite and the owner asked for it. Escape:
   Settings › General › "Clear the map back in the menu" off. Worth one
   sentence in the README FAQ so it is not reported as a bug.
3. **CONFIRMED — LOW (pre-existing). README FAQ contradicts itself on the
   cadence.** `README.md:363` "captures the game's window every 2 seconds"
   vs `:98-99` "about every 0.7 seconds while the game is running, and every
   2 seconds while it is not". Since 0.3.1, not this change. *Fix:* reword
   line 363.
4. **SUSPECTED (by reading) — LOW. A main-window renderer reload leaves
   `shownKey` stale.** After a `render-process-gone` reload the new `Maps`
   starts with `currentKey = ""` and sends nothing, while the overlay window
   keeps its map and main keeps the old `shownKey`. The next menu streak then
   sends `menu-hide-map`, which the renderer ignores (`currentKey === ""`),
   and main sets `shownKey = null` — the overlay stays up in the menu once.
   Only after a renderer crash; a `map-detector-shown` of the current state on
   renderer load would close it.
5. **INFO (pre-existing, not this diff).** `toGrayScaled` on a 1919×1078
   window capture (the shape a real window grab has — three of the five
   full-frame fixtures are 1919 or 1916 wide) takes 27 ms here on the general
   path against AGENTS.md's "~11 ms"; with the 9 ms gated-in match that tick
   blocks ~36 ms of JS, over the ~30 ms line AGENTS.md sets for moving to a
   `utilityProcess`. The owner's log shows `tickMs` 70–132 for matched ticks
   and 20 `slow-tick` lines (100–2286 ms) over the evening. Not a 0.3.3
   regression; the exact 3:1 path is 5.55 ms as documented.
6. **INFO.** The console line `Map detection started (4 templates, …)`
   (`map-detector.js:272`) does not mention variants; `detector.log` does.
7. **INFO.** `scoreThumbnail` (`matcher.js:491`) is no longer used by
   `matchMap` — only by the tests. Harmless.

## Could not be verified

- The `match … by=` / `no-match … gate=in panelMean=` / `menu-streak` /
  `menu-clear` lines at runtime: no game on this machine. Verified by reading
  and by the unit tests that build the same result objects.
- The menu clear on a hand-picked map end to end (needs the game's main
  menu on screen). The pure gate and the IPC chain were traced and the
  `shown` half was exercised in the packaged build.
- Detection on an actual civilian match capture: the only civilian frames are
  the four committed fixtures, which are also the template sources; the
  "unseen view" case was approximated by removing the own variant (finding 1).
- The `hideInMenu` setting path through the settings UI (read only:
  `settings.get('hideInMenu')` → `shouldWatchMenu`, `false` is the only off
  value).
