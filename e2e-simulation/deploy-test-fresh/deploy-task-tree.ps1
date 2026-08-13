$ErrorActionPreference = "Stop"

# Deploy llm-task-tree into the project that contains this script, then open the UI.
# Copy deploy-task-tree.ps1 + 部署任务图.cmd to any project root and double-click the .cmd file.

$ProjectRoot = $PSScriptRoot
$KitFolderName = "llm-task-tree"
$KitDest = Join-Path $ProjectRoot $KitFolderName
$UserTemplate = Join-Path $env:USERPROFILE ".llm-task-tree\template"
$MarkerFile = Join-Path $KitDest "server.js"

function Write-Step([string]$Message) {
  Write-Host ">> $Message"
}

function Test-KitLayout([string]$Path) {
  return (Test-Path -LiteralPath (Join-Path $Path "server.js")) -and
         (Test-Path -LiteralPath (Join-Path $Path "public\app.js")) -and
         (Test-Path -LiteralPath (Join-Path $Path "install.ps1"))
}

function Resolve-KitSource {
  $candidates = @(
    $(if ($env:LLM_TASK_TREE_KIT) { $env:LLM_TASK_TREE_KIT }),
    $UserTemplate,
    (Join-Path $ProjectRoot "llm-task-tree-kit"),
    (Join-Path $ProjectRoot $KitFolderName)
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

  foreach ($candidate in $candidates) {
    if (Test-KitLayout $candidate) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }
  return $null
}

function Copy-Kit([string]$Source, [string]$Destination) {
  if (Test-Path -LiteralPath $Destination) {
    Remove-Item -LiteralPath $Destination -Recurse -Force
  }
  Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
}

function Ensure-UserTemplate([string]$SourceKit) {
  $templateRoot = Split-Path -Parent $UserTemplate
  if (-not (Test-Path -LiteralPath $templateRoot)) {
    New-Item -ItemType Directory -Force -Path $templateRoot | Out-Null
  }
  if (-not (Test-KitLayout $UserTemplate)) {
    Write-Step "Caching kit template to $UserTemplate (for future one-file deploys)"
    Copy-Kit -Source $SourceKit -Destination $UserTemplate
  }
}

function Ensure-Config([string]$KitPath) {
  $configFile = Join-Path $KitPath "task-tree.config.json"
  if (-not (Test-Path -LiteralPath $configFile)) {
    @{ projectRoot = ".." } | ConvertTo-Json | Set-Content -LiteralPath $configFile -Encoding ascii
    Write-Step "Created task-tree.config.json"
  }
}

Write-Host ""
Write-Host "LLM Task Tree — one-click deploy"
Write-Host "Project: $ProjectRoot"
Write-Host ""

if (Test-KitLayout $KitDest) {
  Write-Step "Kit already present at $KitFolderName\"
} else {
  $source = Resolve-KitSource
  if (-not $source) {
    Write-Host ""
    Write-Host "ERROR: Cannot find a kit template to copy." -ForegroundColor Red
    Write-Host ""
    Write-Host "First time — use ONE of these:"
    Write-Host "  A) Copy the whole folder llm-task-tree-kit into this project, then run this script again"
    Write-Host "  B) Set env LLM_TASK_TREE_KIT to the full path of llm-task-tree-kit"
    Write-Host ""
    Write-Host "After a successful deploy, the kit is cached at:"
    Write-Host "  $UserTemplate"
    Write-Host "Then you only need deploy-task-tree.ps1 + 部署任务图.cmd in new projects."
    Write-Host ""
    if ($Host.Name -eq "ConsoleHost") { Read-Host "Press Enter to exit" }
    exit 1
  }
  Write-Step "Copying kit from $source"
  Copy-Kit -Source $source -Destination $KitDest
  Ensure-UserTemplate -SourceKit $KitDest
}

Ensure-Config -KitPath $KitDest

Write-Step "Running install.ps1 (idempotent)"
& (Join-Path $KitDest "install.ps1")

Write-Step "Opening task graph"
& (Join-Path $KitDest "open-task-tree.ps1")

Write-Host ""
Write-Host "Done."
Write-Host "  Task graph UI should be open in your browser."
Write-Host "  Task tree file: $ProjectRoot\task-tree.md"
Write-Host "  Agent rules:    $KitFolderName\AGENTS.task-tree.md"
Write-Host ""
