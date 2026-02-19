#!/usr/bin/env bash
# Deploy the Trading Arena contracts to a local Anvil with Tangle protocol pre-loaded,
# using the proper Blueprint lifecycle:
#
#   1. Deploy contracts + register blueprint on Tangle (forge script)
#   2. Wire VaultFactory to BSM (Anvil impersonation)
#   3. Register operators for the new blueprint
#   4. Request service + operators approve → service activated (no vault yet)
#   5. Grant OPERATOR_ROLE via onOperatorJoined (Anvil impersonation)
#   6. Write .env.local (vaults created per-bot when provision jobs complete)
#
# Prerequisites:
#   anvil --load-state /path/to/blueprint/crates/chain-setup/anvil/snapshots/localtestnet-state.json
#
# Usage: ./scripts/deploy-local.sh
set -euo pipefail

RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
DEPLOYER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
DEPLOYER_ADDR="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
OPERATOR1_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
OPERATOR1_ADDR="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
OPERATOR2_KEY="0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"
OPERATOR2_ADDR="0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
USER_ACCOUNT="0x68FF20459d48917748CA13afCbDA3B265a449D48"
USER_ACCOUNT_2="0xd04E36A1C370c6115e1C676838AcD0b430d740F3"

# Tangle protocol addresses (deterministic from state snapshot)
TANGLE="0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9"
RESTAKING="0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"

# Operator API ports (serves pricing, bot management, etc.)
OPERATOR1_RPC="http://localhost:9200"
OPERATOR2_RPC="http://localhost:9201"

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== Trading Arena — Local Deployment (Blueprint Lifecycle) ==="
echo "RPC: $RPC_URL"
echo "Tangle: $TANGLE"
echo ""

# ── [0/10] Deploy Multicall3 (required by viem) ──────────────────
echo "[0/10] Deploying Multicall3..."
MULTICALL3_ADDR="0xcA11bde05977b3631167028862bE2a173976CA11"
if [[ "$(cast code $MULTICALL3_ADDR --rpc-url "$RPC_URL" 2>/dev/null)" == "0x" ]]; then
  MC3=$(forge create contracts/test/helpers/Multicall3.sol:Multicall3 \
    --broadcast --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" 2>&1 | grep "Deployed to:" | awk '{print $3}')
  MC3_CODE=$(cast code "$MC3" --rpc-url "$RPC_URL")
  cast rpc anvil_setCode "$MULTICALL3_ADDR" "$MC3_CODE" --rpc-url "$RPC_URL" > /dev/null 2>&1
  echo "  Multicall3: $MULTICALL3_ADDR (deployed)"
else
  echo "  Multicall3: $MULTICALL3_ADDR (already exists)"
fi

# ── [1/10] Deploy contracts + create blueprint (forge script) ────
echo "[1/10] Deploying contracts + registering blueprint..."
FORGE_OUTPUT=$(forge script contracts/script/RegisterBlueprint.s.sol \
  --rpc-url "$RPC_URL" --broadcast --slow 2>&1)

# Parse addresses from forge output
parse_deploy() {
  echo "$FORGE_OUTPUT" | grep "DEPLOY_${1}=" | sed "s/.*DEPLOY_${1}=//" | tr -d ' '
}

BSM=$(parse_deploy BSM)
VAULT_FACTORY=$(parse_deploy VAULT_FACTORY)
USDC=$(parse_deploy USDC)
WETH=$(parse_deploy WETH)
BLUEPRINT_ID=$(parse_deploy BLUEPRINT_ID)

if [[ -z "$BSM" || -z "$VAULT_FACTORY" || -z "$USDC" || -z "$BLUEPRINT_ID" ]]; then
  echo "ERROR: Failed to parse addresses from forge script output."
  echo "Forge output:"
  echo "$FORGE_OUTPUT" | tail -30
  exit 1
fi

echo "  BSM:          $BSM"
echo "  VaultFactory: $VAULT_FACTORY"
echo "  USDC:         $USDC"
echo "  WETH:         $WETH"
echo "  Blueprint ID: $BLUEPRINT_ID"

# Fund user accounts
echo "  Funding user accounts..."
for acct in "$USER_ACCOUNT" "$USER_ACCOUNT_2"; do
  cast send "$acct" --value 100ether --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" > /dev/null 2>&1
  cast send "$USDC" "mint(address,uint256)" "$acct" 1000000000000 \
    --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" > /dev/null 2>&1
  cast send "$WETH" "mint(address,uint256)" "$acct" 100000000000000000000 \
    --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" > /dev/null 2>&1
  echo "    $acct (100 ETH, 1M USDC, 100 WETH)"
done

# Fund extra accounts (if provided)
if [[ -n "${EXTRA_ACCOUNTS:-}" ]]; then
  echo "  Funding extra accounts..."
  for acct in $EXTRA_ACCOUNTS; do
    cast send "$acct" --value 100ether --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" > /dev/null 2>&1
    cast send "$USDC" "mint(address,uint256)" "$acct" 1000000000000 \
      --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" > /dev/null 2>&1
    cast send "$WETH" "mint(address,uint256)" "$acct" 100000000000000000000 \
      --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" > /dev/null 2>&1
    echo "  Extra: $acct (100 ETH, 1M USDC, 100 WETH)"
  done
fi

# ── [2/10] Wire VaultFactory to BSM (Tangle impersonation) ───────
echo "[2/10] Wiring VaultFactory to BSM..."
# setVaultFactory() has onlyFromTangle modifier — msg.sender must be Tangle contract
cast rpc anvil_impersonateAccount "$TANGLE" --rpc-url "$RPC_URL" > /dev/null 2>&1
# Fund Tangle contract for gas
cast rpc anvil_setBalance "$TANGLE" "0x56BC75E2D63100000" --rpc-url "$RPC_URL" > /dev/null 2>&1
cast send "$BSM" "setVaultFactory(address)" "$VAULT_FACTORY" \
  --from "$TANGLE" --unlocked --gas-price 0 --priority-gas-price 0 --gas-limit 500000 \
  --rpc-url "$RPC_URL" > /dev/null 2>&1
cast rpc anvil_stopImpersonatingAccount "$TANGLE" --rpc-url "$RPC_URL" > /dev/null 2>&1

# Verify
FACTORY_CHECK=$(cast call "$BSM" "vaultFactory()(address)" --rpc-url "$RPC_URL" 2>&1 | xargs)
echo "  BSM.vaultFactory = $FACTORY_CHECK"

# ── [3/10] Register operators for the new blueprint ──────────────
echo "[3/10] Registering operators..."

# Derive uncompressed ECDSA public keys using viem
derive_pubkey() {
  local privkey="$1"
  cd "$ROOT_DIR/arena" && node -e "
    const { privateKeyToAccount } = require('viem/accounts');
    const a = privateKeyToAccount('$privkey');
    process.stdout.write(a.publicKey);
  "
}

OPERATOR1_PUBKEY=$(derive_pubkey "$OPERATOR1_KEY")
OPERATOR2_PUBKEY=$(derive_pubkey "$OPERATOR2_KEY")

# Register operator 1
if ! cast send "$TANGLE" \
  "registerOperator(uint64,bytes,string)" \
  "$BLUEPRINT_ID" "$OPERATOR1_PUBKEY" "$OPERATOR1_RPC" \
  --gas-price 0 --priority-gas-price 0 --gas-limit 500000 \
  --rpc-url "$RPC_URL" --private-key "$OPERATOR1_KEY" > /dev/null 2>&1; then
  echo "  Operator 1 already registered, updating RPC address..."
  cast send "$TANGLE" \
    "updateOperatorPreferences(uint64,bytes,string)" \
    "$BLUEPRINT_ID" 0x "$OPERATOR1_RPC" \
    --gas-price 0 --priority-gas-price 0 --gas-limit 500000 \
    --rpc-url "$RPC_URL" --private-key "$OPERATOR1_KEY" > /dev/null 2>&1
fi
echo "  Operator 1: $OPERATOR1_ADDR → $OPERATOR1_RPC"

# Register operator 2
if ! cast send "$TANGLE" \
  "registerOperator(uint64,bytes,string)" \
  "$BLUEPRINT_ID" "$OPERATOR2_PUBKEY" "$OPERATOR2_RPC" \
  --gas-price 0 --priority-gas-price 0 --gas-limit 500000 \
  --rpc-url "$RPC_URL" --private-key "$OPERATOR2_KEY" > /dev/null 2>&1; then
  echo "  Operator 2 already registered, updating RPC address..."
  cast send "$TANGLE" \
    "updateOperatorPreferences(uint64,bytes,string)" \
    "$BLUEPRINT_ID" 0x "$OPERATOR2_RPC" \
    --gas-price 0 --priority-gas-price 0 --gas-limit 500000 \
    --rpc-url "$RPC_URL" --private-key "$OPERATOR2_KEY" > /dev/null 2>&1
fi
echo "  Operator 2: $OPERATOR2_ADDR → $OPERATOR2_RPC"

# ── [4/10] Request service with vault config ─────────────────────
echo "[4/10] Requesting service..."

# Get the next request ID before submitting
REQUEST_ID=$(cast call "$TANGLE" "serviceRequestCount()(uint64)" --rpc-url "$RPC_URL" 2>&1 | xargs)
# Strip leading zeros / hex prefix if needed
REQUEST_ID=$(echo "$REQUEST_ID" | sed 's/^0x//' | sed 's/^0*//' | sed 's/^$/0/')

# ABI-encode the vault config for TradingBlueprint.onRequest():
# (address assetToken, address[] signers, uint256 requiredSigs, string name, string symbol)
CONFIG=$(cast abi-encode "f(address,address[],uint256,string,string)" \
  "$USDC" "[$DEPLOYER_ADDR]" 1 "Arena Vault Shares" "avSHARE")

# Build permitted callers list
PERMITTED_CALLERS="[$USER_ACCOUNT,$USER_ACCOUNT_2,$DEPLOYER_ADDR"
if [[ -n "${EXTRA_ACCOUNTS:-}" ]]; then
  for acct in $EXTRA_ACCOUNTS; do
    PERMITTED_CALLERS="$PERMITTED_CALLERS,$acct"
  done
fi
PERMITTED_CALLERS="$PERMITTED_CALLERS]"

cast send "$TANGLE" \
  "requestService(uint64,address[],bytes,address[],uint64,address,uint256)" \
  "$BLUEPRINT_ID" \
  "[$OPERATOR1_ADDR,$OPERATOR2_ADDR]" \
  "$CONFIG" \
  "$PERMITTED_CALLERS" \
  31536000 \
  "0x0000000000000000000000000000000000000000" \
  0 \
  --gas-price 0 --priority-gas-price 0 --gas-limit 3000000 \
  --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" > /dev/null 2>&1
echo "  Service request $REQUEST_ID submitted"

# ── [5/10] Approve service (both operators) ──────────────────────
echo "[5/10] Operators approving service..."

cast send "$TANGLE" "approveService(uint64,uint8)" "$REQUEST_ID" 100 \
  --gas-price 0 --priority-gas-price 0 --gas-limit 10000000 \
  --rpc-url "$RPC_URL" --private-key "$OPERATOR1_KEY" > /dev/null 2>&1
echo "  Operator 1 approved"

cast send "$TANGLE" "approveService(uint64,uint8)" "$REQUEST_ID" 100 \
  --gas-price 0 --priority-gas-price 0 --gas-limit 10000000 \
  --rpc-url "$RPC_URL" --private-key "$OPERATOR2_KEY" > /dev/null 2>&1
echo "  Operator 2 approved → service activated (per-bot vaults deploy on provision)"

# ── [6/10] Grant OPERATOR_ROLE via onOperatorJoined ──────────────
echo "[6/10] Granting OPERATOR_ROLE to operators..."

# Read the service ID (last created)
SERVICE_COUNT=$(cast call "$TANGLE" "serviceCount()(uint64)" --rpc-url "$RPC_URL" 2>&1 | xargs)
SERVICE_COUNT=$(echo "$SERVICE_COUNT" | sed 's/^0x//' | sed 's/^0*//' | sed 's/^$/0/')
SERVICE_ID=$((SERVICE_COUNT - 1))

# onOperatorJoined is NOT auto-called during Fixed membership activation.
# We impersonate Tangle to trigger it, which grants OPERATOR_ROLE on the vault.
cast rpc anvil_impersonateAccount "$TANGLE" --rpc-url "$RPC_URL" > /dev/null 2>&1
cast send "$BSM" "onOperatorJoined(uint64,address,uint16)" \
  "$SERVICE_ID" "$OPERATOR1_ADDR" 10000 \
  --from "$TANGLE" --unlocked --gas-price 0 --priority-gas-price 0 --gas-limit 500000 \
  --rpc-url "$RPC_URL" > /dev/null 2>&1
cast send "$BSM" "onOperatorJoined(uint64,address,uint16)" \
  "$SERVICE_ID" "$OPERATOR2_ADDR" 10000 \
  --from "$TANGLE" --unlocked --gas-price 0 --priority-gas-price 0 --gas-limit 500000 \
  --rpc-url "$RPC_URL" > /dev/null 2>&1
cast rpc anvil_stopImpersonatingAccount "$TANGLE" --rpc-url "$RPC_URL" > /dev/null 2>&1
echo "  OPERATOR_ROLE granted to both operators"

# ── [7/10] Verify service state ───────────────────────────────────
echo "[7/10] Verifying service state..."
PROVISIONED=$(cast call "$BSM" "instanceProvisioned(uint64)(bool)" "$SERVICE_ID" --rpc-url "$RPC_URL" 2>&1 | xargs)
echo "  Service ID:    $SERVICE_ID"
echo "  Provisioned:   $PROVISIONED"
echo "  Note: Per-bot vaults are created when provision jobs complete (not at service init)"

# ── [8/9] Setup pricing engine keystores ─────────────────────────
echo "[8/9] Setting up pricing engine keystores..."
CARGO_TANGLE="${CARGO_TANGLE_BIN:-$(command -v cargo-tangle 2>/dev/null || echo "$ROOT_DIR/../blueprint/target/release/cargo-tangle")}"
SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$SCRIPTS_DIR/data/operator1/keystore" "$SCRIPTS_DIR/data/operator2/keystore"

if [[ -x "$CARGO_TANGLE" ]]; then
  "$CARGO_TANGLE" tangle key import --key-type ecdsa \
    --secret "${OPERATOR1_KEY#0x}" \
    --keystore-path "$SCRIPTS_DIR/data/operator1/keystore" 2>/dev/null || true
  "$CARGO_TANGLE" tangle key import --key-type ecdsa \
    --secret "${OPERATOR2_KEY#0x}" \
    --keystore-path "$SCRIPTS_DIR/data/operator2/keystore" 2>/dev/null || true
  echo "  Keys imported via cargo-tangle"
else
  echo "  WARNING: cargo-tangle not found at $CARGO_TANGLE"
  echo "  Build it: cd ../blueprint && cargo build -p cargo-tangle --release"
  echo "  Then re-run this script to import operator keys"
fi

# ── [9/9] Write env file ─────────────────────────────────────────
echo "[9/9] Writing arena/.env.local..."
cat > arena/.env.local <<EOF
VITE_USE_LOCAL_CHAIN=true
VITE_RPC_URL=$RPC_URL
VITE_CHAIN_ID=31337
VITE_TANGLE_CONTRACT=$TANGLE
VITE_VAULT_FACTORY=$VAULT_FACTORY
VITE_USDC_ADDRESS=$USDC
VITE_WETH_ADDRESS=$WETH
VITE_SERVICE_IDS=$SERVICE_ID
VITE_BOT_META={"$SERVICE_ID":{"name":"Arena Demo Bot","strategyType":"dex"}}
VITE_OPERATOR_API_URL=/operator-api
VITE_DEFAULT_AI_PROVIDER=zai
VITE_DEFAULT_AI_API_KEY=${ZAI_API_KEY:-}
VITE_TRADING_BLUEPRINT=$BSM
VITE_BLUEPRINT_ID=$BLUEPRINT_ID
EOF

echo ""
echo "╔═════════════════════════════════════════════════════════════╗"
echo "║           TRADING ARENA — LOCAL TESTNET (Blueprint)         ║"
echo "╠═════════════════════════════════════════════════════════════╣"
echo "║ Tangle:          $TANGLE  ║"
echo "║ BSM:             $BSM  ║"
echo "║ VaultFactory:    $VAULT_FACTORY  ║"
echo "║ USDC:            $USDC  ║"
echo "║ WETH:            $WETH  ║"
echo "║ Service ID:      $SERVICE_ID (per-bot vaults on provision)             ║"
echo "║ Blueprint ID:    $BLUEPRINT_ID                                       ║"
echo "╠═════════════════════════════════════════════════════════════╣"
echo "║ User:      $USER_ACCOUNT          ║"
echo "║ Operator1: $OPERATOR1_ADDR → :9200  ║"
echo "║ Operator2: $OPERATOR2_ADDR → :9201  ║"
echo "╚═════════════════════════════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo "  1. Start operator binary:  ./target/release/trading-blueprint run ..."
echo "  2. Start frontend:         cd arena && pnpm dev"
