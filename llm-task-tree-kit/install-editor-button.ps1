param(
  [switch]$Remove
)

# Installs the status-bar "任务图" button into Cursor and VS Code.
#
# Editors load unpacked extensions straight from their extensions folder, so a copy plus a
# window reload is all it takes — no marketplace, no .vsix build step.

$ErrorActionPreference = "Stop"
$Source = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "editor-extension"
$Name = "llm-task-tree.llm-task-tree-panel-0.1.0"

if (-not (Test-Path -LiteralPath $Source)) { throw "editor-extension not found: $Source" }

$targets = @(
  @{ Editor = "Cursor";  Dir = (Join-Path $HOME ".cursor\extensions") },
  @{ Editor = "VS Code"; Dir = (Join-Path $HOME ".vscode\extensions") }
)

$touched = 0
foreach ($target in $targets) {
  if (-not (Test-Path -LiteralPath $target.Dir)) { continue }
  $dest = Join-Path $target.Dir $Name

  if ($Remove) {
    if (Test-Path -LiteralPath $dest) {
      Remove-Item -LiteralPath $dest -Recurse -Force
      Write-Host ("Removed from {0}: {1}" -f $target.Editor, $dest)
      $touched++
    }
    continue
  }

  if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Copy-Item -Path (Join-Path $Source "*") -Destination $dest -Recurse -Force
  Write-Host ("Installed into {0}: {1}" -f $target.Editor, $dest)
  $touched++
}

if ($touched -eq 0) {
  if ($Remove) { Write-Host "Nothing to remove." }
  else { Write-Warning "Neither ~/.cursor/extensions nor ~/.vscode/extensions exists; nothing installed." }
  return
}

Write-Host ""
Write-Host "重启编辑器（或 Developer: Reload Window）后，状态栏右下角会出现「任务图」按钮。" -ForegroundColor Green
