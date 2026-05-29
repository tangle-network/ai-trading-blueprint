//! Optional OpenTelemetry OTLP/HTTP-JSON trace export.
//!
//! A Tangle blueprint operator runs fully decentralized — it never calls the
//! sandbox SDK / API / orchestrator directly — yet its work is agentic: each job
//! tick drives an agent loop with tool calls and LLM requests. This module ships
//! the operator's `tracing` spans to a remote OTLP collector so that work is
//! observable on the central platform like any first-class tenant.
//!
//! Default target: the Tangle Intelligence platform
//! (`https://intelligence.tangle.tools/v1/otlp`), OTLP/HTTP **JSON** (the
//! Intelligence adapter parses `application/json` only — not protobuf), with
//! `Authorization: Bearer sk-tan-*`.
//!
//! ## Enabling
//! Export turns on when either is set:
//!   * `TANGLE_API_KEY=sk-tan-…`          → export to the default Intelligence endpoint
//!   * `OTEL_EXPORTER_OTLP_ENDPOINT=<base>` → export to an arbitrary collector
//!
//! With neither set the operator keeps its stdout fmt logs and exports nothing
//! (zero behaviour change). Init never aborts startup: a telemetry misconfig
//! logs a warning and falls back to fmt-only — an observability problem must
//! not take down a trading operator.
//!
//! This is the working reference for the same capability being upstreamed into
//! `blueprint-qos` so every blueprint gets OTLP export for free.

use std::collections::HashMap;
use std::time::Duration;

use opentelemetry::KeyValue;
use opentelemetry::trace::TracerProvider as _;
use opentelemetry_otlp::{Protocol, SpanExporter, WithExportConfig, WithHttpConfig};
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::trace::SdkTracerProvider;
use tracing_subscriber::prelude::*;
use tracing_subscriber::{EnvFilter, fmt};

/// Default Tangle Intelligence OTLP base. The exporter posts to `<base>/v1/traces`.
const DEFAULT_OTLP_BASE: &str = "https://intelligence.tangle.tools/v1/otlp";
const TRACES_PATH: &str = "/v1/traces";
const EXPORT_TIMEOUT_SECS: u64 = 10;

/// Held by `main` for the process lifetime; flushes queued spans + shuts the
/// exporter down on drop so in-flight traces aren't lost on a clean exit.
pub struct TelemetryGuard {
    provider: Option<SdkTracerProvider>,
}

impl Drop for TelemetryGuard {
    fn drop(&mut self) {
        if let Some(provider) = self.provider.take() {
            let _ = provider.force_flush();
            let _ = provider.shutdown();
        }
    }
}

/// Initialize the global tracing subscriber. Always installs a fmt + `EnvFilter`
/// layer (preserving today's stdout logs via `RUST_LOG`). When OTLP export is
/// configured (see module docs) it additionally bridges `tracing` spans to an
/// OTLP/HTTP-JSON exporter. `service_name` becomes the OTel `service.name`
/// resource attribute the Intelligence dashboard groups by.
pub fn init(service_name: &'static str) -> TelemetryGuard {
    let base = tracing_subscriber::registry()
        .with(EnvFilter::from_default_env())
        .with(fmt::layer());

    match build_otlp_provider(service_name) {
        Some((provider, endpoint)) => {
            let tracer = provider.tracer(service_name);
            let otel_layer = tracing_opentelemetry::layer().with_tracer(tracer);
            // Ignore the error if a subscriber is already installed (tests).
            let _ = base.with(otel_layer).try_init();
            tracing::info!(
                target: "telemetry",
                service = service_name,
                endpoint = %endpoint,
                "OTLP trace export enabled"
            );
            TelemetryGuard {
                provider: Some(provider),
            }
        }
        None => {
            let _ = base.try_init();
            TelemetryGuard { provider: None }
        }
    }
}

/// Build the OTLP tracer provider, or `None` when export is disabled or the
/// exporter fails to construct (fall back to fmt-only — never abort startup).
fn build_otlp_provider(service_name: &str) -> Option<(SdkTracerProvider, String)> {
    let api_key = non_empty_env("TANGLE_API_KEY");
    let base = non_empty_env("OTEL_EXPORTER_OTLP_ENDPOINT");

    // Disabled unless a key (→ default endpoint) or an explicit endpoint is set.
    if api_key.is_none() && base.is_none() {
        return None;
    }

    let endpoint = traces_endpoint(base.as_deref().unwrap_or(DEFAULT_OTLP_BASE));
    let headers = build_headers(api_key.as_deref());

    let exporter = match SpanExporter::builder()
        .with_http()
        // The Intelligence OTLP adapter is JSON-only; protobuf would 400.
        .with_protocol(Protocol::HttpJson)
        // Programmatic endpoint is used verbatim (no `/v1/traces` auto-append),
        // so `traces_endpoint` builds the full path itself.
        .with_endpoint(endpoint.clone())
        .with_headers(headers)
        .with_timeout(Duration::from_secs(EXPORT_TIMEOUT_SECS))
        .build()
    {
        Ok(exporter) => exporter,
        Err(err) => {
            eprintln!(
                "telemetry: OTLP exporter init failed ({err}); stdout logs only"
            );
            return None;
        }
    };

    let resource = Resource::builder()
        .with_attributes([
            KeyValue::new("service.name", service_name.to_string()),
            KeyValue::new("service.version", env!("CARGO_PKG_VERSION").to_string()),
        ])
        .build();

    let provider = SdkTracerProvider::builder()
        .with_resource(resource)
        .with_batch_exporter(exporter)
        .build();

    Some((provider, endpoint))
}

/// Assemble export headers: the Tangle bearer token plus any standard
/// `OTEL_EXPORTER_OTLP_HEADERS` (`k1=v1,k2=v2`) passthrough.
fn build_headers(api_key: Option<&str>) -> HashMap<String, String> {
    let mut headers = HashMap::new();
    if let Some(key) = api_key {
        headers.insert("Authorization".to_string(), format!("Bearer {key}"));
    }
    if let Some(raw) = non_empty_env("OTEL_EXPORTER_OTLP_HEADERS") {
        for pair in raw.split(',') {
            if let Some((k, v)) = pair.split_once('=') {
                headers.insert(k.trim().to_string(), v.trim().to_string());
            }
        }
    }
    headers
}

fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Normalize an OTLP base URL to the full traces path: `<base>` → `<base>/v1/traces`.
/// Idempotent if the caller already included `/v1/traces`; trims trailing slashes.
fn traces_endpoint(base: &str) -> String {
    let base = base.trim_end_matches('/');
    if base.ends_with(TRACES_PATH) {
        base.to_string()
    } else {
        format!("{base}{TRACES_PATH}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn traces_endpoint_appends_once() {
        assert_eq!(
            traces_endpoint("https://intelligence.tangle.tools/v1/otlp"),
            "https://intelligence.tangle.tools/v1/otlp/v1/traces"
        );
        // trailing slash is trimmed before append
        assert_eq!(
            traces_endpoint("https://intelligence.tangle.tools/v1/otlp/"),
            "https://intelligence.tangle.tools/v1/otlp/v1/traces"
        );
        // idempotent when the path is already present
        assert_eq!(
            traces_endpoint("http://localhost:4318/v1/traces"),
            "http://localhost:4318/v1/traces"
        );
    }

    #[test]
    fn headers_carry_bearer_and_passthrough() {
        let h = build_headers(Some("sk-tan-abc"));
        assert_eq!(h.get("Authorization").unwrap(), "Bearer sk-tan-abc");
        // no key → no Authorization header (e.g. local unauthenticated collector)
        assert!(build_headers(None).get("Authorization").is_none());
    }
}
