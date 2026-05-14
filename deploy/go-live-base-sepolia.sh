#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
SERVER_IP="${1:?Usage: go-live-base-sepolia.sh <server-ip> <operator-private-key> [manifest-path] }"
PRIVATE_KEY="${2:?Usage: go-live-base-sepolia.sh <server-ip> <operator-private-key> [manifest-path] }"
MANIFEST_PATH="${3:-${TNT_CORE_DEPLOYMENT_MANIFEST:-$ROOT_DIR/deploy/manifests/base-sepolia/tnt-core.latest.json}}"
SKIP_PREFLIGHT="${SKIP_PREFLIGHT:-0}"
REQUIRE_PRODUCTION_PREFLIGHT="${REQUIRE_PRODUCTION_PREFLIGHT:-0}"

if [[ "$REQUIRE_PRODUCTION_PREFLIGHT" == "1" && "$SKIP_PREFLIGHT" == "1" ]]; then
  echo "ERROR: SKIP_PREFLIGHT=1 is blocked when REQUIRE_PRODUCTION_PREFLIGHT=1" >&2
  exit 1
fi

export TNT_CORE_DEPLOYMENT_MANIFEST="$MANIFEST_PATH"
export PRIVATE_KEY
if command -v cast >/dev/null 2>&1; then
  export OPERATOR_ADDRESS="${OPERATOR_ADDRESS:-$(cast wallet address --private-key "$PRIVATE_KEY" 2>/dev/null || true)}"
fi

if [[ -z "${ZAI_API_KEY:-}" && -z "${ANTHROPIC_API_KEY:-}" && -z "${TANGLE_API_KEY:-}" ]]; then
  echo "ERROR: load ZAI_API_KEY, ANTHROPIC_API_KEY, or TANGLE_API_KEY before running the live operator deploy" >&2
  exit 1
fi

# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/load-base-sepolia-env.sh" "$MANIFEST_PATH"

if [[ "$REQUIRE_PRODUCTION_PREFLIGHT" == "1" ]]; then
  "$SCRIPT_DIR/preflight.sh" production
elif [[ "$SKIP_PREFLIGHT" != "1" ]]; then
  "$SCRIPT_DIR/preflight.sh" live
fi

exec "$SCRIPT_DIR/go-live.sh" "$SERVER_IP" "$PRIVATE_KEY"
