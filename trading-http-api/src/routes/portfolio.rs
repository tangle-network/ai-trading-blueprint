use crate::live_portfolio::{LiveRiskInput, reconcile_live_portfolio};
use crate::metrics_store;
use crate::trade_store;
use crate::{MultiBotTradingState, TradingApiState};
use alloy::primitives::{Address, Bytes, U256};
use alloy::providers::{Provider, ProviderBuilder};
use alloy::rpc::types::TransactionRequest;
use alloy::sol_types::{SolCall, SolValue};
use axum::{Extension, Json, Router, extract::State, http::StatusCode, routing::post};
use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::Serialize;
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;
use trading_runtime::contracts::ITradingVault;
use trading_runtime::market_data::MarketDataClient;
use trading_runtime::token_metadata::known_token_decimals;
use trading_runtime::types::{PositionType, PriceData, ValuationStatus};

#[derive(Clone, Debug, Serialize)]
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
    pub has_value_only_positions: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub stale: bool,
}

#[derive(Clone, Debug, Serialize)]
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
async fn get_state(
    State(state): State<Arc<TradingApiState>>,
) -> Result<Json<PortfolioResponse>, (StatusCode, String)> {
    if !state.paper_trade {
        let input = LiveRiskInput::from_state(&state)?;
        let snapshot = reconcile_live_portfolio(&input).await?;
        return Ok(Json(snapshot.portfolio));
    }

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
        .any(|position| position.valuation_status == ValuationStatus::Unpriced);
    let has_value_only_positions = portfolio
        .positions
        .iter()
        .any(|position| position.valuation_status == ValuationStatus::ValueOnly);
    let entries: Vec<PositionEntry> = portfolio
        .positions
        .iter()
        .map(position_entry_from_runtime)
        .collect();

    Ok(Json(PortfolioResponse {
        total_value_usd: portfolio.total_value_usd.to_string(),
        cash_balance: None,
        unrealized_pnl: portfolio.unrealized_pnl.to_string(),
        realized_pnl: portfolio.realized_pnl.to_string(),
        positions: entries,
        warnings: portfolio_warnings(has_unpriced_positions, has_value_only_positions),
        has_unpriced_positions,
        has_value_only_positions,
        source: Some("memory".to_string()),
        observed_at: portfolio.last_updated,
        stale: false,
    }))
}

async fn get_state_multi_bot(
    State(state): State<Arc<MultiBotTradingState>>,
    Extension(bot): Extension<crate::BotContext>,
) -> Result<Json<PortfolioResponse>, (StatusCode, String)> {
    if !bot.paper_trade {
        let input = LiveRiskInput::from_bot(&bot, &state.market_data_base_url);
        let snapshot = reconcile_live_portfolio(&input).await?;
        return Ok(Json(snapshot.portfolio));
    }

    Ok(Json(
        build_multi_bot_portfolio_response(&bot, &state.market_data_base_url).await,
    ))
}

pub(crate) async fn build_multi_bot_portfolio_response(
    bot: &crate::BotContext,
    market_data_base_url: &str,
) -> PortfolioResponse {
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
    let mut has_value_only_positions = false;
    let mut total_value_decimal = Decimal::ZERO;
    let mut vault_lookup_failed = false;

    if !should_skip_onchain_vault_lookup(bot) {
        match read_vault_cash_position(bot, market_data_base_url).await {
            Ok(Some(position)) => {
                cash_balance = Some(position.amount.clone());
                has_unpriced_positions = position.valuation_status == ValuationStatus::Unpriced;
                has_value_only_positions = position.valuation_status == ValuationStatus::ValueOnly;
                if let Some(onchain_value) =
                    position.value_usd.as_deref().and_then(parse_decimal_maybe)
                {
                    total_value_decimal += onchain_value;
                }
                positions.push(position);
            }
            Ok(None) => {}
            Err(e) => {
                vault_lookup_failed = true;
                warnings.push(format!(
                    "On-chain vault balance lookup failed; using latest snapshot fallback: {e}"
                ));
            }
        }
    }

    if let Ok(synthetic) = synthesize_trade_positions(bot, market_data_base_url).await {
        has_unpriced_positions |= synthetic.has_unpriced_positions;
        has_value_only_positions |= synthetic.has_value_only_positions;
        total_value_decimal += synthetic.total_value_usd;
        positions.extend(synthetic.positions);
    }
    if cash_balance.is_none() {
        cash_balance = synthetic_cash_balance(bot, &positions);
    }

    let snapshot_total_value = latest_snapshot
        .as_ref()
        .and_then(|snapshot| parse_decimal_maybe(&snapshot.account_value_usd));
    let total_value_usd = if vault_lookup_failed {
        snapshot_total_value
            .unwrap_or(total_value_decimal)
            .to_string()
    } else if positions.is_empty() {
        snapshot_total_value.unwrap_or(Decimal::ZERO).to_string()
    } else {
        total_value_decimal.to_string()
    };

    if positions.is_empty() && trade_total > 0 {
        warnings.push(
            "Portfolio position breakdown is not yet fully persisted in fleet mode; showing aggregate totals."
                .to_string(),
        );
    }
    warnings.extend(portfolio_warnings(
        has_unpriced_positions,
        has_value_only_positions,
    ));

    PortfolioResponse {
        positions,
        total_value_usd,
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
        has_value_only_positions,
        source: Some("synthetic_trade_history".to_string()),
        observed_at: latest_snapshot.as_ref().map(|snapshot| snapshot.timestamp),
        stale: false,
    }
}

#[derive(Default)]
struct SyntheticPortfolio {
    positions: Vec<PositionEntry>,
    total_value_usd: Decimal,
    has_unpriced_positions: bool,
    has_value_only_positions: bool,
}

#[derive(Clone)]
struct SyntheticPositionAccumulator {
    token: String,
    amount: Decimal,
    entry_price: Option<Decimal>,
    protocol: String,
    position_type: PositionType,
}

impl SyntheticPositionAccumulator {
    fn new(
        token: String,
        protocol: String,
        position_type: PositionType,
        amount: Decimal,
        entry_price: Option<Decimal>,
    ) -> Self {
        Self {
            token,
            amount,
            entry_price,
            protocol,
            position_type,
        }
    }

    fn credit(&mut self, amount: Decimal, entry_price: Option<Decimal>) {
        if amount <= Decimal::ZERO {
            return;
        }

        self.entry_price = match (self.entry_price, entry_price) {
            (Some(existing), Some(next)) if self.amount > Decimal::ZERO => {
                Some(((existing * self.amount) + (next * amount)) / (self.amount + amount))
            }
            (Some(existing), _) => Some(existing),
            (None, Some(next)) => Some(next),
            (None, None) => None,
        };
        self.amount += amount;
    }

    fn debit(&mut self, amount: Decimal) {
        if amount <= Decimal::ZERO {
            return;
        }

        self.amount = (self.amount - amount).max(Decimal::ZERO);
    }
}

async fn synthesize_trade_positions(
    bot: &crate::BotContext,
    market_data_base_url: &str,
) -> Result<SyntheticPortfolio, String> {
    let mut trades = trade_store::trades_for_bot(&bot.bot_id, 1000, 0)?.trades;
    let mut positions: HashMap<String, SyntheticPositionAccumulator> = HashMap::new();
    let protocol_chain_id =
        crate::protocol_chain_id_from_config(bot.chain_id, &bot.strategy_config);
    seed_initial_paper_cash(&mut positions, bot);

    if trades.is_empty() && positions.is_empty() {
        return Ok(SyntheticPortfolio::default());
    }

    trades.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));
    for trade in &trades {
        apply_trade_to_synthetic_positions(&mut positions, protocol_chain_id, trade);
    }

    let mut open_positions: Vec<SyntheticPositionAccumulator> = positions
        .into_values()
        .filter(|position| position.amount > Decimal::ZERO)
        .collect();
    if open_positions.is_empty() {
        return Ok(SyntheticPortfolio::default());
    }

    let market_client = MarketDataClient::new(market_data_base_url.to_string());
    let tokens: Vec<String> = open_positions
        .iter()
        .map(|position| position.token.clone())
        .collect();
    let prices = market_client
        .get_prices_for_chain(Some(protocol_chain_id), &tokens)
        .await
        .unwrap_or_default();
    let current_prices: HashMap<String, Decimal> = prices
        .into_iter()
        .map(|price| (normalize_token_key(&price.token), price.price_usd))
        .collect();

    let mut synthesized = SyntheticPortfolio::default();
    open_positions.sort_by(|a, b| a.token.cmp(&b.token));
    for position in open_positions {
        let current_price = current_prices
            .get(&normalize_token_key(&position.token))
            .copied()
            .or_else(|| default_reference_price_usd(&position.token));
        let fallback_price = position.entry_price;
        let effective_price = current_price.or(fallback_price);
        let valuation_status = match (current_price, position.entry_price) {
            (Some(_), Some(_)) => ValuationStatus::Priced,
            (Some(_), None) | (None, Some(_)) => ValuationStatus::ValueOnly,
            (None, None) => ValuationStatus::Unpriced,
        };
        let value_usd = effective_price.map(|price| price * position.amount);
        let unrealized_pnl = match (current_price, position.entry_price) {
            (Some(current), Some(entry)) => Some((current - entry) * position.amount),
            _ => None,
        };

        synthesized.has_unpriced_positions |= valuation_status == ValuationStatus::Unpriced;
        synthesized.has_value_only_positions |= valuation_status == ValuationStatus::ValueOnly;
        if let Some(value) = value_usd {
            synthesized.total_value_usd += value;
        }

        synthesized.positions.push(PositionEntry {
            token: position.token,
            amount: position.amount.to_string(),
            value_usd: value_usd.map(|value| value.to_string()),
            entry_price: if valuation_status == ValuationStatus::Priced {
                position.entry_price.map(|price| price.to_string())
            } else {
                None
            },
            current_price: effective_price.map(|price| price.to_string()),
            unrealized_pnl: unrealized_pnl.map(|value| value.to_string()),
            protocol: position.protocol,
            position_type: serde_json::to_value(&position.position_type)
                .ok()
                .and_then(|value| value.as_str().map(String::from))
                .unwrap_or_else(|| format!("{:?}", position.position_type)),
            valuation_status,
        });
    }

    Ok(synthesized)
}

fn seed_initial_paper_cash(
    positions: &mut HashMap<String, SyntheticPositionAccumulator>,
    bot: &crate::BotContext,
) {
    if !bot.paper_trade {
        return;
    }

    let strategy = match bot.strategy_config.as_object() {
        Some(strategy) => strategy,
        None => return,
    };
    let token = strategy
        .get("cash_token")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty() && !token_is_zero_placeholder(value))
        .unwrap_or("USDC");
    let capital = strategy
        .get("initial_capital_usd")
        .or_else(|| strategy.get("initial_capital"))
        .or_else(|| strategy.get("cash_balance"))
        .and_then(|value| match value {
            serde_json::Value::String(value) => parse_decimal_maybe(value),
            serde_json::Value::Number(value) => parse_decimal_maybe(&value.to_string()),
            _ => None,
        })
        .unwrap_or(Decimal::ZERO);

    if capital <= Decimal::ZERO {
        return;
    }

    credit_spot_position(
        positions,
        token,
        "paper",
        capital,
        default_reference_price_usd(token),
    );
}

fn synthetic_cash_balance(bot: &crate::BotContext, positions: &[PositionEntry]) -> Option<String> {
    let token = bot
        .strategy_config
        .as_object()
        .and_then(|strategy| strategy.get("cash_token").and_then(|value| value.as_str()))
        .map(str::trim)
        .filter(|value| !value.is_empty() && !token_is_zero_placeholder(value))
        .unwrap_or("USDC");

    positions
        .iter()
        .find(|position| normalize_token_key(&position.token) == normalize_token_key(token))
        .map(|position| position.amount.clone())
        .or_else(|| bot.paper_trade.then(|| "0".to_string()))
}

fn apply_trade_to_synthetic_positions(
    positions: &mut HashMap<String, SyntheticPositionAccumulator>,
    chain_id: u64,
    trade: &trade_store::TradeRecord,
) {
    let action = trade.action.to_ascii_lowercase();

    if trade_represents_spot_swap(&action, &trade.target_protocol) {
        let amount_in = parse_decimal_maybe(&trade.amount_in)
            .map(|amount| normalize_trade_amount(Some(chain_id), &trade.token_in, amount))
            .unwrap_or(Decimal::ZERO);
        let amount_out = trade
            .amount_out
            .as_deref()
            .and_then(parse_decimal_maybe)
            .map(|amount| normalize_trade_amount(Some(chain_id), &trade.token_out, amount))
            .or_else(|| {
                parse_decimal_maybe(&trade.min_amount_out)
                    .map(|amount| normalize_trade_amount(Some(chain_id), &trade.token_out, amount))
            })
            .unwrap_or(amount_in);
        debit_spot_position(
            positions,
            &trade.token_in,
            &trade.target_protocol,
            amount_in,
        );
        credit_spot_position(
            positions,
            &trade.token_out,
            &trade.target_protocol,
            amount_out,
            trade
                .entry_price_usd
                .as_deref()
                .and_then(parse_decimal_maybe),
        );
        return;
    }

    let position_type = trade_position_type(&action, &trade.target_protocol);
    let size = trade
        .amount_out
        .as_deref()
        .and_then(parse_decimal_maybe)
        .map(|amount| normalize_trade_amount(Some(chain_id), &trade.token_out, amount))
        .or_else(|| {
            parse_decimal_maybe(&trade.min_amount_out)
                .map(|amount| normalize_trade_amount(Some(chain_id), &trade.token_out, amount))
        })
        .unwrap_or_else(|| {
            parse_decimal_maybe(&trade.amount_in)
                .map(|amount| normalize_trade_amount(Some(chain_id), &trade.token_in, amount))
                .unwrap_or(Decimal::ZERO)
        });

    if trade_opens_position(&action, &trade.target_protocol) {
        credit_position(
            positions,
            &trade.token_out,
            &trade.target_protocol,
            position_type,
            size,
            trade
                .entry_price_usd
                .as_deref()
                .and_then(parse_decimal_maybe),
        );
    } else if trade_closes_position(&action, &trade.target_protocol) {
        debit_position(
            positions,
            &trade.token_out,
            &trade.target_protocol,
            position_type,
            size,
        );
    }
}

fn trade_represents_spot_swap(action: &str, protocol: &str) -> bool {
    match action {
        "swap" => true,
        "buy" | "sell" => !protocol_uses_non_spot_buy_sell(protocol),
        _ => false,
    }
}

fn trade_opens_position(action: &str, protocol: &str) -> bool {
    if protocol_supports_buy_to_open(protocol) && action == "buy" {
        return true;
    }
    if protocol_supports_dual_sided_opens(protocol) && matches!(action, "buy" | "sell") {
        return true;
    }

    matches!(action, "open_long" | "open_short" | "supply" | "borrow")
}

fn trade_closes_position(action: &str, protocol: &str) -> bool {
    if protocol_supports_buy_to_open(protocol) && action == "sell" {
        return true;
    }

    matches!(
        action,
        "close_long" | "close_short" | "withdraw" | "repay" | "redeem"
    )
}

fn trade_position_type(action: &str, protocol: &str) -> PositionType {
    match (protocol.to_ascii_lowercase().as_str(), action) {
        ("polymarket_clob", _) | ("polymarket", _) => PositionType::ConditionalToken,
        ("hyperliquid", "buy") => PositionType::LongPerp,
        ("hyperliquid", "sell") => PositionType::ShortPerp,
        (_, "open_long") => PositionType::LongPerp,
        (_, "open_short") => PositionType::ShortPerp,
        (_, "supply") => PositionType::Lending,
        (_, "borrow") => PositionType::Borrowing,
        _ => PositionType::Spot,
    }
}

fn protocol_uses_non_spot_buy_sell(protocol: &str) -> bool {
    protocol_supports_buy_to_open(protocol) || protocol_supports_dual_sided_opens(protocol)
}

fn protocol_supports_buy_to_open(protocol: &str) -> bool {
    matches!(
        protocol.trim().to_ascii_lowercase().as_str(),
        "polymarket_clob" | "polymarket"
    )
}

fn protocol_supports_dual_sided_opens(protocol: &str) -> bool {
    matches!(protocol.trim().to_ascii_lowercase().as_str(), "hyperliquid")
}

fn token_is_zero_placeholder(token: &str) -> bool {
    let normalized = token.trim().to_ascii_lowercase();
    normalized == "0x0000000000000000000000000000000000000000"
}

fn credit_spot_position(
    positions: &mut HashMap<String, SyntheticPositionAccumulator>,
    token: &str,
    protocol: &str,
    amount: Decimal,
    entry_price: Option<Decimal>,
) {
    credit_position(
        positions,
        token,
        protocol,
        PositionType::Spot,
        amount,
        entry_price,
    );
}

fn credit_position(
    positions: &mut HashMap<String, SyntheticPositionAccumulator>,
    token: &str,
    protocol: &str,
    position_type: PositionType,
    amount: Decimal,
    entry_price: Option<Decimal>,
) {
    if amount <= Decimal::ZERO {
        return;
    }

    let key = synthetic_position_key(token, protocol, &position_type);
    positions
        .entry(key)
        .and_modify(|position| position.credit(amount, entry_price))
        .or_insert_with(|| {
            SyntheticPositionAccumulator::new(
                token.to_string(),
                protocol.to_string(),
                position_type,
                amount,
                entry_price,
            )
        });
}

fn debit_spot_position(
    positions: &mut HashMap<String, SyntheticPositionAccumulator>,
    token: &str,
    protocol: &str,
    amount: Decimal,
) {
    debit_position(positions, token, protocol, PositionType::Spot, amount);
}

fn debit_position(
    positions: &mut HashMap<String, SyntheticPositionAccumulator>,
    token: &str,
    protocol: &str,
    position_type: PositionType,
    amount: Decimal,
) {
    if amount <= Decimal::ZERO {
        return;
    }

    let key = synthetic_position_key(token, protocol, &position_type);
    if let Some(position) = positions.get_mut(&key) {
        position.debit(amount);
    }
}

fn synthetic_position_key(token: &str, protocol: &str, position_type: &PositionType) -> String {
    if *position_type == PositionType::Spot {
        return format!("{}|spot", normalize_token_key(token));
    }

    format!(
        "{}|{}|{:?}",
        normalize_token_key(token),
        protocol.to_ascii_lowercase(),
        position_type
    )
}

fn normalize_token_key(token: &str) -> String {
    let normalized = token.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "usdc"
        | "usd-coin"
        | "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
        | "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
        | "0x036cbd53842c5426634e7929541ec2318f3dcf7e"
        | "0x7f5c764cbc14f9669b88837ca1490cca17c31607" => "usdc".to_string(),
        _ => normalized,
    }
}

fn parse_decimal_maybe(value: &str) -> Option<Decimal> {
    Decimal::from_str(value).ok()
}

fn normalize_trade_amount(chain_id: Option<u64>, token: &str, amount: Decimal) -> Decimal {
    if amount <= Decimal::ZERO || !amount.fract().is_zero() || amount < Decimal::new(100_000, 0) {
        return amount;
    }

    let Some(decimals) = known_token_decimals(chain_id, token) else {
        return amount;
    };
    let scale = Decimal::from(10u64.pow(decimals as u32));
    amount / scale
}

fn default_reference_price_usd(token: &str) -> Option<Decimal> {
    let normalized = normalize_token_key(token);
    match normalized.as_str() {
        "usdc"
        | "usdt"
        | "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
        | "0xdac17f958d2ee523a2206206994597c13d831ec7"
        | "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
        | "0x036cbd53842c5426634e7929541ec2318f3dcf7e"
        | "0x7f5c764cbc14f9669b88837ca1490cca17c31607" => Some(Decimal::ONE),
        _ => None,
    }
}

fn should_skip_onchain_vault_lookup(bot: &crate::BotContext) -> bool {
    bot.paper_trade && bot.vault_address.starts_with("factory:")
}

async fn read_vault_cash_position(
    bot: &crate::BotContext,
    market_data_base_url: &str,
) -> Result<Option<PositionEntry>, String> {
    if bot.vault_address == format!("{:#x}", Address::ZERO)
        || bot
            .vault_address
            .eq_ignore_ascii_case("0x0000000000000000000000000000000000000000")
    {
        return Ok(None);
    }

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
        && let Some(row) = price_rows
            .iter()
            .find(|row| row.token.eq_ignore_ascii_case(&token_symbol))
    {
        current_price = Some(row.price_usd.to_string());
        let amount_decimal = Decimal::from_str(&amount_display).unwrap_or(Decimal::ZERO);
        value_usd = Some((amount_decimal * row.price_usd).to_string());
    }

    Ok(Some(PositionEntry {
        token: token_symbol,
        amount: amount_display,
        value_usd: value_usd.clone(),
        entry_price: None,
        current_price,
        unrealized_pnl: None,
        protocol: "vault".to_string(),
        position_type: "spot".to_string(),
        valuation_status: if value_usd.is_some() {
            ValuationStatus::ValueOnly
        } else {
            ValuationStatus::Unpriced
        },
    }))
}

fn position_entry_from_runtime(p: &trading_runtime::types::Position) -> PositionEntry {
    let value_usd = match p.valuation_status {
        ValuationStatus::Priced | ValuationStatus::ValueOnly => p
            .current_price
            .map(|current_price| (current_price * p.amount).to_string()),
        ValuationStatus::Unpriced => None,
    };

    PositionEntry {
        token: p.token.clone(),
        amount: p.amount.to_string(),
        value_usd,
        entry_price: match p.valuation_status {
            ValuationStatus::Priced => p.entry_price.map(|value| value.to_string()),
            ValuationStatus::ValueOnly | ValuationStatus::Unpriced => None,
        },
        current_price: match p.valuation_status {
            ValuationStatus::Priced | ValuationStatus::ValueOnly => {
                p.current_price.map(|value| value.to_string())
            }
            ValuationStatus::Unpriced => None,
        },
        unrealized_pnl: match p.valuation_status {
            ValuationStatus::Priced => p.unrealized_pnl.map(|value| value.to_string()),
            ValuationStatus::ValueOnly | ValuationStatus::Unpriced => None,
        },
        protocol: p.protocol.clone(),
        position_type: serde_json::to_value(&p.position_type)
            .ok()
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_else(|| format!("{:?}", p.position_type)),
        valuation_status: p.valuation_status,
    }
}

fn portfolio_warnings(has_unpriced_positions: bool, has_value_only_positions: bool) -> Vec<String> {
    let mut warnings = Vec::new();
    if has_unpriced_positions {
        warnings.push(
            "Some positions still have no current market price, so total portfolio value is hidden."
                .to_string(),
        );
    }
    if has_value_only_positions {
        warnings.push(
            "Some positions have current market value, but entry price or PnL are unavailable."
                .to_string(),
        );
    }
    warnings
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_onchain_lookup_for_paper_bot_factory_placeholder() {
        let bot = crate::BotContext {
            bot_id: "bot-1".to_string(),
            vault_address: "factory:0x1234".to_string(),
            paper_trade: true,
            chain_id: 31337,
            rpc_url: "http://localhost:8545".to_string(),
            strategy_config: serde_json::json!({}),
            risk_params: serde_json::json!({}),
            validator_endpoints: vec![],
            validation_trust: trading_runtime::ValidationTrust::PerTrade,
        };

        assert!(should_skip_onchain_vault_lookup(&bot));
    }

    #[test]
    fn does_not_skip_lookup_for_non_placeholder_or_live_bots() {
        let live_bot = crate::BotContext {
            bot_id: "bot-2".to_string(),
            vault_address: "factory:0x1234".to_string(),
            paper_trade: false,
            chain_id: 31337,
            rpc_url: "http://localhost:8545".to_string(),
            strategy_config: serde_json::json!({}),
            risk_params: serde_json::json!({}),
            validator_endpoints: vec![],
            validation_trust: trading_runtime::ValidationTrust::PerTrade,
        };
        let paper_bot_with_real_vault = crate::BotContext {
            bot_id: "bot-3".to_string(),
            vault_address: "0x0000000000000000000000000000000000000001".to_string(),
            paper_trade: true,
            chain_id: 31337,
            rpc_url: "http://localhost:8545".to_string(),
            strategy_config: serde_json::json!({}),
            risk_params: serde_json::json!({}),
            validator_endpoints: vec![],
            validation_trust: trading_runtime::ValidationTrust::PerTrade,
        };

        assert!(!should_skip_onchain_vault_lookup(&live_bot));
        assert!(!should_skip_onchain_vault_lookup(
            &paper_bot_with_real_vault
        ));
    }

    #[test]
    fn initial_paper_capital_defaults_to_usdc_cash_not_asset_token_units() {
        let bot = crate::BotContext {
            bot_id: "bot-4".to_string(),
            vault_address: "factory:0x1234".to_string(),
            paper_trade: true,
            chain_id: 31338,
            rpc_url: "http://localhost:8545".to_string(),
            strategy_config: serde_json::json!({
                "initial_capital_usd": "10000",
                "asset_token": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
            }),
            risk_params: serde_json::json!({}),
            validator_endpoints: vec![],
            validation_trust: trading_runtime::ValidationTrust::PerTrade,
        };
        let mut positions = HashMap::new();

        seed_initial_paper_cash(&mut positions, &bot);

        let position = positions.get("usdc|spot").expect("paper cash position");
        assert_eq!(position.token, "USDC");
        assert_eq!(position.amount, Decimal::new(10000, 0));
        assert_eq!(position.entry_price, Some(Decimal::ONE));
        assert!(!positions.contains_key("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2|spot"));
    }
}
