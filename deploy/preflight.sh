#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
MODE="${1:-paper}"
ENV_FILE="${2:-}"
MANIFEST_DEFAULT="$ROOT_DIR/../tnt-core/deployments/base-sepolia/latest.json"
if [[ -f "$ROOT_DIR/deploy/manifests/base-sepolia/tnt-core.latest.json" ]]; then
  MANIFEST_DEFAULT="$ROOT_DIR/deploy/manifests/base-sepolia/tnt-core.latest.json"
fi
MANIFEST_PATH="${TNT_CORE_DEPLOYMENT_MANIFEST:-$MANIFEST_DEFAULT}"

if [[ -n "$ENV_FILE" ]]; then
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "ERROR: env file not found: $ENV_FILE" >&2
    exit 1
  fi
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

if [[ -z "${TANGLE_CONTRACT:-}" && -f "$MANIFEST_PATH" ]]; then
  # shellcheck disable=SC1090
  source "$ROOT_DIR/scripts/load-base-sepolia-env.sh" "$MANIFEST_PATH"
fi

if [[ "$MODE" != "paper" && "$MODE" != "live" ]]; then
  echo "Usage: $0 [paper|live] [optional-env-file]" >&2
  exit 1
fi

missing=0

check_var() {
  local name="$1"
  local required="${2:-true}"
  if [[ -n "${!name:-}" ]]; then
    printf '  [ok]   %s\n' "$name"
  elif [[ "$required" == "true" ]]; then
    printf '  [miss] %s\n' "$name"
    missing=1
  else
    printf '  [warn] %s\n' "$name"
  fi
}

check_rpc_state() {
  local expected_chain_id actual_chain_id

  if ! command -v cast >/dev/null 2>&1; then
    printf '  [warn] cast (foundry) missing; skipping live RPC checks\n'
    return
  fi

  if [[ -z "${HTTP_RPC_URL:-}" ]]; then
    printf '  [warn] HTTP_RPC_URL missing; skipping live RPC checks\n'
    return
  fi

  if ! actual_chain_id="$(cast chain-id --rpc-url "$HTTP_RPC_URL" 2>/dev/null)"; then
    printf '  [miss] RPC chain-id check failed for %s\n' "$HTTP_RPC_URL"
    missing=1
    return
  fi

  expected_chain_id="${CHAIN_ID:-}"
  if [[ -n "$expected_chain_id" && "$actual_chain_id" != "$expected_chain_id" ]]; then
    printf '  [miss] chain id mismatch: expected %s got %s\n' "$expected_chain_id" "$actual_chain_id"
    missing=1
  else
    printf '  [ok]   chain id %s\n' "$actual_chain_id"
  fi

  for pair in \
    "TANGLE_CONTRACT:tangle" \
    "STAKING_CONTRACT:staking" \
    "STATUS_REGISTRY_CONTRACT:status-registry"
  do
    local var_name="${pair%%:*}"
    local label="${pair##*:}"
    local address="${!var_name:-}"
    local code=""

    if [[ -z "$address" ]]; then
      continue
    fi

    code="$(cast code "$address" --rpc-url "$HTTP_RPC_URL" 2>/dev/null || true)"
    if [[ -z "$code" || "$code" == "0x" ]]; then
      printf '  [miss] %s bytecode missing at %s\n' "$label" "$address"
      missing=1
    else
      printf '  [ok]   %s bytecode present at %s\n' "$label" "$address"
    fi
  done
}

echo "=== Trading Blueprint Preflight ($MODE) ==="

echo "Protocol"
check_var HTTP_RPC_URL
check_var WS_RPC_URL
check_var CHAIN_ID
check_var TANGLE_CONTRACT
check_var STAKING_CONTRACT
check_var STATUS_REGISTRY_CONTRACT
check_var BLUEPRINT_ID false
check_var SERVICE_ID false
check_rpc_state

echo "Operator"
check_var PRIVATE_KEY
check_var OPERATOR_ADDRESS
check_var KEYSTORE_URI false
if [[ -n "${ZAI_API_KEY:-}" ]]; then
  printf '  [ok]   AI_PROVIDER_KEY via ZAI_API_KEY\n'
elif [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  printf '  [ok]   AI_PROVIDER_KEY via ANTHROPIC_API_KEY\n'
elif [[ -n "${TANGLE_ROUTER_API_KEY:-}" ]]; then
  printf '  [ok]   AI_PROVIDER_KEY via TANGLE_ROUTER_API_KEY\n'
else
  printf '  [miss] AI_PROVIDER_KEY (ZAI_API_KEY, ANTHROPIC_API_KEY, or TANGLE_ROUTER_API_KEY)\n'
  missing=1
fi

echo "Runtime"
check_var OPERATOR_API_PORT false
check_var TRADING_API_PORT false
check_var SIDECAR_IMAGE false
check_var SESSION_AUTH_SECRET false
check_var TANGLE_ROUTER_BASE_URL false

echo "Strategy/Execution"
check_var VALIDATOR_ENDPOINTS false
check_var HYPERLIQUID_TESTNET false
check_var EXECUTOR_PRIVATE_KEY false
check_var POLYMARKET_API_KEY false
check_var POLYMARKET_API_SECRET false
check_var POLYMARKET_API_PASSPHRASE false

if [[ "$MODE" == "live" ]]; then
  if [[ -z "${BLUEPRINT_ID:-}" ]]; then
    echo "  [warn] BLUEPRINT_ID missing; deploy/bootstrap flow may create it"
  fi
  if [[ -z "${SERVICE_ID:-}" ]]; then
    echo "  [warn] SERVICE_ID missing; deploy/bootstrap flow may create it"
  fi
  if [[ -z "${VALIDATOR_ENDPOINTS:-}" ]]; then
    echo "  [warn] VALIDATOR_ENDPOINTS missing; live mode depends on on-chain discovery or explicit validator endpoints"
  fi
  if [[ -z "${EXECUTOR_PRIVATE_KEY:-}" && -z "${PRIVATE_KEY:-}" ]]; then
    echo "  [miss] no signing key available for live execution"
    missing=1
  fi
fi

echo "Local references"
for path in \
  "./deploy/go-live.sh" \
  "./deploy/go-live-base-sepolia.sh" \
  "./deploy/setup-hetzner.sh" \
  "./scripts/load-base-sepolia-env.sh" \
  "./deploy/manifests/base-sepolia/tnt-core.latest.json" \
  "../blueprint-agent/devscripts/secrets/default/dev-vars.enc"
do
  if [[ -e "$path" ]]; then
    printf '  [ok]   %s\n' "$path"
  else
    printf '  [warn] %s\n' "$path"
  fi
done

echo
if [[ "$missing" -eq 0 ]]; then
  echo "Preflight passed for $MODE mode."
else
  echo "Preflight failed for $MODE mode."
  exit 1
fi
