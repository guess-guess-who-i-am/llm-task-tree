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
