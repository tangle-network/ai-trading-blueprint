use once_cell::sync::OnceCell;
use serde::{Deserialize, Serialize};

use sandbox_runtime::store::PersistentStore;

static BOTS: OnceCell<PersistentStore<TradingBotRecord>> = OnceCell::new();
static PAPER_TRADES: OnceCell<PersistentStore<PaperTrade>> = OnceCell::new();

fn default_paper_trade() -> bool {
    true
}

pub use trading_runtime::ValidationTrust;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TradingBotRecord {
    pub id: String,
    pub sandbox_id: String,
    pub vault_address: String,
    pub share_token: String,
    pub strategy_type: String,
    pub strategy_config: serde_json::Value,
    pub risk_params: serde_json::Value,
    pub chain_id: u64,
    pub rpc_url: String,
    pub trading_api_url: String,
    pub trading_api_token: String,
    pub workflow_id: Option<u64>,
    pub trading_active: bool,
    pub created_at: u64,
    /// Operator address that owns this bot.
    #[serde(default)]
    pub operator_address: String,
    /// Validator service IDs used for trade validation discovery.
    #[serde(default)]
    pub validator_service_ids: Vec<u64>,
    /// Requested bot lifetime in days (0 = default 30).
    #[serde(default)]
    pub max_lifetime_days: u64,
    /// Paper trading mode — trades are logged but not executed on-chain.
    #[serde(default = "default_paper_trade")]
    pub paper_trade: bool,
    /// Timestamp when wind-down mode was initiated (None = normal operation).
    #[serde(default)]
    pub wind_down_started_at: Option<u64>,
    /// Address of the wallet that submitted the provision job (for off-chain auth).
    #[serde(default)]
    pub submitter_address: String,
    /// Custom cron schedule from user (empty = use pack default).
    #[serde(default)]
    pub trading_loop_cron: String,
    /// On-chain job call ID (used to resolve vault via botVaults(serviceId, callId)).
    #[serde(default)]
    pub call_id: u64,
    /// Tangle service ID this bot belongs to.
    #[serde(default)]
    pub service_id: u64,
    /// Meta-harness strategy config (HarnessConfig JSON).
    /// Persisted across container restarts. Updated via operator API or evolution.
    #[serde(default)]
    pub harness_json: serde_json::Value,
    /// Validation trust level — controls whether trades need per-trade validator
    /// signatures, envelope-only checks, or no external validation.
    #[serde(default)]
    pub validation_trust: ValidationTrust,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BotLifecycleStatus {
    Unknown,
    AwaitingSecrets,
    Active,
    Stopped,
    WindingDown,
    Archived,
}

impl BotLifecycleStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::AwaitingSecrets => "awaiting_secrets",
            Self::Active => "active",
            Self::Stopped => "stopped",
            Self::WindingDown => "winding_down",
            Self::Archived => "archived",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BotRuntimeStatus {
    pub lifecycle_status: BotLifecycleStatus,
    pub sandbox_state: Option<String>,
    pub sandbox_exists: bool,
    pub sandbox_is_running: bool,
    pub secrets_configured: bool,
    pub archived: bool,
    pub control_available: bool,
}

pub fn bot_runtime_status(bot: &TradingBotRecord) -> BotRuntimeStatus {
    let sandbox = sandbox_runtime::runtime::get_sandbox_by_id(&bot.sandbox_id).ok();
    let sandbox_state = sandbox.as_ref().map(|record| format!("{:?}", record.state));
    let sandbox_exists = sandbox.is_some();
    let sandbox_is_running = sandbox
        .as_ref()
        .map(|record| {
            matches!(
                record.state,
                sandbox_runtime::runtime::SandboxState::Running
            )
        })
        .unwrap_or(false);
    let secrets_configured = sandbox
        .as_ref()
        .map(|record| record.has_user_secrets())
        .unwrap_or(false);
    let archived = !sandbox_exists;

    let lifecycle_status = if archived {
        BotLifecycleStatus::Archived
    } else if bot.wind_down_started_at.is_some() {
        BotLifecycleStatus::WindingDown
    } else if !secrets_configured {
        BotLifecycleStatus::AwaitingSecrets
    } else if sandbox_is_running && bot.trading_active {
        BotLifecycleStatus::Active
    } else if sandbox_exists {
        BotLifecycleStatus::Stopped
    } else {
        BotLifecycleStatus::Unknown
    };

    let control_available = sandbox_exists
        && !matches!(
            lifecycle_status,
            BotLifecycleStatus::Archived
                | BotLifecycleStatus::AwaitingSecrets
                | BotLifecycleStatus::WindingDown
        );

    BotRuntimeStatus {
        lifecycle_status,
        sandbox_state,
        sandbox_exists,
        sandbox_is_running,
        secrets_configured,
        archived,
        control_available,
    }
}

/// A recorded paper trade (simulated execution).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PaperTrade {
    pub id: String,
    pub bot_id: String,
    pub intent: serde_json::Value,
    pub validation: serde_json::Value,
    pub mock_tx_hash: String,
    pub timestamp: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BotLookupCandidates {
    pub live: Vec<TradingBotRecord>,
    pub stale: Vec<TradingBotRecord>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DuplicateBotGroup {
    pub service_id: u64,
    pub call_id: u64,
    pub live_bot_ids: Vec<String>,
    pub stale_bot_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BotStateHealth {
    pub total_bots: usize,
    pub live_bots: usize,
    pub stale_bots: usize,
    pub duplicate_groups: Vec<DuplicateBotGroup>,
}

// ── Activation progress (two-phase provisioning: secrets config) ─────────

static ACTIVATIONS: OnceCell<PersistentStore<ActivationProgress>> = OnceCell::new();

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ActivationProgress {
    pub bot_id: String,
    pub phase: String,
    pub detail: String,
    pub started_at: u64,
    pub updated_at: u64,
}

pub fn activations() -> Result<&'static PersistentStore<ActivationProgress>, String> {
    ACTIVATIONS
        .get_or_try_init(|| {
            let path = sandbox_runtime::store::state_dir().join("activation-progress.json");
            PersistentStore::open(path).map_err(|e| e.to_string())
        })
        .map_err(|e: String| e)
}

pub fn activation_key(bot_id: &str) -> String {
    format!("activation:{bot_id}")
}

pub fn update_activation_progress(bot_id: &str, phase: &str, detail: &str) {
    let now = chrono::Utc::now().timestamp() as u64;
    if let Ok(store) = activations() {
        let started_at = store
            .get(&activation_key(bot_id))
            .ok()
            .flatten()
            .map(|p| p.started_at)
            .unwrap_or(now);

        if let Err(e) = store.insert(
            activation_key(bot_id),
            ActivationProgress {
                bot_id: bot_id.to_string(),
                phase: phase.to_string(),
                detail: detail.to_string(),
                started_at,
                updated_at: now,
            },
        ) {
            tracing::error!(bot_id, phase, "Failed to persist activation progress: {e}");
        }
    }
}

pub fn get_activation(bot_id: &str) -> Result<Option<ActivationProgress>, String> {
    activations()?
        .get(&activation_key(bot_id))
        .map_err(|e| e.to_string())
}

pub fn clear_activation(bot_id: &str) {
    if let Ok(store) = activations() {
        let _ = store.remove(&activation_key(bot_id));
    }
}

pub fn bots() -> Result<&'static PersistentStore<TradingBotRecord>, String> {
    BOTS.get_or_try_init(|| {
        let path = sandbox_runtime::store::state_dir().join("trading-bots.json");
        PersistentStore::open(path).map_err(|e| e.to_string())
    })
    .map_err(|e: String| e)
}

pub fn bot_key(id: &str) -> String {
    format!("bot:{id}")
}

/// Find a bot record by sandbox_id.
pub fn find_bot_by_sandbox(sandbox_id: &str) -> Result<TradingBotRecord, String> {
    let sid = sandbox_id.to_string();
    bots()?
        .find(|b| b.sandbox_id == sid)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("No trading bot found for sandbox {sandbox_id}"))
}

/// Find a bot record by on-chain (service_id, call_id) pair.
///
/// Used for provision dedup: if a provision job is replayed (e.g., operator restart
/// replays past events), return the existing bot instead of creating a duplicate.
pub fn find_bot_by_call(service_id: u64, call_id: u64) -> Result<Option<TradingBotRecord>, String> {
    Ok(bots()?
        .find(|b| b.service_id == service_id && b.call_id == call_id)
        .map_err(|e| e.to_string())?)
}

/// Find a bot record by API token.
pub fn find_bot_by_token(token: &str) -> Result<TradingBotRecord, String> {
    let tok = token.to_string();
    bots()?
        .find(|b| b.trading_api_token == tok)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No trading bot found for given API token".to_string())
}

/// Access the paper-trades persistent store.
pub fn paper_trades() -> Result<&'static PersistentStore<PaperTrade>, String> {
    PAPER_TRADES
        .get_or_try_init(|| {
            let path = sandbox_runtime::store::state_dir().join("paper-trades.json");
            PersistentStore::open(path).map_err(|e| e.to_string())
        })
        .map_err(|e: String| e)
}

/// Store key for a paper trade.
pub fn paper_trade_key(id: &str) -> String {
    format!("paper:{id}")
}

/// Get all paper trades for a specific bot.
pub fn paper_trades_for_bot(bot_id: &str) -> Result<Vec<PaperTrade>, String> {
    let bid = bot_id.to_string();
    Ok(paper_trades()?
        .values()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|t| t.bot_id == bid)
        .collect())
}

pub struct PaginatedBots {
    pub bots: Vec<TradingBotRecord>,
    pub total: usize,
}

/// List all bots with pagination.
pub fn list_bots(limit: usize, offset: usize) -> Result<PaginatedBots, String> {
    let mut all = bots()?.values().map_err(|e| e.to_string())?;
    all.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    let total = all.len();
    let page = all.into_iter().skip(offset).take(limit).collect();
    Ok(PaginatedBots { bots: page, total })
}

/// List bots owned by a specific operator address.
pub fn bots_by_operator(
    operator: &str,
    limit: usize,
    offset: usize,
) -> Result<PaginatedBots, String> {
    let op = operator.to_lowercase();
    let mut all: Vec<TradingBotRecord> = bots()?
        .values()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|b| b.operator_address.to_lowercase() == op)
        .collect();
    all.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    let total = all.len();
    let page = all.into_iter().skip(offset).take(limit).collect();
    Ok(PaginatedBots { bots: page, total })
}

/// List bots using a specific strategy type.
pub fn bots_by_strategy(
    strategy: &str,
    limit: usize,
    offset: usize,
) -> Result<PaginatedBots, String> {
    let strat = strategy.to_string();
    let mut all: Vec<TradingBotRecord> = bots()?
        .values()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|b| b.strategy_type == strat)
        .collect();
    all.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    let total = all.len();
    let page = all.into_iter().skip(offset).take(limit).collect();
    Ok(PaginatedBots { bots: page, total })
}

/// Get a single bot by ID.
pub fn get_bot(id: &str) -> Result<Option<TradingBotRecord>, String> {
    bots()?.get(&bot_key(id)).map_err(|e| e.to_string())
}

/// Find a bot by vault address (case-insensitive).
pub fn find_bot_by_vault_address(vault: &str) -> Result<Option<TradingBotRecord>, String> {
    let v = vault.to_lowercase();
    bots()?
        .find(|b| b.vault_address.to_lowercase() == v)
        .map_err(|e| e.to_string())
}

/// Find a bot by on-chain call_id and service_id.
pub fn find_bot_by_call_id(
    service_id: u64,
    call_id: u64,
) -> Result<Option<TradingBotRecord>, String> {
    Ok(bot_lookup_candidates_by_call_id(service_id, call_id)?
        .live
        .into_iter()
        .next())
}

pub fn bot_lookup_candidates_by_call_id(
    service_id: u64,
    call_id: u64,
) -> Result<BotLookupCandidates, String> {
    let mut live: Vec<TradingBotRecord> = Vec::new();
    let mut stale: Vec<TradingBotRecord> = Vec::new();

    for bot in bots()?.values().map_err(|e| e.to_string())?.into_iter() {
        if bot.service_id != service_id || bot.call_id != call_id {
            continue;
        }

        if sandbox_runtime::runtime::get_sandbox_by_id(&bot.sandbox_id).is_ok() {
            live.push(bot);
        } else {
            stale.push(bot);
        }
    }

    let sort_desc = |a: &TradingBotRecord, b: &TradingBotRecord| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| b.id.cmp(&a.id))
    };
    live.sort_by(sort_desc);
    stale.sort_by(sort_desc);

    if live.len() + stale.len() > 1 {
        let summaries: Vec<String> = live
            .iter()
            .map(|b| format!("live:{}:{}@{}", b.id, b.sandbox_id, b.created_at))
            .chain(
                stale
                    .iter()
                    .map(|b| format!("stale:{}:{}@{}", b.id, b.sandbox_id, b.created_at)),
            )
            .collect();
        tracing::warn!(
            service_id,
            call_id,
            matches = %summaries.join(", "),
            "Multiple bot records found for service_id/call_id"
        );
    }

    Ok(BotLookupCandidates { live, stale })
}

pub fn bot_state_health() -> Result<BotStateHealth, String> {
    let all: Vec<TradingBotRecord> = bots()?.values().map_err(|e| e.to_string())?;
    let mut live_bots = 0usize;
    let mut stale_bots = 0usize;
    let mut grouped: std::collections::BTreeMap<(u64, u64), DuplicateBotGroup> =
        std::collections::BTreeMap::new();

    for bot in &all {
        let is_live = sandbox_runtime::runtime::get_sandbox_by_id(&bot.sandbox_id).is_ok();
        if is_live {
            live_bots += 1;
        } else {
            stale_bots += 1;
        }

        let entry = grouped
            .entry((bot.service_id, bot.call_id))
            .or_insert_with(|| DuplicateBotGroup {
                service_id: bot.service_id,
                call_id: bot.call_id,
                live_bot_ids: Vec::new(),
                stale_bot_ids: Vec::new(),
            });

        if is_live {
            entry.live_bot_ids.push(bot.id.clone());
        } else {
            entry.stale_bot_ids.push(bot.id.clone());
        }
    }

    let duplicate_groups = grouped
        .into_values()
        .filter(|group| group.live_bot_ids.len() + group.stale_bot_ids.len() > 1)
        .collect();

    Ok(BotStateHealth {
        total_bots: all.len(),
        live_bots,
        stale_bots,
        duplicate_groups,
    })
}

/// Get a bot by either its trading ID or vault address.
pub fn resolve_bot(id: &str) -> Result<Option<TradingBotRecord>, String> {
    if let Some(b) = get_bot(id)? {
        return Ok(Some(b));
    }
    find_bot_by_vault_address(id)
}

/// Update the harness config for a bot. Validates the JSON before persisting.
pub fn update_harness(bot_id: &str, harness: serde_json::Value) -> Result<(), String> {
    // Validate it deserializes as a HarnessConfig
    let parsed: trading_runtime::backtest::HarnessConfig = serde_json::from_value(harness.clone())
        .map_err(|e| format!("Invalid harness JSON: {e}"))?;
    parsed
        .validate()
        .map_err(|errors| format!("Harness validation failed: {}", errors.join("; ")))?;

    let key = bot_key(bot_id);
    bots()?
        .update(&key, |bot| {
            bot.harness_json = harness;
        })
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Load per-bot trade data from `{state_dir}/bot-trades/{bot_id}.json`.
pub fn load_bot_trades(bot_id: &str) -> Vec<serde_json::Value> {
    let path = sandbox_runtime::store::state_dir()
        .join("bot-trades")
        .join(format!("{bot_id}.json"));
    match std::fs::read_to_string(&path) {
        Ok(data) => match serde_json::from_str(&data) {
            Ok(trades) => trades,
            Err(e) => {
                tracing::error!(
                    bot_id = %bot_id,
                    path = %path.display(),
                    "Corrupted trade data for bot: {e}"
                );
                Vec::new()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => {
            tracing::error!(
                bot_id = %bot_id,
                path = %path.display(),
                "Failed to read trade data file: {e}"
            );
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_test_env() {
        use std::sync::Once;
        static INIT: Once = Once::new();
        INIT.call_once(|| {
            let tmp = tempfile::TempDir::new().unwrap();
            // SAFETY: called once before store init
            unsafe { std::env::set_var("BLUEPRINT_STATE_DIR", tmp.path()) };
            std::mem::forget(tmp);
        });
    }

    fn make_bot(id: &str, operator: &str, strategy: &str, created_at: u64) -> TradingBotRecord {
        TradingBotRecord {
            id: id.to_string(),
            sandbox_id: format!("sandbox-{id}"),
            vault_address: "0x0000000000000000000000000000000000000001".to_string(),
            share_token: "0x0000000000000000000000000000000000000002".to_string(),
            strategy_type: strategy.to_string(),
            strategy_config: serde_json::json!({}),
            risk_params: serde_json::json!({}),
            chain_id: 31337,
            rpc_url: "http://localhost:8545".to_string(),
            trading_api_url: "http://localhost:9000".to_string(),
            trading_api_token: format!("token-{id}"),
            workflow_id: None,
            trading_active: true,
            created_at,
            operator_address: operator.to_string(),
            validator_service_ids: vec![],
            max_lifetime_days: 30,
            paper_trade: true,
            wind_down_started_at: None,
            submitter_address: String::new(),
            trading_loop_cron: String::new(),
            call_id: 0,
            service_id: 0,
            harness_json: serde_json::Value::default(),
            validation_trust: trading_runtime::ValidationTrust::default(),
        }
    }

    /// Single test to avoid shared-OnceCell ordering issues.
    #[test]
    fn test_state_queries() {
        setup_test_env();

        let store = bots().unwrap();
        store
            .insert(bot_key("b1"), make_bot("b1", "0xOp1", "defi_yield", 1000))
            .unwrap();
        store
            .insert(bot_key("b2"), make_bot("b2", "0xOp2", "dex_trading", 2000))
            .unwrap();
        store
            .insert(bot_key("b3"), make_bot("b3", "0xOp1", "defi_yield", 3000))
            .unwrap();

        // list_bots: all 3, sorted descending by created_at
        let result = list_bots(10, 0).unwrap();
        assert_eq!(result.total, 3);
        assert_eq!(result.bots.len(), 3);
        assert_eq!(result.bots[0].id, "b3");
        assert_eq!(result.bots[1].id, "b2");
        assert_eq!(result.bots[2].id, "b1");

        // pagination
        let page = list_bots(1, 1).unwrap();
        assert_eq!(page.total, 3);
        assert_eq!(page.bots.len(), 1);
        assert_eq!(page.bots[0].id, "b2");

        // bots_by_operator
        let by_op = bots_by_operator("0xOp1", 10, 0).unwrap();
        assert_eq!(by_op.total, 2);
        assert!(by_op.bots.iter().all(|b| b.operator_address == "0xOp1"));

        // bots_by_strategy
        let by_strat = bots_by_strategy("defi_yield", 10, 0).unwrap();
        assert_eq!(by_strat.total, 2);
        assert!(
            by_strat
                .bots
                .iter()
                .all(|b| b.strategy_type == "defi_yield")
        );

        // get_bot
        let found = get_bot("b1").unwrap();
        assert!(found.is_some());
        assert_eq!(found.unwrap().id, "b1");

        let not_found = get_bot("nonexistent").unwrap();
        assert!(not_found.is_none());
    }
}
