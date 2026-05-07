use super::{EventContext, TradingProvider};
use trading_runtime::token_metadata::{chain_display_name, tokens_for_chain};

pub struct UniswapV3Provider;

impl TradingProvider for UniswapV3Provider {
    fn id(&self) -> &'static str {
        "uniswap_v3"
    }

    fn name(&self) -> &'static str {
        "Uniswap V3 DEX"
    }

    fn protocol_adapters(&self) -> &[&'static str] {
        &["uniswap_v3"]
    }

    fn expert_prompt(&self) -> &'static str {
        UNISWAP_EXPERT_PROMPT
    }

    fn setup_commands(&self) -> Vec<String> {
        vec![] // Agent installs npm packages during bootstrap
    }

    fn required_env_vars(&self) -> &[&'static str] {
        &[]
    }

    fn handled_event_types(&self) -> &[&'static str] {
        &["large_swap", "pool_created"]
    }

    fn build_event_prompt(&self, ctx: &EventContext) -> Option<String> {
        match ctx.event_type {
            "large_swap" => Some(format!(
                "UNISWAP LARGE SWAP DETECTED.\n\
                 Data: {data}\n\n\
                 A large swap may signal directional intent or create arbitrage. Steps:\n\
                 1. Check if the swap moved the price significantly\n\
                 2. Compare the affected pair's price across fee tiers\n\
                 3. If cross-fee-tier arb exists (edge > combined fees), build a trade intent\n\
                 4. Set tight min_amount_out for slippage protection",
                data = ctx.data,
            )),
            "pool_created" => Some(format!(
                "NEW UNISWAP V3 POOL CREATED.\n\
                 Data: {data}\n\n\
                 A new liquidity pool has been created. Steps:\n\
                 1. Identify the token pair and fee tier\n\
                 2. Check if the tokens are known/verified\n\
                 3. Monitor initial liquidity depth before trading",
                data = ctx.data,
            )),
            _ => None,
        }
    }
}

pub(crate) const UNISWAP_EXPERT_PROMPT: &str = r#"## Uniswap V3 Protocol Knowledge

Use Uniswap V3 for spot swaps, but always use token addresses for the bot's configured chain.
Never copy a mainnet token address into a Base or Base Sepolia trade, or vice versa.
The bot's configured asset universe is authoritative. Only research, quote, route, and trade tokens returned by `/supported-assets` for this bot or listed in `strategy_config.asset_universe`.
If the user configured a custom token address, treat it as tradeable only after Trading API validation confirms vault valuation support.

Fee tiers: 500 (0.05%), 3000 (0.3%), 10000 (1%)

### Market Discovery — DexScreener API

Use DexScreener for real-time pair discovery across chains:
- `GET https://api.dexscreener.com/latest/dex/tokens/{token_address}` — All pairs for a token
- `GET https://api.dexscreener.com/latest/dex/pairs/{chain}/{pair_address}` — Specific pair details

Response includes: priceUsd, volume (h1, h6, h24), priceChange, liquidity, txns count.

### Multi-Chain Awareness

| Chain | Chain ID | Key DEX |
|-------|----------|---------|
| Ethereum | 1 | Uniswap V3 |
| Arbitrum | 42161 | Uniswap V3, Camelot |
| Base | 8453 | Uniswap V3, Aerodrome |
| Polygon | 137 | Uniswap V3, QuickSwap |

### MEV Awareness

- Always set tight `min_amount_out` (slippage protection) — calculate from current price minus max acceptable slippage
- Use `metadata.deadline` with short expiry (5 minutes) to avoid stale orders
- Prefer lower fee tiers when liquidity is sufficient — they're less attractive to sandwich attacks

### Trading Methodology

1. **Price Monitoring**: Fetch prices for major pairs via CoinGecko and DexScreener. Compare mid-prices between fee tiers and chains.

2. **Cross-Fee-Tier Arbitrage**: When the same pair has different prices across fee tiers (accounting for fees), there's an arbitrage opportunity. Minimum edge: the price difference must exceed the combined fee of both trades.

3. **Slippage Analysis**: Use the Quoter to simulate exact output amounts. Never trade if expected slippage exceeds the configured `max_slippage` parameter.

4. **Trade Intent Format**: Submit through Trading HTTP API with:
   - `action`: "swap"
   - `target_protocol`: "uniswap_v3"
   - `token_in`: input token address
   - `token_out`: output token address
   - `amount_in`: wei amount as string
   - `min_amount_out`: minimum acceptable output (slippage protection)
   - `metadata.fee_tier`: the pool fee tier to route through
   - `metadata.deadline`: unix timestamp for trade expiry

5. **Portfolio Rebalancing**: Maintain target allocations. Rebalance when any position drifts >5% from target weight.
"#;

pub(crate) fn expert_prompt_for_chain(chain_id: u64) -> String {
    let chain_name = chain_display_name(chain_id);
    let known_tokens = tokens_for_chain(chain_id)
        .iter()
        .map(|token| format!("- {}: {}", token.symbol, token.address))
        .collect::<Vec<_>>()
        .join("\n");
    let known_tokens = if known_tokens.is_empty() {
        "- No built-in token references for this chain. Use `/supported-assets`.".to_string()
    } else {
        known_tokens
    };

    format!(
        "{base}\n\n## Active Chain Reference\n\n\
Current chain: {chain_name} (Chain ID {chain_id})\n\
Known token references for this chain:\n\
{known_tokens}\n\
\n\
These are address references only. The allowed trading universe comes from `/supported-assets` and `strategy_config.asset_universe`; do not trade a token just because it appears in this reference list. If you see a different-chain address in notes, memory, or old logs, treat it as stale and do not trade it.",
        base = UNISWAP_EXPERT_PROMPT,
        chain_name = chain_name,
        chain_id = chain_id,
        known_tokens = known_tokens,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_chain_specific_prompt_uses_base_sepolia_addresses() {
        let prompt = expert_prompt_for_chain(84532);
        assert!(prompt.contains("Base Sepolia"));
        assert!(prompt.contains("0x4200000000000000000000000000000000000006"));
        assert!(prompt.contains("0x036CbD53842c5426634e7929541eC2318f3dCF7e"));
        assert!(!prompt.contains("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"));
    }

    #[test]
    fn test_uniswap_handled_events() {
        let p = UniswapV3Provider;
        let ctx = EventContext {
            event_type: "large_swap",
            data: &json!({"pair": "ETH/USDC"}),
            strategy_config: &json!({}),
            risk_params: &json!({}),
        };
        assert!(p.build_event_prompt(&ctx).is_some());

        let ctx_unknown = EventContext {
            event_type: "unknown",
            ..ctx
        };
        assert!(p.build_event_prompt(&ctx_unknown).is_none());
    }
}
