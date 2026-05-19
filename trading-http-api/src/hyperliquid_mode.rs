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

use crate::BotContext;
use crate::hyperliquid_nav::{self, HyperliquidNavSnapshot};

static MODE_SNAPSHOTS: OnceCell<PersistentStore<HyperliquidModeSnapshot>> = OnceCell::new();

const DEFAULT_LIQUIDITY_MODE_QUEUE_BPS: u32 = 1_500;
const DEFAULT_EMERGENCY_QUEUE_BPS: u32 = 6_000;
const DEFAULT_MIN_IDLE_USDC_BPS: u32 = 500;
const DEFAULT_MAX_MARGIN_USAGE_BPS: u32 = 8_000;

sol! {
    function pendingRedeemShares() external view returns (uint256);
    function accountingShareSupply() external view returns (uint256);
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HyperliquidBotMode {
    Normal,
    Liquidity,
    EmergencyWindDown,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HyperliquidModeThresholds {
    pub liquidity_mode_queue_bps: u32,
    pub emergency_queue_bps: u32,
    pub min_idle_usdc_bps: u32,
    pub max_margin_usage_bps: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HyperliquidModeMetrics {
    pub nav_as_of: Option<DateTime<Utc>>,
    pub nav_stale: bool,
    pub total_nav: Option<String>,
    pub idle_usdc: Option<String>,
    pub queued_withdrawal_shares: Option<String>,
    pub accounting_share_supply: Option<String>,
    pub queued_withdrawal_bps: Option<u32>,
    pub idle_usdc_bps: Option<u32>,
    pub margin_usage_bps: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HyperliquidModeSnapshot {
    pub bot_id: String,
    pub mode: HyperliquidBotMode,
    pub reason: String,
    pub checked_at: DateTime<Utc>,
    pub thresholds: HyperliquidModeThresholds,
    pub metrics: HyperliquidModeMetrics,
}

#[derive(Clone, Debug)]
pub struct HyperliquidQueueState {
    pub pending_redeem_shares: U256,
    pub accounting_share_supply: U256,
}

#[derive(Clone, Debug)]
pub enum HyperliquidActionPolicy {
    RiskIncreasing,
    RiskReducing,
    Neutral,
}

pub fn mode_snapshots() -> Result<&'static PersistentStore<HyperliquidModeSnapshot>, String> {
    MODE_SNAPSHOTS
        .get_or_try_init(|| {
            let path = sandbox_runtime::store::state_dir().join("hyperliquid-mode-snapshots.json");
            PersistentStore::open(path).map_err(|e| e.to_string())
        })
        .map_err(|e: String| e)
}

fn snapshot_key(bot_id: &str) -> String {
    format!("hyperliquid-mode:{bot_id}:latest")
}

pub fn latest_mode_for_bot(bot_id: &str) -> Result<Option<HyperliquidModeSnapshot>, String> {
    mode_snapshots()?
        .get(&snapshot_key(bot_id))
        .map_err(|e| e.to_string())
}

fn record_mode(snapshot: HyperliquidModeSnapshot) -> Result<(), String> {
    mode_snapshots()?
        .insert(snapshot_key(&snapshot.bot_id), snapshot)
        .map_err(|e| e.to_string())
}

pub async fn evaluate_hyperliquid_mode(
    bot: &BotContext,
) -> Result<HyperliquidModeSnapshot, (StatusCode, String)> {
    let now = Utc::now();
    let thresholds = thresholds_from_bot(bot);
    let nav = hyperliquid_nav::latest_snapshot_for_bot(&bot.bot_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let queue_state = read_queue_state(bot).await?;
    let snapshot = decide_hyperliquid_mode(
        &bot.bot_id,
        nav.as_ref(),
        Some(&queue_state),
        thresholds,
        now,
    )?;
    record_mode(snapshot.clone()).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(snapshot)
}

pub async fn enforce_hyperliquid_mode_for_action(
    bot: &BotContext,
    action: &str,
    metadata: &serde_json::Value,
) -> Result<HyperliquidModeSnapshot, (StatusCode, String)> {
    if bot.paper_trade {
        return Ok(paper_mode_snapshot(&bot.bot_id));
    }

    let snapshot = evaluate_hyperliquid_mode(bot).await?;
    let policy = classify_hyperliquid_action(action, metadata);
    match (&snapshot.mode, policy) {
        (HyperliquidBotMode::Normal, _) => Ok(snapshot),
        (HyperliquidBotMode::Liquidity, HyperliquidActionPolicy::RiskIncreasing) => Err((
            StatusCode::FORBIDDEN,
            format!(
                "Hyperliquid bot is in Liquidity mode: {}. Only reduce-only or risk-reducing actions are allowed.",
                snapshot.reason
            ),
        )),
        (HyperliquidBotMode::EmergencyWindDown, HyperliquidActionPolicy::RiskIncreasing) => Err((
            StatusCode::FORBIDDEN,
            format!(
                "Hyperliquid bot is in EmergencyWindDown mode: {}. New risk is blocked.",
                snapshot.reason
            ),
        )),
        _ => Ok(snapshot),
    }
}

pub fn classify_hyperliquid_action(
    action: &str,
    metadata: &serde_json::Value,
) -> HyperliquidActionPolicy {
    if metadata
        .get("reduce_only")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
    {
        return HyperliquidActionPolicy::RiskReducing;
    }

    match action.trim().to_ascii_lowercase().as_str() {
        "close_long" | "close_short" => HyperliquidActionPolicy::RiskReducing,
        "open_long" | "open_short" | "buy" | "sell" => HyperliquidActionPolicy::RiskIncreasing,
        "cancel" | "cancel_order" | "withdraw" | "redeem" => HyperliquidActionPolicy::Neutral,
        _ => HyperliquidActionPolicy::RiskIncreasing,
    }
}

fn paper_mode_snapshot(bot_id: &str) -> HyperliquidModeSnapshot {
    HyperliquidModeSnapshot {
        bot_id: bot_id.to_string(),
        mode: HyperliquidBotMode::Normal,
        reason: "paper trade mode".to_string(),
        checked_at: Utc::now(),
        thresholds: HyperliquidModeThresholds {
            liquidity_mode_queue_bps: DEFAULT_LIQUIDITY_MODE_QUEUE_BPS,
            emergency_queue_bps: DEFAULT_EMERGENCY_QUEUE_BPS,
            min_idle_usdc_bps: DEFAULT_MIN_IDLE_USDC_BPS,
            max_margin_usage_bps: DEFAULT_MAX_MARGIN_USAGE_BPS,
        },
        metrics: HyperliquidModeMetrics {
            nav_as_of: None,
            nav_stale: false,
            total_nav: None,
            idle_usdc: None,
            queued_withdrawal_shares: None,
            accounting_share_supply: None,
            queued_withdrawal_bps: None,
            idle_usdc_bps: None,
            margin_usage_bps: None,
        },
    }
}

fn decide_hyperliquid_mode(
    bot_id: &str,
    nav: Option<&HyperliquidNavSnapshot>,
    queue_state: Option<&HyperliquidQueueState>,
    thresholds: HyperliquidModeThresholds,
    now: DateTime<Utc>,
) -> Result<HyperliquidModeSnapshot, (StatusCode, String)> {
    let nav_stale = nav.is_none_or(|snapshot| snapshot.is_stale_at(now));
    let total_nav = nav
        .map(|snapshot| parse_decimal("total_nav", &snapshot.total_nav))
        .transpose()?;
    let idle_usdc = nav
        .map(|snapshot| parse_decimal("idle_usdc", &snapshot.idle_usdc))
        .transpose()?;
    let hyperliquid_equity = nav
        .map(|snapshot| parse_decimal("hyperliquid_equity", &snapshot.hyperliquid_equity))
        .transpose()?;
    let pending_shares = queue_state.map(|state| u256_to_decimal(state.pending_redeem_shares));
    let accounting_supply = queue_state.map(|state| u256_to_decimal(state.accounting_share_supply));
    let queued_withdrawal_bps = match (pending_shares, accounting_supply) {
        (Some(pending), Some(supply)) if supply > Decimal::ZERO => {
            Some(decimal_bps(pending, supply)?)
        }
        _ => None,
    };
    let idle_usdc_bps = match (idle_usdc, total_nav) {
        (Some(idle), Some(total)) if total > Decimal::ZERO => Some(decimal_bps(idle, total)?),
        _ => None,
    };
    let margin_usage_bps = nav.and_then(|snapshot| snapshot.margin_usage_bps);
    let metrics = HyperliquidModeMetrics {
        nav_as_of: nav.map(|snapshot| snapshot.as_of),
        nav_stale,
        total_nav: total_nav.map(|value| value.to_string()),
        idle_usdc: idle_usdc.map(|value| value.to_string()),
        queued_withdrawal_shares: pending_shares.map(|value| value.to_string()),
        accounting_share_supply: accounting_supply.map(|value| value.to_string()),
        queued_withdrawal_bps,
        idle_usdc_bps,
        margin_usage_bps,
    };

    let (mode, reason) = if nav.is_none() {
        (
            HyperliquidBotMode::EmergencyWindDown,
            "NAV snapshot is missing".to_string(),
        )
    } else if nav_stale {
        (
            HyperliquidBotMode::EmergencyWindDown,
            "NAV snapshot is stale".to_string(),
        )
    } else if hyperliquid_equity.is_some_and(|value| value < Decimal::ZERO) {
        (
            HyperliquidBotMode::EmergencyWindDown,
            "Hyperliquid account equity is negative".to_string(),
        )
    } else if total_nav.is_some_and(|value| value <= Decimal::ZERO) {
        (
            HyperliquidBotMode::EmergencyWindDown,
            "total NAV is not positive".to_string(),
        )
    } else if margin_usage_bps.is_some_and(|bps| bps >= thresholds.max_margin_usage_bps) {
        (
            HyperliquidBotMode::EmergencyWindDown,
            format!(
                "margin usage is above the {} bps emergency limit",
                thresholds.max_margin_usage_bps
            ),
        )
    } else if queued_withdrawal_bps.is_some_and(|bps| bps >= thresholds.emergency_queue_bps) {
        (
            HyperliquidBotMode::EmergencyWindDown,
            format!(
                "queued withdrawals are above the {} bps emergency limit",
                thresholds.emergency_queue_bps
            ),
        )
    } else if queued_withdrawal_bps.is_some_and(|bps| bps >= thresholds.liquidity_mode_queue_bps) {
        (
            HyperliquidBotMode::Liquidity,
            format!(
                "queued withdrawals are above the {} bps liquidity threshold",
                thresholds.liquidity_mode_queue_bps
            ),
        )
    } else if pending_shares.is_some_and(|shares| shares > Decimal::ZERO)
        && idle_usdc_bps.is_some_and(|bps| bps < thresholds.min_idle_usdc_bps)
    {
        (
            HyperliquidBotMode::Liquidity,
            format!(
                "idle USDC is below the {} bps minimum while withdrawals are queued",
                thresholds.min_idle_usdc_bps
            ),
        )
    } else {
        (
            HyperliquidBotMode::Normal,
            "all safety checks passed".to_string(),
        )
    };

    Ok(HyperliquidModeSnapshot {
        bot_id: bot_id.to_string(),
        mode,
        reason,
        checked_at: now,
        thresholds,
        metrics,
    })
}

async fn read_queue_state(bot: &BotContext) -> Result<HyperliquidQueueState, (StatusCode, String)> {
    let vault: Address = parse_concrete_address(&bot.vault_address, "vault address")?;
    let provider = ProviderBuilder::new().connect_http(bot.rpc_url.parse().map_err(|e| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            format!("Invalid RPC URL for Hyperliquid mode evaluation: {e}"),
        )
    })?);

    let pending_redeem_shares =
        eth_call_u256(&provider, vault, pendingRedeemSharesCall {}.abi_encode()).await?;
    let accounting_share_supply =
        eth_call_u256(&provider, vault, accountingShareSupplyCall {}.abi_encode()).await?;

    Ok(HyperliquidQueueState {
        pending_redeem_shares,
        accounting_share_supply,
    })
}

fn thresholds_from_bot(bot: &BotContext) -> HyperliquidModeThresholds {
    HyperliquidModeThresholds {
        liquidity_mode_queue_bps: read_bps_setting(
            bot,
            "liquidity_mode_queue_bps",
            DEFAULT_LIQUIDITY_MODE_QUEUE_BPS,
        ),
        emergency_queue_bps: read_bps_setting(
            bot,
            "emergency_queue_bps",
            DEFAULT_EMERGENCY_QUEUE_BPS,
        ),
        min_idle_usdc_bps: read_bps_setting(bot, "min_idle_usdc_bps", DEFAULT_MIN_IDLE_USDC_BPS),
        max_margin_usage_bps: read_bps_setting(
            bot,
            "max_margin_usage_bps",
            DEFAULT_MAX_MARGIN_USAGE_BPS,
        ),
    }
}

fn read_bps_setting(bot: &BotContext, key: &str, fallback: u32) -> u32 {
    read_positive_u32(&bot.risk_params, key)
        .or_else(|| read_positive_u32(&bot.strategy_config, key))
        .map(|value| value.min(10_000))
        .unwrap_or(fallback)
}

fn read_positive_u32(value: &serde_json::Value, key: &str) -> Option<u32> {
    match value.get(key) {
        Some(serde_json::Value::Number(number)) => number.as_u64().and_then(|raw| {
            (raw > 0)
                .then_some(raw)
                .and_then(|raw| u32::try_from(raw).ok())
        }),
        Some(serde_json::Value::String(raw)) => {
            raw.trim().parse::<u32>().ok().filter(|value| *value > 0)
        }
        _ => None,
    }
}

fn parse_decimal(label: &str, raw: &str) -> Result<Decimal, (StatusCode, String)> {
    Decimal::from_str(raw.trim()).map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Hyperliquid mode {label} value '{raw}' is not numeric: {e}"),
        )
    })
}

fn u256_to_decimal(value: U256) -> Decimal {
    Decimal::from_str(&value.to_string()).unwrap_or(Decimal::ZERO)
}

fn decimal_bps(numerator: Decimal, denominator: Decimal) -> Result<u32, (StatusCode, String)> {
    if denominator <= Decimal::ZERO {
        return Ok(0);
    }
    let bps = ((numerator / denominator) * Decimal::from(10_000u64)).round();
    bps.to_string().parse::<u32>().map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to convert Hyperliquid mode ratio to bps: {e}"),
        )
    })
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
            format!("Hyperliquid mode evaluation requires a concrete {label}"),
        ));
    }
    value.parse().map_err(|e| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            format!("Invalid {label} for Hyperliquid mode evaluation: {e}"),
        )
    })
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
            format!("Failed to decode Hyperliquid mode u256 response: {e}"),
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
            format!("Hyperliquid mode chain call failed: {e}"),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn thresholds() -> HyperliquidModeThresholds {
        HyperliquidModeThresholds {
            liquidity_mode_queue_bps: 1_500,
            emergency_queue_bps: 6_000,
            min_idle_usdc_bps: 500,
            max_margin_usage_bps: 8_000,
        }
    }

    fn nav(now: DateTime<Utc>) -> HyperliquidNavSnapshot {
        HyperliquidNavSnapshot {
            bot_id: "bot-1".to_string(),
            account_address: "0x1111111111111111111111111111111111111111".to_string(),
            vault_address: "0x2222222222222222222222222222222222222222".to_string(),
            share_token: "0x3333333333333333333333333333333333333333".to_string(),
            asset_token: "0x4444444444444444444444444444444444444444".to_string(),
            as_of: now,
            status: "fresh".to_string(),
            stale_after_secs: 60,
            idle_usdc: "10000".to_string(),
            hyperliquid_equity: "90000".to_string(),
            total_nav: "100000".to_string(),
            withdrawable_usdc: "12000".to_string(),
            total_margin_used: "40000".to_string(),
            total_notional_position: "120000".to_string(),
            unrealized_pnl: "0".to_string(),
            total_shares: "100000".to_string(),
            share_price: Some("1".to_string()),
            margin_usage_bps: Some(4_000),
            open_order_count: 0,
            position_count: 1,
            positions: vec![],
            warnings: vec![],
            onchain_accounting_tx_hash: None,
        }
    }

    fn queue(pending: u64, supply: u64) -> HyperliquidQueueState {
        HyperliquidQueueState {
            pending_redeem_shares: U256::from(pending),
            accounting_share_supply: U256::from(supply),
        }
    }

    #[test]
    fn missing_nav_enters_emergency() {
        let now = Utc::now();
        let mode =
            decide_hyperliquid_mode("bot-1", None, Some(&queue(0, 100_000)), thresholds(), now)
                .expect("mode");
        assert_eq!(mode.mode, HyperliquidBotMode::EmergencyWindDown);
        assert!(mode.reason.contains("missing"));
    }

    #[test]
    fn stale_nav_enters_emergency() {
        let now = Utc::now();
        let mut snapshot = nav(now - chrono::Duration::seconds(61));
        snapshot.stale_after_secs = 60;
        let mode = decide_hyperliquid_mode(
            "bot-1",
            Some(&snapshot),
            Some(&queue(0, 100_000)),
            thresholds(),
            now,
        )
        .expect("mode");
        assert_eq!(mode.mode, HyperliquidBotMode::EmergencyWindDown);
        assert!(mode.metrics.nav_stale);
    }

    #[test]
    fn queued_withdrawals_enter_liquidity() {
        let now = Utc::now();
        let mode = decide_hyperliquid_mode(
            "bot-1",
            Some(&nav(now)),
            Some(&queue(20_000, 100_000)),
            thresholds(),
            now,
        )
        .expect("mode");
        assert_eq!(mode.mode, HyperliquidBotMode::Liquidity);
        assert_eq!(mode.metrics.queued_withdrawal_bps, Some(2_000));
    }

    #[test]
    fn very_large_queue_enters_emergency() {
        let now = Utc::now();
        let mode = decide_hyperliquid_mode(
            "bot-1",
            Some(&nav(now)),
            Some(&queue(70_000, 100_000)),
            thresholds(),
            now,
        )
        .expect("mode");
        assert_eq!(mode.mode, HyperliquidBotMode::EmergencyWindDown);
    }

    #[test]
    fn high_margin_usage_enters_emergency() {
        let now = Utc::now();
        let mut snapshot = nav(now);
        snapshot.margin_usage_bps = Some(8_000);
        let mode = decide_hyperliquid_mode(
            "bot-1",
            Some(&snapshot),
            Some(&queue(0, 100_000)),
            thresholds(),
            now,
        )
        .expect("mode");
        assert_eq!(mode.mode, HyperliquidBotMode::EmergencyWindDown);
    }

    #[test]
    fn normal_when_nav_fresh_and_queue_small() {
        let now = Utc::now();
        let mode = decide_hyperliquid_mode(
            "bot-1",
            Some(&nav(now)),
            Some(&queue(1_000, 100_000)),
            thresholds(),
            now,
        )
        .expect("mode");
        assert_eq!(mode.mode, HyperliquidBotMode::Normal);
    }

    #[test]
    fn sell_is_risk_increasing_unless_reduce_only() {
        assert!(matches!(
            classify_hyperliquid_action("sell", &serde_json::json!({})),
            HyperliquidActionPolicy::RiskIncreasing
        ));
        assert!(matches!(
            classify_hyperliquid_action("sell", &serde_json::json!({"reduce_only": true})),
            HyperliquidActionPolicy::RiskReducing
        ));
    }
}
