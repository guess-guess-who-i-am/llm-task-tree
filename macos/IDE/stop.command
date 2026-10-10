#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKSPACE="$ROOT"
PORT_FILE="$WORKSPACE/.task-tree-port"
if [[ ! -f "$PORT_FILE" ]]; then
  echo "No task tree server marker found."
  exit 0
fi
PORT="$(tr -dc '0-9' <"$PORT_FILE")"
if [[ -n "$PORT" ]]; then
  curl --noproxy '*' --fail --silent --show-error -X POST "http://127.0.0.1:$PORT/api/shutdown" >/dev/null || true
fi
rm -f "$WORKSPACE/.task-tree-server.pid"
echo "Task tree server stopped."
