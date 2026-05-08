//! Audit FIX-5: per-session rate limiter for `/api/dex/assets/preflight`.
//!
//! The preflight endpoint dispatches up to three sequential RPC calls per
//! fee tier (`asset_preflight::preflight_dex_asset`). An authenticated
//! session can drive this in a tight loop without throttling, turning the
//! endpoint into a relay against any allowlisted RPC. Cap each session at
//! 30 requests per minute (configurable via env). RPC URL allowlisting in
//! `select_preflight_rpc_url` already prevents arbitrary upstream choice;
//! this caps volume.
//!
//! The bin already pulls `governor` + `dashmap` via the dep graph (used by
//! `trading-http-api::rate_limit::PerBotRateLimiter`); we reuse the same
//! primitives for a session-keyed bucket. Per-session limiter is tiny
//! (one record per active caller, evicted with the DashMap entry when no
//! token paths drop the limiter — acceptable in practice).

use std::num::NonZeroU32;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use dashmap::DashMap;
use governor::clock::{Clock, DefaultClock};
use governor::state::{InMemoryState, NotKeyed};
use governor::{Quota, RateLimiter};

type DirectLimiter = RateLimiter<NotKeyed, InMemoryState, DefaultClock>;

/// Per-session governor bucket. Lookup keyed on the session caller address
/// (already validated by `SessionAuth` before the handler runs).
pub struct PreflightLimiter {
    quotas: DashMap<String, Arc<DirectLimiter>>,
    per_minute: u32,
}

impl PreflightLimiter {
    fn new() -> Self {
        // Env-tunable; default 30 / minute. Tight enough that a single session
        // can't drive RPC fanout, loose enough that legitimate UI flows
        // (load asset list → preflight a handful of candidates) never trip it.
        let per_minute = std::env::var("PREFLIGHT_RATE_LIMIT_PER_MINUTE")
            .ok()
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(30);
        Self {
            quotas: DashMap::new(),
            per_minute,
        }
    }

    /// Returns `Ok(())` when the session has budget; `Err(retry_after)`
    /// otherwise.
    pub fn check(&self, caller: &str) -> Result<(), Duration> {
        let limiter = self
            .quotas
            .entry(caller.to_string())
            .or_insert_with(|| {
                let nz = NonZeroU32::new(self.per_minute.max(1))
                    .expect("max(1) keeps the value non-zero");
                Arc::new(RateLimiter::direct(Quota::per_minute(nz)))
            })
            .clone();

        match limiter.check() {
            Ok(_) => Ok(()),
            Err(not_until) => {
                let retry_after = not_until.wait_time_from(DefaultClock::default().now());
                Err(retry_after)
            }
        }
    }
}

/// Process-scoped singleton. The limiter holds state across requests so a
/// caller can't reset their bucket by reconnecting.
pub fn preflight_limiter() -> &'static PreflightLimiter {
    static LIMITER: OnceLock<PreflightLimiter> = OnceLock::new();
    LIMITER.get_or_init(PreflightLimiter::new)
}
