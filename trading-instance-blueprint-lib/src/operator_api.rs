use axum::extract::{Path, Query, RawQuery};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use sandbox_runtime::api_types::{
    CreateLiveTerminalSessionRequest, TerminalInputApiRequest, TerminalResizeApiRequest,
};
use sandbox_runtime::session_auth::SessionAuth;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::time::Duration;
use trading_blueprint_lib::workflow_compat::{WorkflowRunRecord, WorkflowRunStatus};

use crate::{get_instance_bot_id, require_instance_bot, set_instance_bot_id};
use trading_blueprint_lib::asset_preflight::{
    DexAssetPreflightRequest, DexAssetPreflightResponse, preflight_dex_asset,
};
use trading_blueprint_lib::state::{self, ActivationProgress, TradingBotRecord};

// ── Terminal relay types (local, sandbox-runtime keeps these private) ────

/// Error returned by terminal relay helpers.
struct TerminalRelayError {
    status: StatusCode,
    message: String,
    code: Option<String>,
    retry_after_ms: Option<u64>,
}

impl From<sandbox_runtime::error::SandboxError> for TerminalRelayError {
    fn from(err: sandbox_runtime::error::SandboxError) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            message: err.to_string(),
            code: None,
            retry_after_ms: None,
        }
    }
}

/// Summary of a live terminal session (mirrors sandbox-runtime's private type).
#[derive(Debug, Serialize)]
struct LiveTerminalSessionSummary {
    session_id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    title: String,
}

// ── Response types ──────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct BotDetailResponse {
    pub id: String,
    pub name: String,
    pub operator_address: String,
    pub submitter_address: String,
    pub vault_address: String,
    pub strategy_type: String,
    pub strategy_config: serde_json::Value,
    pub risk_params: serde_json::Value,
    pub chain_id: u64,
    pub trading_active: bool,
    pub paper_trade: bool,
    pub created_at: u64,
    pub max_lifetime_days: u64,
    pub trading_api_url: String,
    pub trading_api_token: String,
    pub sandbox_id: String,
    pub workflow_id: Option<String>,
    pub secrets_configured: bool,
    pub sandbox_exists: bool,
    pub sandbox_state: Option<String>,
    pub lifecycle_status: String,
    pub archived: bool,
    pub control_available: bool,
    pub wind_down_started_at: Option<u64>,
    pub call_id: u64,
    pub service_id: u64,
}

impl BotDetailResponse {
    fn from_record(b: TradingBotRecord) -> Self {
        let runtime = state::bot_runtime_status(&b);
        Self {
            id: b.id,
            name: b.name,
            operator_address: b.operator_address,
            submitter_address: b.submitter_address,
            vault_address: b.vault_address,
            strategy_type: b.strategy_type,
            strategy_config: b.strategy_config,
            risk_params: b.risk_params,
            chain_id: b.chain_id,
            trading_active: b.trading_active,
            paper_trade: b.paper_trade,
            created_at: b.created_at,
            max_lifetime_days: b.max_lifetime_days,
            trading_api_url: b.trading_api_url,
            trading_api_token: b.trading_api_token,
            sandbox_id: b.sandbox_id,
            workflow_id: b.workflow_id.map(|workflow_id| workflow_id.to_string()),
            secrets_configured: runtime.secrets_configured,
            sandbox_exists: runtime.sandbox_exists,
            sandbox_state: runtime.sandbox_state,
            lifecycle_status: runtime.lifecycle_status.as_str().to_string(),
            archived: runtime.archived,
            control_available: runtime.control_available,
            wind_down_started_at: b.wind_down_started_at,
            call_id: b.call_id,
            service_id: b.service_id,
        }
    }
}

// ── Provision progress types ────────────────────────────────────────────

#[derive(Serialize)]
pub struct ProvisionProgressResponse {
    pub call_id: u64,
    pub phase: String,
    pub message: Option<String>,
    pub sandbox_id: Option<String>,
    pub progress_pct: u8,
    pub started_at: u64,
    pub updated_at: u64,
    pub metadata: serde_json::Value,
}

impl From<sandbox_runtime::provision_progress::ProvisionStatus> for ProvisionProgressResponse {
    fn from(p: sandbox_runtime::provision_progress::ProvisionStatus) -> Self {
        Self {
            call_id: p.call_id,
            phase: serde_json::to_value(p.phase)
                .ok()
                .and_then(|v| v.as_str().map(String::from))
                .unwrap_or_else(|| format!("{:?}", p.phase)),
            message: p.message,
            sandbox_id: p.sandbox_id,
            progress_pct: p.progress_pct,
            started_at: p.started_at,
            updated_at: p.updated_at,
            metadata: p.metadata,
        }
    }
}

#[derive(Serialize)]
pub struct ProvisionListResponse {
    pub provisions: Vec<ProvisionProgressResponse>,
}

#[derive(Serialize)]
struct OperatorMetaResponse {
    api_version: String,
    deployment_kind: String,
    features: OperatorFeatureFlags,
}

#[derive(Serialize)]
struct OperatorFeatureFlags {
    chat: bool,
    terminal: bool,
}

// ── Secrets types ───────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ConfigureSecretsRequest {
    env_json: serde_json::Map<String, serde_json::Value>,
}

#[derive(Serialize)]
struct SecretsResponse {
    status: String,
    sandbox_id: Option<String>,
    workflow_id: Option<String>,
}

#[derive(Serialize)]
struct GetSecretsResponse {
    sandbox_id: String,
    env_json: serde_json::Map<String, serde_json::Value>,
}

#[derive(Serialize)]
struct ActivationProgressResponse {
    bot_id: String,
    phase: String,
    detail: String,
    started_at: u64,
    updated_at: u64,
}

impl From<ActivationProgress> for ActivationProgressResponse {
    fn from(p: ActivationProgress) -> Self {
        Self {
            bot_id: p.bot_id,
            phase: p.phase,
            detail: p.detail,
            started_at: p.started_at,
            updated_at: p.updated_at,
        }
    }
}

// ── Bot control types ───────────────────────────────────────────────────

#[derive(Serialize)]
struct BotControlResponse {
    status: String,
    sandbox_id: String,
}

#[derive(Serialize)]
struct RunNowResponse {
    status: String,
    workflow_id: String,
    response: serde_json::Value,
}

#[derive(Deserialize)]
struct UpdateConfigRequest {
    strategy_config_json: Option<String>,
    risk_params_json: Option<String>,
}

#[derive(Serialize)]
struct ConfigResponse {
    status: String,
}

#[derive(Serialize)]
struct OperatorErrorResponse {
    code: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    bot_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sandbox_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_after_ms: Option<u64>,
}

enum ApiError {
    Message(StatusCode, String),
    StaleState {
        message: String,
        bot_id: String,
        sandbox_id: String,
    },
}

impl ApiError {
    fn message(status: StatusCode, message: impl Into<String>) -> Self {
        Self::Message(status, message.into())
    }

    fn stale_bot(bot: &TradingBotRecord) -> Self {
        Self::StaleState {
            message: format!(
                "Instance bot {} points to missing sandbox {}. Operator state is stale; reprovision the agent from the deploy step.",
                bot.id, bot.sandbox_id
            ),
            bot_id: bot.id.clone(),
            sandbox_id: bot.sandbox_id.clone(),
        }
    }
}

impl From<(StatusCode, String)> for ApiError {
    fn from(value: (StatusCode, String)) -> Self {
        Self::Message(value.0, value.1)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        api_error_response(self).into_response()
    }
}

type ApiResult<T> = Result<Json<T>, ApiError>;

fn error_json(
    status: StatusCode,
    code: impl Into<String>,
    message: impl Into<String>,
    bot_id: Option<String>,
    sandbox_id: Option<String>,
    retry_after_ms: Option<u64>,
) -> (StatusCode, Json<OperatorErrorResponse>) {
    (
        status,
        Json(OperatorErrorResponse {
            code: code.into(),
            message: message.into(),
            bot_id,
            sandbox_id,
            retry_after_ms,
        }),
    )
}

fn api_error_response(error: ApiError) -> (StatusCode, Json<OperatorErrorResponse>) {
    match error {
        ApiError::Message(status, message) => {
            error_json(status, "operator_error", message, None, None, None)
        }
        ApiError::StaleState {
            message,
            bot_id,
            sandbox_id,
        } => error_json(
            StatusCode::CONFLICT,
            "stale_state",
            message,
            Some(bot_id),
            Some(sandbox_id),
            None,
        ),
    }
}

// ── Instance provision types ─────────────────────────────────────────────

#[derive(Deserialize)]
struct InstanceProvisionRequest {
    name: Option<String>,
    strategy_type: Option<String>,
    strategy_config_json: Option<String>,
    risk_params_json: Option<String>,
    chain_id: Option<u64>,
    rpc_url: Option<String>,
    vault_address: Option<String>,
    asset_token: Option<String>,
    paper_trade: Option<bool>,
    trading_loop_cron: Option<String>,
    validator_service_ids: Option<Vec<u64>>,
    validation_trust: Option<trading_runtime::ValidationTrust>,
}

#[derive(Serialize)]
struct InstanceProvisionResponse {
    status: String,
    bot_id: String,
    sandbox_id: String,
}

// ── Metrics / trades response types ─────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct MetricsSnapshotResponse {
    timestamp: String,
    bot_id: String,
    account_value_usd: f64,
    unrealized_pnl: f64,
    realized_pnl: f64,
    high_water_mark: f64,
    drawdown_pct: f64,
    positions_count: u32,
    trade_count: u32,
}

#[derive(Serialize)]
struct BotMetricsResponse {
    portfolio_value_usd: f64,
    total_pnl: f64,
    trade_count: u32,
}

#[derive(Serialize)]
struct TradeEntryResponse {
    id: String,
    bot_id: String,
    timestamp: String,
    action: String,
    token_in: String,
    token_out: String,
    amount_in: String,
    min_amount_out: String,
    target_protocol: String,
    tx_hash: String,
    paper_trade: bool,
    status: String,
    pnl: f64,
    entry_price: f64,
    current_price: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    amount_out: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    entry_price_usd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    notional_usd: Option<String>,
    #[serde(default)]
    valuation_status: trading_http_api::trade_store::TradeValuationStatus,
}

#[derive(Deserialize)]
struct TradeListQuery {
    limit: Option<usize>,
    offset: Option<usize>,
}

#[derive(Deserialize)]
struct CandleListQuery {
    token: Option<String>,
    from: Option<i64>,
    to: Option<i64>,
    limit: Option<usize>,
}

#[derive(Deserialize)]
struct RunListQuery {
    limit: Option<usize>,
    cursor: Option<String>,
}

#[derive(Serialize)]
struct BotRunListResponse {
    runs: Vec<BotRunResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_cursor: Option<String>,
}

#[derive(Serialize)]
struct BotRunResponse {
    run_id: String,
    workflow_id: u64,
    workflow_kind: String,
    status: WorkflowRunStatus,
    started_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    completed_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    transcript_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    trace_id: Option<String>,
    duration_ms: u64,
    input_tokens: u32,
    output_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
struct PortfolioPosition {
    token: String,
    symbol: String,
    amount: f64,
    value_usd: Option<f64>,
    entry_price: Option<f64>,
    current_price: Option<f64>,
    pnl_percent: Option<f64>,
    weight: Option<f64>,
    #[serde(default)]
    valuation_status: trading_http_api::trade_store::TradeValuationStatus,
}

#[derive(Serialize)]
struct PortfolioStateResponse {
    total_value_usd: Option<f64>,
    cash_balance: Option<f64>,
    #[serde(default)]
    warnings: Vec<String>,
    #[serde(default)]
    has_unpriced_positions: bool,
    positions: Vec<PortfolioPosition>,
}

// ── Session auth types ──────────────────────────────────────────────────

#[derive(Deserialize)]
struct SessionRequest {
    nonce: String,
    signature: String,
}

// ── Pricing types ───────────────────────────────────────────────────────

#[derive(Deserialize)]
struct PricingQuoteRequest {
    blueprint_id: Option<String>,
    ttl_blocks: Option<String>,
    #[allow(dead_code)]
    proof_of_work: Option<String>,
    challenge_timestamp: Option<String>,
    #[allow(dead_code)]
    resource_requirements: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct JobQuoteRequest {
    service_id: Option<String>,
    job_index: Option<u32>,
    #[allow(dead_code)]
    proof_of_work: Option<String>,
    challenge_timestamp: Option<String>,
    /// tnt-core v0.13.0: 0x-prefixed EVM address (20 bytes) the quote must be
    /// bound to. The on-chain verifier rejects `address(0)`, so production
    /// callers MUST supply this. We accept `Option` for staged rollout — when
    /// `None`, the response echoes `address(0)` and the operator-side handler
    /// logs a warning so callers notice before they hit the on-chain reject.
    requester: Option<String>,
}

// ── Router ──────────────────────────────────────────────────────────────

/// Build the singleton-scoped operator router.
///
/// All endpoints use `/api/bot` (no `:bot_id` path param) because the instance
/// manages exactly one bot resolved via `require_instance_bot()`.
pub fn build_instance_router() -> Router {
    Router::new()
        .route("/api/meta", get(get_operator_meta))
        // Session auth
        .route("/api/auth/challenge", post(create_challenge))
        .route("/api/auth/session", post(create_session))
        .route("/api/dex/assets/preflight", post(preflight_dex_asset_route))
        // Instance provisioning (off-chain — replaces on-chain JOB_PROVISION)
        .route("/api/bot/provision", post(provision_bot))
        // Singleton bot management
        .route("/api/bot", get(get_bot))
        .route(
            "/api/bot/secrets",
            get(get_secrets)
                .post(configure_secrets)
                .delete(wipe_secrets),
        )
        .route("/api/bot/start", post(start_bot))
        .route("/api/bot/stop", post(stop_bot))
        .route("/api/bot/run-now", post(run_now))
        .route("/api/bot/config", patch(update_config))
        .route("/api/bot/metrics", get(get_bot_metrics))
        .route("/api/bot/metrics/history", get(get_bot_metrics_history))
        .route("/api/bot/market-data/candles", get(get_bot_market_candles))
        .route("/api/bot/trades", get(get_bot_trades))
        .route("/api/bot/portfolio/state", get(get_bot_portfolio))
        .route("/api/bot/runs", get(list_bot_runs))
        .route("/api/bot/runs/{run_id}", get(get_bot_run))
        .route("/api/bot/activation-progress", get(get_activation_progress))
        .route(
            "/api/bot/live/terminal/sessions",
            get(list_terminal_sessions).post(create_terminal_session),
        )
        .route(
            "/api/bot/live/terminal/sessions/{session_id}",
            patch(resize_terminal_session).delete(delete_terminal_session),
        )
        .route(
            "/api/bot/live/terminal/sessions/{session_id}/stream",
            get(stream_terminal_session),
        )
        .route(
            "/api/bot/live/terminal/sessions/{session_id}/input",
            post(send_terminal_input),
        )
        .route(
            "/api/bot/session/sessions",
            get(list_chat_sessions).post(create_chat_gateway_session),
        )
        .route(
            "/api/bot/session/sessions/{session_id}",
            get(get_chat_session)
                .patch(update_chat_session)
                .delete(delete_chat_session),
        )
        .route(
            "/api/bot/session/sessions/{session_id}/messages",
            get(list_chat_messages).post(send_chat_message),
        )
        .route(
            "/api/bot/session/sessions/{session_id}/abort",
            post(abort_chat_session),
        )
        .route("/api/bot/session/events", get(stream_chat_events))
        .route("/api/platform/volume", get(get_platform_volume))
        // Provision progress
        .route("/api/provisions", get(list_provisions))
        .route("/api/provisions/{call_id}", get(get_provision))
        // Pricing (RFQ) endpoints
        .route("/pricing/quote", post(pricing_quote))
        .route("/pricing/job-quote", post(pricing_job_quote))
        // Debug endpoints
        .route("/api/debug/sandboxes", get(debug_sandboxes))
        .route("/api/debug/state-health", get(debug_state_health))
        .route("/api/debug/workflows", get(debug_workflows))
        .route("/api/debug/run-now", post(debug_run_now))
        .layer(sandbox_runtime::operator_api::build_cors_layer())
}

async fn get_operator_meta() -> Json<OperatorMetaResponse> {
    Json(OperatorMetaResponse {
        api_version: "1".to_string(),
        deployment_kind: "instance".to_string(),
        features: OperatorFeatureFlags {
            chat: true,
            terminal: true,
        },
    })
}

// ── Helpers ─────────────────────────────────────────────────────────────

/// Resolve the singleton bot or return an HTTP error.
fn resolve_singleton() -> Result<TradingBotRecord, (StatusCode, String)> {
    require_instance_bot().map_err(|e| (StatusCode::NOT_FOUND, e))
}

fn resolve_singleton_live() -> Result<TradingBotRecord, ApiError> {
    let bot =
        resolve_singleton().map_err(|(status, message)| ApiError::message(status, message))?;
    ensure_live_sandbox(bot)
}

/// Instance mode provisions against a pre-existing singleton vault, but the
/// shared cloud provision flow persists `factory:{address}` placeholders until
/// a factory-created vault can be resolved later. Normalize the stored record
/// back to the actual singleton vault address so validator signing and
/// activation both see a plain EVM address.
pub fn persist_instance_singleton_vault_address(
    bot_id: &str,
    vault_address: blueprint_sdk::alloy::primitives::Address,
) -> Result<(), String> {
    state::bots()?
        .update(&state::bot_key(bot_id), |bot| {
            bot.vault_address = format!("{vault_address:#x}");
        })
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn ensure_live_sandbox(bot: TradingBotRecord) -> Result<TradingBotRecord, ApiError> {
    if sandbox_runtime::runtime::get_sandbox_by_id(&bot.sandbox_id).is_err() {
        return Err(ApiError::stale_bot(&bot));
    }
    Ok(bot)
}

struct LiveTerminalTarget {
    bot: TradingBotRecord,
    sandbox: sandbox_runtime::runtime::SandboxRecord,
}

fn terminal_error_response(
    err: TerminalRelayError,
    bot: &TradingBotRecord,
) -> (StatusCode, Json<OperatorErrorResponse>) {
    error_json(
        err.status,
        err.code.unwrap_or_else(|| "operator_error".to_string()),
        err.message,
        Some(bot.id.clone()),
        Some(bot.sandbox_id.clone()),
        err.retry_after_ms,
    )
}

fn resolve_live_terminal_target(
    caller: &str,
) -> Result<LiveTerminalTarget, (StatusCode, Json<OperatorErrorResponse>)> {
    let bot = resolve_singleton_live().map_err(api_error_response)?;
    verify_submitter(&bot, caller).map_err(|(status, message)| {
        error_json(
            status,
            "operator_error",
            message,
            Some(bot.id.clone()),
            Some(bot.sandbox_id.clone()),
            None,
        )
    })?;
    let sandbox =
        sandbox_runtime::runtime::get_sandbox_by_id(&bot.sandbox_id).map_err(|_| {
            error_json(
                StatusCode::CONFLICT,
                "stale_state",
                format!(
                    "Instance bot {} points to missing sandbox {}. Operator state is stale; reprovision the agent from the deploy step.",
                    bot.id, bot.sandbox_id
                ),
                Some(bot.id.clone()),
                Some(bot.sandbox_id.clone()),
                None,
            )
        })?;

    Ok(LiveTerminalTarget { bot, sandbox })
}

async fn fetch_trading_api_json(
    bot: &TradingBotRecord,
    path: &str,
    query: &[(&str, String)],
) -> Result<Option<serde_json::Value>, String> {
    fetch_trading_api_json_with_method(bot, reqwest::Method::GET, path, query).await
}

async fn fetch_trading_api_json_with_method(
    bot: &TradingBotRecord,
    method: reqwest::Method,
    path: &str,
    query: &[(&str, String)],
) -> Result<Option<serde_json::Value>, String> {
    if bot.trading_api_url.trim().is_empty() || bot.trading_api_token.trim().is_empty() {
        return Ok(None);
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("failed to build trading api client: {e}"))?;

    let url = format!("{}{}", bot.trading_api_url.trim_end_matches('/'), path);
    let response = client
        .request(method, url)
        .bearer_auth(&bot.trading_api_token)
        .header(reqwest::header::ACCEPT, "application/json")
        .query(query)
        .send()
        .await
        .map_err(|e| format!("trading api request failed: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("trading api returned {status}"));
    }

    response
        .json::<serde_json::Value>()
        .await
        .map(Some)
        .map_err(|e| format!("failed to decode trading api response: {e}"))
}

fn extract_json_array(
    payload: serde_json::Value,
    field_name: &str,
) -> Result<Vec<serde_json::Value>, String> {
    match payload {
        serde_json::Value::Array(values) => Ok(values),
        serde_json::Value::Object(mut map) => match map.remove(field_name) {
            Some(serde_json::Value::Array(values)) => Ok(values),
            Some(_) => Err(format!("trading api field `{field_name}` was not an array")),
            None => Err(format!("trading api response missing `{field_name}`")),
        },
        _ => Err("trading api response was not an array/object".to_string()),
    }
}

fn deserialize_f64_from_string_or_number<'de, D>(deserializer: D) -> Result<f64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    match value {
        serde_json::Value::Number(number) => number
            .as_f64()
            .filter(|v| v.is_finite())
            .ok_or_else(|| serde::de::Error::custom("expected finite number")),
        serde_json::Value::String(text) => text
            .parse::<f64>()
            .ok()
            .filter(|v| v.is_finite())
            .ok_or_else(|| serde::de::Error::custom("expected numeric string")),
        _ => Err(serde::de::Error::custom(
            "expected number or numeric string",
        )),
    }
}

fn deserialize_option_f64_from_string_or_number<'de, D>(
    deserializer: D,
) -> Result<Option<f64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    match value {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::Number(number)) => number
            .as_f64()
            .filter(|v| v.is_finite())
            .map(Some)
            .ok_or_else(|| serde::de::Error::custom("expected finite number")),
        Some(serde_json::Value::String(text)) => text
            .parse::<f64>()
            .ok()
            .filter(|v| v.is_finite())
            .map(Some)
            .ok_or_else(|| serde::de::Error::custom("expected numeric string")),
        Some(_) => Err(serde::de::Error::custom(
            "expected number, numeric string, or null",
        )),
    }
}

#[derive(Deserialize)]
struct TradingApiPortfolioPosition {
    token: String,
    #[serde(deserialize_with = "deserialize_f64_from_string_or_number")]
    amount: f64,
    #[serde(
        default,
        deserialize_with = "deserialize_option_f64_from_string_or_number"
    )]
    value_usd: Option<f64>,
    #[serde(
        default,
        deserialize_with = "deserialize_option_f64_from_string_or_number"
    )]
    entry_price: Option<f64>,
    #[serde(
        default,
        deserialize_with = "deserialize_option_f64_from_string_or_number"
    )]
    current_price: Option<f64>,
    #[serde(default)]
    valuation_status: trading_http_api::trade_store::TradeValuationStatus,
}

#[derive(Deserialize)]
struct TradingApiPortfolioResponse {
    #[serde(default)]
    positions: Vec<TradingApiPortfolioPosition>,
    #[serde(
        default,
        deserialize_with = "deserialize_option_f64_from_string_or_number"
    )]
    total_value_usd: Option<f64>,
    #[serde(
        default,
        deserialize_with = "deserialize_option_f64_from_string_or_number"
    )]
    cash_balance: Option<f64>,
    #[serde(default)]
    warnings: Vec<String>,
    #[serde(default)]
    has_unpriced_positions: bool,
}

fn parse_trade_number(value: &str) -> Option<f64> {
    value.parse::<f64>().ok().filter(|v| v.is_finite())
}

fn action_opens_position(action: &str) -> bool {
    matches!(
        action.to_lowercase().as_str(),
        "buy" | "open_long" | "open_short" | "supply" | "borrow"
    )
}

fn synthesize_trade_entry_from_record(
    rec: &trading_http_api::trade_store::TradeRecord,
) -> serde_json::Value {
    let amount_in = parse_trade_number(&rec.amount_in).unwrap_or(0.0);
    let amount_out = rec
        .amount_out
        .as_deref()
        .and_then(parse_trade_number)
        .or_else(|| parse_trade_number(&rec.min_amount_out));
    let size = amount_out.unwrap_or_else(|| amount_in.max(0.0));
    let status = if action_opens_position(&rec.action) {
        "open"
    } else {
        "closed"
    };
    let entry_price = rec.entry_price_usd.as_deref().and_then(parse_trade_number);
    let notional_usd = rec.notional_usd.as_deref().and_then(parse_trade_number);

    let mut entry = serde_json::json!({
        "id": rec.id,
        "created_at": rec.timestamp.to_rfc3339(),
        "market_id": rec.token_out,
        "question": rec.token_out,
        "symbol": rec.token_out,
        "side": rec.action,
        "status": status,
        "size": size,
        "pnl": 0.0,
        "target_protocol": rec.target_protocol,
        "paper_trade": rec.paper_trade,
        "valuation_status": rec.valuation_status,
    });

    if let Some(amount_out) = amount_out {
        entry["amount_out"] = serde_json::json!(amount_out);
    }
    if let Some(entry_price) = entry_price {
        entry["entry_price"] = serde_json::json!(entry_price);
        entry["current_price"] = serde_json::json!(entry_price);
        entry["entry_price_usd"] = serde_json::json!(entry_price);
    }
    if let Some(notional_usd) = notional_usd {
        entry["amount_usd"] = serde_json::json!(notional_usd);
        entry["notional_usd"] = serde_json::json!(notional_usd);
    }

    entry
}

fn fallback_trade_dataset(bot: &TradingBotRecord) -> Vec<serde_json::Value> {
    let mut trades = state::load_bot_trades(&bot.id);
    let mut seen_ids: std::collections::HashSet<String> = trades
        .iter()
        .filter_map(|t| t.get("id"))
        .map(|v| match v {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Number(n) => n.to_string(),
            _ => v.to_string(),
        })
        .collect();

    if let Ok(paginated) = trading_http_api::trade_store::trades_for_bot(&bot.id, 1000, 0) {
        for rec in paginated.trades {
            if seen_ids.insert(rec.id.clone()) {
                trades.push(synthesize_trade_entry_from_record(&rec));
            }
        }
    }

    trades
}

fn fallback_trade_quantity(t: &serde_json::Value) -> f64 {
    t.get("size")
        .or_else(|| t.get("amount_out"))
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0)
}

fn fallback_trade_price(t: &serde_json::Value) -> Option<f64> {
    let entry_price = t.get("entry_price").and_then(|v| v.as_f64());
    let current_price = t.get("current_price").and_then(|v| v.as_f64());
    match (entry_price, current_price) {
        (Some(entry), Some(current)) => Some(current.max(entry)),
        (Some(entry), None) => Some(entry),
        (None, Some(current)) => Some(current),
        (None, None) => None,
    }
}

fn fallback_trade_value_usd(t: &serde_json::Value) -> Option<f64> {
    if let Some(amount_usd) = t
        .get("notional_usd")
        .or_else(|| t.get("amount_usd"))
        .and_then(|v| v.as_f64())
    {
        return Some(amount_usd);
    }
    let quantity = fallback_trade_quantity(t);
    let price = fallback_trade_price(t)?;
    Some(quantity * price)
}

fn fallback_metrics_snapshots(bot: &TradingBotRecord) -> Vec<MetricsSnapshotResponse> {
    let trades = fallback_trade_dataset(bot);
    synthesize_metrics(bot, &trades)
}

fn fallback_metrics_history(bot: &TradingBotRecord) -> Vec<serde_json::Value> {
    fallback_metrics_snapshots(bot)
        .into_iter()
        .map(|snapshot| serde_json::to_value(snapshot).unwrap_or(serde_json::Value::Null))
        .collect()
}

fn parse_metrics_snapshots(
    snapshots: Vec<serde_json::Value>,
) -> Result<Vec<MetricsSnapshotResponse>, String> {
    serde_json::from_value(serde_json::Value::Array(snapshots))
        .map_err(|e| format!("invalid metrics snapshot array: {e}"))
}

fn payload_trade_total(payload: &serde_json::Value) -> Option<u32> {
    ["total", "total_count", "count"].iter().find_map(|key| {
        payload
            .get(key)
            .and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok()))
            .and_then(|value| u32::try_from(value).ok())
    })
}

fn patch_latest_snapshot_trade_count(snapshots: &mut [serde_json::Value], trade_count: u32) {
    let Some(latest) = snapshots.last_mut() else {
        return;
    };
    let current = latest
        .get("trade_count")
        .and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok()))
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or(0);
    if trade_count > current {
        latest["trade_count"] = serde_json::json!(trade_count);
    }
}

async fn fetch_remote_trade_count(bot: &TradingBotRecord) -> Option<u32> {
    match fetch_trading_api_json(bot, "/trades", &[("limit", "1".to_string())]).await {
        Ok(Some(payload)) => {
            let remote_total = payload_trade_total(&payload);
            let visible_count = extract_json_array(payload, "trades")
                .ok()
                .map(|trades| trades.len() as u32);
            match (remote_total, visible_count) {
                (Some(total), Some(visible)) => Some(total.max(visible)),
                (Some(total), None) => Some(total),
                (None, Some(visible)) => Some(visible),
                (None, None) => None,
            }
        }
        Ok(None) | Err(_) => None,
    }
}

fn map_trading_api_portfolio(payload: serde_json::Value) -> Result<PortfolioStateResponse, String> {
    let portfolio: TradingApiPortfolioResponse =
        serde_json::from_value(payload).map_err(|e| format!("invalid portfolio payload: {e}"))?;

    let total_value = portfolio.total_value_usd;
    let positions = portfolio
        .positions
        .into_iter()
        .map(|position| {
            let value_usd = position.value_usd.or_else(|| {
                position
                    .current_price
                    .map(|current_price| position.amount * current_price)
            });
            let pnl_percent = match (position.entry_price, position.current_price) {
                (Some(entry_price), Some(current_price)) if entry_price > 0.0 => {
                    Some(((current_price - entry_price) / entry_price) * 100.0)
                }
                _ => None,
            };

            PortfolioPosition {
                token: position.token.chars().take(10).collect(),
                symbol: position.token.chars().take(30).collect(),
                amount: position.amount,
                value_usd,
                entry_price: position.entry_price,
                current_price: position.current_price,
                pnl_percent,
                weight: match (value_usd, total_value) {
                    (Some(value_usd), Some(total_value)) if total_value > 0.0 => {
                        Some((value_usd / total_value) * 100.0)
                    }
                    _ => None,
                },
                valuation_status: position.valuation_status,
            }
        })
        .collect();

    Ok(PortfolioStateResponse {
        total_value_usd: total_value,
        cash_balance: portfolio.cash_balance,
        warnings: portfolio.warnings,
        has_unpriced_positions: portfolio.has_unpriced_positions,
        positions,
    })
}

fn fallback_portfolio_state(bot: &TradingBotRecord) -> PortfolioStateResponse {
    let trades = fallback_trade_dataset(bot);

    let open_trades: Vec<&serde_json::Value> = trades
        .iter()
        .filter(|t| t.get("status").and_then(|v| v.as_str()) == Some("open"))
        .collect();

    let mut has_unpriced_positions = false;
    let position_value: f64 = open_trades
        .iter()
        .filter_map(|t| {
            let value = fallback_trade_value_usd(t);
            if value.is_none() {
                has_unpriced_positions = true;
            }
            value
        })
        .sum();

    let positions: Vec<PortfolioPosition> = open_trades
        .iter()
        .map(|t| {
            let mid = t
                .get("market_id")
                .or_else(|| t.get("symbol"))
                .map(|v| v.to_string())
                .unwrap_or_default();
            let question = t
                .get("question")
                .or_else(|| t.get("symbol"))
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown");
            let amount = fallback_trade_quantity(t);
            let value_usd = fallback_trade_value_usd(t);
            let entry_price = t.get("entry_price").and_then(|v| v.as_f64());
            let current_price = t.get("current_price").and_then(|v| v.as_f64());
            let pnl_pct = match (entry_price, current_price) {
                (Some(entry_price), Some(current_price)) if entry_price > 0.0 => {
                    Some(((current_price - entry_price) / entry_price) * 100.0)
                }
                _ => None,
            };
            let valuation_status = if value_usd.is_some() && entry_price.is_some() {
                trading_http_api::trade_store::TradeValuationStatus::Priced
            } else {
                trading_http_api::trade_store::TradeValuationStatus::Unpriced
            };

            PortfolioPosition {
                token: mid.chars().take(10).collect(),
                symbol: question.chars().take(30).collect(),
                amount,
                value_usd,
                entry_price,
                current_price,
                pnl_percent: pnl_pct,
                weight: None,
                valuation_status,
            }
        })
        .collect();

    let total_value_usd = (!has_unpriced_positions).then_some(position_value);
    let positions = positions
        .into_iter()
        .map(|mut position| {
            position.weight = match (position.value_usd, total_value_usd) {
                (Some(value_usd), Some(total_value_usd)) if total_value_usd > 0.0 => {
                    Some((value_usd / total_value_usd) * 100.0)
                }
                _ => None,
            };
            position
        })
        .collect();

    PortfolioStateResponse {
        total_value_usd,
        cash_balance: None,
        warnings: if has_unpriced_positions {
            vec![
                "Some portfolio values are unavailable because trade valuation data is missing."
                    .to_string(),
            ]
        } else {
            Vec::new()
        },
        has_unpriced_positions,
        positions,
    }
}

fn fallback_trade_history(bot: &TradingBotRecord) -> Vec<serde_json::Value> {
    let trades = state::load_bot_trades(&bot.id);
    let protocol = if bot.strategy_type == "prediction" {
        "polymarket"
    } else {
        &bot.strategy_type
    };

    let entries: Vec<TradeEntryResponse> = trades
        .iter()
        .map(|t| {
            let mid = t
                .get("market_id")
                .or_else(|| t.get("symbol"))
                .and_then(|v| v.as_str().or_else(|| v.as_i64().map(|_| "")))
                .unwrap_or("");
            let mid_str = if mid.is_empty() {
                t.get("market_id")
                    .or_else(|| t.get("symbol"))
                    .map(|v| v.to_string())
                    .unwrap_or_default()
            } else {
                mid.to_string()
            };

            let tid = t
                .get("id")
                .map(|v| match v {
                    serde_json::Value::String(s) => s.clone(),
                    serde_json::Value::Number(n) => n.to_string(),
                    _ => v.to_string(),
                })
                .unwrap_or_else(|| mid_str.clone());

            let question = t
                .get("question")
                .or_else(|| t.get("symbol"))
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown");

            let side = t
                .get("side")
                .or_else(|| t.get("action"))
                .and_then(|v| v.as_str())
                .unwrap_or("buy");

            let action = if side == "YES" || side == "long" || side == "buy" || side.contains("buy")
            {
                "buy"
            } else {
                "sell"
            };

            let amount = t
                .get("amount_usd")
                .or_else(|| t.get("size"))
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);

            let entry_price = t.get("entry_price").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let current_price = t
                .get("current_price")
                .and_then(|v| v.as_f64())
                .unwrap_or(entry_price);
            let pnl = t.get("pnl").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let status = t
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");

            let ts = t
                .get("created_at")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            TradeEntryResponse {
                id: tid.clone(),
                bot_id: bot.id.clone(),
                timestamp: if ts.is_empty() {
                    chrono::Utc::now().to_rfc3339()
                } else {
                    ts
                },
                action: action.to_string(),
                token_in: "USDC".to_string(),
                token_out: question.chars().take(40).collect(),
                amount_in: amount.to_string(),
                min_amount_out: entry_price.to_string(),
                target_protocol: protocol.to_string(),
                tx_hash: format!("0xpaper_{}", &tid[..tid.len().min(16)]),
                paper_trade: true,
                status: status.to_string(),
                pnl,
                entry_price,
                current_price,
                amount_out: None,
                entry_price_usd: Some(entry_price.to_string()),
                notional_usd: Some(amount.to_string()),
                valuation_status: trading_http_api::trade_store::TradeValuationStatus::Priced,
            }
        })
        .collect();

    let mut entries = entries;
    let mut seen_ids: std::collections::HashSet<String> =
        entries.iter().map(|entry| entry.id.clone()).collect();

    if let Ok(paginated) = trading_http_api::trade_store::trades_for_bot(&bot.id, 1000, 0) {
        for rec in paginated.trades {
            if !seen_ids.insert(rec.id.clone()) {
                continue;
            }

            entries.push(TradeEntryResponse {
                id: rec.id,
                bot_id: rec.bot_id,
                timestamp: rec.timestamp.to_rfc3339(),
                action: rec.action.clone(),
                token_in: rec.token_in,
                token_out: rec.token_out,
                amount_in: rec.amount_in,
                min_amount_out: rec.min_amount_out,
                target_protocol: rec.target_protocol,
                tx_hash: rec.tx_hash,
                paper_trade: rec.paper_trade,
                status: if rec.paper_trade {
                    "executed".to_string()
                } else {
                    "confirmed".to_string()
                },
                pnl: 0.0,
                entry_price: rec
                    .entry_price_usd
                    .as_deref()
                    .and_then(parse_trade_number)
                    .unwrap_or(0.0),
                current_price: rec
                    .entry_price_usd
                    .as_deref()
                    .and_then(parse_trade_number)
                    .unwrap_or(0.0),
                amount_out: rec.amount_out,
                entry_price_usd: rec.entry_price_usd,
                notional_usd: rec.notional_usd,
                valuation_status: rec.valuation_status,
            });
        }
    }

    entries
        .into_iter()
        .map(|entry| serde_json::to_value(entry).unwrap_or(serde_json::Value::Null))
        .collect()
}

/// Verify caller is the bot's submitter.
fn verify_submitter(bot: &TradingBotRecord, caller: &str) -> Result<(), (StatusCode, String)> {
    if !bot.submitter_address.is_empty()
        && caller.to_lowercase() != bot.submitter_address.to_lowercase()
    {
        return Err((
            StatusCode::FORBIDDEN,
            format!("Caller {caller} is not the bot submitter"),
        ));
    }
    Ok(())
}

fn resolve_live_chat_target(
    caller: &str,
) -> Result<
    (
        TradingBotRecord,
        trading_blueprint_lib::operator_chat::SidecarChatTarget,
    ),
    (StatusCode, String),
> {
    let bot = resolve_singleton()?;
    verify_submitter(&bot, caller)?;
    let target = trading_blueprint_lib::operator_chat::resolve_sidecar_chat_target(&bot.sandbox_id)
        .map_err(|e| (StatusCode::CONFLICT, e))?;
    Ok((bot, target))
}

// ── Chat session proxy handlers ─────────────────────────────────────────

async fn list_chat_sessions(
    SessionAuth(caller): SessionAuth,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<Response, (StatusCode, String)> {
    let (bot, target) = resolve_live_chat_target(&caller)?;
    let include_autonomous = params
        .get("includeAutonomous")
        .is_some_and(|value| matches!(value.as_str(), "1" | "true" | "yes"));
    let scope = if include_autonomous {
        trading_blueprint_lib::operator_chat::ChatSessionScope::All
    } else {
        trading_blueprint_lib::operator_chat::ChatSessionScope::ManualOnly
    };
    trading_blueprint_lib::operator_chat::list_chat_sessions(&target, &bot.id, scope).await
}

async fn create_chat_gateway_session(
    SessionAuth(caller): SessionAuth,
    Json(body): Json<serde_json::Value>,
) -> Result<Response, (StatusCode, String)> {
    let (_bot, target) = resolve_live_chat_target(&caller)?;
    trading_blueprint_lib::operator_chat::proxy_chat_request(
        &target,
        reqwest::Method::POST,
        "/agents/sessions",
        Some(body),
        None,
    )
    .await
}

async fn get_chat_session(
    SessionAuth(caller): SessionAuth,
    Path(session_id): Path<String>,
) -> Result<Response, (StatusCode, String)> {
    let (bot, target) = resolve_live_chat_target(&caller)?;
    let _ = bot;
    trading_blueprint_lib::operator_chat::proxy_chat_request(
        &target,
        reqwest::Method::GET,
        &format!("/agents/sessions/{session_id}"),
        None,
        None,
    )
    .await
}

async fn update_chat_session(
    SessionAuth(caller): SessionAuth,
    Path(session_id): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> Result<Response, (StatusCode, String)> {
    let (bot, target) = resolve_live_chat_target(&caller)?;
    trading_blueprint_lib::operator_chat::ensure_manual_chat_session(&bot.id, &session_id)?;
    trading_blueprint_lib::operator_chat::proxy_chat_request(
        &target,
        reqwest::Method::PATCH,
        &format!("/agents/sessions/{session_id}"),
        Some(body),
        None,
    )
    .await
}

async fn delete_chat_session(
    SessionAuth(caller): SessionAuth,
    Path(session_id): Path<String>,
) -> Result<Response, (StatusCode, String)> {
    let (bot, target) = resolve_live_chat_target(&caller)?;
    trading_blueprint_lib::operator_chat::ensure_manual_chat_session(&bot.id, &session_id)?;
    trading_blueprint_lib::operator_chat::proxy_chat_request(
        &target,
        reqwest::Method::DELETE,
        &format!("/agents/sessions/{session_id}"),
        None,
        None,
    )
    .await
}

async fn list_chat_messages(
    SessionAuth(caller): SessionAuth,
    Path(session_id): Path<String>,
    RawQuery(query): RawQuery,
) -> Result<Response, (StatusCode, String)> {
    let (bot, target) = resolve_live_chat_target(&caller)?;
    let transcript_query = parse_transcript_message_query(query.as_deref());
    if let Some(run) = replayable_run_for_session(&bot, &session_id)? {
        return run_transcript_fallback_response(
            &target,
            &run,
            &transcript_query,
            query.as_deref(),
        )
        .await;
    }

    match trading_blueprint_lib::operator_chat::proxy_chat_request(
        &target,
        reqwest::Method::GET,
        &format!("/agents/sessions/{session_id}/messages"),
        None,
        query.as_deref(),
    )
    .await
    {
        Ok(response) => {
            if response.status() == StatusCode::NOT_FOUND
                && let Some(run) = replayable_run_for_session(&bot, &session_id)?
            {
                return run_transcript_fallback_response(
                    &target,
                    &run,
                    &transcript_query,
                    query.as_deref(),
                )
                .await;
            }

            Ok(response)
        }
        Err(error) => {
            if error.0 == StatusCode::BAD_GATEWAY
                && let Some(run) = replayable_run_for_session(&bot, &session_id)?
            {
                return run_transcript_fallback_response(
                    &target,
                    &run,
                    &transcript_query,
                    query.as_deref(),
                )
                .await;
            }

            Err(error)
        }
    }
}

async fn send_chat_message(
    SessionAuth(caller): SessionAuth,
    Path(session_id): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> Result<Response, (StatusCode, String)> {
    let (bot, target) = resolve_live_chat_target(&caller)?;
    trading_blueprint_lib::operator_chat::ensure_manual_chat_session(&bot.id, &session_id)?;
    trading_blueprint_lib::operator_chat::proxy_chat_request(
        &target,
        reqwest::Method::POST,
        &format!("/agents/sessions/{session_id}/messages"),
        Some(body),
        None,
    )
    .await
}

async fn abort_chat_session(
    SessionAuth(caller): SessionAuth,
    Path(session_id): Path<String>,
) -> Result<Response, (StatusCode, String)> {
    let (bot, target) = resolve_live_chat_target(&caller)?;
    trading_blueprint_lib::operator_chat::ensure_manual_chat_session(&bot.id, &session_id)?;
    trading_blueprint_lib::operator_chat::proxy_chat_request(
        &target,
        reqwest::Method::POST,
        &format!("/agents/sessions/{session_id}/abort"),
        None,
        None,
    )
    .await
}

async fn stream_chat_events(
    SessionAuth(caller): SessionAuth,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let (bot, target) = resolve_live_chat_target(&caller)?;
    let session_id = params.get("sessionId").cloned();
    let _ = bot;
    trading_blueprint_lib::operator_chat::proxy_chat_events(target, session_id).await
}

// ── Terminal relay helpers (call sidecar directly) ─────────────────────

const TERMINAL_PROMPT: &str = r"\u:\w\$ ";
const TERMINAL_SIDECAR_TIMEOUT: Duration = Duration::from_secs(60);

async fn sidecar_terminal_post(
    sandbox: &sandbox_runtime::runtime::SandboxRecord,
    path: &str,
    payload: serde_json::Value,
) -> Result<serde_json::Value, TerminalRelayError> {
    sandbox_runtime::http::sidecar_post_json(&sandbox.sidecar_url, path, &sandbox.token, payload)
        .await
        .map_err(TerminalRelayError::from)
}

async fn sidecar_terminal_get(
    sandbox: &sandbox_runtime::runtime::SandboxRecord,
    path: &str,
) -> Result<serde_json::Value, TerminalRelayError> {
    sandbox_runtime::http::sidecar_get_json(&sandbox.sidecar_url, path, &sandbox.token)
        .await
        .map_err(TerminalRelayError::from)
}

async fn sidecar_terminal_method(
    sandbox: &sandbox_runtime::runtime::SandboxRecord,
    method: reqwest::Method,
    path: &str,
    payload: Option<serde_json::Value>,
) -> Result<serde_json::Value, TerminalRelayError> {
    let url = sandbox_runtime::http::build_url(&sandbox.sidecar_url, path)
        .map_err(TerminalRelayError::from)?;
    let headers =
        sandbox_runtime::http::auth_headers(&sandbox.token).map_err(TerminalRelayError::from)?;
    let (_status, body) = sandbox_runtime::http::send_json(method, url, payload, headers)
        .await
        .map_err(TerminalRelayError::from)?;
    serde_json::from_str(&body).map_err(|e| TerminalRelayError {
        status: StatusCode::BAD_GATEWAY,
        message: format!("Invalid sidecar JSON: {e}"),
        code: None,
        retry_after_ms: None,
    })
}

fn parse_terminal_session(v: &serde_json::Value) -> Option<LiveTerminalSessionSummary> {
    let descriptor = v.get("data").unwrap_or(v);
    let id = descriptor
        .get("sessionId")
        .or_else(|| descriptor.get("session_id"))
        .or_else(|| descriptor.get("id"))
        .and_then(|v| v.as_str())?;
    Some(LiveTerminalSessionSummary {
        session_id: id.to_string(),
        title: descriptor
            .get("title")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string(),
    })
}

// ── Terminal session proxy handlers ─────────────────────────────────────

async fn list_terminal_sessions(
    SessionAuth(caller): SessionAuth,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<OperatorErrorResponse>)> {
    let target = resolve_live_terminal_target(&caller)?;
    let parsed = sidecar_terminal_get(&target.sandbox, "/terminals")
        .await
        .map_err(|err| terminal_error_response(err, &target.bot))?;
    let sessions: Vec<LiveTerminalSessionSummary> = parsed
        .get("data")
        .and_then(serde_json::Value::as_array)
        .or_else(|| parsed.as_array())
        .map(|arr| arr.iter().filter_map(parse_terminal_session).collect())
        .unwrap_or_default();
    Ok(Json(serde_json::json!({ "sessions": sessions })))
}

async fn create_terminal_session(
    SessionAuth(caller): SessionAuth,
    Json(req): Json<CreateLiveTerminalSessionRequest>,
) -> Result<Json<LiveTerminalSessionSummary>, (StatusCode, Json<OperatorErrorResponse>)> {
    let target = resolve_live_terminal_target(&caller)?;
    let mut payload = serde_json::Map::new();
    payload.insert(
        "env".into(),
        serde_json::json!({
            "PS1": TERMINAL_PROMPT,
            "PROMPT_DIRTRIM": "0",
        }),
    );
    let cwd = req.cwd.trim();
    if !cwd.is_empty() {
        payload.insert("cwd".into(), serde_json::json!(cwd));
    }
    if let Some(cols) = req.cols {
        payload.insert("cols".into(), serde_json::json!(cols));
    }
    if let Some(rows) = req.rows {
        payload.insert("rows".into(), serde_json::json!(rows));
    }
    let parsed = sidecar_terminal_post(
        &target.sandbox,
        "/terminals",
        serde_json::Value::Object(payload),
    )
    .await
    .map_err(|err| terminal_error_response(err, &target.bot))?;
    let summary = parse_terminal_session(&parsed).unwrap_or(LiveTerminalSessionSummary {
        session_id: String::new(),
        title: String::new(),
    });
    let session_id = summary.session_id;
    Ok(Json(LiveTerminalSessionSummary {
        session_id,
        title: summary.title,
    }))
}

async fn stream_terminal_session(
    SessionAuth(caller): SessionAuth,
    Path(session_id): Path<String>,
) -> Result<Response, (StatusCode, Json<OperatorErrorResponse>)> {
    let target = resolve_live_terminal_target(&caller)?;
    let stream_path = format!("/terminals/{session_id}/stream");
    let url = sandbox_runtime::http::build_url(&target.sandbox.sidecar_url, &stream_path)
        .map_err(|e| terminal_error_response(TerminalRelayError::from(e), &target.bot))?;
    let headers = sandbox_runtime::http::auth_headers(&target.sandbox.token)
        .map_err(|e| terminal_error_response(TerminalRelayError::from(e), &target.bot))?;
    let client = reqwest::Client::builder()
        .timeout(TERMINAL_SIDECAR_TIMEOUT)
        .build()
        .map_err(|e| {
            terminal_error_response(
                TerminalRelayError {
                    status: StatusCode::INTERNAL_SERVER_ERROR,
                    message: format!("HTTP client error: {e}"),
                    code: None,
                    retry_after_ms: None,
                },
                &target.bot,
            )
        })?;
    let response = client.get(url).headers(headers).send().await.map_err(|e| {
        terminal_error_response(
            TerminalRelayError {
                status: StatusCode::BAD_GATEWAY,
                message: format!("Stream request failed: {e}"),
                code: None,
                retry_after_ms: None,
            },
            &target.bot,
        )
    })?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(terminal_error_response(
            TerminalRelayError {
                status: StatusCode::BAD_GATEWAY,
                message: format!("Sidecar returned {status}: {body}"),
                code: None,
                retry_after_ms: None,
            },
            &target.bot,
        ));
    }
    use futures_util::StreamExt;
    let mut proxied = axum::response::Response::new(axum::body::Body::from_stream(
        response
            .bytes_stream()
            .map(|result| result.map_err(std::io::Error::other)),
    ));
    *proxied.status_mut() = StatusCode::OK;
    proxied.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        axum::http::HeaderValue::from_static("text/event-stream"),
    );
    Ok(proxied)
}

async fn delete_terminal_session(
    SessionAuth(caller): SessionAuth,
    Path(session_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<OperatorErrorResponse>)> {
    let target = resolve_live_terminal_target(&caller)?;
    sidecar_terminal_method(
        &target.sandbox,
        reqwest::Method::DELETE,
        &format!("/terminals/{session_id}"),
        None,
    )
    .await
    .map_err(|err| terminal_error_response(err, &target.bot))?;
    Ok(Json(
        serde_json::json!({ "deleted": true, "session_id": session_id }),
    ))
}

async fn resize_terminal_session(
    SessionAuth(caller): SessionAuth,
    Path(session_id): Path<String>,
    Json(req): Json<TerminalResizeApiRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<OperatorErrorResponse>)> {
    if let Err(message) = req.validate() {
        return Err(error_json(
            StatusCode::BAD_REQUEST,
            "operator_error",
            message,
            None,
            None,
            None,
        ));
    }

    let target = resolve_live_terminal_target(&caller)?;
    sidecar_terminal_method(
        &target.sandbox,
        reqwest::Method::PATCH,
        &format!("/terminals/{session_id}"),
        Some(serde_json::json!({
            "cols": req.cols,
            "rows": req.rows,
        })),
    )
    .await
    .map_err(|err| terminal_error_response(err, &target.bot))?;
    Ok(Json(serde_json::json!({ "success": true })))
}

async fn send_terminal_input(
    SessionAuth(caller): SessionAuth,
    Path(session_id): Path<String>,
    Json(req): Json<TerminalInputApiRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<OperatorErrorResponse>)> {
    if let Err(message) = req.validate() {
        return Err(error_json(
            StatusCode::BAD_REQUEST,
            "operator_error",
            message,
            None,
            None,
            None,
        ));
    }

    let target = resolve_live_terminal_target(&caller)?;
    sidecar_terminal_post(
        &target.sandbox,
        &format!("/terminals/{session_id}/input"),
        serde_json::json!({ "data": req.data }),
    )
    .await
    .map_err(|err| terminal_error_response(err, &target.bot))?;
    Ok(Json(serde_json::json!({ "success": true })))
}

// ── Auth handlers ───────────────────────────────────────────────────────

async fn create_challenge() -> Result<(StatusCode, Json<serde_json::Value>), (StatusCode, String)> {
    let challenge = sandbox_runtime::session_auth::create_challenge().map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Challenge error: {e}"),
        )
    })?;
    let value = serde_json::to_value(&challenge).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Serialization error: {e}"),
        )
    })?;
    Ok((StatusCode::OK, Json(value)))
}

async fn create_session(
    Json(req): Json<SessionRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), (StatusCode, String)> {
    let token =
        sandbox_runtime::session_auth::exchange_signature_for_token(&req.nonce, &req.signature)
            .map_err(|e| (StatusCode::UNAUTHORIZED, e.to_string()))?;
    Ok((StatusCode::OK, Json(serde_json::to_value(token).unwrap())))
}

async fn preflight_dex_asset_route(
    SessionAuth(_caller): SessionAuth,
    Json(request): Json<DexAssetPreflightRequest>,
) -> ApiResult<DexAssetPreflightResponse> {
    preflight_dex_asset(request)
        .await
        .map(Json)
        .map_err(|err| ApiError::message(StatusCode::BAD_REQUEST, err))
}

// ── Instance provision handler ────────────────────────────────────────────

/// Provision the singleton bot via the operator API.
///
/// This replaces the on-chain `JOB_PROVISION` for instance/TEE blueprints.
/// The vault is already created on-chain by `onServiceInitialized` when
/// `instanceMode=true`. This endpoint creates the sidecar container and
/// bot record.
async fn provision_bot(
    SessionAuth(caller): SessionAuth,
    Json(body): Json<InstanceProvisionRequest>,
) -> Result<Json<InstanceProvisionResponse>, (StatusCode, String)> {
    // Singleton check — reject if already provisioned
    if get_instance_bot_id()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .is_some()
    {
        return Err((
            StatusCode::CONFLICT,
            "Instance already provisioned — deprovision first to replace".to_string(),
        ));
    }

    let service_id = crate::context::operator_context()
        .map(|c| c.service_id)
        .unwrap_or(0);

    use blueprint_sdk::alloy::primitives::{Address, U256};

    let chain_id = body
        .chain_id
        .or_else(|| {
            std::env::var("CHAIN_ID")
                .ok()
                .and_then(|value| value.parse().ok())
        })
        .unwrap_or(1);
    let rpc_url = body
        .rpc_url
        .clone()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| std::env::var("RPC_URL").ok())
        .unwrap_or_else(|| "http://localhost:8545".to_string());

    let vault_address_raw = body
        .vault_address
        .clone()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| std::env::var("INSTANCE_VAULT_ADDRESS").ok())
        .ok_or_else(|| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "INSTANCE_VAULT_ADDRESS is not configured for the instance operator".to_string(),
            )
        })?;
    let vault_address: Address = vault_address_raw.parse().map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("Invalid vault_address '{vault_address_raw}': {e}"),
        )
    })?;

    let asset_token = match body
        .asset_token
        .clone()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| std::env::var("ASSET_TOKEN_ADDRESS").ok())
    {
        Some(raw) => raw.parse().map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                format!("Invalid asset_token '{raw}': {e}"),
            )
        })?,
        None => Address::ZERO,
    };

    let strategy_config_json = {
        let raw = body
            .strategy_config_json
            .clone()
            .unwrap_or_else(|| "{}".to_string());

        if let Some(paper_trade) = body.paper_trade {
            let trimmed = raw.trim();
            let mut parsed = if trimmed.is_empty() {
                serde_json::json!({})
            } else {
                serde_json::from_str::<serde_json::Value>(trimmed).map_err(|e| {
                    (
                        StatusCode::BAD_REQUEST,
                        format!("Invalid strategy_config_json: {e}"),
                    )
                })?
            };

            let Some(obj) = parsed.as_object_mut() else {
                return Err((
                    StatusCode::BAD_REQUEST,
                    "strategy_config_json must be a JSON object".to_string(),
                ));
            };
            obj.insert("paper_trade".into(), serde_json::Value::Bool(paper_trade));
            parsed.to_string()
        } else {
            raw
        }
    };

    // Build TradingProvisionRequest from API body with sensible defaults.
    // `factory_address` is repurposed here as a compatibility shim so the
    // shared provision flow stores the real singleton vault address without
    // changing the on-chain request ABI used by cloud mode.
    let request = trading_blueprint_lib::TradingProvisionRequest {
        name: body
            .name
            .unwrap_or_else(|| format!("Instance Bot (service {service_id})")),
        strategy_type: body.strategy_type.unwrap_or_else(|| "dex".to_string()),
        strategy_config_json,
        risk_params_json: body.risk_params_json.unwrap_or_else(|| "{}".to_string()),
        factory_address: vault_address,
        asset_token,
        signers: vec![],
        required_signatures: U256::ZERO,
        chain_id: U256::from(chain_id),
        rpc_url,
        trading_loop_cron: body
            .trading_loop_cron
            .unwrap_or_else(|| "0 */5 * * * *".to_string()),
        cpu_cores: 2,
        memory_mb: 2048,
        max_lifetime_days: 30,
        validator_service_ids: body.validator_service_ids.unwrap_or_default(),
        max_collateral_bps: U256::ZERO,
        validation_trust: 0,
    };

    // Auto-detect TEE backend (None for plain instance, Some for TEE instance)
    let tee_backend = sandbox_runtime::tee::try_tee_backend()
        .map(|b| b.as_ref() as &dyn sandbox_runtime::tee::TeeBackend);

    // Use call_id=0 for the singleton instance bot
    let call_id = 0u64;

    let output = trading_blueprint_lib::jobs::provision_core(
        request,
        None,
        call_id,
        service_id,
        caller.clone(),
        tee_backend,
        body.validation_trust,
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    // Resolve bot_id and store singleton reference
    let bot = trading_blueprint_lib::state::find_bot_by_sandbox(&output.sandbox_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    persist_instance_singleton_vault_address(&bot.id, vault_address)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    set_instance_bot_id(bot.id.clone()).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    tracing::info!(
        "Instance provisioned via operator API: bot={}, sandbox={}, caller={caller}",
        bot.id,
        output.sandbox_id,
    );

    Ok(Json(InstanceProvisionResponse {
        status: "provisioned".to_string(),
        bot_id: bot.id,
        sandbox_id: output.sandbox_id,
    }))
}

// ── Bot handlers (singleton — no bot_id path param) ─────────────────────

async fn get_bot(
    SessionAuth(_caller): SessionAuth,
) -> Result<Json<BotDetailResponse>, (StatusCode, String)> {
    let bot = resolve_singleton()?;
    Ok(Json(BotDetailResponse::from_record(bot)))
}

fn workflow_ids_for_bot(bot: &TradingBotRecord) -> Vec<u64> {
    bot.workflow_id
        .map(|workflow_id| vec![workflow_id, workflow_id + 1, workflow_id + 2])
        .unwrap_or_default()
}

fn workflow_kind_for_bot(bot: &TradingBotRecord, workflow_id: u64) -> &'static str {
    match bot.workflow_id {
        Some(base) if workflow_id == base => "trading",
        Some(base) if workflow_id == base + 1 => "research",
        Some(base) if workflow_id == base + 2 => "conversation",
        _ => "unknown",
    }
}

fn encode_run_cursor(run: &WorkflowRunRecord) -> String {
    format!("{}:{}", run.started_at, run.run_id)
}

fn parse_run_cursor(cursor: &str) -> Option<(u64, String)> {
    let (started_at, run_id) = cursor.split_once(':')?;
    Some((started_at.parse().ok()?, run_id.to_string()))
}

fn run_precedes_cursor(run: &WorkflowRunRecord, cursor: &(u64, String)) -> bool {
    run.started_at < cursor.0 || (run.started_at == cursor.0 && run.run_id < cursor.1)
}

fn latest_execution_runs_for_workflows(workflow_ids: &[u64]) -> Vec<WorkflowRunRecord> {
    workflow_ids
        .iter()
        .filter_map(|workflow_id| {
            trading_blueprint_lib::workflow_compat::latest_execution_run_for_workflow(*workflow_id)
                .ok()
                .flatten()
        })
        .collect()
}

fn map_bot_run(bot: &TradingBotRecord, run: WorkflowRunRecord) -> BotRunResponse {
    let transcript_available = run
        .session_id
        .as_deref()
        .is_some_and(|session_id| !session_id.is_empty());

    BotRunResponse {
        run_id: run.run_id,
        workflow_id: run.workflow_id,
        workflow_kind: workflow_kind_for_bot(bot, run.workflow_id).to_string(),
        status: run.status,
        started_at: run.started_at,
        completed_at: run.completed_at,
        session_id: run.session_id,
        transcript_available,
        trace_id: run.trace_id,
        duration_ms: run.duration_ms,
        input_tokens: run.input_tokens,
        output_tokens: run.output_tokens,
        result: run.result,
        error: run.error,
    }
}

#[derive(Default)]
struct TranscriptMessageQuery {
    cursor: Option<String>,
    limit: usize,
}

fn default_transcript_message_limit() -> usize {
    50
}

fn parse_transcript_message_query(query: Option<&str>) -> TranscriptMessageQuery {
    let mut parsed = TranscriptMessageQuery {
        cursor: None,
        limit: default_transcript_message_limit(),
    };

    for pair in query.unwrap_or_default().split('&') {
        let mut parts = pair.splitn(2, '=');
        let key = parts.next().unwrap_or_default();
        let value = percent_decode_query_value(parts.next().unwrap_or_default());
        match key {
            "cursor" if !value.is_empty() => parsed.cursor = Some(value),
            "limit" => {
                if let Ok(limit) = value.parse::<usize>() {
                    parsed.limit = limit;
                }
            }
            _ => {}
        }
    }

    parsed
}

fn percent_decode_query_value(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                decoded.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                let maybe_hex = std::str::from_utf8(&bytes[index + 1..index + 3])
                    .ok()
                    .and_then(|hex| u8::from_str_radix(hex, 16).ok());
                if let Some(hex) = maybe_hex {
                    decoded.push(hex);
                    index += 3;
                } else {
                    decoded.push(bytes[index]);
                    index += 1;
                }
            }
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }

    String::from_utf8(decoded).unwrap_or_else(|_| value.to_string())
}

fn replayable_run_for_session(
    bot: &TradingBotRecord,
    session_id: &str,
) -> Result<Option<WorkflowRunRecord>, (StatusCode, String)> {
    let workflow_ids = workflow_ids_for_bot(bot);
    if workflow_ids.is_empty() {
        return Ok(None);
    }

    let run =
        trading_blueprint_lib::workflow_compat::list_workflow_runs_for_workflows(&workflow_ids)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
            .into_iter()
            .find(|run| run.session_id.as_deref() == Some(session_id));

    let Some(run) = run else {
        return Ok(None);
    };

    if run.status == WorkflowRunStatus::Running {
        return Ok(None);
    }

    Ok(Some(run))
}

fn workflow_session_base_for_run(run: &WorkflowRunRecord) -> Option<String> {
    let key = ai_agent_sandbox_blueprint_lib::workflows::workflow_key(run.workflow_id);
    let entry = ai_agent_sandbox_blueprint_lib::workflows::workflows()
        .ok()?
        .get(&key)
        .ok()??;
    let workflow_json: serde_json::Value = serde_json::from_str(&entry.workflow_json).ok()?;
    workflow_json
        .get("session_id")
        .and_then(serde_json::Value::as_str)
        .filter(|session_id| !session_id.is_empty())
        .map(str::to_string)
}

fn timestamped_session_candidate(base: &str, session_id: String) -> Option<(u64, String)> {
    let suffix = session_id.strip_prefix(&format!("{base}-"))?;
    let started_at = suffix.parse::<u64>().ok()?;
    Some((started_at, session_id))
}

async fn resolve_run_transcript_session_alias(
    target: &trading_blueprint_lib::operator_chat::SidecarChatTarget,
    run: &WorkflowRunRecord,
) -> Option<String> {
    let base = workflow_session_base_for_run(run)?;
    let cutoff = run.completed_at.unwrap_or(run.started_at);
    let sessions = trading_blueprint_lib::operator_chat::list_chat_session_ids(target)
        .await
        .ok()?;

    sessions
        .into_iter()
        .filter_map(|session_id| timestamped_session_candidate(&base, session_id))
        .filter(|(started_at, _)| *started_at <= cutoff)
        .max_by_key(|(started_at, _)| *started_at)
        .map(|(_, session_id)| session_id)
}

async fn live_run_transcript_alias_response(
    target: &trading_blueprint_lib::operator_chat::SidecarChatTarget,
    run: &WorkflowRunRecord,
    query: Option<&str>,
) -> Option<Response> {
    let session_id = resolve_run_transcript_session_alias(target, run).await?;
    let response = trading_blueprint_lib::operator_chat::proxy_chat_request(
        target,
        reqwest::Method::GET,
        &format!("/agents/sessions/{session_id}/messages"),
        None,
        query,
    )
    .await
    .ok()?;

    response.status().is_success().then_some(response)
}

fn parse_transcript_cursor(cursor: &str) -> Option<usize> {
    cursor.parse::<usize>().ok()
}

fn replay_transcript_messages_response(
    messages: serde_json::Value,
    query: &TranscriptMessageQuery,
) -> Response {
    let Some(messages) = messages.as_array() else {
        return Json(messages).into_response();
    };

    let limit = query.limit;
    let end = query
        .cursor
        .as_deref()
        .and_then(parse_transcript_cursor)
        .unwrap_or(messages.len())
        .min(messages.len());
    let start = end.saturating_sub(limit);
    let page = messages[start..end].to_vec();
    let next_cursor = (start > 0).then(|| start.to_string());

    if query.cursor.is_some() || next_cursor.is_some() {
        Json(serde_json::json!({
            "messages": page,
            "next_cursor": next_cursor,
        }))
        .into_response()
    } else {
        Json(page).into_response()
    }
}

async fn run_transcript_fallback_response(
    target: &trading_blueprint_lib::operator_chat::SidecarChatTarget,
    run: &WorkflowRunRecord,
    query: &TranscriptMessageQuery,
    raw_query: Option<&str>,
) -> Result<Response, (StatusCode, String)> {
    let transcript =
        trading_blueprint_lib::workflow_compat::get_workflow_run_transcript(&run.run_id)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let messages = if let Some(record) = transcript {
        record.messages
    } else if let Some(response) = live_run_transcript_alias_response(target, run, raw_query).await
    {
        return Ok(response);
    } else {
        synthesize_run_transcript_messages(run)
    };

    Ok(replay_transcript_messages_response(messages, query))
}

fn synthesize_run_transcript_messages(run: &WorkflowRunRecord) -> serde_json::Value {
    let timestamp = run.completed_at.unwrap_or(run.started_at);
    let text = if let Some(result) = run.result.as_deref() {
        format!(
            "Stored transcript was unavailable, so this view is replaying the saved run summary.\n\n{result}"
        )
    } else if let Some(error) = run.error.as_deref() {
        format!(
            "Stored transcript was unavailable, so this view is replaying the saved run outcome.\n\n{error}"
        )
    } else {
        "Stored transcript was unavailable for this run.".to_string()
    };

    serde_json::json!([
        {
            "info": {
                "id": format!("run-summary-{}", run.run_id),
                "role": "assistant",
                "timestamp": timestamp,
            },
            "parts": [
                {
                    "type": "text",
                    "text": text,
                }
            ]
        }
    ])
}

async fn list_bot_runs(
    SessionAuth(_caller): SessionAuth,
    Query(params): Query<RunListQuery>,
) -> Result<Json<BotRunListResponse>, (StatusCode, String)> {
    let bot = resolve_singleton()?;
    let workflow_ids = workflow_ids_for_bot(&bot);
    if workflow_ids.is_empty() {
        return Ok(Json(BotRunListResponse {
            runs: Vec::new(),
            next_cursor: None,
        }));
    }

    let limit = params.limit.unwrap_or(100).clamp(1, 500);
    let cursor = params.cursor.as_deref().and_then(parse_run_cursor);

    let mut runs =
        trading_blueprint_lib::workflow_compat::list_workflow_runs_for_workflows(&workflow_ids)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    for latest_run in latest_execution_runs_for_workflows(&workflow_ids) {
        if !runs.iter().any(|run| run.run_id == latest_run.run_id) {
            runs.push(latest_run);
        }
    }
    runs.sort_by(|a, b| {
        b.started_at
            .cmp(&a.started_at)
            .then_with(|| b.run_id.cmp(&a.run_id))
    });

    if let Some(cursor) = cursor.as_ref() {
        runs.retain(|run| run_precedes_cursor(run, cursor));
    }

    let has_more = runs.len() > limit;
    runs.truncate(limit);
    let next_cursor = if has_more {
        runs.last().map(encode_run_cursor)
    } else {
        None
    };

    Ok(Json(BotRunListResponse {
        runs: runs.into_iter().map(|run| map_bot_run(&bot, run)).collect(),
        next_cursor,
    }))
}

async fn get_bot_run(
    SessionAuth(_caller): SessionAuth,
    Path(run_id): Path<String>,
) -> Result<Json<BotRunResponse>, (StatusCode, String)> {
    let bot = resolve_singleton()?;
    let workflow_ids = workflow_ids_for_bot(&bot)
        .into_iter()
        .collect::<HashSet<_>>();
    let run = trading_blueprint_lib::workflow_compat::get_workflow_run(&run_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .or_else(|| {
            workflow_ids
                .iter()
                .find_map(|workflow_id| {
                    trading_blueprint_lib::workflow_compat::latest_execution_run_for_workflow(
                        *workflow_id,
                    )
                    .ok()
                    .flatten()
                })
                .filter(|run| run.run_id == run_id)
        })
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Run not found".to_string()))?;

    if !workflow_ids.contains(&run.workflow_id) {
        return Err((StatusCode::NOT_FOUND, "Run not found".to_string()));
    }

    Ok(Json(map_bot_run(&bot, run)))
}

// ── Secrets handlers ────────────────────────────────────────────────────

async fn configure_secrets(
    SessionAuth(caller): SessionAuth,
    Json(body): Json<ConfigureSecretsRequest>,
) -> ApiResult<SecretsResponse> {
    let bot = resolve_singleton_live()?;
    verify_submitter(&bot, &caller)?;

    // When env_json is empty, use operator-provided AI keys from the binary's environment.
    let env_json = if body.env_json.is_empty() {
        let mut env = serde_json::Map::new();
        let providers: &[(&str, &str, &str, &str)] = &[
            (
                "ANTHROPIC_API_KEY",
                "anthropic",
                "claude-sonnet-4-6",
                "ANTHROPIC_API_KEY",
            ),
            ("ZAI_API_KEY", "zai-coding-plan", "glm-4.7", "ZAI_API_KEY"),
            (
                "TANGLE_ROUTER_API_KEY",
                "openrouter",
                "anthropic/claude-sonnet-4-6",
                "TANGLE_ROUTER_API_KEY",
            ),
        ];
        let mut found = false;
        for &(env_var, model_provider, model_name, native_key) in providers {
            if let Ok(key) = std::env::var(env_var)
                && !key.is_empty()
            {
                env.insert("OPENCODE_MODEL_PROVIDER".into(), model_provider.into());
                env.insert("OPENCODE_MODEL_NAME".into(), model_name.into());
                env.insert("OPENCODE_MODEL_API_KEY".into(), key.clone().into());
                if env_var == "TANGLE_ROUTER_API_KEY" {
                    let base_url = std::env::var("TANGLE_ROUTER_BASE_URL")
                        .unwrap_or_else(|_| "https://router.tangle.tools/v1".to_string());
                    env.insert("TANGLE_ROUTER_BASE_URL".into(), base_url.clone().into());
                    env.insert("OPENCODE_MODEL_BASE_URL".into(), base_url.into());
                }
                env.insert(native_key.into(), key.into());
                found = true;
                tracing::info!("Using operator-provided {env_var} for instance bot");
                break;
            }
        }
        if !found {
            return Err(ApiError::message(
                StatusCode::BAD_REQUEST,
                "No API keys provided and operator has no pre-configured AI keys. \
                 Set ANTHROPIC_API_KEY, ZAI_API_KEY, or TANGLE_ROUTER_API_KEY in the operator environment.",
            ));
        }
        env
    } else {
        body.env_json
    };

    let result = trading_blueprint_lib::jobs::activate_bot_with_secrets(&bot.id, env_json, None)
        .await
        .map_err(|e| ApiError::message(StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(SecretsResponse {
        status: "active".to_string(),
        sandbox_id: Some(result.sandbox_id),
        workflow_id: Some(result.workflow_id.to_string()),
    }))
}

async fn get_secrets(
    SessionAuth(caller): SessionAuth,
) -> Result<Json<GetSecretsResponse>, (StatusCode, String)> {
    let bot = resolve_singleton()?;
    verify_submitter(&bot, &caller)?;

    let sandbox = sandbox_runtime::runtime::get_sandbox_by_id(&bot.sandbox_id)
        .map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;
    let env_json = if sandbox.user_env_json.trim().is_empty() {
        serde_json::Map::new()
    } else {
        serde_json::from_str(&sandbox.user_env_json).unwrap_or_default()
    };

    Ok(Json(GetSecretsResponse {
        sandbox_id: sandbox.id,
        env_json,
    }))
}

async fn wipe_secrets(
    SessionAuth(caller): SessionAuth,
) -> Result<Json<SecretsResponse>, (StatusCode, String)> {
    let bot = resolve_singleton()?;
    verify_submitter(&bot, &caller)?;

    trading_blueprint_lib::jobs::wipe_bot_secrets(&bot.id, None)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(SecretsResponse {
        status: "awaiting_secrets".to_string(),
        sandbox_id: None,
        workflow_id: None,
    }))
}

// ── Bot control handlers ────────────────────────────────────────────────

async fn start_bot(SessionAuth(caller): SessionAuth) -> ApiResult<BotControlResponse> {
    let bot = resolve_singleton_live()?;
    verify_submitter(&bot, &caller)?;

    trading_blueprint_lib::jobs::start_core(&bot.sandbox_id, false)
        .await
        .map_err(|e| ApiError::message(StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(BotControlResponse {
        status: "started".to_string(),
        sandbox_id: bot.sandbox_id,
    }))
}

async fn stop_bot(SessionAuth(caller): SessionAuth) -> ApiResult<BotControlResponse> {
    let bot = resolve_singleton_live()?;
    verify_submitter(&bot, &caller)?;

    trading_blueprint_lib::jobs::stop_core(&bot.sandbox_id, false)
        .await
        .map_err(|e| ApiError::message(StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(BotControlResponse {
        status: "stopped".to_string(),
        sandbox_id: bot.sandbox_id,
    }))
}

async fn run_now(
    SessionAuth(caller): SessionAuth,
) -> Result<Json<RunNowResponse>, (StatusCode, String)> {
    let bot = resolve_singleton()?;
    let runtime = state::bot_runtime_status(&bot);
    verify_submitter(&bot, &caller)?;

    if runtime.lifecycle_status.as_str() != "active" {
        return Err((StatusCode::CONFLICT, "Bot is not active".to_string()));
    }

    let workflow_id = bot.workflow_id.ok_or_else(|| {
        (
            StatusCode::CONFLICT,
            "Bot has no workflow configured".to_string(),
        )
    })?;

    let wf_key = ai_agent_sandbox_blueprint_lib::workflows::workflow_key(workflow_id);
    let entry = ai_agent_sandbox_blueprint_lib::workflows::workflows()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .get(&wf_key)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                format!("Workflow {workflow_id} not found"),
            )
        })?;

    if let Err(err) =
        trading_blueprint_lib::workflow_compat::backfill_latest_execution_run(workflow_id)
    {
        tracing::warn!(
            workflow_id,
            error = %err,
            "Failed to backfill workflow run history before instance manual run"
        );
    }

    let execution = match ai_agent_sandbox_blueprint_lib::workflows::run_workflow(&entry).await {
        Ok(execution) => execution,
        Err(err) => {
            match ai_agent_sandbox_blueprint_lib::workflows::store_failed_execution(
                workflow_id,
                err.clone(),
            ) {
                Ok(latest_execution) => {
                    if let Err(persist_err) =
                        trading_blueprint_lib::workflow_compat::persist_latest_execution_run(
                            workflow_id,
                            latest_execution,
                        )
                    {
                        tracing::warn!(
                            workflow_id,
                            error = %persist_err,
                            "Failed to persist failed instance workflow run history"
                        );
                    }
                }
                Err(store_err) => {
                    tracing::warn!(
                        workflow_id,
                        error = %store_err,
                        "Failed to store failed instance workflow latest execution"
                    );
                }
            }
            return Err((StatusCode::INTERNAL_SERVER_ERROR, err));
        }
    };

    let latest_execution = execution.latest_execution.clone();
    if let Err(err) = ai_agent_sandbox_blueprint_lib::workflows::store_latest_execution(
        workflow_id,
        latest_execution.clone(),
    ) {
        tracing::warn!(
            workflow_id,
            error = %err,
            "Failed to store instance workflow latest execution"
        );
    }
    if let Err(err) = trading_blueprint_lib::workflow_compat::persist_latest_execution_run(
        workflow_id,
        latest_execution,
    ) {
        tracing::warn!(
            workflow_id,
            error = %err,
            "Failed to persist instance workflow run history"
        );
    }

    let last_run_at = execution.last_run_at;
    let next_run_at = execution.next_run_at;
    let _ = ai_agent_sandbox_blueprint_lib::workflows::workflows()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .update(&wf_key, |e| {
            e.last_run_at = Some(last_run_at);
            e.next_run_at = next_run_at;
        });

    Ok(Json(RunNowResponse {
        status: "executed".to_string(),
        workflow_id: workflow_id.to_string(),
        response: execution.response,
    }))
}

async fn update_config(
    SessionAuth(caller): SessionAuth,
    Json(body): Json<UpdateConfigRequest>,
) -> ApiResult<ConfigResponse> {
    let bot = resolve_singleton_live()?;
    verify_submitter(&bot, &caller)?;

    trading_blueprint_lib::jobs::configure_core(
        &bot.sandbox_id,
        body.strategy_config_json.as_deref().unwrap_or(""),
        body.risk_params_json.as_deref().unwrap_or(""),
    )
    .await
    .map_err(|e| ApiError::message(StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(ConfigResponse {
        status: "configured".to_string(),
    }))
}

// ── Metrics / trades helpers ────────────────────────────────────────────

fn synthesize_metrics(
    bot: &TradingBotRecord,
    trades: &[serde_json::Value],
) -> Vec<MetricsSnapshotResponse> {
    const INITIAL_VALUE: f64 = 10_000.0;
    let mut snapshots = Vec::new();

    let start_ts = chrono::DateTime::from_timestamp(bot.created_at as i64, 0)
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());

    snapshots.push(MetricsSnapshotResponse {
        timestamp: start_ts,
        bot_id: bot.id.clone(),
        account_value_usd: INITIAL_VALUE,
        unrealized_pnl: 0.0,
        realized_pnl: 0.0,
        high_water_mark: INITIAL_VALUE,
        drawdown_pct: 0.0,
        positions_count: 0,
        trade_count: 0,
    });

    if trades.is_empty() {
        snapshots.push(MetricsSnapshotResponse {
            timestamp: chrono::Utc::now().to_rfc3339(),
            bot_id: bot.id.clone(),
            account_value_usd: INITIAL_VALUE,
            unrealized_pnl: 0.0,
            realized_pnl: 0.0,
            high_water_mark: INITIAL_VALUE,
            drawdown_pct: 0.0,
            positions_count: 0,
            trade_count: 0,
        });
        return snapshots;
    }

    let mut sorted: Vec<&serde_json::Value> = trades.iter().collect();
    sorted.sort_by(|a, b| {
        let ta = a.get("created_at").and_then(|v| v.as_str()).unwrap_or("");
        let tb = b.get("created_at").and_then(|v| v.as_str()).unwrap_or("");
        ta.cmp(tb)
    });

    let mut running_pnl = 0.0;
    let mut hwm = INITIAL_VALUE;

    for (i, trade) in sorted.iter().enumerate() {
        let pnl = trade.get("pnl").and_then(|v| v.as_f64()).unwrap_or(0.0);
        running_pnl += pnl;
        let val = INITIAL_VALUE + running_pnl;
        if val > hwm {
            hwm = val;
        }

        let open_count = sorted[..=i]
            .iter()
            .filter(|t| t.get("status").and_then(|v| v.as_str()) == Some("open"))
            .count() as u32;

        let realized: f64 = sorted[..=i]
            .iter()
            .filter(|t| t.get("status").and_then(|v| v.as_str()) != Some("open"))
            .filter_map(|t| t.get("pnl").and_then(|v| v.as_f64()))
            .sum();

        let unrealized: f64 = sorted[..=i]
            .iter()
            .filter(|t| t.get("status").and_then(|v| v.as_str()) == Some("open"))
            .filter_map(|t| t.get("pnl").and_then(|v| v.as_f64()))
            .sum();

        let ts = trade
            .get("created_at")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let dd = if hwm > 0.0 {
            ((hwm - val) / hwm) * 100.0
        } else {
            0.0
        };

        snapshots.push(MetricsSnapshotResponse {
            timestamp: if ts.is_empty() {
                chrono::Utc::now().to_rfc3339()
            } else {
                ts
            },
            bot_id: bot.id.clone(),
            account_value_usd: val,
            unrealized_pnl: unrealized,
            realized_pnl: realized,
            high_water_mark: hwm,
            drawdown_pct: dd,
            positions_count: open_count,
            trade_count: (i + 1) as u32,
        });
    }

    snapshots
}

// ── Metrics / trades handlers ───────────────────────────────────────────

async fn get_bot_metrics(
    SessionAuth(_caller): SessionAuth,
) -> Result<Json<BotMetricsResponse>, (StatusCode, String)> {
    let bot = resolve_singleton()?;
    let metrics_history = match fetch_trading_api_json(&bot, "/metrics/history", &[]).await {
        Ok(Some(payload)) => extract_json_array(payload, "snapshots")
            .and_then(parse_metrics_snapshots)
            .unwrap_or_else(|err| {
                tracing::warn!(bot_id = %bot.id, "invalid trading api metrics payload: {err}");
                fallback_metrics_snapshots(&bot)
            }),
        Ok(None) => fallback_metrics_snapshots(&bot),
        Err(err) => {
            tracing::warn!(bot_id = %bot.id, "trading api metrics request failed, using fallback: {err}");
            fallback_metrics_snapshots(&bot)
        }
    };
    let latest_snapshot = metrics_history.last();
    let (trades, trade_count) =
        match fetch_trading_api_json(&bot, "/trades", &[("limit", "500".to_string())]).await {
            Ok(Some(payload)) => {
                let remote_total = payload_trade_total(&payload);
                let trades = extract_json_array(payload, "trades")
                    .unwrap_or_else(|_| fallback_trade_dataset(&bot));
                let trade_count = remote_total.unwrap_or(0).max(trades.len() as u32);
                (trades, trade_count)
            }
            Ok(None) | Err(_) => {
                let trades = fallback_trade_dataset(&bot);
                let trade_count = trades.len() as u32;
                (trades, trade_count)
            }
        };

    let total_pnl: f64 = trades
        .iter()
        .filter_map(|t| t.get("pnl").and_then(|v| v.as_f64()))
        .sum();

    let fallback_portfolio = || {
        fallback_portfolio_state(&bot)
            .total_value_usd
            .unwrap_or(0.0)
    };
    let portfolio_value_usd = match fetch_trading_api_json_with_method(
        &bot,
        reqwest::Method::POST,
        "/portfolio/state",
        &[],
    )
    .await
    {
        Ok(Some(payload)) => map_trading_api_portfolio(payload)
            .ok()
            .map(|portfolio| {
                if portfolio.has_unpriced_positions {
                    0.0
                } else {
                    portfolio.total_value_usd.unwrap_or(0.0)
                }
            })
            .or_else(|| latest_snapshot.map(|snapshot| snapshot.account_value_usd))
            .unwrap_or_else(fallback_portfolio),
        Ok(None) | Err(_) => latest_snapshot
            .map(|snapshot| snapshot.account_value_usd)
            .unwrap_or_else(fallback_portfolio),
    };

    Ok(Json(BotMetricsResponse {
        portfolio_value_usd,
        total_pnl: latest_snapshot
            .map(|snapshot| snapshot.realized_pnl + snapshot.unrealized_pnl)
            .unwrap_or(total_pnl),
        trade_count: latest_snapshot
            .map(|snapshot| snapshot.trade_count)
            .unwrap_or(0)
            .max(trade_count),
    }))
}

async fn get_bot_metrics_history(
    SessionAuth(_caller): SessionAuth,
) -> Result<Json<Vec<serde_json::Value>>, (StatusCode, String)> {
    let bot = resolve_singleton()?;
    match fetch_trading_api_json(&bot, "/metrics/history", &[]).await {
        Ok(Some(payload)) => match extract_json_array(payload, "snapshots") {
            Ok(mut snapshots) if !snapshots.is_empty() => {
                if let Some(trade_count) = fetch_remote_trade_count(&bot).await {
                    patch_latest_snapshot_trade_count(&mut snapshots, trade_count);
                }
                Ok(Json(snapshots))
            }
            Ok(_) => Ok(Json(fallback_metrics_history(&bot))),
            Err(err) => {
                tracing::warn!(bot_id = %bot.id, "invalid trading api metrics payload: {err}");
                Ok(Json(fallback_metrics_history(&bot)))
            }
        },
        Ok(None) => Ok(Json(fallback_metrics_history(&bot))),
        Err(err) => {
            tracing::warn!(bot_id = %bot.id, "trading api metrics request failed: {err}");
            Ok(Json(fallback_metrics_history(&bot)))
        }
    }
}

async fn get_bot_trades(
    SessionAuth(_caller): SessionAuth,
    Query(query): Query<TradeListQuery>,
) -> Result<Json<Vec<serde_json::Value>>, (StatusCode, String)> {
    let bot = resolve_singleton()?;
    let mut remote_query = Vec::new();
    if let Some(limit) = query.limit {
        remote_query.push(("limit", limit.to_string()));
    }
    if let Some(offset) = query.offset {
        remote_query.push(("offset", offset.to_string()));
    }

    match fetch_trading_api_json(&bot, "/trades", &remote_query).await {
        Ok(Some(payload)) => match extract_json_array(payload, "trades") {
            Ok(trades) => Ok(Json(trades)),
            Err(err) => {
                tracing::warn!(bot_id = %bot.id, "invalid trading api trades payload: {err}");
                Ok(Json(fallback_trade_history(&bot)))
            }
        },
        Ok(None) => Ok(Json(fallback_trade_history(&bot))),
        Err(err) => {
            tracing::warn!(bot_id = %bot.id, "trading api trades request failed, using fallback: {err}");
            Ok(Json(fallback_trade_history(&bot)))
        }
    }
}

async fn get_bot_market_candles(
    SessionAuth(_caller): SessionAuth,
    Query(query): Query<CandleListQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let bot = resolve_singleton()?;
    let mut remote_query = Vec::new();
    if let Some(token) = query.token {
        remote_query.push(("token", token));
    }
    if let Some(from) = query.from {
        remote_query.push(("from", from.to_string()));
    }
    if let Some(to) = query.to {
        remote_query.push(("to", to.to_string()));
    }
    if let Some(limit) = query.limit {
        remote_query.push(("limit", limit.to_string()));
    }

    match fetch_trading_api_json(&bot, "/market-data/candles", &remote_query).await {
        Ok(Some(payload)) => Ok(Json(payload)),
        Ok(None) => Ok(Json(serde_json::json!({ "candles": [], "total": 0 }))),
        Err(err) => {
            tracing::warn!(bot_id = %bot.id, "trading api candle request failed: {err}");
            Ok(Json(serde_json::json!({ "candles": [], "total": 0 })))
        }
    }
}

async fn get_platform_volume(
    Query(query): Query<trading_http_api::routes::trades::PlatformVolumeQuery>,
) -> Result<Json<trading_http_api::trade_store::PlatformVolumeResponse>, (StatusCode, String)> {
    trading_http_api::routes::trades::resolve_platform_volume(&query).map(Json)
}

async fn get_bot_portfolio(
    SessionAuth(_caller): SessionAuth,
) -> Result<Json<PortfolioStateResponse>, (StatusCode, String)> {
    let bot = resolve_singleton()?;
    let runtime_status = state::bot_runtime_status(&bot);
    if !matches!(
        runtime_status.lifecycle_status,
        state::BotLifecycleStatus::Active | state::BotLifecycleStatus::WindingDown
    ) {
        return Ok(Json(PortfolioStateResponse {
            total_value_usd: Some(0.0),
            cash_balance: None,
            warnings: Vec::new(),
            has_unpriced_positions: false,
            positions: Vec::new(),
        }));
    }

    match fetch_trading_api_json_with_method(&bot, reqwest::Method::POST, "/portfolio/state", &[])
        .await
    {
        Ok(Some(payload)) => match map_trading_api_portfolio(payload) {
            Ok(portfolio) => Ok(Json(portfolio)),
            Err(err) => {
                tracing::warn!(bot_id = %bot.id, "invalid trading api portfolio payload: {err}");
                Ok(Json(fallback_portfolio_state(&bot)))
            }
        },
        Ok(None) => Ok(Json(fallback_portfolio_state(&bot))),
        Err(err) => {
            tracing::warn!(bot_id = %bot.id, "trading api portfolio request failed, using fallback: {err}");
            Ok(Json(fallback_portfolio_state(&bot)))
        }
    }
}

// ── Activation progress handler ─────────────────────────────────────────

async fn get_activation_progress(
    SessionAuth(_caller): SessionAuth,
) -> Result<Json<ActivationProgressResponse>, (StatusCode, String)> {
    let bot = resolve_singleton()?;
    let progress = state::get_activation(&bot.id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "No activation progress".to_string()))?;

    Ok(Json(ActivationProgressResponse::from(progress)))
}

// ── Provision handlers ──────────────────────────────────────────────────

async fn list_provisions(
    SessionAuth(_caller): SessionAuth,
) -> Result<Json<ProvisionListResponse>, (StatusCode, String)> {
    let all = sandbox_runtime::provision_progress::list_all_provisions()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(ProvisionListResponse {
        provisions: all
            .into_iter()
            .map(ProvisionProgressResponse::from)
            .collect(),
    }))
}

async fn get_provision(
    SessionAuth(_caller): SessionAuth,
    axum::extract::Path(call_id): axum::extract::Path<u64>,
) -> Result<Json<ProvisionProgressResponse>, (StatusCode, String)> {
    let progress = sandbox_runtime::provision_progress::get_provision(call_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                format!("No provision for call_id {call_id}"),
            )
        })?;

    Ok(Json(ProvisionProgressResponse::from(progress)))
}

// ── Pricing handlers ────────────────────────────────────────────────────

async fn pricing_quote(Json(body): Json<PricingQuoteRequest>) -> Json<serde_json::Value> {
    let blueprint_id = body.blueprint_id.as_deref().unwrap_or("0");
    let ttl_blocks = body.ttl_blocks.as_deref().unwrap_or("100");
    let timestamp = body.challenge_timestamp.as_deref().unwrap_or("0");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let expiry = now + 3600;
    let operator_address = std::env::var("OPERATOR_ADDRESS").unwrap_or_default();

    Json(serde_json::json!({
        "operator": operator_address,
        "total_cost": "0",
        "signature": "0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
        "cost_rate": 0.0,
        "details": {
            "blueprint_id": blueprint_id,
            "ttl_blocks": ttl_blocks,
            "total_cost": "0",
            "timestamp": timestamp,
            "expiry": expiry.to_string(),
            "security_commitments": [],
        },
    }))
}

async fn pricing_job_quote(Json(body): Json<JobQuoteRequest>) -> Json<serde_json::Value> {
    let service_id = body.service_id.as_deref().unwrap_or("0");
    let job_index = body.job_index.unwrap_or(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let expiry = now + 3600;
    let timestamp = body.challenge_timestamp.as_deref().unwrap_or("0");
    let operator_address = std::env::var("OPERATOR_ADDRESS").unwrap_or_default();

    // tnt-core v0.13.0: every job quote MUST commit to a non-zero requester.
    // This REST endpoint is informational (real signing happens in the gRPC
    // pricing engine), but we still surface the requester so clients exercising
    // the JSON path notice a missing field early. Default to address(0) so the
    // on-chain verifier rejects, not silently accepts a wildcard.
    let requester = body.requester.as_deref().unwrap_or_else(|| {
        tracing::warn!(
            "pricing_job_quote: requester field omitted — quote would be rejected on-chain"
        );
        "0x0000000000000000000000000000000000000000"
    });

    Json(serde_json::json!({
        "operator": operator_address,
        "total_cost": "0",
        "signature": "0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
        "cost_rate": 0.0,
        "details": {
            "requester": requester,
            "service_id": service_id,
            "job_index": job_index,
            "price": "0",
            "timestamp": timestamp,
            "expiry": expiry.to_string(),
        },
    }))
}

// ── Debug handlers ──────────────────────────────────────────────────────

async fn debug_sandboxes(SessionAuth(_caller): SessionAuth) -> Json<serde_json::Value> {
    match sandbox_runtime::runtime::sandboxes() {
        Ok(store) => match store.values() {
            Ok(records) => {
                let list: Vec<serde_json::Value> = records
                    .iter()
                    .map(|r| {
                        serde_json::json!({
                            "id": r.id,
                            "container_id": &r.container_id[..r.container_id.len().min(12)],
                            "sidecar_url": r.sidecar_url,
                            "token_len": r.token.len(),
                            "state": format!("{:?}", r.state),
                        })
                    })
                    .collect();
                Json(serde_json::json!({ "count": list.len(), "sandboxes": list }))
            }
            Err(e) => Json(serde_json::json!({ "error": format!("values() failed: {e}") })),
        },
        Err(e) => Json(serde_json::json!({ "error": format!("sandboxes() failed: {e}") })),
    }
}

async fn debug_state_health(
    SessionAuth(_caller): SessionAuth,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let health = state::bot_state_health().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(serde_json::json!(health)))
}

async fn debug_workflows(SessionAuth(_caller): SessionAuth) -> Json<serde_json::Value> {
    match ai_agent_sandbox_blueprint_lib::workflows::workflows() {
        Ok(store) => match store.values() {
            Ok(entries) => {
                let list: Vec<serde_json::Value> = entries
                    .iter()
                    .map(|e| {
                        let spec: Result<serde_json::Value, _> =
                            serde_json::from_str(&e.workflow_json);
                        let sidecar_url = spec
                            .as_ref()
                            .ok()
                            .and_then(|v| v["sidecar_url"].as_str())
                            .unwrap_or("unknown");
                        serde_json::json!({
                            "id": e.id,
                            "name": e.name,
                            "active": e.active,
                            "trigger_type": e.trigger_type,
                            "trigger_config": e.trigger_config,
                            "next_run_at": e.next_run_at,
                            "last_run_at": e.last_run_at,
                            "sidecar_url": sidecar_url,
                        })
                    })
                    .collect();
                Json(serde_json::json!({ "count": list.len(), "workflows": list }))
            }
            Err(e) => Json(serde_json::json!({ "error": format!("values() failed: {e}") })),
        },
        Err(e) => Json(serde_json::json!({ "error": format!("workflows() failed: {e}") })),
    }
}

async fn debug_run_now(
    SessionAuth(_caller): SessionAuth,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let bot = resolve_singleton()?;

    let workflow_id = bot
        .workflow_id
        .ok_or_else(|| (StatusCode::CONFLICT, "Bot has no workflow".to_string()))?;

    let wf_key = ai_agent_sandbox_blueprint_lib::workflows::workflow_key(workflow_id);
    let entry = ai_agent_sandbox_blueprint_lib::workflows::workflows()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .get(&wf_key)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                format!("Workflow {workflow_id} not found"),
            )
        })?;

    if let Err(err) =
        trading_blueprint_lib::workflow_compat::backfill_latest_execution_run(workflow_id)
    {
        tracing::warn!(
            workflow_id,
            error = %err,
            "Failed to backfill workflow run history before instance debug run"
        );
    }

    let execution = match ai_agent_sandbox_blueprint_lib::workflows::run_workflow(&entry).await {
        Ok(execution) => execution,
        Err(err) => {
            match ai_agent_sandbox_blueprint_lib::workflows::store_failed_execution(
                workflow_id,
                err.clone(),
            ) {
                Ok(latest_execution) => {
                    if let Err(persist_err) =
                        trading_blueprint_lib::workflow_compat::persist_latest_execution_run(
                            workflow_id,
                            latest_execution,
                        )
                    {
                        tracing::warn!(
                            workflow_id,
                            error = %persist_err,
                            "Failed to persist failed instance debug workflow run history"
                        );
                    }
                }
                Err(store_err) => {
                    tracing::warn!(
                        workflow_id,
                        error = %store_err,
                        "Failed to store failed instance debug workflow latest execution"
                    );
                }
            }
            return Err((StatusCode::INTERNAL_SERVER_ERROR, err));
        }
    };

    let latest_execution = execution.latest_execution.clone();
    if let Err(err) = ai_agent_sandbox_blueprint_lib::workflows::store_latest_execution(
        workflow_id,
        latest_execution.clone(),
    ) {
        tracing::warn!(
            workflow_id,
            error = %err,
            "Failed to store instance debug workflow latest execution"
        );
    }
    if let Err(err) = trading_blueprint_lib::workflow_compat::persist_latest_execution_run(
        workflow_id,
        latest_execution,
    ) {
        tracing::warn!(
            workflow_id,
            error = %err,
            "Failed to persist instance debug workflow run history"
        );
    }

    let last_run_at = execution.last_run_at;
    let next_run_at = execution.next_run_at;
    let _ = ai_agent_sandbox_blueprint_lib::workflows::workflows()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .update(&wf_key, |e| {
            e.last_run_at = Some(last_run_at);
            e.next_run_at = next_run_at;
        });

    Ok(Json(serde_json::json!({
        "status": "executed",
        "workflow_id": workflow_id.to_string(),
        "response": execution.response,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use http_body_util::BodyExt;
    use hyper::Request;
    use tower::ServiceExt;

    fn make_trade_record(
        token_in: &str,
        token_out: &str,
        amount_in: &str,
        min_amount_out: &str,
    ) -> trading_http_api::trade_store::TradeRecord {
        trading_http_api::trade_store::TradeRecord {
            id: "trade-1".to_string(),
            bot_id: "bot-1".to_string(),
            timestamp: chrono::Utc::now(),
            action: "swap".to_string(),
            token_in: token_in.to_string(),
            token_out: token_out.to_string(),
            amount_in: amount_in.to_string(),
            min_amount_out: min_amount_out.to_string(),
            target_protocol: "uniswap_v3".to_string(),
            tx_hash: "0xpaper".to_string(),
            block_number: Some(0),
            gas_used: Some("0".to_string()),
            paper_trade: true,
            execution_status: None,
            clob_order_id: None,
            amount_out: None,
            entry_price_usd: None,
            notional_usd: None,
            requested_price_usd: None,
            filled_price_usd: None,
            filled_amount: None,
            valuation_status: trading_http_api::trade_store::TradeValuationStatus::Unpriced,
            slippage_bps: None,
            execution_reason: None,
            prediction_metadata: None,
            hyperliquid_metadata: None,
            validation: trading_http_api::trade_store::StoredValidation {
                approved: true,
                aggregate_score: 100,
                intent_hash: "0xintent".to_string(),
                responses: Vec::new(),
                simulation: None,
            },
            signal_price: None,
            fill_price: None,
            signal_to_fill_ms: None,
            decision_source: None,
            runner_signal: None,
            agent_reasoning: None,
            harness_version: None,
            candidate_hash: None,
            revision_id: None,
            risk_budget_decision_id: None,
            paper_pnl_pct: None,
            paper_equity_after: None,
        }
    }

    fn test_auth_header() -> String {
        let token = sandbox_runtime::session_auth::create_test_token(
            "0x1234567890abcdef1234567890abcdef12345678",
        );
        format!("Bearer {token}")
    }

    #[tokio::test]
    async fn test_get_bot_not_provisioned() {
        let tmp = tempfile::tempdir().unwrap();
        unsafe { std::env::set_var("BLUEPRINT_STATE_DIR", tmp.path()) };

        let app = build_instance_router();

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/bot")
                    .header("authorization", test_auth_header())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), 404);
    }

    #[tokio::test]
    async fn test_get_bot_market_candles_requires_auth() {
        let app = build_instance_router();

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/bot/market-data/candles?token=ETH")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn test_platform_volume_route_returns_aggregate_shape() {
        let tmp = tempfile::tempdir().unwrap();
        unsafe { std::env::set_var("BLUEPRINT_STATE_DIR", tmp.path()) };

        let app = build_instance_router();

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/platform/volume?bucket=day")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(json["buckets"].is_array());
        assert!(json["summary"]["total_usd"].is_number());
    }

    #[tokio::test]
    async fn test_auth_challenge_returns_nonce() {
        let app = build_instance_router();

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/challenge")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), 200);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(json["nonce"].is_string());
        assert!(json["message"].is_string());
        assert!(json["expires_at"].is_number());
    }

    #[tokio::test]
    async fn test_configure_secrets_requires_auth() {
        let tmp = tempfile::tempdir().unwrap();
        unsafe { std::env::set_var("BLUEPRINT_STATE_DIR", tmp.path()) };

        let app = build_instance_router();

        let body = serde_json::json!({
            "env_json": { "API_KEY": "test" },
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bot/secrets")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn test_start_bot_requires_auth() {
        let app = build_instance_router();

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bot/start")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn test_stop_bot_requires_auth() {
        let app = build_instance_router();

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bot/stop")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn test_run_now_requires_auth() {
        let app = build_instance_router();

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bot/run-now")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn test_update_config_requires_auth() {
        let app = build_instance_router();

        let body = serde_json::json!({
            "strategy_config_json": "{\"max_slippage\": 1.0}",
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/bot/config")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn synthesize_trade_entry_uses_persisted_valuation_fields() {
        let mut rec = make_trade_record("USDC", "WETH", "1000", "0.5");
        rec.amount_out = Some("0.5".to_string());
        rec.entry_price_usd = Some("2000".to_string());
        rec.notional_usd = Some("1000".to_string());
        rec.valuation_status = trading_http_api::trade_store::TradeValuationStatus::Priced;
        let entry = synthesize_trade_entry_from_record(&rec);

        assert_eq!(entry["size"], 0.5);
        assert_eq!(entry["amount_out"], 0.5);
        assert_eq!(entry["entry_price"], 2000.0);
        assert_eq!(entry["current_price"], 2000.0);
        assert_eq!(entry["pnl"], 0.0);
        assert_eq!(entry["amount_usd"], 1000.0);
        assert_eq!(entry["valuation_status"], "priced");
    }

    #[test]
    fn synthesize_trade_entry_leaves_unpriced_records_without_usd_fields() {
        let rec = make_trade_record("WETH", "WBTC", "1", "0.05");
        let entry = synthesize_trade_entry_from_record(&rec);

        assert_eq!(entry["size"], 0.05);
        assert!(entry.get("entry_price").is_none());
        assert!(entry.get("current_price").is_none());
        assert!(entry.get("amount_usd").is_none());
        assert_eq!(entry["valuation_status"], "unpriced");
    }

    #[test]
    fn synthesize_trade_entry_marks_swap_records_closed() {
        let rec = make_trade_record("USDC", "WETH", "1000", "0.5");
        let entry = synthesize_trade_entry_from_record(&rec);

        assert_eq!(entry["status"], "closed");
    }
}
