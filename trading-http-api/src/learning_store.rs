//! Per-bot persistence of strategy-bandit + slippage-learner state.
//!
//! Mirrors the on-disk layout used by `trading-blueprint-lib::state::learning_store`
//! (which re-exports this module): a flat directory of JSON blobs keyed by
//! sanitized bot id under `state_dir/learning/{bot_id}.json`. Lives inside
//! `trading-http-api` so the post-trade hooks in `routes::execute` and the
//! `/learning/*` endpoints can read and mutate the file without taking a
//! dependency on `trading-blueprint-lib` (which would create a cycle).

use std::path::PathBuf;
use std::sync::Mutex;

use once_cell::sync::Lazy;

pub use trading_runtime::learning::BotLearningState;

/// Coarse process-wide write lock — guards file writes against concurrent
/// callers in the same process. Writes are infrequent (post-trade hooks,
/// daily reflection), so a single mutex is sufficient.
static WRITE_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

/// Test-only override for the learning directory. Production callers always
/// see `None` and fall back to `sandbox_runtime::store::state_dir()`.
///
/// Exposed (gated on `feature = "test-utils"`) so sibling crates'
/// integration tests can re-use the same in-process learning_store without
/// racing against `BLUEPRINT_STATE_DIR`-mutating tests in their own binaries.
#[cfg(any(test, feature = "test-utils"))]
static TEST_DIR_OVERRIDE: Lazy<Mutex<Option<PathBuf>>> = Lazy::new(|| Mutex::new(None));

#[cfg(any(test, feature = "test-utils"))]
pub fn set_test_dir(path: PathBuf) {
    *TEST_DIR_OVERRIDE.lock().expect("test dir mutex") = Some(path);
}

fn learning_dir() -> PathBuf {
    #[cfg(any(test, feature = "test-utils"))]
    {
        if let Some(path) = TEST_DIR_OVERRIDE.lock().expect("test dir mutex").as_ref() {
            return path.join("learning");
        }
    }
    sandbox_runtime::store::state_dir().join("learning")
}

fn sanitize_bot_id(bot_id: &str) -> String {
    bot_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn learning_path(bot_id: &str) -> PathBuf {
    learning_dir().join(format!("{}.json", sanitize_bot_id(bot_id)))
}

/// Load the learning state for `bot_id`. Returns the default empty state if
/// no file exists yet. A corrupt file is logged and treated as missing so a
/// single bad write can't permanently brick the agent's learner.
pub fn load(bot_id: &str) -> BotLearningState {
    match std::fs::read_to_string(learning_path(bot_id)) {
        Ok(data) => match serde_json::from_str(&data) {
            Ok(state) => state,
            Err(e) => {
                tracing::error!(
                    bot_id,
                    "Corrupt learning state file — using empty state: {e}"
                );
                BotLearningState::default()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => BotLearningState::default(),
        Err(e) => {
            tracing::error!(bot_id, "Failed to read learning state: {e}");
            BotLearningState::default()
        }
    }
}

/// Persist `state` for `bot_id`. Write errors are surfaced to the caller so
/// hooks can downgrade them to warnings without losing visibility.
pub fn save(bot_id: &str, state: &BotLearningState) -> Result<(), String> {
    let _guard = WRITE_LOCK
        .lock()
        .map_err(|_| "learning store mutex poisoned".to_string())?;

    std::fs::create_dir_all(learning_dir()).map_err(|e| format!("create learning dir: {e}"))?;
    let json = serde_json::to_string_pretty(state)
        .map_err(|e| format!("serialize learning state: {e}"))?;
    std::fs::write(learning_path(bot_id), json).map_err(|e| format!("write learning state: {e}"))
}

/// Read-modify-write helper. The closure receives the current state and may
/// mutate it; the result is persisted on success.
pub fn update<F>(bot_id: &str, mutate: F) -> Result<BotLearningState, String>
where
    F: FnOnce(&mut BotLearningState),
{
    let mut state = load(bot_id);
    mutate(&mut state);
    save(bot_id, &state)?;
    Ok(state)
}

/// Remove the learning state for `bot_id` (used when a bot is deprovisioned).
pub fn clear(bot_id: &str) -> Result<(), String> {
    let path = learning_path(bot_id);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove learning state: {e}")),
    }
}

// ── Public learning API used by post-trade hooks and HTTP routes ────────────

/// Compute observed slippage in basis points from a `min_amount_out` /
/// `actual_amount_out` pair. Returns `None` when the data is missing or
/// non-positive (we never write zero-bps observations on degenerate input).
///
/// Formula: `(min_amount_out - actual_amount_out) / min_amount_out * 10_000`.
/// Because `actual_amount_out >= min_amount_out` for a successful fill, the
/// numerator is `<= 0`. We clamp to `[0, u32::MAX]` so a positive bps value
/// always represents the *amount the fill fell short of the cap*. Trades that
/// over-fill the floor (i.e. better than the minimum) record `0` bps.
pub fn observed_slippage_bps(min_amount_out: f64, actual_amount_out: f64) -> Option<u32> {
    if min_amount_out <= 0.0 || !actual_amount_out.is_finite() {
        return None;
    }
    let shortfall = min_amount_out - actual_amount_out;
    if shortfall <= 0.0 {
        return Some(0);
    }
    let bps = (shortfall / min_amount_out * 10_000.0).round();
    if bps.is_nan() || bps < 0.0 {
        return None;
    }
    if bps >= u32::MAX as f64 {
        return Some(u32::MAX);
    }
    Some(bps as u32)
}

/// Append a successful-fill observation for `bot_id` and `(token_in, token_out)`.
/// Errors are logged at warn level (post-trade hook is best-effort).
pub fn record_fill(
    bot_id: &str,
    token_in: alloy::primitives::Address,
    token_out: alloy::primitives::Address,
    observed_bps: u32,
) {
    if let Err(error) = update(bot_id, |state| {
        state
            .slippage
            .record_fill(token_in, token_out, observed_bps);
    }) {
        tracing::warn!(bot_id, %error, "failed to persist slippage fill");
    }
}

/// Increment the failure counter for `(bot_id, token_in, token_out)`.
pub fn record_failure(
    bot_id: &str,
    token_in: alloy::primitives::Address,
    token_out: alloy::primitives::Address,
) {
    if let Err(error) = update(bot_id, |state| {
        state.slippage.record_failure(token_in, token_out);
    }) {
        tracing::warn!(bot_id, %error, "failed to persist slippage failure");
    }
}

/// Record a strategy outcome against the bandit's arm for `variant_id`.
pub fn record_strategy_outcome(bot_id: &str, variant_id: &str, reward: f64) {
    if let Err(error) = update(bot_id, |state| {
        state.bandit.record_outcome(variant_id, reward);
    }) {
        tracing::warn!(bot_id, %error, "failed to persist strategy outcome");
    }
}

/// Recommend a `max_slippage_bps` cap for a token-pair, falling back to
/// `fallback` when there are no observations yet.
pub fn recommend_max_slippage_bps(
    bot_id: &str,
    token_in: alloy::primitives::Address,
    token_out: alloy::primitives::Address,
    fallback: u32,
) -> u32 {
    load(bot_id)
        .slippage
        .recommend_max_bps(token_in, token_out, fallback)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observed_slippage_bps_handles_short_fills() {
        assert_eq!(observed_slippage_bps(100.0, 99.0), Some(100));
        assert_eq!(observed_slippage_bps(100.0, 95.0), Some(500));
    }

    #[test]
    fn observed_slippage_bps_clamps_overfills_to_zero() {
        // Better-than-minimum fill -> 0 bps slippage observed.
        assert_eq!(observed_slippage_bps(100.0, 105.0), Some(0));
    }

    #[test]
    fn observed_slippage_bps_rejects_degenerate_input() {
        assert_eq!(observed_slippage_bps(0.0, 1.0), None);
        assert_eq!(observed_slippage_bps(-1.0, 1.0), None);
        assert_eq!(observed_slippage_bps(100.0, f64::NAN), None);
    }
}
