#!/usr/bin/env bash
set -euo pipefail

ANVIL_PORT="${ANVIL_PORT:-8545}"
RPC_URL="${RPC_URL:-http://127.0.0.1:$ANVIL_PORT}"
ASSET_TOKEN_ADDRESS="${ASSET_TOKEN_ADDRESS:?ASSET_TOKEN_ADDRESS is required}"
VAULT_ADDRESS="${VAULT_ADDRESS:?VAULT_ADDRESS is required}"
WHALE_ADDRESS="${WHALE_ADDRESS:-}"
DEPOSIT_AMOUNT_RAW="${DEPOSIT_AMOUNT_RAW:?DEPOSIT_AMOUNT_RAW is required}"
DEPOSITOR_KEY="${DEPOSITOR_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
DEPOSITOR_ADDRESS="${DEPOSITOR_ADDRESS:-0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266}"
RECEIVER_ADDRESS="${RECEIVER_ADDRESS:-$DEPOSITOR_ADDRESS}"
SELF_WRAP_ETH="${SELF_WRAP_ETH:-false}"

parse_uint() {
  local raw="$1"
  raw="$(printf '%s\n' "$raw" | awk '{print $1}')"
  if [[ "$raw" == 0x* || "$raw" == 0X* ]]; then
    cast to-dec "$raw"
  else
    printf '%s\n' "$raw"
  fi
}

uint_lt() {
  node -e '
    const [left, right] = process.argv.slice(1);
    process.exit(BigInt(left) < BigInt(right) ? 0 : 1);
  ' "$1" "$2"
}

uint_is_zero() {
  node -e '
    const [value] = process.argv.slice(1);
    process.exit(BigInt(value) === 0n ? 0 : 1);
  ' "$1"
}

echo "=== Seeding Fork Vault ==="
echo "RPC:        $RPC_URL"
echo "Asset:      $ASSET_TOKEN_ADDRESS"
echo "Vault:      $VAULT_ADDRESS"
echo "Depositor:  $DEPOSITOR_ADDRESS"
echo "Amount raw: $DEPOSIT_AMOUNT_RAW"
if [[ -n "$WHALE_ADDRESS" ]]; then
  echo "Whale:      $WHALE_ADDRESS"
fi
if [[ "$SELF_WRAP_ETH" == "true" ]]; then
  echo "Mode:       self-wrap ETH into WETH"
fi

if [[ "$(cast code "$ASSET_TOKEN_ADDRESS" --rpc-url "$RPC_URL" 2>/dev/null)" == "0x" ]]; then
  echo "ERROR: asset token contract not found at $ASSET_TOKEN_ADDRESS"
  exit 1
fi

if [[ "$(cast code "$VAULT_ADDRESS" --rpc-url "$RPC_URL" 2>/dev/null)" == "0x" ]]; then
  echo "ERROR: vault contract not found at $VAULT_ADDRESS"
  exit 1
fi

if [[ "$SELF_WRAP_ETH" == "true" ]]; then
  cast send "$ASSET_TOKEN_ADDRESS" "deposit()" --value "$DEPOSIT_AMOUNT_RAW" \
    --rpc-url "$RPC_URL" --private-key "$DEPOSITOR_KEY" > /dev/null
else
  if [[ -z "$WHALE_ADDRESS" ]]; then
    echo "ERROR: WHALE_ADDRESS is required unless SELF_WRAP_ETH=true"
    exit 1
  fi

  whale_balance_raw="$(cast call "$ASSET_TOKEN_ADDRESS" "balanceOf(address)(uint256)" "$WHALE_ADDRESS" --rpc-url "$RPC_URL" 2>/dev/null | xargs)"
  whale_balance_dec="$(parse_uint "$whale_balance_raw")"
  if uint_lt "$whale_balance_dec" "$DEPOSIT_AMOUNT_RAW"; then
    echo "ERROR: whale balance $whale_balance_dec is below requested deposit $DEPOSIT_AMOUNT_RAW"
    exit 1
  fi

  cast rpc anvil_impersonateAccount "$WHALE_ADDRESS" --rpc-url "$RPC_URL" > /dev/null
  cast rpc anvil_setBalance "$WHALE_ADDRESS" "0x56BC75E2D63100000" --rpc-url "$RPC_URL" > /dev/null

  cast send "$ASSET_TOKEN_ADDRESS" "transfer(address,uint256)" "$DEPOSITOR_ADDRESS" "$DEPOSIT_AMOUNT_RAW" \
    --from "$WHALE_ADDRESS" --unlocked --gas-price 0 --priority-gas-price 0 --gas-limit 500000 \
    --rpc-url "$RPC_URL" > /dev/null
  cast rpc anvil_stopImpersonatingAccount "$WHALE_ADDRESS" --rpc-url "$RPC_URL" > /dev/null
fi

cast send "$ASSET_TOKEN_ADDRESS" "approve(address,uint256)" "$VAULT_ADDRESS" "$DEPOSIT_AMOUNT_RAW" \
  --rpc-url "$RPC_URL" --private-key "$DEPOSITOR_KEY" > /dev/null
cast send "$VAULT_ADDRESS" "deposit(uint256,address)" "$DEPOSIT_AMOUNT_RAW" "$RECEIVER_ADDRESS" \
  --rpc-url "$RPC_URL" --private-key "$DEPOSITOR_KEY" > /dev/null

vault_assets_raw="$(cast call "$VAULT_ADDRESS" "totalAssets()(uint256)" --rpc-url "$RPC_URL" 2>/dev/null | xargs)"
vault_assets_dec="$(parse_uint "$vault_assets_raw")"
if uint_is_zero "$vault_assets_dec"; then
  echo "ERROR: vault totalAssets is still zero after deposit"
  exit 1
fi

echo "Vault seeded successfully."
echo "  totalAssets: $vault_assets_dec"
