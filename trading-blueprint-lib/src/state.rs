use once_cell::sync::OnceCell;
use serde::{Deserialize, Serialize};

use sandbox_runtime::store::PersistentStore;

static BOTS: OnceCell<PersistentStore<TradingBotRecord>> = OnceCell::new();

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
