//! Per-bot rate limiting middleware.
//!
//! ## Why this exists
//!
//! The CEX + Solana audits flagged that `/learning/*`, `/envelope/*`,
//! `/cex/*`, and `/solana/*` had no per-bot throttling. A misbehaving
//! agent could:
//!
//! - Hammer `/learning/strategy-outcome` and exhaust file-storage IO.
//! - Hammer `/cex/binance/*` and get the operator's IP banned by
//!   Binance (their `RAW_REQUEST_WEIGHT` cap is process-global from
//!   the venue's perspective).
//! - Hammer `/solana/*` and DoS the shared RPC client.
//!
//! ## Design
//!
//! [`PerBotRateLimiter`] partitions traffic by `(bot_id, route_class)`
//! using a sharded `DashMap` of [`governor`] direct rate limiters. Each
//! quota is GCRA-based (smooth bursting allowed up to the per-minute
//! cap, then back-pressure). Defaults are conservative for the initial
//! rollout — operators can override via config.
//!
//! Per-route class (not per-route-path), so adding new endpoints in the
//! same family doesn't require new quota config.
//!
//! ## Auth ordering
//!
//! The middleware is registered AFTER `multi_bot_auth_middleware` so the
//! `BotContext` extension is already present. If for any reason the bot
//! id is missing (programmer error — middleware out of order), we
//! fail-open with a `tracing::warn` rather than 500ing the request — the
//! auth layer already gated the call.
//!
//! ## Disable for tests
//!
//! `TRADING_RATE_LIMIT_ENABLED=false` short-circuits the middleware and
//! lets every request pass. Useful for harness/integration tests that
//! need to hammer the API.

use std::num::NonZeroU32;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{Request, State},
    http::{HeaderValue, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use dashmap::DashMap;
use governor::{
    Quota, RateLimiter,
    clock::{Clock, DefaultClock},
    state::{InMemoryState, NotKeyed},
};

use crate::{BotContext, MultiBotTradingState};

/// Per-route-class quota in requests/minute.
///
/// Defaults rationale:
/// - `envelope`: envelopes are signed off-chain and PUT atomically.
///   60/min covers normal renewal cadence (every 30s) plus a healthy
///   margin for retries; anything beyond that is a misuse.
/// - `learning`: strategy-outcome writes are the noisiest path
///   (one per closed trade). 240/min = 4/sec headroom is enough for an
///   aggressive scalper without flooding the on-disk store.
/// - `cex`: 120/min = 2 req/sec. Binance's account weight is 6000/min
///   shared across all callers; we leave 50× margin for the operator's
///   own polling + multiple bots.
/// - `solana`: 120/min matches the CEX cap. A normal Jupiter swap is 1
///   quote + 1 swap = 2 reqs; 60 trades/min is well above plausible
///   strategy throughput.
#[derive(Debug, Clone)]
pub struct RateLimitConfig {
    pub envelope_per_minute: u32,
    pub learning_per_minute: u32,
    pub cex_per_minute: u32,
    pub solana_per_minute: u32,
}

impl Default for RateLimitConfig {
    fn default() -> Self {
        Self {
            envelope_per_minute: 60,
            learning_per_minute: 240,
            cex_per_minute: 120,
            solana_per_minute: 120,
        }
    }
}

/// Route classes the middleware throttles. Matched by URI prefix.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RouteClass {
    Envelope,
    Learning,
    Cex,
    Solana,
}

impl RouteClass {
    /// Resolve the route class for a request path. Returns `None` for
    /// paths that aren't subject to per-bot throttling (e.g. `/health`,
    /// `/portfolio`, etc. — those have no DoS-asymmetric backend).
    pub fn from_path(path: &str) -> Option<Self> {
        if path.starts_with("/envelope") {
            Some(Self::Envelope)
        } else if path.starts_with("/learning") {
            Some(Self::Learning)
        } else if path.starts_with("/cex") {
            Some(Self::Cex)
        } else if path.starts_with("/solana") {
            Some(Self::Solana)
        } else {
            None
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Envelope => "envelope",
            Self::Learning => "learning",
            Self::Cex => "cex",
            Self::Solana => "solana",
        }
    }
}

type DirectLimiter = RateLimiter<NotKeyed, InMemoryState, DefaultClock>;

/// Per-bot rate limiter — sharded by `(bot_id, RouteClass)`.
pub struct PerBotRateLimiter {
    quotas: DashMap<(String, RouteClass), Arc<DirectLimiter>>,
    config: RateLimitConfig,
}

impl PerBotRateLimiter {
    pub fn new(config: RateLimitConfig) -> Self {
        Self {
            quotas: DashMap::new(),
            config,
        }
    }

    fn limit_for(&self, class: RouteClass) -> u32 {
        match class {
            RouteClass::Envelope => self.config.envelope_per_minute,
            RouteClass::Learning => self.config.learning_per_minute,
            RouteClass::Cex => self.config.cex_per_minute,
            RouteClass::Solana => self.config.solana_per_minute,
        }
    }

    /// Build (or reuse) the limiter for `(bot_id, class)` and check whether
    /// a single request fits. Returns `Ok(())` on success, `Err(retry_after)`
    /// when the bucket is empty.
    pub fn check(&self, bot_id: &str, class: RouteClass) -> Result<(), Duration> {
        let key = (bot_id.to_string(), class);
        let limiter = self
            .quotas
            .entry(key)
            .or_insert_with(|| {
                let per_minute = self.limit_for(class);
                let nz =
                    NonZeroU32::new(per_minute.max(1)).expect("max(1) keeps the value non-zero");
                let quota = Quota::per_minute(nz);
                Arc::new(RateLimiter::direct(quota))
            })
            .clone();

        match limiter.check() {
            Ok(_) => Ok(()),
            Err(not_until) => {
                let clock = DefaultClock::default();
                let wait = not_until.wait_time_from(clock.now());
                Err(wait)
            }
        }
    }
}

impl Default for PerBotRateLimiter {
    fn default() -> Self {
        Self::new(RateLimitConfig::default())
    }
}

/// Env-driven kill switch. `TRADING_RATE_LIMIT_ENABLED=false` (case
/// insensitive) disables the middleware entirely. Anything else, or
/// unset, is treated as enabled.
pub fn rate_limit_enabled() -> bool {
    match std::env::var("TRADING_RATE_LIMIT_ENABLED") {
        Ok(raw) => !matches!(
            raw.trim().to_ascii_lowercase().as_str(),
            "false" | "0" | "no"
        ),
        Err(_) => true,
    }
}

/// Axum middleware. Looks up the request's `BotContext` extension
/// (inserted by `multi_bot_auth_middleware`) and the route class from the
/// URI path, then consults the per-bot quota. Returns 429 with a
/// `Retry-After: <seconds>` header on overage.
pub async fn per_bot_rate_limit(
    State(state): State<Arc<MultiBotTradingState>>,
    request: Request,
    next: Next,
) -> Response {
    if !rate_limit_enabled() {
        return next.run(request).await;
    }

    let path = request.uri().path();
    let Some(class) = RouteClass::from_path(path) else {
        return next.run(request).await;
    };

    let bot_id = request
        .extensions()
        .get::<BotContext>()
        .map(|ctx| ctx.bot_id.clone());

    let Some(bot_id) = bot_id else {
        tracing::warn!(
            path = %path,
            "rate-limit middleware ran without a BotContext (auth ordering bug?)"
        );
        return next.run(request).await;
    };

    match state.rate_limiter.check(&bot_id, class) {
        Ok(()) => next.run(request).await,
        Err(retry_after) => {
            let seconds = retry_after.as_secs().max(1);
            tracing::warn!(
                bot_id = %bot_id,
                class = class.label(),
                retry_after_secs = seconds,
                "per-bot rate limit exceeded"
            );
            let mut resp = (
                StatusCode::TOO_MANY_REQUESTS,
                format!(
                    "rate limit exceeded for bot {bot_id} on {} routes; retry after {seconds}s",
                    class.label()
                ),
            )
                .into_response();
            if let Ok(value) = HeaderValue::from_str(&seconds.to_string()) {
                resp.headers_mut().insert(header::RETRY_AFTER, value);
            }
            resp
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Tests that mutate the process-global TRADING_RATE_LIMIT_ENABLED env var
    // must not run concurrently with each other — cargo runs tests in parallel
    // threads, so one test's set_var/remove_var races another's read. Serialize
    // them on this lock.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn route_class_dispatch() {
        assert_eq!(
            RouteClass::from_path("/envelope/anything"),
            Some(RouteClass::Envelope)
        );
        assert_eq!(
            RouteClass::from_path("/learning/strategy-outcome"),
            Some(RouteClass::Learning)
        );
        assert_eq!(
            RouteClass::from_path("/cex/binance/order"),
            Some(RouteClass::Cex)
        );
        assert_eq!(
            RouteClass::from_path("/solana/jupiter/swap"),
            Some(RouteClass::Solana)
        );
        assert_eq!(RouteClass::from_path("/health"), None);
        assert_eq!(RouteClass::from_path("/portfolio/snapshot"), None);
    }

    #[test]
    fn defaults_match_documented_values() {
        let c = RateLimitConfig::default();
        assert_eq!(c.envelope_per_minute, 60);
        assert_eq!(c.learning_per_minute, 240);
        assert_eq!(c.cex_per_minute, 120);
        assert_eq!(c.solana_per_minute, 120);
    }

    #[test]
    fn rate_limit_enabled_default_true() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        unsafe { std::env::remove_var("TRADING_RATE_LIMIT_ENABLED") };
        assert!(rate_limit_enabled());
    }

    #[test]
    fn rate_limit_enabled_respects_false_variants() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        for v in &["false", "FALSE", "False", "0", "no"] {
            unsafe { std::env::set_var("TRADING_RATE_LIMIT_ENABLED", v) };
            assert!(!rate_limit_enabled(), "value {v} should disable limiter");
        }
        unsafe { std::env::remove_var("TRADING_RATE_LIMIT_ENABLED") };
    }

    #[test]
    fn exceeds_returns_429() {
        let lim = PerBotRateLimiter::new(RateLimitConfig {
            envelope_per_minute: 60,
            learning_per_minute: 240,
            cex_per_minute: 120,
            solana_per_minute: 120,
        });
        let bot = "tenant-a";

        for i in 0..240 {
            lim.check(bot, RouteClass::Learning).unwrap_or_else(|wait| {
                panic!("request {i} should pass under 240/min cap; instead asked to wait {wait:?}")
            });
        }
        let err = lim
            .check(bot, RouteClass::Learning)
            .expect_err("241st request must be throttled");
        assert!(err > Duration::ZERO, "retry_after must be > 0");
    }

    #[test]
    fn different_bots_get_separate_quotas() {
        let lim = PerBotRateLimiter::new(RateLimitConfig {
            envelope_per_minute: 60,
            learning_per_minute: 5,
            cex_per_minute: 120,
            solana_per_minute: 120,
        });

        for _ in 0..5 {
            lim.check("bot-a", RouteClass::Learning).unwrap();
        }
        assert!(lim.check("bot-a", RouteClass::Learning).is_err());

        for _ in 0..5 {
            lim.check("bot-b", RouteClass::Learning)
                .expect("bot-b must have its own quota");
        }
    }

    #[test]
    fn different_classes_are_independent_for_same_bot() {
        let lim = PerBotRateLimiter::new(RateLimitConfig {
            envelope_per_minute: 60,
            learning_per_minute: 240,
            cex_per_minute: 3,
            solana_per_minute: 120,
        });
        let bot = "tenant-x";

        for _ in 0..3 {
            lim.check(bot, RouteClass::Cex).unwrap();
        }
        assert!(lim.check(bot, RouteClass::Cex).is_err());

        lim.check(bot, RouteClass::Solana).unwrap();
    }

    #[test]
    fn disabled_env_var_skips_throttle() {
        unsafe { std::env::set_var("TRADING_RATE_LIMIT_ENABLED", "false") };
        assert!(!rate_limit_enabled());
        unsafe { std::env::set_var("TRADING_RATE_LIMIT_ENABLED", "true") };
        assert!(rate_limit_enabled());
        unsafe { std::env::remove_var("TRADING_RATE_LIMIT_ENABLED") };
    }

    #[test]
    fn zero_per_minute_clamps_to_one() {
        let lim = PerBotRateLimiter::new(RateLimitConfig {
            envelope_per_minute: 0,
            learning_per_minute: 0,
            cex_per_minute: 0,
            solana_per_minute: 0,
        });
        lim.check("bot", RouteClass::Envelope).unwrap();
        assert!(lim.check("bot", RouteClass::Envelope).is_err());
    }
}
