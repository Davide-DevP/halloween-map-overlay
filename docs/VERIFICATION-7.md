# Verification 7 — 0.3.4 one-click installer window (`build/installer.nsh`) (independent review)

Reviewed HEAD `f962605` (= `origin/main`, version 0.3.4), commit `f962605`
"Give the one-click installer the app's own face" (AGENTS.md, README.md,
`build/icon.ico`, `build/installer.nsh`, `docs/BUILD.md`, `package.json`).
Nothing in the commit message, AGENTS.md or the `.nsh` comments was taken on
trust: every claim below was re-derived from the electron-builder 26.15.3
templates in `node_modules/app-builder-lib`, a dump of the `RT_DIALOG` in
`SpiderBanner.dll`, a scratch build into
`%TEMP%\hmo-verify-034` (not `dist/`), and the inflated NSIS header of the
built `Setup.exe`. No installer was run; no process was killed; the owner's
installed 0.3.3 and its userData were not touched. No project file was
modified except this one; no commit, tag or push. Scratch scripts
(`peres.js`, `nsishdr.js`) live in the session scratchpad.

## Verdict: **SHIP WITH FIXES** — one non-installer fix (package-lock root version); the installer change itself is correct

The `customCheckAppRunning` override reproduces the stock app-running check
exactly (it *inserts* the two stock macros rather than copying them), the
banner code is a guarded no-op when the banner is absent, the uninstaller gets
the stock behaviour, the build compiles under `-WX`, all eight strings and the
icon are in the produced installer, and nothing on the 0.3.3 → 0.3.4
self-update path (`--updated --force-run`, non-silent, same `APP_GUID`, same
`$INSTDIR`) changed except the two text lines and the icon. The one FAIL is
`package-lock.json`, whose root `version` lines (3, 9) still say 0.3.3 while
`package.json:3` says 0.3.4; every previous release bumped both. `npm ci
--dry-run` on a copy of the pair exits 0, so the release workflow would not
break — it is a hygiene fix, not a blocker.

## Checks

| # | Check | Result | Evidence |
|---|---|---|---|
| 1a | `customCheckAppRunning` inserts the same two macros as the stock default branch, same order | PASS | `build/installer.nsh:118-119` = `IS_POWERSHELL_AVAILABLE`, `_CHECK_APP_RUNNING`; stock `include/allowOnlyOneInstallerInstance.nsh:40-41`. Both are `!insertmacro` of the stock definitions (`:45-62`, `:105-164`), not copies, so process detection, the `MB_OKCANCEL` / `MB_RETRYCANCEL` dialogs with their `/SD IDOK` / `/SD IDCANCEL` silent defaults, the `${isUpdated}` sleeps (300 ms, 1000 ms), `KILL_PROCESS` soft then forced, and the `$R1 > 1` retry limit are byte-identical. |
| 1b | `$CmdPath` / `$PowerShellPath` still set before the override runs | PASS | `allowOnlyOneInstallerInstance.nsh:33-36` run unconditionally inside `CHECK_APP_RUNNING` before the `!ifmacrodef customCheckAppRunning` branch at `:37`. |
| 1c | `Var pid` and `getProcessInfo.nsh` provided exactly once | PASS | Stock guard `!ifmacrondef customCheckAppRunning` (`allowOnlyOneInstallerInstance.nsh:5-8`) is now false; `build/installer.nsh:64-65` supplies both. `getProcessInfo.nsh` is also self-guarded (`GETPROCESSINFO_INCLUDED`, `:15`). A duplicate `Var` would have failed the `-WX` build (`NsisTarget.js:514`); the build passed. The custom include is `!include`d in the generated preamble after `!addincludedir <templates>/include` (builder-debug.yml lines 44, 92-93; `NsisTarget.js:578,602-603`), so the include resolves and the macro is defined before `installer.nsi:11` includes `allowOnlyOneInstallerInstance.nsh`. |
| 1d | Uninstaller branch (`BUILD_UNINSTALLER`) keeps the stock behaviour | PASS | `build/installer.nsh:105` wraps the banner code in `!ifndef BUILD_UNINSTALLER`; the uninstaller's `un.checkAppRunning` (`uninstaller.nsh:1-3`) therefore expands to `IS_POWERSHELL_AVAILABLE` + `_CHECK_APP_RUNNING` only. `getProcessInfo.nsh:151-155` defines `un._GetProcessInfo` under `BUILD_UNINSTALLER`. Build log: `Halloween Map Overlay Setup 0.3.4.__uninstaller.exe` produced and signed. |
| 1e | Registers touched by the new code do not leak into the stock check | PASS | Banner code uses `$R4-$R7` (`installer.nsh:87-100`); `${isUpdated}` clobbers `$R9` (`nsisScriptGenerator.js:30-38`), which the stock check already does (`:108,115`). Nothing after `CHECK_APP_RUNNING` in `installSection.nsh` reads `$R4-$R9` before writing it (`installUtil.nsh:13,194,213`). |
| 2a | Eight `LangString`s, 4 ids × 2 languages, each (id, lang) once | PASS | `installer.nsh:71-81`; `grep LangString \| sort \| uniq -c` gives 2 per id. `hmo*` prefix collides with none of the nine stock ids in `templates/nsis/messages.yml` (`win7Required, x64WinRequired, appRunning, appCannotBeClosed, installing, areYouSureToUninstall, decompressionFailed, uninstallFailed, appClosing`). |
| 2b | Only languages in `installerLanguages` referenced; `${LANG_ENGLISH}` / `${LANG_ITALIAN}` exist at that point | PASS | `package.json:62-65` = `en_US, it_IT`; `nsisLang.js:15-31,58` emits `MUI_LANGUAGE "English"` / `"Italian"` (builder-debug.yml 88-89; `langs.js:321` `it: "Italian"`, `:153` `it_IT: 1040`). `MUI_LANGUAGE` → `Localization.nsh:42 LoadLanguageFile` defines `LANG_ITALIAN` (= 1040, `Italian.nlf` header). `customHeader` is inserted at `installer.nsi:45-47`, after `!insertmacro addLangs` at `:43`. No `DISPLAY_LANG_SELECTOR` (only when `displayLanguageSelector === true`, `NsisTarget.js:483`). |
| 2c | `${VERSION}`, `${PRODUCT_NAME}`, `${isUpdated}` are real | PASS | `NsisTarget.js:164` `PRODUCT_NAME`, `:168` `VERSION: appInfo.version`; `isUpdated` from `scriptGenerator.flags(["updated", ...])` `NsisTarget.js:579` → `!define isUpdated` testing `--updated` via `${StdUtils.TestParameter}` (`nsisScriptGenerator.js:30-38`). |
| 2d | File is what `-INPUTCHARSET UTF8` (`NsisTarget.js:515`) expects | PASS | `build/installer.nsh`: valid UTF-8, no BOM (first bytes `3b 20 48`). The `…` / `—` strings come out of the built header as correct UTF-16LE (check 4). |
| 3a | Banner lookup mirrors the template | PASS | `installer.nsh:87-88` = `installSection.nsh:25-26` (first `#32770` child of `$HWNDPARENT`, then its next sibling). Runs at `installSection.nsh:33`, after `SpiderBanner::Show` at `:20` and inside the same non-silent section. |
| 3b | Control ids 1000 / 1002 exist in SpiderBanner dialog 104 | PASS | Dumped `nsis-resources-3.4.1/plugins/x86-unicode/SpiderBanner.dll`: one `RT_DIALOG`, id 104, DLGTEMPLATEEX 254×78 dlu, 5 items: `1001 msctls_progress32 10,59 234x11`; `1002 static 40,22 204x11`; `1000 static 40,10 204x11 "Installing, Please Wait..."`; `1025 static SS_ICON (style 0x50000003) 10,10 20x20`; `1003 static 10,38 234x18`. Matches the AGENTS.md table exactly. |
| 3c | Guarded for silent mode and the uninstaller; no-op if the banner is missing | PASS | `installer.nsh:105-113`: `!ifndef BUILD_UNINSTALLER`, `!ifdef ONE_CLICK`, `${IfNot} ${Silent}`. `:89 ${If} $R4 != 0` skips everything when `FindWindow` returns 0; `GetDlgItem` / `SendMessage` set no error flag and `SendMessage` to HWND 0 is a harmless failure. No `Abort`, `Quit` or `IfErrors` in the path. |
| 4a | Scratch build exits 0 under `-WX` | PASS | `npx electron-builder --win nsis --publish never --config.directories.output=%TEMP%/hmo-verify-034` → `exit=0`; electron-builder 26.15.3; `dist/` untouched (timestamps predate the build); `git status` clean afterwards. |
| 4b | Strings and icon names present in the built installer | PASS | `NullsoftInst` firstheader at 0x14E00, header block compressed 8463 → 60892 bytes via `inflateRawSync`. FOUND (UTF-16LE): all 8 `hmo*` strings with `0.3.4` substituted, `installerHeaderico.ico`, `uninstallerIcon.ico`, stock `Installing, please wait...` and `Attendere prego. Installazione in corso...`, `Halloween Map Overlay 0.3.4`. Absent: German/Spanish/French stock messages. |
| 4c | Installer icon is `build/icon.ico` | PASS | `Setup.exe` `RT_GROUP_ICON` id 103: 7 entries 16→256 px, 32 bpp, byte sizes 864/1401/1857/3336/4396/10867/24156 — identical to `build/icon.ico`'s 7 entries. |
| 4d | Portable target (also built by the release workflow's `--win`) still compiles with the new `nsis` options | PASS | `npx electron-builder --win portable --publish never` into `%TEMP%\hmo-verify-034-portable` → `exit=0`, `Halloween Map Overlay 0.3.4.exe` (282626628 B) signed. The custom include is skipped for portable (`NsisTarget.js:596-605`, `!this.isPortable`), so `installerLanguages` is the only new option it sees. |
| 5a | `oneClick: true`, `perMachine: false`, `allowToChangeInstallationDirectory: false` | PASS | `package.json:58-60`. `installerHeaderIcon` only applies under `oneClick` (`NsisTarget.js:406-416`). |
| 5b | `differentialPackage` not disabled | PASS | Not set in `package.json`; `Halloween Map Overlay Setup 0.3.4.exe.blockmap` (291181 B) produced. |
| 5c | `publish.releaseType: release` | PASS | `package.json:74`. |
| 5d | Version 0.3.4 in `package.json` **and** lock root lines | **FAIL** | `package.json:3` = 0.3.4; `package-lock.json:3` and `:9` = 0.3.3. Every earlier release bumped both (`14d87b7`, `a401971`, `ce4d5f6`, `510796c`). See finding F1. |
| 5e | `build/icon.ico` committed and valid | PASS | `git ls-files build/` lists it; ICO type 1, 7 entries (16, 24, 32, 48, 64, 128, 256 px, all 32 bpp, all PNG-compressed), 46995 bytes; offsets contiguous. |
| 5f | `.github/workflows/release.yml` unchanged by this change | PASS | Not in `f962605`'s file list. (It did change in `e04e20e`, dash-named upload staging — reviewed in VERIFICATION-6, unrelated to the installer.) Workflow still `npm ci` → `npm test` → `npx electron-builder --win --publish never` → `gh release upload`. |
| 6a | `npm test` | PASS | 279 tests, 279 pass, 0 fail (8.1 s). |
| 6b | `HEAD == origin/main`, tree clean | PASS | Both `f962605e3a876c3373148a4fd1de6d36645ae0a4` after `git fetch`; `git status --short` empty before and after the scratch build. |
| 7a | Self-update path (`--updated --force-run`, non-silent, idle priority) | PASS | `src/core/main-window.js:565` passes exactly those args. In the installer the only new code on that path is `hmoBannerText` (two `WM_SETTEXT`s), executed before the unchanged stock check; `${isUpdated}` selects the "Updating…" wording. Relaunch: `RUN_AFTER_FINISH` still defined (`runAfterFinish` not set, `NsisTarget.js:408-410`) → `installSection.nsh:93-97`. |
| 7b | Language restriction vs the `/S` path | PASS | `/S` skips `SpiderBanner::Show` and the banner code (`${IfNot} ${Silent}` in both). The only effect of `installerLanguages` is the language table set; `/SD` defaults in the stock check are unchanged. Behaviour note in F2. |
| 7c | Icons do not alter `APP_GUID` or the install dir | PASS | `APP_GUID = options.guid \|\| UUID.v5(appInfo.id)` (`NsisTarget.js:159`); `appId` `com.halloweenthegame.mapoverlay` (`package.json:24`) unchanged since v0.3.3 (`git diff v0.3.3 HEAD -- package.json` touches only `version` and the `nsis` block). `$INSTDIR = $LocalAppData\Programs\${APP_FILENAME}` (`multiUser.nsh:30,47`), `APP_FILENAME` from the unchanged `productName` (`NsisTarget.js:166`). Icons only feed `MUI_ICON`/`MUI_UNICON`/`HEADER_ICO`/`UNINSTALLER_ICON` (`:197-198,414,469-470`). Same GUID → `uninstallOldVersion` finds the 0.3.3 key and upgrades in place. |

## Findings (most severe first)

**F1 — CONFIRMED (low): `package-lock.json` root version not bumped.**
`package-lock.json:3,9` say `0.3.3`; `package.json:3` says `0.3.4`. The
project's own convention (all four previous version commits) is to bump both.
Verified on a copy of the pair that `npm ci --dry-run --ignore-scripts` exits
0, so CI's `npm ci` will not fail; but the next `npm install` on any machine
will rewrite the lock as a side effect of an unrelated change.
Fix: `npm install --package-lock-only` (or edit the two lines), commit before
tagging `v0.3.4`.

**F2 — CONFIRMED (informational, intended): non-English/Italian Windows now
gets the stock installer dialogs in English.** Before this change
`installerLanguages` was unset, so electron-builder bundled all its languages
(`nsisLang.js:24`) and the "app is running" / "cannot be closed" / "are you
sure to uninstall" boxes followed the OS language. With `en_US, it_IT` a
German or Spanish Windows falls back to English (first `MUI_LANGUAGE`). This
is what AGENTS.md documents and matches the app's own two languages; no fix
needed, just noting the behaviour change.

No finding against `build/installer.nsh` itself. Specifically ruled out:
an update running with the app still open (stock check inserted verbatim,
1a-1c); an installer hang or crash from the banner code (3c: guarded, no
error path, no blocking call beyond the same `SendMessage` the template
already issues); a `-WX` failure from redefining a stock `LangString` (2a);
a broken uninstaller (1d); a GUID / install-dir change (7c).

## Could not be verified

- The produced `Setup.exe` was not executed (by instruction), so the banner
  was not seen on screen; the text/icon presence is proven from the header
  and resources only. Visual fit of the sub-line in control 1002 (204 dlu,
  no wrap) is asserted by the developer, not measured here.
- The embedded 0.3.4 uninstaller binary was not extracted from the 7z
  payload; its behaviour is verified from the source (`!ifndef
  BUILD_UNINSTALLER`) and from the fact that the uninstaller build step
  compiled and was signed.
- The "about a second" cost of `IS_POWERSHELL_AVAILABLE` and the resulting
  need to set the text first was not timed; the ordering is harmless either
  way.
