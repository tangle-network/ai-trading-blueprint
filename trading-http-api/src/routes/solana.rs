//! Solana venue routes — Jupiter (DEX aggregator) and Drift v2 (perps).
//!
//! Like the Hyperliquid native routes, these endpoints are *off-chain
//! envelope* — gating runs server-side via the bot's signed envelope
//! before any tx reaches the wire. There is no on-chain envelope contract
//! for Solana.
//!
//! ## Routes
//!
//! - `POST /solana/jupiter/quote`  — fetch a Jupiter swap quote.
//! - `POST /solana/jupiter/swap`   — gate, sign, and submit a Jupiter swap.
//! - `POST /solana/drift/order`    — gate, sign, and submit a Drift place_perp_order.
//! - `GET  /solana/account/{pubkey}` — lamports + sanity-checked balances.
//! - `GET  /solana/balances`        — operator-wallet lamports balance.
//!
//! The Solana operator keypair is loaded once from the
//! `SOLANA_OPERATOR_PRIVATE_KEY` env var, parsed lazily, and held in a
//! `OnceLock` mirroring the Hyperliquid client pattern.

use std::str::FromStr;
use std::sync::Arc;

use axum::extract::{Extension, Path, State};
use axum::http::StatusCode;
use axum::{
    Json, Router,
    routing::{get, post},
};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use solana_sdk::compute_budget::ComputeBudgetInstruction;
use solana_sdk::instruction::Instruction;
use solana_sdk::message::VersionedMessage;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::Keypair;
use solana_sdk::signer::Signer;
use solana_sdk::transaction::VersionedTransaction;

use trading_runtime::envelope::check::{
    PerpsContext, UniversalContext, VaultContext, check_perps, check_universal, check_vault,
};
use trading_runtime::solana::client::SolanaClient;
use trading_runtime::solana::drift::{
    DriftOrderParams, DriftOrderRequest, DriftPlacePerpOrderAccounts, build_place_perp_order_ix,
};
use trading_runtime::solana::jupiter::JupiterVenue;
use trading_runtime::solana::keys::load_operator_keypair_from_env;
use trading_runtime::solana::{SolanaQuote, SolanaQuoteRequest, SolanaVenue};

use crate::{BotContext, MultiBotTradingState};

// ── Lazy-initialized state ──────────────────────────────────────────────────

use std::sync::OnceLock;

static SOLANA_RPC: OnceLock<SolanaClient> = OnceLock::new();
static OPERATOR_KEYPAIR: OnceLock<Keypair> = OnceLock::new();

const SOLANA_RPC_URL_ENV: &str = "SOLANA_RPC_URL";
const DEFAULT_SOLANA_RPC_URL: &str = "https://api.mainnet-beta.solana.com";

fn rpc_client() -> &'static SolanaClient {
    SOLANA_RPC.get_or_init(|| {
        let url = std::env::var(SOLANA_RPC_URL_ENV)
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| DEFAULT_SOLANA_RPC_URL.to_string());
        SolanaClient::new(url)
    })
}

/// Legacy single-tenant operator keypair (env-driven, cached).
///
/// Used only by `get_operator_balances`, which is an operator-wide endpoint
/// without a `BotContext` to scope a per-bot key against. Per-bot trading
/// handlers MUST use [`resolve_keypair_for_bot`] instead so each tenant
/// signs with its own credentials.
fn operator_keypair() -> Result<&'static Keypair, (StatusCode, String)> {
    if let Some(kp) = OPERATOR_KEYPAIR.get() {
        return Ok(kp);
    }
    let kp = load_operator_keypair_from_env().map_err(<(StatusCode, String)>::from)?;
    let _ = OPERATOR_KEYPAIR.set(kp);
    OPERATOR_KEYPAIR.get().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "operator keypair race".into(),
    ))
}

/// Audit fix: resolve the Solana operator keypair *per bot* via the
/// configured [`trading_runtime::cex::CexKeyProvider`]. The legacy global
/// `OPERATOR_KEYPAIR` `OnceLock` is preserved as a fallback that the default
/// `EnvKeyProvider` uses, so single-tenant env-driven deployments keep
/// working unchanged.
///
/// Returns 412 PRECONDITION FAILED when the bot has no configured key.
fn resolve_keypair_for_bot(
    state: &MultiBotTradingState,
    bot: &BotContext,
) -> Result<Keypair, (StatusCode, String)> {
    state
        .key_provider
        .solana_keypair(&bot.bot_id)
        .ok_or_else(|| {
            (
                StatusCode::PRECONDITION_FAILED,
                format!(
                    "no Solana operator key configured for bot {}; push credentials via the secrets API before trading",
                    bot.bot_id
                ),
            )
        })
}

// ── Wire types ──────────────────────────────────────────────────────────────

/// `POST /solana/jupiter/quote` — request body.
#[derive(Debug, Deserialize)]
pub struct JupiterQuoteHttpRequest {
    /// Input mint as a base58 pubkey string.
    pub input_mint: String,
    /// Output mint as a base58 pubkey string.
    pub output_mint: String,
    /// Atoms of `input_mint` to spend.
    pub amount_in: u64,
    /// Maximum allowed slippage in basis points.
    pub slippage_bps: u16,
}

/// `POST /solana/jupiter/swap` — request body.
///
/// We accept the full [`SolanaQuote`] payload rather than a synthetic
/// `quote_id`. Jupiter's API is itself stateless: it expects the full
/// `quoteResponse` JSON to be re-submitted. The dApp's caller flow is
/// `/quote` → `/swap`, with the agent passing the quote response back
/// verbatim. (See module docs for `solana::jupiter` for the rationale.)
#[derive(Debug, Deserialize)]
pub struct JupiterSwapHttpRequest {
    pub quote: SolanaQuote,
    /// USD valuation of the trade for envelope universal-policy gating.
    /// The agent computes this off-chain from a price oracle.
    pub trade_size_usd: String,
    /// Current total exposure in USD, for the universal-policy check.
    #[serde(default)]
    pub current_total_exposure_usd: String,
    /// Whether this is opening or closing a position.
    pub is_open: bool,
}

/// `POST /solana/drift/order` — request body.
#[derive(Debug, Deserialize)]
pub struct DriftOrderHttpRequest {
    #[serde(flatten)]
    pub order: DriftOrderRequest,
    /// USD valuation for envelope universal-policy gating.
    pub trade_size_usd: String,
    #[serde(default)]
    pub current_total_exposure_usd: String,
    pub is_open: bool,
    /// Drift `User` PDA for the operator. The bot derives this once
    /// during onboarding; the route doesn't re-derive it.
    pub drift_user_pda: String,
    /// Drift program global state account.
    pub drift_state: String,
}

/// Generic submit response.
#[derive(Debug, Serialize)]
pub struct SolanaSubmitResponse {
    pub status: &'static str,
    pub signature: String,
    pub venue: &'static str,
}

#[derive(Debug, Serialize)]
pub struct AccountInfoResponse {
    pub pubkey: String,
    pub lamports: u64,
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn parse_pubkey(field: &str, raw: &str) -> Result<Pubkey, (StatusCode, String)> {
    Pubkey::from_str(raw.trim()).map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("invalid {field} pubkey '{raw}': {e}"),
        )
    })
}

fn parse_decimal(field: &str, raw: &str) -> Result<Decimal, (StatusCode, String)> {
    if raw.trim().is_empty() {
        return Ok(Decimal::ZERO);
    }
    Decimal::from_str(raw.trim()).map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("invalid {field} '{raw}': {e}"),
        )
    })
}

fn reject_when_paper_trade(bot: &BotContext) -> Result<(), (StatusCode, String)> {
    if bot.paper_trade {
        return Err((
            StatusCode::FORBIDDEN,
            "Solana venue not supported in paper-trade mode (no on-chain simulation hook)".into(),
        ));
    }
    Ok(())
}

// ── Audit fix (HIGH/CRITICAL): quote tampering & fee-payer guards ──────────

/// Audit fix (CRITICAL): the typed `SolanaQuote` is what we gate against,
/// but `quote.raw` is what we forward to Jupiter `/swap`. An attacker could
/// craft a `SolanaQuote` whose typed mints/amounts pass the vault gate
/// while `raw` points to a different swap. Reject any mismatch before
/// signing.
///
/// We compare the *typed* fields against the matching keys in `quote.raw`:
/// `inputMint`, `outputMint`, `inAmount`, `otherAmountThreshold`. Jupiter
/// quote responses always include these; if they're missing the request is
/// malformed and we reject for safety.
fn validate_quote_self_consistent(quote: &SolanaQuote) -> Result<(), (StatusCode, String)> {
    let bad = |reason: &str| -> (StatusCode, String) {
        (
            StatusCode::BAD_REQUEST,
            format!("Solana quote self-consistency check failed: {reason}"),
        )
    };

    let raw = quote
        .raw
        .as_object()
        .ok_or_else(|| bad("raw is not a JSON object"))?;

    let raw_input = raw
        .get("inputMint")
        .and_then(|v| v.as_str())
        .ok_or_else(|| bad("raw.inputMint missing"))?;
    if raw_input != quote.input_mint.to_string() {
        return Err(bad("typed input_mint != raw.inputMint"));
    }

    let raw_output = raw
        .get("outputMint")
        .and_then(|v| v.as_str())
        .ok_or_else(|| bad("raw.outputMint missing"))?;
    if raw_output != quote.output_mint.to_string() {
        return Err(bad("typed output_mint != raw.outputMint"));
    }

    let raw_in = raw
        .get("inAmount")
        .and_then(|v| v.as_str())
        .ok_or_else(|| bad("raw.inAmount missing or non-string"))?;
    if raw_in != quote.in_amount.to_string() {
        return Err(bad("typed in_amount != raw.inAmount"));
    }

    let raw_threshold = raw
        .get("otherAmountThreshold")
        .and_then(|v| v.as_str())
        .ok_or_else(|| bad("raw.otherAmountThreshold missing or non-string"))?;
    if raw_threshold != quote.other_amount_threshold.to_string() {
        return Err(bad(
            "typed other_amount_threshold != raw.otherAmountThreshold",
        ));
    }

    Ok(())
}

/// Audit fix (HIGH): before signing the Jupiter-supplied unsigned tx,
/// confirm that:
///   1. The fee payer (account index 0 in Solana's static account keys)
///      is the operator pubkey. If Jupiter were compromised it could
///      return a tx whose fee payer is the *attacker* — signing it would
///      attach the operator's signature to an arbitrary instruction set.
///   2. The operator pubkey appears as the first signer.
///
/// Both checks reduce blind-trust in Jupiter to "Jupiter can choose which
/// instructions go in *the operator's* tx", which is what we already gate
/// against via the universal/vault policy checks.
fn assert_jupiter_tx_payer_is_operator(
    tx: &VersionedTransaction,
    operator: &Pubkey,
) -> Result<(), (StatusCode, String)> {
    let bad = |reason: String| -> (StatusCode, String) {
        (
            StatusCode::BAD_REQUEST,
            format!("Jupiter swap tx rejected: {reason}"),
        )
    };

    let static_keys = match &tx.message {
        VersionedMessage::Legacy(m) => &m.account_keys,
        VersionedMessage::V0(m) => &m.account_keys,
    };
    let header = match &tx.message {
        VersionedMessage::Legacy(m) => &m.header,
        VersionedMessage::V0(m) => &m.header,
    };

    if header.num_required_signatures == 0 {
        return Err(bad("tx has no required signers".into()));
    }

    let payer = static_keys
        .first()
        .ok_or_else(|| bad("tx has no static account keys".into()))?;
    if payer != operator {
        return Err(bad(format!(
            "fee payer {payer} != operator {operator}; refusing to sign"
        )));
    }

    Ok(())
}

/// Audit fix (HIGH): Drift `place_perp_order` is heavy (200K-400K CUs on a
/// busy slot). The default per-ix limit is 200K, so the tx can silently
/// fail with `ComputeBudgetExceeded`. Without a priority fee the tx may
/// also be dropped during congestion. Prepend two compute-budget ixs.
const DRIFT_DEFAULT_COMPUTE_UNIT_LIMIT: u32 = 400_000;
const DRIFT_DEFAULT_PRIORITY_FEE_MICROLAMPORTS: u64 = 50_000;

fn drift_compute_budget_ixs() -> [Instruction; 2] {
    let cu_limit = std::env::var("DRIFT_COMPUTE_UNIT_LIMIT")
        .ok()
        .and_then(|raw| raw.parse::<u32>().ok())
        .unwrap_or(DRIFT_DEFAULT_COMPUTE_UNIT_LIMIT);
    let priority = std::env::var("DRIFT_PRIORITY_FEE_MICROLAMPORTS")
        .ok()
        .and_then(|raw| raw.parse::<u64>().ok())
        .unwrap_or(DRIFT_DEFAULT_PRIORITY_FEE_MICROLAMPORTS);
    [
        ComputeBudgetInstruction::set_compute_unit_limit(cu_limit),
        ComputeBudgetInstruction::set_compute_unit_price(priority),
    ]
}

// ── Handlers ────────────────────────────────────────────────────────────────

async fn jupiter_quote(
    State(state): State<Arc<MultiBotTradingState>>,
    Extension(bot): Extension<BotContext>,
    Json(req): Json<JupiterQuoteHttpRequest>,
) -> Result<Json<SolanaQuote>, (StatusCode, String)> {
    let input_mint = parse_pubkey("input_mint", &req.input_mint)?;
    let output_mint = parse_pubkey("output_mint", &req.output_mint)?;

    let kp = resolve_keypair_for_bot(&state, &bot)?;
    let venue = JupiterVenue::new(rpc_client().clone()).map_err(<(StatusCode, String)>::from)?;
    let quote_req = SolanaQuoteRequest {
        input_mint,
        output_mint,
        amount: req.amount_in,
        slippage_bps: req.slippage_bps,
        user_public_key: kp.pubkey(),
    };
    let quote = venue
        .quote(&quote_req)
        .await
        .map_err(<(StatusCode, String)>::from)?;
    Ok(Json(quote))
}

async fn jupiter_swap(
    State(state): State<Arc<MultiBotTradingState>>,
    Extension(bot): Extension<BotContext>,
    Json(req): Json<JupiterSwapHttpRequest>,
) -> Result<Json<SolanaSubmitResponse>, (StatusCode, String)> {
    reject_when_paper_trade(&bot)?;

    // Audit fix (CRITICAL): the typed quote drives policy gates while
    // `quote.raw` is what we send to Jupiter `/swap`. They MUST agree on
    // mint identity and amounts or the gate is bypassed.
    validate_quote_self_consistent(&req.quote)?;

    let trade_size_usd = parse_decimal("trade_size_usd", &req.trade_size_usd)?;
    let current_exposure = parse_decimal(
        "current_total_exposure_usd",
        &req.current_total_exposure_usd,
    )?;

    let _ = state; // gated by per-bot envelope store, not multi-bot state.
    let envelope = super::envelope::get_signed_envelope(&bot.bot_id).ok_or((
        StatusCode::FORBIDDEN,
        "No signed envelope on file for this bot — cannot gate Solana swap".to_string(),
    ))?;

    // Universal gating runs first.
    check_universal(
        &envelope.policy,
        &UniversalContext {
            trade_size_usd,
            current_total_exposure_usd: current_exposure,
            is_open: req.is_open,
        },
    )
    .map_err(<(StatusCode, String)>::from)?;

    // Vault-style gating: Jupiter is a DEX aggregator, so we treat it as
    // a vault-policy swap. Slippage is enforced by Jupiter's
    // `otherAmountThreshold`; surface the realised value to the policy
    // for transparency.
    let realised_slippage_bps = bps_between(req.quote.in_amount, req.quote.other_amount_threshold);
    if req.is_open {
        check_vault(
            &envelope.policy,
            &VaultContext {
                protocol: "jupiter",
                token_in: &req.quote.input_mint.to_string(),
                token_out: &req.quote.output_mint.to_string(),
                slippage_bps: realised_slippage_bps,
            },
        )
        .map_err(<(StatusCode, String)>::from)?;
    }

    let kp = resolve_keypair_for_bot(&state, &bot)?;
    let venue = JupiterVenue::new(rpc_client().clone()).map_err(<(StatusCode, String)>::from)?;
    let unsigned = venue
        .build_swap_tx(&req.quote, kp.pubkey())
        .await
        .map_err(<(StatusCode, String)>::from)?;

    // Audit fix (HIGH): defense-in-depth before signing — confirm Jupiter's
    // returned tx names the operator as fee-payer & first signer.
    assert_jupiter_tx_payer_is_operator(&unsigned, &kp.pubkey())?;

    // Audit fix (HIGH): bounded blockhash-expiry retry. Jupiter's swap tx
    // already carries a recent blockhash; on `BlockhashExpired` we
    // re-target the existing message at a fresh blockhash and re-sign in
    // place rather than re-quoting Jupiter (which would risk price drift).
    // Retry is bounded to 1 attempt — see `SolanaClient::submit_with_retry`.
    let sig = rpc_client()
        .submit_with_retry(|fresh_blockhash| {
            let mut new_msg = unsigned.message.clone();
            match &mut new_msg {
                VersionedMessage::Legacy(m) => {
                    m.recent_blockhash = fresh_blockhash;
                }
                VersionedMessage::V0(m) => {
                    m.recent_blockhash = fresh_blockhash;
                }
            }
            VersionedTransaction::try_new(new_msg, &[&kp]).map_err(|e| {
                trading_runtime::solana::error::SolanaError::RpcFailed(format!(
                    "re-sign jupiter swap tx after blockhash refresh: {e}"
                ))
            })
        })
        .await
        .map_err(<(StatusCode, String)>::from)?;

    Ok(Json(SolanaSubmitResponse {
        status: "submitted",
        signature: sig.to_string(),
        venue: "jupiter",
    }))
}

async fn drift_order(
    State(state): State<Arc<MultiBotTradingState>>,
    Extension(bot): Extension<BotContext>,
    Json(req): Json<DriftOrderHttpRequest>,
) -> Result<Json<SolanaSubmitResponse>, (StatusCode, String)> {
    reject_when_paper_trade(&bot)?;

    let trade_size_usd = parse_decimal("trade_size_usd", &req.trade_size_usd)?;
    let current_exposure = parse_decimal(
        "current_total_exposure_usd",
        &req.current_total_exposure_usd,
    )?;
    let drift_state = parse_pubkey("drift_state", &req.drift_state)?;
    let drift_user_pda = parse_pubkey("drift_user_pda", &req.drift_user_pda)?;

    let _ = state; // gated by per-bot envelope store, not multi-bot state.
    let envelope = super::envelope::get_signed_envelope(&bot.bot_id).ok_or((
        StatusCode::FORBIDDEN,
        "No signed envelope on file for this bot — cannot gate Drift order".to_string(),
    ))?;

    check_universal(
        &envelope.policy,
        &UniversalContext {
            trade_size_usd,
            current_total_exposure_usd: current_exposure,
            is_open: req.is_open,
        },
    )
    .map_err(<(StatusCode, String)>::from)?;

    if req.is_open {
        let asset = drift_market_label(req.order.market_index);
        // Drift orders supply their own price (limit) or rely on oracle
        // (market). `leverage` is implicit in Drift's collateralised
        // margin; we treat each placement as 1x for the perps policy
        // unless the bot's strategy_config provides a higher figure.
        let leverage: u32 = bot
            .strategy_config
            .get("drift_leverage")
            .and_then(|v| v.as_u64())
            .unwrap_or(1) as u32;
        check_perps(
            &envelope.policy,
            &PerpsContext {
                asset,
                leverage,
                stop_loss_distance: None,
            },
        )
        .map_err(<(StatusCode, String)>::from)?;
    }

    let kp = resolve_keypair_for_bot(&state, &bot)?;
    let params = DriftOrderParams::new_perp_order(
        req.order.market_index,
        req.order.direction,
        req.order.order_type,
        req.order.base_amount,
        req.order.price,
        req.order.reduce_only,
    );
    let ix = build_place_perp_order_ix(
        &DriftPlacePerpOrderAccounts {
            state: drift_state,
            user: drift_user_pda,
            authority: kp.pubkey(),
        },
        &params,
    )
    .map_err(<(StatusCode, String)>::from)?;

    // Audit fix (HIGH): prepend compute-budget ixs. Without these, Drift's
    // `place_perp_order` ix can blow past the default 200K CU limit on
    // busy slots, and a zero priority-fee tx is dropped during
    // congestion.
    let cb = drift_compute_budget_ixs();
    let ixs = [cb[0].clone(), cb[1].clone(), ix];

    // Audit fix (HIGH): bounded blockhash-expiry retry. The closure
    // re-compiles the Drift tx against the fresh blockhash on retry —
    // ixs (incl. compute budget) and accounts are stable, only the
    // recent_blockhash anchor changes. Retry bounded to 1 attempt.
    let sig = rpc_client()
        .submit_with_retry(|blockhash| {
            let msg =
                solana_sdk::message::v0::Message::try_compile(&kp.pubkey(), &ixs, &[], blockhash)
                    .map_err(|e| {
                        trading_runtime::solana::error::SolanaError::RpcFailed(format!(
                            "compile drift tx: {e}"
                        ))
                    })?;
            VersionedTransaction::try_new(VersionedMessage::V0(msg), &[&kp]).map_err(|e| {
                trading_runtime::solana::error::SolanaError::RpcFailed(format!(
                    "sign drift tx: {e}"
                ))
            })
        })
        .await
        .map_err(<(StatusCode, String)>::from)?;

    Ok(Json(SolanaSubmitResponse {
        status: "submitted",
        signature: sig.to_string(),
        venue: "drift",
    }))
}

async fn get_account(
    State(_state): State<Arc<MultiBotTradingState>>,
    Path(pubkey): Path<String>,
) -> Result<Json<AccountInfoResponse>, (StatusCode, String)> {
    let key = parse_pubkey("pubkey", &pubkey)?;
    let lamports = rpc_client()
        .lamports(&key)
        .await
        .map_err(<(StatusCode, String)>::from)?;
    Ok(Json(AccountInfoResponse {
        pubkey: key.to_string(),
        lamports,
    }))
}

async fn get_operator_balances(
    State(_state): State<Arc<MultiBotTradingState>>,
) -> Result<Json<AccountInfoResponse>, (StatusCode, String)> {
    let kp = operator_keypair()?;
    let lamports = rpc_client()
        .lamports(&kp.pubkey())
        .await
        .map_err(<(StatusCode, String)>::from)?;
    Ok(Json(AccountInfoResponse {
        pubkey: kp.pubkey().to_string(),
        lamports,
    }))
}

// ── Drift symbol mapping ─────────────────────────────────────────────────────

fn drift_market_label(index: u16) -> &'static str {
    use trading_runtime::solana::drift::{
        MARKET_INDEX_BTC_PERP, MARKET_INDEX_ETH_PERP, MARKET_INDEX_SOL_PERP,
    };
    match index {
        MARKET_INDEX_SOL_PERP => "SOL",
        MARKET_INDEX_BTC_PERP => "BTC",
        MARKET_INDEX_ETH_PERP => "ETH",
        _ => "UNKNOWN",
    }
}

// ── bps helper ──────────────────────────────────────────────────────────────

/// Compute `(in - out_threshold) / in` in basis points, capped at u32.
fn bps_between(in_amount: u64, out_threshold: u64) -> u32 {
    if in_amount == 0 || out_threshold >= in_amount {
        return 0;
    }
    let delta = in_amount - out_threshold;
    // bps = delta * 10_000 / in_amount; saturate at u32::MAX to be safe.
    let bps = (u128::from(delta) * 10_000) / u128::from(in_amount);
    bps.try_into().unwrap_or(u32::MAX)
}

// ── Router ──────────────────────────────────────────────────────────────────

pub fn multi_bot_router() -> Router<Arc<MultiBotTradingState>> {
    Router::new()
        .route("/solana/jupiter/quote", post(jupiter_quote))
        .route("/solana/jupiter/swap", post(jupiter_swap))
        .route("/solana/drift/order", post(drift_order))
        .route("/solana/account/{pubkey}", get(get_account))
        .route("/solana/balances", get(get_operator_balances))
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use trading_runtime::solana::drift::{
        DriftDirection as DD, DriftOrderType as DOT, MARKET_INDEX_BTC_PERP, MARKET_INDEX_ETH_PERP,
        MARKET_INDEX_SOL_PERP,
    };

    #[test]
    fn drift_market_label_known() {
        assert_eq!(drift_market_label(MARKET_INDEX_SOL_PERP), "SOL");
        assert_eq!(drift_market_label(MARKET_INDEX_BTC_PERP), "BTC");
        assert_eq!(drift_market_label(MARKET_INDEX_ETH_PERP), "ETH");
        assert_eq!(drift_market_label(999), "UNKNOWN");
    }

    #[test]
    fn bps_between_zero_inputs_safe() {
        assert_eq!(bps_between(0, 0), 0);
        assert_eq!(bps_between(0, 100), 0);
    }

    #[test]
    fn bps_between_threshold_above_input_yields_zero() {
        // out_threshold > in_amount means slippage protection over-shoots —
        // treat as 0 bps for downstream sanity.
        assert_eq!(bps_between(1_000_000, 1_500_000), 0);
        assert_eq!(bps_between(1_000_000, 1_000_000), 0);
    }

    #[test]
    fn bps_between_typical() {
        // 100 in, 99 out → 1% slippage = 100 bps.
        assert_eq!(bps_between(100, 99), 100);
        // 10000 in, 9950 out → 0.5% = 50 bps.
        assert_eq!(bps_between(10_000, 9_950), 50);
    }

    #[test]
    fn parse_pubkey_rejects_garbage() {
        let err = parse_pubkey("input_mint", "not a key").unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn parse_decimal_accepts_blank() {
        assert_eq!(parse_decimal("x", "").unwrap(), Decimal::ZERO);
        assert_eq!(parse_decimal("x", "   ").unwrap(), Decimal::ZERO);
    }

    #[test]
    fn parse_decimal_rejects_garbage() {
        let err = parse_decimal("trade_size_usd", "not a number").unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
    }

    fn make_quote(
        input_mint: &Pubkey,
        output_mint: &Pubkey,
        in_amt: u64,
        threshold: u64,
    ) -> SolanaQuote {
        SolanaQuote {
            venue: "jupiter".into(),
            input_mint: *input_mint,
            output_mint: *output_mint,
            in_amount: in_amt,
            out_amount: in_amt - 1,
            other_amount_threshold: threshold,
            price_impact_pct: 0.001,
            raw: serde_json::json!({
                "inputMint": input_mint.to_string(),
                "outputMint": output_mint.to_string(),
                "inAmount": in_amt.to_string(),
                "outAmount": (in_amt - 1).to_string(),
                "otherAmountThreshold": threshold.to_string(),
                "priceImpactPct": "0.001",
                "swapMode": "ExactIn",
                "routePlan": []
            }),
        }
    }

    /// Audit fix (CRITICAL): the typed `SolanaQuote` is what we gate
    /// against, but `quote.raw` is forwarded verbatim to Jupiter `/swap`.
    /// Mismatched fields can be exploited to bypass the vault gate.
    #[test]
    fn validate_quote_self_consistent_passes_for_matched_quote() {
        let a = Pubkey::new_unique();
        let b = Pubkey::new_unique();
        let q = make_quote(&a, &b, 1_000_000, 990_000);
        validate_quote_self_consistent(&q).expect("matched quote must pass");
    }

    #[test]
    fn validate_quote_self_consistent_rejects_mint_swap() {
        let a = Pubkey::new_unique();
        let b = Pubkey::new_unique();
        let mut q = make_quote(&a, &b, 1_000_000, 990_000);
        // Attacker swaps the typed mint while leaving the raw mint intact —
        // the raw mint is what Jupiter actually swaps.
        q.input_mint = Pubkey::new_unique();
        let err = validate_quote_self_consistent(&q).expect_err("must reject");
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert!(err.1.contains("input_mint"), "{}", err.1);
    }

    #[test]
    fn validate_quote_self_consistent_rejects_inflated_in_amount() {
        let a = Pubkey::new_unique();
        let b = Pubkey::new_unique();
        let mut q = make_quote(&a, &b, 1_000_000, 990_000);
        // Typed in_amount is what the universal/vault check uses; raw is
        // what Jupiter swaps. Diverging the two is an exploit.
        q.in_amount = 1; // tiny typed value, real swap is 1M
        let err = validate_quote_self_consistent(&q).expect_err("must reject");
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert!(err.1.contains("in_amount"), "{}", err.1);
    }

    #[test]
    fn validate_quote_self_consistent_rejects_threshold_tampering() {
        let a = Pubkey::new_unique();
        let b = Pubkey::new_unique();
        let mut q = make_quote(&a, &b, 1_000_000, 990_000);
        q.other_amount_threshold = 1_000_000; // 0 bps slippage on the typed
        // copy, but raw still says 990_000 — Jupiter executes at 1% slippage
        // while the policy thinks slippage is 0 bps.
        let err = validate_quote_self_consistent(&q).expect_err("must reject");
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert!(err.1.contains("other_amount_threshold"), "{}", err.1);
    }

    #[test]
    fn validate_quote_self_consistent_rejects_non_object_raw() {
        let a = Pubkey::new_unique();
        let b = Pubkey::new_unique();
        let mut q = make_quote(&a, &b, 1_000_000, 990_000);
        q.raw = serde_json::json!("not an object");
        let err = validate_quote_self_consistent(&q).expect_err("must reject");
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
    }

    /// Audit fix (HIGH): if Jupiter returned a tx whose fee payer is not
    /// the operator, signing it would attach the operator's signature to
    /// arbitrary instructions. Reject before signing.
    #[test]
    fn assert_jupiter_tx_payer_rejects_foreign_payer() {
        use solana_sdk::message::MessageHeader;
        use solana_sdk::message::v0::Message as V0Message;

        let operator = Pubkey::new_unique();
        let attacker = Pubkey::new_unique();

        let header = MessageHeader {
            num_required_signatures: 1,
            num_readonly_signed_accounts: 0,
            num_readonly_unsigned_accounts: 0,
        };
        let msg = V0Message {
            header,
            account_keys: vec![attacker],
            recent_blockhash: solana_sdk::hash::Hash::default(),
            instructions: vec![],
            address_table_lookups: vec![],
        };
        let tx = VersionedTransaction {
            signatures: vec![Default::default()],
            message: VersionedMessage::V0(msg),
        };
        let err = assert_jupiter_tx_payer_is_operator(&tx, &operator)
            .expect_err("foreign payer must be rejected");
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert!(err.1.contains("fee payer"), "{}", err.1);
    }

    #[test]
    fn assert_jupiter_tx_payer_accepts_operator_payer() {
        use solana_sdk::message::MessageHeader;
        use solana_sdk::message::v0::Message as V0Message;

        let operator = Pubkey::new_unique();
        let header = MessageHeader {
            num_required_signatures: 1,
            num_readonly_signed_accounts: 0,
            num_readonly_unsigned_accounts: 0,
        };
        let msg = V0Message {
            header,
            account_keys: vec![operator],
            recent_blockhash: solana_sdk::hash::Hash::default(),
            instructions: vec![],
            address_table_lookups: vec![],
        };
        let tx = VersionedTransaction {
            signatures: vec![Default::default()],
            message: VersionedMessage::V0(msg),
        };
        assert_jupiter_tx_payer_is_operator(&tx, &operator)
            .expect("operator-as-payer must be accepted");
    }

    /// Audit fix (HIGH): verify compute-budget ixs are produced and have
    /// the right discriminators. We don't assert exact CU/priority values
    /// because they're env-overridable, but we do assert there are exactly
    /// two compute-budget ixs and they're of the expected variants.
    #[test]
    fn drift_compute_budget_ixs_emit_limit_then_price() {
        let ixs = drift_compute_budget_ixs();
        // Compute-budget program id is fixed.
        let cb_pid = solana_sdk::compute_budget::id();
        assert_eq!(ixs[0].program_id, cb_pid);
        assert_eq!(ixs[1].program_id, cb_pid);
        // The first byte of the data is the variant discriminator.
        // SetComputeUnitLimit = 2, SetComputeUnitPrice = 3 (per
        // ComputeBudgetInstruction enum).
        assert_eq!(ixs[0].data[0], 2, "first ix must be SetComputeUnitLimit");
        assert_eq!(ixs[1].data[0], 3, "second ix must be SetComputeUnitPrice");
    }

    #[test]
    fn drift_order_request_serde_flatten_compatible() {
        // Ensure our route's HTTP body shape can deserialize the
        // upstream DriftOrderRequest fields via serde(flatten).
        let body = serde_json::json!({
            "market_index": MARKET_INDEX_SOL_PERP,
            "direction": "long",
            "order_type": "limit",
            "base_amount": 1_000_000_000u64,
            "price": 150_000_000u64,
            "reduce_only": false,
            "trade_size_usd": "150",
            "current_total_exposure_usd": "0",
            "is_open": true,
            "drift_user_pda": "11111111111111111111111111111112",
            "drift_state": "11111111111111111111111111111112"
        });
        let parsed: DriftOrderHttpRequest = serde_json::from_value(body).unwrap();
        assert_eq!(parsed.order.market_index, MARKET_INDEX_SOL_PERP);
        assert!(matches!(parsed.order.direction, DD::Long));
        assert!(matches!(parsed.order.order_type, DOT::Limit));
        assert!(parsed.is_open);
    }
}
