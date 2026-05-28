#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/arena/.env.local"
HYPEREVM_ENV="${HYPEREVM_ENV:-mainnet}"

get_env() {
  awk -F= -v key="$1" '$1 == key { sub($1"=", ""); print; exit }' "$ENV_FILE"
}

json_get() {
  ruby -rjson -e 'puts JSON.parse(File.read(ARGV[0])).fetch(ARGV[1], "")' "$1" "$2"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: required command '$1' is not available" >&2
    exit 1
  fi
}

stop_port() {
  local port="$1"
  local pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "Stopping listener(s) on :$port"
    kill $pids 2>/dev/null || true
    sleep 1
  fi
}

wait_for_http() {
  local url="$1"
  local label="$2"
  for _ in {1..60}; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "  $label ready: $url"
      return 0
    fi
    sleep 1
  done
  echo "ERROR: $label did not become ready: $url" >&2
  return 1
}

require_cmd cast
require_cmd curl
require_cmd docker
require_cmd lsof
require_cmd ruby

case "$HYPEREVM_ENV" in
  mainnet)
    DEFAULT_HYPEREVM_RPC_URL="$(get_env VITE_HYPEREVM_MAINNET_RPC_URL)"
    DEFAULT_HYPEREVM_CHAIN_ID="$(get_env VITE_HYPEREVM_MAINNET_CHAIN_ID)"
    DEFAULT_HYPERLIQUID_TESTNET="false"
    DEFAULT_HYPERLIQUID_INFO_URL="https://api.hyperliquid.xyz/info"
    ;;
  testnet)
    DEFAULT_HYPEREVM_RPC_URL="$(get_env VITE_HYPEREVM_TESTNET_RPC_URL)"
    DEFAULT_HYPEREVM_CHAIN_ID="$(get_env VITE_HYPEREVM_TESTNET_CHAIN_ID)"
    DEFAULT_HYPERLIQUID_TESTNET="true"
    DEFAULT_HYPERLIQUID_INFO_URL="https://api.hyperliquid-testnet.xyz/info"
    ;;
  *)
    echo "ERROR: HYPEREVM_ENV must be mainnet or testnet" >&2
    exit 2
    ;;
esac

LOCAL_RPC_URL="${LOCAL_RPC_URL:-$(get_env VITE_RPC_URL)}"
LOCAL_CHAIN_ID="${LOCAL_CHAIN_ID:-$(get_env VITE_CHAIN_ID)}"
LOCAL_WS_RPC_URL="${LOCAL_WS_RPC_URL:-${LOCAL_RPC_URL/http:/ws:}}"
HYPEREVM_RPC_URL="${HYPEREVM_RPC_URL:-$DEFAULT_HYPEREVM_RPC_URL}"
HYPEREVM_CHAIN_ID="${HYPEREVM_CHAIN_ID:-$DEFAULT_HYPEREVM_CHAIN_ID}"
HYPERLIQUID_TESTNET="${HYPERLIQUID_TESTNET:-$DEFAULT_HYPERLIQUID_TESTNET}"
HYPERLIQUID_INFO_URL="${HYPERLIQUID_INFO_URL:-$DEFAULT_HYPERLIQUID_INFO_URL}"

if [[ -z "$HYPEREVM_RPC_URL" || -z "$HYPEREVM_CHAIN_ID" ]]; then
  echo "ERROR: HYPEREVM_RPC_URL and HYPEREVM_CHAIN_ID are required" >&2
  exit 2
fi

PRIVATE_KEY_FILE="${PRIVATE_KEY_FILE:-$ROOT_DIR/.tmp/secrets/hyperevm-deployer.key}"
API_WALLET_KEY_FILE="${API_WALLET_KEY_FILE:-$ROOT_DIR/.tmp/secrets/hyperliquid-canary-api-wallet.key}"
EXPECTED_OPERATOR_ADDRESS="${EXPECTED_OPERATOR_ADDRESS:-0xb607A500574fE29afb0d0681f1dC3E82f79f4877}"
HYPERLIQUID_VAULT_MANIFEST="${HYPERLIQUID_VAULT_MANIFEST:-$ROOT_DIR/deployments/$HYPEREVM_CHAIN_ID/hyperliquid-vault.json}"

if [[ ! -f "$HYPERLIQUID_VAULT_MANIFEST" ]]; then
  echo "ERROR: missing HyperEVM vault manifest: $HYPERLIQUID_VAULT_MANIFEST" >&2
  exit 2
fi
if [[ ! -f "$PRIVATE_KEY_FILE" ]]; then
  echo "ERROR: missing HyperEVM private key file: $PRIVATE_KEY_FILE" >&2
  exit 2
fi

PRIVATE_KEY="$(tr -d '\r\n\t ' < "$PRIVATE_KEY_FILE")"
if [[ -n "${HYPERLIQUID_API_WALLET_PRIVATE_KEY:-}" ]]; then
  API_WALLET_PRIVATE_KEY="$HYPERLIQUID_API_WALLET_PRIVATE_KEY"
elif [[ -f "$API_WALLET_KEY_FILE" ]]; then
  API_WALLET_PRIVATE_KEY="$(tr -d '\r\n\t ' < "$API_WALLET_KEY_FILE")"
else
  if [[ "$HYPEREVM_CHAIN_ID" == "998" || "$HYPEREVM_CHAIN_ID" == "999" ]]; then
    echo "ERROR: missing dedicated Hyperliquid API wallet key for HyperEVM chain $HYPEREVM_CHAIN_ID" >&2
    echo "Set HYPERLIQUID_API_WALLET_PRIVATE_KEY or create $API_WALLET_KEY_FILE with a fresh trading-only key." >&2
    exit 2
  fi
  API_WALLET_PRIVATE_KEY="$PRIVATE_KEY"
fi

OPERATOR_ADDRESS="$(cast wallet address --private-key "$PRIVATE_KEY")"
if [[ "$(printf '%s' "$OPERATOR_ADDRESS" | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$EXPECTED_OPERATOR_ADDRESS" | tr '[:upper:]' '[:lower:]')" ]]; then
  echo "ERROR: private key resolves to $OPERATOR_ADDRESS, expected $EXPECTED_OPERATOR_ADDRESS" >&2
  exit 2
fi
API_WALLET_ADDRESS="$(cast wallet address --private-key "$API_WALLET_PRIVATE_KEY")"
if [[ "$HYPEREVM_CHAIN_ID" == "998" || "$HYPEREVM_CHAIN_ID" == "999" ]]; then
  if [[ "$(printf '%s' "$API_WALLET_ADDRESS" | tr '[:upper:]' '[:lower:]')" == "$(printf '%s' "$OPERATOR_ADDRESS" | tr '[:upper:]' '[:lower:]')" ]]; then
    echo "ERROR: HyperEVM chain $HYPEREVM_CHAIN_ID requires a dedicated API wallet key; $API_WALLET_ADDRESS matches the operator wallet" >&2
    echo "Set HYPERLIQUID_API_WALLET_PRIVATE_KEY or create $API_WALLET_KEY_FILE with a fresh trading-only key." >&2
    exit 2
  fi
fi

if [[ "$(cast chain-id --rpc-url "$LOCAL_RPC_URL")" != "$LOCAL_CHAIN_ID" ]]; then
  echo "ERROR: local RPC $LOCAL_RPC_URL does not report chain $LOCAL_CHAIN_ID" >&2
  exit 2
fi
if [[ "$(cast chain-id --rpc-url "$HYPEREVM_RPC_URL")" != "$HYPEREVM_CHAIN_ID" ]]; then
  echo "ERROR: HyperEVM RPC $HYPEREVM_RPC_URL does not report chain $HYPEREVM_CHAIN_ID" >&2
  exit 2
fi

HYPEREVM_FACTORY_ADDRESS="${HYPEREVM_FACTORY_ADDRESS:-$(json_get "$HYPERLIQUID_VAULT_MANIFEST" vaultFactory)}"
HYPEREVM_ASSET_TOKEN="${HYPEREVM_ASSET_TOKEN:-$(json_get "$HYPERLIQUID_VAULT_MANIFEST" assetToken)}"
HYPERLIQUID_TRADE_VALIDATOR_ADDRESS="$(json_get "$HYPERLIQUID_VAULT_MANIFEST" tradeValidator)"

OPERATOR_API_PORT="${OPERATOR_API_PORT:-9200}"
INSTANCE_OPERATOR_API_PORT="${INSTANCE_OPERATOR_API_PORT:-9201}"
TRADING_API_PORT="${TRADING_API_PORT:-9100}"
INSTANCE_TRADING_API_PORT="${INSTANCE_TRADING_API_PORT:-9101}"
VALIDATOR_HTTP_PORT="${VALIDATOR_HTTP_PORT:-9090}"
VALIDATOR_ENDPOINT_COUNT="${VALIDATOR_ENDPOINT_COUNT:-2}"
PRICING_ENGINE_PORTS="${PRICING_ENGINE_PORTS:-50051 50052}"

CLOUD_SERVICE_ID="$(get_env VITE_SERVICE_IDS | cut -d, -f1)"
INSTANCE_SERVICE_ID="$(get_env VITE_SERVICE_IDS | cut -d, -f2)"
VALIDATOR_SERVICE_ID="$(get_env VITE_VALIDATOR_SERVICE_ID)"
CLOUD_BLUEPRINT_ID="$(get_env VITE_BLUEPRINT_ID)"
INSTANCE_BLUEPRINT_ID="$(get_env VITE_INSTANCE_BLUEPRINT_ID)"
VALIDATOR_BLUEPRINT_ID="$(get_env VITE_VALIDATOR_BLUEPRINT_ID)"
CLOUD_BSM_ADDRESS="$(get_env VITE_TRADING_BLUEPRINT)"
INSTANCE_BSM_ADDRESS="$(get_env VITE_INSTANCE_TRADING_BLUEPRINT)"
INSTANCE_VAULT_ADDRESS="$(get_env VITE_INSTANCE_VAULT_ADDRESS)"
VALIDATOR_VERIFYING_CONTRACT="${EXECUTION_TRADE_VALIDATOR_ADDRESS:-$HYPERLIQUID_TRADE_VALIDATOR_ADDRESS}"

DOCKER_SOCKET="${DOCKER_HOST:-}"
if [[ -z "$DOCKER_SOCKET" ]]; then
  if [[ -S "$HOME/.docker/run/docker.sock" ]]; then
    DOCKER_SOCKET="unix://$HOME/.docker/run/docker.sock"
  elif [[ -S "$HOME/.orbstack/run/docker.sock" ]]; then
    DOCKER_SOCKET="unix://$HOME/.orbstack/run/docker.sock"
  elif [[ -S "/var/run/docker.sock" ]]; then
    DOCKER_SOCKET="unix:///var/run/docker.sock"
  fi
fi

SIDECAR_IMAGE_NAME="${SIDECAR_IMAGE:-tangle-sidecar:local}"
HOST_ARCH="$(uname -m)"
SIDECAR_IMAGE_ARCH="$(DOCKER_HOST="$DOCKER_SOCKET" docker image inspect "$SIDECAR_IMAGE_NAME" --format '{{.Architecture}}' 2>/dev/null || true)"
if [[ -z "$SIDECAR_IMAGE_ARCH" ]]; then
  echo "ERROR: missing sidecar image: $SIDECAR_IMAGE_NAME" >&2
  echo "Build it first, for this Mac, with:" >&2
  echo "  cd ../agent-dev-container && ./scripts/rebuild-sidecar.sh --local --tag $SIDECAR_IMAGE_NAME" >&2
  exit 2
fi
if [[ "$HOST_ARCH" == "arm64" && "$SIDECAR_IMAGE_ARCH" != "arm64" ]]; then
  echo "ERROR: $SIDECAR_IMAGE_NAME is linux/$SIDECAR_IMAGE_ARCH but this Mac is arm64." >&2
  echo "Rebuild the sidecar natively with:" >&2
  echo "  cd ../agent-dev-container && ./scripts/rebuild-sidecar.sh --local --tag $SIDECAR_IMAGE_NAME" >&2
  exit 2
fi

cd "$ROOT_DIR"
mkdir -p .tmp

for port in $PRICING_ENGINE_PORTS "$VALIDATOR_HTTP_PORT" "$((VALIDATOR_HTTP_PORT + 1))" "$TRADING_API_PORT" "$INSTANCE_TRADING_API_PORT" "$OPERATOR_API_PORT" "$INSTANCE_OPERATOR_API_PORT"; do
  stop_port "$port"
done

pids=()
cleanup() {
  for pid in "${pids[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup INT TERM EXIT

LOAD_BASE_SEPOLIA=false HTTP_RPC_URL="$LOCAL_RPC_URL" WS_RPC_URL="$LOCAL_WS_RPC_URL" \
  bash scripts/run-pricing-engine.sh --config scripts/operator1.toml \
  > .tmp/hyperevm-qa-pricing-1.log 2>&1 &
pids+=("$!")

LOAD_BASE_SEPOLIA=false HTTP_RPC_URL="$LOCAL_RPC_URL" WS_RPC_URL="$LOCAL_WS_RPC_URL" \
  bash scripts/run-pricing-engine.sh --config scripts/operator2.toml \
  > .tmp/hyperevm-qa-pricing-2.log 2>&1 &
pids+=("$!")

DEFAULT_VALIDATOR_ENDPOINTS=""
for ((i = 0; i < VALIDATOR_ENDPOINT_COUNT; i++)); do
  port=$((VALIDATOR_HTTP_PORT + i))
  DEFAULT_VALIDATOR_ENDPOINTS+="${DEFAULT_VALIDATOR_ENDPOINTS:+,}http://127.0.0.1:$port"
  if (( i % 2 == 0 )); then
    validator_operator_address="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
    validator_private_key="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
    validator_keystore="$ROOT_DIR/scripts/data/operator1/keystore"
  else
    validator_operator_address="0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
    validator_private_key="0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"
    validator_keystore="$ROOT_DIR/scripts/data/operator2/keystore"
  fi

  RUST_LOG="${RUST_LOG:-info,tangle=debug,trading=debug}" \
  KEEP_HTTP_APIS_ALIVE_AFTER_RUNNER_EXIT=true \
  SERVICE_ID="$VALIDATOR_SERVICE_ID" \
  BLUEPRINT_ID="$VALIDATOR_BLUEPRINT_ID" \
  CHAIN_ID="$LOCAL_CHAIN_ID" \
  EXECUTION_CHAIN_ID="$HYPEREVM_CHAIN_ID" \
  FORK_BASE_CHAIN_ID="$HYPEREVM_CHAIN_ID" \
  PROTOCOL_CHAIN_ID="$HYPEREVM_CHAIN_ID" \
  RPC_URL="$LOCAL_RPC_URL" \
  HTTP_RPC_URL="$LOCAL_RPC_URL" \
  EXECUTION_RPC_URL="$HYPEREVM_RPC_URL" \
  VALIDATOR_RPC_URL="$HYPEREVM_RPC_URL" \
  VALIDATOR_HTTP_PORT="$port" \
  EXECUTION_TRADE_VALIDATOR_ADDRESS="$VALIDATOR_VERIFYING_CONTRACT" \
  VERIFYING_CONTRACT="$VALIDATOR_VERIFYING_CONTRACT" \
  OPERATOR_ADDRESS="$validator_operator_address" \
  PRIVATE_KEY="$validator_private_key" \
  TANGLE_CONTRACT="0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9" \
  STAKING_CONTRACT="0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" \
  STATUS_REGISTRY_CONTRACT="0x99bbA657f2BbC93c02D617f8bA121cB8Fc104Acf" \
  STATUS_REGISTRY_ADDRESS="0x99bbA657f2BbC93c02D617f8bA121cB8Fc104Acf" \
    target/release/trading-validator run \
      --http-rpc-url "$LOCAL_RPC_URL" \
      --ws-rpc-url "$LOCAL_WS_RPC_URL" \
      --keystore-uri "$validator_keystore" \
      --data-dir "$ROOT_DIR/blueprint-state/validator-$((i + 1))" \
      --protocol tangle -t \
      > ".tmp/hyperevm-qa-validator-$((i + 1)).log" 2>&1 &
  pids+=("$!")
done

COMMON_OPERATOR_ENV=(
  RUST_LOG="${RUST_LOG:-info,tangle=debug,trading=debug}"
  KEEP_HTTP_APIS_ALIVE_AFTER_RUNNER_EXIT=true
  ALLOW_LOOPBACK_RPC_URLS=true
  LOCAL_ANVIL_REPLAY_JOB_RESULT="${LOCAL_ANVIL_REPLAY_JOB_RESULT:-false}"
  DISABLE_TANGLE_PRODUCER="${DISABLE_TANGLE_PRODUCER:-false}"
  RPC_URL="$LOCAL_RPC_URL"
  HTTP_RPC_URL="$HYPEREVM_RPC_URL"
  CHAIN_ID="$HYPEREVM_CHAIN_ID"
  FORK_BASE_CHAIN_ID="$HYPEREVM_CHAIN_ID"
  PROTOCOL_CHAIN_ID="$HYPEREVM_CHAIN_ID"
  VAULT_FACTORY_ADDRESS="$HYPEREVM_FACTORY_ADDRESS"
  EXECUTION_VAULT_FACTORY_ADDRESS="$HYPEREVM_FACTORY_ADDRESS"
  ASSET_TOKEN_ADDRESS="$HYPEREVM_ASSET_TOKEN"
  USDC_ADDRESS="$HYPEREVM_ASSET_TOKEN"
  EXECUTION_ASSET_TOKEN="$HYPEREVM_ASSET_TOKEN"
  HYPERLIQUID_TESTNET="$HYPERLIQUID_TESTNET"
  HYPERLIQUID_INFO_URL="$HYPERLIQUID_INFO_URL"
  HYPERLIQUID_API_WALLET_PRIVATE_KEY="$API_WALLET_PRIVATE_KEY"
  OPERATOR_ADDRESS="$OPERATOR_ADDRESS"
  PRIVATE_KEY="$PRIVATE_KEY"
  TANGLE_CONTRACT="0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9"
  STAKING_CONTRACT="0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"
  STATUS_REGISTRY_CONTRACT="0x99bbA657f2BbC93c02D617f8bA121cB8Fc104Acf"
  SESSION_AUTH_SECRET="${SESSION_AUTH_SECRET:-dev-secret-key-do-not-use-in-production}"
  SIDECAR_IMAGE="$SIDECAR_IMAGE_NAME"
  SIDECAR_PULL_IMAGE="${SIDECAR_PULL_IMAGE:-false}"
  SIDECAR_PUBLIC_HOST="${SIDECAR_PUBLIC_HOST:-127.0.0.1}"
  VALIDATOR_ENDPOINTS="$DEFAULT_VALIDATOR_ENDPOINTS"
  WORKFLOW_CRON_SCHEDULE="${WORKFLOW_CRON_SCHEDULE:-0 * * * * *}"
  FEE_SETTLEMENT_INTERVAL_SECS=999999
  BILLING_INTERVAL_SECS=999999
)

env \
  DOCKER_HOST="$DOCKER_SOCKET" \
  "${COMMON_OPERATOR_ENV[@]}" \
  SERVICE_ID="$CLOUD_SERVICE_ID" \
  BLUEPRINT_ID="$CLOUD_BLUEPRINT_ID" \
  TRADING_BLUEPRINT_ADDRESS="$CLOUD_BSM_ADDRESS" \
  OPERATOR_API_PORT="$OPERATOR_API_PORT" \
  TRADING_API_PORT="$TRADING_API_PORT" \
  BLUEPRINT_STATE_DIR="$ROOT_DIR/blueprint-state/cloud" \
    target/release/trading-blueprint run \
      --http-rpc-url "$LOCAL_RPC_URL" \
      --ws-rpc-url "$LOCAL_WS_RPC_URL" \
      --keystore-uri "$ROOT_DIR/scripts/data/operator1/keystore" \
      --data-dir "$ROOT_DIR/blueprint-state/cloud" \
      --protocol tangle -t \
      > .tmp/hyperevm-qa-cloud.log 2>&1 &
pids+=("$!")

env \
  DOCKER_HOST="$DOCKER_SOCKET" \
  "${COMMON_OPERATOR_ENV[@]}" \
  SERVICE_ID="$INSTANCE_SERVICE_ID" \
  BLUEPRINT_ID="$INSTANCE_BLUEPRINT_ID" \
  TRADING_BLUEPRINT_ADDRESS="$INSTANCE_BSM_ADDRESS" \
  OPERATOR_API_PORT="$INSTANCE_OPERATOR_API_PORT" \
  TRADING_API_PORT="$INSTANCE_TRADING_API_PORT" \
  INSTANCE_VAULT_ADDRESS="$INSTANCE_VAULT_ADDRESS" \
  BLUEPRINT_STATE_DIR="$ROOT_DIR/blueprint-state/instance" \
    target/release/trading-instance-blueprint run \
      --http-rpc-url "$LOCAL_RPC_URL" \
      --ws-rpc-url "$LOCAL_WS_RPC_URL" \
      --keystore-uri "$ROOT_DIR/scripts/data/operator2/keystore" \
      --data-dir "$ROOT_DIR/blueprint-state/instance" \
      --protocol tangle -t \
      > .tmp/hyperevm-qa-instance.log 2>&1 &
pids+=("$!")

wait_for_http "http://127.0.0.1:$VALIDATOR_HTTP_PORT/health" "validator 1"
wait_for_http "http://127.0.0.1:$((VALIDATOR_HTTP_PORT + 1))/health" "validator 2"
wait_for_http "http://127.0.0.1:$TRADING_API_PORT/health" "cloud trading API"
wait_for_http "http://127.0.0.1:$INSTANCE_TRADING_API_PORT/health" "instance trading API"
wait_for_http "http://127.0.0.1:$OPERATOR_API_PORT/api/meta" "cloud operator API"
wait_for_http "http://127.0.0.1:$INSTANCE_OPERATOR_API_PORT/api/meta" "instance operator API"

cat <<EOF

HyperEVM QA backend is running.
  env:              $HYPEREVM_ENV
  local Tangle RPC: $LOCAL_RPC_URL chain $LOCAL_CHAIN_ID
  HyperEVM RPC:     $HYPEREVM_RPC_URL chain $HYPEREVM_CHAIN_ID
  Hyperliquid API:  $HYPERLIQUID_INFO_URL
  trade validator:  $VALIDATOR_VERIFYING_CONTRACT
  operator address: $OPERATOR_ADDRESS
  factory:          $HYPEREVM_FACTORY_ADDRESS
  asset:            $HYPEREVM_ASSET_TOKEN

Logs:
  .tmp/hyperevm-qa-cloud.log
  .tmp/hyperevm-qa-instance.log
  .tmp/hyperevm-qa-validator-1.log
  .tmp/hyperevm-qa-validator-2.log
EOF

wait
