use once_cell::sync::OnceCell;
use sandbox_runtime::store::PersistentStore;
use serde::{Deserialize, Serialize};

static CHART_STUDIES: OnceCell<PersistentStore<ChartStudy>> = OnceCell::new();

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChartOverlayKind {
    Line,
    Level,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChartOverlayPoint {
    pub timestamp_ms: i64,
    pub value: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChartOverlay {
    pub overlay_id: String,
    pub kind: ChartOverlayKind,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
    #[serde(default)]
    pub points: Vec<ChartOverlayPoint>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChartStudy {
    pub schema_version: u32,
    pub study_id: String,
    pub bot_id: String,
    pub token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub venue: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval: Option<String>,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub author: String,
    pub created_at_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valid_from_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valid_to_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
    pub overlays: Vec<ChartOverlay>,
}

pub struct ChartStudyQuery {
    pub bot_id: String,
    pub token: Option<String>,
    pub from_ms: Option<i64>,
    pub to_ms: Option<i64>,
    pub limit: usize,
}

pub struct ChartStudyPage {
    pub studies: Vec<ChartStudy>,
    pub total: usize,
}

pub fn studies() -> Result<&'static PersistentStore<ChartStudy>, String> {
    CHART_STUDIES
        .get_or_try_init(|| {
            let path = sandbox_runtime::store::state_dir().join("chart-studies.json");
            PersistentStore::open(path).map_err(|e| e.to_string())
        })
        .map_err(|e: String| e)
}

fn study_key(bot_id: &str, study_id: &str) -> String {
    format!("chart-study:{bot_id}:{study_id}")
}

pub fn record_study(study: ChartStudy) -> Result<(), String> {
    studies()?
        .insert(study_key(&study.bot_id, &study.study_id), study)
        .map_err(|e| e.to_string())
}

pub fn query_studies(q: &ChartStudyQuery) -> Result<ChartStudyPage, String> {
    let mut all: Vec<ChartStudy> = studies()?
        .values()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|study| study.bot_id == q.bot_id)
        .filter(|study| {
            q.token
                .as_ref()
                .is_none_or(|token| study.token.eq_ignore_ascii_case(token))
        })
        .filter(|study| overlaps_window(study, q.from_ms, q.to_ms))
        .collect();

    all.sort_by(|left, right| {
        right
            .created_at_ms
            .cmp(&left.created_at_ms)
            .then_with(|| left.study_id.cmp(&right.study_id))
    });

    let total = all.len();
    if all.len() > q.limit {
        all.truncate(q.limit);
    }

    Ok(ChartStudyPage {
        studies: all,
        total,
    })
}

fn overlaps_window(study: &ChartStudy, from_ms: Option<i64>, to_ms: Option<i64>) -> bool {
    let study_from = study.valid_from_ms.unwrap_or(study.created_at_ms);
    let study_to = study.valid_to_ms.unwrap_or(study.created_at_ms);
    if from_ms.is_some_and(|from| study_to < from) {
        return false;
    }
    if to_ms.is_some_and(|to| study_from > to) {
        return false;
    }
    true
}
