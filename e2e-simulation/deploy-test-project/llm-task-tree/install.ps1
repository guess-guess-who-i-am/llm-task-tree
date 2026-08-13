$ErrorActionPreference = "Stop"

$KitDir = $PSScriptRoot
$ProjectRoot = Split-Path -Parent $KitDir
$MarkerBegin = "<!-- llm-task-tree:begin -->"
$MarkerEnd = "<!-- llm-task-tree:end -->"

function Write-Step([string]$Message) {
  Write-Host ">> $Message"
}

function Get-TaskTreeProjectRoot {
  param([string]$BaseDir)
  $configFile = Join-Path $BaseDir "task-tree.config.json"
  if (-not (Test-Path -LiteralPath $configFile)) { return (Split-Path $BaseDir -Parent) }
  try {
    $config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
    $raw = [string]$config.projectRoot
    if (-not $raw -or $raw.Trim() -eq ".") { return $BaseDir }
    if ([System.IO.Path]::IsPathRooted($raw)) { return [System.IO.Path]::GetFullPath($raw) }
    return [System.IO.Path]::GetFullPath((Join-Path $BaseDir $raw))
  } catch {
    return (Split-Path $BaseDir -Parent)
  }
}

$ProjectRoot = Get-TaskTreeProjectRoot -BaseDir $KitDir
Write-Step "Kit: $KitDir"
Write-Step "Project root: $ProjectRoot"

$configFile = Join-Path $KitDir "task-tree.config.json"
if (-not (Test-Path -LiteralPath $configFile)) {
  @{ projectRoot = ".." } | ConvertTo-Json | Set-Content -LiteralPath $configFile -Encoding ascii
  Write-Step "Created task-tree.config.json (projectRoot=..)"
}

# Directories
foreach ($dir in @("versions", "knowledge")) {
  $target = Join-Path $ProjectRoot $dir
  if (-not (Test-Path -LiteralPath $target)) {
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Write-Step "Created $dir/"
  }
}

# task-tree.md
$treeFile = Join-Path $ProjectRoot "task-tree.md"
if (-not (Test-Path -LiteralPath $treeFile)) {
  Copy-Item (Join-Path $KitDir "templates\task-tree.starter.md") -Destination $treeFile -Force
  Write-Step "Created task-tree.md from starter template"
} else {
  Write-Step "task-tree.md already exists — kept as-is"
}

# AGENTS.md merge
$agentsFile = Join-Path $ProjectRoot "AGENTS.md"
$mergeBlock = Get-Content (Join-Path $KitDir "templates\AGENTS.merge.md") -Raw -Encoding UTF8
if (Test-Path -LiteralPath $agentsFile) {
  $existing = Get-Content -LiteralPath $agentsFile -Raw -Encoding UTF8
  if ($existing -match [regex]::Escape($MarkerBegin)) {
    Write-Step "AGENTS.md already contains llm-task-tree block — skipped"
  } else {
    $separator = if ($existing.TrimEnd().EndsWith("`n")) { "" } else { "`r`n" }
    Set-Content -LiteralPath $agentsFile -Value ($existing.TrimEnd() + $separator + "`r`n" + $mergeBlock.Trim() + "`r`n") -Encoding UTF8 -NoNewline
    Write-Step "Appended llm-task-tree block to existing AGENTS.md"
  }
} else {
  $header = @"
# Agent Instructions

See also the task graph protocol block below and the full rules in ``llm-task-tree/AGENTS.task-tree.md``.

"@
  Set-Content -LiteralPath $agentsFile -Value ($header + $mergeBlock.Trim() + "`r`n") -Encoding UTF8
  Write-Step "Created AGENTS.md with llm-task-tree block"
}

# .gitignore
$gitignoreFile = Join-Path $ProjectRoot ".gitignore"
$appendLines = Get-Content (Join-Path $KitDir "templates\gitignore.append") -Encoding UTF8
if (Test-Path -LiteralPath $gitignoreFile) {
  $gi = Get-Content -LiteralPath $gitignoreFile -Raw -Encoding UTF8
  $added = 0
  foreach ($line in $appendLines) {
    $t = $line.Trim()
    if (-not $t) { continue }
    if ($gi -notmatch [regex]::Escape($t)) {
      Add-Content -LiteralPath $gitignoreFile -Value $t -Encoding UTF8
      $added++
    }
  }
  Write-Step "Updated .gitignore (+$added entries)"
} else {
  Set-Content -LiteralPath $gitignoreFile -Value ($appendLines -join "`r`n") -Encoding UTF8
  Write-Step "Created .gitignore"
}

# .env
$envExample = Join-Path $KitDir "templates\.env.example"
$envTarget = Join-Path $ProjectRoot ".env"
if ((Test-Path -LiteralPath $envExample) -and -not (Test-Path -LiteralPath $envTarget)) {
  Copy-Item $envExample -Destination $envTarget -Force
  Write-Step "Copied templates/.env.example -> .env (fill in keys if needed)"
} else {
  Write-Step ".env already exists or no template — skipped"
}

# npm
Write-Step "Running npm install in kit directory..."
Push-Location $KitDir
try {
  & npm install 2>&1 | Out-Host
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "Done. Next steps:"
Write-Host "  1. Open task graph: double-click llm-task-tree\打开任务图.cmd"
Write-Host "  2. Ask your Agent to expand task-tree.md (task-tree-grill skill)"
Write-Host "  3. Full agent rules: llm-task-tree\AGENTS.task-tree.md"
