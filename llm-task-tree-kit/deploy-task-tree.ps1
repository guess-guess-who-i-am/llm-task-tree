param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectRoot,

  [string]$KitSource = "",
  [string]$SetupFile = "",
  [switch]$OpenAfterInstall,
  [switch]$FullCopy,
  [switch]$UseSharedKit
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "kit-runtime.ps1")

$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
$KitDest = Join-Path $ProjectRoot "llm-task-tree"

function Write-Step([string]$Message) {
  Write-Host ('>> ' + $Message) -ForegroundColor Cyan
}

function Get-EmbeddedKitPath {
  param([string]$File)
  if (-not $File -or -not (Test-Path -LiteralPath $File)) { return "" }
  foreach ($line in Get-Content -LiteralPath $File -Encoding UTF8) {
    if ($line -match '^\s*::KITPATH=(.*)$') {
      return $Matches[1].Trim()
    }
  }
  return ""
}

function Find-KitSource {
  param([string]$Root, [string]$SelfFile)

  $kitPathFile = Join-Path $Root "setup-task-tree.kitpath"
  $fromFile = ""
  if (Test-Path -LiteralPath $kitPathFile) {
    $fromFile = (Get-Content -LiteralPath $kitPathFile -Raw -Encoding UTF8).Trim()
  }

  $embedded = Get-EmbeddedKitPath -File $SelfFile

  $candidates = @(
    $(if ($env:LLM_TASK_TREE_KIT_HOME) { $env:LLM_TASK_TREE_KIT_HOME.Trim() }),
    $embedded,
    $fromFile,
    (Join-Path $Root "llm-task-tree-kit"),
    (Join-Path $Root "llm-task-tree-kit-source"),
    $PSScriptRoot
  ) | Where-Object { $_ }

  foreach ($candidate in $candidates) {
    try {
      $resolved = [System.IO.Path]::GetFullPath($candidate)
    } catch {
      continue
    }
    $server = Join-Path $resolved "server.js"
    $install = Join-Path $resolved "install.ps1"
    if ([System.IO.File]::Exists($server) -and [System.IO.File]::Exists($install)) {
      return $resolved
    }
  }

  throw @'
找不到任务树 kit 源目录。请任选一种方式：

  1. 右键菜单：重新运行 llm-task-tree-kit/register-context-menu.cmd
  2. 设置用户环境变量 LLM_TASK_TREE_KIT_HOME
  3. 编辑 setup-task-tree.cmd 里的 ::KITPATH= 一行
  4. 把 llm-task-tree-kit 文件夹复制到本项目根目录
'@
}

Write-Host ""
Write-Host '=== LLM Task Tree deploy ===' -ForegroundColor Green
Write-Step ('Project root: ' + $ProjectRoot)

if ($KitSource) {
  $kitSource = [System.IO.Path]::GetFullPath($KitSource)
} else {
  $kitSource = Find-KitSource -Root $ProjectRoot -SelfFile $SetupFile
}

$server = Join-Path $kitSource "server.js"
$install = Join-Path $kitSource "install.ps1"
if (-not ([System.IO.File]::Exists($server) -and [System.IO.File]::Exists($install))) {
  throw ('Invalid kit source: ' + $kitSource)
}

$useShared = -not $FullCopy
if ($PSBoundParameters.ContainsKey("UseSharedKit")) {
  $useShared = [bool]$UseSharedKit
}

$kitSourceNorm = $kitSource.TrimEnd('\')
$kitDestNorm = $KitDest.TrimEnd('\')
if ($kitSourceNorm -ieq $kitDestNorm) {
  $useShared = $false
}

Write-Step ('Kit source: ' + $kitSource)

if ($useShared) {
  Write-Step 'Mode: shared kit (project keeps stub only; update master kit for all projects)'
  Stop-ProjectTaskTreeServer -ProjectRoot $ProjectRoot
  Start-Sleep -Milliseconds 300
  if (Test-Path -LiteralPath $KitDest) {
    Remove-ProjectKitDirectory -StubDir $KitDest
  }
  Write-SharedKitStub -StubDir $KitDest -SharedKitDir $kitSource -ProjectRoot $ProjectRoot
  Write-Step ('Stub written -> ' + $KitDest)
} else {
  Write-Step 'Mode: full copy (independent kit per project)'
  Write-Step ('Sync kit -> ' + $KitDest)
  Sync-FullKitDirectory -Source $kitSource -Destination $KitDest
  $configFile = Join-Path $KitDest "task-tree.config.json"
  if (-not (Test-Path -LiteralPath $configFile)) {
    @{ projectRoot = ".." } | ConvertTo-Json | Set-Content -LiteralPath $configFile -Encoding ascii
    Write-Step 'Created task-tree.config.json'
  }
}

Write-Step 'Running install.ps1 (AGENTS / task-tree / .gitignore / npm)...'
& powershell -NoProfile -ExecutionPolicy Bypass -File $install -StubDir $KitDest
if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
  throw ('install.ps1 failed, exit code ' + $LASTEXITCODE)
}

Register-TaskTreeProject -ProjectRoot $ProjectRoot

if ($OpenAfterInstall) {
  Write-Step 'Opening task graph UI...'
  $openScript = Join-Path $KitDest 'open-task-tree.ps1'
  & powershell -NoProfile -ExecutionPolicy Bypass -File $openScript
}

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
if ($useShared) {
  Write-Host '  Mode: shared kit (update once -> all projects)'
  Write-Host ('  Shared kit: ' + $kitSource)
} else {
  Write-Host '  Mode: full local copy per project'
}
Write-Host '  Right-click this folder -> Open task tree'
Write-Host ('  Or run: ' + (Join-Path $KitDest '打开任务图.cmd'))
Write-Host ''
Write-Host ('AGENTS.md: ' + (Join-Path $ProjectRoot 'AGENTS.md'))
Write-Host ('Task tree: ' + (Join-Path $ProjectRoot 'task-tree.md'))
Write-Host ''
