#!/usr/bin/env bash
# 链式 loop 门禁：shouldStopLoop 时输出 AGENT_LOOP_STOP；否则 AGENT_LOOP_TICK
set -euo pipefail

PORT="${PORT:-5177}"
URL="http://127.0.0.1:${PORT}/api/graph-state/chain-step"

if ! RESP="$(curl -sf --max-time 15 "$URL")"; then
  echo "AGENT_LOOP_STOP 无法连接任务图服务"
  exit 0
fi

if command -v jq >/dev/null 2>&1; then
  STOP="$(echo "$RESP" | jq -r '.shouldStopLoop')"
  REASON="$(echo "$RESP" | jq -r '.stopReason // "链式执行结束"')"
  NEXT="$(echo "$RESP" | jq -r '.state.next // ""')"
else
  STOP="$(echo "$RESP" | grep -o '"shouldStopLoop":[^,}]*' | head -1 | grep -o 'true\|false' || echo false)"
  REASON="链式执行结束"
  NEXT=""
fi

if [[ "$STOP" == "true" ]]; then
  echo "AGENT_LOOP_STOP $REASON"
  exit 0
fi

echo "AGENT_LOOP_TICK chain-step Next=${NEXT}"
exit 1
