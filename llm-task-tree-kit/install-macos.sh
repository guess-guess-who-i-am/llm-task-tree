#!/usr/bin/env bash
set -euo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${OSTYPE:-}" != darwin* ]]; then
  echo "install-macos.sh must run on macOS (detected: ${OSTYPE:-unknown})" >&2
  exit 1
fi

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
# Finder/Terminal launches may not inherit a shell PATH. Reuse the bundled
# runtime when this checkout already contains the standalone IDE runtime.
if [[ -z "$NODE_BIN" && -x "$KIT_DIR/../macos/IDE/runtime/current/bin/node" ]]; then
  NODE_BIN="$KIT_DIR/../macos/IDE/runtime/current/bin/node"
fi
if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js 20.11+ is required. Install Node.js before running this installer." >&2
  exit 1
fi
"$NODE_BIN" --input-type=module - <<'NODE'
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 20 || (major === 20 && minor < 11)) {
  console.error(`Node.js 20.11+ is required; found ${process.versions.node}`);
  process.exit(1);
}
NODE

PROJECT_INPUT="${1:-$(dirname "$KIT_DIR")}"
mkdir -p "$PROJECT_INPUT"
PROJECT_ROOT="$(cd "$PROJECT_INPUT" && pwd -P)"
STUB_DIR="$PROJECT_ROOT/llm-task-tree"

echo ">> Kit: $KIT_DIR"
echo ">> Project root: $PROJECT_ROOT"

mkdir -p "$STUB_DIR" "$PROJECT_ROOT/versions" "$PROJECT_ROOT/knowledge" "$PROJECT_ROOT/scripts"

"$NODE_BIN" "$KIT_DIR/scripts/install-linux-project.mjs" "$PROJECT_ROOT" "$KIT_DIR" "$STUB_DIR"

if [[ ! -f "$PROJECT_ROOT/task-tree.md" ]]; then
  cp "$KIT_DIR/templates/task-tree.starter.md" "$PROJECT_ROOT/task-tree.md"
  echo ">> Created task-tree.md from starter template"
else
  echo ">> task-tree.md already exists — kept as-is"
fi

if [[ ! -f "$PROJECT_ROOT/.env" && -f "$KIT_DIR/templates/.env.example" ]]; then
  cp "$KIT_DIR/templates/.env.example" "$PROJECT_ROOT/.env"
  echo ">> Copied .env.example -> .env"
fi

if command -v npm >/dev/null 2>&1; then
  echo ">> Running npm install in kit"
  (cd "$KIT_DIR" && npm install --ignore-scripts --no-audit --no-fund)
else
  echo ">> npm not found; skipped dependency install (the kit has no runtime dependencies)"
fi

"$NODE_BIN" "$KIT_DIR/scripts/install-codex-hooks.mjs" "$PROJECT_ROOT" "$KIT_DIR/templates/codex"

# Finder equivalent of the Windows Explorer right-click entries. This is user-scoped
# under ~/Library/Services and is refreshed on every kit install/update.
"$NODE_BIN" "$KIT_DIR/scripts/install-finder-services.mjs" "$KIT_DIR"

# Global Codex registration is opt-in because it edits the user's ~/.codex/config.toml.
if [[ "${TASK_TREE_INSTALL_CODEX:-0}" == "1" ]]; then
  "$NODE_BIN" "$KIT_DIR/scripts/install-codex-mcp.mjs" --entry "$KIT_DIR/scripts/mcp-server.mjs" || \
    echo ">> Codex MCP registration skipped; run it manually after Codex login"
fi

MAC_STUB="$STUB_DIR/open-task-tree.command"
cat >"$MAC_STUB" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
STUB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="${NODE_BIN:-}"
if [[ -z "$NODE_BIN" && -x "$STUB_DIR/../../runtime/current/bin/node" ]]; then
  NODE_BIN="$STUB_DIR/../../runtime/current/bin/node"
fi
if [[ ! -x "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node || true)"
fi
if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js 20.11+ is required. Run macos/IDE/install.command first." >&2
  exit 1
fi
KIT_DIR="$($NODE_BIN -e 'const c=require(process.argv[1]); process.stdout.write(c.sharedKitDir||"");' "$STUB_DIR/task-tree.config.json")"
exec env NODE_BIN="$NODE_BIN" "$KIT_DIR/open-task-tree-macos.sh" "$STUB_DIR" "$@"
EOF
chmod +x "$MAC_STUB"

echo
echo "Done."
echo "  Open:   $MAC_STUB"
echo "  URL:    http://127.0.0.1:${PORT:-5177} (the launcher uses a stable project port)"
echo "  Rules:  $STUB_DIR/AGENTS.task-tree.md and AGENTS.node-writing.md"
echo "  Finder: 右键文件夹 → 快速操作/服务 → 创建并打开 LLM 任务树"
