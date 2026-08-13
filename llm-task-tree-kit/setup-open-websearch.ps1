param(
  [string]$KitDir = $PSScriptRoot
)

$ErrorActionPreference = "Stop"

function Resolve-OpenWebSearchDir {
  param([string]$BaseDir, [string]$ProjectRoot)
  $candidates = @(
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

if (-not (Test-Path -LiteralPath (Join-Path $targetDir "package.json"))) {
  $parentSource = Join-Path (Split-Path $KitDir -Parent) "open-webSearch"
  if (Test-Path -LiteralPath (Join-Path $parentSource "package.json")) {
    if (-not (Test-Path -LiteralPath $targetDir)) {
      cmd /c mklink /J "$targetDir" "$parentSource" | Out-Null
      Write-Host "Linked $targetDir -> $parentSource"
    }
  } else {
    Write-Host "Installing open-websearch npm package into $targetDir ..."
    New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
    Push-Location $targetDir
    try {
      npm install open-websearch@2.1.11 --no-save
    } finally {
      Pop-Location
    }
  }
}

if (-not (Test-Path -LiteralPath $entry)) {
  Push-Location $targetDir
  try {
    if (-not (Test-Path -LiteralPath (Join-Path $targetDir "node_modules"))) {
      npm install
    }
    npm run build
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path -LiteralPath $entry)) {
  throw "open-webSearch build failed. Expected $entry"
}

Write-Host "open-webSearch ready at $targetDir"
Write-Host "Set WEB_SEARCH_PROVIDER=openwebsearch and WEB_SEARCH_BASE_URL=http://127.0.0.1:3210 in .env"
