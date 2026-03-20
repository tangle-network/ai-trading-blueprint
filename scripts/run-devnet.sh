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
CHAIN_ID="${CHAIN_ID:-31337}"
RPC_URL="${RPC_URL:-http://127.0.0.1:$ANVIL_PORT}"
WS_RPC_URL="${WS_RPC_URL:-ws://127.0.0.1:$ANVIL_PORT}"
ARENA_PORT="${ARENA_PORT:-1337}"
OPERATOR_API_PORT="${OPERATOR_API_PORT:-9200}"
TRADING_API_PORT="${TRADING_API_PORT:-9100}"
OPERATOR_PROXY_TARGET="${VITE_OPERATOR_PROXY_TARGET:-http://localhost:$OPERATOR_API_PORT}"

for arg in "$@"; do
  case "$arg" in
    --no-ui) START_UI=false ;;
  esac
done

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
if [[ -f "$SNAPSHOT" ]]; then
  anvil --load-state "$SNAPSHOT" --port "$ANVIL_PORT" --chain-id "$CHAIN_ID" --silent &
else
  echo "WARNING: Tangle state snapshot not found at $SNAPSHOT"
  echo "Starting plain Anvil (no Tangle contracts)"
  anvil --port "$ANVIL_PORT" --chain-id "$CHAIN_ID" --silent &
fi
PIDS+=($!)
sleep 2

# Verify Anvil is alive
if ! cast chain-id --rpc-url "$RPC_URL" > /dev/null 2>&1; then
  echo "ERROR: Anvil failed to start"
  exit 1
fi
echo "  Anvil running at $RPC_URL (chain $(cast chain-id --rpc-url "$RPC_URL"))"

# ── 2. Deploy contracts + register operators ───────────────────────
echo ""
echo "=== Deploying contracts ==="
cd "$ROOT_DIR"
CHAIN_ID="$CHAIN_ID" \
RPC_URL="$RPC_URL" \
OPERATOR_API_PORT="$OPERATOR_API_PORT" \
VITE_OPERATOR_PROXY_TARGET="$OPERATOR_PROXY_TARGET" \
  bash "$SCRIPT_DIR/deploy-local.sh"

# ── 3. Start pricing engines ──────────────────────────────────────
echo ""
echo "=== Starting pricing engines ==="

PRICING_BIN="${PRICING_ENGINE_BIN:-$(command -v pricing-engine-server 2>/dev/null || echo "${BLUEPRINT_ROOT:-$ROOT_DIR/../blueprint}/target/release/pricing-engine-server")}"
if [[ -x "$PRICING_BIN" ]]; then
  HTTP_RPC_URL="$RPC_URL" WS_RPC_URL="$WS_RPC_URL" \
    bash "$SCRIPT_DIR/run-pricing-engine.sh" --config "$SCRIPT_DIR/operator1.toml" &
  PIDS+=($!)
  sleep 1

  HTTP_RPC_URL="$RPC_URL" WS_RPC_URL="$WS_RPC_URL" \
    bash "$SCRIPT_DIR/run-pricing-engine.sh" --config "$SCRIPT_DIR/operator2.toml" &
  PIDS+=($!)
  sleep 1

  echo "  Pricing engines started on :50051 and :50052"
else
  echo "  SKIPPED: pricing-engine-server not found"
  echo "  Build it: cd ../blueprint && cargo build -p blueprint-pricing-engine --release"
fi

# ── 4. Start cloud operator ───────────────────────────────────────
echo ""
echo "=== Starting cloud operator ==="

CLOUD_SERVICE_ID="$(grep '^VITE_SERVICE_IDS=' "$ROOT_DIR/arena/.env.local" | cut -d= -f2 | cut -d, -f1)"
CLOUD_BLUEPRINT_ID="$(grep '^VITE_BLUEPRINT_ID=' "$ROOT_DIR/arena/.env.local" | cut -d= -f2)"
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

DOCKER_HOST="$DOCKER_SOCKET" \
RUST_LOG="${RUST_LOG:-info,tangle=debug,trading=debug}" \
SERVICE_ID="$CLOUD_SERVICE_ID" \
BLUEPRINT_ID="$CLOUD_BLUEPRINT_ID" \
RPC_URL="$RPC_URL" \
HTTP_RPC_URL="$RPC_URL" \
CHAIN_ID="$CHAIN_ID" \
OPERATOR_ADDRESS="0x70997970C51812dc3A010C7d01b50e0d17dc79C8" \
PRIVATE_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" \
TANGLE_CONTRACT="0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9" \
RESTAKING_CONTRACT="0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" \
STATUS_REGISTRY_CONTRACT="0x99bbA657f2BbC93c02D617f8bA121cB8Fc104Acf" \
SIDECAR_IMAGE="${SIDECAR_IMAGE:-tangle-sidecar:local}" \
SIDECAR_PULL_IMAGE="${SIDECAR_PULL_IMAGE:-false}" \
SIDECAR_PUBLIC_HOST="${SIDECAR_PUBLIC_HOST:-127.0.0.1}" \
OPERATOR_API_PORT="$OPERATOR_API_PORT" \
TRADING_API_PORT="$TRADING_API_PORT" \
BLUEPRINT_STATE_DIR="${BLUEPRINT_STATE_DIR:-$ROOT_DIR/blueprint-state/cloud}" \
VALIDATOR_ENDPOINTS="${VALIDATOR_ENDPOINTS:-}" \
WORKFLOW_CRON_SCHEDULE="${WORKFLOW_CRON_SCHEDULE:-0 0 1 1 * *}" \
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

# ── 5. Start frontend ─────────────────────────────────────────────
if [[ "$START_UI" == "true" ]]; then
  echo ""
  echo "=== Starting frontend ==="
  if [[ -d "$ROOT_DIR/arena/.react-router" ]]; then
    mv "$ROOT_DIR/arena/.react-router" "$ROOT_DIR/arena/.react-router.bak.$(date +%s)"
  fi
  PATH="${NVM_BIN:-$HOME/.nvm/versions/node/v24.13.1/bin}:$PATH" \
    VITE_OPERATOR_PROXY_TARGET="$OPERATOR_PROXY_TARGET" \
    pnpm -C "$ROOT_DIR/arena" dev --host 0.0.0.0 --port "$ARENA_PORT" &
  PIDS+=($!)
  echo "  Frontend starting on http://localhost:$ARENA_PORT"
fi

# ── Done ───────────────────────────────────────────────────────────
echo ""
echo "╔════════════════════════════════════════════════╗"
echo "║          DEVNET RUNNING                         ║"
echo "╠════════════════════════════════════════════════╣"
echo "║  Anvil RPC:     $RPC_URL          ║"
echo "║  Operator 1:    http://localhost:50051 (gRPC)   ║"
echo "║  Operator 2:    http://localhost:50052 (gRPC)   ║"
echo "║  Cloud API:     http://localhost:$OPERATOR_API_PORT        ║"
if [[ "$START_UI" == "true" ]]; then
echo "║  Frontend:      http://localhost:$ARENA_PORT           ║"
fi
echo "╠════════════════════════════════════════════════╣"
echo "║  Press Ctrl+C to stop all services              ║"
echo "╚════════════════════════════════════════════════╝"
echo ""

# Wait forever (until Ctrl+C)
wait
