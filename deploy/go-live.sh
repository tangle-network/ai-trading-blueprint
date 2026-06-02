#!/usr/bin/env bash
# go-live.sh — Deploy AI Trading Blueprint via the Blueprint Manager (BPM).
#
# Steps:
#   1. Bootstrap the server (Rust, swap, data dirs).
#   2. Build the trading blueprint binary + install cargo-tangle (BPM).
#   3. Import the operator key into a local + remote keystore.
#   4. Deploy blueprint contracts.
#   5. Register the operator on staking + blueprint layers.
#   6. Request + approve a service instance.
#   7. Install the BPM systemd unit with settings.env.
#   8. Start the BPM.
#
# Usage:
#   ./go-live.sh <server-ip> <operator-private-key>
#
# Required env:
#   TANGLE_CONTRACT, STAKING_CONTRACT, STATUS_REGISTRY_CONTRACT
#
# Optional env (sensible defaults shown):
#   TANGLE_RPC=wss://rpc.tangle.tools
#   TANGLE_HTTP_RPC=https://rpc.tangle.tools
#   CHAIN_ID=5845, HYPERLIQUID_TESTNET=0, SKIP_BUILD=0
#   BLUEPRINT_ID=<reuse-existing>
#   REPO_URL, REPO_REF (auto-detected from the current checkout)
#   OPERATOR_STAKE_AMOUNT=1e18 (wei)

set -euo pipefail

SERVER_IP="${1:?Usage: go-live.sh <server-ip> <operator-private-key>}"
PRIVATE_KEY="${2:?Usage: go-live.sh <server-ip> <operator-private-key>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
MANIFEST_DEFAULT="$REPO_DIR/deploy/manifests/base-sepolia/tnt-core.latest.json"
if [[ ! -f "$MANIFEST_DEFAULT" ]]; then
  MANIFEST_DEFAULT="$REPO_DIR/../tnt-core/deployments/base-sepolia/latest.json"
fi

DEFAULT_TANGLE_RPC="wss://rpc.tangle.tools"
DEFAULT_TANGLE_HTTP_RPC="https://rpc.tangle.tools"
DEFAULT_CHAIN_ID="5845"

TANGLE_RPC="${TANGLE_RPC:-$DEFAULT_TANGLE_RPC}"
TANGLE_HTTP_RPC="${TANGLE_HTTP_RPC:-$DEFAULT_TANGLE_HTTP_RPC}"
CHAIN_ID="${CHAIN_ID:-$DEFAULT_CHAIN_ID}"
HL_TESTNET="${HYPERLIQUID_TESTNET:-0}"
SKIP_BUILD="${SKIP_BUILD:-0}"
SKIP_BOOTSTRAP="${SKIP_BOOTSTRAP:-0}"
SKIP_REMOTE_KEYSTORE="${SKIP_REMOTE_KEYSTORE:-0}"
SKIP_OPERATOR_REGISTER="${SKIP_OPERATOR_REGISTER:-0}"
SKIP_SERVICE_CREATE="${SKIP_SERVICE_CREATE:-0}"
BLUEPRINT_ID="${BLUEPRINT_ID:-}"
SERVICE_ID="${SERVICE_ID:-}"
SERVICE_OPERATORS="${SERVICE_OPERATORS:-}"
SERVICE_PERMITTED_CALLERS="${SERVICE_PERMITTED_CALLERS:-}"
SERVICE_CONFIG_HEX="${SERVICE_CONFIG_HEX:-0x}"
SERVICE_TTL_SECONDS="${SERVICE_TTL_SECONDS:-0}"
SERVICE_PAYMENT_TOKEN="${SERVICE_PAYMENT_TOKEN:-0x0000000000000000000000000000000000000000}"
SERVICE_PAYMENT_AMOUNT="${SERVICE_PAYMENT_AMOUNT:-0}"
SERVICE_CONFIDENTIALITY="${SERVICE_CONFIDENTIALITY:-0}"
SERVICE_REQUEST_GAS_LIMIT="${SERVICE_REQUEST_GAS_LIMIT:-3000000}"
SERVICE_APPROVE_GAS_LIMIT="${SERVICE_APPROVE_GAS_LIMIT:-3000000}"
REPO_URL="${REPO_URL:-$(git -C "$REPO_DIR" remote get-url origin 2>/dev/null || echo "https://github.com/tangle-network/ai-trading-blueprint.git")}"
REPO_REF="${REPO_REF:-$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)}"
LOCAL_KEYSTORE_DIR="${LOCAL_KEYSTORE_DIR:-$REPO_DIR/.deploy-keystore}"
BLUEPRINT_DEFINITION="${BLUEPRINT_DEFINITION:-$REPO_DIR/blueprint-definition.json}"
OPERATOR_STAKE_AMOUNT="${OPERATOR_STAKE_AMOUNT:-1000000000000000000}"
TNT_CORE_DEPLOYMENT_MANIFEST="${TNT_CORE_DEPLOYMENT_MANIFEST:-$MANIFEST_DEFAULT}"

# ── Same-box Hyperliquid validator (HTTP-only, 1-of-1) + execution wiring ──────
# When RUN_VALIDATOR=1, the trading-validator binary runs as a second systemd
# unit on this box in HTTP-only mode (SERVICE_ID=0). The operator's HTTP API is
# pointed at it via VALIDATOR_ENDPOINTS and trusts its EIP-712 signer via
# TRADING_ENVELOPE_TRUSTED_SIGNERS. The validator signs over the EXECUTION chain
# domain (Hyperliquid/HyperEVM 998 by default), distinct from the Tangle chain.
RUN_VALIDATOR="${RUN_VALIDATOR:-0}"
VALIDATOR_SIGNER_KEY="${VALIDATOR_SIGNER_KEY:-}"
VALIDATOR_HTTP_PORT="${VALIDATOR_HTTP_PORT:-9090}"
EXECUTION_CHAIN_ID="${EXECUTION_CHAIN_ID:-998}"
EXECUTION_TRADE_VALIDATOR_ADDRESS="${EXECUTION_TRADE_VALIDATOR_ADDRESS:-}"
EXECUTION_RPC_URL="${EXECUTION_RPC_URL:-https://rpc.hyperliquid-testnet.xyz/evm}"
# Hyperliquid agent/API wallet that signs orders on Hyperliquid (testnet when
# HYPERLIQUID_TESTNET=1). Separate from the operator key by design.
HYPERLIQUID_API_WALLET_PRIVATE_KEY="${HYPERLIQUID_API_WALLET_PRIVATE_KEY:-}"

# When set to a release tag (e.g. v0.1.3), download the published operator
# (and, if RUN_VALIDATOR=1, validator) binaries from GitHub Releases instead of
# building from source on the box. Releases ship both x86_64- and
# aarch64-unknown-linux-gnu (since v0.1.3) so this works on ARM cax* boxes too.
# Cuts ~30-min source builds + ~10 GB of `target/` to a ~11 MB download.
USE_RELEASE_BINARY="${USE_RELEASE_BINARY:-}"
CORS_ALLOWED_ORIGINS="${CORS_ALLOWED_ORIGINS:-https://trading-arena.blueprint.tangle.tools,https://trading-arena.pages.dev}"

if [[ -z "${TANGLE_CONTRACT:-}" && -f "$TNT_CORE_DEPLOYMENT_MANIFEST" ]]; then
  # shellcheck source=/dev/null
  source "$REPO_DIR/scripts/load-base-sepolia-env.sh" "$TNT_CORE_DEPLOYMENT_MANIFEST"
  if [[ "$TANGLE_RPC" == "$DEFAULT_TANGLE_RPC" ]]; then
    TANGLE_RPC="$WS_RPC_URL"
  fi
  if [[ "$TANGLE_HTTP_RPC" == "$DEFAULT_TANGLE_HTTP_RPC" ]]; then
    TANGLE_HTTP_RPC="$HTTP_RPC_URL"
  fi
  if [[ "$CHAIN_ID" == "$DEFAULT_CHAIN_ID" ]]; then
    CHAIN_ID="$CHAIN_ID_FROM_MANIFEST"
  fi
fi

: "${TANGLE_CONTRACT:?TANGLE_CONTRACT must be set}"
: "${STAKING_CONTRACT:?STAKING_CONTRACT must be set}"
: "${STATUS_REGISTRY_CONTRACT:?STATUS_REGISTRY_CONTRACT must be set}"

OPERATOR_ADDRESS="$(cast wallet address --private-key "$PRIVATE_KEY" 2>/dev/null || true)"
[ -n "$OPERATOR_ADDRESS" ] || { echo "ERROR: 'cast' (foundry) is required"; exit 1; }
[ -f "$BLUEPRINT_DEFINITION" ] || { echo "ERROR: blueprint definition not found: $BLUEPRINT_DEFINITION"; exit 1; }
SERVICE_OPERATORS="${SERVICE_OPERATORS:-[$OPERATOR_ADDRESS]}"
SERVICE_PERMITTED_CALLERS="${SERVICE_PERMITTED_CALLERS:-[$OPERATOR_ADDRESS]}"

if [[ "$RUN_VALIDATOR" = "1" ]]; then
  : "${VALIDATOR_SIGNER_KEY:?RUN_VALIDATOR=1 requires VALIDATOR_SIGNER_KEY (the EIP-712 signing key; needs no on-chain funds)}"
  : "${EXECUTION_TRADE_VALIDATOR_ADDRESS:?RUN_VALIDATOR=1 requires EXECUTION_TRADE_VALIDATOR_ADDRESS (on-chain TradeValidator on the execution chain)}"
  VALIDATOR_SIGNER_ADDRESS="$(cast wallet address --private-key "$VALIDATOR_SIGNER_KEY" 2>/dev/null || true)"
  [ -n "$VALIDATOR_SIGNER_ADDRESS" ] || { echo "ERROR: VALIDATOR_SIGNER_KEY is not a valid private key"; exit 1; }
  # Point the operator's HTTP API at the local validator and trust its signer.
  VALIDATOR_ENDPOINTS="${VALIDATOR_ENDPOINTS:-http://127.0.0.1:${VALIDATOR_HTTP_PORT}}"
  if [[ -n "${TRADING_ENVELOPE_TRUSTED_SIGNERS:-}" ]]; then
    TRADING_ENVELOPE_TRUSTED_SIGNERS="${TRADING_ENVELOPE_TRUSTED_SIGNERS},${VALIDATOR_SIGNER_ADDRESS}"
  else
    TRADING_ENVELOPE_TRUSTED_SIGNERS="$VALIDATOR_SIGNER_ADDRESS"
  fi
  echo "Validator (HTTP-only) enabled: signer=$VALIDATOR_SIGNER_ADDRESS port=$VALIDATOR_HTTP_PORT execChain=$EXECUTION_CHAIN_ID"
fi

if ! command -v cargo-tangle >/dev/null 2>&1; then
  echo "ERROR: cargo-tangle is required locally" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required locally" >&2
  exit 1
fi

if actual_chain_id="$(cast chain-id --rpc-url "$TANGLE_HTTP_RPC" 2>/dev/null)"; then
  if [[ "$actual_chain_id" != "$CHAIN_ID" ]]; then
    echo "ERROR: chain id mismatch: expected $CHAIN_ID got $actual_chain_id" >&2
    exit 1
  fi
else
  echo "ERROR: unable to query chain id from $TANGLE_HTTP_RPC" >&2
  exit 1
fi

for contract in "$TANGLE_CONTRACT" "$STAKING_CONTRACT" "$STATUS_REGISTRY_CONTRACT"; do
  code="$(cast code "$contract" --rpc-url "$TANGLE_HTTP_RPC" 2>/dev/null || true)"
  if [[ -z "$code" || "$code" == "0x" ]]; then
    echo "ERROR: missing bytecode at $contract" >&2
    exit 1
  fi
done

echo "Operator: $OPERATOR_ADDRESS"

AI_PROVIDER_SETTINGS=""
if [[ -n "${ZAI_API_KEY:-}" ]]; then
  AI_PROVIDER_SETTINGS+="ZAI_API_KEY=${ZAI_API_KEY}"$'\n'
fi
if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  AI_PROVIDER_SETTINGS+="ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}"$'\n'
fi
if [[ -n "${TANGLE_API_KEY:-}" ]]; then
  AI_PROVIDER_SETTINGS+="TANGLE_API_KEY=${TANGLE_API_KEY}"$'\n'
fi
if [[ -n "${TANGLE_ROUTER_BASE_URL:-}" ]]; then
  AI_PROVIDER_SETTINGS+="TANGLE_ROUTER_BASE_URL=${TANGLE_ROUTER_BASE_URL}"$'\n'
fi
if [[ -n "${EXECUTOR_PRIVATE_KEY:-}" ]]; then
  AI_PROVIDER_SETTINGS+="EXECUTOR_PRIVATE_KEY=${EXECUTOR_PRIVATE_KEY}"$'\n'
fi
if [[ -n "${VALIDATOR_ENDPOINTS:-}" ]]; then
  AI_PROVIDER_SETTINGS+="VALIDATOR_ENDPOINTS=${VALIDATOR_ENDPOINTS}"$'\n'
fi
if [[ -n "${POLYMARKET_API_KEY:-}" ]]; then
  AI_PROVIDER_SETTINGS+="POLYMARKET_API_KEY=${POLYMARKET_API_KEY}"$'\n'
fi
if [[ -n "${POLYMARKET_API_SECRET:-}" ]]; then
  AI_PROVIDER_SETTINGS+="POLYMARKET_API_SECRET=${POLYMARKET_API_SECRET}"$'\n'
fi
if [[ -n "${POLYMARKET_API_PASSPHRASE:-}" ]]; then
  AI_PROVIDER_SETTINGS+="POLYMARKET_API_PASSPHRASE=${POLYMARKET_API_PASSPHRASE}"$'\n'
fi
if [[ -n "${HYPERLIQUID_API_WALLET_PRIVATE_KEY:-}" ]]; then
  AI_PROVIDER_SETTINGS+="HYPERLIQUID_API_WALLET_PRIVATE_KEY=${HYPERLIQUID_API_WALLET_PRIVATE_KEY}"$'\n'
fi
if [[ -n "${TRADING_ENVELOPE_TRUSTED_SIGNERS:-}" ]]; then
  AI_PROVIDER_SETTINGS+="TRADING_ENVELOPE_TRUSTED_SIGNERS=${TRADING_ENVELOPE_TRUSTED_SIGNERS}"$'\n'
fi

# Shared cargo-tangle args for commands that talk to the chain.
TANGLE_ARGS=(
  --http-rpc-url "$TANGLE_HTTP_RPC"
  --ws-rpc-url  "$TANGLE_RPC"
  --keystore-path "$LOCAL_KEYSTORE_DIR"
  --tangle-contract "$TANGLE_CONTRACT"
  --restaking-contract "$STAKING_CONTRACT"
  --status-registry-contract "$STATUS_REGISTRY_CONTRACT"
)

cast_uint() {
  local v
  v="$(printf '%s\n' "$1" | awk '{print $1}' | tr -d '\r\n')"
  [[ "$v" == 0x* ]] && cast to-dec "$v" || printf '%s\n' "$v"
}

service_count() {
  cast_uint "$(cast call "$TANGLE_CONTRACT" "serviceCount()(uint64)" --rpc-url "$TANGLE_HTTP_RPC" 2>/dev/null || echo 0)"
}

# Poll until `serviceCount()` exceeds `$1`, or timeout.
wait_for_service_count_above() {
  local threshold="$1" deadline=$(( $(date +%s) + 60 )) count
  while [ "$(date +%s)" -lt "$deadline" ]; do
    count="$(service_count)"
    if [ "$count" -gt "$threshold" ]; then
      echo "$count"
      return 0
    fi
    sleep 2
  done
  echo "ERROR: serviceCount did not exceed $threshold within 60s" >&2
  return 1
}

send_operator_tx() {
  local output="" tx_hash="" receipt="" status=""
  for _ in $(seq 1 5); do
    if output="$(
      cast send --async "$@" \
        --private-key "$PRIVATE_KEY" \
        --rpc-url "$TANGLE_HTTP_RPC" 2>&1
    )"; then
      tx_hash="$(printf '%s\n' "$output" | grep -Eo '0x[0-9a-fA-F]{64}' | tail -n 1)"
      if [[ -z "$tx_hash" ]]; then
        echo "$output"
        return 1
      fi

      for _ in $(seq 1 60); do
        receipt="$(cast rpc eth_getTransactionReceipt "$tx_hash" --rpc-url "$TANGLE_HTTP_RPC" 2>/dev/null || true)"
        if [[ -n "$receipt" && "$receipt" != "null" ]]; then
          status="$(printf '%s' "$receipt" | jq -r '.status')"
          if [[ "$status" == "0x1" || "$status" == "1" ]]; then
            return 0
          fi
          echo "$receipt"
          return 1
        fi
        sleep 2
      done

      echo "Timed out waiting for receipt: $tx_hash"
      return 1
    fi
    if grep -Eqi "replacement transaction underpriced|transaction already imported|nonce too low" <<<"$output"; then
      sleep 3
      continue
    fi
    echo "$output"
    return 1
  done
  echo "$output"
  return 1
}

# ──────────────────────────────────────────────────────────────────────────────
# Step 1: Bootstrap server
# ──────────────────────────────────────────────────────────────────────────────
if [[ "$SKIP_BOOTSTRAP" = "1" ]]; then
  echo "=== Step 1: skipped (SKIP_BOOTSTRAP=1) ==="
else
  echo "=== Step 1: Bootstrap $SERVER_IP ==="
  ssh "root@$SERVER_IP" bash <<'REMOTE'
set -euo pipefail

apt-get update -qq
apt-get install -y --no-install-recommends \
  build-essential pkg-config libssl-dev protobuf-compiler libprotobuf-dev git \
  cmake clang libclang-dev curl docker.io >/dev/null 2>&1

if ! command -v rustc &>/dev/null; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain 1.91.0
fi
source ~/.cargo/env

if ! swapon --show | grep -q swapfile; then
  fallocate -l 4G /mnt/trading-data/swapfile 2>/dev/null || true
  chmod 600 /mnt/trading-data/swapfile
  mkswap  /mnt/trading-data/swapfile 2>/dev/null || true
  swapon  /mnt/trading-data/swapfile 2>/dev/null || true
fi

mkdir -p /mnt/trading-data/blueprint-state /mnt/trading-data/bpm-data /mnt/trading-data/bpm-cache /opt/trading-blueprint
chmod 700 /mnt/trading-data/blueprint-state

rustc --version
REMOTE
fi

# ──────────────────────────────────────────────────────────────────────────────
# Step 2: Build blueprint binary + install cargo-tangle (BPM) on server
# ──────────────────────────────────────────────────────────────────────────────
if [ "$SKIP_BUILD" = "1" ]; then
  echo "=== Step 2: skipped (SKIP_BUILD=1) ==="
else
  echo "=== Step 2: Build on $SERVER_IP ==="
  ssh "root@$SERVER_IP" env REPO_URL="$REPO_URL" REPO_REF="$REPO_REF" RUN_VALIDATOR="$RUN_VALIDATOR" USE_RELEASE_BINARY="$USE_RELEASE_BINARY" bash <<'REMOTE'
set -euo pipefail
source ~/.cargo/env

cd /opt/trading-blueprint
[ -d repo ] || git clone "$REPO_URL" repo
cd repo
git fetch --all --tags
git checkout "$REPO_REF"
git pull --ff-only origin "$REPO_REF" || true

if [[ -n "${USE_RELEASE_BINARY:-}" ]]; then
  # Download pre-built operator (and, if RUN_VALIDATOR=1, validator) binaries
  # from GitHub Releases instead of compiling on-box. Matches host arch;
  # v0.1.3+ ships both x86_64- and aarch64-unknown-linux-gnu via the matrix
  # release.yml. Cuts a ~30 min build + ~10 GB target/ to an ~11 MB download.
  TAG="$USE_RELEASE_BINARY"
  case "$(uname -m)" in
    aarch64|arm64) TGT="aarch64-unknown-linux-gnu" ;;
    x86_64|amd64)  TGT="x86_64-unknown-linux-gnu" ;;
    *) echo "ERROR: unsupported arch $(uname -m); unset USE_RELEASE_BINARY to build from source" >&2; exit 1 ;;
  esac
  mkdir -p target/release
  BINS=("trading-blueprint")
  [[ "${RUN_VALIDATOR:-0}" = "1" ]] && BINS+=("trading-validator")
  for b in "${BINS[@]}"; do
    A="${b}-${TGT}.tar.xz"
    URL="https://github.com/tangle-network/ai-trading-blueprint/releases/download/${TAG}/${A}"
    echo "downloading ${URL}"
    curl -fsSL "${URL}" -o "/tmp/${A}"
    curl -fsSL "${URL}.sha256" -o "/tmp/${A}.sha256"
    (cd /tmp && sha256sum -c "${A}.sha256")
    tar -xJf "/tmp/${A}" -C target/release
    chmod +x "target/release/${b}"
    ls -lh "target/release/${b}" | awk -v n="$b" '{print n": "$5}'
    rm -f "/tmp/${A}" "/tmp/${A}.sha256"
  done
else
  CARGO_BUILD_JOBS=2 cargo build --release -p trading-blueprint-bin
  ls -lh target/release/trading-blueprint | awk '{print "Binary: "$5}'

  if [[ "${RUN_VALIDATOR:-0}" = "1" ]]; then
    CARGO_BUILD_JOBS=2 cargo build --release -p trading-validator-bin
    ls -lh target/release/trading-validator | awk '{print "Validator binary: "$5}'
  fi
fi

# Install cargo-tangle (the BPM) from the blueprint SDK.
[ -d /opt/trading-blueprint/blueprint-sdk ] || \
  git clone https://github.com/tangle-network/blueprint.git /opt/trading-blueprint/blueprint-sdk
cd /opt/trading-blueprint/blueprint-sdk
CARGO_BUILD_JOBS=2 cargo install --path cli 2>&1 | tail -3
cargo tangle --version || true
REMOTE
fi

# ──────────────────────────────────────────────────────────────────────────────
# Step 3: Keystores (local for deploy, remote for BPM)
# ──────────────────────────────────────────────────────────────────────────────
echo "=== Step 3: Keystores ==="
mkdir -p "$LOCAL_KEYSTORE_DIR"
if [ -z "$(find "$LOCAL_KEYSTORE_DIR" -mindepth 1 -print -quit 2>/dev/null)" ]; then
  cargo tangle key import \
    --key-type ecdsa \
    --secret "${PRIVATE_KEY#0x}" \
    --keystore-path "$LOCAL_KEYSTORE_DIR" \
    --protocol tangle
fi

if [[ "$SKIP_REMOTE_KEYSTORE" = "1" ]]; then
  echo "Remote keystore step skipped (SKIP_REMOTE_KEYSTORE=1)"
else
  ssh "root@$SERVER_IP" bash <<REMOTE
set -euo pipefail
K=/mnt/trading-data/blueprint-state/keystore
mkdir -p "\$K" && chmod 700 "\$K"
if [ -z "\$(ls -A "\$K" 2>/dev/null)" ]; then
  source ~/.cargo/env
  cd /opt/trading-blueprint/repo
  cargo tangle key import \
    --key-type ecdsa \
    --secret "${PRIVATE_KEY#0x}" \
    --keystore-path "\$K" \
    --protocol tangle >/dev/null
  echo "Keystore initialized"
else
  echo "Keystore already exists"
fi
REMOTE
fi

# ──────────────────────────────────────────────────────────────────────────────
# Step 4: Deploy blueprint contracts
# ──────────────────────────────────────────────────────────────────────────────
echo "=== Step 4: Deploy blueprint ==="
cd "$REPO_DIR"

if [ -n "$BLUEPRINT_ID" ]; then
  echo "Using existing blueprint ID: $BLUEPRINT_ID"
else
  cargo tangle blueprint deploy tangle \
    --network testnet \
    --definition "$BLUEPRINT_DEFINITION" \
    "${TANGLE_ARGS[@]}" 2>&1 | tee /tmp/deploy-output.txt

  BLUEPRINT_ID="$(sed -n 's/.*blueprint=\([0-9][0-9]*\).*/\1/p' /tmp/deploy-output.txt | tail -1)"
  [ -n "$BLUEPRINT_ID" ] && [ "$BLUEPRINT_ID" != "0" ] || { echo "ERROR: could not parse blueprint_id from deploy output"; exit 1; }
  echo "Deployed blueprint ID: $BLUEPRINT_ID"
fi

# ──────────────────────────────────────────────────────────────────────────────
# Step 5: Register operator (staking + blueprint)
# ──────────────────────────────────────────────────────────────────────────────
if [[ "$SKIP_OPERATOR_REGISTER" = "1" ]]; then
  echo "=== Step 5: skipped (SKIP_OPERATOR_REGISTER=1) ==="
else
  echo "=== Step 5: Register operator ==="
  cargo tangle operator register \
    "${TANGLE_ARGS[@]}" \
    --amount "$OPERATOR_STAKE_AMOUNT" 2>&1 || echo "(staking registration already exists, continuing)"

  cargo tangle blueprint register \
    "${TANGLE_ARGS[@]}" \
    --blueprint-id "$BLUEPRINT_ID" 2>&1 || echo "(blueprint registration already exists, continuing)"
fi

# ──────────────────────────────────────────────────────────────────────────────
# Step 6: Request + approve service instance
# ──────────────────────────────────────────────────────────────────────────────
if [[ -n "$SERVICE_ID" || "$SKIP_SERVICE_CREATE" = "1" ]]; then
  echo "=== Step 6: skipped service create (SERVICE_ID=${SERVICE_ID:-<unset>} SKIP_SERVICE_CREATE=$SKIP_SERVICE_CREATE) ==="
  if [[ -z "$SERVICE_ID" ]]; then
    echo "ERROR: SERVICE_ID must be set when SKIP_SERVICE_CREATE=1" >&2
    exit 1
  fi
else
  echo "=== Step 6: Request + approve service ==="
  if [[ "$SERVICE_CONFIG_HEX" != 0x* ]]; then
    echo "ERROR: SERVICE_CONFIG_HEX must be hex bytes, got: $SERVICE_CONFIG_HEX" >&2
    exit 1
  fi
  SERVICE_COUNT_BEFORE="$(service_count)"
  REQUEST_ID="$(cast_uint "$(cast call "$TANGLE_CONTRACT" "serviceRequestCount()(uint64)" --rpc-url "$TANGLE_HTTP_RPC")")"

  # Direct cast flow targets the tnt-core 0.13 service ABI deployed on Base Sepolia.
  # cargo-tangle may be newer/older than the live diamond and has previously sent
  # a stale requestService selector, leaving go-live blocked after operator setup.
  if ! send_operator_tx "$TANGLE_CONTRACT" \
    "requestService(uint64,address[],bytes,address[],uint64,address,uint256,uint8)" \
    "$BLUEPRINT_ID" \
    "$SERVICE_OPERATORS" \
    "$SERVICE_CONFIG_HEX" \
    "$SERVICE_PERMITTED_CALLERS" \
    "$SERVICE_TTL_SECONDS" \
    "$SERVICE_PAYMENT_TOKEN" \
    "$SERVICE_PAYMENT_AMOUNT" \
    "$SERVICE_CONFIDENTIALITY" \
    --gas-limit "$SERVICE_REQUEST_GAS_LIMIT"; then
    echo "ERROR: requestService failed for blueprint $BLUEPRINT_ID"
    exit 1
  fi

  APPROVAL_PARAMS="($REQUEST_ID,[],[0,0,0,0],[0,0],[])"
  if ! send_operator_tx "$TANGLE_CONTRACT" \
    "approveService((uint64,(uint8,address,uint16)[],uint256[4],uint256[2],(uint8,bytes32,bytes32,uint64)[]))" \
    "$APPROVAL_PARAMS" \
    --gas-limit "$SERVICE_APPROVE_GAS_LIMIT"; then
    echo "ERROR: approveService failed for request $REQUEST_ID"
    exit 1
  fi

  SERVICE_COUNT_AFTER="$(wait_for_service_count_above "$SERVICE_COUNT_BEFORE")"
  SERVICE_ID=$(( SERVICE_COUNT_AFTER - 1 ))
  echo "Request ID: $REQUEST_ID  Service ID: $SERVICE_ID"
fi

# ──────────────────────────────────────────────────────────────────────────────
# Step 7: Install systemd unit + settings.env
# ──────────────────────────────────────────────────────────────────────────────
echo "=== Step 7: Install BPM systemd unit ==="
ssh "root@$SERVER_IP" env AI_PROVIDER_SETTINGS="$AI_PROVIDER_SETTINGS" bash <<REMOTE
set -euo pipefail
cat > /etc/systemd/system/blueprint-manager.service <<'EOF'
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
ExecStart=/root/.cargo/bin/cargo-tangle blueprint run \\
  --protocol tangle \\
  --http-rpc-url ${TANGLE_HTTP_RPC} \\
  --ws-rpc-url ${TANGLE_RPC} \\
  --keystore-path /mnt/trading-data/blueprint-state/keystore \\
  --data-dir /mnt/trading-data/bpm-data \\
  --network testnet \\
  --settings-file /opt/trading-blueprint/repo/settings.env \\
  --no-vm \\
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

cat > /opt/trading-blueprint/repo/settings.env <<EOF
BLUEPRINT_ID=${BLUEPRINT_ID}
SERVICE_ID=${SERVICE_ID}
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
OPERATOR_MAX_CAPACITY=10
MARKET_DATA_BASE_URL=https://api.coingecko.com/api/v3
VALIDATION_DEADLINE_SECS=3600
VALIDATOR_MIN_SCORE=50
HYPERLIQUID_TESTNET=${HL_TESTNET}
BLUEPRINT_STATE_DIR=/mnt/trading-data/blueprint-state
CORS_ALLOWED_ORIGINS=${CORS_ALLOWED_ORIGINS}
EOF
chmod 600 /opt/trading-blueprint/repo/settings.env
printf '%s' "\$AI_PROVIDER_SETTINGS" >> /opt/trading-blueprint/repo/settings.env

# SESSION_AUTH_SECRET is derived on first boot by the binary
# (trading_blueprint_lib::session_auth::ensure_from_env) using the keystore
# or PRIVATE_KEY — same algorithm cross-run, no shell-side derivation needed.

systemctl daemon-reload
REMOTE

# ──────────────────────────────────────────────────────────────────────────────
# Step 7b: Install + start the same-box validator (HTTP-only, 1-of-1)
# ──────────────────────────────────────────────────────────────────────────────
if [[ "$RUN_VALIDATOR" = "1" ]]; then
  echo "=== Step 7b: Install validator systemd unit ==="
  ssh "root@$SERVER_IP" \
    env VALIDATOR_SIGNER_KEY="$VALIDATOR_SIGNER_KEY" \
        VALIDATOR_HTTP_PORT="$VALIDATOR_HTTP_PORT" \
        EXECUTION_CHAIN_ID="$EXECUTION_CHAIN_ID" \
        EXECUTION_TRADE_VALIDATOR_ADDRESS="$EXECUTION_TRADE_VALIDATOR_ADDRESS" \
        EXECUTION_RPC_URL="$EXECUTION_RPC_URL" \
        VALIDATOR_SIGNER_ADDRESS="$VALIDATOR_SIGNER_ADDRESS" \
        bash <<REMOTE
set -euo pipefail
cat > /opt/trading-blueprint/repo/validator.env <<EOF
# HTTP-only validator (SERVICE_ID=0): signs envelopes/intents over the execution
# chain EIP-712 domain. Needs no on-chain funds — the signer address is trusted
# by the operator via TRADING_ENVELOPE_TRUSTED_SIGNERS and configured into vaults.
SERVICE_ID=0
VALIDATOR_HTTP_PORT=${VALIDATOR_HTTP_PORT}
PRIVATE_KEY=${VALIDATOR_SIGNER_KEY}
OPERATOR_ADDRESS=${VALIDATOR_SIGNER_ADDRESS}
EXECUTION_CHAIN_ID=${EXECUTION_CHAIN_ID}
EXECUTION_TRADE_VALIDATOR_ADDRESS=${EXECUTION_TRADE_VALIDATOR_ADDRESS}
EXECUTION_RPC_URL=${EXECUTION_RPC_URL}
EOF
chmod 600 /opt/trading-blueprint/repo/validator.env

cat > /etc/systemd/system/trading-validator.service <<'EOF'
[Unit]
Description=Tangle Trading Validator (HTTP-only)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/trading-blueprint/repo
EnvironmentFile=/opt/trading-blueprint/repo/validator.env
Environment=RUST_LOG=info,trading_validator=debug
ExecStart=/opt/trading-blueprint/repo/target/release/trading-validator
Restart=always
RestartSec=10
TimeoutStopSec=30
KillSignal=SIGTERM
StandardOutput=journal
StandardError=journal
SyslogIdentifier=trading-validator

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable trading-validator
systemctl restart trading-validator
sleep 3
systemctl status trading-validator --no-pager | head -10
echo "--- validator health ---"
curl -fsS "http://127.0.0.1:${VALIDATOR_HTTP_PORT}/health" 2>/dev/null | head -1 || echo "(no /health yet — check journal)"
REMOTE
fi

# ──────────────────────────────────────────────────────────────────────────────
# Step 8: Start the BPM
# ──────────────────────────────────────────────────────────────────────────────
echo "=== Step 8: Start BPM ==="
ssh "root@$SERVER_IP" bash <<'REMOTE'
systemctl enable blueprint-manager
systemctl restart blueprint-manager
sleep 5
systemctl status blueprint-manager --no-pager | head -15
echo "---"
journalctl -u blueprint-manager --no-pager -n 15
REMOTE

cat <<EOF

════════════════════════════════════════════════════════════════
  BLUEPRINT MANAGER LIVE
  Server:       $SERVER_IP
  Operator:     $OPERATOR_ADDRESS
  Blueprint ID: $BLUEPRINT_ID
  Service ID:   $SERVICE_ID
════════════════════════════════════════════════════════════════

Watch logs:  ssh root@$SERVER_IP journalctl -fu blueprint-manager
Status:      ssh root@$SERVER_IP systemctl status blueprint-manager
Restart:     ssh root@$SERVER_IP systemctl restart blueprint-manager
EOF

if [[ "$RUN_VALIDATOR" = "1" ]]; then
  cat <<EOF
  Validator:    http://127.0.0.1:$VALIDATOR_HTTP_PORT (HTTP-only, signer $VALIDATOR_SIGNER_ADDRESS)
  Exec chain:   $EXECUTION_CHAIN_ID  TradeValidator: $EXECUTION_TRADE_VALIDATOR_ADDRESS
  Validator logs: ssh root@$SERVER_IP journalctl -fu trading-validator

  Provision a bot vault with this validator as the 1-of-1 signer:
    signers=[$VALIDATOR_SIGNER_ADDRESS]  required_signatures=1
EOF
fi
