#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
STATE_ROOT="${STATE_ROOT:-$ROOT_DIR/blueprint-state}"
RUNTIME_DIR="${RUNTIME_DIR:-$ROOT_DIR/.tmp/base-sepolia-run}"

kill_port_listener() {
  local port="$1"
  local pids=""
  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  fi
  if [[ -n "$pids" ]]; then
    echo "$pids" | xargs -r kill 2>/dev/null || true
  fi
}

echo "Resetting local blueprint state under $STATE_ROOT"

kill_port_listener 9200
kill_port_listener 9100
kill_port_listener 50051

pkill -f 'cargo-tangle blueprint run' 2>/dev/null || true
pkill -f '/target/debug/trading-blueprint run' 2>/dev/null || true
pkill -f 'pricing-engine-server' 2>/dev/null || true

if command -v docker >/dev/null 2>&1; then
  docker ps --format '{{.Names}}' | rg '^sidecar-sandbox-' | xargs -r docker rm -f >/dev/null 2>&1 || true
fi

find "$STATE_ROOT" -maxdepth 1 -type f -name '*.json' -print0 | while IFS= read -r -d '' file; do
  rm -f "$file"
  echo "  cleared $file"
done

for dir in "$STATE_ROOT/cloud" "$STATE_ROOT/instance" "$STATE_ROOT/tee" "$STATE_ROOT/validator"; do
  rm -rf "$dir"
  mkdir -p "$dir"
  echo "  cleared $dir"
done

rm -rf "$RUNTIME_DIR"
mkdir -p "$RUNTIME_DIR"
echo "  cleared $RUNTIME_DIR"

for dir in "$ROOT_DIR"/scripts/data/operator*/pricing-engine; do
  [[ -e "$dir" ]] || continue
  rm -rf "$dir"
  mkdir -p "$dir"
  echo "  cleared $dir"
done

echo "Local blueprint state reset complete."
