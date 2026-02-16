# Tangle Trading Arena — Frontend Design Specification

A competition-style AI trading dashboard built on the Tangle Network blueprint
system. Inspired by [nof1.ai Alpha Arena](https://nof1.ai), adapted for
Tangle's multi-operator, validator-scored, vault-based architecture.

The frontend is a **7th workspace crate** (`trading-arena-web`) in this repo. It
runs as a Next.js app that talks directly to the blueprint binaries, the Tangle
contracts, and the per-bot HTTP APIs. All Tangle operations (provision, start,
stop, configure, extend, deprovision) go through on-chain job submission —
there is no separate backend. The blueprint IS the backend.

---

## Architecture: Built on Blueprints

```
┌──────────────────────────────────────────────────────────────────────┐
│                         trading-arena-web                            │
│                      (Next.js 15 + wagmi/viem)                      │
├────────────┬─────────────────┬───────────────────┬───────────────────┤
│ On-chain   │ Bot HTTP APIs   │ Validator APIs    │ Local DB          │
│ (wagmi)    │ (per-sidecar)   │ (per-validator)   │ (PostgreSQL)      │
├────────────┼─────────────────┼───────────────────┼───────────────────┤
│ • Submit   │ • /validate     │ • /validate       │ • Competitions    │
│   Tangle   │ • /execute      │ • /health         │ • Cached metrics  │
│   jobs     │ • /portfolio    │                   │ • User prefs      │
│ • Read     │ • /market-data  │                   │ • Trade index     │
│   vault    │ • /metrics      │                   │                   │
│   state    │ • /circuit      │                   │                   │
│ • Deposit/ │ • /adapters     │                   │                   │
│   withdraw │                 │                   │                   │
└────────────┴─────────────────┴───────────────────┴───────────────────┘
       │              │                 │                    │
       ▼              ▼                 ▼                    ▼
  Tangle         trading-          trading-            PostgreSQL
  Contracts      blueprint-bin     validator-bin       (arena-local)
  (Anvil/        (BlueprintRunner) (BlueprintRunner)
   Mainnet)
```

**Key principle**: The blueprint binaries (`trading-blueprint-bin`,
`trading-validator-bin`) are the source of truth. The frontend reads on-chain
state via viem, reads bot state via the per-bot HTTP APIs, and submits all
mutations as Tangle jobs. The only thing stored locally in PostgreSQL is
frontend-specific data: competition definitions, cached metric snapshots for
charting, and user preferences.

---

## Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Framework | **Next.js 15** (App Router, Turbopack) | SSR for SEO on public leaderboard, RSC for data-heavy pages |
| Language | **TypeScript** | End-to-end type safety with ABI types from sol! macros |
| Styling | **Tailwind CSS v4** | Utility-first, matches Tangle's design system |
| Components | **shadcn/ui** | Accessible primitives, fully customizable |
| Charts | **Recharts** + **Lightweight Charts** (TradingView) | Recharts for metrics, LW Charts for candlestick/equity curves |
| State | **TanStack Query v5** | Server state with real-time polling/WebSocket invalidation |
| Web3 | **wagmi v2** + **viem** | Vault deposits, on-chain reads, Tangle job submission |
| Auth | **SIWE** (Sign-In With Ethereum) | Wallet-native auth, operator identity |
| Local DB | **PostgreSQL** + **Prisma** | Competition registry, metric cache, trade index |
| Real-time | **WebSocket** or **SSE** | Live price feeds, position updates, leaderboard ticks |
| ABI Gen | **wagmi CLI** (`wagmi generate`) | TypeScript bindings from Solidity ABIs |

---

## Design System — "Tangle Dark"

### Colors

```css
:root {
  /* Backgrounds (elevation via color, not shadow) */
  --bg-base:       #0a0a12;     /* Deepest background */
  --bg-surface:    #111122;     /* Cards, panels */
  --bg-elevated:   #1a1a2e;     /* Hover states, active cards */
  --bg-overlay:    rgba(255, 255, 255, 0.04);

  /* Tangle accent gradient */
  --accent-start:  #5F5BEE;     /* Tangle purple */
  --accent-end:    #465CD2;     /* Tangle blue */
  --accent-glow:   rgba(95, 91, 238, 0.15);

  /* Semantic */
  --color-positive: #22c55e;    /* Green — profit, approved, running */
  --color-negative: #ef4444;    /* Red — loss, rejected, stopped */
  --color-warning:  #f59e0b;    /* Amber — pending, caution */
  --color-info:     #3b82f6;    /* Blue — informational */

  /* Text */
  --text-primary:   #ffffff;
  --text-secondary: rgba(255, 255, 255, 0.64);
  --text-tertiary:  rgba(255, 255, 255, 0.40);
  --text-muted:     rgba(255, 255, 255, 0.24);

  /* Borders */
  --border-default: rgba(255, 255, 255, 0.08);
  --border-hover:   rgba(255, 255, 255, 0.16);
}
```

### Typography

- **Headings**: Montserrat SemiBold
- **Body**: Open Sans Regular / Medium
- **Mono** (addresses, hashes, code): Inconsolata
- Size scale: 12 / 14 / 16 / 20 / 24 / 32 / 48px

### Component Patterns

- **Cards**: `bg-surface` fill, `border-default` 1px border, no shadow, 12px radius
- **Glowing buttons** (primary CTA): Animated conic-gradient border (Tangle signature), purple→blue gradient fill
- **Data pills**: Small rounded chips for status (Running/Stopped/Pending), strategy type, chain
- **Tables**: Alternating row opacity, sticky headers, sortable columns
- **Elevation**: Color shift only (base → surface → elevated), never box-shadow

---

## Information Architecture

```
/                               → Landing + Live Arena (public)
/arena                          → Competition Leaderboard (public)
/arena/[competitionId]          → Competition Detail (public)
/bots                           → All Bots Grid (public)
/bots/[botId]                   → Bot Detail Page (public)
/bots/[botId]/trades            → Full Trade History
/bots/[botId]/reasoning         → AI Chat Log / Decision Trace
/validators                     → Validator Leaderboard (public)
/validators/[address]           → Validator Detail
/vaults                         → Vault Explorer (public)
/vaults/[address]               → Vault Detail + Deposit/Withdraw
/provision                      → Create New Bot (authenticated)
/provision/configure             → Strategy & Risk Config Wizard
/dashboard                      → Operator Dashboard (authenticated)
/dashboard/bots                 → My Bots Management
/dashboard/earnings             → Fee Revenue & Rewards
/settings                       → Operator Settings
```

---

## Page Designs

### 1. Landing Page (`/`)

**Hero Section**
- Headline: "AI Trading Arena on Tangle"
- Subtitle: "Watch AI models compete with real capital. Validated by decentralized operators. Secured by on-chain vaults."
- Animated Tangle gradient mesh background
- Two CTAs: "Watch the Arena" (ghost button) | "Deploy a Bot" (glowing button)

**Live Ticker Strip**
- Horizontal scrolling bar showing top 5 bots by 24h PnL
- Format: `🤖 Bot Name | +12.4% | $14,200 AV | Uniswap V3`
- Auto-updates via WebSocket

**Competition Spotlight Card**
- Current active competition with countdown timer
- Mini leaderboard (top 3) with sparkline equity curves
- "View Full Arena →" link

**How It Works** (3-column)
| Deploy | Validate | Compete |
|--------|----------|---------|
| Configure your AI trading strategy, risk params, and vault | Decentralized validators score every trade with AI + policy checks | Bots compete on risk-adjusted returns with full transparency |

**Stats Bar**
- Total Bots Active | Total Value in Vaults | Trades Validated | Validators Online

---

### 2. Arena / Competition Leaderboard (`/arena/[id]`)

The core page. Mirrors nof1.ai's model leaderboard but adds Tangle-specific concepts.

**Competition Header**
```
┌─────────────────────────────────────────────────────────────────┐
│  Season 2: DeFi Alpha Challenge                                │
│  Started: Feb 1, 2026  │  Ends: Mar 1, 2026  │  ⏱ 12d 4h left │
│  Starting Capital: $10,000 each  │  Chain: Ethereum Mainnet     │
│  Strategy Types: DEX, Yield  │  6 Competing Bots               │
└─────────────────────────────────────────────────────────────────┘
```

**Comparative Equity Curve**
- Full-width Lightweight Chart showing all bots overlaid
- Toggle individual bots on/off
- Time range selector: 1D / 1W / All
- Crosshair synced across all curves

**Leaderboard Table**

| Rank | Bot | Strategy | Account Value | Return % | Daily PnL | Sharpe | Max DD | Win Rate | Trades | Validators | Score Avg |
|------|-----|----------|---------------|----------|-----------|--------|--------|----------|--------|------------|-----------|
| 1 | AlphaSeeker | DEX | $14,764 | +47.6% | +$312 | 1.42 | -8.2% | 64% | 142 | 3/3 | 82 |
| 2 | YieldHunter | Yield | $13,200 | +32.0% | +$180 | 1.15 | -5.1% | 71% | 89 | 3/3 | 76 |

Each row:
- Click → navigates to `/bots/[botId]`
- Sparkline mini-chart in the "Return %" column
- Color-coded: green rows for positive, red for negative
- Strategy type shown as a colored pill (DEX=blue, Yield=green, Perp=orange, Prediction=purple)
- "Score Avg" = average validator approval score across all trades

**Side Panel: Recent Trades Feed**
- Live-updating feed of last 20 trades across all competing bots
- Each entry: `Bot | Action | Pair | Amount | Score | ✓/✗ | Time`
- Clicking a trade opens a slide-over with full reasoning

---

### 3. Bot Detail Page (`/bots/[botId]`)

The deepest page. Full transparency into a single bot.

**Bot Header**
```
┌──────────────────────────────────────────────────────────────────┐
│  🤖 AlphaSeeker                                    [Running ●]  │
│  Strategy: DEX (Uniswap V3)  │  Chain: Ethereum                │
│  Vault: 0x1234...abcd  │  Operator: 0xf39F...6e51              │
│  Created: Feb 1, 2026  │  Lifetime: 28d remaining              │
│  Paper Trade: No  │  Cron: Every 5 min                          │
└──────────────────────────────────────────────────────────────────┘
```

**Top Metrics Row** (6 cards in a grid)
```
┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐
│ Acct Value │ │ Total PnL  │ │ Win Rate   │ │ Sharpe     │ │ Max DD     │ │ Avg Score  │
│ $14,764    │ │ +$4,764    │ │ 64%        │ │ 1.42       │ │ -8.2%      │ │ 82/100     │
│ ▲ +2.1%    │ │ ▲ +$312    │ │ 91/142     │ │            │ │            │ │ from 3 val │
└────────────┘ └────────────┘ └────────────┘ └────────────┘ └────────────┘ └────────────┘
```

**Tab Navigation**
```
[ Performance ]  [ Positions ]  [ Trade History ]  [ Reasoning Log ]  [ Validators ]  [ Risk Config ]
```

#### Tab: Performance
- **Equity Curve**: Large Lightweight Chart, account value over time
- **Drawdown Chart**: Below equity, showing drawdown % from high-water mark
- **Daily Returns Heatmap**: Calendar grid, color intensity = daily return magnitude
- **PnL Distribution**: Histogram of trade PnL outcomes

#### Tab: Positions
Live portfolio view from `POST /portfolio/state`

| Token | Type | Amount | Entry | Current | Unrealized PnL | Protocol |
|-------|------|--------|-------|---------|-----------------|----------|
| ETH | Spot | 10.5 | $2,000 | $2,500 | +$5,250 | Uniswap V3 |
| USDC | Lending | 5,000 | — | — | +$42 (yield) | Aave V3 |

- Position type pills: Spot / Lending / Borrowing / LongPerp / ShortPerp / ConditionalToken
- Total portfolio value + allocation donut chart

#### Tab: Trade History
Full list from trade execution logs

| Time | Action | Pair | Amount | Price | Score | Approved | Tx Hash | Reasoning |
|------|--------|------|--------|-------|-------|----------|---------|-----------|
| 14:32 | Swap | ETH→USDC | 1.5 ETH | $2,500 | 82 | Yes ✓ | 0xab12... | "Taking profit..." |

- Filterable by: action type, approval status, date range, score range
- Expandable rows showing full validator responses
- Export to CSV

#### Tab: Reasoning Log (nof1-style Chat View)
Chronological AI decision trace. Each entry is a "conversation turn":

```
┌─────────────────────────────────────────────────────────────────┐
│ 🕐 Feb 15, 2026 14:30:00  │  Trading Loop #47                 │
├─────────────────────────────────────────────────────────────────┤
│ MARKET ANALYSIS                                                 │
│ "ETH is up 3.2% in the last hour with increasing volume.       │
│  RSI at 72 suggests overbought conditions. However, the 4H     │
│  trend remains bullish. Considering taking partial profit on    │
│  the existing ETH position..."                                  │
├─────────────────────────────────────────────────────────────────┤
│ DECISION: Swap 1.5 ETH → USDC on Uniswap V3                   │
│ Confidence: 0.78  │  Fee Tier: 0.3%  │  Slippage: 0.5%        │
├─────────────────────────────────────────────────────────────────┤
│ VALIDATION                                                      │
│ Validator 0xabc1...  │  Score: 85  │  "Trade meets policy..."  │
│ Validator 0xdef2...  │  Score: 79  │  "Acceptable risk..."     │
│ Validator 0x7890...  │  Score: 82  │  "Slippage within..."     │
│ Aggregate: 82/100  │  ✓ APPROVED                               │
├─────────────────────────────────────────────────────────────────┤
│ EXECUTION                                                       │
│ Tx: 0xab12...ef56  │  Block: 17,234,567  │  Gas: 125,000      │
│ Received: 3,750 USDC  │  Effective Price: $2,500.00            │
└─────────────────────────────────────────────────────────────────┘
```

#### Tab: Validators
Which validators are scoring this bot's trades:

| Validator | Address | Avg Score | Validations | Avg Latency | AI Provider | Status |
|-----------|---------|-----------|-------------|-------------|-------------|--------|
| Validator A | 0xabc1... | 82 | 142 | 1.2s | Claude | Online ● |
| Validator B | 0xdef2... | 76 | 140 | 3.4s | Z.ai GLM | Online ● |

#### Tab: Risk Config
Read-only display (owner can edit via `/dashboard`):

```
Max Position Size:    $10,000
Max Drawdown:         10%
Max Leverage:         1x (no leverage)
Max Slippage:         100 bps (1%)
Max Trades/Hour:      10
Allowed Tokens:       WETH, USDC, WBTC
Allowed Protocols:    uniswap_v3, aave_v3
Circuit Breaker:      Enabled (10% drawdown trigger)
```

---

### 4. Validator Leaderboard (`/validators`)

**Header Stats**
- Total Validators | Average Score | Total Validations | Avg Latency

**Table**

| Rank | Validator | Stake | Validations | Avg Score | Avg Latency | Uptime | Slash Events | AI Provider |
|------|-----------|-------|-------------|-----------|-------------|--------|--------------|-------------|
| 1 | 0xabc1... | 50 ETH | 1,420 | 84 | 1.2s | 99.9% | 0 | Claude |
| 2 | 0xdef2... | 30 ETH | 1,380 | 78 | 3.1s | 98.5% | 1 | Z.ai GLM |

**Validator Detail Page** (`/validators/[address]`)
- Score distribution histogram
- Latency over time chart
- Recent validations with reasoning excerpts
- Slash history with evidence
- Liveness heartbeat timeline

---

### 5. Vault Explorer (`/vaults`)

**Vault List**

| Vault | Asset | TVL | Bot | Strategy | Depositors | APY (est) | Status |
|-------|-------|-----|-----|----------|------------|-----------|--------|
| 0x1234... | USDC | $250,000 | AlphaSeeker | DEX | 12 | +47.6% | Active |

**Vault Detail Page** (`/vaults/[address]`)

```
┌─────────────────────────────────────────────────────────┐
│  Vault 0x1234...abcd                                    │
│  Asset: USDC  │  Share Token: 0x5678...                 │
│  TVL: $250,000  │  Share Price: $1.47                   │
│  Strategy: DEX (Uniswap V3)  │  Bot: AlphaSeeker       │
├─────────────────────────────────────────────────────────┤
│  [ Deposit ]  [ Withdraw ]      Connected: 0xf39F...   │
│  ┌──────────────────────┐                               │
│  │ Amount: [____] USDC  │                               │
│  │ You receive: ~680 shares                             │
│  │ [Approve & Deposit]  │                               │
│  └──────────────────────┘                               │
├─────────────────────────────────────────────────────────┤
│  TVL Chart  │  Share Price Chart  │  Deposit History    │
└─────────────────────────────────────────────────────────┘
```

- Deposit/withdraw requires wallet connection (wagmi)
- Shows ERC-20 approve + deposit two-step flow
- Historical TVL and share price charts
- List of depositors (anonymized addresses)
- Fee structure: management fee + performance fee

---

### 6. Provision Wizard (`/provision`)

Multi-step form for deploying a new trading bot via Tangle job submission.

**Step 1: Strategy**
- Strategy type selector: DEX / Yield / Perp / Prediction (cards with descriptions)
- Name your bot
- Select chain (Ethereum, Arbitrum, Base)

**Step 2: Configuration**
- JSON editor (Monaco) for strategy_config
- Pre-built templates per strategy type
- Protocol selector (checkboxes): Uniswap V3, Aave V3, GMX V2, etc.
- Token allowlist builder (search + add tokens)

**Step 3: Risk Parameters**
- Slider controls for: max position size, max drawdown, max leverage, max slippage
- Trades per hour limit
- Circuit breaker toggle + threshold

**Step 4: Infrastructure**
- CPU cores (1/2/4)
- Memory (512MB / 1GB / 2GB)
- Lifetime (7d / 30d / 90d)
- Trading loop interval (1m / 5m / 15m / 1h)
- Paper trade toggle

**Step 5: Validators**
- Select validator services (checkboxes from on-chain registry)
- Shows each validator's stats
- Required signatures (m-of-n)

**Step 6: Vault**
- Asset token selector
- Signer addresses (multi-sig)
- Required signature threshold
- Initial deposit amount

**Step 7: Review & Deploy**
- Full summary of all config
- Estimated cost
- "Deploy Bot" button → submits `JOB_PROVISION` to Tangle
- Progress indicator: Submitting → Confirmed → Sidecar Starting → Ready

---

### 7. Operator Dashboard (`/dashboard`)

Authenticated view for operators managing their bots.

**Overview Cards**
- Total Bots | Active / Stopped | Total AUM | Revenue Earned

**My Bots Table**

| Bot | Status | Strategy | AUM | PnL (24h) | Uptime | Actions |
|-----|--------|----------|-----|-----------|--------|---------|
| AlphaSeeker | Running ● | DEX | $250K | +$1,200 | 14d | [Stop] [Configure] [Extend] |
| YieldBot | Stopped ○ | Yield | $100K | — | — | [Start] [Deprovision] |

**Actions (via Tangle jobs)**
- Stop → `JOB_STOP_TRADING`
- Start → `JOB_START_TRADING`
- Configure → navigates to config editor, submits `JOB_CONFIGURE`
- Extend → modal with days input, submits `JOB_EXTEND`
- Deprovision → confirmation modal, submits `JOB_DEPROVISION`
- Status refresh → `JOB_STATUS`

**Webhook Manager**
- Configure webhook events for bots
- Event types: price_move, rebalance, alert
- Target selector: all / strategy:type / bot:id

---

## Data Flow Architecture

The frontend talks to three systems, all of which already exist in the blueprint
workspace:

### 1. Tangle Contracts (via wagmi/viem)

All mutations go through on-chain job submission. The frontend encodes job
payloads using the same ABI types defined in `trading-blueprint-lib/src/lib.rs`
(`TradingProvisionRequest`, `TradingConfigureRequest`, etc.) and submits them
to the Tangle contract. The blueprint binary picks them up via `TangleProducer`.

```typescript
// Example: provision a new bot (client-side, via wagmi)
import { encodeFunctionData } from 'viem'
import { tangleAbi } from '@/generated/abi'

const tx = await writeContract({
  address: TANGLE_CONTRACT,
  abi: tangleAbi,
  functionName: 'submitJob',
  args: [serviceId, JOB_PROVISION, encodedProvisionRequest],
})
```

On-chain reads (vault TVL, share price, operator registrations, service
configs) also go through wagmi hooks — no backend needed.

### 2. Per-Bot HTTP APIs (direct from browser)

Each provisioned bot runs a trading HTTP API (from `trading-http-api` crate)
inside its sidecar. The frontend calls these directly for live data:

- `POST /portfolio/state` — current positions
- `POST /market-data/prices` — price feeds
- `POST /validate` — trigger trade validation
- `POST /execute` — execute validated trade
- `POST /circuit-breaker/check` — drawdown status
- `GET /metrics` — bot health snapshot
- `GET /adapters` — supported protocols

Auth: `Authorization: Bearer {bot_api_token}` (token stored in operator's
local session after provisioning).

### 3. Next.js API Routes (thin caching layer)

A minimal server-side layer for things that don't belong on-chain:

- **Competition registry**: CRUD for competition definitions (PostgreSQL)
- **Metric snapshots**: Periodic polling of bot APIs, cached for chart history
- **Trade index**: Aggregate trade history across bots for leaderboard computation
- **SIWE session**: Wallet-based authentication state

---

## Real-Time Updates

| Data | Method | Frequency |
|------|--------|-----------|
| Leaderboard rankings | WebSocket / SSE | Every 30s |
| Bot equity values | Poll bot API | Every 60s |
| Trade feed | WebSocket | On each trade |
| Vault TVL | On-chain event listener | On deposit/withdraw |
| Validator liveness | Poll | Every 60s |
| Price tickers | External WS (e.g. Pyth) | Sub-second |

---

## Key Interactions Matrix

Every mutation goes through on-chain Tangle job submission. The frontend
encodes the same ABI structs from `trading-blueprint-lib/src/lib.rs` and
submits via wagmi. Read-only queries go directly to the per-bot HTTP APIs
or on-chain contract reads.

| User Action | Frontend Route | Data Source | Tangle Job? |
|-------------|---------------|-------------|-------------|
| View leaderboard | `/arena/[id]` | Cached metrics (PostgreSQL) + bot APIs | No |
| View bot detail | `/bots/[id]` | Bot HTTP API (direct) | No |
| View positions | `/bots/[id]` (Positions tab) | `POST /portfolio/state` on bot API | No |
| View trade history | `/bots/[id]/trades` | Bot API + cached index | No |
| View reasoning | `/bots/[id]/reasoning` | Bot API (trade logs) | No |
| Deposit to vault | `/vaults/[addr]` | wagmi: `vault.deposit()` | No (direct on-chain) |
| Withdraw from vault | `/vaults/[addr]` | wagmi: `vault.withdraw()` | No (direct on-chain) |
| Read vault TVL | `/vaults/[addr]` | wagmi: `vault.totalAssets()` | No (on-chain read) |
| Provision new bot | `/provision` | wagmi → Tangle `submitJob(JOB_PROVISION)` | **Yes** |
| Stop bot | `/dashboard` | wagmi → Tangle `submitJob(JOB_STOP_TRADING)` | **Yes** |
| Start bot | `/dashboard` | wagmi → Tangle `submitJob(JOB_START_TRADING)` | **Yes** |
| Configure bot | `/dashboard` | wagmi → Tangle `submitJob(JOB_CONFIGURE)` | **Yes** |
| Extend bot | `/dashboard` | wagmi → Tangle `submitJob(JOB_EXTEND)` | **Yes** |
| Deprovision bot | `/dashboard` | wagmi → Tangle `submitJob(JOB_DEPROVISION)` | **Yes** |
| Check bot status | `/dashboard` | wagmi → Tangle `submitJob(JOB_STATUS)` | **Yes** |
| Send webhook | `/dashboard` | wagmi → Tangle `submitJob(JOB_WEBHOOK_EVENT)` | **Yes** |
| Run prompt | `/dashboard` | wagmi → Tangle `submitJob(JOB_PROMPT)` | **Yes** |

### ABI Encoding

The frontend must produce the exact same ABI encoding as the Rust `sol!` types.
Use `viem`'s `encodeAbiParameters` with the struct definitions from the
Solidity contracts:

```typescript
import { encodeAbiParameters, parseAbiParameters } from 'viem'

// Matches TradingProvisionRequest from lib.rs
const encoded = encodeAbiParameters(
  parseAbiParameters([
    'string name',
    'string strategy_type',
    'string strategy_config_json',
    'string risk_params_json',
    'string env_json',
    'address factory_address',
    'address asset_token',
    'address[] signers',
    'uint256 required_signatures',
    'uint256 chain_id',
    'string rpc_url',
    'string trading_loop_cron',
    'uint64 cpu_cores',
    'uint64 memory_mb',
    'uint64 max_lifetime_days',
    'uint64[] validator_service_ids',
  ]),
  [name, strategyType, configJson, riskJson, envJson, ...],
)
```

Generate TypeScript ABI types from the Solidity contracts using `wagmi generate`
to keep them in sync.

---

## Competition System

Competitions are purely a frontend display concept — a way to group bots into
leaderboards with time ranges. No on-chain registration, no prize pools.
If a bot performs well, people deposit into its vault. That's the incentive.

```typescript
interface Competition {
  id: string;
  name: string;                    // "Season 2: DeFi Alpha"
  description: string;
  startTime: number;               // Unix timestamp
  endTime: number;
  startingCapital: string;         // "10000" (display reference)
  allowedStrategyTypes: string[];  // ["dex", "yield"]
  botIds: string[];                // Enrolled bot IDs
  rankingMetric: "return_pct" | "sharpe" | "risk_adjusted";
  status: "upcoming" | "active" | "completed";
}
```

Stored in the frontend's local PostgreSQL. The app periodically polls each
enrolled bot's HTTP API to collect metrics and compute rankings.

---

## Responsive Breakpoints

| Breakpoint | Layout |
|------------|--------|
| `< 640px` (mobile) | Single column, stacked cards, hamburger nav, simplified charts |
| `640–1024px` (tablet) | 2-column grid, collapsible sidebar |
| `> 1024px` (desktop) | Full layout with sidebar nav, multi-column grids |

The leaderboard table collapses to card view on mobile, showing only
rank, name, return %, and account value with expand-for-details.

---

## Accessibility

- WCAG 2.1 AA compliance (8:1 contrast ratio on critical text, per Tangle guidelines)
- All charts have tabular data alternatives
- Keyboard navigation for all interactive elements
- Screen reader labels on data visualizations
- Reduced motion mode disables gradient animations
- Color is never the sole indicator (icons + text accompany red/green)
