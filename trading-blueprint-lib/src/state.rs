use once_cell::sync::OnceCell;
use serde::{Deserialize, Serialize};

use sandbox_runtime::store::PersistentStore;

static BOTS: OnceCell<PersistentStore<TradingBotRecord>> = OnceCell::new();
static PAPER_TRADES: OnceCell<PersistentStore<PaperTrade>> = OnceCell::new();

fn default_paper_trade() -> bool {
    true
}

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

        let _ = store.insert(
            activation_key(bot_id),
            ActivationProgress {
                bot_id: bot_id.to_string(),
                phase: phase.to_string(),
                detail: detail.to_string(),
                started_at,
                updated_at: now,
            },
        );
    }
}

pub fn get_activation(bot_id: &str) -> Result<Option<ActivationProgress>, String> {
    activations()?.get(&activation_key(bot_id)).map_err(|e| e.to_string())
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
pub fn bots_by_operator(operator: &str, limit: usize, offset: usize) -> Result<PaginatedBots, String> {
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
pub fn bots_by_strategy(strategy: &str, limit: usize, offset: usize) -> Result<PaginatedBots, String> {
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

/// Get a bot by either its trading ID or vault address.
pub fn resolve_bot(id: &str) -> Result<Option<TradingBotRecord>, String> {
    if let Some(b) = get_bot(id)? {
        return Ok(Some(b));
    }
    find_bot_by_vault_address(id)
}

/// Load per-bot trade data from `{state_dir}/bot-trades/{bot_id}.json`.
pub fn load_bot_trades(bot_id: &str) -> Vec<serde_json::Value> {
    let path = sandbox_runtime::store::state_dir()
        .join("bot-trades")
        .join(format!("{bot_id}.json"));
    match std::fs::read_to_string(&path) {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => Vec::new(),
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
        }
    }

    /// Single test to avoid shared-OnceCell ordering issues.
    #[test]
    fn test_state_queries() {
        setup_test_env();

        let store = bots().unwrap();
        store.insert(bot_key("b1"), make_bot("b1", "0xOp1", "defi_yield", 1000)).unwrap();
        store.insert(bot_key("b2"), make_bot("b2", "0xOp2", "dex_trading", 2000)).unwrap();
        store.insert(bot_key("b3"), make_bot("b3", "0xOp1", "defi_yield", 3000)).unwrap();

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
        assert!(by_strat.bots.iter().all(|b| b.strategy_type == "defi_yield"));

        // get_bot
        let found = get_bot("b1").unwrap();
        assert!(found.is_some());
        assert_eq!(found.unwrap().id, "b1");

        let not_found = get_bot("nonexistent").unwrap();
        assert!(not_found.is_none());
    }
}
