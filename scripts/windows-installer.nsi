; UTF-8 source. Build with scripts/build-installers.ps1.
Unicode true
!include "MUI2.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
Name "fish with me ${VERSION}"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\fish-with-me"
InstallDirRegKey HKCU "Software\fish-with-me" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "fish with me"
VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=2052 "ProductName" "fish with me"
VIAddVersionKey /LANG=2052 "FileDescription" "fish with me 安装程序"
VIAddVersionKey /LANG=2052 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=2052 "LegalCopyright" "Chatagent contributors"
!define MUI_ICON "${PAYLOAD}\Chatagent.ico"
!define MUI_UNICON "${PAYLOAD}\Chatagent.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "欢迎安装 fish with me"
!define MUI_WELCOMEPAGE_TEXT "安装电脑端，连接自己的 DSH，再开始聊天。$\r$\n$\r$\n已包含 Node.js，不需要单独安装。首次连接、资料迁移和语音配置可按软件内教程操作。$\r$\n$\r$\n适用于 Windows 10/11 64 位。"
!define MUI_FINISHPAGE_RUN "$INSTDIR\Chatagent.exe"
!define MUI_FINISHPAGE_RUN_TEXT "打开 fish with me"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${PAYLOAD}\app\LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

!macro CheckWindow
  System::Call 'kernel32::OpenMutexW(i 0x100000, i 0, w "Local\FishWithMeInstalledWindow") p.r0'
  ${If} $0 != 0
    System::Call 'kernel32::CloseHandle(p r0)'
    IfSilent +2
    MessageBox MB_OK|MB_ICONINFORMATION "请先右键鲸鱼托盘图标，选择「退出桌面端」，然后重新运行安装或卸载。"
    SetErrorLevel 2
    Abort
  ${EndIf}
!macroend
Function .onInit
  SetShellVarContext current
  SetRegView 64
  ${IfNot} ${RunningX64}
    MessageBox MB_OK "此安装包需要 64 位 Windows。"
    Abort
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK "此安装包需要 Windows 10 或 Windows 11。"
    Abort
  ${EndIf}
  !insertmacro CheckWindow
FunctionEnd
Function .onVerifyInstDir
  ; Only install into a new/empty directory or our existing installation.
  IfFileExists "$INSTDIR\installed.json" valid
  FindFirst $0 $1 "$INSTDIR\*"
  loop:
    StrCmp $1 "" done
    StrCmp $1 "." next
    StrCmp $1 ".." next
    FindClose $0
    Abort
  next:
    FindNext $0 $1
    Goto loop
  done:
    FindClose $0
  valid:
FunctionEnd
Function CheckWebView
  SetRegView 32
  ReadRegStr $0 HKLM "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${If} $0 == ""
    ReadRegStr $0 HKCU "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${EndIf}
  SetRegView 64
  ${If} $0 == ""
  ${OrIf} $0 == "0.0.0.0"
    DetailPrint "正在安装 Microsoft WebView2，需要联网…"
    ExecWait '"$INSTDIR\MicrosoftEdgeWebview2Setup.exe" /silent /install' $0
    ${If} $0 != 0
      IfSilent +2
      MessageBox MB_OK|MB_ICONEXCLAMATION "WebView2 未能安装。请联网后运行安装目录内 MicrosoftEdgeWebview2Setup.exe，再打开应用。"
      SetErrorLevel 3
    ${EndIf}
  ${EndIf}
FunctionEnd
Section "fish with me"
  SetShellVarContext current
  SetRegView 64
  IfFileExists "$INSTDIR\installed.json" 0 copy
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\installed-bootstrap.ps1" -Stop' $0
  ${If} $0 != 0
    IfSilent +2
    MessageBox MB_OK "后台尚未退出，请稍后重试。"
    SetErrorLevel 4
    Abort
  ${EndIf}
  copy:
  SetOutPath "$INSTDIR"
  File /r "${PAYLOAD}\*"
  WriteUninstaller "$INSTDIR\卸载.exe"
  CreateDirectory "$SMPROGRAMS\fish with me"
  CreateShortCut "$SMPROGRAMS\fish with me\fish with me.lnk" "$INSTDIR\Chatagent.exe"
  CreateShortCut "$SMPROGRAMS\fish with me\卸载.lnk" "$INSTDIR\卸载.exe"
  CreateShortCut "$DESKTOP\fish with me.lnk" "$INSTDIR\Chatagent.exe"
  WriteRegStr HKCU "Software\fish-with-me" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\fish-with-me" "DisplayName" "fish with me"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\fish-with-me" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\fish-with-me" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\fish-with-me" "DisplayIcon" "$INSTDIR\Chatagent.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\fish-with-me" "UninstallString" '$\"$INSTDIR\卸载.exe$\"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\fish-with-me" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\fish-with-me" "NoRepair" 1
  Call CheckWebView
SectionEnd
Function un.onInit
  SetShellVarContext current
  SetRegView 64
  !insertmacro CheckWindow
  IfFileExists "$INSTDIR\installed.json" valid
  Abort
  valid:
FunctionEnd
Section "Uninstall"
  SetShellVarContext current
  SetRegView 64
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\installed-bootstrap.ps1" -Stop' $0
  ${If} $0 != 0
    IfSilent +2
    MessageBox MB_OK "后台尚未退出，请稍后重试。资料会保留。"
    SetErrorLevel 4
    Abort
  ${EndIf}
  ; Generated exact file list. No recursive deletion of user-selected directories.
  !include "${DELETE_LIST}"
  Delete "$INSTDIR\卸载.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\fish with me\fish with me.lnk"
  Delete "$SMPROGRAMS\fish with me\卸载.lnk"
  RMDir "$SMPROGRAMS\fish with me"
  Delete "$DESKTOP\fish with me.lnk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\fish-with-me"
  DeleteRegKey HKCU "Software\fish-with-me"
  ; %LOCALAPPDATA%\fish-with-me (chats, attachments, keys) is deliberately retained.
SectionEnd
