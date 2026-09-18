# Building

```bash
npm install
npm run prepare-maps   # only when maps-src/ or the icon changed
npm run build:win      # runs build-updater first, then electron-builder
```

## Prerequisite: the .NET Framework 4 compiler (Windows only)

`npm run build-updater` compiles the themed updater window
(`updater/*.cs` → `build/updater/hmo-updater.exe`) with the C# compiler that
ships **inside Windows**:

```
%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
```

No Visual Studio, no .NET SDK, no NuGet, no msbuild — and nothing for the user
to install either, because the WPF assemblies it links against are part of the
.NET Framework 4.x that Windows 10 and 11 already have. If that `csc.exe` is
missing the script fails loudly and by name; `.github/workflows/release.yml`
checks for it in a step of its own so a runner without it cannot produce a
release whose installer quietly has no updater in it.

`build`/`build:win` run it first. Its output is git-ignored
(`build/updater/`, `build/.updater-obj/`) and reaches the installer through
`build.extraResources` as `resources/updater/`.

Looking at the window without building an installer:

```bash
node scripts/build-updater.js
build/updater/hmo-updater.exe --demo --version 0.5.1 --lang it --bounds 200,150,1000,720 --log %TEMP%\u.log
build/updater/hmo-updater.exe --demo-fail --lang en --bounds 200,150,560,380 --log %TEMP%\u.log
```

`--demo` is a ~12 s simulation of the real run; `--demo-fail` ends in the error
state. Add `--screenshot <path> [--screenshot-after <ms>]` and the window
renders itself to a PNG with `RenderTargetBitmap` and exits — that is how the
design was compared against the app's own loading overlay, frame by frame.
Both switches are debug-only and neither is ever passed by the app.

Output lands in `dist/`:

| File | What it is |
|---|---|
| `Halloween Map Overlay Setup <version>.exe` | NSIS installer (one-click, per-user; see AGENTS.md for the customised installer window) |
| `Halloween Map Overlay <version>.exe` | Portable single executable |
| `win-unpacked/` | The unpacked app, useful for inspecting a build |

`win-unpacked/resources/updater/` holds `hmo-updater.exe`, `fonts/` (the static
Geist TTFs plus their OFL text) and `icon.png`. If that folder is missing the
app still updates — it just falls back to the plain Windows installer.

The maps are **not** inside `app.asar`. electron-builder copies them via
`extraResources`, so they end up at `resources/maps/<Creator>/<Map>.png` next to
the asar, and `src/core/map-library.js` reads them from `process.resourcesPath`
when `app.isPackaged` is true.

## Verified on this machine

`npm run build:win` completed successfully on Windows 11 Pro (10.0.26200) with
Node.js 24.19.0, npm 11.17.0, electron 40.10.6 and electron-builder 26.15.3,
producing both targets and `resources/maps/deftyconchgaming/*.png` in the unpacked
build. No code-signing certificate is configured, so electron-builder falls back
to an unsigned build — that is expected and not an error.

## Known environment problems

These did not occur here, but they are the usual ones on Windows:

### `Cannot create symbolic link ... winCodeSign`

electron-builder unpacks its `winCodeSign` helper into
`%LOCALAPPDATA%\electron-builder\Cache\winCodeSign`, and that archive contains
symlinks. Creating symlinks on Windows needs either Developer Mode or an
elevated shell. Fixes, cheapest first:

1. Turn on **Settings → System → For developers → Developer Mode**, then retry.
2. Run the build from an **Administrator** terminal.
3. Delete `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign` and retry — a
   partially extracted cache reproduces the error every time.

### First build is slow / times out

The first run downloads the Electron zip, NSIS and 7-Zip into
`%LOCALAPPDATA%\electron-builder\Cache`. Allow several minutes and do not
interrupt it; a half-downloaded cache entry has to be deleted by hand before the
next attempt will work.

### `npm install` did not run the install scripts

npm 11 gates package install scripts. If `node_modules/electron/dist/` is empty,
approve them explicitly:

```bash
npm approve-scripts electron
npm rebuild electron
```

### The app starts but shows no maps

`maps/` has not been generated yet. Run `npm run prepare-maps`.
