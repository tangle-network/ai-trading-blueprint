use serde_json::{Value, json};

use crate::providers::uniswap;
use crate::providers::{EventContext, TradingProvider, registry};

pub const PROFILE_INSTRUCTIONS_PATH: &str = ".opencode/profile-instructions.md";

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
    /// (e.g. `mkdir -p /home/agent/tools`).
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
    /// Composable instruction blocks injected into the agent profile.
    pub prompt_blocks: Vec<&'static str>,
}

/// Look up a strategy pack by type.  Returns `None` for unknown types, which
/// causes provision to fall back to the generic loop prompt.
pub fn get_pack(strategy_type: &str) -> Option<StrategyPack> {
    match strategy_type {
        "prediction" => Some(polymarket_pack()),
        "prediction_politics" => Some(polymarket_politics_pack()),
        "prediction_crypto" => Some(polymarket_crypto_pack()),
        "prediction_war" => Some(polymarket_war_pack()),
        "prediction_trending" => Some(polymarket_trending_pack()),
        "prediction_celebrity" => Some(polymarket_celebrity_pack()),
        "dex" => Some(dex_pack()),
        "yield" => Some(yield_pack()),
        "perp" => Some(perp_pack()),
        "hyperliquid_perp" => Some(hyperliquid_perp_pack()),
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

fn render_expert_prompt(pack: &StrategyPack, config: &crate::state::TradingBotRecord) -> String {
    let reg = registry();
    let mut sections = Vec::new();
    for id in &pack.provider_ids {
        let rendered = match *id {
            "uniswap_v3" => Some(uniswap::expert_prompt_for_chain(config.chain_id)),
            _ => reg
                .get(id)
                .map(|provider| provider.expert_prompt().to_string()),
        };
        if let Some(section) = rendered {
            sections.push(section);
        }
    }
    if !pack.strategy_methodology.is_empty() {
        sections.push(pack.strategy_methodology.clone());
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

#[derive(Clone, Debug)]
pub(crate) struct DexQaConfigSummary {
    pub no_trade_weight: f64,
    pub small_trade_weight: f64,
    pub big_trade_weight: f64,
    pub small_pct: f64,
    pub big_pct: f64,
    pub allowed_directions: Vec<String>,
    pub pair: String,
}

fn qa_numeric_field(value: Option<&Value>, default: f64, min: f64, max: f64) -> f64 {
    let parsed = match value {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.parse::<f64>().ok(),
        _ => None,
    }
    .unwrap_or(default);

    parsed.clamp(min, max)
}

pub(crate) fn dex_stochastic_qa_config(
    config: &crate::state::TradingBotRecord,
) -> Option<DexQaConfigSummary> {
    let qa_mode = config
        .strategy_config
        .get("qa_mode")
        .and_then(Value::as_str)
        .unwrap_or("off");
    if qa_mode != "stochastic" {
        return None;
    }

    let weights = config
        .strategy_config
        .get("qa_trade_weights")
        .and_then(Value::as_object);
    let no_trade_weight = qa_numeric_field(weights.and_then(|w| w.get("no_trade")), 0.4, 0.0, 1.0);
    let small_trade_weight =
        qa_numeric_field(weights.and_then(|w| w.get("small_trade")), 0.4, 0.0, 1.0);
    let big_trade_weight =
        qa_numeric_field(weights.and_then(|w| w.get("big_trade")), 0.2, 0.0, 1.0);
    let total_weight = no_trade_weight + small_trade_weight + big_trade_weight;
    let (no_trade_weight, small_trade_weight, big_trade_weight) = if total_weight <= f64::EPSILON {
        (0.4, 0.4, 0.2)
    } else {
        (
            no_trade_weight / total_weight,
            small_trade_weight / total_weight,
            big_trade_weight / total_weight,
        )
    };

    let sizes = config
        .strategy_config
        .get("qa_trade_sizes")
        .and_then(Value::as_object);
    let small_pct = qa_numeric_field(sizes.and_then(|s| s.get("small_pct")), 0.05, 0.0, 1.0);
    let big_pct = qa_numeric_field(sizes.and_then(|s| s.get("big_pct")), 0.25, small_pct, 1.0);

    let allowed_directions = config
        .strategy_config
        .get("qa_allowed_directions")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(|value| value.trim().to_ascii_lowercase())
                .filter(|value| value == "buy" || value == "sell")
                .collect::<Vec<_>>()
        })
        .filter(|values| !values.is_empty())
        .unwrap_or_else(|| vec!["buy".to_string(), "sell".to_string()]);

    let pair = config
        .strategy_config
        .get("qa_pair")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("WETH/USDC")
        .to_string();

    Some(DexQaConfigSummary {
        no_trade_weight,
        small_trade_weight,
        big_trade_weight,
        small_pct,
        big_pct,
        allowed_directions,
        pair,
    })
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

    /// Build a full sidecar agent profile using file-backed `instructionFiles`
    /// instead of `systemPrompt`. This preserves the sidecar's default coding
    /// identity while appending expert trading knowledge.
    pub fn build_agent_profile(&self, config: &crate::state::TradingBotRecord) -> Value {
        let _ = config;
        build_file_backed_profile(format!("trading-{}", self.strategy_type), self.name.clone())
    }
}

pub fn render_pack_agent_instructions(
    pack: &StrategyPack,
    config: &crate::state::TradingBotRecord,
) -> String {
    build_profile_instructions(
        &pack.strategy_type,
        &render_expert_prompt(pack, config),
        config,
        &pack.prompt_blocks,
    )
}

pub fn render_generic_agent_instructions(
    strategy_type: &str,
    config: &crate::state::TradingBotRecord,
) -> String {
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
    build_profile_instructions(strategy_type, strategy_fragment, config, &[])
}

fn build_file_backed_profile(name: String, description: String) -> Value {
    json!({
        "name": name,
        "description": description,
        "instructionFiles": [PROFILE_INSTRUCTIONS_PATH],
        "permission": {
            "edit": "allow",
            "bash": "allow",
            "webfetch": "allow",
            "mcp": "allow",
            "external_directory": "allow"
        },
        "memory": { "enabled": true }
    })
}

// ---------------------------------------------------------------------------
// Shared bootstrap system
// ---------------------------------------------------------------------------

/// Setup commands prepended to every strategy pack.  Creates the agent workspace,
/// JSON data store, and phase tracker.
fn common_setup_commands() -> Vec<String> {
    vec![
        "mkdir -p /home/agent/{tools,tools/data,data,data/raw,memory,metrics,logs,state,config}".to_string(),
        // Initialize JSON-based data stores
        concat!(
            "node -e \"",
            "const fs = require('fs'); ",
            "const db = '/home/agent/data/trading.json'; ",
            "if (!fs.existsSync(db)) { ",
            "fs.writeFileSync(db, JSON.stringify({",
            "markets: [], trades: [], signals: [], performance: [], memory: []",
            "}, null, 2)); ",
            "console.log('Trading data store initialized'); ",
            "} else { console.log('Trading data store exists'); }\"",
        ).to_string(),
        // Initialize phase tracker — start at "research" (tools are pre-installed)
        concat!(
            "node -e \"",
            "const fs = require('fs'); ",
            "const p = '/home/agent/state/phase.json'; ",
            "if (!fs.existsSync(p)) { ",
            "fs.writeFileSync(p, JSON.stringify({",
            "current: 'research', iteration: 0, last_trade_at: null, ",
            "tools_built: ['analyze-opportunities','submit-trade','get-portfolio','write-metrics','api-client','manage-collateral']",
            "}, null, 2)); ",
            "console.log('Phase tracker created (starting at research)'); ",
            "} else { ",
            "const d = JSON.parse(fs.readFileSync(p, 'utf8')); ",
            "console.log('Phase tracker exists at iteration', d.iteration); }\"",
        ).to_string(),
        // Initialize persistent trading state
        concat!(
            "node -e \"",
            "const fs = require('fs'); ",
            "const p = '/home/agent/state/trading-state.json'; ",
            "if (!fs.existsSync(p)) { ",
            "fs.writeFileSync(p, JSON.stringify({",
            "watchlist: [], positions: [], insights: [], iteration: 0",
            "}, null, 2)); ",
            "console.log('Trading state initialized'); }\"",
        ).to_string(),
        // Initialize empty log files
        "touch /home/agent/memory/insights.jsonl /home/agent/logs/decisions.jsonl".to_string(),
    ]
}

// ---------------------------------------------------------------------------
// Strategy packs
// ---------------------------------------------------------------------------

fn polymarket_pack() -> StrategyPack {
    let providers = vec!["polymarket", "coingecko"];
    let methodology = PREDICTION_GENERAL_METHODOLOGY;
    StrategyPack {
        strategy_type: "prediction".into(),
        name: "Polymarket Prediction Trading".into(),
        provider_ids: providers.clone(),
        strategy_methodology: methodology.into(),
        system_prompt: compose_expert_prompt(&providers, methodology),
        setup_commands: compose_setup_commands(&providers),
        required_env_vars: compose_required_env_vars(&providers),
        max_turns: 30,
        timeout_ms: 600_000,
        default_cron: "0 */15 * * * *".into(),
        prompt_blocks: vec![
            BLOCK_DATA_PIPELINE,
            BLOCK_SELF_CRITIQUE,
            BLOCK_POSITION_SIZING,
        ],
    }
}

fn polymarket_politics_pack() -> StrategyPack {
    let providers = vec!["polymarket", "coingecko"];
    let methodology = PREDICTION_POLITICS_METHODOLOGY;
    StrategyPack {
        strategy_type: "prediction_politics".into(),
        name: "Prediction Markets — Politics".into(),
        provider_ids: providers.clone(),
        strategy_methodology: methodology.into(),
        system_prompt: compose_expert_prompt(&providers, methodology),
        setup_commands: compose_setup_commands(&providers),
        required_env_vars: compose_required_env_vars(&providers),
        max_turns: 20,
        timeout_ms: 240_000,
        default_cron: "0 */15 * * * *".into(),
        prompt_blocks: vec![
            BLOCK_DATA_PIPELINE,
            BLOCK_SELF_CRITIQUE,
            BLOCK_POSITION_SIZING,
        ],
    }
}

fn polymarket_crypto_pack() -> StrategyPack {
    let providers = vec!["polymarket", "coingecko"];
    let methodology = PREDICTION_CRYPTO_METHODOLOGY;
    StrategyPack {
        strategy_type: "prediction_crypto".into(),
        name: "Prediction Markets — Crypto".into(),
        provider_ids: providers.clone(),
        strategy_methodology: methodology.into(),
        system_prompt: compose_expert_prompt(&providers, methodology),
        setup_commands: compose_setup_commands(&providers),
        required_env_vars: compose_required_env_vars(&providers),
        max_turns: 20,
        timeout_ms: 240_000,
        default_cron: "0 */15 * * * *".into(),
        prompt_blocks: vec![
            BLOCK_DATA_PIPELINE,
            BLOCK_SELF_CRITIQUE,
            BLOCK_POSITION_SIZING,
        ],
    }
}

fn polymarket_war_pack() -> StrategyPack {
    let providers = vec!["polymarket", "coingecko"];
    let methodology = PREDICTION_WAR_METHODOLOGY;
    StrategyPack {
        strategy_type: "prediction_war".into(),
        name: "Prediction Markets — Geopolitics".into(),
        provider_ids: providers.clone(),
        strategy_methodology: methodology.into(),
        system_prompt: compose_expert_prompt(&providers, methodology),
        setup_commands: compose_setup_commands(&providers),
        required_env_vars: compose_required_env_vars(&providers),
        max_turns: 20,
        timeout_ms: 240_000,
        default_cron: "0 */15 * * * *".into(),
        prompt_blocks: vec![
            BLOCK_DATA_PIPELINE,
            BLOCK_SELF_CRITIQUE,
            BLOCK_POSITION_SIZING,
        ],
    }
}

fn polymarket_trending_pack() -> StrategyPack {
    let providers = vec!["polymarket", "coingecko"];
    let methodology = PREDICTION_TRENDING_METHODOLOGY;
    StrategyPack {
        strategy_type: "prediction_trending".into(),
        name: "Prediction Markets — Trending".into(),
        provider_ids: providers.clone(),
        strategy_methodology: methodology.into(),
        system_prompt: compose_expert_prompt(&providers, methodology),
        setup_commands: compose_setup_commands(&providers),
        required_env_vars: compose_required_env_vars(&providers),
        max_turns: 20,
        timeout_ms: 240_000,
        default_cron: "0 */15 * * * *".into(),
        prompt_blocks: vec![
            BLOCK_DATA_PIPELINE,
            BLOCK_SELF_CRITIQUE,
            BLOCK_POSITION_SIZING,
        ],
    }
}

fn polymarket_celebrity_pack() -> StrategyPack {
    let providers = vec!["polymarket", "coingecko"];
    let methodology = PREDICTION_CELEBRITY_METHODOLOGY;
    StrategyPack {
        strategy_type: "prediction_celebrity".into(),
        name: "Prediction Markets — Celebrity & Entertainment".into(),
        provider_ids: providers.clone(),
        strategy_methodology: methodology.into(),
        system_prompt: compose_expert_prompt(&providers, methodology),
        setup_commands: compose_setup_commands(&providers),
        required_env_vars: compose_required_env_vars(&providers),
        max_turns: 20,
        timeout_ms: 240_000,
        default_cron: "0 */15 * * * *".into(),
        prompt_blocks: vec![
            BLOCK_DATA_PIPELINE,
            BLOCK_SELF_CRITIQUE,
            BLOCK_POSITION_SIZING,
        ],
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
        prompt_blocks: vec![
            BLOCK_DATA_PIPELINE,
            BLOCK_TA_INDICATORS,
            BLOCK_SELF_CRITIQUE,
            BLOCK_POSITION_SIZING,
        ],
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
        prompt_blocks: vec![BLOCK_DATA_PIPELINE, BLOCK_SELF_CRITIQUE],
    }
}

fn perp_pack() -> StrategyPack {
    let providers = vec!["gmx_v2", "vertex", "coingecko"];
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
        prompt_blocks: vec![
            BLOCK_DATA_PIPELINE,
            BLOCK_TA_INDICATORS,
            BLOCK_SELF_CRITIQUE,
            BLOCK_RISK_REGIME,
            BLOCK_POSITION_SIZING,
            BLOCK_CIRCUIT_BREAKER,
        ],
    }
}

fn hyperliquid_perp_pack() -> StrategyPack {
    let providers = vec!["hyperliquid", "coingecko"];
    let methodology = HYPERLIQUID_PERP_STRATEGY_METHODOLOGY;
    StrategyPack {
        strategy_type: "hyperliquid_perp".into(),
        name: "Hyperliquid Perps".into(),
        provider_ids: providers.clone(),
        strategy_methodology: methodology.into(),
        system_prompt: compose_expert_prompt(&providers, methodology),
        setup_commands: compose_setup_commands(&providers),
        required_env_vars: compose_required_env_vars(&providers),
        max_turns: 15,
        timeout_ms: 180_000,
        default_cron: "0 */2 * * * *".into(),
        prompt_blocks: vec![
            BLOCK_DATA_PIPELINE,
            BLOCK_TA_INDICATORS,
            BLOCK_SELF_CRITIQUE,
            BLOCK_RISK_REGIME,
            BLOCK_POSITION_SIZING,
            BLOCK_CIRCUIT_BREAKER,
        ],
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
        prompt_blocks: vec![
            BLOCK_DATA_PIPELINE,
            BLOCK_TA_INDICATORS,
            BLOCK_SELF_CRITIQUE,
            BLOCK_RISK_REGIME,
            BLOCK_POSITION_SIZING,
            BLOCK_CIRCUIT_BREAKER,
        ],
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
        prompt_blocks: vec![
            BLOCK_DATA_PIPELINE,
            BLOCK_SELF_CRITIQUE,
            BLOCK_RISK_REGIME,
            BLOCK_POSITION_SIZING,
            BLOCK_CIRCUIT_BREAKER,
        ],
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
        prompt_blocks: vec![
            BLOCK_DATA_PIPELINE,
            BLOCK_TA_INDICATORS,
            BLOCK_SELF_CRITIQUE,
            BLOCK_RISK_REGIME,
            BLOCK_POSITION_SIZING,
            BLOCK_CIRCUIT_BREAKER,
        ],
    }
}

// ---------------------------------------------------------------------------
// Strategy methodology consts — cross-protocol logic that doesn't belong to
// any single provider.
// ---------------------------------------------------------------------------

const PERP_STRATEGY_METHODOLOGY: &str = r#"## Vault-Based EVM Perpetual Futures Strategy

### Market Selection

Focus on majors first — ETH and BTC have the deepest liquidity and tightest spreads across GMX v2 and Vertex. Secondary markets such as ARB, SOL, and LINK are viable for smaller positions but require wider stops due to thinner books.

Scan funding rates across GMX v2 and Vertex every iteration. Store them in the signals table for cross-venue comparison.

This strategy is restricted to vault-based EVM execution on Arbitrum-compatible targets. Use only `target_protocol: "gmx_v2"` or `target_protocol: "vertex"`. Do not use Hyperliquid native endpoints from this strategy; Hyperliquid requires a separate native/API execution mode.

### Signal Framework

#### 1. Funding Rate Arbitrage (Delta-Neutral)

When 8h funding rates diverge between venues:
- Long on the venue with negative funding (you get paid to hold)
- Short on the venue with positive funding (you get paid to hold)
- Net exposure is delta-neutral — you collect funding from both sides
- Minimum spread to enter: 0.03%/8h (covers execution costs + slippage)
- Exit when spread compresses below 0.01%/8h

#### 2. Momentum / Trend Following

Use 4h candles from GMX, Vertex, or CoinGecko:
- Enter long when EMA(12) crosses above EMA(26) AND RSI(14) < 70
- Enter short when EMA(12) crosses below EMA(26) AND RSI(14) > 30
- Confirm with volume: entry only if volume exceeds 20-period average
- Stop-loss: 3% from entry (mandatory)
- Take-profit: 2:1 reward-to-risk minimum

#### 3. Mean Reversion

After a >5% move in 4 hours:
- If price touched lower Bollinger Band and RSI < 30 → mean-reversion long
- If price touched upper Bollinger Band and RSI > 70 → mean-reversion short
- Tighter stops for mean reversion: 2% (these are counter-trend, more risk)
- Target: return to 20-period SMA

#### 4. Liquidation Cascade

Monitor GMX and Vertex for liquidation events:
- After a cascade, wait for volatility to settle (at least one iteration)
- Then look for mean-reversion entries at key support/resistance levels
- Smaller position size (1% max) — cascades can extend further than expected

### Execution Across Venues

Route orders to the venue offering best execution:
- **GMX V2**: Deeper liquidity, use for larger positions (accept ~0.1% price impact)
- **Vertex**: Secondary venue — use when its funding rate creates an arb opportunity versus GMX or when its order book offers better execution

Always compare execution cost (fees + expected slippage) across venues before routing.

### Position Management

- Maximum 3 concurrent positions
- Maximum 3x leverage (conservative — higher leverage = wider liquidation risk)
- Every position must have a stop-loss set at entry time
- Trailing stop: move stop to breakeven after achieving 1.5x risk in unrealized profit
- Close positions that have been open >48h without hitting target (stale thesis)
"#;

const HYPERLIQUID_PERP_STRATEGY_METHODOLOGY: &str = r#"## Hyperliquid Perpetual Futures Strategy

This strategy is dedicated to native Hyperliquid perp trading. It is separate
from the generic EVM perp strategy. Use only `target_protocol: "hyperliquid"`.

### Account Model

- The bot account is the configured HyperEVM vault/account address.
- The API wallet is only a signer for native Hyperliquid API orders.
- Query account state for the bot account, not the API wallet signer.
- Use USDC as the v1 collateral/base asset.

### Trading Flow

1. Check `/hyperliquid/nav`, `/hyperliquid/mode`, and `/hyperliquid/account` before opening new risk.
2. Confirm fresh NAV, idle buffer, withdrawal pressure, account value, margin usage, open positions, and open orders.
3. If mode is `liquidity`, cancel non-essential orders, prefer reduce-only trades, and avoid new exposure.
4. Submit live trades through `/validate` and `/execute`.
5. Use reduce-only orders when closing or reducing exposure.

### Risk Management

- Keep enough idle/withdrawable USDC for liquidity needs.
- Respect the settlement tool's idle buffer target and cash-needed fields.
- Do not increase risk if account state is stale or unavailable.
- Stop-loss mandatory on directional trades.
- Maintain a liquidation buffer appropriate for the configured leverage.
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
// Prediction market sub-strategy methodologies
// ---------------------------------------------------------------------------

const PREDICTION_GENERAL_METHODOLOGY: &str = r#"## Prediction Markets — General Strategy (Top 50 by Volume)

### Market Universe

Scan the top 50 markets by volume across all categories:
```
GET https://gamma-api.polymarket.com/events?closed=false&limit=50&order=volume
```
This is the most liquid cohort — tightest spreads, fastest resolution, most news coverage.

### Information Gathering Priority

Focus research effort on markets where:
1. Resolution is within 7 days (time-sensitive alpha)
2. Price is between 15% and 85% (maximum uncertainty = maximum edge potential)
3. Volume spiked >50% in the last 24h (new information being priced in)

For each candidate: fetch the `resolutionSource`, read recent news via webfetch,
and form a calibrated probability estimate before comparing to market price.

### Edge Thesis

General prediction markets reward calibration and speed. The crowd is slow to update
on breaking news and tends to anchor on round numbers (50%, 25%, 75%). Your edge:
- React faster to news than retail participants
- Avoid anchoring bias — derive probabilities from evidence, not round numbers
- Identify markets where the resolution source has already published relevant data
  that hasn't been priced in yet

### Position Management

- Maximum 5 concurrent positions across all categories
- Prefer markets with >$100k volume (better liquidity, tighter spreads)
- Exit when probability reaches >90% or <10% (diminishing marginal return)
"#;

const PREDICTION_POLITICS_METHODOLOGY: &str = r#"## Prediction Markets — Politics Strategy

### Market Discovery

Filter for politics markets specifically:
```
GET https://gamma-api.polymarket.com/markets?tag=politics&closed=false&limit=50&order=volume
```

### Information Sources for Political Markets

Before estimating any political probability, gather from:
1. **Polling aggregators**: webfetch https://projects.fivethirtyeight.com/polls/ for the
   most recent polling average for the relevant race or question
2. **Prediction market consensus**: webfetch https://www.metaculus.com/questions/ — search
   for the question to find expert forecasters' estimates
3. **Official sources**: fetch the `resolutionSource` from the Gamma market — for elections
   this is often an official government results page or news outlet
4. **News**: Reuters, AP News, BBC for recent political developments

### Political Probability Framework

Political events have known base rates. Apply these as your prior before evidence:
- **Incumbent re-election**: ~65% historically (adjust for approval ratings)
- **Senate/House incumbent**: ~85% (incumbency advantage is strong)
- **Legislation passing**: ~15% for major bills (most fail)
- **Candidate winning primary with 20%+ polling lead**: ~85%

Adjust your prior based on:
- Recent polling direction (momentum matters more than level)
- Endorsements from key political figures
- Fundraising numbers (early indicator of organization strength)
- Prediction market consensus from Metaculus/Manifold

### Edge Thesis

Political prediction markets often misprice because:
1. **Overconfidence in polls**: Markets anchor on polls even when sample sizes are small
2. **Recency bias**: A single bad news cycle moves markets too much
3. **Base rate neglect**: Markets underweight how rarely incumbents lose
4. **Resolution ambiguity**: Some political markets resolve on media calls, not official
   results — read resolution criteria carefully

### Risk Management

- Never hold through an election night if you can exit profitably before
- Reduce position sizes 24h before resolution events (vol spike risk)
- Political markets often have correlated moves — avoid holding multiple
  positions in the same election
"#;

const PREDICTION_CRYPTO_METHODOLOGY: &str = r#"## Prediction Markets — Crypto Markets Strategy

### Market Discovery

Filter for crypto prediction markets:
```
GET https://gamma-api.polymarket.com/markets?tag=crypto&closed=false&limit=50&order=volume
```

### Information Gathering for Crypto Markets

Crypto prediction markets are uniquely quantifiable — use hard data:
1. **Current price**: CoinGecko `GET /api/v3/simple/price?ids={coin_id}&vs_currencies=usd`
2. **Price history**: CoinGecko `GET /api/v3/coins/{id}/market_chart?vs_currency=usd&days=30`
3. **Volatility calculation**: From the 30-day price series, compute daily log returns and
   annualized vol
4. **Funding rates**: Hyperliquid `POST https://api.hyperliquid.xyz/info` with
   `{"type": "metaAndAssetCtxs"}` — extreme positive funding = crowded longs = reversion pressure

### Quantitative Probability Framework

For "Will [TOKEN] be above $X by [DATE]?" markets:
1. Fetch current price `P` from CoinGecko
2. Fetch 30-day price history, compute daily log return std dev `σ_daily`
3. Compute time to expiry `T` in days
4. Use log-normal approximation:
   - `μ = ln(P)` (assume zero drift as conservative prior)
   - `σ_T = σ_daily * sqrt(T)`
   - `prob = 1 - Φ((ln(X) - μ) / σ_T)` where Φ is the standard normal CDF
   - This gives probability price exceeds target X at expiry
5. Build a Node.js tool in `/home/agent/tools/crypto-prob.js` implementing this calculation

### Edge Thesis

Crypto prediction markets misprice because:
- **Stale volatility**: Markets use trailing 7-day vol when regimes have shifted
- **Correlation blindness**: BTC/ETH correlation means a BTC dump predicts ETH markets too
- **Event timing**: Protocol upgrades, ETF decisions, exchange listings cause jumps
  the vol model doesn't capture — check crypto news before using pure quant estimate
- **Funding rate signal**: Extreme funding rates predict directional pressure in the
  underlying, which directly affects price prediction markets

### Risk Management

- Cap total crypto prediction exposure at 30% of portfolio
- Never take positions directional on crypto AND hold crypto perps simultaneously
- Reduce size when 30-day vol > 80% annualized (wide error bars on your model)
"#;

const PREDICTION_WAR_METHODOLOGY: &str = r#"## Prediction Markets — Geopolitics & Conflict Strategy

### Market Discovery

Filter for geopolitics markets:
```
GET https://gamma-api.polymarket.com/markets?tag=geopolitics&closed=false&limit=50&order=volume
```
Also check `tag=world` for broader coverage.

### Information Sources for Geopolitical Markets

Geopolitical events require qualitative research from authoritative sources:
1. **Reuters World News**: webfetch https://www.reuters.com/world/ — most balanced breaking news
2. **BBC World**: webfetch https://www.bbc.com/news/world — strong on international conflict
3. **AP News**: webfetch https://apnews.com/hub/world-news
4. **Think tanks**: webfetch https://www.crisisgroup.org/ (International Crisis Group)

Always fetch the market's `resolutionSource` — geopolitical markets often resolve on
specific news sources (e.g. "Reuters reports X") that you should monitor directly.

### Geopolitical Probability Framework

Geopolitical events resist quantification, but these heuristics help:
- **Ceasefire/peace talks**: Base rate of success ~20% (most fail). Adjust up if both
  parties have economic incentives.
- **Escalation within 30 days**: If conflict is ongoing and neither side has clear
  advantage, 40-60% default
- **Sanctions passing**: ~70% if US + EU aligned. ~30% if only one major power
- **Leadership change via coup**: Historically rare (<5% per year) unless military is
  already mobilized

Apply **reference class forecasting**: find the closest historical analog, anchor on that
base rate, then adjust for current-specific factors.

### Edge Thesis

Geopolitical markets are the most mispriced category because:
1. Most retail participants have poor calibration on international events
2. Breaking developments take hours to be priced in — news monitoring is the edge
3. Markets often anchor on the status quo (overweight things staying the same)
4. Resolution criteria are often ambiguous — read them carefully for markets where
   resolution is clearer than the market price implies

### Risk Management

- Maximum position size: 5% of portfolio per market (high tail risk)
- Geopolitical events can resolve suddenly — don't hold oversized positions overnight
- Monitor news feeds between iterations for breaking developments
- Correlated risk: multiple conflict markets in the same region often move together
"#;

const PREDICTION_TRENDING_METHODOLOGY: &str = r#"## Prediction Markets — Trending Markets Strategy

### Market Discovery

Trending markets = highest recent volume growth, not just absolute volume:
```
GET https://gamma-api.polymarket.com/events?closed=false&limit=100&order=volume
```
Then filter for markets where volume in the last 24h is a large fraction of total
volume — this indicates rapid attention growth.

Also check for recently created markets:
```
GET https://gamma-api.polymarket.com/markets?closed=false&limit=50&order=created&ascending=false
```
New markets with high liquidity but low volume = market makers have provisioned
liquidity but retail hasn't discovered it yet — often represents early-stage opportunity.

### What Makes a Market "Trending"

A market is trending when:
- Volume > $10k AND the market is <7 days old
- OR volume spiked >200% in the last 24h compared to 7-day average
- OR a related event is actively in the news cycle

Build a tool to track volume changes across iterations and flag spikes.

### Information Gathering for Trending Markets

Trending markets correspond to viral news events. Research accordingly:
1. **Google News last 24h**: webfetch
   `https://news.google.com/search?q={market_keywords}&hl=en-US&tbs=qdr:d`
2. **Resolution source**: Critical for trending markets — many are created quickly and
   have loose resolution criteria. Read the criteria before trading.

### Edge Thesis

Trending markets are the highest-variance category:
- **Early movers win**: Being 2-3 hours early in a fast-moving market is worth 10-20% edge
- **Overreaction is common**: Viral events cause prices to overshoot — fading extreme
  moves (>85% or <15%) is often profitable after the initial reaction
- **Resolution ambiguity risk**: Quickly-created markets sometimes have unclear resolution
  criteria — read them carefully before trading

### Tactical Approach

1. Scan every iteration for new markets (sort by created desc)
2. When a new market appears: immediately research the underlying event
3. Form probability estimate within the first few turns
4. If edge > 8% (higher threshold due to liquidity risk), size in at 3% max
5. Re-evaluate every iteration — trending markets resolve faster and move more

### Risk Management

- Maximum 3% per trending market position (thin liquidity = more slippage)
- Be prepared for sudden resolution — set mental stop-losses
- Don't chase markets that have already moved 20%+ from initial listing price
"#;

const PREDICTION_CELEBRITY_METHODOLOGY: &str = r#"## Prediction Markets — Celebrity & Entertainment Strategy

### Market Discovery

```
GET https://gamma-api.polymarket.com/markets?tag=pop-culture&closed=false&limit=50&order=volume
```
Also check `tag=entertainment`, `tag=sports` for adjacent categories.

### Information Sources for Celebrity Markets

Celebrity and entertainment markets resolve on public events with good data coverage:
1. **Awards prediction sites**: webfetch https://www.goldderby.com — Oscars, Emmys,
   Grammys expert predictions. GoldDerby aggregates expert forecasters and their
   consensus consistently leads Polymarket prices by 10-15%.
2. **Entertainment news**: webfetch https://variety.com or https://deadline.com for
   awards season, release dates, casting announcements
3. **Sports reference**: webfetch https://www.basketball-reference.com or
   https://www.baseball-reference.com for player statistics and records
4. **Wikipedia**: for current status, recent events, career timeline of the person

### Celebrity Market Probability Framework

Unlike political or crypto markets, celebrity markets often have strong consensus signals:
- **Awards shows**: GoldDerby aggregates expert predictions — use their consensus as
  your prior, then compare with Polymarket price for edge
- **Album/movie release**: Check official announcements; delays are predictable from
  production schedules
- **Sports milestones**: Use statistical reference sites to compute probability from
  current stats and historical rates

For awards markets specifically:
1. Fetch GoldDerby predictions for the category
2. Note the consensus pick's probability (often 60-80% for frontrunners)
3. Compare with Polymarket price — markets often lag expert consensus by 10-15%
4. This lag is a consistent edge source during awards season

### Edge Thesis

Celebrity markets are uniquely exploitable because:
1. **Expert aggregators exist**: GoldDerby and similar sites do the research; you can
   free-ride on their consensus
2. **Predictable calendars**: Awards seasons, sports playoffs, album release cycles are
   known well in advance — position early
3. **Resolution source is always clear**: Oscars, Emmys, Grammys have definitive results
4. **Thin but reliable liquidity**: These markets have less competition from sophisticated
   traders

### Risk Management

- Maximum 3% per celebrity market position (thinner liquidity)
- Avoid markets depending on a single individual's private decision (unpredictable)
- Best entries: 7-30 days before resolution when odds are still volatile but consensus
  is forming
- Exit when position reaches >85% (last 15% takes too long, carries event risk)
"#;

// ---------------------------------------------------------------------------
// Composable prompt blocks — mix and match across strategy packs
// ---------------------------------------------------------------------------

pub(crate) const BLOCK_DATA_PIPELINE: &str = r#"## Data Pipeline

Pre-built data collection tools are in `/home/agent/tools/`. Run them at the start of each iteration.

### Pre-Installed Tools

- `node tools/scan-markets.js [--limit 50] [--tag politics]` — Fetch markets from Gamma API, store in trading.json
- `node tools/check-prices.js [--limit 20]` — Fetch CLOB midpoint prices for stored markets
- `node tools/api-client.js` — Shared module (require it from custom scripts)

### Iteration-Start Data Refresh

At the start of each iteration:
1. Run `node tools/scan-markets.js` to fetch latest market data
2. Run `node tools/check-prices.js` to update prices
3. Read trading.json and analyze the results
4. Only proceed to trading if data is fresh (check `updated_at` timestamps)

### Custom Data Scripts

If you need additional data sources, create scripts in `/home/agent/tools/data/`:
- Use Node.js (not Python) — `const https = require('https')`
- Read/write `/home/agent/data/trading.json` for persistence
- Store raw responses in `/home/agent/data/raw/` for debugging
- Print JSON to stdout: `{"source": "...", "rows_updated": N}`
- Exit 0 on success, exit 1 on failure
"#;

pub(crate) const BLOCK_TA_INDICATORS: &str = r#"## Technical Analysis Indicators

Build a single tool (`tools/indicators.js`) that computes indicators from price history in trading.json. Accept a symbol and timeframe as arguments, output JSON with all indicator values.

### Core Indicators

- **SMA(20) / SMA(50)**: Simple moving averages for trend identification. Price above both = bullish, below both = bearish, between = neutral.
- **EMA(12) / EMA(26)**: Exponential moving averages — more responsive to recent price action. EMA crossovers signal trend changes.
- **RSI(14)**: Relative Strength Index. Overbought > 70, oversold < 30. Look for divergences (price makes new high but RSI doesn't).
- **Bollinger Bands** (20-period SMA ± 2σ): Band width indicates volatility regime. Price touching bands signals potential reversal or breakout.
- **MACD** (EMA(12) - EMA(26), signal = EMA(9) of MACD): Histogram crossing zero = momentum shift. MACD above signal line = bullish.
- **VWAP**: Volume-weighted average price from candle data. Price above VWAP = bullish intraday bias, below = bearish.

### Signal Confluence

Never act on a single indicator. Require **2+ indicators** confirming the same direction before generating a signal. Record which indicator combination led to each signal so you can track which combinations have the best hit rate over time.

### Regime-Aware Usage

- **Trending market** (SMA(20) > SMA(50), wide Bollinger bands): Use EMA crossovers and MACD for entry timing
- **Range-bound market** (SMA(20) ≈ SMA(50), narrow Bollinger bands): Use RSI extremes and Bollinger band touches for mean reversion
- Assess the regime before choosing which signals to weight
"#;

pub(crate) const BLOCK_SELF_CRITIQUE: &str = r#"## Self-Critique Protocol

Before making any trading decision, validate your data pipeline and analysis.

### Data Freshness

- Check `updated_at` on every table you read. If data is older than 3x your cron interval, **do not trade** — stay in research phase and diagnose the pipeline.
- Log stale data warnings to `/home/agent/logs/validation.jsonl`.

### Calculation Validation

- RSI must be between 0 and 100. If not, your computation is wrong.
- Prices must be positive. Zero or negative prices mean a data fetch failed silently.
- Volumes must be non-negative.
- Moving averages must be between the min and max of their input window.

### Cross-Source Verification

- If you pull prices from multiple sources (CoinGecko, DexScreener, protocol APIs), compare them. A disagreement > 1% means one source is stale or wrong — flag it and prefer the most recent.

### Decision Audit

- Before each trade, write a brief rationale to `logs/decisions.jsonl`: what data you used, which indicators fired, why you sized this way, what could invalidate the thesis.
- After each trade resolves, compare your rationale to what actually happened. Update the memory table with what you learned.
"#;

pub(crate) const BLOCK_RISK_REGIME: &str = r#"## Risk Regime Detection

Operate in one of two regimes. Assess the regime at the start of every iteration and store it in `/home/agent/state/regime.json`.

### RISK_ON (Normal)

Criteria (all must hold):
- 30-day realized volatility ≤ 90-day average volatility
- No active portfolio drawdown > 2%
- Funding rates across venues are moderate (|rate| < 0.05%/8h)

Behavior: Normal position sizes, actively seek new entries, standard stop-losses.

### RISK_OFF (Defensive)

Triggers (any one is sufficient):
- 30-day vol spike > 1.5× the 90-day average
- Portfolio drawdown exceeds 3% from peak
- 3+ correlated liquidation events detected in recent data
- Extreme funding rates (|rate| > 0.1%/8h) across multiple venues

Behavior: Halve all position sizes, widen stops by 50%, do NOT open new positions (only manage existing), increase cash buffer.

### Regime Transitions

- Log every regime change as a high-importance insight in the memory table
- When transitioning RISK_ON → RISK_OFF: immediately review all open positions for stop-loss tightening
- When transitioning RISK_OFF → RISK_ON: wait one full iteration before resuming new entries (avoid whipsaw)
"#;

pub(crate) const BLOCK_POSITION_SIZING: &str = r#"## Position Sizing Framework

### Half-Kelly Criterion

Estimate optimal position size using the Kelly formula, then halve it for safety:
- `f* = (b * p - q) / b` where b = reward/risk ratio, p = win probability, q = 1-p
- Use `f*/2` as your position size fraction (half-Kelly)
- Compute rolling win rate and average win/loss ratio from the last 20 trades in the trades table
- If you have fewer than 5 historical trades, use conservative defaults: p=0.5, b=1.5 → f*/2 ≈ 8%

### Hard Limits

- **Per-trade risk**: Never risk more than 2% of portfolio value on a single trade
- **Total exposure**: Never exceed 50% of portfolio in active positions (sum of all position values)
- **Leverage**: For leveraged positions, use notional value (not margin) when computing exposure
- **Correlation**: Positions in correlated assets (e.g. ETH + ARB) count as a single larger position for sizing purposes

### Sizing Formula

`position_size = min(half_kelly * portfolio_value, 0.02 * portfolio_value)`

This ensures you never exceed 2% risk even if Kelly suggests more.
"#;

pub(crate) const BLOCK_CIRCUIT_BREAKER: &str = r#"## Circuit Breaker Rules

In addition to calling POST `/circuit-breaker/check` on the Trading API, apply these local checks:

### Session Drawdown

If your session P&L drops below -3%, halt all trading for the remainder of this iteration. Log the event and enter reflect phase.

### Daily Aggregate

Track cumulative P&L across iterations within a 24-hour window (use the trades table). If aggregate daily loss exceeds 5%, enter RISK_OFF regime and skip trading for the next 3 iterations.

### Consecutive Losses

If 3 consecutive trades are losses, pause trading and enter reflect phase. Analyze what went wrong before resuming. Update your signal weights based on which signals led to the losses.

### Correlation Breaker

If 3+ open positions are all moving against you simultaneously (all showing negative unrealized P&L), reduce all positions by 50%. This indicates a correlated market move your signals didn't anticipate.

### Cooldown

After any circuit breaker triggers, wait at least 1 full iteration (skip trading, stay in research/reflect) before resuming trades. Use the cooldown to diagnose what happened and adjust your approach.
"#;

// ---------------------------------------------------------------------------
// Profile building
// ---------------------------------------------------------------------------

fn iteration_execute_clause(validation_trust: trading_runtime::ValidationTrust) -> &'static str {
    match validation_trust {
        trading_runtime::ValidationTrust::Envelope => {
            "Envelope authorization mode: do NOT submit the intent to the per-trade validator pipeline. Run `await api.executeWithEnvelope(intent)` — the on-file SignedEnvelope authorizes execution. Before trading, call `api.envelopeStatus()` and SKIP the iteration if `is_active === false`, `consumed_pct > 95`, or `expires_in_seconds < 3600`. On a 403 response containing `EnvelopeAmountExceeded`, `EnvelopeTotalExceeded`, `EnvelopeRateTooLow`, or `EnvelopeExpired`: SKIP and call `api.requestEnvelopeRenewal(<error>)`."
        }
        _ => {
            "Per-trade authorization mode: validate it, then execute it if approved using `const validation = await api.validate(intent); if ((validation.data||validation).approved) await api.execute(intent, validation);`. Do not rebuild validator payloads by hand."
        }
    }
}

fn strategy_iteration_protocol(
    strategy_type: &str,
    validation_trust: trading_runtime::ValidationTrust,
) -> String {
    let execute_clause = iteration_execute_clause(validation_trust);
    match strategy_type {
        "dex" => format!(
            r#"Read `/home/agent/state/phase.json` at the start of every iteration. Follow the phase protocol:

- **research**: Run `node tools/get-portfolio.js` to inspect current exposure. Treat `protocol: "vault"` + `position_type: "spot"` as vault-held custody that can be swapped through the Trading API, not as a locked protocol position. Fetch `/supported-assets`, then price and research only the configured asset universe. Cross-check with CoinGecko or DexScreener if you need external confirmation. Optionally call `api.getBanditStatus()` to surface the currently best-performing strategy variant (informational — it does not override your judgement). Form a swap thesis only when price, direction, size, and slippage are clear.
- **trading**: Check circuit breaker (`node -e "const api=require('./tools/api-client'); api.checkCircuitBreaker(10).then(r=>console.log(JSON.stringify(r)))"`). Choose `token_in` from an available spot balance and `token_out` from the configured asset universe. Before quoting, call `api.recommendSlippageBps({{token_in, token_out, fallback_bps: 100}})` and pass the returned `recommended_max_bps` as the `slippage_bps` argument to `api.quoteUniswapSwap({{token_in, token_out, amount_in, slippage_bps}})` — the slippage learner ratchets tighter when fills are clean and looser after failures, so trust its recommendation over a static value. Then build a swap intent with `api.resolveTokenAddress('<configured-symbol>')` or configured token addresses, raw base-unit amounts, `amount_format: "base_units"`, the quoted `min_amount_out`, `strategy_id`, `action: "swap"`, and `target_protocol: "uniswap_v3"`. {execute_clause} Log the outcome immediately. Then proceed to reflect.
- **reflect**: Review fills, recent P&L, and whether the trade matched the thesis. If this bot is running a bandit-tracked variant, call `api.recordStrategyOutcome({{variant_id: <strategy_id from intent>, reward: <realized_pnl_usd>, iteration_id: <iteration from phase.json>}})` (positive = profit, negative = loss) so the UCB1 bandit can update its arm statistics. Write insights to memory. Run `node tools/update-phase.js research` to return to research.

After each phase transition, run `node tools/update-phase.js <next_phase>` and `node tools/write-metrics.js '{{...}}'`.

**Important**: Complete research→trading→reflect in a SINGLE iteration when possible. Don't waste turns on phase transitions."#,
            execute_clause = execute_clause,
        ),
        "yield" => format!(
            r#"Read `/home/agent/state/phase.json` at the start of every iteration. Follow the phase protocol:

- **research**: Run `node tools/get-portfolio.js` to inspect current exposure. Run `node tools/aave-reserve-status.js` to inspect live Aave asset availability on the execution RPC, then fetch current price context with `api-client.js`. Optionally call `api.getBanditStatus()` to surface the currently best-performing variant (informational — it does not override your thesis). Compare only executable Aave and allowlisted MetaMorpho vault opportunities and only form a thesis if the expected yield improvement is meaningful after gas and risk.
- **trading**: Check circuit breaker (`node -e "const api=require('./tools/api-client'); api.checkCircuitBreaker(10).then(r=>console.log(JSON.stringify(r)))"`). For any yield action that involves a swap leg (e.g. rebalancing into a target asset before supply, unwinding after withdraw), call `api.recommendSlippageBps({{token_in, token_out, fallback_bps: 100}})` first and pass `recommended_max_bps` as `slippage_bps` into `api.quoteUniswapSwap` — the slippage learner ratchets tighter on clean fills and looser after failures, so trust its recommendation over a static default. Build an intent with `action: "supply"`, `action: "withdraw"`, `action: "borrow"`, or `action: "repay"` for `aave_v3`, or `action: "supply"`/`action: "withdraw"` for allowlisted `morpho_vault` with `metadata.vault_address`. Use `aave-reserve-status.js` as a hard gate for Aave assets: use the chain-specific asset addresses it returns, set `amount_format: "base_units"`, use raw base-unit amounts such as `"3000000000000000000"` for 3 WETH, do not trade assets marked unavailable or frozen, and for Aave repay include `metadata.debt_token` from the matching variable debt token in that tool output. Required intent shape includes `strategy_id`, `action`, `token_in`, `token_out`, `amount_in`, `min_amount_out`, `amount_format`, and `target_protocol`; use `action`, not `intent_type`. {execute_clause} Then proceed to reflect.
- **reflect**: Review whether the action improved capital placement, whether risk stayed acceptable, and whether the result matched the thesis. If this bot is running a bandit-tracked variant, call `api.recordStrategyOutcome({{variant_id: <strategy_id from intent>, reward: <realized_pnl_usd>, iteration_id: <iteration from phase.json>}})` (positive = profit, negative = loss) so the UCB1 bandit can update its arm statistics. Write insights to memory. Run `node tools/update-phase.js research` to return to research.

After each phase transition, run `node tools/update-phase.js <next_phase>` and `node tools/write-metrics.js '{{...}}'`.

**Important**: Complete research→trading→reflect in a SINGLE iteration when possible. Don't waste turns on phase transitions."#,
            execute_clause = execute_clause,
        ),
        _ => format!(
            r#"Read `/home/agent/state/phase.json` at the start of every iteration. Follow the phase protocol:

- **research**: Run pre-built tools to fetch data: `node tools/scan-markets.js` then `node tools/check-prices.js`. Optionally call `api.getBanditStatus()` to surface the currently best-performing variant (informational — it does not override your judgement). Analyze results. Generate signals. If actionable signals found, proceed to trading within this same iteration.
- **trading**: Check circuit breaker (`node -e "require('./tools/api-client').checkCircuitBreaker(10).then(r=>console.log(JSON.stringify(r)))"`). For any leg that involves an EVM swap (or, for perp venues like Hyperliquid, when sizing a limit order's effective slippage relative to mid), call `api.recommendSlippageBps({{token_in, token_out, fallback_bps: 100}})` and use the returned `recommended_max_bps` as your `slippage_bps` — the per-pair slippage learner ratchets tighter when fills are clean and looser after failures, so trust its recommendation over a static default. {execute_clause} Log results. Then proceed to reflect.
- **reflect**: Calculate P&L from recent trades. Compare signal predictions vs outcomes. If this bot is running a bandit-tracked variant, call `api.recordStrategyOutcome({{variant_id: <strategy_id>, reward: <realized_pnl_usd>, iteration_id: <iteration from phase.json>}})` (positive = profit, negative = loss) so the UCB1 bandit can update its arm statistics. Write insights to memory. Run `node tools/update-phase.js research` to return to research.

After each phase transition, run `node tools/update-phase.js <next_phase>` and `node tools/write-metrics.js '{{...}}'`.

**Important**: Complete research→trading→reflect in a SINGLE iteration when possible. Don't waste turns on phase transitions."#,
            execute_clause = execute_clause,
        ),
    }
}

fn strategy_core_workflow_tools(strategy_type: &str) -> String {
    match strategy_type {
        "dex" => r#"| Tool | Usage | What It Does |
|------|-------|--------------|
| `get-portfolio.js` | `node tools/get-portfolio.js` | Shows positions, recent trades, and iteration state. |
| `api-client.js` | `node -e "const api=require('./tools/api-client'); api.getSupportedAssets().then(r=>console.log(JSON.stringify(r,null,2)))"` | Trading API wrapper for supported assets, prices, circuit breaker, validate, execute, adapters, and metrics. |
| `log-decision.js` | `node tools/log-decision.js '{"action":"trade-or-skip","reason":"..."}'` | Append your trade thesis or skip reason to the decision log. |
| `write-metrics.js` | `node tools/write-metrics.js '{"portfolio_value_usd":10000}'` | Write iteration metrics. |"#
            .to_string(),
        "yield" => r#"| Tool | Usage | What It Does |
|------|-------|--------------|
| `get-portfolio.js` | `node tools/get-portfolio.js` | Shows positions, recent trades, and iteration state. |
| `aave-reserve-status.js` | `node tools/aave-reserve-status.js` | Reads live Aave reserve status from the execution RPC so you know which assets are actually available on the current fork. |
| `api-client.js` | `node -e "const api=require('./tools/api-client'); api.getPrices(['WETH','USDC']).then(r=>console.log(JSON.stringify(r,null,2)))"` | Trading API wrapper for prices, circuit breaker, validate, execute, adapters, and metrics. |
| `log-decision.js` | `node tools/log-decision.js '{"action":"yield-trade-or-skip","reason":"..."}'` | Append your yield thesis or skip reason to the decision log. |
| `write-metrics.js` | `node tools/write-metrics.js '{"portfolio_value_usd":10000}'` | Write iteration metrics. |"#
            .to_string(),
        _ => r#"| Tool | Usage | What It Does |
|------|-------|--------------|
| `analyze-opportunities.js` | `node tools/analyze-opportunities.js` | Scans Gamma API, fetches CLOB prices, filters to tradeable markets. Outputs compact summary. |
| `get-portfolio.js` | `node tools/get-portfolio.js` | Shows positions, recent trades, iteration state. |
| `submit-trade.js` | `node tools/submit-trade.js --action buy --condition-id <id> --side YES --amount 100 --reason "..."` | Full trade pipeline: circuit-breaker → validate → execute → log. Use `--action sell` only to reduce/exit outcome shares already held. If an outcome is overpriced and you do not hold it, buy the opposite side or skip. |
| `manage-collateral.js` | `node tools/manage-collateral.js --action status` | CLOB collateral: release vault funds, return funds, check status. Actions: status, release, return, return-all. |
| `write-metrics.js` | `node tools/write-metrics.js '{{"portfolio_value_usd":10000}}'` | Write iteration metrics. |"#
            .to_string(),
    }
}

fn strategy_typical_iteration(
    strategy_type: &str,
    validation_trust: trading_runtime::ValidationTrust,
) -> String {
    let dex_execute_phrase = match validation_trust {
        trading_runtime::ValidationTrust::Envelope => {
            "do NOT submit the intent to the per-trade validator pipeline — run `await api.executeWithEnvelope(intent)` directly. Before trading, call `api.envelopeStatus()` and skip if `is_active === false`, `consumed_pct > 95`, or `expires_in_seconds < 3600`. On 403 with `EnvelopeAmountExceeded`/`EnvelopeTotalExceeded`/`EnvelopeRateTooLow`/`EnvelopeExpired`: skip and call `api.requestEnvelopeRenewal(<error>)`."
        }
        _ => {
            "validate it and execute it if approved using `const validation = await api.validate(intent); if ((validation.data||validation).approved) await api.execute(intent, validation);`"
        }
    };
    let yield_execute_phrase = dex_execute_phrase; // identical pattern
    match strategy_type {
        "dex" => format!(
            r#"1. Run `get-portfolio.js` — check current positions and recent fills. `protocol: "vault"` with `position_type: "spot"` means vault-held custody available for vault-backed swaps, not a locked protocol position
2. Fetch `/supported-assets`, then fetch current prices for the configured asset universe via `api-client.js` and compare against CoinGecko or DexScreener if needed
3. Run the circuit breaker check before any trade
4. If the setup is actionable, choose `token_in` from an available spot balance and `token_out` from the configured asset universe. First call `api.recommendSlippageBps({{token_in, token_out, fallback_bps: 100}})` and pass `recommended_max_bps` as `slippage_bps` into `api.quoteUniswapSwap({{token_in, token_out, amount_in, slippage_bps}})` — the slippage learner ratchets tighter on clean fills and looser after failures, so trust it over a static value. Then build a swap intent with `api.resolveTokenAddress('<configured-symbol>')` or configured token addresses, `strategy_id`, `action: "swap"`, `amount_format: "base_units"`, raw base-unit `amount_in`, the quoted raw base-unit `min_amount_out`, and `target_protocol: "uniswap_v3"` (for example `1000000` for 1 unit of a 6-decimal token, or `1000000000000000000` for 1 unit of an 18-decimal token), then {dex_execute_phrase}
5. Run `log-decision.js` with the thesis or skip reason. If this bot is running a bandit-tracked variant, call `api.recordStrategyOutcome({{variant_id: <strategy_id>, reward: <realized_pnl_usd>, iteration_id: <iteration from phase.json>}})` so UCB1 can update its arm statistics
6. Run `write-metrics.js` to update state

Do not use `analyze-opportunities.js`, `manage-collateral.js`, `check-orders.js`, or `submit-trade.js` for DEX swaps — those are prediction-market tools."#,
            dex_execute_phrase = dex_execute_phrase,
        ),
        "yield" => format!(
            r#"1. Run `get-portfolio.js` — check current positions and recent changes
2. Run `aave-reserve-status.js` — treat assets with `available_for_supply: false` as blocked on this fork
3. Fetch current price context via `api-client.js` and compare only executable Aave vs allowlisted MetaMorpho vault opportunities
4. Run the circuit breaker check before any trade
5. If the setup is actionable, build an intent with `action: "supply"`, `action: "withdraw"`, `action: "borrow"`, or `action: "repay"`, chain-specific addresses from `aave-reserve-status.js`, `amount_format: "base_units"`, raw base-unit amounts such as `"3000000000000000000"` for 3 WETH, and `target_protocol: "aave_v3"`, or an intent with `action: "supply"`/`action: "withdraw"`, `target_protocol: "morpho_vault"`, and `metadata.vault_address` from the allowlist. Use `action`, not `intent_type`. For any swap leg involved in rebalancing, first call `api.recommendSlippageBps({{token_in, token_out, fallback_bps: 100}})` and pass `recommended_max_bps` into `api.quoteUniswapSwap` as `slippage_bps` — trust the learner over a static value. {yield_execute_phrase}
6. Run `log-decision.js` with the thesis or skip reason. If this bot is running a bandit-tracked variant, call `api.recordStrategyOutcome({{variant_id: <strategy_id>, reward: <realized_pnl_usd>, iteration_id: <iteration from phase.json>}})` so UCB1 can update its arm statistics
7. Run `write-metrics.js` to update state

Do not use `analyze-opportunities.js`, `manage-collateral.js`, `check-orders.js`, or `submit-trade.js` for yield actions — those are prediction-market tools."#,
            yield_execute_phrase = yield_execute_phrase,
        ),
        _ => r#"1. Run `analyze-opportunities.js` — read the opportunities list
2. Run `get-portfolio.js` — check current positions
3. Run `manage-collateral.js --action status` — check CLOB collateral (release funds if needed for CLOB trades)
4. For markets with edge > 5%: run `submit-trade.js --action buy` to increase a position. For negative edge, only run `--action sell` when reducing/exiting an existing outcome position; otherwise buy the opposite side when available or skip. Never sell outcome shares you do not hold.
5. Run `write-metrics.js` to update state"#
            .to_string(),
    }
}

fn strategy_utility_tools(strategy_type: &str) -> String {
    match strategy_type {
        "dex" => r#"| Tool | Usage | Purpose |
|------|-------|---------|
| `update-phase.js` | `node tools/update-phase.js <phase>` | Update phase state |
| `api-client.js` | `require('./tools/api-client')` | Trading HTTP API wrapper (prices, circuit breaker, validate, execute) |
| `log-decision.js` | `node tools/log-decision.js '{"action":"skip","reason":"no clean setup"}'` | Log decisions |
| `scan-markets.js` | `node tools/scan-markets.js [--limit 50]` | Optional broad market scan if you need extra context |
| `check-prices.js` | `node tools/check-prices.js [--limit 20]` | Optional raw price helper for additional context |"#
            .to_string(),
        "yield" => r#"| Tool | Usage | Purpose |
|------|-------|---------|
| `update-phase.js` | `node tools/update-phase.js <phase>` | Update phase state |
| `aave-reserve-status.js` | `node tools/aave-reserve-status.js` | Live Aave reserve availability on the execution RPC. Use it before any Aave action. |
| `api-client.js` | `require('./tools/api-client')` | Trading HTTP API wrapper (prices, circuit breaker, validate, execute) |
| `log-decision.js` | `node tools/log-decision.js '{"action":"skip","reason":"yield spread not worth gas"}'` | Log decisions |
| `scan-markets.js` | `node tools/scan-markets.js [--limit 50]` | Optional broad market scan if you need extra context |
| `check-prices.js` | `node tools/check-prices.js [--limit 20]` | Optional raw price helper for additional context |"#
            .to_string(),
        _ => r#"| Tool | Usage | Purpose |
|------|-------|---------|
| `api-client.js` | `require('./tools/api-client')` | Trading HTTP API wrapper (used by other tools) |
| `update-phase.js` | `node tools/update-phase.js <phase>` | Update phase state |
| `log-decision.js` | `node tools/log-decision.js '{{"action":"skip","reason":"no edge"}}'` | Log decisions |
| `scan-markets.js` | `node tools/scan-markets.js [--limit 50]` | Raw Gamma API scan (use analyze-opportunities instead) |
| `check-prices.js` | `node tools/check-prices.js [--limit 20]` | Raw CLOB prices (use analyze-opportunities instead) |"#
            .to_string(),
    }
}

/// Build instructions markdown that combines identity, workspace, API config,
/// iteration protocol, tool building, data APIs, expert strategy knowledge,
/// and operational mandates.
fn build_profile_instructions(
    strategy_type: &str,
    expert_prompt: &str,
    config: &crate::state::TradingBotRecord,
    prompt_blocks: &[&str],
) -> String {
    let risk_params = serde_json::to_string_pretty(&config.risk_params).unwrap_or_default();

    let paper_mode_note = if config.paper_trade {
        "You are currently in PAPER TRADE mode. Trades are logged but not executed on-chain. \
         Focus on building good analysis tools and tracking your simulated P&L."
    } else {
        "You are in LIVE TRADE mode. Trades will be executed on-chain. \
         Exercise maximum caution and always verify before executing."
    };

    // Extract user-provided overrides from strategy_config
    let expert_override = config
        .strategy_config
        .get("expert_knowledge_override")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let custom_instructions = config
        .strategy_config
        .get("custom_instructions")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let available_protocols = config
        .strategy_config
        .get("available_protocols")
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
        })
        .filter(|values| !values.is_empty());

    // Use override if provided, otherwise use pack expert prompt
    let effective_expert = if expert_override.is_empty() {
        expert_prompt.to_string()
    } else {
        format!("{expert_prompt}\n\n## Operator Strategy Override\n\n{expert_override}")
    };

    // Append custom instructions section if provided
    let custom_section = if custom_instructions.is_empty() {
        String::new()
    } else {
        format!("\n\n## Custom Instructions\n\n{custom_instructions}")
    };

    // Build blocks section if any blocks are provided
    let blocks_section = if prompt_blocks.is_empty() {
        String::new()
    } else {
        format!("\n\n{}", prompt_blocks.join("\n\n"))
    };

    let iteration_protocol = strategy_iteration_protocol(strategy_type, config.validation_trust);
    let core_workflow_tools = strategy_core_workflow_tools(strategy_type);
    let typical_iteration = strategy_typical_iteration(strategy_type, config.validation_trust);
    let utility_tools = strategy_utility_tools(strategy_type);
    let qa_section = dex_stochastic_qa_config(config)
        .map(|qa| {
            format!(
                "\n\n## QA Stochastic Mode\n\n\
This bot is running with temporary QA stochastic trading enabled.\n\
- Pair: {}\n\
- Outcome weights: no-trade {:.0}%, small trade {:.0}%, big trade {:.0}%\n\
- Size policy: small {:.1}% of available inventory, big {:.1}%\n\
- Allowed directions: {}\n\
\n\
At the start of every tick, run `node /home/agent/tools/qa-stochastic-dex.js`.\n\
Treat its output as authoritative for this iteration. If it executes or skips a trade, do not place additional discretionary trades in the same tick.",
                qa.pair,
                qa.no_trade_weight * 100.0,
                qa.small_trade_weight * 100.0,
                qa.big_trade_weight * 100.0,
                qa.small_pct * 100.0,
                qa.big_pct * 100.0,
                qa.allowed_directions.join(", "),
            )
        })
        .unwrap_or_default();

    format!(
        r#"# Trading Agent Instructions

## Identity & Autonomy

You are an autonomous trading agent — a coding agent that runs tools, analyzes data, makes trading decisions, and iterates on its approach. You are NOT a chatbot. You act.

Your container has **Node.js 24**, npm, bash, curl, jq, and ripgrep.

**Pre-built tools are installed at `/home/agent/tools/`.** Run them — don't rebuild them. Use curl for direct API calls. Use Node.js if you need to create custom analysis scripts.

You have a persistent workspace at /home/agent/ that survives across iterations. Each iteration: run tools to gather data, analyze results, make trading decisions, execute trades, and update metrics. Spend your turns on ANALYSIS and DECISIONS, not on infrastructure.

Workspace layout:
```
/home/agent/
├── data/trading.json      # JSON data store (markets, trades, signals, performance, memory)
├── tools/                 # Your tools (scanners, analyzers, indicators) — Node.js scripts
│   ├── strategies/README.md # How to write automated strategy modules
│   └── data/              # Data collection scripts (run at iteration start)
├── memory/insights.jsonl  # Append-only learning log
├── metrics/latest.json    # Current metrics (read by /metrics endpoint)
├── logs/decisions.jsonl   # Trade decision log
└── state/phase.json       # Current phase + iteration counter
```

## Iteration Protocol

{iteration_protocol}

## Pre-Built Tools

Smart tools are pre-installed in `/home/agent/tools/`. They do the heavy lifting — you make decisions.

For automated strategy code, read `/home/agent/tools/strategies/README.md`. Write small modules in `/home/agent/tools/strategies/` that export `async tick(ctx)`, then run one tick with `node /home/agent/tools/run-strategy.js /home/agent/tools/strategies/<name>.js`. Use `ctx.submitTrade()` so circuit breaker, validation, paper/live gating, execution, and logs stay centralized.

### Core Workflow Tools (use these every tick)

{core_workflow_tools}

### Typical Iteration (3-5 turns)

{typical_iteration}

### Utility Tools

{utility_tools}

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
{available_protocols_line}

## Risk Parameters

{risk_params}

## Expert Strategy Knowledge

{effective_expert}
{blocks_section}

## Operational Mandates

1. **Metrics**: Write metrics to /home/agent/metrics/latest.json every iteration:
   {{"timestamp": "<ISO8601>", "iteration": <n>, "portfolio_value_usd": <f64>, "pnl_pct": <f64>, "trades_executed": <n>, "strategy": "{strategy_type}", "signals_generated": <n>, "phase": "<current_phase>", "errors": []}}

2. **Iteration**: Before each run, check /home/agent/tools/ for existing scripts. Run them, don't rebuild. Log every trade decision to /home/agent/logs/decisions.jsonl with reasoning.

3. **Safety**: Always check the circuit breaker before executing trades. Never exceed risk parameters. If uncertain, skip the trade and log why.

4. **Mode**: {paper_mode_note}

5. **Learning**: After every trade outcome (win or loss), write an insight to the memory table. Track which signal types are most accurate. Adjust your approach based on data, not intuition.{qa_section}{custom_section}"#,
        api_url = config.trading_api_url,
        token = config.trading_api_token,
        vault = config.vault_address,
        chain_id = config.chain_id,
        available_protocols_line = available_protocols
            .map(|protocols| format!(
                "- Available Protocols: {}\n- Do not use any `target_protocol` outside this list.",
                protocols.join(", ")
            ))
            .unwrap_or_default(),
        iteration_protocol = iteration_protocol,
        core_workflow_tools = core_workflow_tools,
        typical_iteration = typical_iteration,
        utility_tools = utility_tools,
        qa_section = qa_section,
        custom_section = custom_section,
    )
}

/// Build a generic agent profile for strategy types without a dedicated pack.
/// Still gets workspace awareness and base API info.
pub fn build_generic_agent_profile(
    strategy_type: &str,
    config: &crate::state::TradingBotRecord,
) -> Value {
    let _ = config;
    build_file_backed_profile(
        format!("trading-{}", strategy_type),
        format!("{} trading agent", strategy_type),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_pack_known_types() {
        assert!(get_pack("prediction").is_some());
        assert!(get_pack("prediction_politics").is_some());
        assert!(get_pack("prediction_crypto").is_some());
        assert!(get_pack("prediction_war").is_some());
        assert!(get_pack("prediction_trending").is_some());
        assert!(get_pack("prediction_celebrity").is_some());
        assert!(get_pack("dex").is_some());
        assert!(get_pack("yield").is_some());
        assert!(get_pack("perp").is_some());
        assert!(get_pack("hyperliquid_perp").is_some());
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
        assert!(
            pack.system_prompt
                .contains("0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E")
        );
        assert!(
            pack.system_prompt
                .contains("0x4D97DCd97eC945f40cF65F87097ACe5EA0476045")
        );
    }

    #[test]
    fn test_dex_pack_has_uniswap_addresses() {
        let pack = get_pack("dex").unwrap();
        assert!(pack.system_prompt.contains("uniswap_v3"));
        assert!(
            pack.system_prompt
                .contains("token addresses for the bot's configured chain")
        );
    }

    #[test]
    fn test_yield_pack_uses_live_aave_reserve_tooling() {
        let pack = get_pack("yield").unwrap();
        assert!(pack.system_prompt.contains("aave-reserve-status.js")); // Aave pool/reserve addresses are resolved from the live execution RPC.
        assert!(pack.system_prompt.contains("Morpho"));
    }

    #[test]
    fn test_perp_pack_has_gmx_addresses() {
        let pack = get_pack("perp").unwrap();
        assert!(
            pack.system_prompt
                .contains("0x7C68C7866A64FA2160F78EEaE12217FFbf871fa8")
        ); // GMX Router
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
        for proto in &[
            "uniswap_v3",
            "aave_v3",
            "gmx_v2",
            "morpho_vault",
            "vertex",
            "polymarket",
        ] {
            assert!(
                pack.system_prompt.contains(proto),
                "multi pack missing protocol: {proto}"
            );
        }
    }

    #[test]
    fn test_common_setup_creates_data_store() {
        let cmds = common_setup_commands();
        let joined = cmds.join(" ");
        assert!(
            joined.contains("trading.json"),
            "setup must create trading.json"
        );
        assert!(
            joined.contains("phase.json"),
            "setup must create phase tracker"
        );
    }

    #[test]
    fn test_all_packs_have_common_setup() {
        for pack_type in &[
            "prediction",
            "prediction_politics",
            "prediction_crypto",
            "prediction_war",
            "prediction_trending",
            "prediction_celebrity",
            "dex",
            "yield",
            "perp",
            "volatility",
            "mm",
            "multi",
        ] {
            let pack = get_pack(pack_type).unwrap();
            let joined = pack.setup_commands.join(" ");
            assert!(
                joined.contains("mkdir -p /home/agent/"),
                "{pack_type} pack missing mkdir"
            );
            assert!(
                joined.contains("trading.json"),
                "{pack_type} pack missing data store setup"
            );
        }
    }

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
            baseline_backtest: None,
            renewal_webhook_url: None,
        }
    }

    #[test]
    fn test_build_agent_profile_uses_instructions_not_system_prompt() {
        let pack = get_pack("prediction").unwrap();
        let profile = pack.build_agent_profile(&test_config());
        let obj = profile.as_object().unwrap();

        assert!(
            obj.get("systemPrompt").is_none(),
            "profile must not set systemPrompt"
        );
        assert!(
            obj.get("resources").is_none(),
            "profile must not inline resources"
        );
        assert_eq!(
            profile["instructionFiles"],
            json!([PROFILE_INSTRUCTIONS_PATH]),
            "profile must point OpenCode at the shared instruction file",
        );
    }

    #[test]
    fn test_build_agent_profile_has_workspace_awareness() {
        let pack = get_pack("dex").unwrap();
        let content = render_pack_agent_instructions(&pack, &test_config());

        assert!(
            content.contains("persistent"),
            "instructions must mention persistent workspace"
        );
        assert!(
            content.contains("/home/agent/"),
            "instructions must reference /home/agent/"
        );
        assert!(
            content.contains("coding agent"),
            "instructions must identify agent as a coding agent"
        );
    }

    #[test]
    fn test_build_agent_profile_permissions() {
        let pack = get_pack("yield").unwrap();
        let profile = pack.build_agent_profile(&test_config());
        let perm = profile
            .get("permission")
            .expect("profile must have permission");

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
        assert!(obj.get("resources").is_none());
        assert_eq!(
            profile["instructionFiles"],
            json!([PROFILE_INSTRUCTIONS_PATH])
        );
        let content = render_generic_agent_instructions("multi", &test_config());
        assert!(content.contains("/home/agent/"));
        assert!(content.contains("multi-strategy"));
        assert_eq!(profile["permission"]["bash"], "allow");
        assert_eq!(profile["memory"]["enabled"], true);
    }

    #[test]
    fn test_build_agent_profile_contains_api_config() {
        let pack = get_pack("prediction").unwrap();
        let config = test_config();
        let content = render_pack_agent_instructions(&pack, &config);

        assert!(
            content.contains("http://test-api:9100"),
            "must contain API URL"
        );
        assert!(content.contains("test-token"), "must contain bearer token");
        assert!(content.contains("0xVAULT"), "must contain vault address");
        assert!(content.contains("31337"), "must contain chain ID");
    }

    #[test]
    fn test_dex_instructions_render_base_sepolia_tokens() {
        let pack = get_pack("dex").unwrap();
        let mut config = test_config();
        config.chain_id = 84532;
        let content = render_pack_agent_instructions(&pack, &config);

        assert!(content.contains("Base Sepolia"));
        assert!(content.contains("0x4200000000000000000000000000000000000006"));
        assert!(content.contains("0x036CbD53842c5426634e7929541eC2318f3dCF7e"));
        assert!(!content.contains("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"));
    }

    #[test]
    fn test_pack_defaults() {
        let poly = get_pack("prediction").unwrap();
        assert_eq!(poly.max_turns, 30);
        assert_eq!(poly.timeout_ms, 600_000);
        assert_eq!(poly.default_cron, "0 */15 * * * *");

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

        let hl_perp = get_pack("hyperliquid_perp").unwrap();
        assert_eq!(hl_perp.max_turns, 15);
        assert_eq!(hl_perp.timeout_ms, 180_000);
        assert_eq!(hl_perp.default_cron, "0 */2 * * * *");

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
        let content = render_pack_agent_instructions(&pack, &test_config());

        assert!(
            content.contains("coding agent"),
            "must mention coding agent identity"
        );
        assert!(content.contains("Node.js"), "must mention Node.js");
        assert!(
            content.contains("Iteration Protocol"),
            "must have iteration protocol"
        );
        assert!(
            content.contains("phase.json"),
            "must reference phase tracker"
        );
        assert!(
            content.contains("Pre-Built Tools"),
            "must have pre-built tools section"
        );
    }

    #[test]
    fn test_dex_profile_instructions_use_swap_workflow() {
        let pack = get_pack("dex").unwrap();
        let content = render_pack_agent_instructions(&pack, &test_config());

        assert!(
            content.contains("uniswap_v3"),
            "dex instructions must target uniswap_v3"
        );
        assert!(
            content.contains("api-client.js"),
            "dex instructions must reference the Trading API client"
        );
        assert!(
            content.contains("protocol: \"vault\"")
                && content.contains("not as a locked protocol position"),
            "dex instructions must explain that vault spot custody is tradeable"
        );
        assert!(
            content.contains("Choose `token_in` from an available spot balance")
                || content.contains("choose `token_in` from an available spot balance"),
            "dex instructions must choose swap input from portfolio inventory"
        );
        assert!(
            content.contains("Do not use `analyze-opportunities.js`"),
            "dex instructions must explicitly fence off prediction-market tools"
        );
        assert!(
            !content.contains("--condition-id"),
            "dex instructions must not reference prediction market condition ids"
        );
        assert!(
            !content.contains("manage-collateral.js --action status"),
            "dex instructions must not require CLOB collateral checks"
        );
    }

    // ── New tests for provider composition ──────────────────────────────

    // ── Prediction sub-pack tests ──────────────────────────────────────

    #[test]
    fn test_prediction_subpacks_use_polymarket_provider() {
        for pack_type in &[
            "prediction_politics",
            "prediction_crypto",
            "prediction_war",
            "prediction_trending",
            "prediction_celebrity",
        ] {
            let pack = get_pack(pack_type).unwrap();
            assert!(
                pack.provider_ids.contains(&"polymarket"),
                "{pack_type} must include polymarket provider"
            );
            assert!(
                pack.provider_ids.contains(&"coingecko"),
                "{pack_type} must include coingecko provider"
            );
        }
    }

    #[test]
    fn test_prediction_subpacks_have_polymarket_api_urls() {
        for pack_type in &[
            "prediction_politics",
            "prediction_crypto",
            "prediction_war",
            "prediction_trending",
            "prediction_celebrity",
        ] {
            let pack = get_pack(pack_type).unwrap();
            assert!(
                pack.system_prompt.contains("gamma-api.polymarket.com"),
                "{pack_type} prompt must contain Gamma API URL"
            );
            assert!(
                pack.system_prompt.contains("clob.polymarket.com"),
                "{pack_type} prompt must contain CLOB API URL"
            );
        }
    }

    #[test]
    fn test_prediction_subpacks_have_methodology() {
        let politics = get_pack("prediction_politics").unwrap();
        assert!(!politics.strategy_methodology.is_empty());
        assert!(politics.system_prompt.contains("polling"));

        let crypto = get_pack("prediction_crypto").unwrap();
        assert!(!crypto.strategy_methodology.is_empty());
        assert!(crypto.system_prompt.contains("log-normal"));

        let war = get_pack("prediction_war").unwrap();
        assert!(!war.strategy_methodology.is_empty());
        assert!(war.system_prompt.contains("geopolit") || war.system_prompt.contains("Geopolit"));

        let trending = get_pack("prediction_trending").unwrap();
        assert!(!trending.strategy_methodology.is_empty());
        assert!(
            trending.system_prompt.contains("trending")
                || trending.system_prompt.contains("Trending")
        );

        let celebrity = get_pack("prediction_celebrity").unwrap();
        assert!(!celebrity.strategy_methodology.is_empty());
        assert!(
            celebrity.system_prompt.contains("GoldDerby")
                || celebrity.system_prompt.contains("goldderby")
        );
    }

    #[test]
    fn test_prediction_general_has_methodology() {
        let pack = get_pack("prediction").unwrap();
        assert!(
            !pack.strategy_methodology.is_empty(),
            "prediction pack must have non-empty methodology"
        );
        assert!(pack.system_prompt.contains("Top 50") || pack.system_prompt.contains("top 50"));
    }

    #[test]
    fn test_prediction_subpacks_handle_price_move_event() {
        let config = test_config();
        for pack_type in &[
            "prediction_politics",
            "prediction_crypto",
            "prediction_war",
            "prediction_trending",
            "prediction_celebrity",
        ] {
            let pack = get_pack(pack_type).unwrap();
            let prompt = pack.build_event_prompt(
                "price_move",
                &serde_json::json!({"market": "test"}),
                &config,
            );
            assert!(
                prompt.is_some(),
                "{pack_type} must handle price_move event via polymarket provider"
            );
        }
    }

    // ── Provider composition tests ──────────────────────────────────────

    #[test]
    fn test_packs_have_provider_ids() {
        for pack_type in &[
            "prediction",
            "prediction_politics",
            "prediction_crypto",
            "prediction_war",
            "prediction_trending",
            "prediction_celebrity",
            "dex",
            "yield",
            "perp",
            "volatility",
            "mm",
            "multi",
        ] {
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
        assert!(
            prompt.is_none(),
            "yield pack should not handle unknown events"
        );
    }

    #[test]
    fn test_perp_pack_has_cross_venue_methodology() {
        let pack = get_pack("perp").unwrap();
        assert!(pack.system_prompt.contains("Execution Across Venues"));
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
        assert!(
            pack.system_prompt
                .contains("Cross-Strategy Signal Integration")
        );
    }

    #[test]
    fn test_strategy_config_expert_override_appears_in_profile() {
        let pack = get_pack("prediction").unwrap();
        let mut config = test_config();
        config.strategy_config = serde_json::json!({
            "expert_knowledge_override": "Focus exclusively on US election markets."
        });
        let content = render_pack_agent_instructions(&pack, &config);

        assert!(
            content.contains("Focus exclusively on US election markets"),
            "expert_knowledge_override must appear in instructions"
        );
        assert!(
            content.contains("Operator Strategy Override"),
            "override section header must appear"
        );
    }

    #[test]
    fn test_strategy_config_custom_instructions_appear_in_profile() {
        let pack = get_pack("dex").unwrap();
        let mut config = test_config();
        config.strategy_config = serde_json::json!({
            "custom_instructions": "Always check ETH/USDC pair first."
        });
        let content = render_pack_agent_instructions(&pack, &config);

        assert!(
            content.contains("Always check ETH/USDC pair first"),
            "custom_instructions must appear in instructions"
        );
        assert!(
            content.contains("Custom Instructions"),
            "custom instructions section header must appear"
        );
    }

    #[test]
    fn test_yield_pack_mentions_aave_reserve_status_tool() {
        let pack = get_pack("yield").unwrap();
        let content = render_pack_agent_instructions(&pack, &test_config());

        assert!(
            content.contains("aave-reserve-status.js"),
            "yield profile should instruct the agent to inspect live Aave reserve status"
        );
        assert!(
            content.contains("available_for_supply"),
            "yield profile should treat unavailable reserves as blocked"
        );
    }

    #[test]
    fn test_dex_qa_stochastic_section_appears_in_profile() {
        let pack = get_pack("dex").unwrap();
        let mut config = test_config();
        config.strategy_config = serde_json::json!({
            "qa_mode": "stochastic",
            "qa_trade_weights": {
                "no_trade": 0.5,
                "small_trade": 0.3,
                "big_trade": 0.2
            },
            "qa_trade_sizes": {
                "small_pct": 0.04,
                "big_pct": 0.2
            },
            "qa_allowed_directions": ["buy", "sell"]
        });
        let content = render_pack_agent_instructions(&pack, &config);

        assert!(
            content.contains("QA Stochastic Mode"),
            "qa stochastic section must appear in instructions"
        );
        assert!(
            content.contains("qa-stochastic-dex.js"),
            "qa stochastic tool must be referenced in instructions"
        );
        assert!(
            content.contains("no-trade 50%"),
            "qa stochastic section must include configured weights"
        );
    }

    #[test]
    fn test_empty_strategy_config_no_extra_sections() {
        let pack = get_pack("prediction").unwrap();
        let config = test_config(); // strategy_config = {}
        let content = render_pack_agent_instructions(&pack, &config);

        assert!(
            !content.contains("Operator Strategy Override"),
            "no override section when strategy_config is empty"
        );
        assert!(
            !content.contains("Custom Instructions"),
            "no custom instructions section when strategy_config is empty"
        );
    }

    #[test]
    fn test_prompt_blocks_compose_into_profile() {
        let perp = get_pack("perp").unwrap();
        assert!(!perp.prompt_blocks.is_empty());
        let config = test_config();
        let content = render_pack_agent_instructions(&perp, &config);
        for block in &perp.prompt_blocks {
            assert!(content.contains(block));
        }
        // Generic profile gets no blocks
        let g = render_generic_agent_instructions("perp", &config);
        assert!(!g.contains(BLOCK_DATA_PIPELINE));
    }

    // ----- Learning-loop wiring in rendered instructions -----

    #[test]
    fn test_strategy_outcome_recording_is_referenced_in_reflect_dex() {
        let pack = get_pack("dex").unwrap();
        let mut config = test_config();
        config.validation_trust = trading_runtime::ValidationTrust::PerTrade;
        let content = render_pack_agent_instructions(&pack, &config);
        assert!(
            content.contains("**reflect**"),
            "dex instructions must include the reflect phase"
        );
        let reflect_section = content
            .split("**reflect**")
            .nth(1)
            .expect("reflect phase must be present");
        assert!(
            reflect_section.contains("recordStrategyOutcome"),
            "dex reflect phase must record bandit outcomes"
        );
    }

    #[test]
    fn test_strategy_outcome_recording_is_referenced_in_reflect_yield() {
        let pack = get_pack("yield").unwrap();
        let mut config = test_config();
        config.strategy_type = "yield".to_string();
        config.validation_trust = trading_runtime::ValidationTrust::Envelope;
        let content = render_pack_agent_instructions(&pack, &config);
        let reflect_section = content
            .split("**reflect**")
            .nth(1)
            .expect("reflect phase must be present in yield instructions");
        assert!(
            reflect_section.contains("recordStrategyOutcome"),
            "yield reflect phase must record bandit outcomes (envelope mode)"
        );
    }

    #[test]
    fn test_iteration_protocol_dex_envelope_mentions_slippage_learner() {
        let pack = get_pack("dex").unwrap();
        let mut config = test_config();
        config.validation_trust = trading_runtime::ValidationTrust::Envelope;
        let content = render_pack_agent_instructions(&pack, &config);
        assert!(
            content.contains("recommendSlippageBps"),
            "dex envelope-mode instructions must reference the slippage learner"
        );
        assert!(
            content.contains("slippage_bps"),
            "dex envelope-mode instructions must thread slippage_bps into the quote"
        );
    }

    #[test]
    fn test_iteration_protocol_dex_per_trade_mentions_slippage_learner() {
        let pack = get_pack("dex").unwrap();
        let mut config = test_config();
        config.validation_trust = trading_runtime::ValidationTrust::PerTrade;
        let content = render_pack_agent_instructions(&pack, &config);
        assert!(
            content.contains("recommendSlippageBps"),
            "dex per-trade instructions must reference the slippage learner"
        );
    }

    #[test]
    fn test_iteration_protocol_yield_envelope_mentions_slippage_learner_for_swap_legs() {
        let pack = get_pack("yield").unwrap();
        let mut config = test_config();
        config.strategy_type = "yield".to_string();
        config.validation_trust = trading_runtime::ValidationTrust::Envelope;
        let content = render_pack_agent_instructions(&pack, &config);
        assert!(
            content.contains("recommendSlippageBps"),
            "yield envelope-mode instructions must reference the slippage learner for swap legs"
        );
    }

    #[test]
    fn test_iteration_protocol_research_phase_optionally_surfaces_bandit_status_dex() {
        let pack = get_pack("dex").unwrap();
        let mut config = test_config();
        config.validation_trust = trading_runtime::ValidationTrust::PerTrade;
        let content = render_pack_agent_instructions(&pack, &config);
        let research_section = content
            .split("**research**")
            .nth(1)
            .expect("research phase must be present in dex instructions");
        let research_section = research_section
            .split("**trading**")
            .next()
            .expect("research must precede trading");
        assert!(
            research_section.contains("getBanditStatus"),
            "dex research phase should optionally surface bandit status"
        );
        assert!(
            research_section.contains("informational")
                || research_section.contains("inform")
                || research_section.contains("does not override"),
            "bandit status must be framed as informational, not directive"
        );
    }
}
