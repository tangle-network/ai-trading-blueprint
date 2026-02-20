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
N_VALIDATOR_SERVICES="${N_VALIDATOR_SERVICES:-1}"
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
VALIDATOR_BSM=$(parse_deploy VALIDATOR_BSM)
VAULT_FACTORY=$(parse_deploy VAULT_FACTORY)
USDC=$(parse_deploy USDC)
WETH=$(parse_deploy WETH)
BLUEPRINT_ID=$(parse_deploy BLUEPRINT_ID)
INSTANCE_BLUEPRINT_ID=$(parse_deploy INSTANCE_BLUEPRINT_ID)
TEE_BLUEPRINT_ID=$(parse_deploy TEE_BLUEPRINT_ID)
VALIDATOR_BLUEPRINT_ID=$(parse_deploy VALIDATOR_BLUEPRINT_ID)

if [[ -z "$BSM" || -z "$VAULT_FACTORY" || -z "$USDC" || -z "$BLUEPRINT_ID" ]]; then
  echo "ERROR: Failed to parse addresses from forge script output."
  echo "Forge output:"
  echo "$FORGE_OUTPUT" | tail -30
  exit 1
fi

echo "  BSM:                    $BSM"
echo "  Validator BSM:          $VALIDATOR_BSM"
echo "  VaultFactory:           $VAULT_FACTORY"
echo "  USDC:                   $USDC"
echo "  WETH:                   $WETH"
echo "  Cloud Blueprint ID:     $BLUEPRINT_ID"
echo "  Instance Blueprint ID:  $INSTANCE_BLUEPRINT_ID"
echo "  TEE Blueprint ID:       $TEE_BLUEPRINT_ID"
echo "  Validator Blueprint ID: $VALIDATOR_BLUEPRINT_ID"

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

# ── [3/9] Register operators for all blueprints ──────────────────
echo "[3/9] Registering operators for all blueprint variants..."

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

# Register operators for each blueprint variant (trading + validator)
ALL_BLUEPRINT_IDS=("$BLUEPRINT_ID" "$INSTANCE_BLUEPRINT_ID" "$TEE_BLUEPRINT_ID" "$VALIDATOR_BLUEPRINT_ID")
BLUEPRINT_NAMES=("Cloud" "Instance" "TEE" "Validator")

for idx in 0 1 2 3; do
  BP_ID="${ALL_BLUEPRINT_IDS[$idx]}"
  BP_NAME="${BLUEPRINT_NAMES[$idx]}"

  # Register operator 1
  if ! cast send "$TANGLE" \
    "registerOperator(uint64,bytes,string)" \
    "$BP_ID" "$OPERATOR1_PUBKEY" "$OPERATOR1_RPC" \
    --gas-price 0 --priority-gas-price 0 --gas-limit 500000 \
    --rpc-url "$RPC_URL" --private-key "$OPERATOR1_KEY" > /dev/null 2>&1; then
    cast send "$TANGLE" \
      "updateOperatorPreferences(uint64,bytes,string)" \
      "$BP_ID" 0x "$OPERATOR1_RPC" \
      --gas-price 0 --priority-gas-price 0 --gas-limit 500000 \
      --rpc-url "$RPC_URL" --private-key "$OPERATOR1_KEY" > /dev/null 2>&1
  fi

  # Register operator 2
  if ! cast send "$TANGLE" \
    "registerOperator(uint64,bytes,string)" \
    "$BP_ID" "$OPERATOR2_PUBKEY" "$OPERATOR2_RPC" \
    --gas-price 0 --priority-gas-price 0 --gas-limit 500000 \
    --rpc-url "$RPC_URL" --private-key "$OPERATOR2_KEY" > /dev/null 2>&1; then
    cast send "$TANGLE" \
      "updateOperatorPreferences(uint64,bytes,string)" \
      "$BP_ID" 0x "$OPERATOR2_RPC" \
      --gas-price 0 --priority-gas-price 0 --gas-limit 500000 \
      --rpc-url "$RPC_URL" --private-key "$OPERATOR2_KEY" > /dev/null 2>&1
  fi

  echo "  $BP_NAME (blueprint $BP_ID): both operators registered"
done

# ── [4/9] Request services for all blueprints ────────────────────
echo "[4/9] Requesting services (3 trading + $N_VALIDATOR_SERVICES validator)..."

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

# Helper: create a service for a blueprint and return its service ID
create_service() {
  local bp_id="$1"
  local label="$2"

  local req_id
  req_id=$(cast call "$TANGLE" "serviceRequestCount()(uint64)" --rpc-url "$RPC_URL" 2>&1 | xargs)
  req_id=$(echo "$req_id" | sed 's/^0x//' | sed 's/^0*//' | sed 's/^$/0/')

  cast send "$TANGLE" \
    "requestService(uint64,address[],bytes,address[],uint64,address,uint256)" \
    "$bp_id" \
    "[$OPERATOR1_ADDR,$OPERATOR2_ADDR]" \
    "$CONFIG" \
    "$PERMITTED_CALLERS" \
    31536000 \
    "0x0000000000000000000000000000000000000000" \
    0 \
    --gas-price 0 --priority-gas-price 0 --gas-limit 3000000 \
    --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" > /dev/null 2>&1

  cast send "$TANGLE" "approveService(uint64,uint8)" "$req_id" 100 \
    --gas-price 0 --priority-gas-price 0 --gas-limit 10000000 \
    --rpc-url "$RPC_URL" --private-key "$OPERATOR1_KEY" > /dev/null 2>&1
  cast send "$TANGLE" "approveService(uint64,uint8)" "$req_id" 100 \
    --gas-price 0 --priority-gas-price 0 --gas-limit 10000000 \
    --rpc-url "$RPC_URL" --private-key "$OPERATOR2_KEY" > /dev/null 2>&1

  local svc_count
  svc_count=$(cast call "$TANGLE" "serviceCount()(uint64)" --rpc-url "$RPC_URL" 2>&1 | xargs)
  svc_count=$(echo "$svc_count" | sed 's/^0x//' | sed 's/^0*//' | sed 's/^$/0/')
  local svc_id=$((svc_count - 1))

  echo "  $label: service $svc_id (request $req_id)" >&2
  echo "$svc_id"
}

# Create 3 trading services (one per variant)
CLOUD_SERVICE_ID=$(create_service "$BLUEPRINT_ID" "Cloud")
INSTANCE_SERVICE_ID=$(create_service "$INSTANCE_BLUEPRINT_ID" "Instance")
TEE_SERVICE_ID=$(create_service "$TEE_BLUEPRINT_ID" "TEE")

# Create N validator services (all use same validator blueprint)
declare -a VALIDATOR_SERVICE_IDS
for i in $(seq 1 "$N_VALIDATOR_SERVICES"); do
  svc_id=$(create_service "$VALIDATOR_BLUEPRINT_ID" "Validator $i")
  VALIDATOR_SERVICE_IDS+=("$svc_id")
done

# First validator service (used as default in frontend)
VALIDATOR_SERVICE_ID="${VALIDATOR_SERVICE_IDS[0]}"
# Comma-separated list of all validator service IDs
VALIDATOR_SERVICE_IDS_CSV=$(IFS=,; echo "${VALIDATOR_SERVICE_IDS[*]}")

echo ""
echo "  Cloud service ID:      $CLOUD_SERVICE_ID"
echo "  Instance service ID:   $INSTANCE_SERVICE_ID"
echo "  TEE service ID:        $TEE_SERVICE_ID"
echo "  Validator service IDs: $VALIDATOR_SERVICE_IDS_CSV"

# ── [5/9] Grant OPERATOR_ROLE via onOperatorJoined ───────────────
echo "[5/9] Granting OPERATOR_ROLE to operators..."

# onOperatorJoined is NOT auto-called during Fixed membership activation.
# We impersonate Tangle to trigger it on both BSMs.
cast rpc anvil_impersonateAccount "$TANGLE" --rpc-url "$RPC_URL" > /dev/null 2>&1

# Trading services (use trading BSM)
for SVC_ID in "$CLOUD_SERVICE_ID" "$INSTANCE_SERVICE_ID" "$TEE_SERVICE_ID"; do
  cast send "$BSM" "onOperatorJoined(uint64,address,uint16)" \
    "$SVC_ID" "$OPERATOR1_ADDR" 10000 \
    --from "$TANGLE" --unlocked --gas-price 0 --priority-gas-price 0 --gas-limit 500000 \
    --rpc-url "$RPC_URL" > /dev/null 2>&1
  cast send "$BSM" "onOperatorJoined(uint64,address,uint16)" \
    "$SVC_ID" "$OPERATOR2_ADDR" 10000 \
    --from "$TANGLE" --unlocked --gas-price 0 --priority-gas-price 0 --gas-limit 500000 \
    --rpc-url "$RPC_URL" > /dev/null 2>&1
done
echo "  Trading BSM: OPERATOR_ROLE granted on services $CLOUD_SERVICE_ID, $INSTANCE_SERVICE_ID, $TEE_SERVICE_ID"

# Validator services (use validator BSM — no vaults, just operator tracking)
for SVC_ID in "${VALIDATOR_SERVICE_IDS[@]}"; do
  cast send "$VALIDATOR_BSM" "onOperatorJoined(uint64,address,uint16)" \
    "$SVC_ID" "$OPERATOR1_ADDR" 10000 \
    --from "$TANGLE" --unlocked --gas-price 0 --priority-gas-price 0 --gas-limit 500000 \
    --rpc-url "$RPC_URL" > /dev/null 2>&1
  cast send "$VALIDATOR_BSM" "onOperatorJoined(uint64,address,uint16)" \
    "$SVC_ID" "$OPERATOR2_ADDR" 10000 \
    --from "$TANGLE" --unlocked --gas-price 0 --priority-gas-price 0 --gas-limit 500000 \
    --rpc-url "$RPC_URL" > /dev/null 2>&1
done
echo "  Validator BSM: operators joined $N_VALIDATOR_SERVICES service(s): $VALIDATOR_SERVICE_IDS_CSV"

cast rpc anvil_stopImpersonatingAccount "$TANGLE" --rpc-url "$RPC_URL" > /dev/null 2>&1

# ── [6/9] Verify service state ───────────────────────────────────
echo "[6/9] Verifying service state..."
for idx in 0 1 2; do
  SVC_ID="${SERVICE_IDS[$idx]}"
  BP_NAME="${BLUEPRINT_NAMES[$idx]}"
  PROVISIONED=$(cast call "$BSM" "instanceProvisioned(uint64)(bool)" "$SVC_ID" --rpc-url "$RPC_URL" 2>&1 | xargs)
  echo "  $BP_NAME (service $SVC_ID): provisioned=$PROVISIONED"
done
echo "  Validator ($N_VALIDATOR_SERVICES services: $VALIDATOR_SERVICE_IDS_CSV): active (no vaults needed)"
echo "  Note: Per-bot vaults are created when provision jobs complete (not at service init)"

# ── [7/9] Setup pricing engine keystores ─────────────────────────
echo "[7/9] Setting up pricing engine keystores..."
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

# ── [8/9] Write env file ─────────────────────────────────────────
echo "[8/9] Writing arena/.env.local..."

# Build comma-separated service IDs for all variants
ALL_SERVICE_IDS="$CLOUD_SERVICE_ID,$INSTANCE_SERVICE_ID,$TEE_SERVICE_ID"

cat > arena/.env.local <<EOF
VITE_USE_LOCAL_CHAIN=true
VITE_RPC_URL=$RPC_URL
VITE_CHAIN_ID=31337
VITE_TANGLE_CONTRACT=$TANGLE
VITE_VAULT_FACTORY=$VAULT_FACTORY
VITE_USDC_ADDRESS=$USDC
VITE_WETH_ADDRESS=$WETH
VITE_SERVICE_IDS=$ALL_SERVICE_IDS
VITE_BOT_META={"$CLOUD_SERVICE_ID":{"name":"Cloud Demo Bot","strategyType":"dex"},"$INSTANCE_SERVICE_ID":{"name":"Instance Demo Bot","strategyType":"dex"},"$TEE_SERVICE_ID":{"name":"TEE Demo Bot","strategyType":"dex"}}
VITE_OPERATOR_API_URL=/operator-api
VITE_DEFAULT_AI_PROVIDER=zai
VITE_DEFAULT_AI_API_KEY=${ZAI_API_KEY:-}
VITE_TRADING_BLUEPRINT=$BSM
VITE_VALIDATOR_BLUEPRINT=$VALIDATOR_BSM
VITE_BLUEPRINT_ID=$BLUEPRINT_ID
VITE_INSTANCE_BLUEPRINT_ID=$INSTANCE_BLUEPRINT_ID
VITE_TEE_BLUEPRINT_ID=$TEE_BLUEPRINT_ID
VITE_VALIDATOR_BLUEPRINT_ID=$VALIDATOR_BLUEPRINT_ID
VITE_VALIDATOR_SERVICE_ID=$VALIDATOR_SERVICE_ID
VITE_VALIDATOR_SERVICE_IDS=$VALIDATOR_SERVICE_IDS_CSV
EOF

echo ""
echo "# ── [9/9] Summary ──────────────────────────────────────────────"
echo ""
echo "╔════════════════════════════════════════════════════════════════════╗"
echo "║              TRADING ARENA — LOCAL TESTNET (Blueprint)            ║"
echo "╠════════════════════════════════════════════════════════════════════╣"
echo "║ Tangle:         $TANGLE"
echo "║ Trading BSM:    $BSM"
echo "║ Validator BSM:  $VALIDATOR_BSM"
echo "║ VaultFactory:   $VAULT_FACTORY"
echo "║ USDC:           $USDC"
echo "║ WETH:           $WETH"
echo "╠════════════════════════════════════════════════════════════════════╣"
echo "║ Cloud:     blueprint=$BLUEPRINT_ID  service=$CLOUD_SERVICE_ID"
echo "║ Instance:  blueprint=$INSTANCE_BLUEPRINT_ID  service=$INSTANCE_SERVICE_ID"
echo "║ TEE:       blueprint=$TEE_BLUEPRINT_ID  service=$TEE_SERVICE_ID"
echo "║ Validator: blueprint=$VALIDATOR_BLUEPRINT_ID  services=$VALIDATOR_SERVICE_IDS_CSV"
echo "╠════════════════════════════════════════════════════════════════════╣"
echo "║ User:      $USER_ACCOUNT"
echo "║ Operator1: $OPERATOR1_ADDR → :9200"
echo "║ Operator2: $OPERATOR2_ADDR → :9201"
echo "╚════════════════════════════════════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo "  1. Start operator binary:  ./target/release/trading-blueprint run ..."
echo "  2. Start validator binary:  ./target/release/trading-validator run ..."
echo "  3. Start frontend:         cd arena && pnpm dev"
echo ""
echo "  All 3 trading variants + validator are visible in the UI."
echo "  Bots provisioned with validator_service_ids=[$VALIDATOR_SERVICE_IDS_CSV] will use real validation."
echo "  Deploy more: N_VALIDATOR_SERVICES=3 ./scripts/deploy-local.sh"
