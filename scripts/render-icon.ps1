Add-Type -AssemblyName System.Drawing

$size = 128
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

$blue = [System.Drawing.Color]::FromArgb(0x37, 0x94, 0xFF)
$strokeWidth = 128.0 / 24.0 * 2.0
$pen = New-Object System.Drawing.Pen($blue, $strokeWidth)
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

$scale = 128.0 / 24.0

# Center circle (cx=12, cy=12, r=3) -> (64, 64), r=16
$cx = 12 * $scale
$cy = 12 * $scale
$cr = 3 * $scale
$g.DrawEllipse($pen, [float]($cx - $cr), [float]($cy - $cr), [float]($cr * 2), [float]($cr * 2))

function DrawLine($x1, $y1, $x2, $y2) {
  $g.DrawLine($pen, [float]($x1 * $scale), [float]($y1 * $scale), [float]($x2 * $scale), [float]($y2 * $scale))
}

DrawLine 12 1 12 5
DrawLine 12 19 12 23
DrawLine 4.22 4.22 7.05 7.05
DrawLine 16.95 16.95 19.78 19.78
DrawLine 1 12 5 12
DrawLine 19 12 23 12
DrawLine 4.22 19.78 7.05 16.95
DrawLine 16.95 7.05 19.78 4.22

$out = Join-Path $PSScriptRoot "..\media\argus-icon.png"
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()

Write-Output "wrote $out ($size x $size)"
