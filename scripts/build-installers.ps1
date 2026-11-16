param(
  [string]$AndroidKeystorePath='',
  [string]$AndroidKeystorePasswordFile='',
  [string]$AndroidKeystoreAlias='chatagent-development',
  [switch]$SkipAndroid
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$repo=Split-Path -Parent $PSScriptRoot
$version=(Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
if($version -notmatch '^\d+\.\d+\.\d+$'){throw 'Invalid release version.'}
if(-not $SkipAndroid -and (-not $AndroidKeystorePath -or -not $AndroidKeystorePasswordFile)){throw 'Provide the existing Android release keystore and private password file, or use -SkipAndroid.'}
$cache=Join-Path $repo '.verification-tmp\release-tools'
$release=Join-Path $repo ('artifacts\release\'+$version)
$stage=Join-Path $repo ('artifacts\windows\installer-'+$version+'-'+[guid]::NewGuid().ToString('N'))
$payload=Join-Path $stage 'payload'
New-Item -ItemType Directory -Force -Path $cache,$release,$payload | Out-Null
function Download-Checked([string]$Url,[string]$Name,[string]$Sha256){
  $file=Join-Path $cache $Name
  if(-not(Test-Path -LiteralPath $file)){
    & curl.exe --fail --location --silent --show-error --max-time 180 $Url -o $file
    if($LASTEXITCODE -ne 0){throw ('Download failed: '+$Name)}
  }
  if((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $Sha256){throw ('Download checksum mismatch: '+$Name)}
  return $file
}
$nodeZip=Download-Checked 'https://nodejs.org/download/release/v24.22.2/node-v24.22.2-win-x64.zip' 'node-v24.22.2-win-x64.zip' 'CA1BFF5D8EAD13C9F2EA404A176DB46BD430704D5B5113734049FA365E7799E2'
$nsisZip=Download-Checked 'https://downloads.sourceforge.net/project/nsis/NSIS%203/3.12/nsis-3.12.zip?download=1&use_mirror=gigenet' 'nsis-direct.zip' '56581F90DB321581C5381193D796FFFCF2D24B2F8FED2160A6C6A3BAA67F2C4F'
$webview=Download-Checked 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' 'MicrosoftEdgeWebview2Setup.exe' 'CF2F2445FEF0C5C14E372045F84998771EEB8BB01D59BE4AFD00692FA160082E'
$signature=Get-AuthenticodeSignature -LiteralPath $webview
if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation'){throw 'WebView2 bootstrapper signature invalid.'}
$nodeExtract=Join-Path $stage 'node'
$nsisExtract=Join-Path $stage 'nsis'
Expand-Archive -LiteralPath $nodeZip -DestinationPath $nodeExtract
Expand-Archive -LiteralPath $nsisZip -DestinationPath $nsisExtract
$nodeRoot=Join-Path $nodeExtract 'node-v24.22.2-win-x64'
$nsisRoot=Join-Path $nsisExtract 'nsis-3.12'
$node=Join-Path $nodeRoot 'node.exe'
$candidateText=& $node (Join-Path $PSScriptRoot 'prepare-source.mjs')
if($LASTEXITCODE -ne 0){throw 'Public source audit failed.'}
$candidate=$candidateText | ConvertFrom-Json
Copy-Item -LiteralPath $candidate.target -Destination (Join-Path $payload 'app') -Recurse
& (Join-Path $PSScriptRoot 'build-desktop.ps1') -Distribution -OutputDirectory $payload
if($LASTEXITCODE -ne 0){throw 'Desktop build failed.'}
New-Item -ItemType Directory -Force -Path (Join-Path $payload 'runtime'),(Join-Path $payload 'licenses') | Out-Null
Copy-Item -LiteralPath $node -Destination (Join-Path $payload 'runtime\node.exe')
Copy-Item -LiteralPath (Join-Path $nodeRoot 'LICENSE') -Destination (Join-Path $payload 'licenses\Node-LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $nsisRoot 'COPYING') -Destination (Join-Path $payload 'licenses\NSIS-LICENSE.txt')
Copy-Item -LiteralPath $webview -Destination (Join-Path $payload 'MicrosoftEdgeWebview2Setup.exe')
@'
fish with me — 安装说明

电脑：运行 windows-x64-setup.exe，一直按「下一步」。安装后会打开首次连接引导。
已包含 Node.js。缺少 WebView2 时会联网安装微软运行库。适用于 Windows 10/11 64 位。
第一次用：右键右下角鲸鱼图标 → 复制首次连接提示词 → 粘贴给本机 DSH/Codex。
配置完成后：右键鲸鱼图标 → 导入 DSH 连接配置，选择准备好的 JSON 文件。
DSH、模型账号和可选插件需要自行准备，安装包不包含账号、API 额度或个人聊天。
语音：连接成功后打开「设置 → 语音 → 一键配置」。转文字模型首次需下载约 300 MiB。
定制音色、唱歌和显卡加速请看进阶教程。

手机：把 android.apk 传到 Android 手机，点开安装；需要 Android 8.0 或以上。
已有旧版时直接覆盖安装，不要先卸载。电脑保持运行，再按电脑端「设备」页面配对。
连接方式和证书按软件内手机教程设置。iPhone 不能安装 APK。

电脑资料在 %LOCALAPPDATA%\fish-with-me。卸载只移除程序，保留资料。
升级前建议在软件里生成备份。手机卸载会丢失本机草稿等资料。
Windows 程序尚未购买代码签名证书，系统可能显示「未知发布者」。
本包未自动发布到 GitHub；Android 真机安装和各厂商通知仍需实际确认。
'@ | Set-Content -LiteralPath (Join-Path $release '安装说明.txt') -Encoding UTF8
Copy-Item -LiteralPath (Join-Path $release '安装说明.txt') -Destination (Join-Path $payload '安装说明.txt')
$inventory=@(Get-ChildItem -LiteralPath $payload -Recurse -File | ForEach-Object {
  @{path=$_.FullName.Substring($payload.Length+1).Replace('\','/');bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
})
@{format='fish-with-me-payload-v1';version=$version;sourceTreeHash=$candidate.treeHash;files=$inventory} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $payload 'PAYLOAD-MANIFEST.json') -Encoding UTF8
function Nsis-Literal([string]$Value){$Value.Replace('$','$$').Replace('"','$\"')}
$deletes=New-Object 'Collections.Generic.List[string]'
Get-ChildItem -LiteralPath $payload -Recurse -File | ForEach-Object { $deletes.Add('Delete "$INSTDIR\'+(Nsis-Literal $_.FullName.Substring($payload.Length+1))+'"') }
Get-ChildItem -LiteralPath $payload -Recurse -Directory | Sort-Object { $_.FullName.Length } -Descending | ForEach-Object { $deletes.Add('RMDir "$INSTDIR\'+(Nsis-Literal $_.FullName.Substring($payload.Length+1))+'"') }
$deleteFile=Join-Path $stage 'uninstall-files.nsh'
[IO.File]::WriteAllLines($deleteFile,$deletes,[Text.UTF8Encoding]::new($true))
$installer=Join-Path $release ('fish-with-me-'+$version+'-windows-x64-setup.exe')
& (Join-Path $nsisRoot 'makensis.exe') /V2 ('/DVERSION='+$version) ('/DPAYLOAD='+$payload) ('/DOUTPUT='+$installer) ('/DDELETE_LIST='+$deleteFile) (Join-Path $PSScriptRoot 'windows-installer.nsi')
if($LASTEXITCODE -ne 0){throw 'Windows installer build failed.'}
if(-not $SkipAndroid){
  & (Join-Path $PSScriptRoot 'build-android.ps1') -KeystorePath $AndroidKeystorePath -KeystorePasswordFile $AndroidKeystorePasswordFile -KeystoreAlias $AndroidKeystoreAlias -OutputApk (Join-Path $release ('fish-with-me-'+$version+'-android.apk'))
  if($LASTEXITCODE -ne 0){throw 'Android build failed.'}
}
$artifacts=@(Get-ChildItem -LiteralPath $release -File | Where-Object {$_.Extension -in @('.exe','.apk')} | ForEach-Object {
  @{file=$_.Name;bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
})
@{format='fish-with-me-release-v1';version=$version;sourceTreeHash=$candidate.treeHash;sourceCandidate=$candidate.target.Substring($repo.Length+1).Replace('\','/');payload=$payload.Substring($repo.Length+1).Replace('\','/');node='24.22.2';nsis='3.12';webviewBootstrapperSha256=(Get-FileHash -LiteralPath $webview -Algorithm SHA256).Hash.ToLowerInvariant();windowsCodeSigned=$false;artifacts=$artifacts} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $release 'release-manifest.json') -Encoding UTF8
$artifacts | ForEach-Object {$_.sha256+'  '+$_.file} | Set-Content -LiteralPath (Join-Path $release 'SHA256SUMS.txt') -Encoding ASCII
@{release=$release;payload=$payload;source=$candidate.target;artifacts=$artifacts} | ConvertTo-Json -Depth 8
