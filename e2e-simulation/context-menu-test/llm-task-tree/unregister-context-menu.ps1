$ErrorActionPreference = "Stop"

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

Unregister-ShellCommand "Directory" "LLMTaskTree.Install"
Unregister-ShellCommand "Directory" "LLMTaskTree.Open"
Unregister-ShellCommand "Directory\Background" "LLMTaskTree.Install"
Unregister-ShellCommand "Directory\Background" "LLMTaskTree.Open"

$configPath = "Registry::HKEY_CURRENT_USER\Software\LLMTaskTree"
if (Test-Path -LiteralPath $configPath) {
  Remove-Item -LiteralPath $configPath -Recurse -Force
}

Write-Host ""
Write-Host "已移除 LLM Task Tree 右键菜单。" -ForegroundColor Green
Write-Host ""
