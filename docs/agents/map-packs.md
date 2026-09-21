# Map packs — a map without a release

[← AGENTS.md](../../AGENTS.md) · **Read before** touching `src/core/map-packs.js`,
`map-pack-store.js`, `map-pack-install.js`, `map-pack-fetch.js`,
`src/shared/map-pack-rules.js`, `scripts/build-pack.js` or anything in
`packs/`.

Spec: `docs/SPEC-MAP-PACKS.md`. The procedure in
[maps-authoring.md](maps-authoring.md) ships a map in the **next
release** (~93 MB for every user). A *pack* is the same map's data — the PNG
(~300 KB) and that one map's templates (~48 KB, measured: `templates.json` is
503 KB for four maps × 2 variants of 4096 numbers) — published in `packs/` and
downloaded on its own. `npm run build-pack -- --key … --image … --fixture …`
reuses `prepare-detector.js`'s `buildVariantsForKey` and validates the result
with the runtime's own `shared/map-pack-rules.js` before writing: if the app
would refuse the pack, the script refuses to publish it.

## The trust root

`PACK_HOST` + `PACK_PATH_PREFIX` pin the requests to one host under one
repository path, but note what the prefix does **not** do: GitHub raw serves
every commit of every *fork* under the same `/<owner>/<repo>/` path, so a fork's
blob is reachable through it. The real trust root is one level up — the index at
`main/packs/index.json` in this repository, the only document the app ever
starts from. Everything else is pinned to it by SHA-256, so a reachable fork
blob can only be fetched if its hash is the one the index published, i.e. if it
is byte-identical to the intended file. Never loosen the prefix on the grounds
that "the hash protects us": the prefix is what keeps a socket from opening to
an unrelated repository at all.

## The rules

- **Everything a pack carries is untrusted, and every rule is an allow-list.**
  One host (`raw.githubusercontent.com`) under one path prefix, https only; a
  pack supplies a *name*, never a URL, and `packFileUrl` derives the URL from
  the index's base; `.png`/`.json` only; size + SHA-256 of every file checked
  against the index before it is written; hard caps (index 256 KB, image 8 MB,
  templates 8 MB, pack 16 MB, 48 template variants in total, 3 min for the whole
  check) and two timeouts. `probeImage` is **mandatory**, and an image must also
  pass `isPlausiblePngBytes` — a 33-byte signature+IHDR claiming 8192² passes
  every other check, installs, and leaves the map blank forever. **Nothing from
  a pack is ever executed** — `JSON.parse` only, no `require`, no `vm`.
  `name`/`creator` are **derived from the key**, never taken from the manifest
  (a pack calling itself another map's name hijacks every bare-name lookup;
  `creator: "constructor"` broke the renderer's map picker for every map).
  `isValidFileName` carries the file's **one deny-list**,
  `WINDOWS_RESERVED_STEMS`: `CON.png` is not a file on Windows but the console,
  so `writeFileSync` succeeds and writes nowhere, the size check afterwards
  fails, and such a pack installs nothing and is retried forever. The charset
  allow-list cannot express it — they are ordinary letters.
  `UNSAFE_TEXT` (controls, zero-width formatters, bidi overrides and isolates,
  BOM) is spelled with `\u` escapes, **never the literal characters**: written
  out in raw bytes it put NUL and C1 bytes in the file, git classified the
  project's one security validator as **binary** (`Bin 0 -> 52314 bytes`, i.e.
  unreviewable diffs), and any text-normalising tool could have dropped a range
  out of the middle of the class and silently stopped filtering it. A test
  asserts `map-pack-rules.js` is pure ASCII.
- **A pack that fails anything is discarded whole and the previously installed
  good version stays.** That is why `store.commit` parks the live directory
  aside as `.old-<rand>-<dir>` — the directory is **in the name** so a `sweep()`
  after a crash between the two renames renames it *back* rather than deleting
  it — and why the staging directory is **inside userData**, never `%TEMP%` (a
  cross-volume rename is not atomic, and see the Bitdefender trap in
  [updater-and-installer.md](updater-and-installer.md)).
  An installed pack is re-validated on **every start**, **SHA-256 of every file
  included**: the size alone passed a `map.png` a power cut had zero-filled in
  place, which left a replaced bundled map permanently blank while the next
  check said "up to date". A pack that fails falls out of `list()`, so the
  bundled map comes back *and* the next check re-downloads it.
- **Precedence: a pack wins over the bundled map with the same key**, so a pack
  also *fixes* a shipped map. Custom maps cannot collide — `isValidPackKey`
  refuses the reserved `Custom` creator. One pure merge for the catalogue
  (`mergeMapPacks`, given `sortCatalog`) and one for the detector
  (`mergeTemplateSources`), **both folding case** (they disagreed, so a pack
  published as `…/east haddonfield` replaced the gallery entry and left the bad
  templates), so the gallery, next/prev, the first-run
  Ctrl+Alt+1..9, the hotkey picker, `show-map=` and the matcher all see a pack
  map as an ordinary one. Bundled maps are deliberately *not* re-shaped into
  built-in packs — that would mean per-map template files, a rewritten
  `prepare-detector.js` and a restructured `extraResources` for no behavioural
  gain; the *decisions* are shared instead, the loaders are not, because the
  trust levels differ.
- **One directory per key, checked three times.** `packDirName` folds
  punctuation, so `a/b c`, `a/b-c`, `a/b.c` and `a-b/c` share one directory and
  reinstalled over each other on every check forever. `validateIndex`
  (`duplicate-dir`), `store.commit` (`dir-owned-by-other-key`, since an index is
  not the only way a folder gets there) and `build-pack.js` each refuse it.
  `build-pack.js` also refuses a key that differs from a **bundled** map's only
  by case: the merges fold case, so it would replace that map while the gallery
  showed the pack's spelling — a pack meant to *fix* a map would also rename it.
  Matching the bundled spelling exactly is always what was meant.
- **Templates are merged once at load**, `MapDetector.loadTemplates()` /
  `reloadTemplates()`, never on a tick. See "The capture path"
  ([detection.md](detection.md)). Packs past the
  48-variant budget are dropped with a `templates-dropped` line: every variant
  is scored on every gated-in frame. **Measured: ~0.10 ms per variant** against
  a ~6.8 ms fixed cost, so the full budget is under 5 ms — the cap is there to
  stop an index of 200 packs at 8 variants each (160 ms a tick), not because
  one extra map is expensive. This paragraph used to say ~2 ms per variant,
  which was wrong by 20×; the measurement is in
  [detection.md](detection.md) § Why there is no early exit.
- **`build-pack.js` measures a new map against every map a user could already
  hold** and warns when a pair scores 0.70 or more — a map that is really an
  existing one re-cut belongs under that map's key as a new version, not as a
  second gallery entry. It is a **review gate only**: nothing is recorded in
  the pack, nothing in the index, and no runtime behaviour depends on it, so
  the pack schema is unchanged. [detection.md](detection.md) § Map similarity
  is a build-time check, and [maps-authoring.md](maps-authoring.md) § When two
  maps score alike.
- **`checkForMapPacks`** (default true). Since 1.0 it has no switch of its own:
  it is half of *Settings › General › Check for updates automatically*
  (`settingsForNewsCheck`, which always writes both keys). With it off **no
  request is made by itself**: the gate is the pure `shouldCheckPacks`, which
  the startup timer *and* the *Check now* button both go through, so they cannot
  disagree. The one exception is that button: `force` overrides the setting as
  well as the interval (reason `manual` rather than `forced`), because the click
  *is* the consent and there is no map-pack switch left to send the user to —
  the same rule `planManualUpdateCheck` has always applied to the app's own
  update check. That is why `mapPacks.disabled` is gone: it could only ever be
  shown about a switch that no longer exists. The renderer holds the *Check now*
  button down for **both** halves of the click (`Options.checkingNow`, cleared
  in a `finally`): it used to come back during the 2.6 s pause that separates
  the two toasts, and a second click there started a second flow whose pack
  check answered `busy` with nothing on screen to say so. At most once per 24 h — **one hour after a check that
  failed**, or a launch with no network burns the whole day's slot — remembered
  in `map-packs/state.json`, not in `settings-app.json`, because every settings
  write is an `app.log` line and this is bookkeeping. A **404 on the index** is
  `notPublished`, a quiet distinct state, not a failure: that is what the
  repository looks like until the first pack ships.
- **A map a pack adds gets the next free Ctrl+Alt+N** (`planPackMapHotkey`,
  pure; `Hotkeys.assignPackMapHotkey` writes through the one `hotkeys.json`
  writer). `hotkeys.json` is written once, so before this a downloaded map never
  got a number at all. Only for a key the catalogue did not already hold; never
  when the file is absent (the first-run write owns that) or **present and
  empty** ("I cleared them"); once per map ever, remembered as
  `offeredHotkeys` in the pack state file so a binding the user deleted cannot
  come back; and normalised against every bound system hotkey and every existing
  entry so it can never conflict. The toast names the key
  (`mapPacks.installedOneBound`) — binding a global accelerator silently would
  be a surprise.
- **A pack's key IS logged in full, like a shipped map's.** The
  "custom maps are `(custom)`" rule is about *user text*; a pack key is
  catalogue data from this project's own repository and `isValidPackKey` keeps
  it to a charset with no newline and no `=`. "The new map never arrived" is
  otherwise unanswerable. `system.txt` gains a `[map packs]` section.

See also: [maps-authoring.md](maps-authoring.md) (the in-release procedure a
pack short-circuits), [detection.md](detection.md) ("The capture path" and the
template budget), [hotkeys.md](hotkeys.md) and
[markers-and-tab-mode.md](markers-and-tab-mode.md).
