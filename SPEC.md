# SPEC: Tangle AI Trading — Jane-Street-Tier Trading Team Per Bot

> Status: living document. Updated as work lands. Last-updated stamp at the bottom of each section is the source of truth for what's real vs aspirational.

---

## 1 · Vision

**One adaptive AI agent per user-bot. Each agent operates like a complete Jane-Street-quality trading team in a single capability.**

The user is the client. They type intent in chat — "trade NVDA earnings calendar," "market-make HYPE perp," "yield-farm stables on Base" — and the bot's team does *everything else*:

| Role inside the bot | What it does |
|---|---|
| **Research analyst** | News, on-chain, narrative, prediction-market odds, macro calendar, sector reports |
| **Quant** | Backtest, walk-forward validation, regime detection, volatility modelling, position sizing |
| **Strategist** | Synthesise research + quant into a defensible trade thesis with explicit risk/reward |
| **Trader / execution** | Order timing, sizing, slippage management, venue routing, re-trade discipline |
| **Risk officer** | DD cap enforcement, VaR, stress tests, concentration limits, capacity analysis |
| **Client liaison** | S-tier weekly reports, charts, plain-English explanations, honest about uncertainty |

The user never picks a venue. Never writes a HarnessConfig. Never runs a backtest themselves. They describe what they're thinking; the team handles it end-to-end and reports back at institutional quality.

### Non-goals

- ❌ Building a quant front-end (the user UX is chat — period)
- ❌ Building our own LLM (Claude / GPT / Gemini are the substrate)
- ❌ Building our own exchange (we integrate)
- ❌ Solving custody (the trading-http-api holds operator keys; user never sees them)
- ❌ Building 100 venue adapters before any one is excellent

---

## 2 · Personas & use cases

### Drew (operator / GP)
- Has $X capital, no specific strategy preference
- Wants a portfolio of bots running across different intents
- Reads weekly reports and decides promote / iterate / kill per bot
- Doesn't write code, doesn't run backtests, doesn't pick venues
- **Success criterion**: looks at a per-bot report and trusts it enough to act on it

### Per-bot trading team (the LLM stack)
- Receives an intent from a user (one freeform message)
- Decides venue(s), instruments, strategy form, capital allocation
- Researches, backtests, deploys, monitors, reflects, revises
- Writes daily / weekly / monthly reports
- Lives in a sandboxed sidecar with bash + curl + trading-http-api + MCP delegation loops
- **Success criterion**: produces an S-tier weekly report (§4) with composite ≥ 8.0

### Bot fleet (10 → 100 → 10,000)
- Each bot is independent; no cross-bot state by default
- An operator may run N bots simultaneously across chains
- Per-operator dashboard ranks bots, surfaces promotion candidates
- **Success criterion**: fleet of 50 bots running on real testnets across HL, Base, Drift, Polymarket — each with own weekly report

---

## 3 · Acceptance criteria — when is this shipped

The product is shipped when the following are all true:

1. **5+ bots** running 24/7 on real chain testnets (Arbitrum Sepolia for HL, Base Sepolia for AMM/lending), each with a distinct user intent
2. **7-eval suite** (§5) running on every bot weekly, producing the S-tier report (§4) with composite ≥ 8.0
3. **Fleet view** ranks all bots and surfaces promote / iterate / kill recommendations
4. **Cost** within budget: <$2/bot/day in LLM costs, <$0.50 per insight, <6% cost-to-return ratio
5. **At least one bot promoted to mainnet** with real capital, observed for 4+ weeks with positive expectancy
6. **Operator can spin up a new bot** by typing one intent and receiving an S-tier weekly report 7 days later without further intervention

Each of these maps to a measurable, dated artifact stored under `.evolve/spec-acceptance/`.

---

## 4 · Per-bot weekly S-tier report — the deliverable

This is what the bot fleet *delivers* to the operator. Every bot, every week, produces one of these. It is the product surface.

### Mandatory sections

| Section | Content | Pass bar |
|---|---|---|
| **Exec summary** | 2-3 sentences a busy founder reads. What did the bot do, what's its current view, what should you do about it | Plain English, concrete, no hedging filler |
| **Performance table** | Period return, Sharpe, Sortino, Calmar, Max DD, win rate, profit factor, cost/return — all with **95% CI from N≥5 reps** | Every metric has an interval. No bare-mean claims |
| **Charts (embedded SVG)** | Equity curve · drawdown · trade scatter on price · cost decomp · decision latency hist · revision lineage | Rendered via Vega-Lite, no fake bars, no smoothed-without-disclosure |
| **Strategy decomp** | Which entry rules fired, which made money, which lost. Sizing rationale. Holding distribution | Per-rule PnL with stat-sig markers |
| **Research trace** | Sources cited, recency, narrative coverage. **Score: depth_score / 10** | ≥5 sources/thesis, recency <24h, multi-asset class |
| **Risk decomp** | VaR 95th / 99th, stress test scenarios, concentration HHI, capacity analysis | Stress includes the worst observed move on the underlying ±50% |
| **Conversation evals** | From multishot user-sim: intent_fulfilled, respected_constraints, actually_traded, productive_conversation. N≥5 reps with CI | Composite > null-bot baseline by ≥0.4 |
| **Adversarial robustness** | Contradictions / mid-session crashes / ambiguous intents / DD-cap pressure tests | ≥80% graceful handling |
| **Revision lineage** | Every strategy revision, why it happened, did it improve Sharpe / DD / cost | Lineage links each revision to a forward-looking PnL delta |
| **Comparison to baselines** | This bot vs null-bot, stall-bot, frontier-bot | Frontier-bot anchors the S-tier ceiling |
| **What we'd ship at 9.0+** | The gap list. Concrete, prioritised, owner-assigned | Each item maps to an existing or new task |

Anything less is **not** S-tier and we don't deliver it to the operator.

---

## 5 · The 7-eval surface

Each eval contributes a slice of the weekly report. Each has explicit acceptance criteria.

### Eval #1 — Multishot user-sim E2E
- **Tests**: conversational competence. Does the team understand what the user asked for? Act decisively? Push back when the user is wrong?
- **Mechanism**: `runEval` (agent-eval/campaign) over K user intents; each cell provisions a fresh bot via the real product API, opens a chat session, runs a Claude-driven user-sim turn loop against it. Real bot tool surface. No frozen arm, no scripted prompts.
- **Reps**: 5 default; report with bootstrap 95% CI
- **Acceptance**:
  - Composite > 0.6
  - intent_fulfilled > 0.7
  - respected_constraints > 0.85
  - vs null-bot baseline: +0.4 absolute (so judge isn't broken)
- **Status**: code shipped (PR #123), pending end-to-end real-stack run

### Eval #2 — Agent-in-loop walk-forward
- **Tests**: strategy quality over simulated time. Does the bot's self-improvement loop *actually* improve PnL on real historical data?
- **Mechanism**: K Claude-generated `HarnessConfig` candidates per intent, walked forward D days. Two arms: FROZEN vs AGENT-IN-LOOP. Agent revises at weekly boundaries via Claude reflection on its own trace.
- **Reps**: 3 per candidate, 24+ days per walk-forward
- **Acceptance**:
  - Mean Δ(agent − frozen) ≥ 0% with positive 95% CI lower bound (the loop doesn't actively hurt)
  - Revision quality: ≥60% of revisions improve forward 7d Sharpe
- **Status**: code shipped (PR #123), partial 24-day sweep (3/4 intents) — surfaces a real bug (Claude generated invalid filter type — schema-guard needed)

### Eval #3 — Research depth
- **Tests**: can the bot actually research, or does it just chat?
- **Mechanism**: ask the bot N thesis questions across asset classes (crypto, macro, on-chain, prediction markets). Score the research artifact it produces against a depth rubric.
- **Rubric dimensions**: source count, source diversity, recency, cross-checking, narrative coherence, citation accuracy
- **Reps**: 3 per question
- **Acceptance**: depth ≥ 5/10 average across questions; ≥80% citations resolve to a real source URL
- **Status**: NOT BUILT

### Eval #4 — Report quality
- **Tests**: can the bot write the S-tier weekly report (§4)?
- **Mechanism**: at end of multishot eval, ask the bot for its weekly report. Score it against the §4 rubric (sections present, charts rendered, stats accurate, honest uncertainty, actionable forward outlook).
- **Acceptance**: composite ≥ 7.5/10; frontier-bot comparison >0
- **Status**: NOT BUILT

### Eval #5 — Adversarial robustness
- **Tests**: how the team handles contradictions, ambiguity, mid-session market shocks, conflicting signals, user pushing to violate constraints
- **Mechanism**: scripted adversarial scenarios injected into the user-sim turn stream. Score graceful handling + appropriate refusals.
- **Adversarial scenarios** (each runs as its own sub-eval):
  - Contradictory user instructions ("buy" then "no, sell")
  - Mid-session crash injection (simulate -20% in 4h on the underlying)
  - Ambiguous intent ("do something interesting")
  - Research vs quant conflict (research says bullish, backtest says bearish)
  - User pushing to violate DD cap
  - Oversized intent (capital > venue capacity)
- **Acceptance**: ≥80% scenarios handled gracefully
- **Status**: NOT BUILT

### Eval #6 — Cost & efficiency
- **Tests**: is the bot economically viable at fleet scale?
- **Mechanism**: capture LLM tokens, $ cost, wall-clock, tool call count per shot across all the above evals.
- **Acceptance**: $/insight < $0.50; LLM cost < $2/bot/day; median decision latency < 5s
- **Status**: NOT BUILT (token usage emitted per cell but not aggregated)

### Eval #7 — Fleet consistency
- **Tests**: same intent on different days produces consistent quality, or does the team drift?
- **Mechanism**: re-run multishot user-sim with the same intents on N consecutive days. Compute drift in composite + judge agreement.
- **Acceptance**: |day-N − day-1| < 0.15 composite across 80% of intents
- **Status**: NOT BUILT

---

## 6 · Real-bot provisioning roadmap

The eval suite is meaningful only against real bots. We provision in tiers:

### Tier 0 — Local devnet (now)
- Anvil + sidecar containers via `scripts/run-devnet.sh`
- Used for eval CI + interactive iteration
- **Status**: working; ports 9101/9201 already configured

### Tier 1 — Public testnets
- Hyperliquid testnet (Arbitrum Sepolia) — perp + spot
- Base Sepolia — Aerodrome AMM, Aave lending
- Drift devnet — Solana perp
- Polymarket — already public CLOB, no testnet equivalent (uses tiny test markets)
- **Status**: infrastructure ready, no bots provisioned yet

### Tier 2 — Mainnet canary
- Single bot per chain with small ($1k-$5k) capital
- 4-week observation window
- Promoted only after 2+ weeks of Tier-1 with composite ≥ 8.0
- **Status**: not started; gated on Tier 1 results

### Bot templates we ship at Tier 1

| Template | Venues | Strategy form | Acceptance |
|---|---|---|---|
| **Momentum perp** | HL perp, Drift perp | HarnessConfig (existing) | Sharpe > 1.2 over 4 weeks |
| **Mean-reversion perp** | HL perp | HarnessConfig | Sharpe > 1.0 over 4 weeks |
| **Market maker** | HL perp, Polymarket CLOB | Custom strategy code (in-sandbox TS) | Quote uptime >95%, captures >0.6 of spread |
| **Multi-strategy** | All | N parallel HarnessConfigs, capital allocated by rolling Sharpe | Outperforms best single-strat by ≥10% |
| **AMM rebalancer** | Aerodrome (Base) | Custom strategy code | Tracks target weight ±2% |
| **Yield farmer** | Aave (Base) | Custom strategy code | Beats stable-deposit baseline by ≥1% APR |
| **Prediction market** | Polymarket | Custom strategy code | Selection edge > vig in cited markets |

---

## 7 · Implementation roadmap

PRs ordered by leverage. Each lands a measurable piece toward §3 acceptance.

| PR | Title | Status | Lands |
|---|---|---|---|
| #120 | Migrate persona suite to TS, delete Rust eval module | OPEN | Eval substrate parity |
| #122 | Tiny bot-state reader for outcome scoring | OPEN | Eval-side read helpers |
| #123 | Agent-in-loop walk-forward + multishot user-sim E2E | OPEN | Evals #1 + #2 code + first artifacts |
| **Next 1** | This SPEC.md | IN PROGRESS | The North Star |
| **Next 2** | Report renderer + Vega-Lite charts (Task #97) | NOT STARTED | §4 deliverable form lands; downstream evals plug into it |
| **Next 3** | `reps=5` + adversarial baseline bots + cross-family judge (Task #98) | NOT STARTED | Eval #1 stats become honest |
| **Next 4** | Research-depth eval (Task #99) | NOT STARTED | Eval #3 |
| **Next 5** | Robustness/adversarial eval (Task #100) | NOT STARTED | Eval #5 |
| **Next 6** | Fleet-view aggregator (Task #101) | NOT STARTED | Operator dashboard |
| **Next 7** | Testnet bot provisioning HL + Base (Task #102) | NOT STARTED | Tier 1 |
| **Next 8** | MM + multi-strategy bot templates (Task #103) | NOT STARTED | Strategy diversity at Tier 1 |
| **Future** | Mainnet canary (Tier 2) | NOT STARTED | Gated on Tier 1 |

---

## 8 · Architecture (data flow)

```
┌─────────────────────────────────────────────────────────────┐
│ Operator (Drew)                                              │
│ "Trade HYPE perp, $10k, momentum, max 5% DD"                │
└────────────────────────────┬────────────────────────────────┘
                             ▼
            ┌────────────────────────────────┐
            │ Operator API (existing)         │
            │   POST /api/bots                │
            └────────────────────────────────┘
                             ▼
   ┌─────────────────────────────────────────────────────────┐
   │ Per-bot sandbox (Docker sidecar)                         │
   │                                                          │
   │   ┌──────────────────────────────────────────────┐     │
   │   │ Per-bot agent (Claude/Sonnet)                 │     │
   │   │   Tools:                                       │     │
   │   │     bash, curl, file IO                        │     │
   │   │     trading-http-api  ─→ /execute, /trades    │     │
   │   │                          /portfolio/state     │     │
   │   │                          /strategy/config     │     │
   │   │     MCP delegations:                          │     │
   │   │       runKnowledgeResearchLoop  (research)    │     │
   │   │       multiHarnessCoderFanout   (code)        │     │
   │   │       runAnalystLoop            (reflection)  │     │
   │   │     Daily / weekly reflection cron            │     │
   │   └──────────────────────────────────────────────┘     │
   │                                                          │
   │   ┌──────────────────────────────────────────────┐     │
   │   │ Trace store (/home/agent/.evolve/)           │     │
   │   │   findings, runs, traces, knowledge          │     │
   │   └──────────────────────────────────────────────┘     │
   └─────────────────────────────────────────────────────────┘
                             ▼
   ┌─────────────────────────────────────────────────────────┐
   │ Eval substrate (evals/src/)                              │
   │   runEval → 7 evals → judges → per-bot artifacts        │
   │   Report renderer → S-tier weekly report (§4)           │
   │   Fleet aggregator → operator dashboard                  │
   └─────────────────────────────────────────────────────────┘
                             ▼
            ┌────────────────────────────────┐
            │ Weekly report delivered to op   │
            │ Operator: promote/iterate/kill  │
            └────────────────────────────────┘
```

---

## 9 · Open questions (to resolve as we build)

| # | Question | Owner | Resolve by |
|---|---|---|---|
| Q1 | Which model for cross-family judge — GPT-5 or Gemini 2.5? | Drew | before PR Next-3 |
| Q2 | Capital source for Tier 2 mainnet canary — operator wallet, test fund, or Tangle treasury? | Drew | before Tier 2 |
| Q3 | Compliance / KYC story for mainnet trading bots? | Drew | before Tier 2 |
| Q4 | Capacity per strategy — at what AUM does each bot template degrade? | Quant team (bot itself, via eval) | continuous |
| Q5 | Cross-bot communication — should bots share research, or stay independent for diversification? | Drew | as fleet grows |
| Q6 | Weekly report delivery channel — email, Slack, in-product UI? | Drew | before Tier 1 |
| Q7 | Real-venue data subscription costs — who pays for premium feeds (Bloomberg, Kaiko)? | Drew | as bots scale |

---

## 10 · How to read this doc

- **Section 1-3** is the *what* — vision, personas, acceptance criteria. Don't change without explicit alignment.
- **Section 4-6** is the *deliverable shape* and the *evaluation rigour*. Refined as we learn; each refinement increases the S-tier bar.
- **Section 7** is the *plan* — tasks #96-#103 mirror this. Update status as PRs land. Add new rows when new tasks emerge.
- **Section 9** is *what we don't know* — every open question blocks something downstream.

When a PR lands, update the status column in §7 and (if the PR closed an acceptance gap) update §3. The doc is the source of truth for "are we shipped yet."
