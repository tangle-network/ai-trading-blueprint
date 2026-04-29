#!/usr/bin/env bash
# Deploy the Trading Arena contracts to a local Anvil with Tangle protocol pre-loaded,
# using the proper Blueprint lifecycle:
#
#   1. Deploy contracts + register blueprint on Tangle (forge script)
#   2. Wire VaultFactory to BSM (Anvil impersonation)
#   3. Register operators for the new blueprint
#   4. Request service + operators approve → service activated (no vault yet)
#   5. Grant OPERATOR_ROLE via onOperatorJoined (Anvil impersonation)
#   6. Write .env.local (cloud vaults created by JOB_PROVISION; instance/TEE vaults at service init)
#
# Prerequisites:
#   anvil --load-state /path/to/blueprint/crates/chain-setup/anvil/snapshots/localtestnet-state.json
#
# Usage: ./scripts/deploy-local.sh
set -euo pipefail

ANVIL_PORT="${ANVIL_PORT:-8545}"
RPC_URL="${RPC_URL:-http://127.0.0.1:$ANVIL_PORT}"
CHAIN_ID="${CHAIN_ID:-31338}"
OPERATOR_API_PORT="${OPERATOR_API_PORT:-9200}"
INSTANCE_OPERATOR_API_PORT="${INSTANCE_OPERATOR_API_PORT:-9201}"
N_VALIDATOR_SERVICES="${N_VALIDATOR_SERVICES:-1}"
FORK_MODE="${FORK_MODE:-false}"
FORK_BASE_CHAIN_ID="${FORK_BASE_CHAIN_ID:-${PROTOCOL_CHAIN_ID:-}}"
ENABLE_VALIDATOR_SERVICE="${ENABLE_VALIDATOR_SERVICE:-}"
EXISTING_USDC_ADDRESS="${EXISTING_USDC_ADDRESS:-${USDC_ADDRESS:-}}"
EXISTING_WETH_ADDRESS="${EXISTING_WETH_ADDRESS:-${WETH_ADDRESS:-}}"
FORGE_SCRIPT_TIMEOUT_SECS="${FORGE_SCRIPT_TIMEOUT_SECS:-300}"
TRADING_APPROVE_GAS_LIMIT="${TRADING_APPROVE_GAS_LIMIT:-25000000}"
TRADING_APPROVE_GAS_PRICE_WEI="${TRADING_APPROVE_GAS_PRICE_WEI:-1}"
OPERATOR_REGISTRATION_GAS_LIMIT="${OPERATOR_REGISTRATION_GAS_LIMIT:-3000000}"
DEPLOYER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
DEPLOYER_ADDR="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
SERVICE_REQUEST_KEY="0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6"
SERVICE_REQUEST_ADDR="0xa0Ee7A142d267C1f36714E4a8F75612F20a79720"
OPERATOR1_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
OPERATOR1_ADDR="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
OPERATOR2_KEY="0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"
OPERATOR2_ADDR="0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
SINGLETON_VAULT_DEPLOYER_KEY="${SINGLETON_VAULT_DEPLOYER_KEY:-0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6}"
SINGLETON_VAULT_DEPLOYER_ADDR="${SINGLETON_VAULT_DEPLOYER_ADDR:-0x90F79bf6EB2c4f870365E785982E1f101E93b906}"
USER_ACCOUNT="0x68FF20459d48917748CA13afCbDA3B265a449D48"
USER_ACCOUNT_2="0xd04E36A1C370c6115e1C676838AcD0b430d740F3"

# Tangle protocol addresses (deterministic from state snapshot)
TANGLE="0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9"

# Pricing engine gRPC ports (operators register these for RFQ quotes).
# NOT the operator HTTP API (9200/9201) — the frontend's useQuotes hook
# connects via gRPC-Web to these addresses.
OPERATOR1_RPC="http://localhost:50051"
OPERATOR2_RPC="http://localhost:50052"

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [[ -z "$ENABLE_VALIDATOR_SERVICE" ]]; then
  if [[ "$FORK_MODE" == "true" ]]; then
    ENABLE_VALIDATOR_SERVICE=false
  else
    ENABLE_VALIDATOR_SERVICE=true
  fi
fi

send_with_retry() {
  local output=""
  local tx_hash=""
  local receipt=""
  local status=""
  for _ in $(seq 1 5); do
    if output="$(cast send --async "$@" 2>&1)"; then
      tx_hash="$(printf '%s\n' "$output" | grep -Eo '0x[0-9a-fA-F]{64}' | tail -n 1)"
      if [[ -z "$tx_hash" ]]; then
        echo "$output"
        return 1
      fi

      for _ in $(seq 1 30); do
        receipt="$(cast rpc eth_getTransactionReceipt "$tx_hash" --rpc-url "$RPC_URL" 2>/dev/null || true)"
        if [[ -n "$receipt" && "$receipt" != "null" ]]; then
          status="$(
            RECEIPT_JSON="$receipt" node -e '
              const receipt = JSON.parse(process.env.RECEIPT_JSON);
              process.stdout.write(String(receipt.status));
            '
          )"
          if [[ "$status" == "0x1" || "$status" == "1" ]]; then
            return 0
          fi
          echo "$receipt"
          return 1
        fi

        cast rpc anvil_mine 1 --rpc-url "$RPC_URL" > /dev/null 2>&1 || true
        sleep 1
      done

      echo "Timed out waiting for receipt: $tx_hash"
      return 1
    fi
    if grep -Eqi "replacement transaction underpriced|transaction already imported" <<<"$output"; then
      cast rpc anvil_mine 1 --rpc-url "$RPC_URL" > /dev/null 2>&1 || true
      sleep 1
      continue
    fi
    echo "$output"
    return 1
  done
  echo "$output"
  return 1
}

echo "=== Trading Arena — Local Deployment (Blueprint Lifecycle) ==="
echo "RPC: $RPC_URL"
echo "Tangle: $TANGLE"
if [[ -n "$EXISTING_USDC_ADDRESS" || -n "$EXISTING_WETH_ADDRESS" ]]; then
  echo "Assets: external (USDC=$EXISTING_USDC_ADDRESS WETH=$EXISTING_WETH_ADDRESS)"
fi
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
FORGE_OUTPUT_FILE="$(mktemp)"
FORGE_STATUS_FILE="$(mktemp)"
(
  if EXISTING_USDC_ADDRESS="$EXISTING_USDC_ADDRESS" \
    EXISTING_WETH_ADDRESS="$EXISTING_WETH_ADDRESS" \
    PRECREATE_SINGLETON_VAULTS="$FORK_MODE" \
    ASSET_TOKEN_ADDRESS="${ASSET_TOKEN_ADDRESS:-}" \
    forge script contracts/script/RegisterBlueprint.s.sol \
      --rpc-url "$RPC_URL" --sender "$DEPLOYER_ADDR" --broadcast --skip-simulation >"$FORGE_OUTPUT_FILE" 2>&1; then
    echo 0 > "$FORGE_STATUS_FILE"
  else
    echo $? > "$FORGE_STATUS_FILE"
  fi
) &
FORGE_PID=$!

for _ in $(seq 1 "$FORGE_SCRIPT_TIMEOUT_SECS"); do
  if ! kill -0 "$FORGE_PID" 2>/dev/null; then
    break
  fi
  sleep 1
done

if kill -0 "$FORGE_PID" 2>/dev/null; then
  kill "$FORGE_PID" 2>/dev/null || true
  wait "$FORGE_PID" 2>/dev/null || true
  echo 124 > "$FORGE_STATUS_FILE"
  echo "  Forge script exceeded ${FORGE_SCRIPT_TIMEOUT_SECS}s; continuing with captured deploy output"
else
  wait "$FORGE_PID" 2>/dev/null || true
fi

FORGE_OUTPUT="$(cat "$FORGE_OUTPUT_FILE")"
FORGE_STATUS="$(cat "$FORGE_STATUS_FILE")"
rm -f "$FORGE_OUTPUT_FILE" "$FORGE_STATUS_FILE"

# Parse addresses from forge output
parse_deploy() {
  echo "$FORGE_OUTPUT" | grep "DEPLOY_${1}=" | sed "s/.*DEPLOY_${1}=//" | tr -d ' ' || true
}

create_manual_singleton_vault() {
  local service_id="$1"
  local admin_address="$2"
  local vault_name="$3"
  local vault_symbol="$4"
  local output=""
  local vault=""
  local operator_role
  local creator_role
  cast rpc anvil_setBalance "$SINGLETON_VAULT_DEPLOYER_ADDR" "0x56BC75E2D63100000" --rpc-url "$RPC_URL" > /dev/null 2>&1

  if ! output="$(
    SCRIPT_PRIVATE_KEY="$SINGLETON_VAULT_DEPLOYER_KEY" \
    VAULT_FACTORY="$VAULT_FACTORY" \
    SERVICE_ID="$service_id" \
    ASSET_TOKEN="$TRADING_ASSET_TOKEN" \
    ADMIN_ADDRESS="$admin_address" \
    SIGNER_ONE="$OPERATOR1_ADDR" \
    SIGNER_TWO="$OPERATOR2_ADDR" \
    VAULT_NAME="$vault_name" \
    VAULT_SYMBOL="$vault_symbol" \
    forge script contracts/script/CreateSingletonVault.s.sol \
      --rpc-url "$RPC_URL" \
      --sender "$SINGLETON_VAULT_DEPLOYER_ADDR" \
      --broadcast \
      --skip-simulation 2>&1
  )"; then
    echo "ERROR: failed to create singleton vault for service $service_id" >&2
    echo "$output" >&2
    exit 1
  fi

  vault="$(
    printf '%s\n' "$output" \
      | grep "MANUAL_VAULT=" \
      | sed 's/.*MANUAL_VAULT=//' \
      | tr -d ' '
  )"
  if [[ -z "$vault" ]]; then
    echo "ERROR: failed to parse singleton vault address for service $service_id" >&2
    echo "$output" >&2
    exit 1
  fi

  operator_role="$(cast keccak "OPERATOR_ROLE")"
  creator_role="$(cast keccak "CREATOR_ROLE")"

  if ! output="$(
    send_with_retry "$vault" "grantRole(bytes32,address)" "$operator_role" "$OPERATOR1_ADDR" \
      --gas-price 0 --priority-gas-price 0 --gas-limit 500000 \
      --rpc-url "$RPC_URL" --from "$admin_address" --unlocked 2>&1
  )"; then
    echo "ERROR: failed to grant operator role 1 for service $service_id" >&2
    echo "$output" >&2
    exit 1
  fi

  if ! output="$(
    send_with_retry "$vault" "grantRole(bytes32,address)" "$operator_role" "$OPERATOR2_ADDR" \
      --gas-price 0 --priority-gas-price 0 --gas-limit 500000 \
      --rpc-url "$RPC_URL" --from "$admin_address" --unlocked 2>&1
  )"; then
    echo "ERROR: failed to grant operator role 2 for service $service_id" >&2
    echo "$output" >&2
    exit 1
  fi

  if ! output="$(
    send_with_retry "$vault" "grantRole(bytes32,address)" "$creator_role" "$admin_address" \
      --gas-price 0 --priority-gas-price 0 --gas-limit 500000 \
      --rpc-url "$RPC_URL" --from "$admin_address" --unlocked 2>&1
  )"; then
    echo "ERROR: failed to grant creator role for service $service_id" >&2
    echo "$output" >&2
    exit 1
  fi

  printf '%s\n' "$vault"
}

BSM=$(parse_deploy BSM)
INSTANCE_BSM=$(parse_deploy INSTANCE_BSM)
TEE_BSM=$(parse_deploy TEE_BSM)
VALIDATOR_BSM=$(parse_deploy VALIDATOR_BSM)
VAULT_FACTORY=$(parse_deploy VAULT_FACTORY)
POLICY_ENGINE=$(parse_deploy POLICY_ENGINE)
USDC=$(parse_deploy USDC)
WETH=$(parse_deploy WETH)
TRADE_VALIDATOR=$(parse_deploy TRADE_VALIDATOR)
FEE_DISTRIBUTOR=$(parse_deploy FEE_DISTRIBUTOR)
BLUEPRINT_ID=$(parse_deploy BLUEPRINT_ID)
INSTANCE_BLUEPRINT_ID=$(parse_deploy INSTANCE_BLUEPRINT_ID)
TEE_BLUEPRINT_ID=$(parse_deploy TEE_BLUEPRINT_ID)
VALIDATOR_BLUEPRINT_ID=$(parse_deploy VALIDATOR_BLUEPRINT_ID)
PRECREATED_INSTANCE_VAULT=$(parse_deploy INSTANCE_SINGLETON_VAULT)
PRECREATED_TEE_VAULT=$(parse_deploy TEE_SINGLETON_VAULT)

if [[ -z "$BSM" || -z "$VAULT_FACTORY" || -z "$POLICY_ENGINE" || -z "$TRADE_VALIDATOR" || -z "$FEE_DISTRIBUTOR" || -z "$USDC" || -z "$BLUEPRINT_ID" ]]; then
  echo "ERROR: Failed to parse addresses from forge script output."
  echo "Forge output:"
  echo "$FORGE_OUTPUT" | tail -30
  exit 1
fi

echo "  Cloud BSM:              $BSM"
echo "  Instance BSM:           $INSTANCE_BSM"
echo "  TEE BSM:                $TEE_BSM"
echo "  Validator BSM:          $VALIDATOR_BSM"
echo "  VaultFactory:           $VAULT_FACTORY"
echo "  TradeValidator:         $TRADE_VALIDATOR"
echo "  USDC:                   $USDC"
echo "  WETH:                   $WETH"
echo "  Cloud Blueprint ID:     $BLUEPRINT_ID"
echo "  Instance Blueprint ID:  $INSTANCE_BLUEPRINT_ID"
echo "  TEE Blueprint ID:       $TEE_BLUEPRINT_ID"
echo "  Validator Blueprint ID: $VALIDATOR_BLUEPRINT_ID"

# Fund user accounts
echo "  Funding user accounts..."
if [[ "$FORK_MODE" == "true" ]]; then
  echo "    Skipped custom demo-user funding in fork mode (historical fork backend)"
else
  for acct in "$USER_ACCOUNT" "$USER_ACCOUNT_2"; do
    send_with_retry "$acct" --value 100ether --gas-limit 21000 --rpc-url "$RPC_URL" --from "$SERVICE_REQUEST_ADDR" --unlocked > /dev/null
    if [[ -z "$EXISTING_USDC_ADDRESS" && -z "$EXISTING_WETH_ADDRESS" ]]; then
      send_with_retry "$USDC" "mint(address,uint256)" "$acct" 1000000000000 \
        --rpc-url "$RPC_URL" --from "$SERVICE_REQUEST_ADDR" --unlocked > /dev/null
      send_with_retry "$WETH" "mint(address,uint256)" "$acct" 100000000000000000000 \
        --rpc-url "$RPC_URL" --from "$SERVICE_REQUEST_ADDR" --unlocked > /dev/null
      echo "    $acct (100 ETH, 1M USDC, 100 WETH)"
    else
      echo "    $acct (100 ETH, token seeding deferred to fork helper)"
    fi
  done
fi

# Fund extra accounts (if provided)
if [[ -n "${EXTRA_ACCOUNTS:-}" ]]; then
  echo "  Funding extra accounts..."
  for acct in $EXTRA_ACCOUNTS; do
    send_with_retry "$acct" --value 100ether --gas-limit 21000 --rpc-url "$RPC_URL" --from "$SERVICE_REQUEST_ADDR" --unlocked > /dev/null
    if [[ -z "$EXISTING_USDC_ADDRESS" && -z "$EXISTING_WETH_ADDRESS" ]]; then
      send_with_retry "$USDC" "mint(address,uint256)" "$acct" 1000000000000 \
        --rpc-url "$RPC_URL" --from "$SERVICE_REQUEST_ADDR" --unlocked > /dev/null
      send_with_retry "$WETH" "mint(address,uint256)" "$acct" 100000000000000000000 \
        --rpc-url "$RPC_URL" --from "$SERVICE_REQUEST_ADDR" --unlocked > /dev/null
      echo "  Extra: $acct (100 ETH, 1M USDC, 100 WETH)"
    else
      echo "  Extra: $acct (100 ETH, token seeding deferred to fork helper)"
    fi
  done
fi

# ── [2/10] Wire VaultFactory to all BSMs (Tangle impersonation) ──
echo "[2/10] Wiring VaultFactory to all BSMs..."
# setVaultFactory() has onlyFromTangle modifier — msg.sender must be Tangle contract
cast rpc anvil_impersonateAccount "$TANGLE" --rpc-url "$RPC_URL" > /dev/null 2>&1
# Fund Tangle contract for gas
cast rpc anvil_setBalance "$TANGLE" "0x56BC75E2D63100000" --rpc-url "$RPC_URL" > /dev/null 2>&1
for BSM_ADDR in "$BSM" "$INSTANCE_BSM" "$TEE_BSM"; do
  cast send "$BSM_ADDR" "setVaultFactory(address)" "$VAULT_FACTORY" \
    --from "$TANGLE" --unlocked --gas-price 0 --priority-gas-price 0 --gas-limit 500000 \
    --rpc-url "$RPC_URL" > /dev/null 2>&1
done

if [[ "$FORK_MODE" != "true" ]]; then
  # Set instanceMode=true on Instance and TEE BSMs (vault created at service init, not provision job)
  for BSM_ADDR in "$INSTANCE_BSM" "$TEE_BSM"; do
    cast send "$BSM_ADDR" "setInstanceMode(bool)" true \
      --from "$TANGLE" --unlocked --gas-price 0 --priority-gas-price 0 --gas-limit 500000 \
      --rpc-url "$RPC_URL" > /dev/null 2>&1
  done
else
  echo "  Fork mode: instanceMode disabled; singleton vaults will be created explicitly after service activation"
fi

cast rpc anvil_stopImpersonatingAccount "$TANGLE" --rpc-url "$RPC_URL" > /dev/null 2>&1

echo "  Authorizing trading blueprints on VaultFactory..."
for BSM_ADDR in "$BSM" "$INSTANCE_BSM" "$TEE_BSM"; do
  send_with_retry "$VAULT_FACTORY" "setAuthorizedCaller(address,bool)" "$BSM_ADDR" true \
    --gas-price 0 --priority-gas-price 0 --gas-limit 500000 \
    --rpc-url "$RPC_URL" --from "$DEPLOYER_ADDR" --unlocked > /dev/null
done
send_with_retry "$VAULT_FACTORY" "setAuthorizedCaller(address,bool)" "$SINGLETON_VAULT_DEPLOYER_ADDR" true \
  --gas-price 0 --priority-gas-price 0 --gas-limit 500000 \
  --rpc-url "$RPC_URL" --from "$DEPLOYER_ADDR" --unlocked > /dev/null
if [[ "$FORK_MODE" == "true" ]]; then
  :
fi

# Verify
FACTORY_CHECK=$(cast call "$BSM" "vaultFactory()(address)" --rpc-url "$RPC_URL" 2>&1 | xargs)
echo "  Cloud BSM.vaultFactory = $FACTORY_CHECK"
INSTANCE_MODE_CHECK=$(cast call "$INSTANCE_BSM" "instanceMode()(bool)" --rpc-url "$RPC_URL" 2>&1 | xargs)
echo "  Instance BSM.instanceMode = $INSTANCE_MODE_CHECK"
TEE_MODE_CHECK=$(cast call "$TEE_BSM" "instanceMode()(bool)" --rpc-url "$RPC_URL" 2>&1 | xargs)
echo "  TEE BSM.instanceMode = $TEE_MODE_CHECK"
INSTANCE_AUTH_CHECK=$(cast call "$VAULT_FACTORY" "authorizedCallers(address)(bool)" "$INSTANCE_BSM" --rpc-url "$RPC_URL" 2>&1 | xargs)
TEE_AUTH_CHECK=$(cast call "$VAULT_FACTORY" "authorizedCallers(address)(bool)" "$TEE_BSM" --rpc-url "$RPC_URL" 2>&1 | xargs)
echo "  Instance BSM authorized = $INSTANCE_AUTH_CHECK"
echo "  TEE BSM authorized = $TEE_AUTH_CHECK"

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
ALL_BLUEPRINT_IDS=("$BLUEPRINT_ID" "$INSTANCE_BLUEPRINT_ID" "$TEE_BLUEPRINT_ID")
BLUEPRINT_NAMES=("Cloud" "Instance" "TEE")
if [[ "$ENABLE_VALIDATOR_SERVICE" == "true" ]]; then
  ALL_BLUEPRINT_IDS+=("$VALIDATOR_BLUEPRINT_ID")
  BLUEPRINT_NAMES+=("Validator")
else
  echo "  Skipping validator blueprint operator registration in this mode"
fi

for idx in "${!ALL_BLUEPRINT_IDS[@]}"; do
  BP_ID="${ALL_BLUEPRINT_IDS[$idx]}"
  BP_NAME="${BLUEPRINT_NAMES[$idx]}"
  REG_OUTPUT=""
  PREF_OUTPUT=""

  # Register operator 1
  if ! REG_OUTPUT="$(
    send_with_retry "$TANGLE" \
    "registerOperator(uint64,bytes,string)" \
    "$BP_ID" "$OPERATOR1_PUBKEY" "$OPERATOR1_RPC" \
    --gas-price 0 --priority-gas-price 0 --gas-limit "$OPERATOR_REGISTRATION_GAS_LIMIT" \
    --rpc-url "$RPC_URL" --from "$OPERATOR1_ADDR" --unlocked 2>&1
  )"; then
    if ! PREF_OUTPUT="$(
      send_with_retry "$TANGLE" \
      "updateOperatorPreferences(uint64,bytes,string)" \
      "$BP_ID" 0x "$OPERATOR1_RPC" \
      --gas-price 0 --priority-gas-price 0 --gas-limit "$OPERATOR_REGISTRATION_GAS_LIMIT" \
      --rpc-url "$RPC_URL" --from "$OPERATOR1_ADDR" --unlocked 2>&1
    )"; then
      echo "ERROR: operator 1 registration/update failed for $BP_NAME blueprint $BP_ID"
      echo "$REG_OUTPUT"
      echo "$PREF_OUTPUT"
      exit 1
    fi
  fi

  # Register operator 2
  if ! REG_OUTPUT="$(
    send_with_retry "$TANGLE" \
    "registerOperator(uint64,bytes,string)" \
    "$BP_ID" "$OPERATOR2_PUBKEY" "$OPERATOR2_RPC" \
    --gas-price 0 --priority-gas-price 0 --gas-limit "$OPERATOR_REGISTRATION_GAS_LIMIT" \
    --rpc-url "$RPC_URL" --from "$OPERATOR2_ADDR" --unlocked 2>&1
  )"; then
    if ! PREF_OUTPUT="$(
      send_with_retry "$TANGLE" \
      "updateOperatorPreferences(uint64,bytes,string)" \
      "$BP_ID" 0x "$OPERATOR2_RPC" \
      --gas-price 0 --priority-gas-price 0 --gas-limit "$OPERATOR_REGISTRATION_GAS_LIMIT" \
      --rpc-url "$RPC_URL" --from "$OPERATOR2_ADDR" --unlocked 2>&1
    )"; then
      echo "ERROR: operator 2 registration/update failed for $BP_NAME blueprint $BP_ID"
      echo "$REG_OUTPUT"
      echo "$PREF_OUTPUT"
      exit 1
    fi
  fi

  echo "  $BP_NAME (blueprint $BP_ID): both operators registered"
done

# ── [4/9] Request services for all blueprints ────────────────────
if [[ "$ENABLE_VALIDATOR_SERVICE" == "true" ]]; then
  echo "[4/9] Requesting services (3 trading + $N_VALIDATOR_SERVICES validator)..."
else
  echo "[4/9] Requesting services (3 trading only; validator uses direct HTTP endpoints)..."
fi

# ABI-encode the TradingProvisionRequest tuple expected by TradingBlueprint.onRequest():
# (string name, string strategyType, string strategyConfigJson, string riskParamsJson,
#  address factoryAddress, address assetToken, address[] signers, uint256 requiredSigs,
#  uint256 chainId, string rpcUrl, string cron, uint64 cpuCores, uint64 memoryMb,
#  uint64 maxLifetimeDays, uint64[] validatorServiceIds, uint256 maxCollateralBps)
TRADING_ASSET_TOKEN="${ASSET_TOKEN_ADDRESS:-$USDC}"
TRADING_CONFIG=$(cast abi-encode \
  "f(string,string,string,string,address,address,address[],uint256,uint256,string,string,uint64,uint64,uint64,uint64[],uint256)" \
  "Arena Demo Bot" \
  "dex" \
  "{}" \
  "{}" \
  "$VAULT_FACTORY" \
  "$TRADING_ASSET_TOKEN" \
  "[]" \
  0 \
  "$CHAIN_ID" \
  "$RPC_URL" \
  "0 */5 * * * *" \
  1 \
  2048 \
  30 \
  "[]" \
  0)
VALIDATOR_CONFIG="0x"
echo "  Trading service asset:  $TRADING_ASSET_TOKEN"

# Build permitted callers list
PERMITTED_CALLERS="[$USER_ACCOUNT,$USER_ACCOUNT_2,$DEPLOYER_ADDR,$SERVICE_REQUEST_ADDR"
if [[ -n "${EXTRA_ACCOUNTS:-}" ]]; then
  for acct in $EXTRA_ACCOUNTS; do
    PERMITTED_CALLERS="$PERMITTED_CALLERS,$acct"
  done
fi
PERMITTED_CALLERS="$PERMITTED_CALLERS]"

NEXT_REQ=$(cast call "$TANGLE" "serviceRequestCount()(uint64)" --rpc-url "$RPC_URL" 2>&1 | xargs)
NEXT_REQ=$(echo "$NEXT_REQ" | sed 's/^0x//' | sed 's/^0*//' | sed 's/^$/0/')
SVC_BEFORE=$(cast call "$TANGLE" "serviceCount()(uint64)" --rpc-url "$RPC_URL" 2>&1 | xargs)
SVC_BEFORE=$(echo "$SVC_BEFORE" | sed 's/^0x//' | sed 's/^0*//' | sed 's/^$/0/')

# Helper: submit a service request for a blueprint and return its request ID
submit_service_request() {
  local bp_id="$1"
  local label="$2"
  local config="$3"
  local req_id="$NEXT_REQ"

  if ! send_with_retry "$TANGLE" \
    "requestService(uint64,address[],bytes,address[],uint64,address,uint256,uint8)" \
    "$bp_id" \
    "[$OPERATOR1_ADDR,$OPERATOR2_ADDR]" \
    "$config" \
    "$PERMITTED_CALLERS" \
    31536000 \
    "0x0000000000000000000000000000000000000000" \
    0 \
    0 \
    --gas-price 0 --priority-gas-price 0 --gas-limit 3000000 \
    --rpc-url "$RPC_URL" --from "$SERVICE_REQUEST_ADDR" --unlocked > /dev/null; then
    echo "ERROR: requestService failed for $label blueprint $bp_id"
    exit 1
  fi

  NEXT_REQ=$((NEXT_REQ + 1))
  REQ_ID_OUT="$req_id"
  echo "  $label: request $req_id" >&2
}

# Submit 3 trading service requests (one per variant)
submit_service_request "$BLUEPRINT_ID" "Cloud" "$TRADING_CONFIG"
CLOUD_REQUEST_ID="$REQ_ID_OUT"
submit_service_request "$INSTANCE_BLUEPRINT_ID" "Instance" "$TRADING_CONFIG"
INSTANCE_REQUEST_ID="$REQ_ID_OUT"
submit_service_request "$TEE_BLUEPRINT_ID" "TEE" "$TRADING_CONFIG"
TEE_REQUEST_ID="$REQ_ID_OUT"

declare -a VALIDATOR_REQUEST_IDS
if [[ "$ENABLE_VALIDATOR_SERVICE" == "true" ]]; then
  # Submit N validator service requests (all use same validator blueprint)
  for i in $(seq 1 "$N_VALIDATOR_SERVICES"); do
    submit_service_request "$VALIDATOR_BLUEPRINT_ID" "Validator $i" "$VALIDATOR_CONFIG"
    VALIDATOR_REQUEST_IDS+=("$REQ_ID_OUT")
  done
fi

if [[ "${#VALIDATOR_REQUEST_IDS[@]}" -gt 0 ]]; then
  VALIDATOR_REQUEST_IDS_CSV=$(IFS=,; echo "${VALIDATOR_REQUEST_IDS[*]}")
else
  VALIDATOR_REQUEST_IDS_CSV=""
fi

echo ""
echo "  Cloud request ID:      $CLOUD_REQUEST_ID"
echo "  Instance request ID:   $INSTANCE_REQUEST_ID"
echo "  TEE request ID:        $TEE_REQUEST_ID"
if [[ "$ENABLE_VALIDATOR_SERVICE" == "true" ]]; then
  echo "  Validator request IDs: $VALIDATOR_REQUEST_IDS_CSV"
fi

# ── [5/9] Approve service requests ────────────────────────────────
echo "[5/9] Approving service requests..."

for REQ_ID in "$CLOUD_REQUEST_ID" "$INSTANCE_REQUEST_ID" "$TEE_REQUEST_ID"; do
  APPROVE_OUTPUT=""
  if ! APPROVE_OUTPUT="$(
    send_with_retry "$TANGLE" "approveService(uint64,uint8)" "$REQ_ID" 100 \
    --legacy --gas-price "$TRADING_APPROVE_GAS_PRICE_WEI" --gas-limit "$TRADING_APPROVE_GAS_LIMIT" \
    --rpc-url "$RPC_URL" --from "$OPERATOR1_ADDR" --unlocked 2>&1
  )"; then
    echo "ERROR: operator 1 approval failed for request $REQ_ID"
    echo "$APPROVE_OUTPUT"
    exit 1
  fi
  if ! APPROVE_OUTPUT="$(
    send_with_retry "$TANGLE" "approveService(uint64,uint8)" "$REQ_ID" 100 \
    --legacy --gas-price "$TRADING_APPROVE_GAS_PRICE_WEI" --gas-limit "$TRADING_APPROVE_GAS_LIMIT" \
    --rpc-url "$RPC_URL" --from "$OPERATOR2_ADDR" --unlocked 2>&1
  )"; then
    echo "ERROR: operator 2 approval failed for request $REQ_ID"
    echo "$APPROVE_OUTPUT"
    exit 1
  fi
done

if [[ "$ENABLE_VALIDATOR_SERVICE" == "true" ]]; then
  for REQ_ID in "${VALIDATOR_REQUEST_IDS[@]}"; do
    if ! send_with_retry "$TANGLE" "approveService(uint64,uint8)" "$REQ_ID" 100 \
      --gas-price 0 --priority-gas-price 0 --gas-limit 10000000 \
      --rpc-url "$RPC_URL" --from "$OPERATOR1_ADDR" --unlocked > /dev/null; then
      echo "ERROR: validator operator 1 approval failed for request $REQ_ID"
      exit 1
    fi
    if ! send_with_retry "$TANGLE" "approveService(uint64,uint8)" "$REQ_ID" 100 \
      --gas-price 0 --priority-gas-price 0 --gas-limit 10000000 \
      --rpc-url "$RPC_URL" --from "$OPERATOR2_ADDR" --unlocked > /dev/null; then
      echo "ERROR: validator operator 2 approval failed for request $REQ_ID"
      exit 1
    fi
  done
fi

# Resolve service IDs by scanning services created during this deployment.
echo "[6/9] Resolving service IDs..."
SVC_AFTER=$(cast call "$TANGLE" "serviceCount()(uint64)" --rpc-url "$RPC_URL" 2>&1 | xargs)
SVC_AFTER=$(echo "$SVC_AFTER" | sed 's/^0x//' | sed 's/^0*//' | sed 's/^$/0/')

CLOUD_SERVICE_ID=""
INSTANCE_SERVICE_ID=""
TEE_SERVICE_ID=""
declare -a VALIDATOR_SERVICE_IDS

if (( SVC_AFTER > SVC_BEFORE )); then
  for SVC_ID in $(seq "$SVC_BEFORE" "$((SVC_AFTER - 1))"); do
    SVC_DATA=$(cast call "$TANGLE" "getService(uint64)" "$SVC_ID" --rpc-url "$RPC_URL" 2>/dev/null || true)
    BP_WORD=$(echo "$SVC_DATA" | head -c 66)
    BP_NUM=$(echo "$BP_WORD" | sed 's/^0x0*//' | sed 's/^$/0/')

    if [[ "$BP_NUM" == "$BLUEPRINT_ID" && -z "$CLOUD_SERVICE_ID" ]]; then
      CLOUD_SERVICE_ID="$SVC_ID"
    elif [[ "$BP_NUM" == "$INSTANCE_BLUEPRINT_ID" && -z "$INSTANCE_SERVICE_ID" ]]; then
      INSTANCE_SERVICE_ID="$SVC_ID"
    elif [[ "$BP_NUM" == "$TEE_BLUEPRINT_ID" && -z "$TEE_SERVICE_ID" ]]; then
      TEE_SERVICE_ID="$SVC_ID"
    elif [[ "$BP_NUM" == "$VALIDATOR_BLUEPRINT_ID" ]]; then
      VALIDATOR_SERVICE_IDS+=("$SVC_ID")
    fi
  done
fi

if [[ -z "$CLOUD_SERVICE_ID" || -z "$INSTANCE_SERVICE_ID" || -z "$TEE_SERVICE_ID" ]]; then
  echo "ERROR: Failed to resolve all trading service IDs from services $SVC_BEFORE..$((SVC_AFTER - 1))."
  echo "  Cloud=$CLOUD_SERVICE_ID Instance=$INSTANCE_SERVICE_ID TEE=$TEE_SERVICE_ID"
  exit 1
fi

if [[ "$ENABLE_VALIDATOR_SERVICE" == "true" ]]; then
  if [[ "${#VALIDATOR_SERVICE_IDS[@]}" -lt "$N_VALIDATOR_SERVICES" ]]; then
    echo "WARNING: Failed to resolve $N_VALIDATOR_SERVICES validator service(s) from services $SVC_BEFORE..$((SVC_AFTER - 1))."
    echo "  Found: ${VALIDATOR_SERVICE_IDS[*]:-none}"
    echo "  Continuing with direct validator HTTP endpoints only."
    VALIDATOR_SERVICE_IDS=("0")
  fi
else
  VALIDATOR_SERVICE_IDS=("0")
fi

# First validator service (used as default in frontend)
VALIDATOR_SERVICE_ID="${VALIDATOR_SERVICE_IDS[0]}"
# Comma-separated list of all validator service IDs
VALIDATOR_SERVICE_IDS_CSV=$(IFS=,; echo "${VALIDATOR_SERVICE_IDS[*]}")

echo "  Cloud service ID:      $CLOUD_SERVICE_ID"
echo "  Instance service ID:   $INSTANCE_SERVICE_ID"
echo "  TEE service ID:        $TEE_SERVICE_ID"
echo "  Validator service IDs: $VALIDATOR_SERVICE_IDS_CSV"

# ── [6/9] Grant OPERATOR_ROLE via onOperatorJoined ───────────────
echo "[6/9] Granting OPERATOR_ROLE to operators..."

if [[ "$FORK_MODE" == "true" ]]; then
  if [[ -n "$PRECREATED_INSTANCE_VAULT" && -n "$PRECREATED_TEE_VAULT" ]]; then
    INSTANCE_VAULT="$PRECREATED_INSTANCE_VAULT"
    TEE_VAULT="$PRECREATED_TEE_VAULT"
    echo "  Using precreated singleton vaults from bootstrap..."
    echo "  Instance singleton vault: $INSTANCE_VAULT"
    echo "  TEE singleton vault:      $TEE_VAULT"
  else
    echo "  Creating manual singleton vaults for fork mode..."
    INSTANCE_VAULT="$(create_manual_singleton_vault "$INSTANCE_SERVICE_ID" "$DEPLOYER_ADDR" "Instance Vault" "iVAULT")"
    TEE_VAULT="$(create_manual_singleton_vault "$TEE_SERVICE_ID" "$DEPLOYER_ADDR" "TEE Vault" "tVAULT")"
    echo "  Instance manual vault:  $INSTANCE_VAULT"
    echo "  TEE manual vault:       $TEE_VAULT"
  fi
fi

# onOperatorJoined is NOT auto-called during Fixed membership activation.
# We impersonate Tangle to trigger it on both BSMs.
cast rpc anvil_impersonateAccount "$TANGLE" --rpc-url "$RPC_URL" > /dev/null 2>&1

# Trading services — each variant has its own BSM
SERVICE_IDS=("$CLOUD_SERVICE_ID" "$INSTANCE_SERVICE_ID" "$TEE_SERVICE_ID")
SERVICE_BSMS=("$BSM" "$INSTANCE_BSM" "$TEE_BSM")

for idx in 0 1 2; do
  SVC_ID="${SERVICE_IDS[$idx]}"
  SVC_BSM="${SERVICE_BSMS[$idx]}"
  cast send "$SVC_BSM" "onOperatorJoined(uint64,address,uint16)" \
    "$SVC_ID" "$OPERATOR1_ADDR" 10000 \
    --from "$TANGLE" --unlocked --gas-price 0 --priority-gas-price 0 --gas-limit 500000 \
    --rpc-url "$RPC_URL" > /dev/null 2>&1
  cast send "$SVC_BSM" "onOperatorJoined(uint64,address,uint16)" \
    "$SVC_ID" "$OPERATOR2_ADDR" 10000 \
    --from "$TANGLE" --unlocked --gas-price 0 --priority-gas-price 0 --gas-limit 500000 \
    --rpc-url "$RPC_URL" > /dev/null 2>&1
done
echo "  Trading BSMs: OPERATOR_ROLE granted on services $CLOUD_SERVICE_ID, $INSTANCE_SERVICE_ID, $TEE_SERVICE_ID"

# Validator services (use validator BSM — no vaults, just operator tracking)
if [[ "$ENABLE_VALIDATOR_SERVICE" == "true" ]]; then
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
else
  echo "  Validator BSM: skipped on-chain operator join; direct HTTP endpoint mode enabled"
fi

cast rpc anvil_stopImpersonatingAccount "$TANGLE" --rpc-url "$RPC_URL" > /dev/null 2>&1

# ── [6/9] Verify service state ───────────────────────────────────
echo "[6/9] Verifying service state..."
for idx in 0 1 2; do
  SVC_ID="${SERVICE_IDS[$idx]}"
  SVC_BSM="${SERVICE_BSMS[$idx]}"
  BP_NAME="${BLUEPRINT_NAMES[$idx]}"
  PROVISIONED=$(cast call "$SVC_BSM" "instanceProvisioned(uint64)(bool)" "$SVC_ID" --rpc-url "$RPC_URL" 2>&1 | xargs)
  echo "  $BP_NAME (service $SVC_ID): provisioned=$PROVISIONED"
done
if [[ "$ENABLE_VALIDATOR_SERVICE" == "true" ]]; then
  echo "  Validator ($N_VALIDATOR_SERVICES services: $VALIDATOR_SERVICE_IDS_CSV): active (no vaults needed)"
else
  echo "  Validator: direct HTTP endpoint mode active (service IDs disabled)"
fi
echo "  Note: Cloud vaults are created when provision jobs complete; Instance/TEE singleton vaults are created at service init."

if [[ "$FORK_MODE" != "true" ]]; then
  INSTANCE_VAULT=$(cast call "$INSTANCE_BSM" "instanceVault(uint64)(address)" "$INSTANCE_SERVICE_ID" --rpc-url "$RPC_URL" 2>&1 | xargs)
  TEE_VAULT=$(cast call "$TEE_BSM" "instanceVault(uint64)(address)" "$TEE_SERVICE_ID" --rpc-url "$RPC_URL" 2>&1 | xargs)
fi

if [[ "$INSTANCE_VAULT" == "0x0000000000000000000000000000000000000000" ]]; then
  echo "  Instance singleton vault missing; creating manually..."
  INSTANCE_VAULT="$(create_manual_singleton_vault "$INSTANCE_SERVICE_ID" "$DEPLOYER_ADDR" "Instance Vault" "iVAULT")"
fi
if [[ "$TEE_VAULT" == "0x0000000000000000000000000000000000000000" ]]; then
  echo "  TEE singleton vault missing; creating manually..."
  TEE_VAULT="$(create_manual_singleton_vault "$TEE_SERVICE_ID" "$DEPLOYER_ADDR" "TEE Vault" "tVAULT")"
fi

if [[ "$INSTANCE_VAULT" == "0x0000000000000000000000000000000000000000" ]]; then
  echo "ERROR: Instance singleton vault was not created"
  exit 1
fi
if [[ "$TEE_VAULT" == "0x0000000000000000000000000000000000000000" ]]; then
  echo "ERROR: TEE singleton vault was not created"
  exit 1
fi
echo "  Instance vault:         $INSTANCE_VAULT"
echo "  TEE vault:              $TEE_VAULT"

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
  echo "ERROR: cargo-tangle not found at $CARGO_TANGLE"
  echo "Build it: cd ../blueprint && cargo build -p cargo-tangle --release"
  exit 1
fi

# ── [8/9] Write env file ─────────────────────────────────────────
echo "[8/9] Writing arena/.env.local..."

# Build comma-separated service IDs for all variants
ALL_SERVICE_IDS="$CLOUD_SERVICE_ID,$INSTANCE_SERVICE_ID,$TEE_SERVICE_ID"
ETHEREUM_MAINNET_WETH="0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
DEX_ETHEREUM_ASSET_TOKEN="${VITE_DEX_ETHEREUM_ASSET_TOKEN:-$WETH}"
if [[ "$FORK_MODE" == "true" && "${FORK_BASE_CHAIN_ID:-}" == "1" ]]; then
  DEX_ETHEREUM_ASSET_TOKEN="${VITE_DEX_ETHEREUM_ASSET_TOKEN:-$ETHEREUM_MAINNET_WETH}"
fi

cat > arena/.env.local <<EOF
VITE_USE_LOCAL_CHAIN=true
VITE_RPC_URL=$RPC_URL
VITE_CHAIN_ID=$CHAIN_ID
VITE_TANGLE_CONTRACT=$TANGLE
VITE_VAULT_FACTORY=$VAULT_FACTORY
VITE_TRADE_VALIDATOR_ADDRESS=$TRADE_VALIDATOR
VITE_USDC_ADDRESS=$USDC
VITE_WETH_ADDRESS=$WETH
VITE_INSTANCE_VAULT_ADDRESS=$INSTANCE_VAULT
VITE_TEE_VAULT_ADDRESS=$TEE_VAULT
VITE_FORK_MODE=$FORK_MODE
VITE_DEX_ETHEREUM_ENABLED=$FORK_MODE
VITE_DEX_ETHEREUM_CHAIN_ID=$CHAIN_ID
VITE_DEX_ETHEREUM_PROTOCOL_CHAIN_ID=${FORK_BASE_CHAIN_ID:-}
VITE_DEX_ETHEREUM_RPC_URL=$RPC_URL
VITE_DEX_ETHEREUM_VAULT_FACTORY_ADDRESS=$VAULT_FACTORY
VITE_DEX_ETHEREUM_ASSET_TOKEN=$DEX_ETHEREUM_ASSET_TOKEN
VITE_DEX_ETHEREUM_PAPER_TRADE=${VITE_DEX_ETHEREUM_PAPER_TRADE:-false}
VITE_SERVICE_IDS=$ALL_SERVICE_IDS
VITE_BOT_META={"$CLOUD_SERVICE_ID":{"name":"Cloud Demo Bot","strategyType":"dex"},"$INSTANCE_SERVICE_ID":{"name":"Instance Demo Bot","strategyType":"dex"},"$TEE_SERVICE_ID":{"name":"TEE Demo Bot","strategyType":"dex"}}
VITE_OPERATOR_API_URL=/operator-api
VITE_CLOUD_OPERATOR_API_URL=/operator-api
VITE_INSTANCE_OPERATOR_API_URL=/instance-operator-api
VITE_TEE_OPERATOR_API_URL=/instance-operator-api
VITE_OPERATOR_PROXY_TARGET=${VITE_OPERATOR_PROXY_TARGET:-http://localhost:$OPERATOR_API_PORT}
VITE_INSTANCE_OPERATOR_PROXY_TARGET=${VITE_INSTANCE_OPERATOR_PROXY_TARGET:-http://localhost:$INSTANCE_OPERATOR_API_PORT}
VITE_DEFAULT_AI_PROVIDER=zai
VITE_DEFAULT_AI_API_KEY=${ZAI_API_KEY:-}
VITE_TRADING_BLUEPRINT=$BSM
VITE_INSTANCE_TRADING_BLUEPRINT=$INSTANCE_BSM
VITE_TEE_TRADING_BLUEPRINT=$TEE_BSM
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
echo "║ Cloud BSM:      $BSM"
echo "║ Instance BSM:   $INSTANCE_BSM"
echo "║ TEE BSM:        $TEE_BSM"
echo "║ Validator BSM:  $VALIDATOR_BSM"
echo "║ VaultFactory:   $VAULT_FACTORY"
echo "║ TradeValidator: $TRADE_VALIDATOR"
echo "║ USDC:           $USDC"
echo "║ WETH:           $WETH"
echo "╠════════════════════════════════════════════════════════════════════╣"
echo "║ Cloud:     blueprint=$BLUEPRINT_ID  service=$CLOUD_SERVICE_ID"
echo "║ Instance:  blueprint=$INSTANCE_BLUEPRINT_ID  service=$INSTANCE_SERVICE_ID"
echo "║ TEE:       blueprint=$TEE_BLUEPRINT_ID  service=$TEE_SERVICE_ID"
echo "║ Validator: blueprint=$VALIDATOR_BLUEPRINT_ID  services=$VALIDATOR_SERVICE_IDS_CSV"
echo "║ Instance Vault: $INSTANCE_VAULT"
echo "║ TEE Vault:      $TEE_VAULT"
echo "╠════════════════════════════════════════════════════════════════════╣"
echo "║ User:      $USER_ACCOUNT"
echo "║ Operator1: $OPERATOR1_ADDR → gRPC :50051, HTTP :$OPERATOR_API_PORT"
echo "║ Operator2: $OPERATOR2_ADDR → gRPC :50052, HTTP :$INSTANCE_OPERATOR_API_PORT"
echo "╚════════════════════════════════════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo "  1. Start operator binary:  ./target/release/trading-blueprint run ..."
echo "  2. Start validator binary:  ./target/release/trading-validator run ..."
echo "  3. Start frontend:         cd arena && pnpm dev"
echo ""
echo "  All 3 trading variants + validator are visible in the UI."
if [[ "$VALIDATOR_SERVICE_IDS_CSV" == "0" ]]; then
  echo "  Real validation is provided via VALIDATOR_ENDPOINTS; on-chain validator service IDs are disabled in this mode."
else
  echo "  Bots provisioned with validator_service_ids=[$VALIDATOR_SERVICE_IDS_CSV] will use real validation."
fi
echo "  Deploy more: N_VALIDATOR_SERVICES=3 ./scripts/deploy-local.sh"
