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
  shown on the Objectives tab.
- The in-game map has the same orientation as the community maps in `maps-src/`,
  minus the coloured annotations (storm cellars, escape gates, cars).
