#!/usr/bin/env bash
set -euo pipefail

IDE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="$IDE_DIR/runtime"
CURRENT="$RUNTIME_DIR/current"

if [[ -x "$CURRENT/bin/node" ]]; then
  echo ">> Private Node runtime already installed: $($CURRENT/bin/node --version)"
  exit 0
fi

case "$(uname -m)" in
  arm64) NODE_ARCH="arm64" ;;
  x86_64) NODE_ARCH="x64" ;;
  *) echo "Unsupported macOS architecture: $(uname -m)" >&2; exit 1 ;;
esac

mkdir -p "$RUNTIME_DIR"
WORK_DIR="$(mktemp -d "$RUNTIME_DIR/.install.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

echo ">> Resolving the latest Node.js 22 LTS runtime for darwin-$NODE_ARCH"
curl --fail --location --silent --show-error --retry 3 --connect-timeout 15 \
  --output "$WORK_DIR/SHASUMS256.txt" \
  "https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt"
ARCHIVE="$(awk -v suffix="darwin-$NODE_ARCH.tar.gz" '$2 ~ suffix"$" { print $2; exit }' "$WORK_DIR/SHASUMS256.txt")"
EXPECTED="$(awk -v file="$ARCHIVE" '$2 == file { print $1; exit }' "$WORK_DIR/SHASUMS256.txt")"
if [[ -z "$ARCHIVE" || -z "$EXPECTED" ]]; then
  echo "Could not resolve the Node.js archive checksum." >&2
  exit 1
fi

VERSION="${ARCHIVE#node-}"
VERSION="${VERSION%%-darwin-*}"
if ! curl --fail --location --silent --show-error --retry 1 --connect-timeout 15 --speed-limit 1024 --speed-time 20 \
  --output "$WORK_DIR/$ARCHIVE" \
  "https://nodejs.org/dist/latest-v22.x/$ARCHIVE"; then
  echo ">> nodejs.org binary download was unavailable; using the npmmirror CDN"
  curl --fail --location --silent --show-error --retry 3 --connect-timeout 15 \
    --output "$WORK_DIR/$ARCHIVE" \
    "https://npmmirror.com/mirrors/node/$VERSION/$ARCHIVE"
fi
ACTUAL="$(shasum -a 256 "$WORK_DIR/$ARCHIVE" | awk '{print $1}')"
if [[ "$ACTUAL" != "$EXPECTED" ]]; then
  echo "Node.js archive checksum mismatch." >&2
  exit 1
fi

tar -xzf "$WORK_DIR/$ARCHIVE" -C "$WORK_DIR"
EXTRACTED="$WORK_DIR/${ARCHIVE%.tar.gz}"
mv "$EXTRACTED" "$RUNTIME_DIR/${ARCHIVE%.tar.gz}"
ln -sfn "$RUNTIME_DIR/${ARCHIVE%.tar.gz}" "$CURRENT"
echo ">> Installed private Node runtime: $($CURRENT/bin/node --version)"
