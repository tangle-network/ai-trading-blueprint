use super::{EventContext, TradingProvider};

pub struct CoinGeckoProvider;

impl TradingProvider for CoinGeckoProvider {
    fn id(&self) -> &'static str {
        "coingecko"
    }

    fn name(&self) -> &'static str {
        "CoinGecko Market Data"
    }

    fn protocol_adapters(&self) -> &[&'static str] {
        &[]
    }

    fn expert_prompt(&self) -> &'static str {
        COINGECKO_EXPERT_PROMPT
    }

    fn setup_commands(&self) -> Vec<String> {
        vec![]
    }

    fn required_env_vars(&self) -> &[&'static str] {
        &[]
    }

    fn handled_event_types(&self) -> &[&'static str] {
        &[]
    }

    fn build_event_prompt(&self, _ctx: &EventContext) -> Option<String> {
        None
    }
}

pub(crate) const COINGECKO_EXPERT_PROMPT: &str = r#"## CoinGecko Market Data

### Price API
- `GET https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin&vs_currencies=usd` — Current prices
- `GET https://api.coingecko.com/api/v3/coins/{id}/market_chart?vs_currency=usd&days=30` — 30 days of price history

Rate limit: 30 requests/minute (free tier).

### Volatility Calculation

Use price history to compute realized volatility:
- Calculate log returns: `ln(price_t / price_{t-1})`
- Annualized volatility: `std(log_returns) * sqrt(365)`
- Compute 30d, 7d, and 1d realized vol for comparison
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_coingecko_expert_prompt_has_api() {
        let p = CoinGeckoProvider;
        assert!(p.expert_prompt().contains("api.coingecko.com"));
    }

    #[test]
    fn test_coingecko_is_data_only() {
        let p = CoinGeckoProvider;
        assert!(p.protocol_adapters().is_empty());
        assert!(p.handled_event_types().is_empty());
        assert!(p.setup_commands().is_empty());
    }

    #[test]
    fn test_coingecko_always_returns_none_for_events() {
        let p = CoinGeckoProvider;
        let ctx = EventContext {
            event_type: "price_move",
            data: &json!({}),
            strategy_config: &json!({}),
            risk_params: &json!({}),
        };
        assert!(p.build_event_prompt(&ctx).is_none());
    }

}
