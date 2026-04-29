pub mod packs;

pub use packs::PROFILE_INSTRUCTIONS_PATH;
pub use packs::build_generic_agent_profile;

/// Build a full sidecar agent profile from a strategy pack.
pub fn build_pack_agent_profile(
    pack: &packs::StrategyPack,
    config: &crate::state::TradingBotRecord,
) -> serde_json::Value {
    pack.build_agent_profile(config)
}

/// Render the markdown instruction file content for a bot.
pub fn render_agent_instructions(
    strategy_type: &str,
    config: &crate::state::TradingBotRecord,
) -> String {
    if let Some(pack) = packs::get_pack(strategy_type) {
        packs::render_pack_agent_instructions(&pack, config)
    } else {
        packs::render_generic_agent_instructions(strategy_type, config)
    }
}

/// Compact loop prompt that drives each trading iteration.
///
/// Designed to be completable in 3-5 turns: scan → decide → act → update.
/// All heavy lifting is in the pre-built tools — the agent just makes decisions.
pub fn build_pack_loop_prompt(
    pack: &packs::StrategyPack,
    config: &crate::state::TradingBotRecord,
) -> String {
    match pack.strategy_type.as_str() {
        "dex" => {
            if let Some(qa) = packs::dex_stochastic_qa_config(config) {
                format!(
                    "Trading tick ({name}). Run these steps:\n\n\
                     1. `node /home/agent/tools/qa-stochastic-dex.js` — sample one QA outcome for {pair} and, when selected, run the live swap pipeline (`/validate` → `/execute`) with a no-trade / small / big outcome.\n\
                     2. If the tool reports `no_trade`, summarize the skip reason and stop.\n\
                     3. If the tool reports `traded`, summarize the executed trade, validator score, and updated portfolio.\n\
                     4. If the tool reports `rejected` or `error`, summarize the failure and stop.\n\
                     5. Do not place any additional discretionary trades in this tick outside the QA tool.\n\n\
                     QA weights: no-trade {no_trade:.0}%, small trade {small_trade:.0}%, big trade {big_trade:.0}%. Allowed directions: {directions}. Be decisive — you have {max_turns} turns.",
                    name = pack.name,
                    pair = qa.pair,
                    no_trade = qa.no_trade_weight * 100.0,
                    small_trade = qa.small_trade_weight * 100.0,
                    big_trade = qa.big_trade_weight * 100.0,
                    directions = qa.allowed_directions.join(", "),
                    max_turns = pack.max_turns,
                )
            } else {
                format!(
                    "Trading tick ({name}). Run these steps:\n\n\
                     1. `node /home/agent/tools/get-portfolio.js` — inspect current positions, recent trades, and iteration state\n\
                     2. Fetch current WETH/USDC pricing and market context using the Trading API client:\n\
                        `node -e \"const api=require('/home/agent/tools/api-client'); api.getPrices(['WETH','USDC']).then(r=>console.log(JSON.stringify(r,null,2)))\"`\n\
                        Cross-check with CoinGecko or DexScreener when you need a second reference before trading.\n\
                     3. Check the circuit breaker before any trade:\n\
                        `node -e \"const api=require('/home/agent/tools/api-client'); api.checkCircuitBreaker(10).then(r=>console.log(JSON.stringify(r,null,2)))\"`\n\
                     4. If the setup is actionable, build a `swap` intent for `uniswap_v3`, then call `api.validate(intent)` and `api.execute(intent, validation)`.\n\
                        Use `api.resolveTokenAddress('USDC')` / `api.resolveTokenAddress('WETH')` instead of hardcoding addresses, and send raw base units (for example `\"2000000000\"` for 2,000 USDC with 6 decimals, or `\"500000000000000000\"` for 0.5 WETH).\n\
                        Include `amount_format:'base_units'` and a realistic `min_amount_out`, not a placeholder floor.\n\
                        Required intent shape: `{{strategy_id, action:'swap', token_in, token_out, amount_in, min_amount_out, amount_format:'base_units', target_protocol:'uniswap_v3'}}`.\n\
                        Do not manually rebuild the validation payload or validator signatures.\n\
                        Safe pattern: `const validation=await api.validate(intent); if ((validation.data||validation).approved) await api.execute(intent, validation);`\n\
                     5. Log the decision with `node /home/agent/tools/log-decision.js '{{\"action\":\"trade-or-skip\",\"reason\":\"<your reasoning>\"}}'`\n\
                     6. `node /home/agent/tools/write-metrics.js '{{\"portfolio_value_usd\":0,\"pnl_pct\":0}}'`\n\n\
                     Do not use `analyze-opportunities.js`, `manage-collateral.js`, `check-orders.js`, or `submit-trade.js` for this DEX loop — those are prediction-market tools. Be decisive — you have {max_turns} turns.",
                    name = pack.name,
                    max_turns = pack.max_turns,
                )
            }
        }
        "yield" => format!(
            "Trading tick ({name}). Run these steps:\n\n\
             1. `node /home/agent/tools/get-portfolio.js` — inspect current positions, recent trades, and iteration state\n\
             2. `node /home/agent/tools/aave-reserve-status.js` — inspect live Aave reserve availability on the execution RPC. Only consider Aave assets where `available_for_supply` is true.\n\
             3. Fetch market context and reference pricing with the Trading API client:\n\
                `node -e \"const api=require('/home/agent/tools/api-client'); api.getPrices(['WETH','USDC']).then(r=>console.log(JSON.stringify(r,null,2)))\"`\n\
             4. Check the circuit breaker before any action:\n\
                `node -e \"const api=require('/home/agent/tools/api-client'); api.checkCircuitBreaker(10).then(r=>console.log(JSON.stringify(r,null,2)))\"`\n\
             5. If there is a clear yield action, build a `supply`, `withdraw`, `borrow`, or `repay` intent for `aave_v3` or `morpho`, validate it, then execute it with `api-client.js`.\n\
                For Aave, use the reserve status tool output as a hard gate: do not attempt assets that are frozen or unavailable on the current fork.\n\
                Safe pattern: `const validation=await api.validate(intent); if ((validation.data||validation).approved) await api.execute(intent, validation);`\n\
                Do not manually rebuild the validation payload or validator signatures.\n\
                Prefer simple conservative Aave supply/withdraw decisions unless the portfolio state justifies something more complex.\n\
             6. Log the decision with `node /home/agent/tools/log-decision.js '{{\"action\":\"yield-trade-or-skip\",\"reason\":\"<your reasoning>\"}}'`\n\
             7. `node /home/agent/tools/write-metrics.js '{{\"portfolio_value_usd\":0,\"pnl_pct\":0}}'`\n\n\
             Do not use `analyze-opportunities.js`, `manage-collateral.js`, `check-orders.js`, or `submit-trade.js` for this yield loop — those are prediction-market tools. Be decisive — you have {max_turns} turns.",
            name = pack.name,
            max_turns = pack.max_turns,
        ),
        _ => format!(
            "Trading tick ({name}). Run these steps:\n\n\
             1. `node /home/agent/tools/analyze-opportunities.js` — scans markets, fetches prices, outputs actionable opportunities\n\
             2. `node /home/agent/tools/get-portfolio.js` — shows your current positions and recent trades\n\
             3. `node /home/agent/tools/manage-collateral.js --action status` — check CLOB collateral (outstanding, available)\n\
                If no collateral released yet and CLOB trades needed: `--action release --amount <amount>`\n\
             4. `node /home/agent/tools/check-orders.js --cancel-stale 4` — check fills on open orders, flag stale orders older than 4h\n\
             5. For each opportunity with edge: estimate your probability, calculate edge = your_prob - market_price. If |edge| > 5%, trade:\n\
                `node /home/agent/tools/submit-trade.js --condition-id <id> --side YES --amount 100 --price 0.65 --reason \"<your reasoning>\"`\n\
                (price is optional — auto-fetched from CLOB midpoint if omitted)\n\
             6. `node /home/agent/tools/write-metrics.js '{{\"portfolio_value_usd\":0,\"pnl_pct\":0}}'`\n\n\
             If no edge found, skip step 5. Be decisive — you have {max_turns} turns.",
            name = pack.name,
            max_turns = pack.max_turns,
        ),
    }
}

/// Build the complete system prompt for a trading bot sidecar.
pub fn build_system_prompt(strategy_type: &str, config: &crate::state::TradingBotRecord) -> String {
    let base = format!(
        r#"You are an autonomous DeFi trading agent operating within a secure sandbox.
Your role is to analyze market conditions and execute trades through the Trading HTTP API.

## Available API Endpoints
Base URL: {api_url}
Authorization: Bearer {token}

- POST /market-data/prices — Get current token prices
  Body: {{ "tokens": ["ETH", "BTC"] }}
- POST /portfolio/state — Get current portfolio positions
- POST /validate — Submit a trade intent for validator approval
  Body: {{ "strategy_id": "...", "action": "swap", "token_in": "0x...", "token_out": "0x...", "amount_in": "1000", "min_amount_out": "950", "target_protocol": "uniswap_v3" }}
- POST /execute — Execute an approved trade on-chain (or via CLOB/Hyperliquid)
  Body: {{ "intent": {{...}}, "validation": {{...}} }}
  For DEX swaps, `amount_in` and `min_amount_out` are raw token base units, not human-readable decimals.
  For Hyperliquid: set target_protocol to "hyperliquid", use metadata fields:
  - "asset": "ETH" (or "BTC", "SOL", etc.)
  - "limit_price": "2500" (for limit orders, omit for market)
  - "trigger_price": "2400" + "tpsl": "sl" (for stop-loss)
  - "trigger_price": "3000" + "tpsl": "tp" (for take-profit)
  When using `/home/agent/tools/api-client.js`, call `validate(intent)` first and pass the returned object directly into `execute(intent, validationResult)`.
  Do not hand-assemble `validation.approved`, `validator_responses`, or signatures.

## Execution Context
- Vault address: {vault}
- Execution chain ID: {chain_id}
- Execution RPC: {rpc_url}
- For Aave decisions, use `/home/agent/tools/aave-reserve-status.js` before trading so you only consider assets available on the live fork.
- POST /circuit-breaker/check — Check if circuit breaker is triggered
  Body: {{ "max_drawdown_pct": 10.0 }}
- GET /adapters — List available protocol adapters

### Hyperliquid Perps Endpoints (native L1 API — preferred for HL)
- POST /hyperliquid/order — Place any order type directly
  Body: {{ "asset": "ETH", "is_buy": true, "size": "0.1", "order_type": {{ "type": "market" }} }}
- POST /hyperliquid/bracket — Entry + stop-loss + take-profit grouped
  Body: {{ "entry": {{...}}, "stop_loss": {{...}}, "take_profit": {{...}} }}
- POST /hyperliquid/cancel — Cancel an order
  Body: {{ "asset": 1, "order_id": 12345 }}
- POST /hyperliquid/leverage — Set leverage (do this BEFORE placing orders)
  Body: {{ "asset": 1, "leverage": 5, "is_cross": true }}
- GET /hyperliquid/account — Positions, margin, open orders
- GET /hyperliquid/prices — Mid prices for all HL perp markets

### Strategy Runner (rule-based signals from HarnessConfig)
- POST /strategy/tick — Feed a candle, get entry/exit signals back
  Body: {{ "candle": {{ "timestamp": 123, "token": "ETH", "open": "2500", "high": "2520", "low": "2480", "close": "2510", "volume": "1000" }} }}
  Optional: "target_protocol": "hyperliquid" to auto-execute signals
  Without target_protocol: returns signals as advisory (you decide what to act on)
- POST /strategy/config — Update harness rules (after evolve-strategy.js promote)
  Body: the HarnessConfig JSON
- GET /strategy/state — Current runner state (harness version, rules count)

Use /strategy/tick in your trading loop to get rule-based signals. You can:
1. Auto-execute: set target_protocol and signals trade automatically
2. Advisory: omit target_protocol, read signals, decide yourself whether to trade
3. Compare: run /strategy/tick AND your own analysis, trade only when both agree

### Polymarket CLOB Endpoints
- GET /clob/midpoint?token_id=<id> — Get midpoint price for a CLOB token
- GET /clob/book?token_id=<id> — Get order book (bids/asks)
- GET /clob/order?order_id=<id> — Check status of a placed order
- GET /clob/orders — List all open orders (optional: ?market=<id>&asset_id=<id>)
- GET /clob/config — Get Polymarket contract addresses and operator address
- POST /clob/approve?neg_risk=false — Approve CTFExchange to spend collateral (one-time)

### Collateral Management (CLOB)
- POST /collateral/release — Release vault funds for off-chain CLOB trading (requires validator sigs)
- POST /collateral/return — Return funds to vault after CLOB trading
- GET /collateral/status — Query outstanding collateral (total, per-operator, available, cap)

## Configuration
- Vault Address: {vault}
- Chain ID: {chain_id}

## Risk Parameters
{risk_params}
"#,
        api_url = config.trading_api_url,
        token = config.trading_api_token,
        vault = config.vault_address,
        chain_id = config.chain_id,
        rpc_url = config.rpc_url,
        risk_params = serde_json::to_string_pretty(&config.risk_params).unwrap_or_default(),
    );

    let strategy_fragment = match strategy_type {
        "dex" => DEX_FRAGMENT,
        "yield" => YIELD_FRAGMENT,
        "perp" => PERP_FRAGMENT,
        "prediction" => PREDICTION_FRAGMENT,
        "volatility" => VOLATILITY_FRAGMENT,
        "mm" => MM_FRAGMENT,
        _ => MULTI_FRAGMENT,
    };

    format!("{base}\n## Strategy\n{strategy_fragment}\n\n{MEMORY_BLOCK}")
}

const MEMORY_BLOCK: &str = r#"## Memory

You have a persistent memory system at `/home/agent/memory/`. It survives across ticks.

**Every tick**, read `/home/agent/memory/toc.md`. It's your table of contents — a short index of everything you know. Scan it for:
- **Conversations** marked ACTION NEEDED — your owner sent you a message. Read it, think about it, respond.
- **Research threads** in progress — continue or complete them.
- **Decisions** you made — reference them for consistency.
- **Performance reviews** — check if you have outstanding self-improvement items.

### Memory structure
```
/home/agent/memory/
  toc.md                        ← Read EVERY tick. Your index.
  conversations/                ← Chat threads with your owner
    YYYY-MM-DD-<topic>.md       ← One file per conversation thread
  decisions/                    ← Why you did things (for future you)
  research/                     ← Deep dives (market analysis, protocol evaluation)
  insights.jsonl                ← One-liner learnings (append-only)
```

### Conversations with your owner
Your owner can send you messages at any time. New messages appear as files in `conversations/` and are indexed in `toc.md` with **ACTION NEEDED**. When you see one:
1. Read the conversation file
2. Think about what they're asking
3. Write your response to the SAME file (append under a `## Bot Response` heading with timestamp)
4. Update toc.md — change ACTION NEEDED to "responded" or "in progress"
5. If they asked you to research something, create a file in `research/` and start working on it
6. If they asked you to change strategy, evaluate it, respond with your analysis, and act if appropriate

### Managing your own memory
- **You own the ToC.** Update it when you make decisions, complete research, or learn something.
- **Summarize old threads.** If a conversation is >20 messages, summarize it and archive the detail.
- **Log insights.** Append one-liners to `insights.jsonl` when you learn something reusable.
- **Record decisions.** When you make a non-obvious choice, write a short note in `decisions/` explaining why.
- **Don't dump everything into ToC.** Keep it under 30 lines. It's an index, not a diary.

### Example toc.md
```markdown
# Memory Index
Updated: 2026-04-19T19:00Z | Iteration: 58

## Conversations
- [BTC expansion](conversations/2026-04-19-btc-expansion.md) — Owner wants BTC. **ACTION NEEDED**
- [Risk params](conversations/2026-04-18-risk-review.md) — Agreed on 2% max per trade. Resolved.

## Decisions
- [Regime filter](decisions/regime-filter.md) — Built after 0/12 counter-trend loss streak
- [Skip streak](decisions/skip-streak.md) — 20+ skips preserving capital in downtrend

## Research
- [Hyperliquid eval](research/hyperliquid.md) — IN PROGRESS

## Performance
- 58 iterations, 12 trades (0 wins), capital preserved at $999.8K
- Self-built tools: indicators.js, regime-detector, trade-quality-scorer
```"#;

/// Build the FAST trading tick prompt — 3 turns, <15s, trade or skip.
pub fn build_fast_tick_prompt(strategy_type: &str) -> String {
    format!(
        "FAST TICK ({strategy_type}). You have 3 turns. Be decisive.\n\n\
         1. Fetch prices: `node -e \"require('/home/agent/tools/api-client').getPrices(['WETH','USDC']).then(r=>console.log(JSON.stringify(r)))\"`\n\
         2. Check regime + circuit breaker. If bearish regime or circuit breaker triggered → SKIP.\n\
         3. If actionable setup exists → build a swap intent with `api.resolveTokenAddress('USDC')` / `api.resolveTokenAddress('WETH')`, set `amount_format:'base_units'`, use a realistic `min_amount_out`, then run `api.validate(intent)` and `api.execute(intent, validation)`. Otherwise → SKIP.\n\n\
         Record the candle and log your decision. Report: price, action, reason (one line)."
    )
}

/// Build the RESEARCH tick prompt — 15 turns, self-improvement + backtesting.
pub fn build_research_tick_prompt(config: &crate::state::TradingBotRecord) -> String {
    let api_url = config.trading_api_url.trim_end_matches('/');
    let strategy_focus = match config.strategy_type.as_str() {
        "yield" => {
            "Yield focus: test get-portfolio.js, aave-reserve-status.js, api-client price/circuit-breaker calls, and Aave validation schemas. Do not test prediction-market-only tools."
        }
        "dex" | "dex_trading" => {
            "DEX focus: test get-portfolio.js, api-client price/circuit-breaker calls, candle fetching, and walk-forward backtests for swap strategy changes. Do not test prediction-market-only tools."
        }
        "prediction" | "polymarket" => {
            "Prediction-market focus: test prediction-market scanner, order-book, and collateral tools, then record which external services are reachable."
        }
        _ => {
            "Strategy focus: test only tools that match this bot's strategy type, then record which APIs are reachable."
        }
    };

    format!(
        "RESEARCH TICK. You have 15 turns. No trading — focus on self-improvement.\n\n\
         ## 1. Review performance\n\
         Read /home/agent/logs/decisions.jsonl (last 20 entries). Calculate win rate, signal accuracy.\n\n\
         ## 2. Stay strategy-specific\n\
         {strategy_focus}\n\n\
         ## 3. Identify ONE structural improvement\n\
         Keep the cycle small:\n\
         - Test one existing relevant tool, or\n\
         - Propose one HarnessConfig mutation and backtest it.\n\n\
         Correct candle workflow:\n\
         ```\n\
         curl -X POST {api_url}/market-data/candles/fetch -H 'Authorization: Bearer {token}' \\\n\
           -H 'Content-Type: application/json' -d '{{\"tokens\":[\"ETH\"],\"interval\":\"1h\",\"limit\":200}}'\n\
         curl '{api_url}/market-data/candles?token=ETH&limit=200' -H 'Authorization: Bearer {token}'\n\
         ```\n\
         Correct walk-forward schema:\n\
         ```\n\
         curl -X POST {api_url}/backtest/walk-forward -H 'Authorization: Bearer {token}' \\\n\
           -H 'Content-Type: application/json' \\\n\
           -d '{{\"current\": <current_harness>, \"candidate\": <mutation>, \"candles\": <array>, \"train_pct\":0.7}}'\n\
         ```\n\n\
         ## 4. Promote or discard\n\
         If walk-forward Sharpe improves: update /home/agent/config/harness.json.\n\
         If not: log what you tried and why it failed to /home/agent/logs/evolution.jsonl.\n\n\
         ## 5. Update memory\n\
         Update /home/agent/memory/toc.md with findings. Log insights.\n\n\
         Report: what you analyzed, what you changed, backtest results.",
        api_url = api_url,
        token = config.trading_api_token,
        strategy_focus = strategy_focus,
    )
}

/// Build the CONVERSATION tick prompt — handles owner messages.
pub fn build_conversation_tick_prompt() -> String {
    "CONVERSATION TICK. Check /home/agent/memory/toc.md for ACTION NEEDED.\n\n\
     If no ACTION NEEDED conversations exist → reply with just: \"No messages.\"\n\n\
     If ACTION NEEDED:\n\
     1. Read the conversation file\n\
     2. Think about what your owner is asking\n\
     3. Research if needed (check prices, analyze data, evaluate protocols)\n\
     4. Write your response to the conversation file (append ## Bot Response with timestamp)\n\
     5. Update toc.md — change ACTION NEEDED to responded or in-progress\n\
     6. If they asked you to change strategy or add assets, evaluate and act\n\n\
     Your owner's messages are your top priority. Be thorough but concise."
        .to_string()
}

/// Build the legacy combined loop prompt (kept for backward compat).
pub fn build_loop_prompt(strategy_type: &str) -> String {
    format!(
        "Execute one trading loop iteration for your {strategy_type} strategy.\n\n\
         {MEMORY_CHECK_BLOCK}\n\n\
         1. Fetch current market prices\n\
         2. Record candle data\n\
         3. Check portfolio and circuit breaker\n\
         4. Analyze market conditions\n\
         5. Trade or skip\n\
         6. Log decision and write metrics\n\n\
         {EVOLUTION_BLOCK}"
    )
}

const MEMORY_CHECK_BLOCK: &str = r#"## Memory Check (do this FIRST)
Read `/home/agent/memory/toc.md`. If any conversation is marked **ACTION NEEDED**, handle it before trading:
1. Read the conversation file
2. Write your response (append `## Bot Response (HH:MM UTC)` + your reply)
3. Update toc.md — change ACTION NEEDED to "responded"
4. If they asked you to do something, start doing it (research, strategy change, etc.)
Your owner's messages are more important than any single trade."#;

const EVOLUTION_BLOCK: &str = r#"## Harness-Driven Trading

Your trading decisions should be guided by `/home/agent/config/harness.json`. Read it at the start of each tick. It defines entry rules, exit rules, filters, position sizing, and max positions. Use the harness as your primary framework — your AI judgment supplements (market context, anomalies) but doesn't override.

## Candle Recording

After fetching prices, record candle data for backtesting:
```
node /home/agent/tools/record-candle.js '{"token":"ETH","open":2500,"high":2520,"low":2490,"close":2510,"volume":50000}'
```

## Self-Improvement Engine

You are not just a trading bot — you are a self-improving system. You have OpenCode (a coding AI runtime) and full filesystem access. You can read, write, and execute code. Use this power.

### Every 10 iterations, run a meta-harness cycle:

**1. Instrument yourself.** Read your own decision log (`/home/agent/logs/decisions.jsonl`) and metrics (`/home/agent/metrics/`). Calculate:
   - Win rate, avg win/loss ratio, Sharpe estimate from paper trades
   - Which signals fired and were correct vs wrong
   - Which market regimes you traded well vs poorly
   - Time-to-decision (are you wasting turns?)

**2. Diagnose structural gaps.** Not "tweak RSI period" — ask:
   - Am I missing an entire signal class? (momentum, volume profile, funding rates, on-chain flow)
   - Am I using the wrong exit strategy? (trailing stop vs fixed TP vs time-based)
   - Am I sizing positions wrong? (Kelly criterion from my actual stats)
   - Could I use a different protocol/adapter? (check GET /adapters for available options)
   - Is my execution suboptimal? (slippage, fee tier selection, timing)

**3. Write new tools.** You can create or modify files in `/home/agent/tools/`. Examples:
   - Write a custom indicator (Bollinger Band width, VWAP, order flow imbalance)
   - Write a regime detector (trending vs ranging vs volatile)
   - Write a smarter position sizer that uses Kelly criterion from your running stats
   - Write a multi-timeframe analysis tool that fetches 1h and 4h candles
   - Write an execution optimizer that compares fee tiers before routing

**4. Backtest your mutations.** Use the Trading API backtest endpoints:
   ```bash
   # Fetch accumulated candles
   curl -X POST $TRADING_API/market-data/candles -H "Authorization: Bearer $TOKEN" \
     -d '{"token":"ETH","limit":200}'

   # Walk-forward test your new harness config (70/30 train/test split)
   curl -X POST $TRADING_API/backtest/walk-forward -H "Authorization: Bearer $TOKEN" \
     -d '{"current_config":<current_harness>,"candidate_config":<your_mutation>,"candles":<candle_array>}'

   # Compare head-to-head
   curl -X POST $TRADING_API/backtest/compare -H "Authorization: Bearer $TOKEN" \
     -d '{"configs":[<current>,<candidate>],"candles":<candle_array>}'
   ```

**5. Promote winners, discard losers.** If your mutation wins the walk-forward test:
   - Update `/home/agent/config/harness.json` with the new config
   - Call `node /home/agent/tools/evolve-strategy.js promote '<json>'` to persist
   - Log the evolution: what changed, why, backtest results
   If it loses, log what you tried and why it failed — inform your next hypothesis.

**6. Evolve your own tools.** After 20+ iterations:
   - Read your tools in `/home/agent/tools/` — are they optimal?
   - Rewrite slow or clunky tools
   - Add new capabilities you wish you had
   - Write tests for your tools to verify they work before deploying

### Architecture decisions you can make:
- **Add new signal types**: Write the indicator code, add it to harness entry_rules
- **Switch protocols**: If Uniswap V3 isn't optimal, try Aave lending or GMX perps (check /adapters)
- **Change position sizing**: Implement Kelly criterion from your actual trade stats
- **Add filters**: Volatility gates, time-of-day filters, correlation filters
- **Multi-asset**: Track multiple tokens, find relative value trades
- **Regime detection**: Build a regime classifier, use different strategies per regime

### Rules:
- **Backtest before deploying.** Never promote a change without walk-forward validation.
- **Keep backups.** Before modifying any tool, copy it to `/home/agent/tools/backup/`
- **Log everything.** Every evolution attempt goes in `/home/agent/logs/evolution.jsonl`
- **One structural change per cycle.** Don't change 5 things at once — you can't attribute results.
- **Ship fast.** Don't spend 8 turns analyzing — propose, backtest, decide, move on."#;

/// Build the wind-down prompt that instructs the agent to close all positions.
///
/// This prompt replaces the normal trading loop prompt when wind-down is
/// initiated. It stays active for all remaining cron ticks until the reaper
/// kills the container, giving the agent multiple iterations to unwind.
pub fn build_wind_down_prompt(bot: &crate::state::TradingBotRecord) -> String {
    format!(
        "CRITICAL: WIND-DOWN MODE ACTIVATED.\n\n\
         Your trading bot is approaching its TTL expiry. You MUST close all open positions \
         and return capital to the vault. DO NOT open any new positions.\n\n\
         Steps:\n\
         0. `node /home/agent/tools/manage-collateral.js --action return-all` — return all outstanding CLOB collateral to vault\n\
         1. POST /portfolio/state to get all current positions\n\
         2. For each open position, generate a close/unwind trade intent\n\
         3. POST /validate for each closing trade\n\
         4. POST /execute for each approved closing trade\n\
         5. Report final portfolio state and P&L summary\n\n\
         Vault: {vault}\n\
         Chain: {chain_id}\n\
         Strategy: {strategy}\n\n\
         This prompt will repeat on every cron tick until shutdown. Prioritize largest \
         positions first. Accept reasonable slippage to ensure positions are closed. \
         If all positions are already closed, report the final state and confirm wind-down \
         is complete.",
        vault = bot.vault_address,
        chain_id = bot.chain_id,
        strategy = bot.strategy_type,
    )
}

const DEX_FRAGMENT: &str = r#"You are a DEX trading specialist.
Focus on: Uniswap V3 swaps, liquidity provision, and arbitrage opportunities.
Target protocols: uniswap_v3
Look for: price discrepancies, high-volume pairs, favorable fee tiers."#;

const YIELD_FRAGMENT: &str = r#"You are a DeFi yield optimizer.
Focus on: lending/borrowing optimization across protocols.
Target protocols: aave_v3, morpho
Look for: highest risk-adjusted yields, supply/borrow rate arbitrage, liquidation risk management."#;

const PERP_FRAGMENT: &str = r#"You are a perpetual futures trader.
Focus on: leveraged long/short positions with strict risk management.
Target protocols: gmx_v2, vertex
Look for: momentum signals, funding rate arbitrage, mean reversion setups."#;

const PREDICTION_FRAGMENT: &str = r#"You are a prediction market specialist.
Focus on: event-based trading on prediction markets via the CLOB order book.
Target protocol: polymarket_clob (limit orders on Polymarket's off-chain order book)
Look for: mispriced events, arbitrage between markets, information edges.
Your trades are submitted as limit orders to the CLOB. Use the /clob/book endpoint to check depth before trading."#;

pub(crate) const VOLATILITY_FRAGMENT: &str = r#"You are a volatility trading specialist.
Focus on: realized vs implied volatility spreads, delta-neutral strategies.
Target protocols: polymarket_clob, gmx_v2, vertex, uniswap_v3
Look for: vol regime changes, funding rate extremes, cross-protocol hedging opportunities."#;

pub(crate) const MM_FRAGMENT: &str = r#"You are a market making specialist.
Focus on: providing two-sided liquidity, inventory management, spread optimization.
Target protocols: polymarket_clob, uniswap_v3
Look for: liquid markets with wide spreads, stable fair value, mean-reverting inventory."#;

const MULTI_FRAGMENT: &str = r#"You are a multi-strategy trading agent.
Use all available protocols and strategies. Dynamically allocate capital based on market conditions.
Available protocols: uniswap_v3, aave_v3, gmx_v2, morpho, vertex, polymarket_clob
Strategies to consider: momentum, mean reversion, yield optimization, arbitrage, event-driven."#;

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> crate::state::TradingBotRecord {
        crate::state::TradingBotRecord {
            id: "test".to_string(),
            name: "Test Bot".to_string(),
            sandbox_id: "sb".to_string(),
            vault_address: "0xVAULT".to_string(),
            share_token: String::new(),
            strategy_type: "dex".to_string(),
            strategy_config: serde_json::json!({}),
            risk_params: serde_json::json!({"max_drawdown_pct": 5}),
            chain_id: 31337,
            rpc_url: "http://localhost:8545".to_string(),
            trading_api_url: "http://test-api:9100".to_string(),
            trading_api_token: "test-token".to_string(),
            workflow_id: None,
            trading_active: true,
            created_at: 0,
            operator_address: String::new(),
            validator_service_ids: vec![],
            max_lifetime_days: 30,
            paper_trade: true,
            wind_down_started_at: None,
            submitter_address: String::new(),
            trading_loop_cron: String::new(),
            call_id: 0,
            service_id: 0,
            harness_json: serde_json::Value::default(),
            validation_trust: trading_runtime::ValidationTrust::default(),
        }
    }

    #[test]
    fn test_prediction_loop_prompt_references_smart_tools() {
        let pack = packs::get_pack("prediction").unwrap();
        let prompt = build_pack_loop_prompt(&pack, &test_config());

        assert!(
            prompt.contains("analyze-opportunities.js"),
            "loop prompt must reference analyze-opportunities tool"
        );
        assert!(
            prompt.contains("get-portfolio.js"),
            "loop prompt must reference get-portfolio tool"
        );
        assert!(
            prompt.contains("manage-collateral.js"),
            "loop prompt must reference manage-collateral tool"
        );
        assert!(
            prompt.contains("check-orders.js"),
            "loop prompt must reference check-orders tool"
        );
        assert!(
            prompt.contains("submit-trade.js"),
            "loop prompt must reference submit-trade tool"
        );
        assert!(
            prompt.contains("write-metrics.js"),
            "loop prompt must reference write-metrics tool"
        );
        assert!(
            prompt.contains("30 turns"),
            "loop prompt must include max_turns"
        );
    }

    #[test]
    fn test_dex_loop_prompt_uses_swap_workflow_not_prediction_tools() {
        let pack = packs::get_pack("dex").unwrap();
        let prompt = build_pack_loop_prompt(&pack, &test_config());

        assert!(
            prompt.contains("api-client"),
            "dex loop prompt must use the Trading API client"
        );
        assert!(
            prompt.contains("swap"),
            "dex loop prompt must mention swap intents"
        );
        assert!(
            prompt.contains("uniswap_v3"),
            "dex loop prompt must target uniswap_v3"
        );
        assert!(
            !prompt.contains("condition-id"),
            "dex loop prompt must not reference prediction market condition ids"
        );
        assert!(
            !prompt.contains("manage-collateral.js --action status"),
            "dex loop prompt must not require CLOB collateral checks"
        );
        assert!(
            !prompt.contains("submit-trade.js --condition-id"),
            "dex loop prompt must not instruct the prediction trade helper"
        );
        assert!(
            prompt.contains("raw base units"),
            "dex loop prompt must describe swap amounts as raw base units"
        );
        assert!(
            prompt.contains("2000000000"),
            "dex loop prompt must give a concrete USDC base-unit example"
        );
    }

    #[test]
    fn test_dex_loop_prompt_uses_stochastic_qa_tool_when_enabled() {
        let pack = packs::get_pack("dex").unwrap();
        let mut config = test_config();
        config.strategy_config = serde_json::json!({
            "qa_mode": "stochastic",
            "qa_trade_weights": {
                "no_trade": 0.5,
                "small_trade": 0.3,
                "big_trade": 0.2
            },
            "qa_allowed_directions": ["buy", "sell"]
        });
        let prompt = build_pack_loop_prompt(&pack, &config);

        assert!(
            prompt.contains("qa-stochastic-dex.js"),
            "qa-enabled dex loop must use the stochastic QA tool"
        );
        assert!(
            prompt.contains("Do not place any additional discretionary trades"),
            "qa-enabled dex loop must prevent extra discretionary trades"
        );
        assert!(
            prompt.contains("no-trade 50%"),
            "qa-enabled dex loop must surface configured weights"
        );
    }

    #[test]
    fn test_research_prompt_uses_candle_fetch_and_walk_forward_schema() {
        let prompt = build_research_tick_prompt(&test_config());

        assert!(
            prompt.contains("/market-data/candles/fetch"),
            "research prompt must fetch candles with the fetch endpoint"
        );
        assert!(
            prompt.contains("/market-data/candles?token=ETH&limit=200"),
            "research prompt must read stored candles with GET"
        );
        assert!(
            prompt.contains("\"current\": <current_harness>"),
            "research prompt must use the backtest current field"
        );
        assert!(
            prompt.contains("\"candidate\": <mutation>"),
            "research prompt must use the backtest candidate field"
        );
        assert!(
            !prompt.contains("current_config"),
            "research prompt must not use stale current_config schema"
        );
        assert!(
            !prompt.contains("{\"token\":\"ETH\",\"limit\":200}"),
            "research prompt must not use stale candle POST schema"
        );
    }

    #[test]
    fn test_research_prompt_is_strategy_specific_for_yield() {
        let mut config = test_config();
        config.strategy_type = "yield".to_string();
        let prompt = build_research_tick_prompt(&config);

        assert!(
            prompt.contains("aave-reserve-status.js"),
            "yield research prompt must focus on Aave reserve tooling"
        );
        assert!(
            prompt.contains("Do not test prediction-market-only tools"),
            "yield research prompt must avoid irrelevant prediction-market tools"
        );
    }

    #[test]
    fn test_build_system_prompt_volatility() {
        let prompt = build_system_prompt("volatility", &test_config());
        assert!(
            prompt.contains("volatility"),
            "must include volatility fragment"
        );
        assert!(
            prompt.contains("delta-neutral"),
            "must mention delta-neutral"
        );
    }

    #[test]
    fn test_build_system_prompt_mm() {
        let prompt = build_system_prompt("mm", &test_config());
        assert!(prompt.contains("market making"), "must include mm fragment");
        assert!(prompt.contains("inventory"), "must mention inventory");
    }

    #[test]
    fn test_build_system_prompt_yield_mentions_aave_reserve_status() {
        let prompt = build_system_prompt("yield", &test_config());
        assert!(
            prompt.contains("aave-reserve-status.js"),
            "yield system prompt should mention live Aave reserve status tool"
        );
        assert!(
            prompt.contains("Execution RPC"),
            "yield system prompt should surface execution RPC context"
        );
    }
}
