# Building

```bash
npm install
npm run prepare-maps   # only when maps-src/ or the icon changed
npm run build:win
```

Output lands in `dist/`:

| File | What it is |
|---|---|
| `Halloween Map Overlay Setup <version>.exe` | NSIS installer (not one-click; install dir can be changed) |
| `Halloween Map Overlay <version>.exe` | Portable single executable |
| `win-unpacked/` | The unpacked app, useful for inspecting a build |

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
