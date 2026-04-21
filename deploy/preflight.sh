#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-paper}"
ENV_FILE="${2:-}"

if [[ -n "$ENV_FILE" ]]; then
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "ERROR: env file not found: $ENV_FILE" >&2
    exit 1
  fi
  # shellcheck disable=SC1090
  source "$ENV_FILE"
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

check_any() {
  local label="$1"
  shift
  local found=0
  local var
  for var in "$@"; do
    if [[ -n "${!var:-}" ]]; then
      printf '  [ok]   %s via %s\n' "$label" "$var"
      found=1
      break
    fi
  done
  if [[ "$found" -eq 0 ]]; then
    printf '  [miss] %s (%s)\n' "$label" "$*"
    missing=1
  fi
}

echo "=== Trading Blueprint Preflight ($MODE) ==="

echo "Protocol"
check_var HTTP_RPC_URL
check_var WS_RPC_URL
check_var CHAIN_ID
check_var TANGLE_CONTRACT
check_any STAKING_CONTRACT STAKING_CONTRACT RESTAKING_CONTRACT
check_var STATUS_REGISTRY_CONTRACT
check_var BLUEPRINT_ID
check_var SERVICE_ID

echo "Operator"
check_var PRIVATE_KEY
check_var OPERATOR_ADDRESS
check_var KEYSTORE_URI false
check_any AI_PROVIDER_KEY ZAI_API_KEY ANTHROPIC_API_KEY

echo "Runtime"
check_var OPERATOR_API_PORT false
check_var TRADING_API_PORT false
check_var SIDECAR_IMAGE false
check_var SESSION_AUTH_SECRET false

echo "Strategy/Execution"
check_var VALIDATOR_ENDPOINTS false
check_var HYPERLIQUID_TESTNET false
check_var EXECUTOR_PRIVATE_KEY false
check_var POLYMARKET_API_KEY false
check_var POLYMARKET_API_SECRET false
check_var POLYMARKET_API_PASSPHRASE false

if [[ "$MODE" == "live" ]]; then
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
  "./deploy/setup-hetzner.sh" \
  "./scripts/load-base-sepolia-env.sh" \
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
