param([string]$InstallRoot='', [string]$DataRoot='', [string]$DshRoot='', [switch]$NoClipboard, [switch]$NoOpen)
$ErrorActionPreference='Stop'
$OutputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=$OutputEncoding
$report=Join-Path $PSScriptRoot ('诊断报告-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid().ToString('N').Substring(0,6)+'.txt')
Write-Host '正在核对安装、桥接和最近的错误，请稍等。不会发消息或修改配置。'
$installs=New-Object 'Collections.Generic.List[string]'
$processes=@()
if($InstallRoot){$installs.Add([IO.Path]::GetFullPath($InstallRoot))}else{
 $registered=(Get-ItemProperty HKCU:\Software\fish-with-me -ErrorAction SilentlyContinue).InstallDir
 if($registered){$installs.Add($registered)}
 $installs.Add((Join-Path $env:LOCALAPPDATA 'Programs\fish-with-me'))
 try{
  $items=Get-CimInstance Win32_Process -Filter "Name = 'Chatagent.exe' OR Name = 'DeepSeek Harness.exe' OR Name = 'dsh.exe' OR Name = 'electron.exe'"
  foreach($item in $items){
   if(-not $item.ExecutablePath -or ($item.Name -eq 'electron.exe' -and $item.ExecutablePath -notmatch 'dsh|deepseek')){continue}
   if($item.CommandLine -match '(?:^|\s)--type='){continue}
   if($item.Name -eq 'Chatagent.exe'){$installs.Add((Split-Path -Parent $item.ExecutablePath))}
   $file=Get-Item -LiteralPath $item.ExecutablePath -ErrorAction SilentlyContinue
   $processes+=@{pid=$item.ProcessId;exe=$item.ExecutablePath;version=$file.VersionInfo.FileVersion;startedAt=[DateTimeOffset]::new($item.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()}
  }
 }catch{}
}
$installs=@($installs | Select-Object -Unique)
$node=$null
foreach($folder in $installs){$candidate=Join-Path $folder 'runtime\node.exe';if(Test-Path -LiteralPath $candidate){$node=$candidate;break}}
if(-not $DataRoot){$DataRoot=if($env:CHATAGENT_INSTALL_DATA){$env:CHATAGENT_INSTALL_DATA}else{Join-Path $env:LOCALAPPDATA 'fish-with-me'}}
if(-not $DshRoot){$DshRoot=if($env:DSH_HOME){$env:DSH_HOME}else{Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh'}}
if($node){
 $context=@{installRoots=$installs;dataRoots=@([IO.Path]::GetFullPath($DataRoot));dshRoots=@([IO.Path]::GetFullPath($DshRoot));processes=$processes} | ConvertTo-Json -Depth 6 -Compress
 $context | & $node --no-warnings (Join-Path $PSScriptRoot 'collect.mjs') $report
}else{
 @'
fish with me 诊断报告
未在注册表、默认安装目录或正在运行的程序目录中找到内置 Node.js。
请先打开 fish with me，保持 DSH 打开，再双击诊断一次。
工具没有修改配置或发送消息。
'@ | Set-Content -LiteralPath $report -Encoding UTF8
}
if(-not(Test-Path -LiteralPath $report)){throw 'No report was created.'}
if(-not $NoClipboard){try{Get-Content -LiteralPath $report -Raw -Encoding UTF8 | Set-Clipboard;Write-Host '报告已复制，回到聊天直接粘贴即可。'}catch{Write-Host '请在报告窗口按 Ctrl+A、Ctrl+C，再粘贴发回。'}}
Write-Host ('报告位置：'+$report)
if(-not $NoOpen){Start-Process -FilePath notepad.exe -ArgumentList ('"'+$report+'"') -WindowStyle Normal}
