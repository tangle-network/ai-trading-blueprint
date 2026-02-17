use serde_json::{Value, json};

use crate::providers::{EventContext, TradingProvider, registry};

/// Strategy Pack — self-contained strategy definition with expert-level protocol
/// knowledge, setup commands, and tuned defaults.
///
/// Packs compose multiple [`TradingProvider`]s.  The `system_prompt` field is
/// populated by joining each provider's expert prompt with the pack's
/// cross-protocol `strategy_methodology`.
#[derive(Clone, Debug)]
pub struct StrategyPack {
    pub strategy_type: String,
    pub name: String,
    /// Expert-level system prompt with protocol APIs, contract addresses, and
    /// trading methodology.  Injected as `backend.profile.systemPrompt` in the
    /// sidecar agent session.
    ///
    /// Composed from providers + strategy_methodology.
    pub system_prompt: String,
    /// Shell commands to run inside the sidecar before the first trading loop
    /// (e.g. `pip install py-clob-client`).
    pub setup_commands: Vec<String>,
    /// Env vars the pack expects (informational — logged as warnings if absent).
    pub required_env_vars: Vec<String>,
    /// Override max_turns for this strategy (0 = use default 10).
    pub max_turns: u64,
    /// Override timeout_ms for this strategy (0 = use default 120_000).
    pub timeout_ms: u64,
    /// Default cron expression when the user didn't specify one.
    pub default_cron: String,

    // ── New fields ──────────────────────────────────────────────────────

    /// Which providers compose this strategy.
    pub provider_ids: Vec<&'static str>,
    /// Cross-protocol strategy logic that doesn't belong to any single provider.
    pub strategy_methodology: String,
}

/// Look up a strategy pack by type.  Returns `None` for unknown types, which
/// causes provision to fall back to the generic loop prompt.
pub fn get_pack(strategy_type: &str) -> Option<StrategyPack> {
    match strategy_type {
        "prediction" => Some(polymarket_pack()),
        "dex" => Some(dex_pack()),
        "yield" => Some(yield_pack()),
        "perp" => Some(perp_pack()),
        "volatility" => Some(volatility_pack()),
        "mm" => Some(mm_pack()),
        "multi" => Some(multi_pack()),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Composition helpers
// ---------------------------------------------------------------------------

/// Join provider expert prompts with the pack's cross-protocol methodology.
fn compose_expert_prompt(provider_ids: &[&str], methodology: &str) -> String {
    let reg = registry();
    let mut sections: Vec<&str> = provider_ids
        .iter()
        .filter_map(|id| reg.get(id).map(|p| p.expert_prompt()))
        .collect();
    if !methodology.is_empty() {
        sections.push(methodology);
    }
    sections.join("\n\n")
}

/// Collect setup commands from providers (deduped), prepended with common setup.
fn compose_setup_commands(provider_ids: &[&str]) -> Vec<String> {
    let reg = registry();
    let mut cmds = common_setup_commands();
    let mut seen = std::collections::HashSet::new();
    for id in provider_ids {
        if let Some(p) = reg.get(id) {
            for cmd in p.setup_commands() {
                if seen.insert(cmd.clone()) {
                    cmds.push(cmd);
                }
            }
        }
    }
    cmds
}

/// Collect required env vars from providers (deduped).
fn compose_required_env_vars(provider_ids: &[&str]) -> Vec<String> {
    let reg = registry();
    let mut vars = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for id in provider_ids {
        if let Some(p) = reg.get(id) {
            for var in p.required_env_vars() {
                if seen.insert(*var) {
                    vars.push(var.to_string());
                }
            }
        }
    }
    vars
}

// ---------------------------------------------------------------------------
// StrategyPack convenience methods
// ---------------------------------------------------------------------------

impl StrategyPack {
    /// Get the provider implementations for this pack's provider_ids.
    pub fn providers(&self) -> Vec<&dyn TradingProvider> {
        let reg = registry();
        self.provider_ids
            .iter()
            .filter_map(|id| reg.get(id))
            .collect()
    }

    /// Try each provider's `build_event_prompt` in order.  Returns the first
    /// `Some` result, or `None` if no provider handles this event type.
    pub fn build_event_prompt(
        &self,
        event_type: &str,
        data: &Value,
        bot: &crate::state::TradingBotRecord,
    ) -> Option<String> {
        let ctx = EventContext {
            event_type,
            data,
            strategy_config: &bot.strategy_config,
            risk_params: &bot.risk_params,
        };
        for provider in self.providers() {
            if let Some(prompt) = provider.build_event_prompt(&ctx) {
                return Some(prompt);
            }
        }
        None
    }

    /// Build a full sidecar agent profile using `resources.instructions` instead
    /// of `systemPrompt`. This preserves the sidecar's default coding identity
    /// while appending expert trading knowledge.
    pub fn build_agent_profile(&self, config: &crate::state::TradingBotRecord) -> Value {
        let instructions = build_profile_instructions(
            &self.strategy_type,
            &self.system_prompt,
            config,
        );
        json!({
            "name": format!("trading-{}", self.strategy_type),
            "description": self.name,
            "resources": {
                "instructions": {
                    "content": instructions,
                    "name": "trading-instructions.md"
                }
            },
            "permission": {
                "edit": "allow",
                "bash": "allow",
                "webfetch": "allow",
                "mcp": "allow"
            },
            "memory": { "enabled": true }
        })
    }
}

// ---------------------------------------------------------------------------
// Shared bootstrap system
// ---------------------------------------------------------------------------

/// Setup commands prepended to every strategy pack.  Creates the agent workspace,
/// SQLite database with shared schema, and phase tracker.
fn common_setup_commands() -> Vec<String> {
    vec![
        "pip install requests pandas sqlite-utils 2>/dev/null".to_string(),
        "mkdir -p /home/agent/{tools,data,memory,metrics,logs,state}".to_string(),
        concat!(
            "python3 -c \"",
            "import sqlite3, os; ",
            "db = sqlite3.connect('/home/agent/data/trading.db'); ",
            "c = db.cursor(); ",
            "c.execute('CREATE TABLE IF NOT EXISTS markets (id TEXT PRIMARY KEY, source TEXT, symbol TEXT, name TEXT, price REAL, volume REAL, liquidity REAL, metadata TEXT, discovered_at TEXT, updated_at TEXT)'); ",
            "c.execute('CREATE TABLE IF NOT EXISTS trades (id INTEGER PRIMARY KEY AUTOINCREMENT, market_id TEXT, action TEXT, protocol TEXT, amount REAL, price REAL, tx_hash TEXT, paper_trade INTEGER, pnl REAL, created_at TEXT, closed_at TEXT)'); ",
            "c.execute('CREATE TABLE IF NOT EXISTS signals (id INTEGER PRIMARY KEY AUTOINCREMENT, market_id TEXT, type TEXT, direction TEXT, confidence REAL, acted_on INTEGER DEFAULT 0, outcome TEXT, created_at TEXT)'); ",
            "c.execute('CREATE TABLE IF NOT EXISTS performance (id INTEGER PRIMARY KEY AUTOINCREMENT, metric TEXT, value REAL, context TEXT, recorded_at TEXT)'); ",
            "c.execute('CREATE TABLE IF NOT EXISTS memory (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT, insight TEXT, confidence REAL, times_confirmed INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT)'); ",
            "db.commit(); db.close(); ",
            "print('DB initialized')\"",
        ).to_string(),
        concat!(
            "python3 -c \"",
            "import json, os; ",
            "p = '/home/agent/state/phase.json'; ",
            "d = {'current': 'bootstrap', 'iteration': 0, 'last_trade_at': None, 'tools_built': []}; ",
            "existing = None; ",
            "try:\n",
            "  existing = json.load(open(p))\n",
            "except: pass\n",
            "if existing is None: json.dump(d, open(p, 'w'), indent=2); print('Phase tracker created')\n",
            "else: print('Phase tracker exists at iteration', existing.get('iteration', '?'))\"",
        ).to_string(),
    ]
}

// ---------------------------------------------------------------------------
// Strategy packs
// ---------------------------------------------------------------------------

fn polymarket_pack() -> StrategyPack {
    let providers = vec!["polymarket", "coingecko"];
    let methodology = "";
    StrategyPack {
        strategy_type: "prediction".into(),
        name: "Polymarket Prediction Trading".into(),
        provider_ids: providers.clone(),
        strategy_methodology: methodology.into(),
        system_prompt: compose_expert_prompt(&providers, methodology),
        setup_commands: compose_setup_commands(&providers),
        required_env_vars: compose_required_env_vars(&providers),
        max_turns: 20,
        timeout_ms: 240_000,
        default_cron: "0 */3 * * * *".into(),
    }
}

fn dex_pack() -> StrategyPack {
    let providers = vec!["uniswap_v3", "coingecko"];
    let methodology = "";
    StrategyPack {
        strategy_type: "dex".into(),
        name: "DEX Spot Trading".into(),
        provider_ids: providers.clone(),
        strategy_methodology: methodology.into(),
        system_prompt: compose_expert_prompt(&providers, methodology),
        setup_commands: compose_setup_commands(&providers),
        required_env_vars: compose_required_env_vars(&providers),
        max_turns: 12,
        timeout_ms: 150_000,
        default_cron: "0 */5 * * * *".into(),
    }
}

fn yield_pack() -> StrategyPack {
    let providers = vec!["aave_v3", "morpho", "coingecko"];
    let methodology = "";
    StrategyPack {
        strategy_type: "yield".into(),
        name: "DeFi Yield Optimization".into(),
        provider_ids: providers.clone(),
        strategy_methodology: methodology.into(),
        system_prompt: compose_expert_prompt(&providers, methodology),
        setup_commands: compose_setup_commands(&providers),
        required_env_vars: compose_required_env_vars(&providers),
        max_turns: 10,
        timeout_ms: 120_000,
        default_cron: "0 */15 * * * *".into(),
    }
}

fn perp_pack() -> StrategyPack {
    let providers = vec!["gmx_v2", "hyperliquid", "vertex", "coingecko"];
    let methodology = PERP_STRATEGY_METHODOLOGY;
    StrategyPack {
        strategy_type: "perp".into(),
        name: "Perpetual Futures Trading".into(),
        provider_ids: providers.clone(),
        strategy_methodology: methodology.into(),
        system_prompt: compose_expert_prompt(&providers, methodology),
        setup_commands: compose_setup_commands(&providers),
        required_env_vars: compose_required_env_vars(&providers),
        max_turns: 15,
        timeout_ms: 180_000,
        default_cron: "0 */2 * * * *".into(),
    }
}

fn volatility_pack() -> StrategyPack {
    let providers = vec![
        "polymarket",
        "uniswap_v3",
        "gmx_v2",
        "hyperliquid",
        "vertex",
        "coingecko",
    ];
    let methodology = VOLATILITY_STRATEGY_METHODOLOGY;
    StrategyPack {
        strategy_type: "volatility".into(),
        name: "Volatility Trading".into(),
        provider_ids: providers.clone(),
        strategy_methodology: methodology.into(),
        system_prompt: compose_expert_prompt(&providers, methodology),
        setup_commands: compose_setup_commands(&providers),
        required_env_vars: compose_required_env_vars(&providers),
        max_turns: 12,
        timeout_ms: 150_000,
        default_cron: "0 */10 * * * *".into(),
    }
}

fn mm_pack() -> StrategyPack {
    let providers = vec!["polymarket", "hyperliquid", "uniswap_v3", "coingecko"];
    let methodology = MM_STRATEGY_METHODOLOGY;
    StrategyPack {
        strategy_type: "mm".into(),
        name: "Market Making".into(),
        provider_ids: providers.clone(),
        strategy_methodology: methodology.into(),
        system_prompt: compose_expert_prompt(&providers, methodology),
        setup_commands: compose_setup_commands(&providers),
        required_env_vars: compose_required_env_vars(&providers),
        max_turns: 15,
        timeout_ms: 180_000,
        default_cron: "0 */1 * * * *".into(),
    }
}

fn multi_pack() -> StrategyPack {
    let providers = vec![
        "polymarket",
        "uniswap_v3",
        "aave_v3",
        "morpho",
        "gmx_v2",
        "hyperliquid",
        "vertex",
        "coingecko",
    ];
    let methodology = MULTI_STRATEGY_METHODOLOGY;
    StrategyPack {
        strategy_type: "multi".into(),
        name: "Cross-Strategy Trading".into(),
        provider_ids: providers.clone(),
        strategy_methodology: methodology.into(),
        system_prompt: compose_expert_prompt(&providers, methodology),
        setup_commands: compose_setup_commands(&providers),
        required_env_vars: compose_required_env_vars(&providers),
        max_turns: 20,
        timeout_ms: 300_000,
        default_cron: "0 */5 * * * *".into(),
    }
}

// ---------------------------------------------------------------------------
// Strategy methodology consts — cross-protocol logic that doesn't belong to
// any single provider.
// ---------------------------------------------------------------------------

const PERP_STRATEGY_METHODOLOGY: &str = r#"## Cross-Venue Perpetual Futures Strategy

### Cross-Venue Funding Rate Arbitrage

When funding rates diverge between GMX and Hyperliquid:
1. Long on the venue with negative funding (you get paid)
2. Short on the venue with positive funding (you get paid)
3. Net delta-neutral, collect funding from both sides
4. Minimum spread: 0.03%/8h to cover execution costs
"#;

const VOLATILITY_STRATEGY_METHODOLOGY: &str = r#"## Volatility Trading Strategy

### Implied Volatility Proxies

Crypto markets lack traditional options IV. Use these proxies:
- **Funding rates** from Hyperliquid: High absolute funding = high implied vol
- **Prediction market spreads**: Wide bid-ask spreads on Polymarket crypto markets indicate uncertainty
- **Price momentum**: Rapid price changes (>3% in 1h) signal vol regime change

### Vol Trading Strategies

**Long Volatility** (when realized vol < implied proxies):
- Buy both YES and NO sides of crypto prediction markets near 50/50 split (Polymarket)
- Long perpetual positions with tight stops — capture large moves in either direction
- Use small position sizes (2% each side max)

**Short Volatility** (when realized vol > implied proxies):
- Sell prediction market positions far from 50/50 (>75% or <25%) — collect theta decay
- Provide liquidity on DEX pools (earn fees in low-vol environment)
- Collect high funding on perps by taking the less-crowded side

### Delta Hedging

Maintain delta-neutral exposure:
- Calculate net delta across all positions (prediction + perp + spot)
- Hedge via Uniswap V3 spot trades to bring net delta near zero
- Re-hedge when delta drifts beyond ±5% of portfolio

### Risk Limits

- Maximum 5% of portfolio in volatility trades
- Always maintain delta-neutral (net delta < ±5% of portfolio value)
- Stop-loss: exit all vol positions if session drawdown exceeds 3%
- Rebalance delta hedge every iteration
"#;

const MM_STRATEGY_METHODOLOGY: &str = r#"## Market Making Strategy

### Market Selection

Select 3-5 markets for active market making based on:
1. **Liquidity**: Daily volume > $100k
2. **Spread**: Current spread < 3% (room to quote inside)
3. **Volatility**: Moderate vol — too high = adverse selection risk, too low = no spread to capture
4. **Decay**: For prediction markets, prefer markets expiring in 7-90 days

Scan markets every 10 iterations using Gamma API and Hyperliquid metadata.

### Fair Value Estimation

1. Fetch current order book (bids + asks)
2. Midpoint = (best_bid + best_ask) / 2
3. Adjust for recent trade flow:
   - Net buy flow → fair value slightly above midpoint
   - Net sell flow → fair value slightly below midpoint
4. For prediction markets, cross-reference with fundamental probability estimate

### Inventory Management

- Maximum 10% of portfolio per market
- Target inventory: 0 (flat). Use 2-hour half-life to mean-revert inventory:
  `skew = inventory_value / max_inventory_per_market`
- Shift quotes: move midpoint by `skew * base_spread` toward reducing inventory
- If inventory exceeds 15% in one market, stop quoting that side until rebalanced

### Spread Calculation

Base spread depends on market conditions:
- Low vol, balanced inventory: tight spread (0.5-1%)
- High vol: widen by vol_multiplier (spread * (1 + realized_vol/100))
- Skewed inventory: shift quotes to reduce inventory (see above)
- Minimum spread: must cover fees + expected adverse selection

### Circuit Breakers for Market Making

- Stop quoting if session drawdown exceeds 2%
- Pause a specific market if 3 consecutive trades hit your quotes adversely
- Reduce position sizes by 50% if portfolio drawdown exceeds 1% in 1 hour
- Halt all activity during high-impact events (check prediction market metadata for scheduled events)

### Execution

Quote both sides simultaneously via two trade intents:
- BUY intent at `fair_value - spread/2`
- SELL intent at `fair_value + spread/2`
- Use small sizes (1-2% of portfolio per quote)
- Refresh quotes every iteration (cancel stale, place new)
"#;

const MULTI_STRATEGY_METHODOLOGY: &str = r#"## Cross-Strategy Trading

### Capital Allocation Model

Default allocation (adjust based on market conditions):
- 30% — Prediction markets (Polymarket)
- 25% — DeFi yield (Aave V3, Morpho)
- 25% — Perpetual futures (GMX V2, Vertex)
- 20% — Spot / DEX arbitrage (Uniswap V3)

Rebalance weekly based on Sharpe ratio per strategy:
- Strategy Sharpe > 1.5: increase allocation by 5%
- Strategy Sharpe < 0.5: decrease allocation by 5%
- Never allocate more than 40% or less than 10% to any single strategy

### Cross-Strategy Signal Integration

Signals from one strategy should inform others:
- **Crypto prices** (CoinGecko/DexScreener) → Evaluate prediction market crypto bets
- **Yield data** (DeFiLlama) → Guide capital allocation between strategies
- **Funding rates** (Hyperliquid/GMX) → Directional bias for perps AND prediction markets
- **Volatility spikes** → Reduce exposure across ALL strategies, increase cash buffer

### Daily Routine

1. **Morning scan** (first iteration of day): Fetch all data sources, update markets table, check all positions
2. **Signal generation**: Run all scanner tools, generate cross-strategy signals
3. **Portfolio review**: Check allocation vs targets, identify rebalancing needs
4. **Execution**: Execute highest-conviction trades first, respect per-strategy limits
5. **Evening reflect** (last iteration): Full P&L calculation, strategy Sharpe update, write daily summary

### Risk Management (Portfolio-Wide)

- Maximum 3% daily drawdown across all strategies combined
- Per-strategy drawdown limit: 5% of that strategy's allocation
- Correlation check: don't take correlated positions across strategies (e.g. long ETH spot + long ETH perp = 2x exposure)
- Cash buffer: always keep 10% in stablecoins for opportunities
"#;

// ---------------------------------------------------------------------------
// Profile building
// ---------------------------------------------------------------------------

/// Build instructions markdown that combines identity, workspace, API config,
/// iteration protocol, tool building, data APIs, expert strategy knowledge,
/// and operational mandates.
fn build_profile_instructions(
    strategy_type: &str,
    expert_prompt: &str,
    config: &crate::state::TradingBotRecord,
) -> String {
    let risk_params = serde_json::to_string_pretty(&config.risk_params).unwrap_or_default();

    let paper_mode_note = if config.paper_trade {
        "You are currently in PAPER TRADE mode. Trades are logged but not executed on-chain. \
         Focus on building good analysis tools and tracking your simulated P&L."
    } else {
        "You are in LIVE TRADE mode. Trades will be executed on-chain. \
         Exercise maximum caution and always verify before executing."
    };

    format!(
        r#"# Trading Agent Instructions

## Identity & Autonomy

You are an autonomous trading agent — a coding agent that writes Python scripts, manages its own SQLite database, and iterates on its tools. You are NOT a chatbot. You act.

You have a persistent workspace at /home/agent/ that survives across iterations. You build tools, discover markets, track performance, and improve your approach over time. Every iteration should leave your workspace in a better state than you found it.

Workspace layout:
```
/home/agent/
├── data/trading.db        # SQLite — all persistent data
├── tools/                 # Your Python scripts (scanner, analyzer, tracker)
├── memory/insights.jsonl  # Append-only learning log
├── metrics/latest.json    # Current metrics (read by /metrics endpoint)
├── logs/decisions.jsonl   # Trade decision log
└── state/phase.json       # Current phase + iteration counter
```

## Iteration Protocol

Read `/home/agent/state/phase.json` at the start of every iteration. Follow the phase protocol:

- **bootstrap** (iteration 0): Install packages, build core tools (market scanner, signal analyzer, trade tracker), discover initial markets, populate the DB. Then set phase to "research".
- **research**: Run your scanner tools, update market data in the DB, generate signals. If actionable signals found, set phase to "trading". Otherwise increment iteration and stay in "research".
- **trading**: Check circuit breaker first. Validate trade intents, execute approved trades, log results to the DB. Then set phase to "reflect".
- **reflect**: Calculate P&L from recent trades. Compare your signal predictions vs actual outcomes. Write insights to memory table and insights.jsonl. Set phase to "research".

After each iteration, update `phase.json` with the new phase and incremented iteration count.

## Tool Building Guidelines

Build standalone Python scripts in `/home/agent/tools/`. Each tool should:
- Accept command-line arguments (e.g. `python3 tools/scanner.py --source coingecko --limit 50`)
- Output JSON to stdout for easy parsing
- Use SQLite (`/home/agent/data/trading.db`) for persistence
- Handle errors gracefully — print error JSON, don't crash
- Be idempotent — safe to re-run

On subsequent iterations, run existing tools rather than rebuilding them. Only modify tools when you identify a concrete improvement.

## Common Data APIs

These free APIs are available for market discovery and analysis:

| API | Endpoint | Auth | Use |
|-----|----------|------|-----|
| CoinGecko | `https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin&vs_currencies=usd` | None (30 req/min) | Crypto prices |
| CoinGecko | `https://api.coingecko.com/api/v3/coins/{{id}}/market_chart?vs_currency=usd&days=30` | None | Price history |
| DeFiLlama | `https://yields.llama.fi/pools` | None | DeFi pool yields |
| DeFiLlama | `https://api.llama.fi/protocol/{{name}}` | None | Protocol TVL |
| DexScreener | `https://api.dexscreener.com/latest/dex/tokens/{{address}}` | None | DEX pair data |
| DexScreener | `https://api.dexscreener.com/latest/dex/pairs/{{chain}}/{{pair_address}}` | None | Specific pair |

## Trading HTTP API

Base URL: {api_url}
Authorization: Bearer {token}

Endpoints:
- POST /market-data/prices — Get current token prices. Body: {{"tokens": ["ETH", "BTC"]}}
- POST /portfolio/state — Get current portfolio positions
- POST /validate — Submit a trade intent for validator approval
  Body: {{"strategy_id": "...", "action": "swap", "token_in": "0x...", "token_out": "0x...", "amount_in": "1000", "min_amount_out": "950", "target_protocol": "uniswap_v3"}}
- POST /execute — Execute an approved trade on-chain
  Body: {{"intent": {{...}}, "validation": {{...}}}}
- POST /circuit-breaker/check — Check if circuit breaker is triggered
  Body: {{"max_drawdown_pct": 10.0}}
- GET /adapters — List available protocol adapters
- GET /metrics — Get bot metrics and paper trade status

## Configuration

- Vault Address: {vault}
- Chain ID: {chain_id}
- Strategy: {strategy_type}

## Risk Parameters

{risk_params}

## Expert Strategy Knowledge

{expert_prompt}

## Operational Mandates

1. **Metrics**: Write metrics to /home/agent/metrics/latest.json every iteration:
   {{"timestamp": "<ISO8601>", "iteration": <n>, "portfolio_value_usd": <f64>, "pnl_pct": <f64>, "trades_executed": <n>, "strategy": "{strategy_type}", "signals_generated": <n>, "phase": "<current_phase>", "errors": []}}

2. **Iteration**: Before each run, check /home/agent/tools/ for existing scripts. Run them, don't rebuild. Log every trade decision to /home/agent/logs/decisions.jsonl with reasoning.

3. **Safety**: Always check the circuit breaker before executing trades. Never exceed risk parameters. If uncertain, skip the trade and log why.

4. **Mode**: {paper_mode_note}

5. **Learning**: After every trade outcome (win or loss), write an insight to the memory table. Track which signal types are most accurate. Adjust your approach based on data, not intuition."#,
        api_url = config.trading_api_url,
        token = config.trading_api_token,
        vault = config.vault_address,
        chain_id = config.chain_id,
    )
}

/// Build a generic agent profile for strategy types without a dedicated pack.
/// Still gets workspace awareness and base API info.
pub fn build_generic_agent_profile(
    strategy_type: &str,
    config: &crate::state::TradingBotRecord,
) -> Value {
    // Try to build a strategy fragment from providers
    let strategy_fragment = match strategy_type {
        "dex" => super::DEX_FRAGMENT,
        "yield" => super::YIELD_FRAGMENT,
        "perp" => super::PERP_FRAGMENT,
        "prediction" => super::PREDICTION_FRAGMENT,
        "volatility" => super::VOLATILITY_FRAGMENT,
        "mm" => super::MM_FRAGMENT,
        _ => super::MULTI_FRAGMENT,
    };
    let instructions = build_profile_instructions(strategy_type, strategy_fragment, config);
    json!({
        "name": format!("trading-{}", strategy_type),
        "description": format!("{} trading agent", strategy_type),
        "resources": {
            "instructions": {
                "content": instructions,
                "name": "trading-instructions.md"
            }
        },
        "permission": {
            "edit": "allow",
            "bash": "allow",
            "webfetch": "allow",
            "mcp": "allow"
        },
        "memory": { "enabled": true }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_pack_known_types() {
        assert!(get_pack("prediction").is_some());
        assert!(get_pack("dex").is_some());
        assert!(get_pack("yield").is_some());
        assert!(get_pack("perp").is_some());
        assert!(get_pack("volatility").is_some());
        assert!(get_pack("mm").is_some());
        assert!(get_pack("multi").is_some());
    }

    #[test]
    fn test_get_pack_unknown_returns_none() {
        assert!(get_pack("unknown").is_none());
        assert!(get_pack("").is_none());
    }

    #[test]
    fn test_polymarket_pack_has_api_urls() {
        let pack = get_pack("prediction").unwrap();
        assert!(pack.system_prompt.contains("gamma-api.polymarket.com"));
        assert!(pack.system_prompt.contains("clob.polymarket.com"));
        assert!(pack.system_prompt.contains("0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E"));
        assert!(pack.system_prompt.contains("0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"));
    }

    #[test]
    fn test_dex_pack_has_uniswap_addresses() {
        let pack = get_pack("dex").unwrap();
        assert!(pack.system_prompt.contains("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")); // WETH
        assert!(pack.system_prompt.contains("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")); // USDC
        assert!(pack.system_prompt.contains("uniswap_v3"));
    }

    #[test]
    fn test_yield_pack_has_aave_addresses() {
        let pack = get_pack("yield").unwrap();
        assert!(pack.system_prompt.contains("0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2")); // Aave Pool
        assert!(pack.system_prompt.contains("Morpho"));
    }

    #[test]
    fn test_perp_pack_has_gmx_addresses() {
        let pack = get_pack("perp").unwrap();
        assert!(pack.system_prompt.contains("0x7C68C7866A64FA2160F78EEaE12217FFbf871fa8")); // GMX Router
        assert!(pack.system_prompt.contains("Vertex"));
    }

    #[test]
    fn test_volatility_pack_has_data_apis() {
        let pack = get_pack("volatility").unwrap();
        assert!(pack.system_prompt.contains("api.coingecko.com"));
        assert!(pack.system_prompt.contains("api.hyperliquid.xyz"));
        // Volatility methodology content
        assert!(pack.system_prompt.contains("realized vol"));
    }

    #[test]
    fn test_mm_pack_has_order_book_apis() {
        let pack = get_pack("mm").unwrap();
        assert!(pack.system_prompt.contains("clob.polymarket.com"));
        assert!(pack.system_prompt.contains("l2Book"));
        assert!(pack.system_prompt.contains("inventory"));
    }

    #[test]
    fn test_multi_pack_has_all_protocols() {
        let pack = get_pack("multi").unwrap();
        for proto in &["uniswap_v3", "aave_v3", "gmx_v2", "morpho", "vertex", "polymarket"] {
            assert!(
                pack.system_prompt.contains(proto),
                "multi pack missing protocol: {proto}"
            );
        }
    }

    #[test]
    fn test_common_setup_creates_db() {
        let cmds = common_setup_commands();
        let joined = cmds.join(" ");
        assert!(joined.contains("trading.db"), "setup must create trading.db");
        assert!(joined.contains("CREATE TABLE"), "setup must create tables");
        assert!(joined.contains("phase.json"), "setup must create phase tracker");
    }

    #[test]
    fn test_all_packs_have_common_setup() {
        for pack_type in &["prediction", "dex", "yield", "perp", "volatility", "mm", "multi"] {
            let pack = get_pack(pack_type).unwrap();
            let joined = pack.setup_commands.join(" ");
            assert!(
                joined.contains("mkdir -p /home/agent/"),
                "{pack_type} pack missing mkdir"
            );
            assert!(
                joined.contains("sqlite3"),
                "{pack_type} pack missing sqlite setup"
            );
        }
    }

    fn test_config() -> crate::state::TradingBotRecord {
        crate::state::TradingBotRecord {
            id: "test".to_string(),
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
            secrets_configured: false,
            user_env_json: None,
        }
    }

    #[test]
    fn test_build_agent_profile_uses_instructions_not_system_prompt() {
        let pack = get_pack("prediction").unwrap();
        let profile = pack.build_agent_profile(&test_config());
        let obj = profile.as_object().unwrap();

        assert!(obj.get("systemPrompt").is_none(), "profile must not set systemPrompt");
        let resources = obj.get("resources").expect("profile must have resources");
        let instructions = resources.get("instructions").expect("resources must have instructions");
        assert!(instructions.get("content").is_some());
        assert_eq!(instructions["name"], "trading-instructions.md");
    }

    #[test]
    fn test_build_agent_profile_has_workspace_awareness() {
        let pack = get_pack("dex").unwrap();
        let profile = pack.build_agent_profile(&test_config());
        let content = profile["resources"]["instructions"]["content"].as_str().unwrap();

        assert!(content.contains("persistent"), "instructions must mention persistent workspace");
        assert!(content.contains("/home/agent/"), "instructions must reference /home/agent/");
        assert!(content.contains("coding agent"), "instructions must identify agent as a coding agent");
    }

    #[test]
    fn test_build_agent_profile_permissions() {
        let pack = get_pack("yield").unwrap();
        let profile = pack.build_agent_profile(&test_config());
        let perm = profile.get("permission").expect("profile must have permission");

        assert_eq!(perm["bash"], "allow");
        assert_eq!(perm["edit"], "allow");
        assert_eq!(perm["webfetch"], "allow");
        assert_eq!(perm["mcp"], "allow");
    }

    #[test]
    fn test_build_agent_profile_memory_enabled() {
        let pack = get_pack("perp").unwrap();
        let profile = pack.build_agent_profile(&test_config());

        assert_eq!(profile["memory"]["enabled"], true);
    }

    #[test]
    fn test_build_generic_agent_profile() {
        let profile = build_generic_agent_profile("multi", &test_config());
        let obj = profile.as_object().unwrap();

        assert!(obj.get("systemPrompt").is_none());
        let content = profile["resources"]["instructions"]["content"].as_str().unwrap();
        assert!(content.contains("/home/agent/"));
        assert!(content.contains("multi-strategy"));
        assert_eq!(profile["permission"]["bash"], "allow");
        assert_eq!(profile["memory"]["enabled"], true);
    }

    #[test]
    fn test_build_agent_profile_contains_api_config() {
        let pack = get_pack("prediction").unwrap();
        let config = test_config();
        let profile = pack.build_agent_profile(&config);
        let content = profile["resources"]["instructions"]["content"].as_str().unwrap();

        assert!(content.contains("http://test-api:9100"), "must contain API URL");
        assert!(content.contains("test-token"), "must contain bearer token");
        assert!(content.contains("0xVAULT"), "must contain vault address");
        assert!(content.contains("31337"), "must contain chain ID");
    }

    #[test]
    fn test_pack_defaults() {
        let poly = get_pack("prediction").unwrap();
        assert_eq!(poly.max_turns, 20);
        assert_eq!(poly.timeout_ms, 240_000);
        assert_eq!(poly.default_cron, "0 */3 * * * *");

        let dex = get_pack("dex").unwrap();
        assert_eq!(dex.max_turns, 12);
        assert_eq!(dex.timeout_ms, 150_000);
        assert_eq!(dex.default_cron, "0 */5 * * * *");

        let yld = get_pack("yield").unwrap();
        assert_eq!(yld.max_turns, 10);
        assert_eq!(yld.timeout_ms, 120_000);
        assert_eq!(yld.default_cron, "0 */15 * * * *");

        let perp = get_pack("perp").unwrap();
        assert_eq!(perp.max_turns, 15);
        assert_eq!(perp.timeout_ms, 180_000);
        assert_eq!(perp.default_cron, "0 */2 * * * *");

        let vol = get_pack("volatility").unwrap();
        assert_eq!(vol.max_turns, 12);
        assert_eq!(vol.timeout_ms, 150_000);
        assert_eq!(vol.default_cron, "0 */10 * * * *");

        let mm = get_pack("mm").unwrap();
        assert_eq!(mm.max_turns, 15);
        assert_eq!(mm.timeout_ms, 180_000);
        assert_eq!(mm.default_cron, "0 */1 * * * *");

        let multi = get_pack("multi").unwrap();
        assert_eq!(multi.max_turns, 20);
        assert_eq!(multi.timeout_ms, 300_000);
        assert_eq!(multi.default_cron, "0 */5 * * * *");
    }

    #[test]
    fn test_profile_instructions_have_autonomy() {
        let pack = get_pack("dex").unwrap();
        let profile = pack.build_agent_profile(&test_config());
        let content = profile["resources"]["instructions"]["content"].as_str().unwrap();

        assert!(content.contains("coding agent"), "must mention coding agent identity");
        assert!(content.contains("SQLite"), "must mention SQLite");
        assert!(content.contains("Iteration Protocol"), "must have iteration protocol");
        assert!(content.contains("phase.json"), "must reference phase tracker");
        assert!(content.contains("Tool Building"), "must have tool building section");
    }

    // ── New tests for provider composition ──────────────────────────────

    #[test]
    fn test_packs_have_provider_ids() {
        for pack_type in &["prediction", "dex", "yield", "perp", "volatility", "mm", "multi"] {
            let pack = get_pack(pack_type).unwrap();
            assert!(
                !pack.provider_ids.is_empty(),
                "{pack_type} pack has no provider_ids"
            );
        }
    }

    #[test]
    fn test_multi_pack_has_all_protocol_providers() {
        let pack = get_pack("multi").unwrap();
        for expected in &[
            "polymarket",
            "uniswap_v3",
            "aave_v3",
            "morpho",
            "gmx_v2",
            "hyperliquid",
            "vertex",
            "coingecko",
        ] {
            assert!(
                pack.provider_ids.contains(expected),
                "multi pack missing provider: {expected}"
            );
        }
    }

    #[test]
    fn test_composed_prompt_contains_provider_content() {
        let pack = get_pack("prediction").unwrap();
        let reg = registry();
        for id in &pack.provider_ids {
            if let Some(p) = reg.get(id) {
                // Each provider's expert prompt should appear in the composed system_prompt
                let snippet = &p.expert_prompt()[..50.min(p.expert_prompt().len())];
                assert!(
                    pack.system_prompt.contains(snippet),
                    "pack system_prompt missing content from provider {id}"
                );
            }
        }
    }

    #[test]
    fn test_pack_providers_method() {
        let pack = get_pack("perp").unwrap();
        let providers = pack.providers();
        assert!(!providers.is_empty());
        let ids: Vec<_> = providers.iter().map(|p| p.id()).collect();
        assert!(ids.contains(&"gmx_v2"));
        assert!(ids.contains(&"hyperliquid"));
        assert!(ids.contains(&"vertex"));
    }

    #[test]
    fn test_pack_build_event_prompt_polymarket() {
        let pack = get_pack("prediction").unwrap();
        let config = test_config();
        let prompt = pack.build_event_prompt(
            "price_move",
            &serde_json::json!({"market": "test"}),
            &config,
        );
        assert!(prompt.is_some(), "prediction pack should handle price_move");
        assert!(prompt.unwrap().contains("POLYMARKET"));
    }

    #[test]
    fn test_pack_build_event_prompt_fallback_none() {
        let pack = get_pack("yield").unwrap();
        let config = test_config();
        let prompt = pack.build_event_prompt(
            "completely_unknown_event_xyz",
            &serde_json::json!({}),
            &config,
        );
        assert!(prompt.is_none(), "yield pack should not handle unknown events");
    }

    #[test]
    fn test_perp_pack_has_cross_venue_methodology() {
        let pack = get_pack("perp").unwrap();
        assert!(pack.system_prompt.contains("Cross-Venue"));
        assert!(pack.system_prompt.contains("Funding Rate Arbitrage"));
    }

    #[test]
    fn test_volatility_pack_has_vol_methodology() {
        let pack = get_pack("volatility").unwrap();
        assert!(pack.system_prompt.contains("Implied Volatility Proxies"));
        assert!(pack.system_prompt.contains("Delta Hedging"));
    }

    #[test]
    fn test_mm_pack_has_mm_methodology() {
        let pack = get_pack("mm").unwrap();
        assert!(pack.system_prompt.contains("Fair Value Estimation"));
        assert!(pack.system_prompt.contains("Inventory Management"));
    }

    #[test]
    fn test_multi_pack_has_allocation_methodology() {
        let pack = get_pack("multi").unwrap();
        assert!(pack.system_prompt.contains("Capital Allocation Model"));
        assert!(pack.system_prompt.contains("Cross-Strategy Signal Integration"));
    }
}
