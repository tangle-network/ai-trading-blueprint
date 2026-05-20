use alloy::primitives::{Address, Bytes, U256};
use alloy::providers::{Provider, ProviderBuilder};
use alloy::rpc::types::TransactionRequest;
use alloy::sol;
use alloy::sol_types::{SolCall, SolValue};
use axum::http::StatusCode;
use chrono::{DateTime, TimeZone, Utc};
use dashmap::DashMap;
use once_cell::sync::{Lazy, OnceCell};
use sandbox_runtime::store::PersistentStore;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

use crate::hyperliquid_nav::{self, HyperliquidNavSnapshot};
use crate::{BotContext, MultiBotTradingState};

static SETTLEMENT_ATTEMPTS: OnceCell<PersistentStore<HyperliquidSettlementAttempt>> =
    OnceCell::new();
static SETTLEMENT_RESERVATION_LOCKS: Lazy<DashMap<String, Arc<Mutex<()>>>> =
    Lazy::new(DashMap::new);

pub const CONTRACT_WITHDRAWAL_SETTLEMENT_CRON: &str = "0 0 0 * * *";
pub const CONTRACT_WITHDRAWAL_CUTOFF_SECS: i64 = 3_600;
pub const DEFAULT_MIN_IDLE_USDC_BPS: u32 = 1_500;
pub const DEFAULT_MAX_SETTLEMENT_FULFILLMENTS: u32 = 25;
pub const DEFAULT_SETTLEMENT_RETRY_BACKOFF_SECS: i64 = 300;
pub const DEFAULT_SETTLEMENT_LOCK_TTL_SECS: i64 = 900;
const MAX_SETTLEMENT_FULFILLMENTS_CAP: u32 = 100;

sol! {
    function idleAssets() external view returns (uint256);
    function totalAssets() external view returns (uint256);
    function pendingRedeemShares() external view returns (uint256);
    function nextWithdrawalRequestId() external view returns (uint256);
    function nextFulfillableWithdrawalRequestId() external view returns (uint256);
    function isAccountingFresh() external view returns (bool);
    function withdrawalRequestAssets(uint256 requestId) external view returns (uint256);
    function withdrawalRequestEligibleAt(uint256 requestId) external view returns (uint64);
    function withdrawalRequests(uint256 requestId) external view returns (
        address owner,
        address receiver,
        uint256 shares,
        uint64 createdAt,
        uint64 fulfilledAt,
        uint64 cancelledAt
    );
    function fulfillRedeem(uint256 requestId) external returns (uint256 assets);
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HyperliquidSettlementStatus {
    InProgress,
    Partial,
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
    #[serde(default)]
    pub retry_count: u32,
    #[serde(default)]
    pub next_retry_after: Option<DateTime<Utc>>,
    #[serde(default)]
    pub in_progress_expires_at: Option<DateTime<Utc>>,
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
    pub max_fulfillments_per_run: u32,
    pub retry_backoff_secs: i64,
    pub settlement_lock_ttl_secs: i64,
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
    eligible_at: DateTime<Utc>,
    shares: U256,
    assets: U256,
    fulfilled_at: u64,
    cancelled_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SettleableRequest {
    request_id: u64,
    assets: U256,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum SettleableRequestSelection {
    Selected(SettleableRequest),
    Empty,
    NotYetEligible {
        request_id: u64,
        eligible_at: DateTime<Utc>,
    },
    InsufficientLiquidity {
        request_id: Option<u64>,
        assets: U256,
        available: U256,
    },
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

fn record_attempt(attempt: HyperliquidSettlementAttempt) -> Result<(), String> {
    record_attempt_in_store(settlement_attempts()?, attempt)
}

fn record_attempt_in_store(
    store: &PersistentStore<HyperliquidSettlementAttempt>,
    attempt: HyperliquidSettlementAttempt,
) -> Result<(), String> {
    store
        .insert(latest_attempt_key(&attempt.bot_id), attempt.clone())
        .map_err(|e| e.to_string())?;
    store
        .insert(epoch_attempt_key(&attempt.bot_id, attempt.epoch), attempt)
        .map_err(|e| e.to_string())
}

fn reservation_lock_for_bot(bot_id: &str) -> Arc<Mutex<()>> {
    SETTLEMENT_RESERVATION_LOCKS
        .entry(bot_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

pub async fn settlement_state(
    bot: &BotContext,
) -> Result<HyperliquidSettlementState, (StatusCode, String)> {
    let provider = provider_for_bot(bot)?;
    let vault = parse_concrete_address(&bot.vault_address, "vault address")?;
    let now = Utc::now();
    let schedule = settlement_schedule_for_bot(bot, now);
    let last_attempt =
        latest_attempt_for_bot(&bot.bot_id).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let vault_state = read_vault_state(&provider, vault).await.ok();
    let next_request_id = match vault_state.as_ref() {
        Some(state) => Some(request_id_to_u64(
            state.next_fulfillable_withdrawal_request_id,
            "next_fulfillable_withdrawal_request_id",
        )?),
        None => None,
    };
    let next_request = match next_request_id {
        Some(id) if id > 0 => read_withdrawal_request(&provider, vault, U256::from(id))
            .await
            .ok(),
        _ => None,
    };
    let next_request_assets = next_request.as_ref().map(|request| request.assets);

    let idle_buffer_bps = min_idle_usdc_bps(bot);
    let max_fulfillments_per_run = max_settlement_fulfillments(bot);
    let retry_backoff_secs = settlement_retry_backoff_secs(bot);
    let settlement_lock_ttl_secs = settlement_lock_ttl_secs(bot);
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
        .map(|request| request_is_eligible(request.eligible_at, now));

    Ok(HyperliquidSettlementState {
        bot_id: bot.bot_id.clone(),
        settlement_cron: CONTRACT_WITHDRAWAL_SETTLEMENT_CRON.to_string(),
        next_settlement_time: schedule.next_settlement,
        cutoff_time: schedule.next_cutoff,
        current_epoch: schedule.current_epoch,
        cutoff_secs: schedule.cutoff_secs,
        idle_buffer_bps,
        max_fulfillments_per_run,
        retry_backoff_secs,
        settlement_lock_ttl_secs,
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
        eligible_pending_request_count: match vault_state.as_ref() {
            Some(state) => Some(eligible_pending_count(&provider, vault, state, now).await?),
            None => None,
        },
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
    let schedule = settlement_schedule_for_bot(bot, now);
    let max_fulfillments = max_settlement_fulfillments(bot);
    let reservation = reserve_settlement_epoch(bot, schedule.current_epoch, now, force)?;

    let result = run_reserved_settlement(state, bot, &schedule, now, max_fulfillments).await;
    let attempt = match result {
        Ok(mut attempt) => {
            attempt.retry_count = reservation.retry_count;
            attempt.next_retry_after = retry_after_for_status(
                &attempt.last_status,
                &attempt.stopped_reason,
                attempt.last_attempt_at,
                bot,
            );
            attempt
        }
        Err((status, err)) => {
            let attempt = settlement_attempt(
                bot,
                schedule.current_epoch,
                HyperliquidSettlementStatus::Failed,
                0,
                U256::ZERO,
                format!("settlement_failed: {err}"),
                vec![],
                reservation.retry_count,
            );
            record_attempt(attempt).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
            return Err((status, err));
        }
    };
    record_attempt(attempt.clone()).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(attempt)
}

fn reserve_settlement_epoch(
    bot: &BotContext,
    epoch: DateTime<Utc>,
    now: DateTime<Utc>,
    force: bool,
) -> Result<HyperliquidSettlementAttempt, (StatusCode, String)> {
    let lock = reservation_lock_for_bot(&bot.bot_id);
    let _guard = lock.lock().map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Hyperliquid settlement reservation lock is poisoned".to_string(),
        )
    })?;
    let store =
        settlement_attempts().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    reserve_settlement_epoch_in_store(store, bot, epoch, now, force)
}

fn reserve_settlement_epoch_in_store(
    store: &PersistentStore<HyperliquidSettlementAttempt>,
    bot: &BotContext,
    epoch: DateTime<Utc>,
    now: DateTime<Utc>,
    force: bool,
) -> Result<HyperliquidSettlementAttempt, (StatusCode, String)> {
    let existing = store
        .get(&epoch_attempt_key(&bot.bot_id, epoch))
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let retry_count = match existing.as_ref() {
        Some(attempt) if !force => {
            settlement_attempt_is_retryable(
                attempt,
                now,
                settlement_retry_backoff_secs(bot),
                settlement_lock_ttl_secs(bot),
            )?;
            attempt.retry_count.saturating_add(1)
        }
        Some(attempt) => attempt.retry_count.saturating_add(1),
        None => 0,
    };
    let reservation = in_progress_attempt(bot, epoch, now, retry_count);
    record_attempt_in_store(store, reservation.clone())
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(reservation)
}

async fn run_reserved_settlement(
    state: &MultiBotTradingState,
    bot: &BotContext,
    schedule: &SettlementSchedule,
    now: DateTime<Utc>,
    max_fulfillments: u32,
) -> Result<HyperliquidSettlementAttempt, (StatusCode, String)> {
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
                0,
            );
            return Err((status, attempt.stopped_reason));
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
            0,
        );
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
        if fulfilled_count >= max_fulfillments {
            stopped_reason = "max_fulfillments_reached".to_string();
            break;
        }

        let vault_state = read_vault_state(&provider, vault).await?;
        if vault_state.pending_redeem_shares == U256::ZERO {
            stopped_reason = "queue_empty".to_string();
            break;
        }
        if !vault_state.is_accounting_fresh {
            stopped_reason = "accounting_stale".to_string();
            break;
        }

        nav = latest_fresh_nav_or_stop(bot, now)?;
        if nav.is_stale_at(now) {
            stopped_reason = "nav_stale".to_string();
            break;
        }

        let request =
            match find_settleable_request(&provider, vault, &vault_state, now, idle_buffer_bps)
                .await?
            {
                SettleableRequestSelection::Selected(request) => request,
                SettleableRequestSelection::Empty => {
                    stopped_reason = "queue_empty".to_string();
                    break;
                }
                SettleableRequestSelection::NotYetEligible { .. } => {
                    stopped_reason = "request_not_eligible".to_string();
                    break;
                }
                SettleableRequestSelection::InsufficientLiquidity { .. } => {
                    stopped_reason = "insufficient_liquidity".to_string();
                    break;
                }
            };
        let assets = request.assets;

        let tx = fulfill_redeem_transaction(vault, request.request_id);
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

    let status = settlement_status_for_result(fulfilled_count, &stopped_reason);
    let attempt = settlement_attempt(
        bot,
        schedule.current_epoch,
        status,
        fulfilled_count,
        fulfilled_assets,
        stopped_reason,
        tx_hashes,
        0,
    );
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
    retry_count: u32,
) -> HyperliquidSettlementAttempt {
    let last_attempt_at = Utc::now();
    let next_retry_after = retry_after_for_status(&status, &stopped_reason, last_attempt_at, bot);
    HyperliquidSettlementAttempt {
        bot_id: bot.bot_id.clone(),
        epoch,
        last_attempt_at,
        last_status: status,
        fulfilled_count,
        fulfilled_assets: fulfilled_assets.to_string(),
        stopped_reason,
        tx_hashes,
        retry_count,
        next_retry_after,
        in_progress_expires_at: None,
    }
}

fn in_progress_attempt(
    bot: &BotContext,
    epoch: DateTime<Utc>,
    now: DateTime<Utc>,
    retry_count: u32,
) -> HyperliquidSettlementAttempt {
    HyperliquidSettlementAttempt {
        bot_id: bot.bot_id.clone(),
        epoch,
        last_attempt_at: now,
        last_status: HyperliquidSettlementStatus::InProgress,
        fulfilled_count: 0,
        fulfilled_assets: U256::ZERO.to_string(),
        stopped_reason: "reserved".to_string(),
        tx_hashes: vec![],
        retry_count,
        next_retry_after: None,
        in_progress_expires_at: Some(
            now + chrono::Duration::seconds(settlement_lock_ttl_secs(bot)),
        ),
    }
}

fn retry_after_for_status(
    status: &HyperliquidSettlementStatus,
    stopped_reason: &str,
    attempted_at: DateTime<Utc>,
    bot: &BotContext,
) -> Option<DateTime<Utc>> {
    if settlement_attempt_closes_epoch(status, stopped_reason) {
        return None;
    }
    if matches!(status, HyperliquidSettlementStatus::InProgress) {
        return None;
    }
    Some(attempted_at + chrono::Duration::seconds(settlement_retry_backoff_secs(bot)))
}

fn settlement_attempt_closes_epoch(
    status: &HyperliquidSettlementStatus,
    stopped_reason: &str,
) -> bool {
    matches!(status, HyperliquidSettlementStatus::Succeeded)
        || matches!(status, HyperliquidSettlementStatus::Skipped)
            && matches!(stopped_reason, "queue_empty" | "request_after_cutoff")
}

fn settlement_attempt_is_retryable(
    attempt: &HyperliquidSettlementAttempt,
    now: DateTime<Utc>,
    retry_backoff_secs: i64,
    lock_ttl_secs: i64,
) -> Result<(), (StatusCode, String)> {
    if settlement_attempt_closes_epoch(&attempt.last_status, &attempt.stopped_reason) {
        return Err((
            StatusCode::CONFLICT,
            "Hyperliquid settlement already completed for the current epoch".to_string(),
        ));
    }

    if matches!(attempt.last_status, HyperliquidSettlementStatus::InProgress) {
        let expires_at = attempt
            .in_progress_expires_at
            .unwrap_or(attempt.last_attempt_at + chrono::Duration::seconds(lock_ttl_secs.max(1)));
        if expires_at <= now {
            return Ok(());
        }
        return Err((
            StatusCode::CONFLICT,
            "Hyperliquid settlement is already in progress for the current epoch".to_string(),
        ));
    }

    let next_retry_after = attempt
        .next_retry_after
        .unwrap_or(attempt.last_attempt_at + chrono::Duration::seconds(retry_backoff_secs));
    if now < next_retry_after {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            format!("Hyperliquid settlement retry is blocked until {next_retry_after}"),
        ));
    }
    Ok(())
}

fn settlement_status_for_result(
    fulfilled_count: u32,
    stopped_reason: &str,
) -> HyperliquidSettlementStatus {
    if matches!(stopped_reason, "queue_empty" | "request_after_cutoff") {
        if fulfilled_count > 0 {
            HyperliquidSettlementStatus::Succeeded
        } else {
            HyperliquidSettlementStatus::Skipped
        }
    } else if stopped_reason.starts_with("tx_failed:") {
        HyperliquidSettlementStatus::Failed
    } else if fulfilled_count > 0 {
        HyperliquidSettlementStatus::Partial
    } else {
        HyperliquidSettlementStatus::Skipped
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
    state: &VaultSettlementState,
    now: DateTime<Utc>,
) -> Result<u32, (StatusCode, String)> {
    let Some((mut request_id, last_id)) = eligible_pending_request_id_bounds(state)? else {
        return Ok(0);
    };

    let mut count = 0u32;
    while request_id != 0 && request_id <= last_id {
        let request = read_withdrawal_request(provider, vault, U256::from(request_id)).await?;
        if request.fulfilled_at == 0
            && request.cancelled_at == 0
            && request.shares > U256::ZERO
            && request_is_eligible(request.eligible_at, now)
        {
            count = count.saturating_add(1);
        }
        request_id = request_id.saturating_add(1);
    }
    Ok(count)
}

async fn find_settleable_request(
    provider: &impl Provider,
    vault: Address,
    state: &VaultSettlementState,
    now: DateTime<Utc>,
    idle_buffer_bps: u32,
) -> Result<SettleableRequestSelection, (StatusCode, String)> {
    let Some((mut request_id, last_id)) = eligible_pending_request_id_bounds(state)? else {
        return Ok(SettleableRequestSelection::Empty);
    };

    let buffer = min_idle_assets(state.total_assets, idle_buffer_bps);
    let available = available_after_buffer(state.idle_assets, buffer);
    let mut requests = Vec::new();
    while request_id != 0 && request_id <= last_id {
        let request = read_withdrawal_request(provider, vault, U256::from(request_id)).await?;
        requests.push((request_id, request));
        request_id = request_id.saturating_add(1);
    }

    Ok(select_settleable_request(
        requests
            .iter()
            .map(|(request_id, request)| (*request_id, request)),
        now,
        state.idle_assets,
        available,
    ))
}

fn select_settleable_request<'a>(
    requests: impl IntoIterator<Item = (u64, &'a WithdrawalRequestState)>,
    now: DateTime<Utc>,
    contract_liquid_assets: U256,
    available_after_buffer: U256,
) -> SettleableRequestSelection {
    let mut skipped_illiquid: Option<(u64, U256)> = None;

    for (request_id, request) in requests {
        if request.fulfilled_at != 0 || request.cancelled_at != 0 || request.shares == U256::ZERO {
            continue;
        }

        if !request_is_eligible(request.eligible_at, now) {
            return SettleableRequestSelection::NotYetEligible {
                request_id,
                eligible_at: request.eligible_at,
            };
        }

        if request.assets > contract_liquid_assets {
            skipped_illiquid.get_or_insert((request_id, request.assets));
            continue;
        }

        if request.assets > available_after_buffer {
            return SettleableRequestSelection::InsufficientLiquidity {
                request_id: Some(request_id),
                assets: request.assets,
                available: available_after_buffer,
            };
        }

        return SettleableRequestSelection::Selected(SettleableRequest {
            request_id,
            assets: request.assets,
        });
    }

    if let Some((request_id, assets)) = skipped_illiquid {
        return SettleableRequestSelection::InsufficientLiquidity {
            request_id: Some(request_id),
            assets,
            available: available_after_buffer,
        };
    }

    SettleableRequestSelection::Empty
}

fn eligible_pending_request_id_bounds(
    state: &VaultSettlementState,
) -> Result<Option<(u64, u64)>, (StatusCode, String)> {
    let request_id = request_id_to_u64(
        state.next_fulfillable_withdrawal_request_id,
        "next_fulfillable_withdrawal_request_id",
    )?;
    let last_id = request_id_to_u64(
        state.next_withdrawal_request_id,
        "next_withdrawal_request_id",
    )?;

    if request_id == 0 || request_id > last_id {
        return Ok(None);
    }
    Ok(Some((request_id, last_id)))
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
    let assets = eth_call_u256(
        provider,
        vault,
        withdrawalRequestAssetsCall {
            requestId: request_id,
        }
        .abi_encode(),
    )
    .await?;
    let eligible_at = eth_call_u64(
        provider,
        vault,
        withdrawalRequestEligibleAtCall {
            requestId: request_id,
        }
        .abi_encode(),
    )
    .await?;
    Ok(WithdrawalRequestState {
        created_at: timestamp_to_utc(decoded.createdAt),
        eligible_at: timestamp_to_utc(eligible_at),
        shares: decoded.shares,
        assets,
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

async fn eth_call_u64(
    provider: &impl Provider,
    to: Address,
    data: Vec<u8>,
) -> Result<u64, (StatusCode, String)> {
    let result = eth_call(provider, to, data).await?;
    u64::abi_decode(&result).map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to decode Hyperliquid settlement u64 response: {e}"),
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

fn min_idle_usdc_bps(bot: &BotContext) -> u32 {
    read_positive_u32_setting(bot, "min_idle_usdc_bps")
        .map(|value| value.min(10_000))
        .unwrap_or(DEFAULT_MIN_IDLE_USDC_BPS)
}

fn max_settlement_fulfillments(bot: &BotContext) -> u32 {
    read_positive_u32_setting(bot, "withdrawal_settlement_max_fulfillments")
        .map(|value| value.min(MAX_SETTLEMENT_FULFILLMENTS_CAP))
        .unwrap_or(DEFAULT_MAX_SETTLEMENT_FULFILLMENTS)
}

fn settlement_retry_backoff_secs(bot: &BotContext) -> i64 {
    read_positive_i64_setting(bot, "withdrawal_settlement_retry_backoff_secs")
        .unwrap_or(DEFAULT_SETTLEMENT_RETRY_BACKOFF_SECS)
}

fn settlement_lock_ttl_secs(bot: &BotContext) -> i64 {
    read_positive_i64_setting(bot, "withdrawal_settlement_lock_ttl_secs")
        .unwrap_or(DEFAULT_SETTLEMENT_LOCK_TTL_SECS)
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
    #[allow(dead_code)]
    current_cutoff: DateTime<Utc>,
    next_settlement: DateTime<Utc>,
    next_cutoff: DateTime<Utc>,
    cutoff_secs: i64,
}

fn settlement_schedule_for_bot(_bot: &BotContext, now: DateTime<Utc>) -> SettlementSchedule {
    settlement_schedule(now)
}

fn settlement_schedule(now: DateTime<Utc>) -> SettlementSchedule {
    let now_timestamp = now.timestamp().max(0);
    let current_epoch_timestamp = now_timestamp - now_timestamp.rem_euclid(86_400);
    let current_epoch = timestamp_to_utc(current_epoch_timestamp as u64);
    let next_settlement = current_epoch + chrono::Duration::days(1);
    let cutoff = chrono::Duration::seconds(CONTRACT_WITHDRAWAL_CUTOFF_SECS);
    SettlementSchedule {
        current_epoch,
        current_cutoff: current_epoch - cutoff,
        next_settlement,
        next_cutoff: next_settlement - cutoff,
        cutoff_secs: CONTRACT_WITHDRAWAL_CUTOFF_SECS,
    }
}

fn timestamp_to_utc(timestamp: u64) -> DateTime<Utc> {
    Utc.timestamp_opt(timestamp as i64, 0)
        .single()
        .unwrap_or_else(Utc::now)
}

fn request_is_eligible(eligible_at: DateTime<Utc>, now: DateTime<Utc>) -> bool {
    eligible_at <= now
}

fn min_idle_assets(total_assets: U256, bps: u32) -> U256 {
    (total_assets * U256::from(bps)) / U256::from(10_000u64)
}

fn available_after_buffer(idle_assets: U256, buffer: U256) -> U256 {
    idle_assets.saturating_sub(buffer)
}

fn fulfill_redeem_transaction(vault: Address, request_id: u64) -> TransactionRequest {
    TransactionRequest::default().to(vault).input(
        Bytes::from(
            fulfillRedeemCall {
                requestId: U256::from(request_id),
            }
            .abi_encode(),
        )
        .into(),
    )
}

fn request_id_to_u64(value: U256, field: &str) -> Result<u64, (StatusCode, String)> {
    if value > U256::from(u64::MAX) {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            format!(
                "Hyperliquid settlement {field} value {value} exceeds supported u64 range; vault queue state is corrupt or unsupported"
            ),
        ));
    }
    Ok(value.to::<u64>())
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

    fn vault_state_with_request_ids(
        next_fulfillable_withdrawal_request_id: U256,
        next_withdrawal_request_id: U256,
    ) -> VaultSettlementState {
        VaultSettlementState {
            idle_assets: U256::ZERO,
            total_assets: U256::ZERO,
            pending_redeem_shares: U256::ZERO,
            next_withdrawal_request_id,
            next_fulfillable_withdrawal_request_id,
            is_accounting_fresh: true,
        }
    }

    fn withdrawal_request(
        created_at: DateTime<Utc>,
        eligible_at: DateTime<Utc>,
        shares: u64,
        assets: u64,
    ) -> WithdrawalRequestState {
        WithdrawalRequestState {
            created_at,
            eligible_at,
            shares: U256::from(shares),
            assets: U256::from(assets),
            fulfilled_at: 0,
            cancelled_at: 0,
        }
    }

    fn temp_attempt_store() -> (
        PersistentStore<HyperliquidSettlementAttempt>,
        tempfile::TempDir,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let store = PersistentStore::open(dir.path().join("attempts.json")).unwrap();
        (store, dir)
    }

    fn stored_attempt(
        bot: &BotContext,
        epoch: DateTime<Utc>,
        last_status: HyperliquidSettlementStatus,
        stopped_reason: &str,
        last_attempt_at: DateTime<Utc>,
    ) -> HyperliquidSettlementAttempt {
        HyperliquidSettlementAttempt {
            bot_id: bot.bot_id.clone(),
            epoch,
            last_attempt_at,
            last_status,
            fulfilled_count: 0,
            fulfilled_assets: U256::ZERO.to_string(),
            stopped_reason: stopped_reason.to_string(),
            tx_hashes: vec![],
            retry_count: 0,
            next_retry_after: None,
            in_progress_expires_at: None,
        }
    }

    #[test]
    fn stored_eligibility_separates_eligible_and_future_requests() {
        let now = Utc.with_ymd_and_hms(2026, 5, 20, 0, 0, 0).unwrap();

        assert!(request_is_eligible(now - chrono::Duration::seconds(1), now));
        assert!(request_is_eligible(now, now));
        assert!(!request_is_eligible(
            now + chrono::Duration::seconds(1),
            now
        ));
    }

    #[test]
    fn settlement_schedule_uses_daily_utc_epoch_and_one_hour_cutoff() {
        let now = Utc.with_ymd_and_hms(2026, 5, 19, 12, 30, 0).unwrap();
        let schedule = settlement_schedule(now);

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
    fn settlement_schedule_ignores_divergent_bot_schedule_config() {
        let bot = bot(
            serde_json::json!({
                "withdrawal_cutoff_secs": 7200
            }),
            serde_json::json!({
                "withdrawal_settlement_cron": "0 0 8 * * *"
            }),
        );
        let now = Utc.with_ymd_and_hms(2026, 5, 19, 12, 30, 0).unwrap();
        let schedule = settlement_schedule_for_bot(&bot, now);

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
        assert_eq!(schedule.cutoff_secs, CONTRACT_WITHDRAWAL_CUTOFF_SECS);
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
    fn selector_uses_stored_assets_and_skips_contract_illiquid_head() {
        let now = Utc.with_ymd_and_hms(2026, 5, 20, 0, 0, 0).unwrap();
        let eligible_at = now - chrono::Duration::seconds(1);
        let created_at = eligible_at - chrono::Duration::hours(1);
        let head = withdrawal_request(created_at, eligible_at, 100, 9_000);
        let later = withdrawal_request(created_at, eligible_at, 10_000, 4_000);

        let selected = select_settleable_request(
            [(1, &head), (2, &later)],
            now,
            U256::from(5_000u64),
            U256::from(5_000u64),
        );

        assert_eq!(
            selected,
            SettleableRequestSelection::Selected(SettleableRequest {
                request_id: 2,
                assets: U256::from(4_000u64)
            })
        );
    }

    #[test]
    fn selector_does_not_convert_current_shares_for_fixed_claim_amounts() {
        let now = Utc.with_ymd_and_hms(2026, 5, 20, 0, 0, 0).unwrap();
        let eligible_at = now;
        let request = withdrawal_request(now - chrono::Duration::hours(1), eligible_at, 1, 4_000);

        let selected = select_settleable_request(
            [(7, &request)],
            now,
            U256::from(5_000u64),
            U256::from(5_000u64),
        );

        assert_eq!(
            selected,
            SettleableRequestSelection::Selected(SettleableRequest {
                request_id: 7,
                assets: U256::from(4_000u64)
            })
        );
    }

    #[test]
    fn fulfillment_calldata_is_keyed_by_selected_request_id() {
        let calldata = fulfillRedeemCall {
            requestId: U256::from(7u64),
        }
        .abi_encode();

        assert_eq!(calldata.len(), 36);
        assert_eq!(&calldata[..4], fulfillRedeemCall::SELECTOR);
        assert_eq!(&calldata[4..], U256::from(7u64).abi_encode().as_slice());
    }

    #[test]
    fn selector_uses_stored_eligibility_not_created_at_cutoff() {
        let now = Utc.with_ymd_and_hms(2026, 5, 20, 0, 0, 0).unwrap();
        let created_at = now - chrono::Duration::days(1);
        let eligible_at = now + chrono::Duration::seconds(1);
        let request = withdrawal_request(created_at, eligible_at, 100, 1_000);

        let selected = select_settleable_request(
            [(1, &request)],
            now,
            U256::from(5_000u64),
            U256::from(5_000u64),
        );

        assert_eq!(
            selected,
            SettleableRequestSelection::NotYetEligible {
                request_id: 1,
                eligible_at
            }
        );
    }

    #[test]
    fn selector_stops_when_buffer_blocks_request_contract_would_fulfill() {
        let now = Utc.with_ymd_and_hms(2026, 5, 20, 0, 0, 0).unwrap();
        let eligible_at = now;
        let head = withdrawal_request(now - chrono::Duration::hours(1), eligible_at, 100, 4_500);
        let later = withdrawal_request(now - chrono::Duration::hours(1), eligible_at, 100, 1_000);

        let selected = select_settleable_request(
            [(1, &head), (2, &later)],
            now,
            U256::from(5_000u64),
            U256::from(4_000u64),
        );

        assert_eq!(
            selected,
            SettleableRequestSelection::InsufficientLiquidity {
                request_id: Some(1),
                assets: U256::from(4_500u64),
                available: U256::from(4_000u64)
            }
        );
    }

    #[test]
    fn request_id_conversion_rejects_oversized_u256_values() {
        let err =
            request_id_to_u64(U256::from(u64::MAX) + U256::from(1u64), "next_request").unwrap_err();

        assert_eq!(err.0, StatusCode::SERVICE_UNAVAILABLE);
        assert!(err.1.contains("exceeds supported u64 range"));
        assert!(err.1.contains("corrupt or unsupported"));
    }

    #[test]
    fn eligible_pending_bounds_preserve_legitimate_empty_queues() {
        let zero_next = vault_state_with_request_ids(U256::ZERO, U256::ZERO);
        assert_eq!(
            eligible_pending_request_id_bounds(&zero_next).unwrap(),
            None
        );

        let next_after_last = vault_state_with_request_ids(U256::from(3u64), U256::from(2u64));
        assert_eq!(
            eligible_pending_request_id_bounds(&next_after_last).unwrap(),
            None
        );
    }

    #[test]
    fn eligible_pending_bounds_return_supported_non_empty_range() {
        let state = vault_state_with_request_ids(U256::from(2u64), U256::from(4u64));

        assert_eq!(
            eligible_pending_request_id_bounds(&state).unwrap(),
            Some((2, 4))
        );
    }

    #[test]
    fn eligible_pending_bounds_reject_oversized_next_withdrawal_request_id() {
        let state =
            vault_state_with_request_ids(U256::from(1u64), U256::from(u64::MAX) + U256::from(1u64));
        let err = eligible_pending_request_id_bounds(&state).unwrap_err();

        assert_eq!(err.0, StatusCode::SERVICE_UNAVAILABLE);
        assert!(err.1.contains("next_withdrawal_request_id"));
        assert!(err.1.contains("corrupt or unsupported"));
    }

    #[test]
    fn eligible_pending_bounds_reject_oversized_next_fulfillable_withdrawal_request_id() {
        let state = vault_state_with_request_ids(
            U256::from(u64::MAX) + U256::from(1u64),
            U256::from(u64::MAX),
        );
        let err = eligible_pending_request_id_bounds(&state).unwrap_err();

        assert_eq!(err.0, StatusCode::SERVICE_UNAVAILABLE);
        assert!(err.1.contains("next_fulfillable_withdrawal_request_id"));
        assert!(err.1.contains("corrupt or unsupported"));
    }

    #[test]
    fn settings_keep_operational_knobs_but_ignore_schedule_config() {
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

        assert_eq!(min_idle_usdc_bps(&bot), 1600);
        assert_eq!(
            max_settlement_fulfillments(&bot),
            DEFAULT_MAX_SETTLEMENT_FULFILLMENTS
        );

        let schedule =
            settlement_schedule_for_bot(&bot, Utc.with_ymd_and_hms(2026, 5, 19, 12, 0, 0).unwrap());
        assert_eq!(schedule.cutoff_secs, CONTRACT_WITHDRAWAL_CUTOFF_SECS);
        assert_eq!(
            schedule.current_epoch,
            Utc.with_ymd_and_hms(2026, 5, 19, 0, 0, 0).unwrap()
        );
    }

    #[test]
    fn fulfillment_bound_is_configurable_and_capped() {
        let bot = bot(
            serde_json::json!({
                "withdrawal_settlement_max_fulfillments": 10_000
            }),
            serde_json::json!({}),
        );

        assert_eq!(
            max_settlement_fulfillments(&bot),
            MAX_SETTLEMENT_FULFILLMENTS_CAP
        );
    }

    #[test]
    fn reservation_records_in_progress_and_blocks_concurrent_retry() {
        let (store, _dir) = temp_attempt_store();
        let bot = bot(serde_json::json!({}), serde_json::json!({}));
        let epoch = Utc.with_ymd_and_hms(2026, 5, 20, 0, 0, 0).unwrap();
        let now = Utc.with_ymd_and_hms(2026, 5, 20, 0, 5, 0).unwrap();

        let reserved = reserve_settlement_epoch_in_store(&store, &bot, epoch, now, false).unwrap();
        assert_eq!(
            reserved.last_status,
            HyperliquidSettlementStatus::InProgress
        );
        assert_eq!(
            reserved.in_progress_expires_at,
            Some(now + chrono::Duration::seconds(DEFAULT_SETTLEMENT_LOCK_TTL_SECS))
        );

        let blocked = reserve_settlement_epoch_in_store(&store, &bot, epoch, now, false)
            .expect_err("fresh in-progress reservation should block");
        assert_eq!(blocked.0, StatusCode::CONFLICT);
        assert!(blocked.1.contains("already in progress"));
    }

    #[test]
    fn stale_in_progress_reservation_can_be_recovered() {
        let (store, _dir) = temp_attempt_store();
        let bot = bot(serde_json::json!({}), serde_json::json!({}));
        let epoch = Utc.with_ymd_and_hms(2026, 5, 20, 0, 0, 0).unwrap();
        let first = Utc.with_ymd_and_hms(2026, 5, 20, 0, 5, 0).unwrap();
        let now = first + chrono::Duration::seconds(DEFAULT_SETTLEMENT_LOCK_TTL_SECS + 1);
        let mut existing = stored_attempt(
            &bot,
            epoch,
            HyperliquidSettlementStatus::InProgress,
            "reserved",
            first,
        );
        existing.in_progress_expires_at =
            Some(first + chrono::Duration::seconds(DEFAULT_SETTLEMENT_LOCK_TTL_SECS));
        record_attempt_in_store(&store, existing).unwrap();

        let recovered = reserve_settlement_epoch_in_store(&store, &bot, epoch, now, false).unwrap();

        assert_eq!(
            recovered.last_status,
            HyperliquidSettlementStatus::InProgress
        );
        assert_eq!(recovered.retry_count, 1);
        assert_eq!(
            recovered.in_progress_expires_at,
            Some(now + chrono::Duration::seconds(DEFAULT_SETTLEMENT_LOCK_TTL_SECS))
        );
    }

    #[test]
    fn retryable_skip_respects_backoff_then_reserves_again() {
        let (store, _dir) = temp_attempt_store();
        let bot = bot(serde_json::json!({}), serde_json::json!({}));
        let epoch = Utc.with_ymd_and_hms(2026, 5, 20, 0, 0, 0).unwrap();
        let first = Utc.with_ymd_and_hms(2026, 5, 20, 0, 5, 0).unwrap();
        let mut existing = stored_attempt(
            &bot,
            epoch,
            HyperliquidSettlementStatus::Skipped,
            "nav_stale",
            first,
        );
        existing.next_retry_after =
            Some(first + chrono::Duration::seconds(DEFAULT_SETTLEMENT_RETRY_BACKOFF_SECS));
        record_attempt_in_store(&store, existing).unwrap();

        let blocked = reserve_settlement_epoch_in_store(
            &store,
            &bot,
            epoch,
            first + chrono::Duration::seconds(60),
            false,
        )
        .expect_err("retry before backoff should be rejected");
        assert_eq!(blocked.0, StatusCode::TOO_MANY_REQUESTS);

        let retried = reserve_settlement_epoch_in_store(
            &store,
            &bot,
            epoch,
            first + chrono::Duration::seconds(DEFAULT_SETTLEMENT_RETRY_BACKOFF_SECS + 1),
            false,
        )
        .unwrap();
        assert_eq!(retried.last_status, HyperliquidSettlementStatus::InProgress);
        assert_eq!(retried.retry_count, 1);
    }

    #[test]
    fn completed_settlement_closes_epoch_against_retry() {
        let (store, _dir) = temp_attempt_store();
        let bot = bot(serde_json::json!({}), serde_json::json!({}));
        let epoch = Utc.with_ymd_and_hms(2026, 5, 20, 0, 0, 0).unwrap();
        let finished_at = Utc.with_ymd_and_hms(2026, 5, 20, 0, 5, 0).unwrap();
        let existing = stored_attempt(
            &bot,
            epoch,
            HyperliquidSettlementStatus::Succeeded,
            "queue_empty",
            finished_at,
        );
        record_attempt_in_store(&store, existing).unwrap();

        let blocked = reserve_settlement_epoch_in_store(
            &store,
            &bot,
            epoch,
            finished_at + chrono::Duration::seconds(DEFAULT_SETTLEMENT_RETRY_BACKOFF_SECS + 1),
            false,
        )
        .expect_err("completed settlement should close the epoch");

        assert_eq!(blocked.0, StatusCode::CONFLICT);
        assert!(blocked.1.contains("already completed"));
    }
}
