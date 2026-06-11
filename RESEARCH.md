# RESEARCH.md — The 10-Year Architecture for Superintelligent Trading Agents

Status: living research north star (2026-06-11). Owner: Drew. This is the
leapfrog plan beyond the current roadmap — what we would build with a decade,
sequenced so every rung pays for itself. Companion docs: ARCHITECTURE.md
(current system), PRODUCT_BRIEF.md (current product).

## Core thesis

Market intelligence is three terms multiplied:

```
edge = hypothesis-space expressiveness × honest-feedback speed × selection pressure
```

Every investment below widens one of those terms. A "superintelligent" trading
system is not one breakthrough model — it is **a machine that does science on
markets faster than anyone else**, with capital allocation as the selection
mechanism and falsification as the discipline.

Our unfair advantages, already in the stack:

1. **A fleet** — N bots are N parallel experiments. Competitors with one bot
   learn at 1×; the fleet learns at N× and never forgets.
2. **An evidence substrate** — traces, evals, falsifiable analyst findings,
   walk-forward + paper-trial promotion gates (live as of 2026-06-11).
3. **Crypto transparency** — the only market where the full causal graph of
   money movement (flows, positions, code) is public.
4. **A permissionless capital layer** — Tangle operators, TEE attestation,
   on-chain provenance.

Most quant shops have one of these. Nobody has all four.

## The ladder — eight leapfrogs, each standing on the last

### 1. Strategy-as-program: from tuning knobs to writing code (Year 1)

Today the self-improvement loop mutates harness parameters — a hypothesis
space of ~20 dimensions. The leap is **evolutionary program synthesis**: the
agent writes executable strategy programs; selection (backtest → adversarial
sim → paper → capital) decides what survives.

- Recipe: FunSearch/AlphaEvolve applied to trading — LLM as the mutation
  operator over *code*, deterministic gates as the fitness function.
- Substrate that already exists: `tick_recipe_dsl`, the MCP code-delegation
  skeleton, the promotion conductor.
- Methods to run in parallel:
  - Genetic programming with LLM-proposed mutations.
  - **MAP-Elites** for diversity — niches = market regime × venue, so we keep
    a *portfolio of elites* instead of one overfit champion.
  - Island populations per venue with periodic migration.

### 2. Fleet epistemology: the bots share a brain (Year 1–2)

Every bot trajectory is a sample in one ongoing fleet-wide experiment.

- **Knowledge ledger**: every hypothesis any bot tested, with pre-registered
  predictions, outcomes, and evidence weights. Compounding, queryable, and
  *subtractive* — knowing what is false is half of alpha.
- New bots boot with the fleet's accumulated priors instead of from zero.
- Credit assignment via an **internal capital market**: paper capital flows
  toward strategies with out-of-sample evidence (generalize the UCB1 bandit
  store into the allocator).
- Substrate: `agent-knowledge`, the trace analysts (mandate-alignment,
  loss-attribution, falsification, opportunity-cost), findings stores.

### 3. World models instead of backtests (Year 2–3)

Backtests have a fatal flaw: one realized history, no market impact, no
counterfactuals. The leap:

- **Generative market simulators** — agent-based limit-order-book sims
  populated with adversarial trader agents; sequence models trained on order
  flow that generate statistically faithful synthetic histories conditioned
  on regime.
- **Adversarial co-evolution** — a red-team population whose fitness is
  *breaking our strategies* (finding the market path that ruins them). A
  strategy promotes only if it survives the ensemble of plausible worlds AND
  the adversary.
- This structurally kills overfitting — the disease that produced 2,376
  blocked candidates on the live fleet — instead of patching it with gates.

### 4. A market foundation model — on-chain data is the home-turf moat (Year 3–5)

Stop conditioning strategies on RSI. Pretrain a self-supervised model on the
unified event stream nobody else assembles properly:

- DEX swaps, mempool flow, liquidations, funding rates, bridge flows,
  stablecoin mints/burns, whale entity graphs, MEV extraction, governance
  events, CEX microstructure.
- Output: a **market state embedding** every strategy in the fleet conditions
  on — a shared perception layer.
- Buy vs build: rent frontier LLMs for *reasoning*; **build** the market
  perception model — proprietary data beats scale there.
- Crypto is the only market where this causal graph is public. Build it before
  someone else does.

### 5. RL where RL actually works (Year 3–5)

Honest take: end-to-end deep RL for strategy discovery mostly fails
(non-stationary, adversarial, sparse reward). It wins decisively in two
bounded layers with dense, honest feedback:

- **Execution**: order placement, routing, slippage. The slippage learner is
  the embryo; reward = realized vs arrival price.
- **Allocation**: constrained RL over fleet capital with CVaR/drawdown
  constraints. The mandate-enforcement chain (proven live 2026-06-11) becomes
  the constraint layer of a constrained MDP.

Strategy discovery stays evolutionary/LLM-driven; RL handles the dense-reward
layers.

### 6. The falsification engine — institutional statistics, automated (continuous)

What makes Jane Street-grade reviewers respect the system:

- Pre-registered predictions before capital.
- Holdout discipline; **deflated Sharpe ratios**; multiple-testing correction
  (the fleet generates thousands of candidates — White's reality check or
  equivalent); capacity estimates per strategy.
- Automatic demotion when live performance diverges from sim beyond tolerance.
- End state: every promoted strategy carries a p-value-honest evidence dossier
  no human fund could produce at this scale.
- Rung one shipped: the falsification analyst emits `falsifiable_prediction`
  on every finding.

### 7. Verifiable track records as the business model (Year 2+, the company-maker)

The architecture becomes a company, not a hedge fund:

- Every decision, trade, and evidence record attested (TEE operators exist in
  the blueprint stack; hashes anchored on Tangle).
- Result: **performance records that cannot be faked** — the thing asset
  management runs on trust and auditors for, we get cryptographically.
- That turns the platform into a permissionless strategy marketplace:
  creators launch bots, capital allocates to verifiable evidence, performance
  fees flow, the protocol takes its cut.
- The flywheel: more capital → more bots → more experiments → smarter fleet →
  better verified returns → more capital. The fleet's collective intelligence
  is the product; the marketplace is distribution; attestation is trust.
- Monetizes from Year 2 — long before "superintelligence."

### 8. The self-amending research organization (Year 5–10)

The terminal form: the loop improves the loop.

- Agents in differentiated roles — researcher, adversarial critic, risk
  officer, allocator, **meta-scientist**.
- Every component of the system (reflection prompts, mutation operators,
  gates, simulators, the analysts themselves) is itself a candidate behind
  evidence gates. A practical Gödel machine: nothing changes without
  out-of-sample proof, including the prover.
- Cohort A/Bs of *learning-loop variants* across fleet segments; the better
  epistemology wins capital.
- At this point the durable asset is not any strategy (all alpha decays) —
  it is the **rate of discovery**.

## Alternatives consciously bet against

| Alternative | Verdict |
|---|---|
| End-to-end deep RL discovers strategies | Against as the core — non-stationarity + sparse reward; RL only at execution/allocation (rung 5) |
| One giant model trades everything | Against — monoculture = correlated blowup; portfolio-of-elites is safer and learns faster |
| Centralized prop fund instead of marketplace | Viable but caps at our own capital; marketplace + attestation is the venture-scale path |
| Pure prompt-engineering on frontier LLMs | Decays into commodity overnight; moats are data (4), evidence ledger (2,6), verification (7) |
| HFT / latency competition | Don't — capital-intensive arms race vs entrenched players; our edge is *adaptation speed*, not wire speed |

## The honesty clause

Markets are adversarial and reflexive — every alpha decays as it is
exploited, including ours. This plan does not promise a perpetual money
machine; it promises **the fastest discovery–decay–rediscovery cycle in
existence**, with risk enforcement that actually fires (proven live:
flagship `drawdown-derisk-exit`, 2026-06-11 20:15 UTC). Crypto
microstructure is the right beachhead — inefficient, transparent, 24/7,
composable — and capacity grows with the market. Every rung is sequenced to
pay for itself: program synthesis improves paper fleets in months; the
marketplace monetizes verification in Year 2; the foundation model is funded
by fees, not faith.

## The 90-day bridge from today's repo

1. **Candidates as code**: wire the MCP delegation path so self-improvement
   candidates can be programs, not just parameters — the DSL and the
   promotion gates already exist.
2. **Hypothesis registry**: pre-registered predictions on the
   `agent-knowledge` substrate — the falsification analyst already emits
   `falsifiable_prediction`; give it a ledger and a settlement job.
3. **Internal capital market v0**: cohort the fleet into an explicit
   population with a paper-capital allocator — the UCB1 bandit store exists;
   promote it from per-bot variant selection to fleet-level allocation.

Three moves, all on shipped substrate, and rungs 1, 2, and 6 are alive.
