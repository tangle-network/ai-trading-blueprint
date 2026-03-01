# Development Memory

## Local Testnet Setup

### Prerequisites
- Anvil with pre-loaded Tangle protocol state:
  ```
  anvil --load-state ../blueprint/crates/chain-setup/anvil/snapshots/localtestnet-state.json --host 0.0.0.0
  ```
- The snapshot includes Tangle protocol at `0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9` with 1 existing blueprint (ID 0)

### Deploy
```
./scripts/deploy-local.sh
```
This runs the full Blueprint lifecycle — see below.

### Start Frontend
```
cd arena && pnpm dev
```

## Blueprint Lifecycle (How It Actually Works)

The on-chain flow for creating a service with an auto-deployed vault:

```
1. Deploy contracts (forge script)
   - MockERC20 tokens (USDC, WETH)
   - PolicyEngine, TradeValidator, FeeDistributor, VaultFactory
   - TradingBlueprint (BSM)

2. createBlueprint(BlueprintDefinition) on Tangle
   → Tangle calls BSM.onBlueprintCreated() → sets tangleCore = Tangle address
   → BlueprintDefinition is a complex nested struct, must use Forge (not cast)

3. Wire VaultFactory to BSM
   → BSM.setVaultFactory() has onlyFromTangle modifier
   → Requires anvil_impersonateAccount of Tangle contract

4. Register operators for the blueprint
   → Tangle.registerOperator(blueprintId, ecdsaPubkey, rpcUrl)

5. Request service
   → Tangle.requestService(blueprintId, operators, config, callers, ttl, ...)
   → Tangle calls BSM.onRequest() via _callManager (reverts on failure)
   → BSM stores vault config in _pendingRequests[requestId]
   → Config ABI-encodes: (address assetToken, address[] signers, uint256 requiredSigs, string name, string symbol)

6. Operators approve
   → Tangle.approveService(requestId, stakingPercent)
   → When ALL operators approve: _activateService() fires
   → _activateService calls BSM.onServiceInitialized() via _tryCallManager (silent on failure!)
   → BSM.onServiceInitialized() calls VaultFactory.createVault() → deploys TradingVault + VaultShare

7. Grant OPERATOR_ROLE (manual for Fixed membership)
   → _activateService does NOT call onOperatorJoined for Fixed membership
   → Must impersonate Tangle and call BSM.onOperatorJoined(serviceId, operator, weight)
   → This grants OPERATOR_ROLE on the vault to each operator
```

## Key Gotchas

### MetaMask "Confirm" Button Disabled — Root Causes
When MetaMask shows a disabled/greyed-out confirm button, it means gas estimation reverted. Common causes:

1. **`NotPermittedCaller(serviceId, address)`** — The wallet address isn't in the service's permitted callers list. Fix: `Tangle.addPermittedCaller(serviceId, address)` (only service owner can call).
2. **`chainId` passed to `writeContract()`** — NEVER pass explicit `chainId` to wagmi `writeContract()`. When the dapp-specified chainId differs from the wallet's chain, MetaMask detects a mismatch and disables confirm. Omit `chainId` entirely — wagmi uses the wallet's connected chain.
3. **Gas estimation failure** — The underlying call reverts for any reason. Check `cast call` with the same args to see the revert reason.

**Debugging**: Use `cast call <contract> <function> <args> --from <wallet> --rpc-url <url>` to simulate the exact call and see the revert error.

### Gas limit for approveService
The final `approveService` triggers a deep call chain:
```
approveService → proxy delegatecall → _activateService → _tryCallManager →
  BSM.onServiceInitialized → VaultFactory.createVault →
    CREATE2(VaultShare) [~1M gas] + CREATE2(TradingVault) [~2M gas]
```
TradingVault bytecode is ~9KB → 200 gas/byte = ~1.8M gas just for storage.
**Must use gas limit >= 5M (we use 10M).** The default 3M causes silent failure because `_tryCallManager` swallows the OutOfGas revert.

### _callManager vs _tryCallManager
- `_callManager`: Propagates reverts. Used by `requestService` → `onRequest`.
- `_tryCallManager`: Silently catches ALL reverts. Used by `_activateService` → `onServiceInitialized`.
- If a vault doesn't deploy, check `_tryCallManager` swallowing errors first.

### Forge script address parsing
`forge script --broadcast` outputs `console.log` values that match the actual deployed addresses. A subsequent dry-run (without `--broadcast`) would produce DIFFERENT addresses because nonces changed. Always parse from the broadcast output, never re-run.

### onBlueprintCreated has no ACL
`onBlueprintCreated()` only checks `tangleCore == address(0)`. Once set, it can't be changed. This means the BSM is permanently bound to whichever Tangle contract first calls `createBlueprint` with it as the manager.

### Blueprint ID
The Anvil snapshot has 1 pre-existing blueprint (ID 0). Our deploy creates blueprint ID 1. The ID comes from `_blueprintCount++` (pre-increment return).

### Adding new accounts after deploy
If a new wallet address needs to interact with an existing service:
```bash
# 1. Fund with ETH + tokens
cast send "$ADDR" --value 100ether --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY"
cast send "$USDC" "mint(address,uint256)" "$ADDR" 1000000000000 --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY"

# 2. Add as permitted caller (REQUIRED for submitJob)
cast send "$TANGLE" "addPermittedCaller(uint64,address)" "$SERVICE_ID" "$ADDR" \
  --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY"
```
Without step 2, `submitJob` reverts with `NotPermittedCaller` and MetaMask shows a disabled confirm button.

## SSR Browser Globals Fix

React Router v7 dev server evaluates the entire module graph server-side even with `ssr: false`. Two-part fix:

1. **`ssrBrowserShim` Vite transform plugin** (`vite.config.ts`): Injects browser globals (`document`, `window`, `navigator`, DOM classes) into every JS module that references them during SSR. Handles `@tangle/agent-ui`, `sonner`, `mipd`.

2. **`ClientWeb3Provider` in `root.tsx`**: The `connectkit` → `family` package starts real async wallet connections at import time that crash Node. `Web3Provider` is dynamically imported via `useEffect` so it's never evaluated server-side. Returns `null` until loaded (prevents `WagmiProviderNotFoundError`).

## Contract Addresses (from deploy-local.sh)
Written to `arena/.env.local` on each deploy. Key env vars:
- `VITE_TRADING_BLUEPRINT` — BSM address (must be non-zero for Blueprint-based bot discovery)
- `VITE_VAULT_FACTORY` — VaultFactory address
- `VITE_TANGLE_CONTRACT` — Tangle protocol address
- `VITE_SERVICE_IDS` — Comma-separated service IDs
- `VITE_SERVICE_VAULTS` — JSON map of serviceId → vault address

## BSM as Source of Truth
The Arena frontend queries the BSM (TradingBlueprint) for bot/vault discovery:
- `instanceVault(serviceId)` → vault address
- `instanceProvisioned(serviceId)` → bool
- `instanceShare(serviceId)` → share token address

This replaces the old approach of querying VaultFactory directly.

## Anvil Impersonation Pattern
For calls requiring `onlyFromTangle` modifier:
```bash
cast rpc anvil_impersonateAccount "$TANGLE"
cast rpc anvil_setBalance "$TANGLE" "0x56BC75E2D63100000"  # fund for gas
cast send "$BSM" "someFunction()" --from "$TANGLE" --unlocked --gas-price 0
cast rpc anvil_stopImpersonatingAccount "$TANGLE"
```

## Operator Key Derivation
Uncompressed ECDSA public keys for `registerOperator`:
```bash
node -e "const{privateKeyToAccount}=require('viem/accounts');process.stdout.write(privateKeyToAccount('0x...').publicKey)"
```
