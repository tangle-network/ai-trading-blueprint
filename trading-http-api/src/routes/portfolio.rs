use crate::TradingApiState;
use axum::{Json, Router, extract::State, routing::post};
use chrono::Utc;
use serde::Serialize;
use std::sync::Arc;
use trading_runtime::types::{PositionType, PriceData};

#[derive(Serialize)]
pub struct PortfolioResponse {
    pub positions: Vec<PositionEntry>,
    pub total_value_usd: String,
    pub unrealized_pnl: String,
    pub realized_pnl: String,
}

#[derive(Serialize)]
pub struct PositionEntry {
    pub token: String,
    pub amount: String,
    pub entry_price: String,
    pub current_price: String,
    pub unrealized_pnl: String,
    pub protocol: String,
    pub position_type: String,
}

pub fn router() -> Router<Arc<TradingApiState>> {
    Router::new().route("/portfolio/state", post(get_state))
}

/// Refresh portfolio prices from market data and CLOB midpoints before returning state.
///
/// For on-chain positions: fetches from MarketDataClient.
/// For CLOB (ConditionalToken) positions: fetches midpoint from ClobClient.
/// Price fetch failures are logged but don't block the response — stale prices are better
/// than no portfolio at all.
async fn get_state(State(state): State<Arc<TradingApiState>>) -> Json<PortfolioResponse> {
    // Collect tokens that need price refresh (under read lock, briefly).
    let tokens_to_refresh: Vec<(String, PositionType)> = {
        let portfolio = state.portfolio.read().await;
        portfolio
            .positions
            .iter()
            .map(|p| (p.token.clone(), p.position_type.clone()))
            .collect()
    };

    if !tokens_to_refresh.is_empty() {
        let mut prices = Vec::new();

        // Split by position type: CLOB tokens use midpoint, others use market data.
        let mut market_tokens = Vec::new();
        let mut clob_tokens = Vec::new();

        for (token, ptype) in &tokens_to_refresh {
            if *ptype == PositionType::ConditionalToken {
                clob_tokens.push(token.clone());
            } else {
                market_tokens.push(token.clone());
            }
        }

        // Fetch on-chain token prices.
        if !market_tokens.is_empty() {
            match state.market_client.get_prices(&market_tokens).await {
                Ok(market_prices) => prices.extend(market_prices),
                Err(e) => {
                    tracing::warn!(error = %e, "Failed to fetch market prices for portfolio refresh");
                }
            }
        }

        // Fetch CLOB midpoints for conditional token positions.
        if let Some(clob) = state.clob_client.as_ref() {
            for token_id in &clob_tokens {
                match clob.get_midpoint(token_id).await {
                    Ok(midpoint) => {
                        prices.push(PriceData {
                            token: token_id.clone(),
                            price_usd: midpoint,
                            source: "polymarket_clob".into(),
                            timestamp: Utc::now(),
                        });
                    }
                    Err(e) => {
                        tracing::warn!(
                            token_id = %token_id,
                            error = %e,
                            "Failed to fetch CLOB midpoint for portfolio refresh"
                        );
                    }
                }
            }
        }

        // Apply price updates under write lock.
        if !prices.is_empty() {
            let mut portfolio = state.portfolio.write().await;
            portfolio.update_prices(&prices);
        }
    }

    // Read final state and serialize.
    let portfolio = state.portfolio.read().await;
    let entries: Vec<PositionEntry> = portfolio
        .positions
        .iter()
        .map(|p| PositionEntry {
            token: p.token.clone(),
            amount: p.amount.to_string(),
            entry_price: p.entry_price.to_string(),
            current_price: p.current_price.to_string(),
            unrealized_pnl: p.unrealized_pnl.to_string(),
            protocol: p.protocol.clone(),
            position_type: serde_json::to_value(&p.position_type)
                .ok()
                .and_then(|v| v.as_str().map(String::from))
                .unwrap_or_else(|| format!("{:?}", p.position_type)),
        })
        .collect();

    Json(PortfolioResponse {
        total_value_usd: portfolio.total_value_usd.to_string(),
        unrealized_pnl: portfolio.unrealized_pnl.to_string(),
        realized_pnl: portfolio.realized_pnl.to_string(),
        positions: entries,
    })
}
