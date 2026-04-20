# Pursuit: Split-Tick Architecture
Generation: 8
Status: designing

## Metric → Product-Value Claims
- **tick_latency**: "FAST ticks under 15s mean the bot reacts to market moves in near-real-time instead of waiting 5 minutes for a bloated tick to finish"
- **self_improvement_rate**: "Dedicated RESEARCH ticks with 15 turns actually close the backtest→promote loop instead of writing tools that never get validated"
- **conversation_responsiveness**: "Owner messages get handled within 1 tick (~5 min) instead of being buried in a trading prompt"

## System Audit

### What exists and works
- Trading loop: 5-min cron, 12 turns, 120s timeout — but bloated prompt makes most ticks 50-100s
- Memory system: toc.md + conversations/ — bot reads and responds correctly
- Self-written tools: 25 tools (~400KB) — bot genuinely evolves its code
- Backtest API: POST /backtest/walk-forward exists but bot has NEVER called it

### What's broken
1. **One-size-fits-all ticks**: every tick reads 520-line system prompt + extended loop prompt + memory ToC + harness config + self-improvement instructions. A simple "price unchanged, skip" tick burns 50s and ~10K tokens.
2. **Self-improvement blocks trading**: when the bot decides to write a tool, the tick takes 5 minutes and blocks the next trading evaluation.
3. **Evolution workflow can't get sidecar time**: the 30-min evolution cron times out because the trading tick consumed the session.
4. **Context bloat**: insights.jsonl (42KB) and 25 tools growing unbounded. No pruning.
5. **No backtest validation**: bot writes tools prolifically but never calls the walk-forward API to prove they work.

### Root cause
Single workflow trying to be trader + researcher + conversationalist + self-improver in every tick.

## Baselines
- FAST skip tick: ~50s (should be <15s)
- Self-improvement cycles completed: 0 formal (tools written ad-hoc)
- Backtest API calls: 0
- Conversation response time: 1 tick (5 min) — acceptable

## Diagnosis
Architectural, not tunable. The prompt, turn budget, and workflow structure need to split into purpose-built modes.

## Generation 8 Design

### Thesis
**Three purpose-built tick modes eliminate the one-size-fits-all bottleneck.** FAST ticks handle 90% of iterations in <15s. RESEARCH ticks handle self-improvement with enough turns to actually close the loop. CONVERSATION ticks handle owner messages immediately.

### Moonshot considered
**Persistent sessions with resume**: instead of 1-shot ticks, the bot maintains a long-running session that carries context across ticks. Rejected for now — requires sidecar session persistence architecture that doesn't exist. But this is Gen9 material if we prove split-tick works.

### Changes (ordered by impact)

#### 1. FAST trading prompt (architectural)
- 3 turns max, <15s target
- Reads: prices, regime detector output, circuit breaker
- NO system prompt bloat — just the essential trading instructions
- NO memory check, NO self-improvement, NO conversation handling
- Decision: trade (with pre-computed signals) or skip
- Fires every 5 minutes

#### 2. RESEARCH prompt (architectural)  
- 15 turns, 300s timeout
- Self-improvement: analyze performance, write tools, backtest mutations
- MUST call /backtest/walk-forward API (not just write JS tools)
- Prune unused tools, validate existing ones
- Fires every 30 minutes, staggered from trading ticks

#### 3. CONVERSATION prompt (architectural)
- 10 turns, 120s timeout
- Handle owner messages from memory/toc.md
- Research requests, strategy discussions
- Fires every 5 minutes BUT only executes if toc.md has ACTION NEEDED
- Otherwise: 0 turns, instant skip

#### 4. Workflow configuration
- Remove the bloated combined prompt from trading workflow
- Create 3 separate workflow entries with different prompts/budgets
- Stagger crons so they don't compete for sidecar

### Risk + Success criteria
- Risk: FAST tick too dumb (misses important context) → mitigate by having RESEARCH tick review decisions
- Risk: three workflows competing for sidecar → mitigate with staggered crons
- Success: FAST tick p50 < 15s (from 50s), RESEARCH tick completes 1+ backtest per cycle
