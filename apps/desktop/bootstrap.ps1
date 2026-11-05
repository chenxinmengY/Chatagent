param([Parameter(Mandatory=$true)][string]$Settings)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$settingsPath=[IO.Path]::GetFullPath($Settings)
$desktop=Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
$repo=[IO.Path]::GetFullPath($desktop.workspace)
$configPath=[IO.Path]::GetFullPath($desktop.configuration)
$configuration=Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$bridgeMode=$null -ne $configuration.bridgeUrl
$workspaceMode=$null -ne $configuration.fishRoot -and $null -eq $configuration.captureRoot
$entry=Join-Path $repo $(if($bridgeMode){'scripts\start-bridge.mjs'}elseif($workspaceMode){'scripts\start-workspace.mjs'}else{'scripts\start-standby.mjs'})
if ((-not $bridgeMode -and -not $workspaceMode -and $configuration.mode -notin @('local-rehearsal','configured-model')) -or $configuration.port -lt 37821 -or $configuration.port -gt 37999 -or -not (Test-Path -LiteralPath $entry)) { throw 'Invalid workspace configuration.' }
$url='http://127.0.0.1:'+$configuration.port
$listener=Get-NetTCPConnection -LocalPort $configuration.port -State Listen -ErrorAction SilentlyContinue
function Assert-Owner($connection) {
  $process=Get-CimInstance Win32_Process -Filter ('ProcessId='+$connection.OwningProcess)
  $lock=Get-Content -LiteralPath (Join-Path $configuration.dataRoot 'chat\service.lock') -Raw -Encoding UTF8 | ConvertFrom-Json
  $birth=[DateTimeOffset]::new((Get-Process -Id $process.ProcessId).StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()
  if ($process.Name -ne 'node.exe' -or $lock.pid -ne $process.ProcessId -or $lock.birthMs -ne $birth -or -not $process.CommandLine.Contains($entry) -or -not $process.CommandLine.Contains($configPath)) { throw 'Port belongs to another process. No process was stopped.' }
}
if ($listener) { Assert-Owner $listener } else {
  $node=Get-Command node.exe -ErrorAction Stop
  Start-Process -FilePath $node.Source -ArgumentList @(('"'+$entry+'"'),('"'+$configPath+'"')) -WorkingDirectory $repo -WindowStyle Hidden | Out-Null
}
for ($attempt=0;$attempt -lt 60;$attempt++) {
  try {
    $connection=Get-NetTCPConnection -LocalPort $configuration.port -State Listen -ErrorAction Stop
    Assert-Owner $connection
    $boot=Invoke-RestMethod ($url+'/v1/bootstrap') -TimeoutSec 2
    if ($boot.localOnly -and $boot.backend -eq $(if($bridgeMode){'dsh-bridge'}else{'test-injected'})) { @{url=$url;mode=$configuration.mode} | ConvertTo-Json -Compress; exit 0 }
  } catch { if ($attempt -eq 59) { throw } }
  Start-Sleep -Milliseconds 500
}
throw 'Standby did not become ready.'
