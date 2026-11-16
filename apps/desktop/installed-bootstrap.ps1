param([string]$Connection='', [switch]$Stop)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$folder=$PSScriptRoot
$root=if($env:CHATAGENT_INSTALL_DATA){[IO.Path]::GetFullPath($env:CHATAGENT_INSTALL_DATA)}else{Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'fish-with-me'}
New-Item -ItemType Directory -Force -Path $root | Out-Null
$settingsPath=Join-Path $root 'installed-settings.json'
$node=Join-Path $folder 'runtime\node.exe'
$entry=Join-Path $folder 'app\apps\desktop\installed-server.mjs'
function Read-Json([string]$file){Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json}
if(-not(Test-Path -LiteralPath $settingsPath)){
  if($Stop){exit 0}
  $port=37921
  while(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue){$port++;if($port -gt 37999){throw 'No free local port.'}}
  @{dataRoot=$root;port=$port} | ConvertTo-Json | Set-Content -LiteralPath $settingsPath -Encoding UTF8
}
$config=Read-Json $settingsPath
if($config.dataRoot -ne $root -or $config.port -lt 37821 -or $config.port -gt 37999){throw 'Invalid installed settings.'}
$url='http://127.0.0.1:'+$config.port
function Test-CommandPath([string]$command,[string]$expected){
  $argument=[regex]::Escape($expected.Replace('/','\'))
  return [regex]::IsMatch($command.Replace('/','\'),'(?:^|\s)(?:"'+$argument+'"|'+$argument+')(?=\s|$)',[Text.RegularExpressions.RegexOptions]::IgnoreCase)
}
function Assert-Owner($listener){
  $process=Get-CimInstance Win32_Process -Filter ('ProcessId='+$listener.OwningProcess)
  $lock=Read-Json (Join-Path $root 'chat\service.lock')
  $birth=[DateTimeOffset]::new((Get-Process -Id $process.ProcessId).StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()
  if($process.Name -ne 'node.exe' -or $lock.pid -ne $process.ProcessId -or $lock.birthMs -ne $birth -or $process.ExecutablePath -ne $node -or -not(Test-CommandPath $process.CommandLine $entry) -or -not(Test-CommandPath $process.CommandLine $settingsPath)){throw 'Port belongs to another process. No process was stopped.'}
}
function Stop-Owned($listener){
  Assert-Owner $listener
  $control=Read-Json (Join-Path $root 'service-control.json')
  if($control.pid -ne $listener.OwningProcess){throw 'Invalid service control.'}
  @{nonce=$control.nonce} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'stop-request.json') -Encoding UTF8
  for($i=0;$i -lt 100;$i++){
    if(-not(Get-Process -Id $control.pid -ErrorAction SilentlyContinue)){return}
    Start-Sleep -Milliseconds 300
  }
  throw '后台仍在处理任务，请稍后再试。'
}
$listener=Get-NetTCPConnection -LocalPort $config.port -State Listen -ErrorAction SilentlyContinue
if($listener){Assert-Owner $listener}
if($Stop){if($listener){Stop-Owned $listener};exit 0}
if($Connection){
  $connectionValue=Read-Json ([IO.Path]::GetFullPath($Connection))
  $uri=[Uri]$connectionValue.bridgeUrl
  if($uri.Scheme -ne 'http' -or $uri.Host -ne '127.0.0.1' -or $uri.AbsolutePath -ne '/' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or -not[IO.Path]::IsPathRooted($connectionValue.tokenFile) -or -not(Test-Path -LiteralPath $connectionValue.tokenFile)){throw '请选择有效的 DSH 桥接客户端 JSON 配置。'}
  $token=(Get-Content -LiteralPath $connectionValue.tokenFile -Raw -Encoding UTF8).Trim()
  if($token.Length -lt 32){throw '桥接令牌无效。'}
  $bridge=Invoke-RestMethod ($uri.AbsoluteUri.TrimEnd('/')+'/v1/status') -Headers @{Authorization=('Bearer '+$token)} -TimeoutSec 10
  if($bridge.format -ne 'chatagent-dsh-bridge-v1'){throw '桥接尚未就绪。请先在 DSH 加载本项目插件。'}
  if($listener){
    $boot=Invoke-RestMethod ($url+'/v1/bootstrap') -TimeoutSec 2
    if($boot.backend -ne 'not-connected'){throw '当前已有 DSH 连接。更换连接前请先备份并退出后台。'}
    Stop-Owned $listener;$listener=$null
  }
  # Preserve optional device TLS configuration, but own the installed chat root/port.
  $connectionValue | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $root 'connection.json') -Encoding UTF8
}
if(-not $listener){
  # ShellExecute detaches the background service from the launcher's output pipe.
  $started=Start-Process -FilePath $node -ArgumentList @(('"'+$entry+'"'),('"'+$settingsPath+'"')) -WorkingDirectory (Join-Path $folder 'app') -WindowStyle Hidden -PassThru
}
for($attempt=0;$attempt -lt 80;$attempt++){
  if($started){$started.Refresh();if($started.HasExited){throw '本地服务未能启动。请先打开 DSH；详细原因见资料目录内 startup.stderr.log，现有资料仍保留。'}}
  try{
    $ready=Get-NetTCPConnection -LocalPort $config.port -State Listen -ErrorAction Stop
    Assert-Owner $ready
    $boot=Invoke-RestMethod ($url+'/v1/bootstrap') -TimeoutSec 2
    if(-not $boot.localOnly -or $boot.backend -notin @('not-connected','dsh-bridge')){throw 'Unexpected service.'}
    $plugin=([Uri](Join-Path $folder 'app\packages\dsh-bridge\index.mjs')).AbsoluteUri
    $guide=Join-Path $folder 'app\docs\DSH-BRIDGE.md'
    $prompt=@"
请在这台电脑上配置 fish with me 与 DSH 的首次连接。先阅读 "$guide"，按真实 DSH 版本和本机环境操作，不能假装已经配置成功。
桥接插件入口：$plugin
新的专用桥接资料目录：$(Join-Path $root 'bridge')
新的专用工作目录：$(Join-Path $root 'workspace')
新的桥接令牌文件：$(Join-Path $root 'bridge-token.txt')
客户端连接配置请保存到：$(Join-Path $root 'bridge-client.json')
客户端 JSON 至少包含 bridgeUrl（本机 HTTP 桥接地址）与 tokenFile（上述令牌文件绝对路径）；如需手机，请按文档配置独立的 device TLS 入口，不能开放电脑管理端口。
这是通过绝对 file URL 加载的本地桥接，不一定出现在 DSH 插件管理页的 bundle 列表。请以认证 /v1/status 返回 chatagent-dsh-bridge-v1 和实际回执验证加载成功。升级应用后需重新启动 DSH 才会加载新的桥接代码；不要重复插入多个桥接条目。
不要修改已有聊天、人格或生产 DSH/微信会话；为本应用使用专用会话。不要把令牌发到聊天或日志。缺少模型账号时请让我在 DSH 中填写。先验证桥接 /v1/status，再让我右键应用托盘 → 导入 DSH 连接配置，选择 bridge-client.json。由我决定是否发送真实模型测试消息。
语音请在连接后用软件「设置 → 语音 → 一键配置」，不要覆盖已有自定义音色或唱歌环境。
最后只报告实际完成项、仍需我操作的步骤和配置文件位置。
"@
    $prompt | Set-Content -LiteralPath (Join-Path $root '首次连接提示词.txt') -Encoding UTF8
    @{url=$url;firstRun=($boot.backend -eq 'not-connected');dataRoot=$root;setupPrompt=$prompt} | ConvertTo-Json -Compress;exit 0
  }catch{if($attempt -eq 79){throw}}
  Start-Sleep -Milliseconds 400
}
