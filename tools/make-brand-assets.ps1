param(
  [string]$OutDir = (Join-Path $PSScriptRoot '..\docs')
)
# Brand assets for the published page: the favicon set and the Open Graph card.
#
# Why raster files and not the SVG/data-URI the page used to carry: Google only accepts
# BMP/GIF/ICO/PNG/JPEG/PPM/TIFF for a favicon and has to be able to crawl it with
# Googlebot-Image — a `data:` URI can never be fetched, and SVG is not in the list. The
# OG card has the same problem on the social side (Facebook/X/LinkedIn render PNG, not SVG).
#
# The wordmark is drawn with the platform font, so this script is the source of truth for
# the binaries: re-run it after changing the mark, commit the regenerated files.

Add-Type -AssemblyName System.Drawing

$out = [System.IO.Path]::GetFullPath($OutDir)
New-Item -ItemType Directory -Force -Path $out | Out-Null

$MARK = 'GO?'
$MARK_FONT = 'Consolas'
$SANS = 'Segoe UI'

function New-SquareMark {
  param([int]$Size, [double]$Fill = 0.86)
  $bmp = New-Object System.Drawing.Bitmap $Size, $Size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Black)
  $g.TextRenderingHint = 'AntiAliasGridFit'

  # Grow the font until the wordmark fills the allowed square: the mark must stay
  # readable when the browser downscales a 192px source into a 16px tab.
  $target = $Size * $Fill
  $lo = 4.0
  $hi = $Size * 3.0
  $font = $null
  for ($i = 0; $i -lt 40; $i++) {
    $mid = ($lo + $hi) / 2
    if ($font) { $font.Dispose() }
    $font = New-Object System.Drawing.Font($MARK_FONT, $mid, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $sz = $g.MeasureString($MARK, $font)
    if ($sz.Width -le $target -and $sz.Height -le $target) { $lo = $mid } else { $hi = $mid }
  }
  if ($font) { $font.Dispose() }
  $font = New-Object System.Drawing.Font($MARK_FONT, $lo, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)

  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = 'Center'
  $fmt.LineAlignment = 'Center'
  # Oversized target rect: DrawString clips to the rect, and centering inside exactly
  # the canvas trims the glyph overhang of the last character.
  $rect = New-Object System.Drawing.RectangleF (-$Size), (-$Size), ($Size * 3), ($Size * 3)
  $g.DrawString($MARK, $font, [System.Drawing.Brushes]::White, $rect, $fmt)
  $font.Dispose()
  $g.Dispose()
  return $bmp
}

function Save-Png {
  param($Bitmap, [string]$Name)
  $path = Join-Path $out $Name
  $Bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output ("[brand] {0} ({1} bytes)" -f $Name, (Get-Item $path).Length)
}

# --- favicon set -------------------------------------------------------------
# ICO carries 16/32/48 so every surface (tab, bookmark, SERP) gets a natively sized frame;
# the PNG siblings cover Google's >48px recommendation and iOS home screens.
$icoFrames = @(16, 32, 48)
$frameBytes = @()
foreach ($s in $icoFrames) {
  $bmp = New-SquareMark -Size $s
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $frameBytes += , ($ms.ToArray())
  $bmp.Dispose()
  $ms.Dispose()
}

$icoPath = Join-Path $out 'favicon.ico'
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter $fs
$bw.Write([uint16]0)                 # reserved
$bw.Write([uint16]1)                 # 1 = icon
$bw.Write([uint16]$icoFrames.Count)  # image count
$offset = 6 + 16 * $icoFrames.Count
for ($i = 0; $i -lt $icoFrames.Count; $i++) {
  $s = $icoFrames[$i]
  $bw.Write([byte]$s)                # width  (0 would mean 256)
  $bw.Write([byte]$s)                # height
  $bw.Write([byte]0)                 # palette colours
  $bw.Write([byte]0)                 # reserved
  $bw.Write([uint16]1)               # planes
  $bw.Write([uint16]32)              # bits per pixel
  $bw.Write([uint32]$frameBytes[$i].Length)
  $bw.Write([uint32]$offset)
  $offset += $frameBytes[$i].Length
}
foreach ($bytes in $frameBytes) { $bw.Write($bytes) }
$bw.Flush(); $bw.Dispose(); $fs.Dispose()
Write-Output ("[brand] favicon.ico ({0} bytes)" -f (Get-Item $icoPath).Length)

$bmp = New-SquareMark -Size 192
Save-Png $bmp 'favicon-192.png'
$bmp.Dispose()

$bmp = New-SquareMark -Size 180 -Fill 0.80
Save-Png $bmp 'apple-touch-icon.png'
$bmp.Dispose()

# --- Open Graph / Twitter card ----------------------------------------------
# Same black-and-mono identity as the page; text is the page's own promise so a shared
# link reads as an answer, not as a logo.
$W = 1200; $H = 630
$card = New-Object System.Drawing.Bitmap $W, $H
$g = [System.Drawing.Graphics]::FromImage($card)
$g.Clear([System.Drawing.Color]::FromArgb(17, 17, 17))
$g.TextRenderingHint = 'AntiAliasGridFit'
$g.SmoothingMode = 'HighQuality'

$markFont = New-Object System.Drawing.Font($MARK_FONT, 250, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$g.DrawString($MARK, $markFont, [System.Drawing.Brushes]::White, 64, 150)
$markFont.Dispose()

$right = 560
$titleFont = New-Object System.Drawing.Font($SANS, 46, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$subFont = New-Object System.Drawing.Font($SANS, 30, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$footFont = New-Object System.Drawing.Font($SANS, 22, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)

$white = [System.Drawing.Brushes]::White
$grey = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(200, 200, 200))
$dim = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(140, 140, 140))

$g.DrawString('OpenCode Go pricing', $titleFont, $white, $right, 208)
$g.DrawString('which model gives the', $subFont, $grey, $right, 284)
$g.DrawString('most for your money?', $subFont, $grey, $right, 328)
$g.DrawString('one agent task, priced across every tariff', $footFont, $dim, $right, 424)
$g.DrawString('and independent TIMETOACT benchmark scores', $footFont, $dim, $right, 458)

$titleFont.Dispose(); $subFont.Dispose(); $footFont.Dispose()
$grey.Dispose(); $dim.Dispose()
$g.Dispose()
Save-Png $card 'og-image.png'
$card.Dispose()
