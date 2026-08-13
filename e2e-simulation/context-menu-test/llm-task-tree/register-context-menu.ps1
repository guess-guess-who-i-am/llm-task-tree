$ErrorActionPreference = "Stop"

$KitDir = [System.IO.Path]::GetFullPath($PSScriptRoot)
$installCmd = Join-Path $KitDir "context-menu-install.cmd"
$openCmd = Join-Path $KitDir "context-menu-open.cmd"

foreach ($path in @($installCmd, $openCmd, (Join-Path $KitDir "deploy-task-tree.ps1"))) {
  if (-not (Test-Path -LiteralPath $path)) {
    throw "缺少文件: $path"
  }
}

function Register-ShellCommand {
  param(
    [string]$BaseKey,
    [string]$Name,
    [string]$Label,
    [string]$Command,
    [string]$Position = "Top"
  )

  $keyPath = "Registry::HKEY_CURRENT_USER\Software\Classes\$BaseKey\shell\$Name"
  New-Item -Path $keyPath -Force | Out-Null
  Set-ItemProperty -LiteralPath $keyPath -Name "(Default)" -Value $Label
  Set-ItemProperty -LiteralPath $keyPath -Name "Position" -Value $Position

  $commandPath = Join-Path $keyPath "command"
  New-Item -Path $commandPath -Force | Out-Null
  Set-ItemProperty -LiteralPath $commandPath -Name "(Default)" -Value $Command
}

function Unregister-ShellCommand {
  param(
    [string]$BaseKey,
    [string]$Name
  )

  $keyPath = "Registry::HKEY_CURRENT_USER\Software\Classes\$BaseKey\shell\$Name"
  if (Test-Path -LiteralPath $keyPath) {
    Remove-Item -LiteralPath $keyPath -Recurse -Force
  }
}

$quotedInstall = "`"$installCmd`" `"%1`""
$quotedOpen = "`"$openCmd`" `"%1`""
$quotedInstallBg = "`"$installCmd`" `"%V`""
$quotedOpenBg = "`"$openCmd`" `"%V`""

Unregister-ShellCommand "Directory" "LLMTaskTree.Install"
Unregister-ShellCommand "Directory" "LLMTaskTree.Open"
Unregister-ShellCommand "Directory\Background" "LLMTaskTree.Install"
Unregister-ShellCommand "Directory\Background" "LLMTaskTree.Open"

Register-ShellCommand -BaseKey "Directory" -Name "LLMTaskTree.Install" -Label "安装 LLM Task Tree" -Command $quotedInstall -Position "Top"
Register-ShellCommand -BaseKey "Directory" -Name "LLMTaskTree.Open" -Label "打开任务图" -Command $quotedOpen -Position "Bottom"
Register-ShellCommand -BaseKey "Directory\Background" -Name "LLMTaskTree.Install" -Label "安装 LLM Task Tree" -Command $quotedInstallBg -Position "Top"
Register-ShellCommand -BaseKey "Directory\Background" -Name "LLMTaskTree.Open" -Label "打开任务图" -Command $quotedOpenBg -Position "Bottom"

$configPath = "Registry::HKEY_CURRENT_USER\Software\LLMTaskTree"
New-Item -Path $configPath -Force | Out-Null
Set-ItemProperty -LiteralPath $configPath -Name "KitDir" -Value $KitDir

Write-Host ""
Write-Host "已注册右键菜单（当前用户，无需管理员）:" -ForegroundColor Green
Write-Host "  安装 LLM Task Tree"
Write-Host "  打开任务图"
Write-Host ""
Write-Host "Kit 目录: $KitDir"
Write-Host ""
Write-Host "用法: 在资源管理器中右键任意文件夹（或文件夹内空白处）即可看到上述菜单。"
Write-Host "卸载: 双击 unregister-context-menu.cmd"
Write-Host ""
