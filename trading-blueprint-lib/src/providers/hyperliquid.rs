use super::{EventContext, TradingProvider};

pub struct HyperliquidProvider;

impl TradingProvider for HyperliquidProvider {
    fn id(&self) -> &'static str {
        "hyperliquid"
    }

    fn name(&self) -> &'static str {
        "Hyperliquid Perpetuals"
    }

    fn protocol_adapters(&self) -> &[&'static str] {
        &["hyperliquid"]
    }

    fn expert_prompt(&self) -> &'static str {
        HYPERLIQUID_EXPERT_PROMPT
    }

    fn setup_commands(&self) -> Vec<String> {
        vec!["pip install websockets 2>/dev/null".into()]
    }

    fn required_env_vars(&self) -> &[&'static str] {
        &[]
    }

    fn handled_event_types(&self) -> &[&'static str] {
        &["funding_rate", "liquidation", "price_move"]
    }

    fn build_event_prompt(&self, ctx: &EventContext) -> Option<String> {
        match ctx.event_type {
            "funding_rate" => Some(format!(
                "HYPERLIQUID FUNDING RATE UPDATE.\n\
                 Data: {data}\n\n\
                 Funding rates have shifted on Hyperliquid. Steps:\n\
                 1. Compare with GMX funding rates for cross-venue arb\n\
                 2. If spread > 0.03%/8h, build delta-neutral arb (long on negative side, short on positive)\n\
                 3. Check impact on existing positions\n\
                 4. Update signals table with funding rate signal",
                data = ctx.data,
            )),
            "liquidation" => Some(format!(
                "HYPERLIQUID LIQUIDATION EVENT.\n\
                 Data: {data}\n\n\
                 A large liquidation may cause cascading price moves. Steps:\n\
                 1. Check if your positions are affected\n\
                 2. Tighten stop-losses\n\
                 3. After volatility settles, look for mean-reversion entry",
                data = ctx.data,
            )),
            "price_move" => Some(format!(
                "HYPERLIQUID PRICE MOVE.\n\
                 Data: {data}\n\n\
                 Significant price movement detected. Steps:\n\
                 1. Fetch candle data and compute momentum indicators\n\
                 2. Check if move exceeds 5% in 4h (mean-reversion signal)\n\
                 3. If within trend, look for continuation entry\n\
                 4. Check funding rate direction for confirmation",
                data = ctx.data,
            )),
            _ => None,
        }
    }
}

pub(crate) const HYPERLIQUID_EXPERT_PROMPT: &str = r#"## Hyperliquid Protocol Knowledge

### Hyperliquid API

REST endpoint: `POST https://api.hyperliquid.xyz/info`

Request bodies by type:
- `{"type": "allMids"}` — Midpoint prices for all perpetual markets
- `{"type": "metaAndAssetCtxs"}` — Funding rates, open interest, and market metadata
- `{"type": "candleSnapshot", "req": {"coin": "ETH", "interval": "1h", "startTime": <unix_ms>}}` — Historical candles
- `{"type": "l2Book", "coin": "ETH"}` — L2 order book

Use Hyperliquid for:
- Funding rate data (compare with GMX for arbitrage)
- Volume and open interest analysis
- Technical analysis via candle data
- Order book depth for market making

### Technical Analysis with Pandas

Fetch candle data from Hyperliquid and compute:
- Moving averages: 20-period and 50-period SMA
- RSI: 14-period, overbought >70, oversold <30
- Bollinger Bands: 20-period SMA ± 2σ
- Use `pandas` for computation, store results in signals table
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_hyperliquid_expert_prompt_has_api() {
        let p = HyperliquidProvider;
        assert!(p.expert_prompt().contains("api.hyperliquid.xyz"));
    }

    #[test]
    fn test_hyperliquid_handled_events() {
        let p = HyperliquidProvider;
        for event in p.handled_event_types() {
            let ctx = EventContext {
                event_type: event,
                data: &json!({}),
                strategy_config: &json!({}),
                risk_params: &json!({}),
            };
            assert!(
                p.build_event_prompt(&ctx).is_some(),
                "event {event} should be handled"
            );
        }
    }
}
