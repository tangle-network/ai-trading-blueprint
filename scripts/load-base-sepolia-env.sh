#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

MANIFEST_PATH="${1:-${TNT_CORE_DEPLOYMENT_MANIFEST:-$ROOT_DIR/../tnt-core/deployments/base-sepolia/latest.json}}"

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required to load Base Sepolia deployment settings" >&2
  exit 1
fi

if [[ ! -f "$MANIFEST_PATH" ]]; then
  echo "ERROR: deployment manifest not found: $MANIFEST_PATH" >&2
  exit 1
fi

NETWORK="$(jq -r '.network // empty' "$MANIFEST_PATH")"
CHAIN_ID_FROM_MANIFEST="$(jq -r '.chainId // empty' "$MANIFEST_PATH")"
TANGLE_FROM_MANIFEST="$(jq -r '.tangle // empty' "$MANIFEST_PATH")"
STAKING_FROM_MANIFEST="$(jq -r '(.staking // .restaking) // empty' "$MANIFEST_PATH")"
STATUS_REGISTRY_FROM_MANIFEST="$(jq -r '.statusRegistry // empty' "$MANIFEST_PATH")"

if [[ "$NETWORK" != "base-sepolia" ]]; then
  echo "ERROR: expected base-sepolia manifest, found: ${NETWORK:-<missing>}" >&2
  exit 1
fi

if [[ -z "$TANGLE_FROM_MANIFEST" || -z "$STAKING_FROM_MANIFEST" || -z "$STATUS_REGISTRY_FROM_MANIFEST" ]]; then
  echo "ERROR: manifest is missing one or more required protocol addresses" >&2
  exit 1
fi

export CHAIN_ID="${CHAIN_ID:-${CHAIN_ID_FROM_MANIFEST:-84532}}"
export HTTP_RPC_URL="${HTTP_RPC_URL:-https://sepolia.base.org}"
export RPC_URL="${RPC_URL:-$HTTP_RPC_URL}"
export WS_RPC_URL="${WS_RPC_URL:-wss://base-sepolia-rpc.publicnode.com}"

export TANGLE_CONTRACT="${TANGLE_CONTRACT:-$TANGLE_FROM_MANIFEST}"
export STAKING_CONTRACT="${STAKING_CONTRACT:-${RESTAKING_CONTRACT:-$STAKING_FROM_MANIFEST}}"
export RESTAKING_CONTRACT="${RESTAKING_CONTRACT:-$STAKING_CONTRACT}"
export STATUS_REGISTRY_CONTRACT="${STATUS_REGISTRY_CONTRACT:-$STATUS_REGISTRY_FROM_MANIFEST}"

# QoS paths in the operator and validator binaries currently read STATUS_REGISTRY_ADDRESS.
export STATUS_REGISTRY_ADDRESS="${STATUS_REGISTRY_ADDRESS:-$STATUS_REGISTRY_CONTRACT}"

echo "Loaded Base Sepolia protocol settings from $MANIFEST_PATH" >&2
echo "  HTTP RPC: $HTTP_RPC_URL" >&2
echo "  WS RPC:   $WS_RPC_URL" >&2
echo "  Tangle:   $TANGLE_CONTRACT" >&2
echo "  Staking:  $STAKING_CONTRACT" >&2
echo "  Status:   $STATUS_REGISTRY_CONTRACT" >&2
