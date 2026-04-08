#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

FORK_URL="${FORK_URL:?FORK_URL is required}"
FORK_BLOCK_NUMBER="${FORK_BLOCK_NUMBER:-}"
ANVIL_PORT="${ANVIL_PORT:-8545}"
RPC_URL="${RPC_URL:-http://127.0.0.1:$ANVIL_PORT}"
CHAIN_ID="${CHAIN_ID:-31339}"
ASSET_TOKEN_ADDRESS="${ASSET_TOKEN_ADDRESS:?ASSET_TOKEN_ADDRESS is required}"
EXECUTION_STATE_FILE="${EXECUTION_STATE_FILE:-$ROOT_DIR/.execution-fork.env}"
DEPLOYER_KEY="${DEPLOYER_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
EXECUTION_ADMIN="${EXECUTION_ADMIN:-}"
OPERATOR_ONE="${OPERATOR_ONE:-0x70997970C51812dc3A010C7d01b50e0d17dc79C8}"
OPERATOR_TWO="${OPERATOR_TWO:-0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC}"
EXECUTION_SERVICE_ID="${EXECUTION_SERVICE_ID:-1}"
EXECUTION_REQUIRED_SIGS="${EXECUTION_REQUIRED_SIGS:-1}"
EXECUTION_VAULT_NAME="${EXECUTION_VAULT_NAME:-Execution Vault}"
EXECUTION_VAULT_SYMBOL="${EXECUTION_VAULT_SYMBOL:-xVAULT}"
POLICY_LEVERAGE_CAP="${POLICY_LEVERAGE_CAP:-50000}"
POLICY_MAX_TRADES_PER_HOUR="${POLICY_MAX_TRADES_PER_HOUR:-100}"
POLICY_MAX_SLIPPAGE_BPS="${POLICY_MAX_SLIPPAGE_BPS:-500}"
PERFORMANCE_FEE_BPS="${PERFORMANCE_FEE_BPS:-2000}"
MANAGEMENT_FEE_BPS="${MANAGEMENT_FEE_BPS:-200}"
VALIDATOR_FEE_SHARE_BPS="${VALIDATOR_FEE_SHARE_BPS:-3000}"
WHITELISTED_TOKENS="${WHITELISTED_TOKENS:-}"
WHITELISTED_TARGETS="${WHITELISTED_TARGETS:-}"
TX_GAS_LIMIT="${TX_GAS_LIMIT:-30000000}"
TX_GAS_PRICE_WEI="${TX_GAS_PRICE_WEI:-2000000000}"
TX_RECEIPT_POLL_ATTEMPTS="${TX_RECEIPT_POLL_ATTEMPTS:-30}"

DEPLOYER_ADDRESS="$(cast wallet address --private-key "$DEPLOYER_KEY")"
if [[ -z "$EXECUTION_ADMIN" ]]; then
  EXECUTION_ADMIN="$DEPLOYER_ADDRESS"
fi

csv_to_array_literal() {
  local csv="$1"
  local items=()
  local item=""
  IFS=',' read -r -a items <<< "$csv"
  for i in "${!items[@]}"; do
    item="$(printf '%s' "${items[$i]}" | xargs)"
    items[$i]="$item"
  done
  local result="["
  for item in "${items[@]}"; do
    [[ -n "$item" ]] || continue
    if [[ "$result" != "[" ]]; then
      result+=","
    fi
    result+="$item"
  done
  result+="]"
  printf '%s\n' "$result"
}

wait_for_rpc() {
  for _ in $(seq 1 60); do
    if cast chain-id --rpc-url "$RPC_URL" > /dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "ERROR: execution fork RPC not ready at $RPC_URL" >&2
  exit 1
}

deploy_contract() {
  local artifact_path="$1"
  local constructor_sig="$2"
  shift 2
  local bytecode=""
  local encoded_args=""
  local creation_data=""
  local output=""
  local tx_hash=""
  local receipt=""
  local contract_address=""
  local gas_hex=""
  local gas_price_hex=""

  bytecode="$(jq -r '.bytecode.object' "$artifact_path")"
  if [[ -z "$bytecode" || "$bytecode" == "null" ]]; then
    echo "ERROR: failed to load bytecode from $artifact_path" >&2
    exit 1
  fi

  if [[ "$constructor_sig" == "constructor()" ]]; then
    creation_data="$bytecode"
  else
    encoded_args="$(cast abi-encode "$constructor_sig" "$@")"
    creation_data="${bytecode}${encoded_args#0x}"
  fi

  gas_hex="$(printf '0x%x' "$TX_GAS_LIMIT")"
  gas_price_hex="$(printf '0x%x' "$TX_GAS_PRICE_WEI")"
  if ! output="$(
    cast rpc eth_sendTransaction \
      "{\"from\":\"$DEPLOYER_ADDRESS\",\"data\":\"$creation_data\",\"gas\":\"$gas_hex\",\"gasPrice\":\"$gas_price_hex\"}" \
      --rpc-url "$RPC_URL" 2>&1
  )"; then
    echo "ERROR: failed to deploy artifact $artifact_path" >&2
    echo "$output" >&2
    exit 1
  fi

  tx_hash="$(printf '%s\n' "$output" | tr -d '"' | grep -Eo '0x[0-9a-fA-F]{64}' | tail -n 1)"
  if [[ -z "$tx_hash" ]]; then
    echo "ERROR: failed to parse deployment tx hash for $artifact_path" >&2
    echo "$output" >&2
    exit 1
  fi

  receipt="$(wait_for_receipt "$tx_hash" "deploy $artifact_path")"
  contract_address="$(
    RECEIPT_JSON="$receipt" node -e '
      const receipt = JSON.parse(process.env.RECEIPT_JSON);
      process.stdout.write(String(receipt.contractAddress || ""));
    '
  )"
  if [[ -z "$contract_address" || "$contract_address" == "null" ]]; then
    echo "ERROR: deployment receipt missing contractAddress for $artifact_path" >&2
    echo "$receipt" >&2
    exit 1
  fi
  printf '%s\n' "$contract_address"
}

wait_for_receipt() {
  local tx_hash="$1"
  local label="$2"
  local receipt=""
  local status=""
  for _ in $(seq 1 "$TX_RECEIPT_POLL_ATTEMPTS"); do
    receipt="$(cast rpc eth_getTransactionReceipt "$tx_hash" --rpc-url "$RPC_URL" 2>/dev/null || true)"
    if [[ -n "$receipt" && "$receipt" != "null" ]]; then
      status="$(
        RECEIPT_JSON="$receipt" node -e '
          const receipt = JSON.parse(process.env.RECEIPT_JSON);
          process.stdout.write(String(receipt.status));
        '
      )"
      if [[ "$status" == "0x1" || "$status" == "1" ]]; then
        printf '%s\n' "$receipt"
        return 0
      fi
      echo "ERROR: transaction reverted for $label" >&2
      echo "$receipt" >&2
      exit 1
    fi

    cast rpc anvil_mine 1 --rpc-url "$RPC_URL" > /dev/null 2>&1 || true
    sleep 1
  done

  echo "ERROR: timed out waiting for receipt for $label ($tx_hash)" >&2
  exit 1
}

send_tx() {
  local to="$1"
  local sig="$2"
  shift 2
  local output=""
  local tx_hash=""
  if ! output="$(
    cast send --async "$to" "$sig" "$@" \
      --from "$DEPLOYER_ADDRESS" \
      --unlocked \
      --legacy \
      --gas-price "$TX_GAS_PRICE_WEI" \
      --gas-limit "$TX_GAS_LIMIT" \
      --rpc-url "$RPC_URL" 2>&1
  )"; then
    echo "$output" >&2
    exit 1
  fi

  tx_hash="$(printf '%s\n' "$output" | grep -Eo '0x[0-9a-fA-F]{64}' | tail -n 1)"
  if [[ -z "$tx_hash" ]]; then
    echo "ERROR: failed to parse transaction hash for $sig" >&2
    echo "$output" >&2
    exit 1
  fi

  wait_for_receipt "$tx_hash" "$sig" > /dev/null
}

if lsof -iTCP:"$ANVIL_PORT" -sTCP:LISTEN -n -P > /dev/null 2>&1; then
  echo "ERROR: port $ANVIL_PORT is already in use" >&2
  exit 1
fi

echo "=== Starting execution fork ==="
if [[ -n "$FORK_BLOCK_NUMBER" ]]; then
  anvil --fork-url "$FORK_URL" --fork-block-number "$FORK_BLOCK_NUMBER" --port "$ANVIL_PORT" --chain-id "$CHAIN_ID" --silent &
else
  anvil --fork-url "$FORK_URL" --port "$ANVIL_PORT" --chain-id "$CHAIN_ID" --silent &
fi
ANVIL_PID=$!

cleanup() {
  if kill -0 "$ANVIL_PID" 2>/dev/null; then
    kill "$ANVIL_PID" 2>/dev/null || true
    wait "$ANVIL_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

wait_for_rpc

echo "=== Deploying execution stack ==="
forge build --root "$ROOT_DIR" > /dev/null 2>&1

POLICY_ENGINE="$(deploy_contract "$ROOT_DIR/contracts/out/PolicyEngine.sol/PolicyEngine.json" "constructor()")"
TRADE_VALIDATOR="$(deploy_contract "$ROOT_DIR/contracts/out/TradeValidator.sol/TradeValidator.json" "constructor()")"
FEE_DISTRIBUTOR="$(deploy_contract "$ROOT_DIR/contracts/out/FeeDistributor.sol/FeeDistributor.json" "constructor(address)" "$EXECUTION_ADMIN")"
SHARE_ADDRESS="$(deploy_contract "$ROOT_DIR/contracts/out/VaultShare.sol/VaultShare.json" "constructor(string,string,address)" "$EXECUTION_VAULT_NAME" "$EXECUTION_VAULT_SYMBOL" "$DEPLOYER_ADDRESS")"
VAULT_ADDRESS="$(
  deploy_contract "$ROOT_DIR/contracts/out/TradingVault.sol/TradingVault.json" "constructor(address,address,address,address,address,address,address)" \
    "$ASSET_TOKEN_ADDRESS" "$SHARE_ADDRESS" "$POLICY_ENGINE" "$TRADE_VALIDATOR" "$FEE_DISTRIBUTOR" "$EXECUTION_ADMIN" "$OPERATOR_ONE"
)"

MINTER_ROLE="$(cast keccak "MINTER_ROLE")"
OPERATOR_ROLE="$(cast keccak "OPERATOR_ROLE")"
CREATOR_ROLE="$(cast keccak "CREATOR_ROLE")"
DEFAULT_ADMIN_ROLE="0x0000000000000000000000000000000000000000000000000000000000000000"
SIGNERS_ARRAY="$(csv_to_array_literal "$OPERATOR_ONE,$OPERATOR_TWO")"

send_tx "$SHARE_ADDRESS" "grantRole(bytes32,address)" "$MINTER_ROLE" "$VAULT_ADDRESS"
send_tx "$SHARE_ADDRESS" "linkVault(address)" "$VAULT_ADDRESS"
if [[ "$EXECUTION_ADMIN" != "$DEPLOYER_ADDRESS" ]]; then
  send_tx "$SHARE_ADDRESS" "grantRole(bytes32,address)" "$DEFAULT_ADMIN_ROLE" "$EXECUTION_ADMIN"
fi

send_tx "$TRADE_VALIDATOR" "configureVault(address,address[],uint256)" "$VAULT_ADDRESS" "$SIGNERS_ARRAY" "$EXECUTION_REQUIRED_SIGS"
send_tx "$POLICY_ENGINE" "initializeVault(address,address,(uint256,uint256,uint256))" "$VAULT_ADDRESS" "$EXECUTION_ADMIN" "($POLICY_LEVERAGE_CAP,$POLICY_MAX_TRADES_PER_HOUR,$POLICY_MAX_SLIPPAGE_BPS)"
send_tx "$POLICY_ENGINE" "setAuthorizedCaller(address,bool)" "$VAULT_ADDRESS" true
send_tx "$POLICY_ENGINE" "whitelistToken(address,address,bool)" "$VAULT_ADDRESS" "$ASSET_TOKEN_ADDRESS" true
send_tx "$FEE_DISTRIBUTOR" "initializeVaultFees(address,address,(uint256,uint256,uint256))" "$VAULT_ADDRESS" "$EXECUTION_ADMIN" "($PERFORMANCE_FEE_BPS,$MANAGEMENT_FEE_BPS,$VALIDATOR_FEE_SHARE_BPS)"
send_tx "$VAULT_ADDRESS" "grantRole(bytes32,address)" "$OPERATOR_ROLE" "$OPERATOR_TWO"
send_tx "$VAULT_ADDRESS" "grantRole(bytes32,address)" "$CREATOR_ROLE" "$EXECUTION_ADMIN"

if [[ -n "$WHITELISTED_TOKENS" ]]; then
  IFS=',' read -r -a token_items <<< "$WHITELISTED_TOKENS"
  for token in "${token_items[@]}"; do
    token="$(printf '%s' "$token" | xargs)"
    [[ -n "$token" ]] || continue
    send_tx "$POLICY_ENGINE" "whitelistToken(address,address,bool)" "$VAULT_ADDRESS" "$token" true
  done
fi

if [[ -n "$WHITELISTED_TARGETS" ]]; then
  TARGETS_ARRAY="$(csv_to_array_literal "$WHITELISTED_TARGETS")"
  send_tx "$POLICY_ENGINE" "setTargetWhitelist(address,address[],bool)" "$VAULT_ADDRESS" "$TARGETS_ARRAY" true
fi

cat > "$EXECUTION_STATE_FILE" <<EOF
EXECUTION_RPC_URL=$RPC_URL
EXECUTION_CHAIN_ID=$CHAIN_ID
EXECUTION_DEPLOYER_ADDRESS=$DEPLOYER_ADDRESS
EXECUTION_ADMIN=$EXECUTION_ADMIN
EXECUTION_OPERATOR_ONE=$OPERATOR_ONE
EXECUTION_OPERATOR_TWO=$OPERATOR_TWO
EXECUTION_SERVICE_ID=$EXECUTION_SERVICE_ID
EXECUTION_ASSET_TOKEN=$ASSET_TOKEN_ADDRESS
EXECUTION_POLICY_ENGINE=$POLICY_ENGINE
EXECUTION_TRADE_VALIDATOR=$TRADE_VALIDATOR
EXECUTION_FEE_DISTRIBUTOR=$FEE_DISTRIBUTOR
EXECUTION_VAULT_ADDRESS=$VAULT_ADDRESS
EXECUTION_SHARE_ADDRESS=$SHARE_ADDRESS
EOF

echo "Execution fork ready."
echo "  RPC URL:         $RPC_URL"
echo "  Chain ID:        $CHAIN_ID"
echo "  Asset token:     $ASSET_TOKEN_ADDRESS"
echo "  Vault:           $VAULT_ADDRESS"
echo "  TradeValidator:  $TRADE_VALIDATOR"
echo "  State file:      $EXECUTION_STATE_FILE"

wait "$ANVIL_PID"
