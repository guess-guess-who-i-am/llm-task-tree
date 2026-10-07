#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODE_BIN="${NODE_BIN:-}"
if [[ -z "$NODE_BIN" && -x "$ROOT/macos/IDE/runtime/current/bin/node" ]]; then
  NODE_BIN="$ROOT/macos/IDE/runtime/current/bin/node"
fi
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js 20.11+ is required." >&2
  exit 1
fi
PATH="$(dirname "$NODE_BIN"):$PATH" exec "$NODE_BIN" "$ROOT/scripts/test-macos-kit.mjs"
