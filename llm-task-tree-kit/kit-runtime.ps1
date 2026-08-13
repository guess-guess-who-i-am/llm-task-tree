function Get-OpenWebSearchLauncherLogPaths {
  param([string]$ProjectRoot)

  $root = [System.IO.Path]::GetFullPath($ProjectRoot)
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($root)
  $hash = ([System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes) |
    ForEach-Object { $_.ToString("x2") }) -join ""
  $hash = $hash.Substring(0, 12)
  $dir = Join-Path $env:LOCALAPPDATA "LLMTaskTree\logs\$hash"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  return @{
    Dir = $dir
    Log = Join-Path $dir "open-websearch-launcher.log"
    Err = Join-Path $dir "open-websearch-launcher.err.log"
  }
}

function Remove-LegacyOpenWebSearchLauncherLogs {
  param([string]$ProjectRoot)

  foreach ($name in @("open-websearch-launcher.log", "open-websearch-launcher.err.log")) {
    $legacy = Join-Path $ProjectRoot $name
    if (Test-Path -LiteralPath $legacy) {
      try {
        Remove-Item -LiteralPath $legacy -Force -ErrorAction Stop
      } catch {
      }
    }
  }
}

function Get-TaskTreeRegistryFile {
  return Join-Path $env:LOCALAPPDATA "LLMTaskTree\projects.json"
}

function Read-TaskTreeConfig {
  param([string]$StubDir)

  $defaults = @{
    projectRoot  = ".."
    sharedKitDir = ""
  }
  $configFile = Join-Path $StubDir "task-tree.config.json"
  if (-not (Test-Path -LiteralPath $configFile)) {
    return $defaults
  }
  try {
    $parsed = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
    return @{
      projectRoot  = if ($parsed.projectRoot) { [string]$parsed.projectRoot } else { ".." }
      sharedKitDir = if ($parsed.sharedKitDir) { [string]$parsed.sharedKitDir } else { "" }
    }
  } catch {
    return $defaults
  }
}

function Resolve-TaskTreeProjectRoot {
  param([string]$StubDir)

  $config = Read-TaskTreeConfig -StubDir $StubDir
  $raw = [string]$config.projectRoot
  if (-not $raw -or $raw.Trim() -eq ".") {
    return [System.IO.Path]::GetFullPath($StubDir)
  }
  if ([System.IO.Path]::IsPathRooted($raw)) {
    return [System.IO.Path]::GetFullPath($raw)
  }
  return [System.IO.Path]::GetFullPath((Join-Path $StubDir $raw))
}

function Resolve-SharedKitDir {
  param([string]$StubDir)

  $config = Read-TaskTreeConfig -StubDir $StubDir
  $raw = [string]$config.sharedKitDir
  if ($raw) {
    if ([System.IO.Path]::IsPathRooted($raw)) {
      return [System.IO.Path]::GetFullPath($raw)
    }
    return [System.IO.Path]::GetFullPath((Join-Path $StubDir $raw))
  }
  return [System.IO.Path]::GetFullPath($StubDir)
}

function Test-SharedKitStub {
  param([string]$StubDir)

  if (-not (Test-Path -LiteralPath $StubDir)) { return $false }
  $config = Read-TaskTreeConfig -StubDir $StubDir
  return [bool][string]$config.sharedKitDir
}

function Test-FullKitCopy {
  param([string]$StubDir)

  $server = Join-Path $StubDir "server.js"
  return (Test-Path -LiteralPath $server) -and -not (Test-SharedKitStub -StubDir $StubDir)
}

function Find-GlobalKitSource {
  param([string]$Explicit = "")

  if ($Explicit) {
    $resolved = [System.IO.Path]::GetFullPath($Explicit)
    if (Test-Path (Join-Path $resolved "server.js")) { return $resolved }
    throw "Invalid kit source: $resolved"
  }

  if ($env:LLM_TASK_TREE_KIT_HOME) {
    $candidate = [System.IO.Path]::GetFullPath($env:LLM_TASK_TREE_KIT_HOME.Trim())
    if (Test-Path (Join-Path $candidate "server.js")) { return $candidate }
  }

  $kitPathFile = Join-Path $env:LOCALAPPDATA "LLMTaskTree\kit.path"
  if (Test-Path -LiteralPath $kitPathFile) {
    $candidate = (Get-Content -LiteralPath $kitPathFile -Raw -Encoding UTF8).Trim()
    if ($candidate -and (Test-Path (Join-Path $candidate "server.js"))) {
      return [System.IO.Path]::GetFullPath($candidate)
    }
  }

  throw "Cannot find global kit source. Run register-context-menu.cmd or set LLM_TASK_TREE_KIT_HOME."
}

function Register-TaskTreeProject {
  param([string]$ProjectRoot)

  $resolved = [System.IO.Path]::GetFullPath($ProjectRoot)
  $registryFile = Get-TaskTreeRegistryFile
  $registryDir = Split-Path -Parent $registryFile
  if (-not (Test-Path -LiteralPath $registryDir)) {
    New-Item -ItemType Directory -Force -Path $registryDir | Out-Null
  }

  $projects = @()
  if (Test-Path -LiteralPath $registryFile) {
    try {
      $parsed = Get-Content -LiteralPath $registryFile -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($parsed.projects) { $projects = @($parsed.projects) }
    } catch {
      $projects = @()
    }
  }

  if ($projects -notcontains $resolved) {
    $projects += $resolved
  }

  @{
    updatedAt = (Get-Date).ToString("o")
    projects  = @($projects | Select-Object -Unique)
  } | ConvertTo-Json | Set-Content -LiteralPath $registryFile -Encoding UTF8
}

function Get-RegisteredTaskTreeProjects {
  $registryFile = Get-TaskTreeRegistryFile
  if (-not (Test-Path -LiteralPath $registryFile)) { return @() }
  try {
    $parsed = Get-Content -LiteralPath $registryFile -Raw -Encoding UTF8 | ConvertFrom-Json
    return @($parsed.projects | Where-Object { $_ } | Select-Object -Unique)
  } catch {
    return @()
  }
}

function Write-SharedKitStub {
  param(
    [string]$StubDir,
    [string]$SharedKitDir,
    [string]$ProjectRoot
  )

  if (-not (Test-Path -LiteralPath $StubDir)) {
    New-Item -ItemType Directory -Force -Path $StubDir | Out-Null
  }

  $sharedNorm = [System.IO.Path]::GetFullPath($SharedKitDir)

  $configJson = @{
    projectRoot  = ".."
    sharedKitDir = $sharedNorm
  } | ConvertTo-Json
  [System.IO.File]::WriteAllText(
    (Join-Path $StubDir "task-tree.config.json"),
    ($configJson -replace "`r`n", "`n") + "`n",
    (New-Object System.Text.UTF8Encoding($false))
  )

  $stubOpen = @'
param(
  [string]$StubDir = ""
)

if (-not $StubDir) {
  $StubDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}

$configFile = Join-Path $StubDir "task-tree.config.json"
if (-not (Test-Path -LiteralPath $configFile)) {
  throw "Missing task-tree.config.json in $StubDir"
}

$config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
$sharedKit = [string]$config.sharedKitDir
if (-not $sharedKit) {
  throw "Not a shared-kit stub. Re-run deploy with -UseSharedKit or migrate-to-shared-kit.ps1"
}

$launcher = Join-Path $sharedKit "open-task-tree.ps1"
if (-not (Test-Path -LiteralPath $launcher)) {
  throw "Shared kit launcher missing: $launcher"
}

& powershell -NoProfile -ExecutionPolicy Bypass -File $launcher -StubDir $StubDir
if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
'@

  $stubCmd = @'
@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0open-task-tree.ps1"
'@

  $stubCompactCheck = @'
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$TreeFiles = @()
)

$StubDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$configFile = Join-Path $StubDir "task-tree.config.json"
if (-not (Test-Path -LiteralPath $configFile)) {
  throw "Missing task-tree.config.json in $StubDir"
}
$config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
$sharedKit = [string]$config.sharedKitDir
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $StubDir ([string]$config.projectRoot)))
$checker = Join-Path $sharedKit "scripts\check-tree-compact.mjs"
if (-not (Test-Path -LiteralPath $checker)) {
  throw "Shared compact checker missing: $checker"
}
& node $checker --project-root $projectRoot @TreeFiles
exit $LASTEXITCODE
'@

  $stubCompactCmd = @'
@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0check-tree-compact.ps1" %*
exit /b %ERRORLEVEL%
'@

  # Project-level MCP entry. Committed configs (.cursor/mcp.json) point at this stub with
  # ${workspaceFolder}, so nothing depends on where the shared kit lives on a given machine.
  $stubMcp = @'
#!/usr/bin/env node
/**
 * Forwards to the shared kit's MCP server so a project-relative path is enough.
 * Keeps stdout clean: only the kit runtime may write protocol messages there.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const stubDir = import.meta.dirname;
const configFile = path.join(stubDir, "task-tree.config.json");
if (!existsSync(configFile)) {
  process.stderr.write(`missing task-tree.config.json in ${stubDir}\n`);
  process.exit(1);
}

const config = JSON.parse((await readFile(configFile, "utf8")).replace(/^\uFEFF/, ""));
const sharedKit = String(config.sharedKitDir || "");
const entry = sharedKit ? path.join(sharedKit, "scripts", "mcp-server.mjs") : "";
if (!entry || !existsSync(entry)) {
  process.stderr.write(`shared kit MCP server missing: ${entry || "(no sharedKitDir)"}\n`);
  process.exit(1);
}

const projectRoot = path.resolve(stubDir, String(config.projectRoot || ".."));
if (!process.argv.includes("--project-root")) process.argv.splice(2, 0, "--project-root", projectRoot);
await import(pathToFileURL(entry).href);
'@

  Set-Content -LiteralPath (Join-Path $StubDir "open-task-tree.ps1") -Value $stubOpen -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $StubDir "open-task-tree.cmd") -Value $stubCmd -Encoding ASCII
  Set-Content -LiteralPath (Join-Path $StubDir "check-tree-compact.ps1") -Value $stubCompactCheck -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $StubDir "check-tree-compact.cmd") -Value $stubCompactCmd -Encoding ASCII
  # No BOM: Node's JSON.parse rejects it, and several tools read these files directly.
  [System.IO.File]::WriteAllText(
    (Join-Path $StubDir "mcp-server.mjs"),
    ($stubMcp -replace "`r`n", "`n"),
    (New-Object System.Text.UTF8Encoding($false))
  )
}

function Stop-ProjectTaskTreeServer {
  param([string]$ProjectRoot)

  $portFile = Join-Path $ProjectRoot ".task-tree-port"
  if (-not (Test-Path -LiteralPath $portFile)) { return }
  $port = 0
  if (-not [int]::TryParse((Get-Content -LiteralPath $portFile -Raw).Trim(), [ref]$port)) { return }
  if ($port -le 0) { return }

  try {
    Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/shutdown" -Method Post -TimeoutSec 2 | Out-Null
    Start-Sleep -Milliseconds 400
    Remove-LegacyOpenWebSearchLauncherLogs -ProjectRoot $ProjectRoot
  } catch {
  }
}

function Remove-ProjectKitDirectory {
  param([string]$StubDir)

  for ($i = 0; $i -lt 5; $i += 1) {
    try {
      if (Test-Path -LiteralPath $StubDir) {
        Remove-Item -LiteralPath $StubDir -Recurse -Force -ErrorAction Stop
      }
      return
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  throw "Cannot remove $StubDir (close task tree / stop node and retry)"
}

function Sync-FullKitDirectory {
  param(
    [string]$Source,
    [string]$Destination
  )

  if (-not (Test-Path -LiteralPath $Destination)) {
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  }

  $excludeDirs = @("node_modules", ".git")
  Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
    if ($excludeDirs -contains $_.Name) { return }
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

function Sync-DevKitFromRepoRoot {
  param(
    [string]$KitDir,
    [switch]$Skip
  )

  if ($Skip) {
    return @{ ran = $false; reason = "skipped-by-flag" }
  }

  $kitDir = [System.IO.Path]::GetFullPath($KitDir)
  $repoRoot = Split-Path -Parent $kitDir
  $buildScript = Join-Path $repoRoot "scripts\build-kit.ps1"
  $serverFile = Join-Path $repoRoot "server.js"
  $kitFolderName = Split-Path -Leaf $kitDir

  if ($kitFolderName -ne "llm-task-tree-kit") {
    return @{ ran = $false; reason = "not-dev-kit-layout" }
  }
  if (-not (Test-Path -LiteralPath $buildScript) -or -not (Test-Path -LiteralPath $serverFile)) {
    return @{ ran = $false; reason = "no-repo-build-script" }
  }

  & powershell -NoProfile -ExecutionPolicy Bypass -File $buildScript
  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
    throw "build-kit.ps1 failed with exit code $LASTEXITCODE"
  }

  return @{
    ran      = $true
    reason   = "ok"
    repoRoot = $repoRoot
    script   = $buildScript
  }
}

function Sync-GlobalKitFromSource {
  param(
    [string]$Source,
    [string]$Destination
  )

  $excludeDirs = @("node_modules", ".git", "dist", "versions")
  $excludeFiles = @("setup-task-tree.kitpath")

  if (-not (Test-Path -LiteralPath $Destination)) {
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  }

  Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
    if ($excludeDirs -contains $_.Name) { return }
    if (-not $_.PSIsContainer -and ($excludeFiles -contains $_.Name)) { return }
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

function Write-GlobalKitPathFile {
  param([string]$KitDir)

  $launcherDir = Join-Path $env:LOCALAPPDATA "LLMTaskTree"
  if (-not (Test-Path -LiteralPath $launcherDir)) {
    New-Item -ItemType Directory -Force -Path $launcherDir | Out-Null
  }
  $kitPathFile = Join-Path $launcherDir "kit.path"
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($kitPathFile, [System.IO.Path]::GetFullPath($KitDir), $utf8NoBom)
}

function Pick-GlobalKitInstallDir {
  Add-Type -AssemblyName System.Windows.Forms
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = "Select LLM Task Tree install folder on THIS computer (existing install or empty folder)"
  $dialog.ShowNewFolderButton = $true
  $defaultRoot = [Environment]::GetFolderPath("MyDocuments")
  if (-not $defaultRoot) { $defaultRoot = "C:\" }
  $dialog.SelectedPath = $defaultRoot
  $result = $dialog.ShowDialog()
  if ($result -ne [System.Windows.Forms.DialogResult]::OK) {
    throw "Update cancelled."
  }
  return [System.IO.Path]::GetFullPath($dialog.SelectedPath)
}

function Resolve-GlobalKitTarget {
  param(
    [string]$Explicit = "",
    [switch]$AllowPicker
  )

  if ($Explicit) {
    $resolved = [System.IO.Path]::GetFullPath($Explicit)
    if (-not (Test-Path -LiteralPath $resolved)) {
      New-Item -ItemType Directory -Force -Path $resolved | Out-Null
    }
    return $resolved
  }

  try {
    return Find-GlobalKitSource
  } catch {
    if (-not $AllowPicker) { throw }
    return Pick-GlobalKitInstallDir
  }
}

function Get-SidecarProjectRoots {
  param([string]$BaseDir)

  $items = New-Object System.Collections.Generic.List[string]
  $listFile = Join-Path $BaseDir "update-projects.txt"
  if (-not (Test-Path -LiteralPath $listFile)) {
    return @()
  }

  $listDir = Split-Path -Parent ([System.IO.Path]::GetFullPath($listFile))
  Get-Content -LiteralPath $listFile -Encoding UTF8 | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    if (-not [System.IO.Path]::IsPathRooted($line)) {
      $line = Join-Path $listDir $line
    }
    try {
      $items.Add([System.IO.Path]::GetFullPath($line))
    } catch {
    }
  }
  return @($items | Select-Object -Unique)
}

function Get-UpdateSearchRoots {
  param([string]$BaseDir)

  $items = New-Object System.Collections.Generic.List[string]
  $listFile = Join-Path $BaseDir "update-search-roots.txt"
  if (-not (Test-Path -LiteralPath $listFile)) {
    return @()
  }

  $listDir = Split-Path -Parent ([System.IO.Path]::GetFullPath($listFile))
  Get-Content -LiteralPath $listFile -Encoding UTF8 | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    if (-not [System.IO.Path]::IsPathRooted($line)) {
      $line = Join-Path $listDir $line
    }
    try {
      $items.Add([System.IO.Path]::GetFullPath($line))
    } catch {
    }
  }
  return @($items | Select-Object -Unique)
}

function Test-IsTaskTreeProjectRoot {
  param([string]$Dir)
  if (-not $Dir) { return $false }
  return Test-Path -LiteralPath (Join-Path $Dir "task-tree.md")
}

function Add-TaskTreeProjectCandidate {
  param(
    [System.Collections.Generic.HashSet[string]]$Found,
    [string]$Path
  )
  if (-not $Path) { return }
  try {
    $full = [System.IO.Path]::GetFullPath($Path)
    if (Test-IsTaskTreeProjectRoot -Dir $full) {
      [void]$Found.Add($full)
    }
  } catch {
  }
}

function Discover-TaskTreesUnderRoot {
  param(
    [System.Collections.Generic.HashSet[string]]$Found,
    [string]$Root,
    [int]$DepthRemaining
  )

  $skipNames = @("node_modules", ".git", "dist", "versions", "backups", "llm-task-tree-kit")
  Add-TaskTreeProjectCandidate -Found $Found -Path $Root
  if ($DepthRemaining -le 0) { return }

  if (-not (Test-Path -LiteralPath $Root)) { return }
  Get-ChildItem -LiteralPath $Root -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    if ($skipNames -contains $_.Name) { return }
    Discover-TaskTreesUnderRoot -Found $Found -Root $_.FullName -DepthRemaining ($DepthRemaining - 1)
  }
}

function Discover-TaskTreeProjectRoots {
  param(
    [string[]]$ExtraProjects = @(),
    [string]$SidecarDir = ""
  )

  if (-not $SidecarDir) {
    $SidecarDir = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
  }

  $found = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)

  foreach ($p in @((Get-RegisteredTaskTreeProjects) + $ExtraProjects)) {
    Add-TaskTreeProjectCandidate -Found $found -Path $p
  }

  foreach ($proj in @($found)) {
    $parent = Split-Path -Parent $proj
    if (-not $parent -or -not (Test-Path -LiteralPath $parent)) { continue }
    Get-ChildItem -LiteralPath $parent -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      Add-TaskTreeProjectCandidate -Found $found -Path $_.FullName
    }
  }

  foreach ($root in (Get-UpdateSearchRoots -BaseDir $SidecarDir)) {
    Discover-TaskTreesUnderRoot -Found $found -Root $root -DepthRemaining 2
  }

  return @($found | Sort-Object)
}

function Ensure-ProjectEmbeddingEnv {
  param(
    [string]$ProjectRoot
  )

  $envPath = Join-Path $ProjectRoot ".env"
  if (-not (Test-Path -LiteralPath $envPath)) {
    return "no-env"
  }

  $target = @{
    KNOWLEDGE_EMBEDDING_BATCH_SIZE    = "64"
    KNOWLEDGE_EMBEDDING_CONCURRENCY = "40"
  }
  $comment = "# Reindex embedding throughput: 64 texts per request, 40 parallel requests."
  $lines = @(Get-Content -LiteralPath $envPath -Encoding UTF8)
  $changed = $false
  $missing = @()

  foreach ($key in $target.Keys) {
    $value = $target[$key]
    $found = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if ($lines[$i] -match "^\s*$([regex]::Escape($key))\s*=") {
        $found = $true
        $next = "$key=$value"
        if ($lines[$i] -ne $next) {
          $lines[$i] = $next
          $changed = $true
        }
        break
      }
    }
    if (-not $found) {
      $missing += "$key=$value"
    }
  }

  if ($missing.Count -gt 0) {
    $insertAt = $lines.Count
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if ($lines[$i] -match '^\s*KNOWLEDGE_EMBEDDING_API_KEY\s*=') {
        $insertAt = $i + 1
        break
      }
    }
    $block = @($comment) + $missing
    if ($insertAt -ge $lines.Count) {
      $lines += $block
    } else {
      $lines = $lines[0..($insertAt - 1)] + $block + $lines[$insertAt..($lines.Count - 1)]
    }
    $changed = $true
  }

  if ($changed) {
    Set-Content -LiteralPath $envPath -Value $lines -Encoding UTF8
    return "updated"
  }
  return "ok"
}

function Ensure-ProjectKnowledgeConfigEmbedding {
  param(
    [string]$ProjectRoot
  )

  $configPath = Join-Path $ProjectRoot "knowledge-config.json"
  if (-not (Test-Path -LiteralPath $configPath)) {
    return "no-config"
  }

  try {
    $raw = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8
    if (-not $raw.Trim()) {
      return "empty"
    }
    $config = $raw | ConvertFrom-Json
    if (-not $config.embedding) {
      $config | Add-Member -NotePropertyName embedding -NotePropertyValue ([pscustomobject]@{})
    }
    $changed = $false
    if (-not $config.embedding.batchSize -or [int]$config.embedding.batchSize -ne 64) {
      $config.embedding | Add-Member -NotePropertyName batchSize -NotePropertyValue 64 -Force
      $changed = $true
    }
    if (-not $config.embedding.concurrency -or [int]$config.embedding.concurrency -ne 40) {
      $config.embedding | Add-Member -NotePropertyName concurrency -NotePropertyValue 40 -Force
      $changed = $true
    }
    if ($changed) {
      $json = $config | ConvertTo-Json -Depth 8
      Set-Content -LiteralPath $configPath -Value $json -Encoding UTF8
      return "updated"
    }
    return "ok"
  } catch {
    return "error"
  }
}

function Ensure-ProjectScriptsDir {
  param(
    [string]$ProjectRoot,
    [string]$SharedKitDir
  )

  $scriptsDir = Join-Path $ProjectRoot "scripts"
  if (-not (Test-Path -LiteralPath $scriptsDir)) {
    New-Item -ItemType Directory -Force -Path $scriptsDir | Out-Null
  }

  $readmeTemplate = Join-Path $SharedKitDir "templates\scripts\README.md"
  $readmeDest = Join-Path $scriptsDir "README.md"
  if (Test-Path -LiteralPath $readmeTemplate) {
    Copy-Item -LiteralPath $readmeTemplate -Destination $readmeDest -Force
  }

  $stepsDir = Join-Path $scriptsDir "steps"
  New-Item -ItemType Directory -Force -Path $stepsDir | Out-Null
  $stepsReadmeTemplate = Join-Path $SharedKitDir "templates\scripts\steps\README.md"
  $stepsReadmeDest = Join-Path $stepsDir "README.md"
  if (Test-Path -LiteralPath $stepsReadmeTemplate) {
    Copy-Item -LiteralPath $stepsReadmeTemplate -Destination $stepsReadmeDest -Force
  }
}

function Ensure-ProjectCursorRules {
  param(
    [string]$ProjectRoot,
    [string]$SharedKitDir
  )

  $templateDir = Join-Path $SharedKitDir "templates\cursor-rules"
  if (-not (Test-Path -LiteralPath $templateDir)) {
    return
  }

  $rulesDir = Join-Path $ProjectRoot ".cursor\rules"
  New-Item -ItemType Directory -Force -Path $rulesDir | Out-Null
  Get-ChildItem -LiteralPath $templateDir -Filter "*.mdc" | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $rulesDir $_.Name) -Force
  }
  @("task-tree-edit.mdc", "task-tree-flow-edit.mdc") | ForEach-Object {
    $legacy = Join-Path $rulesDir $_
    if (Test-Path -LiteralPath $legacy) {
      Remove-Item -LiteralPath $legacy -Force
    }
  }
}

function Ensure-ProjectCursorMcp {
  param([string]$ProjectRoot)

  # Never point Cursor at a stub that is not there: legacy embedded copies have no MCP entry.
  if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot "llm-task-tree\mcp-server.mjs"))) {
    return
  }

  $cursorDir = Join-Path $ProjectRoot ".cursor"
  New-Item -ItemType Directory -Force -Path $cursorDir | Out-Null
  $mcpFile = Join-Path $cursorDir "mcp.json"

  # ${workspaceFolder} keeps this file committable: it resolves per clone, per machine.
  $server = [ordered]@{
    type    = "stdio"
    command = "node"
    args    = @('${workspaceFolder}/llm-task-tree/mcp-server.mjs')
  }

  $existing = $null
  if (Test-Path -LiteralPath $mcpFile) {
    try {
      $raw = [System.IO.File]::ReadAllText($mcpFile) -replace "^\uFEFF", ""
      if ($raw.Trim()) { $existing = $raw | ConvertFrom-Json }
    } catch {
      $existing = $null
    }
  }

  $doc = [ordered]@{}
  $servers = [ordered]@{}
  if ($existing) {
    foreach ($prop in $existing.PSObject.Properties) {
      if ($prop.Name -eq "mcpServers") {
        if ($prop.Value) {
          foreach ($srv in $prop.Value.PSObject.Properties) { $servers[$srv.Name] = $srv.Value }
        }
      } else {
        $doc[$prop.Name] = $prop.Value
      }
    }
  }
  $servers["task_tree"] = $server
  $doc["mcpServers"] = $servers

  $json = (($doc | ConvertTo-Json -Depth 12) -replace "`r`n", "`n") + "`n"
  $current = ""
  if (Test-Path -LiteralPath $mcpFile) { $current = [System.IO.File]::ReadAllText($mcpFile) }
  if ($current -ne $json) {
    [System.IO.File]::WriteAllText($mcpFile, $json, (New-Object System.Text.UTF8Encoding($false)))
  }
}

<#
Registers the task-graph MCP server and plugin in Codex's config.toml.

The desktop app and the CLI read the same config, so this is what puts the tools in the
desktop UI without anyone typing a codex command. Machine-wide, idempotent, and reversible
through `install-codex-mcp.mjs --with-plugin --remove`. Returns the action the registrator
reported ("appended" / "none" / "removed"), or "" when Codex is not installed here.
#>
function Ensure-CodexRegistration {
  param([string]$KitDir)

  $codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
  if (-not (Test-Path -LiteralPath $codexHome)) { return "" }

  $script = Join-Path $KitDir "scripts\install-codex-mcp.mjs"
  if (-not (Test-Path -LiteralPath $script)) { return "" }

  try {
    $output = & node $script --with-plugin --codex-home $codexHome 2>&1
    if ("$output" -match '"action"\s*:\s*"([a-z]+)"') { return $Matches[1] }
    return "unknown"
  } catch {
    Write-Warning "Codex registration skipped: $($_.Exception.Message)"
    return ""
  }
}

function Sync-ProjectAgentPrompts {
  param(
    [string]$ProjectRoot,
    [string]$SharedKitDir
  )

  $projectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
  $stubDir = Join-Path $projectRoot "llm-task-tree"
  if (-not (Test-Path -LiteralPath $stubDir)) {
    return "no-stub"
  }

  $installScript = Join-Path $SharedKitDir "install.ps1"
  if (-not (Test-Path -LiteralPath $installScript)) {
    throw "Missing install.ps1 in shared kit: $SharedKitDir"
  }

  & powershell -NoProfile -ExecutionPolicy Bypass -File $installScript -StubDir $stubDir -PromptsOnly
  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
    throw "install.ps1 -PromptsOnly failed for $projectRoot"
  }
  return "prompts-synced"
}

function Update-RegisteredProjectStub {
  param(
    [string]$ProjectRoot,
    [string]$SharedKitDir
  )

  $projectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
  $stubDir = Join-Path $projectRoot "llm-task-tree"
  Stop-ProjectTaskTreeServer -ProjectRoot $projectRoot

  if (-not (Test-IsTaskTreeProjectRoot -Dir $projectRoot)) {
    return "skipped"
  }

  if (Test-SharedKitStub -StubDir $stubDir) {
    Write-SharedKitStub -StubDir $stubDir -SharedKitDir $SharedKitDir -ProjectRoot $projectRoot
    Ensure-ProjectScriptsDir -ProjectRoot $projectRoot -SharedKitDir $SharedKitDir
    Ensure-ProjectCursorRules -ProjectRoot $projectRoot -SharedKitDir $SharedKitDir
    Ensure-ProjectCursorMcp -ProjectRoot $projectRoot
    Register-TaskTreeProject -ProjectRoot $projectRoot
    return "stub-refreshed"
  }

  if (Test-FullKitCopy -StubDir $stubDir) {
    Remove-ProjectKitDirectory -StubDir $stubDir
    Write-SharedKitStub -StubDir $stubDir -SharedKitDir $SharedKitDir -ProjectRoot $projectRoot
    Ensure-ProjectScriptsDir -ProjectRoot $projectRoot -SharedKitDir $SharedKitDir
    Ensure-ProjectCursorRules -ProjectRoot $projectRoot -SharedKitDir $SharedKitDir
    Ensure-ProjectCursorMcp -ProjectRoot $projectRoot
    Register-TaskTreeProject -ProjectRoot $projectRoot
    return "migrated"
  }

  if (-not (Test-Path -LiteralPath $stubDir)) {
    New-Item -ItemType Directory -Force -Path $stubDir | Out-Null
  }

  Write-SharedKitStub -StubDir $stubDir -SharedKitDir $SharedKitDir -ProjectRoot $projectRoot
  Ensure-ProjectScriptsDir -ProjectRoot $projectRoot -SharedKitDir $SharedKitDir
  Ensure-ProjectCursorRules -ProjectRoot $projectRoot -SharedKitDir $SharedKitDir
  Ensure-ProjectCursorMcp -ProjectRoot $projectRoot
  Register-TaskTreeProject -ProjectRoot $projectRoot
  if (Test-Path -LiteralPath (Join-Path $stubDir "server.js")) {
    return "migrated"
  }
  return "stub-created"
}

function Update-AllRegisteredProjects {
  param(
    [string]$SharedKitDir,
    [string[]]$ExtraProjects = @(),
    [string]$SidecarDir = ""
  )

  $projects = Discover-TaskTreeProjectRoots -ExtraProjects $ExtraProjects -SidecarDir $SidecarDir
  $stats = @{
    discovered       = $projects.Count
    "stub-refreshed" = 0
    migrated         = 0
    "stub-created"   = 0
    "prompts-synced" = 0
    "embedding-env"  = 0
    skipped          = 0
    failed           = 0
  }

  foreach ($project in $projects) {
    if (-not $project) { continue }
    try {
      $result = Update-RegisteredProjectStub -ProjectRoot $project -SharedKitDir $SharedKitDir
      if ($stats.ContainsKey($result)) {
        $stats[$result] += 1
      } else {
        $stats.skipped += 1
      }
      $promptResult = Sync-ProjectAgentPrompts -ProjectRoot $project -SharedKitDir $SharedKitDir
      if ($promptResult -eq "prompts-synced") {
        $stats["prompts-synced"] += 1
      }
      $envResult = Ensure-ProjectEmbeddingEnv -ProjectRoot $project
      $cfgResult = Ensure-ProjectKnowledgeConfigEmbedding -ProjectRoot $project
      if ($envResult -eq "updated" -or $cfgResult -eq "updated") {
        $stats["embedding-env"] += 1
      }
    } catch {
      $stats.failed += 1
    }
  }

  return $stats
}

function Test-NodeJs {
  try {
    return [string](& node --version 2>$null)
  } catch {
    return ""
  }
}

function Show-UpdateMessageBox {
  param(
    [string]$Title,
    [string]$Message,
    [switch]$IsError
  )

  Add-Type -AssemblyName System.Windows.Forms
  $icon = if ($IsError) {
    [System.Windows.Forms.MessageBoxIcon]::Error
  } else {
    [System.Windows.Forms.MessageBoxIcon]::Information
  }
  [void][System.Windows.Forms.MessageBox]::Show($Message, $Title, [System.Windows.Forms.MessageBoxButtons]::OK, $icon)
}
