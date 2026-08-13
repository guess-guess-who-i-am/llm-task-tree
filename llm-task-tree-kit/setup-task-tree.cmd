@echo off
setlocal
title LLM Task Tree - 一键部署
set "LLM_TASK_TREE_PROJECT_ROOT=%~dp0"
set "LLM_TASK_TREE_PROJECT_ROOT=%LLM_TASK_TREE_PROJECT_ROOT:~0,-1%"
set "LLM_TASK_TREE_SETUP_FILE=%~f0"
goto :MAIN

:: 只需复制本文件到目标项目根目录，改下面这一行 kit 路径（留空则用环境变量或本项目下的 llm-task-tree-kit 文件夹）
::KITPATH=E:\解决跟不上大模型思路问题\llm-task-tree-kit

:MAIN
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$lines = Get-Content -LiteralPath $env:LLM_TASK_TREE_SETUP_FILE -Encoding UTF8; $start = -1; $end = $lines.Count - 1; for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -eq ':PSSCRIPT') { $start = $i + 1; break } }; for ($j = $start; $j -lt $lines.Count; $j++) { if ($lines[$j] -eq ':PSEND') { $end = $j - 1; break } }; if ($start -lt 0) { throw 'missing :PSSCRIPT marker' }; $body = ($lines[$start..$end] -join [Environment]::NewLine); Invoke-Expression $body"
if errorlevel 1 (
  echo.
  echo 部署失败，请查看上方错误信息。
  pause
  exit /b 1
)
echo.
echo 按任意键关闭此窗口...
pause >nul
exit /b 0

:PSSCRIPT
$ErrorActionPreference = "Stop"

$ProjectRoot = $env:LLM_TASK_TREE_PROJECT_ROOT
$SetupFile = $env:LLM_TASK_TREE_SETUP_FILE
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

  throw @"
找不到任务树 kit 源目录。请任选一种方式：

  1. 编辑本脚本里的 ::KITPATH= 一行（推荐，只复制这一个文件）
  2. 设置用户环境变量 LLM_TASK_TREE_KIT_HOME
  3. 把 llm-task-tree-kit 文件夹复制到本项目根目录
  4. （旧方式）同目录放 setup-task-tree.kitpath 文件

::KITPATH 示例（仅一行，写在本 cmd 文件里）：
  ::KITPATH=E:\你的路径\llm-task-tree-kit
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

$kitSource = Find-KitSource -Root $ProjectRoot -SelfFile $SetupFile
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
:PSEND
