use chrono::{DateTime, Duration, Utc};
use once_cell::sync::OnceCell;
use rust_decimal::Decimal;
use sandbox_runtime::store::PersistentStore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use trading_runtime::backtest::WalkForwardResult;

static EVIDENCE_REPORTS: OnceCell<PersistentStore<EvidenceReport>> = OnceCell::new();
static DECISIONS: OnceCell<PersistentStore<RiskBudgetDecision>> = OnceCell::new();

const DEFAULT_LIVE_PROBE_NOTIONAL_USD: &str = "25";
const DEFAULT_LIVE_PROBE_MAX_LOSS_USD: &str = "5";
const DEFAULT_LIVE_PROBE_TRADES: u64 = 1;
const DEFAULT_LIVE_PROBE_TTL_SECS: i64 = 15 * 60;
const FAST_PATH_HALF_LIFE_SECS: u64 = 6 * 60 * 60;

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UserRiskPosture {
    Conservative,
    #[default]
    Balanced,
    Aggressive,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceMode {
    CertifiedHotPath,
    FastBacktest,
    PaperForward,
    ShadowLive,
    TinyLiveProbe,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PromotionLevel {
    Rejected,
    Candidate,
    Shadow,
    TinyLive,
    Active,
    Scaled,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RiskDecisionAction {
    Reject,
    Research,
    PaperTrade,
    Shadow,
    LiveProbe,
    Active,
    Scale,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RiskBudgetRequest {
    #[serde(default)]
    pub strategy_class: Option<String>,
    #[serde(default)]
    pub market_type: Option<String>,
    #[serde(default)]
    pub instrument_type: Option<String>,
    #[serde(default)]
    pub venue: Option<String>,
    #[serde(default)]
    pub target_protocol: Option<String>,
    #[serde(default)]
    pub opportunity_half_life_secs: Option<u64>,
    #[serde(default)]
    pub user_posture: UserRiskPosture,
    #[serde(default)]
    pub certified_strategy: bool,
    #[serde(default = "default_allow_live_probe")]
    pub allow_live_probe: bool,
    #[serde(default)]
    pub prefer_shadow: bool,
    #[serde(default)]
    pub max_live_probe_notional_usd: Option<String>,
    #[serde(default)]
    pub max_live_probe_loss_usd: Option<String>,
    #[serde(default)]
    pub max_live_probe_trades: Option<u64>,
    #[serde(default)]
    pub ttl_seconds: Option<u64>,
}

fn default_allow_live_probe() -> bool {
    true
}

impl Default for RiskBudgetRequest {
    fn default() -> Self {
        Self {
            strategy_class: None,
            market_type: None,
            instrument_type: None,
            venue: None,
            target_protocol: None,
            opportunity_half_life_secs: None,
            user_posture: UserRiskPosture::Balanced,
            certified_strategy: false,
            allow_live_probe: true,
            prefer_shadow: false,
            max_live_probe_notional_usd: None,
            max_live_probe_loss_usd: None,
            max_live_probe_trades: None,
            ttl_seconds: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EvidenceReport {
    pub report_id: String,
    pub bot_id: String,
    pub created_at: DateTime<Utc>,
    pub candidate_hash: String,
    #[serde(default)]
    pub revision_id: Option<String>,
    #[serde(default)]
    pub strategy_class: Option<String>,
    #[serde(default)]
    pub market_type: Option<String>,
    #[serde(default)]
    pub instrument_type: Option<String>,
    #[serde(default)]
    pub venue: Option<String>,
    #[serde(default)]
    pub target_protocol: Option<String>,
    pub candles_used: usize,
    pub backtest_should_promote: bool,
    pub likely_overfit: bool,
    pub train_candles: usize,
    pub test_candles: usize,
    pub train_sharpe_delta: f64,
    pub test_sharpe_delta: f64,
    pub train_drawdown_delta: f64,
    pub test_drawdown_delta: f64,
    #[serde(default)]
    pub paper_trades: Option<u64>,
    #[serde(default)]
    pub paper_return_pct: Option<f64>,
    #[serde(default)]
    pub paper_max_drawdown_pct: Option<f64>,
    pub evidence_modes: Vec<EvidenceMode>,
    pub blockers: Vec<String>,
    pub confidence_score: f64,
    pub recommendation: PromotionLevel,
    pub explanation: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RiskBudgetDecision {
    pub decision_id: String,
    pub bot_id: String,
    pub evidence_report_id: String,
    pub created_at: DateTime<Utc>,
    #[serde(default)]
    pub expires_at: Option<DateTime<Utc>>,
    pub candidate_hash: String,
    #[serde(default)]
    pub revision_id: Option<String>,
    pub action: RiskDecisionAction,
    pub promotion_level: PromotionLevel,
    pub can_trade_live: bool,
    pub can_touch_funds: bool,
    #[serde(default)]
    pub target_protocol: Option<String>,
    #[serde(default)]
    pub venue: Option<String>,
    #[serde(default)]
    pub max_notional_usd: Option<String>,
    #[serde(default)]
    pub max_loss_usd: Option<String>,
    #[serde(default)]
    pub max_trades: Option<u64>,
    #[serde(default)]
    pub reserved_trades: u64,
    #[serde(default)]
    pub kill_conditions: Vec<String>,
    pub confidence_score: f64,
    pub evidence_modes: Vec<EvidenceMode>,
    pub blockers: Vec<String>,
    pub explanation: String,
}

#[derive(Clone, Debug)]
pub struct PaperEvidenceSummary {
    pub trades: u64,
    pub total_return_pct: f64,
    pub max_drawdown_pct: f64,
}

#[derive(Clone, Debug)]
pub struct DecisionBuildInput<'a> {
    pub bot_id: &'a str,
    pub candidate_hash: &'a str,
    pub revision_id: Option<String>,
    pub request: &'a RiskBudgetRequest,
    pub result: &'a WalkForwardResult,
    pub candles_used: usize,
    pub paper: Option<PaperEvidenceSummary>,
    pub paper_passed: bool,
    pub hard_blockers: Vec<String>,
    pub paper_blockers: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct LiveDecisionCheck<'a> {
    pub bot_id: &'a str,
    pub paper_trade: bool,
    pub strategy_config: &'a Value,
    pub target_protocol: &'a str,
    pub metadata: &'a Value,
    pub notional_usd: Option<Decimal>,
}

pub fn evidence_reports() -> Result<&'static PersistentStore<EvidenceReport>, String> {
    EVIDENCE_REPORTS
        .get_or_try_init(|| {
            let path = sandbox_runtime::store::state_dir().join("risk-evidence-reports.json");
            PersistentStore::open(path).map_err(|e| e.to_string())
        })
        .map_err(|e: String| e)
}

pub fn decisions() -> Result<&'static PersistentStore<RiskBudgetDecision>, String> {
    DECISIONS
        .get_or_try_init(|| {
            let path = sandbox_runtime::store::state_dir().join("risk-budget-decisions.json");
            PersistentStore::open(path).map_err(|e| e.to_string())
        })
        .map_err(|e: String| e)
}

fn report_key(report_id: &str) -> String {
    format!("risk-evidence:{report_id}")
}

fn decision_key(decision_id: &str) -> String {
    format!("risk-budget:{decision_id}")
}

pub fn insert_report(report: EvidenceReport) -> Result<(), String> {
    evidence_reports()?
        .insert(report_key(&report.report_id), report)
        .map_err(|e| e.to_string())
}

pub fn insert_decision(decision: RiskBudgetDecision) -> Result<(), String> {
    decisions()?
        .insert(decision_key(&decision.decision_id), decision)
        .map_err(|e| e.to_string())
}

pub fn get_decision(decision_id: &str) -> Result<Option<RiskBudgetDecision>, String> {
    decisions()?
        .get(&decision_key(decision_id))
        .map_err(|e| e.to_string())
}

pub fn get_report(report_id: &str) -> Result<Option<EvidenceReport>, String> {
    evidence_reports()?
        .get(&report_key(report_id))
        .map_err(|e| e.to_string())
}

pub fn persist_decision_pair(
    report: EvidenceReport,
    decision: RiskBudgetDecision,
) -> Result<(EvidenceReport, RiskBudgetDecision), String> {
    insert_report(report.clone())?;
    insert_decision(decision.clone())?;
    Ok((report, decision))
}

pub fn build_promotion_decision(
    input: DecisionBuildInput<'_>,
) -> (EvidenceReport, RiskBudgetDecision) {
    let now = Utc::now();
    let report_id = format!("er-{}", uuid::Uuid::new_v4());
    let decision_id = format!("rbd-{}", uuid::Uuid::new_v4());
    let backtest_passed = input.result.should_promote && !input.result.likely_overfit;
    let fast_path = input.request.certified_strategy || is_fast_path_request(input.request);
    let mut evidence_modes = vec![EvidenceMode::FastBacktest];
    if input.request.certified_strategy {
        evidence_modes.push(EvidenceMode::CertifiedHotPath);
    }
    if input.paper.is_some() {
        evidence_modes.push(EvidenceMode::PaperForward);
    }

    let hard_reject = !backtest_passed || !input.hard_blockers.is_empty();
    let paper_missing_or_incomplete = !input.paper_passed
        && !input.paper_blockers.is_empty()
        && input.paper_blockers.iter().all(|blocker| {
            blocker.contains("missing persisted paper")
                || blocker.contains("paper trading evidence has")
        });
    let paper_failed = !input.paper_passed && !paper_missing_or_incomplete;

    let (action, level, can_trade_live, explanation) = if hard_reject || paper_failed {
        (
            RiskDecisionAction::Reject,
            PromotionLevel::Rejected,
            false,
            "Rejected because the candidate failed backtest, overfit, or forward evidence quality checks.",
        )
    } else if input.paper_passed {
        (
            RiskDecisionAction::Active,
            PromotionLevel::Active,
            true,
            "Approved for active allocation inside the returned risk budget.",
        )
    } else if input.request.prefer_shadow {
        evidence_modes.push(EvidenceMode::ShadowLive);
        (
            RiskDecisionAction::Shadow,
            PromotionLevel::Shadow,
            false,
            "Backtest passed but forward evidence is incomplete; route to shadow live observation.",
        )
    } else if fast_path && input.request.allow_live_probe {
        evidence_modes.push(EvidenceMode::TinyLiveProbe);
        (
            RiskDecisionAction::LiveProbe,
            PromotionLevel::TinyLive,
            true,
            "Backtest passed and opportunity is time-sensitive; allow a tiny live probe with strict caps.",
        )
    } else {
        (
            RiskDecisionAction::PaperTrade,
            PromotionLevel::Candidate,
            false,
            "Backtest passed but forward paper evidence is incomplete; continue paper trial before live capital.",
        )
    };

    let confidence_score = confidence_score(input.result, input.paper.as_ref(), level);
    let mut blockers = input.hard_blockers;
    blockers.extend(input.paper_blockers);
    let expires_at = if can_trade_live {
        Some(now + Duration::seconds(ttl_seconds(input.request)))
    } else {
        None
    };
    let (max_notional_usd, max_loss_usd, max_trades) = live_caps(input.request, level);
    let kill_conditions = kill_conditions(level);

    let report = EvidenceReport {
        report_id: report_id.clone(),
        bot_id: input.bot_id.to_string(),
        created_at: now,
        candidate_hash: input.candidate_hash.to_string(),
        revision_id: input.revision_id.clone(),
        strategy_class: input.request.strategy_class.clone(),
        market_type: input.request.market_type.clone(),
        instrument_type: input.request.instrument_type.clone(),
        venue: input.request.venue.clone(),
        target_protocol: input.request.target_protocol.clone(),
        candles_used: input.candles_used,
        backtest_should_promote: input.result.should_promote,
        likely_overfit: input.result.likely_overfit,
        train_candles: input.result.train_candles,
        test_candles: input.result.test_candles,
        train_sharpe_delta: input.result.train.sharpe_delta,
        test_sharpe_delta: input.result.test.sharpe_delta,
        train_drawdown_delta: input.result.train.drawdown_delta,
        test_drawdown_delta: input.result.test.drawdown_delta,
        paper_trades: input.paper.as_ref().map(|paper| paper.trades),
        paper_return_pct: input.paper.as_ref().map(|paper| paper.total_return_pct),
        paper_max_drawdown_pct: input.paper.as_ref().map(|paper| paper.max_drawdown_pct),
        evidence_modes: evidence_modes.clone(),
        blockers: blockers.clone(),
        confidence_score,
        recommendation: level,
        explanation: explanation.to_string(),
    };
    let decision = RiskBudgetDecision {
        decision_id,
        bot_id: input.bot_id.to_string(),
        evidence_report_id: report_id,
        created_at: now,
        expires_at,
        candidate_hash: input.candidate_hash.to_string(),
        revision_id: input.revision_id,
        action,
        promotion_level: level,
        can_trade_live,
        can_touch_funds: can_trade_live,
        target_protocol: input.request.target_protocol.clone(),
        venue: input.request.venue.clone(),
        max_notional_usd,
        max_loss_usd,
        max_trades,
        reserved_trades: 0,
        kill_conditions,
        confidence_score,
        evidence_modes,
        blockers,
        explanation: explanation.to_string(),
    };

    (report, decision)
}

pub fn risk_budget_decision_id(metadata: &Value) -> Option<String> {
    metadata_string(metadata, "risk_budget_decision_id")
        .or_else(|| metadata_string(metadata, "risk_decision_id"))
}

pub fn enforce_live_decision(
    check: LiveDecisionCheck<'_>,
) -> Result<Option<RiskBudgetDecision>, String> {
    if check.paper_trade {
        return Ok(None);
    }

    let decision_id = risk_budget_decision_id(check.metadata);
    if decision_id.is_none() && !requires_decision(check.strategy_config, check.metadata) {
        return Ok(None);
    }
    let decision_id = decision_id
        .ok_or_else(|| "risk_budget_decision_id is required for this live trade".to_string())?;
    let mut outcome: Option<Result<RiskBudgetDecision, String>> = None;
    let found = decisions()?
        .update(&decision_key(&decision_id), |decision| {
            outcome = Some(
                validate_and_reserve_live_decision(decision, &check).map(|()| decision.clone()),
            );
        })
        .map_err(|e| e.to_string())?;
    if !found {
        return Err(format!(
            "risk budget decision '{decision_id}' was not found"
        ));
    }

    let decision = outcome.unwrap_or_else(|| {
        Err(format!(
            "risk budget decision '{decision_id}' could not be evaluated"
        ))
    })?;
    Ok(Some(decision))
}

fn validate_and_reserve_live_decision(
    decision: &mut RiskBudgetDecision,
    check: &LiveDecisionCheck<'_>,
) -> Result<(), String> {
    if decision.bot_id != check.bot_id {
        return Err(format!(
            "risk budget decision '{}' belongs to bot '{}', not '{}'",
            decision.decision_id, decision.bot_id, check.bot_id
        ));
    }
    if !decision.can_trade_live || !decision.can_touch_funds {
        return Err(format!(
            "risk budget decision '{}' does not allow live fund execution",
            decision.decision_id
        ));
    }
    if let Some(expires_at) = decision.expires_at
        && Utc::now() >= expires_at
    {
        return Err(format!(
            "risk budget decision '{}' expired at {}",
            decision.decision_id,
            expires_at.to_rfc3339()
        ));
    }
    if let Some(expected) = decision.target_protocol.as_deref()
        && normalize(expected) != normalize(check.target_protocol)
    {
        return Err(format!(
            "risk budget decision '{}' is for protocol '{}', not '{}'",
            decision.decision_id, expected, check.target_protocol
        ));
    }

    let metadata_revision = metadata_string(check.metadata, "revision_id");
    let metadata_candidate = metadata_string(check.metadata, "candidate_hash");
    if let Some(expected) = decision.revision_id.as_deref() {
        if metadata_revision.as_deref() != Some(expected) {
            return Err(format!(
                "risk budget decision '{}' requires revision_id '{}'",
                decision.decision_id, expected
            ));
        }
    } else if !decision.candidate_hash.trim().is_empty()
        && metadata_candidate.as_deref() != Some(decision.candidate_hash.as_str())
    {
        return Err(format!(
            "risk budget decision '{}' requires candidate_hash '{}'",
            decision.decision_id, decision.candidate_hash
        ));
    }
    if metadata_candidate
        .as_deref()
        .is_some_and(|candidate| candidate != decision.candidate_hash)
    {
        return Err(format!(
            "risk budget decision '{}' candidate_hash mismatch",
            decision.decision_id
        ));
    }

    if let Some(raw_max_notional) = decision.max_notional_usd.as_deref() {
        let max_notional = parse_decimal(raw_max_notional).ok_or_else(|| {
            format!(
                "risk budget decision '{}' has invalid max_notional_usd '{}'",
                decision.decision_id, raw_max_notional
            )
        })?;
        let notional = check.notional_usd.ok_or_else(|| {
            format!(
                "risk budget decision '{}' requires priced notional before live execution",
                decision.decision_id
            )
        })?;
        if notional > max_notional {
            return Err(format!(
                "risk budget decision '{}' max_notional_usd {} exceeded by trade notional {}",
                decision.decision_id, max_notional, notional
            ));
        }
    }
    if let Some(max_trades) = decision.max_trades {
        if decision.reserved_trades >= max_trades {
            return Err(format!(
                "risk budget decision '{}' max_trades {} already consumed",
                decision.decision_id, max_trades
            ));
        }
        decision.reserved_trades += 1;
    }

    Ok(())
}

fn requires_decision(strategy_config: &Value, metadata: &Value) -> bool {
    bool_at(strategy_config, &["risk_budget", "require_decision"]).unwrap_or(false)
        || bool_at(metadata, &["risk_budget_decision_required"]).unwrap_or(false)
        || metadata_string(metadata, "risk_budget_decision_id").is_some()
        || metadata_string(metadata, "risk_decision_id").is_some()
        || metadata_string(metadata, "candidate_hash").is_some()
        || metadata_string(metadata, "revision_id")
            .as_deref()
            .is_some_and(|revision| revision != "rev-0")
}

fn bool_at(value: &Value, path: &[&str]) -> Option<bool> {
    let mut current = value;
    for part in path {
        current = current.get(*part)?;
    }
    current.as_bool()
}

fn metadata_string(metadata: &Value, key: &str) -> Option<String> {
    metadata
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn is_fast_path_request(request: &RiskBudgetRequest) -> bool {
    request.user_posture == UserRiskPosture::Aggressive
        || request
            .opportunity_half_life_secs
            .is_some_and(|secs| secs <= FAST_PATH_HALF_LIFE_SECS)
        || request
            .market_type
            .as_deref()
            .is_some_and(|market| normalize(market).contains("prediction"))
}

fn ttl_seconds(request: &RiskBudgetRequest) -> i64 {
    request
        .ttl_seconds
        .and_then(|secs| i64::try_from(secs).ok())
        .filter(|secs| *secs > 0)
        .or_else(|| {
            request
                .opportunity_half_life_secs
                .and_then(|secs| i64::try_from(secs).ok())
                .map(|secs| secs.clamp(60, DEFAULT_LIVE_PROBE_TTL_SECS))
        })
        .unwrap_or(DEFAULT_LIVE_PROBE_TTL_SECS)
}

fn live_caps(
    request: &RiskBudgetRequest,
    level: PromotionLevel,
) -> (Option<String>, Option<String>, Option<u64>) {
    match level {
        PromotionLevel::TinyLive => (
            Some(
                request
                    .max_live_probe_notional_usd
                    .clone()
                    .unwrap_or_else(|| DEFAULT_LIVE_PROBE_NOTIONAL_USD.to_string()),
            ),
            Some(
                request
                    .max_live_probe_loss_usd
                    .clone()
                    .unwrap_or_else(|| DEFAULT_LIVE_PROBE_MAX_LOSS_USD.to_string()),
            ),
            Some(
                request
                    .max_live_probe_trades
                    .unwrap_or(DEFAULT_LIVE_PROBE_TRADES),
            ),
        ),
        PromotionLevel::Active | PromotionLevel::Scaled => (
            request.max_live_probe_notional_usd.clone(),
            request.max_live_probe_loss_usd.clone(),
            request.max_live_probe_trades,
        ),
        _ => (None, None, None),
    }
}

fn kill_conditions(level: PromotionLevel) -> Vec<String> {
    match level {
        PromotionLevel::TinyLive => vec![
            "ttl_expired".to_string(),
            "max_loss_hit".to_string(),
            "max_trades_consumed".to_string(),
            "live_slippage_exceeds_budget".to_string(),
            "venue_liquidity_deteriorated".to_string(),
        ],
        PromotionLevel::Active | PromotionLevel::Scaled => vec![
            "max_loss_hit".to_string(),
            "live_vs_backtest_drift".to_string(),
            "mandate_violation".to_string(),
        ],
        _ => Vec::new(),
    }
}

fn confidence_score(
    result: &WalkForwardResult,
    paper: Option<&PaperEvidenceSummary>,
    level: PromotionLevel,
) -> f64 {
    let mut score = if result.should_promote { 0.55 } else { 0.10 };
    if !result.likely_overfit {
        score += 0.15;
    }
    if result.sharpe_ratio_decay.is_finite() {
        score += result.sharpe_ratio_decay.clamp(0.0, 1.0) * 0.15;
    }
    if let Some(paper) = paper {
        if paper.trades >= 20 {
            score += 0.10;
        }
        if paper.total_return_pct > 0.0 {
            score += 0.05;
        }
    }
    if level == PromotionLevel::TinyLive {
        score = score.min(0.74);
    }
    score.clamp(0.0, 0.99)
}

fn parse_decimal(raw: &str) -> Option<Decimal> {
    raw.trim().parse::<Decimal>().ok()
}

fn normalize(value: &str) -> String {
    value.trim().to_lowercase().replace('-', "_")
}

#[cfg(test)]
mod tests {
    use super::*;
    use trading_runtime::backtest::{BacktestComparison, BacktestResult, WalkForwardResult};
    use trading_runtime::leaderboard::LeaderboardStats;

    fn stats(sharpe_ratio: f64, max_drawdown_pct: f64) -> LeaderboardStats {
        LeaderboardStats {
            bot_id: "test".to_string(),
            total_return_pct: 12.0,
            sharpe_ratio,
            sortino_ratio: sharpe_ratio,
            max_drawdown_pct,
            calmar_ratio: 1.0,
            win_rate: 0.60,
            total_trades: 24,
            profitable_trades: 14,
            days_active: 10.0,
        }
    }

    fn result() -> WalkForwardResult {
        let current = BacktestResult {
            trades: Vec::new(),
            equity_curve: Vec::new(),
            stats: stats(1.0, 5.0),
            total_fees: Decimal::ZERO,
            total_slippage: Decimal::ZERO,
            total_gas: Decimal::ZERO,
            candles_processed: 80,
            tokens_traded: vec!["ETH".to_string()],
        };
        let candidate = BacktestResult {
            trades: Vec::new(),
            equity_curve: Vec::new(),
            stats: stats(1.3, 5.1),
            total_fees: Decimal::ZERO,
            total_slippage: Decimal::ZERO,
            total_gas: Decimal::ZERO,
            candles_processed: 80,
            tokens_traded: vec!["ETH".to_string()],
        };
        WalkForwardResult {
            train: BacktestComparison {
                current: current.clone(),
                candidate: candidate.clone(),
                sharpe_delta: 0.3,
                drawdown_delta: 0.1,
                win_rate_delta: 0.05,
            },
            test: BacktestComparison {
                current,
                candidate,
                sharpe_delta: 0.25,
                drawdown_delta: 0.1,
                win_rate_delta: 0.04,
            },
            should_promote: true,
            train_candles: 50,
            test_candles: 30,
            sharpe_ratio_decay: 0.8,
            likely_overfit: false,
        }
    }

    fn live_probe_decision(id: &str, bot_id: &str) -> RiskBudgetDecision {
        RiskBudgetDecision {
            decision_id: id.to_string(),
            bot_id: bot_id.to_string(),
            evidence_report_id: format!("er-{id}"),
            created_at: Utc::now(),
            expires_at: Some(Utc::now() + Duration::minutes(5)),
            candidate_hash: "sha256:candidate".to_string(),
            revision_id: None,
            action: RiskDecisionAction::LiveProbe,
            promotion_level: PromotionLevel::TinyLive,
            can_trade_live: true,
            can_touch_funds: true,
            target_protocol: Some("polymarket_clob".to_string()),
            venue: Some("polymarket".to_string()),
            max_notional_usd: Some("25".to_string()),
            max_loss_usd: Some("5".to_string()),
            max_trades: Some(1),
            reserved_trades: 0,
            kill_conditions: Vec::new(),
            confidence_score: 0.7,
            evidence_modes: vec![EvidenceMode::FastBacktest],
            blockers: Vec::new(),
            explanation: "test".to_string(),
        }
    }

    #[test]
    fn time_sensitive_backtest_passer_gets_tiny_live_decision() {
        let request = RiskBudgetRequest {
            market_type: Some("prediction_market".to_string()),
            target_protocol: Some("polymarket_clob".to_string()),
            opportunity_half_life_secs: Some(900),
            user_posture: UserRiskPosture::Aggressive,
            ..Default::default()
        };
        let (_report, decision) = build_promotion_decision(DecisionBuildInput {
            bot_id: "bot-1",
            candidate_hash: "sha256:candidate",
            revision_id: None,
            request: &request,
            result: &result(),
            candles_used: 80,
            paper: None,
            paper_passed: false,
            hard_blockers: Vec::new(),
            paper_blockers: vec![
                "missing persisted paper trading evidence for candidate".to_string(),
            ],
        });

        assert_eq!(decision.action, RiskDecisionAction::LiveProbe);
        assert_eq!(decision.promotion_level, PromotionLevel::TinyLive);
        assert!(decision.can_trade_live);
        assert_eq!(decision.max_notional_usd.as_deref(), Some("25"));
        assert_eq!(decision.max_trades, Some(1));
    }

    #[test]
    fn certified_without_forward_evidence_gets_bounded_probe_not_active() {
        let request = RiskBudgetRequest {
            certified_strategy: true,
            ..Default::default()
        };
        let (_report, decision) = build_promotion_decision(DecisionBuildInput {
            bot_id: "bot-certified",
            candidate_hash: "sha256:candidate",
            revision_id: None,
            request: &request,
            result: &result(),
            candles_used: 80,
            paper: None,
            paper_passed: false,
            hard_blockers: Vec::new(),
            paper_blockers: vec![
                "missing persisted paper trading evidence for candidate".to_string(),
            ],
        });

        assert_eq!(decision.action, RiskDecisionAction::LiveProbe);
        assert_eq!(decision.promotion_level, PromotionLevel::TinyLive);
        assert_eq!(decision.max_notional_usd.as_deref(), Some("25"));
    }

    #[test]
    fn negative_paper_evidence_rejects_even_when_trade_count_incomplete() {
        let request = RiskBudgetRequest {
            market_type: Some("prediction_market".to_string()),
            opportunity_half_life_secs: Some(900),
            user_posture: UserRiskPosture::Aggressive,
            ..Default::default()
        };
        let (_report, decision) = build_promotion_decision(DecisionBuildInput {
            bot_id: "bot-negative-paper",
            candidate_hash: "sha256:candidate",
            revision_id: None,
            request: &request,
            result: &result(),
            candles_used: 80,
            paper: Some(PaperEvidenceSummary {
                trades: 3,
                total_return_pct: -2.0,
                max_drawdown_pct: 4.0,
            }),
            paper_passed: false,
            hard_blockers: Vec::new(),
            paper_blockers: vec![
                "paper trading evidence has 3 trades; need at least 20".to_string(),
                "paper trading return must be positive and finite".to_string(),
            ],
        });

        assert_eq!(decision.action, RiskDecisionAction::Reject);
        assert!(!decision.can_trade_live);
    }

    #[test]
    fn live_decision_rejects_over_cap_notional() {
        let decision = live_probe_decision("rbd-over-cap", "bot-over-cap");
        insert_decision(decision).expect("insert decision");

        let err = enforce_live_decision(LiveDecisionCheck {
            bot_id: "bot-over-cap",
            paper_trade: false,
            strategy_config: &serde_json::json!({}),
            target_protocol: "polymarket_clob",
            metadata: &serde_json::json!({
                "risk_budget_decision_id": "rbd-over-cap",
                "candidate_hash": "sha256:candidate"
            }),
            notional_usd: Some(Decimal::new(2600, 2)),
        })
        .expect_err("over cap should reject");

        assert!(err.contains("max_notional_usd"));
    }

    #[test]
    fn live_decision_rejects_invalid_notional_cap() {
        let mut decision = live_probe_decision("rbd-invalid-cap", "bot-invalid-cap");
        decision.max_notional_usd = Some("not-a-decimal".to_string());
        insert_decision(decision).expect("insert decision");

        let err = enforce_live_decision(LiveDecisionCheck {
            bot_id: "bot-invalid-cap",
            paper_trade: false,
            strategy_config: &serde_json::json!({}),
            target_protocol: "polymarket_clob",
            metadata: &serde_json::json!({
                "risk_budget_decision_id": "rbd-invalid-cap",
                "candidate_hash": "sha256:candidate"
            }),
            notional_usd: Some(Decimal::ONE),
        })
        .expect_err("invalid cap should fail closed");

        assert!(err.contains("invalid max_notional_usd"));
    }

    #[test]
    fn live_decision_requires_matching_candidate_hash() {
        let decision = live_probe_decision("rbd-candidate-match", "bot-candidate-match");
        insert_decision(decision).expect("insert decision");

        let err = enforce_live_decision(LiveDecisionCheck {
            bot_id: "bot-candidate-match",
            paper_trade: false,
            strategy_config: &serde_json::json!({}),
            target_protocol: "polymarket_clob",
            metadata: &serde_json::json!({
                "risk_budget_decision_id": "rbd-candidate-match"
            }),
            notional_usd: Some(Decimal::ONE),
        })
        .expect_err("candidate hash should be required");

        assert!(err.contains("requires candidate_hash"));
    }

    #[test]
    fn live_decision_reserves_trade_count_before_dispatch() {
        let decision = live_probe_decision("rbd-reserve-count", "bot-reserve-count");
        insert_decision(decision).expect("insert decision");

        enforce_live_decision(LiveDecisionCheck {
            bot_id: "bot-reserve-count",
            paper_trade: false,
            strategy_config: &serde_json::json!({}),
            target_protocol: "polymarket_clob",
            metadata: &serde_json::json!({
                "risk_budget_decision_id": "rbd-reserve-count",
                "candidate_hash": "sha256:candidate"
            }),
            notional_usd: Some(Decimal::ONE),
        })
        .expect("first trade should reserve");

        let err = enforce_live_decision(LiveDecisionCheck {
            bot_id: "bot-reserve-count",
            paper_trade: false,
            strategy_config: &serde_json::json!({}),
            target_protocol: "polymarket_clob",
            metadata: &serde_json::json!({
                "risk_budget_decision_id": "rbd-reserve-count",
                "candidate_hash": "sha256:candidate"
            }),
            notional_usd: Some(Decimal::ONE),
        })
        .expect_err("second trade should exceed reserved max_trades");

        assert!(err.contains("max_trades 1 already consumed"));
    }

    #[test]
    fn candidate_revision_requires_decision_for_live_execution() {
        let err = enforce_live_decision(LiveDecisionCheck {
            bot_id: "bot-missing-decision",
            paper_trade: false,
            strategy_config: &serde_json::json!({}),
            target_protocol: "uniswap_v3",
            metadata: &serde_json::json!({ "revision_id": "sr-candidate" }),
            notional_usd: Some(Decimal::ONE),
        })
        .expect_err("candidate revision should require decision");

        assert!(err.contains("risk_budget_decision_id is required"));
    }
}
