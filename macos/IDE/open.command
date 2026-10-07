#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -x "$ROOT/macos/IDE/runtime/current/bin/node" ]]; then
  export NODE_BIN="$ROOT/macos/IDE/runtime/current/bin/node"
  export PATH="$ROOT/macos/IDE/runtime/current/bin:$PATH"
fi
exec "$ROOT/llm-task-tree-kit/open-task-tree-macos.sh" "$ROOT/macos/IDE/workspace/llm-task-tree" "$@"
