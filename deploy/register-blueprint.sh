#!/usr/bin/env bash
# Register the AI Trading blueprints (Cloud / Instance / TEE / Validator) on a
# deployed Tangle protocol. Unlike `scripts/deploy-local.sh`, this wrapper
# targets *external* networks (Base Sepolia today, mainnet eventually) and
# does NOT perform anvil-impersonation lifecycle steps — those are not
# applicable on a live chain.
#
# Required environment:
#   PRIVATE_KEY   — deployer key (0x… hex). MUST be funded on the target chain.
#   RPC_URL       — RPC endpoint. Defaults to https://sepolia.base.org.
#   TANGLE_CORE   — Tangle proxy address on the target chain.
#                   On Base Sepolia: loaded from manifest if omitted.
#
# Optional environment:
#   TARGET_NETWORK — override block.chainid detection. Values:
#                    "local" | "base-sepolia" | "mainnet"
#   RESTAKING      — exposed for parity with future scripts; unused by
#                    RegisterBlueprint.s.sol today.
#   BROADCAST      — set to "true" to actually send transactions.
#                    Default: dry-run (forge --simulate only).
#
# Usage:
#   export PRIVATE_KEY=0x...
#   export RPC_URL=https://sepolia.base.org
#   export TANGLE_CORE=0x0fb3874f4d416ede0791cf083d5258631fad0c98
#   ./deploy/register-blueprint.sh
#
# Add `BROADCAST=true` to broadcast — leave unset for a dry-run that just
# proves the call frame encodes correctly.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

: "${PRIVATE_KEY:?ERROR: PRIVATE_KEY must be set (0x… hex)}"

RPC_URL="${RPC_URL:-https://sepolia.base.org}"

# Auto-load Base Sepolia manifest if available + TANGLE_CORE unset.
if [[ -z "${TANGLE_CORE:-}" ]]; then
  if [[ -f "$ROOT_DIR/scripts/load-base-sepolia-env.sh" ]]; then
    # shellcheck disable=SC1091
    source "$ROOT_DIR/scripts/load-base-sepolia-env.sh" >/dev/null 2>&1 || true
    if [[ -n "${TANGLE_CONTRACT:-}" ]]; then
      TANGLE_CORE="$TANGLE_CONTRACT"
    fi
  fi
fi
: "${TANGLE_CORE:?ERROR: TANGLE_CORE must be set (or place a base-sepolia manifest at deploy/manifests/base-sepolia/tnt-core.latest.json)}"

# Detect chain id via RPC for diagnostics + sanity check.
CHAIN_ID_HEX="$(cast chain-id --rpc-url "$RPC_URL" 2>/dev/null || true)"
TARGET_NETWORK="${TARGET_NETWORK:-}"

echo "=== AI Trading Blueprint Registration ==="
echo "  RPC URL:        $RPC_URL"
echo "  Chain ID:       ${CHAIN_ID_HEX:-<unknown>}"
echo "  TANGLE_CORE:    $TANGLE_CORE"
echo "  TARGET_NETWORK: ${TARGET_NETWORK:-<auto>}"
echo "  Broadcast:      ${BROADCAST:-false (dry-run)}"
echo ""

FORGE_FLAGS=(
  --rpc-url "$RPC_URL"
  --skip-simulation
  --disable-code-size-limit
)

if [[ "${BROADCAST:-false}" == "true" ]]; then
  FORGE_FLAGS+=(--broadcast --slow)
else
  echo "NOTE: dry-run mode — pass BROADCAST=true to broadcast." >&2
fi

# Pass-through env. RegisterBlueprint.s.sol reads:
#   PRIVATE_KEY             — deployer key. vm.startBroadcast(deployerKey) honors this
#                             so every tx is signed by the funded address. Anvil
#                             account 0 is used only as a fallback for local flows.
#   TANGLE_CORE             — Tangle proxy address (required)
#   TARGET_NETWORK          — optional override for chain-id detection
#   EXISTING_USDC_ADDRESS   — pin specific stable for the local mock flow
#   EXISTING_WETH_ADDRESS   — pin specific weth for the local mock flow
PRIVATE_KEY="$PRIVATE_KEY" \
TANGLE_CORE="$TANGLE_CORE" \
TARGET_NETWORK="$TARGET_NETWORK" \
EXISTING_USDC_ADDRESS="${EXISTING_USDC_ADDRESS:-}" \
EXISTING_WETH_ADDRESS="${EXISTING_WETH_ADDRESS:-}" \
  forge script contracts/script/RegisterBlueprint.s.sol \
    --private-key "$PRIVATE_KEY" \
    "${FORGE_FLAGS[@]}"
