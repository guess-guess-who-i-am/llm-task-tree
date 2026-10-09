#!/usr/bin/env bash
set -euo pipefail
LAUNCHER_SOURCE="${BASH_SOURCE[0]}"
while [[ -L "$LAUNCHER_SOURCE" ]]; do
  LAUNCHER_DIR="$(cd "$(dirname "$LAUNCHER_SOURCE")" && pwd)"
  LAUNCHER_SOURCE="$(readlink "$LAUNCHER_SOURCE")"
  [[ "$LAUNCHER_SOURCE" = /* ]] || LAUNCHER_SOURCE="$LAUNCHER_DIR/$LAUNCHER_SOURCE"
done
exec "$(cd "$(dirname "$LAUNCHER_SOURCE")" && pwd)/open.command" "$@"
