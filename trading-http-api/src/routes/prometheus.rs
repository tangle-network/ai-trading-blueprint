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
//!
//! ## Bounded label cardinality
//!
//! `bot_id` is operator-supplied and unbounded — at fleet scale (10K bots ×
//! 5 protocols × 4 chains = 200K time series) the Prometheus text encoder
//! would burn memory just serialising the response, and a single
//! attacker-controlled `bot_id = "a".repeat(10000)` could OOM the scraper.
//! Two defences (see [`MAX_PROMETHEUS_BOT_LABELS`] and [`safe_bot_label`]):
//!
//! 1. **Per-family cap** — each metric family tracks the
//!    `(bot_id, secondary_label)` combinations it has emitted. After
//!    `MAX_PROMETHEUS_BOT_LABELS` (= 1024) unique pairs, additional bots
//!    fold into a synthetic `bot_id="overflow"` row so the family stays
//!    bounded but operators still see *some* signal. A `tracing::warn!` is
//!    emitted once per family on first overflow.
//! 2. **Bot-id hashing** — bot ids longer than 32 ASCII chars are replaced
//!    with `sha-<16hex>` before being used as a label, capping the
//!    serialised label width regardless of input size.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use alloy::primitives::keccak256;
use axum::Router;
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::get;
use dashmap::DashMap;
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

// ── Cardinality cap (per-family) ──────────────────────────────────────────

/// Per-metric-family cap on the number of distinct `(bot_id, secondary)`
/// label combinations that emit a unique row. After the cap is hit,
/// additional combinations fold into a synthetic `bot_id="overflow"` row.
///
/// 1024 is sized generously above realistic 100-bot fleets while keeping
/// the worst-case scrape payload bounded (≤ a few hundred KB per family).
pub const MAX_PROMETHEUS_BOT_LABELS: usize = 1024;

/// Synthetic bot id used when a metric family is at its cardinality cap.
/// Operators see *some* signal for over-cap bots without unbounded series
/// growth.
pub const OVERFLOW_BOT_LABEL: &str = "overflow";

/// Threshold above which a `bot_id` is hashed before being emitted as a
/// label. Long bot ids (e.g. an attacker submitting `"a".repeat(10_000)`)
/// would otherwise blow the Prometheus serializer's memory; replacing them
/// with a 16-hex-char keccak prefix bounds label width.
pub const MAX_BOT_LABEL_LEN: usize = 32;

/// Per-family cardinality tracker. Each metric family the helpers below
/// touch has its own entry — a `DashMap<(bot_id, secondary), ()>` recording
/// which combinations have been emitted. Keyed by the metric family name
/// so we can lazily allocate per family the first time it is touched.
type FamilyCardinality = Arc<DashMap<(String, String), ()>>;

static FAMILY_TRACKERS: Lazy<DashMap<&'static str, FamilyCardinality>> = Lazy::new(DashMap::new);

/// Per-family one-shot warning flag — we only want one `tracing::warn!` per
/// family on first overflow, not one per record call. `Arc<AtomicBool>` so
/// callers can drop the DashMap shard guard before the swap.
static FAMILY_OVERFLOW_WARNED: Lazy<DashMap<&'static str, Arc<AtomicBool>>> =
    Lazy::new(DashMap::new);

fn family_tracker(family: &'static str) -> FamilyCardinality {
    FAMILY_TRACKERS
        .entry(family)
        .or_insert_with(|| Arc::new(DashMap::new()))
        .clone()
}

/// Hash long bot ids to a fixed-width sentinel; pass shorter ids through
/// unchanged. Hashing uses `keccak256` (already a project dependency via
/// alloy) and emits the leading 16 hex chars — collision-resistant enough
/// for label deduplication and short enough to keep scrape payloads small.
pub fn safe_bot_label(bot_id: &str) -> String {
    if bot_id.len() <= MAX_BOT_LABEL_LEN {
        return bot_id.to_string();
    }
    let digest = keccak256(bot_id.as_bytes());
    let hex = alloy::hex::encode(digest);
    format!("sha-{}", &hex[..16])
}

/// Resolve the `(bot_id, secondary)` label pair to use for a record call,
/// honouring the per-family cap and the long-bot-id hash. Returns the
/// possibly-rewritten `(bot_id_label, secondary_label)`. Inserts the new
/// pair into the family tracker on first touch.
fn resolve_labels(family: &'static str, bot_id: &str, secondary: &str) -> (String, String) {
    let safe_bot = safe_bot_label(bot_id);
    let tracker = family_tracker(family);
    let key = (safe_bot.clone(), secondary.to_string());

    // Fast path: pair already recorded — just emit at the existing label.
    if tracker.contains_key(&key) {
        return key;
    }

    // Slow path: see if we have headroom. The check-then-insert is racy
    // but `MAX_PROMETHEUS_BOT_LABELS` is a soft cap (we accept up to a
    // couple of extra rows under contention rather than block on a
    // process-wide mutex).
    if tracker.len() < MAX_PROMETHEUS_BOT_LABELS {
        tracker.insert(key.clone(), ());
        return key;
    }

    // At cap → fold into the synthetic overflow row, and warn once per
    // family so operators can tell the cap is in effect. We *do* track the
    // (overflow, secondary) pair in the same map (so the family ends up at
    // exactly `cap + 1` entries — the cap unique rows plus a single
    // overflow row regardless of how many bots collide on it).
    let warned: Arc<AtomicBool> = FAMILY_OVERFLOW_WARNED
        .entry(family)
        .or_insert_with(|| Arc::new(AtomicBool::new(false)))
        .value()
        .clone();
    if !warned.swap(true, Ordering::Relaxed) {
        tracing::warn!(
            family,
            cap = MAX_PROMETHEUS_BOT_LABELS,
            "prometheus label cardinality cap hit — over-cap bots fold into bot_id=\"overflow\""
        );
    }
    let overflow_key = (OVERFLOW_BOT_LABEL.to_string(), secondary.to_string());
    tracker.entry(overflow_key.clone()).or_insert(());
    overflow_key
}

#[cfg(test)]
fn family_label_count(family: &'static str) -> usize {
    family_tracker(family).len()
}

#[cfg(test)]
fn reset_cardinality_for_tests(family: &'static str) {
    FAMILY_TRACKERS.remove(family);
    FAMILY_OVERFLOW_WARNED.remove(family);
}

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
///
/// Folds high-cardinality `(bot_id, protocol)` pairs above the family cap
/// into `bot_id="overflow"`. The `action` and `status` labels are bounded
/// (3 + small) so they do not need to pass through the cardinality tracker.
pub fn record_execution(
    bot_id: &str,
    protocol: &str,
    action: &str,
    status: ExecutionStatus,
    started_at: Instant,
) {
    let (bot_label, protocol_label) = resolve_labels("trading_executions_total", bot_id, protocol);
    EXECUTIONS_TOTAL
        .with_label_values(&[&bot_label, &protocol_label, action, status.as_str()])
        .inc();
    EXECUTION_LATENCY_SECONDS
        .with_label_values(&[&bot_label, &protocol_label, action])
        .observe(started_at.elapsed().as_secs_f64());
}

/// Record a renewal-cron action for `bot_id` with the canonical variant name.
pub fn record_renewal_action(bot_id: &str, action: &str) {
    let (bot_label, action_label) =
        resolve_labels("trading_envelope_renewal_actions_total", bot_id, action);
    ENVELOPE_RENEWAL_ACTIONS_TOTAL
        .with_label_values(&[&bot_label, &action_label])
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
    let (bot_label, protocol_label) =
        resolve_labels("trading_envelope_consumed_amount", bot_id, protocol);
    ENVELOPE_CONSUMED_AMOUNT
        .with_label_values(&[&bot_label, &protocol_label])
        .set(consumed_amount_f64);
    ENVELOPE_MAX_TOTAL
        .with_label_values(&[&bot_label, &protocol_label])
        .set(max_total_amount_f64);
    ENVELOPE_EXPIRES_AT_SECONDS
        .with_label_values(&[&bot_label, &protocol_label])
        .set(expires_at_secs as f64);
    ENVELOPE_SIGNATURE_COUNT
        .with_label_values(&[&bot_label, &protocol_label])
        .set(signature_count as f64);
}

/// Update the current slippage recommendation gauge.
///
/// The cardinality tracker is keyed by `(bot_id, "{token_in}->{token_out}")`
/// so a single bot trading 50 token pairs counts as 50 distinct entries
/// against the family cap (matching the on-disk semantics — there is one
/// recommendation per bot+pair).
pub fn record_slippage_recommendation(bot_id: &str, token_in: &str, token_out: &str, bps: u32) {
    let pair = format!("{token_in}->{token_out}");
    let (bot_label, _) = resolve_labels("trading_learning_slippage_bps", bot_id, &pair);
    LEARNING_SLIPPAGE_BPS
        .with_label_values(&[&bot_label, token_in, token_out])
        .set(bps as f64);
}

/// Record a bandit-arm pull and update its mean reward gauge.
pub fn record_bandit_pull(bot_id: &str, variant_id: &str, mean_reward: f64) {
    let (bot_label, variant_label) = resolve_labels(
        "trading_learning_bandit_arm_pulls_total",
        bot_id,
        variant_id,
    );
    LEARNING_BANDIT_ARM_PULLS_TOTAL
        .with_label_values(&[&bot_label, &variant_label])
        .inc();
    LEARNING_BANDIT_ARM_MEAN_REWARD
        .with_label_values(&[&bot_label, &variant_label])
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

    #[test]
    fn safe_bot_label_passes_through_short_ids() {
        assert_eq!(safe_bot_label("bot-1"), "bot-1");
        let len32 = "a".repeat(32);
        assert_eq!(safe_bot_label(&len32), len32);
    }

    #[test]
    fn safe_bot_label_hashes_oversized_ids() {
        let huge = "a".repeat(10_000);
        let label = safe_bot_label(&huge);
        assert!(label.starts_with("sha-"), "want sha- prefix, got {label}");
        // sha- + 16 hex chars = 20.
        assert_eq!(label.len(), 20);
        // Same input → same label (deterministic).
        assert_eq!(label, safe_bot_label(&huge));
    }

    /// Record 2K distinct `(bot_id, protocol)` pairs against a synthetic
    /// metric family. Cap is 1024 unique rows + 1 synthetic
    /// `bot_id="overflow"` row → exactly 1025 entries in the tracker.
    ///
    /// Uses a per-test family name so we don't inherit residue from other
    /// tests touching the real `trading_envelope_consumed_amount` tracker.
    /// We exercise `resolve_labels` directly because the
    /// `record_envelope_snapshot` path emits to a registry shared by every
    /// test in this module — gauge counts there are not stable across the
    /// test order.
    #[test]
    fn label_cardinality_caps_at_max() {
        let family = "trading_test_cardinality_envelope_consumed_amount";
        reset_cardinality_for_tests(family);

        for i in 0..2_000usize {
            let bot_id = format!("bot-{i:05}");
            let (label, _) = resolve_labels(family, &bot_id, "uniswap_v3");
            if i < MAX_PROMETHEUS_BOT_LABELS {
                assert_eq!(label, format!("bot-{i:05}"));
            } else {
                assert_eq!(label, OVERFLOW_BOT_LABEL);
            }
        }

        // 1024 unique bot rows + the single synthetic overflow row = 1025.
        assert_eq!(family_label_count(family), MAX_PROMETHEUS_BOT_LABELS + 1);
        reset_cardinality_for_tests(family);
    }
}
