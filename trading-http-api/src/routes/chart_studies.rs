use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::chart_study_store::{self, ChartOverlay, ChartOverlayKind, ChartStudy, ChartStudyQuery};
use crate::{MultiBotTradingState, TradingApiState};

const CHART_STUDY_SCHEMA_VERSION: u32 = 1;
const MAX_STUDIES_RETURNED: usize = 50;
const MAX_OVERLAYS_PER_STUDY: usize = 24;
const MAX_POINTS_PER_STUDY: usize = 5_000;
const MAX_TOKEN_LEN: usize = 128;
const MAX_TEXT_LEN: usize = 512;

pub fn router() -> Router<Arc<TradingApiState>> {
    Router::new()
        .route("/chart/studies", get(list_chart_studies))
        .route("/chart/studies", post(record_chart_study))
}

pub fn multi_bot_router() -> Router<Arc<MultiBotTradingState>> {
    Router::new()
        .route("/chart/studies", get(list_chart_studies_multi_bot))
        .route("/chart/studies", post(record_chart_study_multi_bot))
}

#[derive(Deserialize)]
pub struct ChartStudyListQuery {
    pub token: Option<String>,
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub limit: Option<usize>,
}

#[derive(Serialize)]
pub struct ChartStudyListResponse {
    pub studies: Vec<ChartStudy>,
    pub total: usize,
    pub limit: usize,
}

#[derive(Deserialize)]
pub struct RecordChartStudyRequest {
    #[serde(default)]
    pub study_id: Option<String>,
    pub token: String,
    #[serde(default)]
    pub venue: Option<String>,
    #[serde(default)]
    pub interval: Option<String>,
    pub title: String,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub valid_from_ms: Option<i64>,
    #[serde(default)]
    pub valid_to_ms: Option<i64>,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub decision_id: Option<String>,
    #[serde(default)]
    pub trace_id: Option<String>,
    pub overlays: Vec<ChartOverlay>,
}

#[derive(Serialize)]
pub struct RecordChartStudyResponse {
    pub recorded: bool,
    pub study: ChartStudy,
}

async fn list_chart_studies(
    State(state): State<Arc<TradingApiState>>,
    Query(query): Query<ChartStudyListQuery>,
) -> Result<Json<ChartStudyListResponse>, (StatusCode, String)> {
    list_chart_studies_for_bot(&state.bot_id, query)
}

async fn list_chart_studies_multi_bot(
    Extension(bot): Extension<crate::BotContext>,
    Query(query): Query<ChartStudyListQuery>,
) -> Result<Json<ChartStudyListResponse>, (StatusCode, String)> {
    list_chart_studies_for_bot(&bot.bot_id, query)
}

async fn record_chart_study(
    State(state): State<Arc<TradingApiState>>,
    Json(req): Json<RecordChartStudyRequest>,
) -> Result<Json<RecordChartStudyResponse>, (StatusCode, String)> {
    record_chart_study_for_bot(&state.bot_id, req)
}

async fn record_chart_study_multi_bot(
    Extension(bot): Extension<crate::BotContext>,
    Json(req): Json<RecordChartStudyRequest>,
) -> Result<Json<RecordChartStudyResponse>, (StatusCode, String)> {
    record_chart_study_for_bot(&bot.bot_id, req)
}

fn list_chart_studies_for_bot(
    bot_id: &str,
    query: ChartStudyListQuery,
) -> Result<Json<ChartStudyListResponse>, (StatusCode, String)> {
    let limit = query.limit.unwrap_or(12).min(MAX_STUDIES_RETURNED);
    let token = normalize_optional_text(query.token, "token", MAX_TOKEN_LEN)?;
    let page = chart_study_store::query_studies(&ChartStudyQuery {
        bot_id: bot_id.to_string(),
        token,
        from_ms: query.from,
        to_ms: query.to,
        limit,
    })
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(ChartStudyListResponse {
        studies: page.studies,
        total: page.total,
        limit,
    }))
}

fn record_chart_study_for_bot(
    bot_id: &str,
    req: RecordChartStudyRequest,
) -> Result<Json<RecordChartStudyResponse>, (StatusCode, String)> {
    let token = normalize_required_text(req.token, "token", MAX_TOKEN_LEN)?;
    let title = normalize_required_text(req.title, "title", MAX_TEXT_LEN)?;
    let overlays = validate_overlays(req.overlays)?;
    let now_ms = Utc::now().timestamp_millis();
    let study_id = normalize_optional_text(req.study_id, "study_id", MAX_TEXT_LEN)?
        .unwrap_or_else(|| format!("study_{}", uuid::Uuid::new_v4().simple()));
    let study = ChartStudy {
        schema_version: CHART_STUDY_SCHEMA_VERSION,
        study_id,
        bot_id: bot_id.to_string(),
        token,
        venue: normalize_optional_text(req.venue, "venue", MAX_TEXT_LEN)?,
        interval: normalize_optional_text(req.interval, "interval", MAX_TEXT_LEN)?,
        title,
        summary: normalize_optional_text(req.summary, "summary", MAX_TEXT_LEN)?,
        author: normalize_optional_text(req.author, "author", MAX_TEXT_LEN)?
            .unwrap_or_else(|| "agent".to_string()),
        created_at_ms: now_ms,
        valid_from_ms: req.valid_from_ms,
        valid_to_ms: req.valid_to_ms,
        run_id: normalize_optional_text(req.run_id, "run_id", MAX_TEXT_LEN)?,
        decision_id: normalize_optional_text(req.decision_id, "decision_id", MAX_TEXT_LEN)?,
        trace_id: normalize_optional_text(req.trace_id, "trace_id", MAX_TEXT_LEN)?,
        overlays,
    };

    if let (Some(from), Some(to)) = (study.valid_from_ms, study.valid_to_ms)
        && from > to
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "valid_from_ms must be <= valid_to_ms".to_string(),
        ));
    }

    chart_study_store::record_study(study.clone())
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(RecordChartStudyResponse {
        recorded: true,
        study,
    }))
}

fn validate_overlays(
    overlays: Vec<ChartOverlay>,
) -> Result<Vec<ChartOverlay>, (StatusCode, String)> {
    if overlays.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "overlays cannot be empty".to_string(),
        ));
    }
    if overlays.len() > MAX_OVERLAYS_PER_STUDY {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("overlays cannot exceed {MAX_OVERLAYS_PER_STUDY}"),
        ));
    }

    let point_count: usize = overlays.iter().map(|overlay| overlay.points.len()).sum();
    if point_count > MAX_POINTS_PER_STUDY {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("chart study points cannot exceed {MAX_POINTS_PER_STUDY}"),
        ));
    }

    for overlay in &overlays {
        normalize_required_text(overlay.overlay_id.clone(), "overlay_id", MAX_TEXT_LEN)?;
        normalize_required_text(overlay.label.clone(), "overlay.label", MAX_TEXT_LEN)?;
        if let Some(color) = &overlay.color {
            normalize_required_text(color.clone(), "overlay.color", 32)?;
        }
        if let Some(confidence) = &overlay.confidence {
            normalize_required_text(confidence.clone(), "overlay.confidence", MAX_TEXT_LEN)?;
        }
        match overlay.kind {
            ChartOverlayKind::Line => {
                if overlay.points.len() < 2 {
                    return Err((
                        StatusCode::BAD_REQUEST,
                        format!(
                            "line overlay '{}' requires at least two points",
                            overlay.overlay_id
                        ),
                    ));
                }
            }
            ChartOverlayKind::Level => {
                if !overlay.value.is_some_and(f64::is_finite) {
                    return Err((
                        StatusCode::BAD_REQUEST,
                        format!(
                            "level overlay '{}' requires a finite value",
                            overlay.overlay_id
                        ),
                    ));
                }
            }
        }
        for point in &overlay.points {
            if point.timestamp_ms <= 0 || !point.value.is_finite() {
                return Err((
                    StatusCode::BAD_REQUEST,
                    format!("overlay '{}' contains an invalid point", overlay.overlay_id),
                ));
            }
        }
    }

    Ok(overlays)
}

fn normalize_required_text(
    value: String,
    field: &str,
    max_len: usize,
) -> Result<String, (StatusCode, String)> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err((StatusCode::BAD_REQUEST, format!("{field} cannot be empty")));
    }
    if normalized.len() > max_len {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("{field} cannot exceed {max_len} bytes"),
        ));
    }
    Ok(normalized.to_string())
}

fn normalize_optional_text(
    value: Option<String>,
    field: &str,
    max_len: usize,
) -> Result<Option<String>, (StatusCode, String)> {
    value
        .map(|value| normalize_required_text(value, field, max_len))
        .transpose()
}
