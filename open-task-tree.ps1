$ErrorActionPreference = "Stop"

$RootDir = [System.IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$StubLauncher = Join-Path $RootDir "llm-task-tree\open-task-tree.ps1"

if (Test-Path -LiteralPath $StubLauncher) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File $StubLauncher
  if ($LASTEXITCODE) { exit $LASTEXITCODE }
  exit 0
}

if (-not (Test-Path -LiteralPath (Join-Path $RootDir "task-tree.md"))) {
  Write-Host "LLM Task Tree is not installed in this folder."
  Write-Host "Right-click the folder in Explorer -> Install LLM Task Tree"
  exit 1
}

$kitDir = $env:LLM_TASK_TREE_KIT_HOME
if (-not $kitDir) {
  $kitPathFile = Join-Path $env:LOCALAPPDATA "LLMTaskTree\kit.path"
  if (Test-Path -LiteralPath $kitPathFile) {
    $kitDir = (Get-Content -LiteralPath $kitPathFile -Raw -Encoding UTF8).Trim()
  }
}

if (-not $kitDir -or -not (Test-Path -LiteralPath (Join-Path $kitDir "kit-runtime.ps1"))) {
  Write-Host "Global kit not found. Run llm-task-tree-kit\一键更新.cmd first, or install LLM Task Tree."
  exit 1
}

. (Join-Path $kitDir "kit-runtime.ps1")
$stubDir = Join-Path $RootDir "llm-task-tree"
Write-SharedKitStub -StubDir $stubDir -SharedKitDir $kitDir -ProjectRoot $RootDir
Register-TaskTreeProject -ProjectRoot $RootDir

& powershell -NoProfile -ExecutionPolicy Bypass -File $StubLauncher
if ($LASTEXITCODE) { exit $LASTEXITCODE }
