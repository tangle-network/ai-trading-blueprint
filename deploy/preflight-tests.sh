#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cat > "$TMP_DIR/cast" <<'CAST'
#!/usr/bin/env bash
set -euo pipefail

cmd="${1:-}"
shift || true

case "$cmd" in
  chain-id)
    echo "${CAST_CHAIN_ID:-84532}"
    ;;
  code)
    address="${1:-}"
    if [[ "${CAST_MISSING_CODE_FOR:-}" == "$address" ]]; then
      echo "0x"
    else
      echo "0x6000"
    fi
    ;;
  block)
    echo "timestamp $(date +%s)"
    ;;
  wallet)
    echo "${CAST_SIGNER_ADDRESS:-0x1111111111111111111111111111111111111111}"
    ;;
  balance)
    echo "${CAST_BALANCE:-1000000000000000000}"
    ;;
  call)
    address="${1:-}"
    signature="${2:-}"
    case "$signature" in
      "policyEngine()(address)")
        echo "${CAST_POLICY_ENGINE:-0x2222222222222222222222222222222222222222}"
        ;;
      "tradeValidator()(address)")
        echo "${CAST_TRADE_VALIDATOR:-0x3333333333333333333333333333333333333333}"
        ;;
      "paused()(bool)"|"windDownActive()(bool)")
        echo "false"
        ;;
      "OPERATOR_ROLE()(bytes32)")
        echo "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ;;
      "hasRole(bytes32,address)(bool)")
        echo "${CAST_OPERATOR_HAS_ROLE:-true}"
        ;;
      "getRequiredSignatures(address)(uint256)")
        echo "${CAST_REQUIRED_SIGNATURES:-1}"
        ;;
      "getSignerCount(address)(uint256)")
        echo "${CAST_SIGNER_COUNT:-2}"
        ;;
      "tokenWhitelisted(address,address)(bool)")
        echo "${CAST_TOKEN_WHITELISTED:-true}"
        ;;
      "targetWhitelisted(address,address)(bool)")
        echo "${CAST_TARGET_WHITELISTED:-true}"
        ;;
      *)
        echo "unsupported call $address $signature" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "unsupported cast command: $cmd" >&2
    exit 1
    ;;
esac
CAST
chmod +x "$TMP_DIR/cast"

run_preflight() {
  local output_file="$1"
  shift
  (
    export PATH="$TMP_DIR:$PATH"
    export HTTP_RPC_URL="http://127.0.0.1:8545"
    export WS_RPC_URL="ws://127.0.0.1:8545"
    export CHAIN_ID="84532"
    export TANGLE_CONTRACT="0x4444444444444444444444444444444444444444"
    export STAKING_CONTRACT="0x5555555555555555555555555555555555555555"
    export STATUS_REGISTRY_CONTRACT="0x6666666666666666666666666666666666666666"
    export PRIVATE_KEY="0xabc"
    export OPERATOR_ADDRESS="0x1111111111111111111111111111111111111111"
    export ZAI_API_KEY="test"
    export PRODUCTION_VAULT_ADDRESS="0x7777777777777777777777777777777777777777"
    export PRODUCTION_TOKENS="0x8888888888888888888888888888888888888888"
    export PRODUCTION_TARGETS="0x9999999999999999999999999999999999999999"
    export PRODUCTION_TRADING_API_URL="http://127.0.0.1:1"
    export TRADING_API_TOKEN="test-token"
    export PRODUCTION_PROBE_TOKEN_IN="0x8888888888888888888888888888888888888888"
    export PRODUCTION_PROBE_TOKEN_OUT="0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    export PRODUCTION_PROBE_AMOUNT_IN="1"
    export PRODUCTION_PROBE_MIN_AMOUNT_OUT="1"
    export VALIDATOR_HEALTH_TIMEOUT_SECS="1"
    "$@" "$SCRIPT_DIR/preflight.sh" production >"$output_file" 2>&1
  )
}

assert_fails_with() {
  local name="$1"
  local expected="$2"
  shift 2
  local output="$TMP_DIR/$name.out"
  if run_preflight "$output" "$@"; then
    echo "FAIL: $name unexpectedly passed" >&2
    cat "$output" >&2
    exit 1
  fi
  if ! grep -q "$expected" "$output"; then
    echo "FAIL: $name did not contain expected text: $expected" >&2
    cat "$output" >&2
    exit 1
  fi
  echo "ok - $name"
}

assert_fails_with "missing-validators" "VALIDATOR_ENDPOINTS required" env -u VALIDATOR_ENDPOINTS
assert_fails_with "duplicate-validators" "duplicate validator endpoint" env VALIDATOR_ENDPOINTS="http://v1,http://v1"
assert_fails_with "missing-vault-bytecode" "trading vault bytecode missing" env VALIDATOR_ENDPOINTS="http://v1" CAST_MISSING_CODE_FOR="0x7777777777777777777777777777777777777777"
assert_fails_with "missing-token-whitelist" "token not whitelisted" env VALIDATOR_ENDPOINTS="http://v1" CAST_TOKEN_WHITELISTED=false
assert_fails_with "low-signer-balance" "signer gas balance too low" env VALIDATOR_ENDPOINTS="http://v1" CAST_BALANCE=1
assert_fails_with "broken-simulation-probe" "production simulation probe failed" env VALIDATOR_ENDPOINTS="http://v1"

skip_output="$TMP_DIR/skip-preflight.out"
if REQUIRE_PRODUCTION_PREFLIGHT=1 SKIP_PREFLIGHT=1 "$SCRIPT_DIR/go-live-base-sepolia.sh" 127.0.0.1 0xabc >"$skip_output" 2>&1; then
  echo "FAIL: skip-preflight unexpectedly passed" >&2
  cat "$skip_output" >&2
  exit 1
fi
if ! grep -q "SKIP_PREFLIGHT=1 is blocked" "$skip_output"; then
  echo "FAIL: skip-preflight did not block production skip" >&2
  cat "$skip_output" >&2
  exit 1
fi
echo "ok - skip-preflight"

echo "preflight tests passed"
