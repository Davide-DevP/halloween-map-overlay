# Halloween Map Overlay

A transparent, always-on-top map overlay for **Halloween: The Game**. Pick a map
in the app and it appears as a small click-through window on top of the game,
with hotkeys to hide, rotate and cycle between maps. There is also an OBS window
with a green background for streamers.

It ships the map images inside the app and displays them. It does **not** read
the game's memory, inject anything or hook the game process. It makes two kinds
of network request — an update check and a look for new maps — both of which
can be turned off individually; see [Network use](#network-use). The optional
**auto-detect** feature reads the game's own window (and nothing else) while it
is switched on — see [Auto-detect](#auto-detect-map).

![The East Haddonfield map as shown by the overlay](maps/deftyconchgaming/East%20Haddonfield.png)

## Features

- The four maps by u/deftyconchgaming bundled with the app — no download step.
- **New maps arrive on their own**, as a few hundred KB rather than a whole app
  update: the app asks once a day whether new or corrected map images exist, and
  a new map appears in the gallery without a restart. Off with one switch.
- **One choice instead of three switches**: *where do you want to see the map?*
  — in a corner of the screen, on the game's own map, or both. Everything the
  choice needs is switched on with it.
- Optional **recognise the map by itself**: open the in-game map with
  <kbd>Tab</kbd> and the overlay switches to that map. Off by default for the
  corner map, and part of the two game's-map modes. It also clears the overlay
  when the game goes back to its main menu.
- Transparent, frameless, click-through overlay that stays above the game.
- Pick the monitor, corner, fine-grain position, size, opacity and rotation.
- Drag the overlay into place with the mouse, or use the position sliders.
- Global hotkeys for hide/show, rotate, next/previous map and the overlay's
  opacity and size, plus one hotkey per map (all rebindable, and each one can
  be switched off). By default they are only held while the game is in front,
  so they do not take combinations away from your other programs.
- Optionally keep the map's name on the overlay all the time.
- **Markers** for the places a storm cellar, an escape gate, a car or a gas can
  may appear — the gas cans in particular, which the game only ever shows to
  civilians. One chip per kind, a legend, and one hotkey to show or hide the
  lot. See [Markers](#markers).
- **In testing: the points on the game's own map.** While you hold <kbd>Tab</kbd>
  they can be drawn straight onto the game's own big map, next to your own
  arrow, and they disappear the moment you let go. Off by default.
- **Six languages** — English, Italian, Spanish, German, French and Brazilian
  Portuguese — following your system language by default. See
  [Language](#language).
- Built to stay out of the game's way: about 140 MB of RAM during a match with
  everything switched on and the window in the tray, and the graphics card left alone unless you ask for it.
  See [Memory use](#memory-use).
- Import your own map images; they show up under the **Custom** creator.
- OBS window with a `#00ff00` background for chroma keying.
- Minimize to the system tray.

## First run

The first time you start the app a **setup guide** opens over the home page,
and it is meant to be enough on its own: you can set the whole app up in it
without ever opening Settings. Six steps:

1. **The language.** The guide itself starts in your computer's language, and
   changing it here re-translates the guide as you watch.
2. **Where do you want to see the map?** Three cards, and you pick one: in a
   corner of the screen, on the game's own map (still *in testing*), or both.
3. **Set it up the way you like.** For the corner: the screen, the corner, the
   size and how visible it is — with a test map on the overlay while the
   step is open, so you can see exactly where it lands. For the game's own map:
   which key opens the map inside the game.
4. **What do you want to see on the map?** The four kinds of point, the legend,
   and *recognise the map automatically* — which the two game's-map modes need, so
   it is locked on for them.
5. **The hotkeys.** The five the app comes with, each with a *change* link that
   opens the real bind dialog, so a combination another program already owns can
   be moved here and now.
6. **All set.** One switch for looking up new versions and new maps, the single
   honest sentence about what the app uses the internet for, and a line naming
   the choice you made on step 2.

**Skip the guide** or <kbd>Esc</kbd> at any point. Every control in it is the
same control as in **Settings**, and nothing is written unless you actually
change something — pressing *Next* six times changes nothing at all.

It opens by itself on a new installation, and it is remembered as *owed* rather
than as "first start", so quitting or restarting before you finish does not lose
it: you are greeted again next time. It also opens **once** for an install that
is upgrading from an older version, because the guide was rewritten. You can
open it again whenever you like from **Settings → General → See the setup guide
again**.

## Hotkeys

| Action | Default |
|---|---|
| Show / hide the map | <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>H</kbd> |
| Next map | <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>→</kbd> |
| Previous map | <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>←</kbd> |
| Wrong map? Recognise it again | <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>D</kbd> |
| Show / hide the points | <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>M</kbd> |
| Turn the map | *no key by default — set one in Settings → Hotkeys* |
| More opaque (+10 %) | *no key by default — set one in Settings → Hotkeys* |
| More transparent (−10 %) | *no key by default — set one in Settings → Hotkeys* |
| Bigger (+25 px) | *no key by default — set one in Settings → Hotkeys* |
| Smaller (−25 px) | *no key by default — set one in Settings → Hotkeys* |
| East Haddonfield | <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>1</kbd> |
| Haddonfield Heights | <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>2</kbd> |
| Haddonfield Town Center | <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>3</kbd> |
| Orange Grove Estates | <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>4</kbd> |

**Five of them come with no key.** Rotate, the two opacity steps and the two
size steps are there, they work, and they are yours to bind — they are simply
not *given* a combination on a new installation, because ten global shortcuts
is more than anyone needs and every one of them is a combination taken away
from the rest of your PC. You will find them in **Settings → Hotkeys** under
**More keys**, the folded line below the table; their rows read *no key*, so
press **Edit** on one, press the keys you want, and it is bound from that
moment on — and from then on it sits in the table above with the rest, not in
the fold. Rotation, opacity and size are all on the sliders and buttons
in **Settings → Map** as well, so nothing needs a hotkey to be reachable.
**If you are updating**, nothing is taken away from you: an install that
already has these five on <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>R</kbd>,
<kbd>↑</kbd>, <kbd>↓</kbd> and <kbd>Shift</kbd> + <kbd>↑</kbd> / <kbd>↓</kbd>
keeps them exactly as they are, and so does anything you rebound or switched
off yourself.

**Why Ctrl + Alt and not plain Ctrl?** <kbd>Ctrl</kbd> is crouch in most games,
and <kbd>Ctrl</kbd> + <kbd>R</kbd>, <kbd>Ctrl</kbd> + <kbd>H</kbd>,
<kbd>Ctrl</kbd> + <kbd>1</kbd>…<kbd>9</kbd> and <kbd>Ctrl</kbd> + arrows all
belong to your browser, Discord and every text field on the PC. These are
*global* shortcuts, so the app would take them away from all of it. If you are
updating from 0.6.0 or earlier, the app moves your hotkeys onto the new
defaults once, on the next start — but only the ones you never changed
yourself. Anything you rebound or switched off is left exactly as it is, and
nothing is moved onto a combination that is already in use.

Opacity is clamped to 10–100 % and the size to 50–800 px, the same ranges as
the sliders in **Settings → Map**; the new value appears in the status
message at the bottom right, and the sliders follow along if the settings
window happens to be open.

All of them can be changed under **Settings → Hotkeys**. The per-map bindings
are written once on first run — <kbd>Ctrl</kbd> + <kbd>Alt</kbd> +
<kbd>1</kbd> to <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>9</kbd> go to the first
nine maps in gallery order, so maps added in a later version get their own
number automatically — and are yours to edit or delete afterwards.

Any of the system hotkeys can also be switched off entirely: press **Edit** on
its row, then **Remove key** in the dialog. That leaves the action with no key, so the keys go back to the game and
to every other program. The row then reads *no key*, **Reset** puts the
default back (unless something else has taken it meanwhile) and **Edit** binds
it again. For the five that have no default, **Reset** is the same thing as
*Remove key* — back to no key — and the button is greyed out while that is already
the case. That choice sticks across restarts.

While the *press the keys you want* window is open, the app releases all of its
hotkeys, so you can record a combination it is currently using — swapping two
bindings, or moving one out of the way, works as you would expect. They come
back as soon as you close that window.

### Only while the game is in the foreground

**Settings → Hotkeys** has one switch above the table, **on by default**: the
hotkeys are held only while you are in *Halloween: The Game* — or in one of
this app's own windows, so you can try a combination straight after rebinding
it. The rest of the time the combinations belong to whatever program is in
front, so <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>H</kbd> in your editor is
your editor's again.

It costs nothing: about once a second the app asks Windows for the list of open
windows and which one has the keyboard — no screenshot, nothing captured, well
under a millisecond, and the same when the game is closed.

**If your hotkeys do nothing in game, switch this off.** It depends on the app
recognising the game's window, and a game launched in an unusual way (a
different executable name, a wrapper, a remote-play session) may not be
recognised. With the switch off, the hotkeys are registered all the time, as in
0.6.0 and earlier. The diagnostic report prints both the setting and whether
the hotkeys were registered at the moment it was made.

## Language

The interface is available in **English**, **Italian**, **Spanish**, **German**,
**French** and **Brazilian Portuguese**. It follows your system language out of
the box — an Italian locale gets Italian, Spanish gets Spanish, German German,
French French, any Portuguese locale gets Brazilian Portuguese, and everything
else English — and can be pinned to one of them under **Settings → General →
Language**. The change applies immediately, with no restart. Map names and
creator names are never translated, and neither are the in-game terms you have
to match against the game's own screen (*Borderless Windowed*, the key names on
your hotkeys).

## Auto-detect map

The switch above the gallery on the home page turns on automatic map detection.
With it on, press <kbd>Tab</kbd> in the game once at the start of a match and
the overlay switches to the map you are playing, naming it on the overlay for
about three seconds so you can see what it did. The status line next to the
switch reads *Off*, *Watching for the in-game map (Tab)…* or
*Detected Haddonfield Heights at 21:37*.

<kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>D</kbd> clears the map **and** makes
the detector forget what it last saw, so the next <kbd>Tab</kbd> press detects
the map again even if it is the same one. (Plain <kbd>Ctrl</kbd> +
<kbd>Alt</kbd> + <kbd>H</kbd> only hides the overlay.)

When the game returns to its **main menu** the match is over, so the overlay
clears itself and the detector forgets the map — the next <kbd>Tab</kbd> press
in the next match detects it again, even if it is the same map. It waits for
three consecutive readings of the menu (about two seconds) so a loading screen
cannot trigger it, and it only does this **while a map is on the overlay** —
whether auto-detect put it there or you picked it by hand. (Up to 0.3.2 a map
you had picked yourself was never cleared unless auto-detect had recognised one
first in the same match.) A map you pick **while the menu is already up** is
left alone: the overlay is only cleared once the game has been seen away from
the menu since that map went up, so choosing the next map between matches is
never undone.

How it works, in full:

- While the switch is on, the app captures **the game's own window** — not your
  screen, not any other window — about every 0.7 seconds while the game is
  running, and every 2 seconds while it is not. Almost every one of those images
  is answered with a single cheap check and dropped without being looked at any
  further. (Up to 0.3.0 it was every 2 seconds, and every 5 once a map had been
  recognised, which regularly missed a short Tab press.)
- **Only while the game is running.** If *Halloween: The Game* is not open there
  is no window to capture and nothing is captured; the app just checks whether
  the window exists, which takes a fraction of a millisecond.
- It compares the in-game map panel in that reduced image, on your own computer,
  against small 64x64 thumbnails of the maps that ship inside the app.
- **Both views of the map are recognised** (since 0.3.3). The game draws the
  Tab map differently depending on who you are playing: Michael sees a dark
  blue plan, a civilian sees a light street map with a red boundary and
  building numbers. 0.3.2 only knew Michael's, so a civilian match scored too
  low to act on even though the right map was always well ahead of the others.
  Each map now carries one thumbnail **per view**, and on top of that a map is
  accepted either when it matches strongly or when it is clearly ahead of every
  other map — so a view nobody has sent a screenshot of yet is still usually
  recognised, while a screen that merely looks vaguely map-like switches
  nothing.
- **Nothing is stored and nothing is sent.** The image is never written to disk
  and never leaves the app; the only thing that outlives the comparison is the
  name of the map it matched. Since 0.7 the comparing normally happens in a
  small separate process, and then the picture does not even leave *that* — the
  rest of the app only ever receives a map name and a number. If that process
  cannot run on your machine, the comparison happens inside the app as it did
  before; either way nothing is stored and nothing is sent.
- It is **off by default** and captures nothing at all while it is off.
- **With *on the game’s own map* on, how often the window is looked at
  depends on which method that mode is using** (see
  [Markers on the in-game map](#markers-on-the-in-game-map-experimental)).
  Reading your map key: the ordinary 0.7 s check, plus **one** look when you
  press the key, plus a twice-a-second check while the markers are actually up
  so they cannot linger if a key release is ever missed. The slower method,
  without the key: every 0.45 s, and about six times a second while the markers
  are up. Either way those extra checks are cheap ones — they look at about a
  fifth of the window and ask a yes/no question, nothing more — and none of it
  changes what is kept: still no disk, still no network, and the only thing that
  outlives a check is the answer to "was that still the Tab screen?".
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
anywhere. Open **Settings → General → Something not working? → Open the files
folder** and send
`detector.log` (and `detector.log.1` if it is there) with your report. The file
is capped at 512 KB with one backup, so it cannot grow without bound. Easier
still: use **Create diagnostic report**, which puts that file and everything
else into one zip — see [Reporting a problem](#reporting-a-problem).

**If a map is still not recognised**, one screenshot fixes it for everyone:
press <kbd>Tab</kbd> in that match, take a **full-screen screenshot**, and add
it to `detection-fixtures/` as `tab-<role>-<map>.png` — for example
`tab-civilian-orange-grove-estates.png` — in a pull request or attached to an
issue. Every `tab-*` screenshot of a map is a *positive* example: the build
step turns each one into its own thumbnail for that map (a **variant**), and
the detector matches a map by whichever of its variants fits best. So a new
view is simply added; it never weakens the ones already there.

## Markers

The overlay can mark the places the game **may** put the things you are looking
for. There are four kinds:

| | |
|---|---|
| **Storm cellar** | one of the ways out |
| **Escape gate** | the other one |
| **Car** | the third |
| **Gas can** | what the car needs |

**Every one of them is a *possible* location, never a certainty.** The game
picks a different subset for each match: a map with nine cellar spots does not
have nine cellars in it, it has a few, chosen from those nine. Read a marker as
"worth checking", not as "it is there".

**On the maps that ship with the app you will only see the gas cans.** The
cellar, gate and car rings are already painted onto those images by their
author, so drawing them a second time would just double every ring. The gas
data comes from the same author's separate gas-spawn maps and is nowhere on the
image, which is why it is the one the app adds — and it is the one worth having,
because the game only ever shows gas cans to civilians. A map that arrives later
with a clean image gets all four.

Under **Settings → Map → What to show** each kind is a chip you tap on and off,
with one for the legend and a slider for how strongly they are drawn under
*Other adjustments*.
<kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>M</kbd> turns the lot on and off
without leaving the game. The OBS window shows exactly the same markers as the
overlay.

### The points on the game's own map (in testing)

While you hold <kbd>Tab</kbd> the game draws a big map with **your own arrow**
on it — something the corner overlay cannot do. Choosing *on the game's own
map*, or *both*, under **Settings → Map → Where do you want to see the map?**
draws the points straight onto that map instead, all four kinds, in the game's
own scale, and takes them away the moment you let go.

It is off by default, and:

- **It needs auto-detect.** The markers can only be placed once the app knows
  which map you are playing, so the switch is disabled while auto-detect is off.
  If a map is not recognised nothing is drawn and the corner overlay carries on
  as usual.
- **It needs the game in a plain window (borderless).** The markers are placed
  against the game window's own rectangle, so a window with a border and a
  title bar would put them slightly off on its map. The app checks, and draws
  nothing rather than drawing them in the wrong place; Settings says so when
  that happens. The corner overlay is unaffected either way.
- The brackets are hollow, so the game's own icon for an exit you have already
  found shows through rather than being covered up.

#### How it knows you pressed the map key

So that the markers appear the moment you press it and vanish the moment you let
go, the app asks Windows one question, a few dozen times a second: **is your map
key held down right now?**

- **Switching the mode on checks once that Windows lets it ask at all** — one
  harmless call that reads no key. That is how the app can tell you straight
  away whether this will work on your PC, instead of waiting until the next
  time you launch the game.
- **Then, each time, it asks Windows which program owns the window you are
  working in first**, and only carries on if that is the game. So the question
  is not "is this key down on this PC", it is "is this key down *in the
  game*".
- **Only then does it ask about one key** — the one under *The game's map key*,
  <kbd>Tab</kbd> unless you rebound it in the game. Plus <kbd>Alt</kbd>, and
  only while that key reads as held, so <kbd>Alt</kbd> + <kbd>Tab</kbd> is not
  mistaken for you opening the map. While you are in a browser, a chat window
  or anywhere else, **no key is read at all**.
- **It does not receive, record or see any other key.** There is no keyboard
  hook and nothing is captured; the app asks about one key by number and gets
  yes or no. Nothing about any key is written down except that your map key
  went down or came up, in the same local log as the rest of auto-detect.
- **Your map key still belongs to the game.** The app does not reserve it the
  way it reserves its own hotkeys, so the game sees every press exactly as
  before.
- **Pressing it is never enough on its own.** <kbd>Tab</kbd> is pressed in
  menus, in chat and in every lobby, so a press only makes the app *look* at
  the game's window — once, and up to three more times over the next third of a
  second in case the game is still fading the screen in. The markers appear
  only if what it sees really is the map screen, and only for the map it
  recognises there.
- It runs **only while this mode is on and the game is running**. With the mode
  off, or the game closed, or the markers switched off, nothing is read at all —
  not the key, not the foreground window.

#### Playing with a controller

The map key can have a **second input**: one controller button, under
*Settings → Map → Controller button* (and in the setup tutorial). Click
*Choose button…*, press the button that opens the map in the game, done. The
keyboard key keeps working alongside it, and the markers appear just as fast
either way.

- **It is read under the same rules as the key**: only while the game is the
  window in front, only with a button set. A hidden part of the app reads the
  controller the way a web browser does — the standard Gamepad API, the same
  one a browser game uses — and looks at the one button you chose; the other
  buttons and the sticks are thrown away. Nothing is sent anywhere, and nothing
  about it is written down except that your map button went down or came up.
  With no button set, the controller is never read at all, and that hidden
  part of the app does not even exist.
- **More than one controller plugged in?** Press the button on the one you
  play with when you choose it: that is the controller the app reads from then
  on. With only one plugged in, it is simply that one.
- **Choosing the button is the one time it is read outside the game**: for up to fifteen seconds after you click *Choose button…* — long enough to switch
  back to the game and press it there, should the button do nothing on the
  desktop.
- **Xbox, PlayStation and other PC controllers all work as they are**, with
  nothing to install: the Gamepad API knows the DualShock 4, the DualSense and
  the Xbox pads by name. On a PlayStation pad the touchpad click is a button
  like any other.

If reading the key state does not work on your PC — some security software
blocks it — the app says so once and falls back to the slower method below, all
by itself. You can also choose that method yourself with **Do not read the key
state**. Settings says which one is in use, under *Something not working?*, and says *"ready — your map key
will be used as soon as the game is running"* while the game is closed; that is
not a problem, it simply means nothing is being read yet.

- **The slower method** looks at the game's window a few times a second instead
  (and a little more often than usual while the markers are up). It is what the
  feature does without the key trigger, it works exactly the same way, and the
  markers just take a fraction of a second longer to appear. See
  [Auto-detect map](#auto-detect-map) for what is captured and what is not.

## The map name on the overlay

By default the overlay names the map for about three seconds after auto-detect
switches to it, and stays anonymous the rest of the time. **Settings → Map
→ Map name on the overlay** changes that to *Always* or *Never*. The name sits
at the bottom of the overlay window, is never rotated with the map, and uses the
same opacity as the map. The OBS window follows the same setting.

## Memory use

The overlay runs for a whole match on a machine the game already fills, so this
matters. Measured during a real match (1.0, six and a half minutes, a sample
every five seconds) with a map up, the window in the tray, the map recognised
automatically and the points drawn on the game's map — that is, everything
switched on — the app uses about **140 MB of RAM** across its six processes
(median 143 MB, between 103 and 177 MB), the "Memory" column Task Manager
shows, added up. The part that watches the game's window costs about 7 % of
one processor core while you play; everything else together about 5 %. With
automatic recognition off there is one process fewer and the total is lower.

One switch is most of the difference. **Settings → General → Something not working? →
"Use the graphics card to draw the map"** is **off by default**, and that is deliberate: the
overlay is a still image with no animation in it, so there is nothing for the
graphics card to accelerate. Leaving it alone takes about 14 MB off that total
and about 59 MB off the memory Windows reserves for the app, and it costs no
measurable processor time — measured back to back over five minutes each, the
app used 0.24 % of one core with the graphics card on and 0.19 % with it off.
The overlay looks and behaves exactly the same either way.

Turn it **on** if the app looks or feels wrong on your machine — the window
redrawing slowly, scrolling that stutters, anything that looks like a graphics
problem. It takes effect the next time the app starts.

The other half is not a setting at all — the app decides. While it sits in the
tray this window is closed after about three quarters of a minute and its
memory goes back to the system — measured, about 90 MB less reserved memory and
one process fewer. Nothing you use during a match is
affected: the overlay stays up, every hotkey still works, and it still switches
the map and clears it back in the menu. The only difference you will notice is
that opening the window from the tray takes a moment instead of being instant.
The window is never closed out from under you: not while you are minimized to
the taskbar, not with Settings or the setup guide open, not while a diagnostic
report or an image import is running, and not while an update is waiting for you
to say yes. (It was a switch up to 0.7; nobody has a reason to want the memory
back rather than the instant reopen.)

If you want to squeeze out another ~18 MB and you do not mind the overlay
blanking on the rare occasion a window crashes, start the app with
`--renderer-process-limit=1`. It puts every window in one process. The map comes
back with the next auto-detect or a press of the show/hide hotkey.

## Command line

A second launch of the app hands its arguments to the running instance instead
of starting a new one, so you can drive it from a stream deck, a shortcut or a
script:

```
"Halloween Map Overlay.exe" show-map=deftyconchgaming/East Haddonfield
```

The key is matched case-insensitively, without the file extension, and falls
back to the closest map name, so `show-map=east haddonfield` works too. The map
appears whether or not the app's window is open — it does not open the window,
which is what you want from a stream deck mid-match.

Launching the app again **with no arguments** does two things: the new copy
tells you it is already running and closes, and the copy that was already there
brings its window back. That is the ordinary way to get the window back if you
have forgotten about the tray icon.

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

> Version X.Y.Z is ready. Press Restart and update: the app closes for a few
> seconds and reopens by itself.

Press **Restart and update** (there, or on the icon near the clock). The window turns into
an *Updating to X.Y.Z* screen, a small window in the app's own colours takes its
place — same dark background, same pumpkin mark, the step it is on and a
progress bar — it works the disk for a few seconds, and then the app starts
itself back up. You never see a Windows installer. The installer underneath is
launched at **low (idle) process priority**, which on Windows also lowers its
disk priority, so the unpack stays out of the way and the rest of the PC keeps
responding while it runs. You are not asked anything on the way through, and
Windows does not raise a permission prompt: it is a per-user install. Press
**Later** and the banner goes away until the next start; the downloaded update
keeps waiting.

If that small window cannot start — an antivirus can block it, it is an
unsigned executable like every other file in this app — **the update still
happens**: the plain Windows installer runs instead, exactly as it did before
0.5.0. The app does not close until it has proof one of the two is on screen,
so there is no way to end up on neither. If something goes wrong further in, the
window says so in one sentence, shows where its log is, and offers a link to the
download page — and, as long as the old version is still intact on disk, a
button that reopens it.

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

1. Open **Settings → General → Something not working?** and press **Create a
   file to send to whoever is helping you**.
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
  not. The controller you chose for the map shows as `(set)`, not by its name.
- `crash-*.txt`: any crash the app recorded, with the last 200 log lines.
- `system.txt`: Windows version, screens, graphics card, app version, plus the
  marker switches and what *on the game’s own map* was doing (whether it
  was on, whether it had anything on screen, and how long its last check took
  — decisions and timings, never an image).

**What is *not* in it**: no screenshots, no map images, no file paths from your
user folder (they are written as `~`), no names you gave your own imported
images (a hotkey bound to one says `Custom/(custom)`), no controller names, no
account of any kind.
Nothing is uploaded — the button writes a file, and you decide whether to send
it. The app's network use is still only the two requests described below.

## Network use

The app makes exactly two kinds of network request, both of them a plain GET of
a public file on GitHub. Nothing about you or your PC is sent in either case,
and **one** switch — *Settings → General → Check for updates automatically* — turns both
off together: the difference between "a new version of the app" and "a new map"
is the app's problem, not the player's.

**1. The update check.** An HTTPS call to `api.github.com` / `github.com` at
startup, asking whether a newer release of this app exists, and downloading it
if so. Switch: **Settings → General → Check for updates automatically**, with a
*Check now* button next to it that makes the same single request
when — and only when — you press it, switch on or off.

**2. New maps.** An HTTPS call to
`raw.githubusercontent.com/Davide-DevP/halloween-map-overlay/main/packs/index.json`
at startup and then **at most once every 24 hours**, asking whether new or
corrected map images exist. *Halloween: The Game* gets new maps far more often
than this app gets a release, so a map is downloaded on its own — a few hundred
KB of image and detection data instead of a ~90 MB app update. Switch:
**Settings → General → Check for updates automatically**, with a *Check now*
button next to it. With the switch off **nothing is requested by itself**; the
button still works, because pressing it is asking for that one request.

What is actually requested and what happens to it:

- Only that one host, only over HTTPS, and only under this project's own path
  on it. Every file's URL is built by the app from a published index plus a
  file name it has validated — a downloaded file can never name its own URL,
  and a redirect to any other host is refused.
- Every file's size and SHA-256 are published in the index and checked before
  anything is stored. A download that is incomplete, altered or simply not what
  it claims to be is thrown away whole, and the map you already had is left
  exactly as it was.
- Only `.png` and `.json` files, with hard size limits (8 MB an image, 16 MB a
  whole map) and timeouts. **Nothing downloaded is ever executed**: the JSON is
  parsed as data and the image is shown, the same as the maps inside the app.
- Downloads land in the app's own data folder
  (`%APPDATA%/halloween-map-overlay/map-packs`), never in your temp folder.
- A new map appears in the gallery — and in auto-detect — without a restart.

And for both:

- No accounts, no telemetry, no analytics, no crash reporting. No identifier of
  any kind is sent; the only thing either request says about itself is a
  `User-Agent` naming the app, which GitHub asks every client for.
- Turn the switch off and the app makes no network requests **by itself**. The
  one exception is the *Check now* button: pressing it is asking for that one
  request, which is why it still works.
- The main window additionally runs under a Content-Security-Policy with
  `connect-src 'none'`, so the UI itself cannot reach the network even by
  accident — all of the above happens in the app's background process.

## Build from source

Requires Node.js LTS.

```bash
npm install
npm run prepare-maps     # crops maps-src/*.webp into maps/ and renders the icons
npm run prepare-detector # rebuilds the auto-detect templates from the fixtures
npm run build-pack -- --key "…" --image … --fixture …   # one downloadable map
npm start                # run in dev mode
npm test                 # unit tests
npm run build-updater    # compiles updater/*.cs -> build/updater/hmo-updater.exe
npm run build:win        # NSIS installer + portable exe into dist/
```

`build:win` runs `build-updater` first. It needs the C# compiler that ships
inside Windows (`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`) — no
Visual Studio, no .NET SDK, and nothing extra for the people who run the app.
See [docs/BUILD.md](docs/BUILD.md).

The update check is skipped in dev builds (`app.isPackaged` is false), so
`npm start` never goes online.

`npm run prepare-maps` only needs re-running when the source images in
`maps-src/` or the app icon change; its output (`maps/deftyconchgaming/*.png`,
`build/icon.png`, `build/icon.ico`, `src/images/icon.png`,
`src/images/tray.png`) is committed (`--icons-only` for the icons alone). The
same goes for
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
   A full 1920x1080 frame or a crop of the two Tab panels both work. More than
   one screenshot of the same map is allowed and encouraged — the game draws
   the map panel differently per **role**, so name the extras
   `tab-<role>-<slug>.png` (`tab-civilian-haddonfield-town-center.png`). Each
   becomes a **variant** of that map's template and the detector scores the map
   as the best of its variants; ideally every map has one screenshot per view.
3. `npm run prepare-detector` — this rebuilds
   `src/core/map-detector/templates.json` from the fixtures.
4. `npm test` — the new map is already covered; the fixtures *are* the test
   matrix, and a map with no fixture fails the suite.

The gallery, the creator filter, next/previous cycling, the
<kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>1</kbd>…<kbd>9</kbd> defaults and
auto-detect all pick the new map up on their own. Commit `maps/`, `detection-fixtures/` and the
regenerated `templates.json` together, and credit the author in the Credits
modal, this README and `NOTICE` if the creator is new.

### …or shipping it as a downloadable map

The steps above put the map inside the **next release**. To get it to people who
already have the app, build the same map as a *map pack* instead — the image and
that map's detector templates, a few hundred KB, published in `packs/`:

```bash
npm run build-pack -- \
  --key "deftyconchgaming/Silver Shamrock" \
  --image maps-src/silver-shamrock-overlay.png \
  --fixture detection-fixtures/tab-silver-shamrock.png \
  --fixture detection-fixtures/tab-civilian-silver-shamrock.png
```

It reuses the same template generator, validates the result with the app's own
checker, writes `packs/<map>/` and updates `packs/index.json` with the sizes and
checksums. Commit and push `packs/` — that is the whole release. A pack with the
same key as a bundled map **replaces** it, so this is also how a bad image or a
map auto-detect keeps missing gets fixed without a release. Format and rules:
[docs/SPEC-MAP-PACKS.md](docs/SPEC-MAP-PACKS.md).

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
It only draws image files — the ones that ship with it, the ones you import and
the ones it downloads from this project's own repository. It never reads the
game's memory, never injects anything and never touches the game process. See
[Network use](#network-use) for the two requests it does make, and
[Auto-detect](#auto-detect-map) for the one thing that reads pixels.

**Where do new maps come from, and is that safe?**
From this project's own GitHub repository and nowhere else: the app will not
follow a link anywhere but there, every file's checksum is published and checked
before it is stored, only images and plain data files are accepted, and nothing
downloaded is ever run — it is shown, exactly like the maps inside the app. A
download that does not match its checksum is discarded whole and the map you
already had stays. Turn the whole thing off under **Settings → General → Look
for news by itself**. The format is documented in
[docs/SPEC-MAP-PACKS.md](docs/SPEC-MAP-PACKS.md).

**Does it take screenshots?**
Only with **Recognise the map automatically** switched on, and that is off by default. It then
captures the game's window about every 0.7 seconds while the game is running,
and every 2 seconds while it is not (when there is no window to capture and
nothing is captured). With **on the game’s own map** also on there are a
few more looks while you are holding your map key — how many depends on which
method that mode uses, and the figures are in
[Auto-detect](#auto-detect-map). Either way nothing is stored and nothing is
sent: normally the picture stays inside the separate process that compares it
and the rest of the app is only told which map it was, and if that process
cannot run the comparison happens inside the app instead.

**Does it read my keyboard?**
It reads **one key**, and only with **on the game’s own map** switched on
(off by default) and the game running. Switching that mode on makes the app
check once that Windows lets it ask at all — that check reads no key, and it is
what lets Settings tell you straight away whether this works on your PC. After
that, each time, it first asks Windows which program owns the window you are
working in; if that is not the game it stops there and reads no key at all. If it is the game, it asks "is the map key held
right now?" — the one key you set under *The game's map key*, plus <kbd>Alt</kbd>
while that key is held so that <kbd>Alt</kbd> + <kbd>Tab</kbd> is not mistaken
for opening the map. There is **no keyboard hook**: the app does not receive
keystrokes, cannot see what you type, and never asks about any other key.
Nothing is written down except that your map key went down or came up. It does
not reserve the key either, so the game still sees every press. Switch that
mode off, or switch on *Use the other method*, and no key is read at all.
Everything else the app does with the keyboard is its own hotkeys, which you
choose and can unbind.

**Does it read my controller?**
Only if you set a controller button under *Settings → Map*, and then under the
same rules as the key: only while the game is the window in front. A hidden
part of the app reads the controller the way a web browser does (the standard
Gamepad API) and looks at the one button you chose; the rest is thrown away,
never written down and never sent. With more than one controller plugged in,
only the one you pressed the button on when you chose it is read.
Choosing the button is the one time it is read outside the game, for at most
fifteen seconds after you click *Choose button…*. With no button set the
controller is never read. See [Playing with a controller](#playing-with-a-controller).

**Why are there markers where there is nothing?**
Because a marker is a place the game **may** put a cellar, a gate, a car or a
gas can — it activates a different subset every match. Read one as "worth
checking". See [Markers](#markers).

**I only see gas-can markers.**
That is correct on the maps that ship with the app: their images already have
the cellar, gate and car rings painted on by their author, so the app would
only be drawing them twice. See [Markers](#markers).

**Auto-detect took my map away when I went back to the menu.**
That is the menu clear doing its job: when the game returns
to the main menu the match is over, so the overlay clears itself after about
two seconds of menu. It only does that to a map that was on the overlay while
you were **in** a match — a map you pick while the menu is already on screen
stays. There is no switch for it: a map from the last match still on the
overlay in the menu is a bug, not a preference.

**Auto-detect does not recognise the map in my matches.**
It should since 0.3.3, which added the civilian view of the map panel next to
Michael's — older versions only knew Michael's and scored the other one too low
to act on. If it still does not, send a full-screen screenshot of that
<kbd>Tab</kbd> screen: dropped into `detection-fixtures/` as
`tab-<role>-<map>.png` it becomes another variant of that map's template, and
the next build recognises it. See [Auto-detect](#auto-detect-map).

**The overlay is catching my mouse clicks.**
You left it in "move it with the mouse" mode. Open **Settings → Map** and press
*Leave it there*.

**How do I capture it in OBS?**
Press *Open OBS window*, add that window as a source in OBS and apply a
chroma-key filter for the green background.

**Where are my settings stored?**
In the app's userData directory (`%APPDATA%/halloween-map-overlay` on Windows):
`settings-app.json`, `hotkeys.json`, imported images under `custom/` and
downloaded maps under `map-packs/`.

**Does updating slow my PC down?**
It should not: the update installer is started at low (idle) priority, so
Windows gives it leftover CPU and disk instead of competing with whatever you
are doing. The remaining cost is your antivirus scanning the ~350 MB it unpacks
— excluding `%LOCALAPPDATA%\Programs\Halloween Map Overlay` in **Windows
Security → Virus & threat protection → Manage settings → Exclusions** removes
that too.

## Changelog

### 1.3.1

- **The update screen gets more time to appear.** The app now waits up to
  fifteen seconds for its own update window instead of four. On a slow start
  the four were not enough, and the plain Windows installer showed instead.
  Updating from 1.3.0 may still show the plain installer once: the waiting is
  done by the version you already have.
- **Settings and the home page, tidied.** A setting the app decides for itself
  is shown as *On* rather than as a switch you cannot move. The map name and
  the buttons at the top are quieter. The recognition bar keeps only its
  status. Hotkey rows show *Edit* and *Reset*; *Remove key* is inside the
  edit dialog.
- **A taller window that remembers its size.** It opens at 1100×820 and comes
  back at the size you left it.

### 1.3.0

- **More than one controller?** When you choose the controller button, the app
  remembers which controller you pressed it on, and in the game it listens to
  that one only. With a single controller plugged in nothing changes. Settings
  shows the name of the controller you chose.
- **One way to read the controller.** Xbox, PlayStation and other PC controllers
  are all read the same way now, through the standard Gamepad API. The FAQ and
  the *Playing with a controller* section above say exactly what is read.
- **Adding a hotkey to a map keeps Settings open.** Before, every new key sent
  you back to the home page.
- **The menu works from the keyboard.** Settings, *Add your own map*, FAQ and
  Credits can be reached with Tab and opened with Enter.
- **Faster under the hood.** The map recognition does the same work in about a
  quarter less time per check, with results identical to the bit. The gallery
  loads its images all at once instead of one by one.
- Fixes nobody should have noticed: a diagnostic report could include your
  Windows user folder if `hotkeys.json` was locked by an antivirus; an empty
  name in *Add your own map* could break the custom maps folder.

### 1.2.0

- **PlayStation and other controllers work through Steam.** The controller
  button is read the way a web browser reads a controller, so a DualShock or
  DualSense set up through Steam Input works, not only an Xbox pad.

### 1.1.0 – 1.1.2

- **The map key can have a second input: one controller button.** Choose it
  under *Settings → Map* or in the setup tutorial, and hold it in the game the
  way you hold the map key. On PlayStation through Steam the map opens with the
  touchpad, and the label says so.
- Choosing the button waits up to fifteen seconds and survives an Alt+Tab back
  to the game, which Steam needs for a PlayStation pad.

### 1.0.0

- **A setup guide instead of a tour.** Six short steps set the app up without
  ever opening Settings: language, where you want the map, how it looks, what to
  show, your hotkeys, updates. It opens on first run, and **once for everyone
  who already has the app**, because so much has changed. It starts from what
  you already chose, so pressing *Next* all the way changes nothing, and *Skip*
  or Esc closes it at any point.
- **One question instead of a page of switches: *Where do you want to see the
  map?*** In a corner of the screen, on the game's own map while you hold the
  map key, or both. Everything that choice needs switches itself on.
- **Settings a player can read.** Three tabs, eight switches in sight instead of
  twenty-one. The options you only need when something goes wrong are folded
  under *Something not working?* and written as the question you would ask.
  Two options are gone because the app decides them itself. One switch and one
  *Check now* button cover both the app's updates and new maps.
- **Every sentence rewritten** for someone who knows nothing about PCs, in all
  six languages, one word per thing (*points*, *hotkeys*, *the map in the
  corner*, *the game's map*). What the app reads and when it uses the internet
  is in the FAQ, in plain language first.
- **Five hotkeys instead of ten.** Rotate, more/less visible and bigger/smaller
  have no key on a new installation — they are under *More keys* and one click
  gives them one. **If you are updating, every key you have stays exactly as it
  is.**
- **The window really leaves memory now.** Sending the app to the tray with the
  − button never freed the main window's memory, in 0.7.0 either. It does now:
  measured in a match, about 90 MB less reserved memory and one process fewer.
  The README's memory figures are now real in-match measurements (about 140 MB
  of RAM with everything on).
- *Map recognised … at 18:27* now shows when the map was first recognised, not
  the last time you pressed Tab.
- The installed app is about 55 MB smaller (only the languages the app speaks,
  no development files).
- For map authors: `build-pack` now compares a new map with every other one and
  warns when two maps look too alike for the detector to tell apart.
- Note: going back to 0.7.0 keeps your settings; it simply ignores the new ones.

### 0.7.0

- **Gas can spawns on every map**, as yellow diamonds with their own legend
  entry (positions from the maps by u/deftyconchgaming). *Toggle markers*
  (Ctrl+Alt+M) switches the marker layer on and off.
- **Markers on the in-game map (experimental).** Hold the game's map key (Tab
  by default, configurable) and the possible exit and gas can locations are
  drawn as small corner brackets over the game's own map, with a legend in the
  Objectives panel; release the key and they are gone. Only that one key is
  read, only while this mode is on and the game is in the foreground; without it
  the corner minimap works exactly as before. Once the app has seen a map during
  a match, the markers for every later press fade in with the game's own map
  instead of appearing a third of a second after it (*Show them the moment I
  press the key*, on by default — switch it off if you would rather never see a
  flash where the map does not open). *Hide the corner overlay* takes the
  corner minimap off screen while this mode is running. Tested at 100 % display scaling
  with the game in Borderless Windowed.
- **Hotkeys that stay out of the way.** The defaults are now Ctrl+Alt+…
  (existing installs are moved over once; anything you changed yourself is
  kept), hotkeys only fire while the game or the app is in the foreground
  (*Only while the game is in the foreground*, on by default), equivalent spellings of a
  combination are recognised as the same one, and hotkeys are suspended while
  you record a new one.
- **Downloadable map packs.** New game maps can arrive without an app update:
  *Check for new maps now* in Settings › General (and an optional check at
  startup) downloads image, detector template and markers, verified by SHA-256.
  A new map gets the next free Ctrl+Alt+number.
- **Check for updates now** button in Settings › General — no restart needed to
  see a new release.
- **Welcome tour** on first run, six short steps, Esc closes it.
- **Lighter.** Map detection (capture and matching) runs in its own process, so
  the app never stalls on it, and an idle tick costs about 1 ms instead of 27;
  the main window is unloaded after 45 s in the tray (*Free this window's memory
  in the tray*); hardware acceleration is now a setting, off by default.
- **Español, Deutsch, Français, Português (Brasil)** next to English and
  Italiano.
- A failed settings write now tells you instead of silently losing the change.
- Note: going back to 0.6.0 or earlier keeps the new Ctrl+Alt+… combinations
  but knows nothing about markers, map packs or the new settings.

### 0.6.0

- **System hotkeys can be switched off.** Settings › Hotkeys has a *Remove key*
  button next to *Edit* and *Reset*: an action you never use (say *Rotate map*,
  Ctrl+R) is no longer registered at all, so the combination goes back to the
  game and every other application instead of having to be parked on some
  out-of-the-way key. The row reads *no key*, the choice survives a restart,
  *Edit* binds it again and *Reset* restores the default.
- **Reset no longer double-books a combination.** If a map or another action
  has taken a hotkey's default in the meantime, *Reset* says so instead of
  putting two things on the same keys.
- The diagnostic report lists a switched-off hotkey as `(unbound)`.
- Note: versions up to 0.5.1 do not know about unbound hotkeys — going back to
  one of them brings the default combination back.

### 0.5.1

- Maintenance release with no functional changes: the first update delivered
  through the new updater window introduced in 0.5.0.

### 0.5.0

- **Updating looks like the app now.** Press *Restart and update* and the window
  becomes an *Updating to X.Y.Z* screen; a small window in the same colours
  takes over, names the step it is on (*Closing the app* → *Removing the
  previous version* → *Installing* → *Starting*), shows a real progress bar, and
  the new version's loading screen comes up in the same place. The Windows
  installer is never seen.
- **It cannot leave you on the old version.** The app does not close until the
  new window has proved it is on screen. If it cannot start — an antivirus
  blocking an unsigned file, a missing file, anything — the plain installer runs
  instead and the update happens exactly as it did before.
- If the install itself fails, the window says what happened in one sentence,
  points at its log, offers the download page and — while the old version is
  still intact on disk — reopens it.
- English and Italian, and it follows the Windows *show animations* setting.
- `updater.log` joins the diagnostic report.

### 0.4.0

- **A new look for the main window.** Same features, same places — restyled:
  warm off-black with a single pumpkin-orange accent, the Geist typeface
  (bundled inside the app, nothing is downloaded), a two-column map gallery
  with an unmistakable *On overlay* flag on the active map, a status dot on the
  auto-detect bar, live values beside the size / opacity / position sliders,
  cleaner hotkey tables, visible keyboard focus everywhere, and animations that
  respect Windows' *reduce motion* setting.
- **Fixed: *Add map hotkey* opened as *Change hotkey*.** After editing a system
  hotkey, the next *Add map hotkey* dialog kept the previous title and hid the
  map picker. It now resets every time it closes.
- Italian: the hotkey-conflict banner now points to *Impostazioni → Hotkey*,
  the tab's actual name.

### 0.3.4

- **The update installer window looks like the app now.** Pressing **Restart and
  update** used to hand you a nameless grey progress box; it now carries the app
  icon, *Updating Halloween Map Overlay…* and *Installing version X.Y.Z — the
  app reopens by itself*, in English or Italian depending on your Windows
  language, so it is obvious what is running and that it will bring the app
  back.

### 0.3.3

- **Auto-detect recognises the civilian map screen.** The game draws the
  <kbd>Tab</kbd> map differently for a civilian than for Michael, and 0.3.2
  only knew Michael's — so in a civilian match the right map was always in
  front but just under the bar it needed to act, and had to be picked by hand.
  All four maps now carry both views, and a map is accepted either
  when it matches strongly *or* when it is clearly ahead of every other map,
  which covers the views no screenshot exists for yet.
- **The overlay clears in the menu even when you picked the map yourself.**
  Up to 0.3.2 that only happened if auto-detect had recognised a map first, so
  after a hand-picked map the overlay stayed up for the rest of the session.
- **A screenshot is enough to teach the detector a view it misses.** Every Tab
  screenshot of a map becomes one of its templates instead of all but the first
  being ignored — see [Auto-detect](#auto-detect-map).
- **The detector log says more about a match it refused**: whether the frame
  was the Tab screen and how bright the map panel was, so a dimmed or
  mis-aligned panel is visible without anyone sending a screenshot.

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
- **Gas can locations** also by **u/deftyconchgaming**, traced from their
  gas-spawn maps. The cellar, gate and car marker positions are read off the
  same author's map images. See [Markers](#markers).
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
