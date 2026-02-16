use super::{DataEndpoint, EventContext, TradingProvider};

pub struct AaveV3Provider;

impl TradingProvider for AaveV3Provider {
    fn id(&self) -> &'static str {
        "aave_v3"
    }

    fn name(&self) -> &'static str {
        "Aave V3 Lending"
    }

    fn protocol_adapters(&self) -> &[&'static str] {
        &["aave_v3"]
    }

    fn expert_prompt(&self) -> &'static str {
        AAVE_EXPERT_PROMPT
    }

    fn strategy_fragment(&self) -> &'static str {
        "Focus on Aave V3 lending and borrowing optimization. \
         Monitor supply/borrow APYs, health factors, and utilization rates."
    }

    fn data_endpoints(&self) -> &[DataEndpoint] {
        &AAVE_ENDPOINTS
    }

    fn setup_commands(&self) -> Vec<String> {
        vec!["pip install web3 2>/dev/null".into()]
    }

    fn required_env_vars(&self) -> &[&'static str] {
        &[]
    }

    fn handled_event_types(&self) -> &[&'static str] {
        &["rate_change", "health_factor_warning"]
    }

    fn build_event_prompt(&self, ctx: &EventContext) -> Option<String> {
        match ctx.event_type {
            "rate_change" => Some(format!(
                "AAVE V3 RATE CHANGE.\n\
                 Data: {data}\n\n\
                 Interest rates have shifted. Steps:\n\
                 1. Compare new APYs with current positions\n\
                 2. Check if yield differential exceeds 1% threshold for rebalancing\n\
                 3. Verify gas cost < 10% of annual yield improvement\n\
                 4. If rebalancing is warranted, submit supply/withdraw intents",
                data = ctx.data,
            )),
            "health_factor_warning" => Some(format!(
                "AAVE V3 HEALTH FACTOR WARNING.\n\
                 Data: {data}\n\n\
                 Health factor is approaching danger zone. IMMEDIATE ACTION:\n\
                 1. Check current health factor via Pool Data Provider\n\
                 2. If HF < 1.5, reduce leverage immediately (repay or add collateral)\n\
                 3. Submit repay intent through Trading HTTP API\n\
                 4. Target HF > 2.0 after rebalancing",
                data = ctx.data,
            )),
            _ => None,
        }
    }
}

static AAVE_ENDPOINTS: [DataEndpoint; 2] = [
    DataEndpoint {
        name: "DeFiLlama Pools",
        url: "https://yields.llama.fi/pools",
        description: "All DeFi pools with APY, TVL, chain, protocol",
        auth: "None",
    },
    DataEndpoint {
        name: "DeFiLlama Protocol",
        url: "https://api.llama.fi/protocol/aave-v3",
        description: "Aave V3 TVL and protocol data",
        auth: "None",
    },
];

pub(crate) const AAVE_EXPERT_PROMPT: &str = r#"## Aave V3 Protocol Knowledge

### Aave V3 (Ethereum Mainnet)
- Pool: 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2
- Pool Data Provider: 0x7B4EB56E7CD4b454BA8ff71E4518426c96956482

Actions: supply, withdraw, borrow, repay
Each action requires the asset address and amount.

Key metrics to monitor:
- Supply APY (variable rate)
- Borrow APY (variable + stable rates)
- Utilization rate (high utilization = higher rates but more risk)
- Health factor (MUST stay above 1.5 for safety, liquidation at 1.0)

### DeFiLlama Yields API

Automated yield scanning across all DeFi:
- `GET https://yields.llama.fi/pools` — All pools with APY, TVL, chain, protocol
- Filter by chain: look for `chain == "Ethereum"` in results
- Filter by protocol: look for `project == "aave-v3"` in results
- Sort by `apy` descending, filter for `tvlUsd > 1000000` for safety

Response fields: `pool`, `chain`, `project`, `symbol`, `tvlUsd`, `apy`, `apyBase`, `apyReward`, `stablecoin`, `exposure`

### Yield Comparison Methodology

Build a tool that periodically fetches DeFiLlama pools and compares with current positions:
1. Fetch all pools → filter by chain and minimum TVL
2. Group by asset (USDC, ETH, WBTC)
3. Compare current position APY vs best available
4. Only rebalance if improvement > 1% APY AND gas cost < 10% of annual gain

### Health Factor Monitoring

Write a monitoring script that checks health factor every iteration:
- HF > 2.0: safe, can add leverage
- 1.5 < HF < 2.0: caution, do not add leverage
- HF < 1.5: WARNING — reduce leverage immediately

### Trading Methodology

1. **Yield Scanning**: Compare risk-adjusted yields for each asset. Factor in:
   - Base APY
   - Reward token APY (if any)
   - Protocol risk premium
   - Smart contract risk

2. **Opportunity Detection**: Rebalance when yield differential between current position and best alternative exceeds 1% APY (annualized).

3. **Health Factor Management**: For leveraged yield strategies (borrow-supply loops), maintain health factor > 1.5. If HF drops below 2.0, reduce leverage.

4. **Trade Intent Format**: Submit through Trading HTTP API with:
   - `action`: "supply", "withdraw", "borrow", or "repay"
   - `target_protocol`: "aave_v3"
   - `token_in`: asset address
   - `amount_in`: amount as string (in token decimals)
   - `metadata.on_behalf_of`: vault address (for Aave)

5. **Rebalancing Frequency**: Yields change slowly — evaluate every 15 minutes. Only rebalance if the gas cost is <10% of the yield improvement (annualized over expected holding period).
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_aave_expert_prompt_has_addresses() {
        let p = AaveV3Provider;
        assert!(p.expert_prompt().contains("0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"));
    }

    #[test]
    fn test_aave_strategy_fragment() {
        let p = AaveV3Provider;
        assert!(p.strategy_fragment().contains("Aave V3"));
    }

    #[test]
    fn test_aave_handled_events() {
        let p = AaveV3Provider;
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
    fn test_aave_unhandled_event() {
        let p = AaveV3Provider;
        let ctx = EventContext {
            event_type: "something_else",
            data: &json!({}),
            strategy_config: &json!({}),
            risk_params: &json!({}),
        };
        assert!(p.build_event_prompt(&ctx).is_none());
    }
}
