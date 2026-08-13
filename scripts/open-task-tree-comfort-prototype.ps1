$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$port = 5411
$url = "http://127.0.0.1:$port/task-tree-prototype/index.html?variant=a"

function Test-PrototypeServer {
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/server-info" -TimeoutSec 2 -UseBasicParsing
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

if (-not (Test-PrototypeServer)) {
  $command = "`$env:PORT='$port'; Set-Location -LiteralPath '$($projectRoot.Replace("'", "''"))'; node server.js"
  Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-WindowStyle', 'Hidden', '-Command', $command) -WindowStyle Hidden
  for ($attempt = 0; $attempt -lt 30 -and -not (Test-PrototypeServer); $attempt += 1) {
    Start-Sleep -Milliseconds 250
  }
}

if (-not (Test-PrototypeServer)) {
  throw "任务树舒适版原型服务未能在端口 $port 启动。"
}

Start-Process $url
