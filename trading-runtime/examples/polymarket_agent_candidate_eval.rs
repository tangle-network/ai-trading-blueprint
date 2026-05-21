use std::env;
use std::fs;
use std::path::PathBuf;
use std::str::FromStr;

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use trading_runtime::backtest::{
    BacktestConfig, BacktestEngine, Candle, EntryCondition, EntryRule, ExitRule, HarnessConfig,
    PositionSizing, SignalType, SlippageModel,
};

#[derive(Debug, Deserialize)]
struct CandidateSpec {
    schema_version: u32,
    strategy_id: String,
    venue: String,
    mode: String,
    rsi_period: usize,
    rsi_condition: String,
    rsi_below: f64,
    ema_short: usize,
    ema_long: usize,
    ema_condition: String,
    position_fraction: f64,
    entry_threshold: f64,
    stop_loss_pct: f64,
    take_profit_pct: f64,
    max_drawdown_pct: f64,
    requires_holdout: bool,
    no_live_keys: bool,
    rationale: String,
}

#[derive(Debug, Deserialize)]
struct GammaMarket {
    id: String,
    question: String,
    slug: String,
    #[serde(rename = "conditionId")]
    condition_id: String,
    #[serde(rename = "clobTokenIds")]
    clob_token_ids: String,
}

#[derive(Debug, Deserialize)]
struct PriceHistory {
    history: Vec<PricePoint>,
}

#[derive(Debug, Deserialize)]
struct PricePoint {
    t: i64,
    p: f64,
}

#[derive(Debug, Serialize)]
struct AgentCandidateReplayReport {
    suite: String,
    source: String,
    market_id: String,
    condition_id: String,
    slug: String,
    question: String,
    clob_token_id: String,
    strategy_id: String,
    interval: String,
    fidelity_minutes: u32,
    candles: usize,
    train_candles: usize,
    test_candles: usize,
    train_candidate_return_pct: f64,
    test_current_return_pct: f64,
    test_candidate_return_pct: f64,
    test_return_delta_pct: f64,
    test_candidate_sharpe: f64,
    test_candidate_max_drawdown_pct: f64,
    test_candidate_trades: u64,
    should_promote: bool,
    likely_overfit: bool,
    pass: bool,
    failure_reasons: Vec<String>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut candidate_path: Option<PathBuf> = None;
    let mut out: Option<PathBuf> = None;
    let mut interval = env::var("POLYMARKET_PRICE_INTERVAL").unwrap_or_else(|_| "1m".into());
    let mut fidelity_minutes = env::var("POLYMARKET_PRICE_FIDELITY")
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(60);
    let mut token_id = env::var("POLYMARKET_CLOB_TOKEN_ID").ok();

    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--candidate" => {
                candidate_path = Some(PathBuf::from(
                    args.next().ok_or("--candidate requires a path")?,
                ))
            }
            "--out" => out = Some(PathBuf::from(args.next().ok_or("--out requires a path")?)),
            "--interval" => interval = args.next().ok_or("--interval requires a value")?,
            "--fidelity" => {
                fidelity_minutes = args
                    .next()
                    .ok_or("--fidelity requires minutes")?
                    .parse::<u32>()?;
            }
            "--token-id" => token_id = Some(args.next().ok_or("--token-id requires an id")?),
            "--help" | "-h" => {
                eprintln!(
                    "usage: cargo run -p trading-runtime --example polymarket_agent_candidate_eval -- --candidate <path> [--out <path>] [--interval 1m] [--fidelity 60] [--token-id <clob-token-id>]"
                );
                return Ok(());
            }
            other => return Err(format!("unknown argument: {other}").into()),
        }
    }

    let candidate_path = candidate_path.ok_or("--candidate is required")?;
    let candidate: CandidateSpec = serde_json::from_str(&fs::read_to_string(&candidate_path)?)?;
    validate_candidate_spec(&candidate)?;

    let client = reqwest::Client::new();
    let market = fetch_market(&client).await?;
    let selected_token = token_id.unwrap_or_else(|| first_clob_token(&market.clob_token_ids));
    if selected_token.is_empty() {
        return Err("market has no CLOB token ids".into());
    }

    let candles = fetch_price_history(&client, &selected_token, &interval, fidelity_minutes)
        .await?
        .into_iter()
        .filter_map(|p| candle_from_point(&market.slug, p))
        .collect::<Vec<_>>();
    if candles.len() < 64 {
        return Err(format!(
            "insufficient Polymarket price history: {} points",
            candles.len()
        )
        .into());
    }

    let current = BacktestConfig {
        initial_capital: Decimal::new(1_000, 0),
        harness: HarnessConfig::default(),
        slippage: SlippageModel::FixedBps { bps: 25 },
        gas_cost_usd: Decimal::ZERO,
        taker_fee_bps: 0,
    };
    let replay_candidate = BacktestConfig {
        initial_capital: Decimal::new(1_000, 0),
        harness: HarnessConfig {
            version: 1,
            entry_rules: vec![
                EntryRule {
                    signal: SignalType::Rsi {
                        period: candidate.rsi_period,
                    },
                    condition: rsi_condition(&candidate),
                    weight: 0.55,
                    tokens: vec![],
                },
                EntryRule {
                    signal: SignalType::EmaCross {
                        short_period: candidate.ema_short,
                        long_period: candidate.ema_long,
                    },
                    condition: ema_condition(&candidate),
                    weight: 0.45,
                    tokens: vec![],
                },
            ],
            exit_rules: vec![
                ExitRule::StopLoss {
                    pct: candidate.stop_loss_pct,
                },
                ExitRule::TakeProfit {
                    pct: candidate.take_profit_pct,
                },
            ],
            filters: vec![],
            position_sizing: PositionSizing::FixedFraction {
                fraction: candidate.position_fraction,
            },
            entry_threshold: candidate.entry_threshold,
            max_positions: 1,
        },
        slippage: SlippageModel::FixedBps { bps: 25 },
        gas_cost_usd: Decimal::ZERO,
        taker_fee_bps: 0,
    };

    let walk =
        BacktestEngine::walk_forward_compare(&current, &replay_candidate, &candles, &[], 0.65)?;
    let mut failure_reasons = Vec::new();
    if walk.test.candidate.stats.total_return_pct <= 0.0 {
        failure_reasons.push(format!(
            "holdout return is not profitable: {:.4}%",
            walk.test.candidate.stats.total_return_pct
        ));
    }
    if walk.test.candidate.stats.total_return_pct <= walk.test.current.stats.total_return_pct {
        failure_reasons.push(format!(
            "candidate did not beat baseline on holdout: candidate {:.4}% baseline {:.4}%",
            walk.test.candidate.stats.total_return_pct, walk.test.current.stats.total_return_pct
        ));
    }
    if walk.test.candidate.stats.max_drawdown_pct > candidate.max_drawdown_pct {
        failure_reasons.push(format!(
            "holdout drawdown {:.4}% exceeds candidate cap {:.4}%",
            walk.test.candidate.stats.max_drawdown_pct, candidate.max_drawdown_pct
        ));
    }
    if walk.likely_overfit {
        failure_reasons.push("walk-forward marked candidate as likely overfit".to_string());
    }
    if walk.test.candidate.stats.total_trades == 0 {
        failure_reasons.push("candidate made no holdout trades".to_string());
    }

    let report = AgentCandidateReplayReport {
        suite: "polymarket-agent-candidate-replay".into(),
        source: "gamma-api.polymarket.com + clob.polymarket.com/prices-history".into(),
        market_id: market.id,
        condition_id: market.condition_id,
        slug: market.slug,
        question: market.question,
        clob_token_id: selected_token,
        strategy_id: candidate.strategy_id,
        interval,
        fidelity_minutes,
        candles: candles.len(),
        train_candles: walk.train_candles,
        test_candles: walk.test_candles,
        train_candidate_return_pct: walk.train.candidate.stats.total_return_pct,
        test_current_return_pct: walk.test.current.stats.total_return_pct,
        test_candidate_return_pct: walk.test.candidate.stats.total_return_pct,
        test_return_delta_pct: walk.test.candidate.stats.total_return_pct
            - walk.test.current.stats.total_return_pct,
        test_candidate_sharpe: walk.test.candidate.stats.sharpe_ratio,
        test_candidate_max_drawdown_pct: walk.test.candidate.stats.max_drawdown_pct,
        test_candidate_trades: walk.test.candidate.stats.total_trades,
        should_promote: walk.should_promote,
        likely_overfit: walk.likely_overfit,
        pass: failure_reasons.is_empty(),
        failure_reasons,
    };

    let json = serde_json::to_string_pretty(&report)?;
    if let Some(path) = out {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, format!("{json}\n"))?;
        println!("{}", path.display());
    } else {
        println!("{json}");
    }

    if !report.pass {
        return Err(format!(
            "agent candidate replay failed: {}",
            report.failure_reasons.join("; ")
        )
        .into());
    }

    Ok(())
}

fn validate_candidate_spec(candidate: &CandidateSpec) -> Result<(), Box<dyn std::error::Error>> {
    let mut errors = Vec::new();
    if candidate.schema_version != 1 {
        errors.push("schema_version must be 1".to_string());
    }
    if candidate.venue != "polymarket_clob" {
        errors.push("venue must be polymarket_clob".to_string());
    }
    if candidate.mode != "paper" {
        errors.push("mode must be paper".to_string());
    }
    if candidate.rsi_period == 0 || candidate.rsi_period > 64 {
        errors.push("rsi_period must be in 1..=64".to_string());
    }
    if !(5.0..=95.0).contains(&candidate.rsi_below) {
        errors.push("rsi_below must be in 5..=95".to_string());
    }
    if candidate.rsi_condition != "below" && candidate.rsi_condition != "above" {
        errors.push("rsi_condition must be below or above".to_string());
    }
    if candidate.ema_short == 0
        || candidate.ema_long == 0
        || candidate.ema_short >= candidate.ema_long
        || candidate.ema_long > 128
    {
        errors.push("ema periods must satisfy 0 < short < long <= 128".to_string());
    }
    if candidate.ema_condition != "cross_above" && candidate.ema_condition != "cross_below" {
        errors.push("ema_condition must be cross_above or cross_below".to_string());
    }
    if !(0.0..=0.05).contains(&candidate.position_fraction) || candidate.position_fraction == 0.0 {
        errors.push("position_fraction must be in (0, 0.05]".to_string());
    }
    if !(0.0..=1.0).contains(&candidate.entry_threshold) {
        errors.push("entry_threshold must be in [0, 1]".to_string());
    }
    if !(0.1..=20.0).contains(&candidate.stop_loss_pct) {
        errors.push("stop_loss_pct must be in 0.1..=20".to_string());
    }
    if !(0.1..=40.0).contains(&candidate.take_profit_pct) {
        errors.push("take_profit_pct must be in 0.1..=40".to_string());
    }
    if !(0.1..=5.0).contains(&candidate.max_drawdown_pct) {
        errors.push("max_drawdown_pct must be in 0.1..=5".to_string());
    }
    if !candidate.requires_holdout {
        errors.push("requires_holdout must be true".to_string());
    }
    if !candidate.no_live_keys {
        errors.push("no_live_keys must be true".to_string());
    }
    if !candidate.rationale.to_lowercase().contains("holdout")
        && !candidate.rationale.to_lowercase().contains("held-out")
    {
        errors.push("rationale must mention holdout validation".to_string());
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; ").into())
    }
}

fn rsi_condition(candidate: &CandidateSpec) -> EntryCondition {
    if candidate.rsi_condition == "above" {
        EntryCondition::Above {
            threshold: candidate.rsi_below,
        }
    } else {
        EntryCondition::Below {
            threshold: candidate.rsi_below,
        }
    }
}

fn ema_condition(candidate: &CandidateSpec) -> EntryCondition {
    if candidate.ema_condition == "cross_below" {
        EntryCondition::CrossBelow
    } else {
        EntryCondition::CrossAbove
    }
}

async fn fetch_market(client: &reqwest::Client) -> Result<GammaMarket, Box<dyn std::error::Error>> {
    let markets = client
        .get("https://gamma-api.polymarket.com/markets")
        .query(&[("closed", "false"), ("active", "true"), ("limit", "20")])
        .send()
        .await?
        .error_for_status()?
        .json::<Vec<GammaMarket>>()
        .await?;
    markets
        .into_iter()
        .find(|m| !first_clob_token(&m.clob_token_ids).is_empty())
        .ok_or_else(|| "no active Polymarket CLOB markets returned".into())
}

async fn fetch_price_history(
    client: &reqwest::Client,
    token_id: &str,
    interval: &str,
    fidelity_minutes: u32,
) -> Result<Vec<PricePoint>, Box<dyn std::error::Error>> {
    let history = client
        .get("https://clob.polymarket.com/prices-history")
        .query(&[
            ("market", token_id),
            ("interval", interval),
            ("fidelity", &fidelity_minutes.to_string()),
        ])
        .send()
        .await?
        .error_for_status()?
        .json::<PriceHistory>()
        .await?;
    Ok(history.history)
}

fn candle_from_point(token: &str, point: PricePoint) -> Option<Candle> {
    if !point.p.is_finite() || point.p <= 0.0 {
        return None;
    }
    let price = Decimal::from_str(&format!("{:.8}", point.p)).ok()?;
    Some(Candle {
        timestamp: point.t,
        token: token.to_string(),
        open: price,
        high: price,
        low: price,
        close: price,
        volume: Decimal::ONE,
    })
}

fn first_clob_token(raw: &str) -> String {
    serde_json::from_str::<Vec<String>>(raw)
        .ok()
        .and_then(|tokens| tokens.into_iter().next())
        .unwrap_or_else(|| raw.trim_matches(['[', ']', '"']).to_string())
}
