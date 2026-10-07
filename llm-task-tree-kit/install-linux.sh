#!/usr/bin/env bash
set -euo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_INPUT="${1:-$(dirname "$KIT_DIR")}"
mkdir -p "$PROJECT_INPUT"
PROJECT_ROOT="$(cd "$PROJECT_INPUT" && pwd)"
STUB_DIR="$PROJECT_ROOT/llm-task-tree"

if [[ -f "$STUB_DIR/task-tree.config.json" ]]; then
  ROOT_RAW="$(node -e "
    const c=require(process.argv[1]);
    const p=c.projectRoot||'..';
    if(p==='.'||p==='') process.stdout.write(process.argv[2]);
    else if(p.startsWith('/')) process.stdout.write(p);
    else process.stdout.write(require('path').resolve(process.argv[2], p));
  " "$STUB_DIR/task-tree.config.json" "$STUB_DIR")"
  PROJECT_ROOT="$(cd "$ROOT_RAW" && pwd)"
fi

step() { echo ">> $*"; }

step "Kit: $KIT_DIR"
step "Stub: $STUB_DIR"
step "Project root: $PROJECT_ROOT"

mkdir -p "$STUB_DIR"
mkdir -p "$PROJECT_ROOT/versions" "$PROJECT_ROOT/knowledge" "$PROJECT_ROOT/scripts"

node "$KIT_DIR/scripts/install-linux-project.mjs" "$PROJECT_ROOT" "$KIT_DIR" "$STUB_DIR"

if [[ ! -f "$STUB_DIR/task-tree.config.json" ]]; then
  printf '%s\n' '{"projectRoot":".."}' > "$STUB_DIR/task-tree.config.json"
  step "Created llm-task-tree/task-tree.config.json"
fi

TREE_FILE="$PROJECT_ROOT/task-tree.md"
if [[ ! -f "$TREE_FILE" ]]; then
  cp "$KIT_DIR/templates/task-tree.starter.md" "$TREE_FILE"
  step "Created task-tree.md from starter template"
else
  step "task-tree.md already exists — kept as-is"
fi

ENV_TARGET="$PROJECT_ROOT/.env"
if [[ ! -f "$ENV_TARGET" && -f "$KIT_DIR/templates/.env.example" ]]; then
  cp "$KIT_DIR/templates/.env.example" "$ENV_TARGET"
  step "Copied .env.example -> .env"
fi

step "Running npm install in kit..."
(cd "$KIT_DIR" && npm install)

if [[ -f "$KIT_DIR/templates/codex/hooks.json" ]]; then
  node "$KIT_DIR/scripts/install-codex-hooks.mjs" "$PROJECT_ROOT" "$KIT_DIR/templates/codex"
fi

if command -v codex >/dev/null 2>&1; then
  if node "$KIT_DIR/scripts/install-codex-mcp.mjs" \
    --with-plugin \
    --entry "$KIT_DIR/scripts/mcp-server.mjs" \
    --marketplace "$KIT_DIR/marketplace"; then
    if codex plugin list 2>/dev/null | grep -Eq '^task-tree@llm-task-tree[[:space:]]+installed'; then
      step "Codex task-tree plugin already installed"
    else
      codex plugin add task-tree@llm-task-tree || step "Codex plugin install skipped (run manually after login)"
    fi
  else
    step "Codex registration skipped (run manually after login)"
  fi
else
  step "Codex CLI not found — skipped global MCP/plugin registration"
fi

cat <<EOF

Done.

  Start:  $STUB_DIR/open-task-tree.sh
  Open:   http://127.0.0.1:\${PORT:-5177}
  Rules:  $STUB_DIR/AGENTS.task-tree.md and AGENTS.node-writing.md

EOF
