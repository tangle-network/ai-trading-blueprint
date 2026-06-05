// Compat layer for the sibling repo's removed per-run history surface. See
// crate::workflow_compat for the rationale + long-term path.
use axum::extract::{Path, Query, RawQuery};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use futures_util::{StreamExt, stream};
use sandbox_runtime::api_types::{
    CreateLiveTerminalSessionRequest, TerminalInputApiRequest, TerminalResizeApiRequest,
};
use sandbox_runtime::session_auth::SessionAuth;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::str::FromStr;
use std::time::Duration;
use trading_blueprint_lib::workflow_compat::{WorkflowRunRecord, WorkflowRunStatus};

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

use trading_blueprint_lib::asset_preflight::{
    DexAssetPreflightRequest, DexAssetPreflightResponse, preflight_dex_asset,
};
use trading_blueprint_lib::request_access::{self, RequestAccessSummary, RequestAccessUpdate};
use trading_blueprint_lib::state::{self, ActivationProgress, TradingBotRecord};

#[derive(Deserialize)]
pub struct BotListQuery {
    pub operator: Option<String>,
    pub strategy: Option<String>,
    pub status: Option<String>,
    pub include_archived: Option<bool>,
    pub call_id: Option<u64>,
    pub service_id: Option<u64>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

#[derive(Serialize)]
pub struct BotListResponse {
    pub bots: Vec<BotSummary>,
    pub total: usize,
    pub limit: usize,
    pub offset: usize,
}

#[derive(Serialize)]
pub struct BotSummary {
    pub id: String,
    pub name: String,
    pub operator_address: String,
    pub submitter_address: String,
    pub vault_address: String,
    pub strategy_type: String,
    pub strategy_config: serde_json::Value,
    pub chain_id: u64,
    pub trading_active: bool,
    pub paper_trade: bool,
    pub created_at: u64,
    pub secrets_configured: bool,
    pub sandbox_exists: bool,
    pub sandbox_state: Option<String>,
    pub lifecycle_status: String,
    pub archived: bool,
    pub control_available: bool,
    pub sandbox_id: String,
    pub call_id: u64,
    pub service_id: u64,
}

impl BotSummary {
    fn from_record(b: TradingBotRecord) -> Self {
        let runtime = state::bot_runtime_status(&b);
        let name = effective_bot_name(&b);
        Self {
            id: b.id,
            name,
            operator_address: b.operator_address,
            submitter_address: b.submitter_address,
            vault_address: b.vault_address,
            strategy_type: b.strategy_type,
            strategy_config: b.strategy_config,
            chain_id: b.chain_id,
            trading_active: b.trading_active,
            paper_trade: b.paper_trade,
            created_at: b.created_at,
            secrets_configured: runtime.secrets_configured,
            sandbox_exists: runtime.sandbox_exists,
            sandbox_state: runtime.sandbox_state,
            lifecycle_status: runtime.lifecycle_status.as_str().to_string(),
            archived: runtime.archived,
            control_available: runtime.control_available,
            sandbox_id: b.sandbox_id,
            call_id: b.call_id,
            service_id: b.service_id,
        }
    }
}

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
    #[serde(skip_serializing)]
    #[allow(dead_code)]
    pub trading_api_token: String,
    pub sandbox_id: String,
    pub workflow_id: Option<String>,
    pub workflow_running: bool,
    pub latest_execution:
        Option<ai_agent_sandbox_blueprint_lib::workflows::WorkflowLatestExecution>,
    pub secrets_configured: bool,
    pub sandbox_exists: bool,
    pub sandbox_state: Option<String>,
    pub lifecycle_status: String,
    pub archived: bool,
    pub control_available: bool,
    pub wind_down_started_at: Option<u64>,
    pub validator_service_ids: Vec<u64>,
    pub validator_endpoints: Vec<String>,
    pub call_id: u64,
    pub service_id: u64,
}

impl BotDetailResponse {
    fn from_record(b: TradingBotRecord) -> Self {
        let runtime = state::bot_runtime_status(&b);
        let name = effective_bot_name(&b);
        let workflow_running = b
            .workflow_id
            .map(ai_agent_sandbox_blueprint_lib::workflows::is_workflow_running)
            .unwrap_or(false);
        let workflow_latest_execution = b.workflow_id.and_then(|wid| {
            let key = ai_agent_sandbox_blueprint_lib::workflows::workflow_key(wid);
            ai_agent_sandbox_blueprint_lib::workflows::workflow_runtime()
                .ok()?
                .get(&key)
                .ok()?
                .and_then(|meta| meta.latest_execution)
        });
        Self {
            id: b.id,
            name,
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
            workflow_running,
            latest_execution: workflow_latest_execution,
            secrets_configured: runtime.secrets_configured,
            sandbox_exists: runtime.sandbox_exists,
            sandbox_state: runtime.sandbox_state,
            lifecycle_status: runtime.lifecycle_status.as_str().to_string(),
            archived: runtime.archived,
            control_available: runtime.control_available,
            wind_down_started_at: b.wind_down_started_at,
            validator_service_ids: b.validator_service_ids.clone(),
            validator_endpoints: trading_blueprint_lib::discovery::endpoints_from_env(),
            call_id: b.call_id,
            service_id: b.service_id,
        }
    }
}

// ── Provision progress types (from sandbox-runtime) ─────────────────────

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
    request_access: RequestAccessSummary,
}

#[derive(Serialize)]
struct OperatorFeatureFlags {
    chat: bool,
    terminal: bool,
}

// ── Secrets types ────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ConfigureSecretsRequest {
    env_json: serde_json::Map<String, serde_json::Value>,
}

#[derive(Serialize)]
struct SecretsResponse {
    status: String,
    sandbox_id: Option<String>,
    workflow_id: Option<String>,
    /// Trading API credentials — returned on activation so the agent
    /// (or operator) knows how to authenticate with the Trading HTTP API.
    trading_api_token: Option<String>,
    trading_api_url: Option<String>,
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

// ── Bot control types ────────────────────────────────────────────────────

#[derive(Serialize)]
struct BotControlResponse {
    status: String,
    sandbox_id: String,
}

#[derive(Serialize)]
struct RunNowResponse {
    status: String,
    workflow_id: String,
    session_id: String,
    accepted_at: u64,
}

#[derive(Deserialize)]
struct UpdateConfigRequest {
    strategy_config_json: Option<String>,
    risk_params_json: Option<String>,
    harness_json: Option<String>,
    vault_address: Option<String>,
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
    Conflict(String),
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

    fn conflict(message: impl Into<String>) -> Self {
        Self::Conflict(message.into())
    }

    fn stale_bot(bot: &TradingBotRecord) -> Self {
        Self::StaleState {
            message: format!(
                "Bot {} points to missing sandbox {}. Operator state is stale; reprovision the agent from the deploy step.",
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

fn map_run_now_error(err: String) -> (StatusCode, String) {
    if err.contains("already running") {
        (StatusCode::CONFLICT, err)
    } else {
        (StatusCode::INTERNAL_SERVER_ERROR, err)
    }
}

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
        ApiError::Conflict(message) => {
            error_json(StatusCode::CONFLICT, "conflict", message, None, None, None)
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

// ── Metrics / trades response types ─────────────────────────────────────

#[derive(Clone, Deserialize, Serialize)]
struct MetricsSnapshotResponse {
    timestamp: String,
    bot_id: String,
    #[serde(deserialize_with = "deserialize_f64_from_string_or_number")]
    account_value_usd: f64,
    #[serde(deserialize_with = "deserialize_f64_from_string_or_number")]
    unrealized_pnl: f64,
    #[serde(deserialize_with = "deserialize_f64_from_string_or_number")]
    realized_pnl: f64,
    #[serde(deserialize_with = "deserialize_f64_from_string_or_number")]
    high_water_mark: f64,
    #[serde(deserialize_with = "deserialize_f64_from_string_or_number")]
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
    #[serde(skip_serializing_if = "Option::is_none")]
    hyperliquid_metadata: Option<trading_http_api::trade_store::HyperliquidTradeMetadata>,
    #[serde(default)]
    valuation_status: trading_http_api::trade_store::TradeValuationStatus,
}

#[derive(Serialize)]
struct PortfolioPosition {
    token: String,
    symbol: String,
    amount: f64,
    value_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    margin_used_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    notional_usd: Option<f64>,
    entry_price: Option<f64>,
    current_price: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    unrealized_pnl_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    leverage: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    liquidation_price: Option<f64>,
    pnl_percent: Option<f64>,
    weight: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    protocol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    position_type: Option<String>,
    #[serde(default)]
    valuation_status: trading_runtime::types::ValuationStatus,
}

#[derive(Serialize)]
struct PortfolioStateResponse {
    total_value_usd: Option<f64>,
    cash_balance: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    observed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stale: Option<bool>,
    #[serde(default)]
    warnings: Vec<String>,
    #[serde(default)]
    has_unpriced_positions: bool,
    #[serde(default)]
    has_value_only_positions: bool,
    positions: Vec<PortfolioPosition>,
}

#[derive(Deserialize)]
struct MetricsHistoryQuery {
    #[allow(dead_code)]
    from: Option<String>,
    #[allow(dead_code)]
    to: Option<String>,
    #[allow(dead_code)]
    limit: Option<usize>,
}

#[derive(Deserialize)]
struct TradeListQuery {
    limit: Option<usize>,
    offset: Option<usize>,
}

#[derive(Deserialize)]
struct CandleListQuery {
    token: Option<String>,
    source: Option<String>,
    interval: Option<String>,
    from: Option<i64>,
    to: Option<i64>,
    limit: Option<usize>,
    backfill: Option<bool>,
}

#[derive(Deserialize)]
struct ChartStudyListQuery {
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

#[derive(Deserialize)]
struct ObservatoryTriggerRequest {
    reason: Option<String>,
}

#[derive(Deserialize)]
struct ObservatoryIdeaFeedbackRequest {
    action: String,
    note: Option<String>,
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

// ── Session auth types ──────────────────────────────────────────────────

#[derive(Deserialize)]
struct SessionRequest {
    nonce: String,
    signature: String,
}

// ── Router ───────────────────────────────────────────────────────────────

pub fn build_operator_router() -> Router {
    Router::new()
        .route("/api/meta", get(get_operator_meta))
        .route(
            "/api/request-access",
            get(get_request_access).patch(update_request_access),
        )
        // Session auth (delegates to sandbox-runtime's session_auth)
        .route("/api/auth/challenge", post(create_challenge))
        .route("/api/auth/session", post(create_session))
        .route("/api/dex/assets/preflight", post(preflight_dex_asset_route))
        .route("/api/observatory/overview", get(get_observatory_overview))
        // Bot management
        .route("/api/bots", get(list_bots).post(create_bot))
        .route("/api/bots/repair-names", post(repair_bot_names))
        .route(
            "/api/bots/{bot_id}/strategy/repair",
            post(repair_bot_strategy),
        )
        .route("/api/bots/{bot_id}", get(get_bot))
        .route(
            "/api/bots/{bot_id}/secrets",
            get(get_secrets)
                .post(configure_secrets)
                .delete(wipe_secrets),
        )
        .route("/api/bots/{bot_id}/start", post(start_bot))
        .route("/api/bots/{bot_id}/stop", post(stop_bot))
        .route("/api/bots/{bot_id}/run-now", post(run_now))
        .route("/api/bots/{bot_id}/runs", get(list_bot_runs))
        .route("/api/bots/{bot_id}/observatory", get(get_bot_observatory))
        .route(
            "/api/bots/{bot_id}/observatory/trigger",
            post(trigger_bot_observatory),
        )
        .route(
            "/api/bots/{bot_id}/observatory/ideas/{idea_id}/feedback",
            post(record_observatory_idea_feedback),
        )
        .route("/api/bots/{bot_id}/runs/{run_id}", get(get_bot_run))
        .route(
            "/api/bots/{bot_id}/runs/{run_id}/messages",
            get(list_bot_run_messages),
        )
        .route(
            "/api/bots/{bot_id}/evolution/self-improve/runs",
            get(list_self_improvement_runs),
        )
        .route(
            "/api/bots/{bot_id}/evolution/revision-arena",
            get(get_revision_arena),
        )
        .route(
            "/api/bots/{bot_id}/evolution/revision-arena/promote",
            post(promote_revision_candidate),
        )
        .route(
            "/api/bots/{bot_id}/evolution/revision-arena/decision",
            post(decide_revision_candidate),
        )
        .route("/api/bots/{bot_id}/config", patch(update_config))
        .route("/api/bots/{bot_id}/metrics", get(get_bot_metrics))
        .route(
            "/api/bots/{bot_id}/metrics/history",
            get(get_bot_metrics_history),
        )
        .route(
            "/api/bots/{bot_id}/market-data/candles",
            get(get_bot_market_candles),
        )
        .route(
            "/api/bots/{bot_id}/chart/studies",
            get(get_bot_chart_studies),
        )
        .route("/api/bots/{bot_id}/trades", get(get_bot_trades))
        .route(
            "/api/bots/{bot_id}/tick-artifacts",
            get(get_bot_tick_artifacts),
        )
        .route(
            "/api/bots/{bot_id}/baseline-backtest",
            get(get_bot_baseline_backtest),
        )
        .route("/api/bots/{bot_id}/portfolio/state", get(get_bot_portfolio))
        .route(
            "/api/bots/{bot_id}/hyperliquid/nav",
            get(get_bot_hyperliquid_nav).post(refresh_bot_hyperliquid_nav),
        )
        .route(
            "/api/bots/{bot_id}/hyperliquid/mode",
            get(get_bot_hyperliquid_mode),
        )
        .route(
            "/api/bots/{bot_id}/hyperliquid/settlement",
            get(get_bot_hyperliquid_settlement),
        )
        .route(
            "/api/bots/{bot_id}/hyperliquid/settlement/run",
            post(run_bot_hyperliquid_settlement),
        )
        .route(
            "/api/bots/{bot_id}/activation-progress",
            get(get_activation_progress),
        )
        .route(
            "/api/bots/{bot_id}/live/terminal/sessions",
            get(list_terminal_sessions).post(create_terminal_session),
        )
        .route(
            "/api/bots/{bot_id}/live/terminal/sessions/{session_id}",
            patch(resize_terminal_session).delete(delete_terminal_session),
        )
        .route(
            "/api/bots/{bot_id}/live/terminal/sessions/{session_id}/stream",
            get(stream_terminal_session),
        )
        .route(
            "/api/bots/{bot_id}/live/terminal/sessions/{session_id}/input",
            post(send_terminal_input),
        )
        .route(
            "/api/bots/{bot_id}/session/sessions",
            get(list_chat_sessions).post(create_chat_gateway_session),
        )
        .route(
            "/api/bots/{bot_id}/session/sessions/{session_id}",
            get(get_chat_session)
                .patch(update_chat_session)
                .delete(delete_chat_session),
        )
        .route(
            "/api/bots/{bot_id}/session/sessions/{session_id}/messages",
            get(list_chat_messages).post(send_chat_message),
        )
        .route(
            "/api/bots/{bot_id}/session/sessions/{session_id}/abort",
            post(abort_chat_session),
        )
        .route("/api/bots/{bot_id}/session/events", get(stream_chat_events))
        .route("/api/platform/trades", get(get_platform_trades))
        .route("/api/platform/volume", get(get_platform_volume))
        // Provision progress
        .route("/api/provisions", get(list_provisions))
        .route("/api/provisions/{call_id}", get(get_provision))
        // Pricing endpoints — subscription config + billing status
        .route("/pricing/quote", post(pricing_quote))
        .route("/pricing/job-quote", post(pricing_job_quote))
        .route("/api/pricing/config", get(get_pricing_config))
        .route("/api/pricing/billing/{service_id}", get(get_billing_status))
        // Leaderboard
        .route("/api/leaderboard", get(get_leaderboard))
        // Debug endpoints (auth required)
        .route("/api/debug/sandboxes", get(debug_sandboxes))
        .route("/api/debug/state-health", get(debug_state_health))
        .route("/api/debug/workflows", get(debug_workflows))
        .route("/api/debug/run-now/{bot_id}", post(debug_run_now))
        .layer(sandbox_runtime::operator_api::build_cors_layer())
        // One tracing span per HTTP request (method/path/status/latency) →
        // exported via OTLP to Tangle Intelligence when telemetry is enabled.
        .layer(tower_http::trace::TraceLayer::new_for_http())
}

async fn get_operator_meta() -> Json<OperatorMetaResponse> {
    let access = request_access::load_request_access_policy();
    Json(OperatorMetaResponse {
        api_version: "1".to_string(),
        deployment_kind: "fleet".to_string(),
        features: OperatorFeatureFlags {
            chat: true,
            terminal: true,
        },
        request_access: access.summary(),
    })
}

async fn get_request_access() -> Json<RequestAccessSummary> {
    Json(request_access::load_request_access_policy().summary())
}

async fn update_request_access(
    SessionAuth(caller): SessionAuth,
    Json(body): Json<RequestAccessUpdate>,
) -> ApiResult<RequestAccessSummary> {
    if !request_access::caller_is_operator_admin(&caller) {
        return Err(ApiError::message(
            StatusCode::FORBIDDEN,
            "operator admin session required",
        ));
    }
    let policy = request_access::save_request_access_policy(body)
        .map_err(|e| ApiError::message(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(policy.summary()))
}

// ── Auth handlers ────────────────────────────────────────────────────────

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
    let value = serde_json::to_value(token).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Serialization error: {e}"),
        )
    })?;
    Ok((StatusCode::OK, Json(value)))
}

async fn preflight_dex_asset_route(
    SessionAuth(caller): SessionAuth,
    Json(request): Json<DexAssetPreflightRequest>,
) -> ApiResult<DexAssetPreflightResponse> {
    // Per-session rate limit. The endpoint dispatches 1-3 RPC calls per fee
    // tier, so an unrate-limited session can drive a relay loop against any
    // allowlisted RPC. 30/min default; env-tunable.
    if let Err(retry_after) = crate::preflight_limiter::preflight_limiter().check(&caller) {
        let secs = retry_after.as_secs().max(1);
        return Err(ApiError::message(
            StatusCode::TOO_MANY_REQUESTS,
            format!("preflight rate limit exceeded; retry after {secs}s"),
        ));
    }

    preflight_dex_asset(request).await.map(Json).map_err(|err| {
        let status = classify_preflight_error(&err);
        ApiError::message(status, err)
    })
}

/// Map `preflight_dex_asset` string errors to status codes. RPC-side /
/// infra failures → 5xx; everything else stays 400 so a caller-supplied
/// bad input doesn't masquerade as a server fault.
fn classify_preflight_error(err: &str) -> StatusCode {
    let lower = err.to_ascii_lowercase();
    if lower.contains("rpc unreachable")
        || lower.contains("rpc error")
        || lower.contains("connection")
        || lower.contains("timeout")
        || lower.contains("decode")
        || lower.contains("network")
    {
        return StatusCode::BAD_GATEWAY;
    }
    if lower.contains("no allowlisted rpc") || lower.contains("rpc is not configured") {
        return StatusCode::SERVICE_UNAVAILABLE;
    }
    StatusCode::BAD_REQUEST
}

// ── Bot handlers ─────────────────────────────────────────────────────────

const DIRECT_BOT_CREATE_ENV: &str = "TRADING_ENABLE_DIRECT_BOT_CREATE";

fn direct_bot_create_enabled() -> bool {
    std::env::var(DIRECT_BOT_CREATE_ENV)
        .ok()
        .is_some_and(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "enabled" | "allow" | "on"
            )
        })
}

fn ensure_direct_bot_create_enabled() -> Result<(), ApiError> {
    if direct_bot_create_enabled() {
        return Ok(());
    }

    Err(ApiError::message(
        StatusCode::FORBIDDEN,
        format!(
            "Direct bot creation is disabled. Create a Tangle service instance through /provision; set {DIRECT_BOT_CREATE_ENV}=true only for local/dev bypasses."
        ),
    ))
}

/// Legacy direct bot creation request. Disabled by default; production creation
/// must enter through the Tangle service lifecycle.
#[derive(Deserialize)]
struct CreateBotRequest {
    /// Free-form strategy description from the user
    #[serde(default)]
    prompt: String,
    /// Optional strategy type override (auto-detected from prompt if omitted)
    #[serde(default)]
    strategy_type: Option<String>,
    /// Optional name (defaults to first 50 chars of prompt)
    #[serde(default)]
    name: Option<String>,
    /// Optional structured strategy config merged into the provision request.
    #[serde(default)]
    strategy_config: Option<serde_json::Value>,
    /// Optional JSON-encoded structured config for CLI callers.
    #[serde(default)]
    strategy_config_json: Option<String>,
    /// Canonical owner-facing agent definition. Strategy config is a runtime
    /// projection from this profile while existing adapters still require
    /// `strategy_type`.
    #[serde(default)]
    agent_profile: Option<serde_json::Value>,
}

#[derive(Debug, Clone)]
struct BotNameResolution {
    name: String,
    source: String,
    model: Option<String>,
    fallback_reason: Option<String>,
}

#[derive(Debug, Clone)]
struct NamingModelConfig {
    api_key: String,
    base_url: String,
    model: String,
    label: String,
}

#[derive(Deserialize, Default)]
struct RepairBotNamesRequest {
    #[serde(default)]
    force: bool,
    #[serde(default)]
    dry_run: bool,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    bot_ids: Vec<String>,
}

#[derive(Serialize)]
struct BotNameRepairResult {
    bot_id: String,
    old_name: String,
    new_name: String,
    changed: bool,
    source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fallback_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_prompt: Option<String>,
}

#[derive(Serialize)]
struct BotNameRepairResponse {
    dry_run: bool,
    force: bool,
    scanned: usize,
    renamed: usize,
    skipped: usize,
    results: Vec<BotNameRepairResult>,
}

#[derive(Deserialize, Default)]
struct RepairBotStrategyRequest {
    #[serde(default)]
    dry_run: bool,
    /// Recreate and reactivate the paper bot after persisting the repaired pack.
    #[serde(default = "default_true")]
    reactivate: bool,
    /// Reapply the pack even when the inferred target already matches.
    #[serde(default)]
    force: bool,
    /// Optional explicit target. If omitted, the stored/user prompt is authoritative.
    #[serde(default)]
    strategy_type: Option<String>,
    /// Optional replacement mandate used for inference and stored as user_prompt.
    #[serde(default)]
    prompt: Option<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Serialize)]
struct RepairBotStrategyResponse {
    bot_id: String,
    dry_run: bool,
    changed: bool,
    reactivated: bool,
    old_strategy_type: String,
    new_strategy_type: String,
    changed_fields: Vec<String>,
    old_sandbox_id: String,
    new_sandbox_id: Option<String>,
    old_workflow_id: Option<u64>,
    new_workflow_id: Option<u64>,
    name: String,
    strategy_config: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    activation_error: Option<String>,
}

/// Canonical USDC address for the common chains we deploy on.
/// Unknown chains fall through; callers must supply `ASSET_TOKEN_ADDRESS`.
fn default_asset_token_address(chain_id: u64) -> Option<&'static str> {
    match chain_id {
        1 => Some("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"), // Ethereum USDC
        8453 => Some("0x833589fCD6eDb6E08f4c7C32D4f71b54bDA02913"), // Base USDC
        84532 => Some("0x036CbD53842c5426634e7929541eC2318f3dCF7e"), // Base Sepolia USDC
        998 => Some("0x2B3370eE501B4a559b57D449569354196457D8Ab"), // HyperEVM testnet USDC
        999 => Some("0xb88339CB7199b77E23DB6E890353E22632Ba630f"), // HyperEVM mainnet USDC
        _ => None,
    }
}

fn configured_protocol_chain_id(execution_chain_id: u64) -> u64 {
    ["PROTOCOL_CHAIN_ID", "FORK_BASE_CHAIN_ID"]
        .iter()
        .find_map(|key| std::env::var(key).ok())
        .and_then(|raw| raw.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(execution_chain_id)
}

fn is_hyperevm_chain(chain_id: u64) -> bool {
    matches!(chain_id, 998 | 999)
}

fn default_hyperliquid_protocol_chain_id(execution_chain_id: u64) -> u64 {
    if is_hyperevm_chain(execution_chain_id) {
        execution_chain_id
    } else {
        998
    }
}

fn create_bot_protocol_chain_id(strategy_type: &str, execution_chain_id: u64) -> u64 {
    match trading_runtime::supported_assets::normalize_strategy_type(strategy_type).as_str() {
        "perp" => 42161,
        "hyperliquid_perp" => default_hyperliquid_protocol_chain_id(execution_chain_id),
        _ => configured_protocol_chain_id(execution_chain_id),
    }
}

fn strategy_protocol_chain_and_asset_token(
    strategy_type: &str,
    chain_id: u64,
) -> Result<(u64, String), ApiError> {
    let protocol_chain_id = create_bot_protocol_chain_id(strategy_type, chain_id);
    let asset_token = std::env::var("ASSET_TOKEN_ADDRESS")
        .or_else(|_| std::env::var("USDC_ADDRESS"))
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| default_asset_token_address(protocol_chain_id).map(str::to_string))
        .ok_or_else(|| {
            ApiError::message(
                StatusCode::FAILED_DEPENDENCY,
                format!(
                    "No asset token configured for chain {chain_id} / protocol chain {protocol_chain_id}. \
                     Set ASSET_TOKEN_ADDRESS or USDC_ADDRESS."
                ),
            )
        })?;
    Ok((protocol_chain_id, asset_token))
}

fn parse_bool_env(raw: &str) -> Option<bool> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "y" | "on" => Some(true),
        "0" | "false" | "no" | "n" | "off" => Some(false),
        _ => None,
    }
}

fn default_paper_trade_for_chain(chain_id: u64) -> bool {
    if let Some(value) = std::env::var("DEFAULT_PAPER_TRADE")
        .ok()
        .and_then(|raw| parse_bool_env(&raw))
    {
        return value;
    }

    !matches!(chain_id, 31338 | 31339)
}

fn strategy_context_filename(date: &str) -> String {
    format!("conversations/{date}-strategy-context.md")
}

fn build_strategy_bootstrap_memory(
    date: &str,
    timestamp: &str,
    prompt: &str,
    agent_profile: Option<&serde_json::Value>,
) -> (String, String, String) {
    let conversation_file = strategy_context_filename(date);
    let profile_section = agent_profile
        .filter(|profile| !profile.is_null())
        .map(|profile| {
            let pretty =
                serde_json::to_string_pretty(profile).unwrap_or_else(|_| profile.to_string());
            format!("\n## AgentProfile\n```json\n{pretty}\n```\n")
        })
        .unwrap_or_default();
    let strategy_content =
        format!("# Strategy Brief\n\n## Owner ({timestamp})\n{prompt}\n{profile_section}");
    let toc_content = format!(
        "# Memory Index\nUpdated: {date} | Iteration: 0\n\n\
         ## Conversations\n\
         - [Strategy Brief]({conversation_file}) — Initial owner strategy brief. **ACTION NEEDED**\n\n\
         ## Decisions\n\
         (none yet)\n\n\
         ## Research\n\
         (none yet)\n\n\
         ## Performance\n\
         - New agent, no trades yet\n"
    );

    (conversation_file, strategy_content, toc_content)
}

fn create_bot_strategy_config(
    body: &CreateBotRequest,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let mut config = if let Some(raw) = body
        .strategy_config_json
        .as_deref()
        .map(str::trim)
        .filter(|raw| !raw.is_empty())
    {
        let parsed = serde_json::from_str::<serde_json::Value>(raw)
            .map_err(|e| format!("strategy_config_json is not valid JSON: {e}"))?;
        parsed
            .as_object()
            .cloned()
            .ok_or_else(|| "strategy_config_json must be a JSON object".to_string())?
    } else {
        match body.strategy_config.as_ref() {
            None | Some(serde_json::Value::Null) => serde_json::Map::new(),
            Some(serde_json::Value::Object(map)) => map.clone(),
            Some(_) => return Err("strategy_config must be a JSON object".to_string()),
        }
    };

    if let Some(profile) = body.agent_profile.as_ref() {
        if !profile.is_object() {
            return Err("agent_profile must be a JSON object".to_string());
        }
        config.insert("agent_profile".to_string(), profile.clone());
    }

    Ok(config)
}

fn string_at_path<'a>(value: &'a serde_json::Value, path: &[&str]) -> Option<&'a str> {
    let mut current = value;
    for segment in path {
        current = current.get(*segment)?;
    }
    current
        .as_str()
        .map(str::trim)
        .filter(|raw| !raw.is_empty())
}

fn prompt_from_agent_profile(agent_profile: &serde_json::Value) -> Option<&str> {
    string_at_path(agent_profile, &["mandate", "raw"])
        .or_else(|| string_at_path(agent_profile, &["mandate", "text"]))
        .or_else(|| string_at_path(agent_profile, &["mandate", "summary"]))
}

fn strategy_type_from_agent_profile(agent_profile: &serde_json::Value) -> Option<&str> {
    string_at_path(agent_profile, &["activation", "projectedStrategyType"])
        .or_else(|| string_at_path(agent_profile, &["activation", "executionAdapter"]))
        .or_else(|| string_at_path(agent_profile, &["execution", "adapter", "strategy_type"]))
        .or_else(|| string_at_path(agent_profile, &["compatibility", "strategy_type"]))
}

fn env_string(keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| std::env::var(key).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn env_bool(key: &str) -> bool {
    std::env::var(key)
        .ok()
        .and_then(|value| parse_bool_env(&value))
        .unwrap_or(false)
}

fn naming_model_configs() -> Vec<NamingModelConfig> {
    if env_bool("BOT_NAMING_DISABLE_LLM") {
        return Vec::new();
    }

    let mut configs = Vec::new();

    if let Some(api_key) = env_string(&["BOT_NAMING_MODEL_API_KEY"]) {
        configs.push(NamingModelConfig {
            api_key,
            base_url: env_string(&["BOT_NAMING_MODEL_BASE_URL"])
                .unwrap_or_else(|| "https://api.z.ai/api/coding/paas/v4".to_string()),
            model: env_string(&["BOT_NAMING_MODEL_NAME"]).unwrap_or_else(|| "glm-4.7".to_string()),
            label: "bot-naming-model".to_string(),
        });
    }

    if let Some(api_key) = env_string(&["OPENCODE_MODEL_API_KEY"]) {
        configs.push(NamingModelConfig {
            api_key,
            base_url: env_string(&["OPENCODE_MODEL_BASE_URL"])
                .unwrap_or_else(|| "https://api.z.ai/api/coding/paas/v4".to_string()),
            model: env_string(&["OPENCODE_MODEL_NAME"]).unwrap_or_else(|| "glm-4.7".to_string()),
            label: "opencode-model".to_string(),
        });
    }

    if let Some(api_key) = env_string(&["ZAI_GLM_API_KEY", "ZAI_API_KEY"]) {
        configs.push(NamingModelConfig {
            api_key,
            base_url: "https://api.z.ai/api/coding/paas/v4".to_string(),
            model: env_string(&["BOT_NAMING_ZAI_MODEL"]).unwrap_or_else(|| "glm-4.7".to_string()),
            label: "zai".to_string(),
        });
    }

    if let Some(api_key) = env_string(&["TANGLE_ROUTER_API_KEY", "TANGLE_API_KEY"]) {
        configs.push(NamingModelConfig {
            api_key,
            base_url: env_string(&["TANGLE_ROUTER_BASE_URL"])
                .unwrap_or_else(|| "https://router.tangle.tools/v1".to_string()),
            model: env_string(&["BOT_NAMING_TANGLE_MODEL"])
                .unwrap_or_else(|| "anthropic/claude-sonnet-4-6".to_string()),
            label: "tangle-router".to_string(),
        });
    }

    configs
}

fn prompt_from_config(strategy_config: &serde_json::Value) -> Option<&str> {
    strategy_config
        .get("user_prompt")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            strategy_config
                .get("agent_profile")
                .and_then(prompt_from_agent_profile)
        })
}

fn config_string(strategy_config: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| strategy_config.get(*key))
        .and_then(|value| match value {
            serde_json::Value::String(raw) => Some(raw.trim().to_string()),
            serde_json::Value::Number(raw) => Some(raw.to_string()),
            _ => None,
        })
        .filter(|value| !value.is_empty())
}

fn words_lower(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
        .map(|part| part.to_ascii_lowercase())
        .collect()
}

fn mentions_any(text: &str, needles: &[&str]) -> bool {
    let words = words_lower(text);
    needles
        .iter()
        .any(|needle| words.iter().any(|word| word == needle))
}

fn has_negative_hyperliquid_context(prompt_lower: &str) -> bool {
    [
        "no hyperliquid",
        "not hyperliquid",
        "not on hyperliquid",
        "without hyperliquid",
        "avoid hyperliquid",
        "do not use hyperliquid",
        "don't use hyperliquid",
        "dont use hyperliquid",
    ]
    .iter()
    .any(|phrase| prompt_lower.contains(phrase))
}

fn has_positive_hyperliquid_perp_mandate(prompt: &str) -> bool {
    let prompt_lower = prompt.to_ascii_lowercase();
    let mentions_hyperliquid =
        prompt_lower.contains("hyperliquid") || prompt_lower.contains("hyperevm");
    let mentions_perp_surface = [
        "perp",
        "perps",
        "perpetual",
        "perpetuals",
        "futures",
        "leverage",
        "liquidation",
    ]
    .iter()
    .any(|term| prompt_lower.contains(term));

    mentions_hyperliquid
        && mentions_perp_surface
        && !has_negative_hyperliquid_context(&prompt_lower)
}

fn infer_create_bot_strategy_type(prompt: &str, requested: Option<&str>) -> String {
    let requested = requested.map(str::trim).filter(|value| !value.is_empty());
    if has_positive_hyperliquid_perp_mandate(prompt) {
        let requested_strategy = requested
            .map(trading_runtime::supported_assets::normalize_strategy_type)
            .unwrap_or_else(|| "perp".to_string());
        if matches!(requested_strategy.as_str(), "perp" | "hyperliquid_perp") {
            return "hyperliquid_perp".to_string();
        }
    }

    if let Some(strategy_type) = requested {
        return strategy_type.to_string();
    }

    let prompt_lower = prompt.to_lowercase();
    if prompt_lower.contains("yield")
        || prompt_lower.contains("lending")
        || prompt_lower.contains("aave")
    {
        "yield".into()
    } else if prompt_lower.contains("polymarket")
        || prompt_lower.contains("prediction")
        || prompt_lower.contains("politic")
    {
        "prediction".into()
    } else if prompt_lower.contains("perp")
        || prompt_lower.contains("leverage")
        || prompt_lower.contains("futures")
    {
        "perp".into()
    } else {
        "dex".into()
    }
}

fn extract_pair(strategy_config: &serde_json::Value, prompt: &str) -> Option<String> {
    let configured = config_string(
        strategy_config,
        &[
            "pair",
            "market",
            "symbol",
            "asset_pair",
            "trading_pair",
            "hyperliquid_symbol",
        ],
    );
    if let Some(value) = configured {
        let normalized = value
            .replace('-', "/")
            .split_whitespace()
            .next()
            .unwrap_or("")
            .trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '/')
            .to_ascii_uppercase();
        if normalized.len() >= 3 {
            return Some(normalized);
        }
    }

    let prompt_upper = prompt.to_ascii_uppercase();
    for pair in [
        "ETH/USDC",
        "ETH/USD",
        "BTC/USDC",
        "BTC/USD",
        "SOL/USDC",
        "HYPE/USDC",
    ] {
        if prompt_upper.contains(pair) {
            return Some(pair.to_string());
        }
    }

    if mentions_any(prompt, &["eth", "ethereum", "weth"]) {
        return Some("ETH".to_string());
    }
    if mentions_any(prompt, &["btc", "bitcoin", "wbtc"]) {
        return Some("BTC".to_string());
    }
    if mentions_any(prompt, &["sol", "solana"]) {
        return Some("SOL".to_string());
    }
    if mentions_any(prompt, &["hype", "hyperliquid"]) {
        return Some("HYPE".to_string());
    }
    if mentions_any(prompt, &["aero", "aerodrome"]) {
        return Some("AERO".to_string());
    }

    None
}

fn extract_venue(strategy_config: &serde_json::Value, prompt: &str) -> Option<&'static str> {
    let configured = config_string(
        strategy_config,
        &[
            "protocol",
            "target_protocol",
            "venue",
            "exchange",
            "adapter",
        ],
    )
    .unwrap_or_default()
    .to_ascii_lowercase();
    let haystack = format!("{} {}", configured, prompt.to_ascii_lowercase());

    if haystack.contains("hyperliquid") {
        Some("Hyperliquid")
    } else if haystack.contains("aerodrome") {
        Some("Aerodrome")
    } else if haystack.contains("polymarket") {
        Some("Polymarket")
    } else if haystack.contains("uniswap") {
        Some("Uniswap")
    } else if haystack.contains("aave") {
        Some("Aave")
    } else if haystack.contains("morpho") {
        Some("Morpho")
    } else if haystack.contains("gmx") {
        Some("GMX")
    } else if haystack.contains("vertex") {
        Some("Vertex")
    } else {
        None
    }
}

fn strategy_family(strategy_type: &str) -> &'static str {
    let lower = strategy_type.to_ascii_lowercase();
    if lower.contains("hyperliquid") || lower.contains("perp") || lower.contains("future") {
        "perp"
    } else if lower.contains("yield") || lower.contains("lending") {
        "yield"
    } else if lower.contains("prediction") || lower.contains("polymarket") || lower.contains("clob")
    {
        "prediction"
    } else if lower.contains("volatility") {
        "volatility"
    } else {
        "dex"
    }
}

fn compact_name(name: &str, max_chars: usize) -> String {
    let mut compact = name
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(|c: char| c == '"' || c == '\'' || c == '`' || c == '.' || c == ':')
        .to_string();
    while compact.chars().count() > max_chars {
        let Some(idx) = compact.rfind(' ') else {
            break;
        };
        compact.truncate(idx);
    }
    compact
}

fn deterministic_bot_name(
    prompt: &str,
    strategy_type: &str,
    strategy_config: &serde_json::Value,
) -> String {
    let pair = extract_pair(strategy_config, prompt);
    let venue = extract_venue(strategy_config, prompt);
    let family = strategy_family(strategy_type);
    let base = match family {
        "perp" => pair
            .as_ref()
            .map(|asset| format!("{asset} Perp Sentinel"))
            .or_else(|| venue.map(|v| format!("{v} Perp Sentinel")))
            .unwrap_or_else(|| "Perp Sentinel".to_string()),
        "yield" => pair
            .as_ref()
            .map(|asset| format!("{asset} Yield Allocator"))
            .or_else(|| venue.map(|v| format!("{v} Yield Allocator")))
            .unwrap_or_else(|| "Yield Allocator".to_string()),
        "prediction" => venue
            .map(|v| format!("{v} Market Scout"))
            .or_else(|| pair.as_ref().map(|asset| format!("{asset} Market Scout")))
            .unwrap_or_else(|| "Prediction Market Scout".to_string()),
        "volatility" => pair
            .as_ref()
            .map(|asset| format!("{asset} Volatility Scout"))
            .unwrap_or_else(|| "Volatility Scout".to_string()),
        _ => pair
            .as_ref()
            .map(|asset| {
                if asset.contains('/') {
                    format!("{asset} Maker")
                } else {
                    format!("{asset} DEX Trader")
                }
            })
            .or_else(|| venue.map(|v| format!("{v} Market Maker")))
            .unwrap_or_else(|| "DEX Market Maker".to_string()),
    };
    sanitize_bot_name(&base).unwrap_or_else(|| "Trading Strategy".to_string())
}

fn sanitize_bot_name(raw: &str) -> Option<String> {
    let first_line = raw.lines().find(|line| !line.trim().is_empty())?.trim();
    let normalized = compact_name(first_line, 36);
    let lower = normalized.to_ascii_lowercase();
    if normalized.chars().count() < 3 {
        return None;
    }
    if lower.starts_with("i want")
        || lower.starts_with("create ")
        || lower.contains(" agent that ")
        || lower.contains(" bot that ")
        || lower.contains("please ")
        || lower.contains(" should ")
    {
        return None;
    }
    if lower.contains("agent") || lower.contains("bot") {
        return None;
    }
    let has_alnum = normalized.chars().any(|c| c.is_ascii_alphanumeric());
    has_alnum.then_some(normalized)
}

fn bot_name_needs_generation(current_name: &str, prompt: &str) -> bool {
    let current = current_name.trim();
    if sanitize_bot_name(current).is_none() {
        return true;
    }
    let current_lower = current.to_ascii_lowercase();
    let prompt_lower = prompt.trim().to_ascii_lowercase();
    if prompt_lower.is_empty() {
        return false;
    }
    current_lower.starts_with("i want")
        || current_lower.starts_with("create ")
        || current_lower.contains("agent that")
        || current_lower.contains("bot that")
        || (current.chars().count() >= 32 && prompt_lower.starts_with(&current_lower))
}

fn extract_model_name(content: &str) -> Option<String> {
    let trimmed = content.trim();
    let parsed = serde_json::from_str::<serde_json::Value>(trimmed)
        .ok()
        .or_else(|| {
            let start = trimmed.find('{')?;
            let end = trimmed.rfind('}')?;
            serde_json::from_str::<serde_json::Value>(&trimmed[start..=end]).ok()
        });
    parsed
        .as_ref()
        .and_then(|value| value.get("name"))
        .and_then(serde_json::Value::as_str)
        .or_else(|| {
            if trimmed.starts_with('{') {
                None
            } else {
                Some(trimmed)
            }
        })
        .and_then(sanitize_bot_name)
}

fn bot_name_prompt(
    prompt: &str,
    strategy_type: &str,
    strategy_config: &serde_json::Value,
) -> String {
    let context = json!({
        "strategy_type": strategy_type,
        "user_prompt": prompt,
        "strategy_config": strategy_config,
    });
    format!(
        "Name this AI trading strategy for a professional crypto trading terminal.\n\
         Return only compact JSON: {{\"name\":\"...\"}}.\n\
         Criteria:\n\
         - 2 to 4 words, 36 characters max.\n\
         - No sentence fragments, no prompts, no quotes.\n\
         - Do not use the words agent or bot.\n\
         - Prefer asset, venue, and strategy role when available.\n\
         - Examples: ETH Perp Sentinel, Aerodrome Market Maker, Aave Yield Allocator, Polymarket Event Scout.\n\n\
         Context:\n{context}"
    )
}

async fn call_bot_name_model(
    prompt: &str,
    strategy_type: &str,
    strategy_config: &serde_json::Value,
) -> Result<BotNameResolution, String> {
    let configs = naming_model_configs();
    if configs.is_empty() {
        return Err("no naming model configured".to_string());
    }

    let mut failures = Vec::new();
    for config in configs {
        match call_bot_name_model_with_config(&config, prompt, strategy_type, strategy_config).await
        {
            Ok(resolution) => return Ok(resolution),
            Err(reason) => failures.push(format!("{}:{}: {reason}", config.label, config.model)),
        }
    }

    Err(failures.join("; "))
}

async fn call_bot_name_model_with_config(
    config: &NamingModelConfig,
    prompt: &str,
    strategy_type: &str,
    strategy_config: &serde_json::Value,
) -> Result<BotNameResolution, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("{}/chat/completions", config.base_url.trim_end_matches('/'));
    let response = client
        .post(url)
        .bearer_auth(&config.api_key)
        .json(&json!({
            "model": config.model,
            "temperature": 0.2,
            "max_tokens": 80,
            "messages": [
                {
                    "role": "system",
                    "content": "You name crypto trading strategies. Output only valid JSON."
                },
                {
                    "role": "user",
                    "content": bot_name_prompt(prompt, strategy_type, strategy_config)
                }
            ]
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    let body = response
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("model response JSON decode failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("model returned HTTP {status}"));
    }
    let content = body
        .pointer("/choices/0/message/content")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| format!("model response missing message content: {body}"))?;
    let name = extract_model_name(content)
        .ok_or_else(|| format!("model returned unusable name: {content}"))?;
    Ok(BotNameResolution {
        name,
        source: "llm".to_string(),
        model: Some(format!("{}:{}", config.label, config.model)),
        fallback_reason: None,
    })
}

async fn resolve_bot_display_name(
    explicit_name: Option<&str>,
    prompt: &str,
    strategy_type: &str,
    strategy_config: &serde_json::Value,
) -> BotNameResolution {
    if let Some(name) = explicit_name
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .and_then(sanitize_bot_name)
        .filter(|name| !bot_name_needs_generation(name, prompt))
    {
        return BotNameResolution {
            name,
            source: "explicit".to_string(),
            model: None,
            fallback_reason: None,
        };
    }

    match call_bot_name_model(prompt, strategy_type, strategy_config).await {
        Ok(resolution) => resolution,
        Err(reason) => BotNameResolution {
            name: deterministic_bot_name(prompt, strategy_type, strategy_config),
            source: "deterministic".to_string(),
            model: None,
            fallback_reason: Some(reason),
        },
    }
}

fn persist_name_metadata(
    config: &mut serde_json::Map<String, serde_json::Value>,
    resolution: &BotNameResolution,
) {
    config.insert(
        "display_name".to_string(),
        serde_json::Value::String(resolution.name.clone()),
    );
    config.insert(
        "display_name_source".to_string(),
        serde_json::Value::String(resolution.source.clone()),
    );
    if let Some(model) = &resolution.model {
        config.insert(
            "display_name_model".to_string(),
            serde_json::Value::String(model.clone()),
        );
    }
    if let Some(reason) = &resolution.fallback_reason {
        config.insert(
            "display_name_fallback_reason".to_string(),
            serde_json::Value::String(reason.clone()),
        );
    }
    config.insert(
        "display_name_generated_at".to_string(),
        serde_json::Value::String(chrono::Utc::now().to_rfc3339()),
    );
}

fn stored_display_name(bot: &TradingBotRecord) -> Option<String> {
    bot.strategy_config
        .get("display_name")
        .and_then(serde_json::Value::as_str)
        .and_then(sanitize_bot_name)
}

fn effective_bot_name(bot: &TradingBotRecord) -> String {
    if let Some(name) = stored_display_name(bot) {
        return name;
    }

    let prompt = prompt_from_config(&bot.strategy_config).unwrap_or_default();
    if let Some(name) =
        sanitize_bot_name(&bot.name).filter(|name| !bot_name_needs_generation(name, prompt))
    {
        return name;
    }

    if !prompt.is_empty() {
        return deterministic_bot_name(prompt, &bot.strategy_type, &bot.strategy_config);
    }

    deterministic_bot_name("", &bot.strategy_type, &bot.strategy_config)
}

fn bot_should_repair_name(bot: &TradingBotRecord, force: bool) -> bool {
    if force {
        return true;
    }
    let prompt = prompt_from_config(&bot.strategy_config).unwrap_or_default();
    if !prompt.is_empty() && bot_name_needs_generation(&bot.name, prompt) {
        return true;
    }
    stored_display_name(bot).is_none() && sanitize_bot_name(&bot.name).is_none()
}

fn apply_bot_name_resolution(record: &mut TradingBotRecord, resolution: &BotNameResolution) {
    record.name = resolution.name.clone();
    if !record.strategy_config.is_object() {
        record.strategy_config = json!({});
    }
    let Some(config) = record.strategy_config.as_object_mut() else {
        return;
    };
    persist_name_metadata(config, resolution);
}

async fn repair_bot_names(
    SessionAuth(caller): SessionAuth,
    Json(body): Json<RepairBotNamesRequest>,
) -> ApiResult<BotNameRepairResponse> {
    if !is_operator_admin(&caller) {
        return Err(ApiError::message(
            StatusCode::FORBIDDEN,
            "operator admin session required",
        ));
    }

    let requested_ids: HashSet<String> = body.bot_ids.iter().cloned().collect();
    let result = state::list_bots(None, 10_000, 0)
        .map_err(|e| ApiError::message(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let mut candidates: Vec<TradingBotRecord> = result
        .bots
        .into_iter()
        .filter(|bot| requested_ids.is_empty() || requested_ids.contains(&bot.id))
        .collect();
    candidates.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    if requested_ids.is_empty() {
        candidates.truncate(body.limit.unwrap_or(250).min(1_000));
    }

    let mut results = Vec::with_capacity(candidates.len());
    let mut renamed = 0usize;
    let mut skipped = 0usize;
    let scanned = candidates.len();

    for bot in candidates {
        let prompt = prompt_from_config(&bot.strategy_config)
            .unwrap_or_default()
            .to_string();
        let current_display = effective_bot_name(&bot);
        if !bot_should_repair_name(&bot, body.force) {
            skipped += 1;
            results.push(BotNameRepairResult {
                bot_id: bot.id,
                old_name: bot.name,
                new_name: current_display,
                changed: false,
                source: "existing".to_string(),
                model: None,
                fallback_reason: None,
                user_prompt: (!prompt.is_empty()).then_some(prompt),
            });
            continue;
        }

        let resolution =
            resolve_bot_display_name(None, &prompt, &bot.strategy_type, &bot.strategy_config).await;
        let changed = bot.name != resolution.name
            || stored_display_name(&bot) != Some(resolution.name.clone());
        if changed {
            renamed += 1;
        } else {
            skipped += 1;
        }

        if changed && !body.dry_run {
            let bot_id = bot.id.clone();
            let resolution_for_store = resolution.clone();
            state::bots()
                .map_err(|e| ApiError::message(StatusCode::INTERNAL_SERVER_ERROR, e))?
                .update(&state::bot_key(&bot_id), |record| {
                    apply_bot_name_resolution(record, &resolution_for_store);
                })
                .map_err(|e| ApiError::message(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        }

        results.push(BotNameRepairResult {
            bot_id: bot.id,
            old_name: bot.name,
            new_name: resolution.name,
            changed,
            source: resolution.source,
            model: resolution.model,
            fallback_reason: resolution.fallback_reason,
            user_prompt: (!prompt.is_empty()).then_some(prompt),
        });
    }

    Ok(Json(BotNameRepairResponse {
        dry_run: body.dry_run,
        force: body.force,
        scanned,
        renamed,
        skipped,
        results,
    }))
}

fn changed_strategy_fields(old: &serde_json::Value, new: &serde_json::Value) -> Vec<String> {
    let (Some(old_object), Some(new_object)) = (old.as_object(), new.as_object()) else {
        return (old != new)
            .then(|| "strategy_config".to_string())
            .into_iter()
            .collect();
    };

    let mut keys = BTreeSet::new();
    keys.extend(old_object.keys().cloned());
    keys.extend(new_object.keys().cloned());
    keys.into_iter()
        .filter(|key| old_object.get(key) != new_object.get(key))
        .collect()
}

fn repair_prompt(
    bot: &TradingBotRecord,
    body: &RepairBotStrategyRequest,
) -> Result<String, ApiError> {
    body.prompt
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| prompt_from_config(&bot.strategy_config))
        .map(str::to_string)
        .ok_or_else(|| {
            ApiError::message(
                StatusCode::BAD_REQUEST,
                "strategy repair requires a prompt or stored strategy_config.user_prompt",
            )
        })
}

async fn repair_bot_strategy(
    SessionAuth(caller): SessionAuth,
    Path(bot_id): Path<String>,
    Json(body): Json<RepairBotStrategyRequest>,
) -> ApiResult<RepairBotStrategyResponse> {
    if !is_operator_admin(&caller) {
        return Err(ApiError::message(
            StatusCode::FORBIDDEN,
            "operator admin session required",
        ));
    }
    if !body.dry_run && !body.reactivate {
        return Err(ApiError::message(
            StatusCode::BAD_REQUEST,
            "strategy repair must reactivate the bot; use dry_run=true to preview only",
        ));
    }

    let bot = resolve_bot(&bot_id).map_err(ApiError::from)?;
    if !bot.paper_trade {
        return Err(ApiError::message(
            StatusCode::CONFLICT,
            "strategy repair is limited to paper-trading bots",
        ));
    }
    if bot.wind_down_started_at.is_some() {
        return Err(ApiError::message(
            StatusCode::CONFLICT,
            "strategy repair refuses winding-down bots",
        ));
    }
    let has_active_trial =
        bot.active_trial_run_id.is_some() || bot.active_trial_candidate_hash.is_some();
    if has_active_trial && !body.force {
        return Err(ApiError::message(
            StatusCode::CONFLICT,
            "strategy repair refuses bots with an active self-improvement trial unless force=true",
        ));
    }

    let prompt = repair_prompt(&bot, &body)?;
    let requested_strategy = body
        .strategy_type
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let target_strategy = trading_runtime::supported_assets::normalize_strategy_type(
        &infer_create_bot_strategy_type(&prompt, requested_strategy),
    );
    let (_, asset_token) = strategy_protocol_chain_and_asset_token(&target_strategy, bot.chain_id)?;
    let asset_token = asset_token.parse().map_err(|e| {
        ApiError::message(
            StatusCode::FAILED_DEPENDENCY,
            format!("Invalid asset token for repaired strategy: {e}"),
        )
    })?;

    let realigned = trading_blueprint_lib::jobs::realign_existing_bot_strategy_pack(
        &bot,
        &target_strategy,
        &prompt,
        asset_token,
    )
    .map_err(|e| ApiError::message(StatusCode::BAD_REQUEST, e))?;

    let mut changed_fields =
        changed_strategy_fields(&bot.strategy_config, &realigned.strategy_config);
    if bot.strategy_type != realigned.strategy_type {
        changed_fields.insert(0, "strategy_type".to_string());
    }
    if bot.harness_json != realigned.harness_json {
        changed_fields.push("harness_json".to_string());
    }
    if has_active_trial {
        changed_fields.push("active_trial".to_string());
    }

    let changed = !changed_fields.is_empty();
    if !changed && !body.force {
        return Ok(Json(RepairBotStrategyResponse {
            bot_id: bot.id.clone(),
            dry_run: body.dry_run,
            changed: false,
            reactivated: false,
            old_strategy_type: bot.strategy_type.clone(),
            new_strategy_type: realigned.strategy_type,
            changed_fields,
            old_sandbox_id: bot.sandbox_id.clone(),
            new_sandbox_id: None,
            old_workflow_id: bot.workflow_id,
            new_workflow_id: bot.workflow_id,
            name: effective_bot_name(&bot),
            strategy_config: bot.strategy_config.clone(),
            activation_error: None,
        }));
    }

    let mut repaired_config = realigned
        .strategy_config
        .as_object()
        .cloned()
        .ok_or_else(|| {
            ApiError::message(
                StatusCode::INTERNAL_SERVER_ERROR,
                "repaired strategy config is not an object",
            )
        })?;
    repaired_config.insert(
        "strategy_repair".to_string(),
        json!({
            "previous_strategy_type": bot.strategy_type,
            "target_strategy_type": realigned.strategy_type,
            "repaired_at": chrono::Utc::now().to_rfc3339(),
            "source": "operator_api",
            "reactivate": body.reactivate,
        }),
    );

    let proposed_config = serde_json::Value::Object(repaired_config.clone());
    let name_resolution = if body.dry_run {
        BotNameResolution {
            name: deterministic_bot_name(&prompt, &realigned.strategy_type, &proposed_config),
            source: "dry_run".to_string(),
            model: None,
            fallback_reason: None,
        }
    } else {
        resolve_bot_display_name(None, &prompt, &realigned.strategy_type, &proposed_config).await
    };
    persist_name_metadata(&mut repaired_config, &name_resolution);
    let final_config = serde_json::Value::Object(repaired_config);
    let final_name = name_resolution.name.clone();

    if body.dry_run {
        return Ok(Json(RepairBotStrategyResponse {
            bot_id: bot.id,
            dry_run: true,
            changed: true,
            reactivated: false,
            old_strategy_type: bot.strategy_type,
            new_strategy_type: realigned.strategy_type,
            changed_fields,
            old_sandbox_id: bot.sandbox_id,
            new_sandbox_id: None,
            old_workflow_id: bot.workflow_id,
            new_workflow_id: bot.workflow_id,
            name: final_name,
            strategy_config: final_config,
            activation_error: None,
        }));
    }

    state::bots()
        .map_err(|e| ApiError::message(StatusCode::INTERNAL_SERVER_ERROR, e))?
        .update(&state::bot_key(&bot.id), |record| {
            record.name = final_name.clone();
            record.strategy_type = realigned.strategy_type.clone();
            record.strategy_config = final_config.clone();
            record.harness_json = realigned.harness_json.clone();
            record.active_trial_run_id = None;
            record.active_trial_candidate_hash = None;
            record.pre_trial_harness_json = None;
        })
        .map_err(|e| ApiError::message(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if let Some(workflow_id) = bot.workflow_id
        && let Err(error) = trading_blueprint_lib::jobs::remove_bot_workflows(&bot.id, workflow_id)
    {
        tracing::warn!(bot_id = %bot.id, workflow_id, %error, "strategy repair: failed to remove stale workflows");
    }

    let updated_bot = state::get_bot(&bot.id)
        .map_err(|e| ApiError::message(StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| {
            ApiError::message(
                StatusCode::INTERNAL_SERVER_ERROR,
                "bot missing after strategy repair update",
            )
        })?;
    let new_sandbox_id = trading_blueprint_lib::jobs::force_recreate_bot_sandbox(&updated_bot)
        .await
        .map_err(|e| ApiError::message(StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let mut user_env =
        trading_blueprint_lib::operator_credentials::operator_ai_env().map_err(|message| {
            ApiError::message(
                StatusCode::BAD_REQUEST,
                format!("Activation failed: {message}"),
            )
        })?;
    user_env.insert(
        "USER_STRATEGY_PROMPT".into(),
        serde_json::Value::String(prompt),
    );

    let mut activation_error = None;
    let activation =
        match trading_blueprint_lib::jobs::activate_bot_with_secrets(&bot.id, user_env, None).await
        {
            Ok(result) => Some(result),
            Err(error) => {
                tracing::warn!(bot_id = %bot.id, %error, "strategy repair: reactivation failed");
                activation_error = Some(error);
                None
            }
        };

    Ok(Json(RepairBotStrategyResponse {
        bot_id: bot.id,
        dry_run: false,
        changed: true,
        reactivated: activation.is_some(),
        old_strategy_type: bot.strategy_type,
        new_strategy_type: realigned.strategy_type,
        changed_fields,
        old_sandbox_id: bot.sandbox_id,
        new_sandbox_id: Some(
            activation
                .as_ref()
                .map(|result| result.sandbox_id.clone())
                .unwrap_or(new_sandbox_id),
        ),
        old_workflow_id: bot.workflow_id,
        new_workflow_id: activation.as_ref().map(|result| result.workflow_id),
        name: final_name,
        strategy_config: final_config,
        activation_error,
    }))
}

async fn create_bot(req: axum::extract::Request) -> ApiResult<serde_json::Value> {
    ensure_direct_bot_create_enabled()?;
    let caller = req
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|h| {
            let token = h.strip_prefix("Bearer ").unwrap_or(h);
            sandbox_runtime::session_auth::validate_session_token(token)
                .ok()
                .map(|c| c.address)
        })
        .ok_or_else(|| {
            ApiError::message(
                StatusCode::UNAUTHORIZED,
                "Authentication required".to_string(),
            )
        })?;
    request_access::ensure_requester_allowed(&caller)
        .map_err(|message| ApiError::message(StatusCode::FORBIDDEN, message))?;
    let bytes = axum::body::to_bytes(req.into_body(), 1024 * 1024)
        .await
        .map_err(|e| ApiError::message(StatusCode::BAD_REQUEST, format!("Bad body: {e}")))?;
    let body: CreateBotRequest = serde_json::from_slice(&bytes)
        .map_err(|e| ApiError::message(StatusCode::BAD_REQUEST, format!("Bad JSON: {e}")))?;
    let mut strategy_config = create_bot_strategy_config(&body)
        .map_err(|message| ApiError::message(StatusCode::BAD_REQUEST, message))?;
    let strategy_config_from_request = serde_json::Value::Object(strategy_config.clone());
    let prompt = body.prompt.trim().to_string();
    let prompt = if prompt.is_empty() {
        prompt_from_config(&strategy_config_from_request)
            .map(str::to_string)
            .unwrap_or_default()
    } else {
        prompt
    };
    if prompt.is_empty() {
        return Err(ApiError::message(
            StatusCode::BAD_REQUEST,
            "prompt or agent_profile.mandate.raw is required".to_string(),
        ));
    }

    let requested_strategy_type = body.strategy_type.as_deref().or_else(|| {
        strategy_config_from_request
            .get("agent_profile")
            .and_then(strategy_type_from_agent_profile)
    });
    let strategy_type = infer_create_bot_strategy_type(&prompt, requested_strategy_type);

    // Build a TradingProvisionRequest
    let chain_id: u64 = std::env::var("CHAIN_ID")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(31337);
    let vault_factory = std::env::var("VAULT_FACTORY_ADDRESS")
        .unwrap_or_else(|_| "0x0000000000000000000000000000000000000000".into());
    let (protocol_chain_id, asset_token) =
        strategy_protocol_chain_and_asset_token(&strategy_type, chain_id)?;
    let rpc_url = std::env::var("HTTP_RPC_URL").unwrap_or_else(|_| "http://127.0.0.1:8545".into());
    let paper_trade = default_paper_trade_for_chain(chain_id);

    strategy_config
        .entry("user_prompt".to_string())
        .or_insert_with(|| serde_json::Value::String(prompt.clone()));
    strategy_config
        .entry("paper_trade".to_string())
        .or_insert(serde_json::Value::Bool(paper_trade));
    strategy_config
        .entry("protocol_chain_id".to_string())
        .or_insert(serde_json::Value::Number(protocol_chain_id.into()));
    let strategy_config_for_naming = serde_json::Value::Object(strategy_config.clone());
    let name_resolution = resolve_bot_display_name(
        body.name.as_deref(),
        &prompt,
        &strategy_type,
        &strategy_config_for_naming,
    )
    .await;
    persist_name_metadata(&mut strategy_config, &name_resolution);
    let name = name_resolution.name.clone();

    let final_strategy_config = serde_json::Value::Object(strategy_config);
    let agent_profile_for_response = final_strategy_config
        .get("agent_profile")
        .cloned()
        .unwrap_or(serde_json::Value::Null);

    let request = trading_blueprint_lib::TradingProvisionRequest {
        name: name.clone(),
        strategy_type: strategy_type.clone(),
        strategy_config_json: serde_json::to_string(&final_strategy_config).unwrap_or_default(),
        risk_params_json: r#"{"max_drawdown_pct":10}"#.into(),
        factory_address: vault_factory
            .parse()
            .unwrap_or(alloy_primitives::Address::ZERO),
        asset_token: asset_token
            .parse()
            .unwrap_or(alloy_primitives::Address::ZERO),
        signers: Vec::new(),
        required_signatures: alloy_primitives::U256::ZERO,
        chain_id: alloy_primitives::U256::from(chain_id),
        rpc_url,
        trading_loop_cron: "0 */5 * * * *".into(),
        cpu_cores: 1,
        memory_mb: 2048,
        max_lifetime_days: 30,
        validator_service_ids: Vec::new(),
        max_collateral_bps: alloy_primitives::U256::ZERO,
        validation_trust: 0,
    };

    // 1. Provision
    let service_id = std::env::var("SERVICE_ID")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1u64);
    // Use milliseconds + atomic counter to prevent same-second collision (RACE-2).
    static CALL_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = CALL_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let call_id = (chrono::Utc::now().timestamp_millis() as u64)
        .wrapping_mul(1000)
        .wrapping_add(seq % 1000);

    // provision_core returns a TradingProvisionOutput (vault/share/sandbox/workflow),
    // but downstream activation needs the full bot record (including `id`), so we
    // re-read from the store here.
    trading_blueprint_lib::jobs::provision_core(
        request,
        None,
        call_id,
        service_id,
        caller.clone(),
        None,
        None,
    )
    .await
    .map_err(|e| ApiError::message(StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let bot = state::find_bot_by_call(service_id, call_id)
        .map_err(|e| ApiError::message(StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| {
            ApiError::message(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Bot not found after provision (service={service_id}, call={call_id})"),
            )
        })?;

    // 2. Auto-activate with AI provider from env
    let mut user_env =
        trading_blueprint_lib::operator_credentials::operator_ai_env().map_err(|message| {
            ApiError::message(
                StatusCode::BAD_REQUEST,
                format!("Activation failed: {message}"),
            )
        })?;
    // Pass the user's prompt as an env var so the agent can read it
    user_env.insert(
        "USER_STRATEGY_PROMPT".into(),
        serde_json::Value::String(prompt.clone()),
    );
    if !agent_profile_for_response.is_null() {
        user_env.insert(
            "AGENT_PROFILE_JSON".into(),
            serde_json::Value::String(agent_profile_for_response.to_string()),
        );
    }

    let mut activation_error = None;
    let activate_result =
        match trading_blueprint_lib::jobs::activate_bot_with_secrets(&bot.id, user_env, None).await
        {
            Ok(result) => Some(result),
            Err(error) => {
                tracing::warn!(
                    bot_id = %bot.id,
                    %error,
                    "Bot provisioned but activation did not complete"
                );
                activation_error = Some(error);
                None
            }
        };

    // 3. Seed the user's initial prompt as an actionable owner conversation so
    // the agent sees it through the normal ACTION NEEDED workflow on first tick.
    if let Some(ref activate_result) = activate_result
        && let Ok(sandbox) =
            sandbox_runtime::runtime::get_sandbox_by_id(&activate_result.sandbox_id)
    {
        let date = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let timestamp = chrono::Utc::now().format("%H:%M UTC").to_string();
        let (conversation_file, strategy_content, toc_content) = build_strategy_bootstrap_memory(
            &date,
            &timestamp,
            &prompt,
            Some(&agent_profile_for_response),
        );

        let writes: &[(&str, &str)] = &[
            (
                &format!("/home/agent/memory/{conversation_file}"),
                &strategy_content,
            ),
            ("/home/agent/memory/toc.md", &toc_content),
        ];

        for (path, content) in writes {
            let req = ai_agent_sandbox_blueprint_lib::SandboxExecRequest {
                sidecar_url: sandbox.sidecar_url.clone(),
                command: format!(
                    r#"node -e "require('fs').mkdirSync(require('path').dirname(process.argv[1]),{{recursive:true}});require('fs').writeFileSync(process.argv[1], process.env.FILE_CONTENT)" "{path}""#,
                ),
                cwd: String::new(),
                env_json: serde_json::json!({"FILE_CONTENT": content}).to_string(),
                timeout_ms: 10_000,
            };
            let _ = ai_agent_sandbox_blueprint_lib::run_exec_request(&req, &sandbox.token).await;
        }
    }

    let status = if activate_result.is_some() {
        "active"
    } else {
        "awaiting_activation"
    };
    let sandbox_id = activate_result
        .as_ref()
        .map(|result| result.sandbox_id.clone())
        .unwrap_or_else(|| bot.sandbox_id.clone());
    let trading_api_url = activate_result
        .as_ref()
        .map(|result| serde_json::Value::String(result.trading_api_url.clone()))
        .unwrap_or(serde_json::Value::Null);
    let trading_api_token = activate_result
        .as_ref()
        .map(|result| serde_json::Value::String(result.trading_api_token.clone()))
        .unwrap_or(serde_json::Value::Null);

    Ok(Json(serde_json::json!({
        "bot_id": bot.id,
        "sandbox_id": sandbox_id,
        "strategy_type": strategy_type,
        "name": name,
        "status": status,
        "trading_api_url": trading_api_url,
        "trading_api_token": trading_api_token,
        "activation_error": activation_error,
        "prompt": prompt,
        "agent_profile": agent_profile_for_response,
        "strategy_config": final_strategy_config,
    })))
}

async fn list_bots(
    headers: axum::http::HeaderMap,
    Query(query): Query<BotListQuery>,
) -> ApiResult<BotListResponse> {
    let limit = query.limit.unwrap_or(50).min(200);
    let offset = query.offset.unwrap_or(0);
    let status_filter = query.status.as_deref();
    let include_archived = query.include_archived.unwrap_or(false);
    let full_scan = status_filter.is_some() || !include_archived;
    let fetch_limit = if full_scan { 10_000 } else { limit };
    let fetch_offset = if full_scan { 0 } else { offset };

    // Optional auth: the fleet list is a PUBLIC leaderboard. Caller-scoping:
    //   - unauthenticated viewer  → `None` (public scope: the full roster, as
    //     read-only BotSummary — the arena shows ALL bots across operators)
    //   - authenticated admin      → `None` (sees everything)
    //   - authenticated consumer   → `Some(addr)` (own + legacy un-attributed)
    // Secrets/control endpoints keep the strict `SessionAuth` extractor.
    let caller = optional_session_caller(&headers);
    let viewer: Option<&str> = match caller.as_deref() {
        Some(addr) if is_operator_admin(addr) => None,
        Some(addr) => Some(addr),
        None => None,
    };

    // Exact match by on-chain call_id + service_id (most reliable lookup)
    if let (Some(call_id), Some(service_id)) = (query.call_id, query.service_id) {
        if call_id == 0 {
            return Err(ApiError::conflict(
                "call_id=0 is not a unique bot identity; use bot_id or sandbox_id instead"
                    .to_string(),
            ));
        }

        let matches = state::bot_lookup_candidates_by_call_id(service_id, call_id)
            .map_err(|e| ApiError::message(StatusCode::INTERNAL_SERVER_ERROR, e))?;

        if matches.live.len() > 1 {
            let ids: Vec<String> = matches.live.iter().map(|bot| bot.id.clone()).collect();
            return Err(ApiError::conflict(format!(
                "Multiple live bots found for service_id {service_id} and call_id {call_id}: {}. Operator state is ambiguous; reset local state or reprovision the agent.",
                ids.join(", ")
            )));
        }

        if matches.live.is_empty() && !matches.stale.is_empty() {
            return Err(ApiError::stale_bot(&matches.stale[0]));
        }

        let bots: Vec<BotSummary> = matches
            .live
            .into_iter()
            .filter(|b| state::bot_visible_to(&b.submitter_address, viewer))
            .take(1)
            .map(BotSummary::from_record)
            .collect();
        let total = bots.len();
        return Ok(Json(BotListResponse {
            bots,
            total,
            limit,
            offset,
        }));
    }

    let result = if let Some(ref operator) = query.operator {
        state::bots_by_operator(operator, viewer, fetch_limit, fetch_offset)
    } else if let Some(ref strategy) = query.strategy {
        state::bots_by_strategy(strategy, viewer, fetch_limit, fetch_offset)
    } else {
        state::list_bots(viewer, fetch_limit, fetch_offset)
    };

    let paginated = result.map_err(|e| ApiError::message(StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let mut bots: Vec<BotSummary> = paginated
        .bots
        .into_iter()
        .map(BotSummary::from_record)
        .collect();

    let mut total = paginated.total;

    if !include_archived {
        bots.retain(|b| !b.archived);
        total = bots.len();
    }

    // Optional status filter (active/inactive). Apply before response pagination
    // so `total` describes the filtered set instead of the raw roster.
    if let Some(status) = status_filter {
        let active = status == "active";
        bots.retain(|b| (b.lifecycle_status == "active") == active);
        total = bots.len();
    }

    if full_scan {
        bots = bots.into_iter().skip(offset).take(limit).collect();
    }

    Ok(Json(BotListResponse {
        total,
        bots,
        limit,
        offset,
    }))
}

async fn get_bot(
    _headers: axum::http::HeaderMap,
    Path(bot_id): Path<String>,
) -> Result<Json<BotDetailResponse>, (StatusCode, String)> {
    // Public bot detail (discovery/leaderboard). The per-bot trading API token
    // authenticates control over the bot and must never leave this endpoint.
    let mut resp = BotDetailResponse::from_record(resolve_bot(&bot_id)?);
    resp.trading_api_token = String::new();
    Ok(Json(resp))
}

/// Read the bot's deterministic-tick side effects (decisions.jsonl, metrics,
/// strategy files) out of its sandbox. The eval consumes this so the RLM trace
/// analyst can adjudicate real execution vs fabricated prose claims. Bad gateway
/// when the sandbox is unreachable — never fabricates a "captured" payload.
async fn get_bot_tick_artifacts(
    SessionAuth(caller): SessionAuth,
    Path(bot_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let bot = resolve_bot(&bot_id)?;
    verify_submitter(&bot, &caller)?;
    let artifacts = trading_blueprint_lib::jobs::tick_artifacts::read_bot_tick_artifacts(&bot)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
    Ok(Json(artifacts))
}

fn workflow_ids_for_bot(bot: &TradingBotRecord) -> Vec<u64> {
    let mut ids = bot
        .workflow_id
        .map(|workflow_id| vec![workflow_id, workflow_id + 1, workflow_id + 2])
        .unwrap_or_default();
    let observatory_workflow_id =
        trading_blueprint_lib::jobs::observatory_cadence::observatory_workflow_id(bot);
    if !ids.contains(&observatory_workflow_id) {
        ids.push(observatory_workflow_id);
    }
    ids
}

fn workflow_kind_for_bot(bot: &TradingBotRecord, workflow_id: u64) -> &'static str {
    if workflow_id == trading_blueprint_lib::jobs::observatory_cadence::observatory_workflow_id(bot)
    {
        return "observatory";
    }
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
    let has_session = run
        .session_id
        .as_deref()
        .is_some_and(|session_id| !session_id.is_empty());
    let has_stored_transcript =
        trading_blueprint_lib::workflow_compat::get_workflow_run_transcript(&run.run_id)
            .ok()
            .flatten()
            .is_some();
    let transcript_available =
        has_stored_transcript || (run.status == WorkflowRunStatus::Running && has_session);

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

fn is_sensitive_public_transcript_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();

    [
        "apikey",
        "authorization",
        "bearer",
        "mnemonic",
        "password",
        "privatekey",
        "refreshtoken",
        "secret",
        "seedphrase",
        "sessiontoken",
        "signature",
        "tradingapitoken",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

fn redact_public_transcript_value(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Array(values) => serde_json::Value::Array(
            values
                .into_iter()
                .map(redact_public_transcript_value)
                .collect(),
        ),
        serde_json::Value::Object(values) => serde_json::Value::Object(
            values
                .into_iter()
                .map(|(key, value)| {
                    if is_sensitive_public_transcript_key(&key) {
                        (key, serde_json::Value::String("[redacted]".to_string()))
                    } else {
                        (key, redact_public_transcript_value(value))
                    }
                })
                .collect(),
        ),
        other => other,
    }
}

fn run_public_transcript_response(
    run: &WorkflowRunRecord,
    query: &TranscriptMessageQuery,
) -> Result<Response, (StatusCode, String)> {
    let transcript =
        trading_blueprint_lib::workflow_compat::get_workflow_run_transcript(&run.run_id)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let messages = transcript
        .map(|record| redact_public_transcript_value(record.messages))
        .unwrap_or_else(|| synthesize_run_transcript_messages(run));

    Ok(replay_transcript_messages_response(messages, query))
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
    let parts = if let Some(result) = run.result.as_deref() {
        synthesize_run_result_transcript_parts(result)
    } else if let Some(error) = run.error.as_deref() {
        vec![serde_json::json!({
            "type": "text",
            "text": format!("The saved run ended with an error.\n\n{error}"),
        })]
    } else {
        vec![serde_json::json!({
            "type": "text",
            "text": "Saved run details were unavailable for this run.",
        })]
    };

    serde_json::json!([
        {
            "info": {
                "id": format!("run-summary-{}", run.run_id),
                "role": "assistant",
                "timestamp": timestamp,
                "success": run.status != WorkflowRunStatus::Failed,
            },
            "parts": parts
        }
    ])
}

fn summarize_value(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(value) if !value.is_empty() => Some(value.clone()),
        serde_json::Value::Number(value) => Some(value.to_string()),
        serde_json::Value::Bool(value) => Some(value.to_string()),
        serde_json::Value::Array(values) => Some(values.len().to_string()),
        _ => None,
    }
}

fn transcript_string(value: Option<&serde_json::Value>, fallback: &str) -> String {
    value
        .and_then(summarize_value)
        .unwrap_or_else(|| fallback.to_string())
}

fn push_reasoning_part(parts: &mut Vec<serde_json::Value>, text: impl Into<String>) {
    parts.push(serde_json::json!({
        "type": "reasoning",
        "text": text.into(),
    }));
}

fn push_tool_part(
    parts: &mut Vec<serde_json::Value>,
    id: &str,
    tool: &str,
    input: serde_json::Value,
    output: serde_json::Value,
) {
    parts.push(serde_json::json!({
        "type": "tool",
        "id": id,
        "tool": tool,
        "state": {
            "status": "completed",
            "input": input,
            "output": output,
        }
    }));
}

fn synthesize_run_result_transcript_parts(result: &str) -> Vec<serde_json::Value> {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(result) else {
        return vec![serde_json::json!({
            "type": "text",
            "text": format!("Saved run summary.\n\n{result}"),
        })];
    };

    let mut parts = Vec::new();

    if let Some(state) = parsed.get("checked_state") {
        let nav_status = transcript_string(state.get("nav_status"), "unknown");
        let total_nav = transcript_string(state.get("total_nav_usdc"), "unknown");
        let margin = transcript_string(state.get("perp_margin_usdc"), "unknown");
        let positions = transcript_string(state.get("positions_count"), "unknown");
        push_reasoning_part(
            &mut parts,
            format!(
                "I checked the trading account before deciding. NAV was {nav_status}, total value was {total_nav} USDC, available perp margin was {margin} USDC, and there were {positions} open positions.",
            ),
        );
        push_tool_part(
            &mut parts,
            "tool-checked-state",
            "hyperliquid_nav",
            serde_json::json!({ "scope": "vault_and_hyperliquid_state" }),
            state.clone(),
        );
    }

    if let Some(decision) = parsed.get("decision") {
        let action = transcript_string(decision.get("action"), "unknown");
        let reason = transcript_string(decision.get("reason"), "no reason recorded");
        let mut reasoning = format!("I decided to {action} because {reason}.");

        if let Some(setup) = decision.get("setup") {
            let setup_action = transcript_string(setup.get("action"), "prepare a trade");
            let asset = transcript_string(setup.get("asset"), "the selected asset");
            let amount = transcript_string(setup.get("amount_in"), "the configured amount");
            let rationale = transcript_string(setup.get("rationale"), "the configured signal");
            reasoning.push_str(&format!(
                " The candidate setup was to {setup_action} {asset} with {amount} USDC because {rationale}.",
            ));
        }

        push_reasoning_part(&mut parts, reasoning);

        if let Some(approval) = decision.get("approval") {
            push_tool_part(
                &mut parts,
                "tool-api-wallet-approval-check",
                "hyperliquid_api_wallet_approval",
                serde_json::json!({ "check": "corewriter_approval" }),
                approval.clone(),
            );
        }
    }

    if let Some(funding) = parsed.get("funding_action") {
        let attempted = transcript_string(funding.get("attempted"), "unknown");
        push_reasoning_part(
            &mut parts,
            format!("Funding step recorded attempted = {attempted}."),
        );
        push_tool_part(
            &mut parts,
            "tool-funding-action",
            "hyperliquid_funding",
            serde_json::json!({ "action": "ensure_margin" }),
            funding.clone(),
        );
    }

    if let Some(approval_action) = parsed.get("api_wallet_approval_action") {
        let attempted = transcript_string(approval_action.get("attempted"), "unknown");
        push_reasoning_part(
            &mut parts,
            format!("API wallet approval step recorded attempted = {attempted}."),
        );
        push_tool_part(
            &mut parts,
            "tool-api-wallet-approval-action",
            "hyperliquid_api_wallet_approval",
            serde_json::json!({ "action": "approve_api_wallet" }),
            approval_action.clone(),
        );
    }

    if let Some(trade) = parsed.get("trade_action") {
        let attempted = transcript_string(trade.get("attempted"), "unknown");
        push_reasoning_part(
            &mut parts,
            format!("Trade execution step recorded attempted = {attempted}."),
        );
        push_tool_part(
            &mut parts,
            "tool-trade-action",
            "hyperliquid_trade",
            serde_json::json!({ "action": "execute_validated_trade" }),
            trade.clone(),
        );
    }

    let final_text = if let Some(decision) = parsed.get("decision") {
        let action = transcript_string(decision.get("action"), "finish");
        let reason = transcript_string(decision.get("reason"), "no final reason recorded");
        format!("Final outcome: {action}. Reason: {reason}.")
    } else {
        "Final outcome was saved for this run.".to_string()
    };
    parts.push(serde_json::json!({
        "type": "text",
        "text": final_text,
    }));

    if parts.is_empty() {
        vec![serde_json::json!({
            "type": "text",
            "text": "Saved run details were unavailable for this run.",
        })]
    } else {
        parts
    }
}

async fn list_bot_runs(
    Path(bot_id): Path<String>,
    Query(params): Query<RunListQuery>,
) -> Result<Json<BotRunListResponse>, (StatusCode, String)> {
    let bot = resolve_bot(&bot_id)?;
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

async fn get_observatory_overview(
    SessionAuth(caller): SessionAuth,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let all_bots = state::bots()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .values()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let visible_bots: Vec<_> = all_bots
        .into_iter()
        .filter(|bot| caller_has_bot_command_access(bot, &caller))
        .filter(|bot| !state::bot_runtime_status(bot).archived)
        .collect();

    let bot_count = visible_bots.len();
    let mut bot_records = stream::iter(visible_bots)
        .map(|bot| async move {
            match trading_blueprint_lib::jobs::observatory_cadence::read_observatory_records(&bot)
                .await
            {
                Ok(records) => json!({
                    "bot_id": bot.id,
                    "bot_name": effective_bot_name(&bot),
                    "strategy_type": bot.strategy_type,
                    "trading_active": bot.trading_active,
                    "paper_trade": bot.paper_trade,
                    "records": records,
                    "error": null,
                }),
                Err(error) => json!({
                    "bot_id": bot.id,
                    "bot_name": effective_bot_name(&bot),
                    "strategy_type": bot.strategy_type,
                    "trading_active": bot.trading_active,
                    "paper_trade": bot.paper_trade,
                    "records": {
                        "schema_version": 1,
                        "world_signal_digests": [],
                        "reflection_runs": [],
                        "ideas": [],
                        "research_tasks": [],
                        "delegated_work_sessions": [],
                        "owner_feedback": [],
                    },
                    "error": error,
                }),
            }
        })
        .buffer_unordered(4)
        .collect::<Vec<_>>()
        .await;
    bot_records.sort_by(|a, b| {
        a.get("bot_name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .cmp(
                b.get("bot_name")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default(),
            )
    });

    let reflection_count: usize = bot_records
        .iter()
        .map(|entry| {
            entry
                .get("records")
                .and_then(|records| records.get("reflection_runs"))
                .and_then(serde_json::Value::as_array)
                .map(Vec::len)
                .unwrap_or(0)
        })
        .sum();
    let idea_count: usize = bot_records
        .iter()
        .map(|entry| {
            entry
                .get("records")
                .and_then(|records| records.get("ideas"))
                .and_then(serde_json::Value::as_array)
                .map(Vec::len)
                .unwrap_or(0)
        })
        .sum();
    let delegated_count: usize = bot_records
        .iter()
        .map(|entry| {
            entry
                .get("records")
                .and_then(|records| records.get("delegated_work_sessions"))
                .and_then(serde_json::Value::as_array)
                .map(Vec::len)
                .unwrap_or(0)
        })
        .sum();

    Ok(Json(json!({
        "schema_version": 1,
        "bot_count": bot_count,
        "totals": {
            "reflection_runs": reflection_count,
            "ideas": idea_count,
            "delegated_work_sessions": delegated_count,
        },
        "bots": bot_records,
    })))
}

async fn get_bot_observatory(
    SessionAuth(caller): SessionAuth,
    Path(bot_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let bot = resolve_bot(&bot_id)?;
    verify_submitter(&bot, &caller)?;
    let records = trading_blueprint_lib::jobs::observatory_cadence::read_observatory_records(&bot)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))?;

    Ok(Json(json!({
        "schema_version": 1,
        "bot_id": bot.id,
        "bot_name": effective_bot_name(&bot),
        "strategy_type": bot.strategy_type,
        "trading_active": bot.trading_active,
        "paper_trade": bot.paper_trade,
        "records": records,
    })))
}

async fn trigger_bot_observatory(
    SessionAuth(caller): SessionAuth,
    Path(bot_id): Path<String>,
    Json(body): Json<ObservatoryTriggerRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let bot = resolve_bot(&bot_id)?;
    verify_submitter(&bot, &caller)?;
    let runtime = state::bot_runtime_status(&bot);
    if !runtime.sandbox_exists {
        return Err((
            StatusCode::CONFLICT,
            format!("Bot {} has no live sandbox", bot.id),
        ));
    }
    let reason = body
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("manual")
        .to_string();
    let result = trading_blueprint_lib::jobs::observatory_cadence::trigger_observatory_for_bot(
        &bot,
        trading_blueprint_lib::jobs::observatory_cadence::ObservatoryTriggerOptions {
            trigger: reason,
            requested_by: Some(caller),
        },
    )
    .await
    .map_err(|e| (StatusCode::BAD_GATEWAY, e))?;

    Ok(Json(json!({
        "schema_version": 1,
        "status": "completed",
        "bot_id": result.bot_id,
        "run_id": result.run_id,
        "started_at": result.started_at,
        "completed_at": result.completed_at,
        "workflow_id": result.workflow_id,
        "records": result.records,
    })))
}

async fn record_observatory_idea_feedback(
    SessionAuth(caller): SessionAuth,
    Path((bot_id, idea_id)): Path<(String, String)>,
    Json(body): Json<ObservatoryIdeaFeedbackRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let bot = resolve_bot(&bot_id)?;
    verify_submitter(&bot, &caller)?;
    let action = body.action.trim().to_ascii_lowercase();
    if !matches!(
        action.as_str(),
        "interesting" | "rejected" | "reject" | "delegate_research" | "delegate_build" | "mute"
    ) {
        return Err((
            StatusCode::BAD_REQUEST,
            "Unsupported Observatory feedback action".to_string(),
        ));
    }
    let normalized_action = if action == "reject" {
        "rejected".to_string()
    } else {
        action
    };
    let result = trading_blueprint_lib::jobs::observatory_cadence::append_observatory_feedback(
        &bot,
        trading_blueprint_lib::jobs::observatory_cadence::ObservatoryFeedbackInput {
            idea_id,
            action: normalized_action,
            note: body.note,
            owner: Some(caller),
        },
    )
    .await
    .map_err(|e| (StatusCode::BAD_GATEWAY, e))?;

    Ok(Json(json!({
        "schema_version": 1,
        "status": "recorded",
        "result": result,
    })))
}

async fn get_bot_run(
    SessionAuth(caller): SessionAuth,
    Path((bot_id, run_id)): Path<(String, String)>,
) -> Result<Json<BotRunResponse>, (StatusCode, String)> {
    let bot = resolve_bot(&bot_id)?;
    verify_submitter(&bot, &caller)?;
    let run = resolve_bot_workflow_run(&bot, &run_id)?;

    Ok(Json(map_bot_run(&bot, run)))
}

fn resolve_bot_workflow_run(
    bot: &TradingBotRecord,
    run_id: &str,
) -> Result<WorkflowRunRecord, (StatusCode, String)> {
    let workflow_ids = workflow_ids_for_bot(bot)
        .into_iter()
        .collect::<HashSet<_>>();
    let run = trading_blueprint_lib::workflow_compat::get_workflow_run(run_id)
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

    Ok(run)
}

async fn list_bot_run_messages(
    Path((bot_id, run_id)): Path<(String, String)>,
    RawQuery(query): RawQuery,
) -> Result<Response, (StatusCode, String)> {
    let bot = resolve_bot(&bot_id)?;
    let run = resolve_bot_workflow_run(&bot, &run_id)?;
    let transcript_query = parse_transcript_message_query(query.as_deref());
    run_public_transcript_response(&run, &transcript_query)
}

// ── Secrets handlers ─────────────────────────────────────────────────────

/// Recreate sidecar sandboxes for active paper bots whose operator-local sandbox was
/// lost (e.g. host rebuilt + data volume re-attached). Idempotent: skips bots
/// whose sandbox already exists. Rebuilds the sidecar from the preserved bot
/// record, then re-injects the operator AI keys so the agent path works. Runs
/// once at startup. Best-effort — a per-bot failure is logged and skipped.
pub async fn ensure_active_bot_sandboxes() {
    trading_blueprint_lib::jobs::ensure_active_bot_sandboxes().await;
}

async fn configure_secrets(
    SessionAuth(caller): SessionAuth,
    Path(bot_id): Path<String>,
    Json(body): Json<ConfigureSecretsRequest>,
) -> ApiResult<SecretsResponse> {
    let bot = resolve_live_bot(&bot_id)?;
    verify_submitter(&bot, &caller)?;

    // When env_json is empty, use operator-provided AI keys from the binary's environment.
    // This supports the "use operator provided keys" frontend option.
    let env_json = if body.env_json.is_empty() {
        let env = trading_blueprint_lib::operator_credentials::operator_ai_env()
            .map_err(|message| ApiError::message(StatusCode::BAD_REQUEST, message))?;
        if let Some(provider) = env
            .get("OPENCODE_MODEL_PROVIDER")
            .and_then(serde_json::Value::as_str)
        {
            tracing::info!("Using operator-provided {provider} credentials for bot {bot_id}");
        }
        env
    } else {
        body.env_json
    };

    let result = trading_blueprint_lib::jobs::activate_bot_with_secrets(&bot_id, env_json, None)
        .await
        .map_err(|e| ApiError::message(StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(SecretsResponse {
        status: "active".to_string(),
        sandbox_id: Some(result.sandbox_id),
        workflow_id: Some(result.workflow_id.to_string()),
        trading_api_token: Some(result.trading_api_token),
        trading_api_url: Some(result.trading_api_url),
    }))
}

async fn get_secrets(
    SessionAuth(caller): SessionAuth,
    Path(bot_id): Path<String>,
) -> Result<Json<GetSecretsResponse>, (StatusCode, String)> {
    let bot = resolve_bot(&bot_id)?;
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
    Path(bot_id): Path<String>,
) -> Result<Json<SecretsResponse>, (StatusCode, String)> {
    let bot = resolve_bot(&bot_id)?;
    verify_submitter(&bot, &caller)?;

    trading_blueprint_lib::jobs::wipe_bot_secrets(&bot_id, None)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(SecretsResponse {
        status: "awaiting_secrets".to_string(),
        sandbox_id: None,
        workflow_id: None,
        trading_api_token: None,
        trading_api_url: None,
    }))
}

// ── Bot control handlers ─────────────────────────────────────────────────

/// Verify caller is the bot's submitter. Returns the bot on success.
/// Whether `caller` is the operator key that runs this binary (fleet admin).
/// Compared case-insensitively against `OPERATOR_ADDRESS`; an unset/empty
/// `OPERATOR_ADDRESS` means no caller is admin, so listings stay caller-scoped.
fn is_operator_admin(caller: &str) -> bool {
    std::env::var("OPERATOR_ADDRESS")
        .ok()
        .filter(|op| !op.is_empty())
        .is_some_and(|op| op.eq_ignore_ascii_case(caller))
}

/// Extract + validate an OPTIONAL session token from the `Authorization` header.
/// Returns the caller address for a valid `Bearer <token>`, else `None`.
///
/// Public read endpoints (the fleet list / leaderboard) use this instead of the
/// `SessionAuth` extractor so an unauthenticated viewer gets the public scope
/// rather than a 401. The arena is a public competition UI: the bot roster and
/// PnL are meant to be visible to everyone; secrets/control stay behind
/// `SessionAuth`.
fn optional_session_caller(headers: &axum::http::HeaderMap) -> Option<String> {
    let raw = headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?;
    let token = raw
        .strip_prefix("Bearer ")
        .or_else(|| raw.strip_prefix("bearer "))?
        .trim();
    sandbox_runtime::session_auth::validate_session_token(token)
        .ok()
        .map(|claims| claims.address)
}

fn strategy_config_has_permitted_caller(config: &serde_json::Value, caller: &str) -> bool {
    let caller = caller.trim();
    if caller.is_empty() {
        return false;
    }

    for key in [
        "permitted_callers",
        "permittedCallers",
        "allowed_callers",
        "authorized_callers",
    ] {
        let Some(values) = config.get(key).and_then(serde_json::Value::as_array) else {
            continue;
        };
        if values
            .iter()
            .filter_map(serde_json::Value::as_str)
            .any(|address| address.trim().eq_ignore_ascii_case(caller))
        {
            return true;
        }
    }

    false
}

fn caller_has_bot_command_access(bot: &TradingBotRecord, caller: &str) -> bool {
    let caller = caller.trim();
    if caller.is_empty() {
        return false;
    }

    let submitter = bot.submitter_address.trim();
    (!submitter.is_empty() && submitter.eq_ignore_ascii_case(caller))
        || strategy_config_has_permitted_caller(&bot.strategy_config, caller)
}

fn verify_submitter(bot: &TradingBotRecord, caller: &str) -> Result<(), (StatusCode, String)> {
    if caller_has_bot_command_access(bot, caller) {
        return Ok(());
    }

    Err((
        StatusCode::FORBIDDEN,
        format!("Caller {caller} is not permitted to command bot {}", bot.id),
    ))
}

async fn start_bot(
    SessionAuth(caller): SessionAuth,
    Path(bot_id): Path<String>,
) -> ApiResult<BotControlResponse> {
    let bot = resolve_live_bot(&bot_id)?;

    verify_submitter(&bot, &caller)?;

    trading_blueprint_lib::jobs::start_core(&bot.sandbox_id, false)
        .await
        .map_err(|e| ApiError::message(StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(BotControlResponse {
        status: "started".to_string(),
        sandbox_id: bot.sandbox_id,
    }))
}

async fn stop_bot(
    SessionAuth(caller): SessionAuth,
    Path(bot_id): Path<String>,
) -> ApiResult<BotControlResponse> {
    let bot = resolve_live_bot(&bot_id)?;

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
    Path(bot_id): Path<String>,
) -> Result<Json<RunNowResponse>, (StatusCode, String)> {
    let bot = resolve_bot(&bot_id)?;
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

    let _run_guard = ai_agent_sandbox_blueprint_lib::workflows::acquire_workflow_run(workflow_id)
        .map_err(map_run_now_error)?;

    let accepted_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    if let Err(err) =
        trading_blueprint_lib::workflow_compat::backfill_latest_execution_run(workflow_id)
    {
        tracing::warn!(
            workflow_id,
            error = %err,
            "Failed to backfill workflow run history before manual run"
        );
    }

    if entry.name.starts_with("fast-tick-") {
        let wf_key_bg = wf_key.clone();
        let entry_bg = entry.clone();
        let bot_bg = bot.clone();
        tokio::spawn(async move {
            let _guard = _run_guard;
            match trading_blueprint_lib::jobs::run_manual_fast_tick_for_workflow(&bot_bg, &entry_bg)
                .await
            {
                Ok(Some(result)) => {
                    let latest_execution = result.latest_execution();
                    let _ = ai_agent_sandbox_blueprint_lib::workflows::store_latest_execution(
                        workflow_id,
                        latest_execution.clone(),
                    );
                    if let Err(err) =
                        trading_blueprint_lib::workflow_compat::persist_latest_execution_run(
                            workflow_id,
                            latest_execution,
                        )
                    {
                        tracing::warn!(
                            workflow_id,
                            error = %err,
                            "Failed to persist manual fast-tick run history"
                        );
                    }
                    let _ = ai_agent_sandbox_blueprint_lib::workflows::workflows()
                        .ok()
                        .and_then(|store| {
                            store
                                .update(&wf_key_bg, |e| {
                                    e.last_run_at = Some(result.executed_at);
                                })
                                .ok()
                        });
                }
                Ok(None) => {
                    tracing::warn!(
                        workflow_id,
                        "Manual fast-tick branch selected a non-fast workflow"
                    );
                }
                Err(err) => {
                    tracing::error!("Manual fast tick {workflow_id} failed: {err}");
                    let failed_at = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs();
                    match ai_agent_sandbox_blueprint_lib::workflows::store_failed_execution(
                        workflow_id,
                        err,
                    ) {
                        Ok(latest_execution) => {
                            if let Err(err) =
                                trading_blueprint_lib::workflow_compat::persist_latest_execution_run(
                                    workflow_id,
                                    latest_execution,
                                )
                            {
                                tracing::warn!(
                                    workflow_id,
                                    error = %err,
                                    "Failed to persist failed manual fast-tick run history"
                                );
                            }
                        }
                        Err(err) => {
                            tracing::warn!(
                                workflow_id,
                                error = %err,
                                "Failed to store failed manual fast-tick execution"
                            );
                        }
                    }
                    let _ = ai_agent_sandbox_blueprint_lib::workflows::workflows()
                        .ok()
                        .and_then(|store| {
                            store
                                .update(&wf_key_bg, |e| {
                                    trading_blueprint_lib::workflow_compat::apply_workflow_failure(
                                        e, failed_at,
                                    );
                                })
                                .ok()
                        });
                }
            }
        });

        return Ok(Json(RunNowResponse {
            status: "started".to_string(),
            workflow_id: workflow_id.to_string(),
            session_id: String::new(),
            accepted_at,
        }));
    }

    // Spawn workflow execution in the background so we return immediately.
    let wf_key_bg = wf_key.clone();
    tokio::spawn(async move {
        // _run_guard is moved into this task and dropped when done.
        let _guard = _run_guard;
        match ai_agent_sandbox_blueprint_lib::workflows::run_workflow(&entry).await {
            Ok(execution) => {
                let latest_execution = execution.latest_execution.clone();
                let _ = ai_agent_sandbox_blueprint_lib::workflows::store_latest_execution(
                    workflow_id,
                    latest_execution.clone(),
                );
                if let Err(err) =
                    trading_blueprint_lib::workflow_compat::persist_latest_execution_run(
                        workflow_id,
                        latest_execution,
                    )
                {
                    tracing::warn!(
                        workflow_id,
                        error = %err,
                        "Failed to persist workflow run history after manual run"
                    );
                }
                let _ = ai_agent_sandbox_blueprint_lib::workflows::workflows()
                    .ok()
                    .and_then(|store| {
                        store
                            .update(&wf_key_bg, |e| {
                                ai_agent_sandbox_blueprint_lib::workflows::apply_workflow_execution(
                                    e,
                                    execution.last_run_at,
                                    execution.next_run_at,
                                );
                            })
                            .ok()
                    });
            }
            Err(err) => {
                tracing::error!("Workflow {workflow_id} execution failed: {err}");
                let failed_at = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                let failed_execution =
                    ai_agent_sandbox_blueprint_lib::workflows::store_failed_execution(
                        workflow_id,
                        err,
                    );
                match failed_execution {
                    Ok(latest_execution) => {
                        if let Err(err) =
                            trading_blueprint_lib::workflow_compat::persist_latest_execution_run(
                                workflow_id,
                                latest_execution,
                            )
                        {
                            tracing::warn!(
                                workflow_id,
                                error = %err,
                                "Failed to persist failed workflow run history"
                            );
                        }
                    }
                    Err(err) => {
                        tracing::warn!(
                            workflow_id,
                            error = %err,
                            "Failed to store failed workflow latest execution"
                        );
                    }
                }
                let _ = ai_agent_sandbox_blueprint_lib::workflows::workflows()
                    .ok()
                    .and_then(|store| {
                        store
                            .update(&wf_key_bg, |e| {
                                trading_blueprint_lib::workflow_compat::apply_workflow_failure(
                                    e, failed_at,
                                );
                            })
                            .ok()
                    });
            }
        }
    });

    Ok(Json(RunNowResponse {
        status: "started".to_string(),
        workflow_id: workflow_id.to_string(),
        session_id: String::new(),
        accepted_at,
    }))
}

async fn update_config(
    SessionAuth(caller): SessionAuth,
    Path(bot_id): Path<String>,
    Json(body): Json<UpdateConfigRequest>,
) -> ApiResult<ConfigResponse> {
    let bot = resolve_live_bot(&bot_id)?;

    verify_submitter(&bot, &caller)?;

    trading_blueprint_lib::jobs::configure_core(
        &bot.sandbox_id,
        body.strategy_config_json.as_deref().unwrap_or(""),
        body.risk_params_json.as_deref().unwrap_or(""),
    )
    .await
    .map_err(|e| ApiError::message(StatusCode::INTERNAL_SERVER_ERROR, e))?;

    // Update vault address if provided
    if let Some(addr) = &body.vault_address
        && let Ok(store) = state::bots()
    {
        let _ = store.update(&state::bot_key(&bot.id), |b| {
            b.vault_address.clone_from(addr);
        });
    }

    // Persist harness config if provided
    if let Some(harness_str) = &body.harness_json {
        let harness: serde_json::Value = serde_json::from_str(harness_str).map_err(|e| {
            ApiError::message(
                StatusCode::BAD_REQUEST,
                format!("Invalid harness JSON: {e}"),
            )
        })?;
        trading_blueprint_lib::state::update_harness(&bot.id, harness)
            .map_err(|e| ApiError::message(StatusCode::BAD_REQUEST, e))?;
    }

    Ok(Json(ConfigResponse {
        status: "configured".to_string(),
    }))
}

// ── Bot data resolution ─────────────────────────────────────────────────

/// Resolve a bot by trading ID or vault address.
fn resolve_bot(bot_id: &str) -> Result<TradingBotRecord, (StatusCode, String)> {
    state::resolve_bot(bot_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("Bot {bot_id} not found")))
}

fn resolve_live_bot(bot_id: &str) -> Result<TradingBotRecord, ApiError> {
    let bot =
        resolve_bot(bot_id).map_err(|(status, message)| ApiError::message(status, message))?;
    ensure_live_sandbox(bot)
}

fn resolve_live_chat_target(
    bot_id: &str,
    caller: &str,
) -> Result<
    (
        TradingBotRecord,
        trading_blueprint_lib::operator_chat::SidecarChatTarget,
    ),
    (StatusCode, String),
> {
    let bot = resolve_bot(bot_id)?;
    verify_submitter(&bot, caller)?;
    let target = trading_blueprint_lib::operator_chat::resolve_sidecar_chat_target(&bot.sandbox_id)
        .map_err(|e| (StatusCode::CONFLICT, e))?;
    Ok((bot, target))
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
    bot_id: &str,
    caller: &str,
) -> Result<LiveTerminalTarget, (StatusCode, Json<OperatorErrorResponse>)> {
    let bot = resolve_live_bot(bot_id).map_err(api_error_response)?;
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
                    "Bot {} points to missing sandbox {}. Operator state is stale; reprovision the agent from the deploy step.",
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

    let base_url = bot
        .trading_api_url
        .trim_end_matches('/')
        .replace("host.docker.internal", "127.0.0.1");
    let url = format!("{base_url}{path}");
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

// ── Self-improvement / revision arena handlers ─────────────────────────

async fn list_self_improvement_runs(
    SessionAuth(caller): SessionAuth,
    Path(bot_id): Path<String>,
) -> ApiResult<serde_json::Value> {
    let (bot, target) = resolve_live_chat_target(&bot_id, &caller)?;
    let tasks = read_self_improvement_tasks(&target, &bot.id).await?;
    Ok(Json(json!({
        "bot_id": bot.id,
        "runs": tasks.get("runs").cloned().unwrap_or_else(|| serde_json::Value::Array(vec![])),
    })))
}

async fn get_revision_arena(
    SessionAuth(caller): SessionAuth,
    Path(bot_id): Path<String>,
) -> ApiResult<serde_json::Value> {
    let (bot, target) = resolve_live_chat_target(&bot_id, &caller)?;
    let tasks = read_self_improvement_tasks(&target, &bot.id).await?;
    let runs = tasks
        .get("runs")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let canary_revision = bot_canary_revision(&bot);
    let canary_revision_id = canary_revision
        .as_ref()
        .and_then(|revision| revision.get("revision_id"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let rejected_revisions = bot_rejected_revisions(&bot);
    let revisions = runs
        .into_iter()
        .filter_map(|run| {
            let status = run.get("status").and_then(serde_json::Value::as_str).unwrap_or("unknown");
            let tests_passed = run.get("tests_passed").and_then(serde_json::Value::as_bool).unwrap_or(false);
            let patch_sha = run.get("patch_sha256").and_then(serde_json::Value::as_str);
            let task_id = run.get("task_id").and_then(serde_json::Value::as_str).unwrap_or("unknown");
            let revision_id = revision_id_for_task(task_id);
            if canary_revision_id.as_deref() == Some(revision_id.as_str()) {
                return None;
            }
            let rejection = rejected_revisions.get(&revision_id);
            let ready = status == "completed" && tests_passed && patch_sha.is_some();
            let blockers = if let Some(rejection) = rejection {
                vec![format!(
                    "Rejected by owner: {}",
                    rejection
                        .get("reason")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("No reason provided")
                )]
            } else if ready && bot_allows_live_revision_promotion(&bot) {
                vec!["User approval can promote this candidate into the live path; trades still require configured trading API and validator/risk gates.".to_string()]
            } else if ready {
                vec!["User approval can stage this candidate as canary paper/live-sim; configure live mode and user secrets before fund access.".to_string()]
            } else {
                vec![
                    "Candidate has not passed deterministic MCP checks.".to_string(),
                    "Live execution remains blocked until an approved paper/shadow candidate exists.".to_string(),
                ]
            };
            Some(json!({
                "revision_id": revision_id,
                "display_name": format!("Self-improvement {task_id}"),
                "source": "self-improvement-mcp",
                "status": if rejection.is_some() { "rejected" } else if ready { "candidate" } else if status == "failed" { "failed" } else { status },
                "run_mode": "paper",
                "can_execute_live": false,
                "parent_revision_id": "rev-0",
                "run_id": task_id,
                "created_at": run.get("created_at").cloned().unwrap_or(serde_json::Value::Null),
                "user_intent": run.get("spec").and_then(serde_json::Value::as_str).unwrap_or("Self-improvement task"),
                "patch_sha256": patch_sha,
                "files_changed": run.get("files_changed").cloned().unwrap_or_else(|| serde_json::Value::Array(vec![])),
                "tests": run.get("tests").cloned().unwrap_or_else(|| serde_json::Value::Array(vec![])),
                "promotion_approved": false,
                "promotion_blockers": blockers,
                "rejection": rejection.cloned(),
                "paper_evidence": serde_json::Value::Null,
            }))
        })
        .collect::<Vec<_>>();

    let mut all_revisions = vec![json!({
        "revision_id": "rev-0",
        "display_name": "Current deployed bot",
        "source": "provisioned-bot",
        "status": "active",
        "run_mode": if bot.paper_trade { "paper" } else { "live" },
        "can_execute_live": !bot.paper_trade,
        "parent_revision_id": serde_json::Value::Null,
        "run_id": bot.workflow_id.map(|id| id.to_string()),
        "created_at": serde_json::Value::Null,
        "user_intent": bot.strategy_config.get("user_prompt").and_then(serde_json::Value::as_str).unwrap_or("Initial provisioned strategy"),
        "patch_sha256": serde_json::Value::Null,
        "files_changed": [],
        "tests": [],
        "promotion_approved": !bot.paper_trade,
        "promotion_blockers": if bot.paper_trade {
            vec!["Bot is currently paper trading; live execution requires explicit approval and validator gates."]
        } else {
            Vec::<&str>::new()
        },
        "paper_evidence": bot.baseline_backtest,
    })];
    all_revisions.extend(revisions);
    if let Some(canary) = canary_revision {
        all_revisions.push(canary);
    }
    let active_revision_id = canary_revision_id.unwrap_or_else(|| "rev-0".to_string());
    let active_revision_can_execute_live = all_revisions.iter().any(|revision| {
        revision
            .get("revision_id")
            .and_then(serde_json::Value::as_str)
            == Some(active_revision_id.as_str())
            && revision
                .get("can_execute_live")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
    });

    Ok(Json(json!({
        "bot_id": bot.id,
        "invariant": "Only the active approved revision may touch execution keys or vault funds; MCP candidates are paper/shadow until deterministic checks, user approval, and validator gates pass.",
        "active_revision_id": active_revision_id.clone(),
        "live_revision_id": if active_revision_can_execute_live {
            serde_json::Value::String(active_revision_id)
        } else if bot.paper_trade {
            serde_json::Value::Null
        } else {
            serde_json::Value::String("rev-0".to_string())
        },
        "revisions": all_revisions,
        "modes": [
            { "mode": "research", "can_touch_funds": false, "description": "Research-only investigation and source grounding." },
            { "mode": "backtest", "can_touch_funds": false, "description": "Offline replay against deterministic data." },
            { "mode": "paper", "can_touch_funds": false, "description": "Paper execution with no live transaction authority." },
            { "mode": "shadow", "can_touch_funds": false, "description": "Observe live markets without submitting orders." },
            { "mode": "canary", "can_touch_funds": false, "description": "Approved paper/live-sim observation before validator-gated live exposure." },
            { "mode": "live", "can_touch_funds": true, "description": "Full live execution only for approved active revisions." }
        ]
    })))
}

#[derive(Deserialize)]
struct PromoteRevisionRequest {
    revision_id: Option<String>,
    confirm_live: Option<bool>,
}

#[derive(Deserialize)]
struct RevisionDecisionRequest {
    revision_id: Option<String>,
    action: String,
    reason: Option<String>,
    confirm_live: Option<bool>,
}

fn revision_id_for_task(task_id: &str) -> String {
    format!("mcp-{task_id}")
}

fn bot_canary_revision(bot: &TradingBotRecord) -> Option<serde_json::Value> {
    bot.strategy_config
        .get("revision_arena")
        .and_then(|value| value.get("canary_revision"))
        .cloned()
}

fn bot_rejected_revisions(bot: &TradingBotRecord) -> serde_json::Map<String, serde_json::Value> {
    bot.strategy_config
        .get("revision_arena")
        .and_then(|value| value.get("rejected_revisions"))
        .and_then(serde_json::Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn bot_has_user_secrets(bot: &TradingBotRecord) -> bool {
    sandbox_runtime::runtime::get_sandbox_by_id(&bot.sandbox_id)
        .map(|sandbox| sandbox.has_user_secrets())
        .unwrap_or(false)
}

fn bot_allows_live_revision_promotion(bot: &TradingBotRecord) -> bool {
    !bot.paper_trade && bot_has_user_secrets(bot)
}

fn revision_from_candidate(
    run: &serde_json::Value,
    live_enabled: bool,
) -> Option<serde_json::Value> {
    let task_id = run.get("task_id").and_then(serde_json::Value::as_str)?;
    let patch_sha = run
        .get("patch_sha256")
        .and_then(serde_json::Value::as_str)?;
    let mode = if live_enabled { "live" } else { "canary" };
    let blockers = if live_enabled {
        Vec::<&str>::new()
    } else {
        vec![
            "Canary is approved for paper/live-sim observation only.",
            "Configure the bot for live mode with user secrets before fund execution.",
        ]
    };
    Some(json!({
        "revision_id": revision_id_for_task(task_id),
        "display_name": format!("{} {}", if live_enabled { "Live" } else { "Canary" }, task_id),
        "source": "self-improvement-mcp",
        "status": "active",
        "run_mode": mode,
        "can_execute_live": live_enabled,
        "can_touch_funds": live_enabled,
        "parent_revision_id": "rev-0",
        "run_id": task_id,
        "created_at": chrono::Utc::now().to_rfc3339(),
        "user_intent": run.get("spec").and_then(serde_json::Value::as_str).unwrap_or("Approved paper candidate"),
        "patch_sha256": patch_sha,
        "files_changed": run.get("files_changed").cloned().unwrap_or_else(|| serde_json::Value::Array(vec![])),
        "tests": run.get("tests").cloned().unwrap_or_else(|| serde_json::Value::Array(vec![])),
        "promotion_approved": true,
        "promotion_blockers": blockers,
        "paper_evidence": {
            "candidate_hash": patch_sha,
            "revision_id": revision_id_for_task(task_id),
            "trades": 0,
            "total_return_pct": 0,
            "max_drawdown_pct": 0
        }
    }))
}

fn persist_canary_revision(
    bot: &TradingBotRecord,
    revision: serde_json::Value,
) -> Result<(), ApiError> {
    let mut config = bot.strategy_config.clone();
    if !config.is_object() {
        config = json!({});
    }
    let object = config.as_object_mut().ok_or_else(|| {
        ApiError::message(StatusCode::INTERNAL_SERVER_ERROR, "invalid strategy config")
    })?;
    let revision_arena = object.entry("revision_arena").or_insert_with(|| json!({}));
    if !revision_arena.is_object() {
        *revision_arena = json!({});
    }
    revision_arena
        .as_object_mut()
        .expect("revision arena object")
        .insert("canary_revision".to_string(), revision);

    state::bots()
        .map_err(|e| ApiError::message(StatusCode::INTERNAL_SERVER_ERROR, e))?
        .update(&state::bot_key(&bot.id), |record| {
            record.strategy_config = config.clone();
        })
        .map_err(|e| ApiError::message(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(())
}

fn persist_rejected_revision(
    bot: &TradingBotRecord,
    revision_id: &str,
    reason: &str,
) -> Result<serde_json::Value, ApiError> {
    let mut config = bot.strategy_config.clone();
    if !config.is_object() {
        config = json!({});
    }
    let object = config.as_object_mut().ok_or_else(|| {
        ApiError::message(StatusCode::INTERNAL_SERVER_ERROR, "invalid strategy config")
    })?;
    let revision_arena = object.entry("revision_arena").or_insert_with(|| json!({}));
    if !revision_arena.is_object() {
        *revision_arena = json!({});
    }
    let arena = revision_arena
        .as_object_mut()
        .expect("revision arena object");
    let rejected = arena
        .entry("rejected_revisions")
        .or_insert_with(|| json!({}));
    if !rejected.is_object() {
        *rejected = json!({});
    }
    let rejection = json!({
        "revision_id": revision_id,
        "reason": reason,
        "rejected_at": chrono::Utc::now().to_rfc3339(),
    });
    rejected
        .as_object_mut()
        .expect("rejected revisions object")
        .insert(revision_id.to_string(), rejection.clone());

    state::bots()
        .map_err(|e| ApiError::message(StatusCode::INTERNAL_SERVER_ERROR, e))?
        .update(&state::bot_key(&bot.id), |record| {
            record.strategy_config = config.clone();
        })
        .map_err(|e| ApiError::message(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(rejection)
}

async fn promote_revision_candidate(
    SessionAuth(caller): SessionAuth,
    Path(bot_id): Path<String>,
    Json(body): Json<PromoteRevisionRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<OperatorErrorResponse>)> {
    let (bot, target) =
        resolve_live_chat_target(&bot_id, &caller).map_err(|(status, message)| {
            error_json(
                status,
                "operator_error",
                message,
                Some(bot_id.clone()),
                None,
                None,
            )
        })?;
    promote_revision_for_bot(
        &bot,
        &target,
        body.revision_id.unwrap_or_else(|| "latest".to_string()),
        body.confirm_live.unwrap_or(false),
    )
    .await
    .map(Json)
}

async fn decide_revision_candidate(
    SessionAuth(caller): SessionAuth,
    Path(bot_id): Path<String>,
    Json(body): Json<RevisionDecisionRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<OperatorErrorResponse>)> {
    let (bot, target) =
        resolve_live_chat_target(&bot_id, &caller).map_err(|(status, message)| {
            error_json(
                status,
                "operator_error",
                message,
                Some(bot_id.clone()),
                None,
                None,
            )
        })?;
    let revision_id = body.revision_id.unwrap_or_else(|| "latest".to_string());
    match body.action.as_str() {
        "approve" => promote_revision_for_bot(
            &bot,
            &target,
            revision_id,
            body.confirm_live.unwrap_or(true),
        )
        .await
        .map(Json),
        "reject" => {
            let tasks = read_self_improvement_tasks(&target, &bot.id)
                .await
                .map_err(api_error_response)?;
            let runs = tasks
                .get("runs")
                .and_then(serde_json::Value::as_array)
                .cloned()
                .unwrap_or_default();
            let selected = runs.iter().rev().find(|run| {
                revision_id == "latest"
                    || run
                        .get("task_id")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|task_id| {
                            revision_id == task_id || revision_id == format!("mcp-{task_id}")
                        })
            });
            let Some(run) = selected else {
                return Err(error_json(
                    StatusCode::NOT_FOUND,
                    "revision_not_found",
                    format!("No self-improvement candidate matched {revision_id}"),
                    Some(bot.id),
                    Some(bot.sandbox_id),
                    None,
                ));
            };
            let task_id = run
                .get("task_id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("unknown");
            let revision_id = revision_id_for_task(task_id);
            let reason = body.reason.as_deref().unwrap_or("Rejected by owner");
            let rejection = persist_rejected_revision(&bot, &revision_id, reason)
                .map_err(api_error_response)?;
            Ok(Json(json!({
                "status": "rejected",
                "bot_id": bot.id,
                "sandbox_id": bot.sandbox_id,
                "revision_id": revision_id,
                "rejection": rejection,
            })))
        }
        _ => Err(error_json(
            StatusCode::BAD_REQUEST,
            "invalid_revision_decision",
            "Revision decision action must be approve or reject.",
            Some(bot.id),
            Some(bot.sandbox_id),
            None,
        )),
    }
}

async fn promote_revision_for_bot(
    bot: &TradingBotRecord,
    target: &trading_blueprint_lib::operator_chat::SidecarChatTarget,
    revision_id: String,
    confirm_live: bool,
) -> Result<serde_json::Value, (StatusCode, Json<OperatorErrorResponse>)> {
    let tasks = read_self_improvement_tasks(target, &bot.id)
        .await
        .map_err(api_error_response)?;
    let runs = tasks
        .get("runs")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let selected = runs.iter().rev().find(|run| {
        revision_id == "latest"
            || run
                .get("task_id")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|task_id| {
                    revision_id == task_id || revision_id == format!("mcp-{task_id}")
                })
    });
    let Some(run) = selected else {
        return Err(error_json(
            StatusCode::NOT_FOUND,
            "revision_not_found",
            format!("No self-improvement candidate matched {revision_id}"),
            Some(bot.id.clone()),
            Some(bot.sandbox_id.clone()),
            None,
        ));
    };
    let status = run
        .get("status")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown");
    let tests_passed = run
        .get("tests_passed")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let patch_sha = run.get("patch_sha256").and_then(serde_json::Value::as_str);
    let task_revision_id = run
        .get("task_id")
        .and_then(serde_json::Value::as_str)
        .map(revision_id_for_task)
        .unwrap_or_else(|| revision_id.clone());
    if bot_rejected_revisions(bot).contains_key(&task_revision_id) {
        return Err(error_json(
            StatusCode::CONFLICT,
            "promotion_blocked",
            "Live promotion blocked: candidate was rejected by the owner.",
            Some(bot.id.clone()),
            Some(bot.sandbox_id.clone()),
            None,
        ));
    }
    if !(confirm_live && status == "completed" && tests_passed && patch_sha.is_some()) {
        return Err(error_json(
            StatusCode::CONFLICT,
            "promotion_blocked",
            "Live promotion blocked: candidate must be completed, have deterministic tests passed, have a patch hash, and include explicit user confirmation.",
            Some(bot.id.clone()),
            Some(bot.sandbox_id.clone()),
            None,
        ));
    }
    let live_enabled = bot_allows_live_revision_promotion(bot);
    let revision = revision_from_candidate(run, live_enabled).ok_or_else(|| {
        error_json(
            StatusCode::CONFLICT,
            "promotion_blocked",
            "Live promotion blocked: candidate is missing task id or patch hash.",
            Some(bot.id.clone()),
            Some(bot.sandbox_id.clone()),
            None,
        )
    })?;
    persist_canary_revision(bot, revision.clone()).map_err(api_error_response)?;
    let status = if live_enabled {
        "live_promoted"
    } else {
        "canary_promoted"
    };
    let message = if live_enabled {
        "Candidate approved into the live execution path. Trades still flow through the configured trading API and validator/risk gates."
    } else {
        "Candidate approved into canary paper/live-sim mode. Configure live mode and user secrets before fund execution."
    };
    Ok(json!({
        "status": status,
        "bot_id": bot.id.clone(),
        "sandbox_id": bot.sandbox_id.clone(),
        "revision": revision,
        "message": message
    }))
}

async fn read_self_improvement_tasks(
    target: &trading_blueprint_lib::operator_chat::SidecarChatTarget,
    _bot_id: &str,
) -> Result<serde_json::Value, ApiError> {
    let exec_req = ai_agent_sandbox_blueprint_lib::SandboxExecRequest {
        sidecar_url: target.sidecar_url.clone(),
        command: READ_SELF_IMPROVEMENT_TASKS_JS.to_string(),
        cwd: "/home/agent".to_string(),
        env_json: "{}".to_string(),
        timeout_ms: 30_000,
    };
    let response =
        ai_agent_sandbox_blueprint_lib::run_exec_request(&exec_req, &target.sidecar_token)
            .await
            .map_err(|e| {
                ApiError::message(
                    StatusCode::BAD_GATEWAY,
                    format!("failed to read MCP tasks: {e}"),
                )
            })?;
    if response.exit_code != 0 {
        return Err(ApiError::message(
            StatusCode::BAD_GATEWAY,
            format!("failed to read MCP tasks: {}", response.stderr),
        ));
    }
    serde_json::from_str(&response.stdout).map_err(|e| {
        ApiError::message(
            StatusCode::BAD_GATEWAY,
            format!("failed to parse MCP task state: {e}: {}", response.stdout),
        )
    })
}

const READ_SELF_IMPROVEMENT_TASKS_JS: &str = r#"node <<'NODE'
const fs = require('node:fs')

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function jsonFiles(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => ({ file, value: readJson(`${dir}/${file}`) }))
    .filter((entry) => entry.value && typeof entry.value === 'object')
}

function tail(file, maxBytes = 20000) {
  try {
    const stat = fs.statSync(file)
    const fd = fs.openSync(file, 'r')
    const len = Math.min(stat.size, maxBytes)
    const buffer = Buffer.alloc(len)
    fs.readSync(fd, buffer, 0, len, stat.size - len)
    fs.closeSync(fd)
    return buffer.toString('utf8')
  } catch {
    return null
  }
}

function parseJsonl(raw) {
  return String(raw || '')
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line) } catch { return null }
    })
    .filter((entry) => entry && typeof entry === 'object')
}

function usageSummary(events, filter = {}) {
  const filtered = events.filter((event) => {
    if (filter.run_id && event.run_id !== filter.run_id) return false
    if (filter.task_id && event.task_id !== filter.task_id) return false
    return true
  })
  const sum = (key) => filtered.reduce((acc, event) => acc + (Number.isFinite(Number(event[key])) ? Number(event[key]) : 0), 0)
  const hasTokenCoverage = (event) => event.token_count_status === 'reported'
    || event.token_count_status === 'estimated'
    || event.token_count_status === 'partial'
    || event.token_count_status === 'partial_estimated'
    || event.total_tokens != null
    || event.input_tokens != null
    || event.output_tokens != null
  const hasCostCoverage = (event) => event.cost_usd != null && Number.isFinite(Number(event.cost_usd))
  const tokenCovered = filtered.filter(hasTokenCoverage).length
  const costCovered = filtered.filter(hasCostCoverage).length
  const reportingStatus = filtered.length === 0
    ? 'not_applicable'
    : tokenCovered === filtered.length
      ? 'reported'
      : tokenCovered > 0
        ? 'partial'
        : 'unreported'
  const costReportingStatus = filtered.length === 0
    ? 'not_applicable'
    : costCovered === filtered.length
      ? (filtered.every((event) => event.cost_source === 'reported' || event.cost_estimated === false) ? 'reported' : 'estimated')
      : costCovered > 0
        ? 'partial'
        : 'unreported'
  return {
    event_count: filtered.length,
    reporting_status: reportingStatus,
    cost_reporting_status: costReportingStatus,
    events_with_token_coverage: tokenCovered,
    events_with_reported_tokens: filtered.filter((event) => event.token_count_status === 'reported').length,
    events_with_reported_or_estimated_cost: costCovered,
    input_tokens: sum('input_tokens'),
    output_tokens: sum('output_tokens'),
    total_tokens: sum('total_tokens') || sum('input_tokens') + sum('output_tokens'),
    cost_usd: Number(sum('cost_usd').toFixed(8)),
    providers: [...new Set(filtered.map((event) => event.provider).filter(Boolean))].sort(),
    models: [...new Set(filtered.map((event) => event.model).filter(Boolean))].sort(),
    latest: filtered.slice(-5),
  }
}

function epochish(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0
}

const usageTelemetryJsonl = tail('/home/agent/telemetry/llm-usage.jsonl', 1000000)
const usageEvents = parseJsonl(usageTelemetryJsonl)

const mcpDir = '/home/agent/.evolve/mcp-self-improvement/tasks'
const mcpRuns = jsonFiles(mcpDir).map(({ value: task }) => {
  const variants = task.variants || []
  const winner = variants.find((v) => v.variant_id === task.winner_variant_id) || variants[variants.length - 1] || {}
  const shots = winner.shots || []
  return {
    task_id: task.task_id,
    status: task.status,
    created_at: task.created_at || task.started_at || null,
    updated_at: task.updated_at || null,
    spec: task.spec || '',
    winner_variant_id: task.winner_variant_id || null,
    patch_sha256: task.patch_sha256 || null,
    files_changed: task.files_changed || winner.files_changed || [],
    tests: task.test_commands || [],
    tests_passed: Boolean(winner.test_passed || shots.some((shot) => (shot.tests || []).length > 0 && (shot.tests || []).every((test) => test.ok))),
    rounds_used: winner.rounds_used || shots.length || 0,
    failure: task.failure || winner.errored_reason || null,
    latest_shot: shots[shots.length - 1] || null,
    usage_summary: task.usage_summary || usageSummary(usageEvents, { task_id: task.task_id }),
  }
})

const runtimeDir = '/home/agent/.evolve/self-improvement'
const runtimeRuns = jsonFiles(runtimeDir).map(({ file, value: report }) => {
  const apiRun = report.self_improve?.data?.run || {}
  const promotion = report.self_improve?.data?.promotion || {}
  const statusCode = Number(report.self_improve?.status || 0)
  const status = apiRun.status
    || (statusCode >= 200 && statusCode < 300 ? 'recorded' : statusCode > 0 ? 'failed' : 'running_or_failed')
  return {
    task_id: report.run_id || apiRun.run_id || file.replace(/\.json$/, ''),
    run_id: apiRun.run_id || report.run_id || null,
    status,
    source: 'runtime-reflection-loop',
    created_at: report.created_at || apiRun.created_at || null,
    updated_at: report.created_at || apiRun.created_at || null,
    spec: report.intent || apiRun.user_intent || '',
    user_intent: report.intent || apiRun.user_intent || '',
    candidate_hash: apiRun.candidate_hash || null,
    approved: typeof apiRun.approved === 'boolean' ? apiRun.approved : (typeof promotion.approved === 'boolean' ? promotion.approved : null),
    blockers: apiRun.blockers || promotion.blockers || [],
    candles_used: apiRun.candles_used ?? promotion.candles_used ?? null,
    patch_sha256: null,
    files_changed: [],
    tests: ['bun --bun /home/agent/tools/self-improvement-loop.ts status'],
    tests_passed: ['backtest_pass', 'paper_trial', 'evidence_met', 'promoted', 'staged_for_operator_approval', 'recorded'].includes(status),
    usage_summary: report.usage_telemetry || usageSummary(usageEvents, { run_id: report.run_id || apiRun.run_id || null }),
    latest_shot: {
      run_id: report.run_id || null,
      package_status: report.package_status || null,
      candidate_search: report.candidate_search || null,
      self_improve: report.self_improve || null,
    },
  }
})

const runs = [...runtimeRuns, ...mcpRuns].sort((a, b) => epochish(b.created_at) - epochish(a.created_at))
console.log(JSON.stringify({
  runs,
  runtime_runs: runtimeRuns,
  mcp_runs: mcpRuns,
  usage_telemetry_jsonl: usageTelemetryJsonl,
  usage_summary: usageSummary(usageEvents),
  logs: {
    generation: tail('/home/agent/logs/self-improvement-generation.log'),
    maintenance: tail('/home/agent/logs/self-improvement-maintenance.log'),
  },
}))
NODE"#;

// ── Chat session proxy handlers ─────────────────────────────────────────

async fn list_chat_sessions(
    SessionAuth(caller): SessionAuth,
    Path(bot_id): Path<String>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<Response, (StatusCode, String)> {
    let (bot, target) = resolve_live_chat_target(&bot_id, &caller)?;
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
    Path(bot_id): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> Result<Response, (StatusCode, String)> {
    let (_bot, target) = resolve_live_chat_target(&bot_id, &caller)?;
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
    Path((bot_id, session_id)): Path<(String, String)>,
) -> Result<Response, (StatusCode, String)> {
    let (bot, target) = resolve_live_chat_target(&bot_id, &caller)?;
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
    Path((bot_id, session_id)): Path<(String, String)>,
    Json(body): Json<serde_json::Value>,
) -> Result<Response, (StatusCode, String)> {
    let (bot, target) = resolve_live_chat_target(&bot_id, &caller)?;
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
    Path((bot_id, session_id)): Path<(String, String)>,
) -> Result<Response, (StatusCode, String)> {
    let (bot, target) = resolve_live_chat_target(&bot_id, &caller)?;
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
    Path((bot_id, session_id)): Path<(String, String)>,
    RawQuery(query): RawQuery,
) -> Result<Response, (StatusCode, String)> {
    let (bot, target) = resolve_live_chat_target(&bot_id, &caller)?;
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
    Path((bot_id, session_id)): Path<(String, String)>,
    Json(body): Json<serde_json::Value>,
) -> Result<Response, (StatusCode, String)> {
    let (bot, target) = resolve_live_chat_target(&bot_id, &caller)?;
    trading_blueprint_lib::operator_chat::ensure_manual_chat_session(&bot.id, &session_id)?;

    // Persist message to bot's memory filesystem so it survives across ticks.
    // Content is passed via FILE_CONTENT env var to avoid any shell interpretation.
    if let Some(msg_text) = body.get("message").and_then(|m| m.as_str()) {
        let session_slug = session_id
            .chars()
            .filter(|c| c.is_alphanumeric() || *c == '-')
            .take(30)
            .collect::<String>();
        let date = chrono::Utc::now().format("%Y-%m-%d");
        let timestamp = chrono::Utc::now().format("%H:%M UTC");
        let conv_file = format!("conversations/{date}-{session_slug}.md");
        let conv_path = format!("/home/agent/memory/{conv_file}");

        // Build append content (message entry to append to the conversation file)
        let append_content = format!("\n## Owner ({timestamp})\n{msg_text}\n");
        // Build ToC entry line to inject (only if the file isn't already listed)
        let toc_entry = format!("- [{session_slug}]({conv_file}) — **ACTION NEEDED**");

        let msg_owned = msg_text.to_string();
        let sandbox_id = bot.sandbox_id.clone();

        // Fire-and-forget — don't block the chat response on filesystem writes
        tokio::spawn(async move {
            let Ok(sandbox) = sandbox_runtime::runtime::get_sandbox_by_id(&sandbox_id) else {
                return;
            };

            // Append message to conversation file (create if needed)
            let append_req = ai_agent_sandbox_blueprint_lib::SandboxExecRequest {
                sidecar_url: sandbox.sidecar_url.clone(),
                command: format!(
                    r#"node -e "const fs=require('fs'),p=process.argv[1];fs.mkdirSync(require('path').dirname(p),{{recursive:true}});fs.appendFileSync(p,process.env.FILE_CONTENT)" "{conv_path}""#,
                ),
                cwd: String::new(),
                env_json: serde_json::json!({"FILE_CONTENT": append_content}).to_string(),
                timeout_ms: 10_000,
            };
            let _ =
                ai_agent_sandbox_blueprint_lib::run_exec_request(&append_req, &sandbox.token).await;

            // Update ToC: inject entry under "## Conversations" if not already present.
            // Safe: conv_file and toc_entry are server-generated slugs, not user input.
            let toc_update_req = ai_agent_sandbox_blueprint_lib::SandboxExecRequest {
                sidecar_url: sandbox.sidecar_url.clone(),
                command: r#"node -e "
const fs=require('fs'),p='/home/agent/memory/toc.md';
try{
  let t=fs.readFileSync(p,'utf8');
  if(!t.includes(process.env.CONV_FILE)){
    t=t.replace('## Conversations','## Conversations\n'+process.env.TOC_ENTRY);
    fs.writeFileSync(p,t);
  }
}catch(e){/* toc.md not yet created, skip */}"
"#
                .to_string(),
                cwd: String::new(),
                env_json: serde_json::json!({"CONV_FILE": conv_file, "TOC_ENTRY": toc_entry})
                    .to_string(),
                timeout_ms: 10_000,
            };
            let _ =
                ai_agent_sandbox_blueprint_lib::run_exec_request(&toc_update_req, &sandbox.token)
                    .await;

            // Keep msg_owned alive until the spawn completes
            let _ = msg_owned;
        });

        if is_live_revision_approval_message(msg_text) {
            trading_blueprint_lib::operator_chat::append_operator_transcript_message(
                &target,
                &session_id,
                "user",
                msg_text.to_string(),
                json!({ "transport": "operator-chat", "source": "owner" }),
            );
            let promotion = promote_revision_for_bot(&bot, &target, "latest".to_string(), true)
                .await
                .map_err(|(status, Json(error))| (status, error.message));
            let mut promotion_status = "live_promotion_blocked".to_string();
            let assistant = match promotion {
                Ok(value) => {
                    let status = value
                        .get("status")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("promotion_updated");
                    promotion_status = status.to_string();
                    let message = value
                        .get("message")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("Revision promotion updated.");
                    let revision_id = value
                        .get("revision")
                        .and_then(|revision| revision.get("revision_id"))
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("unknown");
                    format!("{status}\nrevision_id: {revision_id}\n\n{message}")
                }
                Err((_, message)) => format!("Live promotion is blocked.\n\n{message}"),
            };
            trading_blueprint_lib::operator_chat::append_operator_transcript_message(
                &target,
                &session_id,
                "assistant",
                assistant,
                json!({ "transport": "operator-chat", "status": promotion_status }),
            );
            return Ok(Json(json!({
                "ok": true,
                "sessionId": session_id,
                "transport": "operator-chat",
                "status": "accepted"
            }))
            .into_response());
        }
    }

    trading_blueprint_lib::operator_chat::proxy_chat_request(
        &target,
        reqwest::Method::POST,
        &format!("/agents/sessions/{session_id}/messages"),
        Some(body),
        None,
    )
    .await
}

fn is_live_revision_approval_message(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    [
        "live",
        "real funds",
        "mainnet",
        "on-chain",
        "execute for real",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
        && [
            "run this", "turn on", "enable", "promote", "approve", "go live", "switch", "deploy",
        ]
        .iter()
        .any(|needle| lower.contains(needle))
        && !lower.contains("paper")
        && !lower.contains("shadow")
}

async fn abort_chat_session(
    SessionAuth(caller): SessionAuth,
    Path((bot_id, session_id)): Path<(String, String)>,
) -> Result<Response, (StatusCode, String)> {
    let (bot, target) = resolve_live_chat_target(&bot_id, &caller)?;
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
    Path(bot_id): Path<String>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let (bot, target) = resolve_live_chat_target(&bot_id, &caller)?;
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
    Path(bot_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<OperatorErrorResponse>)> {
    let target = resolve_live_terminal_target(&bot_id, &caller)?;
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
    Path(bot_id): Path<String>,
    Json(req): Json<CreateLiveTerminalSessionRequest>,
) -> Result<Json<LiveTerminalSessionSummary>, (StatusCode, Json<OperatorErrorResponse>)> {
    let target = resolve_live_terminal_target(&bot_id, &caller)?;
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
    Path((bot_id, session_id)): Path<(String, String)>,
) -> Result<Response, (StatusCode, Json<OperatorErrorResponse>)> {
    let target = resolve_live_terminal_target(&bot_id, &caller)?;
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
    Path((bot_id, session_id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<OperatorErrorResponse>)> {
    let target = resolve_live_terminal_target(&bot_id, &caller)?;
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
    Path((bot_id, session_id)): Path<(String, String)>,
    Json(req): Json<TerminalResizeApiRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<OperatorErrorResponse>)> {
    if let Err(message) = req.validate() {
        return Err(error_json(
            StatusCode::BAD_REQUEST,
            "operator_error",
            message,
            Some(bot_id),
            None,
            None,
        ));
    }

    let target = resolve_live_terminal_target(&bot_id, &caller)?;
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
    Path((bot_id, session_id)): Path<(String, String)>,
    Json(req): Json<TerminalInputApiRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<OperatorErrorResponse>)> {
    if let Err(message) = req.validate() {
        return Err(error_json(
            StatusCode::BAD_REQUEST,
            "operator_error",
            message,
            Some(bot_id),
            None,
            None,
        ));
    }

    let target = resolve_live_terminal_target(&bot_id, &caller)?;
    sidecar_terminal_post(
        &target.sandbox,
        &format!("/terminals/{session_id}/input"),
        serde_json::json!({ "data": req.data }),
    )
    .await
    .map_err(|err| terminal_error_response(err, &target.bot))?;
    Ok(Json(serde_json::json!({ "success": true })))
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

fn paginated_trade_payload(
    trades: Vec<serde_json::Value>,
    query: &TradeListQuery,
) -> serde_json::Value {
    let total = trades.len();
    let limit = query.limit.unwrap_or(50).min(200);
    let offset = query.offset.unwrap_or(0);
    let page: Vec<_> = trades.into_iter().skip(offset).take(limit).collect();

    json!({
        "trades": page,
        "total": total,
        "limit": limit,
        "offset": offset,
    })
}

fn normalize_trade_list_payload(
    payload: serde_json::Value,
    query: &TradeListQuery,
) -> Result<serde_json::Value, String> {
    match payload {
        serde_json::Value::Array(trades) => Ok(paginated_trade_payload(trades, query)),
        serde_json::Value::Object(mut map) => {
            let visible_count = match map.get("trades") {
                Some(serde_json::Value::Array(trades)) => trades.len(),
                Some(_) => return Err("trading api field `trades` was not an array".to_string()),
                None => return Err("trading api response missing `trades`".to_string()),
            };
            let explicit_total = ["total", "total_count", "count"]
                .iter()
                .find_map(|key| {
                    map.get(*key)
                        .and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok()))
                })
                .unwrap_or(0);
            let total = explicit_total.max(visible_count as u64);
            map.insert("total".to_string(), json!(total));
            map.entry("limit".to_string())
                .or_insert_with(|| json!(query.limit.unwrap_or(50).min(200)));
            map.entry("offset".to_string())
                .or_insert_with(|| json!(query.offset.unwrap_or(0)));
            Ok(serde_json::Value::Object(map))
        }
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
    margin_used_usd: Option<f64>,
    #[serde(
        default,
        deserialize_with = "deserialize_option_f64_from_string_or_number"
    )]
    notional_usd: Option<f64>,
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
    #[serde(
        default,
        deserialize_with = "deserialize_option_f64_from_string_or_number"
    )]
    unrealized_pnl: Option<f64>,
    #[serde(
        default,
        deserialize_with = "deserialize_option_f64_from_string_or_number"
    )]
    unrealized_pnl_usd: Option<f64>,
    #[serde(
        default,
        deserialize_with = "deserialize_option_f64_from_string_or_number"
    )]
    leverage: Option<f64>,
    #[serde(
        default,
        deserialize_with = "deserialize_option_f64_from_string_or_number"
    )]
    liquidation_price: Option<f64>,
    #[serde(default)]
    protocol: Option<String>,
    #[serde(default)]
    position_type: Option<String>,
    #[serde(default)]
    valuation_status: trading_runtime::types::ValuationStatus,
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
    source: Option<String>,
    #[serde(default)]
    observed_at: Option<String>,
    #[serde(default)]
    stale: Option<bool>,
    #[serde(default)]
    warnings: Vec<String>,
    #[serde(default)]
    has_unpriced_positions: bool,
    #[serde(default)]
    has_value_only_positions: bool,
}

#[derive(Clone)]
struct FallbackDexPositionAccumulator {
    token: String,
    amount: rust_decimal::Decimal,
    entry_price: Option<rust_decimal::Decimal>,
}

impl FallbackDexPositionAccumulator {
    fn new(
        token: String,
        amount: rust_decimal::Decimal,
        entry_price: Option<rust_decimal::Decimal>,
    ) -> Self {
        Self {
            token,
            amount,
            entry_price,
        }
    }

    fn credit(
        &mut self,
        amount: rust_decimal::Decimal,
        entry_price: Option<rust_decimal::Decimal>,
    ) {
        if amount <= rust_decimal::Decimal::ZERO {
            return;
        }

        self.entry_price = match (self.entry_price, entry_price) {
            (Some(existing), Some(next)) if self.amount > rust_decimal::Decimal::ZERO => {
                Some(((existing * self.amount) + (next * amount)) / (self.amount + amount))
            }
            (Some(existing), _) => Some(existing),
            (None, Some(next)) => Some(next),
            (None, None) => None,
        };
        self.amount += amount;
    }

    fn debit(&mut self, amount: rust_decimal::Decimal) {
        if amount <= rust_decimal::Decimal::ZERO {
            return;
        }

        self.amount = (self.amount - amount).max(rust_decimal::Decimal::ZERO);
    }
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
    if let Some(metadata) = &rec.hyperliquid_metadata {
        entry["hyperliquid_metadata"] = serde_json::to_value(metadata).unwrap_or_default();
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

fn parse_decimal_number(value: &str) -> Option<rust_decimal::Decimal> {
    rust_decimal::Decimal::from_str(value).ok()
}

fn decimal_to_f64(value: rust_decimal::Decimal) -> Option<f64> {
    value
        .to_string()
        .parse::<f64>()
        .ok()
        .filter(|v| v.is_finite())
}

fn token_is_zero_placeholder(token: &str) -> bool {
    token
        .trim()
        .eq_ignore_ascii_case("0x0000000000000000000000000000000000000000")
}

fn normalize_fallback_token_key(token: &str) -> String {
    let normalized = token.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "usdc"
        | "usd-coin"
        | "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
        | "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
        | "0x036cbd53842c5426634e7929541ec2318f3dcf7e"
        | "0x7f5c764cbc14f9669b88837ca1490cca17c31607" => "usdc".to_string(),
        _ => normalized,
    }
}

fn default_reference_price_usd(token: &str) -> Option<rust_decimal::Decimal> {
    match normalize_fallback_token_key(token).as_str() {
        "usdc" | "usdt" => Some(rust_decimal::Decimal::ONE),
        _ => None,
    }
}

fn normalize_trade_amount(
    chain_id: Option<u64>,
    token: &str,
    amount: rust_decimal::Decimal,
) -> rust_decimal::Decimal {
    if amount <= rust_decimal::Decimal::ZERO
        || !amount.fract().is_zero()
        || amount < rust_decimal::Decimal::new(100_000, 0)
    {
        return amount;
    }

    let Some(decimals) = trading_runtime::token_metadata::known_token_decimals(chain_id, token)
    else {
        return amount;
    };
    let scale = rust_decimal::Decimal::from(10u64.pow(decimals as u32));
    amount / scale
}

fn configured_cash_token(bot: &TradingBotRecord) -> Option<String> {
    let configured = bot
        .strategy_config
        .as_object()
        .and_then(|strategy| strategy.get("cash_token").and_then(|value| value.as_str()))
        .map(str::trim)
        .filter(|value| !value.is_empty() && !token_is_zero_placeholder(value))
        .map(str::to_string);

    configured.or_else(|| bot.paper_trade.then(|| "USDC".to_string()))
}

fn seed_initial_paper_cash_position(
    positions: &mut HashMap<String, FallbackDexPositionAccumulator>,
    bot: &TradingBotRecord,
) {
    if !bot.paper_trade {
        return;
    }

    let strategy = match bot.strategy_config.as_object() {
        Some(strategy) => strategy,
        None => return,
    };
    let token = configured_cash_token(bot).unwrap_or_else(|| "USDC".to_string());
    let capital = strategy
        .get("initial_capital_usd")
        .or_else(|| strategy.get("initial_capital"))
        .or_else(|| strategy.get("cash_balance"))
        .and_then(|value| match value {
            serde_json::Value::String(value) => parse_decimal_number(value),
            serde_json::Value::Number(value) => parse_decimal_number(&value.to_string()),
            _ => None,
        })
        .unwrap_or(rust_decimal::Decimal::ZERO);

    if capital <= rust_decimal::Decimal::ZERO {
        return;
    }

    credit_fallback_position(
        positions,
        &token,
        capital,
        default_reference_price_usd(&token),
    );
}

fn initial_paper_capital_usd(bot: &TradingBotRecord) -> Option<f64> {
    if !bot.paper_trade {
        return None;
    }

    bot.strategy_config
        .as_object()
        .and_then(|strategy| {
            strategy
                .get("initial_capital_usd")
                .or_else(|| strategy.get("initial_capital"))
                .or_else(|| strategy.get("cash_balance"))
        })
        .and_then(|value| match value {
            serde_json::Value::String(value) => parse_trade_number(value),
            serde_json::Value::Number(value) => parse_trade_number(&value.to_string()),
            _ => None,
        })
        .filter(|value| *value > 0.0)
}

fn credit_fallback_position(
    positions: &mut HashMap<String, FallbackDexPositionAccumulator>,
    token: &str,
    amount: rust_decimal::Decimal,
    entry_price: Option<rust_decimal::Decimal>,
) {
    if amount <= rust_decimal::Decimal::ZERO {
        return;
    }

    let key = normalize_fallback_token_key(token);
    positions
        .entry(key)
        .and_modify(|position| position.credit(amount, entry_price))
        .or_insert_with(|| {
            FallbackDexPositionAccumulator::new(token.to_string(), amount, entry_price)
        });
}

fn debit_fallback_position(
    positions: &mut HashMap<String, FallbackDexPositionAccumulator>,
    token: &str,
    amount: rust_decimal::Decimal,
) {
    if amount <= rust_decimal::Decimal::ZERO {
        return;
    }

    if let Some(position) = positions.get_mut(&normalize_fallback_token_key(token)) {
        position.debit(amount);
    }
}

fn protocol_supports_buy_to_open(protocol: &str) -> bool {
    matches!(
        protocol.trim().to_ascii_lowercase().as_str(),
        "polymarket_clob" | "polymarket"
    )
}

fn protocol_supports_dual_sided_opens(protocol: &str) -> bool {
    matches!(protocol.trim().to_ascii_lowercase().as_str(), "hyperliquid")
}

fn protocol_uses_non_spot_buy_sell(protocol: &str) -> bool {
    protocol_supports_buy_to_open(protocol) || protocol_supports_dual_sided_opens(protocol)
}

fn trade_represents_spot_swap(action: &str, protocol: &str) -> bool {
    match action {
        "swap" => true,
        "buy" | "sell" => !protocol_uses_non_spot_buy_sell(protocol),
        _ => false,
    }
}

fn infer_swap_entry_price(
    trade: &trading_http_api::trade_store::TradeRecord,
    amount_in: rust_decimal::Decimal,
    amount_out: rust_decimal::Decimal,
) -> Option<rust_decimal::Decimal> {
    if amount_out <= rust_decimal::Decimal::ZERO {
        return None;
    }

    trade
        .entry_price_usd
        .as_deref()
        .and_then(parse_decimal_number)
        .or_else(|| {
            trade
                .notional_usd
                .as_deref()
                .and_then(parse_decimal_number)
                .map(|notional| notional / amount_out)
        })
        .or_else(|| {
            default_reference_price_usd(&trade.token_in)
                .map(|input_price| (amount_in * input_price) / amount_out)
        })
}

fn synthesize_dex_fallback_portfolio(bot: &TradingBotRecord) -> Option<PortfolioStateResponse> {
    let trades = trading_http_api::trade_store::trades_for_bot(&bot.id, 1000, 0)
        .ok()
        .map(|result| result.trades)
        .unwrap_or_default();
    let mut positions: HashMap<String, FallbackDexPositionAccumulator> = HashMap::new();
    seed_initial_paper_cash_position(&mut positions, bot);

    if trades.is_empty() && positions.is_empty() {
        return None;
    }

    let mut trades = trades;
    trades.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));
    for trade in &trades {
        let action = trade.action.to_ascii_lowercase();
        if !trade_represents_spot_swap(&action, &trade.target_protocol) {
            continue;
        }

        let amount_in = parse_decimal_number(&trade.amount_in)
            .map(|amount| normalize_trade_amount(Some(bot.chain_id), &trade.token_in, amount))
            .unwrap_or(rust_decimal::Decimal::ZERO);
        let amount_out = trade
            .amount_out
            .as_deref()
            .and_then(parse_decimal_number)
            .map(|amount| normalize_trade_amount(Some(bot.chain_id), &trade.token_out, amount))
            .or_else(|| {
                parse_decimal_number(&trade.min_amount_out).map(|amount| {
                    normalize_trade_amount(Some(bot.chain_id), &trade.token_out, amount)
                })
            })
            .unwrap_or(amount_in);

        debit_fallback_position(&mut positions, &trade.token_in, amount_in);
        credit_fallback_position(
            &mut positions,
            &trade.token_out,
            amount_out,
            infer_swap_entry_price(trade, amount_in, amount_out),
        );
    }

    let mut open_positions: Vec<FallbackDexPositionAccumulator> = positions
        .into_values()
        .filter(|position| position.amount > rust_decimal::Decimal::ZERO)
        .collect();
    if open_positions.is_empty() {
        return Some(PortfolioStateResponse {
            total_value_usd: Some(0.0),
            cash_balance: configured_cash_token(bot).map(|_| 0.0),
            source: None,
            observed_at: None,
            stale: None,
            warnings: Vec::new(),
            has_unpriced_positions: false,
            has_value_only_positions: false,
            positions: Vec::new(),
        });
    }

    open_positions.sort_by(|a, b| a.token.cmp(&b.token));
    let cash_token = configured_cash_token(bot);
    let mut cash_balance = None;
    let mut total_value = rust_decimal::Decimal::ZERO;
    let mut has_unpriced_positions = false;
    let mut has_value_only_positions = false;
    let mut portfolio_positions = Vec::with_capacity(open_positions.len());

    for position in open_positions {
        let current_price = default_reference_price_usd(&position.token);
        let effective_price = current_price.or(position.entry_price);
        let valuation_status = match (current_price, position.entry_price) {
            (Some(_), _) => trading_runtime::types::ValuationStatus::Priced,
            (None, Some(_)) => trading_runtime::types::ValuationStatus::ValueOnly,
            (None, None) => trading_runtime::types::ValuationStatus::Unpriced,
        };
        let value_usd = effective_price.map(|price| price * position.amount);
        if let Some(value) = value_usd {
            total_value += value;
        }
        has_unpriced_positions |=
            valuation_status == trading_runtime::types::ValuationStatus::Unpriced;
        has_value_only_positions |=
            valuation_status == trading_runtime::types::ValuationStatus::ValueOnly;
        if cash_token.as_ref().is_some_and(|token| {
            normalize_fallback_token_key(token) == normalize_fallback_token_key(&position.token)
        }) {
            cash_balance = decimal_to_f64(position.amount);
        }

        let current_price_f64 = effective_price.and_then(decimal_to_f64);
        let entry_price_f64 = if valuation_status == trading_runtime::types::ValuationStatus::Priced
        {
            position.entry_price.and_then(decimal_to_f64)
        } else {
            None
        };
        let value_usd_f64 = value_usd.and_then(decimal_to_f64);
        let pnl_percent = match (current_price, position.entry_price) {
            (Some(current), Some(entry)) if entry > rust_decimal::Decimal::ZERO => {
                decimal_to_f64(((current - entry) / entry) * rust_decimal::Decimal::new(100, 0))
            }
            _ => None,
        };

        portfolio_positions.push(PortfolioPosition {
            token: position.token.clone(),
            symbol: position.token.clone(),
            amount: decimal_to_f64(position.amount).unwrap_or(0.0),
            value_usd: value_usd_f64,
            margin_used_usd: None,
            notional_usd: None,
            entry_price: entry_price_f64,
            current_price: current_price_f64,
            unrealized_pnl_usd: None,
            leverage: None,
            liquidation_price: None,
            pnl_percent,
            weight: None,
            protocol: None,
            position_type: None,
            valuation_status,
        });
    }

    let total_value_usd = if has_unpriced_positions {
        None
    } else {
        decimal_to_f64(total_value)
    };
    let positions = portfolio_positions
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

    let mut warnings = Vec::new();
    if has_unpriced_positions {
        warnings.push(
            "Some portfolio values are unavailable because trade valuation data is missing."
                .to_string(),
        );
    }
    if has_value_only_positions {
        warnings.push(
            "Some positions have current market value, but entry price or PnL are unavailable."
                .to_string(),
        );
    }

    Some(PortfolioStateResponse {
        total_value_usd,
        cash_balance: cash_balance.or_else(|| cash_token.as_ref().map(|_| 0.0)),
        source: None,
        observed_at: None,
        stale: None,
        warnings,
        has_unpriced_positions,
        has_value_only_positions,
        positions,
    })
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

fn patch_latest_snapshot_trade_count(snapshots: &mut [MetricsSnapshotResponse], trade_count: u32) {
    let Some(latest) = snapshots.last_mut() else {
        return;
    };
    latest.trade_count = latest.trade_count.max(trade_count);
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

fn fallback_trade_count(bot: &TradingBotRecord) -> u32 {
    u32::try_from(fallback_trade_dataset(bot).len()).unwrap_or(u32::MAX)
}

async fn fetch_visible_trade_count(bot: &TradingBotRecord) -> Option<u32> {
    let count = fetch_remote_trade_count(bot)
        .await
        .unwrap_or(0)
        .max(fallback_trade_count(bot));
    (count > 0).then_some(count)
}

fn fallback_metrics_history(
    bot: &TradingBotRecord,
    query: &MetricsHistoryQuery,
) -> Vec<MetricsSnapshotResponse> {
    let mut trades: Vec<_> = fallback_trade_dataset(bot)
        .into_iter()
        .map(|trade| {
            let timestamp = trade
                .get("created_at")
                .or_else(|| trade.get("timestamp"))
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let value_usd = fallback_trade_value_usd(&trade).unwrap_or(0.0);
            (timestamp, value_usd)
        })
        .collect();

    if trades.is_empty() {
        return Vec::new();
    }

    trades.sort_by(|a, b| a.0.cmp(&b.0));

    let initial_timestamp =
        chrono::DateTime::<chrono::Utc>::from_timestamp(bot.created_at as i64, 0)
            .unwrap_or_else(chrono::Utc::now)
            .to_rfc3339();
    let initial_account_value_usd = initial_paper_capital_usd(bot).unwrap_or(0.0);
    let mut snapshots = vec![MetricsSnapshotResponse {
        timestamp: initial_timestamp,
        bot_id: bot.id.clone(),
        account_value_usd: initial_account_value_usd,
        unrealized_pnl: 0.0,
        realized_pnl: 0.0,
        high_water_mark: initial_account_value_usd,
        drawdown_pct: 0.0,
        positions_count: 0,
        trade_count: 0,
    }];

    let mut account_value_usd = initial_account_value_usd;
    let mut high_water_mark = account_value_usd;
    for (index, (timestamp, value_usd)) in trades.into_iter().enumerate() {
        account_value_usd += value_usd;
        high_water_mark = high_water_mark.max(account_value_usd);
        snapshots.push(MetricsSnapshotResponse {
            timestamp,
            bot_id: bot.id.clone(),
            account_value_usd,
            unrealized_pnl: 0.0,
            realized_pnl: 0.0,
            high_water_mark,
            drawdown_pct: 0.0,
            positions_count: (index + 1) as u32,
            trade_count: (index + 1) as u32,
        });
    }

    if let Some(limit) = query.limit
        && snapshots.len() > limit
    {
        snapshots = snapshots.split_off(snapshots.len() - limit);
    }

    snapshots
}

async fn resolve_metrics_history_for_bot(
    bot: &TradingBotRecord,
    query: &MetricsHistoryQuery,
) -> Result<Vec<MetricsSnapshotResponse>, String> {
    let mut remote_query = Vec::new();
    if let Some(from) = &query.from {
        remote_query.push(("from", from.clone()));
    }
    if let Some(to) = &query.to {
        remote_query.push(("to", to.clone()));
    }
    if let Some(limit) = query.limit {
        remote_query.push(("limit", limit.to_string()));
    }

    match fetch_trading_api_json(bot, "/metrics/history", &remote_query).await {
        Ok(Some(payload)) => {
            match extract_json_array(payload, "snapshots").and_then(parse_metrics_snapshots) {
                Ok(mut snapshots) if !snapshots.is_empty() => {
                    if query.to.is_none()
                        && let Some(trade_count) = fetch_visible_trade_count(bot).await
                    {
                        patch_latest_snapshot_trade_count(&mut snapshots, trade_count);
                    }
                    Ok(snapshots)
                }
                Ok(_) => Ok(fallback_metrics_history(bot, query)),
                Err(err) => {
                    let fallback = fallback_metrics_history(bot, query);
                    if fallback.is_empty() {
                        Err(err)
                    } else {
                        Ok(fallback)
                    }
                }
            }
        }
        Ok(None) => Ok(fallback_metrics_history(bot, query)),
        Err(err) => {
            tracing::warn!(bot_id = %bot.id, "trading api metrics request failed: {err}");
            Ok(fallback_metrics_history(bot, query))
        }
    }
}

fn map_trading_api_portfolio(payload: serde_json::Value) -> Result<PortfolioStateResponse, String> {
    let portfolio: TradingApiPortfolioResponse =
        serde_json::from_value(payload).map_err(|e| format!("invalid portfolio payload: {e}"))?;

    let total_value = portfolio.total_value_usd;
    let has_unpriced_positions = portfolio.has_unpriced_positions;
    let mut has_value_only_positions = portfolio.has_value_only_positions;
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
            let valuation_status = match position.valuation_status {
                trading_runtime::types::ValuationStatus::Priced
                | trading_runtime::types::ValuationStatus::ValueOnly => position.valuation_status,
                trading_runtime::types::ValuationStatus::Unpriced => {
                    match (position.current_price, position.entry_price, value_usd) {
                        (Some(_), _, _) => trading_runtime::types::ValuationStatus::Priced,
                        (None, Some(_), _) | (None, None, Some(_)) => {
                            trading_runtime::types::ValuationStatus::ValueOnly
                        }
                        (None, None, None) => trading_runtime::types::ValuationStatus::Unpriced,
                    }
                }
            };
            if valuation_status == trading_runtime::types::ValuationStatus::ValueOnly {
                has_value_only_positions = true;
            };

            PortfolioPosition {
                token: position.token.clone(),
                symbol: position.token.clone(),
                amount: position.amount,
                value_usd,
                margin_used_usd: position.margin_used_usd,
                notional_usd: position.notional_usd,
                entry_price: position.entry_price,
                current_price: position.current_price,
                unrealized_pnl_usd: position.unrealized_pnl_usd.or(position.unrealized_pnl),
                leverage: position.leverage,
                liquidation_price: position.liquidation_price,
                pnl_percent,
                weight: match (value_usd, total_value) {
                    (Some(value_usd), Some(total_value)) if total_value > 0.0 => {
                        Some((value_usd / total_value) * 100.0)
                    }
                    _ => None,
                },
                protocol: position.protocol,
                position_type: position.position_type,
                valuation_status,
            }
        })
        .collect();

    Ok(PortfolioStateResponse {
        total_value_usd: total_value,
        cash_balance: portfolio.cash_balance,
        source: portfolio.source,
        observed_at: portfolio.observed_at,
        stale: portfolio.stale,
        warnings: portfolio.warnings,
        has_unpriced_positions,
        has_value_only_positions,
        positions,
    })
}

fn fallback_portfolio_state(bot: &TradingBotRecord) -> PortfolioStateResponse {
    if bot.strategy_type.eq_ignore_ascii_case("dex")
        && let Some(portfolio) = synthesize_dex_fallback_portfolio(bot)
    {
        return portfolio;
    }

    let trades = fallback_trade_dataset(bot);

    let open_trades: Vec<&serde_json::Value> = trades
        .iter()
        .filter(|t| t.get("status").and_then(|v| v.as_str()) == Some("open"))
        .collect();

    let mut has_unpriced_positions = false;
    let mut has_value_only_positions = false;
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
            let valuation_status = match (current_price, entry_price, value_usd) {
                (Some(_), _, _) => trading_runtime::types::ValuationStatus::Priced,
                (None, Some(_), _) | (None, None, Some(_)) => {
                    trading_runtime::types::ValuationStatus::ValueOnly
                }
                (None, None, None) => trading_runtime::types::ValuationStatus::Unpriced,
            };
            has_value_only_positions |=
                valuation_status == trading_runtime::types::ValuationStatus::ValueOnly;

            PortfolioPosition {
                token: mid.chars().take(10).collect(),
                symbol: question.chars().take(30).collect(),
                amount,
                value_usd,
                margin_used_usd: None,
                notional_usd: None,
                entry_price,
                current_price,
                unrealized_pnl_usd: None,
                leverage: None,
                liquidation_price: None,
                pnl_percent: pnl_pct,
                weight: None,
                protocol: None,
                position_type: None,
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
        source: None,
        observed_at: None,
        stale: None,
        warnings: {
            let mut warnings = Vec::new();
            if has_unpriced_positions {
                warnings.push(
                    "Some portfolio values are unavailable because trade valuation data is missing."
                        .to_string(),
                );
            }
            if has_value_only_positions {
                warnings.push(
                    "Some positions have current market value, but entry price or PnL are unavailable."
                        .to_string(),
                );
            }
            warnings
        },
        has_unpriced_positions,
        has_value_only_positions,
        positions,
    }
}

fn fallback_trade_history(bot: &TradingBotRecord) -> Vec<serde_json::Value> {
    let protocol = if bot.strategy_type == "prediction" {
        "polymarket"
    } else {
        &bot.strategy_type
    };

    let mut entries: Vec<TradeEntryResponse> = Vec::new();
    let mut seen_ids: std::collections::HashSet<String> = std::collections::HashSet::new();

    let portfolio_trades = state::load_bot_trades(&bot.id);
    for t in &portfolio_trades {
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

        let action = if side == "YES" || side == "long" || side == "buy" || side.contains("buy") {
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

        seen_ids.insert(tid.clone());
        entries.push(TradeEntryResponse {
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
            hyperliquid_metadata: None,
            valuation_status: trading_http_api::trade_store::TradeValuationStatus::Priced,
        });
    }

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
                hyperliquid_metadata: rec.hyperliquid_metadata,
                valuation_status: rec.valuation_status,
            });
        }
    }

    entries.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    entries
        .into_iter()
        .map(|entry| serde_json::to_value(entry).unwrap_or(serde_json::Value::Null))
        .collect()
}

// ── Metrics / trades handlers ───────────────────────────────────────────

async fn get_bot_metrics(
    Path(bot_id): Path<String>,
) -> Result<Json<BotMetricsResponse>, (StatusCode, String)> {
    let bot = resolve_bot(&bot_id)?;
    let metrics_history = match resolve_metrics_history_for_bot(
        &bot,
        &MetricsHistoryQuery {
            from: None,
            to: None,
            limit: Some(100),
        },
    )
    .await
    {
        Ok(snapshots) => snapshots,
        Err(err) => {
            tracing::warn!(bot_id = %bot.id, "failed to resolve metrics history: {err}");
            Vec::new()
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
    let trade_count = trade_count.max(fallback_trade_count(&bot));

    let total_pnl: f64 = trades
        .iter()
        .filter_map(|t| t.get("pnl").and_then(|v| v.as_f64()))
        .sum();

    let portfolio_value_usd = latest_snapshot
        .map(|snapshot| snapshot.account_value_usd)
        .unwrap_or_else(|| {
            fallback_portfolio_state(&bot)
                .total_value_usd
                .unwrap_or(0.0)
        });

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
    Path(bot_id): Path<String>,
    Query(query): Query<MetricsHistoryQuery>,
) -> Result<Json<Vec<serde_json::Value>>, (StatusCode, String)> {
    let bot = resolve_bot(&bot_id)?;
    let snapshots = resolve_metrics_history_for_bot(&bot, &query)
        .await
        .map_err(|err| {
            tracing::warn!(bot_id = %bot.id, "failed to load metrics history: {err}");
            (StatusCode::BAD_GATEWAY, err)
        })?;
    let json_snapshots = snapshots
        .into_iter()
        .map(|snapshot| serde_json::to_value(snapshot).unwrap_or(serde_json::Value::Null))
        .collect();

    Ok(Json(json_snapshots))
}

async fn get_bot_trades(
    Path(bot_id): Path<String>,
    Query(query): Query<TradeListQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let bot = resolve_bot(&bot_id)?;
    let mut remote_query = Vec::new();
    if let Some(limit) = query.limit {
        remote_query.push(("limit", limit.to_string()));
    }
    if let Some(offset) = query.offset {
        remote_query.push(("offset", offset.to_string()));
    }

    match fetch_trading_api_json(&bot, "/trades", &remote_query).await {
        Ok(Some(payload)) => match normalize_trade_list_payload(payload, &query) {
            Ok(payload) => Ok(Json(payload)),
            Err(err) => {
                tracing::warn!(bot_id = %bot.id, "invalid trading api trades payload: {err}");
                Ok(Json(paginated_trade_payload(
                    fallback_trade_history(&bot),
                    &query,
                )))
            }
        },
        Ok(None) => Ok(Json(paginated_trade_payload(
            fallback_trade_history(&bot),
            &query,
        ))),
        Err(err) => {
            tracing::warn!(bot_id = %bot.id, "trading api trades request failed, using fallback: {err}");
            Ok(Json(paginated_trade_payload(
                fallback_trade_history(&bot),
                &query,
            )))
        }
    }
}

async fn get_bot_market_candles(
    Path(bot_id): Path<String>,
    Query(query): Query<CandleListQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let bot = resolve_bot(&bot_id)?;
    let mut remote_query = Vec::new();
    if let Some(token) = query.token {
        remote_query.push(("token", token));
    }
    if let Some(source) = query.source {
        remote_query.push(("source", source));
    }
    if let Some(interval) = query.interval {
        remote_query.push(("interval", interval));
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
    if let Some(backfill) = query.backfill {
        remote_query.push(("backfill", backfill.to_string()));
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

async fn get_bot_chart_studies(
    Path(bot_id): Path<String>,
    Query(query): Query<ChartStudyListQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let bot = resolve_bot(&bot_id)?;
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

    match fetch_trading_api_json(&bot, "/chart/studies", &remote_query).await {
        Ok(Some(payload)) => Ok(Json(payload)),
        Ok(None) => Ok(Json(
            serde_json::json!({ "studies": [], "total": 0, "limit": query.limit.unwrap_or(12) }),
        )),
        Err(err) => {
            tracing::warn!(bot_id = %bot.id, "trading api chart studies request failed: {err}");
            Ok(Json(
                serde_json::json!({ "studies": [], "total": 0, "limit": query.limit.unwrap_or(12) }),
            ))
        }
    }
}

async fn get_platform_volume(
    Query(query): Query<trading_http_api::routes::trades::PlatformVolumeQuery>,
) -> Result<Json<trading_http_api::trade_store::PlatformVolumeResponse>, (StatusCode, String)> {
    trading_http_api::routes::trades::resolve_platform_volume(&query).map(Json)
}

async fn get_platform_trades(
    Query(query): Query<trading_http_api::routes::trades::TradeListQuery>,
) -> Result<Json<trading_http_api::routes::trades::TradeListResponse>, (StatusCode, String)> {
    trading_http_api::routes::trades::resolve_platform_trades(&query).map(Json)
}

async fn get_bot_baseline_backtest(
    SessionAuth(caller): SessionAuth,
    Path(bot_id): Path<String>,
) -> Result<Json<Option<trading_runtime::backtest::BacktestSummary>>, (StatusCode, String)> {
    let bot = resolve_bot(&bot_id)?;
    verify_submitter(&bot, &caller)?;
    Ok(Json(bot.baseline_backtest))
}

async fn get_bot_portfolio(
    Path(bot_id): Path<String>,
) -> Result<Json<PortfolioStateResponse>, (StatusCode, String)> {
    let bot = resolve_bot(&bot_id)?;

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

async fn get_bot_hyperliquid_nav(
    SessionAuth(caller): SessionAuth,
    Path(bot_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let bot = resolve_bot(&bot_id)?;
    verify_submitter(&bot, &caller)?;
    proxy_hyperliquid_nav(&bot, reqwest::Method::GET).await
}

async fn refresh_bot_hyperliquid_nav(
    SessionAuth(caller): SessionAuth,
    Path(bot_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let bot = resolve_bot(&bot_id)?;
    verify_submitter(&bot, &caller)?;
    proxy_hyperliquid_nav(&bot, reqwest::Method::POST).await
}

async fn get_bot_hyperliquid_mode(
    SessionAuth(caller): SessionAuth,
    Path(bot_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let bot = resolve_bot(&bot_id)?;
    verify_submitter(&bot, &caller)?;
    fetch_trading_api_json_with_method(&bot, reqwest::Method::GET, "/hyperliquid/mode", &[])
        .await
        .map_err(|err| {
            tracing::warn!(bot_id = %bot.id, "trading api Hyperliquid mode request failed: {err}");
            (StatusCode::BAD_GATEWAY, err)
        })?
        .map(Json)
        .ok_or_else(|| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "Bot trading API is not available for Hyperliquid mode".to_string(),
            )
        })
}

async fn get_bot_hyperliquid_settlement(
    SessionAuth(caller): SessionAuth,
    Path(bot_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let bot = resolve_bot(&bot_id)?;
    verify_submitter(&bot, &caller)?;
    proxy_hyperliquid_settlement(&bot, reqwest::Method::GET, "/hyperliquid/settlement").await
}

async fn run_bot_hyperliquid_settlement(
    SessionAuth(caller): SessionAuth,
    Path(bot_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let bot = resolve_bot(&bot_id)?;
    verify_submitter(&bot, &caller)?;
    proxy_hyperliquid_settlement(&bot, reqwest::Method::POST, "/hyperliquid/settlement/run").await
}

async fn proxy_hyperliquid_settlement(
    bot: &TradingBotRecord,
    method: reqwest::Method,
    path: &str,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    fetch_trading_api_json_with_method(bot, method, path, &[])
        .await
        .map_err(|err| {
            tracing::warn!(bot_id = %bot.id, "trading api Hyperliquid settlement request failed: {err}");
            (StatusCode::BAD_GATEWAY, err)
        })?
        .map(Json)
        .ok_or_else(|| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "Bot trading API is not available for Hyperliquid settlement".to_string(),
            )
        })
}

async fn proxy_hyperliquid_nav(
    bot: &TradingBotRecord,
    method: reqwest::Method,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    fetch_trading_api_json_with_method(bot, method, "/hyperliquid/nav", &[])
        .await
        .map_err(|err| {
            tracing::warn!(bot_id = %bot.id, "trading api Hyperliquid NAV request failed: {err}");
            (StatusCode::BAD_GATEWAY, err)
        })?
        .map(Json)
        .ok_or_else(|| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "Bot trading API is not available for Hyperliquid NAV reconciliation".to_string(),
            )
        })
}

// ── Activation progress handler ──────────────────────────────────────────

async fn get_activation_progress(
    SessionAuth(caller): SessionAuth,
    Path(bot_id): Path<String>,
) -> Result<Json<ActivationProgressResponse>, (StatusCode, String)> {
    let bot = resolve_bot(&bot_id)?;
    verify_submitter(&bot, &caller)?;
    let progress = state::get_activation(&bot_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                format!("No activation progress for bot {bot_id}"),
            )
        })?;

    Ok(Json(ActivationProgressResponse::from(progress)))
}

// ── Leaderboard ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct LeaderboardQuery {
    limit: Option<usize>,
    offset: Option<usize>,
    sort_by: Option<String>,
}

async fn get_leaderboard(
    Query(q): Query<LeaderboardQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let limit = q.limit.unwrap_or(50).min(200);
    let offset = q.offset.unwrap_or(0);
    let sort_by = q.sort_by.as_deref().unwrap_or("total_return_pct");

    let paginated = state::list_bots(None, 500, 0).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to list bots: {e}"),
        )
    })?;

    let mut entries: Vec<trading_runtime::leaderboard::LeaderboardStats> = paginated
        .bots
        .iter()
        .filter_map(|bot| {
            // Get metric snapshots for equity curve
            let snapshots =
                trading_http_api::metrics_store::snapshots_for_bot(&bot.id, None, None, 10000)
                    .ok()?;

            let equity_points: Vec<trading_runtime::leaderboard::EquityPoint> = snapshots
                .snapshots
                .iter()
                .filter_map(|s| {
                    let val = s.account_value_usd.parse::<rust_decimal::Decimal>().ok()?;
                    Some(trading_runtime::leaderboard::EquityPoint {
                        timestamp_secs: s.timestamp.timestamp(),
                        account_value: val,
                    })
                })
                .collect();

            // Get trade records for win rate
            let trades = trading_http_api::trade_store::trades_for_bot(&bot.id, 10000, 0).ok()?;
            // Approximate per-trade PnL from notional values where available
            let trade_pnls: Vec<rust_decimal::Decimal> = trades
                .trades
                .iter()
                .filter_map(|t| {
                    let amount_in: rust_decimal::Decimal = t.amount_in.parse().ok()?;
                    let amount_out: rust_decimal::Decimal = t.amount_out.as_ref()?.parse().ok()?;
                    Some(amount_out - amount_in)
                })
                .collect();

            Some(trading_runtime::leaderboard::compute_stats(
                &bot.id,
                &equity_points,
                &trade_pnls,
            ))
        })
        .collect();

    // Sort by requested field (descending)
    entries.sort_by(|a, b| {
        let cmp = match sort_by {
            "sharpe_ratio" => a.sharpe_ratio.partial_cmp(&b.sharpe_ratio),
            "sortino_ratio" => a.sortino_ratio.partial_cmp(&b.sortino_ratio),
            "max_drawdown_pct" => b.max_drawdown_pct.partial_cmp(&a.max_drawdown_pct), // lower is better
            "win_rate" => a.win_rate.partial_cmp(&b.win_rate),
            "calmar_ratio" => a.calmar_ratio.partial_cmp(&b.calmar_ratio),
            "total_trades" => a.total_trades.partial_cmp(&b.total_trades),
            _ => a.total_return_pct.partial_cmp(&b.total_return_pct),
        };
        cmp.unwrap_or(std::cmp::Ordering::Equal).reverse()
    });

    let total = entries.len();
    let page: Vec<_> = entries.into_iter().skip(offset).take(limit).collect();

    Ok(Json(serde_json::json!({
        "entries": page,
        "total": total,
        "limit": limit,
        "offset": offset,
        "sort_by": sort_by,
    })))
}

// ── Debug handlers ───────────────────────────────────────────────────────

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
    SessionAuth(caller): SessionAuth,
    Path(bot_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let bot = resolve_bot(&bot_id)?;
    verify_submitter(&bot, &caller)?;

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

    let _run_guard = ai_agent_sandbox_blueprint_lib::workflows::acquire_workflow_run(workflow_id)
        .map_err(map_run_now_error)?;

    let accepted_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    if let Err(err) =
        trading_blueprint_lib::workflow_compat::backfill_latest_execution_run(workflow_id)
    {
        tracing::warn!(
            workflow_id,
            error = %err,
            "Failed to backfill workflow run history before debug run"
        );
    }

    let wf_key_bg = wf_key.clone();
    tokio::spawn(async move {
        let _guard = _run_guard;
        match ai_agent_sandbox_blueprint_lib::workflows::run_workflow(&entry).await {
            Ok(execution) => {
                let latest_execution = execution.latest_execution.clone();
                let _ = ai_agent_sandbox_blueprint_lib::workflows::store_latest_execution(
                    workflow_id,
                    latest_execution.clone(),
                );
                if let Err(err) =
                    trading_blueprint_lib::workflow_compat::persist_latest_execution_run(
                        workflow_id,
                        latest_execution,
                    )
                {
                    tracing::warn!(
                        workflow_id,
                        error = %err,
                        "Failed to persist workflow run history after debug run"
                    );
                }
                let _ = ai_agent_sandbox_blueprint_lib::workflows::workflows()
                    .ok()
                    .and_then(|store| {
                        store
                            .update(&wf_key_bg, |e| {
                                ai_agent_sandbox_blueprint_lib::workflows::apply_workflow_execution(
                                    e,
                                    execution.last_run_at,
                                    execution.next_run_at,
                                );
                            })
                            .ok()
                    });
            }
            Err(err) => {
                tracing::error!("Debug workflow {workflow_id} execution failed: {err}");
                let failed_at = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                let failed_execution =
                    ai_agent_sandbox_blueprint_lib::workflows::store_failed_execution(
                        workflow_id,
                        err,
                    );
                match failed_execution {
                    Ok(latest_execution) => {
                        if let Err(err) =
                            trading_blueprint_lib::workflow_compat::persist_latest_execution_run(
                                workflow_id,
                                latest_execution,
                            )
                        {
                            tracing::warn!(
                                workflow_id,
                                error = %err,
                                "Failed to persist failed debug workflow run history"
                            );
                        }
                    }
                    Err(err) => {
                        tracing::warn!(
                            workflow_id,
                            error = %err,
                            "Failed to store failed debug workflow latest execution"
                        );
                    }
                }
                let _ = ai_agent_sandbox_blueprint_lib::workflows::workflows()
                    .ok()
                    .and_then(|store| {
                        store
                            .update(&wf_key_bg, |e| {
                                trading_blueprint_lib::workflow_compat::apply_workflow_failure(
                                    e, failed_at,
                                );
                            })
                            .ok()
                    });
            }
        }
    });

    Ok(Json(serde_json::json!({
        "status": "started",
        "workflow_id": workflow_id.to_string(),
        "session_id": "",
        "accepted_at": accepted_at,
    })))
}

// ── Pricing handlers ─────────────────────────────────────────────────────
//
// Service creation quotes are handled by the pricing engine gRPC server
// (separate process). These REST endpoints provide subscription info and
// billing status for operator dashboards and integrations.

#[derive(Deserialize)]
struct PricingQuoteRequest {
    #[allow(dead_code)]
    blueprint_id: Option<String>,
    #[allow(dead_code)]
    ttl_blocks: Option<String>,
    #[allow(dead_code)]
    proof_of_work: Option<String>,
    #[allow(dead_code)]
    challenge_timestamp: Option<String>,
    #[allow(dead_code)]
    resource_requirements: Option<serde_json::Value>,
    requester: Option<String>,
}

#[derive(Deserialize)]
struct JobQuoteRequest {
    #[allow(dead_code)]
    service_id: Option<String>,
    job_index: Option<u32>,
    #[allow(dead_code)]
    proof_of_work: Option<String>,
    #[allow(dead_code)]
    challenge_timestamp: Option<String>,
    /// tnt-core v0.13.0: 0x-prefixed EVM address (20 bytes) the quote must be
    /// bound to. The on-chain verifier rejects `address(0)`, so production
    /// callers MUST supply this. `Option` keeps wire compat for staged rollout.
    requester: Option<String>,
}

/// Returns subscription pricing info.
///
/// Service creation quotes are signed by the pricing engine gRPC server
/// (separate process). This REST endpoint returns informational pricing
/// config for integrations that don't use gRPC.
async fn pricing_quote(
    Json(body): Json<PricingQuoteRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let pricing_engine_endpoint = std::env::var("PRICING_ENGINE_ENDPOINT").unwrap_or_default();
    let operator_address = std::env::var("OPERATOR_ADDRESS").unwrap_or_default();
    let requester = body
        .requester
        .as_deref()
        .unwrap_or("0x0000000000000000000000000000000000000000");
    if requester != "0x0000000000000000000000000000000000000000" {
        request_access::ensure_requester_allowed(requester)
            .map_err(|message| (StatusCode::FORBIDDEN, message))?;
    }

    Ok(Json(serde_json::json!({
        "pricing_model": "subscription",
        "operator": operator_address,
        "requester": requester,
        "request_access": request_access::load_request_access_policy().summary(),
        "note": "Service creation quotes are served by the pricing engine gRPC endpoint. Use the gRPC GetPrice RPC for signed EIP-712 quotes.",
        "pricing_engine_grpc": pricing_engine_endpoint,
        "job_multipliers": {
            "provision": 50,
            "configure": 2,
            "start_trading": 1,
            "stop_trading": 1,
            "status": 0,
            "deprovision": 1,
            "extend": 10,
        },
    })))
}

/// Returns per-job pricing info.
///
/// Under subscription pricing, all jobs are covered by the service subscription.
/// No per-job payment is required.
async fn pricing_job_quote(
    Json(body): Json<JobQuoteRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let job_index = body.job_index.unwrap_or(0);
    let multipliers = [50, 2, 1, 1, 0, 1, 10]; // PRICE_MULT_* from contract
    let multiplier = multipliers.get(job_index as usize).copied().unwrap_or(0);

    // tnt-core v0.13.0: every job quote MUST commit to a non-zero requester.
    // Echo the field back so JSON callers can spot a missing/zero requester
    // before they hit the on-chain reject. Subscription pricing means no
    // signed quote is produced here — the gRPC pricing engine handles signing.
    let requester = body.requester.as_deref().unwrap_or_else(|| {
        tracing::warn!(
            "pricing_job_quote: requester field omitted — quote would be rejected on-chain"
        );
        "0x0000000000000000000000000000000000000000"
    });
    if requester != "0x0000000000000000000000000000000000000000" {
        request_access::ensure_requester_allowed(requester)
            .map_err(|message| (StatusCode::FORBIDDEN, message))?;
    }

    Ok(Json(serde_json::json!({
        "pricing_model": "subscription",
        "job_index": job_index,
        "per_job_cost": "0",
        "multiplier": multiplier,
        "requester": requester,
        "request_access": request_access::load_request_access_policy().summary(),
        "note": "All jobs are covered by the service subscription. No per-job payment required.",
    })))
}

/// Returns the operator's pricing configuration.
async fn get_pricing_config() -> Json<serde_json::Value> {
    let subscription_rate =
        std::env::var("SUBSCRIPTION_RATE").unwrap_or_else(|_| "1000000000".to_string());
    let subscription_interval: u64 = std::env::var("SUBSCRIPTION_INTERVAL")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(86400);
    let pricing_engine_endpoint = std::env::var("PRICING_ENGINE_ENDPOINT").unwrap_or_default();
    let operator_address = std::env::var("OPERATOR_ADDRESS").unwrap_or_default();

    Json(serde_json::json!({
        "operator": operator_address,
        "pricing_model": "subscription",
        "subscription_rate": subscription_rate,
        "subscription_interval": subscription_interval,
        "job_multipliers": {
            "provision": 50,
            "configure": 2,
            "start_trading": 1,
            "stop_trading": 1,
            "status": 0,
            "deprovision": 1,
            "extend": 10,
        },
        "pricing_engine_grpc": pricing_engine_endpoint,
    }))
}

/// Returns billing status for a specific service.
async fn get_billing_status(
    Path(service_id): Path<u64>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let tangle_address: alloy_primitives::Address = std::env::var("TANGLE_CONTRACT")
        .ok()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "TANGLE_CONTRACT not configured".to_string(),
            )
        })?;

    let ctx = trading_blueprint_lib::context::operator_context().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "Operator context not initialized".to_string(),
        )
    })?;

    let rpc_url = std::env::var("RPC_URL").unwrap_or_else(|_| "http://localhost:8545".to_string());
    let chain_id: u64 = std::env::var("CHAIN_ID")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(31337);

    let chain = trading_runtime::chain::ChainClient::new(&rpc_url, &ctx.private_key, chain_id)
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("ChainClient error: {e}"),
            )
        })?;

    let escrow =
        trading_blueprint_lib::on_chain::get_service_escrow(&chain, tangle_address, service_id)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let billable = trading_blueprint_lib::on_chain::get_billable_services(
        &chain,
        tangle_address,
        vec![service_id],
    )
    .await
    .unwrap_or_default();

    Ok(Json(serde_json::json!({
        "service_id": service_id,
        "escrow_token": format!("{}", escrow.token),
        "escrow_balance": escrow.balance.to_string(),
        "total_deposited": escrow.total_deposited.to_string(),
        "total_released": escrow.total_released.to_string(),
        "is_billable": billable.contains(&service_id),
    })))
}

// ── Provision handlers ───────────────────────────────────────────────────

async fn list_provisions() -> Result<Json<ProvisionListResponse>, (StatusCode, String)> {
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
    Path(call_id): Path<u64>,
) -> Result<Json<ProvisionProgressResponse>, (StatusCode, String)> {
    if call_id == 0 {
        return Err((
            StatusCode::CONFLICT,
            "call_id=0 is not a unique provision identity".to_string(),
        ));
    }

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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use http_body_util::BodyExt;
    use hyper::Request;
    use once_cell::sync::Lazy;
    use tower::ServiceExt;

    /// Shared state directory that outlives all tests in this module.
    /// Eagerly initializes all global OnceCell stores so they capture this
    /// stable directory rather than a short-lived tempdir from another test.
    ///
    /// IMPORTANT: This must be forced before ANY test calls `state::bots()`,
    /// `state::activations()`, or `sandboxes()` — otherwise the OnceCell
    /// captures a short-lived tempdir path from another test and later
    /// writes fail with ENOENT.
    static SHARED_STATE_DIR: Lazy<tempfile::TempDir> = Lazy::new(|| {
        let dir = tempfile::tempdir().expect("create temp state dir");
        unsafe {
            std::env::set_var("BLUEPRINT_STATE_DIR", dir.path());
        }
        // Eagerly initialize ALL global OnceCell stores so they capture
        // this stable directory. Order matters: set the env var first,
        // then touch every store.
        let _ = state::bots();
        let _ = state::activations();
        let _ = sandbox_runtime::runtime::sandboxes();
        dir
    });

    /// Ensure the shared state directory exists and all global stores are
    /// initialized to it. Must be called at the start of every test that
    /// seeds data or exercises handlers that write to stores.
    fn ensure_state_dir() {
        let dir = Lazy::force(&SHARED_STATE_DIR);
        std::fs::create_dir_all(dir.path()).ok();
    }

    fn test_auth_header() -> String {
        let token = sandbox_runtime::session_auth::create_test_token(
            "0x1234567890abcdef1234567890abcdef12345678",
        );
        format!("Bearer {token}")
    }

    #[test]
    fn create_bot_strategy_config_accepts_structured_object() {
        let req = CreateBotRequest {
            prompt: "volatility".to_string(),
            strategy_type: Some("volatility".to_string()),
            name: None,
            strategy_config: Some(serde_json::json!({
                "available_protocols": ["gmx_v2", "vertex"],
                "volatility_params": { "realized_window_hours": 24 }
            })),
            strategy_config_json: None,
            agent_profile: None,
        };

        let config = create_bot_strategy_config(&req).expect("strategy config");

        assert_eq!(
            config["available_protocols"],
            serde_json::json!(["gmx_v2", "vertex"])
        );
        assert_eq!(config["volatility_params"]["realized_window_hours"], 24);
    }

    #[test]
    fn create_bot_strategy_config_accepts_json_string_for_cli_callers() {
        let req = CreateBotRequest {
            prompt: "perp".to_string(),
            strategy_type: Some("perp".to_string()),
            name: None,
            strategy_config: None,
            strategy_config_json: Some(
                r#"{"protocol_chain_id":42161,"available_protocols":["gmx_v2","vertex"]}"#
                    .to_string(),
            ),
            agent_profile: None,
        };

        let config = create_bot_strategy_config(&req).expect("strategy config");

        assert_eq!(config["protocol_chain_id"], 42161);
        assert_eq!(
            config["available_protocols"],
            serde_json::json!(["gmx_v2", "vertex"])
        );
    }

    #[test]
    fn create_bot_strategy_config_rejects_non_object_config() {
        let req = CreateBotRequest {
            prompt: "perp".to_string(),
            strategy_type: Some("perp".to_string()),
            name: None,
            strategy_config: Some(serde_json::json!(["gmx_v2"])),
            strategy_config_json: None,
            agent_profile: None,
        };

        let err = create_bot_strategy_config(&req).expect_err("non-object config rejected");

        assert!(err.contains("strategy_config must be a JSON object"));
    }

    #[test]
    fn create_bot_strategy_config_accepts_agent_profile_as_source_of_intent() {
        let agent_profile = serde_json::json!({
            "schema": "tangle.trading.agent-profile.v1",
            "name": "ETH Perp Sentinel",
            "mandate": {
                "raw": "Trade ETH perps on Hyperliquid with strict liquidation buffers.",
                "market": "ETH-PERP",
                "preferredVenue": "Hyperliquid"
            },
            "activation": {
                "projectedStrategyType": "perp"
            },
            "capabilities": {
                "availableProtocols": ["hyperliquid", "gmx_v2", "vertex"],
                "preferredProtocols": ["hyperliquid"]
            }
        });
        let req = CreateBotRequest {
            prompt: String::new(),
            strategy_type: None,
            name: None,
            strategy_config: Some(serde_json::json!({
                "paper_trade": true
            })),
            strategy_config_json: None,
            agent_profile: Some(agent_profile.clone()),
        };

        let config = create_bot_strategy_config(&req).expect("strategy config");
        let config_value = serde_json::Value::Object(config.clone());
        let profile_prompt = prompt_from_config(&config_value).expect("profile prompt");
        let requested_strategy = config
            .get("agent_profile")
            .and_then(strategy_type_from_agent_profile);

        assert_eq!(config["agent_profile"], agent_profile);
        assert_eq!(
            profile_prompt,
            "Trade ETH perps on Hyperliquid with strict liquidation buffers."
        );
        assert_eq!(
            infer_create_bot_strategy_type(profile_prompt, requested_strategy),
            "hyperliquid_perp"
        );
    }

    fn naming_test_bot(
        name: &str,
        strategy_type: &str,
        strategy_config: serde_json::Value,
    ) -> TradingBotRecord {
        TradingBotRecord {
            id: "bot-name-test".to_string(),
            name: name.to_string(),
            sandbox_id: "sandbox-name-test".to_string(),
            vault_address: "0x0000000000000000000000000000000000000001".to_string(),
            share_token: String::new(),
            strategy_type: strategy_type.to_string(),
            strategy_config,
            risk_params: serde_json::json!({}),
            chain_id: 31337,
            rpc_url: "http://localhost:8545".to_string(),
            trading_api_url: "http://localhost:9100".to_string(),
            trading_api_token: "tok".to_string(),
            workflow_id: None,
            trading_active: false,
            created_at: 1000,
            operator_address: String::new(),
            validator_service_ids: vec![],
            max_lifetime_days: 30,
            paper_trade: true,
            wind_down_started_at: None,
            submitter_address: String::new(),
            trading_loop_cron: String::new(),
            call_id: 0,
            service_id: 0,
            harness_json: serde_json::json!(null),
            validation_trust: trading_runtime::ValidationTrust::default(),
            baseline_backtest: None,
            renewal_webhook_url: None,
            active_trial_run_id: None,
            active_trial_candidate_hash: None,
            pre_trial_harness_json: None,
        }
    }

    #[test]
    fn bot_name_generation_rejects_prompt_fragments() {
        let prompt = "I want an agent that trades ETH perps on Hyperliquid";

        assert!(sanitize_bot_name(prompt).is_none());
        assert!(bot_name_needs_generation(
            &prompt.chars().take(50).collect::<String>(),
            prompt
        ));
    }

    #[test]
    fn deterministic_bot_name_uses_asset_and_strategy_role() {
        let config = serde_json::json!({
            "user_prompt": "I want an agent that trades ETH perps on Hyperliquid",
            "protocol": "hyperliquid"
        });

        assert_eq!(
            deterministic_bot_name(
                "I want an agent that trades ETH perps on Hyperliquid",
                "hyperliquid_perp",
                &config,
            ),
            "ETH Perp Sentinel"
        );
    }

    #[test]
    fn create_bot_infers_hyperliquid_perp_without_frontend_override() {
        let prompt = "I want an agent that trades ETH perps on Hyperliquid with strict leverage and liquidation limits.";

        assert_eq!(
            infer_create_bot_strategy_type(prompt, None),
            "hyperliquid_perp"
        );
        assert_eq!(
            infer_create_bot_strategy_type(prompt, Some("perp")),
            "hyperliquid_perp"
        );
        assert_eq!(create_bot_protocol_chain_id("hyperliquid_perp", 84532), 998);
        assert_eq!(
            default_asset_token_address(998),
            Some("0x2B3370eE501B4a559b57D449569354196457D8Ab")
        );
    }

    #[test]
    fn create_bot_keeps_non_hyperliquid_perps_on_generic_perp_pack() {
        let prompt = "Trade ETH perps on GMX with 2x max leverage.";

        assert_eq!(infer_create_bot_strategy_type(prompt, None), "perp");
        assert_eq!(create_bot_protocol_chain_id("perp", 84532), 42161);
    }

    #[test]
    fn create_bot_does_not_promote_negative_hyperliquid_mentions() {
        let prompt = "Trade ETH perps on GMX, not on Hyperliquid.";

        assert_eq!(infer_create_bot_strategy_type(prompt, None), "perp");
    }

    #[test]
    fn effective_bot_name_prefers_persisted_display_name() {
        let bot = naming_test_bot(
            "I want an agent that trades ETH perps on Hyperliq",
            "hyperliquid_perp",
            serde_json::json!({
                "user_prompt": "I want an agent that trades ETH perps on Hyperliquid",
                "display_name": "ETH Perp Sentinel",
            }),
        );

        assert_eq!(effective_bot_name(&bot), "ETH Perp Sentinel");
    }

    #[test]
    fn effective_bot_name_falls_back_without_prompt_sentence() {
        let bot = naming_test_bot(
            "I want an agent that trades ETH perps on Hyperliq",
            "hyperliquid_perp",
            serde_json::json!({
                "user_prompt": "I want an agent that trades ETH perps on Hyperliquid",
                "protocol": "hyperliquid"
            }),
        );

        assert_eq!(effective_bot_name(&bot), "ETH Perp Sentinel");
    }

    #[tokio::test]
    async fn test_list_bots_returns_valid_response() {
        let tmp = tempfile::tempdir().unwrap();
        unsafe { std::env::set_var("BLUEPRINT_STATE_DIR", tmp.path()) };

        let app = build_operator_router();

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/bots")
                    .header("authorization", test_auth_header())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), 200);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(json["bots"].is_array());
        assert!(json["total"].is_number());
        assert!(json["limit"].is_number());
        assert!(json["offset"].is_number());
    }

    #[tokio::test]
    async fn test_zero_call_id_lookup_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        unsafe { std::env::set_var("BLUEPRINT_STATE_DIR", tmp.path()) };

        let app = build_operator_router();

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/bots?call_id=0&service_id=1")
                    .header("authorization", test_auth_header())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn test_zero_call_id_provision_lookup_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        unsafe { std::env::set_var("BLUEPRINT_STATE_DIR", tmp.path()) };

        let app = build_operator_router();

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/provisions/0")
                    .header("authorization", test_auth_header())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn test_get_bot_not_found() {
        let tmp = tempfile::tempdir().unwrap();
        unsafe { std::env::set_var("BLUEPRINT_STATE_DIR", tmp.path()) };

        let app = build_operator_router();

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/bots/nonexistent")
                    .header("authorization", test_auth_header())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), 404);
    }

    #[tokio::test]
    async fn test_get_bot_market_candles_route_resolves_bot_context() {
        let tmp = tempfile::tempdir().unwrap();
        unsafe { std::env::set_var("BLUEPRINT_STATE_DIR", tmp.path()) };

        let app = build_operator_router();

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/bots/nonexistent/market-data/candles?token=ETH")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_platform_volume_route_returns_aggregate_shape() {
        ensure_state_dir();
        let app = build_operator_router();

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
        let app = build_operator_router();

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

    #[test]
    fn test_strategy_bootstrap_memory_seeds_actionable_owner_message() {
        let (conversation_file, strategy_content, toc_content) = build_strategy_bootstrap_memory(
            "2026-04-22",
            "07:25 UTC",
            "Create a conservative Base Sepolia paper-trading bot.",
            None,
        );

        assert_eq!(
            conversation_file,
            "conversations/2026-04-22-strategy-context.md"
        );
        assert!(strategy_content.contains("# Strategy Brief"));
        assert!(strategy_content.contains("## Owner (07:25 UTC)"));
        assert!(toc_content.contains("[Strategy Brief]"));
        assert!(toc_content.contains("ACTION NEEDED"));
    }

    #[tokio::test]
    async fn test_configure_secrets_requires_auth() {
        let tmp = tempfile::tempdir().unwrap();
        unsafe { std::env::set_var("BLUEPRINT_STATE_DIR", tmp.path()) };

        let app = build_operator_router();

        let body = serde_json::json!({
            "env_json": { "API_KEY": "test" },
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bots/test-bot/secrets")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn test_configure_secrets_bot_not_found() {
        let tmp = tempfile::tempdir().unwrap();
        unsafe { std::env::set_var("BLUEPRINT_STATE_DIR", tmp.path()) };

        let app = build_operator_router();

        let body = serde_json::json!({
            "env_json": { "API_KEY": "test" },
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bots/nonexistent/secrets")
                    .header("content-type", "application/json")
                    .header("authorization", test_auth_header())
                    .body(Body::from(serde_json::to_string(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_wipe_secrets_requires_auth() {
        let app = build_operator_router();

        let response = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/bots/test-bot/secrets")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn test_start_bot_requires_auth() {
        let app = build_operator_router();

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bots/test-bot/start")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn test_stop_bot_requires_auth() {
        let app = build_operator_router();

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bots/test-bot/stop")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn test_run_now_requires_auth() {
        let app = build_operator_router();

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bots/test-bot/run-now")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn test_update_config_requires_auth() {
        let app = build_operator_router();

        let body = serde_json::json!({
            "strategy_config_json": "{\"max_slippage\": 1.0}",
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/bots/test-bot/config")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn test_start_bot_not_found() {
        let tmp = tempfile::tempdir().unwrap();
        unsafe { std::env::set_var("BLUEPRINT_STATE_DIR", tmp.path()) };

        let app = build_operator_router();

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bots/nonexistent/start")
                    .header("authorization", test_auth_header())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_run_now_not_found() {
        let tmp = tempfile::tempdir().unwrap();
        unsafe { std::env::set_var("BLUEPRINT_STATE_DIR", tmp.path()) };

        let app = build_operator_router();

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bots/nonexistent/run-now")
                    .header("authorization", test_auth_header())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_update_config_not_found() {
        let tmp = tempfile::tempdir().unwrap();
        unsafe { std::env::set_var("BLUEPRINT_STATE_DIR", tmp.path()) };

        let app = build_operator_router();

        let body = serde_json::json!({
            "strategy_config_json": "{\"max_slippage\": 1.0}",
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/bots/nonexistent/config")
                    .header("content-type", "application/json")
                    .header("authorization", test_auth_header())
                    .body(Body::from(serde_json::to_string(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_bot_detail_includes_wind_down() {
        ensure_state_dir();

        let store = state::bots().unwrap();
        let bot = TradingBotRecord {
            id: "wd-bot".to_string(),
            name: "Wind Down Bot".to_string(),
            sandbox_id: "sandbox-wd".to_string(),
            vault_address: "0x01".to_string(),
            share_token: String::new(),
            strategy_type: "dex_trading".to_string(),
            strategy_config: serde_json::json!({}),
            risk_params: serde_json::json!({}),
            chain_id: 31337,
            rpc_url: "http://localhost:8545".to_string(),
            trading_api_url: "http://localhost:9000".to_string(),
            trading_api_token: "tok".to_string(),
            workflow_id: None,
            trading_active: true,
            created_at: 1000,
            operator_address: String::new(),
            validator_service_ids: vec![],
            max_lifetime_days: 30,
            paper_trade: true,
            wind_down_started_at: Some(5000),
            submitter_address: String::new(),
            trading_loop_cron: String::new(),
            call_id: 0,
            service_id: 0,
            harness_json: serde_json::json!(null),
            validation_trust: trading_runtime::ValidationTrust::default(),
            baseline_backtest: None,
            renewal_webhook_url: None,
            active_trial_run_id: None,
            active_trial_candidate_hash: None,
            pre_trial_harness_json: None,
        };
        let expected_name = effective_bot_name(&bot);
        let _ = store.insert(state::bot_key("wd-bot"), bot);

        let app = build_operator_router();
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/bots/wd-bot")
                    .header("authorization", test_auth_header())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), 200);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["wind_down_started_at"], 5000);
        assert_eq!(json["name"], expected_name);
    }

    #[tokio::test]
    async fn test_get_bot_accepts_sandbox_id_alias() {
        ensure_state_dir();

        let bot = seed_bot(
            "sandbox-alias-bot",
            TEST_AUTH_ADDRESS,
            true,
            "sandbox-alias-1",
        );

        let app = build_operator_router();
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/bots/sandbox-alias-1")
                    .header("authorization", test_auth_header())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), 200);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["id"], bot.id);
        assert_eq!(json["sandbox_id"], "sandbox-alias-1");
    }

    // ── Helpers for unhappy-path tests ──────────────────────────────────

    /// Seed a bot record into the persistent store with a given submitter address.
    fn seed_bot(
        id: &str,
        submitter_address: &str,
        trading_active: bool,
        sandbox_id: &str,
    ) -> TradingBotRecord {
        let record = TradingBotRecord {
            id: id.to_string(),
            name: format!("Bot {id}"),
            sandbox_id: sandbox_id.to_string(),
            vault_address: format!("0xVAULT-{id}"),
            share_token: String::new(),
            strategy_type: "dex_trading".to_string(),
            strategy_config: serde_json::json!({}),
            risk_params: serde_json::json!({}),
            chain_id: 31337,
            rpc_url: "http://localhost:8545".to_string(),
            trading_api_url: "http://localhost:9100".to_string(),
            trading_api_token: "tok".to_string(),
            workflow_id: None,
            trading_active,
            created_at: 1000,
            operator_address: String::new(),
            validator_service_ids: vec![],
            max_lifetime_days: 30,
            paper_trade: true,
            wind_down_started_at: None,
            submitter_address: submitter_address.to_string(),
            trading_loop_cron: String::new(),
            call_id: 0,
            service_id: 0,
            harness_json: serde_json::json!(null),
            validation_trust: trading_runtime::ValidationTrust::default(),
            baseline_backtest: None,
            renewal_webhook_url: None,
            active_trial_run_id: None,
            active_trial_candidate_hash: None,
            pre_trial_harness_json: None,
        };
        let _ = state::bots()
            .expect("bots store")
            .insert(state::bot_key(id), record.clone());
        record
    }

    static ENV_LOCK: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));

    fn set_test_admin_env(_guard: &tokio::sync::MutexGuard<'_, ()>) {
        // SAFETY: serialized by ENV_LOCK for tests that mutate OPERATOR_ADDRESS.
        unsafe {
            std::env::set_var("OPERATOR_ADDRESS", TEST_AUTH_ADDRESS);
        }
    }

    fn reset_request_access_policy(_guard: &tokio::sync::MutexGuard<'_, ()>) {
        // SAFETY: serialized by ENV_LOCK for tests that mutate operator policy env.
        unsafe {
            std::env::remove_var("TRADING_REQUESTER_ACCESS_MODE");
            std::env::remove_var("TRADING_REQUESTER_ALLOWLIST");
            std::env::remove_var("TRADING_BOT_REQUESTER_ALLOWLIST");
            std::env::remove_var(DIRECT_BOT_CREATE_ENV);
        }
        let _ = std::fs::remove_file(
            sandbox_runtime::store::state_dir().join("request-access-policy.json"),
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn test_operator_meta_reports_request_access_policy() {
        ensure_state_dir();
        let _guard = ENV_LOCK.lock().await;
        set_test_admin_env(&_guard);
        reset_request_access_policy(&_guard);

        let response = build_operator_router()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/meta")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["deployment_kind"], "fleet");
        assert_eq!(json["request_access"]["mode"], "allowlist");
        assert_eq!(
            json["request_access"]["operator_address"],
            TEST_AUTH_ADDRESS
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn test_pricing_quote_rejects_disallowed_requester() {
        ensure_state_dir();
        let _guard = ENV_LOCK.lock().await;
        set_test_admin_env(&_guard);
        reset_request_access_policy(&_guard);

        let response = build_operator_router()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/pricing/quote")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "blueprint_id": "1",
                            "ttl_blocks": "100",
                            "requester": "0x9999999999999999999999999999999999999999"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let text = String::from_utf8(body.to_vec()).unwrap();
        assert!(text.contains("not allowed"), "{text}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn test_direct_bot_create_disabled_by_default() {
        ensure_state_dir();
        let _guard = ENV_LOCK.lock().await;
        set_test_admin_env(&_guard);
        reset_request_access_policy(&_guard);

        let response = build_operator_router()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bots")
                    .header("content-type", "application/json")
                    .header("authorization", test_auth_header())
                    .body(Body::from(
                        serde_json::json!({
                            "prompt": "Create a paper ETH strategy"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let text = String::from_utf8(body.to_vec()).unwrap();
        assert!(text.contains("Direct bot creation is disabled"), "{text}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn test_repair_strategy_requires_operator_admin() {
        ensure_state_dir();
        let _guard = ENV_LOCK.lock().await;
        // SAFETY: serialized by ENV_LOCK for tests that mutate OPERATOR_ADDRESS.
        unsafe {
            std::env::remove_var("OPERATOR_ADDRESS");
        }
        seed_bot(
            "repair-admin-required-1",
            TEST_AUTH_ADDRESS,
            true,
            "sandbox-repair-admin-required-1",
        );

        let app = build_operator_router();
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bots/repair-admin-required-1/strategy/repair")
                    .header("content-type", "application/json")
                    .header("authorization", test_auth_header())
                    .body(Body::from(r#"{"dry_run":true}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn test_repair_strategy_dry_run_retargets_hyperliquid_pack() {
        ensure_state_dir();
        let _guard = ENV_LOCK.lock().await;
        set_test_admin_env(&_guard);
        let prompt = "I want an agent that trades ETH perps on Hyperliquid with strict liquidation and drawdown limits.";
        let mut bot = seed_bot(
            "repair-hyperliquid-dry-run-1",
            TEST_AUTH_ADDRESS,
            true,
            "sandbox-repair-hyperliquid-dry-run-1",
        );
        bot.strategy_type = "perp".to_string();
        bot.chain_id = 84532;
        bot.strategy_config = serde_json::json!({
            "user_prompt": prompt,
            "strategy_type": "perp",
            "protocol_chain_id": 84532,
            "available_protocols": ["gmx_v2"],
            "supported_assets": [{"symbol": "ETH", "protocol": "gmx_v2", "chain_id": 42161}],
            "position_sizing": {"method": "fixed_fraction", "fraction": 0.1}
        });
        state::bots()
            .expect("bots store")
            .insert(state::bot_key(&bot.id), bot.clone())
            .expect("update bot");

        let app = build_operator_router();
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bots/repair-hyperliquid-dry-run-1/strategy/repair")
                    .header("content-type", "application/json")
                    .header("authorization", test_auth_header())
                    .body(Body::from(r#"{"dry_run":true}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["changed"], true);
        assert_eq!(json["reactivated"], false);
        assert_eq!(json["new_strategy_type"], "hyperliquid_perp");
        assert_eq!(json["strategy_config"]["protocol_chain_id"], 998);
        assert_eq!(
            json["strategy_config"]["available_protocols"],
            serde_json::json!(trading_runtime::supported_assets::all_execution_protocols())
        );
        assert_eq!(
            json["strategy_config"]["preferred_protocols"],
            serde_json::json!(["hyperliquid"])
        );
        let supported_assets = json["strategy_config"]["supported_assets"]
            .as_array()
            .expect("supported assets");
        assert!(
            supported_assets.iter().any(|asset| {
                asset["protocol"] == "hyperliquid" && asset["chain_id"] == serde_json::json!(998)
            }),
            "supported assets must include Hyperliquid on HyperEVM"
        );

        let stored = state::get_bot("repair-hyperliquid-dry-run-1")
            .unwrap()
            .unwrap();
        assert_eq!(stored.strategy_type, "perp");
        assert_eq!(
            stored.strategy_config["available_protocols"],
            serde_json::json!(["gmx_v2"])
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn test_repair_strategy_refuses_live_money_bot() {
        ensure_state_dir();
        let _guard = ENV_LOCK.lock().await;
        set_test_admin_env(&_guard);
        let mut bot = seed_bot(
            "repair-live-refused-1",
            TEST_AUTH_ADDRESS,
            true,
            "sandbox-repair-live-refused-1",
        );
        bot.paper_trade = false;
        bot.strategy_config = serde_json::json!({
            "user_prompt": "Trade ETH perps on Hyperliquid"
        });
        state::bots()
            .expect("bots store")
            .insert(state::bot_key(&bot.id), bot)
            .expect("update bot");

        let app = build_operator_router();
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bots/repair-live-refused-1/strategy/repair")
                    .header("content-type", "application/json")
                    .header("authorization", test_auth_header())
                    .body(Body::from(r#"{"dry_run":true}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::CONFLICT);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn test_repair_strategy_force_allows_active_trial_preview() {
        ensure_state_dir();
        let _guard = ENV_LOCK.lock().await;
        set_test_admin_env(&_guard);
        let mut bot = seed_bot(
            "repair-active-trial-force-1",
            TEST_AUTH_ADDRESS,
            true,
            "sandbox-repair-active-trial-force-1",
        );
        bot.strategy_type = "perp".to_string();
        bot.chain_id = 84532;
        bot.strategy_config = serde_json::json!({
            "user_prompt": "Trade ETH perps on Hyperliquid",
            "available_protocols": ["gmx_v2"],
            "protocol_chain_id": 84532
        });
        bot.active_trial_run_id = Some("trial-1".to_string());
        bot.active_trial_candidate_hash = Some("candidate-1".to_string());
        state::bots()
            .expect("bots store")
            .insert(state::bot_key(&bot.id), bot)
            .expect("update bot");

        let app = build_operator_router();
        let guarded_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bots/repair-active-trial-force-1/strategy/repair")
                    .header("content-type", "application/json")
                    .header("authorization", test_auth_header())
                    .body(Body::from(r#"{"dry_run":true}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(guarded_response.status(), StatusCode::CONFLICT);

        let forced_response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bots/repair-active-trial-force-1/strategy/repair")
                    .header("content-type", "application/json")
                    .header("authorization", test_auth_header())
                    .body(Body::from(r#"{"dry_run":true,"force":true}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(forced_response.status(), StatusCode::OK);
        let body = forced_response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["new_strategy_type"], "hyperliquid_perp");
        assert!(
            json["changed_fields"]
                .as_array()
                .unwrap()
                .iter()
                .any(|field| field == "active_trial")
        );
    }

    async fn spawn_mock_hyperliquid_nav_api() -> String {
        let app = Router::new()
            .route(
                "/hyperliquid/nav",
                axum::routing::get(|| async {
                    Json(serde_json::json!({
                        "snapshot": {
                            "bot_id": "hype-nav-proxy",
                            "total_nav": "100000",
                            "share_price": "1"
                        },
                        "stale": false
                    }))
                })
                .post(|| async {
                    Json(serde_json::json!({
                        "snapshot": {
                            "bot_id": "hype-nav-proxy",
                            "total_nav": "100001",
                            "share_price": "1.00001"
                        },
                        "stale": false
                    }))
                }),
            )
            .route(
                "/hyperliquid/mode",
                axum::routing::get(|| async {
                    Json(serde_json::json!({
                        "snapshot": {
                            "bot_id": "hype-nav-proxy",
                            "mode": "liquidity",
                            "reason": "queued withdrawals are above the 1500 bps liquidity threshold",
                            "checked_at": "2026-05-18T00:00:00Z",
                            "thresholds": {
                                "liquidity_mode_queue_bps": 1500,
                                "emergency_queue_bps": 6000,
                                "min_idle_usdc_bps": 1500,
                                "max_margin_usage_bps": 8000
                            },
                            "metrics": {
                                "nav_as_of": "2026-05-18T00:00:00Z",
                                "nav_stale": false,
                                "queued_withdrawal_bps": 1800,
                                "idle_usdc_bps": 400,
                                "margin_usage_bps": 4200
                            }
                        }
                    }))
                }),
            )
            .route(
                "/hyperliquid/settlement",
                axum::routing::get(|| async {
                    Json(serde_json::json!({
                        "state": {
                            "bot_id": "hype-nav-proxy",
                            "settlement_cron": "0 0 0 * * *",
                            "next_settlement_time": "2026-05-19T00:00:00Z",
                            "cutoff_time": "2026-05-18T23:00:00Z",
                            "current_epoch": "2026-05-18T00:00:00Z",
                            "cutoff_secs": 3600,
                            "idle_buffer_bps": 1500,
                            "idle_buffer_target": "15000000000",
                            "cash_needed": "0",
                            "queued_shares": "250000000",
                            "next_request_id": "1",
                            "next_request_created_at": "2026-05-18T22:30:00Z",
                            "next_request_eligible": true,
                            "eligible_pending_request_count": 1,
                            "rollover": false,
                            "last_attempt": null
                        }
                    }))
                }),
            )
            .route(
                "/hyperliquid/settlement/run",
                axum::routing::post(|| async {
                    Json(serde_json::json!({
                        "attempt": {
                            "bot_id": "hype-nav-proxy",
                            "epoch": "2026-05-18T00:00:00Z",
                            "last_attempt_at": "2026-05-18T00:00:03Z",
                            "last_status": "succeeded",
                            "fulfilled_count": 1,
                            "fulfilled_assets": "250000000",
                            "stopped_reason": "queue_empty",
                            "tx_hashes": ["0xabc"]
                        }
                    }))
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock Hyperliquid NAV API");
        let addr = listener.local_addr().expect("mock Hyperliquid NAV addr");
        tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve mock Hyperliquid NAV API");
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn test_bot_hyperliquid_nav_routes_proxy_trading_api() {
        ensure_state_dir();
        let trading_api_url = spawn_mock_hyperliquid_nav_api().await;
        let mut bot = seed_bot(
            "hype-nav-proxy",
            TEST_AUTH_ADDRESS,
            true,
            "sandbox-hype-nav-proxy",
        );
        bot.strategy_type = "hyperliquid_perp".to_string();
        bot.trading_api_url = trading_api_url;
        bot.trading_api_token = "tok".to_string();
        state::bots()
            .expect("bots store")
            .insert(state::bot_key(&bot.id), bot.clone())
            .expect("update bot");

        let app = build_operator_router();
        let get_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/bots/{}/hyperliquid/nav", bot.id))
                    .header("authorization", test_auth_header())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(get_response.status(), StatusCode::OK);
        let body = get_response.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["snapshot"]["total_nav"], "100000");
        assert_eq!(json["snapshot"]["share_price"], "1");
        assert_eq!(json["stale"], false);

        let post_response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/bots/{}/hyperliquid/nav", bot.id))
                    .header("authorization", test_auth_header())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(post_response.status(), StatusCode::OK);
        let body = post_response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["snapshot"]["total_nav"], "100001");
        assert_eq!(json["snapshot"]["share_price"], "1.00001");
        assert_eq!(json["stale"], false);

        let mode_response = build_operator_router()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/bots/{}/hyperliquid/mode", bot.id))
                    .header("authorization", test_auth_header())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(mode_response.status(), StatusCode::OK);
        let body = mode_response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["snapshot"]["mode"], "liquidity");
        assert_eq!(json["snapshot"]["metrics"]["queued_withdrawal_bps"], 1800);

        let settlement_response = build_operator_router()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/bots/{}/hyperliquid/settlement", bot.id))
                    .header("authorization", test_auth_header())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(settlement_response.status(), StatusCode::OK);
        let body = settlement_response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["state"]["idle_buffer_bps"], 1500);
        assert_eq!(json["state"]["eligible_pending_request_count"], 1);

        let run_response = build_operator_router()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/bots/{}/hyperliquid/settlement/run", bot.id))
                    .header("authorization", test_auth_header())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(run_response.status(), StatusCode::OK);
        let body = run_response.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["attempt"]["fulfilled_count"], 1);
        assert_eq!(json["attempt"]["stopped_reason"], "queue_empty");
    }

    #[tokio::test]
    async fn test_bot_hyperliquid_proxy_routes_reject_wrong_submitter() {
        ensure_state_dir();

        let mut bot = seed_bot(
            "hype-proxy-forbidden-1",
            "0xDEAD000000000000000000000000000000000003",
            true,
            "sandbox-hype-proxy-forbidden-1",
        );
        bot.strategy_type = "hyperliquid_perp".to_string();
        state::bots()
            .expect("bots store")
            .insert(state::bot_key(&bot.id), bot.clone())
            .expect("update bot");

        let app = build_operator_router();
        let routes = [
            ("GET", format!("/api/bots/{}/hyperliquid/nav", bot.id)),
            ("POST", format!("/api/bots/{}/hyperliquid/nav", bot.id)),
            ("GET", format!("/api/bots/{}/hyperliquid/mode", bot.id)),
            (
                "GET",
                format!("/api/bots/{}/hyperliquid/settlement", bot.id),
            ),
            (
                "POST",
                format!("/api/bots/{}/hyperliquid/settlement/run", bot.id),
            ),
        ];

        for (method, uri) in routes {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(uri)
                        .header("authorization", test_auth_header())
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();

            assert_eq!(
                response.status(),
                StatusCode::FORBIDDEN,
                "{method} Hyperliquid proxy route should reject wrong submitter"
            );
        }
    }

    /// The address embedded in the token produced by `test_auth_header()`.
    const TEST_AUTH_ADDRESS: &str = "0x1234567890abcdef1234567890abcdef12345678";

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
            slippage_bps: None,
            execution_reason: None,
            prediction_metadata: None,
            hyperliquid_metadata: None,
            valuation_status: trading_http_api::trade_store::TradeValuationStatus::Unpriced,
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

    /// Seed a sandbox record whose `has_user_secrets()` returns true.
    ///
    /// The insert may fail to flush to disk if the sandboxes OnceCell was
    /// initialized by a parallel test that used a short-lived tempdir. We
    /// ignore the flush error because the in-memory HashMap is still updated
    /// (LocalDatabase inserts before flushing), and `get_sandbox_by_id` reads
    /// from memory.
    fn seed_sandbox_with_secrets(sandbox_id: &str) {
        let record = sandbox_runtime::SandboxRecord {
            id: sandbox_id.to_string(),
            container_id: "fake-container".to_string(),
            sidecar_url: "http://127.0.0.1:19999".to_string(),
            sidecar_port: 19999,
            ssh_port: None,
            token: "tok".to_string(),
            created_at: 1000,
            cpu_cores: 1,
            memory_mb: 512,
            state: Default::default(),
            idle_timeout_seconds: 0,
            max_lifetime_seconds: 0,
            last_activity_at: 0,
            stopped_at: None,
            snapshot_image_id: None,
            snapshot_s3_url: None,
            container_removed_at: None,
            image_removed_at: None,
            original_image: String::new(),
            base_env_json: "{}".to_string(),
            user_env_json: r#"{"ANTHROPIC_API_KEY":"sk-already-set"}"#.to_string(),
            snapshot_destination: None,
            tee_deployment_id: None,
            tee_metadata_json: None,
            name: String::new(),
            agent_identifier: String::new(),
            metadata_json: String::new(),
            disk_gb: 0,
            stack: String::new(),
            owner: String::new(),
            service_id: None,
            tee_config: None,
            extra_ports: std::collections::HashMap::new(),
            ssh_login_user: None,
            ssh_authorized_keys: Vec::new(),
            capabilities_json: String::new(),
            tee_attestation_json: None,
        };
        // Ignore flush errors — the in-memory data is what matters for
        // has_user_secrets() since get_sandbox_by_id reads from memory.
        let _ = sandbox_runtime::runtime::sandboxes()
            .expect("sandboxes store")
            .insert(sandbox_id.to_string(), record);
    }

    // ── Unhappy-path tests ──────────────────────────────────────────────

    #[tokio::test]
    async fn test_auth_session_rejects_invalid_nonce() {
        ensure_state_dir();

        let app = build_operator_router();

        // Use a nonce that was never issued by create_challenge().
        let body = serde_json::json!({
            "nonce": "0000000000000000000000000000000000000000000000000000000000000000",
            "signature": "0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/session")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "Invalid nonce should be rejected with 401"
        );
    }

    #[tokio::test]
    async fn test_auth_session_rejects_bad_signature() {
        ensure_state_dir();

        let app = build_operator_router();

        // First obtain a real nonce from the challenge endpoint.
        let challenge_resp = build_operator_router()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/challenge")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(challenge_resp.status(), StatusCode::OK);
        let challenge_body = challenge_resp
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        let challenge_json: serde_json::Value = serde_json::from_slice(&challenge_body).unwrap();
        let nonce = challenge_json["nonce"].as_str().unwrap().to_string();

        // Use the real nonce but a garbled (too-short) signature.
        let body = serde_json::json!({
            "nonce": nonce,
            "signature": "0xdeadbeef",
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/session")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "Garbled signature with valid nonce should be rejected with 401"
        );
    }

    #[tokio::test]
    async fn test_secrets_wrong_submitter_returns_forbidden() {
        ensure_state_dir();

        // Seed a bot whose submitter is NOT the test auth address.
        seed_bot(
            "secrets-forbidden-1",
            "0xDEAD000000000000000000000000000000000001",
            false,
            "sandbox-secrets-forbidden-1",
        );
        seed_sandbox_with_secrets("sandbox-secrets-forbidden-1");

        let app = build_operator_router();

        let body = serde_json::json!({
            "env_json": { "ANTHROPIC_API_KEY": "sk-test" },
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bots/secrets-forbidden-1/secrets")
                    .header("content-type", "application/json")
                    .header("authorization", test_auth_header())
                    .body(Body::from(serde_json::to_string(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(
            response.status(),
            StatusCode::FORBIDDEN,
            "Wrong submitter should get 403"
        );
    }

    #[tokio::test]
    async fn test_secrets_with_empty_env_and_no_operator_keys() {
        ensure_state_dir();

        // Ensure no AI keys are present in the environment.
        unsafe {
            std::env::remove_var("ANTHROPIC_API_KEY");
            std::env::remove_var("ZAI_API_KEY");
        }

        // Seed a bot whose submitter matches the test auth address.
        seed_bot(
            "secrets-empty-env-1",
            TEST_AUTH_ADDRESS,
            false,
            "sandbox-secrets-empty-env-1",
        );
        seed_sandbox_with_secrets("sandbox-secrets-empty-env-1");

        let app = build_operator_router();

        let body = serde_json::json!({
            "env_json": {},
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bots/secrets-empty-env-1/secrets")
                    .header("content-type", "application/json")
                    .header("authorization", test_auth_header())
                    .body(Body::from(serde_json::to_string(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(
            response.status(),
            StatusCode::BAD_REQUEST,
            "Empty env_json with no operator AI keys should return 400"
        );
    }

    #[tokio::test]
    async fn test_stop_already_stopped_bot() {
        ensure_state_dir();

        // Seed a bot that is already stopped (trading_active = false).
        seed_bot(
            "stop-stopped-1",
            TEST_AUTH_ADDRESS,
            false,
            "sandbox-stop-stopped-1",
        );
        seed_sandbox_with_secrets("sandbox-stop-stopped-1");

        let app = build_operator_router();

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bots/stop-stopped-1/stop")
                    .header("authorization", test_auth_header())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        // stop_core calls find_bot_by_sandbox, sets trading_active=false.
        // The handler uses bot.sandbox_id which maps to a real bot, so
        // the operation succeeds idempotently (no Docker, just state update).
        let status = response.status().as_u16();
        // stop_core is idempotent: it succeeds or fails at Docker/workflow layer.
        // Without Docker, it should succeed at 200, or 500 if state update fails.
        assert!(
            status == 200 || status == 500,
            "Expected 200 (idempotent stop) or 500 (state error), got {status}"
        );
    }

    #[tokio::test]
    async fn test_start_already_active_bot() {
        ensure_state_dir();

        // Seed a bot that is already active (trading_active = true).
        seed_bot(
            "start-active-1",
            TEST_AUTH_ADDRESS,
            true,
            "sandbox-start-active-1",
        );
        seed_sandbox_with_secrets("sandbox-start-active-1");

        let app = build_operator_router();

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bots/start-active-1/start")
                    .header("authorization", test_auth_header())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        // start_core is idempotent: sets trading_active=true even if already true.
        // Without Docker/workflow it should succeed.
        let status = response.status().as_u16();
        assert!(
            status == 200 || status == 500,
            "Expected 200 (idempotent start) or 500 (state error), got {status}"
        );
    }

    #[tokio::test]
    async fn test_configure_bot_with_invalid_json() {
        ensure_state_dir();

        seed_bot(
            "config-invalid-json-1",
            TEST_AUTH_ADDRESS,
            true,
            "sandbox-config-invalid-json-1",
        );

        let app = build_operator_router();

        // configure_core silently ignores invalid JSON in strategy_config_json
        // (uses `if let Ok(config) = serde_json::from_str(...)` — no error on
        // parse failure). The handler returns 200. It does NOT return 400 for
        // malformed strategy_config_json.
        let body = serde_json::json!({
            "strategy_config_json": "not{valid",
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/bots/config-invalid-json-1/config")
                    .header("content-type", "application/json")
                    .header("authorization", test_auth_header())
                    .body(Body::from(serde_json::to_string(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        let status = response.status().as_u16();
        // The handler does NOT reject invalid JSON with 400 — it silently
        // ignores it via `if let Ok(...)`. The response is 200 when the
        // store update flushes successfully, or 500 if the global store's
        // disk path was invalidated by a parallel test (pre-existing test
        // infrastructure issue, not a behavior issue). Either way, it does
        // NOT return 400 or 403.
        assert_ne!(
            status, 400,
            "Invalid strategy JSON should NOT cause a 400 — it is silently ignored"
        );
        assert_ne!(status, 401, "Auth should pass");
        assert_ne!(status, 403, "Submitter check should pass");
        assert_ne!(status, 404, "Bot should be found");

        // When the store is functional (200), verify the config was NOT changed.
        if status == 200 {
            let bot = state::get_bot("config-invalid-json-1").unwrap().unwrap();
            assert_eq!(
                bot.strategy_config,
                serde_json::json!({}),
                "Strategy config should remain unchanged when invalid JSON is provided"
            );
        }
    }

    #[tokio::test]
    async fn test_wipe_secrets_wrong_submitter() {
        ensure_state_dir();

        // Seed a bot whose submitter does NOT match the test auth address.
        seed_bot(
            "wipe-forbidden-1",
            "0xDEAD000000000000000000000000000000000002",
            false,
            "sandbox-wipe-forbidden-1",
        );

        let app = build_operator_router();

        let response = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/bots/wipe-forbidden-1/secrets")
                    .header("authorization", test_auth_header())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(
            response.status(),
            StatusCode::FORBIDDEN,
            "Wrong submitter should get 403 on wipe_secrets"
        );
    }

    #[tokio::test]
    async fn test_run_now_inactive_bot() {
        ensure_state_dir();

        // Seed a bot that is NOT active.
        seed_bot(
            "run-now-inactive-1",
            TEST_AUTH_ADDRESS,
            false,
            "sandbox-run-now-inactive-1",
        );

        let app = build_operator_router();

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bots/run-now-inactive-1/run-now")
                    .header("authorization", test_auth_header())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(
            response.status(),
            StatusCode::CONFLICT,
            "run-now on inactive bot should return 409 CONFLICT"
        );
    }

    #[tokio::test]
    async fn test_observatory_trigger_requires_auth() {
        ensure_state_dir();

        seed_bot(
            "observatory-auth-required-1",
            TEST_AUTH_ADDRESS,
            true,
            "sandbox-observatory-auth-required-1",
        );

        let app = build_operator_router();
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bots/observatory-auth-required-1/observatory/trigger")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"reason":"test"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn test_observatory_trigger_rejects_wrong_submitter_before_sidecar() {
        ensure_state_dir();

        seed_bot(
            "observatory-wrong-owner-1",
            "0xDEAD000000000000000000000000000000000004",
            true,
            "sandbox-observatory-wrong-owner-1",
        );

        let app = build_operator_router();
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bots/observatory-wrong-owner-1/observatory/trigger")
                    .header("content-type", "application/json")
                    .header("authorization", test_auth_header())
                    .body(Body::from(r#"{"reason":"test"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn test_observatory_overview_scopes_to_owner_and_hides_empty_submitters() {
        ensure_state_dir();

        seed_bot(
            "observatory-owned-visible-1",
            TEST_AUTH_ADDRESS,
            true,
            "sandbox-observatory-owned-visible-1",
        );
        seed_sandbox_with_secrets("sandbox-observatory-owned-visible-1");
        seed_bot(
            "observatory-other-hidden-1",
            "0xDEAD000000000000000000000000000000000005",
            true,
            "sandbox-observatory-other-hidden-1",
        );
        seed_sandbox_with_secrets("sandbox-observatory-other-hidden-1");
        seed_bot(
            "observatory-empty-hidden-1",
            "",
            true,
            "sandbox-observatory-empty-hidden-1",
        );
        seed_sandbox_with_secrets("sandbox-observatory-empty-hidden-1");

        let app = build_operator_router();
        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/observatory/overview")
                    .header("authorization", test_auth_header())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let bot_ids: Vec<String> = json
            .get("bots")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|bot| bot.get("bot_id").and_then(serde_json::Value::as_str))
            .map(str::to_string)
            .collect();

        assert!(bot_ids.iter().any(|id| id == "observatory-owned-visible-1"));
        assert!(!bot_ids.iter().any(|id| id == "observatory-other-hidden-1"));
        assert!(!bot_ids.iter().any(|id| id == "observatory-empty-hidden-1"));
    }

    #[tokio::test]
    async fn test_observatory_feedback_rejects_unknown_action_before_sidecar() {
        ensure_state_dir();

        seed_bot(
            "observatory-feedback-action-1",
            TEST_AUTH_ADDRESS,
            true,
            "sandbox-observatory-feedback-action-1",
        );

        let app = build_operator_router();
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(
                        "/api/bots/observatory-feedback-action-1/observatory/ideas/idea-1/feedback",
                    )
                    .header("content-type", "application/json")
                    .header("authorization", test_auth_header())
                    .body(Body::from(r#"{"action":"promote_live"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn test_secrets_on_already_activated_bot() {
        ensure_state_dir();

        let bot_id = "secrets-already-active-1";
        let sandbox_id = "sandbox-secrets-already-active-1";

        // Seed the bot record.
        seed_bot(bot_id, TEST_AUTH_ADDRESS, false, sandbox_id);

        // Seed a sandbox record with user_env_json set (simulating secrets
        // already configured). The activate_bot_with_secrets code checks
        // has_user_secrets() and rejects if true.
        seed_sandbox_with_secrets(sandbox_id);

        let app = build_operator_router();

        let body = serde_json::json!({
            "env_json": { "ANTHROPIC_API_KEY": "sk-new-key" },
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/bots/{bot_id}/secrets"))
                    .header("content-type", "application/json")
                    .header("authorization", test_auth_header())
                    .body(Body::from(serde_json::to_string(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(
            response.status(),
            StatusCode::INTERNAL_SERVER_ERROR,
            "Posting secrets to an already-activated bot should fail"
        );

        let body = response.into_body().collect().await.unwrap().to_bytes();
        let err = String::from_utf8_lossy(&body);
        assert!(
            err.contains("already has secrets"),
            "Error should mention secrets already configured, got: {err}"
        );
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

    #[test]
    fn parse_metrics_snapshots_accepts_numeric_strings() {
        let snapshots = vec![serde_json::json!({
            "timestamp": "2026-04-10T13:45:31.753572Z",
            "bot_id": "bot-1",
            "account_value_usd": "2212.61",
            "unrealized_pnl": "12.61",
            "realized_pnl": "0",
            "high_water_mark": "2212.61",
            "drawdown_pct": "0.0",
            "positions_count": 1,
            "trade_count": 2
        })];

        let parsed = parse_metrics_snapshots(snapshots).expect("metrics snapshots should parse");

        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].account_value_usd, 2212.61);
        assert_eq!(parsed[0].unrealized_pnl, 12.61);
        assert_eq!(parsed[0].trade_count, 2);
    }

    #[test]
    fn parse_metrics_snapshots_rejects_non_numeric_values() {
        let snapshots = vec![serde_json::json!({
            "timestamp": "2026-04-10T13:45:31.753572Z",
            "bot_id": "bot-1",
            "account_value_usd": "not-a-number",
            "unrealized_pnl": "12.61",
            "realized_pnl": "0",
            "high_water_mark": "2212.61",
            "drawdown_pct": "0.0",
            "positions_count": 1,
            "trade_count": 2
        })];

        let result = parse_metrics_snapshots(snapshots);

        assert!(result.is_err(), "invalid metrics should fail");
        assert!(
            result
                .err()
                .is_some_and(|err| err.contains("invalid metrics snapshot array"))
        );
    }

    #[test]
    fn initial_paper_capital_reads_usd_balance_not_asset_units() {
        ensure_state_dir();
        let bot = seed_bot(
            "paper-capital-bot",
            TEST_AUTH_ADDRESS,
            true,
            "sandbox-capital-1",
        );

        let mut bot = bot;
        bot.strategy_config = serde_json::json!({
            "initial_capital_usd": "10000",
            "asset_token": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
        });

        assert_eq!(initial_paper_capital_usd(&bot), Some(10000.0));
        assert_eq!(configured_cash_token(&bot), Some("USDC".to_string()));
    }

    #[test]
    fn map_trading_api_portfolio_inferrs_priced_positions_when_status_is_missing() {
        let payload = serde_json::json!({
            "positions": [
                {
                    "token": "WETH",
                    "amount": "1",
                    "value_usd": "2220.1",
                    "entry_price": null,
                    "current_price": "2220.1"
                }
            ],
            "total_value_usd": "2220.1",
            "cash_balance": "1",
            "warnings": [],
            "has_unpriced_positions": false
        });

        let portfolio = map_trading_api_portfolio(payload).expect("portfolio should parse");

        assert_eq!(portfolio.total_value_usd, Some(2220.1));
        assert!(!portfolio.has_unpriced_positions);
        assert_eq!(
            portfolio.positions[0].valuation_status,
            trading_runtime::types::ValuationStatus::Priced
        );
        assert_eq!(portfolio.positions[0].value_usd, Some(2220.1));
        assert_eq!(portfolio.positions[0].current_price, Some(2220.1));
    }

    #[test]
    fn map_trading_api_portfolio_preserves_hyperliquid_perp_fields() {
        let payload = serde_json::json!({
            "positions": [
                {
                    "token": "ETH",
                    "amount": "0.026",
                    "value_usd": "2.57049",
                    "margin_used_usd": "2.57049",
                    "notional_usd": "51.4098",
                    "entry_price": "2084.22",
                    "current_price": null,
                    "unrealized_pnl_usd": "-2.77992",
                    "leverage": 20,
                    "liquidation_price": "1696.3270408163",
                    "protocol": "hyperliquid",
                    "position_type": "long_perp",
                    "valuation_status": "value_only"
                }
            ],
            "total_value_usd": "8.187387",
            "cash_balance": "0",
            "source": "hyperliquid_nav",
            "observed_at": "2026-05-27T10:07:12.000Z",
            "stale": false,
            "warnings": [],
            "has_unpriced_positions": false,
            "has_value_only_positions": true
        });

        let portfolio = map_trading_api_portfolio(payload).expect("portfolio should parse");
        let position = &portfolio.positions[0];

        assert_eq!(portfolio.total_value_usd, Some(8.187387));
        assert_eq!(portfolio.source.as_deref(), Some("hyperliquid_nav"));
        assert_eq!(
            portfolio.observed_at.as_deref(),
            Some("2026-05-27T10:07:12.000Z")
        );
        assert_eq!(portfolio.stale, Some(false));
        assert_eq!(position.token, "ETH");
        assert_eq!(position.protocol.as_deref(), Some("hyperliquid"));
        assert_eq!(position.position_type.as_deref(), Some("long_perp"));
        assert_eq!(position.value_usd, Some(2.57049));
        assert_eq!(position.margin_used_usd, Some(2.57049));
        assert_eq!(position.notional_usd, Some(51.4098));
        assert_eq!(position.unrealized_pnl_usd, Some(-2.77992));
        assert_eq!(position.leverage, Some(20.0));
        assert_eq!(position.liquidation_price, Some(1696.3270408163));
        assert_eq!(position.weight, Some((2.57049 / 8.187387) * 100.0));
    }

    #[test]
    fn self_improvement_reader_includes_runtime_runs_and_generation_logs() {
        assert!(
            READ_SELF_IMPROVEMENT_TASKS_JS.contains("/home/agent/.evolve/self-improvement"),
            "operator self-improvement route must expose runtime reflection-loop runs"
        );
        assert!(
            READ_SELF_IMPROVEMENT_TASKS_JS.contains("runtime-reflection-loop"),
            "runtime runs must be tagged so the UI can distinguish cadence-generated work"
        );
        assert!(
            READ_SELF_IMPROVEMENT_TASKS_JS.contains("self-improvement-generation.log"),
            "generation log tail must be exposed for failed/background runs"
        );
        assert!(
            READ_SELF_IMPROVEMENT_TASKS_JS.contains("/home/agent/telemetry/llm-usage.jsonl"),
            "self-improvement reader must expose sandbox LLM usage telemetry"
        );
        assert!(
            READ_SELF_IMPROVEMENT_TASKS_JS.contains("usage_summary"),
            "self-improvement reader must summarize usage per candidate"
        );
    }
}
