use alloy::primitives::{Address, Bytes, U256};
use alloy::providers::{Provider, ProviderBuilder};
use alloy::rpc::types::TransactionRequest;
use alloy::sol;
use alloy::sol_types::{SolCall, SolValue};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use once_cell::sync::OnceCell;
use rust_decimal::Decimal;
use sandbox_runtime::store::PersistentStore;
use serde::{Deserialize, Serialize};
use std::str::FromStr;

use crate::routes::hyperliquid::{get_hl_client, require_hyperliquid_account_address};
use crate::{BotContext, MultiBotTradingState};
use trading_runtime::contracts::ITradingVault;
use trading_runtime::hyperliquid::AccountInfo;
use trading_runtime::token_metadata::known_token_decimals;

static NAV_SNAPSHOTS: OnceCell<PersistentStore<HyperliquidNavSnapshot>> = OnceCell::new();

const DEFAULT_NAV_STALE_AFTER_SECS: i64 = 60;

sol! {
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function decimals() external view returns (uint8);
    function accountingShareSupply() external view returns (uint256);
    function setHyperliquidAccountAssets(uint256 accountAssets) external;
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HyperliquidPositionNav {
    pub asset: String,
    pub size: String,
    pub entry_price: String,
    pub unrealized_pnl: String,
    pub margin_used: String,
    pub leverage: u32,
    pub liquidation_price: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HyperliquidNavSnapshot {
    pub bot_id: String,
    pub account_address: String,
    pub vault_address: String,
    pub share_token: String,
    pub asset_token: String,
    pub as_of: DateTime<Utc>,
    pub status: String,
    pub stale_after_secs: i64,
    pub idle_usdc: String,
    pub hyperliquid_equity: String,
    pub total_nav: String,
    pub withdrawable_usdc: String,
    pub total_margin_used: String,
    pub total_notional_position: String,
    pub unrealized_pnl: String,
    pub total_shares: String,
    pub share_price: Option<String>,
    pub margin_usage_bps: Option<u32>,
    pub open_order_count: usize,
    pub position_count: usize,
    pub positions: Vec<HyperliquidPositionNav>,
    pub warnings: Vec<String>,
    pub onchain_accounting_tx_hash: Option<String>,
}

impl HyperliquidNavSnapshot {
    pub fn is_stale_at(&self, now: DateTime<Utc>) -> bool {
        now.signed_duration_since(self.as_of).num_seconds() > self.stale_after_secs
    }
}

pub fn snapshots() -> Result<&'static PersistentStore<HyperliquidNavSnapshot>, String> {
    NAV_SNAPSHOTS
        .get_or_try_init(|| {
            let path = sandbox_runtime::store::state_dir().join("hyperliquid-nav-snapshots.json");
            PersistentStore::open(path).map_err(|e| e.to_string())
        })
        .map_err(|e: String| e)
}

fn snapshot_key(bot_id: &str) -> String {
    format!("hyperliquid-nav:{bot_id}:latest")
}

pub fn record_snapshot(snapshot: HyperliquidNavSnapshot) -> Result<(), String> {
    snapshots()?
        .insert(snapshot_key(&snapshot.bot_id), snapshot)
        .map_err(|e| e.to_string())
}

pub fn latest_snapshot_for_bot(bot_id: &str) -> Result<Option<HyperliquidNavSnapshot>, String> {
    snapshots()?
        .get(&snapshot_key(bot_id))
        .map_err(|e| e.to_string())
}

pub async fn reconcile_hyperliquid_nav(
    state: &MultiBotTradingState,
    bot: &BotContext,
) -> Result<HyperliquidNavSnapshot, (StatusCode, String)> {
    if bot.paper_trade {
        return Err((
            StatusCode::BAD_REQUEST,
            "Hyperliquid NAV reconciliation is only used for live Hyperliquid vault bots"
                .to_string(),
        ));
    }

    let account_address = require_hyperliquid_account_address(bot)?;
    let vault_address = parse_concrete_address(&bot.vault_address, "vault address")?;
    let provider = ProviderBuilder::new().connect_http(bot.rpc_url.parse().map_err(|e| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            format!("Invalid RPC URL for Hyperliquid NAV reconciliation: {e}"),
        )
    })?);

    let asset_token = eth_call_address(
        &provider,
        vault_address,
        ITradingVault::assetCall {}.abi_encode(),
    )
    .await?;
    let share_token = eth_call_address(
        &provider,
        vault_address,
        ITradingVault::shareCall {}.abi_encode(),
    )
    .await?;
    let idle_raw = eth_call_u256(
        &provider,
        asset_token,
        balanceOfCall {
            account: vault_address,
        }
        .abi_encode(),
    )
    .await?;
    let shares_raw = eth_call_u256(
        &provider,
        vault_address,
        accountingShareSupplyCall {}.abi_encode(),
    )
    .await?;
    let asset_decimals = token_decimals(&provider, bot.chain_id, asset_token).await?;

    let client = get_hl_client(state)?;
    let account = client
        .get_account_for(Some(&account_address))
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!("Hyperliquid account refresh failed for {account_address}: {e}"),
            )
        })?;

    let mut snapshot = build_snapshot_from_parts(NavBuildInput {
        bot_id: &bot.bot_id,
        account_address: &account_address,
        vault_address,
        share_token,
        asset_token,
        idle_raw,
        shares_raw,
        asset_decimals,
        account: &account,
        as_of: Utc::now(),
        stale_after_secs: nav_stale_after_secs(bot),
    })?;

    if let Some(tx_hash) =
        sync_onchain_accounting(state, bot, vault_address, asset_decimals, &mut snapshot).await?
    {
        snapshot.onchain_accounting_tx_hash = Some(tx_hash);
    }

    record_snapshot(snapshot.clone()).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(snapshot)
}

struct NavBuildInput<'a> {
    bot_id: &'a str,
    account_address: &'a str,
    vault_address: Address,
    share_token: Address,
    asset_token: Address,
    idle_raw: U256,
    shares_raw: U256,
    asset_decimals: u8,
    account: &'a AccountInfo,
    as_of: DateTime<Utc>,
    stale_after_secs: i64,
}

fn build_snapshot_from_parts(
    input: NavBuildInput<'_>,
) -> Result<HyperliquidNavSnapshot, (StatusCode, String)> {
    let idle_usdc = u256_to_decimal(input.idle_raw, input.asset_decimals)?;
    let total_shares = u256_to_decimal(input.shares_raw, input.asset_decimals)?;
    let hyperliquid_equity = parse_decimal_field("account_value", &input.account.account_value)?;
    let withdrawable_usdc = parse_decimal_field("withdrawable", &input.account.withdrawable)?;
    let total_margin_used =
        parse_decimal_field("total_margin_used", &input.account.total_margin_used)?;
    let total_notional_position =
        parse_decimal_field("total_ntl_pos", &input.account.total_ntl_pos)?;
    let total_nav = idle_usdc + hyperliquid_equity;
    let share_price = (total_shares > Decimal::ZERO).then(|| total_nav / total_shares);
    let margin_usage_bps = bps_ratio(total_margin_used, hyperliquid_equity)?;
    let unrealized_pnl =
        sum_position_decimal(input.account, |position| position.unrealized_pnl.as_str())?;

    let mut warnings = Vec::new();
    if total_shares.is_zero() {
        warnings.push("total share supply is zero; share price is unavailable".to_string());
    }
    if hyperliquid_equity.is_sign_negative() {
        warnings.push("Hyperliquid account equity is negative".to_string());
    }

    Ok(HyperliquidNavSnapshot {
        bot_id: input.bot_id.to_string(),
        account_address: input.account_address.to_string(),
        vault_address: format!("{:#x}", input.vault_address),
        share_token: format!("{:#x}", input.share_token),
        asset_token: format!("{:#x}", input.asset_token),
        as_of: input.as_of,
        status: "fresh".to_string(),
        stale_after_secs: input.stale_after_secs,
        idle_usdc: idle_usdc.to_string(),
        hyperliquid_equity: hyperliquid_equity.to_string(),
        total_nav: total_nav.to_string(),
        withdrawable_usdc: withdrawable_usdc.to_string(),
        total_margin_used: total_margin_used.to_string(),
        total_notional_position: total_notional_position.to_string(),
        unrealized_pnl: unrealized_pnl.to_string(),
        total_shares: total_shares.to_string(),
        share_price: share_price.map(|value| value.to_string()),
        margin_usage_bps,
        open_order_count: input.account.open_orders.len(),
        position_count: input.account.positions.len(),
        positions: input
            .account
            .positions
            .iter()
            .map(|position| HyperliquidPositionNav {
                asset: position.asset.clone(),
                size: position.size.clone(),
                entry_price: position.entry_price.clone(),
                unrealized_pnl: position.unrealized_pnl.clone(),
                margin_used: position.margin_used.clone(),
                leverage: position.leverage,
                liquidation_price: position.liquidation_price.clone(),
            })
            .collect(),
        warnings,
        onchain_accounting_tx_hash: None,
    })
}

async fn sync_onchain_accounting(
    state: &MultiBotTradingState,
    bot: &BotContext,
    vault_address: Address,
    asset_decimals: u8,
    snapshot: &mut HyperliquidNavSnapshot,
) -> Result<Option<String>, (StatusCode, String)> {
    let Some(chain_client) = state.chain_client.as_ref() else {
        snapshot.warnings.push(
            "on-chain accounting was not updated; no shared chain client is configured".to_string(),
        );
        return Ok(None);
    };
    if state.chain_client_chain_id != Some(bot.chain_id)
        || state.chain_client_rpc_url.as_deref() != Some(bot.rpc_url.as_str())
    {
        snapshot.warnings.push(
            "on-chain accounting was not updated; shared chain client does not match this bot chain/RPC"
                .to_string(),
        );
        return Ok(None);
    }

    let equity = parse_decimal_field("account_value", &snapshot.hyperliquid_equity)?;
    if equity.is_sign_negative() {
        snapshot.warnings.push(
            "on-chain accounting was not updated because Hyperliquid equity is negative"
                .to_string(),
        );
        return Ok(None);
    }
    let raw_equity = decimal_to_u256(equity, asset_decimals)?;
    let tx = TransactionRequest::default().to(vault_address).input(
        Bytes::from(
            setHyperliquidAccountAssetsCall {
                accountAssets: raw_equity,
            }
            .abi_encode(),
        )
        .into(),
    );
    let pending = chain_client
        .provider
        .send_transaction(tx)
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!("Hyperliquid on-chain accounting tx send failed: {e}"),
            )
        })?;
    let tx_hash = format!("0x{}", hex::encode(pending.tx_hash().as_slice()));
    let receipt = pending.get_receipt().await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Hyperliquid on-chain accounting tx receipt failed: {e}"),
        )
    })?;
    if !receipt.status() {
        return Err((
            StatusCode::BAD_GATEWAY,
            format!("Hyperliquid on-chain accounting transaction reverted: {tx_hash}"),
        ));
    }
    Ok(Some(tx_hash))
}

fn parse_concrete_address(raw: &str, label: &str) -> Result<Address, (StatusCode, String)> {
    let value = raw.trim();
    if value.is_empty()
        || value.starts_with("factory:")
        || value.starts_with("vault:")
        || value.eq_ignore_ascii_case("0x0000000000000000000000000000000000000000")
    {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            format!("Hyperliquid NAV reconciliation requires a concrete {label}"),
        ));
    }
    value.parse().map_err(|e| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            format!("Invalid {label} for Hyperliquid NAV reconciliation: {e}"),
        )
    })
}

fn nav_stale_after_secs(bot: &BotContext) -> i64 {
    bot.risk_params
        .get("max_nav_staleness_secs")
        .and_then(serde_json::Value::as_i64)
        .filter(|value| *value > 0)
        .or_else(|| {
            bot.strategy_config
                .get("max_nav_staleness_secs")
                .and_then(serde_json::Value::as_i64)
                .filter(|value| *value > 0)
        })
        .unwrap_or(DEFAULT_NAV_STALE_AFTER_SECS)
}

async fn token_decimals(
    provider: &impl Provider,
    chain_id: u64,
    token: Address,
) -> Result<u8, (StatusCode, String)> {
    let token_string = format!("{token:#x}");
    if let Some(decimals) = known_token_decimals(Some(chain_id), &token_string) {
        return Ok(decimals);
    }

    let result = eth_call(provider, token, decimalsCall {}.abi_encode()).await?;
    let decoded = U256::abi_decode(&result).map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to decode token decimals for {token_string}: {e}"),
        )
    })?;
    Ok(decoded.to::<u8>())
}

fn parse_decimal_field(label: &str, raw: &str) -> Result<Decimal, (StatusCode, String)> {
    Decimal::from_str(raw.trim()).map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Hyperliquid {label} value '{raw}' is not numeric: {e}"),
        )
    })
}

fn u256_to_decimal(amount: U256, decimals: u8) -> Result<Decimal, (StatusCode, String)> {
    let raw = Decimal::from_str(&amount.to_string()).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to convert raw NAV amount to decimal: {e}"),
        )
    })?;
    let scale = Decimal::from(10u64.pow(decimals as u32));
    Ok(raw / scale)
}

fn decimal_to_u256(amount: Decimal, decimals: u8) -> Result<U256, (StatusCode, String)> {
    if amount.is_sign_negative() {
        return Err((
            StatusCode::BAD_GATEWAY,
            "Cannot convert negative Hyperliquid NAV amount to raw units".to_string(),
        ));
    }
    let scale = Decimal::from(10u64.pow(decimals as u32));
    let raw = (amount * scale).trunc();
    U256::from_str(&raw.to_string()).map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to convert Hyperliquid NAV amount to raw units: {e}"),
        )
    })
}

fn bps_ratio(
    numerator: Decimal,
    denominator: Decimal,
) -> Result<Option<u32>, (StatusCode, String)> {
    if denominator <= Decimal::ZERO {
        return Ok(None);
    }
    let ratio = (numerator / denominator) * Decimal::from(10_000u64);
    let rounded = ratio.round();
    rounded.to_string().parse::<u32>().map(Some).map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to convert margin usage to bps: {e}"),
        )
    })
}

fn sum_position_decimal<F>(account: &AccountInfo, value: F) -> Result<Decimal, (StatusCode, String)>
where
    F: Fn(&trading_runtime::hyperliquid::PositionInfo) -> &str,
{
    let mut total = Decimal::ZERO;
    for position in &account.positions {
        total += parse_decimal_field("position unrealized_pnl", value(position))?;
    }
    Ok(total)
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
            format!("Failed to decode Hyperliquid NAV u256 response: {e}"),
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
            format!("Failed to decode Hyperliquid NAV address response: {e}"),
        )
    })
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
            format!("Hyperliquid NAV chain call failed: {e}"),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use trading_runtime::hyperliquid::{AccountInfo, HlOpenOrderInfo, PositionInfo};

    fn account() -> AccountInfo {
        AccountInfo {
            account_value: "90000.50".to_string(),
            total_margin_used: "45000.25".to_string(),
            total_ntl_pos: "120000".to_string(),
            total_raw_usd: "90000.50".to_string(),
            withdrawable: "12500.25".to_string(),
            positions: vec![
                PositionInfo {
                    asset: "ETH".to_string(),
                    size: "10".to_string(),
                    entry_price: "3000".to_string(),
                    unrealized_pnl: "100.25".to_string(),
                    leverage: 5,
                    liquidation_price: Some("2500".to_string()),
                    margin_used: "6000".to_string(),
                    return_on_equity: "0.1".to_string(),
                },
                PositionInfo {
                    asset: "BTC".to_string(),
                    size: "-1".to_string(),
                    entry_price: "65000".to_string(),
                    unrealized_pnl: "-50.25".to_string(),
                    leverage: 3,
                    liquidation_price: None,
                    margin_used: "20000".to_string(),
                    return_on_equity: "-0.01".to_string(),
                },
            ],
            open_orders: vec![HlOpenOrderInfo {
                coin: "ETH".to_string(),
                limit_px: "3100".to_string(),
                oid: 1,
                side: "A".to_string(),
                sz: "1".to_string(),
                timestamp: 1,
            }],
        }
    }

    #[test]
    fn builds_full_nav_from_idle_vault_and_hyperliquid_equity() {
        let snapshot = build_snapshot_from_parts(NavBuildInput {
            bot_id: "bot-1",
            account_address: "0x1111111111111111111111111111111111111111",
            vault_address: "0x2222222222222222222222222222222222222222"
                .parse()
                .unwrap(),
            share_token: "0x3333333333333333333333333333333333333333"
                .parse()
                .unwrap(),
            asset_token: "0x4444444444444444444444444444444444444444"
                .parse()
                .unwrap(),
            idle_raw: U256::from(10_000_000_000u64),
            shares_raw: U256::from(100_000_000_000u64),
            asset_decimals: 6,
            account: &account(),
            as_of: Utc::now(),
            stale_after_secs: 60,
        })
        .unwrap();

        assert_eq!(snapshot.idle_usdc, "10000");
        assert_eq!(snapshot.hyperliquid_equity, "90000.50");
        assert_eq!(snapshot.total_nav, "100000.50");
        assert_eq!(snapshot.total_shares, "100000");
        assert_eq!(snapshot.share_price.as_deref(), Some("1.000005"));
        assert_eq!(snapshot.unrealized_pnl, "50.00");
        assert_eq!(snapshot.margin_usage_bps, Some(5000));
        assert_eq!(snapshot.open_order_count, 1);
        assert_eq!(snapshot.position_count, 2);
    }

    #[test]
    fn omits_share_price_when_no_shares_exist() {
        let snapshot = build_snapshot_from_parts(NavBuildInput {
            bot_id: "bot-1",
            account_address: "0x1111111111111111111111111111111111111111",
            vault_address: "0x2222222222222222222222222222222222222222"
                .parse()
                .unwrap(),
            share_token: "0x3333333333333333333333333333333333333333"
                .parse()
                .unwrap(),
            asset_token: "0x4444444444444444444444444444444444444444"
                .parse()
                .unwrap(),
            idle_raw: U256::from(1_000_000u64),
            shares_raw: U256::ZERO,
            asset_decimals: 6,
            account: &account(),
            as_of: Utc::now(),
            stale_after_secs: 60,
        })
        .unwrap();

        assert_eq!(snapshot.share_price, None);
        assert!(snapshot.warnings.iter().any(|w| w.contains("share supply")));
    }

    #[test]
    fn converts_decimal_nav_to_raw_units_without_rounding_up() {
        let raw = decimal_to_u256(Decimal::from_str("90000.1234567").unwrap(), 6).unwrap();
        assert_eq!(raw, U256::from(90_000_123_456u64));
        assert!(decimal_to_u256(Decimal::from_str("-1").unwrap(), 6).is_err());
    }
}
