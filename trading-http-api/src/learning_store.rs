//! Per-bot persistence of strategy-bandit + slippage-learner state.
//!
//! Mirrors the on-disk layout used by `trading-blueprint-lib::state::learning_store`
//! (which re-exports this module): a flat directory of JSON blobs keyed by
//! sanitized bot id under `state_dir/learning/{bot_id}.json`. Lives inside
//! `trading-http-api` so the post-trade hooks in `routes::execute` and the
//! `/learning/*` endpoints can read and mutate the file without taking a
//! dependency on `trading-blueprint-lib` (which would create a cycle).
//!
//! ## Concurrency
//!
//! Writes are guarded by a **per-bot** mutex stored in a global `DashMap`.
//! The previous implementation used a single process-wide `Mutex<()>`,
//! which serialised every post-trade hook + `/learning/*` write across
//! every bot. With 1000 concurrent bots writing trade outcomes, that lock
//! dominates — bot A waits on bot B for a file write that touches a
//! different file. The sharded mutex isolates contention to bots that
//! genuinely race on the same file.
//!
//! A background sweeper task ([`spawn_lock_cleanup`]) prunes
//! lock entries whose only remaining owner is the map (i.e.
//! `Arc::strong_count == 1`) every 5 minutes so the map does not retain
//! locks for bots that have been deprovisioned.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dashmap::DashMap;
use once_cell::sync::Lazy;

pub use trading_runtime::learning::BotLearningState;

/// Global sharded write-lock map. Each bot acquires its own `Mutex<()>` for
/// the read-modify-write window, so writes for different bots run in
/// parallel. The map itself is a `DashMap` so contention to *take* the
/// per-bot mutex out of the map is also sharded.
///
/// Mutex type: `std::sync::Mutex<()>` rather than `tokio::sync::Mutex<()>`
/// because the file-IO save path is fully sync (and is called from sync +
/// async contexts alike via `update`). Switching to `tokio::sync::Mutex`
/// would force every caller to be `async` and ripple through the
/// `record_fill` / `record_failure` post-trade hooks.
static BOT_WRITE_LOCKS: Lazy<DashMap<String, Arc<Mutex<()>>>> = Lazy::new(DashMap::new);

/// How often the background sweeper prunes idle locks. 5 minutes is large
/// enough to stay below 0.1% CPU on a 100K-bot fleet, small enough to
/// reclaim memory promptly when bots are deprovisioned in bulk.
pub const LOCK_CLEANUP_INTERVAL: Duration = Duration::from_secs(5 * 60);

fn lock_for_bot(bot_id: &str) -> Arc<Mutex<()>> {
    // `entry()` returns a `RefMut` holding the shard write lock; cloning
    // the `Arc` is the only allocation we need. The shard guard is dropped
    // before we acquire the inner mutex, so the per-bot mutex never blocks
    // the shard.
    let entry = BOT_WRITE_LOCKS
        .entry(bot_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())));
    Arc::clone(entry.value())
}

/// Remove lock entries whose only `Arc` owner is the map (`strong_count == 1`).
/// Idempotent — running it back-to-back is a no-op for the second call.
pub fn cleanup_unused_locks() -> usize {
    let mut removed = 0usize;
    // We can't call `retain` while holding any iterator into the map, but
    // `DashMap::retain` is exposed and atomic per-shard.
    BOT_WRITE_LOCKS.retain(|_, arc| {
        let keep = Arc::strong_count(arc) > 1;
        if !keep {
            removed += 1;
        }
        keep
    });
    removed
}

/// Spawn a background task that calls [`cleanup_unused_locks`] every
/// [`LOCK_CLEANUP_INTERVAL`]. Idempotent at the application level — repeat
/// calls spawn additional tasks; the binary should call this exactly once
/// at startup.
pub fn spawn_lock_cleanup() {
    tokio::spawn(async {
        let mut interval = tokio::time::interval(LOCK_CLEANUP_INTERVAL);
        // Skip the immediate fire so we don't waste a sweep on a freshly
        // started process with an empty map.
        interval.tick().await;
        loop {
            interval.tick().await;
            let removed = cleanup_unused_locks();
            if removed > 0 {
                tracing::debug!(removed, "learning_store: pruned idle per-bot locks");
            }
        }
    });
}

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
///
/// Writes are atomic: data is staged to a sibling tempfile and `rename`d
/// into place. Without this, a crash mid-write would leave a truncated
/// JSON blob that `load` silently treats as the empty default state — i.e.
/// a single bad write would erase the bandit's history. See audit #2.
///
/// The per-bot mutex (see [`lock_for_bot`]) guards the read-modify-write
/// window for one bot at a time; concurrent saves for different bots
/// proceed in parallel.
pub fn save(bot_id: &str, state: &BotLearningState) -> Result<(), String> {
    let lock = lock_for_bot(bot_id);
    let _guard = lock
        .lock()
        .map_err(|_| format!("learning store mutex poisoned for bot_id={bot_id}"))?;

    std::fs::create_dir_all(learning_dir()).map_err(|e| format!("create learning dir: {e}"))?;
    let json = serde_json::to_string_pretty(state)
        .map_err(|e| format!("serialize learning state: {e}"))?;
    let target = learning_path(bot_id);
    let tmp = target.with_extension(format!("tmp.{}", std::process::id()));
    std::fs::write(&tmp, json).map_err(|e| format!("write learning state: {e}"))?;
    if let Err(e) = std::fs::rename(&tmp, &target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("rename learning state: {e}"));
    }
    Ok(())
}

/// Read-modify-write helper. The closure receives the current state and may
/// mutate it; the result is persisted on success.
///
/// Holds the per-bot mutex across both the load and the save so two
/// concurrent updates for the same bot serialize correctly (no lost
/// updates). Updates for *different* bots run in parallel.
pub fn update<F>(bot_id: &str, mutate: F) -> Result<BotLearningState, String>
where
    F: FnOnce(&mut BotLearningState),
{
    let lock = lock_for_bot(bot_id);
    let _guard = lock
        .lock()
        .map_err(|_| format!("learning store mutex poisoned for bot_id={bot_id}"))?;

    let mut state = load(bot_id);
    mutate(&mut state);

    // Inline save body so we don't double-acquire the per-bot mutex.
    std::fs::create_dir_all(learning_dir()).map_err(|e| format!("create learning dir: {e}"))?;
    let json = serde_json::to_string_pretty(&state)
        .map_err(|e| format!("serialize learning state: {e}"))?;
    let target = learning_path(bot_id);
    let tmp = target.with_extension(format!("tmp.{}", std::process::id()));
    std::fs::write(&tmp, json).map_err(|e| format!("write learning state: {e}"))?;
    if let Err(e) = std::fs::rename(&tmp, &target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("rename learning state: {e}"));
    }
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
///
/// `iteration_id`, when supplied, deduplicates against the per-bot
/// `(variant_id, iteration_id)` journal: a retried record_strategy_outcome
/// call with the same tuple is absorbed silently. Without `iteration_id`
/// (i.e. legacy callers) the function records every call — preserving the
/// always-record semantics existing post-trade hooks rely on.
pub fn record_strategy_outcome(
    bot_id: &str,
    variant_id: &str,
    reward: f64,
    iteration_id: Option<&str>,
) {
    let mut bandit_mean: Option<f64> = None;
    let mut deduplicated = false;
    if let Err(error) = update(bot_id, |state| {
        if let Some(iter_id) = iteration_id {
            if state.has_recorded_iteration(variant_id, iter_id) {
                deduplicated = true;
                return;
            }
            state.note_iteration(variant_id, iter_id);
        }
        state.bandit.record_outcome(variant_id, reward);
        bandit_mean = state
            .bandit
            .arms
            .iter()
            .find(|arm| arm.variant_id == variant_id)
            .map(|arm| arm.mean_reward());
    }) {
        tracing::warn!(bot_id, %error, "failed to persist strategy outcome");
        return;
    }
    if !deduplicated {
        crate::routes::prometheus::record_bandit_pull(
            bot_id,
            variant_id,
            bandit_mean.unwrap_or(reward),
        );
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
    let recommendation = load(bot_id)
        .slippage
        .recommend_max_bps(token_in, token_out, fallback);
    crate::routes::prometheus::record_slippage_recommendation(
        bot_id,
        &format!("{token_in:#x}"),
        &format!("{token_out:#x}"),
        recommendation,
    );
    recommendation
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

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

    /// 100 concurrent tasks split across 2 bots. Each task acquires the
    /// per-bot lock, sleeps 20ms (simulating fsync latency), releases.
    /// Under the OLD global lock all 100 tasks serialise → ≥ 100 × 20ms = 2s.
    /// Under the NEW sharded lock each bot's 50 tasks serialise but the two
    /// bots run in parallel → ≈ 50 × 20ms = 1s. We assert <= 1.6s wall to
    /// give a generous margin for thread scheduling on noisy CI.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn sharded_mutex_allows_concurrent_different_bots() {
        let counter = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::with_capacity(100);
        let start = std::time::Instant::now();

        for i in 0..100usize {
            let bot_id = if i % 2 == 0 { "bot-A" } else { "bot-B" };
            let counter = counter.clone();
            handles.push(tokio::task::spawn_blocking(move || {
                let lock = lock_for_bot(bot_id);
                let _guard = lock.lock().expect("acquire per-bot lock");
                std::thread::sleep(Duration::from_millis(20));
                counter.fetch_add(1, Ordering::Relaxed);
            }));
        }
        for h in handles {
            h.await.unwrap();
        }

        let elapsed = start.elapsed();
        assert_eq!(counter.load(Ordering::Relaxed), 100);
        // 50 tasks × 20ms = 1s ideal; allow 1.6s for scheduling jitter.
        assert!(
            elapsed < Duration::from_millis(1_600),
            "two-bot sharded test took {elapsed:?}; expected < 1.6s (would be ≥ 2s under a global lock)"
        );

        // After all tasks complete, each per-bot Arc is owned only by the
        // map — `cleanup_unused_locks` should reclaim both.
        let removed = cleanup_unused_locks();
        assert!(
            removed >= 2,
            "expected ≥2 idle locks to be pruned, got {removed}"
        );
    }
}
