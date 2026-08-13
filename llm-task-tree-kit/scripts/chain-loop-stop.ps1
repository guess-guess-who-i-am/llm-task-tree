# 链式 loop 停止：默认 -SoftOnly 只停 loop 任务，不关闭 IDE；加 -Hard 才结束 Codex/Cursor/VS Code
param(
  [string]$Reason = "链式执行结束",
  [switch]$SoftOnly,
  [switch]$Hard,
  [switch]$StopCodex,
  [switch]$StopIde,
  [switch]$SkipLoopTasks
)

if ($Hard) {
  $StopCodex = $true
  $StopIde = $true
} elseif ($SoftOnly -or (-not $PSBoundParameters.ContainsKey('StopCodex') -and -not $PSBoundParameters.ContainsKey('StopIde'))) {
  $StopCodex = $false
  $StopIde = $false
  $SoftOnly = $true
} else {
  if (-not $PSBoundParameters.ContainsKey('StopCodex')) { $StopCodex = $true }
  if (-not $PSBoundParameters.ContainsKey('StopIde')) { $StopIde = $true }
}

function Write-StopLog([string]$Message) {
  Write-Output "[chain-loop-stop] $Message"
}

function Stop-ByProcessNames([string[]]$Names, [string]$Label) {
  $stopped = 0
  foreach ($name in $Names) {
    $procs = Get-Process -Name $name -ErrorAction SilentlyContinue
    foreach ($proc in $procs) {
      try {
        Stop-Process -Id $proc.Id -Force -ErrorAction Stop
        $stopped++
        Write-StopLog "已结束 ${Label}: $($proc.ProcessName) (PID $($proc.Id))"
      } catch {
        Write-StopLog "无法结束 ${Label} PID $($proc.Id): $($_.Exception.Message)"
      }
    }
  }
  return $stopped
}

function Stop-AgentLoopTasks {
  if ($SkipLoopTasks) { return 0 }
  $stopped = 0
  try {
    $matches = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      $cmd = [string]$_.CommandLine
      $cmd -match 'AGENT_LOOP_(TICK|WAKE)' -or $cmd -match 'chain-loop-gate\.ps1'
    }
    foreach ($proc in $matches) {
      if ($proc.ProcessId -eq $PID) { continue }
      try {
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
        $stopped++
        Write-StopLog "已结束 loop 任务 PID $($proc.ProcessId)"
      } catch {
        Write-StopLog "无法结束 loop 任务 PID $($proc.ProcessId): $($_.Exception.Message)"
      }
    }
  } catch {
    Write-StopLog "扫描 loop 任务失败: $($_.Exception.Message)"
  }
  return $stopped
}

Write-StopLog "开始停止 — $Reason$(if ($SoftOnly) { ' (SoftOnly: 不关闭 IDE)' } else { ' (Hard: 含 IDE)' })"

$total = 0
$total += Stop-AgentLoopTasks

if ($StopCodex) {
  $total += Stop-ByProcessNames @('codex', 'Codex') 'Codex'
}

if ($StopIde) {
  $total += Stop-ByProcessNames @('Cursor') 'Cursor'
  $total += Stop-ByProcessNames @('Code') 'VS Code'
}

if ($total -eq 0) {
  Write-StopLog "未发现可结束的 loop / Codex / IDE 进程（可能已退出）"
} else {
  Write-StopLog "共结束 $total 个进程"
}

Write-Output "AGENT_LOOP_HARD_STOP $Reason"
exit 0
