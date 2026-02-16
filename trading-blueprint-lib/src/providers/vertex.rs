use super::{DataEndpoint, EventContext, TradingProvider};

pub struct VertexProvider;

impl TradingProvider for VertexProvider {
    fn id(&self) -> &'static str {
        "vertex"
    }

    fn name(&self) -> &'static str {
        "Vertex Protocol"
    }

    fn protocol_adapters(&self) -> &[&'static str] {
        &["vertex"]
    }

    fn expert_prompt(&self) -> &'static str {
        VERTEX_EXPERT_PROMPT
    }

    fn strategy_fragment(&self) -> &'static str {
        "Focus on Vertex Protocol's combined spot + perps order book on Arbitrum. \
         Use subaccount margining for capital-efficient positions."
    }

    fn data_endpoints(&self) -> &[DataEndpoint] {
        &[]
    }

    fn setup_commands(&self) -> Vec<String> {
        vec!["pip install websockets 2>/dev/null".into()]
    }

    fn required_env_vars(&self) -> &[&'static str] {
        &[]
    }

    fn handled_event_types(&self) -> &[&'static str] {
        &["funding_rate"]
    }

    fn build_event_prompt(&self, ctx: &EventContext) -> Option<String> {
        match ctx.event_type {
            "funding_rate" => Some(format!(
                "VERTEX FUNDING RATE UPDATE.\n\
                 Data: {data}\n\n\
                 Vertex funding rates have shifted. Steps:\n\
                 1. Compare with GMX and Hyperliquid for cross-venue arb opportunity\n\
                 2. Check existing Vertex positions\n\
                 3. If spread exceeds 0.03%/8h across venues, consider arb trade",
                data = ctx.data,
            )),
            _ => None,
        }
    }
}

pub(crate) const VERTEX_EXPERT_PROMPT: &str = r#"## Vertex Protocol Knowledge

### Vertex Protocol (Arbitrum)
- Endpoint: 0xbbEE07B3e8121227AfCFe1E2B82772571571571

Vertex combines spot + perps in a single order book. Uses subaccounts for margining.

### Trading Methodology

1. **Trade Intent Format**: Submit through Trading HTTP API with:
   - `action`: "open_long", "open_short", "close_long", or "close_short"
   - `target_protocol`: "vertex"
   - `token_in`: collateral token address
   - `amount_in`: collateral amount as string
   - `metadata.leverage`: leverage multiplier (max 3.0)
   - `metadata.market`: market address or symbol
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_vertex_expert_prompt_has_address() {
        let p = VertexProvider;
        assert!(p.expert_prompt().contains("0xbbEE07B3e8121227AfCFe1E2B82772571571571"));
    }

    #[test]
    fn test_vertex_strategy_fragment() {
        let p = VertexProvider;
        assert!(p.strategy_fragment().contains("Vertex"));
    }

    #[test]
    fn test_vertex_handled_events() {
        let p = VertexProvider;
        let ctx = EventContext {
            event_type: "funding_rate",
            data: &json!({}),
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
