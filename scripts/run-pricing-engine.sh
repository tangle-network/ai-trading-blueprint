#!/usr/bin/env bash
# Run a pricing engine instance for one operator.
#
# Requires: pricing-engine-server binary (from ../blueprint), running Anvil instance.
#
# Usage:
#   ./scripts/run-pricing-engine.sh --config scripts/operator1.toml
#   ./scripts/run-pricing-engine.sh --config scripts/operator2.toml
#
# Or run both operators:
#   ./scripts/run-pricing-engine.sh --both

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Defaults (override via env)
: "${HTTP_RPC_URL:=http://127.0.0.1:8545}"
: "${WS_RPC_URL:=ws://127.0.0.1:8545}"
: "${TANGLE_CONTRACT:=0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9}"
: "${RESTAKING_CONTRACT:=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512}"
: "${STATUS_REGISTRY_CONTRACT:=0x99bbA657f2BbC93c02D617f8bA121cB8Fc104Acf}"
: "${BLUEPRINT_ID:=0}"
: "${PRICING_CONFIG:=$SCRIPT_DIR/default_pricing.toml}"

# Resolve pricing engine binary
PRICING_BIN="${PRICING_ENGINE_BIN:-$(command -v pricing-engine-server 2>/dev/null || echo "$ROOT_DIR/../blueprint/target/release/pricing-engine-server")}"

if [[ ! -x "$PRICING_BIN" ]]; then
  echo "ERROR: pricing-engine-server not found at $PRICING_BIN"
  echo "Build it: cd ../blueprint && cargo build -p blueprint-pricing-engine --release"
  exit 1
fi

# Parse --both flag
if [[ "${1:-}" == "--both" ]]; then
  echo "Starting both pricing engines..."

  # Operator 1 in background
  "$0" --config "$SCRIPT_DIR/operator1.toml" &
  PID1=$!

  # Operator 2 in background
  "$0" --config "$SCRIPT_DIR/operator2.toml" &
  PID2=$!

  echo "  Operator 1 PID: $PID1 (port 50051)"
  echo "  Operator 2 PID: $PID2 (port 50052)"

  # Wait for either to exit
  trap "kill $PID1 $PID2 2>/dev/null; exit" INT TERM
  wait -n
  exit $?
fi

# Default config file
CONFIG="${CONFIG:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) CONFIG="$2"; shift 2 ;;
    *) break ;;
  esac
done

if [[ -z "$CONFIG" ]]; then
  CONFIG="$SCRIPT_DIR/operator1.toml"
fi

# Use default pricing config if the per-operator one doesn't exist
if [[ ! -f "$PRICING_CONFIG" ]]; then
  PRICING_CONFIG="$ROOT_DIR/../blueprint/crates/pricing-engine/config/default_pricing.toml"
fi

echo "Starting pricing engine"
echo "  Config:  $CONFIG"
echo "  Pricing: $PRICING_CONFIG"
echo "  RPC:     $HTTP_RPC_URL"
echo "  Binary:  $PRICING_BIN"

exec "$PRICING_BIN" \
  --config "$CONFIG" \
  --pricing-config "$PRICING_CONFIG" \
  --http-rpc-endpoint "$HTTP_RPC_URL" \
  --ws-rpc-endpoint "$WS_RPC_URL" \
  --blueprint-id "$BLUEPRINT_ID" \
  --tangle-contract "$TANGLE_CONTRACT" \
  --restaking-contract "$RESTAKING_CONTRACT" \
  --status-registry-contract "$STATUS_REGISTRY_CONTRACT" \
  "$@"
