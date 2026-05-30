# Typed Strategy Recipe Roadmap

Status: proposal / tracking. Owner: trading-blueprint. Last updated: 2026-05-30.

## Thesis

Today the trading agent acts **imperatively**: the LLM (opencode) writes JS, calls
`/validate` + `/execute`, and reasons in prose. That is fragile — it produced
silent tick skips, hallucinated reasoning, and non-reproducible decisions, and it
is hard to verify before money moves.

A more robust model, proven in mature quant-research tooling, is to make the LLM a
**recipe author, not an executor**: it emits a *typed, deterministic, content-addressed*
operator DAG ("recipe") that a fast engine executes and that can be statically
checked (lookahead, universe, coverage, dtype) *before* any trade. The model
proposes a plan; a deterministic engine runs it; a validator can verify it.

This doc captures the candidate ideas, a judging rubric, and an adoption ranking.
It is the tracking artifact for the work; specific items become tasks/PRs.

## Design principle: this lifts agency, it does not cage it

The point is NOT to make the agent less agentic. It is to separate two kinds of
agency and treat them differently:

- **Agency over cognition** — what to research, what to hypothesize, reading data,
  deciding *what* to compute, designing/extending strategies, interpreting results,
  talking to the principal. **Keep this maximal; expand it.**
- **Agency over mechanism** — *how* the committed, money-moving decision is expressed
  (hand-written imperative JS vs. a typed plan). Reducing free-wheeling here is a
  **gain**: raw mechanism is exactly where the agent currently hallucinates, skips
  silently, and fails to reproduce. That "freedom" is where failures live, not value.

Today the agent is maximally free (writes arbitrary JS) but **cannot reliably
exercise that freedom**. This work improves its ability to do reliably what it
already attempts unreliably, and hands it powers it never had (reproducibility,
attestation, principled self-tuning, transparency).

Guards (G2/G6) only stop **wrong or fake** actions — lookahead is not a real live
capability; trading an unlisted asset is a bug. Removing footguns ≠ reducing useful
agency. F2/F3 are pure observability (zero constraint).

The one real "caging" risk is the typed DSL (F1/M1). It stays tide-lifting only if
designed against these four rules — **violating them is the regression signal to stop:**

1. **Composable + extensible vocabulary** — the agent builds new sub-pipelines from
   primitives (`call_sub_pipeline`) and can propose new operators. The vocabulary
   *grows*; it is not a fixed dropdown.
2. **Escape hatch, not a wall** — dangerous ops are *gated behind an explicit
   acknowledgement*, never forbidden outright. The agent can still do the unusual
   thing; it just has to declare it.
3. **Free-form cognition stays free** — research, hypotheses, regime reasoning, and
   principal conversation remain open-ended. Only the *committed executable decision*
   must be typed.
4. **Determinism is a domain requirement, not distrust** — a human quant PM also
   expresses their edge as code a deterministic backtest runs; that is what makes the
   edge auditable and (for us) on-chain attestable.

## Why this is a fit for THIS product (not generic)

- We already have a `validate → execute` envelope and per-strategy tick tools — a
  typed recipe is the natural, verifiable replacement for free-written JS ticks.
- We have a walk-forward eval + capture pipeline — content-addressed recipes make
  eval cells reproducible and dedupable.
- We have a decentralized operator + validator set — a hashed, deterministic recipe
  + input-hash + output is exactly what a validator can independently re-derive and
  attest. Determinism is not a nice-to-have here; it is the trust substrate.

## Judging rubric

Each idea scored 1–5 on four axes; **Verdict** derives from the blend.

- **Impact** — how much it moves correctness / capability / trust.
- **Feasibility** — how cleanly it extends what already exists (5 = drop-in).
- **Differentiation** — how specific it is to our on-chain/decentralized setting
  (5 = uniquely ours; 1 = commodity any quant tool has).
- **Confidence** — how sure we are it works and is worth it.

Verdicts: **Adopt-now** (grounded, high confidence) · **Adopt-next** (after the
foundation) · **Research** (spike first) · **Park** (revisit later).

## Foundation (everything else builds on this)

| ID | Idea | Impact | Feas | Diff | Conf | Verdict |
|----|------|:--:|:--:|:--:|:--:|--------|
| F1 | **Typed tick-recipe DSL** — small operator catalog (`ema, rsi, rolling_{mean,std,zscore}, rank, crossover, clamp, sign, score_combine, regime_condition, filter, top_n`) compiling to a deterministic decision, replacing free-written `*-tick.js`. | 5 | 4 | 3 | 4 | **Adopt-now** |
| F2 | **`recipe_hash` content-addressing** — hash(recipe + resolved inputs) on every decision; cache + dedupe eval cells; prove "same recipe+data → same decision". | 5 | 4 | 4 | 5 | **Adopt-now** |
| F3 | **Decision provenance record** — each tick emits `{recipe_hash, input_hash, params, decision}` into the existing capture (`decisions.jsonl`/metrics). | 4 | 5 | 4 | 5 | **Adopt-now** |

**Why F1–F3 first:** they are the trust + reproducibility substrate. Cheap,
grounded in the tick + capture code we own, and unlock F2-dependent items (eval
dedupe, on-chain attestation, principled tuning).

**Expected benefit / success metric:**
- F1: ≥1 strategy family (start: `mm`) runs from a typed recipe with identical or
  better decisions vs the JS tick on a replay; recipe is < ~30 lines of typed ops.
- F2/F3: re-running an eval cell with an unchanged recipe is a 100% cache hit;
  every live decision carries a `recipe_hash` queryable in the capture store.

## Grounded improvements (inside the box)

| ID | Idea | Impact | Feas | Diff | Conf | Verdict |
|----|------|:--:|:--:|:--:|:--:|--------|
| G2 | **Hard lookahead guard** in walk-forward eval — assert no tick reads future candles; gate any `lead`-equivalent behind an explicit unsafe ack. | 5 | 4 | 2 | 5 | **Adopt-now** |
| G4 | **Coverage-aware findings, not silent skips** — emit a structured finding when data is insufficient (the exact failure we hit in the paper-trade unblock). | 4 | 4 | 2 | 5 | **Adopt-now** |
| G6 | **Declared-universe gate** — formalize `supported_assets_for` as a `where`-style universe the agent must use; refuse ad-hoc token addresses (the #122 asset-universe bug class). | 4 | 5 | 2 | 5 | **Adopt-now** |
| R1 | **Refusal-code taxonomy** — structured refusal codes for tick/validate (entitlement / universe / coverage / lookahead / dtype) instead of silent or prose failures. | 4 | 4 | 2 | 4 | **Adopt-next** |
| G7 | **Winsorize / clamp / robust-standardize** indicators — harden signals against flash-crash candles. | 3 | 4 | 2 | 4 | **Adopt-next** |
| G5 | **Factor-neutral scoring for multi-asset bots** — rank on beta/sector-neutralized signal, not raw momentum. | 4 | 3 | 3 | 3 | **Adopt-next** |
| G10 | **as-of join semantics for multi-source data** (price + funding + on-chain) to kill timestamp-mismatch lookahead. | 3 | 3 | 3 | 3 | **Research** |

**Why:** G2/G4/G6 directly close bug classes we *already hit this quarter*; they are
near drop-in and raise correctness/trust immediately. R1/G7/G5 harden quality.

## Moonshots (outside the box)

| ID | Idea | Impact | Feas | Diff | Conf | Verdict |
|----|------|:--:|:--:|:--:|:--:|--------|
| M2 | **On-chain-verifiable recipes** — `recipe_hash` + input-hash + output as the artifact operators sign and validators independently re-derive/attest. Determinism makes decentralized verification possible. | 5 | 2 | 5 | 3 | **Research** |
| M1 | **Recipe-authoring agent** — agent emits a typed recipe DAG executed by a fast engine; LLM never imperatively touches execution. Verify/gate before run. | 5 | 2 | 4 | 3 | **Research** |
| M8 | **Crypto-native factor model** — declared factors (momentum, funding-carry, TVL growth, on-chain activity, liquidity depth, vol) + factor-exposure join. | 5 | 2 | 5 | 3 | **Research** |
| M4 | **Recipe → backtest → live promotion** gated by held-out walk-forward (reuse `HeldOutGate`); recipe_hash makes promotion auditable. | 4 | 3 | 3 | 4 | **Adopt-next** |
| M9 | **Principled param tuning** — optimize typed recipe params under the held-out gate instead of free-form JS edits (the deferred agentic-tuning loop, done right). | 4 | 3 | 3 | 4 | **Adopt-next** |
| M10 | **Recipe lineage in the arena UI** — render the exact typed DAG behind every trade for full transparency. | 4 | 3 | 4 | 4 | **Adopt-next** |
| M6 | **"Findings" as the agent output contract** — decision = deterministic fn(findings, recipe); kills hallucinated reasoning. | 4 | 3 | 3 | 3 | **Research** |
| M3 | **Factor/data marketplace with on-chain entitlement** — `load` entitlement → on-chain access grants; two-sided data+strategy market. | 4 | 1 | 5 | 2 | **Park** |
| M7 | **Regime-conditional recipe switching** — deterministic strategy swap on a declared vol/trend regime predicate. | 3 | 2 | 3 | 3 | **Research** |
| M5 | **Recipe diversity as an eval axis** — same recipe across many operators/models isolates author variance; turns the fleet into a measurement instrument. | 3 | 3 | 4 | 3 | **Research** |

## Recommended sequence

1. **Now:** F2 + F3 (hash + provenance) and G2/G4/G6 (lookahead/coverage/universe
   guards). Small, grounded, close known bug classes, and unblock everything.
2. **Then:** F1 (typed tick-recipe DSL) on the `mm` family as the pilot.
3. **Then:** M4/M9/M10 (promotion gate, principled tuning, arena lineage) on top of
   F1+F2.
4. **Research spikes:** M1/M2/M8 — the recipe-authoring agent, on-chain attestation,
   and crypto factor model are the highest-ceiling bets; each needs a scoped spike
   before commitment.

## Open questions

- Build the engine in Rust (extend `trading-runtime`) vs. a JS recipe interpreter
  bundled into the sidecar tools? Rust is faster + closer to the validator; JS is
  closer to the current tick tools. Lean Rust for the executor, JS shim for authoring.
- How much of the operator catalog do crypto strategies actually need? Start with the
  ~12 in F1; grow by demand, not by mirroring an equities catalog wholesale.
- Does on-chain attestation (M2) require the full recipe on-chain, or just the hashes
  + a challenge/dispute path (cheaper, fits the existing slashing/dispute window)?
