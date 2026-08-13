param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectRoot
)

$ErrorActionPreference = "Stop"
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
$launcher = Join-Path $ProjectRoot "llm-task-tree\open-task-tree.ps1"

if (-not (Test-Path -LiteralPath $launcher)) {
  Add-Type -AssemblyName System.Windows.Forms
  [void][System.Windows.Forms.MessageBox]::Show(
    "此目录尚未安装 LLM Task Tree。`n`n请先在该文件夹上右键，选择「安装 LLM Task Tree」。",
    "打开任务图",
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Information
  )
  exit 1
}

& powershell -NoProfile -ExecutionPolicy Bypass -File $launcher
