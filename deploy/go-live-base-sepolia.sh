#!/usr/bin/env bash
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$DEPLOY_DIR")"
SERVER_IP="${1:?Usage: go-live-base-sepolia.sh <server-ip> <operator-private-key> [manifest-path] }"
PRIVATE_KEY="${2:?Usage: go-live-base-sepolia.sh <server-ip> <operator-private-key> [manifest-path] }"
MANIFEST_PATH="${3:-${TNT_CORE_DEPLOYMENT_MANIFEST:-$ROOT_DIR/deploy/manifests/base-sepolia/tnt-core.latest.json}}"
SKIP_PREFLIGHT="${SKIP_PREFLIGHT:-0}"

export TNT_CORE_DEPLOYMENT_MANIFEST="$MANIFEST_PATH"
export PRIVATE_KEY
if command -v cast >/dev/null 2>&1; then
  export OPERATOR_ADDRESS="${OPERATOR_ADDRESS:-$(cast wallet address --private-key "$PRIVATE_KEY" 2>/dev/null || true)}"
fi

if [[ -z "${ZAI_API_KEY:-}" && -z "${ANTHROPIC_API_KEY:-}" && -z "${TANGLE_ROUTER_API_KEY:-}" ]]; then
  echo "ERROR: load ZAI_API_KEY, ANTHROPIC_API_KEY, or TANGLE_ROUTER_API_KEY before running the live operator deploy" >&2
  exit 1
fi

# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/load-base-sepolia-env.sh" "$MANIFEST_PATH"

if [[ "$SKIP_PREFLIGHT" != "1" ]]; then
  "$DEPLOY_DIR/preflight.sh" live
fi

exec "$DEPLOY_DIR/go-live.sh" "$SERVER_IP" "$PRIVATE_KEY"
