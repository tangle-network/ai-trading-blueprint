//! Per-session rate limiter for `/api/dex/assets/preflight`.
//!
//! The endpoint dispatches up to three sequential RPC calls per fee tier
//! (`asset_preflight::preflight_dex_asset`). RPC URL allowlisting in
//! `select_preflight_rpc_url` prevents arbitrary upstream choice; this caps
//! volume so an authenticated session can't drive a tight relay loop.
//!
//! Default 30 req/min, env-tunable via `PREFLIGHT_RATE_LIMIT_PER_MINUTE`.
//! Keyed on the session caller address (validated by `SessionAuth` before
//! the handler runs). Process-scoped singleton so the bucket survives
//! reconnection.

use std::num::NonZeroU32;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use dashmap::DashMap;
use governor::clock::{Clock, DefaultClock};
use governor::state::{InMemoryState, NotKeyed};
use governor::{Quota, RateLimiter};

type DirectLimiter = RateLimiter<NotKeyed, InMemoryState, DefaultClock>;

/// Per-session governor bucket. Lookup keyed on the session caller address.
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

pub fn preflight_limiter() -> &'static PreflightLimiter {
    static LIMITER: OnceLock<PreflightLimiter> = OnceLock::new();
    LIMITER.get_or_init(PreflightLimiter::new)
}
