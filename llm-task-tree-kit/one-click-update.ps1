param(
  [string]$KitTarget = "",
  [switch]$Silent,
  [switch]$SkipBuildKit
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "kit-runtime.ps1")

function Write-Step([string]$Message) {
  Write-Host ">> $Message" -ForegroundColor Cyan
}

$sourceDir = [System.IO.Path]::GetFullPath($PSScriptRoot)
$serverFile = Join-Path $sourceDir "server.js"
$runtimeFile = Join-Path $sourceDir "kit-runtime.ps1"

if (-not (Test-Path -LiteralPath $serverFile) -or -not (Test-Path -LiteralPath $runtimeFile)) {
  $msg = "This folder is not a valid LLM Task Tree kit package.`n`nMissing server.js or kit-runtime.ps1"
  if (-not $Silent) { Show-UpdateMessageBox -Title "LLM Task Tree Update" -Message $msg -IsError }
  throw $msg
}

$nodeVersion = Test-NodeJs
if (-not $nodeVersion) {
  $msg = "Node.js was not found.`n`nInstall Node.js 18+ from https://nodejs.org/ then run update again."
  if (-not $Silent) { Show-UpdateMessageBox -Title "LLM Task Tree Update" -Message $msg -IsError }
  throw $msg
}

Write-Host ""
Write-Host "=== LLM Task Tree One-Click Update ===" -ForegroundColor Green
Write-Step ("Update package: " + $sourceDir)
Write-Step ("Node.js: " + $nodeVersion)

$buildResult = Sync-DevKitFromRepoRoot -KitDir $sourceDir -Skip:$SkipBuildKit
if ($buildResult.ran) {
  Write-Step ("Built kit from repo root: " + $buildResult.repoRoot)
} elseif (-not $SkipBuildKit -and $buildResult.reason -eq "no-repo-build-script") {
  Write-Step "No scripts/build-kit.ps1 nearby; using this kit folder as-is"
}

try {
  $targetDir = Resolve-GlobalKitTarget -Explicit $KitTarget -AllowPicker
} catch {
  if (-not $Silent) { Show-UpdateMessageBox -Title "LLM Task Tree Update" -Message $_.Exception.Message -IsError }
  throw
}

$sourceNorm = $sourceDir.TrimEnd('\')
$targetNorm = $targetDir.TrimEnd('\')

Write-Step ("This PC install folder: " + $targetDir)

if ($sourceNorm -ieq $targetNorm) {
  Write-Step "Source equals install folder; skip file copy"
} else {
  Write-Step "Syncing update package -> install folder..."
  Sync-GlobalKitFromSource -Source $sourceDir -Destination $targetDir
}

Write-GlobalKitPathFile -KitDir $targetDir

Write-Step "Running npm install..."
Push-Location $targetDir
try {
  & npm install 2>&1 | Out-Host
} finally {
  Pop-Location
}

$setupWebSearch = Join-Path $targetDir "setup-open-websearch.ps1"
if (Test-Path -LiteralPath $setupWebSearch) {
  Write-Step "Preparing open-webSearch (no-key web search daemon)..."
  & powershell -NoProfile -ExecutionPolicy Bypass -File $setupWebSearch -KitDir $targetDir
  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
    throw "setup-open-websearch.ps1 failed with exit code $LASTEXITCODE"
  }
}

$registerScript = Join-Path $targetDir "register-context-menu.ps1"
if (Test-Path -LiteralPath $registerScript) {
  Write-Step "Refreshing Explorer right-click menu..."
  & powershell -NoProfile -ExecutionPolicy Bypass -File $registerScript
  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
    throw "register-context-menu.ps1 failed with exit code $LASTEXITCODE"
  }
}

$extraProjects = Get-SidecarProjectRoots -BaseDir $sourceDir
$discovered = Discover-TaskTreeProjectRoots -ExtraProjects $extraProjects -SidecarDir $sourceDir
Write-Step ("Discovered task-tree projects: " + $discovered.Count)
$stats = Update-AllRegisteredProjects -SharedKitDir $targetDir -ExtraProjects $extraProjects -SidecarDir $sourceDir

$manifest = @{
  version     = "0.2.0"
  updatedAt   = (Get-Date).ToString("o")
  installDir  = $targetDir
  sourceDir   = $sourceDir
} | ConvertTo-Json
Set-Content -LiteralPath (Join-Path $targetDir "install.manifest.json") -Value $manifest -Encoding UTF8

$summary = @"
Update complete on this computer.

Install folder:
$targetDir
$(if ($buildResult.ran) { "Repo build: synced llm-task-tree-kit from $($buildResult.repoRoot)" } else { "Repo build: skipped ($($buildResult.reason))" })

Projects (discovered $($stats.discovered)):
  refreshed stub: $($stats['stub-refreshed'])
  migrated to shared kit: $($stats.migrated)
  new stub: $($stats['stub-created'])
  agent prompts synced: $($stats['prompts-synced'])
  embedding 64x40 synced: $($stats['embedding-env'])
  skipped: $($stats.skipped)
  failed: $($stats.failed)

Next:
- Refresh open task tree pages (Ctrl+F5), or reopen from Explorer / llm-task-tree\open-task-tree.cmd.
- UI runs from the shared kit install folder — not from each project's old server.js copy.
- Task graph toolbar: **关系图 | 执行流程** (execution order in scripts/project.json + scripts/run.json per project).
- Each project keeps its own task-tree.md / versions / knowledge / scripts.
- Agents: **edit-tree gate** — Read `llm-task-tree/AGENTS.task-tree.md` + `AGENTS.node-writing.md` + task-tree-grill only when writing `task-tree.md`; `.cursor/rules/llm-task-tree-edit.mdc` synced to each project.
- Agents: **edit-flow gate** — Read `scripts/README.md` only when writing `scripts/project.json` / `run.json`; `.cursor/rules/llm-task-tree-flow-edit.mdc` synced to each project.
- Ask Agent to keep node prose concise Chinese and code-free; Input/Output use a short Chinese description plus optional evidence paths.
- Knowledge reindex embedding: KNOWLEDGE_EMBEDDING_BATCH_SIZE=64, KNOWLEDGE_EMBEDDING_CONCURRENCY=40 (40 parallel requests x 64 texts each).
"@

Write-Host ""
Write-Host $summary -ForegroundColor Green

if (-not $Silent) {
  Show-UpdateMessageBox -Title "LLM Task Tree Update" -Message $summary
}

if ($stats.failed -gt 0) {
  exit 1
}
