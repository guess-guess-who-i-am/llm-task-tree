param(
  [switch]$KeepFiles
)

$ErrorActionPreference = "Stop"

$InstallDir = ""
$regKit = ""
try {
  $regKit = (Get-ItemProperty -LiteralPath "HKCU:\Software\LLMTaskTree" -Name KitDir -ErrorAction Stop).KitDir
  $InstallDir = $regKit
} catch {
}

if (-not $InstallDir -and $PSScriptRoot) {
  $manifest = Join-Path $PSScriptRoot "install.manifest.json"
  if (Test-Path -LiteralPath $manifest) {
    $InstallDir = $PSScriptRoot
  }
}

Add-Type -AssemblyName System.Windows.Forms

if (-not $KeepFiles) {
  $answer = [System.Windows.Forms.MessageBox]::Show(
    "Remove LLM Task Tree context menu and optional install files?`n`nYes = remove menu + delete install folder`nNo = remove menu only`nCancel = abort",
    "Uninstall LLM Task Tree",
    [System.Windows.Forms.MessageBoxButtons]::YesNoCancel,
    [System.Windows.Forms.MessageBoxIcon]::Question
  )
  if ($answer -eq [System.Windows.Forms.DialogResult]::Cancel) {
    exit 0
  }
  $deleteFiles = ($answer -eq [System.Windows.Forms.DialogResult]::Yes)
} else {
  $deleteFiles = $false
}

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "unregister-context-menu.ps1")

$launcherDir = Join-Path $env:LOCALAPPDATA "LLMTaskTree"
if (Test-Path -LiteralPath $launcherDir) {
  Remove-Item -LiteralPath $launcherDir -Recurse -Force
}

if ($deleteFiles -and $InstallDir -and (Test-Path -LiteralPath $InstallDir)) {
  Remove-Item -LiteralPath $InstallDir -Recurse -Force
}

[System.Windows.Forms.MessageBox]::Show(
  "LLM Task Tree has been uninstalled.",
  "Uninstall",
  [System.Windows.Forms.MessageBoxButtons]::OK,
  [System.Windows.Forms.MessageBoxIcon]::Information
) | Out-Null
