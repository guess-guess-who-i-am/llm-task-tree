param(
  [string]$InstallDir = "",
  [switch]$Repair,
  [switch]$Silent
)

$ErrorActionPreference = "Stop"

$SourceDir = [System.IO.Path]::GetFullPath($PSScriptRoot)
$Version = "0.1.0"
$ExcludeDirs = @("node_modules", ".git", "dist", "versions")
$ExcludeFiles = @("setup-task-tree.kitpath")

function Write-Step([string]$Message) {
  Write-Host ">> $Message" -ForegroundColor Cyan
}

function Test-NodeJs {
  try {
    $version = & node --version 2>$null
    return [string]$version
  } catch {
    return ""
  }
}

function Show-Info([string]$Title, [string]$Message) {
  Add-Type -AssemblyName System.Windows.Forms
  [void][System.Windows.Forms.MessageBox]::Show($Message, $Title, [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information)
}

function Show-ErrorBox([string]$Title, [string]$Message) {
  Add-Type -AssemblyName System.Windows.Forms
  [void][System.Windows.Forms.MessageBox]::Show($Message, $Title, [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error)
}

function Pick-InstallDir {
  Add-Type -AssemblyName System.Windows.Forms
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = "Choose where to install LLM Task Tree (any drive/folder)"
  $dialog.ShowNewFolderButton = $true
  $defaultRoot = [Environment]::GetFolderPath("MyDocuments")
  if (-not $defaultRoot) {
    $defaultRoot = "C:\"
  }
  $dialog.SelectedPath = $defaultRoot
  $result = $dialog.ShowDialog()
  if ($result -ne [System.Windows.Forms.DialogResult]::OK) {
    throw "Install cancelled."
  }
  return [System.IO.Path]::GetFullPath($dialog.SelectedPath)
}

function Sync-InstallFiles {
  param(
    [string]$Source,
    [string]$Destination
  )

  if (-not (Test-Path -LiteralPath $Destination)) {
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  }

  Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
    if ($ExcludeDirs -contains $_.Name) { return }
    if (-not $_.PSIsContainer -and ($ExcludeFiles -contains $_.Name)) { return }

    $target = Join-Path $Destination $_.Name
    if ($_.PSIsContainer) {
      if (Test-Path -LiteralPath $target) {
        Remove-Item -LiteralPath $target -Recurse -Force
      }
      Copy-Item -LiteralPath $_.FullName -Destination $target -Recurse -Force
    } else {
      Copy-Item -LiteralPath $_.FullName -Destination $target -Force
    }
  }
}

Write-Host ""
Write-Host "=== LLM Task Tree Setup v$Version ===" -ForegroundColor Green

$nodeVersion = Test-NodeJs
if (-not $nodeVersion) {
  $msg = "Node.js was not found.`n`nInstall Node.js 18+ from https://nodejs.org/ then run Setup again."
  if ($Silent) { throw $msg }
  Show-ErrorBox "LLM Task Tree Setup" $msg
  exit 1
}
Write-Step ("Node.js: " + $nodeVersion)

if (-not $InstallDir) {
  if ($Silent) {
    throw "InstallDir is required for silent setup."
  }
  $InstallDir = Pick-InstallDir
}

$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$sourceNorm = $SourceDir.TrimEnd('\')
$installNorm = $InstallDir.TrimEnd('\')
$alreadyInstalled = Test-Path (Join-Path $InstallDir "install.manifest.json")

if ($alreadyInstalled -and -not $Repair -and $sourceNorm -eq $installNorm) {
  Write-Step "Already installed here. Re-registering context menu..."
  $Repair = $true
}

if (-not $Repair -and $sourceNorm -ne $installNorm) {
  Write-Step ("Copy files -> " + $InstallDir)
  Sync-InstallFiles -Source $SourceDir -Destination $InstallDir
} elseif ($Repair) {
  Write-Step "Repair mode: skip file copy"
} else {
  Write-Step "Install dir equals source dir; skip copy"
}

Write-Step "Running npm install..."
Push-Location $InstallDir
try {
  & npm install 2>&1 | Out-Host
} finally {
  Pop-Location
}

$manifest = @{
  version = $Version
  installedAt = (Get-Date).ToString("o")
  installDir = $InstallDir
} | ConvertTo-Json
$manifestPath = Join-Path $InstallDir "install.manifest.json"
Set-Content -LiteralPath $manifestPath -Value $manifest -Encoding UTF8

Write-Step "Registering Explorer right-click menu..."
$registerScript = Join-Path $InstallDir "register-context-menu.ps1"
& powershell -NoProfile -ExecutionPolicy Bypass -File $registerScript
if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
  throw "register-context-menu.ps1 failed with exit code $LASTEXITCODE"
}

$done = @"
Install complete.

Install folder:
$InstallDir

How to use:
1. Open Windows File Explorer (not Cursor sidebar)
2. Right-click any folder -> Install LLM Task Tree
3. Right-click again -> Open Task Tree

To update later: copy a new kit folder anywhere and run Update.cmd (or 一键更新.cmd).

To uninstall: run Uninstall.cmd in the install folder.
"@

Write-Host ""
Write-Host $done -ForegroundColor Green
if (-not $Silent) {
  Show-Info "LLM Task Tree Setup" $done
}
