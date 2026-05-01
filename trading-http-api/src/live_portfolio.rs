use alloy::primitives::{Address, Bytes, U256};
use alloy::providers::{Provider, ProviderBuilder};
use alloy::rpc::types::TransactionRequest;
use alloy::sol;
use alloy::sol_types::{SolCall, SolValue};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde_json::Value;
use std::str::FromStr;

use crate::metrics_store;
use crate::routes::portfolio::{PortfolioResponse, PositionEntry};
use crate::{BotContext, TradingApiState};
use trading_runtime::aave_v3_registry::{market_for_chain, reserve_by_a_token};
use trading_runtime::contracts::ITradingVault;
use trading_runtime::market_data::MarketDataClient;
use trading_runtime::token_metadata::{known_token_decimals, token_metadata_for_chain};
use trading_runtime::types::ValuationStatus;

const LIVE_PORTFOLIO_STALE_SECS: i64 = 30;

sol! {
    function balanceOf(address account) external view returns (uint256);
}

#[derive(Clone, Debug)]
pub struct LivePortfolioSnapshot {
    pub bot_id: String,
    pub portfolio: PortfolioResponse,
    pub account_value_usd: Decimal,
    pub high_water_mark: Decimal,
    pub drawdown_pct: Decimal,
    pub observed_at: DateTime<Utc>,
    pub nav_safe: bool,
}

#[derive(Clone, Debug)]
pub struct LiveRiskInput {
    pub bot_id: String,
    pub paper_trade: bool,
    pub vault_address: String,
    pub rpc_url: String,
    pub chain_id: u64,
    pub market_data_base_url: String,
    pub strategy_config: Value,
}

impl LiveRiskInput {
    pub fn from_state(state: &TradingApiState) -> Result<Self, (StatusCode, String)> {
        Ok(Self {
            bot_id: state.bot_id.clone(),
            paper_trade: state.paper_trade,
            vault_address: state.vault_address.clone(),
            rpc_url: state.rpc_url.clone().ok_or_else(|| {
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Live risk checks require an RPC URL".to_string(),
                )
            })?,
            chain_id: state.chain_id.unwrap_or(1),
            market_data_base_url: state.market_client.base_url().to_string(),
            strategy_config: Value::Object(Default::default()),
        })
    }

    pub fn from_bot(bot: &BotContext, market_data_base_url: &str) -> Self {
        Self {
            bot_id: bot.bot_id.clone(),
            paper_trade: bot.paper_trade,
            vault_address: bot.vault_address.clone(),
            rpc_url: bot.rpc_url.clone(),
            chain_id: bot.chain_id,
            market_data_base_url: market_data_base_url.to_string(),
            strategy_config: bot.strategy_config.clone(),
        }
    }
}

pub async fn reconcile_live_portfolio(
    input: &LiveRiskInput,
) -> Result<LivePortfolioSnapshot, (StatusCode, String)> {
    if input.paper_trade {
        return Err((
            StatusCode::BAD_REQUEST,
            "Live portfolio reconciliation is not used for paper trading".to_string(),
        ));
    }
    if input.vault_address.starts_with("factory:")
        || input
            .vault_address
            .eq_ignore_ascii_case("0x0000000000000000000000000000000000000000")
    {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "Live risk checks require a deployed vault address".to_string(),
        ));
    }

    let provider = ProviderBuilder::new().connect_http(input.rpc_url.parse().map_err(|e| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            format!("Invalid RPC URL for live reconciliation: {e}"),
        )
    })?);
    let vault_addr: Address = input.vault_address.parse().map_err(|e| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            format!("Invalid vault address for live reconciliation: {e}"),
        )
    })?;

    let asset_addr = eth_call_address(
        &provider,
        vault_addr,
        ITradingVault::assetCall {}.abi_encode(),
    )
    .await?;
    let total_assets = eth_call_u256(
        &provider,
        vault_addr,
        ITradingVault::totalAssetsCall {}.abi_encode(),
    )
    .await?;
    let nav_safe = eth_call_bool(
        &provider,
        vault_addr,
        ITradingVault::isNavSafeCall {}.abi_encode(),
    )
    .await?;
    let outstanding_collateral = eth_call_u256(
        &provider,
        vault_addr,
        ITradingVault::totalOutstandingCollateralCall {}.abi_encode(),
    )
    .await
    .unwrap_or(U256::ZERO);
    let held_tokens = eth_call_addresses(
        &provider,
        vault_addr,
        ITradingVault::getHeldTokensCall {}.abi_encode(),
    )
    .await?;

    let market_client = MarketDataClient::new(input.market_data_base_url.clone());
    let observed_at = Utc::now();
    let asset_token = format!("{asset_addr:#x}");
    let asset_meta = token_metadata_for_chain(Some(input.chain_id), &asset_token);
    let asset_symbol = asset_meta
        .map(|metadata| metadata.symbol.to_string())
        .unwrap_or_else(|| asset_token.clone());
    let asset_decimals = asset_meta
        .map(|metadata| metadata.decimals)
        .unwrap_or_else(|| known_token_decimals(Some(input.chain_id), &asset_token).unwrap_or(18));
    let mut asset_price = price_for_token(&market_client, input.chain_id, &asset_token).await;
    if asset_price.is_none() && asset_symbol != asset_token {
        asset_price = price_for_token(&market_client, input.chain_id, &asset_symbol).await;
    }
    let asset_price = asset_price.ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            format!("Live risk checks require a price for vault asset {asset_symbol}"),
        )
    })?;

    let total_assets_decimal = u256_to_decimal(total_assets, asset_decimals)?;
    let mut account_value_usd = total_assets_decimal * asset_price;
    let mut positions = Vec::new();
    let mut warnings = Vec::new();
    let has_value_only_positions = true;
    let mut has_unpriced_positions = false;
    let protocol_chain_id =
        crate::protocol_chain_id_from_config(input.chain_id, &input.strategy_config);

    let cash_raw = eth_call_u256(
        &provider,
        vault_addr,
        ITradingVault::getBalanceCall { token: asset_addr }.abi_encode(),
    )
    .await?;
    let cash_amount = u256_to_decimal(cash_raw, asset_decimals)?;
    positions.push(PositionEntry {
        token: asset_symbol.clone(),
        amount: cash_amount.to_string(),
        value_usd: Some((cash_amount * asset_price).to_string()),
        entry_price: None,
        current_price: Some(asset_price.to_string()),
        unrealized_pnl: None,
        protocol: "vault".to_string(),
        position_type: "spot".to_string(),
        valuation_status: ValuationStatus::ValueOnly,
    });

    for token_addr in held_tokens {
        let raw_balance = eth_call_u256(
            &provider,
            vault_addr,
            ITradingVault::getBalanceCall { token: token_addr }.abi_encode(),
        )
        .await?;
        if raw_balance.is_zero() {
            continue;
        }
        let token = format!("{token_addr:#x}");
        let aave_reserve = reserve_by_a_token(protocol_chain_id, &token);
        let metadata = token_metadata_for_chain(Some(input.chain_id), &token);
        let symbol = aave_reserve
            .map(|reserve| reserve.symbol.to_string())
            .or_else(|| metadata.map(|metadata| metadata.symbol.to_string()))
            .unwrap_or_else(|| token.clone());
        let decimals = aave_reserve
            .map(|reserve| reserve.decimals)
            .or_else(|| metadata.map(|metadata| metadata.decimals))
            .unwrap_or_else(|| known_token_decimals(Some(input.chain_id), &token).unwrap_or(18));
        let amount = u256_to_decimal(raw_balance, decimals)?;
        let price_token = aave_reserve
            .map(|reserve| reserve.underlying)
            .unwrap_or(token.as_str());
        let price_chain_id = if aave_reserve.is_some() {
            protocol_chain_id
        } else {
            input.chain_id
        };
        let mut price = price_for_token(&market_client, price_chain_id, price_token).await;
        if price.is_none() && symbol != token {
            price = price_for_token(&market_client, price_chain_id, &symbol).await;
        }
        let (value_usd, current_price, valuation_status) = match price {
            Some(price) => (
                Some((amount * price).to_string()),
                Some(price.to_string()),
                ValuationStatus::ValueOnly,
            ),
            None => {
                has_unpriced_positions = true;
                warnings.push(format!(
                    "Live vault token {symbol} is held on-chain but has no market price."
                ));
                (None, None, ValuationStatus::Unpriced)
            }
        };
        positions.push(PositionEntry {
            token: symbol,
            amount: amount.to_string(),
            value_usd,
            entry_price: None,
            current_price,
            unrealized_pnl: None,
            protocol: aave_reserve
                .map(|_| "aave_v3")
                .unwrap_or("vault")
                .to_string(),
            position_type: aave_reserve
                .map(|_| "lending")
                .unwrap_or("spot")
                .to_string(),
            valuation_status,
        });
    }

    if let Some(market) = market_for_chain(protocol_chain_id) {
        for reserve in market.reserves {
            let debt_token: Address = reserve.variable_debt_token.parse().map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Invalid Aave debt token in registry: {e}"),
                )
            })?;
            let debt_raw = erc20_balance_of(&provider, debt_token, vault_addr)
                .await
                .unwrap_or(U256::ZERO);
            if debt_raw.is_zero() {
                continue;
            }

            let amount = u256_to_decimal(debt_raw, reserve.decimals)?;
            let mut price =
                price_for_token(&market_client, protocol_chain_id, reserve.underlying).await;
            if price.is_none() {
                price = price_for_token(&market_client, protocol_chain_id, reserve.symbol).await;
            }

            let (value_usd, current_price, valuation_status) = match price {
                Some(price) => {
                    let value = amount * price;
                    account_value_usd -= value;
                    (
                        Some(format!("-{value}")),
                        Some(price.to_string()),
                        ValuationStatus::ValueOnly,
                    )
                }
                None => {
                    has_unpriced_positions = true;
                    warnings.push(format!(
                        "Live Aave debt token {} is owed on-chain but has no market price.",
                        reserve.symbol
                    ));
                    (None, None, ValuationStatus::Unpriced)
                }
            };

            positions.push(PositionEntry {
                token: reserve.symbol.to_string(),
                amount: format!("-{amount}"),
                value_usd,
                entry_price: None,
                current_price,
                unrealized_pnl: None,
                protocol: "aave_v3".to_string(),
                position_type: "borrowing".to_string(),
                valuation_status,
            });
        }
    }

    if !outstanding_collateral.is_zero() {
        let collateral = u256_to_decimal(outstanding_collateral, asset_decimals)?;
        positions.push(PositionEntry {
            token: asset_symbol.clone(),
            amount: collateral.to_string(),
            value_usd: Some((collateral * asset_price).to_string()),
            entry_price: None,
            current_price: Some(asset_price.to_string()),
            unrealized_pnl: None,
            protocol: "vault_collateral".to_string(),
            position_type: "spot".to_string(),
            valuation_status: ValuationStatus::ValueOnly,
        });
    }

    if !nav_safe {
        warnings.push(
            "Vault NAV is not safe because one or more held assets cannot be valued on-chain."
                .to_string(),
        );
        has_unpriced_positions = true;
    }

    let (high_water_mark, drawdown_pct) =
        live_drawdown(&input.bot_id, &input.strategy_config, account_value_usd)?;
    let portfolio = PortfolioResponse {
        positions,
        total_value_usd: account_value_usd.to_string(),
        cash_balance: Some(cash_amount.to_string()),
        unrealized_pnl: "0".to_string(),
        realized_pnl: metrics_store::latest_snapshot_for_bot(&input.bot_id)
            .ok()
            .flatten()
            .map(|snapshot| snapshot.realized_pnl)
            .unwrap_or_else(|| "0".to_string()),
        warnings,
        has_unpriced_positions,
        has_value_only_positions,
        source: Some("live_onchain".to_string()),
        observed_at: Some(observed_at),
        stale: false,
    };

    Ok(LivePortfolioSnapshot {
        bot_id: input.bot_id.clone(),
        portfolio,
        account_value_usd,
        high_water_mark,
        drawdown_pct,
        observed_at,
        nav_safe,
    })
}

pub async fn enforce_live_risk(
    input: &LiveRiskInput,
    max_drawdown_pct: Decimal,
) -> Result<LivePortfolioSnapshot, (StatusCode, String)> {
    let snapshot = reconcile_live_portfolio(input).await?;
    if Utc::now()
        .signed_duration_since(snapshot.observed_at)
        .num_seconds()
        > LIVE_PORTFOLIO_STALE_SECS
    {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "Live portfolio reconciliation is stale; refusing production trade".to_string(),
        ));
    }
    if !snapshot.nav_safe {
        return Err((
            StatusCode::FORBIDDEN,
            "Vault NAV is unsafe; refusing production trade".to_string(),
        ));
    }
    if snapshot.drawdown_pct >= max_drawdown_pct {
        return Err((
            StatusCode::FORBIDDEN,
            format!(
                "Circuit breaker: live drawdown {}% exceeds {}% threshold",
                snapshot.drawdown_pct, max_drawdown_pct
            ),
        ));
    }
    Ok(snapshot)
}

pub fn max_drawdown_from_strategy_config(strategy_config: &Value) -> Decimal {
    strategy_config
        .get("risk_params")
        .and_then(|risk| risk.get("max_drawdown_pct"))
        .or_else(|| strategy_config.get("max_drawdown_pct"))
        .and_then(decimal_from_value)
        .unwrap_or_else(|| Decimal::new(10, 0))
}

fn live_drawdown(
    bot_id: &str,
    strategy_config: &Value,
    account_value_usd: Decimal,
) -> Result<(Decimal, Decimal), (StatusCode, String)> {
    let previous = metrics_store::latest_snapshot_for_bot(bot_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let baseline = initial_capital_usd(strategy_config).unwrap_or(account_value_usd);
    let previous_hwm = previous
        .as_ref()
        .and_then(|snapshot| Decimal::from_str(&snapshot.high_water_mark).ok())
        .unwrap_or(baseline.max(account_value_usd));
    let high_water_mark = previous_hwm.max(account_value_usd).max(baseline);
    let drawdown_pct = if high_water_mark > Decimal::ZERO {
        ((high_water_mark - account_value_usd) / high_water_mark) * Decimal::new(100, 0)
    } else {
        Decimal::ZERO
    };
    Ok((high_water_mark, drawdown_pct))
}

fn initial_capital_usd(strategy_config: &Value) -> Option<Decimal> {
    strategy_config
        .as_object()
        .and_then(|strategy| {
            strategy
                .get("initial_capital_usd")
                .or_else(|| strategy.get("initial_capital"))
                .or_else(|| strategy.get("cash_balance"))
        })
        .and_then(decimal_from_value)
}

fn decimal_from_value(value: &Value) -> Option<Decimal> {
    match value {
        Value::Number(number) => Decimal::from_str(&number.to_string()).ok(),
        Value::String(raw) => Decimal::from_str(raw).ok(),
        _ => None,
    }
}

async fn price_for_token(
    market_client: &MarketDataClient,
    chain_id: u64,
    token: &str,
) -> Option<Decimal> {
    market_client
        .get_price_for_chain(Some(chain_id), token)
        .await
        .ok()
        .map(|price| price.price_usd)
}

fn u256_to_decimal(amount: U256, decimals: u8) -> Result<Decimal, (StatusCode, String)> {
    let raw = Decimal::from_str(&amount.to_string()).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to convert live amount to decimal: {e}"),
        )
    })?;
    let scale = Decimal::from(10u64.pow(decimals as u32));
    Ok(raw / scale)
}

async fn eth_call_u256(
    provider: &impl Provider,
    to: Address,
    data: Vec<u8>,
) -> Result<U256, (StatusCode, String)> {
    let result = eth_call(provider, to, data).await?;
    U256::abi_decode(&result).map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to decode live u256 response: {e}"),
        )
    })
}

async fn eth_call_address(
    provider: &impl Provider,
    to: Address,
    data: Vec<u8>,
) -> Result<Address, (StatusCode, String)> {
    let result = eth_call(provider, to, data).await?;
    Address::abi_decode(&result).map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to decode live address response: {e}"),
        )
    })
}

async fn eth_call_addresses(
    provider: &impl Provider,
    to: Address,
    data: Vec<u8>,
) -> Result<Vec<Address>, (StatusCode, String)> {
    let result = eth_call(provider, to, data).await?;
    <Vec<Address>>::abi_decode(&result).map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to decode live address list response: {e}"),
        )
    })
}

async fn eth_call_bool(
    provider: &impl Provider,
    to: Address,
    data: Vec<u8>,
) -> Result<bool, (StatusCode, String)> {
    let result = eth_call(provider, to, data).await?;
    bool::abi_decode(&result).map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to decode live bool response: {e}"),
        )
    })
}

async fn erc20_balance_of(
    provider: &impl Provider,
    token: Address,
    account: Address,
) -> Result<U256, (StatusCode, String)> {
    eth_call_u256(provider, token, balanceOfCall { account }.abi_encode()).await
}

async fn eth_call(
    provider: &impl Provider,
    to: Address,
    data: Vec<u8>,
) -> Result<Bytes, (StatusCode, String)> {
    let tx = TransactionRequest::default()
        .to(to)
        .input(Bytes::from(data).into());
    provider.call(tx).await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Live chain reconciliation call failed: {e}"),
        )
    })
}

pub fn snapshot_to_metric(
    snapshot: &LivePortfolioSnapshot,
    trade_count: u32,
) -> crate::metrics_store::MetricSnapshot {
    crate::metrics_store::MetricSnapshot {
        timestamp: snapshot.observed_at,
        bot_id: snapshot.bot_id.clone(),
        account_value_usd: snapshot.account_value_usd.to_string(),
        unrealized_pnl: "0".to_string(),
        realized_pnl: snapshot.portfolio.realized_pnl.clone(),
        high_water_mark: snapshot.high_water_mark.to_string(),
        drawdown_pct: snapshot.drawdown_pct.to_string(),
        positions_count: snapshot.portfolio.positions.len() as u32,
        trade_count,
    }
}
