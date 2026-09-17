# Halloween Map Overlay

A transparent, always-on-top map overlay for **Halloween: The Game**. Pick a map
in the app and it appears as a small click-through window on top of the game,
with hotkeys to hide, rotate and cycle between maps. There is also an OBS window
with a green background for streamers.

It ships the map images inside the app and displays them. It does **not** read
the game's memory, inject anything or hook the game process. Its only network
request is the startup update check, which can be turned off — see
[Network use](#network-use). The optional **auto-detect** feature reads the
game's own window (and nothing else) while it is switched on — see
[Auto-detect](#auto-detect-map).

![The East Haddonfield map as shown by the overlay](maps/deftyconchgaming/East%20Haddonfield.png)

## Features

- The four maps by u/deftyconchgaming bundled with the app — no download step.
- Optional **auto-detect**: open the in-game map with <kbd>Tab</kbd> and the
  overlay switches to that map by itself. Off by default. It also clears the
  overlay when the game goes back to its main menu.
- Transparent, frameless, click-through overlay that stays above the game.
- Pick the monitor, corner, fine-grain position, size, opacity and rotation.
- Drag the overlay into place with the mouse, or use the position sliders.
- Global hotkeys for hide/show, rotate, next/previous map and the overlay's
  opacity and size, plus one hotkey per map (all rebindable).
- Optionally keep the map's name on the overlay all the time.
- **English and Italian**, following your system language by default.
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
| More opaque (+10 %) | <kbd>Ctrl</kbd> + <kbd>↑</kbd> |
| More transparent (−10 %) | <kbd>Ctrl</kbd> + <kbd>↓</kbd> |
| Bigger (+25 px) | <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>↑</kbd> |
| Smaller (−25 px) | <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>↓</kbd> |
| East Haddonfield | <kbd>Ctrl</kbd> + <kbd>1</kbd> |
| Haddonfield Heights | <kbd>Ctrl</kbd> + <kbd>2</kbd> |
| Haddonfield Town Center | <kbd>Ctrl</kbd> + <kbd>3</kbd> |
| Orange Grove Estates | <kbd>Ctrl</kbd> + <kbd>4</kbd> |

Opacity is clamped to 10–100 % and the size to 50–800 px, the same ranges as
the sliders in **Settings → Overlay**; the new value appears in the status
message at the bottom right, and the sliders follow along if the settings
window happens to be open.

All of them can be changed under **Settings → Hotkeys**. The per-map bindings
are written once on first run — <kbd>Ctrl</kbd> + <kbd>1</kbd> to
<kbd>Ctrl</kbd> + <kbd>9</kbd> go to the first nine maps in gallery order, so
maps added in a later version get their own number automatically — and are
yours to edit or delete afterwards.

## Language

The interface is available in **English** and **Italian**. It follows your
system language out of the box (anything Italian gets Italian, everything else
English) and can be pinned to one of them under **Settings → General →
Language**. The change applies immediately, with no restart. Map names and
creator names are never translated.

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

When the game returns to its **main menu** the match is over, so the overlay
clears itself and the detector forgets the map — the next <kbd>Tab</kbd> press
in the next match detects it again, even if it is the same map. It waits for
three consecutive readings of the menu (about two seconds) so a loading screen
cannot trigger it, and
it only does this **after auto-detect has recognised a map in this match** (if
you then pick a different map by hand, that one is cleared too). Turn it off
under **Settings → General → Clear the map back in the menu**.

How it works, in full:

- While the switch is on, the app captures **the game's own window** — not your
  screen, not any other window — about every 0.7 seconds while the game is
  running, and every 2 seconds while it is not. The image is immediately
  reduced to 640 pixels wide. (Up to 0.3.0 it was every 2 seconds, and every 5
  once a map had been recognised, which regularly missed a short Tab press.)
- **Only while the game is running.** If *Halloween: The Game* is not open there
  is no window to capture and nothing is captured; the app just checks whether
  the window exists, which takes a fraction of a millisecond.
- It compares the in-game map panel in that reduced image, on your own computer,
  against small 64x64 thumbnails of the maps that ship inside the app.
- **Nothing is stored and nothing is sent.** The image is never written to disk
  and never leaves the process; the only thing that outlives the comparison is
  the name of the map it matched.
- It is **off by default** and captures nothing at all while it is off.
- It only switches when the map it sees is **not the one already on the
  overlay**, so a map you picked by hand is never replaced by itself — and a
  hand-picked map *is* replaced the moment the game shows a different one.
- It reads pixels out of the game's window, exactly like a screen recorder does.
  It does not read the game's memory, inject code or touch the game process.

It needs the Tab (Objectives) screen to be visible in the game window, so the
game has to be in **Borderless Windowed** (see the FAQ) and not minimized.

**If detection misbehaves.** The app keeps a small text log of what the
detector decided — which map, with what score, how long the check took, and
whether the overlay actually switched. It contains no images and nothing about
your system; it is only ever written to your own computer and is never sent
anywhere. Open **Settings → General → Open log folder** and send
`detector.log` (and `detector.log.1` if it is there) with your report. The file
is capped at 512 KB with one backup, so it cannot grow without bound. Easier
still: use **Create diagnostic report**, which puts that file and everything
else into one zip — see [Reporting a problem](#reporting-a-problem).

## The map name on the overlay

By default the overlay names the map for about three seconds after auto-detect
switches to it, and stays anonymous the rest of the time. **Settings → Overlay
→ Map name on the overlay** changes that to *Always* or *Never*. The name sits
at the bottom of the overlay window, is never rotated with the map, and uses the
same opacity as the map. The OBS window follows the same setting.

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

Both downloads are about 95 MB and unpack to roughly 350 MB on disk.
Installing — including a self-update — spends a few seconds unpacking that
payload. That is exactly why the app no longer installs an update behind your
back when you close it, and why the self-update runs the installer at low
priority; see **Updates** below.

Or build it yourself (below).

### "Windows protected your PC"

The builds are not code-signed — a signing certificate costs several hundred
euros a year, which is hard to justify for a free community tool. SmartScreen
therefore shows a blue warning the first time you run it. Click **More info**,
then **Run anyway**. If you would rather not trust a stranger's binary, the
whole source is here and `npm run build:win` produces the same thing.

### Updates

The **installer** build checks GitHub for a newer release when it starts and
downloads it in the background; progress appears in the status message at the
bottom right. **Nothing is installed until you ask for it.** Once the download
finishes a green banner appears at the top of the app window:

> Version X.Y.Z is ready. Restart and update — the app closes, installs for a
> few seconds (disk-heavy, an installer window shows progress) and reopens by
> itself.

Press **Restart and update** (there, or in the tray menu). The app closes, a
small installer window appears and shows its progress while it unpacks — a few
seconds of heavy disk activity — and then the app starts itself back up. The
installer is launched at **low (idle) process priority**, which on Windows also
lowers its disk priority, so the unpack stays out of the way and the rest of the
PC keeps responding while it runs. You are not asked anything on the way
through, and Windows does not raise a permission prompt: it is a per-user
install. Press **Later** and the banner goes away until the next start; the
downloaded update keeps waiting.

If the update still feels heavy, most of what is left is your antivirus reading
every unpacked file. Adding the install folder
`%LOCALAPPDATA%\Programs\Halloween Map Overlay` to **Windows Security → Virus &
threat protection → Manage settings → Exclusions** removes that cost.

**Closing or quitting the app never installs anything.** Earlier versions used
electron-updater's default, which ran the installer silently on quit — a
several-second freeze at whatever moment you happened to close the app.

You can turn the check off in **Settings → General**.

The **portable** build cannot update itself — there is nothing installed for it
to replace. Download the new `.exe` from the Releases page when you want to
upgrade.

## Reporting a problem

Something not working? Three steps:

1. Open **Settings → General** and press **Create diagnostic report**.
2. A file called `HalloweenMapOverlay-report-<date>-<time>.zip` appears on your
   Desktop, and the folder opens with it selected.
3. Attach that zip to your message — an
   [issue](https://github.com/Davide-DevP/halloween-map-overlay/issues) or
   wherever you got the app from.

If the app closed on its own, it says so on the home page the next time you
start it, with the same button in the notice.

**What is in the zip**, so you can check before you send it — it is all plain
text:

- `app.log` (and one backup): what the app did — starts, map switches, hotkeys,
  settings changes, update checks, errors.
- `detector.log` (and one backup): what auto-detect decided. Only present if you
  have used it.
- `settings-app.json`, `hotkeys.json`: your settings and key bindings. A
  hotkey bound to one of your own imported images shows as
  `Custom/(custom)` — the binding is in there, the name you gave the image is
  not.
- `crash-*.txt`: any crash the app recorded, with the last 200 log lines.
- `system.txt`: Windows version, screens, graphics card, app version.

**What is *not* in it**: no screenshots, no map images, no file paths from your
user folder (they are written as `~`), no names you gave your own imported
images (a hotkey bound to one says `Custom/(custom)`), no account of any kind.
Nothing is uploaded — the button writes a file, and you decide whether to send
it. The app's only network request is still the update check.

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

### Teaching the detector what is *not* a map

`detection-fixtures/` is also the negative test set. **Any PNG whose name does
not start with `tab-` or `menu-` is a negative**: the map matcher must return
nothing for it, and the menu matcher must not call it the main menu. Dropping
one in is a data-only change — `npm test` discovers it and adds the assertions
and a row in the printed score table, with no code edited.

That is the cheap way to pin down a screen the detector has never seen. Good
candidates: the Tab screen's **Player List** tab, the **pause menu**, a loading
screen, a lobby, the store. Name them anything descriptive that avoids the two
reserved prefixes — `playerlist-tab.png`, `pause-menu.png`, `lobby.png`.

## FAQ

**The overlay does not show over the game.**
Set the game to **Borderless Windowed** in its video settings. In exclusive
fullscreen Windows hands the game exclusive control of the display and no
overlay window can draw on top of it.

**Can this get me banned?**
It only draws image files that ship with it. It never reads the game's memory,
never injects anything and never touches the game process. See
[Network use](#network-use) for the one request it does make, and
[Auto-detect](#auto-detect-map) for the one thing that reads pixels.

**Does it take screenshots?**
Only with **Auto-detect map** switched on, and that is off by default. It then
captures the game's window every 2 seconds, and only while the game is running.
See [Auto-detect](#auto-detect-map) for exactly what it captures and what
happens to it (nothing is stored, nothing is sent).

**The overlay is catching my mouse clicks.**
You left "Set position" mode on. Open **Settings → Overlay** and press
*Stop setting position*.

**How do I capture it in OBS?**
Press *Open OBS window*, add that window as a source in OBS and apply a
chroma-key filter for the green background.

**Where are my settings stored?**
In the app's userData directory (`%APPDATA%/halloween-map-overlay` on Windows):
`settings-app.json`, `hotkeys.json` and imported images under `custom/`.

**Does updating slow my PC down?**
It should not: the update installer is started at low (idle) priority, so
Windows gives it leftover CPU and disk instead of competing with whatever you
are doing. The remaining cost is your antivirus scanning the ~350 MB it unpacks
— excluding `%LOCALAPPDATA%\Programs\Halloween Map Overlay` in **Windows
Security → Virus & threat protection → Manage settings → Exclusions** removes
that too.

## Changelog

### 0.3.2

- **One-click diagnostic report.** **Settings → General → Create diagnostic
  report** writes a single zip to your Desktop with the logs, your settings and
  a description of your PC, then opens the folder so you can attach it. Nothing
  is uploaded and there are no screenshots or map images in it — see
  [Reporting a problem](#reporting-a-problem).
- **The app keeps its own log now**, `app.log`, next to the detector's: starts,
  map switches, hotkeys, settings changes, update checks and errors. Paths from
  your user folder are written as `~`, so the file is safe to send.
- **It says when it crashed.** If the app closes unexpectedly it writes a crash
  file and tells you on the home page next time you start it, with the report
  button right there. If the window itself dies it is reloaded once instead of
  leaving you with a frozen app.
- **Hotkeys another program has taken are no longer silent.** They are listed in
  a warning on the home page — the usual culprits are Discord and the NVIDIA
  overlay — so a shortcut that "does nothing" has a visible reason.

### 0.3.1

- **Auto-detect reacts to a short <kbd>Tab</kbd> press.** While the game is
  running the check now runs about every 0.7 s instead of every 2-5 s, so a
  one-second glance at the Objectives screen is no longer missed.
- **A map picked by hand is no longer sticky.** If you override the detector,
  the next time the game shows a map the overlay follows it again — including
  the same map you had overridden.
- **Back-in-menu clearing waits for three readings** instead of two, which the
  faster check makes just as quick in real time and harder to fool.
- **A log you can send.** **Settings → General → Open log folder** opens the
  folder holding `detector.log`, a plain-text record of the detector's
  decisions — no images, nothing sent anywhere. See *Auto-detect map*.

### 0.3.0

- **Italian.** The whole interface is translated, and follows your system
  language by default — **Settings → General → Language** pins it to English or
  Italian. Applies immediately, no restart. Map and creator names stay as they
  are.
- **Back-in-menu clearing.** With auto-detect on, the overlay clears itself when
  the game returns to its main menu, and the detector forgets the map so the
  next match is detected even if it is the same one.
  **Settings → General** turns it off.
- **Opacity and size hotkeys.** <kbd>Ctrl</kbd> + <kbd>↑</kbd> /
  <kbd>↓</kbd> for opacity and <kbd>Ctrl</kbd> + <kbd>Shift</kbd> +
  <kbd>↑</kbd> / <kbd>↓</kbd> for size, so the overlay can be adjusted without
  leaving the game. Rebindable like every other hotkey.
- **A permanent map name.** **Settings → Overlay → Map name on the overlay** can
  now keep the name on screen always, or never show it at all.

Older versions are listed on the
[Releases page](https://github.com/Davide-DevP/halloween-map-overlay/releases).

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
