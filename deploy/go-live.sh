#!/usr/bin/env bash
# go-live.sh — End-to-end deployment of the AI Trading Blueprint
#
# This script automates the full sequence:
#   1. Build the binary on the Hetzner server (or use pre-built)
#   2. Generate operator keystore
#   3. Deploy blueprint contracts to Tangle testnet
#   4. Register as operator
#   5. Configure .env
#   6. Start the service
#
# Prerequisites:
#   - SSH access to the target server (ssh root@<ip> works)
#   - cargo-tangle CLI installed locally (cargo tangle --help)
#   - Funded operator wallet on Tangle testnet
#
# Usage:
#   ./go-live.sh <server-ip> <operator-private-key>
#
# Environment variables (optional):
#   TANGLE_RPC=wss://rpc.tangle.tools       Tangle RPC endpoint
#   CHAIN_ID=5845                            Chain ID
#   HYPERLIQUID_TESTNET=1                    Use HL testnet (default: mainnet)
#   SKIP_BUILD=1                             Skip building on server

set -euo pipefail

SERVER_IP="${1:?Usage: go-live.sh <server-ip> <operator-private-key>}"
PRIVATE_KEY="${2:?Usage: go-live.sh <server-ip> <operator-private-key>}"
TANGLE_RPC="${TANGLE_RPC:-wss://rpc.tangle.tools}"
TANGLE_HTTP_RPC="${TANGLE_HTTP_RPC:-https://rpc.tangle.tools}"
CHAIN_ID="${CHAIN_ID:-5845}"
HL_TESTNET="${HYPERLIQUID_TESTNET:-0}"
SKIP_BUILD="${SKIP_BUILD:-0}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

# Derive operator address from private key
OPERATOR_ADDRESS=$(cast wallet address --private-key "$PRIVATE_KEY" 2>/dev/null || echo "")
if [ -z "$OPERATOR_ADDRESS" ]; then
  echo "ERROR: Could not derive address from private key. Is 'cast' installed?"
  exit 1
fi
echo "Operator: $OPERATOR_ADDRESS"

# ──────────────────────────────────────────────────────────────────────────────
# Step 1: Build on server (or skip)
# ──────────────────────────────────────────────────────────────────────────────

if [ "$SKIP_BUILD" = "1" ]; then
  echo "=== Skipping build (SKIP_BUILD=1) ==="
else
  echo "=== Step 1: Building on $SERVER_IP ==="
  ssh "root@$SERVER_IP" bash <<'REMOTE'
set -euo pipefail
source ~/.cargo/env 2>/dev/null || true

cd /opt/trading-blueprint
if [ ! -d repo ]; then
  git clone --branch feat/hyperliquid-native-perps \
    https://github.com/tangle-network/ai-trading-blueprint.git repo
else
  cd repo && git pull && cd ..
fi

cd repo
# Comment out [patch] sections for remote build
sed -i '/^\[patch\./,/^$/s/^/#/' Cargo.toml

cargo build --release -p trading-blueprint-bin
cp target/release/trading-blueprint-bin /usr/local/bin/trading-blueprint
echo "Binary installed: $(ls -lh /usr/local/bin/trading-blueprint | awk '{print $5}')"
REMOTE
fi

# ──────────────────────────────────────────────────────────────────────────────
# Step 2: Generate keystore on server
# ──────────────────────────────────────────────────────────────────────────────

echo "=== Step 2: Setting up keystore ==="
ssh "root@$SERVER_IP" bash <<REMOTE
set -euo pipefail
KEYSTORE_DIR="/mnt/trading-data/blueprint-state/keystore"
mkdir -p "\$KEYSTORE_DIR"
chmod 700 "\$KEYSTORE_DIR"

if [ -z "\$(ls -A \$KEYSTORE_DIR 2>/dev/null)" ]; then
  echo "Generating new keystore..."
  # Import the operator key into the keystore
  echo "${PRIVATE_KEY}" > /tmp/operator-key.hex
  # The key file is just the raw hex — blueprint-sdk reads it
  cp /tmp/operator-key.hex "\$KEYSTORE_DIR/operator.key"
  chmod 600 "\$KEYSTORE_DIR/operator.key"
  rm /tmp/operator-key.hex
  echo "Keystore initialized at \$KEYSTORE_DIR"
else
  echo "Keystore already exists at \$KEYSTORE_DIR"
fi
REMOTE

# ──────────────────────────────────────────────────────────────────────────────
# Step 3: Deploy blueprint contracts
# ──────────────────────────────────────────────────────────────────────────────

echo "=== Step 3: Deploying blueprint to Tangle testnet ==="
cd "$REPO_DIR"

# Check if already deployed
BLUEPRINT_ID=$(cargo tangle blueprint list-blueprints \
  --ws-rpc-url "$TANGLE_RPC" 2>/dev/null | grep "trading" | head -1 | awk '{print $1}' || echo "")

if [ -n "$BLUEPRINT_ID" ]; then
  echo "Blueprint already deployed: ID=$BLUEPRINT_ID"
else
  echo "Deploying new blueprint..."
  cargo tangle blueprint deploy tangle \
    --http-rpc-url "$TANGLE_HTTP_RPC" \
    --ws-rpc-url "$TANGLE_RPC" \
    --package trading-blueprint-bin \
    --keystore-path ./keystore 2>&1 | tee /tmp/deploy-output.txt

  BLUEPRINT_ID=$(grep -oP 'blueprint_id[=: ]+\K\d+' /tmp/deploy-output.txt 2>/dev/null || echo "0")
  echo "Deployed blueprint ID: $BLUEPRINT_ID"
fi

# ──────────────────────────────────────────────────────────────────────────────
# Step 4: Register as operator
# ──────────────────────────────────────────────────────────────────────────────

echo "=== Step 4: Registering as operator ==="
if [ -n "$BLUEPRINT_ID" ] && [ "$BLUEPRINT_ID" != "0" ]; then
  cargo tangle blueprint register \
    --blueprint-id "$BLUEPRINT_ID" \
    --ws-rpc-url "$TANGLE_RPC" \
    --keystore-uri ./keystore 2>&1 || echo "Registration may already exist"
else
  echo "WARN: No blueprint ID — skipping registration. Deploy contracts first."
fi

# ──────────────────────────────────────────────────────────────────────────────
# Step 5: Configure .env on server
# ──────────────────────────────────────────────────────────────────────────────

echo "=== Step 5: Writing .env ==="
ssh "root@$SERVER_IP" bash <<REMOTE
cat > /opt/trading-blueprint/.env << 'ENVEOF'
# Generated by go-live.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)

# Tangle Protocol
BLUEPRINT_ID=${BLUEPRINT_ID:-0}
SERVICE_ID=1
CHAIN=testnet
HTTP_RPC_URL=${TANGLE_HTTP_RPC}
CHAIN_ID=${CHAIN_ID}

# Operator
PRIVATE_KEY=${PRIVATE_KEY}
OPERATOR_ADDRESS=${OPERATOR_ADDRESS}

# Keystore
KEYSTORE_URI=/mnt/trading-data/blueprint-state/keystore

# Trading
OPERATOR_MAX_CAPACITY=10
MARKET_DATA_BASE_URL=https://api.coingecko.com/api/v3
VALIDATION_DEADLINE_SECS=3600
VALIDATOR_MIN_SCORE=50

# Hyperliquid
HYPERLIQUID_TESTNET=${HL_TESTNET}

# State
BLUEPRINT_STATE_DIR=/mnt/trading-data/blueprint-state

# Logging
RUST_LOG=info,trading_blueprint_lib=debug,trading_runtime=debug
ENVEOF

chmod 600 /opt/trading-blueprint/.env
echo ".env configured"
REMOTE

# ──────────────────────────────────────────────────────────────────────────────
# Step 6: Start the service
# ──────────────────────────────────────────────────────────────────────────────

echo "=== Step 6: Starting trading-blueprint service ==="
ssh "root@$SERVER_IP" bash <<'REMOTE'
systemctl daemon-reload
systemctl enable trading-blueprint
systemctl restart trading-blueprint
sleep 3
systemctl status trading-blueprint --no-pager | head -15
echo "---"
journalctl -u trading-blueprint --no-pager -n 10
REMOTE

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  TRADING BLUEPRINT LIVE"
echo "  Server:   $SERVER_IP"
echo "  Operator: $OPERATOR_ADDRESS"
echo "  API:      http://$SERVER_IP:9100/health"
echo "  Admin:    http://$SERVER_IP:9200/health"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "Next steps:"
echo "  1. Verify health: curl http://$SERVER_IP:9100/health"
echo "  2. Fund HL wallet: send testnet USDC to $OPERATOR_ADDRESS"
echo "  3. Request a service on Tangle testnet"
echo "  4. Watch logs: ssh root@$SERVER_IP journalctl -fu trading-blueprint"
