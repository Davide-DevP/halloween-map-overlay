# Detection fixtures

Screenshots of *Halloween: The Game* (1080p, PC) used to design and unit-test the
automatic map detection (phase 2). Provided by the project owner on 2026-09-17.

| File | What it is | Expected detector result |
|---|---|---|
| `tab-fullscreen-haddonfield-heights.png` | Full 1920x1080 Tab (Objectives) screen. Title box ≈ x 300–547, y 160–203; map panel ≈ x 871–1670, y 140–935 | Haddonfield Heights |
| `tab-haddonfield-heights.png` | Tab screen, cropped to the two panels (1406x784) | Haddonfield Heights |
| `tab-orange-grove-estates.png` | Tab screen, cropped (1411x785) | Orange Grove Estates |
| `tab-haddonfield-town-center.png` | Tab screen, cropped (1400x781) | Haddonfield Town Center |
| `tab-east-haddonfield.png` | Tab screen, cropped (1403x784) | East Haddonfield |
| `gameplay-killer.png` | Normal gameplay as Michael Myers, no map open | none |
| `gameplay-civilian.png` | Normal gameplay as civilian, no map open | none |
| `menu-main.png` | Main menu | none (may be used to auto-hide the overlay) |

Notes
- The loading screen is black with a cutscene and never shows the map name, so
  detection must rely on the Tab screen only.
- The objectives list (top-left) appears both in gameplay and in the Tab screen;
  only the framed map-name box is unique to the Tab screen.
- The Tab screen has "Objectives" (Q) and "Player List" (E) tabs; the map name is
  shown on the Objectives tab. A newer build shows three (Objectives / Player
  List / Perk Cards) — that strip is at the top of the *Tab* screen and must not
  be confused with the main menu's navigation strip; the civilian fixtures score
  0.07-0.19 against the menu template, far under its 0.75 threshold.
- **The map panel is drawn per role** — see *Civilian view* below. Each role's
  screenshot is its own template *variant*, named `tab-<role>-<slug>.png`; the
  generator maps any `tab-…<slug>.png` to that map's key and the matcher scores
  a map as the best of its variants. The random glow spots are why the gradient
  half of the score matters: three house-sized glows cost ~0.05 of it.
- The in-game map has the same orientation as the community maps in `maps-src/`,
  minus the coloured annotations (storm cellars, escape gates, cars).

## Civilian view (added 2026-09-17, v0.3.3)

The Tab map looks completely different for the civilian role: a light,
greenish street map with a red boundary, grid letters/numbers and building
numbers, versus Michael's dark blue rendering. Same layout and orientation.
The yellow/blue glow spots over houses and the player arrow are random per
match and are NOT map features. As a civilian the Tab strip has three tabs
(Objectives / Player List / Perk Cards).

| File | Expected |
|---|---|
| `tab-civilian-<map>.png` (panel crops, ~1410x790) | that map (civilian variant template source) |
| `tab-fullscreen-civilian-<map>.png` (1919x1079 full frames) | that map (positives only) |

All four maps have both files.

## Discovered-exit icons (added 2026-09-20, Tab-map mode)

`tab-fullscreen-killer-found-*-haddonfield-heights.png` — four killer-view Tab
screens of the same map with **0, 1, 2 and 3 exits already discovered**, so the
game is drawing its own icons on the map panel. They exist because Tab-map mode
draws over that panel for as long as the Tab screen is up, and the recognition
has to survive the game's own annotations rather than only the pristine panel.
Sources: `maps-src/tab-reference/heights-killer-*.png` (the owner's real
screenshots).

`tab-fullscreen-` so they are **positives only** and not template sources — the
map already has its Michael and civilian variants, and a fifth thumbnail cut
from a frame with exit icons on it would key the template on those icons.

Measured, unchanged thresholds: the Tab gate passes at darkFraction
0.986–0.995 / nameBoxFraction 0.084–0.115, and the map scores **0.949–0.995**
with a margin of **0.459–0.493** at native resolution and at 1280x720 /
2560x1440 / 640x360. The icons cost about 0.045 of the score per extra
discovered exit and nothing at all of the margin, which is why no threshold
moved.

Note `locatePanel` finds the wrong row on `…found-gate-…` (dy 156 instead of 0)
— harmless, because a `tab-fullscreen-` fixture is not a template source and
the runtime matches these through `MAP_PANEL_REL`, not through `locatePanel`.
Two of the four are also 1914 and 1918 px wide rather than 1919; the regions
are fractions of the frame, so that changes nothing.
