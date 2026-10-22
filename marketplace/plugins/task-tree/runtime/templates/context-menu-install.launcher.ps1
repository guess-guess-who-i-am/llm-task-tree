param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectRoot
)

$ErrorActionPreference = "Stop"
$kitDir = (Get-Content (Join-Path $PSScriptRoot "kit.path") -Raw -Encoding UTF8).Trim()
$deployScript = Join-Path $kitDir "deploy-task-tree.ps1"

if (-not (Test-Path -LiteralPath $deployScript)) {
  throw "Missing deploy script: $deployScript"
}

& powershell -NoProfile -ExecutionPolicy Bypass -File $deployScript -ProjectRoot $ProjectRoot -KitSource $kitDir -OpenAfterInstall
if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
