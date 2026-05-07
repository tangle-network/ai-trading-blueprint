#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

FORK_URL="${FORK_URL:?FORK_URL is required}"
FORK_BLOCK_NUMBER="${FORK_BLOCK_NUMBER:-}"
ANVIL_PORT="${ANVIL_PORT:-8545}"
RPC_URL="${RPC_URL:-http://127.0.0.1:$ANVIL_PORT}"
CHAIN_ID="${CHAIN_ID:-31339}"
ANVIL_CODE_SIZE_LIMIT="${ANVIL_CODE_SIZE_LIMIT:-30000}"
ASSET_TOKEN_ADDRESS="${ASSET_TOKEN_ADDRESS:?ASSET_TOKEN_ADDRESS is required}"
EXECUTION_STATE_FILE="${EXECUTION_STATE_FILE:-$ROOT_DIR/.execution-fork.env}"
DEPLOYER_KEY="${DEPLOYER_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
EXECUTION_ADMIN="${EXECUTION_ADMIN:-}"
OPERATOR_ONE="${OPERATOR_ONE:-0x70997970C51812dc3A010C7d01b50e0d17dc79C8}"
OPERATOR_TWO="${OPERATOR_TWO:-0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC}"
EXECUTION_SERVICE_ID="${EXECUTION_SERVICE_ID:-1}"
EXECUTION_REQUIRED_SIGS="${EXECUTION_REQUIRED_SIGS:-1}"
EXECUTION_VAULT_NAME="${EXECUTION_VAULT_NAME:-Execution Vault}"
EXECUTION_VAULT_SYMBOL="${EXECUTION_VAULT_SYMBOL:-xVAULT}"
POLICY_LEVERAGE_CAP="${POLICY_LEVERAGE_CAP:-50000}"
POLICY_MAX_TRADES_PER_HOUR="${POLICY_MAX_TRADES_PER_HOUR:-100}"
POLICY_MAX_SLIPPAGE_BPS="${POLICY_MAX_SLIPPAGE_BPS:-500}"
PERFORMANCE_FEE_BPS="${PERFORMANCE_FEE_BPS:-2000}"
MANAGEMENT_FEE_BPS="${MANAGEMENT_FEE_BPS:-200}"
VALIDATOR_FEE_SHARE_BPS="${VALIDATOR_FEE_SHARE_BPS:-3000}"
WHITELISTED_TOKENS="${WHITELISTED_TOKENS:-}"
WHITELISTED_TARGETS="${WHITELISTED_TARGETS:-}"
CHAINLINK_USD_FEEDS="${CHAINLINK_USD_FEEDS:-}"
UNISWAP_V3_ROUTER="${UNISWAP_V3_ROUTER:-0xE592427A0AEce92De3Edee1F18E0157C05861564}"
AAVE_V3_POOL="${AAVE_V3_POOL:-0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2}"
MAINNET_WETH="${MAINNET_WETH:-0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2}"
MAINNET_USDC="${MAINNET_USDC:-0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48}"
MAINNET_USDT="${MAINNET_USDT:-0xdAC17F958D2ee523a2206206994597C13D831ec7}"
MAINNET_DAI="${MAINNET_DAI:-0x6B175474E89094C44Da98b954EedeAC495271d0F}"
MAINNET_WBTC="${MAINNET_WBTC:-0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599}"
CHAINLINK_ETH_USD_FEED="${CHAINLINK_ETH_USD_FEED:-0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419}"
CHAINLINK_USDC_USD_FEED="${CHAINLINK_USDC_USD_FEED:-0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6}"
CHAINLINK_USDT_USD_FEED="${CHAINLINK_USDT_USD_FEED:-0x3E7d1eAB13ad0104d2750B8863b489D65364e32D}"
CHAINLINK_DAI_USD_FEED="${CHAINLINK_DAI_USD_FEED:-0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9}"
CHAINLINK_WBTC_USD_FEED="${CHAINLINK_WBTC_USD_FEED:-0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c}"
CHAINLINK_MAX_STALENESS="${CHAINLINK_MAX_STALENESS:-0}"
AAVE_AWETH="${AAVE_AWETH:-0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8}"
AAVE_AUSDC="${AAVE_AUSDC:-0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c}"
AAVE_DEBT_WETH="${AAVE_DEBT_WETH:-0xeA51d7853EEFb32b6ee06b1C12E6dcCA88Be0fFE}"
AAVE_DEBT_USDC="${AAVE_DEBT_USDC:-0x72E95b8931767C79bA4EeE721354d6E99a61D004}"
TX_GAS_LIMIT="${TX_GAS_LIMIT:-30000000}"
TX_GAS_PRICE_WEI="${TX_GAS_PRICE_WEI:-2000000000}"
TX_RECEIPT_POLL_ATTEMPTS="${TX_RECEIPT_POLL_ATTEMPTS:-30}"

DEPLOYER_ADDRESS="$(cast wallet address --private-key "$DEPLOYER_KEY")"
if [[ -z "$EXECUTION_ADMIN" ]]; then
  EXECUTION_ADMIN="$DEPLOYER_ADDRESS"
fi

# Default the execution target whitelist to the canonical Uniswap V3 router for
# the local Ethereum-fork QA flow. Callers can still override this explicitly
# via WHITELISTED_TARGETS when testing other protocols.
if [[ -z "$WHITELISTED_TARGETS" ]]; then
  WHITELISTED_TARGETS="$UNISWAP_V3_ROUTER,$AAVE_V3_POOL"
fi

csv_to_array_literal() {
  local csv="$1"
  local items=()
  local item=""
  IFS=',' read -r -a items <<< "$csv"
  for i in "${!items[@]}"; do
    item="$(printf '%s' "${items[$i]}" | xargs)"
    items[$i]="$item"
  done
  local result="["
  for item in "${items[@]}"; do
    [[ -n "$item" ]] || continue
    if [[ "$result" != "[" ]]; then
      result+=","
    fi
    result+="$item"
  done
  result+="]"
  printf '%s\n' "$result"
}

wait_for_rpc() {
  for _ in $(seq 1 60); do
    if cast chain-id --rpc-url "$RPC_URL" > /dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "ERROR: execution fork RPC not ready at $RPC_URL" >&2
  exit 1
}

deploy_contract() {
  local artifact_path="$1"
  local constructor_sig="$2"
  shift 2
  local bytecode=""
  local encoded_args=""
  local creation_data=""
  local output=""
  local tx_hash=""
  local receipt=""
  local contract_address=""
  local gas_hex=""
  local gas_price_hex=""

  bytecode="$(jq -r '.bytecode.object' "$artifact_path")"
  if [[ -z "$bytecode" || "$bytecode" == "null" ]]; then
    echo "ERROR: failed to load bytecode from $artifact_path" >&2
    exit 1
  fi

  if [[ "$constructor_sig" == "constructor()" ]]; then
    creation_data="$bytecode"
  else
    encoded_args="$(cast abi-encode "$constructor_sig" "$@")"
    creation_data="${bytecode}${encoded_args#0x}"
  fi

  gas_hex="$(printf '0x%x' "$TX_GAS_LIMIT")"
  gas_price_hex="$(printf '0x%x' "$TX_GAS_PRICE_WEI")"
  if ! output="$(
    cast rpc eth_sendTransaction \
      "{\"from\":\"$DEPLOYER_ADDRESS\",\"data\":\"$creation_data\",\"gas\":\"$gas_hex\",\"gasPrice\":\"$gas_price_hex\"}" \
      --rpc-url "$RPC_URL" 2>&1
  )"; then
    echo "ERROR: failed to deploy artifact $artifact_path" >&2
    echo "$output" >&2
    exit 1
  fi

  tx_hash="$(printf '%s\n' "$output" | tr -d '"' | grep -Eo '0x[0-9a-fA-F]{64}' | tail -n 1)"
  if [[ -z "$tx_hash" ]]; then
    echo "ERROR: failed to parse deployment tx hash for $artifact_path" >&2
    echo "$output" >&2
    exit 1
  fi

  receipt="$(wait_for_receipt "$tx_hash" "deploy $artifact_path")"
  contract_address="$(
    RECEIPT_JSON="$receipt" node -e '
      const receipt = JSON.parse(process.env.RECEIPT_JSON);
      process.stdout.write(String(receipt.contractAddress || ""));
    '
  )"
  if [[ -z "$contract_address" || "$contract_address" == "null" ]]; then
    echo "ERROR: deployment receipt missing contractAddress for $artifact_path" >&2
    echo "$receipt" >&2
    exit 1
  fi
  printf '%s\n' "$contract_address"
}

wait_for_receipt() {
  local tx_hash="$1"
  local label="$2"
  local receipt=""
  local status=""
  for _ in $(seq 1 "$TX_RECEIPT_POLL_ATTEMPTS"); do
    receipt="$(cast rpc eth_getTransactionReceipt "$tx_hash" --rpc-url "$RPC_URL" 2>/dev/null || true)"
    if [[ -n "$receipt" && "$receipt" != "null" ]]; then
      status="$(
        RECEIPT_JSON="$receipt" node -e '
          const receipt = JSON.parse(process.env.RECEIPT_JSON);
          process.stdout.write(String(receipt.status));
        '
      )"
      if [[ "$status" == "0x1" || "$status" == "1" ]]; then
        printf '%s\n' "$receipt"
        return 0
      fi
      echo "ERROR: transaction reverted for $label" >&2
      echo "$receipt" >&2
      exit 1
    fi

    cast rpc anvil_mine 1 --rpc-url "$RPC_URL" > /dev/null 2>&1 || true
    sleep 1
  done

  echo "ERROR: timed out waiting for receipt for $label ($tx_hash)" >&2
  exit 1
}

send_tx() {
  local to="$1"
  local sig="$2"
  shift 2
  local output=""
  local tx_hash=""
  if ! output="$(
    cast send --async "$to" "$sig" "$@" \
      --from "$DEPLOYER_ADDRESS" \
      --unlocked \
      --legacy \
      --gas-price "$TX_GAS_PRICE_WEI" \
      --gas-limit "$TX_GAS_LIMIT" \
      --rpc-url "$RPC_URL" 2>&1
  )"; then
    echo "$output" >&2
    exit 1
  fi

  tx_hash="$(printf '%s\n' "$output" | grep -Eo '0x[0-9a-fA-F]{64}' | tail -n 1)"
  if [[ -z "$tx_hash" ]]; then
    echo "ERROR: failed to parse transaction hash for $sig" >&2
    echo "$output" >&2
    exit 1
  fi

  wait_for_receipt "$tx_hash" "$sig" > /dev/null
}

if lsof -iTCP:"$ANVIL_PORT" -sTCP:LISTEN -n -P > /dev/null 2>&1; then
  echo "ERROR: port $ANVIL_PORT is already in use" >&2
  exit 1
fi

echo "=== Starting execution fork ==="
if [[ -n "$FORK_BLOCK_NUMBER" ]]; then
  anvil --fork-url "$FORK_URL" --fork-block-number "$FORK_BLOCK_NUMBER" --port "$ANVIL_PORT" --chain-id "$CHAIN_ID" --code-size-limit "$ANVIL_CODE_SIZE_LIMIT" --silent &
else
  anvil --fork-url "$FORK_URL" --port "$ANVIL_PORT" --chain-id "$CHAIN_ID" --code-size-limit "$ANVIL_CODE_SIZE_LIMIT" --silent &
fi
ANVIL_PID=$!

cleanup() {
  if kill -0 "$ANVIL_PID" 2>/dev/null; then
    kill "$ANVIL_PID" 2>/dev/null || true
    wait "$ANVIL_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

wait_for_rpc

echo "=== Deploying execution stack ==="
forge build --root "$ROOT_DIR" > /dev/null 2>&1

POLICY_ENGINE="$(deploy_contract "$ROOT_DIR/contracts/out/PolicyEngine.sol/PolicyEngine.json" "constructor()")"
TRADE_VALIDATOR="$(deploy_contract "$ROOT_DIR/contracts/out/TradeValidator.sol/TradeValidator.json" "constructor()")"
FEE_DISTRIBUTOR="$(deploy_contract "$ROOT_DIR/contracts/out/FeeDistributor.sol/FeeDistributor.json" "constructor(address)" "$EXECUTION_ADMIN")"
VAULT_FACTORY="$(deploy_contract "$ROOT_DIR/contracts/out/VaultFactory.sol/VaultFactory.json" "constructor(address,address,address)" "$POLICY_ENGINE" "$TRADE_VALIDATOR" "$FEE_DISTRIBUTOR")"
VAULT_DEPLOYER="$(deploy_contract "$ROOT_DIR/contracts/out/VaultDeployer.sol/VaultDeployer.json" "constructor(address,address,address,address)" "$VAULT_FACTORY" "$POLICY_ENGINE" "$TRADE_VALIDATOR" "$FEE_DISTRIBUTOR")"
VAULT_SHARE_DEPLOYER="$(deploy_contract "$ROOT_DIR/contracts/out/VaultShareDeployer.sol/VaultShareDeployer.json" "constructor(address)" "$VAULT_FACTORY")"
CHAINLINK_USD_VALUATOR="$(deploy_contract "$ROOT_DIR/contracts/out/ChainlinkUsdValuator.sol/ChainlinkUsdValuator.json" "constructor(address)" "$DEPLOYER_ADDRESS")"
WRAPPED_ASSET_VALUATOR="$(deploy_contract "$ROOT_DIR/contracts/out/WrappedAssetValuator.sol/WrappedAssetValuator.json" "constructor(address,address)" "$DEPLOYER_ADDRESS" "$CHAINLINK_USD_VALUATOR")"

send_tx "$CHAINLINK_USD_VALUATOR" "setFeed(address,address,uint48)" "$MAINNET_WETH" "$CHAINLINK_ETH_USD_FEED" "$CHAINLINK_MAX_STALENESS"
send_tx "$CHAINLINK_USD_VALUATOR" "setFeed(address,address,uint48)" "$MAINNET_USDC" "$CHAINLINK_USDC_USD_FEED" "$CHAINLINK_MAX_STALENESS"
send_tx "$CHAINLINK_USD_VALUATOR" "setFeed(address,address,uint48)" "$MAINNET_USDT" "$CHAINLINK_USDT_USD_FEED" "$CHAINLINK_MAX_STALENESS"
send_tx "$CHAINLINK_USD_VALUATOR" "setFeed(address,address,uint48)" "$MAINNET_DAI" "$CHAINLINK_DAI_USD_FEED" "$CHAINLINK_MAX_STALENESS"
send_tx "$CHAINLINK_USD_VALUATOR" "setFeed(address,address,uint48)" "$MAINNET_WBTC" "$CHAINLINK_WBTC_USD_FEED" "$CHAINLINK_MAX_STALENESS"

if [[ -n "$CHAINLINK_USD_FEEDS" ]]; then
  IFS=',' read -r -a feed_items <<< "$CHAINLINK_USD_FEEDS"
  for feed_item in "${feed_items[@]}"; do
    feed_item="$(printf '%s' "$feed_item" | xargs)"
    [[ -n "$feed_item" ]] || continue
    if [[ "$feed_item" != *"="* ]]; then
      echo "ERROR: CHAINLINK_USD_FEEDS entries must use token=feed format" >&2
      exit 1
    fi
    token="$(printf '%s' "${feed_item%%=*}" | xargs)"
    feed="$(printf '%s' "${feed_item#*=}" | xargs)"
    if [[ -z "$token" || -z "$feed" ]]; then
      echo "ERROR: CHAINLINK_USD_FEEDS entries must include both token and feed" >&2
      exit 1
    fi
    send_tx "$CHAINLINK_USD_VALUATOR" "setFeed(address,address,uint48)" "$token" "$feed" "$CHAINLINK_MAX_STALENESS"
  done
fi

send_tx "$WRAPPED_ASSET_VALUATOR" "setUnderlying(address,address)" "$AAVE_AWETH" "$MAINNET_WETH"
send_tx "$WRAPPED_ASSET_VALUATOR" "setUnderlying(address,address)" "$AAVE_AUSDC" "$MAINNET_USDC"
send_tx "$WRAPPED_ASSET_VALUATOR" "setUnderlying(address,address)" "$AAVE_DEBT_WETH" "$MAINNET_WETH"
send_tx "$WRAPPED_ASSET_VALUATOR" "setUnderlying(address,address)" "$AAVE_DEBT_USDC" "$MAINNET_USDC"

send_tx "$POLICY_ENGINE" "transferOwnership(address)" "$VAULT_FACTORY"
send_tx "$TRADE_VALIDATOR" "transferOwnership(address)" "$VAULT_FACTORY"
send_tx "$FEE_DISTRIBUTOR" "transferOwnership(address)" "$VAULT_FACTORY"
send_tx "$VAULT_FACTORY" "acceptDependencyOwnership()"
send_tx "$VAULT_FACTORY" "setVaultDeployers(address,address)" "$VAULT_DEPLOYER" "$VAULT_SHARE_DEPLOYER"
send_tx "$VAULT_FACTORY" "setAuthorizedCaller(address,bool)" "$DEPLOYER_ADDRESS" true
send_tx "$VAULT_FACTORY" "setAuthorizedCaller(address,bool)" "$OPERATOR_ONE" true
send_tx "$VAULT_FACTORY" "setAuthorizedCaller(address,bool)" "$OPERATOR_TWO" true
send_tx "$VAULT_FACTORY" "setDefaultWhitelistedToken(address,bool)" "$ASSET_TOKEN_ADDRESS" true
send_tx "$VAULT_FACTORY" "setDefaultWhitelistedToken(address,bool)" "$MAINNET_WETH" true
send_tx "$VAULT_FACTORY" "setDefaultWhitelistedToken(address,bool)" "$MAINNET_USDC" true
send_tx "$VAULT_FACTORY" "setDefaultWhitelistedToken(address,bool)" "$MAINNET_USDT" true
send_tx "$VAULT_FACTORY" "setDefaultWhitelistedToken(address,bool)" "$MAINNET_DAI" true
send_tx "$VAULT_FACTORY" "setDefaultWhitelistedToken(address,bool)" "$MAINNET_WBTC" true

if [[ -n "$CHAINLINK_USD_FEEDS" ]]; then
  IFS=',' read -r -a feed_items <<< "$CHAINLINK_USD_FEEDS"
  for feed_item in "${feed_items[@]}"; do
    feed_item="$(printf '%s' "$feed_item" | xargs)"
    [[ -n "$feed_item" ]] || continue
    token="$(printf '%s' "${feed_item%%=*}" | xargs)"
    [[ -n "$token" ]] || continue
    send_tx "$VAULT_FACTORY" "setDefaultWhitelistedToken(address,bool)" "$token" true
  done
fi

if [[ -n "$WHITELISTED_TOKENS" ]]; then
  IFS=',' read -r -a token_items <<< "$WHITELISTED_TOKENS"
  for token in "${token_items[@]}"; do
    token="$(printf '%s' "$token" | xargs)"
    [[ -n "$token" ]] || continue
    send_tx "$VAULT_FACTORY" "setDefaultWhitelistedToken(address,bool)" "$token" true
  done
fi

if [[ -n "$WHITELISTED_TARGETS" ]]; then
  IFS=',' read -r -a target_items <<< "$WHITELISTED_TARGETS"
  for target in "${target_items[@]}"; do
    target="$(printf '%s' "$target" | xargs)"
    [[ -n "$target" ]] || continue
    send_tx "$VAULT_FACTORY" "setDefaultWhitelistedTarget(address,bool)" "$target" true
  done
fi

cat > "$EXECUTION_STATE_FILE" <<EOF
EXECUTION_RPC_URL=$RPC_URL
EXECUTION_CHAIN_ID=$CHAIN_ID
EXECUTION_DEPLOYER_ADDRESS=$DEPLOYER_ADDRESS
EXECUTION_ADMIN=$EXECUTION_ADMIN
EXECUTION_OPERATOR_ONE=$OPERATOR_ONE
EXECUTION_OPERATOR_TWO=$OPERATOR_TWO
EXECUTION_SERVICE_ID=$EXECUTION_SERVICE_ID
EXECUTION_ASSET_TOKEN=$ASSET_TOKEN_ADDRESS
EXECUTION_DEFAULT_SUPPORTED_ASSETS=$MAINNET_WETH,$MAINNET_USDC,$MAINNET_USDT,$MAINNET_DAI,$MAINNET_WBTC
EXECUTION_CHAINLINK_USD_FEEDS=$CHAINLINK_USD_FEEDS
EXECUTION_POLICY_ENGINE=$POLICY_ENGINE
EXECUTION_TRADE_VALIDATOR=$TRADE_VALIDATOR
EXECUTION_FEE_DISTRIBUTOR=$FEE_DISTRIBUTOR
EXECUTION_VAULT_FACTORY_ADDRESS=$VAULT_FACTORY
EXECUTION_VAULT_DEPLOYER_ADDRESS=$VAULT_DEPLOYER
EXECUTION_VAULT_SHARE_DEPLOYER_ADDRESS=$VAULT_SHARE_DEPLOYER
POLICY_ENGINE_ADDRESS=$POLICY_ENGINE
VAULT_FACTORY_ADDRESS=$VAULT_FACTORY
EXECUTION_CHAINLINK_USD_VALUATOR=$CHAINLINK_USD_VALUATOR
EXECUTION_WRAPPED_ASSET_VALUATOR=$WRAPPED_ASSET_VALUATOR
CHAINLINK_USD_VALUATOR_ADDRESS=$CHAINLINK_USD_VALUATOR
WRAPPED_ASSET_VALUATOR_ADDRESS=$WRAPPED_ASSET_VALUATOR
EOF

echo "Execution fork ready."
echo "  RPC URL:         $RPC_URL"
echo "  Chain ID:        $CHAIN_ID"
echo "  Asset token:     $ASSET_TOKEN_ADDRESS"
echo "  Supported assets: WETH, USDC, USDT, DAI, WBTC"
echo "  VaultFactory:    $VAULT_FACTORY"
echo "  Chainlink val:   $CHAINLINK_USD_VALUATOR"
echo "  TradeValidator:  $TRADE_VALIDATOR"
echo "  State file:      $EXECUTION_STATE_FILE"

wait "$ANVIL_PID"
