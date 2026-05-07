//! Prometheus exposition endpoint + global metric registry.
//!
//! Maintains a single process-wide [`prometheus::Registry`] and exposes the
//! gauges / counters / histograms used by the rest of the HTTP API. Helper
//! functions (`record_*`) are called from the relevant code paths
//! (envelope renewal cron, execute routes, learning store, envelope poll)
//! so this module is the only place that talks to the Prometheus crate.
//!
//! `GET /metrics/prometheus` is mounted **outside** the auth middleware on
//! `build_multi_bot_router` because the existing `/metrics` route already
//! returns the JSON `BotMetrics` payload consumed by the dApp UI. Prometheus
//! scrape configs can target any path via `metrics_path:` so this is purely
//! a routing artefact, not a behavioural one.

use std::sync::Arc;
use std::time::Instant;

use axum::Router;
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::get;
use once_cell::sync::Lazy;
use prometheus::{
    CounterVec, Encoder, GaugeVec, HistogramOpts, HistogramVec, Opts, Registry, TextEncoder,
};

use crate::MultiBotTradingState;

/// Linear-ish bucket boundaries (seconds) for trade-execution latency.
/// Reflects the realistic spread for vault-routed EVM trades — sub-second
/// happy path, single-digit-second p95 / p99 under load, 30s ceiling for
/// stalled mempool / RPC outages.
const EXECUTION_LATENCY_BUCKETS_SECONDS: &[f64] = &[0.1, 0.5, 1.0, 2.0, 5.0, 10.0, 30.0];

/// Global registry. Constructed once and reused for the lifetime of the process.
pub static REGISTRY: Lazy<Registry> = Lazy::new(Registry::new);

// ── Metric handles ──────────────────────────────────────────────────────────

pub static ENVELOPE_CONSUMED_AMOUNT: Lazy<GaugeVec> = Lazy::new(|| {
    let g = GaugeVec::new(
        Opts::new(
            "trading_envelope_consumed_amount",
            "Current envelope consumed amount (raw token base units, cast to f64).",
        ),
        &["bot_id", "protocol"],
    )
    .expect("envelope consumed_amount gauge");
    REGISTRY
        .register(Box::new(g.clone()))
        .expect("register envelope_consumed_amount");
    g
});

pub static ENVELOPE_MAX_TOTAL: Lazy<GaugeVec> = Lazy::new(|| {
    let g = GaugeVec::new(
        Opts::new(
            "trading_envelope_max_total",
            "Envelope max_total_amount (raw token base units, cast to f64).",
        ),
        &["bot_id", "protocol"],
    )
    .expect("envelope max_total gauge");
    REGISTRY
        .register(Box::new(g.clone()))
        .expect("register envelope_max_total");
    g
});

pub static ENVELOPE_EXPIRES_AT_SECONDS: Lazy<GaugeVec> = Lazy::new(|| {
    let g = GaugeVec::new(
        Opts::new(
            "trading_envelope_expires_at_seconds",
            "Envelope expires_at as a unix timestamp (seconds).",
        ),
        &["bot_id", "protocol"],
    )
    .expect("envelope expires_at gauge");
    REGISTRY
        .register(Box::new(g.clone()))
        .expect("register envelope_expires_at_seconds");
    g
});

pub static ENVELOPE_SIGNATURE_COUNT: Lazy<GaugeVec> = Lazy::new(|| {
    let g = GaugeVec::new(
        Opts::new(
            "trading_envelope_signature_count",
            "Number of signatures attached to the active envelope.",
        ),
        &["bot_id", "protocol"],
    )
    .expect("envelope signature_count gauge");
    REGISTRY
        .register(Box::new(g.clone()))
        .expect("register envelope_signature_count");
    g
});

pub static ENVELOPE_RENEWAL_ACTIONS_TOTAL: Lazy<CounterVec> = Lazy::new(|| {
    let c = CounterVec::new(
        Opts::new(
            "trading_envelope_renewal_actions_total",
            "Count of envelope renewal cron actions, partitioned by RenewalAction variant.",
        ),
        &["bot_id", "action"],
    )
    .expect("envelope renewal_actions counter");
    REGISTRY
        .register(Box::new(c.clone()))
        .expect("register envelope_renewal_actions_total");
    c
});

pub static LEARNING_SLIPPAGE_BPS: Lazy<GaugeVec> = Lazy::new(|| {
    let g = GaugeVec::new(
        Opts::new(
            "trading_learning_slippage_bps",
            "Most-recent slippage learner recommendation (basis points).",
        ),
        &["bot_id", "token_in", "token_out"],
    )
    .expect("learning slippage_bps gauge");
    REGISTRY
        .register(Box::new(g.clone()))
        .expect("register learning_slippage_bps");
    g
});

pub static LEARNING_BANDIT_ARM_PULLS_TOTAL: Lazy<CounterVec> = Lazy::new(|| {
    let c = CounterVec::new(
        Opts::new(
            "trading_learning_bandit_arm_pulls_total",
            "Cumulative pulls per bandit arm (strategy variant).",
        ),
        &["bot_id", "variant_id"],
    )
    .expect("learning bandit pulls counter");
    REGISTRY
        .register(Box::new(c.clone()))
        .expect("register learning_bandit_arm_pulls_total");
    c
});

pub static LEARNING_BANDIT_ARM_MEAN_REWARD: Lazy<GaugeVec> = Lazy::new(|| {
    let g = GaugeVec::new(
        Opts::new(
            "trading_learning_bandit_arm_mean_reward",
            "Mean reward of each bandit arm.",
        ),
        &["bot_id", "variant_id"],
    )
    .expect("learning bandit mean_reward gauge");
    REGISTRY
        .register(Box::new(g.clone()))
        .expect("register learning_bandit_arm_mean_reward");
    g
});

pub static EXECUTIONS_TOTAL: Lazy<CounterVec> = Lazy::new(|| {
    let c = CounterVec::new(
        Opts::new(
            "trading_executions_total",
            "Trade execution outcomes by (bot, protocol, action, status).",
        ),
        &["bot_id", "protocol", "action", "status"],
    )
    .expect("executions_total counter");
    REGISTRY
        .register(Box::new(c.clone()))
        .expect("register executions_total");
    c
});

pub static EXECUTION_LATENCY_SECONDS: Lazy<HistogramVec> = Lazy::new(|| {
    let h = HistogramVec::new(
        HistogramOpts::new(
            "trading_execution_latency_seconds",
            "End-to-end trade execution latency, including chain submit + confirmation.",
        )
        .buckets(EXECUTION_LATENCY_BUCKETS_SECONDS.to_vec()),
        &["bot_id", "protocol", "action"],
    )
    .expect("execution_latency histogram");
    REGISTRY
        .register(Box::new(h.clone()))
        .expect("register execution_latency_seconds");
    h
});

// ── Recording helpers (callable from request paths) ─────────────────────────

/// Status label used by [`record_execution`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExecutionStatus {
    Success,
    Reverted,
    Rejected,
}

impl ExecutionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ExecutionStatus::Success => "success",
            ExecutionStatus::Reverted => "reverted",
            ExecutionStatus::Rejected => "rejected",
        }
    }
}

/// Record a single trade execution outcome + its end-to-end latency.
pub fn record_execution(
    bot_id: &str,
    protocol: &str,
    action: &str,
    status: ExecutionStatus,
    started_at: Instant,
) {
    EXECUTIONS_TOTAL
        .with_label_values(&[bot_id, protocol, action, status.as_str()])
        .inc();
    EXECUTION_LATENCY_SECONDS
        .with_label_values(&[bot_id, protocol, action])
        .observe(started_at.elapsed().as_secs_f64());
}

/// Record a renewal-cron action for `bot_id` with the canonical variant name.
pub fn record_renewal_action(bot_id: &str, action: &str) {
    ENVELOPE_RENEWAL_ACTIONS_TOTAL
        .with_label_values(&[bot_id, action])
        .inc();
}

/// Snapshot a single bot's envelope state into the gauges. Each call sets the
/// labelled gauge to the new value (no aggregation across protocols — the
/// active envelope is single-protocol so multiple labels for the same bot only
/// appear after a protocol switch and are intentionally left as stale samples).
pub fn record_envelope_snapshot(
    bot_id: &str,
    protocol: &str,
    consumed_amount_f64: f64,
    max_total_amount_f64: f64,
    expires_at_secs: i64,
    signature_count: usize,
) {
    ENVELOPE_CONSUMED_AMOUNT
        .with_label_values(&[bot_id, protocol])
        .set(consumed_amount_f64);
    ENVELOPE_MAX_TOTAL
        .with_label_values(&[bot_id, protocol])
        .set(max_total_amount_f64);
    ENVELOPE_EXPIRES_AT_SECONDS
        .with_label_values(&[bot_id, protocol])
        .set(expires_at_secs as f64);
    ENVELOPE_SIGNATURE_COUNT
        .with_label_values(&[bot_id, protocol])
        .set(signature_count as f64);
}

/// Update the current slippage recommendation gauge.
pub fn record_slippage_recommendation(bot_id: &str, token_in: &str, token_out: &str, bps: u32) {
    LEARNING_SLIPPAGE_BPS
        .with_label_values(&[bot_id, token_in, token_out])
        .set(bps as f64);
}

/// Record a bandit-arm pull and update its mean reward gauge.
pub fn record_bandit_pull(bot_id: &str, variant_id: &str, mean_reward: f64) {
    LEARNING_BANDIT_ARM_PULLS_TOTAL
        .with_label_values(&[bot_id, variant_id])
        .inc();
    LEARNING_BANDIT_ARM_MEAN_REWARD
        .with_label_values(&[bot_id, variant_id])
        .set(mean_reward);
}

// ── Router + handler ────────────────────────────────────────────────────────

pub fn multi_bot_router() -> Router<Arc<MultiBotTradingState>> {
    Router::new().route("/metrics/prometheus", get(prometheus_handler))
}

async fn prometheus_handler(State(_state): State<Arc<MultiBotTradingState>>) -> impl IntoResponse {
    let metric_families = REGISTRY.gather();
    let encoder = TextEncoder::new();
    let mut buffer = Vec::with_capacity(4096);
    if let Err(error) = encoder.encode(&metric_families, &mut buffer) {
        tracing::warn!(%error, "prometheus encoder failed");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            format!("prometheus encode failed: {error}"),
        )
            .into_response();
    }
    let body = String::from_utf8(buffer).unwrap_or_default();
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, encoder.format_type().to_string())],
        body,
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use prometheus::IntCounterVec;

    /// Registering a fresh counter on the global registry, incrementing it,
    /// gathering the registry and asserting the text-format output contains
    /// both the HELP/TYPE lines and the counter sample exercises the same
    /// path the live `/metrics/prometheus` handler uses.
    #[test]
    fn registry_emits_text_format() {
        // Use a name unique to this test so re-running on the global registry
        // does not double-register.
        let name = "trading_test_registry_emits_total";
        let counter = IntCounterVec::new(
            Opts::new(name, "test counter for prometheus exporter"),
            &["label"],
        )
        .expect("build counter");
        REGISTRY
            .register(Box::new(counter.clone()))
            .expect("register test counter");
        counter.with_label_values(&["alpha"]).inc();
        counter.with_label_values(&["alpha"]).inc();
        counter.with_label_values(&["beta"]).inc();

        let metric_families = REGISTRY.gather();
        let encoder = TextEncoder::new();
        let mut buffer = Vec::new();
        encoder
            .encode(&metric_families, &mut buffer)
            .expect("encode succeeds");
        let text = String::from_utf8(buffer).expect("utf8 prometheus output");

        // Format compliance: each metric family emits HELP + TYPE.
        assert!(
            text.contains(&format!("# HELP {name}")),
            "missing HELP line for {name}\n{text}"
        );
        assert!(
            text.contains(&format!("# TYPE {name} counter")),
            "missing TYPE line for {name}\n{text}"
        );
        // Sample present with both labels.
        assert!(text.contains(&format!("{name}{{label=\"alpha\"}} 2")));
        assert!(text.contains(&format!("{name}{{label=\"beta\"}} 1")));
    }

    #[test]
    fn record_execution_increments_counter_and_records_latency() {
        let started = Instant::now();
        record_execution(
            "bot-rec-exec",
            "uniswap_v3",
            "swap",
            ExecutionStatus::Success,
            started,
        );
        let metric_families = REGISTRY.gather();
        let encoder = TextEncoder::new();
        let mut buffer = Vec::new();
        encoder.encode(&metric_families, &mut buffer).unwrap();
        let text = String::from_utf8(buffer).unwrap();
        assert!(
            text.contains("trading_executions_total"),
            "executions_total not exported"
        );
        assert!(
            text.contains("trading_execution_latency_seconds"),
            "execution_latency_seconds not exported"
        );
    }

    #[test]
    fn record_renewal_action_increments_per_variant() {
        record_renewal_action("bot-rcron", "AutoRenewed");
        record_renewal_action("bot-rcron", "AutoRenewed");
        record_renewal_action("bot-rcron", "WebhookFired");
        let metric_families = REGISTRY.gather();
        let encoder = TextEncoder::new();
        let mut buffer = Vec::new();
        encoder.encode(&metric_families, &mut buffer).unwrap();
        let text = String::from_utf8(buffer).unwrap();
        assert!(text.contains("trading_envelope_renewal_actions_total"));
        assert!(text.contains("action=\"AutoRenewed\""));
        assert!(text.contains("action=\"WebhookFired\""));
    }
}
