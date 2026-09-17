# Halloween Map Overlay

A transparent, always-on-top map overlay for **Halloween: The Game**. Pick a map
in the app and it appears as a small click-through window on top of the game,
with hotkeys to hide, rotate and cycle between maps. There is also an OBS window
with a green background for streamers.

It ships the map images inside the app and displays them. It does **not** read
the game's memory, inject anything or hook the game process. Its only network
request is the startup update check, which can be turned off — see
[Network use](#network-use). The optional **auto-detect** feature reads the
screen (and nothing else) while it is switched on — see
[Auto-detect](#auto-detect-map).

![The East Haddonfield map as shown by the overlay](maps/deftyconchgaming/East%20Haddonfield.png)

## Features

- The four maps by u/deftyconchgaming bundled with the app — no download step.
- Optional **auto-detect**: open the in-game map with <kbd>Tab</kbd> and the
  overlay switches to that map by itself. Off by default.
- Transparent, frameless, click-through overlay that stays above the game.
- Pick the monitor, corner, fine-grain position, size, opacity and rotation.
- Drag the overlay into place with the mouse, or use the position sliders.
- Global hotkeys for hide/show, rotate and next/previous map, plus one hotkey
  per map (all rebindable).
- Import your own map images; they show up under the **Custom** creator.
- OBS window with a `#00ff00` background for chroma keying.
- Minimize to the system tray.

## Hotkeys

| Action | Default |
|---|---|
| Show / hide the current map | <kbd>Ctrl</kbd> + <kbd>H</kbd> |
| Rotate the map by 90° | <kbd>Ctrl</kbd> + <kbd>R</kbd> |
| Next map | <kbd>Ctrl</kbd> + <kbd>→</kbd> |
| Previous map | <kbd>Ctrl</kbd> + <kbd>←</kbd> |
| Clear the map and re-detect | <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>D</kbd> |
| East Haddonfield | <kbd>Ctrl</kbd> + <kbd>1</kbd> |
| Haddonfield Heights | <kbd>Ctrl</kbd> + <kbd>2</kbd> |
| Haddonfield Town Center | <kbd>Ctrl</kbd> + <kbd>3</kbd> |
| Orange Grove Estates | <kbd>Ctrl</kbd> + <kbd>4</kbd> |

All of them can be changed under **Settings → Hotkeys**. The per-map bindings
are written once on first run — <kbd>Ctrl</kbd> + <kbd>1</kbd> to
<kbd>Ctrl</kbd> + <kbd>9</kbd> go to the first nine maps in gallery order, so
maps added in a later version get their own number automatically — and are
yours to edit or delete afterwards.

## Auto-detect map

The switch above the gallery on the home page turns on automatic map detection.
With it on, press <kbd>Tab</kbd> in the game once at the start of a match and
the overlay switches to the map you are playing, naming it on the overlay for
about three seconds so you can see what it did. The status line next to the
switch reads *Off*, *Watching for the in-game map (Tab)…* or
*Detected Haddonfield Heights at 21:37*.

<kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>D</kbd> clears the map **and** makes
the detector forget what it last saw, so the next <kbd>Tab</kbd> press detects
the map again even if it is the same one. (Plain <kbd>Ctrl</kbd> + <kbd>H</kbd>
only hides the overlay.)

How it works, in full:

- While the switch is on, the app takes a screenshot of the display selected
  under **Settings → Overlay → Monitor** every 2 seconds — every 5 seconds once
  it has recognised a map — and shrinks it to 640x360.
- It compares the in-game map panel in that thumbnail, on your own computer,
  against four 64x64 thumbnails of the four maps that ship inside the app.
- **Nothing is stored and nothing is sent.** The screenshot is never written to
  disk and never leaves the process; the only thing that outlives the comparison
  is the name of the map it matched.
- It is **off by default** and takes no screenshot at all while it is off.
- It only acts when it sees a map *different* from the last one it recognised,
  so picking a map by hand or with a hotkey overrides it and is not fought over.
- It reads pixels off the screen, exactly like a screen recorder does. It does
  not read the game's memory, inject code or touch the game process.

It needs the Tab (Objectives) screen to be visible on the selected display, so
the game has to be in **Borderless Windowed** (see the FAQ) and on that monitor.

> **Known issue.** Taking that screenshot currently costs about half a second of
> main-thread time per poll, which can make the whole machine stutter every two
> seconds while the switch is on. Capturing only the game window instead of the
> whole display is the fix and is the next thing being worked on; until then,
> leave auto-detect off if you notice it.

## Command line

A second launch of the app hands its arguments to the running instance instead
of starting a new one, so you can drive it from a stream deck, a shortcut or a
script:

```
"Halloween Map Overlay.exe" show-map=deftyconchgaming/East Haddonfield
```

The key is matched case-insensitively, without the file extension, and falls
back to the closest map name, so `show-map=east haddonfield` works too.

## Download

Get the latest build from the
**[Releases page](https://github.com/Davide-DevP/halloween-map-overlay/releases)**:

| File | Use it if |
|---|---|
| `Halloween Map Overlay Setup <version>.exe` | You want it installed, in the Start menu, and **updating itself** |
| `Halloween Map Overlay <version>.exe` | You want a single portable file with nothing installed |

Or build it yourself (below).

### "Windows protected your PC"

The builds are not code-signed — a signing certificate costs several hundred
euros a year, which is hard to justify for a free community tool. SmartScreen
therefore shows a blue warning the first time you run it. Click **More info**,
then **Run anyway**. If you would rather not trust a stranger's binary, the
whole source is here and `npm run build:win` produces the same thing.

### Updates

The **installer** build checks GitHub for a newer release when it starts,
downloads it in the background and installs it the next time you quit the app.
Progress appears in the status message at the bottom right. You can turn the
check off in **Settings → General**.

The **portable** build cannot update itself — there is nothing installed for it
to replace. Download the new `.exe` from the Releases page when you want to
upgrade.

## Network use

The app makes exactly one kind of network request: an HTTPS call to
`api.github.com` / `github.com` at startup, asking whether a newer release of
this app exists, and downloading it if so. That is all.

- No accounts, no telemetry, no analytics, no crash reporting.
- The map images ship inside the app and are never downloaded.
- Unchecking **Settings → General → Check for updates on startup** stops it
  completely; the app then makes no network requests at all.
- The main window additionally runs under a Content-Security-Policy with
  `connect-src 'none'`, so the UI itself cannot reach the network even by
  accident.

## Build from source

Requires Node.js LTS.

```bash
npm install
npm run prepare-maps     # crops maps-src/*.webp into maps/ and renders the icons
npm run prepare-detector # rebuilds the auto-detect templates from the fixtures
npm start                # run in dev mode
npm test                 # unit tests
npm run build:win        # NSIS installer + portable exe into dist/
```

The update check is skipped in dev builds (`app.isPackaged` is false), so
`npm start` never goes online.

`npm run prepare-maps` only needs re-running when the source images in
`maps-src/` or the app icon change; its output (`maps/deftyconchgaming/*.png`,
`build/icon.png`, `src/images/icon.png`) is committed. The same goes for
`npm run prepare-detector`, whose output
(`src/core/map-detector/templates.json`) is built from `detection-fixtures/`
and is committed too.

If `npm run build:win` fails on your machine, see [docs/BUILD.md](docs/BUILD.md).

### Adding a map

The game gets new maps; adding one to this app is a **data-only** change — no
source file is edited.

1. Put the overlay image at `maps/<Creator>/<Map Name>.png`. (Or drop the
   original in `maps-src/`, add its file stem to `MAP_NAMES` in
   `scripts/prepare-maps.js` and run `npm run prepare-maps` to have it cropped
   for you.)
2. Put one screenshot of the in-game Tab (Objectives) screen showing that map at
   `detection-fixtures/tab-<slug>.png`, where `<slug>` is the map name
   lower-cased with spaces and punctuation turned into hyphens — for example
   `Haddonfield Town Center` → `detection-fixtures/tab-haddonfield-town-center.png`.
   A full 1920x1080 frame or a crop of the two Tab panels both work.
3. `npm run prepare-detector` — this rebuilds
   `src/core/map-detector/templates.json` from the fixtures.
4. `npm test` — the new map is already covered; the fixtures *are* the test
   matrix, and a map with no fixture fails the suite.

The gallery, the creator filter, next/previous cycling, the
<kbd>Ctrl</kbd> + <kbd>1</kbd>…<kbd>9</kbd> defaults and auto-detect all pick the
new map up on their own. Commit `maps/`, `detection-fixtures/` and the
regenerated `templates.json` together, and credit the author in the Credits
modal, this README and `NOTICE` if the creator is new.

## FAQ

**The overlay does not show over the game.**
Set the game to **Borderless Windowed** in its video settings. In exclusive
fullscreen Windows hands the game exclusive control of the display and no
overlay window can draw on top of it.

**Can this get me banned?**
It only draws image files that ship with it. It never reads the game's memory,
never injects anything and never touches the game process. See
[Network use](#network-use) for the one request it does make, and
[Auto-detect](#auto-detect-map) for the one thing that reads the screen.

**Does it take screenshots?**
Only with **Auto-detect map** switched on, and that is off by default. See
[Auto-detect](#auto-detect-map) for exactly what it captures and what happens
to it (nothing is stored, nothing is sent).

**The overlay is catching my mouse clicks.**
You left "Set position" mode on. Open **Settings → Overlay** and press
*Stop setting position*.

**How do I capture it in OBS?**
Press *Open OBS window*, add that window as a source in OBS and apply a
chroma-key filter for the green background.

**Where are my settings stored?**
In the app's userData directory (`%APPDATA%/halloween-map-overlay` on Windows):
`settings-app.json`, `hotkeys.json` and imported images under `custom/`.

## Credits

- Maps by **u/deftyconchgaming** on r/TheHalloweenGame —
  <https://www.reddit.com/r/TheHalloweenGame/comments/1wauwcx/>
- Application: derived from **DBD Map Overlay** by **LucaFontanot** —
  <https://github.com/LucaFontanot/dbd-map-overlay>

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).

This project is a derivative work of
[LucaFontanot/dbd-map-overlay](https://github.com/LucaFontanot/dbd-map-overlay)
(Apache-2.0); see [NOTICE](NOTICE) for the list of derived files and the
changes made. The bundled map images are the work of the r/TheHalloweenGame
author u/deftyconchgaming and are not covered by the Apache License applying
to the code.

Not affiliated with, endorsed by or connected to the developers or publishers
of *Halloween: The Game*.
