$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$output = Join-Path $root "artifacts\readme-hero.png"
$overviewPath = Join-Path $root "artifacts\project-overview-desktop.png"
$treePath = Join-Path $root "artifacts\task-tree-semantic-zoom-macro.png"
$lensPath = Join-Path $root "artifacts\focus-lens-desktop.png"

$canvas = New-Object System.Drawing.Bitmap 1920,720
$canvas.SetResolution(144, 144)
$graphics = [System.Drawing.Graphics]::FromImage($canvas)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$graphics.Clear([System.Drawing.ColorTranslator]::FromHtml("#F3F6F4"))

$ink = [System.Drawing.ColorTranslator]::FromHtml("#13251F")
$muted = [System.Drawing.ColorTranslator]::FromHtml("#587068")
$accent = [System.Drawing.ColorTranslator]::FromHtml("#0F766E")
$border = [System.Drawing.ColorTranslator]::FromHtml("#C9D6D0")
$white = [System.Drawing.Color]::White
$fontFamily = "Microsoft YaHei UI"
$titleFont = New-Object System.Drawing.Font $fontFamily, 27, ([System.Drawing.FontStyle]::Bold)
$subtitleFont = New-Object System.Drawing.Font $fontFamily, 14, ([System.Drawing.FontStyle]::Regular)
$panelFont = New-Object System.Drawing.Font $fontFamily, 16, ([System.Drawing.FontStyle]::Bold)
$stepFont = New-Object System.Drawing.Font $fontFamily, 12, ([System.Drawing.FontStyle]::Bold)
$captionFont = New-Object System.Drawing.Font $fontFamily, 11, ([System.Drawing.FontStyle]::Regular)

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

function Draw-Panel($x, $step, $title, $caption, $imagePath) {
  $panel = New-Object System.Drawing.RectangleF $x,174,560,470
  $shadow = New-Object System.Drawing.RectangleF ($x + 7),182,560,470
  $shadowPath = New-RoundedPath $shadow 16
  $graphics.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(24, 22, 50, 40))), $shadowPath)
  $shadowPath.Dispose()

  $panelPath = New-RoundedPath $panel 16
  $graphics.FillPath((New-Object System.Drawing.SolidBrush $white), $panelPath)
  $graphics.DrawPath((New-Object System.Drawing.Pen $border, 2), $panelPath)

  $circle = New-Object System.Drawing.RectangleF ($x + 28),198,34,34
  $graphics.FillEllipse((New-Object System.Drawing.SolidBrush $accent), $circle)
  $stepSize = $graphics.MeasureString($step, $stepFont)
  $graphics.DrawString($step, $stepFont, (New-Object System.Drawing.SolidBrush $white), ($circle.X + (($circle.Width - $stepSize.Width) / 2)), ($circle.Y + 5))
  $graphics.DrawString($title, $panelFont, (New-Object System.Drawing.SolidBrush $ink), ($x + 76),197)
  $graphics.DrawString($caption, $captionFont, (New-Object System.Drawing.SolidBrush $muted), ($x + 30),244)

  $image = [System.Drawing.Image]::FromFile($imagePath)
  $imageRect = New-Object System.Drawing.RectangleF ($x + 24),286,512,320
  $imagePathShape = New-RoundedPath $imageRect 10
  $oldClip = $graphics.Clip
  $graphics.SetClip($imagePathShape)
  $source = New-Object System.Drawing.Rectangle 0,0,$image.Width,$image.Height
  $graphics.DrawImage($image, $imageRect, $source, [System.Drawing.GraphicsUnit]::Pixel)
  $graphics.Clip = $oldClip
  $graphics.DrawPath((New-Object System.Drawing.Pen $border, 1), $imagePathShape)
  $imagePathShape.Dispose()
  $image.Dispose()
  $panelPath.Dispose()
}

$graphics.DrawString("From project context to the next action", $titleFont, (New-Object System.Drawing.SolidBrush $ink), 72,34)
$graphics.DrawString("Three complete landscape views: overview, task-tree trunk, and focused reasoning.", $subtitleFont, (New-Object System.Drawing.SolidBrush $muted), 76,96)

$linePen = New-Object System.Drawing.Pen $border, 4
$linePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$graphics.DrawLine($linePen, 608,407,650,407)
$graphics.DrawLine($linePen, 1216,407,1258,407)
$arrowPen = New-Object System.Drawing.Pen $accent, 4
$arrowPen.CustomEndCap = New-Object System.Drawing.Drawing2D.AdjustableArrowCap 5,7
$graphics.DrawLine($arrowPen, 608,407,637,407)
$graphics.DrawLine($arrowPen, 1216,407,1245,407)

Draw-Panel 64 "1" "Project overview" "Goal - progress - current problem" $overviewPath
Draw-Panel 680 "2" "Task-tree trunk" "Direction and focus at a glance" $treePath
Draw-Panel 1296 "3" "Focused node" "Problem - approach - result" $lensPath

$graphics.Dispose()
$canvas.Save($output, [System.Drawing.Imaging.ImageFormat]::Png)
$canvas.Dispose()
$titleFont.Dispose()
$subtitleFont.Dispose()
$panelFont.Dispose()
$stepFont.Dispose()
$captionFont.Dispose()
$linePen.Dispose()
$arrowPen.Dispose()

Write-Output $output
