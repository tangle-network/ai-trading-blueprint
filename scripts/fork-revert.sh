#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ANVIL_PORT="${ANVIL_PORT:-8545}"
RPC_URL="${RPC_URL:-http://127.0.0.1:$ANVIL_PORT}"
SNAPSHOT_FILE="${SNAPSHOT_FILE:-$SCRIPT_DIR/data/fork.snapshot}"
SNAPSHOT_ID="${SNAPSHOT_ID:-}"
TAKE_NEW_SNAPSHOT="${TAKE_NEW_SNAPSHOT:-true}"

if [[ -z "$SNAPSHOT_ID" ]]; then
  if [[ ! -f "$SNAPSHOT_FILE" ]]; then
    echo "ERROR: snapshot id not provided and $SNAPSHOT_FILE does not exist"
    exit 1
  fi
  SNAPSHOT_ID="$(tr -d '\n' < "$SNAPSHOT_FILE")"
fi

revert_result="$(cast rpc anvil_revert "$SNAPSHOT_ID" --rpc-url "$RPC_URL" | tr -d '"')"
if [[ "$revert_result" != "true" ]]; then
  echo "ERROR: failed to revert chain state to snapshot $SNAPSHOT_ID"
  exit 1
fi
echo "Reverted chain state to snapshot $SNAPSHOT_ID"

if [[ "$TAKE_NEW_SNAPSHOT" == "true" ]]; then
  new_snapshot_id="$(cast rpc anvil_snapshot --rpc-url "$RPC_URL" | tr -d '"')"
  if [[ "$new_snapshot_id" == "0x0" ]]; then
    new_snapshot_id="$(cast rpc anvil_snapshot --rpc-url "$RPC_URL" | tr -d '"')"
  fi
  printf '%s\n' "$new_snapshot_id" > "$SNAPSHOT_FILE"
  echo "Saved replacement snapshot $new_snapshot_id to $SNAPSHOT_FILE"
fi
