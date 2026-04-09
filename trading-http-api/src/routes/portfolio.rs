use crate::metrics_store;
use crate::trade_store;
use crate::{MultiBotTradingState, TradingApiState};
use alloy::primitives::{Address, Bytes, U256};
use alloy::providers::{Provider, ProviderBuilder};
use alloy::rpc::types::TransactionRequest;
use alloy::sol_types::{SolCall, SolValue};
use axum::{Extension, Json, Router, extract::State, routing::post};
use chrono::Utc;
use rust_decimal::Decimal;
use serde::Serialize;
use std::str::FromStr;
use std::sync::Arc;
use trading_runtime::contracts::ITradingVault;
use trading_runtime::market_data::MarketDataClient;
use trading_runtime::types::{PositionType, PriceData, ValuationStatus};

#[derive(Serialize)]
pub struct PortfolioResponse {
    pub positions: Vec<PositionEntry>,
    pub total_value_usd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cash_balance: Option<String>,
    pub unrealized_pnl: String,
    pub realized_pnl: String,
    #[serde(default)]
    pub warnings: Vec<String>,
    pub has_unpriced_positions: bool,
}

#[derive(Serialize)]
pub struct PositionEntry {
    pub token: String,
    pub amount: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value_usd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry_price: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_price: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unrealized_pnl: Option<String>,
    pub protocol: String,
    pub position_type: String,
    pub valuation_status: ValuationStatus,
}

pub fn router() -> Router<Arc<TradingApiState>> {
    Router::new().route("/portfolio/state", post(get_state))
}

pub fn multi_bot_router() -> Router<Arc<MultiBotTradingState>> {
    Router::new().route("/portfolio/state", post(get_state_multi_bot))
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
    let has_unpriced_positions = portfolio
        .positions
        .iter()
        .any(|position| position.valuation_status != ValuationStatus::Priced);
    let entries: Vec<PositionEntry> = portfolio
        .positions
        .iter()
        .map(|p| {
            let priced = p.valuation_status == ValuationStatus::Priced;
            PositionEntry {
                token: p.token.clone(),
                amount: p.amount.to_string(),
                value_usd: priced.then(|| (p.current_price * p.amount).to_string()),
                entry_price: priced.then(|| p.entry_price.to_string()),
                current_price: priced.then(|| p.current_price.to_string()),
                unrealized_pnl: priced.then(|| p.unrealized_pnl.to_string()),
                protocol: p.protocol.clone(),
                position_type: serde_json::to_value(&p.position_type)
                    .ok()
                    .and_then(|v| v.as_str().map(String::from))
                    .unwrap_or_else(|| format!("{:?}", p.position_type)),
                valuation_status: p.valuation_status,
            }
        })
        .collect();

    Json(PortfolioResponse {
        total_value_usd: portfolio.total_value_usd.to_string(),
        cash_balance: None,
        unrealized_pnl: portfolio.unrealized_pnl.to_string(),
        realized_pnl: portfolio.realized_pnl.to_string(),
        positions: entries,
        warnings: if has_unpriced_positions {
            vec![
                "Some portfolio values are unavailable because trade valuation data is missing."
                    .to_string(),
            ]
        } else {
            Vec::new()
        },
        has_unpriced_positions,
    })
}

async fn get_state_multi_bot(
    State(state): State<Arc<MultiBotTradingState>>,
    Extension(bot): Extension<crate::BotContext>,
) -> Json<PortfolioResponse> {
    let latest_snapshot = metrics_store::latest_snapshot_for_bot(&bot.bot_id)
        .ok()
        .flatten();
    let trade_total = trade_store::trades_for_bot(&bot.bot_id, 1, 0)
        .ok()
        .map(|result| result.total)
        .unwrap_or(0);

    let mut warnings = Vec::new();
    let mut positions = Vec::new();
    let mut cash_balance = None;
    let mut has_unpriced_positions = false;

    let onchain_total = match read_vault_cash_position(&bot, &state.market_data_base_url).await {
        Ok(Some(position)) => {
            let onchain_value = position
                .value_usd
                .clone()
                .unwrap_or_else(|| "0".to_string());
            cash_balance = Some(position.amount.clone());
            has_unpriced_positions = position.valuation_status != ValuationStatus::Priced;
            positions.push(position);
            onchain_value
        }
        Ok(None) => "0".to_string(),
        Err(e) => {
            warnings.push(format!(
                "On-chain vault balance lookup failed; using latest snapshot fallback: {e}"
            ));
            latest_snapshot
                .as_ref()
                .map(|snapshot| snapshot.account_value_usd.clone())
                .unwrap_or_else(|| "0".to_string())
        }
    };

    if positions.is_empty() && trade_total > 0 {
        warnings.push(
            "Portfolio position breakdown is not yet fully persisted in fleet mode; showing aggregate totals."
                .to_string(),
        );
    }

    Json(PortfolioResponse {
        positions,
        total_value_usd: if onchain_total == "0" {
            latest_snapshot
                .as_ref()
                .map(|snapshot| snapshot.account_value_usd.clone())
                .unwrap_or_else(|| "0".to_string())
        } else {
            onchain_total
        },
        cash_balance,
        unrealized_pnl: latest_snapshot
            .as_ref()
            .map(|snapshot| snapshot.unrealized_pnl.clone())
            .unwrap_or_else(|| "0".to_string()),
        realized_pnl: latest_snapshot
            .as_ref()
            .map(|snapshot| snapshot.realized_pnl.clone())
            .unwrap_or_else(|| "0".to_string()),
        warnings,
        has_unpriced_positions,
    })
}

async fn read_vault_cash_position(
    bot: &crate::BotContext,
    market_data_base_url: &str,
) -> Result<Option<PositionEntry>, String> {
    let provider = ProviderBuilder::new().connect_http(
        bot.rpc_url
            .parse()
            .map_err(|e| format!("invalid bot rpc_url '{}': {e}", bot.rpc_url))?,
    );
    let vault_addr: Address = bot
        .vault_address
        .parse()
        .map_err(|e| format!("invalid vault address '{}': {e}", bot.vault_address))?;

    let asset_addr = eth_call_address(
        &provider,
        vault_addr,
        ITradingVault::assetCall {}.abi_encode(),
    )
    .await
    .map_err(|e| format!("vault asset read failed: {e}"))?;
    let balance_raw = eth_call_u256(
        &provider,
        vault_addr,
        ITradingVault::getBalanceCall { token: asset_addr }.abi_encode(),
    )
    .await
    .map_err(|e| format!("vault getBalance failed: {e}"))?;

    if balance_raw.is_zero() {
        return Ok(None);
    }

    let token_symbol = eth_call_string(&provider, asset_addr, hex::decode("95d89b41").unwrap())
        .await
        .unwrap_or_else(|_| format!("{asset_addr:#x}"));
    let decimals_u256 = eth_call_u256(&provider, asset_addr, hex::decode("313ce567").unwrap())
        .await
        .unwrap_or_else(|_| U256::from(18));
    let decimals: u8 = decimals_u256.to();
    let amount_display = format_units(balance_raw, decimals);

    let mut value_usd = None;
    let mut current_price = None;
    let market_client = MarketDataClient::new(market_data_base_url.to_string());
    if let Ok(price_rows) = market_client
        .get_prices(std::slice::from_ref(&token_symbol))
        .await
    {
        if let Some(row) = price_rows
            .iter()
            .find(|row| row.token.eq_ignore_ascii_case(&token_symbol))
        {
            current_price = Some(row.price_usd.to_string());
            let amount_decimal = Decimal::from_str(&amount_display).unwrap_or(Decimal::ZERO);
            value_usd = Some((amount_decimal * row.price_usd).to_string());
        }
    }

    Ok(Some(PositionEntry {
        token: token_symbol,
        amount: amount_display,
        value_usd: value_usd.clone(),
        entry_price: None,
        current_price,
        unrealized_pnl: Some("0".to_string()),
        protocol: "vault".to_string(),
        position_type: "spot".to_string(),
        valuation_status: if value_usd.is_some() {
            ValuationStatus::Priced
        } else {
            ValuationStatus::Unpriced
        },
    }))
}

async fn eth_call_u256(
    provider: &impl Provider,
    to: Address,
    data: Vec<u8>,
) -> Result<U256, String> {
    let tx = TransactionRequest::default()
        .to(to)
        .input(Bytes::from(data).into());

    let result = provider
        .call(tx)
        .await
        .map_err(|e| format!("eth_call failed: {e}"))?;

    U256::abi_decode(&result).map_err(|e| format!("abi decode u256 failed: {e}"))
}

async fn eth_call_address(
    provider: &impl Provider,
    to: Address,
    data: Vec<u8>,
) -> Result<Address, String> {
    let tx = TransactionRequest::default()
        .to(to)
        .input(Bytes::from(data).into());

    let result = provider
        .call(tx)
        .await
        .map_err(|e| format!("eth_call failed: {e}"))?;

    Address::abi_decode(&result).map_err(|e| format!("abi decode address failed: {e}"))
}

async fn eth_call_string(
    provider: &impl Provider,
    to: Address,
    data: Vec<u8>,
) -> Result<String, String> {
    let tx = TransactionRequest::default()
        .to(to)
        .input(Bytes::from(data).into());

    let result = provider
        .call(tx)
        .await
        .map_err(|e| format!("eth_call failed: {e}"))?;

    String::abi_decode(&result).map_err(|e| format!("abi decode string failed: {e}"))
}

fn format_units(amount: U256, decimals: u8) -> String {
    let mut digits = amount.to_string();
    let decimals = decimals as usize;
    if decimals == 0 {
        return digits;
    }

    if digits.len() <= decimals {
        let zeros = "0".repeat(decimals - digits.len());
        digits = format!("0.{zeros}{digits}");
    } else {
        let split = digits.len() - decimals;
        digits.insert(split, '.');
    }

    let trimmed = digits.trim_end_matches('0').trim_end_matches('.');
    if trimmed.is_empty() {
        "0".to_string()
    } else {
        trimmed.to_string()
    }
}
