use axum::extract::{Path, Query};
use axum::http::StatusCode;
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use sandbox_runtime::session_auth::SessionAuth;
use serde::{Deserialize, Serialize};
use tower_http::cors::{Any, CorsLayer};

use trading_blueprint_lib::state::{self, ActivationProgress, TradingBotRecord};

#[derive(Deserialize)]
pub struct BotListQuery {
    pub operator: Option<String>,
    pub strategy: Option<String>,
    pub status: Option<String>,
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

// ── Session auth types ──────────────────────────────────────────────────

#[derive(Deserialize)]
struct SessionRequest {
    nonce: String,
    signature: String,
}

// ── Router ───────────────────────────────────────────────────────────────

fn cors_layer() -> CorsLayer {
    let origins = std::env::var("CORS_ALLOWED_ORIGINS").unwrap_or_default();
    if origins == "*" || origins.is_empty() {
        CorsLayer::permissive()
    } else {
        let parsed: Vec<_> = origins
            .split(',')
            .filter_map(|s| s.trim().parse().ok())
            .collect();
        CorsLayer::new()
            .allow_origin(parsed)
            .allow_methods(Any)
            .allow_headers(Any)
    }
}

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
        .route("/api/bots/{bot_id}/activation-progress", get(get_activation_progress))
        // Provision progress
        .route("/api/provisions", get(list_provisions))
        .route("/api/provisions/{call_id}", get(get_provision))
        .layer(cors_layer())
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
    let record = state::get_bot(&bot_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("Bot {bot_id} not found")))?;

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

    let result = trading_blueprint_lib::jobs::activate_bot_with_secrets(&bot_id, body.env_json, None)
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

// ── Activation progress handler ──────────────────────────────────────────

async fn get_activation_progress(
    Path(bot_id): Path<String>,
) -> Result<Json<ActivationProgressResponse>, (StatusCode, String)> {
    let progress = state::get_activation(&bot_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("No activation progress for bot {bot_id}")))?;

    Ok(Json(ActivationProgressResponse::from(progress)))
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
