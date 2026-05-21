# Trading Agent Evals

This repo has four eval layers:

- `scripts/e2e-eval.sh` exercises the customer journey against a running
  operator/trading API.
- `npm run eval:self-improvement-mcp` exercises the sandbox
  self-improvement MCP with real git worktrees and command execution.
- `scripts/eval-polymarket-real-price-history.sh` fetches live Polymarket
  Gamma/CLOB price history and runs the real Rust walk-forward backtester.
- `scripts/eval-trading-personas.sh` runs the trading-domain persona suite
  added for market makers, portfolio managers, protocol researchers, and
  arbitrage agents.
- `npm run eval:agent-strategy` drives the sandbox coding agent through the
  self-improvement MCP/opencode path and validates a bounded strategy artifact.
- `npm run eval:full` composes the release gate across TS, Rust, persona,
  lifecycle, MCP, and agent-driven strategy evals.

## Trading Persona Suite

The suite lives in `trading-runtime::evals::agent_personas` and wraps the real
`BacktestEngine::walk_forward_compare` path. It is deterministic: no LLM judge
can override failed objective gates.

Current personas:

- `hyperliquid_perp_market_maker`
- `prediction_market_maker`
- `uniswap_lp_market_maker`
- `evm_portfolio_manager_base`
- `risk_on_arbitrage_bot`
- `protocol_researcher`
- `second_order_game_theory_bot`
- `third_order_adaptive_game_theory_bot`

Each scenario defines:

- persona mandate: venues, chains, execution mode, position limit, drawdown
  limit, expected trade-count range
- baseline strategy config
- specialist candidate strategy config
- adversarial market regime candles/funding snapshots
- deterministic score gates and agent-eval-style findings

The second-order game-theory scenarios currently cover:

- crowded breakout flow: simple bots chase visible highs; the candidate must
  learn from the flow without oversized crowd exposure
- stop-cascade flow: levered bots trigger forced selling; the candidate must
  join confirmed flow briefly and avoid late reversal exposure
- AMM rebalancer flow: inventory-management bots create predictable
  oscillations after shocks; the candidate must avoid toxic first prints

The third-order adaptive scenarios currently cover:

- crowded alpha decay: a profitable bot pattern becomes crowded; the candidate
  is scored against a naive, high-cost baseline that keeps paying for stale edge
- counterparty rotation: the dominant counterparty population changes from
  momentum bots to rebalancer bots; the candidate is scored on held-out survival
  rather than training-window fit

These are deterministic proxies. The stronger eval is an agent-loop task where
the sandboxed trading agent observes train-window microstructure, writes a new
`HarnessConfig`, and is scored on the held-out regime through the same
backtester.

Scoring is 90 points today because the subjective reasoning judge is not wired
yet:

- 25 risk: position size and drawdown
- 20 execution: trade-count bounds and real walk-forward backtest execution
- 20 economics: candidate beats baseline out-of-sample
- 15 adaptation: walk-forward/generalization behavior
- 10 ops: candidate config validates

The missing 10-point reasoning bucket should be added only when it judges real
agent traces: market thesis, uncertainty handling, and whether the proposed
change is small/testable. It must not judge PnL, drawdown, signatures, NAV, or
trade validity.

## Run

```bash
./scripts/eval-trading-personas.sh
```

By default this writes:

```txt
.evolve/evals/trading-agent-personas-<timestamp>.json
```

To also emit `@tangle-network/agent-eval` RunRecords and traces:

```bash
npm run eval:trading-personas
```

That writes:

```txt
.evolve/evals/trading-agent-personas-<timestamp>.json
.evolve/agent-eval/trading-persona-runs.jsonl
.evolve/agent-eval/traces/trading-personas/
```

The bridge imports `@tangle-network/agent-eval` when available in the current
Node environment. For local development without installing repo-level Node
deps, point it at a checkout build:

```bash
AGENT_EVAL_IMPORT=/Users/drew/webb/agent-eval/dist/index.js \
  npm run eval:trading-personas
```

For CI or local debugging:

```bash
cargo test -p trading-runtime persona_eval_suite_has_required_coverage_and_passes
cargo run -p trading-runtime --example agent_persona_eval -- --out /tmp/trading-agent-personas.json
```

## Live Polymarket Price-History Eval

The fastest real-data path is:

```bash
./scripts/eval-polymarket-real-price-history.sh
```

This pulls an active market from `gamma-api.polymarket.com`, fetches YES-token
history from `clob.polymarket.com/prices-history`, converts each point into a
single-price candle, and runs `BacktestEngine::walk_forward_compare`. It is a
real data eval, but not a full fill-simulation eval: it validates market-data
ingestion, train/test split behavior, and promotion discipline against live
Polymarket prices. Full execution realism needs trade-print or L2 book fixtures.

Useful overrides:

```bash
POLYMARKET_CLOB_TOKEN_ID=<token-id> \
POLYMARKET_PRICE_INTERVAL=1m \
POLYMARKET_PRICE_FIDELITY=60 \
  ./scripts/eval-polymarket-real-price-history.sh
```

Current higher-fidelity data options:

- `SII-WANGZJ/Polymarket_data`: MIT, Hugging Face parquet dataset with
  `orderfilled.parquet`, `trades.parquet`, `markets.parquet`, `quant.parquet`,
  and `users.parquet`. Best next fit for this repo because `quant.parquet`
  maps cleanly into OHLCV candles grouped by `market_id`.
- `evan-kolberg/prediction-market-backtesting`: strong reference for PMXT and
  Telonex L2 order-book replay, but active code is mixed MIT/LGPL and depends
  on NautilusTrader. Treat it as a reference or optional external oracle, not
  something to vendor into `trading-runtime`.

## Agent-Eval Boundary

This suite emits JSON with stable scenario ids, persona ids, deterministic
gates, metrics, and findings. `evals/src/trading/persona-agent-eval.ts` converts
that report into `@tangle-network/agent-eval` RunRecords and TraceStore rows.

Keep this split:

- product repo: scenarios, market data adapters, backtest/paper/live drivers,
  deterministic validators
- `agent-eval`: trace storage, replay records, analyst loops, judge
  orchestration, release confidence, optimization primitives

Next integration step: wrap actual agent runs so each persona scenario can ask
the sandboxed trading agent to produce a candidate `HarnessConfig`, then score
that candidate through this same suite.

## Simulated User Lifecycle Eval

The lifecycle eval is a typed TypeScript wrapper around the deterministic
persona suite. It simulates multi-turn user feedback such as "make the strategy
more risk-off", "review microstructure", and "find adjacent pairs", then links
each revision to concrete backtest scenarios and emits durable feedback
trajectory JSONL records.

```bash
npm run eval:trading-lifecycle
```

The TypeScript eval package is under `evals/src`. Keep eval entrypoints there
and expose repo-level commands through `package.json`; shell scripts in
`scripts/` are compatibility wrappers only.

## Full Gate

Run the professional local gate with:

```bash
npm run eval:full
```

This runs deterministic build/test gates, emits `agent-eval` records where
available, launches the real self-improvement MCP with `opencode`, and requires
the coding agent to produce a bounded Polymarket paper-strategy artifact that
passes deterministic validation. To include live Polymarket Gamma/CLOB price
history in the same gate:

```bash
npm run eval:full -- --live-polymarket
```
