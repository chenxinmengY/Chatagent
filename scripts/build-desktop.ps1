param([string]$WebViewSdk='', [string]$Configuration='')
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
$repo=Split-Path -Parent $PSScriptRoot
if (-not $WebViewSdk) {
  $sdkCache=Join-Path $repo '.verification-tmp\webview2-sdk'
  $WebViewSdk=Join-Path $sdkCache 'extracted'
  $package=Join-Path $sdkCache 'package.zip'
  New-Item -ItemType Directory -Force -Path $sdkCache | Out-Null
  if(-not(Test-Path -LiteralPath $package)){Invoke-WebRequest 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.4314.35/microsoft.web.webview2.1.0.4314.35.nupkg' -OutFile $package}
  if((Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash -ne '90778DEB1B77E36292828B4B5833C9255C27533F40E0DDD55891AE718944EDC4'){throw 'WebView2 SDK package checksum mismatch'}
  if(-not(Test-Path -LiteralPath $WebViewSdk)){Expand-Archive -LiteralPath $package -DestinationPath $WebViewSdk}
}
$output=Join-Path $repo 'artifacts\windows\Chatagent-0.4.4'
New-Item -ItemType Directory -Force -Path $output | Out-Null
$core=Join-Path $WebViewSdk 'lib\net462\Microsoft.Web.WebView2.Core.dll'
$forms=Join-Path $WebViewSdk 'lib\net462\Microsoft.Web.WebView2.WinForms.dll'
foreach ($file in @($core,$forms,(Join-Path $WebViewSdk 'runtimes\win-x64\native\WebView2Loader.dll'))) { Copy-Item -LiteralPath $file -Destination $output -Force }
Copy-Item -LiteralPath (Join-Path $WebViewSdk 'LICENSE.txt') -Destination (Join-Path $output 'WebView2-LICENSE.txt') -Force
Copy-Item -LiteralPath (Join-Path $WebViewSdk 'NOTICE.txt') -Destination (Join-Path $output 'WebView2-NOTICE.txt') -Force
Add-Type -AssemblyName System.Drawing
$bitmap=New-Object Drawing.Bitmap 64,64
$graphics=[Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode='AntiAlias';$graphics.Clear([Drawing.Color]::FromArgb(232,242,255))
$blue=New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(67,137,235))
$graphics.FillEllipse($blue,10,21,43,31)
$tail=[Drawing.Point[]]@((New-Object Drawing.Point 46,37),(New-Object Drawing.Point 62,27),(New-Object Drawing.Point 59,46))
$graphics.FillPolygon($blue,$tail);$graphics.FillEllipse([Drawing.Brushes]::White,17,39,25,9);$graphics.FillEllipse([Drawing.Brushes]::MidnightBlue,22,30,4,4)
$icon=[Drawing.Icon]::FromHandle($bitmap.GetHicon());$stream=[IO.File]::Create((Join-Path $output 'Chatagent.ico'));try{$icon.Save($stream)}finally{$stream.Dispose();$graphics.Dispose();$blue.Dispose();$bitmap.Dispose()}
$compiler='C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $compiler /nologo /target:winexe /platform:x64 /optimize+ /utf8output ('/out:'+(Join-Path $output 'Chatagent.exe')) ('/win32icon:'+(Join-Path $output 'Chatagent.ico')) /reference:System.dll /reference:System.Core.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll ('/reference:'+$core) ('/reference:'+$forms) (Join-Path $repo 'apps\desktop\Chatagent.cs')
if($LASTEXITCODE -ne 0){throw 'Desktop compile failed'}
Copy-Item -LiteralPath (Join-Path $repo 'apps\desktop\bootstrap.ps1') -Destination $output -Force
if(-not $Configuration){
  $bridgeConfiguration=Join-Path $repo 'data\bridge-launch.private.json'
  $Configuration=if(Test-Path -LiteralPath $bridgeConfiguration){$bridgeConfiguration}else{Join-Path $repo 'data\standby-v0210-launch.private.json'}
}
@{workspace=$repo;configuration=[IO.Path]::GetFullPath($Configuration)} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'desktop.private.json') -Encoding UTF8
@'
Chatagent 0.4.4 — 本机桌面版
双击 Chatagent.exe。请将同目录 DLL、图标和配置文件一起保留。
复用已核验的本地备用服务；服务未运行时尝试启动备用服务。
点右上角“×”或最小化会收进托盘，双击托盘图标可打开。右键托盘可退出桌面端。
桌面端是管理界面；退出桌面端不会停止后台服务，手机仍可连接。电脑重启后，打开桌面端会检查并启动本机服务；模型与插件调用仍需 DSH 运行。
使用本机已安装的 Microsoft Edge WebView2 Runtime 和 Node.js。
desktop.private.json 绑定本机工程和独立档案位置。本文件夹不包含私人档案、DSH SDK或语音模型，不能单独拷到另一台电脑即用。
回复方式沿用空间中现有模型设置。不会启动、停止或修改微信及生产DSH。
'@ | Set-Content -LiteralPath (Join-Path $output '使用说明.txt') -Encoding UTF8
Get-FileHash -LiteralPath (Join-Path $output 'Chatagent.exe') -Algorithm SHA256 | ConvertTo-Json
