#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ANVIL_PORT="${ANVIL_PORT:-8545}"
RPC_URL="${RPC_URL:-http://127.0.0.1:$ANVIL_PORT}"
SNAPSHOT_FILE="${SNAPSHOT_FILE:-$SCRIPT_DIR/data/fork.snapshot}"

mkdir -p "$(dirname "$SNAPSHOT_FILE")"
snapshot_id="$(cast rpc anvil_snapshot --rpc-url "$RPC_URL" | tr -d '"')"
if [[ "$snapshot_id" == "0x0" ]]; then
  snapshot_id="$(cast rpc anvil_snapshot --rpc-url "$RPC_URL" | tr -d '"')"
fi
printf '%s\n' "$snapshot_id" > "$SNAPSHOT_FILE"

echo "Saved fork snapshot $snapshot_id to $SNAPSHOT_FILE"
