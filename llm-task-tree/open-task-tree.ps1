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
