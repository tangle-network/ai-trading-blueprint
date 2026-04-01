#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
STATE_ROOT="${STATE_ROOT:-$ROOT_DIR/blueprint-state}"

echo "Resetting local blueprint state under $STATE_ROOT"

for dir in "$STATE_ROOT/cloud" "$STATE_ROOT/instance" "$STATE_ROOT/tee"; do
  rm -rf "$dir"
  mkdir -p "$dir"
  echo "  cleared $dir"
done

echo "Local blueprint state reset complete."
