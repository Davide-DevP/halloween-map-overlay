# Adding and preparing maps

[← AGENTS.md](../../AGENTS.md) · **Read before** adding a map, running `scripts/prepare-maps.js`,
`prepare-detector.js`, `build-markers.js` or `build-pack.js`, or touching
`maps/`, `maps-src/` or `detection-fixtures/`.

## Adding a map (data only — no code change)

The game is getting more maps; adding one must never need an edit to a source
file. The whole procedure:

1. Put the overlay image at `maps/<Creator>/<Map Name>.png` (or drop the source
   in `maps-src/` and run `npm run prepare-maps` — see "Adding maps" below).
2. Put one Tab (Objectives) screenshot at
   `detection-fixtures/tab-<slug>.png`, where `<slug>` is the map name
   lower-cased with non-alphanumerics turned into hyphens
   (`Haddonfield Town Center` → `tab-haddonfield-town-center.png`). A full
   1920x1080 frame or a crop of the two panels both work — `locatePanel` finds
   the panel either way.
3. `npm run prepare-detector` → rewrites `src/core/map-detector/templates.json`.
4. `npm test` → the new map is already covered; the fixture list *is* the test
   matrix.
5. Credit the author in the Credits modal (`src/index.html`), `README.md` and
   `NOTICE` if the creator is new.

Everything else follows automatically: the gallery and the creator filter read
the `maps/` listing, `next`/`prev` cycle over the catalogue, the first nine maps
in catalogue order get Ctrl+Alt+1..Ctrl+Alt+9 on a fresh install, and the matcher
iterates over whatever `templates.json` holds.

The fixture naming rules that make this work are in
[detection.md](detection.md) ("Fixture naming rules") — do not break them.

## Adding maps — the map image half

See "Adding a map (data only)" above for the whole procedure; this is just the
image step.

1. Drop the source image in `maps-src/` and add its stem → display name to
   `MAP_NAMES` in `scripts/prepare-maps.js`, **or** put a finished PNG straight
   into `maps/<Creator>/<Map Name>.png` (no code change at all).
2. `npm run prepare-maps` if you went through `maps-src/`. Then *look at the
   output PNGs* — the crop is detected from the image, not hard-coded, so a
   differently framed source can crop wrong.
3. A new folder under `maps/` is automatically a new creator; the home creator
   filter un-hides itself once there is more than one.
4. Default Ctrl+N bindings need no edit: the first nine shipped maps in
   catalogue order get them (fresh installs only, i.e. no `hotkeys.json` yet).
5. Credit the author in the Credits modal (`src/index.html`), `README.md` and
   `NOTICE`.

## Map crop detection

`scripts/prepare-maps.js` finds the map square by **mean luminance**, not by the
drawn frame: the letterbox around the square is flat grey (~45), the square is
near-black. It scans inward from each edge and stops at the first row/column
that is not letterbox, so bright content in the middle of the map (a white
title, a lit street) cannot break it. Only then does it look a few pixels
further in for a drawn frame line to sit just inside. An earlier attempt keyed
on the bright frame instead — two of the four sources have no frame at all, so
it did not work.

## Marker data

Marker positions are authored in `maps-src/markers.json` (provenance in its
`_about`) and built into the shipped `src/core/map-markers/markers.json` with
`npm run build-markers`; a test asserts the two agree. The authoring spelling
of the Tab transform differs from the runtime one on purpose — see
[markers-and-tab-mode.md](markers-and-tab-mode.md).

## Shipping a map without a release

`npm run build-pack` publishes the same data as a *map pack* instead, which
reaches users without a 93 MB release — [map-packs.md](map-packs.md).
