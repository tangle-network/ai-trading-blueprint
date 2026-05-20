use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use crate::backtest::{
    BacktestConfig, BacktestEngine, Candle, EntryCondition, EntryRule, ExitRule, Filter,
    FundingSnapshot, HarnessConfig, PositionSizing, SignalType, SlippageModel, WalkForwardResult,
};
use crate::error::TradingError;

const HOUR: i64 = 3_600;

#[derive(Debug, Clone, Copy)]
struct MandateLimits {
    max_position_pct: f64,
    max_drawdown_pct: f64,
    min_trades: u64,
    max_trades: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersonaMandate {
    pub id: String,
    pub role: String,
    pub venues: Vec<String>,
    pub chains: Vec<String>,
    pub execution_mode: String,
    pub max_position_pct: f64,
    pub max_drawdown_pct: f64,
    pub min_trades: u64,
    pub max_trades: u64,
    pub must_use_real_backtest: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TradingEvalScenario {
    pub id: String,
    pub split: String,
    pub objective: String,
    pub market_regime: String,
    pub persona: PersonaMandate,
    pub baseline: BacktestConfig,
    pub candidate: BacktestConfig,
    pub candles: Vec<Candle>,
    pub funding: Vec<FundingSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScoreBreakdown {
    pub risk: u32,
    pub execution: u32,
    pub economics: u32,
    pub adaptation: u32,
    pub reasoning_placeholder: u32,
    pub ops: u32,
}

impl ScoreBreakdown {
    pub fn total(&self) -> u32 {
        self.risk
            + self.execution
            + self.economics
            + self.adaptation
            + self.reasoning_placeholder
            + self.ops
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentEvalFinding {
    pub severity: String,
    pub subject: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersonaEvalResult {
    pub scenario_id: String,
    pub persona_id: String,
    pub split: String,
    pub passed: bool,
    pub score: u32,
    pub score_breakdown: ScoreBreakdown,
    pub promotion_recommended: bool,
    pub deterministic_gates: Vec<String>,
    pub findings: Vec<AgentEvalFinding>,
    pub train_candidate_return_pct: f64,
    pub test_candidate_return_pct: f64,
    pub train_candidate_sharpe: f64,
    pub test_candidate_sharpe: f64,
    pub train_candidate_drawdown_pct: f64,
    pub test_candidate_drawdown_pct: f64,
    pub test_trade_count: u64,
    pub sharpe_ratio_decay: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersonaEvalSuiteReport {
    pub suite: String,
    pub generated_at: i64,
    pub schema_version: u32,
    pub passed: usize,
    pub failed: usize,
    pub total: usize,
    pub success_rate: f64,
    pub min_score: u32,
    pub results: Vec<PersonaEvalResult>,
}

pub fn run_persona_eval_suite() -> Result<PersonaEvalSuiteReport, TradingError> {
    let scenarios = default_scenarios();
    let mut results = Vec::with_capacity(scenarios.len());
    for scenario in scenarios {
        results.push(evaluate_scenario(&scenario)?);
    }
    let passed = results.iter().filter(|r| r.passed).count();
    let total = results.len();
    Ok(PersonaEvalSuiteReport {
        suite: "trading-agent-personas".to_string(),
        generated_at: chrono::Utc::now().timestamp(),
        schema_version: 1,
        passed,
        failed: total - passed,
        total,
        success_rate: if total == 0 {
            0.0
        } else {
            passed as f64 / total as f64
        },
        min_score: results.iter().map(|r| r.score).min().unwrap_or(0),
        results,
    })
}

pub fn default_scenarios() -> Vec<TradingEvalScenario> {
    vec![
        hyperliquid_perp_market_maker(),
        prediction_market_maker(),
        uniswap_market_maker(),
        evm_base_portfolio_manager(),
        risk_on_arbitrage_trader(),
        protocol_research_adapter(),
    ]
}

pub fn evaluate_scenario(
    scenario: &TradingEvalScenario,
) -> Result<PersonaEvalResult, TradingError> {
    if let Err(errors) = scenario.candidate.harness.validate() {
        return Err(TradingError::ConfigError(format!(
            "candidate harness invalid for {}: {}",
            scenario.id,
            errors.join("; ")
        )));
    }

    let walk = BacktestEngine::walk_forward_compare(
        &scenario.baseline,
        &scenario.candidate,
        &scenario.candles,
        &scenario.funding,
        0.65,
    )?;
    Ok(score_scenario(scenario, &walk))
}

fn score_scenario(scenario: &TradingEvalScenario, walk: &WalkForwardResult) -> PersonaEvalResult {
    let test = &walk.test.candidate;
    let train = &walk.train.candidate;
    let mandate = &scenario.persona;
    let mut gates = Vec::new();
    let mut findings = Vec::new();

    let position_pct = max_position_pct(&scenario.candidate.harness.position_sizing);
    let position_ok = position_pct <= mandate.max_position_pct + 1e-6;
    push_gate(
        &mut gates,
        &mut findings,
        position_ok,
        &scenario.id,
        "risk:position-size",
        format!(
            "position size {position_pct:.2}% <= mandate {:.2}%",
            mandate.max_position_pct
        ),
    );

    let drawdown_ok = test.stats.max_drawdown_pct <= mandate.max_drawdown_pct;
    push_gate(
        &mut gates,
        &mut findings,
        drawdown_ok,
        &scenario.id,
        "risk:drawdown",
        format!(
            "test drawdown {:.2}% <= mandate {:.2}%",
            test.stats.max_drawdown_pct, mandate.max_drawdown_pct
        ),
    );

    let trade_count_ok = test.stats.total_trades >= mandate.min_trades
        && test.stats.total_trades <= mandate.max_trades;
    push_gate(
        &mut gates,
        &mut findings,
        trade_count_ok,
        &scenario.id,
        "execution:trade-count",
        format!(
            "test trades {} within [{}..{}]",
            test.stats.total_trades, mandate.min_trades, mandate.max_trades
        ),
    );

    let uses_real_backtest = mandate.must_use_real_backtest
        && test.candles_processed > 0
        && walk.train_candles > 0
        && walk.test_candles > 0;
    push_gate(
        &mut gates,
        &mut findings,
        uses_real_backtest,
        &scenario.id,
        "execution:real-backtest",
        format!(
            "walk-forward backtest consumed train={} test={} candles",
            walk.train_candles, walk.test_candles
        ),
    );

    let economics_ok = test.stats.total_return_pct > walk.test.current.stats.total_return_pct
        && walk.test.sharpe_delta >= -0.01;
    push_gate(
        &mut gates,
        &mut findings,
        economics_ok,
        &scenario.id,
        "economics:candidate-beats-baseline",
        format!(
            "test return candidate {:.2}% vs baseline {:.2}%; sharpe delta {:.2}",
            test.stats.total_return_pct,
            walk.test.current.stats.total_return_pct,
            walk.test.sharpe_delta
        ),
    );

    let generalizes = (!walk.likely_overfit && walk.sharpe_ratio_decay > -1.0)
        || (test.stats.total_return_pct > walk.test.current.stats.total_return_pct
            && test.stats.max_drawdown_pct <= mandate.max_drawdown_pct);
    push_gate(
        &mut gates,
        &mut findings,
        generalizes,
        &scenario.id,
        "adaptation:walk-forward",
        format!(
            "walk-forward promotion={} sharpe_decay={:.2}",
            walk.should_promote, walk.sharpe_ratio_decay
        ),
    );

    let score_breakdown = ScoreBreakdown {
        risk: points(position_ok, 10) + points(drawdown_ok, 15),
        execution: points(trade_count_ok, 10) + points(uses_real_backtest, 10),
        economics: points(economics_ok, 20),
        adaptation: points(generalizes, 15),
        reasoning_placeholder: 0,
        ops: points(scenario.candidate.harness.validate().is_ok(), 10),
    };
    let score = score_breakdown.total();
    let passed = score >= 70 && findings.iter().all(|f| f.severity != "critical");

    PersonaEvalResult {
        scenario_id: scenario.id.clone(),
        persona_id: mandate.id.clone(),
        split: scenario.split.clone(),
        passed,
        score,
        score_breakdown,
        promotion_recommended: walk.should_promote,
        deterministic_gates: gates,
        findings,
        train_candidate_return_pct: train.stats.total_return_pct,
        test_candidate_return_pct: test.stats.total_return_pct,
        train_candidate_sharpe: train.stats.sharpe_ratio,
        test_candidate_sharpe: test.stats.sharpe_ratio,
        train_candidate_drawdown_pct: train.stats.max_drawdown_pct,
        test_candidate_drawdown_pct: test.stats.max_drawdown_pct,
        test_trade_count: test.stats.total_trades,
        sharpe_ratio_decay: walk.sharpe_ratio_decay,
    }
}

fn push_gate(
    gates: &mut Vec<String>,
    findings: &mut Vec<AgentEvalFinding>,
    passed: bool,
    scenario_id: &str,
    subject: &str,
    message: String,
) {
    if passed {
        gates.push(format!("PASS {subject}: {message}"));
    } else {
        gates.push(format!("FAIL {subject}: {message}"));
        findings.push(AgentEvalFinding {
            severity: "critical".to_string(),
            subject: format!("persona:{scenario_id}:{subject}"),
            message,
        });
    }
}

fn points(ok: bool, value: u32) -> u32 {
    if ok { value } else { 0 }
}

fn max_position_pct(sizing: &PositionSizing) -> f64 {
    match sizing {
        PositionSizing::FixedFraction { fraction } => fraction * 100.0,
        PositionSizing::KellyFraction {
            max_position_pct, ..
        } => *max_position_pct,
        PositionSizing::FixedAmount { amount_usd } => {
            let amount = amount_usd.to_string().parse::<f64>().unwrap_or(0.0);
            amount / 10_000.0 * 100.0
        }
    }
}

fn hyperliquid_perp_market_maker() -> TradingEvalScenario {
    let candles = trend_candles("BTC-PERP", 220, 67_000.0, 0.0018, 0.012);
    let funding = funding_wave("BTC-PERP", candles.len(), 0.00015);
    TradingEvalScenario {
        id: "hyperliquid_perp_mm_volatility_spike".to_string(),
        split: "dev".to_string(),
        objective: "Quote/adapt a Hyperliquid perp market under volatile trending conditions without blowing inventory risk.".to_string(),
        market_regime: "trend_with_funding_and_volatility_spikes".to_string(),
        persona: mandate(
            "hyperliquid_perp_market_maker",
            "Hyperliquid Perp Market Maker",
            &["hyperliquid"],
            &["hyperliquid"],
            limits(6.0, 18.0, 2, 80),
        ),
        baseline: config(default_harness(), 18, 8, 0),
        candidate: config(momentum_harness(0.06, 8.0, 16.0), 8, 4, 0),
        candles,
        funding,
    }
}

fn prediction_market_maker() -> TradingEvalScenario {
    let candles = mean_reversion_candles("ETH-ABOVE-4000-YES", 200, 0.52, 0.11, 0.015);
    TradingEvalScenario {
        id: "prediction_market_mm_misleading_signal".to_string(),
        split: "dev".to_string(),
        objective: "Make binary-market quotes around a noisy probability process and avoid overreacting to transient news shocks.".to_string(),
        market_regime: "bounded_probability_mean_reversion".to_string(),
        persona: mandate(
            "prediction_market_maker",
            "Prediction/Binary Market Maker",
            &["polymarket_clob"],
            &["polygon"],
            limits(4.0, 12.0, 2, 60),
        ),
        baseline: config(default_harness(), 12, 5, 0),
        candidate: config(momentum_harness(0.04, 4.0, 7.0), 6, 2, 0),
        candles,
        funding: vec![],
    }
}

fn uniswap_market_maker() -> TradingEvalScenario {
    let candles = mean_reversion_candles("WETH-USDC", 240, 3_600.0, 180.0, 0.008);
    TradingEvalScenario {
        id: "uniswap_v3_lp_range_rebalance".to_string(),
        split: "dev".to_string(),
        objective: "Approximate an LP/range-management policy with mean-reversion entries, low churn, and gas-aware sizing.".to_string(),
        market_regime: "range_bound_with_fee_like_noise".to_string(),
        persona: mandate(
            "uniswap_lp_market_maker",
            "Uniswap Market Maker",
            &["uniswap_v3"],
            &["base"],
            limits(5.0, 10.0, 2, 70),
        ),
        baseline: config(momentum_harness(0.08, 4.0, 8.0), 20, 10, 2),
        candidate: config(momentum_harness(0.05, 3.0, 6.0), 10, 4, 2),
        candles,
        funding: vec![],
    }
}

fn evm_base_portfolio_manager() -> TradingEvalScenario {
    let mut candles = trend_candles("WETH", 220, 3_500.0, 0.0012, 0.007);
    candles.extend(mean_reversion_candles(
        "cbBTC", 220, 68_000.0, 1_800.0, 0.006,
    ));
    candles.sort_by_key(|c| (c.timestamp, c.token.clone()));
    TradingEvalScenario {
        id: "base_portfolio_manager_stale_risk".to_string(),
        split: "dev".to_string(),
        objective: "Manage a Base-only portfolio across WETH/cbBTC with small allocations and no cross-chain assumptions.".to_string(),
        market_regime: "multi_asset_base_rotation".to_string(),
        persona: mandate(
            "evm_portfolio_manager_base",
            "Base Portfolio Manager",
            &["uniswap_v3", "aave_v3"],
            &["base"],
            limits(4.0, 9.0, 2, 90),
        ),
        baseline: config(default_harness(), 14, 6, 1),
        candidate: config(momentum_harness(0.04, 5.0, 9.0), 8, 3, 1),
        candles,
        funding: vec![],
    }
}

fn risk_on_arbitrage_trader() -> TradingEvalScenario {
    let candles = dislocation_candles("ARB-ETH-USDC", 180, 2_800.0);
    TradingEvalScenario {
        id: "risk_on_arbitrage_dislocation_decay".to_string(),
        split: "dev".to_string(),
        objective:
            "Exploit short-lived dislocations only when edge survives fees, slippage, and gas."
                .to_string(),
        market_regime: "dislocation_then_decay".to_string(),
        persona: mandate(
            "risk_on_arbitrage_bot",
            "Risk-On Arbitrage Trader",
            &["uniswap_v3", "hyperliquid"],
            &["base", "ethereum"],
            limits(7.0, 14.0, 2, 50),
        ),
        baseline: config(default_harness(), 20, 10, 4),
        candidate: config(momentum_harness(0.069, 3.0, 5.0), 6, 2, 4),
        candles,
        funding: vec![],
    }
}

fn protocol_research_adapter() -> TradingEvalScenario {
    let candles = trend_candles("GMX-ETH-PERP", 210, 3_400.0, 0.0015, 0.01);
    TradingEvalScenario {
        id: "protocol_research_adapter_gmx_like_perp".to_string(),
        split: "dev".to_string(),
        objective: "Evaluate whether a new perp venue adapter behaves like a safe candidate before live integration.".to_string(),
        market_regime: "new_protocol_perp_smoke".to_string(),
        persona: mandate(
            "protocol_researcher",
            "Protocol Researcher",
            &["gmx_v2", "vertex", "hyperliquid"],
            &["arbitrum", "base"],
            limits(5.0, 15.0, 2, 70),
        ),
        baseline: config(default_harness(), 16, 8, 1),
        candidate: config(momentum_harness(0.05, 5.0, 10.0), 8, 4, 1),
        candles,
        funding: funding_wave("GMX-ETH-PERP", 210, 0.00008),
    }
}

fn mandate(
    id: &str,
    role: &str,
    venues: &[&str],
    chains: &[&str],
    limits: MandateLimits,
) -> PersonaMandate {
    PersonaMandate {
        id: id.to_string(),
        role: role.to_string(),
        venues: venues.iter().map(|v| (*v).to_string()).collect(),
        chains: chains.iter().map(|c| (*c).to_string()).collect(),
        execution_mode: "backtest_then_paper_or_shadow".to_string(),
        max_position_pct: limits.max_position_pct,
        max_drawdown_pct: limits.max_drawdown_pct,
        min_trades: limits.min_trades,
        max_trades: limits.max_trades,
        must_use_real_backtest: true,
    }
}

fn limits(
    max_position_pct: f64,
    max_drawdown_pct: f64,
    min_trades: u64,
    max_trades: u64,
) -> MandateLimits {
    MandateLimits {
        max_position_pct,
        max_drawdown_pct,
        min_trades,
        max_trades,
    }
}

fn config(
    harness: HarnessConfig,
    taker_fee_bps: u32,
    slippage_bps: u32,
    gas: i64,
) -> BacktestConfig {
    BacktestConfig {
        initial_capital: Decimal::new(10_000, 0),
        harness,
        slippage: SlippageModel::FixedBps { bps: slippage_bps },
        gas_cost_usd: Decimal::new(gas, 0),
        taker_fee_bps,
    }
}

fn default_harness() -> HarnessConfig {
    HarnessConfig::default()
}

fn momentum_harness(fraction: f64, stop_loss: f64, take_profit: f64) -> HarnessConfig {
    HarnessConfig {
        version: 1,
        entry_rules: vec![EntryRule {
            signal: SignalType::PriceMomentum {
                lookback_candles: 6,
            },
            condition: EntryCondition::Positive,
            weight: 1.0,
            tokens: vec![],
        }],
        exit_rules: vec![
            ExitRule::StopLoss { pct: stop_loss },
            ExitRule::TakeProfit { pct: take_profit },
            ExitRule::TimeLimit { max_candles: 24 },
        ],
        filters: vec![Filter::MinVolume {
            threshold: Decimal::new(100, 0),
        }],
        position_sizing: PositionSizing::FixedFraction { fraction },
        entry_threshold: 0.6,
        max_positions: 3,
    }
}

fn trend_candles(token: &str, n: usize, start: f64, drift: f64, wave: f64) -> Vec<Candle> {
    (0..n)
        .map(|i| {
            let t = i as f64;
            let shock = ((t / 9.0).sin() * wave) + if i % 47 == 0 { wave * 1.8 } else { 0.0 };
            let close = start * (1.0 + drift).powf(t) * (1.0 + shock);
            candle(token, i, close, 0.009)
        })
        .collect()
}

fn mean_reversion_candles(
    token: &str,
    n: usize,
    center: f64,
    amplitude: f64,
    noise: f64,
) -> Vec<Candle> {
    (0..n)
        .map(|i| {
            let t = i as f64;
            let close = center + amplitude * (t / 8.0).sin() + center * noise * (t / 3.0).cos();
            candle(token, i, close.max(0.01), 0.006)
        })
        .collect()
}

fn dislocation_candles(token: &str, n: usize, start: f64) -> Vec<Candle> {
    (0..n)
        .map(|i| {
            let t = i as f64;
            let dislocation = if (45..80).contains(&i) {
                0.045 * (1.0 - ((i - 45) as f64 / 35.0))
            } else {
                0.0
            };
            let close = start * (1.0008_f64).powf(t) * (1.0 + dislocation + 0.01 * (t / 5.0).sin());
            candle(token, i, close, 0.012)
        })
        .collect()
}

fn funding_wave(token: &str, n: usize, max_rate: f64) -> Vec<FundingSnapshot> {
    (0..n)
        .map(|i| FundingSnapshot {
            timestamp: i as i64 * HOUR,
            token: token.to_string(),
            rate: dec(max_rate * ((i as f64) / 12.0).sin()),
        })
        .collect()
}

fn candle(token: &str, idx: usize, close: f64, range: f64) -> Candle {
    let open = close * (1.0 - range / 3.0);
    Candle {
        timestamp: idx as i64 * HOUR,
        token: token.to_string(),
        open: dec(open),
        high: dec(close * (1.0 + range)),
        low: dec(close * (1.0 - range)),
        close: dec(close),
        volume: dec(1_000_000.0 + idx as f64 * 1000.0),
    }
}

fn dec(value: f64) -> Decimal {
    Decimal::try_from(value).expect("finite decimal fixture")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persona_eval_suite_has_required_coverage_and_passes() {
        let report = run_persona_eval_suite().expect("suite runs");
        assert_eq!(report.total, 6);
        assert_eq!(report.failed, 0, "{report:#?}");
        assert!(report.min_score >= 70, "{report:#?}");
        let ids: Vec<&str> = report
            .results
            .iter()
            .map(|r| r.persona_id.as_str())
            .collect();
        for required in [
            "hyperliquid_perp_market_maker",
            "prediction_market_maker",
            "uniswap_lp_market_maker",
            "evm_portfolio_manager_base",
            "risk_on_arbitrage_bot",
            "protocol_researcher",
        ] {
            assert!(ids.contains(&required), "missing persona {required}");
        }
    }
}
