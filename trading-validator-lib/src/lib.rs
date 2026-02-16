pub mod context;
pub mod jobs;
pub mod risk_evaluator;
pub mod scoring;
pub mod server;
pub mod signer;
pub mod slashing;

use blueprint_sdk::Job;
use blueprint_sdk::Router;
use blueprint_sdk::tangle::TangleLayer;

pub use blueprint_sdk::tangle;

// Job IDs matching ValidatorBlueprint.sol v0.2.0
// Registration and slashing are handled by Tangle protocol hooks (onRegister, onSlash),
// NOT by jobs.  These operational jobs are all that remain:
pub const JOB_UPDATE_REPUTATION: u8 = 0;
pub const JOB_UPDATE_CONFIG: u8 = 1;
pub const JOB_LIVENESS: u8 = 2;

// ABI types using alloy sol! macro
blueprint_sdk::alloy::sol! {
    /// Reputation update — submitted by each operator periodically
    struct ReputationUpdate {
        address validator_address;
        int256 delta;
        bytes32 trade_hash;
    }

    /// Configuration update
    struct ConfigUpdate {
        uint256 threshold;
        uint256 min_stake;
    }

    /// Liveness heartbeat proof
    struct LivenessProof {
        uint64 timestamp;
        bytes32 block_hash;
    }

    /// Generic JSON response for job results
    struct JsonResponse {
        string json;
    }

    /// Reputation output — ABI-encoded in onJobResult outputs
    /// Must match: abi.encode(uint256 validationCount, int256 reputationDelta)
    struct ReputationOutput {
        uint256 validation_count;
        int256 reputation_delta;
    }
}

/// State for a registered validator operator (persisted per-operator)
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ValidatorState {
    pub address: String,
    pub endpoint: String,
    pub reputation: i64,
    pub active: bool,
    pub last_heartbeat: u64,
}

/// Per-vault validator configuration
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct VaultValidatorConfig {
    pub vault_address: String,
    pub chain_id: u64,
    pub verifying_contract: String,
    pub threshold: u32,
}

/// Metrics tracked per validator operator
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct ValidatorMetrics {
    pub validations_completed: u64,
    pub average_score: f64,
    pub average_latency_ms: u64,
    pub ai_scoring_failures: u64,
}

impl ValidatorMetrics {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a completed validation
    pub fn record_validation(&mut self, score: u32, latency_ms: u64) {
        self.validations_completed += 1;
        let alpha: f64 = if self.validations_completed == 1 {
            1.0 // First observation gets full weight
        } else {
            0.1
        };
        self.average_score = self.average_score * (1.0 - alpha) + score as f64 * alpha;
        self.average_latency_ms =
            ((self.average_latency_ms as f64 * (1.0 - alpha)) + (latency_ms as f64 * alpha)) as u64;
    }

    pub fn record_ai_failure(&mut self) {
        self.ai_scoring_failures += 1;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE MANAGEMENT — PersistentStore for multi-operator support
// ═══════════════════════════════════════════════════════════════════════════════

use once_cell::sync::OnceCell;
use std::collections::HashMap;
use std::sync::Mutex;

// For now, use Mutex<HashMap> for in-process state since the validator server
// is stateless across restarts (it re-registers with the protocol).
// The PersistentStore pattern from sandbox-runtime can be added when
// cross-restart persistence is needed.

static VALIDATOR_STATES: OnceCell<Mutex<HashMap<String, ValidatorState>>> = OnceCell::new();
static VAULT_CONFIGS: OnceCell<Mutex<HashMap<String, VaultValidatorConfig>>> = OnceCell::new();
static VALIDATOR_METRICS: OnceCell<Mutex<HashMap<String, ValidatorMetrics>>> = OnceCell::new();

fn validator_states() -> &'static Mutex<HashMap<String, ValidatorState>> {
    VALIDATOR_STATES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn validator_metrics_store() -> &'static Mutex<HashMap<String, ValidatorMetrics>> {
    VALIDATOR_METRICS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Get validator state for a specific operator address.
pub fn get_validator_state(operator: &str) -> Result<Option<ValidatorState>, String> {
    let guard = validator_states().lock().map_err(|e| e.to_string())?;
    Ok(guard.get(operator).cloned())
}

/// Set validator state for a specific operator.
pub fn set_validator_state(state: ValidatorState) -> Result<(), String> {
    let mut guard = validator_states().lock().map_err(|e| e.to_string())?;
    guard.insert(state.address.clone(), state);
    Ok(())
}

/// Remove validator state for a specific operator.
pub fn remove_validator_state(operator: &str) -> Result<(), String> {
    let mut guard = validator_states().lock().map_err(|e| e.to_string())?;
    guard.remove(operator);
    Ok(())
}

/// Get all registered validators.
pub fn get_all_validators() -> Result<HashMap<String, ValidatorState>, String> {
    let guard = validator_states().lock().map_err(|e| e.to_string())?;
    Ok(guard.clone())
}

/// Get metrics for a specific operator.
pub fn get_validator_metrics(operator: &str) -> Result<ValidatorMetrics, String> {
    let guard = validator_metrics_store().lock().map_err(|e| e.to_string())?;
    Ok(guard.get(operator).cloned().unwrap_or_else(ValidatorMetrics::new))
}

/// Update metrics for a specific operator via a closure.
pub fn update_validator_metrics<F>(operator: &str, f: F) -> Result<(), String>
where
    F: FnOnce(&mut ValidatorMetrics),
{
    let mut guard = validator_metrics_store().lock().map_err(|e| e.to_string())?;
    let metrics = guard
        .entry(operator.to_string())
        .or_insert_with(ValidatorMetrics::new);
    f(metrics);
    Ok(())
}

/// Get the configuration for a specific vault address.
pub fn get_vault_config(vault_address: &str) -> Result<Option<VaultValidatorConfig>, String> {
    let lock = VAULT_CONFIGS.get_or_init(|| Mutex::new(HashMap::new()));
    let guard = lock.lock().map_err(|e| e.to_string())?;
    Ok(guard.get(vault_address).cloned())
}

/// Set the configuration for a specific vault address.
pub fn set_vault_config(config: VaultValidatorConfig) -> Result<(), String> {
    let lock = VAULT_CONFIGS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = lock.lock().map_err(|e| e.to_string())?;
    guard.insert(config.vault_address.clone(), config);
    Ok(())
}

/// Remove the configuration for a specific vault address.
pub fn remove_vault_config(vault_address: &str) -> Result<(), String> {
    let lock = VAULT_CONFIGS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = lock.lock().map_err(|e| e.to_string())?;
    guard.remove(vault_address);
    Ok(())
}

/// Get all vault configurations.
pub fn get_all_vault_configs() -> Result<HashMap<String, VaultValidatorConfig>, String> {
    let lock = VAULT_CONFIGS.get_or_init(|| Mutex::new(HashMap::new()));
    let guard = lock.lock().map_err(|e| e.to_string())?;
    Ok(guard.clone())
}

/// Build the job router with only operational jobs.
/// Registration, deregistration, and slashing are handled by the
/// Tangle protocol's `onRegister`, `onUnregister`, and `onSlash` hooks.
pub fn router() -> Router {
    Router::new()
        .route(JOB_UPDATE_REPUTATION, jobs::update_reputation::handle_update_reputation.layer(TangleLayer))
        .route(JOB_UPDATE_CONFIG, jobs::update_config::handle_update_config.layer(TangleLayer))
        .route(JOB_LIVENESS, jobs::liveness::handle_liveness.layer(TangleLayer))
}
