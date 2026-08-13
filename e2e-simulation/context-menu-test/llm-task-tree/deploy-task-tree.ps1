param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectRoot,

  [string]$KitSource = "",
  [string]$SetupFile = "",
  [switch]$OpenAfterInstall
)

$ErrorActionPreference = "Stop"

$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
$KitDest = Join-Path $ProjectRoot "llm-task-tree"

function Write-Step([string]$Message) {
  Write-Host ">> $Message" -ForegroundColor Cyan
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
    (Join-Path $Root "llm-task-tree-kit-source")
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

function Sync-KitDirectory {
  param(
    [string]$Source,
    [string]$Destination
  )

  if (-not (Test-Path -LiteralPath $Destination)) {
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  }

  $excludeDirs = @("node_modules", ".git")
  Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
    if ($excludeDirs -contains $_.Name) { return }
    $target = Join-Path $Destination $_.Name
    if ($_.PSIsContainer) {
      if (Test-Path -LiteralPath $target) {
        Remove-Item -LiteralPath $target -Recurse -Force
      }
      Copy-Item -LiteralPath $_.FullName -Destination $target -Recurse -Force
    } else {
      Copy-Item -LiteralPath $_.FullName -Destination $target -Force
    }
  }
}

Write-Host ""
Write-Host "=== LLM Task Tree 部署 ===" -ForegroundColor Green
Write-Step "项目根目录: $ProjectRoot"

if ($KitSource) {
  $kitSource = [System.IO.Path]::GetFullPath($KitSource)
} else {
  $kitSource = Find-KitSource -Root $ProjectRoot -SelfFile $SetupFile
}

$server = Join-Path $kitSource "server.js"
$install = Join-Path $kitSource "install.ps1"
if (-not ([System.IO.File]::Exists($server) -and [System.IO.File]::Exists($install))) {
  throw "Kit 源无效: $kitSource"
}

Write-Step "Kit 源: $kitSource"
Write-Step "同步 kit -> $KitDest"
Sync-KitDirectory -Source $kitSource -Destination $KitDest

$configFile = Join-Path $KitDest "task-tree.config.json"
if (-not (Test-Path -LiteralPath $configFile)) {
  @{ projectRoot = ".." } | ConvertTo-Json | Set-Content -LiteralPath $configFile -Encoding ascii
  Write-Step "已创建 task-tree.config.json"
}

Write-Step "运行 install.ps1（AGENTS / task-tree / .gitignore / npm）..."
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $KitDest "install.ps1")
if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
  throw "install.ps1 失败，退出码 $LASTEXITCODE"
}

if ($OpenAfterInstall) {
  Write-Step "启动任务图界面..."
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $KitDest "open-task-tree.ps1")
}

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host '  Right-click this folder -> Open task tree'
Write-Host ('  Or run: ' + (Join-Path $KitDest '打开任务图.cmd'))
Write-Host ''
Write-Host ('AGENTS.md: ' + (Join-Path $ProjectRoot 'AGENTS.md'))
Write-Host ('Protocol: ' + (Join-Path $KitDest 'AGENTS.task-tree.md'))
Write-Host ('Task tree: ' + (Join-Path $ProjectRoot 'task-tree.md'))
Write-Host ''