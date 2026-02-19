pub mod packs;

pub use packs::build_generic_agent_profile;

/// Build a full sidecar agent profile from a strategy pack.
pub fn build_pack_agent_profile(
    pack: &packs::StrategyPack,
    config: &crate::state::TradingBotRecord,
) -> serde_json::Value {
    pack.build_agent_profile(config)
}

/// Phase-aware loop prompt that drives the agent's iteration cycle.
pub fn build_pack_loop_prompt(pack: &packs::StrategyPack) -> String {
    let timeout_secs = pack.timeout_ms / 1000;
    format!(
        "Trading iteration tick. Strategy: {name}.\n\n\
         1. Read /home/agent/state/phase.json for current phase and iteration.\n\
         2. Review your learning history before acting:\n\
            - `sqlite3 /home/agent/data/trading.db \"SELECT category, insight, confidence, times_confirmed FROM memory ORDER BY updated_at DESC LIMIT 10\"`\n\
            - Read /home/agent/memory/insights.jsonl (last 20 lines) for recent insights.\n\
            - Check recent signal accuracy: `sqlite3 /home/agent/data/trading.db \"SELECT type, direction, outcome, confidence FROM signals ORDER BY created_at DESC LIMIT 10\"`\n\n\
         Phase protocol:\n\
         - bootstrap (iteration 0): Build tools, discover markets, populate DB → set \"research\"\n\
         - research: Run scanners, update data, generate signals. Use past signal accuracy to weight new signals. → \"trading\" if actionable signals found\n\
         - trading: Circuit breaker → validate → execute → log → \"reflect\"\n\
         - reflect: P&L calc, compare predictions vs outcomes, update signal outcomes in DB, write insights to memory table + insights.jsonl → \"research\"\n\n\
         Update phase.json after. Write metrics to /home/agent/metrics/latest.json.\n\
         You have {max_turns} turns and {timeout}s. Run existing tools, don't rebuild.",
        name = pack.name,
        max_turns = pack.max_turns,
        timeout = timeout_secs,
    )
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
- POST /execute — Execute an approved trade on-chain
  Body: {{ "intent": {{...}}, "validation": {{...}} }}
- POST /circuit-breaker/check — Check if circuit breaker is triggered
  Body: {{ "max_drawdown_pct": 10.0 }}
- GET /adapters — List available protocol adapters

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

    format!("{base}\n## Strategy\n{strategy_fragment}")
}

/// Build the loop iteration prompt sent by cron workflow.
pub fn build_loop_prompt(strategy_type: &str) -> String {
    format!(
        "Execute one trading loop iteration for your {strategy_type} strategy.\n\n\
         Before acting, review your learning history:\n\
         - Read /home/agent/state/phase.json for current phase\n\
         - `sqlite3 /home/agent/data/trading.db \"SELECT category, insight, confidence FROM memory ORDER BY updated_at DESC LIMIT 10\"`\n\
         - Read /home/agent/memory/insights.jsonl (last 20 lines)\n\n\
         Then follow your system instructions:\n\
         1. Fetch current market prices\n\
         2. Check portfolio state\n\
         3. Check circuit breaker\n\
         4. Analyze market conditions (weight signals by past accuracy)\n\
         5. Generate and validate trade intents if conditions warrant\n\
         6. Execute approved trades\n\
         7. Log trade decisions with reasoning to /home/agent/logs/decisions.jsonl\n\
         8. Write metrics to /home/agent/metrics/latest.json\n\
         9. Report results as JSON"
    )
}

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
Focus on: event-based trading on prediction markets.
Target protocols: polymarket
Look for: mispriced events, arbitrage between markets, information edges."#;

pub(crate) const VOLATILITY_FRAGMENT: &str = r#"You are a volatility trading specialist.
Focus on: realized vs implied volatility spreads, delta-neutral strategies.
Target protocols: polymarket, gmx_v2, vertex, uniswap_v3
Look for: vol regime changes, funding rate extremes, cross-protocol hedging opportunities."#;

pub(crate) const MM_FRAGMENT: &str = r#"You are a market making specialist.
Focus on: providing two-sided liquidity, inventory management, spread optimization.
Target protocols: polymarket, uniswap_v3
Look for: liquid markets with wide spreads, stable fair value, mean-reverting inventory."#;

const MULTI_FRAGMENT: &str = r#"You are a multi-strategy trading agent.
Use all available protocols and strategies. Dynamically allocate capital based on market conditions.
Available protocols: uniswap_v3, aave_v3, gmx_v2, morpho, vertex, polymarket
Strategies to consider: momentum, mean reversion, yield optimization, arbitrage, event-driven."#;

#[cfg(test)]
mod tests {
    use super::*;

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
            trading_loop_cron: String::new(),
        }
    }

    #[test]
    fn test_loop_prompt_is_phase_aware() {
        let pack = packs::get_pack("prediction").unwrap();
        let prompt = build_pack_loop_prompt(&pack);

        assert!(prompt.contains("phase.json"), "loop prompt must reference phase.json");
        assert!(prompt.contains("bootstrap"), "loop prompt must mention bootstrap phase");
        assert!(prompt.contains("research"), "loop prompt must mention research phase");
        assert!(prompt.contains("trading"), "loop prompt must mention trading phase");
        assert!(prompt.contains("reflect"), "loop prompt must mention reflect phase");
        assert!(prompt.contains("20 turns"), "loop prompt must include max_turns");
        assert!(prompt.contains("insights.jsonl"), "loop prompt must reference insights");
        assert!(prompt.contains("memory"), "loop prompt must reference memory table");
        assert!(prompt.contains("signal accuracy"), "loop prompt must reference signal accuracy");
    }

    #[test]
    fn test_build_system_prompt_volatility() {
        let prompt = build_system_prompt("volatility", &test_config());
        assert!(prompt.contains("volatility"), "must include volatility fragment");
        assert!(prompt.contains("delta-neutral"), "must mention delta-neutral");
    }

    #[test]
    fn test_build_system_prompt_mm() {
        let prompt = build_system_prompt("mm", &test_config());
        assert!(prompt.contains("market making"), "must include mm fragment");
        assert!(prompt.contains("inventory"), "must mention inventory");
    }
}
