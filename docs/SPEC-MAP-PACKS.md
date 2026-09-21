# SPEC — Map packs

New and corrected maps, delivered without an app release.

Status: implemented (0.7 batch). Code:
`src/shared/map-pack-rules.js` (pure), `src/core/map-pack-store.js` (fs),
`src/core/map-pack-fetch.js` (https), `src/core/map-pack-install.js`
(orchestration), `src/core/map-packs.js` (electron), `scripts/build-pack.js`
(authoring). Tests: `test/map-pack-rules.test.js`,
`test/map-pack-store.test.js`, `test/map-pack-install.test.js`.

---

## 1. Why

*Halloween: The Game* gets new maps far more often than this app gets a
release, and two are already announced. Today adding one means:

1. a PNG in `maps/<creator>/`,
2. `npm run prepare-detector`, which rewrites the single 34k-line
   `src/core/map-detector/templates.json`,
3. **a full app release** — ~93 MB of NSIS installer that every user
   downloads, and an installer run that takes tens of seconds.

Measured on the four bundled maps, the data one map actually needs is:

| part | bytes |
|---|---|
| overlay PNG (`maps/deftyconchgaming/*.png`, 598–608 px square-ish) | 221 339 – 313 356 |
| detector templates (2 variants × 4096 numbers at 3 decimals) | ~48 300 of JSON |
| **one map, total** | **≈ 270–360 KB** |

`templates.json` as committed is **502 787 bytes** for four maps plus the
96×12 menu strip. It is `format: 2`: `templates` is keyed by **catalogue key**
(`deftyconchgaming/East Haddonfield`) and each value is a *list* of variants —
one 64×64 thumbnail per view of the Tab map panel (Michael, civilian, …), each
a flat array of `size * size` = 4096 numbers in 0..1. The detector converts
them to `Float32Array` **once, in its constructor** (`templateVariants`), never
per tick.

So a map's whole share of the app is about a third of a megabyte, and the part
that has to be *keyed* per map is already keyed per map. That is what makes a
pack possible: it is a slice of exactly the two files a map contributes.

## 2. The format

One directory per map. The directory name is **derived from the key by the
app** (`packDirName`: lower-cased, non-alphanumerics folded to `-`), never
taken from the pack.

```
<pack>/
  pack.json        the manifest (below)
  <Map Name>.png   the overlay image
  templates.json   the detector templates for THIS map only
  markers.json     optional, ≤ 64 KB, opaque to this version
```

### `pack.json`

```json
{
  "formatVersion": 1,
  "key": "deftyconchgaming/Silver Shamrock",
  "name": "Silver Shamrock",
  "creator": "deftyconchgaming",
  "credit": "u/deftyconchgaming",
  "version": 1,
  "minAppVersion": "0.7.0",
  "image": "Silver Shamrock.png",
  "markers": "markers.json",
  "files": [
    {"name": "Silver Shamrock.png", "bytes": 254112, "sha256": "…64 hex…"},
    {"name": "templates.json",      "bytes":  48290, "sha256": "…64 hex…"},
    {"name": "markers.json",        "bytes":   1204, "sha256": "…64 hex…"}
  ]
}
```

- `key` — `Creator/Map Name`, exactly one `/`, each half
  `[A-Za-z0-9][A-Za-z0-9 ._'()-]{0,63}` with no leading/trailing space. The
  reserved creator `Custom` is refused: those keys mean "a file in the user's
  own `custom/` folder".
- `version` — a **positive integer**, not a semver. It orders one map's packs
  against each other and nothing else.
- `minAppVersion` — optional. A pack that wants a newer app is skipped, not
  half-installed.
- `name`/`creator` — **derived from the key, never taken from the manifest.**
  They may appear (the generator writes them, and they make the file readable)
  but only spelled exactly as the key spells them; anything else is
  `name-mismatch` / `creator-mismatch`. They were free text in the first draft
  and that was wrong four ways at once: a pack `aaa/Foo` calling itself
  "East Haddonfield" sorts ahead of the real one and hijacks
  `show-map=east haddonfield` and every bare-name lookup; `creator: "Custom"`
  lands in the reserved group with `custom: false`; `creator: "constructor"` or
  `"__proto__"` reached `byCreator[creator] || []` in the renderer's map picker
  and inherited a function from `Object.prototype`, breaking the picker for
  *every* map (fixed there too, with a `Map`, since a `maps/constructor/` folder
  would do the same); and free text is a rendering surface — nothing
  interpolates it raw today, but 58 characters is enough for an `onerror=`
  payload and one future call site that forgets `escapeHtml` would be RCE with
  `nodeIntegration: true`. The key is already the single source for both halves
  (that is how `buildCatalog` derives them for a bundled map from its path), so
  this removes a duplicate rather than a feature. **Renaming a map means
  publishing it under a new key**, exactly as renaming the folder does for a
  bundled one.
- `credit` — optional free text, ≤ 200 characters. Control characters,
  zero-width characters and bidirectional overrides are **stripped** rather
  than refused (`sanitizeText`): a stray `U+200B` is a copy-paste accident, not
  a reason to throw a map away, while a `U+202E` would reverse the rest of a
  line wherever it is shown.
- `files` — every file in the pack **except `pack.json` itself**, with byte
  size and lower-case hex SHA-256. Listing the manifest among the files it
  describes would be circular; it is pinned instead by cross-checking every
  field against the index entry (§3). File names are one segment matching
  `[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}` with a `.png`/`.json` extension — plus the
  module's one **deny**-list: the Windows device stems (`CON`, `AUX`, `NUL`,
  `COM1`…). `CON.png` is not a file on Windows, it is the console; the write
  succeeds, the bytes go nowhere, and the pack would install nothing and be
  retried forever.

### `templates.json`

Byte-for-byte what `scripts/prepare-detector.js` would have put in the bundled
file, restricted to one key:

```json
{"format": 2, "size": 64, "templates": {"<key>": [[0.123, …4096 numbers…], …]}}
```

`size` must equal the matcher's `DEFAULT_SIZE`; every variant must be exactly
`size * size` **finite** numbers in 0..1; at most 8 variants; and the one key
must be the pack's own. `Float32Array.from` turns a `null`, a string or a hole
into `NaN`, and one `NaN` poisons the whole NCC — every map would then score
`NaN` and the detector would silently stop working — so "finite numbers only"
is checked element by element rather than trusted.

### `markers.json` (optional, opaque)

Stored and exposed through the catalogue; **nothing renders it yet**. Validated
only against the documented top-level shape, so a pack can ship markers before
the release that draws them:

```json
{"layers": {"chests": [{"x": 0.41, "y": 0.62}, …]}, "tab": {"sx": …, "sy": …, "tx": …, "ty": …}}
```

≤ 64 KB, ≤ 32 layers, ≤ 512 points per layer, every coordinate finite and in
0..1, layer names `[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}`.

Exposed two ways: the catalogue entry carries `markers: true` so a caller knows
there is something to ask for, and `get-map-markers` (IPC) /
`MapPacks.markers(key)` hand over the parsed object.

## 3. The remote index

`https://raw.githubusercontent.com/Davide-DevP/halloween-map-overlay/main/packs/index.json`

```json
{
  "formatVersion": 1,
  "packs": [
    {
      "key": "deftyconchgaming/Silver Shamrock",
      "version": 1,
      "minAppVersion": "0.7.0",
      "base": "silver-shamrock",
      "files": [{"name": "…", "bytes": 1, "sha256": "…"}]
    }
  ]
}
```

An empty `packs` array is valid and is what the repository holds today.

**Every URL the app requests is derived, never supplied.** `packFileUrl(indexUrl,
base, name)`:

- `base` is normally a *relative* directory, resolved against the index's own
  directory — so it cannot leave the host by construction. Each segment must
  match `[A-Za-z0-9][A-Za-z0-9._-]*`. An absolute `https://…` base is accepted
  but wins nothing: it still has to pass the allow-list.
- `name` must pass `isValidFileName`: one segment, no `/`, `\`, `:` or `..`
  anywhere, ≤ 64 characters, and an extension in `{.png, .json}`.
- the assembled URL is re-checked against the allow-list before it is used.

The allow-list (`isAllowedUrl`) is: **https**, host exactly
`raw.githubusercontent.com`, path starting with
`/Davide-DevP/halloween-map-overlay/`, no port, no credentials, no query, no
fragment, and no `..` in the raw string (`new URL` normalises those away, and a
normalised path that still starts with the prefix would open a socket for a URL
nobody meant). The host alone is not enough — anybody can create a repository on
it, so the path prefix is part of the check.

Note what the prefix does *not* do: GitHub raw serves every commit of every
**fork** under the same `/<owner>/<repo>/` path, so a fork's blob is reachable
through it. The real trust root is one level up — **the index at
`main/packs/index.json` in this repository**, the only document the app ever
starts from. Everything else is pinned to it by SHA-256, so a reachable fork
blob can only be fetched at all if its hash is the one the index published, i.e.
if it is byte-identical to the intended file.

### Caps and timeouts

| thing | cap |
|---|---|
| `index.json` | 256 KB |
| a `.png` | 8 MB |
| `templates.json` (any other `.json`) | 8 MB |
| `pack.json` | 64 KB |
| `markers.json` | 64 KB |
| one pack, all files together | 16 MB |
| packs the index may list | 200 |
| files one pack may list | 8 |
| template variants, bundled + packs together | 48 |
| socket inactivity | 10 s |
| whole request | 30 s |
| the whole check, installs included | 3 min |
| redirects | ≤ 2, each `Location` re-validated against the allow-list |

The size cap is enforced on `content-length` *and* on the running total, so a
server that lies about the length still cannot overrun it.

The **variant** budget is a cost bound on the detector rather than a capacity
plan: a frame that passes the Tab gate costs **~0.10 ms per variant** on top of
a ~6.8 ms fixed cost (re-measured for 1.0 — this said ~2 ms per variant, which
was wrong by 20×; see `docs/agents/detection.md` § Why there is no early exit),
and that file's own rule is that the blocking JS must not grow past ~30 ms per
tick. The full 48 is under 5 ms, but an index listing its 200 packs at 8
variants each (1600 variants) would be ~160 ms in the hot loop, which is what
the cap exists to stop. Bundled maps are never dropped; packs past the budget
are, with a `templates-dropped` log line. Since 0.7 that work happens in the
detector's `utilityProcess` rather than on the main thread, so the budget is no
longer a stutter budget — but it is still one core of the player's CPU, and
`matchMap` is still linear in variants, so the cap stays
(`docs/agents/detection.md`).

The **check deadline** exists because `MapPacks` holds a single-flight flag for
the duration: 200 packs × 4 files × a 30 s per-request timeout is hours, and the
"Check for new maps" button would be dead for all of it. Packs not reached are
`skipped: deadline` and picked up by the next check.

Nothing is sent: a GET of a public file, no query string, no cookies, no
identifier. The only header that says anything is a bare `User-Agent` of
`halloween-map-overlay` — the product name and nothing else, no version and no
platform, which GitHub asks every client for. Deliberately less than the update
check's own user agent.

## 4. Install

1. GET the index, `JSON.parse`, `validateIndex`. A malformed *entry* drops that
   entry (with a logged reason); a malformed *document* drops everything. A
   **404** on the index is neither: it is `notPublished` — the state this
   repository is in until the first pack ships — so it raises no "could not
   check" and does not shorten the retry as if the network were broken.
   `validateIndex` also refuses two entries whose **install directory** would
   collide (§5) and two spellings of one key.
2. `selectPacksToInstall`: install a pack whose version is **higher** than the
   installed one. `up-to-date`, `downgrade` and `needs-app` are normal
   outcomes, not errors. A downgrade is **refused** — the index is a file in a
   git repository and a botched revert must not roll every user's map back.
3. Into a staging directory `userData/map-packs/.staging-<random>/` —
   **inside userData, never `%TEMP%`**. A cross-volume rename is not atomic
   (Windows refuses it outright), and `%TEMP%` is the folder that makes
   Bitdefender's Advanced Threat Defense fire on this project's development
   machine (`docs/agents/updater-and-installer.md`). Nothing in a pack is ever executed, but a download
   belongs next to where it is going.
4. Per pack: GET `pack.json`, cross-check it against the index entry (same key,
   same version, same file list with the same sizes and hashes), then GET each
   listed file, check **length then SHA-256** against the index, validate the
   content, and only then write it. For the image that is: the PNG signature
   (on the bytes, not the name), 64..8192 px per side via `image-size` — which
   is **required**, not optional, since it is the only check that looks at what
   the file claims to be — and `isPlausiblePngBytes`, a trailing `IEND` chunk
   plus a floor of a quarter of a bit per pixel. A 33-byte signature + IHDR
   declaring 8192×8192 passes everything else, installs, and leaves the map
   permanently blank while the next check reports "up to date"; the floor is
   ~155 bytes for a 600×600 map against real files of 221–313 KB, so it can only
   ever catch truncation.
5. `store.commit`: refuse outright if the live directory already belongs to a
   **different key** (§5); otherwise rename it aside to
   `.old-<rand>-<safe-dir>`, rename staging onto the live name, then delete the
   old one. Two renames because Windows refuses to rename onto an existing
   directory; in that order because **a previously installed good version must
   stay** — if the second rename fails the first is undone.
6. Any failure: the staging directory is deleted, the reason is logged, and
   nothing else changed. `fetch` itself is wrapped (`safeFetch`), so a
   transport that throws, answers with a non-object or claims `ok` with no
   buffer is a failed check rather than a thrown one.

Startup housekeeping, and one of the two is **recovery**:

- a `.staging-*` folder is a killed download and is deleted;
- a `.old-<rand>-<dir>` folder carries the directory it came from **in its
  name**. If that directory exists the swap completed and the parked copy is
  the old version, so it goes. If it does **not**, the process died between the
  two renames and this folder is the only copy of that pack — so it is renamed
  back. The first draft named it `.old-<random>` and deleted every one of them,
  which was the one case where "a previously installed good version stays" was
  not true across a crash.

**Nothing from a pack is ever executed.** JSON is read with `fs.readFileSync` +
`JSON.parse`; there is no `require`, no `vm`, no `eval` anywhere near a pack,
and the PNG reaches the renderer as bytes exactly like a bundled map.

An installed pack is **fully re-validated on every start** — including the
**SHA-256 of every listed file**, not just its size. Size alone was a hole: a
`map.png` a power cut or a bad sector zero-filled *in place* keeps its byte
count, so it passed, was offered to the catalogue, and for a pack replacing a
bundled map left that map permanently blank (`imageSize` throws in
`main-window.js` and the `map-change` handler returns quietly) while the next
check reported "up to date" — it could never heal. Hashing ~350 KB per pack at
startup is nothing next to that. A pack that fails falls out of `list()`, which
means two things at once: the **bundled map comes back**, and the pack is not
in the installed set `selectPacksToInstall` compares against, so the next check
**downloads it again**.

## 5. Catalogue precedence

`MapLibrary.getCatalog()` is now

```
mergeCustomMaps( mergeMapPacks( buildCatalog(maps/), installed packs ), custom/ )
```

- **A pack wins over a bundled map with the same key.** A bundled map has no
  version — it is whatever the installed app ships — so any pack claiming its
  key is newer by construction. That is what lets a pack fix a bundled map's
  image, templates or markers.
- **Custom maps are untouched.** Their creator is the reserved `Custom`, which
  `isValidPackKey` refuses, so the two sets cannot collide.
- A pack entry is an ordinary catalogue entry plus `pack` (the install
  directory) and `packVersion`, and it sorts with the project's one
  `sortCatalog`. Nothing downstream special-cases it, which is what makes the
  gallery, the creator filter, `next`/`prev`, the first-run Ctrl+Alt+1..9
  defaults, the hotkey map picker, `show-map=` and the detector all see a pack
  map exactly like a bundled one.

`resolveEntry` picks one of three roots from the entry itself: `custom/`,
`map-packs/<dir>/`, or `maps/`.

**Templates**: `mergeTemplateSources(bundled, packs)` is the same precedence
for `map-detector/templates.json`, applied **once at load** —
`MapDetector.loadTemplates()` at construction and `reloadTemplates()` after an
install. Never on a tick; see *The capture path — do not make it heavier*.

**Both merges fold case.** `mergeTemplateSources` compared keys exactly while
`mergeMapPacks` folded them, so a pack published as
`deftyconchgaming/east haddonfield` replaced the bundled map in the *gallery*
while its *templates* stayed — i.e. the one thing the pack existed to fix (a map
auto-detect keeps missing) was the one thing it could not fix. They now agree,
and the pack's own spelling of the key wins so there is never more than one
entry for one map. `scripts/build-pack.js` refuses such a key outright at
authoring time, telling the author to match the bundled spelling; `validateIndex`
is deliberately *not* given the bundled key list (it is pure and imports
nothing, and the runtime outcome is already correct either way).

### One directory per key, and only one

The install directory is `packDirName(key)`: lower-cased with every
non-alphanumeric character folded to `-`. That means `a/b c`, `a/b-c`, `a/b.c`,
`a/b'c` and `a-b/c` are five different keys with **one** directory. Published
together they reinstalled over each other on *every* check, forever: each saw
the other's manifest, decided its own key was not installed, downloaded,
committed, and made the other map vanish — with a toast and a gallery refresh
each time. Three checks now stop that, at each of the three points where a
directory can be claimed:

- `validateIndex` drops the second entry that maps to an already-seen directory
  (`duplicate-dir`);
- `MapPackStore.commit` refuses when the live directory's manifest names a
  different key (`dir-owned-by-other-key`) — an index is not the only way a
  directory gets there. An *unreadable* manifest is not a claim, so a
  half-written pack can still heal;
- `scripts/build-pack.js` refuses to publish the collision in the first place.

### Why bundled maps are not "built-in packs"

The task asked for one loader if it did not balloon the diff. It would:
bundled maps would need per-map `templates.json` files generated into
`maps/<creator>/<map>/`, `prepare-detector.js` rewritten to emit N files
instead of one (with the menu strip — which is *not* a map — needing a home of
its own), `extraResources` restructured, and the committed 34k-line file
deleted, all of which is a large, risky change to the one thing whose
regression is invisible until someone plays a match. What is shared instead is
the **decision**: one `mergeMapPacks` for the catalogue and one
`mergeTemplateSources` for the templates, both pure and both tested. The
loaders differ (a `require`d JSON vs. a validated read from disk) because the
trust levels differ — and that difference is the point.

## 6. When it runs

- **`checkForMapPacks`**, default `true`, Settings › General next to the
  update-check switch. With it off **no request is made at all**: the gate is
  the pure `shouldCheckPacks`, so the startup check and the button cannot
  disagree about it.
- **At startup, after the window is up** — a `setTimeout` from
  `createWindow()`, deliberately later than the update check's 4 s so the two
  requests do not toast over each other. It never blocks the window.
- **At most once per 24 h**, remembered in `map-packs/state.json` (not in
  `settings-app.json`: this is bookkeeping, and every settings write is an
  `app.log` line). A `lastCheckAt` in the future counts as "now", so a bad
  clock cannot lock the check out for a day.
- **A check that *failed* is retried after an hour**, not tomorrow
  (`RETRY_INTERVAL_MS`). A laptop launched on a train fails in a second and
  writes `lastCheckAt` anyway; without this it would get nothing for the rest of
  the day however long it was online afterwards. "Nothing published yet" (the
  404) is *not* a failure and does not shorten anything.
- **"Check for new maps now"** in Settings › General ignores the interval but
  **not** the setting.
- A newly installed pack toasts (`mapPacks.installedOne` /
  `installedOneBound` / `installedMany`) and the gallery refreshes over
  `map-packs-updated` → `Maps.invalidateCache()`. No restart.

### A number key for a map that arrived later

`hotkeys.json` is written exactly once, by `ensureDefaultMapHotkeys`, so a
downloaded map used to get no `Ctrl+Alt+N` ever: the file already existed by the
time the pack landed, and the first-run defaults had gone to the maps that
shipped in the build. A map arriving a week later was a second-class map
forever — including on the very first start, where the pack check finishes after
`loadKeys()` has already written the file.

`MapPacks.assignHotkeys` now offers one, for each installed key that was **not
already in the catalogue** (a pack merely *replacing* a bundled map is not a new
map and keeps that map's binding). The decision is the pure
`planPackMapHotkey` in `shared/hotkeys-rules.js`; `Hotkeys.assignPackMapHotkey`
does the writing, through the **single** `hotkeys.json` writer, and reports a
failed write with the same `hotkeys.error.saveFailed` toast as a hotkey saved by
hand. `loadKeys()` runs once for however many maps arrived.

Four rules, each because the alternative is worse:

1. **No file, no offer.** A missing `hotkeys.json` means `loadKeys()` has not
   run its first-run write yet, or that write failed. Writing here would race it
   or leave a file holding only the pack map, which `ensureDefaultMapHotkeys`
   would then never fill in — and the pack map is in the catalogue, so the
   ordinary first-run path gives it a number anyway.
2. **An existing but empty file means "I cleared them."** A user who deleted
   every map binding has said what they want; a new map must not re-arm a global
   accelerator behind them.
3. **One offer per map, ever**, remembered in `map-packs/state.json`
   (`offeredHotkeys`) rather than in `hotkeys.json`, because the whole point is
   that a binding the user *deleted* must not come back on the next start.
4. **It can never create a conflict.** The candidate goes through the project's
   normalised comparison (`ownAcceleratorKeys`) against every *bound* system
   hotkey and every entry already in the file, so a user who put Ctrl+Alt+3 on
   something themselves gets 4, `ctrl+alt+3` and `CommandOrControl+Alt+3` count
   as one combination, and an unbound system action does not reserve a slot. A
   full number row is simply no offer.

The user is told which key it is (`mapPacks.installedOneBound`): binding a
*global* accelerator silently would be the kind of surprise this app does not
do.

## 7. Logging and privacy

- **A pack's key is logged in full, like a shipped map's.** The logging rule
  (`docs/agents/diagnostics.md`) is that a *custom* map's key is user text and becomes `Custom/(custom)`. A
  pack's key is not user text: it is catalogue data from a manifest published
  in this project's own repository, and `isValidPackKey` restricts it to a
  narrow character set with no newlines and no `=`, so it is safe in a `k=v`
  line. Which pack failed, and why, is the only thing that makes "the new map
  never arrived" answerable. Packs may not claim the `Custom` creator, so this
  can never become a way to launder a user-typed name into the log.
- `app.log` events: `map-pack-check`, `map-pack-rejected`,
  `map-pack-installed`, `map-pack-failed`, `map-pack-sweep`,
  `map-pack-hotkey`. `detector.log` gains `templates-reloaded` and
  `templates-dropped`.
- `system.txt` in the diagnostic report gains a `[map packs]` section: the
  setting, the last check time and result, every installed pack's key and
  version, and every folder that failed validation with its reason.
- Nothing about the user is sent, ever. The renderer's CSP stays
  `connect-src 'none'`; all of this is in the main process.

## 8. Authoring

```bash
npm run build-pack -- \
  --key "deftyconchgaming/Silver Shamrock" \
  --image maps-src/silver-shamrock-overlay.png \
  --fixture detection-fixtures/tab-silver-shamrock.png \
  --fixture detection-fixtures/tab-civilian-silver-shamrock.png \
  [--markers markers/silver-shamrock.json] \
  [--credit "u/deftyconchgaming"] [--version 2] [--min-app 0.7.0] [--dry-run]
```

It reuses `prepare-detector.js`'s own `buildVariantsForKey` (the same
`locatePanel` + `downsample` that builds the bundled templates) and validates
the finished pack with the **runtime's** `map-pack-rules.js` before writing
anything: if the app would refuse the pack, the script refuses to publish it.
Then commit `packs/` and push — GitHub raw serves it, and nothing else
publishes anything. `--dry-run` does everything except write.

Since 1.0 it also **measures the new map's Tab panel against every map a user
could already hold** — the bundled templates plus every pack already in
`packs/`, in both directions — prints the cross-score matrix, and warns when a
pair reaches 0.70. That is a **review gate only**: the pack format is unchanged,
nothing is recorded and nothing is refused, because the failure it catches is an
authoring one (the same map published twice under two keys). See
`docs/agents/detection.md` § Map similarity is a build-time check and
`docs/agents/maps-authoring.md` § When two maps score alike.

`--version` defaults to "one more than the index already has", and a version
that is not newer is refused, because the app refuses a downgrade and
re-publishing the same number would be a silent no-op.

There is no `--name` or `--creator`: both come from `--key`, and passing them is
an error rather than something quietly ignored. The script also refuses a key
that shares an install directory with one already in the index, and a key that
differs from a **bundled** map's only by case.

## 9. Testing without publishing

`checkForPacks` takes its index URL and its `fetch` as arguments, so a local
index is a two-line change in `src/core/map-packs.js` (`indexUrl` + a `fetch`
that reads from disk) — see the manual-test checklist. The allow-list is
deliberately strict enough that a `file://` or `http://localhost` URL is
refused, which is the correct behaviour in the shipped product; a local test
therefore replaces the `fetch` function, not the URL alone.

`map-pack-fetch.js` itself has the same shape one level down: the **transport**
is injectable (`opts.request`, defaulting to `https.get`), so
`test/map-pack-fetch.test.js` drives the redirect, cap, lying-`content-length`
and timeout paths against a fake request object with no network and no local
server. The URLs in those tests are real allowed URLs and `isAllowedUrl` runs on
every one of them — the seam is the socket, not the policy. A server on
`127.0.0.1` would have needed a hole in the host allow-list, which is exactly
what must not exist.
