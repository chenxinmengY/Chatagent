param(
  [string]$SdkRoot = 'D:\Android\Sdk',
  [string]$JdkRoot = 'C:\Program Files\Java\jdk-17',
  [string]$BuildTools = '37.0.0',
  [switch]$VoiceAcceptance,
  [string]$BuildRoot = 'D:\ChatagentBuild',
  [string]$Platform = 'android-37.0'
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repo 'apps\android'
$output = Join-Path $repo 'artifacts\android'
$build = Join-Path $BuildRoot ('android-' + [guid]::NewGuid().ToString('N'))
$toolsDir = Join-Path $SdkRoot ('build-tools\' + $BuildTools)
$platformJar = Join-Path $SdkRoot ('platforms\'+$Platform+'\android.jar')
foreach ($required in @($platformJar, (Join-Path $JdkRoot 'bin\javac.exe'), (Join-Path $toolsDir 'aapt2.exe'))) { if (-not (Test-Path -LiteralPath $required)) { throw "Missing build tool: $required" } }
New-Item -ItemType Directory -Path $output,$build,(Join-Path $build 'classes'),(Join-Path $build 'dex') -Force | Out-Null
function Run-Checked([string]$File, [string[]]$Arguments) { & $File @Arguments; if ($LASTEXITCODE -ne 0) { throw "Build command failed: $File" } }
$env:JAVA_HOME = $JdkRoot
$javaSources = @(Get-ChildItem -LiteralPath (Join-Path $source 'src') -Recurse -Filter '*.java' | ForEach-Object FullName)
Run-Checked (Join-Path $JdkRoot 'bin\javac.exe') (@('-encoding','UTF-8','--release','8','-classpath',$platformJar,'-d',(Join-Path $build 'classes')) + $javaSources)
Run-Checked (Join-Path $JdkRoot 'bin\jar.exe') @('cf',(Join-Path $build 'classes.jar'),'-C',(Join-Path $build 'classes'),'.')
Run-Checked (Join-Path $toolsDir 'd8.bat') @('--lib',$platformJar,'--min-api','26','--output',(Join-Path $build 'dex'),(Join-Path $build 'classes.jar'))
Copy-Item -LiteralPath (Join-Path $source 'res') -Destination (Join-Path $build 'res') -Recurse
Copy-Item -LiteralPath (Join-Path $source 'assets') -Destination (Join-Path $build 'assets') -Recurse
Copy-Item -LiteralPath (Join-Path $source 'AndroidManifest.xml') -Destination (Join-Path $build 'AndroidManifest.xml')
if ($VoiceAcceptance) {
  $manifestPath = Join-Path $build 'AndroidManifest.xml'
  $manifestText = [IO.File]::ReadAllText($manifestPath)
  $manifestText = $manifestText.Replace('package="local.chatagent.privatechat"','package="local.chatagent.privatechat.voiceacceptance"').Replace('android:authorities="local.chatagent.privatechat.files"','android:authorities="local.chatagent.privatechat.voiceacceptance.files"')
  $manifestText = $manifestText -replace 'android:label="[^"]+"','android:label="Chatagent Voice Test"'
  foreach ($component in @('ChatApplication','MainActivity','ProfileActivity','SyncService','BootReceiver','Files')) { $manifestText = $manifestText.Replace(('android:name=".' + $component + '"'),('android:name="local.chatagent.privatechat.' + $component + '"')) }
  [IO.File]::WriteAllText($manifestPath,$manifestText,[Text.UTF8Encoding]::new($false))
}
Run-Checked (Join-Path $toolsDir 'aapt2.exe') @('compile','--dir',(Join-Path $build 'res'),'-o',(Join-Path $build 'resources.zip'))
Run-Checked (Join-Path $toolsDir 'aapt2.exe') @('link','-o',(Join-Path $build 'unsigned.apk'),'-I',$platformJar,'--manifest',(Join-Path $build 'AndroidManifest.xml'),'--min-sdk-version','26','--target-sdk-version','35','-A',(Join-Path $build 'assets'),(Join-Path $build 'resources.zip'))
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$archive = [System.IO.Compression.ZipFile]::Open((Join-Path $build 'unsigned.apk'),[System.IO.Compression.ZipArchiveMode]::Update)
try { [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,(Join-Path $build 'dex\classes.dex'),'classes.dex') | Out-Null } finally { $archive.Dispose() }
Run-Checked (Join-Path $toolsDir 'zipalign.exe') @('-f','-p','4',(Join-Path $build 'unsigned.apk'),(Join-Path $build 'aligned.apk'))
$signing = Join-Path $repo '.local-signing'
New-Item -ItemType Directory -Path $signing -Force | Out-Null
$keystore = Join-Path $signing 'android-development.p12'
if (-not (Test-Path -LiteralPath $keystore)) { Run-Checked (Join-Path $JdkRoot 'bin\keytool.exe') @('-genkeypair','-keystore',$keystore,'-storetype','PKCS12','-storepass','chatagent-development','-keypass','chatagent-development','-alias','chatagent-development','-keyalg','RSA','-keysize','3072','-validity','3650','-dname','CN=Chatagent Local Development','-noprompt') }
$apk = Join-Path $output 'Chatagent-0.3.15-development.apk'
if ($VoiceAcceptance) { $apk = Join-Path $output 'Chatagent-0.3.15-voice-acceptance.apk' }
Run-Checked (Join-Path $toolsDir 'apksigner.bat') @('sign','--ks',$keystore,'--ks-key-alias','chatagent-development','--ks-pass','pass:chatagent-development','--key-pass','pass:chatagent-development','--out',$apk,(Join-Path $build 'aligned.apk'))
Run-Checked (Join-Path $toolsDir 'zipalign.exe') @('-c','-p','4',$apk)
Run-Checked (Join-Path $toolsDir 'apksigner.bat') @('verify','--verbose','--print-certs',$apk)
Get-FileHash -LiteralPath $apk -Algorithm SHA256 | Select-Object Algorithm,Hash,Path | ConvertTo-Json
