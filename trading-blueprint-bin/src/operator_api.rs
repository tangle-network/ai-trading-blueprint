use axum::extract::{Path, Query};
use axum::http::StatusCode;
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use sandbox_runtime::session_auth::SessionAuth;
use serde::{Deserialize, Serialize};

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
    pub sandbox_id: String,
    pub call_id: u64,
    pub service_id: u64,
}

impl BotSummary {
    fn from_record(b: TradingBotRecord) -> Self {
        let secrets_configured = sandbox_runtime::runtime::get_sandbox_by_id(&b.sandbox_id)
            .map(|s| s.has_user_secrets())
            .unwrap_or(false);
        Self {
            id: b.id,
            operator_address: b.operator_address,
            vault_address: b.vault_address,
            strategy_type: b.strategy_type,
            chain_id: b.chain_id,
            trading_active: b.trading_active,
            paper_trade: b.paper_trade,
            created_at: b.created_at,
            secrets_configured,
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
    pub trading_api_token: String,
    pub sandbox_id: String,
    pub workflow_id: Option<u64>,
    pub secrets_configured: bool,
    pub wind_down_started_at: Option<u64>,
}

impl BotDetailResponse {
    fn from_record(b: TradingBotRecord) -> Self {
        let secrets_configured = sandbox_runtime::runtime::get_sandbox_by_id(&b.sandbox_id)
            .map(|s| s.has_user_secrets())
            .unwrap_or(false);
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
            workflow_id: b.workflow_id,
            secrets_configured,
            wind_down_started_at: b.wind_down_started_at,
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
            phase: serde_json::to_value(&p.phase)
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

// ── Secrets types ────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ConfigureSecretsRequest {
    env_json: serde_json::Map<String, serde_json::Value>,
}

#[derive(Serialize)]
struct SecretsResponse {
    status: String,
    sandbox_id: Option<String>,
    workflow_id: Option<u64>,
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
    workflow_id: u64,
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

// ── Metrics / trades response types ─────────────────────────────────────

#[derive(Serialize)]
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
}

#[derive(Serialize)]
struct PortfolioPosition {
    token: String,
    symbol: String,
    amount: f64,
    value_usd: f64,
    entry_price: f64,
    current_price: f64,
    pnl_percent: f64,
    weight: f64,
}

#[derive(Serialize)]
struct PortfolioStateResponse {
    total_value_usd: f64,
    cash_balance: f64,
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

// ── Session auth types ──────────────────────────────────────────────────

#[derive(Deserialize)]
struct SessionRequest {
    nonce: String,
    signature: String,
}

// ── Router ───────────────────────────────────────────────────────────────

pub fn build_operator_router() -> Router {
    Router::new()
        // Session auth (delegates to sandbox-runtime's session_auth)
        .route("/api/auth/challenge", post(create_challenge))
        .route("/api/auth/session", post(create_session))
        // Bot management
        .route("/api/bots", get(list_bots))
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
        .route("/api/bots/{bot_id}/metrics/history", get(get_bot_metrics_history))
        .route("/api/bots/{bot_id}/trades", get(get_bot_trades))
        .route("/api/bots/{bot_id}/portfolio/state", get(get_bot_portfolio))
        .route("/api/bots/{bot_id}/activation-progress", get(get_activation_progress))
        // Provision progress
        .route("/api/provisions", get(list_provisions))
        .route("/api/provisions/{call_id}", get(get_provision))
        // Pricing (RFQ) endpoints — operators serve these for service creation + job pricing
        .route("/pricing/quote", post(pricing_quote))
        .route("/pricing/job-quote", post(pricing_job_quote))
        // Debug endpoints (no auth — test mode only)
        .route("/api/debug/sandboxes", get(debug_sandboxes))
        .route("/api/debug/workflows", get(debug_workflows))
        .route("/api/debug/run-now/{bot_id}", post(debug_run_now))
        .layer(sandbox_runtime::operator_api::build_cors_layer())
}

// ── Auth handlers ────────────────────────────────────────────────────────

async fn create_challenge() -> (StatusCode, Json<serde_json::Value>) {
    let challenge = sandbox_runtime::session_auth::create_challenge();
    (StatusCode::OK, Json(serde_json::to_value(challenge).unwrap()))
}

async fn create_session(
    Json(req): Json<SessionRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), (StatusCode, String)> {
    let token = sandbox_runtime::session_auth::exchange_signature_for_token(&req.nonce, &req.signature)
        .map_err(|e| (StatusCode::UNAUTHORIZED, e.to_string()))?;
    Ok((StatusCode::OK, Json(serde_json::to_value(token).unwrap())))
}

// ── Bot handlers ─────────────────────────────────────────────────────────

async fn list_bots(
    Query(query): Query<BotListQuery>,
) -> Result<Json<BotListResponse>, (StatusCode, String)> {
    let limit = query.limit.unwrap_or(50).min(200);
    let offset = query.offset.unwrap_or(0);

    // Exact match by on-chain call_id + service_id (most reliable lookup)
    if let (Some(call_id), Some(service_id)) = (query.call_id, query.service_id) {
        let bot = state::find_bot_by_call_id(service_id, call_id)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
        let bots: Vec<BotSummary> = bot.into_iter().map(BotSummary::from_record).collect();
        let total = bots.len();
        return Ok(Json(BotListResponse { bots, total, limit, offset }));
    }

    let result = if let Some(ref operator) = query.operator {
        state::bots_by_operator(operator, limit, offset)
    } else if let Some(ref strategy) = query.strategy {
        state::bots_by_strategy(strategy, limit, offset)
    } else {
        state::list_bots(limit, offset)
    };

    let paginated = result.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let mut bots: Vec<BotSummary> = paginated.bots.into_iter().map(BotSummary::from_record).collect();

    // Optional status filter (active/inactive)
    if let Some(ref status) = query.status {
        let active = status == "active";
        bots.retain(|b| b.trading_active == active);
    }

    Ok(Json(BotListResponse {
        total: paginated.total,
        bots,
        limit,
        offset,
    }))
}

async fn get_bot(
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
) -> Result<Json<SecretsResponse>, (StatusCode, String)> {

    let bot = state::get_bot(&bot_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("Bot {bot_id} not found")))?;

    // Verify caller is the bot's submitter
    if !bot.submitter_address.is_empty()
        && caller.to_lowercase() != bot.submitter_address.to_lowercase()
    {
        return Err((
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
            ("ANTHROPIC_API_KEY", "anthropic", "claude-sonnet-4-20250514", "ANTHROPIC_API_KEY"),
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
            return Err((
                StatusCode::BAD_REQUEST,
                "No API keys provided and operator has no pre-configured AI keys. \
                 Set ANTHROPIC_API_KEY or ZAI_API_KEY in the operator environment."
                    .to_string(),
            ));
        }
        env
    } else {
        body.env_json
    };

    let result = trading_blueprint_lib::jobs::activate_bot_with_secrets(&bot_id, env_json, None)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(SecretsResponse {
        status: "active".to_string(),
        sandbox_id: Some(result.sandbox_id),
        workflow_id: Some(result.workflow_id),
    }))
}

async fn wipe_secrets(
    SessionAuth(caller): SessionAuth,
    Path(bot_id): Path<String>,
) -> Result<Json<SecretsResponse>, (StatusCode, String)> {

    let bot = state::get_bot(&bot_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("Bot {bot_id} not found")))?;

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
) -> Result<Json<BotControlResponse>, (StatusCode, String)> {
    let bot = state::get_bot(&bot_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("Bot {bot_id} not found")))?;

    verify_submitter(&bot, &caller)?;

    trading_blueprint_lib::jobs::start_core(&bot.sandbox_id, false)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(BotControlResponse {
        status: "started".to_string(),
        sandbox_id: bot.sandbox_id,
    }))
}

async fn stop_bot(
    SessionAuth(caller): SessionAuth,
    Path(bot_id): Path<String>,
) -> Result<Json<BotControlResponse>, (StatusCode, String)> {
    let bot = state::get_bot(&bot_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("Bot {bot_id} not found")))?;

    verify_submitter(&bot, &caller)?;

    trading_blueprint_lib::jobs::stop_core(&bot.sandbox_id, false)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(BotControlResponse {
        status: "stopped".to_string(),
        sandbox_id: bot.sandbox_id,
    }))
}

async fn run_now(
    SessionAuth(caller): SessionAuth,
    Path(bot_id): Path<String>,
) -> Result<Json<RunNowResponse>, (StatusCode, String)> {
    let bot = state::get_bot(&bot_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("Bot {bot_id} not found")))?;

    verify_submitter(&bot, &caller)?;

    if !bot.trading_active {
        return Err((StatusCode::CONFLICT, "Bot is not active".to_string()));
    }

    let workflow_id = bot
        .workflow_id
        .ok_or_else(|| (StatusCode::CONFLICT, "Bot has no workflow configured".to_string()))?;

    let wf_key = ai_agent_sandbox_blueprint_lib::workflows::workflow_key(workflow_id);
    let entry = ai_agent_sandbox_blueprint_lib::workflows::workflows()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .get(&wf_key)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("Workflow {workflow_id} not found")))?;

    let execution = ai_agent_sandbox_blueprint_lib::workflows::run_workflow(&entry)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    // Update workflow timestamps
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
        workflow_id,
        response: execution.response,
    }))
}

async fn update_config(
    SessionAuth(caller): SessionAuth,
    Path(bot_id): Path<String>,
    Json(body): Json<UpdateConfigRequest>,
) -> Result<Json<ConfigResponse>, (StatusCode, String)> {
    let bot = state::get_bot(&bot_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("Bot {bot_id} not found")))?;

    verify_submitter(&bot, &caller)?;

    trading_blueprint_lib::jobs::configure_core(
        &bot.sandbox_id,
        body.strategy_config_json.as_deref().unwrap_or(""),
        body.risk_params_json.as_deref().unwrap_or(""),
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

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

/// Synthesize metrics history from per-bot trade data.
/// Returns a time series of account value snapshots.
fn synthesize_metrics(bot: &TradingBotRecord, trades: &[serde_json::Value]) -> Vec<MetricsSnapshotResponse> {
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

        // Emit a snapshot every ~5 trades + last trade
        if (i + 1) % 5 == 0 || i == sorted.len() - 1 {
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

            let dd = if hwm > 0.0 { ((hwm - val) / hwm) * 100.0 } else { 0.0 };

            snapshots.push(MetricsSnapshotResponse {
                timestamp: if ts.is_empty() { chrono::Utc::now().to_rfc3339() } else { ts },
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
    }

    snapshots
}

// ── Metrics / trades handlers ───────────────────────────────────────────

async fn get_bot_metrics(
    Path(bot_id): Path<String>,
) -> Result<Json<BotMetricsResponse>, (StatusCode, String)> {
    let bot = resolve_bot(&bot_id)?;
    let trades = state::load_bot_trades(&bot.id);

    let total_pnl: f64 = trades
        .iter()
        .filter_map(|t| t.get("pnl").and_then(|v| v.as_f64()))
        .sum();

    Ok(Json(BotMetricsResponse {
        portfolio_value_usd: 10_000.0 + total_pnl,
        total_pnl,
        trade_count: trades.len() as u32,
    }))
}

async fn get_bot_metrics_history(
    Path(bot_id): Path<String>,
    Query(_query): Query<MetricsHistoryQuery>,
) -> Result<Json<Vec<MetricsSnapshotResponse>>, (StatusCode, String)> {
    let bot = resolve_bot(&bot_id)?;
    let trades = state::load_bot_trades(&bot.id);
    let snapshots = synthesize_metrics(&bot, &trades);
    Ok(Json(snapshots))
}

async fn get_bot_trades(
    Path(bot_id): Path<String>,
) -> Result<Json<Vec<TradeEntryResponse>>, (StatusCode, String)> {
    let bot = resolve_bot(&bot_id)?;
    let trades = state::load_bot_trades(&bot.id);
    let protocol = if bot.strategy_type == "prediction" {
        "polymarket"
    } else {
        &bot.strategy_type
    };

    let entries: Vec<TradeEntryResponse> = trades
        .iter()
        .map(|t| {
            let mid = t.get("market_id")
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

            let tid = t.get("id")
                .map(|v| match v {
                    serde_json::Value::String(s) => s.clone(),
                    serde_json::Value::Number(n) => n.to_string(),
                    _ => v.to_string(),
                })
                .unwrap_or_else(|| mid_str.clone());

            let question = t.get("question")
                .or_else(|| t.get("symbol"))
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown");

            let side = t.get("side")
                .or_else(|| t.get("action"))
                .and_then(|v| v.as_str())
                .unwrap_or("buy");

            let action = if side == "YES" || side == "long" || side == "buy" || side.contains("buy") {
                "buy"
            } else {
                "sell"
            };

            let amount = t.get("amount_usd")
                .or_else(|| t.get("size"))
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);

            let entry_price = t.get("entry_price").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let current_price = t.get("current_price").and_then(|v| v.as_f64()).unwrap_or(entry_price);
            let pnl = t.get("pnl").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let status = t.get("status").and_then(|v| v.as_str()).unwrap_or("unknown");

            let ts = t.get("created_at")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            TradeEntryResponse {
                id: tid.clone(),
                bot_id: bot.id.clone(),
                timestamp: if ts.is_empty() { chrono::Utc::now().to_rfc3339() } else { ts },
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
            }
        })
        .collect();

    Ok(Json(entries))
}

async fn get_bot_portfolio(
    Path(bot_id): Path<String>,
) -> Result<Json<PortfolioStateResponse>, (StatusCode, String)> {
    let bot = resolve_bot(&bot_id)?;
    let trades = state::load_bot_trades(&bot.id);

    let open_trades: Vec<&serde_json::Value> = trades
        .iter()
        .filter(|t| t.get("status").and_then(|v| v.as_str()) == Some("open"))
        .collect();

    let total_pnl: f64 = trades
        .iter()
        .filter_map(|t| t.get("pnl").and_then(|v| v.as_f64()))
        .sum();
    let total_value = 10_000.0 + total_pnl;

    let position_value: f64 = open_trades
        .iter()
        .map(|t| {
            t.get("amount_usd")
                .or_else(|| t.get("size"))
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0)
        })
        .sum();

    let positions: Vec<PortfolioPosition> = open_trades
        .iter()
        .map(|t| {
            let mid = t.get("market_id")
                .or_else(|| t.get("symbol"))
                .map(|v| v.to_string())
                .unwrap_or_default();
            let question = t.get("question")
                .or_else(|| t.get("symbol"))
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown");
            let amount = t.get("amount_usd")
                .or_else(|| t.get("size"))
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            let entry_price = t.get("entry_price").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let current_price = t.get("current_price").and_then(|v| v.as_f64()).unwrap_or(entry_price);
            let pnl_pct = if entry_price > 0.0 {
                ((current_price - entry_price) / entry_price) * 100.0
            } else {
                0.0
            };

            PortfolioPosition {
                token: mid.chars().take(10).collect(),
                symbol: question.chars().take(30).collect(),
                amount,
                value_usd: amount * current_price.max(entry_price),
                entry_price,
                current_price,
                pnl_percent: pnl_pct,
                weight: if total_value > 0.0 { (amount / total_value) * 100.0 } else { 0.0 },
            }
        })
        .collect();

    Ok(Json(PortfolioStateResponse {
        total_value_usd: total_value,
        cash_balance: total_value - position_value,
        positions,
    }))
}

// ── Activation progress handler ──────────────────────────────────────────

async fn get_activation_progress(
    Path(bot_id): Path<String>,
) -> Result<Json<ActivationProgressResponse>, (StatusCode, String)> {
    let progress = state::get_activation(&bot_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("No activation progress for bot {bot_id}")))?;

    Ok(Json(ActivationProgressResponse::from(progress)))
}

// ── Debug handlers ───────────────────────────────────────────────────────

async fn debug_sandboxes() -> Json<serde_json::Value> {
    match sandbox_runtime::runtime::sandboxes() {
        Ok(store) => match store.values() {
            Ok(records) => {
                let list: Vec<serde_json::Value> = records
                    .iter()
                    .map(|r| serde_json::json!({
                        "id": r.id,
                        "container_id": &r.container_id[..r.container_id.len().min(12)],
                        "sidecar_url": r.sidecar_url,
                        "token_len": r.token.len(),
                        "state": format!("{:?}", r.state),
                    }))
                    .collect();
                Json(serde_json::json!({ "count": list.len(), "sandboxes": list }))
            }
            Err(e) => Json(serde_json::json!({ "error": format!("values() failed: {e}") })),
        },
        Err(e) => Json(serde_json::json!({ "error": format!("sandboxes() failed: {e}") })),
    }
}

async fn debug_workflows() -> Json<serde_json::Value> {
    match ai_agent_sandbox_blueprint_lib::workflows::workflows() {
        Ok(store) => match store.values() {
            Ok(entries) => {
                let list: Vec<serde_json::Value> = entries
                    .iter()
                    .map(|e| {
                        let spec: Result<serde_json::Value, _> = serde_json::from_str(&e.workflow_json);
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
    Path(bot_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let bot = state::get_bot(&bot_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("Bot {bot_id} not found")))?;

    let workflow_id = bot
        .workflow_id
        .ok_or_else(|| (StatusCode::CONFLICT, "Bot has no workflow".to_string()))?;

    let wf_key = ai_agent_sandbox_blueprint_lib::workflows::workflow_key(workflow_id);
    let entry = ai_agent_sandbox_blueprint_lib::workflows::workflows()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .get(&wf_key)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("Workflow {workflow_id} not found")))?;

    let execution = ai_agent_sandbox_blueprint_lib::workflows::run_workflow(&entry)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

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
        "workflow_id": workflow_id,
        "response": execution.response,
    })))
}

// ── Pricing handlers (RFQ for service creation + per-job quotes) ─────────

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
}

/// Returns a zero-cost signed quote for local development.
/// In production, this would compute resource pricing and sign with the operator key.
async fn pricing_quote(
    Json(body): Json<PricingQuoteRequest>,
) -> Json<serde_json::Value> {
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

/// Returns a zero-cost per-job quote for local development.
async fn pricing_job_quote(
    Json(body): Json<JobQuoteRequest>,
) -> Json<serde_json::Value> {
    let service_id = body.service_id.as_deref().unwrap_or("0");
    let job_index = body.job_index.unwrap_or(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let expiry = now + 3600;
    let timestamp = body.challenge_timestamp.as_deref().unwrap_or("0");

    let operator_address = std::env::var("OPERATOR_ADDRESS").unwrap_or_default();

    Json(serde_json::json!({
        "operator": operator_address,
        "total_cost": "0",
        "signature": "0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
        "cost_rate": 0.0,
        "details": {
            "service_id": service_id,
            "job_index": job_index,
            "price": "0",
            "timestamp": timestamp,
            "expiry": expiry.to_string(),
        },
    }))
}

// ── Provision handlers ───────────────────────────────────────────────────

async fn list_provisions() -> Result<Json<ProvisionListResponse>, (StatusCode, String)> {
    let all = sandbox_runtime::provision_progress::list_all_provisions()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(ProvisionListResponse {
        provisions: all.into_iter().map(ProvisionProgressResponse::from).collect(),
    }))
}

async fn get_provision(
    Path(call_id): Path<u64>,
) -> Result<Json<ProvisionProgressResponse>, (StatusCode, String)> {
    let progress = sandbox_runtime::provision_progress::get_provision(call_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("No provision for call_id {call_id}")))?;

    Ok(Json(ProvisionProgressResponse::from(progress)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use http_body_util::BodyExt;
    use hyper::Request;
    use tower::ServiceExt;

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
        let tmp = tempfile::tempdir().unwrap();
        unsafe { std::env::set_var("BLUEPRINT_STATE_DIR", tmp.path()) };

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
        };
        store
            .insert(state::bot_key("wd-bot"), bot)
            .unwrap();

        let app = build_operator_router();
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/bots/wd-bot")
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
}
