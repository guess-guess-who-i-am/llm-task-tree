# Build distributable LLM Task Tree installer zip
param(
  [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$KitSource = Join-Path $RepoRoot "llm-task-tree-kit"
if (-not (Test-Path -LiteralPath $KitSource)) {
  throw "Missing kit folder: $KitSource"
}

if (-not $OutDir) {
  $OutDir = Join-Path $RepoRoot "dist"
}
$Staging = Join-Path $OutDir "LLMTaskTree-staging"
$ZipPath = Join-Path $OutDir "LLMTaskTree-Setup.zip"

if (Test-Path -LiteralPath $Staging) {
  Remove-Item -LiteralPath $Staging -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $Staging | Out-Null
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$excludeDirs = @("node_modules", ".git", "dist")
$excludeFiles = @("setup-task-tree.kitpath")

Get-ChildItem -LiteralPath $KitSource -Force | ForEach-Object {
  if ($excludeDirs -contains $_.Name) { return }
  if (-not $_.PSIsContainer -and ($excludeFiles -contains $_.Name)) { return }
  Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $Staging $_.Name) -Recurse -Force
}

if (Test-Path -LiteralPath $ZipPath) {
  Remove-Item -LiteralPath $ZipPath -Force
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($Staging, $ZipPath)

Write-Host ""
Write-Host "Built: $ZipPath" -ForegroundColor Green
Write-Host "Share this zip. User extracts and runs Setup.cmd (first install) or Update.cmd / 一键更新.cmd (update)" -ForegroundColor Green
Write-Host ""
