# AI Trading Blueprints

Autonomous AI trading agents with decentralized risk validation and on-chain execution, built on [Tangle Network](https://tangle.tools).

AI agents run inside sandboxed Docker containers, analyze markets across 8 DeFi protocols, and generate trade intents that must pass through a three-layer security model — AI reasoning, a decentralized validator committee (2-of-3 EIP-712 signatures), and on-chain policy enforcement — before any capital moves.

## Architecture

```
Cron Tick → AI Agent → Fetch Prices → Check Portfolio → Analyze
               │
               ▼
          Build Intent → Validate (3 nodes) → Execute (on-chain)
               │              │
               ▼              ▼
          Store History   Policy + AI Score + EIP-712 Sign
                              │
                     if approved (score ≥ 50)
                              │
                              ▼
                     vault.execute(params, sigs, scores)
                              │
                     PolicyEngine + TradeValidator
                     2-of-3 multisig verification
                              │
                     Trade on DEX / Lending / Perp
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
| **Uniswap V3** | DEX | Token swaps (exact in/out) |
| **Aave V3** | Lending | Supply, borrow, repay, withdraw |
| **GMX v2** | Perpetuals | Leveraged long/short |
| **Morpho** | Lending | Optimized lending rates |
| **Vertex** | Perpetuals | Perp trading |
| **Hyperliquid** | Perpetuals | High-frequency leverage |
| **Polymarket** | Prediction | On-chain CTF + off-chain CLOB orders |
| **TWAP** | Execution | Time-weighted average price |

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

Every trade passes through three independent validation layers:

1. **AI Agent Reasoning** (off-chain) — Market analysis, portfolio context, risk assessment. Runs in an isolated Docker sidecar with no direct chain access.

2. **Decentralized Validator Committee** (off-chain + signatures) — 3 independent validator nodes each evaluate policy compliance (40% weight) and AI scoring (60% weight), then sign with EIP-712. Requires 2-of-3 valid signatures.

3. **On-Chain Guards** (hard limits) — `PolicyEngine` enforces token whitelists, position caps, leverage limits, rate limiting, and slippage bounds. `TradeValidator` recovers and verifies m-of-n EIP-712 signatures. Intent deduplication prevents replay.

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
# 1. Start local chain
anvil --host 0.0.0.0

# 2. Deploy contracts and register blueprint
./scripts/deploy-local.sh

# 3. Start operator node
cargo run --release -p trading-blueprint-bin

# 4. Start validator nodes (separate terminals)
cargo run --release -p trading-validator-bin

# 5. Start frontend
cd arena && pnpm dev
```

### Testing

```bash
# Solidity (379 tests)
cd contracts && forge test

# Rust unit tests
cargo test -p trading-runtime          # 159 tests
cargo test -p trading-http-api         # 47 tests
cargo test -p trading-blueprint-lib    # 132 tests (94 unit + 38 integration)
cargo test -p trading-validator-lib    # 42 tests
cargo test -p trading-instance-blueprint-lib  # 33 tests

# Arena frontend (36 tests)
cd arena && pnpm vitest run

# Full E2E with Docker sidecars (~6s)
SIDECAR_E2E=1 cargo test -p trading-blueprint-lib --test tangle_e2e_full

# Full E2E with AI scoring (~45s)
SIDECAR_E2E=1 ZAI_API_KEY=<key> cargo test -p trading-blueprint-lib --test tangle_e2e_full

# Binary process E2E (~9s)
SIDECAR_E2E=1 cargo test -p trading-blueprint-lib --test tangle_binary_e2e
```

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
| `POST /execute` | On-chain trade execution through vault |
| `GET /collateral/status` | CLOB collateral status |
| `POST /collateral/release` | Release vault funds for off-chain CLOB trading |
| `POST /collateral/return` | Return CLOB funds to vault |

## License

See [LICENSE](./LICENSE) for details.
