use super::{EventContext, TradingProvider};

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
        vec!["pip install web3 2>/dev/null".into()]
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

### Uniswap V3 (Ethereum Mainnet)
- Router: 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45 (SwapRouter02)
- Factory: 0x1F98431c8aD98523631AE4a59f267346ea31F984
- Quoter V2: 0x61fFE014bA17989E743c5F6cB21bF9697530B21e

Fee tiers: 500 (0.05%), 3000 (0.3%), 10000 (1%)

Key tokens:
- WETH: 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
- USDC: 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
- USDT: 0xdAC17F958D2ee523a2206206994597C13D831ec7
- DAI: 0x6B175474E89094C44Da98b954EedeAC495271d0F
- WBTC: 0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599

### Market Discovery — DexScreener API

Use DexScreener for real-time pair discovery across chains:
- `GET https://api.dexscreener.com/latest/dex/tokens/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` — All pairs for WETH
- `GET https://api.dexscreener.com/latest/dex/pairs/ethereum/{pair_address}` — Specific pair details

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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_uniswap_expert_prompt_has_addresses() {
        let p = UniswapV3Provider;
        let prompt = p.expert_prompt();
        assert!(prompt.contains("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")); // WETH
        assert!(prompt.contains("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")); // USDC
        assert!(prompt.contains("0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45")); // Router
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
