# Halloween Map Overlay

A transparent, always-on-top map overlay for **Halloween: The Game**. Pick a map
in the app and it appears as a small click-through window on top of the game,
with hotkeys to hide, rotate and cycle between maps. There is also an OBS window
with a green background for streamers.

It is a static map viewer: it ships the map images inside the app and displays
them. It does **not** read the game's memory, take screenshots or hook the game
process. Its only network request is the startup update check, which can be
turned off — see [Network use](#network-use).

![The East Haddonfield map as shown by the overlay](maps/deftyconchgaming/East%20Haddonfield.png)

## Features

- The four maps by u/deftyconchgaming bundled with the app — no download step.
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
| East Haddonfield | <kbd>Ctrl</kbd> + <kbd>1</kbd> |
| Haddonfield Heights | <kbd>Ctrl</kbd> + <kbd>2</kbd> |
| Orange Grove Estates | <kbd>Ctrl</kbd> + <kbd>3</kbd> |
| Haddonfield Town Center | <kbd>Ctrl</kbd> + <kbd>4</kbd> |

All of them can be changed under **Settings → Hotkeys**. The per-map bindings
are written once on first run and are yours to edit or delete afterwards.

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
npm run prepare-maps   # crops maps-src/*.webp into maps/ and renders the icons
npm start              # run in dev mode
npm test               # unit tests
npm run build:win      # NSIS installer + portable exe into dist/
```

The update check is skipped in dev builds (`app.isPackaged` is false), so
`npm start` never goes online.

`npm run prepare-maps` only needs re-running when the source images in
`maps-src/` or the app icon change; its output (`maps/deftyconchgaming/*.png`,
`build/icon.png`, `src/images/icon.png`) is committed.

If `npm run build:win` fails on your machine, see [docs/BUILD.md](docs/BUILD.md).

## FAQ

**The overlay does not show over the game.**
Set the game to **Borderless Windowed** in its video settings. In exclusive
fullscreen Windows hands the game exclusive control of the display and no
overlay window can draw on top of it.

**Can this get me banned?**
It only draws image files that ship with it. It never reads the game's memory,
never takes screenshots and never touches the game process. See
[Network use](#network-use) for the one request it does make.

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
