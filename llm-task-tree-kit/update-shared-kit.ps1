param(
  [string]$KitSource = "",
  [string]$SyncFrom = ""
)

$ErrorActionPreference = "Stop"

$self = $PSScriptRoot
if ($SyncFrom) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $self "one-click-update.ps1") -KitTarget $KitSource -Silent
  exit $LASTEXITCODE
}

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $self "one-click-update.ps1") -KitTarget $KitSource
exit $LASTEXITCODE
