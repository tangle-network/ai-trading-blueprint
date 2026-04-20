#!/usr/bin/env bash
# Setup script for a Hetzner Cloud VM running the trading blueprint.
#
# Prerequisites:
#   - hcloud CLI installed and authenticated (hcloud context create)
#   - SSH key registered in Hetzner Cloud
#
# Usage:
#   ./setup-hetzner.sh [server-name] [ssh-key-name]
#
# This script:
#   1. Creates a CX22 VM (2 vCPU, 4GB RAM, 40GB disk) — ~€4/mo
#   2. Attaches a 50GB Hetzner Cloud Volume for persistent state
#   3. Installs Docker + docker-compose
#   4. Copies deploy files and .env to the server
#   5. Starts the trading blueprint
#
# Storage strategy: Hetzner Cloud Volumes are detachable — if you outgrow
# the VM, detach the volume, create a bigger VM, reattach. Data survives.
# 50GB is enough for ~5 years of bot state at 10 bots.

set -euo pipefail

SERVER_NAME="${1:-trading-operator}"
SSH_KEY="${2:-default}"
LOCATION="fsn1"  # Falkenstein, cheapest EU DC
SERVER_TYPE="cx22"  # 2 vCPU, 4GB RAM, 40GB SSD — €3.99/mo
VOLUME_SIZE=50  # GB — enough for years of state
VOLUME_NAME="${SERVER_NAME}-state"

echo "=== Creating Hetzner Cloud Volume (${VOLUME_SIZE}GB) ==="
hcloud volume create \
  --name "$VOLUME_NAME" \
  --size "$VOLUME_SIZE" \
  --location "$LOCATION" \
  --format ext4 || echo "Volume may already exist"

echo "=== Creating Hetzner VM ($SERVER_TYPE in $LOCATION) ==="
hcloud server create \
  --name "$SERVER_NAME" \
  --type "$SERVER_TYPE" \
  --image ubuntu-24.04 \
  --location "$LOCATION" \
  --ssh-key "$SSH_KEY" || echo "Server may already exist"

# Get server IP
SERVER_IP=$(hcloud server ip "$SERVER_NAME")
echo "Server IP: $SERVER_IP"

echo "=== Attaching volume ==="
hcloud volume attach "$VOLUME_NAME" --server "$SERVER_NAME" || echo "Volume may already be attached"

echo "=== Waiting for SSH ==="
for i in $(seq 1 30); do
  ssh -o ConnectTimeout=2 -o StrictHostKeyChecking=no "root@$SERVER_IP" true 2>/dev/null && break
  sleep 2
done

echo "=== Installing Docker + build deps ==="
ssh "root@$SERVER_IP" bash <<'REMOTE'
set -euo pipefail

# Install Docker
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
fi

# All build deps in one shot (Rust compilation needs these)
apt-get update -qq
apt-get install -y --no-install-recommends \
  build-essential pkg-config libssl-dev protobuf-compiler git \
  cmake clang libclang-dev curl docker-compose-plugin >/dev/null 2>&1

# Install Rust
if ! command -v rustc &>/dev/null; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain 1.91.0
fi

# Mount the volume (Hetzner attaches at /dev/disk/by-id/scsi-0HC_Volume_*)
VOLUME_DEV=$(ls /dev/disk/by-id/scsi-0HC_Volume_* 2>/dev/null | head -1)
if [ -n "$VOLUME_DEV" ]; then
  mkdir -p /mnt/trading-state
  if ! mountpoint -q /mnt/trading-state; then
    mount "$VOLUME_DEV" /mnt/trading-state
    echo "$VOLUME_DEV /mnt/trading-state ext4 defaults 0 2" >> /etc/fstab
  fi
  echo "Volume mounted at /mnt/trading-state"
else
  echo "WARNING: No Hetzner volume found, using local disk"
  mkdir -p /mnt/trading-state
fi

mkdir -p /mnt/trading-state/blueprint-state
chmod 700 /mnt/trading-state/blueprint-state

# Create deploy directory
mkdir -p /opt/trading-blueprint
REMOTE

echo "=== Copying deploy files ==="
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
scp "$SCRIPT_DIR/docker-compose.yml" "root@$SERVER_IP:/opt/trading-blueprint/"

# Copy .env if it exists locally
if [ -f "$SCRIPT_DIR/.env" ]; then
  scp "$SCRIPT_DIR/.env" "root@$SERVER_IP:/opt/trading-blueprint/"
  ssh "root@$SERVER_IP" "chmod 600 /opt/trading-blueprint/.env"
else
  echo "WARNING: No .env file found at $SCRIPT_DIR/.env"
  echo "Copy .env.example, fill in values, and scp to root@$SERVER_IP:/opt/trading-blueprint/.env"
fi

echo ""
echo "=== Setup complete ==="
echo "Server: $SERVER_NAME ($SERVER_IP)"
echo "Volume: $VOLUME_NAME (${VOLUME_SIZE}GB at /mnt/trading-state)"
echo ""
echo "Next steps:"
echo "  1. Create /opt/trading-blueprint/.env on the server (see .env.example)"
echo "  2. Build and push Docker image, or download release binary"
echo "  3. ssh root@$SERVER_IP 'cd /opt/trading-blueprint && docker compose up -d'"
echo ""
echo "To deploy with a release binary (no Docker build on server):"
echo "  VERSION=latest"
echo "  ssh root@$SERVER_IP 'curl -fsSL https://github.com/tangle-network/ai-trading-blueprint/releases/download/\$VERSION/trading-blueprint-linux-amd64 -o /usr/local/bin/trading-blueprint && chmod +x /usr/local/bin/trading-blueprint'"
