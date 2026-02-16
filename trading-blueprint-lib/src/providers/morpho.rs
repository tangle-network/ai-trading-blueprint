use super::{DataEndpoint, EventContext, TradingProvider};

pub struct MorphoProvider;

impl TradingProvider for MorphoProvider {
    fn id(&self) -> &'static str {
        "morpho"
    }

    fn name(&self) -> &'static str {
        "Morpho Blue Lending"
    }

    fn protocol_adapters(&self) -> &[&'static str] {
        &["morpho"]
    }

    fn expert_prompt(&self) -> &'static str {
        MORPHO_EXPERT_PROMPT
    }

    fn strategy_fragment(&self) -> &'static str {
        "Focus on Morpho Blue aggregated lending/borrowing. \
         Compare vault APYs across isolated markets for optimal yield."
    }

    fn data_endpoints(&self) -> &[DataEndpoint] {
        &MORPHO_ENDPOINTS
    }

    fn setup_commands(&self) -> Vec<String> {
        vec!["pip install web3 2>/dev/null".into()]
    }

    fn required_env_vars(&self) -> &[&'static str] {
        &[]
    }

    fn handled_event_types(&self) -> &[&'static str] {
        &["rate_change"]
    }

    fn build_event_prompt(&self, ctx: &EventContext) -> Option<String> {
        match ctx.event_type {
            "rate_change" => Some(format!(
                "MORPHO RATE CHANGE.\n\
                 Data: {data}\n\n\
                 Morpho market rates have changed. Steps:\n\
                 1. Compare new vault APYs with current positions\n\
                 2. Check DeFiLlama for cross-protocol yield comparison\n\
                 3. If Morpho offers >1% APY improvement over current position, rebalance\n\
                 4. Verify gas cost < 10% of annual yield improvement before acting",
                data = ctx.data,
            )),
            _ => None,
        }
    }
}

static MORPHO_ENDPOINTS: [DataEndpoint; 1] = [DataEndpoint {
    name: "DeFiLlama Morpho",
    url: "https://api.llama.fi/protocol/morpho",
    description: "Morpho protocol TVL and data",
    auth: "None",
}];

pub(crate) const MORPHO_EXPERT_PROMPT: &str = r#"## Morpho Protocol Knowledge

### Morpho Blue (Ethereum Mainnet)
- Morpho Blue: 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb

Morpho aggregates lending/borrowing across multiple markets. Check vault APYs via the Morpho API or directly from vault contracts.

### Trading Methodology

1. **Yield Scanning**: Compare Morpho vault APYs with Aave V3 for the same assets. Factor in:
   - Base APY
   - Protocol risk (Morpho uses isolated markets — different risk profile than Aave's shared pool)
   - Smart contract risk

2. **Trade Intent Format**: Submit through Trading HTTP API with:
   - `action`: "supply" or "withdraw"
   - `target_protocol`: "morpho"
   - `token_in`: asset address
   - `amount_in`: amount as string (in token decimals)
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_morpho_expert_prompt_has_address() {
        let p = MorphoProvider;
        assert!(p.expert_prompt().contains("0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb"));
    }

    #[test]
    fn test_morpho_strategy_fragment() {
        let p = MorphoProvider;
        assert!(p.strategy_fragment().contains("Morpho"));
    }

    #[test]
    fn test_morpho_handled_events() {
        let p = MorphoProvider;
        let ctx = EventContext {
            event_type: "rate_change",
            data: &json!({}),
            strategy_config: &json!({}),
            risk_params: &json!({}),
        };
        assert!(p.build_event_prompt(&ctx).is_some());
    }
}
