#!/usr/bin/env bash
set -euo pipefail

# Own dir, kept in a uniquely-named var: `source load-base-sepolia-env.sh` below
# sets its own SCRIPT_DIR, which would otherwise clobber ours and send the
# preflight/go-live lookups into scripts/ instead of deploy/.
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$DEPLOY_DIR"
ROOT_DIR="$(dirname "$DEPLOY_DIR")"
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

# go-live.sh only maps HTTP_RPC_URL/WS_RPC_URL → TANGLE_*_RPC when TANGLE_CONTRACT
# is unset, but we just exported it — so hand it the Base Sepolia RPCs directly,
# else it falls back to the Tangle-L1 default (rpc.tangle.tools) and the chain-id
# preflight fails.
export TANGLE_HTTP_RPC="${TANGLE_HTTP_RPC:-$HTTP_RPC_URL}"
export TANGLE_RPC="${TANGLE_RPC:-$WS_RPC_URL}"

if [[ "$REQUIRE_PRODUCTION_PREFLIGHT" == "1" ]]; then
  "$DEPLOY_DIR/preflight.sh" production
elif [[ "$SKIP_PREFLIGHT" != "1" ]]; then
  "$DEPLOY_DIR/preflight.sh" live
fi

exec "$DEPLOY_DIR/go-live.sh" "$SERVER_IP" "$PRIVATE_KEY"
