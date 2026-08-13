# 链式 loop 门禁：shouldStopLoop 时输出 STOP 并 exit 0；否则输出 TICK 并 exit 1
param(
  [int]$Port = $(if ($env:PORT) { [int]$env:PORT } else { 5177 })
)

$url = "http://127.0.0.1:$Port/api/graph-state/chain-step"
try {
  $resp = Invoke-RestMethod -Uri $url -Method Get -TimeoutSec 15
} catch {
  Write-Output "AGENT_LOOP_STOP 无法连接任务图服务: $($_.Exception.Message)"
  exit 0
}

if ($resp.shouldStopLoop) {
  $reason = $resp.stopReason
  Write-Output "AGENT_LOOP_STOP $reason"
  $stopScript = Join-Path $PSScriptRoot "chain-loop-stop.ps1"
  if (Test-Path $stopScript) {
    & $stopScript -Reason $reason
  }
  exit 0
}

Write-Output "AGENT_LOOP_TICK chain-step Next=$($resp.state.next)"
exit 1
