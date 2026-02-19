# AI Trading Blueprints — System Architecture

```
╔══════════════════════════════════════════════════════════════════════════════════════╗
║                         AI TRADING BLUEPRINTS — SYSTEM ARCHITECTURE                ║
╚══════════════════════════════════════════════════════════════════════════════════════╝


  USERS                         TANGLE NETWORK                    ON-CHAIN (EVM)
  ─────                         ──────────────                    ──────────────

  ┌─────────────┐               ┌──────────────────────────────────────────────────┐
  │  CUSTOMER   │──callJob()──▶ │              TANGLE PROTOCOL                     │
  │  (Strategy  │               │                                                  │
  │   Owner)    │               │  ┌─────────────────────┐ ┌────────────────────┐  │
  │             │               │  │  TRADING BLUEPRINT   │ │ VALIDATOR BLUEPRINT│  │
  │ - picks     │               │  │  (Service 0)         │ │ (Service 1)        │  │
  │   strategy  │               │  │                      │ │                    │  │
  │ - sets risk │               │  │  0: Provision        │ │ 0: Register        │  │
  │   params    │               │  │  1: Configure        │ │ 1: Deregister      │  │
  │ - funds     │               │  │  2: Start            │ │ 2: UpdateReputation│  │
  │   vault     │               │  │  3: Stop             │ │ 3: Slash           │  │
  └─────────────┘               │  │  4: Status           │ │ 4: UpdateConfig    │  │
                                │  │  5: Deprovision      │ │ 5: Liveness        │  │
                                │  │ 30: WorkflowTick     │ │                    │  │
                                │  └──────────┬───────────┘ └─────────┬──────────┘  │
                                └─────────────┼───────────────────────┼─────────────┘
                                              │                       │
                                              ▼                       ▼
                                ┌─────────────────────────────────────────────────┐
                                │                  OPERATOR NODE                   │
  ┌─────────────┐               │          (trading-blueprint-bin)                 │
  │  OPERATOR   │──runs────────▶│                                                  │
  │             │               │  Processes Tangle jobs, manages sidecars,        │
  │ - runs node │               │  orchestrates workflows, collects fees           │
  │ - deploys   │               └──────┬──────────────────────┬────────────────────┘
  │   infra     │                      │                      │
  │ - earns     │                      │ creates/destroys     │ registers cron
  │   fees      │                      ▼                      ▼
  └─────────────┘     ┌────────────────────────┐  ┌─────────────────────────┐
                      │    SIDECAR CONTAINER    │  │    WORKFLOW ENGINE      │
                      │    (Docker sandbox)     │  │                         │
                      │                         │  │  "0 */5 * * * *"       │
                      │  ┌───────────────────┐  │  │  (every 5 min)         │
                      │  │    AI AGENT       │  │  │                         │
                      │  │  (Claude / GLM)   │  │  │  triggers              │
                      │  │                   │  │  │  JOB_WORKFLOW_TICK ─────┤
                      │  │  System prompt:   │  │  └─────────────────────────┘
                      │  │  - API endpoints  │  │
                      │  │  - Risk params    │  │
                      │  │  - Strategy frag  │  │
                      │  └───────┬───────────┘  │
                      └──────────┼──────────────┘
                                 │
        Every tick the AI agent calls these endpoints:
                                 │
          ┌──────────────────────┼──────────────────────────┐
          │                      │                          │
          ▼                      ▼                          ▼
  ┌───────────────┐  ┌───────────────────┐  ┌──────────────────────┐
  │ 1. GET PRICES │  │ 2. GET PORTFOLIO  │  │ 3. CHECK CIRCUIT     │
  │               │  │                   │  │    BREAKER           │
  │ POST /market- │  │ POST /portfolio/  │  │                      │
  │ data/prices   │  │ state             │  │ POST /circuit-       │
  └───────────────┘  └───────────────────┘  │ breaker/check        │
                                            └──────────────────────┘
          │                      │                    │
          └──────────────────────┼────────────────────┘
                                 │
                                 ▼  AI reasons about market conditions
                        ┌────────────────┐
                        │ 4. VALIDATE    │
                        │                │
                        │ POST /validate │
                        └───────┬────────┘
                                │
  ════════════════════════════════════════════════════════════════════
                    TRADING HTTP API (axum, port 9100)
  ════════════════════════════════════════════════════════════════════
                                │
                  ValidatorClient.validate()
                     fans out to all validators
                                │
              ┌─────────────────┼─────────────────┐
              │                 │                  │
              ▼                 ▼                  ▼
  ┌───────────────────┐ ┌──────────────┐ ┌──────────────────┐
  │  VALIDATOR 1      │ │ VALIDATOR 2  │ │  VALIDATOR 3     │
  │                   │ │              │ │                  │
  │ ┌──────────────┐  │ │  (same as 1) │ │  (same as 1)     │
  │ │ Policy Check │  │ │              │ │                  │
  │ │ - deadline?  │  │ └──────────────┘ └──────────────────┘
  │ │ - slippage?  │  │
  │ │ - amount>0?  │  │    Each validator independently:
  │ ├──────────────┤  │    1. Policy check (40% weight)
  │ │ AI Scoring   │  │    2. AI scoring   (60% weight)
  │ │ (GLM-4.7)   │  │    3. EIP-712 sign (intentHash,
  │ │              │  │       vault, score, deadline)
  │ │ score 0-100  │  │
  │ │ + reasoning  │  │
  │ ├──────────────┤  │
  │ │ EIP-712 Sign │  │
  │ │              │  │
  │ │ signature    │  │
  │ └──────────────┘  │
  └───────────────────┘
              │                 │                  │
              └─────────────────┼──────────────────┘
                                │
                    3 signed responses returned
                    (score, signature, reasoning)
                                │
                                ▼
                    ┌────────────────────┐
                    │ aggregate_score    │
                    │ approved (>=50)    │
                    │ intent_hash        │
                    │ deadline           │
                    └────────┬───────────┘
                             │
                 if approved │
                             ▼
                    ┌────────────────┐
                    │ 5. EXECUTE     │
                    │                │
                    │ POST /execute  │
                    └───────┬────────┘
                            │
  ══════════════════════════╪═══════════════════════════════════════
              TRADE EXECUTOR│(trading-runtime)
  ══════════════════════════╪═══════════════════════════════════════
                            │
              ┌─────────────┼──────────────────┐
              │             │                  │
              ▼             ▼                  ▼
  ┌──────────────┐ ┌──────────────┐ ┌────────────────┐
  │ Protocol     │ │ Vault Client │ │ Chain Client   │
  │ Adapter      │ │              │ │                │
  │              │ │ encode       │ │ submit tx      │
  │ uniswap_v3  │ │ execute()    │ │ wait receipt   │
  │ aave_v3     │ │ calldata     │ │                │
  │ gmx_v2      │ │              │ │ → tx_hash      │
  │ morpho      │ └──────┬───────┘ │ → block_number │
  │ vertex      │        │         │ → gas_used     │
  │ polymarket   │        │         └───────┬────────┘
  │ twap        │        │                 │
  └──────────────┘        │                 │
                          ▼                 ▼
  ════════════════════════════════════════════════════════════════
                     EVM BLOCKCHAIN (Anvil / Mainnet)
  ════════════════════════════════════════════════════════════════

  ┌───────────────────────────────────────────────────────────────┐
  │                                                               │
  │   vault.execute(ExecuteParams, signatures[], scores[])        │
  │                                                               │
  │   ┌─────────────────┐   ┌───────────────────┐                │
  │   │  PolicyEngine    │   │  TradeValidator    │                │
  │   │                  │   │                    │                │
  │   │ ✓ token whitelist│   │ ✓ recover signers  │                │
  │   │ ✓ position limit │   │   from EIP-712     │                │
  │   │ ✓ leverage cap   │   │ ✓ check m-of-n     │  2-of-3       │
  │   │ ✓ rate limit     │   │   (2 valid = pass)  │  multisig     │
  │   │ ✓ max slippage   │   │ ✓ check deadline   │                │
  │   └────────┬─────────┘   └────────┬───────────┘                │
  │            │ pass                 │ pass                       │
  │            └──────────┬───────────┘                            │
  │                       ▼                                        │
  │              target.call(data)                                │
  │              (Uniswap/Aave/GMX/...)                           │
  │                       │                                        │
  │                       ▼                                        │
  │              verify min_output                                │
  │              emit TradeExecuted                               │
  │                                                               │
  └───────────────────────────────────────────────────────────────┘
```

## Vault & DeFi Users

```
  ┌─────────────┐
  │  DEFI USER  │
  │  (Depositor)│           ┌──────────────────────────────────┐
  │             │           │         VaultFactory              │
  │ - deposits  │──deploy──▶│  createVault(asset, signers...)   │
  │   capital   │           │          │                        │
  │ - receives  │           └──────────┼────────────────────────┘
  │   shares    │                      │ deploys
  │ - earns     │                      ▼
  │   returns   │           ┌──────────────────────────────────┐
  │             │           │        TradingVault               │
  │             │──deposit()│        (ERC-7575)                 │
  │             │──────────▶│                                   │
  │             │◀──shares──│  ┌──────────┐  ┌──────────────┐  │
  │             │           │  │ VaultShare│  │FeeDistributor│  │
  │             │──redeem()─│  │ (ERC-20)  │  │              │  │
  │             │──────────▶│  │           │  │ 20% perf fee │  │
  │             │◀──assets──│  │ tracks NAV│  │  2% mgmt fee │  │
  │             │           │  │ across    │  │ 30% → valids │  │
  └─────────────┘           │  │ vaults    │  │ 70% → ops    │  │
                            │  └──────────┘  └──────────────┘  │
                            └──────────────────────────────────┘
```

## Trading Loop Summary

```
  ╔══════════════════════════════════════════════════════════════╗
  ║                    TRADING LOOP SUMMARY                      ║
  ║                                                              ║
  ║   Cron ──▶ AI Agent ──▶ Fetch Prices ──▶ Check Portfolio    ║
  ║                │                                             ║
  ║                ▼                                             ║
  ║           Analyze ──▶ Build Intent ──▶ Validate (3 nodes)   ║
  ║                                            │                 ║
  ║                                    ┌───────┴───────┐         ║
  ║                                    │ Policy + AI   │         ║
  ║                                    │ Score & Sign  │         ║
  ║                                    └───────┬───────┘         ║
  ║                                            │                 ║
  ║                               if approved (score>=50)        ║
  ║                                            │                 ║
  ║                                            ▼                 ║
  ║           Execute ──▶ Adapter Encode ──▶ Vault.execute()    ║
  ║                                            │                 ║
  ║                                    ┌───────┴───────┐         ║
  ║                                    │ PolicyEngine  │         ║
  ║                                    │ TradeValidator│         ║
  ║                                    │ 2-of-3 sigs   │         ║
  ║                                    └───────┬───────┘         ║
  ║                                            │                 ║
  ║                                     Trade on DEX/Lending     ║
  ║                                                              ║
  ╚══════════════════════════════════════════════════════════════╝
```

## Strategy Types & Protocol Adapters

```
  STRATEGY TYPES                    PROTOCOL ADAPTERS
  ───────────────                   ──────────────────
  dex      → spot trading          uniswap_v3   (swap)
  yield    → lending/farming       aave_v3      (supply/borrow)
  perp     → leveraged trading     gmx_v2       (long/short)
  prediction → event markets       morpho       (lending)
  multi    → cross-strategy        vertex       (perp)
                                   polymarket   (prediction)
                                   twap         (time-weighted)
                                   stat_arb     (arbitrage)
```

## Security Model

Every trade passes through **3 independent validation layers**:

1. **AI Agent reasoning** — should I trade? (market analysis, portfolio context)
2. **3 Validator nodes** — is this trade safe? (policy checks + AI scoring + EIP-712 signatures, 2-of-3 must approve)
3. **On-chain PolicyEngine + TradeValidator** — hard limits (whitelists, position caps, leverage, rate limiting) + cryptographic signature verification

## Session Management & Auth

- **Operator API auth**: EIP-191 challenge-response → PASETO v4.local tokens (1hr TTL)
- **Per-tick session isolation**: Each cron tick creates a fresh session (`trading-{bot_id}-{timestamp}`). No conversation context preserved between ticks.
- **Persistent state**: Filesystem survives across ticks — SQLite DB, phase.json, insights.jsonl, tools/
- **Submitter verification**: `verify_submitter()` ensures API caller == bot.submitter_address

## Agent Iteration Protocol (4-Phase)

```
bootstrap → research → trading → reflect → research → ...
```

Each tick, the loop prompt instructs the agent to:
1. Read `phase.json` for current phase/iteration
2. Review learning history (memory table, insights.jsonl, signal accuracy)
3. Execute the current phase protocol
4. Update phase.json, write metrics

### Agent Workspace (per sandbox)

```
/home/agent/
├── data/trading.db        # SQLite: markets, trades, signals, performance, memory
├── tools/                 # Agent-built Python scripts (scanners, analyzers)
├── memory/insights.jsonl  # Append-only learning log
├── metrics/latest.json    # Current metrics (read by /metrics endpoint)
├── logs/decisions.jsonl   # Trade decision log with reasoning
└── state/phase.json       # Current phase + iteration counter
```

### Feedback Loop

The reflect phase writes insights to the `memory` table and `insights.jsonl`. The loop prompt instructs the agent to read these before acting — past signal accuracy directly weights future decisions. The `memory` table tracks `times_confirmed` to reinforce reliable patterns.

## Scheduling

- **Cron engine**: `tokio_cron_scheduler`, per-bot cron expressions
- **Global tick**: `workflow_tick` (job 30) checks which bots are due each minute
- **Wind-down**: 24h before TTL expiry, loop prompt switches to close-all-positions mode
- **Reaper**: Kills containers after TTL expiry + grace period

## Strategy Packs

| Pack | Providers | Default Cron | Max Turns |
|------|-----------|-------------|-----------|
| prediction | polymarket, coingecko | */15 min | 20 |
| dex | uniswap_v3, coingecko | */5 min | 12 |
| yield | aave_v3, morpho, coingecko | */15 min | 10 |
| perp | gmx_v2, hyperliquid, vertex, coingecko | */2 min | 15 |
| volatility | 6 providers | */10 min | 12 |
| mm | polymarket, hyperliquid, uniswap_v3, coingecko | */1 min | 15 |
| multi | all 8 providers | */5 min | 20 |

## Local Development

```bash
anvil --load-state scripts/data/anvil-state.json --host 0.0.0.0
./scripts/deploy-local.sh
./scripts/start-pricing-engines.sh
cargo run --release -p trading-blueprint-bin
cd arena && pnpm dev
```

State directory: `BLUEPRINT_STATE_DIR` (default `./blueprint-state/`). Wipe this + `scripts/data/operator*/trading/` for a full reset.

## Crate Map

| Crate | Role |
|-------|------|
| `trading-runtime` | Core types, adapters, executor, validator client, market data |
| `trading-http-api` | REST API consumed by AI agent sidecars |
| `trading-blueprint-lib` | Tangle blueprint jobs + workflow orchestration |
| `trading-blueprint-bin` | Operator binary (runs the trading blueprint) |
| `trading-validator-lib` | Validator server, AI scoring, EIP-712 signing |
| `trading-validator-bin` | Validator binary (runs a validator node) |
| `contracts/` | Solidity: TradingVault, TradeValidator, PolicyEngine, FeeDistributor, VaultFactory |
