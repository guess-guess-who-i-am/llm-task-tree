#!/usr/bin/env bash
set -euo pipefail

# Finder Quick Actions pass selected folders as positional arguments. The service is
# deliberately small: project installation and the browser/server lifecycle remain in
# the same tested macOS kit entry points used by the standalone IDE.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT_DIR="$SCRIPT_DIR"
if [[ -f "$SCRIPT_DIR/kit.path" ]]; then
  KIT_DIR="$(tr -d '\r\n' <"$SCRIPT_DIR/kit.path")"
fi
KIT_DIR="$(cd "$KIT_DIR" && pwd -P)"
ACTION="${1:-create-open}"
shift || true

if [[ $# -eq 0 ]]; then
  echo "请选择一个文件夹后再运行 LLM Task Tree 服务。" >&2
  exit 2
fi

NODE_BIN="${NODE_BIN:-}"
if [[ -z "$NODE_BIN" && -x "$KIT_DIR/../macos/IDE/runtime/current/bin/node" ]]; then
  NODE_BIN="$KIT_DIR/../macos/IDE/runtime/current/bin/node"
fi
if [[ -z "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node || true)"
fi
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "找不到 Node.js 20.11+。请先运行 macos/IDE/install.command，或安装 Node.js。" >&2
  exit 1
fi

for selected in "$@"; do
  [[ -d "$selected" ]] || continue
  PROJECT_ROOT="$(cd "$selected" && pwd -P)"
  STUB_DIR="$PROJECT_ROOT/llm-task-tree"

  # Both actions are safe as a first-use entry: an uninstalled folder is initialized
  # before its HTML graph is opened. Existing task-tree.md is preserved by the installer.
  if [[ ! -f "$PROJECT_ROOT/task-tree.md" || ! -f "$STUB_DIR/task-tree.config.json" ]]; then
    OSTYPE=darwin NODE_BIN="$NODE_BIN" "$KIT_DIR/install-macos.sh" "$PROJECT_ROOT"
  fi

  if [[ "$ACTION" == "create" || "$ACTION" == "create-open" || "$ACTION" == "open" ]]; then
    TASK_TREE_STUB_DIR="$STUB_DIR" NODE_BIN="$NODE_BIN" \
      "$KIT_DIR/open-task-tree-macos.sh" "$STUB_DIR"
  else
    echo "未知 Finder 服务动作：$ACTION" >&2
    exit 2
  fi
done
