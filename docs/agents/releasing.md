# Releasing

[← AGENTS.md](../../AGENTS.md) · **Read before** tagging, touching
`.github/workflows/release.yml`, or changing `version` in
`package.json`.

`.github/workflows/release.yml` runs on a pushed `v*` tag only — nothing is
published by an ordinary push to `main`. It runs `npm ci`, `npm test`, then
`npx electron-builder --win --publish always` with the workflow's own
`GITHUB_TOKEN` (needs `permissions: contents: write`).

The NSIS build shape (`oneClick`, `perMachine`, the `compression`
measurement) is load-bearing for the update flow and is written out in
[updater-and-installer.md](updater-and-installer.md).

**The procedure, in order. Nothing else publishes anything.**

```bash
# 1. bump "version" in package.json — say to 0.2.1
npm test                              # must be green; the workflow reruns it
git commit -am "Release 0.2.1"
git push                              # publishes nothing on its own
git tag v0.2.1                        # the tag MUST be "v" + package.json version
git push --tags                       # this, and only this, triggers the release
```

The tag must equal `v` + the `package.json` version. electron-builder derives
the GitHub release name from `package.json`, **not** from the pushed tag, so a
mismatch uploads the artifacts to a release whose name disagrees with the app.
`build.publish.releaseType` is `"release"`, so the release is published rather
than left as a draft (electron-builder's default is `draft`, which
electron-updater ignores and which shows nothing on the Releases page). Watch
the run before telling anyone to download.

Gotcha: the very first push, the one `gh repo create --source . --push` makes,
is rejected if it contains a workflow file — *"refusing to allow an OAuth App
to create or update workflow `.github/workflows/release.yml` without `workflow`
scope"* — even though an ordinary `git push` of the same file to the
now-existing repo goes through with the same token. If it bites again, push the
first commit without `.github/`, then commit and push the workflow separately.
Should a later push hit the scope wall for real:
`gh auth refresh -h github.com -s workflow` (needs a browser confirmation from
the account owner).

The workflow has run for every release since 0.2.x. Still watch each run before
telling anyone to download.
