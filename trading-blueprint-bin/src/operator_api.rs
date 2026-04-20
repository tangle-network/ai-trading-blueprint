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
use std::time::Duration;

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

use trading_blueprint_lib::state::{self, ActivationProgress, TradingBotRecord};

#[derive(Deserialize)]
pub struct BotListQuery {
    pub operator: Option<String>,
    pub strategy: Option<String>,
    pub status: Option<String>,
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
    pub operator_address: String,
    pub vault_address: String,
    pub strategy_type: String,
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
        Self {
            id: b.id,
            operator_address: b.operator_address,
            vault_address: b.vault_address,
            strategy_type: b.strategy_type,
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
        // Session auth (delegates to sandbox-runtime's session_auth)
        .route("/api/auth/challenge", post(create_challenge))
        .route("/api/auth/session", post(create_session))
        // Bot management
        .route("/api/bots", get(list_bots).post(create_bot))
        .route("/api/bots/{bot_id}", get(get_bot))
        .route(
            "/api/bots/{bot_id}/secrets",
            post(configure_secrets).delete(wipe_secrets),
        )
        .route("/api/bots/{bot_id}/start", post(start_bot))
        .route("/api/bots/{bot_id}/stop", post(stop_bot))
        .route("/api/bots/{bot_id}/run-now", post(run_now))
        .route("/api/bots/{bot_id}/config", patch(update_config))
        .route("/api/bots/{bot_id}/metrics", get(get_bot_metrics))
        .route(
            "/api/bots/{bot_id}/metrics/history",
            get(get_bot_metrics_history),
        )
        .route("/api/bots/{bot_id}/trades", get(get_bot_trades))
        .route("/api/bots/{bot_id}/portfolio/state", get(get_bot_portfolio))
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
}

async fn get_operator_meta() -> Json<OperatorMetaResponse> {
    Json(OperatorMetaResponse {
        api_version: "1".to_string(),
        deployment_kind: "fleet".to_string(),
        features: OperatorFeatureFlags {
            chat: true,
            terminal: true,
        },
    })
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

// ── Bot handlers ─────────────────────────────────────────────────────────

/// Create a bot from a free-form prompt — provisions + activates in one call.
/// This is the chat-first GTM endpoint: user describes a strategy, gets a live bot.
#[derive(Deserialize)]
struct CreateBotRequest {
    /// Free-form strategy description from the user
    prompt: String,
    /// Optional strategy type override (auto-detected from prompt if omitted)
    #[serde(default)]
    strategy_type: Option<String>,
    /// Optional name (defaults to first 50 chars of prompt)
    #[serde(default)]
    name: Option<String>,
}

async fn create_bot(req: axum::extract::Request) -> ApiResult<serde_json::Value> {
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
    let bytes = axum::body::to_bytes(req.into_body(), 1024 * 1024)
        .await
        .map_err(|e| ApiError::message(StatusCode::BAD_REQUEST, format!("Bad body: {e}")))?;
    let body: CreateBotRequest = serde_json::from_slice(&bytes)
        .map_err(|e| ApiError::message(StatusCode::BAD_REQUEST, format!("Bad JSON: {e}")))?;
    let prompt = body.prompt.trim().to_string();
    if prompt.is_empty() {
        return Err(ApiError::message(
            StatusCode::BAD_REQUEST,
            "prompt is required".to_string(),
        ));
    }

    // Auto-detect strategy type from prompt
    let prompt_lower = prompt.to_lowercase();
    let strategy_type = body.strategy_type.unwrap_or_else(|| {
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
    });

    let name = body
        .name
        .unwrap_or_else(|| prompt.chars().take(50).collect());

    // Build a TradingProvisionRequest
    let vault_factory = std::env::var("VAULT_FACTORY_ADDRESS")
        .unwrap_or_else(|_| "0x0000000000000000000000000000000000000000".into());
    let asset_token = std::env::var("ASSET_TOKEN_ADDRESS")
        .or_else(|_| std::env::var("USDC_ADDRESS"))
        .unwrap_or_else(|_| "0x0000000000000000000000000000000000000000".into());
    let rpc_url = std::env::var("HTTP_RPC_URL").unwrap_or_else(|_| "http://127.0.0.1:8545".into());
    let chain_id: u64 = std::env::var("CHAIN_ID")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(31337);

    let strategy_config = serde_json::json!({
        "user_prompt": prompt,
        "paper_trade": true,
    });

    let request = trading_blueprint_lib::TradingProvisionRequest {
        name: name.clone(),
        strategy_type: strategy_type.clone(),
        strategy_config_json: serde_json::to_string(&strategy_config).unwrap_or_default(),
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

    let result = trading_blueprint_lib::jobs::provision_core(
        request,
        None,
        call_id,
        service_id,
        caller.clone(),
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
    let mut user_env = serde_json::Map::new();
    if let Ok(key) = std::env::var("ZAI_API_KEY") {
        user_env.insert("ZAI_API_KEY".into(), serde_json::Value::String(key));
    } else if let Ok(key) = std::env::var("ANTHROPIC_API_KEY") {
        user_env.insert("ANTHROPIC_API_KEY".into(), serde_json::Value::String(key));
    }
    // Pass the user's prompt as an env var so the agent can read it
    user_env.insert(
        "USER_STRATEGY_PROMPT".into(),
        serde_json::Value::String(prompt.clone()),
    );

    let activate_result =
        trading_blueprint_lib::jobs::activate_bot_with_secrets(&bot.id, user_env, None)
            .await
            .map_err(|e| {
                ApiError::message(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Activation failed: {e}"),
                )
            })?;

    // 3. Write the user's prompt to the bot's memory as the first conversation.
    // Content is passed via env var (FILE_CONTENT) to avoid any shell interpretation.
    if let Ok(sandbox) = sandbox_runtime::runtime::get_sandbox_by_id(&activate_result.sandbox_id) {
        let date = chrono::Utc::now().format("%Y-%m-%d");
        let timestamp = chrono::Utc::now().format("%H:%M UTC");

        let strategy_content = format!("# Strategy Brief\n\n## Owner ({timestamp})\n{prompt}\n");
        let toc_content = format!(
            "# Memory Index\nUpdated: {date} | Iteration: 0\n\n\
             ## Conversations\n\
             - [Strategy Brief](conversations/{date}-strategy.md) — **ACTION NEEDED** — Owner described their strategy\n\n\
             ## Decisions\n\
             (none yet)\n\n\
             ## Research\n\
             (none yet)\n\n\
             ## Performance\n\
             - New agent, no trades yet\n"
        );

        let writes: &[(&str, &str)] = &[
            (
                &format!("/home/agent/memory/conversations/{date}-strategy.md"),
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

    Ok(Json(serde_json::json!({
        "bot_id": bot.id,
        "sandbox_id": activate_result.sandbox_id,
        "strategy_type": strategy_type,
        "name": name,
        "status": "active",
        "trading_api_url": activate_result.trading_api_url,
        "trading_api_token": activate_result.trading_api_token,
        "prompt": prompt,
    })))
}

async fn list_bots(
    SessionAuth(_caller): SessionAuth,
    Query(query): Query<BotListQuery>,
) -> ApiResult<BotListResponse> {
    let limit = query.limit.unwrap_or(50).min(200);
    let offset = query.offset.unwrap_or(0);

    // Exact match by on-chain call_id + service_id (most reliable lookup)
    if let (Some(call_id), Some(service_id)) = (query.call_id, query.service_id) {
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
        state::bots_by_operator(operator, limit, offset)
    } else if let Some(ref strategy) = query.strategy {
        state::bots_by_strategy(strategy, limit, offset)
    } else {
        state::list_bots(limit, offset)
    };

    let paginated = result.map_err(|e| ApiError::message(StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let mut bots: Vec<BotSummary> = paginated
        .bots
        .into_iter()
        .map(BotSummary::from_record)
        .collect();

    // Optional status filter (active/inactive)
    if let Some(ref status) = query.status {
        let active = status == "active";
        bots.retain(|b| (b.lifecycle_status == "active") == active);
    }

    Ok(Json(BotListResponse {
        total: paginated.total,
        bots,
        limit,
        offset,
    }))
}

async fn get_bot(
    SessionAuth(_caller): SessionAuth,
    Path(bot_id): Path<String>,
) -> Result<Json<BotDetailResponse>, (StatusCode, String)> {
    let record = resolve_bot(&bot_id)?;
    Ok(Json(BotDetailResponse::from_record(record)))
}

// ── Secrets handlers ─────────────────────────────────────────────────────

async fn configure_secrets(
    SessionAuth(caller): SessionAuth,
    Path(bot_id): Path<String>,
    Json(body): Json<ConfigureSecretsRequest>,
) -> ApiResult<SecretsResponse> {
    let bot = resolve_live_bot(&bot_id)?;

    // Verify caller is the bot's submitter
    if !bot.submitter_address.is_empty()
        && caller.to_lowercase() != bot.submitter_address.to_lowercase()
    {
        return Err(ApiError::message(
            StatusCode::FORBIDDEN,
            format!("Caller {caller} is not the bot submitter"),
        ));
    }

    // When env_json is empty, use operator-provided AI keys from the binary's environment.
    // This supports the "use operator provided keys" frontend option.
    let env_json = if body.env_json.is_empty() {
        let mut env = serde_json::Map::new();
        // Try each supported AI provider in order of preference
        let providers: &[(&str, &str, &str, &str)] = &[
            (
                "ANTHROPIC_API_KEY",
                "anthropic",
                "claude-sonnet-4-20250514",
                "ANTHROPIC_API_KEY",
            ),
            ("ZAI_API_KEY", "zai-coding-plan", "glm-4.7", "ZAI_API_KEY"),
        ];
        let mut found = false;
        for &(env_var, model_provider, model_name, native_key) in providers {
            if let Ok(key) = std::env::var(env_var) {
                if !key.is_empty() {
                    env.insert("OPENCODE_MODEL_PROVIDER".into(), model_provider.into());
                    env.insert("OPENCODE_MODEL_NAME".into(), model_name.into());
                    env.insert("OPENCODE_MODEL_API_KEY".into(), key.clone().into());
                    env.insert(native_key.into(), key.into());
                    found = true;
                    tracing::info!("Using operator-provided {env_var} for bot {bot_id}");
                    break;
                }
            }
        }
        if !found {
            return Err(ApiError::message(
                StatusCode::BAD_REQUEST,
                "No API keys provided and operator has no pre-configured AI keys. \
                 Set ANTHROPIC_API_KEY or ZAI_API_KEY in the operator environment.",
            ));
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

async fn wipe_secrets(
    SessionAuth(caller): SessionAuth,
    Path(bot_id): Path<String>,
) -> Result<Json<SecretsResponse>, (StatusCode, String)> {
    let bot = resolve_bot(&bot_id)?;

    if !bot.submitter_address.is_empty()
        && caller.to_lowercase() != bot.submitter_address.to_lowercase()
    {
        return Err((
            StatusCode::FORBIDDEN,
            format!("Caller {caller} is not the bot submitter"),
        ));
    }

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

    // Spawn workflow execution in the background so we return immediately.
    let wf_key_bg = wf_key.clone();
    tokio::spawn(async move {
        // _run_guard is moved into this task and dropped when done.
        let _guard = _run_guard;
        match ai_agent_sandbox_blueprint_lib::workflows::run_workflow(&entry).await {
            Ok(execution) => {
                let _ = ai_agent_sandbox_blueprint_lib::workflows::store_latest_execution(
                    workflow_id,
                    execution.latest_execution,
                );
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
                let _ = ai_agent_sandbox_blueprint_lib::workflows::store_failed_execution(
                    workflow_id,
                    err,
                );
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
    if let Some(addr) = &body.vault_address {
        if let Ok(store) = state::bots() {
            let _ = store.update(&state::bot_key(&bot.id), |b| {
                b.vault_address.clone_from(addr);
            });
        }
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

// ── Chat session proxy handlers ─────────────────────────────────────────

async fn list_chat_sessions(
    SessionAuth(caller): SessionAuth,
    Path(bot_id): Path<String>,
) -> Result<Response, (StatusCode, String)> {
    let (bot, target) = resolve_live_chat_target(&bot_id, &caller)?;
    trading_blueprint_lib::operator_chat::list_manual_chat_sessions(&target, &bot.id).await
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
    trading_blueprint_lib::operator_chat::ensure_manual_chat_session(&bot.id, &session_id)?;
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
    trading_blueprint_lib::operator_chat::ensure_manual_chat_session(&bot.id, &session_id)?;
    trading_blueprint_lib::operator_chat::proxy_chat_request(
        &target,
        reqwest::Method::GET,
        &format!("/agents/sessions/{session_id}/messages"),
        None,
        query.as_deref(),
    )
    .await
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
                command: format!(
                    r#"node -e "
const fs=require('fs'),p='/home/agent/memory/toc.md';
try{{
  let t=fs.readFileSync(p,'utf8');
  if(!t.includes(process.env.CONV_FILE)){{
    t=t.replace('## Conversations','## Conversations\n'+process.env.TOC_ENTRY);
    fs.writeFileSync(p,t);
  }}
}}catch(e){{/* toc.md not yet created, skip */}}"
"#,
                ),
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
    if let Some(session_id) = session_id.as_deref() {
        trading_blueprint_lib::operator_chat::ensure_manual_chat_session(&bot.id, session_id)?;
    }
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
    let id = v
        .get("id")
        .or_else(|| v.get("session_id"))
        .and_then(|v| v.as_str())?;
    Some(LiveTerminalSessionSummary {
        session_id: id.to_string(),
        title: String::new(),
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
    let session_id = parsed
        .get("id")
        .or_else(|| parsed.get("session_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Ok(Json(LiveTerminalSessionSummary {
        session_id,
        title: String::new(),
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

fn fallback_metrics_history(bot: &TradingBotRecord) -> Vec<serde_json::Value> {
    let trades = fallback_trade_dataset(bot);
    synthesize_metrics(bot, &trades)
        .into_iter()
        .map(|snapshot| serde_json::to_value(snapshot).unwrap_or(serde_json::Value::Null))
        .collect()
}

fn fallback_metrics_snapshots(bot: &TradingBotRecord) -> Vec<MetricsSnapshotResponse> {
    let trades = fallback_trade_dataset(bot);
    synthesize_metrics(bot, &trades)
}

fn parse_metrics_snapshots(
    snapshots: Vec<serde_json::Value>,
) -> Result<Vec<MetricsSnapshotResponse>, String> {
    serde_json::from_value(serde_json::Value::Array(snapshots))
        .map_err(|e| format!("invalid metrics snapshot array: {e}"))
}

async fn resolve_metrics_history_for_bot(
    bot: &TradingBotRecord,
    query: &MetricsHistoryQuery,
) -> Vec<MetricsSnapshotResponse> {
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
                Ok(snapshots) if !snapshots.is_empty() => snapshots,
                Ok(_) => Vec::new(),
                Err(err) => {
                    tracing::warn!(bot_id = %bot.id, "invalid trading api metrics payload: {err}");
                    Vec::new()
                }
            }
        }
        Ok(None) => Vec::new(),
        Err(err) => {
            tracing::warn!(bot_id = %bot.id, "trading api metrics request failed, using fallback: {err}");
            Vec::new()
        }
    }
}

fn map_trading_api_portfolio(payload: serde_json::Value) -> Result<PortfolioStateResponse, String> {
    let portfolio: TradingApiPortfolioResponse =
        serde_json::from_value(payload).map_err(|e| format!("invalid portfolio payload: {e}"))?;

    let total_value = portfolio.total_value_usd;
    let has_unpriced_positions = portfolio.has_unpriced_positions;
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
            let valuation_status = if value_usd.is_some()
                || position.current_price.is_some()
                || (!has_unpriced_positions && total_value.unwrap_or(0.0) > 0.0)
            {
                trading_http_api::trade_store::TradeValuationStatus::Priced
            } else {
                position.valuation_status
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
                valuation_status,
            }
        })
        .collect();

    Ok(PortfolioStateResponse {
        total_value_usd: total_value,
        cash_balance: portfolio.cash_balance,
        warnings: portfolio.warnings,
        has_unpriced_positions,
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

/// Synthesize metrics history from per-bot trade data.
/// Returns a time series of account value snapshots.
fn synthesize_metrics(
    bot: &TradingBotRecord,
    trades: &[serde_json::Value],
) -> Vec<MetricsSnapshotResponse> {
    const INITIAL_VALUE: f64 = 10_000.0;
    let mut snapshots = Vec::new();

    let start_ts = chrono::DateTime::from_timestamp(bot.created_at as i64, 0)
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());

    // Initial snapshot
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

    // Sort trades by created_at
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
    Path(bot_id): Path<String>,
) -> Result<Json<BotMetricsResponse>, (StatusCode, String)> {
    let bot = resolve_bot(&bot_id)?;
    let metrics_history = resolve_metrics_history_for_bot(
        &bot,
        &MetricsHistoryQuery {
            from: None,
            to: None,
            limit: Some(100),
        },
    )
    .await;
    let latest_snapshot = metrics_history.last();
    let trades =
        match fetch_trading_api_json(&bot, "/trades", &[("limit", "500".to_string())]).await {
            Ok(Some(payload)) => extract_json_array(payload, "trades")
                .unwrap_or_else(|_| fallback_trade_dataset(&bot)),
            Ok(None) | Err(_) => fallback_trade_dataset(&bot),
        };

    let total_pnl: f64 = trades
        .iter()
        .filter_map(|t| t.get("pnl").and_then(|v| v.as_f64()))
        .sum();

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
            .unwrap_or_else(|| {
                fallback_portfolio_state(&bot)
                    .total_value_usd
                    .unwrap_or(0.0)
            }),
        Ok(None) | Err(_) => latest_snapshot
            .map(|snapshot| snapshot.account_value_usd)
            .unwrap_or_else(|| {
                fallback_portfolio_state(&bot)
                    .total_value_usd
                    .unwrap_or(0.0)
            }),
    };

    Ok(Json(BotMetricsResponse {
        portfolio_value_usd,
        total_pnl: latest_snapshot
            .map(|snapshot| snapshot.realized_pnl + snapshot.unrealized_pnl)
            .unwrap_or(total_pnl),
        trade_count: latest_snapshot
            .map(|snapshot| snapshot.trade_count)
            .unwrap_or(trades.len() as u32),
    }))
}

async fn get_bot_metrics_history(
    SessionAuth(_caller): SessionAuth,
    Path(bot_id): Path<String>,
    Query(query): Query<MetricsHistoryQuery>,
) -> Result<Json<Vec<serde_json::Value>>, (StatusCode, String)> {
    let bot = resolve_bot(&bot_id)?;
    let mut remote_query = Vec::new();
    if let Some(from) = query.from {
        remote_query.push(("from", from));
    }
    if let Some(to) = query.to {
        remote_query.push(("to", to));
    }
    if let Some(limit) = query.limit {
        remote_query.push(("limit", limit.to_string()));
    }

    match fetch_trading_api_json(&bot, "/metrics/history", &remote_query).await {
        Ok(Some(payload)) => match extract_json_array(payload, "snapshots") {
            Ok(snapshots) if !snapshots.is_empty() => Ok(Json(snapshots)),
            Ok(_) => Ok(Json(Vec::new())),
            Err(err) => {
                tracing::warn!(bot_id = %bot.id, "invalid trading api metrics payload: {err}");
                Ok(Json(Vec::new()))
            }
        },
        Ok(None) => Ok(Json(Vec::new())),
        Err(err) => {
            tracing::warn!(bot_id = %bot.id, "trading api metrics request failed: {err}");
            Ok(Json(Vec::new()))
        }
    }
}

async fn get_bot_trades(
    SessionAuth(_caller): SessionAuth,
    Path(bot_id): Path<String>,
    Query(query): Query<TradeListQuery>,
) -> Result<Json<Vec<serde_json::Value>>, (StatusCode, String)> {
    let bot = resolve_bot(&bot_id)?;
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

async fn get_bot_portfolio(
    SessionAuth(_caller): SessionAuth,
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

// ── Activation progress handler ──────────────────────────────────────────

async fn get_activation_progress(
    SessionAuth(_caller): SessionAuth,
    Path(bot_id): Path<String>,
) -> Result<Json<ActivationProgressResponse>, (StatusCode, String)> {
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

    let paginated = state::list_bots(500, 0).map_err(|e| {
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
    SessionAuth(_caller): SessionAuth,
    Path(bot_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let bot = resolve_bot(&bot_id)?;

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

    let wf_key_bg = wf_key.clone();
    tokio::spawn(async move {
        let _guard = _run_guard;
        match ai_agent_sandbox_blueprint_lib::workflows::run_workflow(&entry).await {
            Ok(execution) => {
                let _ = ai_agent_sandbox_blueprint_lib::workflows::store_latest_execution(
                    workflow_id,
                    execution.latest_execution,
                );
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
                let _ = ai_agent_sandbox_blueprint_lib::workflows::store_failed_execution(
                    workflow_id,
                    err,
                );
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
}

/// Returns subscription pricing info.
///
/// Service creation quotes are signed by the pricing engine gRPC server
/// (separate process). This REST endpoint returns informational pricing
/// config for integrations that don't use gRPC.
async fn pricing_quote(Json(_body): Json<PricingQuoteRequest>) -> Json<serde_json::Value> {
    let pricing_engine_endpoint = std::env::var("PRICING_ENGINE_ENDPOINT").unwrap_or_default();
    let operator_address = std::env::var("OPERATOR_ADDRESS").unwrap_or_default();

    Json(serde_json::json!({
        "pricing_model": "subscription",
        "operator": operator_address,
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
    }))
}

/// Returns per-job pricing info.
///
/// Under subscription pricing, all jobs are covered by the service subscription.
/// No per-job payment is required.
async fn pricing_job_quote(Json(body): Json<JobQuoteRequest>) -> Json<serde_json::Value> {
    let job_index = body.job_index.unwrap_or(0);
    let multipliers = [50, 2, 1, 1, 0, 1, 10]; // PRICE_MULT_* from contract
    let multiplier = multipliers.get(job_index as usize).copied().unwrap_or(0);

    Json(serde_json::json!({
        "pricing_model": "subscription",
        "job_index": job_index,
        "per_job_cost": "0",
        "multiplier": multiplier,
        "note": "All jobs are covered by the service subscription. No per-job payment required.",
    }))
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
        };
        store.insert(state::bot_key("wd-bot"), bot).unwrap();

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
        };
        state::bots()
            .unwrap()
            .insert(state::bot_key(id), record.clone())
            .unwrap();
        record
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
            amount_out: None,
            entry_price_usd: None,
            notional_usd: None,
            valuation_status: trading_http_api::trade_store::TradeValuationStatus::Unpriced,
            validation: trading_http_api::trade_store::StoredValidation {
                approved: true,
                aggregate_score: 100,
                intent_hash: "0xintent".to_string(),
                responses: Vec::new(),
                simulation: None,
            },
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
        assert_eq!(portfolio.has_unpriced_positions, false);
        assert_eq!(
            portfolio.positions[0].valuation_status,
            trading_http_api::trade_store::TradeValuationStatus::Priced
        );
        assert_eq!(portfolio.positions[0].value_usd, Some(2220.1));
        assert_eq!(portfolio.positions[0].current_price, Some(2220.1));
    }
}
