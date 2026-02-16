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
SNAPSHOT="${ANVIL_STATE:-$ROOT_DIR/../blueprint/crates/chain-setup/anvil/snapshots/localtestnet-state.json}"
START_UI=true
PIDS=()

for arg in "$@"; do
  case "$arg" in
    --no-ui) START_UI=false ;;
  esac
done

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
  anvil --load-state "$SNAPSHOT" --silent &
else
  echo "WARNING: Tangle state snapshot not found at $SNAPSHOT"
  echo "Starting plain Anvil (no Tangle contracts)"
  anvil --silent &
fi
PIDS+=($!)
sleep 2

# Verify Anvil is alive
if ! cast chain-id --rpc-url http://127.0.0.1:8545 > /dev/null 2>&1; then
  echo "ERROR: Anvil failed to start"
  exit 1
fi
echo "  Anvil running (chain $(cast chain-id --rpc-url http://127.0.0.1:8545))"

# ── 2. Deploy contracts + register operators ───────────────────────
echo ""
echo "=== Deploying contracts ==="
cd "$ROOT_DIR"
bash "$SCRIPT_DIR/deploy-local.sh"

# ── 3. Start pricing engines ──────────────────────────────────────
echo ""
echo "=== Starting pricing engines ==="

PRICING_BIN="${PRICING_ENGINE_BIN:-$(command -v pricing-engine-server 2>/dev/null || echo "$ROOT_DIR/../blueprint/target/release/pricing-engine-server")}"
if [[ -x "$PRICING_BIN" ]]; then
  bash "$SCRIPT_DIR/run-pricing-engine.sh" --config "$SCRIPT_DIR/operator1.toml" &
  PIDS+=($!)
  sleep 1

  bash "$SCRIPT_DIR/run-pricing-engine.sh" --config "$SCRIPT_DIR/operator2.toml" &
  PIDS+=($!)
  sleep 1

  echo "  Pricing engines started on :50051 and :50052"
else
  echo "  SKIPPED: pricing-engine-server not found"
  echo "  Build it: cd ../blueprint && cargo build -p blueprint-pricing-engine --release"
fi

# ── 4. Start frontend ─────────────────────────────────────────────
if [[ "$START_UI" == "true" ]]; then
  echo ""
  echo "=== Starting frontend ==="
  cd "$ROOT_DIR/arena"
  pnpm dev &
  PIDS+=($!)
  echo "  Frontend starting on http://localhost:5173"
fi

# ── Done ───────────────────────────────────────────────────────────
echo ""
echo "╔════════════════════════════════════════════════╗"
echo "║          DEVNET RUNNING                         ║"
echo "╠════════════════════════════════════════════════╣"
echo "║  Anvil RPC:     http://127.0.0.1:8545          ║"
echo "║  Operator 1:    http://localhost:50051 (gRPC)   ║"
echo "║  Operator 2:    http://localhost:50052 (gRPC)   ║"
if [[ "$START_UI" == "true" ]]; then
echo "║  Frontend:      http://localhost:5173           ║"
fi
echo "╠════════════════════════════════════════════════╣"
echo "║  Press Ctrl+C to stop all services              ║"
echo "╚════════════════════════════════════════════════╝"
echo ""

# Wait forever (until Ctrl+C)
wait
