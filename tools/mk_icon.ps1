# Build app icons from one PNG:
#   src-tauri/icons/icon.png  (window / tray / taskbar big icon; embedded via include_bytes!)
#   src-tauri/icons/icon.ico  (multi-size 16/32/48/64/128/256; exe resource + taskbar)
# Usage: powershell -File tools/mk_icon.ps1 -Src <png> [-OutDir src-tauri/icons]
param(
  [Parameter(Mandatory = $true)][string]$Src,
  [string]$OutDir = "src-tauri/icons"
)

Add-Type -AssemblyName System.Drawing
$srcImg = [System.Drawing.Image]::FromFile($Src)
Write-Host ("source: {0}  {1}x{2}" -f $Src, $srcImg.Width, $srcImg.Height)

if (!(Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }

# 1) icon.png - keep the original pixels
$pngPath = Join-Path $OutDir "icon.png"
$srcImg.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Host ("wrote {0} ({1} bytes)" -f $pngPath, (Get-Item $pngPath).Length)

# 2) icon.ico - small sizes as BMP entries, 256 as PNG entry
$sizes = @(16, 32, 48, 64, 128, 256)
$entries = New-Object System.Collections.ArrayList
foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($srcImg, 0, 0, $s, $s)
  $g.Dispose()

  # PNG payload (used for 256x256)
  $pms = New-Object System.IO.MemoryStream
  $bmp.Save($pms, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngBytes = $pms.ToArray()
  $pms.Dispose()

  # BMP payload: BITMAPINFOHEADER (height = 2x) + bottom-up BGRA + AND mask
  $rowBytes = $s * 4
  $maskRow = [int]([Math]::Floor(($s + 31) / 32) * 4)
  $maskBytes = $maskRow * $s
  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($ms)
  $bw.Write([uint32]40)
  $bw.Write([int32]$s)
  $bw.Write([int32]($s * 2))
  $bw.Write([uint16]1)
  $bw.Write([uint16]32)
  $bw.Write([uint32]0)
  $bw.Write([uint32]($rowBytes * $s + $maskBytes))
  $bw.Write([int32]0); $bw.Write([int32]0)
  $bw.Write([uint32]0); $bw.Write([uint32]0)
  $rect = New-Object System.Drawing.Rectangle 0, 0, $s, $s
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
                       [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $stride = $data.Stride
  $raw = New-Object byte[] ($stride * $s)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $raw, 0, $raw.Length)
  $bmp.UnlockBits($data)
  for ($y = $s - 1; $y -ge 0; $y--) {
    $off = $y * $stride
    for ($x = 0; $x -lt $s; $x++) {
      $b = $raw[$off + $x * 4 + 0]
      $gg = $raw[$off + $x * 4 + 1]
      $r = $raw[$off + $x * 4 + 2]
      $a = $raw[$off + $x * 4 + 3]
      $bw.Write([byte]$b); $bw.Write([byte]$gg); $bw.Write([byte]$r); $bw.Write([byte]$a)
    }
  }
  $bw.Write((New-Object byte[] $maskBytes))
  $bw.Flush()
  $bmpBytes = $ms.ToArray()
  $bw.Dispose(); $ms.Dispose(); $bmp.Dispose()

  $payload = if ($s -ge 256) { $pngBytes } else { $bmpBytes }
  [void]$entries.Add([pscustomobject]@{ Size = $s; Bytes = $payload })
}

$icoPath = Join-Path $OutDir "icon.ico"
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$entries.Count)
$offset = 6 + 16 * $entries.Count
foreach ($e in $entries) {
  $d = if ($e.Size -ge 256) { 0 } else { $e.Size }
  $bw.Write([byte]$d); $bw.Write([byte]$d); $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([uint16]1); $bw.Write([uint16]32)
  $bw.Write([uint32]($e.Bytes.Length)); $bw.Write([uint32]$offset)
  $offset += $e.Bytes.Length
}
foreach ($e in $entries) { $bw.Write([byte[]]$e.Bytes) }
$bw.Flush(); $bw.Dispose(); $fs.Dispose()
Write-Host ("wrote {0} ({1} bytes, sizes {2})" -f $icoPath, (Get-Item $icoPath).Length, ($sizes -join "/"))
$srcImg.Dispose()
