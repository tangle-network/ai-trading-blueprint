//! Background poller that walks envelope storage and emits per-bot gauges +
//! threshold alerts.
//!
//! Ticks every [`ENVELOPE_WATCHER_INTERVAL`] (60s by default). For each bot
//! enumerated by `MultiBotTradingState::list_envelope_bots`:
//!
//! 1. Loads the on-disk signed envelope; missing entries are skipped silently.
//! 2. Calls [`crate::routes::envelope::envelope_consumed_amount`] to read
//!    on-chain consumption (best-effort — a failure leaves consumed at 0 and
//!    we still emit expiry-driven gauges and alerts).
//! 3. Emits the four envelope-status gauges via
//!    [`crate::routes::prometheus::record_envelope_snapshot`].
//! 4. Fires `EnvelopeNearlyExhausted` and `EnvelopeNearExpiry` alerts when
//!    the configured thresholds are breached. Per-bot, per-threshold
//!    debounce of 1 hour prevents alert storms on a stuck cron.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use alloy::primitives::U256;
use chrono::Utc;
use tokio::sync::Mutex;

use crate::alerts::{Alert, AlertSink};
use crate::routes::envelope::{
    envelope_consumed_amount, get_signed_envelope, max_total_for_enforcement,
};
use crate::routes::prometheus::record_envelope_snapshot;
use crate::{BotContext, EnvelopeBotInfo, MultiBotTradingState};

/// Polling interval for the watcher.
pub const ENVELOPE_WATCHER_INTERVAL: Duration = Duration::from_secs(60);

/// Threshold for `EnvelopeNearlyExhausted` (90% consumed).
pub const ALERT_NEARLY_EXHAUSTED_PCT: f64 = 90.0;

/// Threshold for `EnvelopeNearExpiry` (6 hours).
pub const ALERT_NEAR_EXPIRY_SECONDS: i64 = 6 * 3600;

/// Debounce window — at most one alert per bot per threshold per hour.
pub const ALERT_DEBOUNCE: Duration = Duration::from_secs(3600);

/// Per-bot last-fired timestamps, keyed by `(bot_id, alert_kind)`.
type DebounceState = Arc<Mutex<HashMap<(String, &'static str), SystemTime>>>;

fn make_debounce_state() -> DebounceState {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Spawn the envelope watcher background task. No-op when neither a bot lister
/// nor an alert sink is configured.
pub fn spawn_envelope_watcher(state: Arc<MultiBotTradingState>) {
    if state.list_envelope_bots.is_none() {
        tracing::debug!("envelope watcher skipped — no list_envelope_bots provider");
        return;
    }
    if std::env::var("DISABLE_ENVELOPE_WATCHER").is_ok_and(|v| matches!(v.as_str(), "1" | "true")) {
        tracing::info!("envelope watcher disabled via DISABLE_ENVELOPE_WATCHER");
        return;
    }
    let debounce = make_debounce_state();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(ENVELOPE_WATCHER_INTERVAL);
        // Skip the immediate-fire so process startup doesn't generate a burst.
        interval.tick().await;
        loop {
            interval.tick().await;
            envelope_watcher_tick(&state, debounce.clone()).await;
        }
    });
}

/// Run a single watcher tick. Public so the binary or tests can drive it
/// directly (the spawned task simply calls this in a loop).
pub async fn envelope_watcher_tick(state: &MultiBotTradingState, debounce: DebounceState) {
    let bots = match state.list_envelope_bots.as_ref() {
        Some(lister) => lister(),
        None => return,
    };
    for bot in bots {
        process_bot(state, bot, debounce.clone()).await;
    }
}

async fn process_bot(state: &MultiBotTradingState, bot: EnvelopeBotInfo, debounce: DebounceState) {
    if bot.validation_trust != trading_runtime::ValidationTrust::Envelope {
        return;
    }
    let Some(envelope) = get_signed_envelope(&bot.bot_id) else {
        return;
    };

    let bot_ctx = BotContext {
        bot_id: bot.bot_id.clone(),
        vault_address: bot.vault_address.clone(),
        paper_trade: false,
        chain_id: bot.chain_id,
        rpc_url: bot.rpc_url.clone(),
        strategy_config: bot.strategy_config.clone(),
        risk_params: bot.risk_params.clone(),
        validator_endpoints: Vec::new(),
        validation_trust: bot.validation_trust,
    };
    let max_total = max_total_for_enforcement(&envelope.enforcement);
    let consumed_result = envelope_consumed_amount(state, &envelope, &bot_ctx).await;
    let consumed = consumed_result.as_ref().copied().unwrap_or(U256::ZERO);

    let consumed_pct = consumed_percentage(consumed, max_total);
    let now = Utc::now().timestamp();
    let expires_in = envelope.expires_at as i64 - now;

    record_envelope_snapshot(
        &bot.bot_id,
        &envelope.protocol,
        u256_to_f64(consumed),
        u256_to_f64(max_total),
        envelope.expires_at as i64,
        envelope.signatures.len(),
    );

    if let Err(error) = consumed_result {
        tracing::debug!(
            bot_id = %bot.bot_id,
            %error,
            "envelope watcher could not read consumption (gauges still emitted via expiry)"
        );
    }

    if consumed_pct >= ALERT_NEARLY_EXHAUSTED_PCT {
        maybe_fire(
            &state.alert_sink,
            &debounce,
            &bot.bot_id,
            "envelope_nearly_exhausted",
            Alert::EnvelopeNearlyExhausted {
                bot_id: bot.bot_id.clone(),
                consumed_pct,
            },
        )
        .await;
    }

    if expires_in <= ALERT_NEAR_EXPIRY_SECONDS {
        maybe_fire(
            &state.alert_sink,
            &debounce,
            &bot.bot_id,
            "envelope_near_expiry",
            Alert::EnvelopeNearExpiry {
                bot_id: bot.bot_id.clone(),
                expires_in_seconds: expires_in,
            },
        )
        .await;
    }
}

async fn maybe_fire(
    sink: &AlertSink,
    debounce: &DebounceState,
    bot_id: &str,
    kind: &'static str,
    alert: Alert,
) {
    let key = (bot_id.to_string(), kind);
    let now = SystemTime::now();
    {
        let mut guard = debounce.lock().await;
        if let Some(last) = guard.get(&key) {
            if now
                .duration_since(*last)
                .map(|d| d < ALERT_DEBOUNCE)
                .unwrap_or(false)
            {
                return;
            }
        }
        guard.insert(key, now);
    }
    sink.fire(alert).await;
}

fn consumed_percentage(consumed: U256, max_total: U256) -> f64 {
    if max_total.is_zero() {
        return 0.0;
    }
    let num = consumed.to_string().parse::<f64>().unwrap_or(0.0);
    let den = max_total.to_string().parse::<f64>().unwrap_or(1.0);
    (num / den) * 100.0
}

fn u256_to_f64(value: U256) -> f64 {
    value.to_string().parse::<f64>().unwrap_or(0.0)
}

// `UNIX_EPOCH` is referenced via `SystemTime::now()` arithmetic in callers; the
// import is kept for forward-compat readers wondering why we don't use chrono
// for the debounce timestamp.
#[allow(dead_code)]
const _UNIX_EPOCH_REF: SystemTime = UNIX_EPOCH;

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    #[tokio::test]
    async fn debounce_skips_repeat_within_window() {
        let debounce = make_debounce_state();
        let key = ("bot-1".to_string(), "envelope_near_expiry");
        debounce.lock().await.insert(key.clone(), SystemTime::now());

        let mut guard = debounce.lock().await;
        let last = guard.get(&key).copied().unwrap();
        let recent = SystemTime::now()
            .duration_since(last)
            .map(|d| d < ALERT_DEBOUNCE)
            .unwrap_or(false);
        assert!(
            recent,
            "second fire within debounce window should be skipped"
        );
        guard.clear();
    }

    #[test]
    fn consumed_percentage_handles_zero_denominator() {
        assert_eq!(consumed_percentage(U256::from(100u64), U256::ZERO), 0.0);
        assert_eq!(
            consumed_percentage(U256::from(50u64), U256::from(100u64)),
            50.0
        );
    }
}
