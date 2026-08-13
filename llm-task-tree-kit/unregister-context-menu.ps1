$ErrorActionPreference = "Stop"

$names = @("LLMTaskTreeInstall", "LLMTaskTreeOpen", "LLMTaskTree.Install", "LLMTaskTree.Open")
$baseKeys = @("Directory", "Directory\Background", "Folder")

foreach ($baseKey in $baseKeys) {
  foreach ($name in $names) {
    & reg.exe delete "HKCU\Software\Classes\$baseKey\shell\$name" /f *> $null
  }
}

& reg.exe delete "HKCU\Software\Classes\Directory\Background\shell\LLMTaskTreeInstallTest" /f *> $null
& reg.exe delete "HKCU\Software\Classes\Folder" /f *> $null
& reg.exe delete "HKCU\Software\LLMTaskTree" /f *> $null

Write-Host ""
Write-Host "Removed LLM Task Tree context menu entries." -ForegroundColor Green
Write-Host "Removed HKCU Folder override (restores normal double-click open)." -ForegroundColor Green
Write-Host ""
