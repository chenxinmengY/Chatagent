param(
  [Parameter(Mandatory=$true)][ValidateSet('Windows','Android')][string]$Target,
  [Parameter(Mandatory=$true)][string]$OutputDirectory
)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
$repo=Split-Path -Parent $PSScriptRoot
$source=[Drawing.Bitmap]::FromFile((Join-Path $repo 'apps\branding\app-icon.png'))
$OutputDirectory=[IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
function New-IconBitmap([int]$Size,[switch]$Rounded) {
  $bitmap=New-Object Drawing.Bitmap $Size,$Size
  $graphics=[Drawing.Graphics]::FromImage($bitmap)
  $attributes=New-Object Drawing.Imaging.ImageAttributes
  try {
    $graphics.InterpolationMode='HighQualityBicubic';$graphics.PixelOffsetMode='HighQuality'
    $attributes.SetWrapMode([Drawing.Drawing2D.WrapMode]::TileFlipXY)
    $graphics.DrawImage($source,[Drawing.Rectangle]::new(0,0,$Size,$Size),0,0,$source.Width,$source.Height,[Drawing.GraphicsUnit]::Pixel,$attributes)
  } finally { $attributes.Dispose();$graphics.Dispose() }
  if(-not $Rounded){return $bitmap}
  $roundedBitmap=New-Object Drawing.Bitmap $Size,$Size
  $graphics=[Drawing.Graphics]::FromImage($roundedBitmap)
  $brush=New-Object Drawing.TextureBrush $bitmap
  $outline=New-Object Drawing.Drawing2D.GraphicsPath
  try {
    $graphics.Clear([Drawing.Color]::Transparent);$graphics.SmoothingMode='AntiAlias'
    $diameter=[single]($Size*0.36);$edge=[single]$Size
    $outline.AddArc(0,0,$diameter,$diameter,180,90)
    $outline.AddArc(($edge-$diameter),0,$diameter,$diameter,270,90)
    $outline.AddArc(($edge-$diameter),($edge-$diameter),$diameter,$diameter,0,90)
    $outline.AddArc(0,($edge-$diameter),$diameter,$diameter,90,90)
    $outline.CloseFigure();$graphics.FillPath($brush,$outline)
  } finally { $outline.Dispose();$brush.Dispose();$graphics.Dispose();$bitmap.Dispose() }
  return $roundedBitmap
}
try {
  if($Target -eq 'Windows') {
    $frames=@(foreach($size in @(16,24,32,48,64,128,256)) {
      $bitmap=New-IconBitmap $size -Rounded
      $memory=New-Object IO.MemoryStream
      try { $bitmap.Save($memory,[Drawing.Imaging.ImageFormat]::Png);[PSCustomObject]@{Size=$size;Bytes=$memory.ToArray()} }
      finally { $memory.Dispose();$bitmap.Dispose() }
    })
    $stream=[IO.File]::Create((Join-Path $OutputDirectory 'Chatagent.ico'))
    $writer=New-Object IO.BinaryWriter $stream
    try {
      $writer.Write([uint16]0);$writer.Write([uint16]1);$writer.Write([uint16]$frames.Count)
      $offset=6+16*$frames.Count
      foreach($frame in $frames) {
        $dimension=if($frame.Size -eq 256){0}else{$frame.Size}
        $writer.Write([byte]$dimension);$writer.Write([byte]$dimension);$writer.Write([byte]0);$writer.Write([byte]0)
        $writer.Write([uint16]1);$writer.Write([uint16]32);$writer.Write([uint32]$frame.Bytes.Length);$writer.Write([uint32]$offset)
        $offset+=$frame.Bytes.Length
      }
      foreach($frame in $frames){$writer.Write([byte[]]$frame.Bytes)}
    } finally { $writer.Dispose() }
  } else {
    foreach($density in @(@('mdpi',48),@('hdpi',72),@('xhdpi',96),@('xxhdpi',144),@('xxxhdpi',192))) {
      $directory=Join-Path $OutputDirectory ('mipmap-'+$density[0])
      New-Item -ItemType Directory -Path $directory -Force | Out-Null
      $bitmap=New-IconBitmap $density[1]
      try { $bitmap.Save((Join-Path $directory 'ic_launcher.png'),[Drawing.Imaging.ImageFormat]::Png) }
      finally { $bitmap.Dispose() }
    }
    # Android uses a 108dp layer with the approved artwork inside the central 66dp.
    # Extend the edge pixels into the overscan area so launcher motion cannot reveal a seam.
    $art=New-IconBitmap 264
    $foreground=New-Object Drawing.Bitmap 432,432
    $graphics=[Drawing.Graphics]::FromImage($foreground)
    try {
      $graphics.InterpolationMode='NearestNeighbor';$graphics.PixelOffsetMode='Half'
      $segments=@(@(0,84,0,1),@(84,264,0,264),@(348,84,263,1))
      foreach($x in $segments){foreach($y in $segments){
        $graphics.DrawImage($art,[Drawing.Rectangle]::new($x[0],$y[0],$x[1],$y[1]),$x[2],$y[2],$x[3],$y[3],[Drawing.GraphicsUnit]::Pixel)
      }}
      $directory=Join-Path $OutputDirectory 'drawable-nodpi'
      New-Item -ItemType Directory -Path $directory -Force | Out-Null
      $foreground.Save((Join-Path $directory 'ic_launcher_foreground.png'),[Drawing.Imaging.ImageFormat]::Png)
    } finally { $graphics.Dispose();$foreground.Dispose();$art.Dispose() }
  }
} finally { $source.Dispose() }
