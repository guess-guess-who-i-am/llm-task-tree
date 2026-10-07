#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
"$ROOT/macos/IDE/install-node-runtime.sh"
export NODE_BIN="$ROOT/macos/IDE/runtime/current/bin/node"
export PATH="$ROOT/macos/IDE/runtime/current/bin:$PATH"
"$ROOT/llm-task-tree-kit/install-macos.sh" "$ROOT/macos/IDE/workspace"
# This is a separate IDE project even when installed inside the source repository.
# An empty baseline enables worktrees without committing any existing user files.
if [[ ! -e "$ROOT/macos/IDE/workspace/.git" ]]; then
  git -C "$ROOT/macos/IDE/workspace" init
fi
if ! git -C "$ROOT/macos/IDE/workspace" rev-parse --verify HEAD >/dev/null 2>&1; then
  git -C "$ROOT/macos/IDE/workspace" -c user.name='Task Tree' -c user.email='task-tree@local' commit --allow-empty -m 'Initialize standalone IDE workspace'
fi
