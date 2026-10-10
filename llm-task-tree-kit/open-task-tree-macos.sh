#!/usr/bin/env bash
set -euo pipefail

# macOS entry point for the standalone IDE. The POSIX installer also works on macOS,
# but this launcher adds the Finder-friendly behavior users expect: start/reuse the
# local server, then open the project URL with the default browser.
KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STUB_INPUT="${1:-${TASK_TREE_STUB_DIR:-$(dirname "$KIT_DIR")/llm-task-tree}}"
STUB_DIR="$(cd "$STUB_INPUT" && pwd)"

if [[ ! -f "$STUB_DIR/task-tree.config.json" ]]; then
  echo "Missing task-tree.config.json: $STUB_DIR" >&2
  exit 1
fi

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
# The standalone macOS bundle ships its own Node runtime.  A clean Finder
# launch has no shell profile, so PATH may not contain node even though the
# runtime is installed and ready to use.
if [[ -z "$NODE_BIN" && -x "$KIT_DIR/../macos/IDE/runtime/current/bin/node" ]]; then
  NODE_BIN="$KIT_DIR/../macos/IDE/runtime/current/bin/node"
fi
if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js 20.11+ is required. Install it, then rerun this launcher." >&2
  exit 1
fi

PROJECT_ROOT="$("$NODE_BIN" --input-type=module - "$STUB_DIR/task-tree.config.json" "$STUB_DIR" <<'NODE'
import { readFile } from "node:fs/promises";
import path from "node:path";
const [configFile, stubDir] = process.argv.slice(2);
const config = JSON.parse(await readFile(configFile, "utf8"));
const raw = String(config.projectRoot || "..");
process.stdout.write(path.resolve(stubDir, raw));
NODE
)"
MARKER_PORT=""
if [[ -f "$PROJECT_ROOT/.task-tree-port" ]]; then
  MARKER_PORT="$(tr -dc '0-9' <"$PROJECT_ROOT/.task-tree-port")"
fi
PORT="${PORT:-${MARKER_PORT:-$("$NODE_BIN" "$KIT_DIR/scripts/project-port.mjs" "$PROJECT_ROOT")}}"
HOST="${HOST:-127.0.0.1}"
URL="http://${HOST}:${PORT}"
LOG_FILE="$PROJECT_ROOT/.task-tree-server.log"
PID_FILE="$PROJECT_ROOT/.task-tree-server.pid"

is_project_server() {
  "$NODE_BIN" --input-type=module - "$URL/api/project" "$PROJECT_ROOT" <<'NODE'
import { realpathSync } from "node:fs";
const [url, expected] = process.argv.slice(2);
try {
  const response = await fetch(url, { signal: AbortSignal.timeout(800) });
  const actual = (await response.json()).root;
  const physical = (value) => { try { return realpathSync.native(value); } catch { return value; } };
  process.exit(response.ok && physical(actual) === physical(expected) ? 0 : 1);
} catch { process.exit(1); }
NODE
}

if ! is_project_server; then
  # A stale marker must not force us onto an occupied port. Recompute the preferred stable port;
  # project-port.mjs falls back to an ephemeral port only when another process owns it.
  if [[ -n "$MARKER_PORT" ]]; then
    PORT="$("$NODE_BIN" "$KIT_DIR/scripts/project-port.mjs" "$PROJECT_ROOT")"
    URL="http://${HOST}:${PORT}"
  fi
  GLOBAL_ENV_FILE="${TASK_TREE_GLOBAL_ENV_FILE:-$KIT_DIR/../../.env}"
  export HOST PORT TASK_TREE_STUB_DIR="$STUB_DIR" TASK_TREE_PROJECT_ROOT="$PROJECT_ROOT" TASK_TREE_GLOBAL_ENV_FILE="$GLOBAL_ENV_FILE"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    "$NODE_BIN" "$KIT_DIR/scripts/project-service-macos.mjs" start "$STUB_DIR" "$PROJECT_ROOT" "$PORT" "$HOST" "$GLOBAL_ENV_FILE"
  else
    "$NODE_BIN" --input-type=module - "$KIT_DIR/server.js" "$LOG_FILE" "$PID_FILE" <<'NODE'
import { spawn } from "node:child_process";
import { openSync, closeSync, writeFileSync } from "node:fs";
const [entry, logFile, pidFile] = process.argv.slice(2);
const log = openSync(logFile, "a");
const child = spawn(process.execPath, [entry], {
  detached: true,
  stdio: ["ignore", log, log],
  env: process.env
});
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
writeFileSync(pidFile, `${child.pid}\n`);
child.unref();
closeSync(log);
NODE
  fi
  for _ in $(seq 1 80); do
    if is_project_server; then break; fi
    sleep 0.25
  done
fi

if ! is_project_server; then
  echo "Task tree server did not start on $URL. See $LOG_FILE" >&2
  exit 1
fi

echo "$PORT" >"$PROJECT_ROOT/.task-tree-port"
echo "Task tree: $URL"
if [[ "${1:-}" != "--no-open" && "${TASK_TREE_NO_OPEN:-0}" != "1" ]]; then
  OPEN_CMD="${TASK_TREE_OPEN_CMD:-open}"
  "$OPEN_CMD" "$URL"
fi
