#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

RPC_URL="${RPC_URL:-https://rpc.hyperliquid-testnet.xyz/evm}"
CHAIN_ID="${CHAIN_ID:-998}"
PRIVATE_KEY="${PRIVATE_KEY:?PRIVATE_KEY is required}"
ASSET_TOKEN="${ASSET_TOKEN:-0x2B3370eE501B4a559b57D449569354196457D8Ab}"
DEPLOY_TX_GAS_LIMIT="${HYPEREVM_DEPLOY_TX_GAS_LIMIT:-3000000}"
WRITE_DEPLOYMENT_JSON="${WRITE_DEPLOYMENT_JSON:-true}"
DEPLOYMENT_JSON_DIR="${DEPLOYMENT_JSON_DIR:-$ROOT_DIR/deployments}"
AUTHORIZED_CALLERS="${AUTHORIZED_CALLERS:-}"

cd "$ROOT_DIR"

require_tool() {
  local tool="$1"
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: required tool '$tool' was not found" >&2
    exit 1
  fi
}

require_tool cast
require_tool forge
require_tool jq

lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

actual_chain_id="$(cast chain-id --rpc-url "$RPC_URL")"
if [[ "$actual_chain_id" != "$CHAIN_ID" ]]; then
  echo "ERROR: RPC $RPC_URL is chain $actual_chain_id, expected $CHAIN_ID" >&2
  exit 1
fi

deployer="$(cast wallet address --private-key "$PRIVATE_KEY")"
echo "Deploying Hyperliquid vault stack"
echo "  chain:       $actual_chain_id"
echo "  rpc:         $RPC_URL"
echo "  deployer:    $deployer"
echo "  asset token: $ASSET_TOKEN"
echo "  tx gas cap:  $DEPLOY_TX_GAS_LIMIT"
if [[ -n "$AUTHORIZED_CALLERS" ]]; then
  echo "  authorized:  $AUTHORIZED_CALLERS"
fi

forge build -q

append_constructor_args() {
  local artifact="$1"
  shift

  local bytecode
  bytecode="$(jq -r '.bytecode.object' "$artifact")"
  if [[ "$#" -eq 0 ]]; then
    printf '%s' "$bytecode"
    return
  fi

  local args
  args="$(cast abi-encode "$@")"
  printf '%s%s' "$bytecode" "${args#0x}"
}

code_size() {
  local address="$1"
  local code
  code="$(cast code --rpc-url "$RPC_URL" "$address")"
  if [[ "$code" == "0x" ]]; then
    printf '0'
  else
    printf '%s' "$(( (${#code} - 2) / 2 ))"
  fi
}

send_create() {
  local label="$1"
  local creation_code="$2"
  local tx_json tx_hash receipt status gas_used contract_address bytes

  tx_json="$(
    cast send \
      --rpc-url "$RPC_URL" \
      --private-key "$PRIVATE_KEY" \
      --gas-limit "$DEPLOY_TX_GAS_LIMIT" \
      --create "$creation_code" \
      --json
  )"
  tx_hash="$(jq -r '.transactionHash' <<<"$tx_json")"
  receipt="$(cast receipt --rpc-url "$RPC_URL" "$tx_hash" --json)"
  status="$(jq -r '.status' <<<"$receipt")"
  gas_used="$(jq -r '.gasUsed' <<<"$receipt")"
  contract_address="$(jq -r '.contractAddress' <<<"$receipt")"
  bytes="$(code_size "$contract_address")"

  printf '%-32s address=%s status=%s gasUsed=%d codeBytes=%s tx=%s\n' \
    "$label" "$contract_address" "$status" "$((gas_used))" "$bytes" "$tx_hash" >&2

  if [[ "$status" != "0x1" ]]; then
    echo "ERROR: $label deployment failed" >&2
    exit 1
  fi
  if (( bytes <= 0 )); then
    echo "ERROR: $label deployed with empty code at $contract_address" >&2
    exit 1
  fi

  printf '%s' "$contract_address"
}

send_call() {
  local label="$1"
  local to="$2"
  local sig="$3"
  shift 3

  local tx_json tx_hash receipt status gas_used
  tx_json="$(
    cast send \
      --rpc-url "$RPC_URL" \
      --private-key "$PRIVATE_KEY" \
      --gas-limit "$DEPLOY_TX_GAS_LIMIT" \
      "$to" "$sig" "$@" \
      --json
  )"
  tx_hash="$(jq -r '.transactionHash' <<<"$tx_json")"
  receipt="$(cast receipt --rpc-url "$RPC_URL" "$tx_hash" --json)"
  status="$(jq -r '.status' <<<"$receipt")"
  gas_used="$(jq -r '.gasUsed' <<<"$receipt")"

  printf '%-32s status=%s gasUsed=%d tx=%s\n' "$label" "$status" "$((gas_used))" "$tx_hash"
  if [[ "$status" != "0x1" ]]; then
    echo "ERROR: $label failed" >&2
    exit 1
  fi
}

vault_implementation="$(
  send_create \
    "HyperliquidVault" \
    "$(append_constructor_args contracts/out/HyperliquidVault.sol/HyperliquidVault.json)"
)"
trade_validator="$(
  send_create \
    "HyperliquidTradeValidator" \
    "$(append_constructor_args contracts/out/HyperliquidTradeValidator.sol/HyperliquidTradeValidator.json)"
)"
vault_factory="$(
  send_create \
    "HyperliquidVaultFactory" \
    "$(append_constructor_args contracts/out/HyperliquidVaultFactory.sol/HyperliquidVaultFactory.json 'constructor(address)' "$trade_validator")"
)"
vault_deployer="$(
  send_create \
    "HyperliquidVaultDeployer" \
    "$(append_constructor_args contracts/out/HyperliquidVaultDeployer.sol/HyperliquidVaultDeployer.json 'constructor(address,address)' "$vault_factory" "$vault_implementation")"
)"
vault_share_deployer="$(
  send_create \
    "VaultShareDeployer" \
    "$(append_constructor_args contracts/out/VaultShareDeployer.sol/VaultShareDeployer.json 'constructor(address)' "$vault_factory")"
)"

send_call "validator.transferOwnership" "$trade_validator" "transferOwnership(address)" "$vault_factory"
send_call "factory.acceptDependency" "$vault_factory" "acceptDependencyOwnership()"
send_call "factory.setVaultDeployers" "$vault_factory" "setVaultDeployers(address,address)" "$vault_deployer" "$vault_share_deployer"

authorized_callers_json='[]'
if [[ -n "$AUTHORIZED_CALLERS" ]]; then
  IFS=',' read -r -a authorized_callers <<< "$AUTHORIZED_CALLERS"
  for caller in "${authorized_callers[@]}"; do
    caller="$(printf '%s' "$caller" | xargs)"
    [[ -n "$caller" ]] || continue
    send_call "factory.authorizeCaller" "$vault_factory" "setAuthorizedCaller(address,bool)" "$caller" true
    is_authorized="$(cast call --rpc-url "$RPC_URL" "$vault_factory" "authorizedCallers(address)(bool)" "$caller")"
    if [[ "$is_authorized" != "true" ]]; then
      echo "ERROR: factory authorizedCallers($caller) was not set" >&2
      exit 1
    fi
    authorized_callers_json="$(jq -c --arg caller "$caller" '. + [$caller]' <<<"$authorized_callers_json")"
  done
fi

wired_vault_deployer="$(cast call --rpc-url "$RPC_URL" "$vault_factory" "deployer()(address)")"
wired_share_deployer="$(cast call --rpc-url "$RPC_URL" "$vault_factory" "shareDeployer()(address)")"
validator_owner="$(cast call --rpc-url "$RPC_URL" "$trade_validator" "owner()(address)")"

if [[ "$(lower "$wired_vault_deployer")" != "$(lower "$vault_deployer")" ]]; then
  echo "ERROR: factory.deployer mismatch: got $wired_vault_deployer expected $vault_deployer" >&2
  exit 1
fi
if [[ "$(lower "$wired_share_deployer")" != "$(lower "$vault_share_deployer")" ]]; then
  echo "ERROR: factory.shareDeployer mismatch: got $wired_share_deployer expected $vault_share_deployer" >&2
  exit 1
fi
if [[ "$(lower "$validator_owner")" != "$(lower "$vault_factory")" ]]; then
  echo "ERROR: validator.owner mismatch: got $validator_owner expected $vault_factory" >&2
  exit 1
fi

echo "Verified factory/deployer/validator wiring."

if [[ "$WRITE_DEPLOYMENT_JSON" == "true" ]]; then
  chain_dir="$DEPLOYMENT_JSON_DIR/$actual_chain_id"
  json_path="$chain_dir/hyperliquid-vault.json"
  mkdir -p "$chain_dir"
  tmp_path="$(mktemp "$chain_dir/hyperliquid-vault.json.tmp.XXXXXX")"

  jq -n \
    --argjson chainId "$actual_chain_id" \
    --arg deployer "$deployer" \
    --arg assetToken "$ASSET_TOKEN" \
    --arg vaultFactory "$vault_factory" \
    --arg vaultImplementation "$vault_implementation" \
    --arg vaultDeployer "$vault_deployer" \
    --arg vaultShareDeployer "$vault_share_deployer" \
    --arg tradeValidator "$trade_validator" \
    --argjson authorizedCallers "$authorized_callers_json" \
    '{
      chainId: $chainId,
      deployer: $deployer,
      assetToken: $assetToken,
      vaultFactory: $vaultFactory,
      vaultImplementation: $vaultImplementation,
      vaultDeployer: $vaultDeployer,
      vaultShareDeployer: $vaultShareDeployer,
      tradeValidator: $tradeValidator,
      authorizedCallers: $authorizedCallers
    }' > "$tmp_path"

  mv "$tmp_path" "$json_path"
  echo "Wrote $json_path"
else
  echo "WRITE_DEPLOYMENT_JSON=false; deployment manifest not written."
fi
