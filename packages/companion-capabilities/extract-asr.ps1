$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())) | ConvertFrom-Json
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = [IO.Path]::GetFullPath($request.root)
if (-not [IO.Path]::IsPathRooted($request.root) -or -not [IO.Directory]::Exists($root)) { throw 'ASR_SETUP_PATH' }
$prefix = $root.TrimEnd('\') + '\'
$count = 0
$total = [long]0
foreach ($archive in $request.archives) {
  $zip = [IO.Compression.ZipFile]::OpenRead($archive.file)
  try {
    $ffmpegCount = 0
    foreach ($entry in $zip.Entries) {
      $count++
      $total += $entry.Length
      if ($count -gt 6000 -or $total -gt 1073741824 -or $entry.Length -gt 536870912) { throw 'ASR_SETUP_ARCHIVE_LIMIT' }
      $name = $entry.FullName
      if ($name.Contains('\') -or $name -match '[:\x00]' -or $name -match '(^|/)(\.|\.\.)(/|$)' -or $name.StartsWith('/') -or $name -match '(^|/)[^/]*[. ](/|$)' -or (($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960 -or ($entry.ExternalAttributes -band 1024)) { throw 'ASR_SETUP_ARCHIVE_PATH' }
      if ($name.EndsWith('/')) { continue }
      if ($archive.kind -eq 'python') { $relative = 'env/Scripts/' + $name }
      elseif ($archive.kind -eq 'wheel') { $relative = 'env/Scripts/site-packages/' + $name }
      elseif ($archive.kind -eq 'ffmpeg') {
        if ($name -match '^imageio_ffmpeg/binaries/ffmpeg-[^/]+\.exe$') { $relative = 'ffmpeg.exe'; $ffmpegCount++ }
        elseif ($name -match '(LICENSE|COPYING|NOTICE|README)') { $relative = 'licenses/imageio-ffmpeg/' + $name }
        else { continue }
      } else { throw 'ASR_SETUP_ARCHIVE_KIND' }
      $target = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $relative))
      if (-not $target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'ASR_SETUP_ARCHIVE_PATH' }
      $parent = [IO.Path]::GetDirectoryName($target)
      [IO.Directory]::CreateDirectory($parent) | Out-Null
      $current = $parent
      while ($current.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        if (([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'ASR_SETUP_ARCHIVE_PATH' }
        if ($current -eq $root) { break }
        $current = [IO.Path]::GetDirectoryName($current)
      }
      $inputStream = $entry.Open()
      $outputStream = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose(); $inputStream.Dispose() }
    }
    if ($archive.kind -eq 'ffmpeg' -and $ffmpegCount -ne 1) { throw 'ASR_SETUP_FFMPEG_MISSING' }
  } finally { $zip.Dispose() }
}
Write-Output '{"completed":true}'
