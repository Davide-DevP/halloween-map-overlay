; Halloween Map Overlay — one-click NSIS installer customisation.
;
; electron-builder picks this file up automatically as `build/installer.nsh`
; (`nsis.include`, which package.json also names explicitly) and pastes it into
; the *preamble* of the generated script — i.e. before `templates/nsis/
; installer.nsi` is read. That ordering is what makes the two hooks below work.
;
; What the user sees during a self-update
; ---------------------------------------
; The one-click installer has no wizard pages worth customising: `oneClick.nsh`
; only inserts `MUI_PAGE_INSTFILES` and `common.nsh` sets `ShowInstDetails
; nevershow`. The window the user actually looks at is the *SpiderBanner*
; dialog that `installSection.nsh` puts up:
;
;     SpiderBanner::Show /MODERN /ICON "$PLUGINSDIR\installerHeaderico.ico"
;     FindWindow $0 "#32770" "" $hwndparent      ; the INSTFILES page
;     FindWindow $0 "#32770" "" $hwndparent $0   ; the banner, next sibling
;     GetDlgItem $0 $0 1000
;     SendMessage $0 ${WM_SETTEXT} 0 "STR:$(installing)"
;
; Dumping the dialog resource out of nsis-resources' SpiderBanner.dll (the only
; RT_DIALOG in it, id 104, 254x78 dlu) shows five controls, and the template
; uses exactly one of them:
;
;     1025  static, SS_ICON, 10,10 20x20   → the icon (/ICON = HEADER_ICO)
;     1000  static,          40,10 204x11  → headline   (template: $(installing))
;     1002  static,          40,22 204x11  → sub-line   (unused, empty)
;     1003  static,          10,38 234x18  → free text  (unused, empty)
;     1001  msctls_progress32 10,59 234x11 → the progress bar
;
; So the headline slot is one line tall and there is a second, unused line
; underneath it. `hmoBannerText` fills 1000 and 1002; `nsis.installerHeaderIcon`
; in package.json fills 1025; the progress bar and the window caption
; ("Halloween Map Overlay Setup") and branding line ("Halloween Map Overlay
; 0.3.x", from `common.nsh`) are already right.
;
; Where it is done, and why there
; -------------------------------
; The banner only exists between `SpiderBanner::Show` and the end of the
; section, and the *only* electron-builder hook in that window is
; `customCheckAppRunning` — `customInit` runs in `.onInit` (before any GUI) and
; `customInstall` runs after the 350 MB payload has already been unpacked.
; `customCheckAppRunning` *replaces* the stock app-running check rather than
; adding to it, so this file re-inserts the two macros the default branch of
; `CHECK_APP_RUNNING` would have inserted, in the same order, and does the UI
; work first (`IS_POWERSHELL_AVAILABLE` shells out to PowerShell twice and costs
; about a second — the text has to be up before that, not after).
;
; Defining `customCheckAppRunning` also turns off the
; `!ifmacrondef customCheckAppRunning` guard at the top of
; `include/allowOnlyOneInstallerInstance.nsh`, which is where `getProcessInfo.nsh`
; and `Var pid` normally come from. `_CHECK_APP_RUNNING` needs both, so this file
; provides them.
;
; Strings are `LangString`s, not literals: `nsis.installerLanguages` is pinned to
; English and Italian (the two the app itself speaks) and NSIS picks the one that
; matches the OS, falling back to the first declared language. They are defined
; in `customHeader`, which `installer.nsi` inserts *after* `!insertmacro addLangs`
; — the point at which `${LANG_ENGLISH}` / `${LANG_ITALIAN}` exist. Note that
; makensis runs with `-WX`, so the stock `installing` message is left alone
; rather than redefined: a second `LangString` for the same id is a warning, and
; a warning is a failed build.

!include "getProcessInfo.nsh"
Var pid

; Fresh install and self-update are the same installer; only the wording differs.
; `--updated` is what `spawnInstallerAtLowPriority()` (src/core/main-window.js)
; passes, and electron-builder turns it into the `isUpdated` LogicLib flag.
!macro customHeader
  LangString hmoUpdateTitle     ${LANG_ENGLISH} "Updating ${PRODUCT_NAME}…"
  LangString hmoUpdateSubtitle  ${LANG_ENGLISH} "Installing version ${VERSION} — the app reopens by itself"
  LangString hmoInstallTitle    ${LANG_ENGLISH} "Installing ${PRODUCT_NAME}…"
  LangString hmoInstallSubtitle ${LANG_ENGLISH} "Version ${VERSION} — this takes a moment"

  LangString hmoUpdateTitle     ${LANG_ITALIAN} "Aggiornamento di ${PRODUCT_NAME}…"
  ; Kept close to the English in length: control 1002 is 204 dlu (~330 px) wide
  ; and does not wrap, so a sub-line much past ~55 characters would be clipped.
  LangString hmoUpdateSubtitle  ${LANG_ITALIAN} "Installazione versione ${VERSION} — l'app si riapre da sola"
  LangString hmoInstallTitle    ${LANG_ITALIAN} "Installazione di ${PRODUCT_NAME}…"
  LangString hmoInstallSubtitle ${LANG_ITALIAN} "Versione ${VERSION} — ci vuole un momento"
!macroend

; $R4..$R7 are untouched by _CHECK_APP_RUNNING ($R0/$R1), FIND_PROCESS ($R0),
; KILL_PROCESS ($0) and GetProcessInfo ($1..$4).
!macro hmoBannerText
  FindWindow $R4 "#32770" "" $HWNDPARENT
  FindWindow $R4 "#32770" "" $HWNDPARENT $R4
  ${If} $R4 != 0
    ${If} ${isUpdated}
      StrCpy $R6 "$(hmoUpdateTitle)"
      StrCpy $R7 "$(hmoUpdateSubtitle)"
    ${Else}
      StrCpy $R6 "$(hmoInstallTitle)"
      StrCpy $R7 "$(hmoInstallSubtitle)"
    ${EndIf}
    GetDlgItem $R5 $R4 1000
    SendMessage $R5 ${WM_SETTEXT} 0 "STR:$R6"
    GetDlgItem $R5 $R4 1002
    SendMessage $R5 ${WM_SETTEXT} 0 "STR:$R7"
  ${EndIf}
!macroend

!macro customCheckAppRunning
  !ifndef BUILD_UNINSTALLER
    !ifdef ONE_CLICK
      ; No banner in a silent run, and none in the uninstaller, which inserts
      ; CHECK_APP_RUNNING too (uninstaller.nsh:2).
      ${IfNot} ${Silent}
        !insertmacro hmoBannerText
      ${EndIf}
    !endif
  !endif

  ; Verbatim the default branch of CHECK_APP_RUNNING
  ; (include/allowOnlyOneInstallerInstance.nsh) — closing the running app on a
  ; self-update must keep working exactly as it did.
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
!macroend
