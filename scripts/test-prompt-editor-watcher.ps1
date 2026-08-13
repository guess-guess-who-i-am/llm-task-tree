$ErrorActionPreference = "Stop"

$watcher = Join-Path $PSScriptRoot "prompt-publisher\edit-global-prompt.ps1"
$source = Get-Content -LiteralPath $watcher -Raw -Encoding UTF8
$match = [regex]::Match(
  $source,
  '(?ms)^function Get-SourceHash\([^\r\n]*\) \{.*?^\}'
)
if (-not $match.Success) {
  throw "Get-SourceHash was not found in $watcher"
}

Invoke-Expression $match.Value

$handle = [System.IO.File]::Open(
  $watcher,
  [System.IO.FileMode]::Open,
  [System.IO.FileAccess]::ReadWrite,
  [System.IO.FileShare]::None
)
try {
  $lockedHash = Get-SourceHash $watcher
  if ($lockedHash) {
    throw "A locked source should not produce a hash."
  }
} finally {
  $handle.Dispose()
}

$availableHash = Get-SourceHash $watcher
if ($availableHash -notmatch '^[0-9a-f]{64}$') {
  throw "The source hash did not recover after the file lock was released."
}

Write-Host "PASS Prompt editor watcher tolerates transient file locks"
