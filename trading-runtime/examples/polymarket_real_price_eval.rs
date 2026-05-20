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
struct RealPolymarketEvalReport {
    suite: String,
    source: String,
    market_id: String,
    condition_id: String,
    slug: String,
    question: String,
    clob_token_id: String,
    interval: String,
    fidelity_minutes: u32,
    candles: usize,
    train_candles: usize,
    test_candles: usize,
    current_return_pct: f64,
    candidate_return_pct: f64,
    return_delta_pct: f64,
    candidate_sharpe: f64,
    candidate_max_drawdown_pct: f64,
    candidate_trades: u64,
    should_promote: bool,
    likely_overfit: bool,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut out: Option<PathBuf> = None;
    let mut interval = env::var("POLYMARKET_PRICE_INTERVAL").unwrap_or_else(|_| "1d".into());
    let mut fidelity_minutes = env::var("POLYMARKET_PRICE_FIDELITY")
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(5);
    let mut token_id = env::var("POLYMARKET_CLOB_TOKEN_ID").ok();

    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
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
                    "usage: cargo run -p trading-runtime --example polymarket_real_price_eval -- [--out <path>] [--interval 1d] [--fidelity 5] [--token-id <clob-token-id>]"
                );
                return Ok(());
            }
            other => return Err(format!("unknown argument: {other}").into()),
        }
    }

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
    if candles.len() < 32 {
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
    let candidate = BacktestConfig {
        initial_capital: Decimal::new(1_000, 0),
        harness: HarnessConfig {
            version: 1,
            entry_rules: vec![
                EntryRule {
                    signal: SignalType::Rsi { period: 6 },
                    condition: EntryCondition::Below { threshold: 42.0 },
                    weight: 0.6,
                    tokens: vec![],
                },
                EntryRule {
                    signal: SignalType::EmaCross {
                        short_period: 4,
                        long_period: 12,
                    },
                    condition: EntryCondition::CrossAbove,
                    weight: 0.4,
                    tokens: vec![],
                },
            ],
            exit_rules: vec![
                ExitRule::StopLoss { pct: 12.0 },
                ExitRule::TakeProfit { pct: 18.0 },
            ],
            filters: vec![],
            position_sizing: PositionSizing::FixedFraction { fraction: 0.08 },
            entry_threshold: 0.35,
            max_positions: 1,
        },
        slippage: SlippageModel::FixedBps { bps: 25 },
        gas_cost_usd: Decimal::ZERO,
        taker_fee_bps: 0,
    };

    let walk = BacktestEngine::walk_forward_compare(&current, &candidate, &candles, &[], 0.65)?;
    let report = RealPolymarketEvalReport {
        suite: "real-polymarket-price-history".into(),
        source: "gamma-api.polymarket.com + clob.polymarket.com/prices-history".into(),
        market_id: market.id,
        condition_id: market.condition_id,
        slug: market.slug,
        question: market.question,
        clob_token_id: selected_token,
        interval,
        fidelity_minutes,
        candles: candles.len(),
        train_candles: walk.train_candles,
        test_candles: walk.test_candles,
        current_return_pct: walk.test.current.stats.total_return_pct,
        candidate_return_pct: walk.test.candidate.stats.total_return_pct,
        return_delta_pct: walk.test.candidate.stats.total_return_pct
            - walk.test.current.stats.total_return_pct,
        candidate_sharpe: walk.test.candidate.stats.sharpe_ratio,
        candidate_max_drawdown_pct: walk.test.candidate.stats.max_drawdown_pct,
        candidate_trades: walk.test.candidate.stats.total_trades,
        should_promote: walk.should_promote,
        likely_overfit: walk.likely_overfit,
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

    Ok(())
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

fn first_clob_token(raw: &str) -> String {
    serde_json::from_str::<Vec<String>>(raw)
        .ok()
        .and_then(|tokens| tokens.into_iter().next())
        .unwrap_or_default()
}

fn candle_from_point(token: &str, point: PricePoint) -> Option<Candle> {
    let price = Decimal::from_str(&format!("{:.6}", point.p)).ok()?;
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
