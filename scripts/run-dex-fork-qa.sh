#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

FORK_URL="${FORK_URL:?FORK_URL is required}"
FORK_BLOCK_NUMBER="${FORK_BLOCK_NUMBER:-}"
CHAIN_ID="${CHAIN_ID:-31339}"
ANVIL_PORT="${ANVIL_PORT:-8545}"
RPC_URL="${RPC_URL:-http://127.0.0.1:$ANVIL_PORT}"
WS_RPC_URL="${WS_RPC_URL:-ws://127.0.0.1:$ANVIL_PORT}"
OPERATOR_API_PORT="${OPERATOR_API_PORT:-9200}"
INSTANCE_OPERATOR_API_PORT="${INSTANCE_OPERATOR_API_PORT:-9201}"
TRADING_API_PORT="${TRADING_API_PORT:-9100}"
INSTANCE_TRADING_API_PORT="${INSTANCE_TRADING_API_PORT:-9101}"
VALIDATOR_HTTP_PORT="${VALIDATOR_HTTP_PORT:-9090}"
EXISTING_USDC_ADDRESS="${EXISTING_USDC_ADDRESS:-0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48}"
EXISTING_WETH_ADDRESS="${EXISTING_WETH_ADDRESS:-0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2}"
ASSET_TOKEN_ADDRESS="${ASSET_TOKEN_ADDRESS:-$EXISTING_USDC_ADDRESS}"
TARGET_TOKEN_ADDRESS="${TARGET_TOKEN_ADDRESS:-$EXISTING_WETH_ADDRESS}"
WHALE_ADDRESS="${WHALE_ADDRESS:-}"
DEPOSIT_AMOUNT_RAW="${DEPOSIT_AMOUNT_RAW:-10000000000}"
SESSION_SIGNER_KEY="${SESSION_SIGNER_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
SESSION_SIGNER_ADDRESS="${SESSION_SIGNER_ADDRESS:-0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266}"
DEPOSITOR_KEY="${DEPOSITOR_KEY:-$SESSION_SIGNER_KEY}"
DEPOSITOR_ADDRESS="${DEPOSITOR_ADDRESS:-$SESSION_SIGNER_ADDRESS}"
TRADE_AMOUNT_RAW="${TRADE_AMOUNT_RAW:-10000000}"
MIN_AMOUNT_OUT_RAW="${MIN_AMOUNT_OUT_RAW:-1}"
AUTO_ACTIVATE_BOT="${AUTO_ACTIVATE_BOT:-false}"
START_UI="${START_UI:-false}"
SELF_WRAP_ETH="${SELF_WRAP_ETH:-false}"

DEVNET_PID=""

cleanup() {
  if [[ -n "$DEVNET_PID" ]] && kill -0 "$DEVNET_PID" 2>/dev/null; then
    kill "$DEVNET_PID" 2>/dev/null || true
    wait "$DEVNET_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

wait_for_http() {
  local url="$1"
  local label="$2"
  for _ in $(seq 1 300); do
    if curl -fsS "$url" > /dev/null 2>&1; then
      echo "  $label ready at $url"
      return 0
    fi
    sleep 1
  done
  echo "ERROR: $label did not become ready at $url"
  exit 1
}

json_read() {
  local expr="$1"
  node -e '
    const fs = require("fs");
    const obj = JSON.parse(fs.readFileSync(0, "utf8"));
    const value = Function("obj", "return " + process.argv[1])(obj);
    if (value === undefined || value === null) process.exit(1);
    process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
  ' "$expr"
}

echo "=== Starting fork QA stack ==="
if [[ "$SELF_WRAP_ETH" != "true" && -z "$WHALE_ADDRESS" ]]; then
  echo "ERROR: WHALE_ADDRESS is required unless SELF_WRAP_ETH=true"
  exit 1
fi

if [[ "$START_UI" == "true" ]]; then
  FORK_URL="$FORK_URL" \
  FORK_BLOCK_NUMBER="$FORK_BLOCK_NUMBER" \
  FORK_MODE=true \
  CHAIN_ID="$CHAIN_ID" \
  ANVIL_PORT="$ANVIL_PORT" \
  RPC_URL="$RPC_URL" \
  WS_RPC_URL="$WS_RPC_URL" \
  OPERATOR_API_PORT="$OPERATOR_API_PORT" \
  INSTANCE_OPERATOR_API_PORT="$INSTANCE_OPERATOR_API_PORT" \
  TRADING_API_PORT="$TRADING_API_PORT" \
  INSTANCE_TRADING_API_PORT="$INSTANCE_TRADING_API_PORT" \
  VALIDATOR_HTTP_PORT="$VALIDATOR_HTTP_PORT" \
  EXISTING_USDC_ADDRESS="$EXISTING_USDC_ADDRESS" \
  EXISTING_WETH_ADDRESS="$EXISTING_WETH_ADDRESS" \
  ASSET_TOKEN_ADDRESS="$ASSET_TOKEN_ADDRESS" \
  "$SCRIPT_DIR/run-devnet.sh" --reset-state &
else
  FORK_URL="$FORK_URL" \
  FORK_BLOCK_NUMBER="$FORK_BLOCK_NUMBER" \
  FORK_MODE=true \
  CHAIN_ID="$CHAIN_ID" \
  ANVIL_PORT="$ANVIL_PORT" \
  RPC_URL="$RPC_URL" \
  WS_RPC_URL="$WS_RPC_URL" \
  OPERATOR_API_PORT="$OPERATOR_API_PORT" \
  INSTANCE_OPERATOR_API_PORT="$INSTANCE_OPERATOR_API_PORT" \
  TRADING_API_PORT="$TRADING_API_PORT" \
  INSTANCE_TRADING_API_PORT="$INSTANCE_TRADING_API_PORT" \
  VALIDATOR_HTTP_PORT="$VALIDATOR_HTTP_PORT" \
  EXISTING_USDC_ADDRESS="$EXISTING_USDC_ADDRESS" \
  EXISTING_WETH_ADDRESS="$EXISTING_WETH_ADDRESS" \
  ASSET_TOKEN_ADDRESS="$ASSET_TOKEN_ADDRESS" \
  "$SCRIPT_DIR/run-devnet.sh" --no-ui --reset-state &
fi
DEVNET_PID=$!

wait_for_http "http://localhost:$INSTANCE_OPERATOR_API_PORT/api/meta" "Instance operator"
wait_for_http "http://localhost:$INSTANCE_TRADING_API_PORT/health" "Instance trading API"

INSTANCE_VAULT_ADDRESS="$(grep '^VITE_INSTANCE_VAULT_ADDRESS=' "$ROOT_DIR/arena/.env.local" | cut -d= -f2)"
VALIDATOR_SERVICE_ID="$(grep '^VITE_VALIDATOR_SERVICE_ID=' "$ROOT_DIR/arena/.env.local" | cut -d= -f2)"
if [[ -z "$INSTANCE_VAULT_ADDRESS" ]]; then
  echo "ERROR: failed to read instance vault from arena/.env.local"
  exit 1
fi

VALIDATOR_SERVICE_IDS_JSON="[]"
if [[ -n "$VALIDATOR_SERVICE_ID" && "$VALIDATOR_SERVICE_ID" != "0" ]]; then
  VALIDATOR_SERVICE_IDS_JSON="[$VALIDATOR_SERVICE_ID]"
fi

echo "=== Seeding singleton vault ==="
ASSET_TOKEN_ADDRESS="$ASSET_TOKEN_ADDRESS" \
VAULT_ADDRESS="$INSTANCE_VAULT_ADDRESS" \
WHALE_ADDRESS="$WHALE_ADDRESS" \
DEPOSIT_AMOUNT_RAW="$DEPOSIT_AMOUNT_RAW" \
DEPOSITOR_KEY="$DEPOSITOR_KEY" \
DEPOSITOR_ADDRESS="$DEPOSITOR_ADDRESS" \
RECEIVER_ADDRESS="$DEPOSITOR_ADDRESS" \
SELF_WRAP_ETH="$SELF_WRAP_ETH" \
RPC_URL="$RPC_URL" \
  "$SCRIPT_DIR/seed-fork-vault.sh"

"$SCRIPT_DIR/fork-snapshot.sh"

echo "=== Authenticating with instance operator ==="
challenge_json="$(curl -fsS -X POST "http://localhost:$INSTANCE_OPERATOR_API_PORT/api/auth/challenge")"
nonce="$(printf '%s' "$challenge_json" | json_read 'obj.nonce')"
message="$(printf '%s' "$challenge_json" | json_read 'obj.message')"
signature="$(cast wallet sign --private-key "$SESSION_SIGNER_KEY" "$message" | tr -d '\n')"
session_json="$(curl -fsS -X POST "http://localhost:$INSTANCE_OPERATOR_API_PORT/api/auth/session" \
  -H 'Content-Type: application/json' \
  --data "{\"nonce\":\"$nonce\",\"signature\":\"$signature\"}")"
session_token="$(printf '%s' "$session_json" | json_read 'obj.token')"

echo "=== Provisioning instance bot ==="
provision_payload="$(cat <<EOF
{"name":"Fork QA Dex Bot","strategy_type":"dex","strategy_config_json":"{\"paper_trade\":false,\"custom_instructions\":\"Trade only the canonical USDC/WETH pair on Uniswap V3.\"}","risk_params_json":"{}","chain_id":$CHAIN_ID,"rpc_url":"$RPC_URL","vault_address":"$INSTANCE_VAULT_ADDRESS","asset_token":"$ASSET_TOKEN_ADDRESS","paper_trade":false,"validator_service_ids":$VALIDATOR_SERVICE_IDS_JSON}
EOF
)"
curl -fsS -X POST "http://localhost:$INSTANCE_OPERATOR_API_PORT/api/bot/provision" \
  -H "Authorization: Bearer $session_token" \
  -H 'Content-Type: application/json' \
  --data "$provision_payload" > /dev/null

bot_json="$(curl -fsS "http://localhost:$INSTANCE_OPERATOR_API_PORT/api/bot" \
  -H "Authorization: Bearer $session_token")"
bot_id="$(printf '%s' "$bot_json" | json_read 'obj.id')"
trading_api_token="$(printf '%s' "$bot_json" | json_read 'obj.trading_api_token')"
paper_trade_flag="$(printf '%s' "$bot_json" | json_read 'String(obj.paper_trade)')"

if [[ "$paper_trade_flag" != "false" ]]; then
  echo "ERROR: instance bot provisioned in paper mode"
  exit 1
fi

if [[ "$AUTO_ACTIVATE_BOT" == "true" ]]; then
  echo "=== Activating bot workflow ==="
  curl -fsS -X POST "http://localhost:$INSTANCE_OPERATOR_API_PORT/api/bot/secrets" \
    -H "Authorization: Bearer $session_token" \
    -H 'Content-Type: application/json' \
    --data '{"env_json":{}}' > /dev/null
fi

echo "=== Validating live swap ==="
validate_payload="$(cat <<EOF
{"strategy_id":"fork-qa","action":"swap","token_in":"$ASSET_TOKEN_ADDRESS","token_out":"$TARGET_TOKEN_ADDRESS","amount_in":"$TRADE_AMOUNT_RAW","min_amount_out":"$MIN_AMOUNT_OUT_RAW","target_protocol":"uniswap_v3","deadline_secs":300}
EOF
)"
validate_json="$(curl -fsS -X POST "http://localhost:$INSTANCE_TRADING_API_PORT/validate" \
  -H "Authorization: Bearer $trading_api_token" \
  -H 'Content-Type: application/json' \
  --data "$validate_payload")"

approved="$(printf '%s' "$validate_json" | json_read 'String(obj.approved)')"
if [[ "$approved" != "true" ]]; then
  echo "ERROR: validator rejected live fork trade"
  printf '%s\n' "$validate_json"
  exit 1
fi

echo "=== Executing live swap ==="
execute_payload="$(node -e '
  const validate = JSON.parse(process.argv[1]);
  const execute = {
    intent: JSON.parse(process.argv[2]),
    validation: {
      approved: validate.approved,
      aggregate_score: validate.aggregate_score,
      intent_hash: validate.intent_hash,
      validator_responses: validate.validator_responses
    }
  };
  process.stdout.write(JSON.stringify(execute));
' "$validate_json" "$validate_payload")"
execute_json="$(curl -fsS -X POST "http://localhost:$INSTANCE_TRADING_API_PORT/execute" \
  -H "Authorization: Bearer $trading_api_token" \
  -H 'Content-Type: application/json' \
  --data "$execute_payload")"
tx_hash="$(printf '%s' "$execute_json" | json_read 'obj.tx_hash')"
execute_paper_trade="$(printf '%s' "$execute_json" | json_read 'String(obj.paper_trade)')"
if [[ "$execute_paper_trade" != "false" ]]; then
  echo "ERROR: execute path still returned paper_trade=true"
  printf '%s\n' "$execute_json"
  exit 1
fi

trades_json="$(curl -fsS "http://localhost:$INSTANCE_TRADING_API_PORT/trades" \
  -H "Authorization: Bearer $trading_api_token")"
trade_count="$(printf '%s' "$trades_json" | json_read 'String(obj.total ?? (obj.trades ? obj.trades.length : 0))')"
if [[ "$trade_count" -lt 1 ]]; then
  echo "ERROR: no trades recorded after execute"
  exit 1
fi

echo ""
echo "Fork QA verification succeeded."
echo "  Bot ID:            $bot_id"
echo "  Instance vault:    $INSTANCE_VAULT_ADDRESS"
echo "  Trading API token: $trading_api_token"
echo "  Live tx hash:      $tx_hash"
echo "  Trades stored:     $trade_count"
echo ""
echo "Services are still running. Press Ctrl+C to stop them."

trap - EXIT INT TERM
wait "$DEVNET_PID"
