# 一键部署 LLM Task Tree 到当前项目
# 用法：把 setup-task-tree.cmd + setup-task-tree.ps1 复制到任意项目根目录，双击 .cmd 即可。
# 可选：在同目录放 llm-task-tree-kit 文件夹，或设置环境变量 LLM_TASK_TREE_KIT_HOME 指向 kit 源目录。

$ErrorActionPreference = "Stop"

$ProjectRoot = $PSScriptRoot
$KitDest = Join-Path $ProjectRoot "llm-task-tree"
$HostName = "127.0.0.1"

function Write-Step([string]$Message) {
  Write-Host ">> $Message" -ForegroundColor Cyan
}

function Find-KitSource {
  $kitPathFile = Join-Path $ProjectRoot "setup-task-tree.kitpath"
  $fromFile = ""
  if (Test-Path -LiteralPath $kitPathFile) {
    $fromFile = (Get-Content -LiteralPath $kitPathFile -Raw -Encoding UTF8).Trim()
  }

  $candidates = @(
    $(if ($env:LLM_TASK_TREE_KIT_HOME) { $env:LLM_TASK_TREE_KIT_HOME.Trim() }),
    $fromFile,
    (Join-Path $ProjectRoot "llm-task-tree-kit"),
    (Join-Path $ProjectRoot "llm-task-tree-kit-source")
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

  throw @"
找不到任务树 kit 源目录。请任选一种方式：

  1. 与 setup 脚本同级放置 setup-task-tree.kitpath（一行文字 = kit 文件夹完整路径）
  2. 设置用户环境变量 LLM_TASK_TREE_KIT_HOME
  3. 把 llm-task-tree-kit 文件夹复制到本项目根目录

kitpath 示例内容（仅一行）：
  E:\你的路径\llm-task-tree-kit
"@
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
Write-Host "=== LLM Task Tree 一键部署 ===" -ForegroundColor Green
Write-Step "项目根目录: $ProjectRoot"

$kitSource = Find-KitSource
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

Write-Step "启动任务图界面..."
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $KitDest "open-task-tree.ps1")

Write-Host ""
Write-Host "完成。以后只需双击:" -ForegroundColor Green
Write-Host "  $KitDest\打开任务图.cmd"
Write-Host ""
Write-Host "Agent 规则: $ProjectRoot\AGENTS.md"
Write-Host "完整协议: $KitDest\AGENTS.task-tree.md"
Write-Host "任务树文件: $ProjectRoot\task-tree.md"
Write-Host ""
