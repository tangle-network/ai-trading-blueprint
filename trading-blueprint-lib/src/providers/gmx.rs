use super::{DataEndpoint, EventContext, TradingProvider};

pub struct GmxV2Provider;

impl TradingProvider for GmxV2Provider {
    fn id(&self) -> &'static str {
        "gmx_v2"
    }

    fn name(&self) -> &'static str {
        "GMX V2 Perpetuals"
    }

    fn protocol_adapters(&self) -> &[&'static str] {
        &["gmx_v2"]
    }

    fn expert_prompt(&self) -> &'static str {
        GMX_EXPERT_PROMPT
    }

    fn strategy_fragment(&self) -> &'static str {
        "Focus on GMX V2 perpetual futures on Arbitrum. \
         Monitor funding rates, open interest, and technical signals for position management."
    }

    fn data_endpoints(&self) -> &[DataEndpoint] {
        &GMX_ENDPOINTS
    }

    fn setup_commands(&self) -> Vec<String> {
        vec!["pip install websockets 2>/dev/null".into()]
    }

    fn required_env_vars(&self) -> &[&'static str] {
        &[]
    }

    fn handled_event_types(&self) -> &[&'static str] {
        &["funding_rate", "liquidation"]
    }

    fn build_event_prompt(&self, ctx: &EventContext) -> Option<String> {
        match ctx.event_type {
            "funding_rate" => Some(format!(
                "GMX V2 FUNDING RATE UPDATE.\n\
                 Data: {data}\n\n\
                 Funding rates have shifted on GMX V2. Steps:\n\
                 1. Compare GMX funding with Hyperliquid for cross-venue arb\n\
                 2. If spread > 0.03%/8h, consider delta-neutral arb position\n\
                 3. Check existing positions for P&L impact\n\
                 4. If highly positive funding (>0.05%/8h), short bias; if negative, long bias",
                data = ctx.data,
            )),
            "liquidation" => Some(format!(
                "GMX V2 LIQUIDATION EVENT.\n\
                 Data: {data}\n\n\
                 A liquidation has occurred, which may signal a price cascade. Steps:\n\
                 1. Check if the liquidation affected your positions' markets\n\
                 2. Look for mean-reversion opportunities after cascade\n\
                 3. Tighten stop-losses on existing positions\n\
                 4. Wait for volatility to subside before opening new positions",
                data = ctx.data,
            )),
            _ => None,
        }
    }
}

static GMX_ENDPOINTS: [DataEndpoint; 1] = [DataEndpoint {
    name: "GMX Prices",
    url: "https://arbitrum-api.gmxinfra.io/prices/tickers",
    description: "All GMX V2 market prices with min/max",
    auth: "None",
}];

pub(crate) const GMX_EXPERT_PROMPT: &str = r#"## GMX V2 Protocol Knowledge

### GMX V2 (Arbitrum)
- Exchange Router: 0x7C68C7866A64FA2160F78EEaE12217FFbf871fa8
- Order Vault: 0x31eF83a530Fde1B38deDA89C0A6c72e868c0eDAA
- Data Store: 0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8

Supported markets: ETH/USD, BTC/USD, ARB/USD, SOL/USD, LINK/USD

Actions: open_long, open_short, close_long, close_short
Each position requires: market address, collateral token, size (USD), leverage, acceptable price, execution fee.

### GMX REST API

Real-time prices for all GMX markets:
- `GET https://arbitrum-api.gmxinfra.io/prices/tickers` — All market prices with min/max

### Trading Methodology

1. **Signal Generation**:
   - Momentum: 1h and 4h price trends. Enter when both align.
   - Funding Rate: When funding rate is extremely positive (>0.05%/8h), short bias. When extremely negative, long bias.
   - Mean Reversion: After >5% move in 4h, look for reversal signals.

2. **Position Sizing**:
   - Maximum 3x leverage (conservative)
   - Risk no more than 2% of portfolio per trade
   - Maximum 3 concurrent positions

3. **Risk Management**:
   - Stop-loss: 3% from entry (mandatory for all positions)
   - Take-profit: 2:1 reward-to-risk minimum
   - Trailing stop: move stop to breakeven after 1.5x risk in profit
   - Check circuit breaker before every trade

4. **Trade Intent Format**: Submit through Trading HTTP API with:
   - `action`: "open_long", "open_short", "close_long", or "close_short"
   - `target_protocol`: "gmx_v2"
   - `token_in`: collateral token address
   - `amount_in`: collateral amount as string
   - `metadata.leverage`: leverage multiplier (max 3.0)
   - `metadata.market`: market address or symbol
   - `metadata.acceptable_price`: max/min execution price
   - `metadata.stop_loss_price`: mandatory stop-loss price
   - `metadata.take_profit_price`: take-profit price
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_gmx_expert_prompt_has_addresses() {
        let p = GmxV2Provider;
        assert!(p.expert_prompt().contains("0x7C68C7866A64FA2160F78EEaE12217FFbf871fa8"));
    }

    #[test]
    fn test_gmx_strategy_fragment() {
        let p = GmxV2Provider;
        assert!(p.strategy_fragment().contains("GMX V2"));
    }

    #[test]
    fn test_gmx_handled_events() {
        let p = GmxV2Provider;
        for event in p.handled_event_types() {
            let ctx = EventContext {
                event_type: event,
                data: &json!({}),
                strategy_config: &json!({}),
                risk_params: &json!({}),
            };
            assert!(p.build_event_prompt(&ctx).is_some());
        }
    }

    #[test]
    fn test_gmx_unhandled_event() {
        let p = GmxV2Provider;
        let ctx = EventContext {
            event_type: "unknown",
            data: &json!({}),
            strategy_config: &json!({}),
            risk_params: &json!({}),
        };
        assert!(p.build_event_prompt(&ctx).is_none());
    }
}
