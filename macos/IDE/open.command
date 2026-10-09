#!/usr/bin/env bash
set -euo pipefail
LAUNCHER_SOURCE="${BASH_SOURCE[0]}"
while [[ -L "$LAUNCHER_SOURCE" ]]; do
  LAUNCHER_DIR="$(cd "$(dirname "$LAUNCHER_SOURCE")" && pwd)"
  LAUNCHER_SOURCE="$(readlink "$LAUNCHER_SOURCE")"
  [[ "$LAUNCHER_SOURCE" = /* ]] || LAUNCHER_SOURCE="$LAUNCHER_DIR/$LAUNCHER_SOURCE"
done
ROOT="$(cd "$(dirname "$LAUNCHER_SOURCE")/../.." && pwd)"
if [[ -x "$ROOT/macos/IDE/runtime/current/bin/node" ]]; then
  export NODE_BIN="$ROOT/macos/IDE/runtime/current/bin/node"
  export PATH="$ROOT/macos/IDE/runtime/current/bin:$PATH"
fi
exec "$ROOT/llm-task-tree-kit/open-task-tree-macos.sh" "$ROOT/llm-task-tree" "$@"
