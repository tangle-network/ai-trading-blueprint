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

if [[ "$MODE" != "paper" && "$MODE" != "live" && "$MODE" != "production" ]]; then
  echo "Usage: $0 [paper|live|production] [optional-env-file]" >&2
  exit 1
fi

missing=0

is_production() {
  [[ "$MODE" == "production" ]]
}

mark_miss() {
  printf '  [miss] %s\n' "$1"
  missing=1
}

mark_ok() {
  printf '  [ok]   %s\n' "$1"
}

mark_warn() {
  printf '  [warn] %s\n' "$1"
}

check_var() {
  local name="$1"
  local required="${2:-true}"
  if [[ -n "${!name:-}" ]]; then
    mark_ok "$name"
  elif [[ "$required" == "true" ]]; then
    mark_miss "$name"
  else
    mark_warn "$name"
  fi
}

check_rpc_state() {
  local expected_chain_id actual_chain_id

  if ! command -v cast >/dev/null 2>&1; then
    if is_production; then
      mark_miss "cast (foundry) missing; production RPC checks cannot run"
    else
      mark_warn "cast (foundry) missing; skipping live RPC checks"
    fi
    return
  fi

  if [[ -z "${HTTP_RPC_URL:-}" ]]; then
    if is_production; then
      mark_miss "HTTP_RPC_URL missing; production RPC checks cannot run"
    else
      mark_warn "HTTP_RPC_URL missing; skipping live RPC checks"
    fi
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

is_zero_address() {
  local address
  address="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  [[ "$address" == "0x0000000000000000000000000000000000000000" ]]
}

is_hex_address() {
  [[ "$1" =~ ^0x[0-9a-fA-F]{40}$ ]]
}

is_placeholder_address() {
  local address
  address="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  [[ "$address" == "0x0000000000000000000000000000000000000001" || "$address" == factory:* ]]
}

decimal_lt() {
  local left="$1"
  local right="$2"
  left="${left#"${left%%[!0]*}"}"
  right="${right#"${right%%[!0]*}"}"
  left="${left:-0}"
  right="${right:-0}"
  if (( ${#left} != ${#right} )); then
    (( ${#left} < ${#right} ))
  else
    [[ "$left" < "$right" ]]
  fi
}

check_address_var() {
  local name="$1"
  local value="${!name:-}"
  if [[ -z "$value" ]]; then
    mark_miss "$name"
  elif ! is_hex_address "$value"; then
    mark_miss "$name invalid address: $value"
  elif is_zero_address "$value" || is_placeholder_address "$value"; then
    mark_miss "$name placeholder address: $value"
  else
    mark_ok "$name $value"
  fi
}

cast_call() {
  local address="$1"
  local signature="$2"
  shift 2
  cast call "$address" "$signature" "$@" --rpc-url "$HTTP_RPC_URL" 2>/dev/null | xargs
}

check_contract_code() {
  local label="$1"
  local address="$2"
  local code
  if [[ -z "$address" ]]; then
    mark_miss "$label address missing"
    return
  fi
  if ! is_hex_address "$address" || is_zero_address "$address" || is_placeholder_address "$address"; then
    mark_miss "$label invalid or placeholder address: $address"
    return
  fi
  code="$(cast code "$address" --rpc-url "$HTTP_RPC_URL" 2>/dev/null || true)"
  if [[ -z "$code" || "$code" == "0x" ]]; then
    mark_miss "$label bytecode missing at $address"
  else
    mark_ok "$label bytecode present at $address"
  fi
}

check_latest_block_freshness() {
  local max_age="${MAX_BLOCK_AGE_SECS:-120}"
  local block timestamp now age
  block="$(cast block latest --rpc-url "$HTTP_RPC_URL" 2>/dev/null || true)"
  timestamp="$(printf '%s\n' "$block" | awk '/timestamp/ {print $2; exit}')"
  if [[ -z "$timestamp" || ! "$timestamp" =~ ^[0-9]+$ ]]; then
    mark_miss "latest block timestamp unavailable"
    return
  fi
  now="$(date +%s)"
  age=$((now - timestamp))
  if (( age < 0 )); then
    age=0
  fi
  if (( age > max_age )); then
    mark_miss "latest block stale: ${age}s old (max ${max_age}s)"
  else
    mark_ok "latest block fresh: ${age}s old"
  fi
}

check_signer() {
  local key="${EXECUTOR_PRIVATE_KEY:-${PRIVATE_KEY:-}}"
  local derived expected balance min_balance
  if [[ -z "$key" ]]; then
    mark_miss "EXECUTOR_PRIVATE_KEY or PRIVATE_KEY required for production trading"
    return
  fi
  if ! derived="$(cast wallet address --private-key "$key" 2>/dev/null | xargs)"; then
    mark_miss "could not derive signer address from execution key"
    return
  fi
  expected="${EXECUTOR_ADDRESS:-${OPERATOR_ADDRESS:-}}"
  if [[ -n "$expected" && "$(printf '%s' "$derived" | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$expected" | tr '[:upper:]' '[:lower:]')" ]]; then
    mark_miss "signer address mismatch: expected $expected got $derived"
  else
    mark_ok "signer address $derived"
  fi
  min_balance="${MIN_SIGNER_GAS_WEI:-1000000000000000}"
  balance="$(cast balance "$derived" --rpc-url "$HTTP_RPC_URL" 2>/dev/null | xargs || true)"
  if [[ -z "$balance" || ! "$balance" =~ ^[0-9]+$ ]]; then
    mark_miss "signer gas balance unavailable for $derived"
  elif decimal_lt "$balance" "$min_balance"; then
    mark_miss "signer gas balance too low: $balance wei (min $min_balance)"
  else
    mark_ok "signer gas balance $balance wei"
  fi
}

check_validator_endpoints() {
  local endpoints_raw="${VALIDATOR_ENDPOINTS:-}"
  local quorum="${VALIDATOR_QUORUM:-${REQUIRED_VALIDATOR_QUORUM:-1}}"
  local endpoint trimmed health_url reachable=0 seen=","
  local -a endpoints=()

  if [[ -z "$endpoints_raw" ]]; then
    mark_miss "VALIDATOR_ENDPOINTS required for production trading"
    return
  fi

  IFS=',' read -ra endpoints <<< "$endpoints_raw"
  for endpoint in "${endpoints[@]}"; do
    trimmed="$(printf '%s' "$endpoint" | xargs)"
    if [[ -z "$trimmed" ]]; then
      continue
    fi
    if [[ "$seen" == *",$trimmed,"* ]]; then
      mark_miss "duplicate validator endpoint: $trimmed"
      continue
    fi
    seen="${seen}${trimmed},"
    health_url="${trimmed%/}/health"
    if curl -fsS --max-time "${VALIDATOR_HEALTH_TIMEOUT_SECS:-5}" "$health_url" >/dev/null 2>&1; then
      reachable=$((reachable + 1))
      mark_ok "validator reachable $trimmed"
    else
      mark_miss "validator unreachable $trimmed"
    fi
  done

  if (( reachable < quorum )); then
    mark_miss "validator quorum not met: reachable $reachable need $quorum"
  else
    mark_ok "validator quorum reachable $reachable/$quorum"
  fi
}

check_csv_contract_allowlist() {
  local label="$1"
  local values="$2"
  local vault="$3"
  local policy="$4"
  local signature="$5"
  local value allowed
  local -a items=()
  if [[ -z "$values" ]]; then
    mark_miss "$label list missing"
    return
  fi
  IFS=',' read -ra items <<< "$values"
  for value in "${items[@]}"; do
    value="$(printf '%s' "$value" | xargs)"
    if [[ -z "$value" ]]; then
      continue
    fi
    if ! is_hex_address "$value" || is_zero_address "$value" || is_placeholder_address "$value"; then
      mark_miss "$label invalid address: $value"
      continue
    fi
    allowed="$(cast_call "$policy" "$signature" "$vault" "$value" || true)"
    if [[ "$allowed" == "true" ]]; then
      mark_ok "$label whitelisted $value"
    else
      mark_miss "$label not whitelisted $value"
    fi
  done
}

run_production_probe() {
  local api_url="${PRODUCTION_TRADING_API_URL:-}"
  local protocol="${PRODUCTION_PROBE_PROTOCOL:-uniswap_v3}"
  local token_in="${PRODUCTION_PROBE_TOKEN_IN:-}"
  local token_out="${PRODUCTION_PROBE_TOKEN_OUT:-}"
  local amount_in="${PRODUCTION_PROBE_AMOUNT_IN:-}"
  local min_out="${PRODUCTION_PROBE_MIN_AMOUNT_OUT:-}"
  local token="${TRADING_API_TOKEN:-${PRODUCTION_TRADING_API_TOKEN:-}}"
  local body response status
  local probe_out="/tmp/trading-preflight-probe.$$.out"
  local probe_err="/tmp/trading-preflight-probe.$$.err"

  if [[ -z "$api_url" ]]; then
    mark_miss "PRODUCTION_TRADING_API_URL required for production simulation probe"
    return
  fi
  if [[ -z "$token" ]]; then
    mark_miss "TRADING_API_TOKEN or PRODUCTION_TRADING_API_TOKEN required for production simulation probe"
    return
  fi
  for name in PRODUCTION_PROBE_TOKEN_IN PRODUCTION_PROBE_TOKEN_OUT PRODUCTION_PROBE_AMOUNT_IN PRODUCTION_PROBE_MIN_AMOUNT_OUT; do
    if [[ -z "${!name:-}" ]]; then
      mark_miss "$name required for production simulation probe"
      return
    fi
  done

  body="$(printf '{"strategy_id":"production-preflight","action":"swap","token_in":"%s","token_out":"%s","amount_in":"%s","min_amount_out":"%s","target_protocol":"%s"}' "$token_in" "$token_out" "$amount_in" "$min_out" "$protocol")"
  response="$(curl -sS --max-time "${PRODUCTION_PROBE_TIMEOUT_SECS:-30}" -o "$probe_out" -w '%{http_code}' \
    -X POST "${api_url%/}/validate" \
    -H "authorization: Bearer $token" \
    -H "content-type: application/json" \
    --data "$body" 2>"$probe_err" || true)"
  status="$response"
  if [[ "$status" =~ ^2[0-9][0-9]$ ]] && grep -q '"approved"' "$probe_out" 2>/dev/null; then
    mark_ok "production simulation probe completed"
  else
    mark_miss "production simulation probe failed with HTTP ${status:-<none>}"
  fi
  rm -f "$probe_out" "$probe_err"
}

check_production_trading() {
  local vault policy validator paused wind_down operator_role required_sigs signer_count quorum
  echo "Production trading"
  check_address_var PRODUCTION_VAULT_ADDRESS
  vault="${PRODUCTION_VAULT_ADDRESS:-}"
  if ! is_hex_address "$vault" || is_zero_address "$vault" || is_placeholder_address "$vault"; then
    return
  fi

  check_latest_block_freshness
  check_signer
  check_validator_endpoints
  check_contract_code "trading vault" "$vault"

  policy="$(cast_call "$vault" "policyEngine()(address)" || true)"
  validator="$(cast_call "$vault" "tradeValidator()(address)" || true)"
  check_contract_code "policy engine" "$policy"
  check_contract_code "trade validator" "$validator"

  paused="$(cast_call "$vault" "paused()(bool)" || true)"
  if [[ "$paused" == "true" ]]; then
    mark_miss "vault is paused"
  elif [[ "$paused" == "false" ]]; then
    mark_ok "vault is not paused"
  else
    mark_miss "vault pause state unavailable"
  fi

  wind_down="$(cast_call "$vault" "windDownActive()(bool)" || true)"
  if [[ "$wind_down" == "true" ]]; then
    mark_miss "vault wind-down is active"
  elif [[ "$wind_down" == "false" ]]; then
    mark_ok "vault wind-down is inactive"
  else
    mark_miss "vault wind-down state unavailable"
  fi

  if [[ -n "${OPERATOR_ADDRESS:-}" ]]; then
    operator_role="$(cast_call "$vault" "OPERATOR_ROLE()(bytes32)" || true)"
    if [[ -n "$operator_role" ]]; then
      if [[ "$(cast_call "$vault" "hasRole(bytes32,address)(bool)" "$operator_role" "$OPERATOR_ADDRESS" || true)" == "true" ]]; then
        mark_ok "operator has OPERATOR_ROLE"
      else
        mark_miss "operator lacks OPERATOR_ROLE on vault"
      fi
    else
      mark_miss "OPERATOR_ROLE unavailable"
    fi
  else
    mark_miss "OPERATOR_ADDRESS required to check vault execution rights"
  fi

  required_sigs="$(cast_call "$validator" "getRequiredSignatures(address)(uint256)" "$vault" || true)"
  signer_count="$(cast_call "$validator" "getSignerCount(address)(uint256)" "$vault" || true)"
  quorum="${VALIDATOR_QUORUM:-${REQUIRED_VALIDATOR_QUORUM:-1}}"
  if [[ -z "$required_sigs" || ! "$required_sigs" =~ ^[0-9]+$ || "$required_sigs" == "0" ]]; then
    mark_miss "trade validator required signatures not configured"
  elif [[ -z "$signer_count" || ! "$signer_count" =~ ^[0-9]+$ || "$signer_count" == "0" ]]; then
    mark_miss "trade validator signers not configured"
  elif (( required_sigs > signer_count )); then
    mark_miss "trade validator threshold exceeds signer count: $required_sigs > $signer_count"
  elif (( required_sigs > quorum )); then
    mark_miss "validator quorum below on-chain required signatures: quorum $quorum need $required_sigs"
  else
    mark_ok "trade validator threshold $required_sigs/$signer_count"
  fi

  check_csv_contract_allowlist "token" "${PRODUCTION_TOKENS:-}" "$vault" "$policy" "tokenWhitelisted(address,address)(bool)"
  check_csv_contract_allowlist "target" "${PRODUCTION_TARGETS:-}" "$vault" "$policy" "targetWhitelisted(address,address)(bool)"
  run_production_probe
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
elif [[ -n "${TANGLE_API_KEY:-}" ]]; then
  printf '  [ok]   AI_PROVIDER_KEY via TANGLE_API_KEY\n'
else
  printf '  [miss] AI_PROVIDER_KEY (ZAI_API_KEY, ANTHROPIC_API_KEY, or TANGLE_API_KEY)\n'
  missing=1
fi

echo "Runtime"
check_var OPERATOR_API_PORT false
check_var TRADING_API_PORT false
check_var SIDECAR_IMAGE false
check_var SESSION_AUTH_SECRET false
check_var TANGLE_ROUTER_BASE_URL false

echo "Strategy/Execution"
if is_production; then
  check_var VALIDATOR_ENDPOINTS true
else
  check_var VALIDATOR_ENDPOINTS false
fi
check_var HYPERLIQUID_TESTNET false
check_var EXECUTOR_PRIVATE_KEY false
check_var POLYMARKET_API_KEY false
check_var POLYMARKET_API_SECRET false
check_var POLYMARKET_API_PASSPHRASE false

if [[ "$MODE" == "live" || "$MODE" == "production" ]]; then
  if [[ -z "${BLUEPRINT_ID:-}" ]]; then
    echo "  [warn] BLUEPRINT_ID missing; deploy/bootstrap flow may create it"
  fi
  if [[ -z "${SERVICE_ID:-}" ]]; then
    echo "  [warn] SERVICE_ID missing; deploy/bootstrap flow may create it"
  fi
  if [[ -z "${VALIDATOR_ENDPOINTS:-}" && "$MODE" == "live" ]]; then
    mark_warn "VALIDATOR_ENDPOINTS missing; live mode depends on on-chain discovery or explicit validator endpoints"
  fi
  if [[ -z "${EXECUTOR_PRIVATE_KEY:-}" && -z "${PRIVATE_KEY:-}" ]]; then
    mark_miss "no signing key available for live execution"
  fi
fi

if is_production; then
  check_production_trading
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
