param(
  [string]$CodexHome = (Join-Path $env:USERPROFILE ".codex"),
  [string]$RemoteHost = "huangyu",
  [string]$RemoteCodexHome = ".codex",
  [string]$ShortcutDirectory = [Environment]::GetFolderPath("Desktop"),
  [string]$ShortcutName = "编辑并发布全局 Prompt.lnk",
  [switch]$PublishNow
)

$ErrorActionPreference = "Stop"
$sourceDir = $PSScriptRoot
$codexHome = [System.IO.Path]::GetFullPath($CodexHome)
$installDir = Join-Path $codexHome "prompt-publisher"
$promptDir = Join-Path $codexHome "prompts"
$configFile = Join-Path $installDir "targets.json"
$sourcePrompt = Join-Path $promptDir "global-every-turn.zh.md"
$englishPrompt = Join-Path $promptDir "global-every-turn.en.md"
$hooksFile = Join-Path $codexHome "hooks.json"

foreach ($required in @($sourcePrompt, $englishPrompt, $hooksFile)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "缺少现有 Codex 全局 Prompt/Hook 文件：$required" }
}
if (-not ((Get-Content -Raw -LiteralPath $hooksFile -Encoding UTF8) -match "global-user-prompt-submit")) {
  throw "用户级 hooks.json 尚未安装 global-user-prompt-submit Hook：$hooksFile"
}
if (-not (Get-Command node.exe,node -ErrorAction SilentlyContinue | Select-Object -First 1)) {
  throw "找不到 Node.js。"
}

New-Item -ItemType Directory -Path $installDir -Force | Out-Null
foreach ($name in @("publish-global-prompt.mjs", "edit-global-prompt.ps1", "launch-global-prompt-editor.vbs", "translation.schema.json", "README.zh.md")) {
  Copy-Item -LiteralPath (Join-Path $sourceDir $name) -Destination (Join-Path $installDir $name) -Force
}

if (-not (Test-Path -LiteralPath $configFile)) {
  $remoteTargets = @()
  if ($RemoteHost) {
    $remoteTargets += [ordered]@{
      name = $RemoteHost
      sshHost = $RemoteHost
      codexHome = $RemoteCodexHome
      requireGlobalHook = $true
    }
  }
  $config = [ordered]@{
    version = 1
    sourceFile = "../prompts/global-every-turn.zh.md"
    stateFile = "state.json"
    schemaFile = "translation.schema.json"
    lockFile = "publish.lock"
    model = ""
    translationTimeoutMs = 600000
    translationAttempts = 3
    translationRetryDelayMs = 2000
    localTargets = @(
      [ordered]@{
        name = "本机 Codex（覆盖所有本机项目）"
        codexHome = ".."
        requireGlobalHook = $true
      }
    )
    remoteTargets = $remoteTargets
  }
  $json = $config | ConvertTo-Json -Depth 8
  [System.IO.File]::WriteAllText($configFile, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
}

$shortcutDirectory = [System.IO.Path]::GetFullPath($ShortcutDirectory)
New-Item -ItemType Directory -Path $shortcutDirectory -Force | Out-Null
$shortcutFile = Join-Path $shortcutDirectory $ShortcutName
$wscript = Join-Path $env:WINDIR "System32\wscript.exe"
$launcher = Join-Path $installDir "launch-global-prompt-editor.vbs"
$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($shortcutFile)
$shortcut.TargetPath = $wscript
$shortcut.Arguments = ('"{0}" "{1}"' -f $launcher, $configFile)
$shortcut.WorkingDirectory = $installDir
$shortcut.WindowStyle = 7
$shortcut.Description = "编辑中文全局 Prompt；保存后自动翻译、校验并同步本机与远程 Codex"
$code = Get-Command code.cmd -ErrorAction SilentlyContinue
if ($code) {
  $codeExe = Join-Path (Split-Path -Parent (Split-Path -Parent $code.Source)) "Code.exe"
  if (Test-Path -LiteralPath $codeExe) { $shortcut.IconLocation = "$codeExe,0" }
}
$shortcut.Save()

Write-Host "Prompt 发布器已安装：$installDir" -ForegroundColor Green
Write-Host "桌面快捷方式：$shortcutFile" -ForegroundColor Green
Write-Host "目标配置：$configFile"

if ($PublishNow) {
  $node = Get-Command node.exe,node -ErrorAction Stop | Select-Object -First 1
  & $node.Source (Join-Path $installDir "publish-global-prompt.mjs") --config $configFile
  if ($LASTEXITCODE -ne 0) { throw "首次 Prompt 发布失败（exit $LASTEXITCODE）" }
}
