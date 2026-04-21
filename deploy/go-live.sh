#!/usr/bin/env bash
# go-live.sh — Deploy AI Trading Blueprint via the Blueprint Manager (BPM)
#
# The BPM is the correct production entry point. It:
#   - Watches the chain for service requests
#   - Discovers and fetches blueprint binaries (from GitHub releases or local)
#   - Spawns and manages blueprint instances
#   - Handles lifecycle (restart on crash, wind-down, deprovision)
#
# This script automates:
#   1. Install cargo-tangle + build deps on server
#   2. Build the blueprint binary (so BPM can find it locally)
#   3. Deploy blueprint contracts to the configured EVM stack
#   4. Register the operator on restaking + blueprint layers
#   5. Request + approve a fixed-membership service instance
#   6. Start the Blueprint Manager via systemd
#
# Usage:
#   ./go-live.sh <server-ip> <operator-private-key>
#
# Environment variables (optional):
#   TANGLE_RPC=wss://rpc.tangle.tools          Tangle WS RPC
#   TANGLE_HTTP_RPC=https://rpc.tangle.tools   Tangle HTTP RPC
#   TANGLE_CONTRACT=0x...                      Tangle core contract
#   STAKING_CONTRACT=0x...                     Staking contract
#   STATUS_REGISTRY_CONTRACT=0x...             Status registry contract
#   CHAIN_ID=5845                              Chain ID
#   HYPERLIQUID_TESTNET=1                      Use HL testnet
#   SKIP_BUILD=1                               Skip building on server
#   BLUEPRINT_ID=N                             Use existing blueprint ID
#   REPO_URL=https://github.com/tangle-network/ai-trading-blueprint.git
#   REPO_REF=<branch-or-tag>                   Remote git ref to deploy

set -euo pipefail

SERVER_IP="${1:?Usage: go-live.sh <server-ip> <operator-private-key>}"
PRIVATE_KEY="${2:?Usage: go-live.sh <server-ip> <operator-private-key>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
TANGLE_RPC="${TANGLE_RPC:-wss://rpc.tangle.tools}"
TANGLE_HTTP_RPC="${TANGLE_HTTP_RPC:-https://rpc.tangle.tools}"
TANGLE_CONTRACT="${TANGLE_CONTRACT:-}"
STAKING_CONTRACT="${STAKING_CONTRACT:-}"
STATUS_REGISTRY_CONTRACT="${STATUS_REGISTRY_CONTRACT:-}"
CHAIN_ID="${CHAIN_ID:-5845}"
HL_TESTNET="${HYPERLIQUID_TESTNET:-0}"
SKIP_BUILD="${SKIP_BUILD:-0}"
BLUEPRINT_ID="${BLUEPRINT_ID:-}"
REPO_URL="${REPO_URL:-$(git -C "$REPO_DIR" remote get-url origin 2>/dev/null || echo "https://github.com/tangle-network/ai-trading-blueprint.git")}"
REPO_REF="${REPO_REF:-$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)}"
LOCAL_KEYSTORE_DIR="${LOCAL_KEYSTORE_DIR:-$REPO_DIR/.deploy-keystore}"
BLUEPRINT_DEFINITION="${BLUEPRINT_DEFINITION:-$REPO_DIR/blueprint-definition.json}"
OPERATOR_STAKE_AMOUNT="${OPERATOR_STAKE_AMOUNT:-1000000000000000000}"

# Derive operator address from private key
OPERATOR_ADDRESS=$(cast wallet address --private-key "$PRIVATE_KEY" 2>/dev/null || echo "")
if [ -z "$OPERATOR_ADDRESS" ]; then
  echo "ERROR: Could not derive address. Is 'cast' (foundry) installed?"
  exit 1
fi
echo "Operator: $OPERATOR_ADDRESS"

decode_cast_uint() {
  local value
  value="$(printf '%s\n' "$1" | awk '{print $1}' | tr -d '\r\n')"
  if [[ "$value" == 0x* ]]; then
    cast to-dec "$value"
  else
    printf '%s\n' "$value"
  fi
}

if [ -z "$TANGLE_CONTRACT" ] || [ -z "$STAKING_CONTRACT" ] || [ -z "$STATUS_REGISTRY_CONTRACT" ]; then
  echo "ERROR: TANGLE_CONTRACT, STAKING_CONTRACT, and STATUS_REGISTRY_CONTRACT must be set"
  exit 1
fi

# ──────────────────────────────────────────────────────────────────────────────
# Step 1: Install deps + Rust + cargo-tangle on server
# ──────────────────────────────────────────────────────────────────────────────

echo "=== Step 1: Setting up server $SERVER_IP ==="
ssh "root@$SERVER_IP" bash <<'REMOTE'
set -euo pipefail

echo "Installing build dependencies..."
apt-get update -qq
apt-get install -y --no-install-recommends \
  build-essential pkg-config libssl-dev protobuf-compiler libprotobuf-dev git \
  cmake clang libclang-dev curl docker.io >/dev/null 2>&1

if ! command -v rustc &>/dev/null; then
  echo "Installing Rust..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain 1.91.0
fi
source ~/.cargo/env

# Swap for compilation
if ! swapon --show | grep -q swapfile; then
  echo "Adding 4GB swap..."
  fallocate -l 4G /mnt/trading-data/swapfile 2>/dev/null || true
  chmod 600 /mnt/trading-data/swapfile
  mkswap /mnt/trading-data/swapfile 2>/dev/null || true
  swapon /mnt/trading-data/swapfile 2>/dev/null || true
fi

# State + data directories
mkdir -p /mnt/trading-data/blueprint-state
mkdir -p /mnt/trading-data/bpm-data
mkdir -p /mnt/trading-data/bpm-cache
chmod 700 /mnt/trading-data/blueprint-state
mkdir -p /opt/trading-blueprint

echo "Server setup complete"
rustc --version
REMOTE

# ──────────────────────────────────────────────────────────────────────────────
# Step 2: Build blueprint binary + install cargo-tangle on server
# ──────────────────────────────────────────────────────────────────────────────

if [ "$SKIP_BUILD" = "1" ]; then
  echo "=== Skipping build (SKIP_BUILD=1) ==="
else
  echo "=== Step 2: Building on $SERVER_IP ==="
  ssh "root@$SERVER_IP" env REPO_URL="$REPO_URL" REPO_REF="$REPO_REF" bash <<'REMOTE'
set -euo pipefail
source ~/.cargo/env

cd /opt/trading-blueprint
if [ ! -d repo ]; then
  git clone "$REPO_URL" repo
else
  cd repo && git fetch --all --tags && cd ..
fi

cd repo
git fetch --all --tags
git checkout "$REPO_REF"
git pull --ff-only origin "$REPO_REF" || true
# Comment out [patch] sections for remote build
sed -i '/^\[patch\./,/^$/s/^/#/' Cargo.toml

echo "Building blueprint binary..."
CARGO_BUILD_JOBS=2 cargo build --release -p trading-blueprint-bin
echo "Binary: $(ls -lh target/release/trading-blueprint | awk '{print $5}')"

# Also install cargo-tangle (the BPM) from the blueprint SDK
echo "Installing cargo-tangle (Blueprint Manager)..."
if [ ! -d /opt/trading-blueprint/blueprint-sdk ]; then
  git clone https://github.com/tangle-network/blueprint.git /opt/trading-blueprint/blueprint-sdk
fi
cd /opt/trading-blueprint/blueprint-sdk
CARGO_BUILD_JOBS=2 cargo install --path cli 2>&1 | tail -3
echo "cargo-tangle installed: $(cargo tangle --version 2>/dev/null || echo 'check path')"
REMOTE
fi

# ──────────────────────────────────────────────────────────────────────────────
# Step 3: Set up keystores
# ──────────────────────────────────────────────────────────────────────────────

echo "=== Step 3: Setting up keystores ==="
mkdir -p "$LOCAL_KEYSTORE_DIR"
if [ -z "$(find "$LOCAL_KEYSTORE_DIR" -mindepth 1 -print -quit 2>/dev/null)" ]; then
  cargo tangle key import \
    --key-type ecdsa \
    --secret "${PRIVATE_KEY#0x}" \
    --keystore-path "$LOCAL_KEYSTORE_DIR" \
    --protocol tangle
fi

ssh "root@$SERVER_IP" bash <<REMOTE
set -euo pipefail
KEYSTORE_DIR="/mnt/trading-data/blueprint-state/keystore"
mkdir -p "\$KEYSTORE_DIR"
chmod 700 "\$KEYSTORE_DIR"

if [ -z "\$(ls -A \$KEYSTORE_DIR 2>/dev/null)" ]; then
  source ~/.cargo/env
  cd /opt/trading-blueprint/repo
  cargo tangle key import \
    --key-type ecdsa \
    --secret "${PRIVATE_KEY#0x}" \
    --keystore-path "\$KEYSTORE_DIR" \
    --protocol tangle >/dev/null
  echo "Keystore initialized"
else
  echo "Keystore already exists"
fi
REMOTE

# ──────────────────────────────────────────────────────────────────────────────
# Step 4: Deploy blueprint contracts (locally, not on server)
# ──────────────────────────────────────────────────────────────────────────────

echo "=== Step 4: Deploying blueprint to Tangle ==="
cd "$REPO_DIR"

if [ -n "$BLUEPRINT_ID" ]; then
  echo "Using existing blueprint ID: $BLUEPRINT_ID"
else
  echo "Deploying new blueprint..."
  cargo tangle blueprint deploy tangle \
    --network testnet \
    --definition "$BLUEPRINT_DEFINITION" \
    --http-rpc-url "$TANGLE_HTTP_RPC" \
    --ws-rpc-url "$TANGLE_RPC" \
    --keystore-path "$LOCAL_KEYSTORE_DIR" \
    --tangle-contract "$TANGLE_CONTRACT" \
    --restaking-contract "$STAKING_CONTRACT" \
    --status-registry-contract "$STATUS_REGISTRY_CONTRACT" 2>&1 | tee /tmp/deploy-output.txt

  BLUEPRINT_ID=$(sed -n 's/.*blueprint=\([0-9][0-9]*\).*/\1/p' /tmp/deploy-output.txt | tail -1)
  echo "Deployed blueprint ID: $BLUEPRINT_ID"
fi

# ──────────────────────────────────────────────────────────────────────────────
# Step 5: Register as operator
# ──────────────────────────────────────────────────────────────────────────────

echo "=== Step 5: Registering as operator ==="
if [ -n "$BLUEPRINT_ID" ] && [ "$BLUEPRINT_ID" != "0" ]; then
  cargo tangle operator register \
    --http-rpc-url "$TANGLE_HTTP_RPC" \
    --ws-rpc-url "$TANGLE_RPC" \
    --keystore-path "$LOCAL_KEYSTORE_DIR" \
    --tangle-contract "$TANGLE_CONTRACT" \
    --restaking-contract "$STAKING_CONTRACT" \
    --status-registry-contract "$STATUS_REGISTRY_CONTRACT" \
    --amount "$OPERATOR_STAKE_AMOUNT" 2>&1 || echo "Restaking registration may already exist"

  cargo tangle blueprint register \
    --http-rpc-url "$TANGLE_HTTP_RPC" \
    --ws-rpc-url "$TANGLE_RPC" \
    --keystore-path "$LOCAL_KEYSTORE_DIR" \
    --tangle-contract "$TANGLE_CONTRACT" \
    --restaking-contract "$STAKING_CONTRACT" \
    --status-registry-contract "$STATUS_REGISTRY_CONTRACT" \
    --blueprint-id "$BLUEPRINT_ID" \
    2>&1 || echo "Blueprint registration may already exist"
fi

# ──────────────────────────────────────────────────────────────────────────────
# Step 6: Request + approve service instance
# ──────────────────────────────────────────────────────────────────────────────

SERVICE_ID=""
if [ -n "$TANGLE_CONTRACT" ] && [ -n "$STAKING_CONTRACT" ] && [ -n "$BLUEPRINT_ID" ] && [ "$BLUEPRINT_ID" != "0" ]; then
  SERVICE_COUNT_BEFORE=$(cast call "$TANGLE_CONTRACT" "serviceCount()(uint64)" --rpc-url "$TANGLE_HTTP_RPC" 2>/dev/null || echo "0x0")
  SERVICE_COUNT_BEFORE=$(decode_cast_uint "$SERVICE_COUNT_BEFORE")
  echo "=== Step 6: Requesting service instance ==="
  SERVICE_REQUEST_OUTPUT=$(cargo tangle blueprint service request \
    --http-rpc-url "$TANGLE_HTTP_RPC" \
    --ws-rpc-url "$TANGLE_RPC" \
    --keystore-path "$LOCAL_KEYSTORE_DIR" \
    --tangle-contract "$TANGLE_CONTRACT" \
    --restaking-contract "$STAKING_CONTRACT" \
    --status-registry-contract "$STATUS_REGISTRY_CONTRACT" \
    --blueprint-id "$BLUEPRINT_ID" \
    --operator "$OPERATOR_ADDRESS" \
    --ttl 0 \
    --json 2>&1 || echo "{}")
  REQUEST_ID=$(echo "$SERVICE_REQUEST_OUTPUT" | grep -oP '"request_id":\s*\K\d+' 2>/dev/null || echo "")
  if [ -z "$REQUEST_ID" ]; then
    echo "ERROR: Could not parse request_id from service request output"
    echo "$SERVICE_REQUEST_OUTPUT"
    exit 1
  fi

  cargo tangle blueprint service approve \
    --http-rpc-url "$TANGLE_HTTP_RPC" \
    --ws-rpc-url "$TANGLE_RPC" \
    --keystore-path "$LOCAL_KEYSTORE_DIR" \
    --tangle-contract "$TANGLE_CONTRACT" \
    --restaking-contract "$STAKING_CONTRACT" \
    --status-registry-contract "$STATUS_REGISTRY_CONTRACT" \
    --request-id "$REQUEST_ID" \
    --restaking-percent 100 \
    --json

  sleep 2
  SERVICE_COUNT_AFTER=$(cast call "$TANGLE_CONTRACT" "serviceCount()(uint64)" --rpc-url "$TANGLE_HTTP_RPC" 2>/dev/null || echo "0x0")
  SERVICE_COUNT_AFTER=$(decode_cast_uint "$SERVICE_COUNT_AFTER")
  if [ "$SERVICE_COUNT_AFTER" -le "$SERVICE_COUNT_BEFORE" ]; then
    echo "ERROR: serviceCount did not increase after approval"
    exit 1
  fi
  SERVICE_ID=$((SERVICE_COUNT_AFTER - 1))
  echo "Request ID: $REQUEST_ID"
  echo "Service ID: $SERVICE_ID"
else
  echo "=== Step 6: SKIP (set TANGLE_CONTRACT + STAKING_CONTRACT for auto-request) ==="
  SERVICE_ID="1"
fi

# ──────────────────────────────────────────────────────────────────────────────
# Step 7: Install systemd unit for the Blueprint Manager
# ──────────────────────────────────────────────────────────────────────────────

echo "=== Step 7: Installing Blueprint Manager systemd service ==="
ssh "root@$SERVER_IP" bash <<REMOTE
cat > /etc/systemd/system/blueprint-manager.service << 'EOF'
[Unit]
Description=Tangle Blueprint Manager
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/trading-blueprint/repo
Environment=PATH=/root/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=RUST_LOG=info,blueprint_manager=debug,trading_blueprint=debug
ExecStart=/root/.cargo/bin/cargo-tangle blueprint run \
  --protocol tangle \
  --http-rpc-url ${TANGLE_HTTP_RPC} \
  --ws-rpc-url ${TANGLE_RPC} \
  --keystore-path /mnt/trading-data/blueprint-state/keystore \
  --data-dir /mnt/trading-data/bpm-data \
  --network testnet \
  --settings-file /opt/trading-blueprint/repo/settings.env \
  --no-vm \
  --allow-unchecked-attestations
Restart=always
RestartSec=10
TimeoutStopSec=30
KillSignal=SIGTERM

StandardOutput=journal
StandardError=journal
SyslogIdentifier=blueprint-manager

[Install]
WantedBy=multi-user.target
EOF

# Write settings.env for the BPM
SESSION_AUTH_SECRET="${SESSION_AUTH_SECRET:-$(cast keccak "tangle-trading-session-auth-v1:${PRIVATE_KEY#0x}")}"
cat > /opt/trading-blueprint/repo/settings.env << 'SETTINGSEOF'
BLUEPRINT_ID=${BLUEPRINT_ID:-0}
SERVICE_ID=${SERVICE_ID:-1}
TANGLE_CONTRACT=${TANGLE_CONTRACT}
STAKING_CONTRACT=${STAKING_CONTRACT}
STATUS_REGISTRY_CONTRACT=${STATUS_REGISTRY_CONTRACT}
PRIVATE_KEY=${PRIVATE_KEY}
OPERATOR_ADDRESS=${OPERATOR_ADDRESS}
HTTP_RPC_URL=${TANGLE_HTTP_RPC}
RPC_URL=${TANGLE_HTTP_RPC}
WS_RPC_URL=${TANGLE_RPC}
CHAIN_ID=${CHAIN_ID}
KEYSTORE_URI=/mnt/trading-data/blueprint-state/keystore
SESSION_AUTH_SECRET=${SESSION_AUTH_SECRET}
OPERATOR_MAX_CAPACITY=10
MARKET_DATA_BASE_URL=https://api.coingecko.com/api/v3
VALIDATION_DEADLINE_SECS=3600
VALIDATOR_MIN_SCORE=50
HYPERLIQUID_TESTNET=${HL_TESTNET}
BLUEPRINT_STATE_DIR=/mnt/trading-data/blueprint-state
SETTINGSEOF

chmod 600 /opt/trading-blueprint/repo/settings.env

systemctl daemon-reload
echo "Blueprint Manager systemd unit installed"
REMOTE

# ──────────────────────────────────────────────────────────────────────────────
# Step 8: Start the Blueprint Manager
# ──────────────────────────────────────────────────────────────────────────────

echo "=== Step 8: Starting Blueprint Manager ==="
ssh "root@$SERVER_IP" bash <<'REMOTE'
systemctl enable blueprint-manager
systemctl restart blueprint-manager
sleep 5
systemctl status blueprint-manager --no-pager | head -15
echo "---"
journalctl -u blueprint-manager --no-pager -n 15
REMOTE

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  BLUEPRINT MANAGER LIVE"
echo "  Server:       $SERVER_IP"
echo "  Operator:     $OPERATOR_ADDRESS"
echo "  Blueprint ID: ${BLUEPRINT_ID:-pending}"
echo "  Service ID:   ${SERVICE_ID:-pending}"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "The BPM is now watching the chain for service requests."
echo "When a service is requested and approved, it will:"
echo "  1. Discover the trading blueprint binary"
echo "  2. Spawn it with the correct env vars"
echo "  3. Manage its lifecycle (restart, wind-down, etc.)"
echo ""
echo "Commands:"
echo "  Watch logs:  ssh root@$SERVER_IP journalctl -fu blueprint-manager"
echo "  Status:      ssh root@$SERVER_IP systemctl status blueprint-manager"
echo "  Restart:     ssh root@$SERVER_IP systemctl restart blueprint-manager"
