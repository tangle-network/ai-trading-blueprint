use alloy::primitives::{Address, Bytes, U256};
use alloy::providers::{Provider, ProviderBuilder};
use alloy::rpc::types::TransactionRequest;
use alloy::sol;
use alloy::sol_types::{SolCall, SolValue};
use axum::http::StatusCode;
use chrono::{DateTime, TimeZone, Utc};
use once_cell::sync::OnceCell;
use sandbox_runtime::store::PersistentStore;
use serde::{Deserialize, Serialize};
use std::str::FromStr;

use crate::hyperliquid_nav::{self, HyperliquidNavSnapshot};
use crate::{BotContext, MultiBotTradingState};

static SETTLEMENT_ATTEMPTS: OnceCell<PersistentStore<HyperliquidSettlementAttempt>> =
    OnceCell::new();

pub const DEFAULT_WITHDRAWAL_SETTLEMENT_CRON: &str = "0 0 0 * * *";
pub const DEFAULT_WITHDRAWAL_CUTOFF_SECS: i64 = 3_600;
pub const DEFAULT_MIN_IDLE_USDC_BPS: u32 = 1_500;

sol! {
    function idleAssets() external view returns (uint256);
    function totalAssets() external view returns (uint256);
    function pendingRedeemShares() external view returns (uint256);
    function nextWithdrawalRequestId() external view returns (uint256);
    function nextFulfillableWithdrawalRequestId() external view returns (uint256);
    function isAccountingFresh() external view returns (bool);
    function convertToAssets(uint256 shares) external view returns (uint256);
    function withdrawalRequests(uint256 requestId) external view returns (
        address owner,
        address receiver,
        uint256 shares,
        uint64 createdAt,
        uint64 fulfilledAt,
        uint64 cancelledAt
    );
    function fulfillNextRedeem() external returns (uint256 requestId, uint256 assets);
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HyperliquidSettlementStatus {
    Succeeded,
    Skipped,
    Failed,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HyperliquidSettlementAttempt {
    pub bot_id: String,
    pub epoch: DateTime<Utc>,
    pub last_attempt_at: DateTime<Utc>,
    pub last_status: HyperliquidSettlementStatus,
    pub fulfilled_count: u32,
    pub fulfilled_assets: String,
    pub stopped_reason: String,
    pub tx_hashes: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HyperliquidSettlementState {
    pub bot_id: String,
    pub settlement_cron: String,
    pub next_settlement_time: DateTime<Utc>,
    pub cutoff_time: DateTime<Utc>,
    pub current_epoch: DateTime<Utc>,
    pub cutoff_secs: i64,
    pub idle_buffer_bps: u32,
    pub idle_buffer_target: Option<String>,
    pub cash_needed: Option<String>,
    pub queued_shares: Option<String>,
    pub next_request_id: Option<String>,
    pub next_request_created_at: Option<DateTime<Utc>>,
    pub next_request_eligible: Option<bool>,
    pub eligible_pending_request_count: Option<u32>,
    pub rollover: bool,
    pub last_attempt: Option<HyperliquidSettlementAttempt>,
}

#[derive(Clone, Debug)]
struct WithdrawalRequestState {
    created_at: DateTime<Utc>,
    shares: U256,
    fulfilled_at: u64,
    cancelled_at: u64,
}

#[derive(Clone, Debug)]
struct VaultSettlementState {
    idle_assets: U256,
    total_assets: U256,
    pending_redeem_shares: U256,
    next_withdrawal_request_id: U256,
    next_fulfillable_withdrawal_request_id: U256,
    is_accounting_fresh: bool,
}

pub fn settlement_attempts()
-> Result<&'static PersistentStore<HyperliquidSettlementAttempt>, String> {
    SETTLEMENT_ATTEMPTS
        .get_or_try_init(|| {
            let path =
                sandbox_runtime::store::state_dir().join("hyperliquid-settlement-attempts.json");
            PersistentStore::open(path).map_err(|e| e.to_string())
        })
        .map_err(|e: String| e)
}

fn latest_attempt_key(bot_id: &str) -> String {
    format!("hyperliquid-settlement:{bot_id}:latest")
}

fn epoch_attempt_key(bot_id: &str, epoch: DateTime<Utc>) -> String {
    format!(
        "hyperliquid-settlement:{bot_id}:epoch:{}",
        epoch.timestamp()
    )
}

pub fn latest_attempt_for_bot(
    bot_id: &str,
) -> Result<Option<HyperliquidSettlementAttempt>, String> {
    settlement_attempts()?
        .get(&latest_attempt_key(bot_id))
        .map_err(|e| e.to_string())
}

fn attempt_for_epoch(
    bot_id: &str,
    epoch: DateTime<Utc>,
) -> Result<Option<HyperliquidSettlementAttempt>, String> {
    settlement_attempts()?
        .get(&epoch_attempt_key(bot_id, epoch))
        .map_err(|e| e.to_string())
}

fn record_attempt(attempt: HyperliquidSettlementAttempt) -> Result<(), String> {
    let store = settlement_attempts()?;
    store
        .insert(latest_attempt_key(&attempt.bot_id), attempt.clone())
        .map_err(|e| e.to_string())?;
    store
        .insert(epoch_attempt_key(&attempt.bot_id, attempt.epoch), attempt)
        .map_err(|e| e.to_string())
}

pub async fn settlement_state(
    bot: &BotContext,
) -> Result<HyperliquidSettlementState, (StatusCode, String)> {
    let provider = provider_for_bot(bot)?;
    let vault = parse_concrete_address(&bot.vault_address, "vault address")?;
    let now = Utc::now();
    let schedule = settlement_schedule(now, cutoff_secs(bot));
    let last_attempt =
        latest_attempt_for_bot(&bot.bot_id).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let vault_state = read_vault_state(&provider, vault).await.ok();
    let next_request = match vault_state
        .as_ref()
        .and_then(|state| request_id_to_u64(state.next_fulfillable_withdrawal_request_id))
    {
        Some(id) if id > 0 => read_withdrawal_request(&provider, vault, U256::from(id))
            .await
            .ok(),
        _ => None,
    };
    let next_request_assets = match next_request.as_ref() {
        Some(request) if request.shares > U256::ZERO => eth_call_u256(
            &provider,
            vault,
            convertToAssetsCall {
                shares: request.shares,
            }
            .abi_encode(),
        )
        .await
        .ok(),
        _ => None,
    };

    let idle_buffer_bps = min_idle_usdc_bps(bot);
    let idle_buffer_target = vault_state
        .as_ref()
        .map(|state| min_idle_assets(state.total_assets, idle_buffer_bps).to_string());
    let cash_needed = match (vault_state.as_ref(), next_request_assets) {
        (Some(state), Some(assets)) => {
            let buffer = min_idle_assets(state.total_assets, idle_buffer_bps);
            let available = available_after_buffer(state.idle_assets, buffer);
            Some(assets.saturating_sub(available).to_string())
        }
        _ => None,
    };
    let next_request_eligible = next_request
        .as_ref()
        .map(|request| request_is_eligible(request.created_at, schedule.next_cutoff));

    Ok(HyperliquidSettlementState {
        bot_id: bot.bot_id.clone(),
        settlement_cron: withdrawal_settlement_cron(bot),
        next_settlement_time: schedule.next_settlement,
        cutoff_time: schedule.next_cutoff,
        current_epoch: schedule.current_epoch,
        cutoff_secs: schedule.cutoff_secs,
        idle_buffer_bps,
        idle_buffer_target,
        cash_needed,
        queued_shares: vault_state
            .as_ref()
            .map(|state| state.pending_redeem_shares.to_string()),
        next_request_id: vault_state
            .as_ref()
            .map(|state| state.next_fulfillable_withdrawal_request_id.to_string()),
        next_request_created_at: next_request.as_ref().map(|request| request.created_at),
        next_request_eligible,
        eligible_pending_request_count: eligible_pending_count(
            &provider,
            vault,
            vault_state.as_ref(),
            schedule.next_cutoff,
        )
        .await
        .ok(),
        rollover: last_attempt.as_ref().is_some_and(|attempt| {
            matches!(
                attempt.stopped_reason.as_str(),
                "request_after_cutoff" | "insufficient_liquidity"
            )
        }),
        last_attempt,
    })
}

pub async fn run_settlement(
    state: &MultiBotTradingState,
    bot: &BotContext,
) -> Result<HyperliquidSettlementAttempt, (StatusCode, String)> {
    run_settlement_inner(state, bot, false).await
}

async fn run_settlement_inner(
    state: &MultiBotTradingState,
    bot: &BotContext,
    force: bool,
) -> Result<HyperliquidSettlementAttempt, (StatusCode, String)> {
    let now = Utc::now();
    let schedule = settlement_schedule(now, cutoff_secs(bot));
    if !force
        && attempt_for_epoch(&bot.bot_id, schedule.current_epoch)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
            .is_some()
    {
        return Err((
            StatusCode::CONFLICT,
            "Hyperliquid settlement already ran for the current UTC epoch".to_string(),
        ));
    }

    let mut nav = match hyperliquid_nav::reconcile_hyperliquid_nav(state, bot).await {
        Ok(snapshot) => snapshot,
        Err((status, err)) => {
            let attempt = settlement_attempt(
                bot,
                schedule.current_epoch,
                HyperliquidSettlementStatus::Failed,
                0,
                U256::ZERO,
                format!("nav_refresh_failed: {err}"),
                vec![],
            );
            record_attempt(attempt.clone()).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
            return Err((status, err));
        }
    };
    if nav.is_stale_at(now) {
        let attempt = settlement_attempt(
            bot,
            schedule.current_epoch,
            HyperliquidSettlementStatus::Skipped,
            0,
            U256::ZERO,
            "nav_stale".to_string(),
            vec![],
        );
        record_attempt(attempt.clone()).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
        return Ok(attempt);
    }

    let Some(chain_client) = state.chain_client.as_ref() else {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "Hyperliquid settlement requires a shared chain client".to_string(),
        ));
    };
    if state.chain_client_chain_id != Some(bot.chain_id)
        || state.chain_client_rpc_url.as_deref() != Some(bot.rpc_url.as_str())
    {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "Hyperliquid settlement chain client does not match this bot chain/RPC".to_string(),
        ));
    }

    let provider = provider_for_bot(bot)?;
    let vault = parse_concrete_address(&bot.vault_address, "vault address")?;
    let idle_buffer_bps = min_idle_usdc_bps(bot);
    let mut fulfilled_count = 0u32;
    let mut fulfilled_assets = U256::ZERO;
    let mut tx_hashes = Vec::new();
    let stopped_reason;

    loop {
        let vault_state = read_vault_state(&provider, vault).await?;
        if vault_state.pending_redeem_shares == U256::ZERO {
            stopped_reason = "queue_empty".to_string();
            break;
        }
        if !vault_state.is_accounting_fresh {
            stopped_reason = "accounting_stale".to_string();
            break;
        }

        let Some(request_id) =
            request_id_to_u64(vault_state.next_fulfillable_withdrawal_request_id)
        else {
            stopped_reason = "queue_empty".to_string();
            break;
        };
        if request_id == 0
            || vault_state.next_fulfillable_withdrawal_request_id
                > vault_state.next_withdrawal_request_id
        {
            stopped_reason = "queue_empty".to_string();
            break;
        }

        let request = read_withdrawal_request(&provider, vault, U256::from(request_id)).await?;
        if request.fulfilled_at != 0 || request.cancelled_at != 0 || request.shares == U256::ZERO {
            stopped_reason = "request_not_pending".to_string();
            break;
        }
        if !request_is_eligible(request.created_at, schedule.current_cutoff) {
            stopped_reason = "request_after_cutoff".to_string();
            break;
        }

        nav = latest_fresh_nav_or_stop(bot, now)?;
        if nav.is_stale_at(now) {
            stopped_reason = "nav_stale".to_string();
            break;
        }

        let assets = eth_call_u256(
            &provider,
            vault,
            convertToAssetsCall {
                shares: request.shares,
            }
            .abi_encode(),
        )
        .await?;
        let buffer = min_idle_assets(vault_state.total_assets, idle_buffer_bps);
        let available = available_after_buffer(vault_state.idle_assets, buffer);
        if assets > available {
            stopped_reason = "insufficient_liquidity".to_string();
            break;
        }

        let tx = TransactionRequest::default()
            .to(vault)
            .input(Bytes::from(fulfillNextRedeemCall {}.abi_encode()).into());
        let pending = chain_client
            .provider
            .send_transaction(tx)
            .await
            .map_err(|e| {
                (
                    StatusCode::BAD_GATEWAY,
                    format!("Hyperliquid settlement tx send failed: {e}"),
                )
            })?;
        let tx_hash = format!("0x{}", hex::encode(pending.tx_hash().as_slice()));
        let receipt = pending.get_receipt().await.map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!("Hyperliquid settlement tx receipt failed: {e}"),
            )
        })?;
        if !receipt.status() {
            tx_hashes.push(tx_hash.clone());
            stopped_reason = format!("tx_failed:{tx_hash}");
            break;
        }
        tx_hashes.push(tx_hash);
        fulfilled_count = fulfilled_count.saturating_add(1);
        fulfilled_assets = fulfilled_assets.saturating_add(assets);
    }

    let status = if fulfilled_count > 0 {
        HyperliquidSettlementStatus::Succeeded
    } else {
        HyperliquidSettlementStatus::Skipped
    };
    let attempt = settlement_attempt(
        bot,
        schedule.current_epoch,
        status,
        fulfilled_count,
        fulfilled_assets,
        stopped_reason,
        tx_hashes,
    );
    record_attempt(attempt.clone()).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(attempt)
}

fn settlement_attempt(
    bot: &BotContext,
    epoch: DateTime<Utc>,
    status: HyperliquidSettlementStatus,
    fulfilled_count: u32,
    fulfilled_assets: U256,
    stopped_reason: String,
    tx_hashes: Vec<String>,
) -> HyperliquidSettlementAttempt {
    HyperliquidSettlementAttempt {
        bot_id: bot.bot_id.clone(),
        epoch,
        last_attempt_at: Utc::now(),
        last_status: status,
        fulfilled_count,
        fulfilled_assets: fulfilled_assets.to_string(),
        stopped_reason,
        tx_hashes,
    }
}

fn latest_fresh_nav_or_stop(
    bot: &BotContext,
    now: DateTime<Utc>,
) -> Result<HyperliquidNavSnapshot, (StatusCode, String)> {
    let nav = hyperliquid_nav::latest_snapshot_for_bot(&bot.bot_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "NAV snapshot is missing".to_string(),
            )
        })?;
    if nav.is_stale_at(now) {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "NAV snapshot is stale".to_string(),
        ));
    }
    Ok(nav)
}

async fn eligible_pending_count(
    provider: &impl Provider,
    vault: Address,
    state: Option<&VaultSettlementState>,
    cutoff: DateTime<Utc>,
) -> Result<u32, (StatusCode, String)> {
    let Some(state) = state else {
        return Ok(0);
    };
    let Some(mut request_id) = request_id_to_u64(state.next_fulfillable_withdrawal_request_id)
    else {
        return Ok(0);
    };
    let Some(last_id) = request_id_to_u64(state.next_withdrawal_request_id) else {
        return Ok(0);
    };

    let mut count = 0u32;
    while request_id != 0 && request_id <= last_id {
        let request = read_withdrawal_request(provider, vault, U256::from(request_id)).await?;
        if request.fulfilled_at == 0
            && request.cancelled_at == 0
            && request.shares > U256::ZERO
            && request_is_eligible(request.created_at, cutoff)
        {
            count = count.saturating_add(1);
        }
        request_id = request_id.saturating_add(1);
    }
    Ok(count)
}

async fn read_vault_state(
    provider: &impl Provider,
    vault: Address,
) -> Result<VaultSettlementState, (StatusCode, String)> {
    Ok(VaultSettlementState {
        idle_assets: eth_call_u256(provider, vault, idleAssetsCall {}.abi_encode()).await?,
        total_assets: eth_call_u256(provider, vault, totalAssetsCall {}.abi_encode()).await?,
        pending_redeem_shares: eth_call_u256(
            provider,
            vault,
            pendingRedeemSharesCall {}.abi_encode(),
        )
        .await?,
        next_withdrawal_request_id: eth_call_u256(
            provider,
            vault,
            nextWithdrawalRequestIdCall {}.abi_encode(),
        )
        .await?,
        next_fulfillable_withdrawal_request_id: eth_call_u256(
            provider,
            vault,
            nextFulfillableWithdrawalRequestIdCall {}.abi_encode(),
        )
        .await?,
        is_accounting_fresh: eth_call_bool(provider, vault, isAccountingFreshCall {}.abi_encode())
            .await?,
    })
}

async fn read_withdrawal_request(
    provider: &impl Provider,
    vault: Address,
    request_id: U256,
) -> Result<WithdrawalRequestState, (StatusCode, String)> {
    let result = eth_call(
        provider,
        vault,
        withdrawalRequestsCall {
            requestId: request_id,
        }
        .abi_encode(),
    )
    .await?;
    let decoded = withdrawalRequestsCall::abi_decode_returns(&result).map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to decode withdrawal request: {e}"),
        )
    })?;
    Ok(WithdrawalRequestState {
        created_at: timestamp_to_utc(decoded.createdAt),
        shares: decoded.shares,
        fulfilled_at: decoded.fulfilledAt,
        cancelled_at: decoded.cancelledAt,
    })
}

fn provider_for_bot(bot: &BotContext) -> Result<impl Provider, (StatusCode, String)> {
    Ok(
        ProviderBuilder::new().connect_http(bot.rpc_url.parse().map_err(|e| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                format!("Invalid RPC URL for Hyperliquid settlement: {e}"),
            )
        })?),
    )
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
            format!("Failed to decode Hyperliquid settlement u256 response: {e}"),
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
            format!("Failed to decode Hyperliquid settlement bool response: {e}"),
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
            format!("Hyperliquid settlement chain call failed: {e}"),
        )
    })
}

fn withdrawal_settlement_cron(bot: &BotContext) -> String {
    read_string_setting(bot, "withdrawal_settlement_cron")
        .unwrap_or_else(|| DEFAULT_WITHDRAWAL_SETTLEMENT_CRON.to_string())
}

fn cutoff_secs(bot: &BotContext) -> i64 {
    read_positive_i64_setting(bot, "withdrawal_cutoff_secs")
        .unwrap_or(DEFAULT_WITHDRAWAL_CUTOFF_SECS)
}

fn min_idle_usdc_bps(bot: &BotContext) -> u32 {
    read_positive_u32_setting(bot, "min_idle_usdc_bps")
        .map(|value| value.min(10_000))
        .unwrap_or(DEFAULT_MIN_IDLE_USDC_BPS)
}

fn read_string_setting(bot: &BotContext, key: &str) -> Option<String> {
    bot.risk_params
        .get(key)
        .and_then(serde_json::Value::as_str)
        .or_else(|| {
            bot.strategy_config
                .get(key)
                .and_then(serde_json::Value::as_str)
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn read_positive_i64_setting(bot: &BotContext, key: &str) -> Option<i64> {
    read_positive_u64_setting(bot, key).and_then(|value| i64::try_from(value).ok())
}

fn read_positive_u32_setting(bot: &BotContext, key: &str) -> Option<u32> {
    read_positive_u64_setting(bot, key).and_then(|value| u32::try_from(value).ok())
}

fn read_positive_u64_setting(bot: &BotContext, key: &str) -> Option<u64> {
    fn read(value: &serde_json::Value, key: &str) -> Option<u64> {
        match value.get(key) {
            Some(serde_json::Value::Number(number)) => number.as_u64().filter(|value| *value > 0),
            Some(serde_json::Value::String(raw)) => {
                raw.trim().parse::<u64>().ok().filter(|value| *value > 0)
            }
            _ => None,
        }
    }
    read(&bot.risk_params, key).or_else(|| read(&bot.strategy_config, key))
}

struct SettlementSchedule {
    current_epoch: DateTime<Utc>,
    current_cutoff: DateTime<Utc>,
    next_settlement: DateTime<Utc>,
    next_cutoff: DateTime<Utc>,
    cutoff_secs: i64,
}

fn settlement_schedule(now: DateTime<Utc>, cutoff_secs: i64) -> SettlementSchedule {
    let epoch_secs = now.timestamp().div_euclid(86_400) * 86_400;
    let current_epoch = timestamp_to_utc(epoch_secs as u64);
    let next_settlement = current_epoch + chrono::Duration::days(1);
    let cutoff = chrono::Duration::seconds(cutoff_secs);
    SettlementSchedule {
        current_epoch,
        current_cutoff: current_epoch - cutoff,
        next_settlement,
        next_cutoff: next_settlement - cutoff,
        cutoff_secs,
    }
}

fn timestamp_to_utc(timestamp: u64) -> DateTime<Utc> {
    Utc.timestamp_opt(timestamp as i64, 0)
        .single()
        .unwrap_or_else(Utc::now)
}

fn request_is_eligible(created_at: DateTime<Utc>, cutoff: DateTime<Utc>) -> bool {
    created_at <= cutoff
}

fn min_idle_assets(total_assets: U256, bps: u32) -> U256 {
    (total_assets * U256::from(bps)) / U256::from(10_000u64)
}

fn available_after_buffer(idle_assets: U256, buffer: U256) -> U256 {
    idle_assets.saturating_sub(buffer)
}

fn request_id_to_u64(value: U256) -> Option<u64> {
    u64::from_str(&value.to_string()).ok()
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
            format!("Hyperliquid settlement requires a concrete {label}"),
        ));
    }
    value.parse().map_err(|e| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            format!("Invalid {label} for Hyperliquid settlement: {e}"),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bot(risk_params: serde_json::Value, strategy_config: serde_json::Value) -> BotContext {
        BotContext {
            bot_id: "bot-1".to_string(),
            vault_address: "0x1111111111111111111111111111111111111111".to_string(),
            paper_trade: false,
            chain_id: 998,
            rpc_url: "https://rpc.hyperliquid-testnet.xyz/evm".to_string(),
            strategy_config,
            risk_params,
            validator_endpoints: vec![],
            validation_trust: trading_runtime::ValidationTrust::PerTrade,
        }
    }

    #[test]
    fn cutoff_logic_separates_current_epoch_eligible_and_rollforward_requests() {
        let cutoff = Utc.with_ymd_and_hms(2026, 5, 18, 23, 0, 0).unwrap();

        assert!(request_is_eligible(
            cutoff - chrono::Duration::seconds(1),
            cutoff
        ));
        assert!(request_is_eligible(cutoff, cutoff));
        assert!(!request_is_eligible(
            cutoff + chrono::Duration::seconds(1),
            cutoff
        ));
    }

    #[test]
    fn settlement_schedule_uses_daily_utc_epoch_and_one_hour_cutoff() {
        let now = Utc.with_ymd_and_hms(2026, 5, 19, 12, 30, 0).unwrap();
        let schedule = settlement_schedule(now, DEFAULT_WITHDRAWAL_CUTOFF_SECS);

        assert_eq!(
            schedule.current_epoch,
            Utc.with_ymd_and_hms(2026, 5, 19, 0, 0, 0).unwrap()
        );
        assert_eq!(
            schedule.current_cutoff,
            Utc.with_ymd_and_hms(2026, 5, 18, 23, 0, 0).unwrap()
        );
        assert_eq!(
            schedule.next_settlement,
            Utc.with_ymd_and_hms(2026, 5, 20, 0, 0, 0).unwrap()
        );
        assert_eq!(
            schedule.next_cutoff,
            Utc.with_ymd_and_hms(2026, 5, 19, 23, 0, 0).unwrap()
        );
    }

    #[test]
    fn buffer_preservation_keeps_default_fifteen_percent_idle() {
        let total = U256::from(100_000_000_000u64);
        let idle = U256::from(20_000_000_000u64);
        let buffer = min_idle_assets(total, DEFAULT_MIN_IDLE_USDC_BPS);

        assert_eq!(buffer, U256::from(15_000_000_000u64));
        assert_eq!(
            available_after_buffer(idle, buffer),
            U256::from(5_000_000_000u64)
        );
    }

    #[test]
    fn settings_prefer_risk_params_then_strategy_config() {
        let bot = bot(
            serde_json::json!({
                "withdrawal_cutoff_secs": 7200,
                "min_idle_usdc_bps": 1600
            }),
            serde_json::json!({
                "withdrawal_cutoff_secs": 1800,
                "min_idle_usdc_bps": 1200,
                "withdrawal_settlement_cron": "0 0 1 * * *"
            }),
        );

        assert_eq!(cutoff_secs(&bot), 7200);
        assert_eq!(min_idle_usdc_bps(&bot), 1600);
        assert_eq!(withdrawal_settlement_cron(&bot), "0 0 1 * * *");
    }
}
