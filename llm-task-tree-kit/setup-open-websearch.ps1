param(
  [string]$KitDir = $PSScriptRoot
)

$ErrorActionPreference = "Stop"

function Resolve-OpenWebSearchDir {
  param([string]$BaseDir, [string]$ProjectRoot)
  $candidates = @(
    (Join-Path $BaseDir "node_modules\open-websearch"),
    (Join-Path $BaseDir "open-webSearch"),
    (Join-Path $ProjectRoot "open-webSearch"),
    (Join-Path (Split-Path $BaseDir -Parent) "open-webSearch"),
    (Join-Path (Split-Path $ProjectRoot -Parent) "open-webSearch")
  )
  $seen = @{}
  foreach ($dir in $candidates) {
    $resolved = [System.IO.Path]::GetFullPath($dir)
    if ($seen.ContainsKey($resolved)) { continue }
    $seen[$resolved] = $true
    if (Test-Path -LiteralPath (Join-Path $resolved "package.json")) {
      return $resolved
    }
  }
  return (Join-Path $BaseDir "open-webSearch")
}

$configFile = Join-Path $KitDir "task-tree.config.json"
$projectRoot = $KitDir
if (Test-Path -LiteralPath $configFile) {
  try {
    $cfg = Get-Content -LiteralPath $configFile -Raw -Encoding utf8 | ConvertFrom-Json
    $raw = [string]$cfg.projectRoot
    if ($raw) {
      if ([System.IO.Path]::IsPathRooted($raw)) {
        $projectRoot = [System.IO.Path]::GetFullPath($raw)
      } else {
        $projectRoot = [System.IO.Path]::GetFullPath((Join-Path $KitDir $raw))
      }
    }
  } catch {
    # keep defaults
  }
}

$targetDir = Resolve-OpenWebSearchDir -BaseDir $KitDir -ProjectRoot $projectRoot
$entry = Join-Path $targetDir "build\index.js"

if (-not (Test-Path -LiteralPath $entry)) {
  # All published dependencies live in the shared kit, not a per-project folder.
  # This also repairs old installations with a package.json but no root build/.
  Write-Host "Installing shared dependencies from the IDE lockfile ..."
  Push-Location $KitDir
  try {
    npm ci --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "Shared dependency installation failed" }
  } finally {
    Pop-Location
  }
  $targetDir = Resolve-OpenWebSearchDir -BaseDir $KitDir -ProjectRoot $projectRoot
  $entry = Join-Path $targetDir "build\index.js"
}

if (-not (Test-Path -LiteralPath $entry)) {
  throw "open-websearch published package entry is missing. Expected $entry"
}

Write-Host "open-webSearch ready at $targetDir"
Write-Host "Set WEB_SEARCH_PROVIDER=openwebsearch and WEB_SEARCH_BASE_URL=http://127.0.0.1:3210 in .env"
