$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $root "artifacts\readme-tree-wide.png"
$focusPath = Join-Path $root "artifacts\readme-focus-wide.png"
$heroPath = Join-Path $root "artifacts\readme-hero.png"
$coverPath = Join-Path $root "artifacts\readme-demo-cover.png"

function New-RoundedPath([System.Drawing.RectangleF]$rect, [float]$radius) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $diameter = $radius * 2
  $path.AddArc($rect.X, $rect.Y, $diameter, $diameter, 180, 90)
  $path.AddArc($rect.Right - $diameter, $rect.Y, $diameter, $diameter, 270, 90)
  $path.AddArc($rect.Right - $diameter, $rect.Bottom - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($rect.X, $rect.Bottom - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function Draw-CoverImage($graphics, $image, [System.Drawing.RectangleF]$destination, [float]$radius) {
  $path = $null
  $previousClip = $null
  if ($radius -gt 0) {
    $path = New-RoundedPath $destination $radius
    $previousClip = $graphics.Clip.Clone()
    $graphics.SetClip($path)
  }
  $sourceRatio = $image.Width / $image.Height
  $targetRatio = $destination.Width / $destination.Height
  if ($sourceRatio -gt $targetRatio) {
    $sourceHeight = $image.Height
    $sourceWidth = [int]($sourceHeight * $targetRatio)
    $sourceX = [int](($image.Width - $sourceWidth) / 2)
    $source = New-Object System.Drawing.Rectangle $sourceX,0,$sourceWidth,$sourceHeight
  } else {
    $sourceWidth = $image.Width
    $sourceHeight = [int]($sourceWidth / $targetRatio)
    $sourceY = [int](($image.Height - $sourceHeight) / 2)
    $source = New-Object System.Drawing.Rectangle 0,$sourceY,$sourceWidth,$sourceHeight
  }
  $graphics.DrawImage($image, $destination, $source, [System.Drawing.GraphicsUnit]::Pixel)
  if ($path) {
    $graphics.Clip = $previousClip
    $previousClip.Dispose()
    $path.Dispose()
  }
}

$fontFamily = "Microsoft YaHei UI"
$ink = [System.Drawing.ColorTranslator]::FromHtml("#1D1D1F")
$muted = [System.Drawing.ColorTranslator]::FromHtml("#6E6E73")
$surface = [System.Drawing.ColorTranslator]::FromHtml("#F5F5F7")

$source = [System.Drawing.Image]::FromFile($sourcePath)
$hero = New-Object System.Drawing.Bitmap 1920,1200
$hero.SetResolution(144, 144)
$graphics = [System.Drawing.Graphics]::FromImage($hero)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$graphics.Clear($surface)

$titleFont = New-Object System.Drawing.Font $fontFamily,58,([System.Drawing.FontStyle]::Bold)
$subtitleFont = New-Object System.Drawing.Font $fontFamily,24,([System.Drawing.FontStyle]::Regular)
$title = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("6K6p6ZW/5pyf6aG555uu77yM5LiA55y85Zue5Yiw5q2j6L2o44CC"))
$subtitle = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("5qC55pys55uu5qCH44CB5b2T5YmN6L+b5bqm44CB6IqC54K55oCd6Lev5ZKM5LiL5LiA5q2l77yM5Zyo5ZCM5LiA5byg5Zu+6YeM5L+d5oyB5LiA6Ie044CC"))
$titleSize = $graphics.MeasureString($title, $titleFont)
$subtitleSize = $graphics.MeasureString($subtitle, $subtitleFont)
$graphics.DrawString($title, $titleFont, (New-Object System.Drawing.SolidBrush $ink), ((1920 - $titleSize.Width) / 2), 72)
$graphics.DrawString($subtitle, $subtitleFont, (New-Object System.Drawing.SolidBrush $muted), ((1920 - $subtitleSize.Width) / 2), 215)

$shadowRect = New-Object System.Drawing.RectangleF 117,310,1686,1054
$shadowPath = New-RoundedPath $shadowRect 24
$graphics.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(24,0,0,0))), $shadowPath)
$shadowPath.Dispose()
$screenRect = New-Object System.Drawing.RectangleF 120,300,1680,1050
Draw-CoverImage $graphics $source $screenRect 22

$graphics.Dispose()
$hero.Save($heroPath, [System.Drawing.Imaging.ImageFormat]::Png)
$hero.Dispose()
$source.Dispose()
$titleFont.Dispose()
$subtitleFont.Dispose()

$focus = [System.Drawing.Image]::FromFile($focusPath)
$cover = New-Object System.Drawing.Bitmap 1600,1000
$cover.SetResolution(144, 144)
$coverGraphics = [System.Drawing.Graphics]::FromImage($cover)
$coverGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$coverGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$coverGraphics.Clear([System.Drawing.Color]::White)
$coverRect = New-Object System.Drawing.RectangleF 0,0,1600,1000
Draw-CoverImage $coverGraphics $focus $coverRect 0
$coverGraphics.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(38,0,0,0))), 0,0,1600,1000)
$circleRect = New-Object System.Drawing.RectangleF 734,434,132,132
$coverGraphics.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(236,255,255,255))), $circleRect)
$triangle = [System.Drawing.PointF[]]@(
  (New-Object System.Drawing.PointF 786,471),
  (New-Object System.Drawing.PointF 786,529),
  (New-Object System.Drawing.PointF 835,500)
)
$coverGraphics.FillPolygon((New-Object System.Drawing.SolidBrush $ink), $triangle)
$coverGraphics.Dispose()
$cover.Save($coverPath, [System.Drawing.Imaging.ImageFormat]::Png)
$cover.Dispose()
$focus.Dispose()

Write-Output $heroPath
Write-Output $coverPath
