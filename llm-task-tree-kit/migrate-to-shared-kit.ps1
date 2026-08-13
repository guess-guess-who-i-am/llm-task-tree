param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectRoot,

  [string]$KitSource = "",
  [switch]$OpenAfter
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "kit-runtime.ps1")

$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
$StubDir = Join-Path $ProjectRoot "llm-task-tree"
$kitSource = Find-GlobalKitSource -Explicit $KitSource

Write-Host ""
Write-Host "=== Migrate to Shared Kit ===" -ForegroundColor Green
Write-Host "Project: $ProjectRoot"
Write-Host "Shared kit: $kitSource"
Write-Host ""
Write-Host "Keeps: task-tree.md, versions/, knowledge/, .env, AGENTS.md body"
Write-Host "Replaces: llm-task-tree/ full copy -> small stub pointing to shared kit"
Write-Host ""

if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot "task-tree.md"))) {
  Write-Warning "No task-tree.md in project root. Continue only if this is really a task-tree project."
}

Stop-ProjectTaskTreeServer -ProjectRoot $ProjectRoot
Start-Sleep -Milliseconds 300

if (Test-Path -LiteralPath $StubDir) {
  Write-Host "Removing old llm-task-tree copy..."
  Remove-ProjectKitDirectory -StubDir $StubDir
}

Write-SharedKitStub -StubDir $StubDir -SharedKitDir $kitSource -ProjectRoot $ProjectRoot

$install = Join-Path $kitSource "install.ps1"
& powershell -NoProfile -ExecutionPolicy Bypass -File $install -StubDir $StubDir
if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
  throw "install.ps1 failed with exit code $LASTEXITCODE"
}

Register-TaskTreeProject -ProjectRoot $ProjectRoot

Write-Host ""
Write-Host "Migration complete." -ForegroundColor Green
Write-Host "Next: update-shared-kit.cmd once to refresh all projects."
Write-Host ""

if ($OpenAfter) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $StubDir "open-task-tree.ps1")
}
