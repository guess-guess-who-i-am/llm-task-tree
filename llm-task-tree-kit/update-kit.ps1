param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectRoot,

  [string]$KitSource = "",
  [switch]$OpenAfterUpdate
)

$ErrorActionPreference = "Stop"

$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
$deployScript = Join-Path $PSScriptRoot "deploy-task-tree.ps1"

if (-not (Test-Path -LiteralPath $deployScript)) {
  throw "Missing deploy script: $deployScript"
}

Write-Host ""
Write-Host "=== LLM Task Tree Kit Update (single project) ===" -ForegroundColor Green
Write-Host "Project: $ProjectRoot"
Write-Host ""
Write-Host "Preserved at project root:" -ForegroundColor Yellow
Write-Host "  task-tree.md, versions/, knowledge/, .env (if exists), your AGENTS.md body"
Write-Host ""
Write-Host "Updated under llm-task-tree/:" -ForegroundColor Cyan
Write-Host "  server.js, public/, install.ps1, templates/, skills/, ..."
Write-Host ""

$deployArgs = @{
  ProjectRoot = $ProjectRoot
  SetupFile   = $MyInvocation.MyCommand.Path
}
if ($KitSource) {
  $deployArgs.KitSource = $KitSource
}
if ($OpenAfterUpdate) {
  $deployArgs.OpenAfterInstall = $true
}

& powershell -NoProfile -ExecutionPolicy Bypass -File $deployScript @deployArgs
if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

Write-Host ""
Write-Host "Update complete for: $ProjectRoot" -ForegroundColor Green
Write-Host ""
