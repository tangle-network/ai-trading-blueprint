#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RPC_URL="${HYPEREVM_GAS_RPC_URL:-${RPC_URL:-https://rpc.hyperliquid-testnet.xyz/evm}}"
CHAIN_ID="${CHAIN_ID:-998}"
DEPLOY_TX_GAS_LIMIT="${HYPEREVM_DEPLOY_TX_GAS_LIMIT:-3000000}"
SAFE_DEPLOY_TX_GAS_LIMIT="${HYPEREVM_SAFE_DEPLOY_TX_GAS_LIMIT:-2950000}"

cd "$ROOT_DIR/contracts"

forge test --match-contract HyperliquidVaultStackGasTest

actual_chain_id="$(cast chain-id --rpc-url "$RPC_URL")"
if [[ "$actual_chain_id" != "$CHAIN_ID" ]]; then
  echo "ERROR: RPC $RPC_URL is chain $actual_chain_id, expected $CHAIN_ID" >&2
  exit 1
fi

creation_code="$(jq -r '.bytecode.object' out/HyperliquidVault.sol/HyperliquidVault.json)"
estimate="$(cast estimate --rpc-url "$RPC_URL" --create "$creation_code")"

echo "HyperliquidVault implementation creation estimate on chain $actual_chain_id: $estimate gas"
echo "Hard limit: $DEPLOY_TX_GAS_LIMIT gas; regression gate: $SAFE_DEPLOY_TX_GAS_LIMIT gas"

if (( estimate >= DEPLOY_TX_GAS_LIMIT )); then
  echo "ERROR: HyperliquidVault implementation creation estimate exceeds chain limit" >&2
  exit 1
fi

if (( estimate >= SAFE_DEPLOY_TX_GAS_LIMIT )); then
  echo "ERROR: HyperliquidVault implementation creation estimate has insufficient margin" >&2
  exit 1
fi
