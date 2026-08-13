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
    "LLM Task Tree is not installed in this folder.`n`nRight-click the folder and choose Install LLM Task Tree first.",
    "Open Task Tree",
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Information
  )
  exit 1
}

& powershell -NoProfile -ExecutionPolicy Bypass -File $launcher
if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
