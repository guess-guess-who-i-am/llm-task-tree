param(
  [string[]]$ProjectRoot = @(),
  [string]$ProjectsFile = "",
  [string]$KitSource = "",
  [switch]$UseRegistry,
  [switch]$MigrateOnly,
  [switch]$SharedKitOnly,
  [switch]$FullCopyUpdate,
  [switch]$OpenAfterUpdate,
  [switch]$WhatIf
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "kit-runtime.ps1")

function Write-Step([string]$Message) {
  Write-Host ">> $Message" -ForegroundColor Cyan
}

function Normalize-ProjectRoot {
  param([string]$Root)
  if (-not $Root) { return "" }
  $trimmed = $Root.Trim().Trim('"')
  if (-not $trimmed) { return "" }
  try {
    if ([System.IO.Path]::IsPathRooted($trimmed)) {
      return [System.IO.Path]::GetFullPath($trimmed)
    }
    return [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $trimmed))
  } catch {
    Write-Warning ("Invalid project path (skipped): " + $trimmed)
    return ""
  }
}

function Get-ProjectRoots {
  param(
    [string[]]$Roots,
    [string]$ListFile,
    [switch]$FromRegistry
  )

  $items = New-Object System.Collections.Generic.List[string]

  if ($FromRegistry) {
    foreach ($root in Get-RegisteredTaskTreeProjects) {
      $resolved = Normalize-ProjectRoot -Root $root
      if ($resolved) { $items.Add($resolved) }
    }
  }

  foreach ($root in $Roots) {
    $resolved = Normalize-ProjectRoot -Root $root
    if ($resolved) { $items.Add($resolved) }
  }

  if ($ListFile) {
    if (-not (Test-Path -LiteralPath $ListFile)) {
      throw "Projects file not found: $ListFile"
    }
    $listDir = Split-Path -Parent ([System.IO.Path]::GetFullPath($ListFile))
    Get-Content -LiteralPath $ListFile -Encoding UTF8 | ForEach-Object {
      $line = $_.Trim()
      if (-not $line -or $line.StartsWith("#")) { return }
      if (-not [System.IO.Path]::IsPathRooted($line)) {
        $line = Join-Path $listDir $line
      }
      $resolved = Normalize-ProjectRoot -Root $line
      if ($resolved) { $items.Add($resolved) }
    }
  }

  return @($items | Select-Object -Unique)
}

if ($SharedKitOnly -or (-not $ProjectRoot -and -not $ProjectsFile -and -not $MigrateOnly -and -not $FullCopyUpdate)) {
  $syncArgs = @{}
  if ($KitSource) { $syncArgs.KitSource = $KitSource }
  if ($PSScriptRoot) { $syncArgs.SyncFrom = $PSScriptRoot }
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "update-shared-kit.ps1") @syncArgs
  exit $LASTEXITCODE
}

$projects = Get-ProjectRoots -Roots $ProjectRoot -ListFile $ProjectsFile -FromRegistry:$UseRegistry
if (-not $projects.Count) {
  throw @'
No projects listed.

Examples:
  update-all-projects.ps1 -UseRegistry -MigrateOnly
  update-all-projects.ps1 -UseRegistry -SharedKitOnly
  update-all-projects.ps1 -ProjectsFile my-projects.txt -MigrateOnly
'@
}

$kitSource = Find-GlobalKitSource -Explicit $KitSource
$migrateScript = Join-Path $PSScriptRoot "migrate-to-shared-kit.ps1"
$updateScript = Join-Path $PSScriptRoot "update-kit.ps1"

Write-Host ""
Write-Host "=== LLM Task Tree Batch ===" -ForegroundColor Green
Write-Step ("Kit source: " + $kitSource)
Write-Step ("Projects: " + $projects.Count)
Write-Host ""

$ok = 0
$skipped = 0
$failed = 0

foreach ($project in $projects) {
  Write-Host ("--- " + $project) -ForegroundColor White
  $stubDir = Join-Path $project "llm-task-tree"

  if (-not (Test-Path -LiteralPath $stubDir)) {
    Write-Host "  SKIP: no llm-task-tree/" -ForegroundColor Yellow
    $skipped += 1
    continue
  }

  if ($WhatIf) {
    if ($MigrateOnly) {
      Write-Host "  WOULD MIGRATE to shared kit" -ForegroundColor DarkGray
    } elseif ($FullCopyUpdate) {
      Write-Host "  WOULD FULL-COPY UPDATE" -ForegroundColor DarkGray
    } else {
      Write-Host "  WOULD REFRESH (shared stub or full copy)" -ForegroundColor DarkGray
    }
    $ok += 1
    continue
  }

  try {
    if ($MigrateOnly) {
      & powershell -NoProfile -ExecutionPolicy Bypass -File $migrateScript -ProjectRoot $project -KitSource $kitSource
      if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "migrate failed" }
      $ok += 1
      continue
    }

    if ($FullCopyUpdate -or (Test-FullKitCopy -StubDir $stubDir)) {
      $args = @{
        ProjectRoot = $project
        KitSource   = $kitSource
      }
      if ($OpenAfterUpdate) { $args.OpenAfterUpdate = $true }
      & powershell -NoProfile -ExecutionPolicy Bypass -File $updateScript @args
      if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "full copy update failed" }
      $ok += 1
      continue
    }

    if (Test-SharedKitStub -StubDir $stubDir) {
      Write-Host "  OK: shared-kit stub" -ForegroundColor Green
      Register-TaskTreeProject -ProjectRoot $project
      $ok += 1
      continue
    }

    Write-Host "  MIGRATE: converting full copy -> shared stub" -ForegroundColor Cyan
    & powershell -NoProfile -ExecutionPolicy Bypass -File $migrateScript -ProjectRoot $project -KitSource $kitSource
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "migrate failed" }
    $ok += 1
  } catch {
    Write-Host ("  FAILED: " + $_.Exception.Message) -ForegroundColor Red
    $failed += 1
  }

  Write-Host ""
}

if (-not $FullCopyUpdate) {
  Write-Step "Updating shared kit once for all stub projects..."
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "update-shared-kit.ps1") -KitSource $kitSource -SyncFrom $PSScriptRoot
}

Write-Host "=== Summary ===" -ForegroundColor Green
Write-Host ("OK:      " + $ok)
Write-Host ("Skipped: " + $skipped)
Write-Host ("Failed:  " + $failed)

if ($failed -gt 0) { exit 1 }
