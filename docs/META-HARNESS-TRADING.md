# Meta-Harness Trading: Self-Improving Trading Bots

## The Thesis

The trading bot's **harness** — its strategy code, risk parameters, prompt engineering, tool usage patterns, and decision logic — is the single variable that determines PnL. Everything else (vault contracts, validator signing, adapter encoding, execution pipeline) is infrastructure.

Meta-harness applies automated code architecture evolution to the harness. The bot:
1. Trades using its current harness
2. Measures its own PnL, Sharpe, win rate, drawdown
3. Diagnoses what's working and what isn't from trade traces
4. Proposes structural changes to its own strategy
5. Backtests candidates against recent market history
6. Promotes the winner, discards the rest
7. Repeat

The validator system provides the safety net — even a self-improving bot can't execute a trade the validators reject.

## What Is The Harness

For a trading bot, the harness is the code/config that the AI agent in the sidecar uses to make decisions. It includes:

| Component | What It Controls | Example |
|-----------|-----------------|---------|
| **System prompt** | How the agent thinks about markets | "You are a momentum trader focused on 4h timeframes" |
| **Strategy logic** | Entry/exit rules, position sizing | "Enter long when RSI < 30 AND price > 200 EMA" |
| **Risk params** | Max position size, stop loss, drawdown limits | `{"max_position_pct": 10, "stop_loss_pct": 3}` |
| **Tool usage patterns** | Which APIs to call, in what order | "Check funding rates before entering perp positions" |
| **Signal weights** | How to combine multiple indicators | `{"momentum": 0.4, "mean_reversion": 0.3, "sentiment": 0.3}` |
| **Timing logic** | When to trade vs when to wait | "Don't trade in the first 30min after market open" |

The harness is NOT: the vault contracts, the validator scoring, the adapter encoding, the HTTP API. Those are infrastructure — they don't change between strategy variants.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     SIDECAR CONTAINER                           │
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │  AI Agent     │    │  Harness     │    │  Meta-Harness    │  │
│  │  (Claude/GLM) │◄───│  (strategy   │◄───│  Evolution Loop  │  │
│  │               │    │   code)      │    │                  │  │
│  └──────┬───────┘    └──────────────┘    └────────┬─────────┘  │
│         │                                          │            │
│         │ every 5min tick                          │ every 6h   │
│         ▼                                          ▼            │
│  ┌──────────────┐                          ┌──────────────┐    │
│  │ Trade Loop   │                          │ Eval Loop    │    │
│  │              │                          │              │    │
│  │ 1. Get prices│                          │ 1. Pull own  │    │
│  │ 2. Analyze   │                          │    metrics   │    │
│  │ 3. Decide    │                          │ 2. Diagnose  │    │
│  │ 4. Validate  │                          │ 3. Propose   │    │
│  │ 5. Execute   │                          │    variant   │    │
│  └──────┬───────┘                          │ 4. Backtest  │    │
│         │                                  │ 5. Compare   │    │
│         ▼                                  │ 6. Promote   │    │
│  ┌──────────────┐                          │    or discard│    │
│  │ Trading HTTP │                          └──────────────┘    │
│  │ API (9100)   │                                              │
│  └──────────────┘                                              │
└─────────────────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────┐         ┌──────────────────┐
│  Validator Nodes  │         │  On-Chain Vault   │
│  (m-of-n scoring) │         │  (ERC-4626)       │
│                    │         │                   │
│  SAFETY NET:       │         │  Funds stay here  │
│  Every trade still │         │  regardless of    │
│  needs validator   │         │  strategy changes │
│  approval          │         │                   │
└──────────────────┘         └──────────────────┘
```

## The Evolution Loop

The meta-harness loop runs on a slower cadence than trading (every 6 hours, not every 5 minutes). It's a separate workflow tick job.

### Step 1: Evaluate Current Performance

Pull from the bot's own API:
- `GET /metrics/history` → equity curve (last 7 days)
- `GET /trades` → all trades with PnL, validator scores, reasoning
- `GET /portfolio/state` → current positions

Compute:
- Rolling 7d Sharpe, Sortino, max drawdown
- Win rate by trade type (long/short, protocol, time of day)
- Average hold time for winners vs losers
- Cost per trade (gas, slippage)

### Step 2: Diagnose

The AI agent reads the raw trade traces and identifies patterns:
- "Long trades on ETH are profitable (68% win rate) but BTC longs are losing (35%)"
- "Trades entered during high funding rates lose money — the bot is trading against the carry"
- "Stop losses are too tight — 60% of losing trades would have been winners with 2% more room"
- "The bot trades too frequently — 40% of trades are noise, reducing Sharpe"

This is the trace-reading step from meta-harness — not summaries, raw traces.

### Step 3: Propose Harness Variant

The agent writes a concrete change to its own strategy:
- Not parameter tuning ("change stop loss from 3% to 5%")
- Structural mechanism change ("add a funding rate filter that blocks entries when 8h funding > 0.03%")

The variant is a modified version of the strategy config or system prompt, stored as a candidate.

### Step 4: Backtest

The agent backtests the candidate variant against the last 7 days of real market data:
1. Replay the same market conditions (prices, funding rates, order books)
2. Apply the candidate strategy's entry/exit rules
3. Simulate execution (with realistic slippage and gas costs)
4. Compare PnL, Sharpe, drawdown vs the current harness

The backtest uses the SAME data the bot actually traded on — so it can compare "what I did" vs "what I would have done."

### Step 5: Promote or Discard

If the candidate variant shows improvement on the backtest:
- Improvement > 10% on primary metric (Sharpe) AND no regression > 5% on safety metrics (drawdown)
- Promote: update the bot's active strategy config
- Log the change in the evolution history

If not:
- Discard the variant
- Log why it failed
- Use the failure to inform the next hypothesis

### Step 6: Safety Rails

Even after a harness mutation, the safety model is unchanged:
1. Every trade still goes through m-of-n validator scoring
2. PolicyEngine whitelists are not affected by harness changes
3. Circuit breaker (max drawdown) is enforced at the vault level
4. The operator can freeze trading at any time via `JOB_STOP_TRADING`

The meta-harness can change WHAT the bot wants to trade, but never HOW trades are validated or executed.

## User Control Modes

Users choose how much autonomy to give:

| Mode | Description | Meta-Harness |
|------|-------------|--------------|
| **Manual** | User sets all strategy params, bot follows exactly | Off |
| **Assisted** | Bot proposes changes, user approves before deployment | On, human-in-the-loop |
| **Autonomous** | Bot evolves its own strategy within risk bounds | On, fully automatic |
| **Off-the-shelf** | Use a pre-built strategy pack (e.g., "perp momentum") | Off, static config |

The default for new users is **off-the-shelf** — proven strategies that work without customization. Power users can enable meta-harness for autonomous improvement.

## Implementation Plan

### Phase 1: Backtest Engine (required first)

The bot needs to backtest strategy variants against historical data. This requires:
- Historical price data storage (candles, funding rates)
- Trade simulation engine (apply strategy rules to historical data)
- Slippage/gas cost modeling
- PnL computation matching the leaderboard module

This is the eval harness for trading — without it, meta-harness can't judge variants.

### Phase 2: Strategy Representation

Define the harness format — a structured config that the AI agent reads and can modify:

```json
{
  "version": 2,
  "entry_rules": [
    {"signal": "rsi_14", "condition": "below", "threshold": 30, "weight": 0.4},
    {"signal": "ema_cross", "condition": "golden", "lookback": "4h", "weight": 0.3},
    {"signal": "funding_rate", "condition": "negative", "weight": 0.3}
  ],
  "exit_rules": [
    {"type": "stop_loss", "pct": 3.0},
    {"type": "take_profit", "pct": 8.0},
    {"type": "trailing_stop", "activation_pct": 5.0, "trail_pct": 2.0}
  ],
  "filters": [
    {"type": "volatility_gate", "min_atr_pct": 0.5, "max_atr_pct": 5.0},
    {"type": "time_filter", "skip_hours": [0, 1, 2, 3]}
  ],
  "position_sizing": {
    "method": "kelly_fraction",
    "max_position_pct": 10,
    "kelly_multiplier": 0.25
  }
}
```

The agent can propose changes to this config (or generate entirely new ones) — each is a harness variant.

### Phase 3: Evolution Loop Integration

Wire the evolution loop into the workflow tick system:
- New job type: `JOB_EVOLVE_STRATEGY` (runs every 6 hours)
- Reads metrics via Trading HTTP API
- Reads trade traces for diagnosis
- Proposes variant → backtests → promotes or discards
- Logs evolution history to `.evolve/meta-harness/evolution.jsonl` inside the sidecar

### Phase 4: Cross-Strategy Learning (future)

When multiple bots run with meta-harness enabled, the operator can aggregate evolution histories across bots. Patterns that work for multiple bots in the same market conditions are promoted to strategy packs that new users can deploy off-the-shelf.

This is the flywheel: autonomous bots → evolution histories → proven strategies → new users → more bots → more evolution data.

## Metrics That Matter

The meta-harness optimizes for a composite objective, not a single number:

| Metric | Weight | Why |
|--------|--------|-----|
| Sharpe ratio (7d rolling) | 40% | Risk-adjusted return — the primary measure of strategy quality |
| Win rate | 20% | Consistency — high Sharpe with 30% win rate is fragile |
| Max drawdown (7d) | 20% | Safety — a strategy that draws down 50% is unusable |
| Trade efficiency (PnL/gas) | 10% | Cost — a strategy that generates $1 profit on $0.50 gas is wasteful |
| Trade frequency | 10% | Noise — over-trading destroys Sharpe via costs and slippage |

The meta-harness tracks a Pareto frontier across these dimensions. A variant that improves Sharpe but doubles drawdown is NOT promoted.

## What This Is NOT

- **Not a backtesting platform** — the backtest engine is internal to each bot, not user-facing
- **Not a strategy marketplace** — users don't buy/sell strategies (yet)
- **Not parameter optimization** — meta-harness changes mechanisms, not numbers
- **Not model fine-tuning** — we're evolving the harness (code/config), not the AI model
