#!/usr/bin/env bash
# Full local devnet: Anvil + contracts + operators + pricing engines + frontend.
#
# Usage:
#   ./scripts/run-devnet.sh           # Start everything
#   ./scripts/run-devnet.sh --no-ui   # Skip frontend
#
# Prerequisites:
#   - anvil, forge, cast (foundry)
#   - pricing-engine-server: cd ../blueprint && cargo build -p blueprint-pricing-engine --release
#   - node, pnpm (for frontend + pubkey derivation)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
START_UI=true
RESET_STATE=false
PIDS=()

resolve_blueprint_root() {
  if [[ -n "${BLUEPRINT_ROOT:-}" && -d "${BLUEPRINT_ROOT}" ]]; then
    printf '%s\n' "$BLUEPRINT_ROOT"
    return
  fi

  local candidate
  for candidate in \
    "$ROOT_DIR/../blueprint" \
    "$ROOT_DIR/../../blueprint"
  do
    if [[ -d "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done

  return 1
}

resolve_anvil_snapshot() {
  if [[ -n "${ANVIL_STATE:-}" && -f "${ANVIL_STATE}" ]]; then
    printf '%s\n' "$ANVIL_STATE"
    return
  fi

  if [[ -n "${BLUEPRINT_ROOT:-}" ]]; then
    local blueprint_snapshot="$BLUEPRINT_ROOT/crates/chain-setup/anvil/snapshots/localtestnet-state.json"
    if [[ -f "$blueprint_snapshot" ]]; then
      printf '%s\n' "$blueprint_snapshot"
      return
    fi
  fi

  local cargo_snapshot
  cargo_snapshot="$(find "$HOME/.cargo/git/checkouts" -path '*crates/chain-setup/anvil/snapshots/localtestnet-state.json' 2>/dev/null | head -n 1)"
  if [[ -n "$cargo_snapshot" && -f "$cargo_snapshot" ]]; then
    printf '%s\n' "$cargo_snapshot"
    return
  fi

  return 1
}

binary_needs_rebuild() {
  local binary_path="$1"
  shift

  if [[ ! -x "$binary_path" ]]; then
    return 0
  fi

  local dep
  for dep in "$@"; do
    if [[ ! -e "$dep" ]]; then
      continue
    fi
    if [[ -d "$dep" ]]; then
      if find "$dep" -type f -newer "$binary_path" -print -quit | grep -q .; then
        return 0
      fi
    elif [[ "$dep" -nt "$binary_path" ]]; then
      return 0
    fi
  done

  return 1
}

wait_for_operator_meta() {
  local url="$1"
  local expected_kind="$2"
  local label="$3"
  local response=""

  for _ in $(seq 1 30); do
    if response="$(curl -fsS "$url" 2>/dev/null)"; then
      if grep -q "\"deployment_kind\":\"$expected_kind\"" <<<"$response"; then
        echo "  $label ready at $url ($expected_kind)"
        return 0
      fi
    fi
    sleep 1
  done

  echo "ERROR: $label at $url did not report deployment_kind=$expected_kind"
  if [[ -n "$response" ]]; then
    echo "Last response: $response"
  fi
  exit 1
}

verify_distinct_proxy_targets() {
  if [[ "$OPERATOR_PROXY_TARGET" == "$INSTANCE_OPERATOR_PROXY_TARGET" ]]; then
    echo "ERROR: cloud and instance operator proxy targets are both set to $OPERATOR_PROXY_TARGET"
    echo "Set VITE_OPERATOR_PROXY_TARGET and VITE_INSTANCE_OPERATOR_PROXY_TARGET to different operator URLs."
    exit 1
  fi
}

patch_execution_fork_frontend_env() {
  if [[ "$LOAD_EXECUTION_FORK_ENV" != "true" || ! -f "$EXECUTION_STATE_FILE" ]]; then
    return
  fi
  if [[ -z "${EXECUTION_RPC_URL:-}" || -z "${EXECUTION_CHAIN_ID:-}" || -z "${EXECUTION_VAULT_FACTORY_ADDRESS:-}" || -z "${EXECUTION_ASSET_TOKEN:-}" ]]; then
    return
  fi

  ARENA_ENV_FILE="$ROOT_DIR/arena/.env.local" \
  EXECUTION_RPC_URL="$EXECUTION_RPC_URL" \
  EXECUTION_CHAIN_ID="$EXECUTION_CHAIN_ID" \
  EXECUTION_VAULT_FACTORY_ADDRESS="$EXECUTION_VAULT_FACTORY_ADDRESS" \
  EXECUTION_ASSET_TOKEN="$EXECUTION_ASSET_TOKEN" \
  node <<'NODE'
const fs = require('fs');
const path = process.env.ARENA_ENV_FILE;
let text = fs.readFileSync(path, 'utf8');
const updates = {
  VITE_DEX_BASE_ENABLED: 'false',
  VITE_DEX_ETHEREUM_ENABLED: 'true',
  VITE_DEX_ETHEREUM_CHAIN_ID: process.env.EXECUTION_CHAIN_ID,
  VITE_DEX_ETHEREUM_PROTOCOL_CHAIN_ID: '1',
  VITE_DEX_ETHEREUM_RPC_URL: process.env.EXECUTION_RPC_URL,
  VITE_DEX_ETHEREUM_VAULT_FACTORY_ADDRESS: process.env.EXECUTION_VAULT_FACTORY_ADDRESS,
  VITE_DEX_ETHEREUM_VAULT_ADDRESS: '0x0000000000000000000000000000000000000000',
  VITE_DEX_ETHEREUM_ASSET_TOKEN: process.env.EXECUTION_ASSET_TOKEN,
  VITE_DEX_ETHEREUM_PAPER_TRADE: 'false',
};
for (const [key, value] of Object.entries(updates)) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(text)) {
    text = text.replace(pattern, line);
  } else {
    text += text.endsWith('\n') ? line + '\n' : '\n' + line + '\n';
  }
}
fs.writeFileSync(path, text);
NODE
  echo "  Patched arena/.env.local with execution fork target from $EXECUTION_STATE_FILE"
}

sync_tangle_domain_separator() {
  local rpc_url="$1"
  local chain_id="$2"
  local tangle_proxy="0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9"
  local domain_slot="0x3"

  if [[ "$(cast code "$tangle_proxy" --rpc-url "$rpc_url" 2>/dev/null)" == "0x" ]]; then
    return
  fi

  local type_hash name_hash version_hash encoded expected expected_lower current
  type_hash="$(cast keccak "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")"
  name_hash="$(cast keccak "TangleQuote")"
  version_hash="$(cast keccak "1")"
  encoded="$(cast abi-encode "f(bytes32,bytes32,bytes32,uint256,address)" \
    "$type_hash" \
    "$name_hash" \
    "$version_hash" \
    "$chain_id" \
    "$tangle_proxy")"
  expected="$(cast keccak "$encoded")"
  expected_lower="$(printf '%s' "$expected" | tr '[:upper:]' '[:lower:]')"
  current="$(cast storage "$tangle_proxy" "$domain_slot" --rpc-url "$rpc_url" 2>/dev/null | tr '[:upper:]' '[:lower:]')"

  if [[ "$current" == "$expected_lower" ]]; then
    echo "  Tangle domain separator already matches chain $chain_id"
    return
  fi

  cast rpc anvil_setStorageAt \
    "$tangle_proxy" \
    "$domain_slot" \
    "$expected" \
    --rpc-url "$rpc_url" > /dev/null
  echo "  Patched Tangle domain separator for chain $chain_id"
}

ensure_release_binaries() {
  local sandbox_root="$ROOT_DIR/../ai-agent-sandbox-blueprint"
  local cloud_bin="$ROOT_DIR/target/release/trading-blueprint"
  local instance_bin="$ROOT_DIR/target/release/trading-instance-blueprint"
  local tee_bin="$ROOT_DIR/target/release/trading-tee-instance-blueprint"
  local validator_bin="$ROOT_DIR/target/release/trading-validator"
  local watch_paths=(
    "$ROOT_DIR/Cargo.toml"
    "$ROOT_DIR/Cargo.lock"
    "$ROOT_DIR/trading-runtime"
    "$ROOT_DIR/trading-http-api"
    "$ROOT_DIR/trading-blueprint-lib"
    "$ROOT_DIR/trading-blueprint-bin"
    "$ROOT_DIR/trading-validator-lib"
    "$ROOT_DIR/trading-validator-bin"
    "$ROOT_DIR/trading-instance-blueprint-lib"
    "$ROOT_DIR/trading-instance-blueprint-bin"
    "$ROOT_DIR/trading-tee-instance-blueprint-lib"
    "$ROOT_DIR/trading-tee-instance-blueprint-bin"
    "$ROOT_DIR/scripts"
  )

  if [[ -d "$sandbox_root/ai-agent-sandbox-blueprint-lib" ]]; then
    watch_paths+=("$sandbox_root/ai-agent-sandbox-blueprint-lib")
  fi
  if [[ -d "$sandbox_root/sandbox-runtime" ]]; then
    watch_paths+=("$sandbox_root/sandbox-runtime")
  fi

  if binary_needs_rebuild "$cloud_bin" "${watch_paths[@]}" ||
    binary_needs_rebuild "$instance_bin" "${watch_paths[@]}" ||
    binary_needs_rebuild "$tee_bin" "${watch_paths[@]}" ||
    binary_needs_rebuild "$validator_bin" "${watch_paths[@]}"; then
    echo ""
    echo "=== Building release binaries ==="
    cargo build --release \
      -p trading-blueprint-bin \
      -p trading-instance-blueprint-bin \
      -p trading-tee-instance-blueprint-bin \
      -p trading-validator-bin
  fi
}

BLUEPRINT_ROOT="$(resolve_blueprint_root || true)"
SNAPSHOT="$(resolve_anvil_snapshot || true)"
ANVIL_PORT="${ANVIL_PORT:-8545}"
CHAIN_ID="${CHAIN_ID:-31338}"
RPC_URL="${RPC_URL:-http://127.0.0.1:$ANVIL_PORT}"
WS_RPC_URL="${WS_RPC_URL:-ws://127.0.0.1:$ANVIL_PORT}"
ANVIL_CODE_SIZE_LIMIT="${ANVIL_CODE_SIZE_LIMIT:-30000}"
ARENA_PORT="${ARENA_PORT:-1337}"
OPERATOR_API_PORT="${OPERATOR_API_PORT:-9200}"
INSTANCE_OPERATOR_API_PORT="${INSTANCE_OPERATOR_API_PORT:-9201}"
TRADING_API_PORT="${TRADING_API_PORT:-9100}"
INSTANCE_TRADING_API_PORT="${INSTANCE_TRADING_API_PORT:-9101}"
VALIDATOR_HTTP_PORT="${VALIDATOR_HTTP_PORT:-9090}"
VALIDATOR_ENDPOINT_COUNT="${VALIDATOR_ENDPOINT_COUNT:-2}"
EXECUTION_STATE_FILE="${EXECUTION_STATE_FILE:-$ROOT_DIR/.execution-fork.env}"
LOAD_EXECUTION_FORK_ENV="${LOAD_EXECUTION_FORK_ENV:-true}"
START_VALIDATOR="${START_VALIDATOR:-}"
FORK_URL="${FORK_URL:-}"
FORK_BLOCK_NUMBER="${FORK_BLOCK_NUMBER:-}"
FORK_MODE="${FORK_MODE:-false}"
FORK_BASE_CHAIN_ID="${FORK_BASE_CHAIN_ID:-${PROTOCOL_CHAIN_ID:-}}"
OPERATOR_PROXY_TARGET="${VITE_OPERATOR_PROXY_TARGET:-http://localhost:$OPERATOR_API_PORT}"
INSTANCE_OPERATOR_PROXY_TARGET="${VITE_INSTANCE_OPERATOR_PROXY_TARGET:-http://localhost:$INSTANCE_OPERATOR_API_PORT}"

if [[ "$LOAD_EXECUTION_FORK_ENV" == "true" && -f "$EXECUTION_STATE_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$EXECUTION_STATE_FILE"
  set +a
  echo "Loaded execution fork env from $EXECUTION_STATE_FILE"
fi

for arg in "$@"; do
  case "$arg" in
    --no-ui) START_UI=false ;;
    --reset-state) RESET_STATE=true ;;
  esac
done

verify_distinct_proxy_targets

if [[ "$RESET_STATE" == "true" ]]; then
  echo "=== Resetting local blueprint state ==="
  bash "$SCRIPT_DIR/reset-local-state.sh"
fi

ensure_release_binaries

cleanup() {
  echo ""
  echo "Shutting down devnet..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null
  echo "Done."
}
trap cleanup EXIT INT TERM

# ── 1. Start Anvil ─────────────────────────────────────────────────
echo "=== Starting Anvil ==="
if [[ -n "$FORK_URL" ]]; then
  FORK_MODE=true
fi
if [[ "$FORK_MODE" == "true" && -z "$FORK_BASE_CHAIN_ID" ]]; then
  FORK_BASE_CHAIN_ID=1
fi
if [[ "$FORK_MODE" == "true" && "$FORK_BASE_CHAIN_ID" == "1" ]]; then
  EXISTING_USDC_ADDRESS="${EXISTING_USDC_ADDRESS:-0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48}"
  EXISTING_WETH_ADDRESS="${EXISTING_WETH_ADDRESS:-0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2}"
fi

if [[ -f "$SNAPSHOT" && -n "$FORK_URL" ]]; then
  if [[ -n "$FORK_BLOCK_NUMBER" ]]; then
    anvil --load-state "$SNAPSHOT" --fork-url "$FORK_URL" --fork-block-number "$FORK_BLOCK_NUMBER" --port "$ANVIL_PORT" --chain-id "$CHAIN_ID" --code-size-limit "$ANVIL_CODE_SIZE_LIMIT" --silent &
  else
    anvil --load-state "$SNAPSHOT" --fork-url "$FORK_URL" --port "$ANVIL_PORT" --chain-id "$CHAIN_ID" --code-size-limit "$ANVIL_CODE_SIZE_LIMIT" --silent &
  fi
elif [[ -f "$SNAPSHOT" ]]; then
  anvil --load-state "$SNAPSHOT" --port "$ANVIL_PORT" --chain-id "$CHAIN_ID" --code-size-limit "$ANVIL_CODE_SIZE_LIMIT" --silent &
elif [[ -n "$FORK_URL" ]]; then
  if [[ -n "$FORK_BLOCK_NUMBER" ]]; then
    anvil --fork-url "$FORK_URL" --fork-block-number "$FORK_BLOCK_NUMBER" --port "$ANVIL_PORT" --chain-id "$CHAIN_ID" --code-size-limit "$ANVIL_CODE_SIZE_LIMIT" --silent &
  else
    anvil --fork-url "$FORK_URL" --port "$ANVIL_PORT" --chain-id "$CHAIN_ID" --code-size-limit "$ANVIL_CODE_SIZE_LIMIT" --silent &
  fi
else
  echo "WARNING: Tangle state snapshot not found at $SNAPSHOT"
  echo "Starting plain Anvil (no Tangle contracts)"
  anvil --port "$ANVIL_PORT" --chain-id "$CHAIN_ID" --code-size-limit "$ANVIL_CODE_SIZE_LIMIT" --silent &
fi
PIDS+=($!)

# Verify Anvil is alive. Fork + load-state boot can take noticeably longer than
# plain local Anvil, so poll instead of assuming a short fixed delay.
ANVIL_CHAIN_ID=""
for _ in $(seq 1 60); do
  if ANVIL_CHAIN_ID="$(cast chain-id --rpc-url "$RPC_URL" 2>/dev/null)"; then
    break
  fi
  sleep 1
done

if [[ -z "$ANVIL_CHAIN_ID" ]]; then
  echo "ERROR: Anvil failed to start"
  exit 1
fi
echo "  Anvil running at $RPC_URL (chain $ANVIL_CHAIN_ID)"
if [[ -n "$FORK_URL" ]]; then
  echo "  Fork source: $FORK_URL"
  if [[ -n "$FORK_BLOCK_NUMBER" ]]; then
    echo "  Fork block:  $FORK_BLOCK_NUMBER"
  fi
fi
sync_tangle_domain_separator "$RPC_URL" "$CHAIN_ID"

# ── 2. Deploy contracts + register operators ───────────────────────
echo ""
echo "=== Deploying contracts ==="
cd "$ROOT_DIR"
CHAIN_ID="$CHAIN_ID" \
RPC_URL="$RPC_URL" \
OPERATOR_API_PORT="$OPERATOR_API_PORT" \
INSTANCE_OPERATOR_API_PORT="$INSTANCE_OPERATOR_API_PORT" \
VITE_OPERATOR_PROXY_TARGET="$OPERATOR_PROXY_TARGET" \
VITE_INSTANCE_OPERATOR_PROXY_TARGET="$INSTANCE_OPERATOR_PROXY_TARGET" \
FORK_MODE="$FORK_MODE" \
FORK_BASE_CHAIN_ID="$FORK_BASE_CHAIN_ID" \
EXISTING_USDC_ADDRESS="${EXISTING_USDC_ADDRESS:-}" \
EXISTING_WETH_ADDRESS="${EXISTING_WETH_ADDRESS:-}" \
  bash "$SCRIPT_DIR/deploy-local.sh"
patch_execution_fork_frontend_env

# ── 3. Start pricing engines ──────────────────────────────────────
echo ""
echo "=== Starting pricing engines ==="

PRICING_BIN="${PRICING_ENGINE_BIN:-$(command -v pricing-engine-server 2>/dev/null || echo "${BLUEPRINT_ROOT:-$ROOT_DIR/../blueprint}/target/release/pricing-engine-server")}"
if [[ -x "$PRICING_BIN" ]]; then
  LOAD_BASE_SEPOLIA=false HTTP_RPC_URL="$RPC_URL" WS_RPC_URL="$WS_RPC_URL" \
    bash "$SCRIPT_DIR/run-pricing-engine.sh" --config "$SCRIPT_DIR/operator1.toml" &
  PIDS+=($!)
  sleep 1

  LOAD_BASE_SEPOLIA=false HTTP_RPC_URL="$RPC_URL" WS_RPC_URL="$WS_RPC_URL" \
    bash "$SCRIPT_DIR/run-pricing-engine.sh" --config "$SCRIPT_DIR/operator2.toml" &
  PIDS+=($!)
  sleep 1

  echo "  Pricing engines started on :50051 and :50052"
else
  echo "  SKIPPED: pricing-engine-server not found"
  echo "  Build it: cd ../blueprint && cargo build -p blueprint-pricing-engine --release"
fi

CLOUD_SERVICE_ID="$(grep '^VITE_SERVICE_IDS=' "$ROOT_DIR/arena/.env.local" | cut -d= -f2 | cut -d, -f1)"
CLOUD_SERVICE_ID="${CLOUD_SERVICE_ID:-0}"
CLOUD_BLUEPRINT_ID="$(grep '^VITE_BLUEPRINT_ID=' "$ROOT_DIR/arena/.env.local" | cut -d= -f2)"
CLOUD_BSM_ADDRESS="$(grep '^VITE_TRADING_BLUEPRINT=' "$ROOT_DIR/arena/.env.local" | cut -d= -f2)"
INSTANCE_SERVICE_ID="$(grep '^VITE_SERVICE_IDS=' "$ROOT_DIR/arena/.env.local" | cut -d= -f2 | cut -d, -f2)"
INSTANCE_SERVICE_ID="${INSTANCE_SERVICE_ID:-0}"
INSTANCE_BLUEPRINT_ID="$(grep '^VITE_INSTANCE_BLUEPRINT_ID=' "$ROOT_DIR/arena/.env.local" | cut -d= -f2)"
INSTANCE_BSM_ADDRESS="$(grep '^VITE_INSTANCE_TRADING_BLUEPRINT=' "$ROOT_DIR/arena/.env.local" | cut -d= -f2)"
VALIDATOR_SERVICE_ID="$(grep '^VITE_VALIDATOR_SERVICE_ID=' "$ROOT_DIR/arena/.env.local" | cut -d= -f2)"
VALIDATOR_BLUEPRINT_ID="$(grep '^VITE_VALIDATOR_BLUEPRINT_ID=' "$ROOT_DIR/arena/.env.local" | cut -d= -f2)"
INSTANCE_VAULT_ADDRESS="$(grep '^VITE_INSTANCE_VAULT_ADDRESS=' "$ROOT_DIR/arena/.env.local" | cut -d= -f2)"
TRADE_VALIDATOR_ADDRESS="$(grep '^VITE_TRADE_VALIDATOR_ADDRESS=' "$ROOT_DIR/arena/.env.local" | cut -d= -f2)"
if [[ -z "$START_VALIDATOR" ]]; then
  if [[ -n "$VALIDATOR_SERVICE_ID" && "$VALIDATOR_SERVICE_ID" != "0" ]]; then
    START_VALIDATOR=true
  elif [[ "$FORK_MODE" == "true" ]]; then
    START_VALIDATOR=true
  else
    START_VALIDATOR=false
  fi
fi
DEFAULT_VALIDATOR_ENDPOINTS="${VALIDATOR_ENDPOINTS:-}"
if [[ -z "$DEFAULT_VALIDATOR_ENDPOINTS" && "$START_VALIDATOR" == "true" ]]; then
  DEFAULT_VALIDATOR_ENDPOINTS=""
  for ((i = 0; i < VALIDATOR_ENDPOINT_COUNT; i++)); do
    endpoint="http://127.0.0.1:$((VALIDATOR_HTTP_PORT + i))"
    if [[ -z "$DEFAULT_VALIDATOR_ENDPOINTS" ]]; then
      DEFAULT_VALIDATOR_ENDPOINTS="$endpoint"
    else
      DEFAULT_VALIDATOR_ENDPOINTS="$DEFAULT_VALIDATOR_ENDPOINTS,$endpoint"
    fi
  done
fi
VALIDATOR_SIGNING_RPC_URL="${EXECUTION_RPC_URL:-$RPC_URL}"
VALIDATOR_SIGNING_CHAIN_ID="${EXECUTION_CHAIN_ID:-$CHAIN_ID}"
VALIDATOR_VERIFYING_CONTRACT="${EXECUTION_TRADE_VALIDATOR_ADDRESS:-${EXECUTION_TRADE_VALIDATOR:-$TRADE_VALIDATOR_ADDRESS}}"
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

if [[ "$START_VALIDATOR" == "true" ]]; then
  # ── 3b. Start validator ─────────────────────────────────────────
  echo ""
  echo "=== Starting validators ==="

  for ((i = 0; i < VALIDATOR_ENDPOINT_COUNT; i++)); do
    port=$((VALIDATOR_HTTP_PORT + i))
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
    SERVICE_ID="$VALIDATOR_SERVICE_ID" \
    BLUEPRINT_ID="$VALIDATOR_BLUEPRINT_ID" \
    CHAIN_ID="$CHAIN_ID" \
    EXECUTION_CHAIN_ID="$VALIDATOR_SIGNING_CHAIN_ID" \
    FORK_BASE_CHAIN_ID="$FORK_BASE_CHAIN_ID" \
    PROTOCOL_CHAIN_ID="$FORK_BASE_CHAIN_ID" \
    EXECUTION_RPC_URL="$VALIDATOR_SIGNING_RPC_URL" \
    RPC_URL="$RPC_URL" \
    HTTP_RPC_URL="$RPC_URL" \
    VALIDATOR_RPC_URL="$VALIDATOR_SIGNING_RPC_URL" \
    VALIDATOR_HTTP_PORT="$port" \
    EXECUTION_TRADE_VALIDATOR_ADDRESS="$VALIDATOR_VERIFYING_CONTRACT" \
    VERIFYING_CONTRACT="$VALIDATOR_VERIFYING_CONTRACT" \
    OPERATOR_ADDRESS="$validator_operator_address" \
    PRIVATE_KEY="$validator_private_key" \
    TANGLE_CONTRACT="0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9" \
    STAKING_CONTRACT="0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" \
    STATUS_REGISTRY_CONTRACT="0x99bbA657f2BbC93c02D617f8bA121cB8Fc104Acf" \
    STATUS_REGISTRY_ADDRESS="0x99bbA657f2BbC93c02D617f8bA121cB8Fc104Acf" \
    "$ROOT_DIR/target/release/trading-validator" run \
      --http-rpc-url "$RPC_URL" \
      --ws-rpc-url "$WS_RPC_URL" \
      --keystore-uri "$validator_keystore" \
      --data-dir "${VALIDATOR_BLUEPRINT_STATE_DIR:-$ROOT_DIR/blueprint-state/validator-$((i + 1))}" \
      --protocol tangle -t &
    PIDS+=($!)
  done

  sleep 2
  for ((i = 0; i < VALIDATOR_ENDPOINT_COUNT; i++)); do
    port=$((VALIDATOR_HTTP_PORT + i))
    echo "  Validator running at http://localhost:$port"
    if ! curl -fsS "http://localhost:$port/health" > /dev/null 2>&1; then
      echo "ERROR: Validator failed to start on port $port"
      exit 1
    fi
  done
  echo "  Validator endpoints:    $DEFAULT_VALIDATOR_ENDPOINTS"
  echo "  Validator signing chain: $VALIDATOR_SIGNING_CHAIN_ID"
  echo "  Validator signing RPC:   $VALIDATOR_SIGNING_RPC_URL"
  echo "  Verifying contract:      $VALIDATOR_VERIFYING_CONTRACT"
else
  echo ""
  echo "=== Skipping validator ==="
  echo "  START_VALIDATOR is false; operators will use VALIDATOR_ENDPOINTS='${DEFAULT_VALIDATOR_ENDPOINTS}'"
fi

# ── 4. Start cloud operator ───────────────────────────────────────
echo ""
echo "=== Starting cloud operator ==="

DOCKER_HOST="$DOCKER_SOCKET" \
RUST_LOG="${RUST_LOG:-info,tangle=debug,trading=debug}" \
ALLOW_LOOPBACK_RPC_URLS="${ALLOW_LOOPBACK_RPC_URLS:-true}" \
SERVICE_ID="$CLOUD_SERVICE_ID" \
BLUEPRINT_ID="$CLOUD_BLUEPRINT_ID" \
RPC_URL="$RPC_URL" \
HTTP_RPC_URL="$RPC_URL" \
CHAIN_ID="$CHAIN_ID" \
FORK_BASE_CHAIN_ID="$FORK_BASE_CHAIN_ID" \
PROTOCOL_CHAIN_ID="$FORK_BASE_CHAIN_ID" \
TRADING_BLUEPRINT_ADDRESS="$CLOUD_BSM_ADDRESS" \
LOCAL_ANVIL_REPLAY_JOB_RESULT="${LOCAL_ANVIL_REPLAY_JOB_RESULT:-true}" \
OPERATOR_ADDRESS="0x70997970C51812dc3A010C7d01b50e0d17dc79C8" \
PRIVATE_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" \
TANGLE_CONTRACT="0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9" \
STAKING_CONTRACT="0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" \
STATUS_REGISTRY_CONTRACT="0x99bbA657f2BbC93c02D617f8bA121cB8Fc104Acf" \
SESSION_AUTH_SECRET="${SESSION_AUTH_SECRET:-dev-secret-key-do-not-use-in-production}" \
SIDECAR_IMAGE="${SIDECAR_IMAGE:-tangle-sidecar:local}" \
SIDECAR_PULL_IMAGE="${SIDECAR_PULL_IMAGE:-false}" \
SIDECAR_PUBLIC_HOST="${SIDECAR_PUBLIC_HOST:-127.0.0.1}" \
OPERATOR_API_PORT="$OPERATOR_API_PORT" \
TRADING_API_PORT="$TRADING_API_PORT" \
BLUEPRINT_STATE_DIR="${BLUEPRINT_STATE_DIR:-$ROOT_DIR/blueprint-state/cloud}" \
VALIDATOR_ENDPOINTS="$DEFAULT_VALIDATOR_ENDPOINTS" \
WORKFLOW_CRON_SCHEDULE="${WORKFLOW_CRON_SCHEDULE:-0 * * * * *}" \
FEE_SETTLEMENT_INTERVAL_SECS="${FEE_SETTLEMENT_INTERVAL_SECS:-999999}" \
BILLING_INTERVAL_SECS="${BILLING_INTERVAL_SECS:-999999}" \
"$ROOT_DIR/target/release/trading-blueprint" run \
  --http-rpc-url "$RPC_URL" \
  --ws-rpc-url "$WS_RPC_URL" \
  --keystore-uri "$ROOT_DIR/scripts/data/operator1/keystore" \
  --data-dir "${BLUEPRINT_STATE_DIR:-$ROOT_DIR/blueprint-state/cloud}" \
  --protocol tangle -t &
PIDS+=($!)
sleep 2
echo "  Cloud operator starting on :$OPERATOR_API_PORT (API) and :$TRADING_API_PORT (trading)"
wait_for_operator_meta "http://localhost:$OPERATOR_API_PORT/api/meta" "fleet" "Cloud operator"

# ── 4b. Start instance operator ─────────────────────────────────────
echo ""
echo "=== Starting instance operator ==="

DOCKER_HOST="$DOCKER_SOCKET" \
RUST_LOG="${RUST_LOG:-info,tangle=debug,trading=debug}" \
ALLOW_LOOPBACK_RPC_URLS="${ALLOW_LOOPBACK_RPC_URLS:-true}" \
SERVICE_ID="$INSTANCE_SERVICE_ID" \
BLUEPRINT_ID="$INSTANCE_BLUEPRINT_ID" \
RPC_URL="$RPC_URL" \
HTTP_RPC_URL="$RPC_URL" \
CHAIN_ID="$CHAIN_ID" \
FORK_BASE_CHAIN_ID="$FORK_BASE_CHAIN_ID" \
PROTOCOL_CHAIN_ID="$FORK_BASE_CHAIN_ID" \
TRADING_BLUEPRINT_ADDRESS="$INSTANCE_BSM_ADDRESS" \
LOCAL_ANVIL_REPLAY_JOB_RESULT="${LOCAL_ANVIL_REPLAY_JOB_RESULT:-true}" \
OPERATOR_ADDRESS="0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" \
PRIVATE_KEY="0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" \
TANGLE_CONTRACT="0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9" \
STAKING_CONTRACT="0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" \
STATUS_REGISTRY_CONTRACT="0x99bbA657f2BbC93c02D617f8bA121cB8Fc104Acf" \
SESSION_AUTH_SECRET="${SESSION_AUTH_SECRET:-dev-secret-key-do-not-use-in-production}" \
SIDECAR_IMAGE="${SIDECAR_IMAGE:-tangle-sidecar:local}" \
SIDECAR_PULL_IMAGE="${SIDECAR_PULL_IMAGE:-false}" \
SIDECAR_PUBLIC_HOST="${SIDECAR_PUBLIC_HOST:-127.0.0.1}" \
OPERATOR_API_PORT="$INSTANCE_OPERATOR_API_PORT" \
TRADING_API_PORT="$INSTANCE_TRADING_API_PORT" \
INSTANCE_VAULT_ADDRESS="$INSTANCE_VAULT_ADDRESS" \
BLUEPRINT_STATE_DIR="${INSTANCE_BLUEPRINT_STATE_DIR:-$ROOT_DIR/blueprint-state/instance}" \
VALIDATOR_ENDPOINTS="$DEFAULT_VALIDATOR_ENDPOINTS" \
WORKFLOW_CRON_SCHEDULE="${WORKFLOW_CRON_SCHEDULE:-0 * * * * *}" \
FEE_SETTLEMENT_INTERVAL_SECS="${FEE_SETTLEMENT_INTERVAL_SECS:-999999}" \
BILLING_INTERVAL_SECS="${BILLING_INTERVAL_SECS:-999999}" \
"$ROOT_DIR/target/release/trading-instance-blueprint" run \
  --http-rpc-url "$RPC_URL" \
  --ws-rpc-url "$WS_RPC_URL" \
  --keystore-uri "$ROOT_DIR/scripts/data/operator2/keystore" \
  --data-dir "${INSTANCE_BLUEPRINT_STATE_DIR:-$ROOT_DIR/blueprint-state/instance}" \
  --protocol tangle -t &
PIDS+=($!)
sleep 2
echo "  Instance operator starting on :$INSTANCE_OPERATOR_API_PORT (API) and :$INSTANCE_TRADING_API_PORT (trading)"
wait_for_operator_meta "http://localhost:$INSTANCE_OPERATOR_API_PORT/api/meta" "instance" "Instance operator"

# ── 5. Start frontend ─────────────────────────────────────────────
if [[ "$START_UI" == "true" ]]; then
  echo ""
  echo "=== Starting frontend ==="
  if [[ -d "$ROOT_DIR/arena/.react-router" ]]; then
    mv "$ROOT_DIR/arena/.react-router" "$ROOT_DIR/arena/.react-router.bak.$(date +%s)"
  fi
  PNPM_BIN="${PNPM_BIN:-$(command -v pnpm)}"
  VITE_OPERATOR_PROXY_TARGET="$OPERATOR_PROXY_TARGET" \
    VITE_INSTANCE_OPERATOR_PROXY_TARGET="$INSTANCE_OPERATOR_PROXY_TARGET" \
    "$PNPM_BIN" -C "$ROOT_DIR/arena" dev --host 0.0.0.0 --port "$ARENA_PORT" &
  PIDS+=($!)
  echo "  Frontend starting on http://localhost:$ARENA_PORT"
  wait_for_operator_meta "http://localhost:$ARENA_PORT/operator-api/api/meta" "fleet" "Frontend cloud operator proxy"
  wait_for_operator_meta "http://localhost:$ARENA_PORT/instance-operator-api/api/meta" "instance" "Frontend instance operator proxy"
fi

# ── Done ───────────────────────────────────────────────────────────
echo ""
echo "╔════════════════════════════════════════════════╗"
echo "║          DEVNET RUNNING                         ║"
echo "╠════════════════════════════════════════════════╣"
echo "║  Anvil RPC:     $RPC_URL          ║"
echo "║  Operator 1:    http://localhost:50051 (gRPC)   ║"
echo "║  Operator 2:    http://localhost:50052 (gRPC)   ║"
if [[ "$START_VALIDATOR" == "true" ]]; then
echo "║  Validator:     http://localhost:$VALIDATOR_HTTP_PORT         ║"
fi
echo "║  Cloud API:     http://localhost:$OPERATOR_API_PORT        ║"
echo "║  Instance API:  http://localhost:$INSTANCE_OPERATOR_API_PORT        ║"
echo "║  Instance Tx:   http://localhost:$INSTANCE_TRADING_API_PORT        ║"
if [[ "$START_UI" == "true" ]]; then
echo "║  Frontend:      http://localhost:$ARENA_PORT           ║"
fi
echo "╠════════════════════════════════════════════════╣"
echo "║  Press Ctrl+C to stop all services              ║"
echo "╚════════════════════════════════════════════════╝"
echo ""

# Wait forever (until Ctrl+C)
wait
