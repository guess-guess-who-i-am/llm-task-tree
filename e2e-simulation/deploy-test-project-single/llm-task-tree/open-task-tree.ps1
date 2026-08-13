$ErrorActionPreference = "Stop"

$KitDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$HostName = "127.0.0.1"

function Get-TaskTreeProjectRoot {
  param([string]$BaseDir)
  $configFile = Join-Path $BaseDir "task-tree.config.json"
  if (-not (Test-Path -LiteralPath $configFile)) {
    return $BaseDir
  }
  try {
    $config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
    $raw = [string]$config.projectRoot
    if (-not $raw -or $raw.Trim() -eq ".") {
      return $BaseDir
    }
    if ([System.IO.Path]::IsPathRooted($raw)) {
      return [System.IO.Path]::GetFullPath($raw)
    }
    return [System.IO.Path]::GetFullPath((Join-Path $BaseDir $raw))
  } catch {
    return $BaseDir
  }
}

$ProjectRoot = Get-TaskTreeProjectRoot -BaseDir $KitDir
$PortFile = Join-Path $ProjectRoot ".task-tree-port"
$KnownPortsFile = Join-Path $ProjectRoot ".task-tree-ports"

function Get-FreePort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try {
    return $listener.LocalEndpoint.Port
  } finally {
    $listener.Stop()
  }
}

function Test-ProjectServer {
  param([int]$Port)
  try {
    $project = Invoke-RestMethod -Uri "http://$HostName`:$Port/api/project" -Method Get -TimeoutSec 1
    $expected = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\')
    $actual = [System.IO.Path]::GetFullPath([string]$project.root).TrimEnd('\')
    return $actual -ieq $expected
  } catch {
    return $false
  }
}

function Stop-ProjectServer {
  param([int]$Port)
  try {
    Invoke-RestMethod -Uri "http://$HostName`:$Port/api/shutdown" -Method Post -TimeoutSec 1 | Out-Null
    return
  } catch {
    try {
      Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
        Where-Object { $_.OwningProcess } |
        ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
    } catch {
    }
  }
}

function Stop-OtherProjectServers {
  param([int]$KeepPort)
  $ports = @()
  if (Test-Path -LiteralPath $KnownPortsFile) {
    $ports += Get-Content -LiteralPath $KnownPortsFile | ForEach-Object {
      $value = 0
      if ([int]::TryParse($_.Trim(), [ref]$value)) { $value }
    }
  }
  if (Test-Path -LiteralPath $PortFile) {
    $saved = 0
    if ([int]::TryParse((Get-Content -LiteralPath $PortFile -Raw).Trim(), [ref]$saved)) {
      $ports += $saved
    }
  }
  $ports = $ports | Where-Object { $_ -and $_ -ne $KeepPort } | Select-Object -Unique
  foreach ($candidatePort in $ports) {
    try {
      $project = Invoke-RestMethod -Uri "http://$HostName`:$candidatePort/api/project" -Method Get -TimeoutSec 1
      $expected = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\')
      $actual = [System.IO.Path]::GetFullPath([string]$project.root).TrimEnd('\')
      if ($actual -ieq $expected) {
        Stop-ProjectServer -Port $candidatePort
      }
    } catch {
    }
  }
}

function Add-KnownProjectPort {
  param([int]$Port)
  $ports = @()
  if (Test-Path -LiteralPath $KnownPortsFile) {
    $ports += Get-Content -LiteralPath $KnownPortsFile
  }
  $ports += [string]$Port
  $ports |
    Where-Object { $_ -and $_.Trim() } |
    Select-Object -Unique |
    Set-Content -LiteralPath $KnownPortsFile -Encoding ascii
}

function Get-DotEnvValue {
  param([string]$Name)
  $envFile = Join-Path $ProjectRoot ".env"
  if (-not (Test-Path -LiteralPath $envFile)) {
    return ""
  }
  foreach ($line in Get-Content -LiteralPath $envFile) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) {
      continue
    }
    $prefix = "$Name="
    if ($trimmed.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      return $trimmed.Substring($prefix.Length).Trim().Trim('"').Trim("'")
    }
  }
  return ""
}

function Normalize-ProviderName {
  param([string]$Value)
  return (($Value.Trim().ToLowerInvariant()) -replace "[\s_-]+", "")
}

function Test-OpenWebSearchDaemon {
  param([string]$BaseUrl)
  try {
    $health = Invoke-RestMethod -Uri "$BaseUrl/health" -Method Get -TimeoutSec 1
    return [string]$health.status -eq "ok"
  } catch {
    return $false
  }
}

function Ensure-OpenWebSearchDaemon {
  $provider = Normalize-ProviderName -Value (Get-DotEnvValue -Name "WEB_SEARCH_PROVIDER")
  if ($provider -ne "openwebsearch") {
    return
  }

  $baseUrl = Get-DotEnvValue -Name "WEB_SEARCH_BASE_URL"
  if (-not $baseUrl) {
    $baseUrl = "http://127.0.0.1:3210"
  }

  if (Test-OpenWebSearchDaemon -BaseUrl $baseUrl) {
    return
  }

  $uri = [System.Uri]::new($baseUrl)
  $daemonHost = if ($uri.Host) { $uri.Host } else { "127.0.0.1" }
  $daemonPort = if ($uri.Port -gt 0) { $uri.Port } else { 3210 }
  $openWebSearchRoot = Join-Path $KitDir "open-webSearch"
  $entry = Join-Path $openWebSearchRoot "build\index.js"
  $nodeModules = Join-Path $openWebSearchRoot "node_modules"
  $launcherLog = Join-Path $ProjectRoot "open-websearch-launcher.log"
  $launcherErr = Join-Path $ProjectRoot "open-websearch-launcher.err.log"

  if (-not (Test-Path -LiteralPath $entry)) {
    if (Test-Path -LiteralPath $nodeModules) {
      Push-Location $openWebSearchRoot
      try {
        & npm run build *> $launcherLog
      } catch {
        "open-webSearch build failed: $($_.Exception.Message)" | Set-Content -LiteralPath $launcherErr -Encoding utf8
        return
      } finally {
        Pop-Location
      }
    }
  }

  if (-not (Test-Path -LiteralPath $entry)) {
    "open-webSearch is not built. Run: cd open-webSearch; npm install; npm run build" | Set-Content -LiteralPath $launcherErr -Encoding utf8
    return
  }

  $node = (Get-Command node -ErrorAction Stop).Source
  $engines = Get-DotEnvValue -Name "OPEN_WEBSEARCH_ENGINES"
  $searchMode = Get-DotEnvValue -Name "OPEN_WEBSEARCH_SEARCH_MODE"
  if (-not $searchMode) {
    $searchMode = "request"
  }
  $defaultEngine = "duckduckgo"
  if ($engines) {
    $defaultEngine = ($engines.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -First 1)
  }

  $env:OPEN_WEBSEARCH_DAEMON_HOST = [string]$daemonHost
  $env:OPEN_WEBSEARCH_DAEMON_PORT = [string]$daemonPort
  $env:DEFAULT_SEARCH_ENGINE = [string]$defaultEngine
  $env:ALLOWED_SEARCH_ENGINES = [string]$engines
  $env:SEARCH_MODE = [string]$searchMode

  Start-Process -FilePath $node `
    -ArgumentList @("build/index.js", "serve", "--host", [string]$daemonHost, "--port", [string]$daemonPort) `
    -WorkingDirectory $openWebSearchRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $launcherLog `
    -RedirectStandardError $launcherErr

  for ($i = 0; $i -lt 60; $i += 1) {
    if (Test-OpenWebSearchDaemon -BaseUrl $baseUrl) {
      return
    }
    Start-Sleep -Milliseconds 250
  }
}

function Open-TaskTree {
  param([int]$Port)
  $url = "http://$HostName`:$Port"
  $edgeCandidates = @(
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
  )
  $chromeCandidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
  )
  $browser = @($edgeCandidates + $chromeCandidates) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
  if ($browser) {
    Start-Process -FilePath $browser -ArgumentList @("--app=$url", "--new-window")
    return
  }
  Start-Process $url
}

if (Test-Path -LiteralPath $PortFile) {
  $savedPortText = (Get-Content -LiteralPath $PortFile -Raw).Trim()
  $savedPort = 0
  if ([int]::TryParse($savedPortText, [ref]$savedPort) -and (Test-ProjectServer -Port $savedPort)) {
    Add-KnownProjectPort -Port $savedPort
    Stop-OtherProjectServers -KeepPort $savedPort
    Ensure-OpenWebSearchDaemon
    Open-TaskTree -Port $savedPort
    exit 0
  }
}

$port = Get-FreePort
Set-Content -LiteralPath $PortFile -Value $port -Encoding ascii
Add-KnownProjectPort -Port $port

$node = (Get-Command node -ErrorAction Stop).Source
$ps = (Get-Process -Id $PID).Path
$escapedKitDir = $KitDir.Replace("'", "''")
$escapedNode = $node.Replace("'", "''")
$command = "`$env:HOST='$HostName'; `$env:PORT='$port'; Set-Location -LiteralPath '$escapedKitDir'; & '$escapedNode' 'server.js'"

Start-Process -FilePath $ps -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $command) -WindowStyle Hidden

for ($i = 0; $i -lt 40; $i += 1) {
  if (Test-ProjectServer -Port $port) {
    Stop-OtherProjectServers -KeepPort $port
    Ensure-OpenWebSearchDaemon
    Open-TaskTree -Port $port
    exit 0
  }
  Start-Sleep -Milliseconds 150
}

Write-Host "任务图服务启动超时。你可以手动运行 npm start 查看错误。"
Read-Host "按 Enter 退出"
