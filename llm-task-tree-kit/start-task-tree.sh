#!/usr/bin/env bash
set -euo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STUB_INPUT="${1:-${TASK_TREE_STUB_DIR:-$(dirname "$KIT_DIR")/llm-task-tree}}"
STUB_DIR="$(cd "$STUB_INPUT" && pwd)"
PROJECT_ROOT="$(cd "$(dirname "$STUB_DIR")" && pwd)"

if [[ -f "$STUB_DIR/task-tree.config.json" ]]; then
  PROJECT_ROOT="$(node -e "
    const c=require(process.argv[1]);
    const stub=process.argv[2];
    const p=c.projectRoot||'..';
    if(p==='.'||p==='') process.stdout.write(require('path').dirname(stub));
    else if(p.startsWith('/')) process.stdout.write(p);
    else process.stdout.write(require('path').resolve(stub,p));
  " "$STUB_DIR/task-tree.config.json" "$STUB_DIR")"
fi

export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-$(node "$KIT_DIR/scripts/project-port.mjs" "$PROJECT_ROOT")}"
export TASK_TREE_STUB_DIR="$STUB_DIR"
export TASK_TREE_PROJECT_ROOT="$PROJECT_ROOT"

PORT_FILE="$PROJECT_ROOT/.task-tree-port"
echo "$PORT" > "$PORT_FILE"

echo "Task tree: http://${HOST}:${PORT}"
echo "Project:   $PROJECT_ROOT"
echo "Kit:       $KIT_DIR"
echo "Press Ctrl+C to stop."

cd "$KIT_DIR"
exec node server.js
