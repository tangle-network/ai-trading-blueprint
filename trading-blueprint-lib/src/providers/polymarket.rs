use super::{DataEndpoint, EventContext, TradingProvider};

pub struct PolymarketProvider;

impl TradingProvider for PolymarketProvider {
    fn id(&self) -> &'static str {
        "polymarket"
    }

    fn name(&self) -> &'static str {
        "Polymarket Prediction Markets"
    }

    fn protocol_adapters(&self) -> &[&'static str] {
        &["polymarket"]
    }

    fn expert_prompt(&self) -> &'static str {
        POLYMARKET_EXPERT_PROMPT
    }

    fn strategy_fragment(&self) -> &'static str {
        "Focus on event-based trading on Polymarket prediction markets. \
         Use Gamma API for market discovery, CLOB API for order books, \
         and cross-reference with crypto prices for edge detection."
    }

    fn data_endpoints(&self) -> &[DataEndpoint] {
        &POLYMARKET_ENDPOINTS
    }

    fn setup_commands(&self) -> Vec<String> {
        vec!["pip install py-clob-client 2>/dev/null".into()]
    }

    fn required_env_vars(&self) -> &[&'static str] {
        &[
            "POLYMARKET_API_KEY",
            "POLYMARKET_API_SECRET",
            "POLYMARKET_API_PASSPHRASE",
        ]
    }

    fn handled_event_types(&self) -> &[&'static str] {
        &["price_move", "market_resolved", "new_market"]
    }

    fn build_event_prompt(&self, ctx: &EventContext) -> Option<String> {
        match ctx.event_type {
            "price_move" => Some(format!(
                "POLYMARKET PRICE MOVE ALERT.\n\
                 Data: {data}\n\n\
                 Analyze this price movement using the CLOB order book. Steps:\n\
                 1. Fetch current book depth at clob.polymarket.com/book?token_id={{token_id}}\n\
                 2. Calculate if the move creates edge (EV > 5%)\n\
                 3. Check your current positions in the markets table\n\
                 4. If edge exists and position sizing allows (half-Kelly, max 10% per position), \
                    submit a trade intent through the Trading HTTP API\n\
                 5. Log analysis to /home/agent/logs/decisions.jsonl",
                data = ctx.data,
            )),
            "market_resolved" => Some(format!(
                "POLYMARKET MARKET RESOLVED.\n\
                 Data: {data}\n\n\
                 A prediction market has resolved. Steps:\n\
                 1. Check if you hold any positions in this market (query trades table)\n\
                 2. Record P&L for any closed positions\n\
                 3. Update performance metrics in /home/agent/metrics/latest.json\n\
                 4. Write insight to memory table about what worked/didn't",
                data = ctx.data,
            )),
            "new_market" => Some(format!(
                "NEW POLYMARKET MARKET.\n\
                 Data: {data}\n\n\
                 A new prediction market has been listed. Steps:\n\
                 1. Fetch full market details from Gamma API\n\
                 2. Store in markets table with metadata\n\
                 3. If volume > $50k and end date > 24h, add to watchlist\n\
                 4. Estimate initial probability and compare with current price",
                data = ctx.data,
            )),
            _ => None,
        }
    }
}

static POLYMARKET_ENDPOINTS: [DataEndpoint; 4] = [
    DataEndpoint {
        name: "Gamma Events",
        url: "https://gamma-api.polymarket.com/events?closed=false&limit=50&order=volume",
        description: "Top prediction market events by volume",
        auth: "None",
    },
    DataEndpoint {
        name: "Gamma Markets",
        url: "https://gamma-api.polymarket.com/markets",
        description: "Active markets with metadata",
        auth: "None",
    },
    DataEndpoint {
        name: "CLOB Book",
        url: "https://clob.polymarket.com/book?token_id={token_id}",
        description: "Full order book (bids, asks, spread)",
        auth: "None",
    },
    DataEndpoint {
        name: "CLOB Midpoint",
        url: "https://clob.polymarket.com/midpoint?token_id={token_id}",
        description: "Current midpoint price",
        auth: "None",
    },
];

pub(crate) const POLYMARKET_EXPERT_PROMPT: &str = r#"## Polymarket Protocol Knowledge

### Market Discovery — Gamma API
Base URL: https://gamma-api.polymarket.com

Endpoints:
- GET /events?closed=false&limit=50&order=volume — Top events by volume
- GET /markets — List all active markets. Supports query params: `limit`, `offset`, `order` (volume, liquidity, created), `ascending` (true/false), `tag` (politics, crypto, sports, etc.), `closed` (false for active only)
- GET /markets/{condition_id} — Single market details (title, description, outcomes, resolution source, end_date)
- GET /markets?slug={slug} — Look up by URL slug

Response fields: `id` (condition_id), `question`, `outcomes` (array of outcome strings), `outcomePrices` (JSON string of price array, e.g. "[\"0.65\",\"0.35\"]"), `volume`, `liquidity`, `endDate`, `closed`, `marketSlug`, `resolutionSource`

### Order Book & Pricing — CLOB API
Base URL: https://clob.polymarket.com

Endpoints:
- GET /markets — Active CLOB markets with token_ids
- GET /book?token_id={token_id} — Full order book (bids, asks, spread)
- GET /midpoint?token_id={token_id} — Current midpoint price
- GET /price?token_id={token_id}&side=BUY — Best available price for a side
- GET /trades?market={condition_id} — Recent trades with timestamps and sizes

The CLOB API uses condition_id (from Gamma) to map to token_ids. Each binary market has two token_ids: one for YES, one for NO. The `book` endpoint returns `{ bids: [{price, size}], asks: [{price, size}] }`.

### Conditional Token Framework (CTF) Contracts (Polygon)
- CTF Exchange: 0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E
- Conditional Tokens: 0x4D97DCd97eC945f40cF65F87097ACe5EA0476045
- USDC (Polygon): 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174

### Autonomous Market Discovery

Every 3rd iteration, do a full market scan:
1. Fetch top 50 events by volume from `GET /events?closed=false&limit=50&order=volume`
2. For each event, get market details and CLOB midpoints
3. Store all discovered markets in the `markets` table
4. On non-scan iterations, only update prices for markets in your watchlist

### Cross-Reference with Crypto Prices

For crypto-related prediction markets (e.g. "Will ETH be above $X by date?"):
1. Fetch current price from CoinGecko
2. Compare market implied probability (price) with your fundamental estimate
3. Example: If ETH=$3000, and "ETH > $3500 by March?" trades at $0.40, calculate whether 40% probability is fair given historical volatility

### News & Resolution Checking

Markets have a `resolutionSource` field — fetch it periodically to check for early resolution signals. Markets that resolve early offer risk-free exits if you're on the right side.

### Trading Methodology

1. **Market Scanning**: Query Gamma API for high-volume, high-liquidity markets. Filter for markets ending >24h from now with volume >$50k.

2. **Price Discovery**: For each candidate market, fetch CLOB midpoint prices. Compare with your fundamental probability estimate.

3. **Edge Detection**: Calculate expected value: `EV = (your_prob * payout) - price`. Only trade when EV > 5% (minimum edge threshold).

4. **Order Book Analysis**: Check CLOB book depth. Ensure sufficient liquidity at your target size. Avoid markets with >5% spread.

5. **Position Sizing**: Use half-Kelly criterion: `kelly_fraction = (edge / odds) / 2`. Cap at 10% of portfolio per position. Maximum 3 concurrent positions.

6. **Risk Management**:
   - Check circuit breaker before every trade
   - Stop-loss: exit if position value drops 50% from entry
   - Take-profit: consider exiting at 80%+ probability (diminishing returns)
   - Never hold through resolution unless confidence is very high

7. **Execution**: Submit trade intents through the Trading HTTP API with:
   - `action`: "buy" or "sell"
   - `target_protocol`: "polymarket"
   - `token_in`: USDC address
   - `token_out`: conditional token address (token_id from CLOB)
   - `amount_in`: position size in USDC (6 decimals)
   - Include `metadata.condition_id`, `metadata.outcome_index`, `metadata.market_slug`
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_polymarket_expert_prompt_has_api_urls() {
        let p = PolymarketProvider;
        let prompt = p.expert_prompt();
        assert!(prompt.contains("gamma-api.polymarket.com"));
        assert!(prompt.contains("clob.polymarket.com"));
        assert!(prompt.contains("0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E"));
        assert!(prompt.contains("0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"));
    }

    #[test]
    fn test_polymarket_strategy_fragment_mentions_adapter() {
        let p = PolymarketProvider;
        assert!(p.strategy_fragment().contains("Polymarket"));
    }

    #[test]
    fn test_polymarket_handled_events_match_build() {
        let p = PolymarketProvider;
        let ctx = EventContext {
            event_type: "",
            data: &json!({}),
            strategy_config: &json!({}),
            risk_params: &json!({}),
        };

        for event in p.handled_event_types() {
            let ctx = EventContext {
                event_type: event,
                ..ctx
            };
            assert!(
                p.build_event_prompt(&ctx).is_some(),
                "handled event {event} returned None from build_event_prompt"
            );
        }
    }

    #[test]
    fn test_polymarket_unhandled_event_returns_none() {
        let p = PolymarketProvider;
        let ctx = EventContext {
            event_type: "unknown_event",
            data: &json!({}),
            strategy_config: &json!({}),
            risk_params: &json!({}),
        };
        assert!(p.build_event_prompt(&ctx).is_none());
    }

    #[test]
    fn test_polymarket_setup_commands_non_empty() {
        let p = PolymarketProvider;
        assert!(!p.setup_commands().is_empty());
        assert!(p.setup_commands()[0].contains("py-clob-client"));
    }

    #[test]
    fn test_polymarket_data_endpoints() {
        let p = PolymarketProvider;
        let endpoints = p.data_endpoints();
        assert!(!endpoints.is_empty());
        assert!(endpoints.iter().any(|e| e.url.contains("gamma-api")));
        assert!(endpoints.iter().any(|e| e.url.contains("clob.polymarket")));
    }
}
