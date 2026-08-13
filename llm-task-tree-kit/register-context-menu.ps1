$ErrorActionPreference = "Stop"

$KitDir = [System.IO.Path]::GetFullPath($PSScriptRoot)
$launcherDir = Join-Path $env:LOCALAPPDATA "LLMTaskTree"
$installPs1 = Join-Path $launcherDir "install.ps1"
$openPs1 = Join-Path $launcherDir "open.ps1"
$kitPathFile = Join-Path $launcherDir "kit.path"

New-Item -ItemType Directory -Force -Path $launcherDir | Out-Null
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($kitPathFile, $KitDir, $utf8NoBom)
Copy-Item -LiteralPath (Join-Path $KitDir "context-menu-open.ps1") -Destination $openPs1 -Force
Copy-Item -LiteralPath (Join-Path $KitDir "templates\context-menu-install.launcher.ps1") -Destination $installPs1 -Force

$installStubContent = @'
@echo off
setlocal
if "%~1"=="" (
  echo Missing target folder.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -ProjectRoot "%~1"
if errorlevel 1 (
  echo.
  echo Install failed.
  pause
  exit /b 1
)
'@

$openStubContent = @'
@echo off
setlocal
if "%~1"=="" (
  echo Missing target folder.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0open.ps1" -ProjectRoot "%~1"
if errorlevel 1 exit /b 1
'@

$installStub = Join-Path $launcherDir "install.cmd"
$openStub = Join-Path $launcherDir "open.cmd"

Set-Content -LiteralPath $installStub -Value $installStubContent -Encoding ASCII
Set-Content -LiteralPath $openStub -Value $openStubContent -Encoding ASCII

foreach ($path in @($installStub, $openStub, $installPs1, $openPs1, (Join-Path $KitDir "deploy-task-tree.ps1"))) {
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Missing file: $path"
  }
}

function Remove-ShellCommand {
  param(
    [string]$BaseKey,
    [string]$Name
  )
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "SilentlyContinue"
  & reg.exe delete "HKCU\Software\Classes\$BaseKey\shell\$Name" /f *> $null
  $ErrorActionPreference = $prev
}

function Remove-RegistryTree {
  param([string]$KeyPath)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "SilentlyContinue"
  & reg.exe delete $KeyPath /f *> $null
  $ErrorActionPreference = $prev
}

function Add-ShellCommand {
  param(
    [string]$BaseKey,
    [string]$Name,
    [string]$Label,
    [string]$Command,
    [string]$Position = "Top"
  )

  & reg.exe add "HKCU\Software\Classes\$BaseKey\shell\$Name" /ve /d $Label /f *> $null
  if ($Position) {
    & reg.exe add "HKCU\Software\Classes\$BaseKey\shell\$Name" /v Position /d $Position /f *> $null
  }
  & reg.exe add "HKCU\Software\Classes\$BaseKey\shell\$Name\command" /ve /d $Command /f *> $null
}

$quotedInstallFolder = "`"$installStub`" `"%1`""
$quotedOpenFolder = "`"$openStub`" `"%1`""
$quotedInstallBackground = "`"$installStub`" `"%V`""
$quotedOpenBackground = "`"$openStub`" `"%V`""

$legacyNames = @(
  @{ BaseKey = "Directory"; Name = "LLMTaskTree.Install" },
  @{ BaseKey = "Directory"; Name = "LLMTaskTree.Open" },
  @{ BaseKey = "Directory\Background"; Name = "LLMTaskTree.Install" },
  @{ BaseKey = "Directory\Background"; Name = "LLMTaskTree.Open" },
  @{ BaseKey = "Folder"; Name = "LLMTaskTree.Install" },
  @{ BaseKey = "Folder"; Name = "LLMTaskTree.Open" },
  @{ BaseKey = "Folder"; Name = "LLMTaskTreeInstall" },
  @{ BaseKey = "Folder"; Name = "LLMTaskTreeOpen" }
)

foreach ($item in $legacyNames) {
  Remove-ShellCommand -BaseKey $item.BaseKey -Name $item.Name
}

Remove-ShellCommand -BaseKey "Directory\Background" -Name "LLMTaskTreeInstallTest"
Remove-RegistryTree -KeyPath "HKCU\Software\Classes\Folder"

$labelInstall = "Install LLM Task Tree"
$labelOpen = "Open Task Tree"

$targets = @(
  @{ BaseKey = "Directory"; InstallArg = $quotedInstallFolder; OpenArg = $quotedOpenFolder },
  @{ BaseKey = "Directory\Background"; InstallArg = $quotedInstallBackground; OpenArg = $quotedOpenBackground }
)

foreach ($target in $targets) {
  Add-ShellCommand -BaseKey $target.BaseKey -Name "LLMTaskTreeInstall" -Label $labelInstall -Command $target.InstallArg -Position "Top"
  Add-ShellCommand -BaseKey $target.BaseKey -Name "LLMTaskTreeOpen" -Label $labelOpen -Command $target.OpenArg -Position "Bottom"
}

& reg.exe add "HKCU\Software\LLMTaskTree" /v KitDir /d $KitDir /f *> $null
& reg.exe add "HKCU\Software\LLMTaskTree" /v LauncherDir /d $launcherDir /f *> $null

Write-Host ""
Write-Host "Context menu registered (right-click only)." -ForegroundColor Green
Write-Host "  Install LLM Task Tree"
Write-Host "  Open Task Tree"
Write-Host ""
Write-Host ("Kit dir: " + $KitDir)
Write-Host ("Launcher dir: " + $launcherDir)
Write-Host ""
Write-Host "Double-click folders still opens them normally."
Write-Host "Use right-click in Windows File Explorer (not Cursor sidebar)."
Write-Host ""
Write-Host "Restarting Explorer..."
Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
Start-Process explorer.exe
Write-Host "Done."
