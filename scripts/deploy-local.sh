#!/usr/bin/env bash
# Deploy the Trading Arena contracts to a local Anvil with Tangle protocol pre-loaded.
#
# Prerequisites:
#   anvil --load-state /path/to/blueprint/crates/chain-setup/anvil/snapshots/localtestnet-state.json
#
# Usage: ./scripts/deploy-local.sh
set -euo pipefail

RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
DEPLOYER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
DEPLOYER_ADDR="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
OPERATOR1_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
OPERATOR1_ADDR="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
OPERATOR2_KEY="0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"
OPERATOR2_ADDR="0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
USER_ACCOUNT="0x68FF20459d48917748CA13afCbDA3B265a449D48"

# Tangle protocol addresses (deterministic from state snapshot)
TANGLE="0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9"
RESTAKING="0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"

# Pricing engine ports (operators register these as their RPC addresses)
OPERATOR1_RPC="http://localhost:50051"
OPERATOR2_RPC="http://localhost:50052"
BLUEPRINT_ID=0

echo "=== Trading Arena — Local Deployment ==="
echo "RPC: $RPC_URL"
echo "Tangle: $TANGLE"
echo ""

# ── Deploy Multicall3 (required by viem) ──────────────────────
echo "[0/9] Deploying Multicall3..."
MULTICALL3_ADDR="0xcA11bde05977b3631167028862bE2a173976CA11"
if [[ "$(cast code $MULTICALL3_ADDR --rpc-url "$RPC_URL" 2>/dev/null)" == "0x" ]]; then
  MC3=$(forge create contracts/test/helpers/Multicall3.sol:Multicall3 \
    --broadcast --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" 2>&1 | grep "Deployed to:" | awk '{print $3}')
  MC3_CODE=$(cast code "$MC3" --rpc-url "$RPC_URL")
  cast rpc anvil_setCode "$MULTICALL3_ADDR" "$MC3_CODE" --rpc-url "$RPC_URL" > /dev/null 2>&1
  echo "  Multicall3: $MULTICALL3_ADDR (deployed)"
else
  echo "  Multicall3: $MULTICALL3_ADDR (already exists)"
fi

# ── Deploy Mock Tokens ──────────────────────────────────────
echo "[1/9] Deploying tokens..."
USDC=$(forge create contracts/test/helpers/Setup.sol:MockERC20 \
  --broadcast --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" \
  --constructor-args "USD Coin" "USDC" 6 2>&1 | grep "Deployed to:" | awk '{print $3}')
echo "  USDC: $USDC"

WETH=$(forge create contracts/test/helpers/Setup.sol:MockERC20 \
  --broadcast --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" \
  --constructor-args "Wrapped Ether" "WETH" 18 2>&1 | grep "Deployed to:" | awk '{print $3}')
echo "  WETH: $WETH"

# ── Deploy Core Contracts ───────────────────────────────────
echo "[2/7] Deploying core contracts..."
POLICY_ENGINE=$(forge create contracts/src/PolicyEngine.sol:PolicyEngine \
  --broadcast --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" 2>&1 | grep "Deployed to:" | awk '{print $3}')
echo "  PolicyEngine: $POLICY_ENGINE"

TRADE_VALIDATOR=$(forge create contracts/src/TradeValidator.sol:TradeValidator \
  --broadcast --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" 2>&1 | grep "Deployed to:" | awk '{print $3}')
echo "  TradeValidator: $TRADE_VALIDATOR"

FEE_DISTRIBUTOR=$(forge create contracts/src/FeeDistributor.sol:FeeDistributor \
  --broadcast --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" \
  --constructor-args "$DEPLOYER_ADDR" 2>&1 | grep "Deployed to:" | awk '{print $3}')
echo "  FeeDistributor: $FEE_DISTRIBUTOR"

VAULT_FACTORY=$(forge create contracts/src/VaultFactory.sol:VaultFactory \
  --broadcast --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" \
  --constructor-args "$POLICY_ENGINE" "$TRADE_VALIDATOR" "$FEE_DISTRIBUTOR" 2>&1 | grep "Deployed to:" | awk '{print $3}')
echo "  VaultFactory: $VAULT_FACTORY"

# ── Transfer ownership ──────────────────────────────────────
echo "[3/7] Transferring ownership to VaultFactory..."
cast send "$POLICY_ENGINE" "transferOwnership(address)" "$VAULT_FACTORY" \
  --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" > /dev/null 2>&1
cast send "$TRADE_VALIDATOR" "transferOwnership(address)" "$VAULT_FACTORY" \
  --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" > /dev/null 2>&1

# Accept ownership via VaultFactory.acceptDependencyOwnership()
cast send "$VAULT_FACTORY" "acceptDependencyOwnership()" \
  --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" > /dev/null 2>&1
echo "  Done."

# ── Fund accounts ───────────────────────────────────────────
echo "[4/7] Funding accounts..."
fund_account() {
  local addr="$1"
  local label="$2"
  cast send "$addr" --value 100ether --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" > /dev/null 2>&1
  cast send "$USDC" "mint(address,uint256)" "$addr" 1000000000000 \
    --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" > /dev/null 2>&1
  cast send "$WETH" "mint(address,uint256)" "$addr" 100000000000000000000 \
    --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" > /dev/null 2>&1
  echo "  $label ($addr): 100 ETH, 1M USDC, 100 WETH"
}

fund_account "$USER_ACCOUNT" "User"
cast send "$USDC" "mint(address,uint256)" "$DEPLOYER_ADDR" 1000000000000 \
  --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" > /dev/null 2>&1

# Fund additional wallets passed via EXTRA_ACCOUNTS env var (space-separated)
if [[ -n "${EXTRA_ACCOUNTS:-}" ]]; then
  for acct in $EXTRA_ACCOUNTS; do
    fund_account "$acct" "Extra"
  done
fi

# ── Create vault (service 0) ───────────────────────────────
echo "[5/9] Creating vault for service 0..."
cast send "$VAULT_FACTORY" \
  "createVault(uint64,address,address,address,address[],uint256,string,string,bytes32)" \
  0 "$USDC" "$DEPLOYER_ADDR" "$OPERATOR1_ADDR" "[$DEPLOYER_ADDR]" 1 \
  "Arena Vault Shares" "avSHARE" \
  "0x6172656e612d7661756c742d3000000000000000000000000000000000000000" \
  --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" > /dev/null 2>&1

VAULT_0=$(cast call "$VAULT_FACTORY" "getServiceVaults(uint64)(address[])" 0 --rpc-url "$RPC_URL" 2>&1 | tr -d '[]' | tr ',' '\n' | head -1 | xargs)
SHARE_0=$(cast call "$VAULT_FACTORY" "serviceShares(uint64)(address)" 0 --rpc-url "$RPC_URL" 2>&1 | xargs)
echo "  Vault: $VAULT_0"
echo "  Share: $SHARE_0"

# Seed vault with 50K USDC
echo "[6/9] Seeding vault..."
cast send "$USDC" "approve(address,uint256)" "$VAULT_0" "$(cast max-uint)" \
  --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" > /dev/null 2>&1
cast send "$VAULT_0" "deposit(uint256,address)" 50000000000 "$DEPLOYER_ADDR" \
  --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" > /dev/null 2>&1
echo "  50,000 USDC deposited"

# ── Register operators on Tangle ──────────────────────────────
echo "[7/9] Registering operators on Tangle..."

# Derive uncompressed ECDSA public keys using viem (already installed in arena)
derive_pubkey() {
  local privkey="$1"
  cd "$ROOT_DIR/arena" && node -e "
    const { privateKeyToAccount } = require('viem/accounts');
    const a = privateKeyToAccount('$privkey');
    process.stdout.write(a.publicKey);
  "
}

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OPERATOR1_PUBKEY=$(derive_pubkey "$OPERATOR1_KEY")
OPERATOR2_PUBKEY=$(derive_pubkey "$OPERATOR2_KEY")

# Register or update operator 1 (blueprint 0, rpc = pricing engine port 50051)
# Note: --gas-price 0 needed because Anvil snapshot accounts have EIP-1559 fee estimation issues
if ! cast send "$TANGLE" \
  "registerOperator(uint64,bytes,string)" \
  "$BLUEPRINT_ID" "$OPERATOR1_PUBKEY" "$OPERATOR1_RPC" \
  --gas-price 0 --priority-gas-price 0 --gas-limit 500000 \
  --rpc-url "$RPC_URL" --private-key "$OPERATOR1_KEY" > /dev/null 2>&1; then
  echo "  Operator 1 already registered, updating RPC address..."
  cast send "$TANGLE" \
    "updateOperatorPreferences(uint64,bytes,string)" \
    "$BLUEPRINT_ID" 0x "$OPERATOR1_RPC" \
    --gas-price 0 --priority-gas-price 0 --gas-limit 500000 \
    --rpc-url "$RPC_URL" --private-key "$OPERATOR1_KEY" > /dev/null 2>&1
fi
echo "  Operator 1: $OPERATOR1_ADDR → $OPERATOR1_RPC"

# Register or update operator 2 (blueprint 0, rpc = pricing engine port 50052)
if ! cast send "$TANGLE" \
  "registerOperator(uint64,bytes,string)" \
  "$BLUEPRINT_ID" "$OPERATOR2_PUBKEY" "$OPERATOR2_RPC" \
  --gas-price 0 --priority-gas-price 0 --gas-limit 500000 \
  --rpc-url "$RPC_URL" --private-key "$OPERATOR2_KEY" > /dev/null 2>&1; then
  echo "  Operator 2 already registered, updating RPC address..."
  cast send "$TANGLE" \
    "updateOperatorPreferences(uint64,bytes,string)" \
    "$BLUEPRINT_ID" 0x "$OPERATOR2_RPC" \
    --gas-price 0 --priority-gas-price 0 --gas-limit 500000 \
    --rpc-url "$RPC_URL" --private-key "$OPERATOR2_KEY" > /dev/null 2>&1
fi
echo "  Operator 2: $OPERATOR2_ADDR → $OPERATOR2_RPC"

# ── Permit callers on service 0 ───────────────────────────────
echo "[7.5/9] Adding permitted callers to service 0..."
add_permitted_caller() {
  local addr="$1"
  cast send "$TANGLE" "addPermittedCaller(uint64,address)" 0 "$addr" \
    --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" > /dev/null 2>&1 || true
}

add_permitted_caller "$USER_ACCOUNT"
add_permitted_caller "$DEPLOYER_ADDR"
echo "  Permitted: $USER_ACCOUNT, $DEPLOYER_ADDR"
if [[ -n "${EXTRA_ACCOUNTS:-}" ]]; then
  for acct in $EXTRA_ACCOUNTS; do
    add_permitted_caller "$acct"
    echo "  Permitted: $acct"
  done
fi

# ── Import operator keys into pricing engine keystores ────────
echo "[8/9] Setting up pricing engine keystores..."
CARGO_TANGLE="${CARGO_TANGLE_BIN:-$(command -v cargo-tangle 2>/dev/null || echo "$ROOT_DIR/../blueprint/target/release/cargo-tangle")}"
SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$SCRIPTS_DIR/data/operator1/keystore" "$SCRIPTS_DIR/data/operator2/keystore"

if [[ -x "$CARGO_TANGLE" ]]; then
  "$CARGO_TANGLE" tangle key import --key-type ecdsa \
    --secret "${OPERATOR1_KEY#0x}" \
    --keystore-path "$SCRIPTS_DIR/data/operator1/keystore" 2>/dev/null || true
  "$CARGO_TANGLE" tangle key import --key-type ecdsa \
    --secret "${OPERATOR2_KEY#0x}" \
    --keystore-path "$SCRIPTS_DIR/data/operator2/keystore" 2>/dev/null || true
  echo "  Keys imported via cargo-tangle"
else
  echo "  WARNING: cargo-tangle not found at $CARGO_TANGLE"
  echo "  Build it: cd ../blueprint && cargo build -p cargo-tangle --release"
  echo "  Then re-run this script to import operator keys"
fi

# ── Write env file ──────────────────────────────────────────
echo "[9/9] Writing arena/.env.local..."
cat > arena/.env.local <<EOF
VITE_USE_LOCAL_CHAIN=true
VITE_RPC_URL=http://127.0.0.1:8545
VITE_CHAIN_ID=31337
VITE_TANGLE_CONTRACT=$TANGLE
VITE_VAULT_FACTORY=$VAULT_FACTORY
VITE_USDC_ADDRESS=$USDC
VITE_WETH_ADDRESS=$WETH
VITE_SERVICE_IDS=0
VITE_SERVICE_VAULTS={"0":"$VAULT_0"}
VITE_BOT_META={"0":{"name":"Arena Demo Bot","strategyType":"dex"}}
VITE_OPERATOR_API_URL=/operator-api
VITE_DEFAULT_AI_PROVIDER=zai
VITE_DEFAULT_AI_API_KEY=${ZAI_API_KEY:-}
VITE_TRADING_BLUEPRINT=${TRADING_BLUEPRINT:-0x0000000000000000000000000000000000000000}
EOF

echo ""
echo "╔═════════════════════════════════════════════════════════════╗"
echo "║              TRADING ARENA — LOCAL TESTNET                  ║"
echo "╠═════════════════════════════════════════════════════════════╣"
echo "║ Tangle:          $TANGLE  ║"
echo "║ VaultFactory:    $VAULT_FACTORY  ║"
echo "║ USDC:            $USDC  ║"
echo "║ WETH:            $WETH  ║"
echo "║ Vault (svc 0):   $VAULT_0  ║"
echo "╠═════════════════════════════════════════════════════════════╣"
echo "║ User:      $USER_ACCOUNT          ║"
echo "║ Operator1: $OPERATOR1_ADDR → :50051 ║"
echo "║ Operator2: $OPERATOR2_ADDR → :50052 ║"
echo "╚═════════════════════════════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo "  1. Start pricing engines: ./scripts/run-pricing-engine.sh --config scripts/operator1.toml"
echo "  2. Start frontend:        cd arena && pnpm dev"
