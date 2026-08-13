param(
  [string]$Config = (Join-Path $PSScriptRoot "targets.json"),
  [int]$DebounceSeconds = 3
)

$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

function Resolve-ConfigPath([string]$Base, [string]$Value) {
  if ([System.IO.Path]::IsPathRooted($Value)) { return [System.IO.Path]::GetFullPath($Value) }
  return [System.IO.Path]::GetFullPath((Join-Path $Base $Value))
}

function Get-SourceHash([string]$Path, [int]$Attempts = 8, [int]$DelayMilliseconds = 125) {
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return "" }
    try {
      return (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
    } catch {
      if ($attempt -lt $Attempts) {
        Start-Sleep -Milliseconds $DelayMilliseconds
      }
    }
  }
  return ""
}

function Find-Editor {
  $code = Get-Command code.cmd -ErrorAction SilentlyContinue
  if ($code) { return @{ File = $code.Source; Args = @("--wait") } }
  return @{ File = (Get-Command notepad.exe -ErrorAction Stop).Source; Args = @() }
}

function Open-Source([string]$Source, [switch]$Wait) {
  $editor = Find-Editor
  $arguments = @($editor.Args) + @($Source)
  if ($Wait) {
    return Start-Process -FilePath $editor.File -ArgumentList $arguments -PassThru
  }
  Start-Process -FilePath $editor.File -ArgumentList $arguments | Out-Null
  return $null
}

$configPath = [System.IO.Path]::GetFullPath($Config)
$configDir = Split-Path -Parent $configPath
$settings = Get-Content -Raw -LiteralPath $configPath -Encoding UTF8 | ConvertFrom-Json
$sourceFile = Resolve-ConfigPath $configDir $settings.sourceFile
$publisher = Join-Path $PSScriptRoot "publish-global-prompt.mjs"
$logDir = Join-Path $PSScriptRoot "logs"
$logFile = Join-Path $logDir ("publish-" + (Get-Date -Format "yyyyMMdd") + ".log")
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

$mutex = New-Object System.Threading.Mutex($false, "Local\CodexGlobalPromptPublisher")
$ownsMutex = $false
try {
  $ownsMutex = $mutex.WaitOne(0)
  if (-not $ownsMutex) {
    Open-Source -Source $sourceFile
    exit 0
  }

  $node = Get-Command node.exe,node -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $node) { throw "找不到 Node.js，无法运行 Prompt 发布器。" }
  if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) { throw "中文 Prompt 不存在：$sourceFile" }

  function Write-Status([string]$Message) {
    $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $Message
    Write-Host $line
    [System.IO.File]::AppendAllText($logFile, $line + [Environment]::NewLine, $utf8)
  }

  function Invoke-Publisher {
    Write-Status "检测到保存，开始模型翻译、校验和同步。"
    $output = & $node.Source $publisher --config $configPath 2>&1
    $exitCode = $LASTEXITCODE
    foreach ($line in @($output)) {
      Write-Host $line
      [System.IO.File]::AppendAllText($logFile, [string]$line + [Environment]::NewLine, $utf8)
    }
    if ($exitCode -ne 0) { throw "发布失败（exit $exitCode），详情见：$logFile" }
    Write-Status "本次发布完成。"
  }

  Write-Status "正在打开中文唯一源：$sourceFile"
  $editorProcess = Open-Source -Source $sourceFile -Wait
  $observedHash = Get-SourceHash $sourceFile
  $pending = $false
  $changedAt = [DateTime]::UtcNow
  $lastError = $null

  while (-not $editorProcess.HasExited) {
    Start-Sleep -Milliseconds 500
    $editorProcess.Refresh()
    $currentHash = Get-SourceHash $sourceFile
    if ($currentHash -and $currentHash -ne $observedHash) {
      $observedHash = $currentHash
      $changedAt = [DateTime]::UtcNow
      $pending = $true
      Write-Status "文件已保存，等待内容稳定。"
    }
    if ($pending -and (([DateTime]::UtcNow - $changedAt).TotalSeconds -ge $DebounceSeconds)) {
      try {
        Invoke-Publisher
        $lastError = $null
      } catch {
        $lastError = $_.Exception.Message
        Write-Status $lastError
      }
      $pending = $false
    }
  }

  # Closing the editor also verifies and repairs target drift, even when this session made no edit.
  try {
    Invoke-Publisher
    $lastError = $null
  } catch {
    $lastError = $_.Exception.Message
    Write-Status $lastError
  }

  Add-Type -AssemblyName System.Windows.Forms
  if ($lastError) {
    [System.Windows.Forms.MessageBox]::Show(
      "Prompt 未能完整发布。`n`n$lastError`n`n日志：$logFile",
      "全局 Prompt 发布失败",
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
    exit 1
  }
  [System.Windows.Forms.MessageBox]::Show(
    "中文 Prompt 已翻译、校验，并同步到全部已配置目标。",
    "全局 Prompt 已发布",
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Information
  ) | Out-Null
} catch {
  $startupError = $_.Exception.Message
  try {
    $line = "[{0}] 编辑器监测异常：{1}" -f (Get-Date -Format "HH:mm:ss"), $startupError
    [System.IO.File]::AppendAllText($logFile, $line + [Environment]::NewLine, $utf8)
  } catch {
    # The original error remains the useful one if the log itself is unavailable.
  }
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
      $startupError,
      "无法启动全局 Prompt 编辑器",
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
  } catch {
    Write-Error $startupError
  }
  exit 1
} finally {
  if ($ownsMutex) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
