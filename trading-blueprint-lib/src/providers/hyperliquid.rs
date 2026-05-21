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
        vec![] // Agent installs npm packages during bootstrap
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

pub(crate) const HYPERLIQUID_EXPERT_PROMPT: &str = r#"## Hyperliquid Perpetuals — Full Trading API

You have native Hyperliquid perps trading via the trading API. Use these endpoints
instead of the on-chain bridge adapter — they're faster and support all order types.

### Place Orders — POST /hyperliquid/order

```json
// Market buy 0.1 ETH perp
{"asset": "ETH", "is_buy": true, "size": "0.1", "order_type": {"type": "market"}}

// Limit sell 0.05 BTC perp at $68,000
{"asset": "BTC", "is_buy": false, "size": "0.05", "order_type": {"type": "limit", "price": "68000"}}

// Stop-loss: sell ETH if price drops to $2,400
{"asset": "ETH", "is_buy": false, "size": "0.1", "order_type": {"type": "stop_loss", "trigger_price": "2400", "is_market": true}, "reduce_only": true}

// Take-profit: sell ETH at $3,000
{"asset": "ETH", "is_buy": false, "size": "0.1", "order_type": {"type": "take_profit", "trigger_price": "3000", "is_market": true}, "reduce_only": true}
```

### Bracket Orders (entry + SL + TP) — POST /hyperliquid/bracket

Places entry, stop-loss, and take-profit as a grouped order:
```json
{
  "entry": {"asset": "ETH", "is_buy": true, "size": "0.1", "order_type": {"type": "market"}},
  "stop_loss": {"asset": "ETH", "is_buy": false, "size": "0.1", "order_type": {"type": "stop_loss", "trigger_price": "2400", "is_market": true}},
  "take_profit": {"asset": "ETH", "is_buy": false, "size": "0.1", "order_type": {"type": "take_profit", "trigger_price": "3000", "is_market": true}}
}
```

### Cancel Orders — POST /hyperliquid/cancel
```json
{"asset": 1, "order_id": 12345}
```

### Set Leverage — POST /hyperliquid/leverage
```json
{"asset": 1, "leverage": 5, "is_cross": true}
```
Set before placing orders. `is_cross: true` for cross-margin, `false` for isolated.

### Account State — GET /hyperliquid/account
Returns positions, margin, equity, open orders. Use to check:
- Current positions and P&L
- Available margin before new trades
- Open orders that might conflict

### Vault NAV, Mode, and Settlement
- GET /hyperliquid/nav — Check fresh vault NAV, idle USDC, Hyperliquid equity, and withdrawable USDC before opening risk.
- GET /hyperliquid/mode — Check before opening or increasing exposure. In `liquidity` mode, cancel non-essential orders, prefer reduce-only trades, and avoid new exposure. In `emergency_wind_down`, do not open new risk.
- GET /hyperliquid/settlement — Reports withdrawal pressure, idle buffer target, cash needed, next settlement, cutoff, and rollover status.

### Prices — GET /hyperliquid/prices
Returns mid prices for all HL perp markets as `{"ETH": "2500.5", "BTC": "67432.1", ...}`.

### Asset IDs
Use symbol strings ("ETH", "BTC", "SOL", etc.) or numeric indices (0=BTC, 1=ETH, ...).

### Risk Management Rules
1. Always set leverage BEFORE placing orders
2. Use bracket orders (entry + SL + TP) for every position
3. Never risk more than 2% of account per trade
4. Check GET /hyperliquid/nav, GET /hyperliquid/mode, and GET /hyperliquid/account before opening new positions
5. Use reduce_only=true for all exit orders (SL, TP, manual close)

### Read-Only Market Data (direct API)
For analysis, you can also call the HL info API directly:
- `POST https://api.hyperliquid.xyz/info` with `{"type": "allMids"}` — all mid prices
- `{"type": "metaAndAssetCtxs"}` — funding rates, open interest, metadata
- `{"type": "candleSnapshot", "req": {"coin": "ETH", "interval": "1h", "startTime": <unix_ms>}}` — candles
- `{"type": "l2Book", "coin": "ETH"}` — order book depth
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
