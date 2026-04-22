# AI Trading Blueprints

Self-improving autonomous trading agents with decentralized risk validation, built on [Tangle Network](https://tangle.tools).

Agents trade across 10 DeFi protocols (Hyperliquid perps, Uniswap, Polymarket, Aave, GMX, etc.) with a three-tier security model: per-trade validator signatures for untrusted operators, pre-approved trading envelopes for instant execution, and self-operated mode for trusted operators. The same strategy config drives backtesting, paper trading, and live execution.

## Architecture

```
                    ┌─────────────────────────────────────┐
                    │         SELF-IMPROVING LOOP          │
                    │                                       │
  Candle data ──→ StrategyRunner ──→ TradeSignal           │
                       │                 │                  │
               ┌───────┴──────┐    ┌─────┴──────┐         │
               │ Advisory     │    │ Auto-exec   │         │
               │ (agent       │    │ (bracket    │         │
               │  decides)    │    │  orders)    │         │
               └───────┬──────┘    └─────┬──────┘         │
                       │                 │                  │
                Trade records + execution quality           │
                       │                                    │
              evolve-strategy.js ──→ mutate HarnessConfig  │
                       │                                    │
              POST /strategy/config ──→ runner updates     │
                       └────────────────────────────────────┘

  Validation trust:
    PerTrade    → validator EIP-712 sigs per trade (5-30s)
    Envelope    → pre-approved bounds, instant execution
    SelfOperated → local policy only, no external validation
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for full system diagrams.

## Deployment Models

| Model | Binary | Bots | Vault Creation | Use Case |
|-------|--------|------|----------------|----------|
| **Cloud Fleet** | `trading-blueprint-bin` | Multi-bot, shared HTTP API | On-chain `JOB_PROVISION` | Scalable operator fleets |
| **Instance** | `trading-instance-blueprint-bin` | Single dedicated bot | Service init vault + operator API provision | Per-subscription bots |
| **TEE Instance** | `trading-tee-instance-blueprint-bin` | Single bot + hardware isolation | Service init vault + operator API provision | Sensitive strategies in enclave |

## Runtime Backend Selection

Trading provision requests can select runtime backend via:

- `strategy_config_json.runtime_backend = "docker" | "firecracker" | "tee"`

Operator mapping:

- The provision handler maps this to sandbox metadata (`metadata_json.runtime_backend`).
- `firecracker` currently follows the sandbox-runtime Firecracker gate:
  it returns a clear validation error until provider wiring is enabled.
- `tee` is intended for confidential runtime selection; TEE instance blueprints pin this mode by default.

## Supported Protocols

| Adapter | Type | Operations |
|---------|------|------------|
| **Hyperliquid** | Perpetuals | Native L1 API: market/limit/stop-loss/take-profit/bracket orders, leverage, positions |
| **Uniswap V3** | DEX | Token swaps (exact in/out) |
| **Aave V3** | Lending | Supply, borrow, repay, withdraw |
| **GMX v2** | Perpetuals | Leveraged long/short |
| **Morpho** | Lending | Optimized lending rates |
| **Vertex** | Perpetuals | Perp trading |
| **Polymarket** | Prediction | On-chain CTF + off-chain CLOB orders |
| **Aerodrome** | DEX | Base L2 swaps |
| **TWAP** | Execution | Time-weighted average price |
| **Stat Arb** | Execution | Cross-venue statistical arbitrage |

## Strategy Packs

Modular AI prompt packs compose protocol adapters into trading strategies:

| Pack | Providers | Default Cron | Max Turns |
|------|-----------|-------------|-----------|
| `prediction` | Polymarket, Coingecko | Every 15 min | 20 |
| `dex` | Uniswap V3, Coingecko | Every 5 min | 12 |
| `yield` | Aave V3, Morpho, Coingecko | Every 15 min | 10 |
| `perp` | GMX v2, Hyperliquid, Vertex, Coingecko | Every 2 min | 15 |
| `volatility` | 6 providers | Every 10 min | 12 |
| `mm` | Polymarket, Hyperliquid, Uniswap V3, Coingecko | Every 1 min | 15 |
| `multi` | All 8 providers | Every 5 min | 20 |

## Security Model

Three-tier validation trust, set per bot at provision time:

| Trust Level | Who | Validation | Latency |
|-------------|-----|-----------|---------|
| **PerTrade** | Untrusted operators | Validator EIP-712 signatures per trade | 5-30s |
| **Envelope** | Depositor-approved strategy | Pre-approved bounds, instant within | ~0ms |
| **SelfOperated** | Self-hosted operators | Local policy only (envelope still enforced) | ~0ms |

**Trading Envelope** — operators approve a policy surface (allowed assets, max position size, leverage cap, total exposure limit, drawdown threshold, SL distance range). Trades within the envelope execute instantly. Cancels always instant. The exact entry/exit within the envelope is unpredictable — prevents front-running.

**On-Chain Guards** — `PolicyEngine` enforces token whitelists, position caps, leverage limits, rate limiting. `TradeValidator` verifies m-of-n EIP-712 signatures (minimum 2-of-2 floor). Intent deduplication prevents replay.

**Fund Safety** — position ledger survives restarts, startup reconciliation detects orphaned positions, SIGTERM handler emergency-closes all open positions, retry with exponential backoff on API failures.

**Security Audit** — 3 harden rounds, 12 CRITICALs + 8 HIGHs fixed, 429 Forge fuzz tests including adversarial scenarios (donation attacks, cross-vault NAV manipulation, score averaging, lockup bypass).

## Project Structure

### Rust Workspace (10 crates)

| Crate | Role |
|-------|------|
| `trading-runtime` | Core types, protocol adapters, trade executor, validator client, market data |
| `trading-http-api` | REST API consumed by AI agent sidecars (port 9100) |
| `trading-blueprint-lib` | Tangle blueprint jobs, workflow orchestration, sidecar lifecycle |
| `trading-blueprint-bin` | Operator binary — processes Tangle jobs, manages sidecars, runs HTTP API |
| `trading-validator-lib` | Validator server, policy evaluation, AI scoring, EIP-712 signing |
| `trading-validator-bin` | Validator binary — runs standalone validator nodes |
| `trading-instance-blueprint-lib` | Single-bot-per-service variant (simplified, no multi-bot routing) |
| `trading-instance-blueprint-bin` | Instance operator binary |
| `trading-tee-instance-blueprint-lib` | TEE-secured instance variant (Phala/Nitro/GCP/Azure enclaves) |
| `trading-tee-instance-blueprint-bin` | TEE instance operator binary |

### Solidity Contracts

| Contract | Purpose |
|----------|---------|
| `TradingBlueprint.sol` | Tangle blueprint — vault deployment, job handlers, operator roles |
| `TradingVault.sol` | ERC-7575 vault — trade execution with policy + signature checks |
| `VaultFactory.sol` | Deploys vault instances with configured policies and validators |
| `PolicyEngine.sol` | Per-vault risk policies (whitelists, limits, rate limiting) |
| `TradeValidator.sol` | EIP-712 signature verification, m-of-n multisig enforcement |
| `FeeDistributor.sol` | Fee collection and distribution (30% validators, 70% operators) |
| `VaultShare.sol` | ERC-20 share token for vault depositors |

### Arena Frontend

React 19 + React Router v7 + UnoCSS web app for managing bots, vaults, and provisioning.

- Bot dashboard with real-time metrics and trade history
- Multi-step provisioning workflow
- Vault deposit/withdrawal interface with collateral management
- Terminal integration for sidecar logs
- Web3 wallet connection (wagmi + ConnectKit)

## Getting Started

### Prerequisites

- **Rust** 1.80+
- **Foundry** (forge, anvil, cast)
- **Docker** with `tangle-sidecar:local` image
- **Node.js** 20+ with pnpm

### Build

```bash
# Rust workspace
cargo build --workspace

# Solidity contracts
cd contracts && forge build

# Arena frontend
cd arena && pnpm install
```

### Local Development

```bash
# Option A: cargo tangle harness (recommended)
cargo tangle harness up   # boots anvil, deploys contracts, runs operator

# Option B: manual
anvil --host 0.0.0.0
./scripts/deploy-local.sh
cargo run --release -p trading-blueprint-bin

# Validator nodes (separate terminals)
cargo run --release -p trading-validator-bin

# Frontend
cd arena && pnpm dev
```

### Deploy to Hetzner (production)

```bash
./deploy/go-live-base-sepolia.sh <server-ip> <operator-private-key>
```

Uses the Blueprint Manager (`cargo tangle blueprint run`), not the raw binary. Supports N service instances per BPM.
The default Base Sepolia `tnt-core` manifest is committed at
`deploy/manifests/base-sepolia/tnt-core.latest.json`, so operators do not need a
matching sibling checkout. Override with `TNT_CORE_DEPLOYMENT_MANIFEST=/path/to/manifest.json`
when targeting a different deployment snapshot.

### Base Sepolia Operator Prep

Fresh protocol deploys come from `tnt-core`, not this repo. This repo carries a
committed Base Sepolia manifest snapshot for the latest known-good deployment.
Load protocol addresses from that file by default, or point at another manifest
explicitly:

```bash
source ./scripts/load-base-sepolia-env.sh

# or
source ./scripts/load-base-sepolia-env.sh /path/to/tnt-core-manifest.json
```

That exports the current:

- `TANGLE_CONTRACT`
- `STAKING_CONTRACT` for the staking or `MultiAssetDelegation` contract
- `STATUS_REGISTRY_CONTRACT`
- `STATUS_REGISTRY_ADDRESS` for the operator heartbeat path
- `HTTP_RPC_URL=https://sepolia.base.org`
- `WS_RPC_URL=wss://base-sepolia-rpc.publicnode.com`
- `CHAIN_ID=84532`

Then set the blueprint-specific IDs from your own service deployment:

```bash
export BLUEPRINT_ID=<trading blueprint id>
export SERVICE_ID=<service instance id>
```

Pricing engine launch:

```bash
./scripts/run-pricing-engine.sh --config scripts/operator1.toml
```

Use `STAKING_CONTRACT` as the contract name throughout the operator and deployment flow.

### Testing

```bash
# Solidity (429 tests including adversarial fuzz)
cd contracts && forge test

# Rust unit tests (481 tests)
cargo test -p trading-runtime --lib          # 310 tests
cargo test -p trading-http-api --lib         # 16 tests
cargo test -p trading-blueprint-lib --lib    # 99 tests
cargo test -p trading-validator-lib --lib    # 56 tests

# Integration tests
cargo test -p trading-runtime --test new_signals_integration      # 9 signal type tests
cargo test -p trading-runtime --test backtest_runner_equivalence  # backtest↔live equivalence

# Hyperliquid E2E (requires funded testnet account)
HYPERLIQUID_E2E=1 EXECUTOR_PRIVATE_KEY=0x... \
  cargo test -p trading-runtime --test hyperliquid_e2e -- --nocapture

# Full E2E with Docker sidecars
SIDECAR_E2E=1 cargo test -p trading-blueprint-lib --test tangle_e2e_full
```

**Total: 928 tests (429 Forge + 499 Rust), 0 failures.**

## Operator API

Operators authenticate via EIP-191 challenge-response to receive PASETO session tokens.

```
POST /api/auth/challenge    → { message, nonce, expires_at }
POST /api/auth/session      → { token }  (sign message, submit signature)
```

Protected endpoints (require `Authorization: Bearer <token>`):

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/bots` | List all bots |
| GET | `/api/bots/{id}` | Bot details |
| GET | `/api/bots/{id}/trades` | Trade history |
| GET | `/api/bots/{id}/metrics` | Performance metrics |
| POST | `/api/bots/{id}/secrets` | Inject secrets (two-phase activation) |
| POST | `/api/bots/{id}/start` | Start trading |
| POST | `/api/bots/{id}/stop` | Stop trading |
| POST | `/api/bots/{id}/run-now` | Trigger immediate tick |
| PATCH | `/api/bots/{id}/config` | Update configuration |
| POST | `/api/bots/{id}/wipe-secrets` | Clear secrets |

## Trading HTTP API

REST API on port 9100, consumed by AI agents running inside sidecars:

| Endpoint | Purpose |
|----------|---------|
| `POST /market-data/prices` | Aggregated price feeds |
| `POST /portfolio/state` | Current holdings and positions |
| `POST /circuit-breaker/check` | Risk limit enforcement |
| `POST /validate` | Trade intent validation (fans out to validator committee) |
| `POST /execute` | Trade execution (routes to vault, HL, or CLOB based on target_protocol) |
| **Hyperliquid** | |
| `POST /hyperliquid/order` | Place any order type (market/limit/stop/TP) |
| `POST /hyperliquid/bracket` | Entry + stop-loss + take-profit grouped |
| `POST /hyperliquid/cancel` | Cancel order |
| `POST /hyperliquid/leverage` | Set leverage (cross/isolated) |
| `GET /hyperliquid/account` | Positions, margin, open orders |
| `GET /hyperliquid/prices` | Mid prices for all HL perp markets |
| `GET/PUT /hyperliquid/envelope` | View/update trading envelope |
| **Strategy Runner** | |
| `POST /strategy/tick` | Feed candle, get entry/exit signals (optional auto-execute) |
| `POST /strategy/config` | Update harness config (from evolve-strategy.js) |
| `GET /strategy/state` | Current runner state (harness version, rules) |
| **Collateral** | |
| `GET /collateral/status` | CLOB collateral status |
| `POST /collateral/release` | Release vault funds for off-chain CLOB trading |
| `POST /collateral/return` | Return CLOB funds to vault |

## Self-Improving Strategy Loop

The meta-harness automatically evolves trading strategies through backtesting:

1. **Backtest** — `HarnessConfig` defines entry/exit rules evaluated against historical candles
2. **Paper trade** — same config drives the `StrategyRunner` against live market data
3. **Live trade** — same config, real money, via `/strategy/tick` with `target_protocol`
4. **Evaluate** — execution quality metrics (slippage, fill time) + decision traces
5. **Evolve** — `evolve-strategy.js` mutates config, backtests variants, promotes winners
6. **Guard** — walk-forward validation blocks configs that overfit in-sample data

### Signal Types (13)

| Category | Signals |
|----------|---------|
| Momentum | RSI, MACD, PriceMomentum |
| Trend | EMA Cross, SMA Cross |
| Volatility | Bollinger Bands, ATR Breakout |
| Volume | Volume Surge, OBV, VWAP |
| Market Structure | FundingRate, FundingRateSpread, MeanReversion |

The agent can combine any signals with weighted conditions. The meta-harness discovers which combinations work.

## License

See [LICENSE](./LICENSE) for details.
