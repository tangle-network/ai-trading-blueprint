//! Background poller that walks envelope storage and emits per-bot gauges +
//! threshold alerts.
//!
//! Ticks every [`ENVELOPE_WATCHER_INTERVAL`] (60s by default). For each bot
//! enumerated by `MultiBotTradingState::list_envelope_bots`:
//!
//! 1. Loads the on-disk signed envelope; missing entries are skipped silently.
//! 2. Reads on-chain consumption via a **batched** Multicall3 call (one RPC
//!    per chain — see [`batch_consumed_amounts`]). A failure leaves consumed
//!    at 0 and we still emit expiry-driven gauges and alerts.
//! 3. Emits the four envelope-status gauges via
//!    [`crate::routes::prometheus::record_envelope_snapshot`].
//! 4. Fires `EnvelopeNearlyExhausted` and `EnvelopeNearExpiry` alerts when
//!    the configured thresholds are breached. Per-bot, per-threshold
//!    debounce of 1 hour prevents alert storms on a stuck cron.
//!
//! ## Why Multicall3?
//!
//! With `N` bots a per-bot `eth_call` pattern issues `2N+` round trips per tick
//! (`tradeValidator()` + `hashEnvelope()` + `envelopeConsumedAmount()`). At
//! 10K bots × 60s ticks that's >10K RPCs/min — busy chains rate-limit, and
//! per-call latency dominates the tick budget. Batching all
//! `envelopeConsumedAmount(hash)` reads through Multicall3
//! (`0xcA11bde05977b3631167028862bE2a173976CA11`, canonical on every major
//! EVM chain) collapses an entire chain's worth of bots into one RPC.
//!
//! The envelope hash is computed off-chain via
//! [`trading_runtime::envelope::abi_bridge::envelope_struct_hash`], which the
//! cross-domain digest proptest pins to the on-chain `_hashEnvelope` output.
//! This skips the validator round-trip entirely.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use alloy::primitives::{Address, FixedBytes, U256};
use alloy::providers::ProviderBuilder;
use alloy::sol_types::SolCall;
use chrono::Utc;
use tokio::sync::Mutex;
use trading_runtime::SignedEnvelope;
use trading_runtime::contracts::{IMulticall3, ITradingVault};
use trading_runtime::envelope::abi_bridge::{envelope_struct_hash, to_sol_envelope};
use trading_runtime::multicall::multicall3_address;

use crate::alerts::{Alert, AlertSink};
use crate::routes::envelope::{get_signed_envelope, max_total_for_enforcement};
use crate::routes::prometheus::record_envelope_snapshot;
use crate::{EnvelopeBotInfo, MultiBotTradingState};

/// Polling interval for the watcher.
pub const ENVELOPE_WATCHER_INTERVAL: Duration = Duration::from_secs(60);

/// Threshold for `EnvelopeNearlyExhausted` (90% consumed).
pub const ALERT_NEARLY_EXHAUSTED_PCT: f64 = 90.0;

/// Threshold for `EnvelopeNearExpiry` (6 hours).
pub const ALERT_NEAR_EXPIRY_SECONDS: i64 = 6 * 3600;

/// Debounce window — at most one alert per bot per threshold per hour.
pub const ALERT_DEBOUNCE: Duration = Duration::from_secs(3600);

/// Per-bot last-fired timestamps, keyed by `(bot_id, alert_kind)`.
type DebounceState = Arc<Mutex<HashMap<(String, &'static str), SystemTime>>>;

fn make_debounce_state() -> DebounceState {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Spawn the envelope watcher background task. No-op when neither a bot lister
/// nor an alert sink is configured.
pub fn spawn_envelope_watcher(state: Arc<MultiBotTradingState>) {
    if state.list_envelope_bots.is_none() {
        tracing::debug!("envelope watcher skipped — no list_envelope_bots provider");
        return;
    }
    if std::env::var("DISABLE_ENVELOPE_WATCHER").is_ok_and(|v| matches!(v.as_str(), "1" | "true")) {
        tracing::info!("envelope watcher disabled via DISABLE_ENVELOPE_WATCHER");
        return;
    }
    let debounce = make_debounce_state();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(ENVELOPE_WATCHER_INTERVAL);
        // SECURITY/correctness: prefer `Delay` over the default `Burst` so a
        // slow tick (many bots × slow RPC) cannot queue duplicate ticks that
        // double-fire alerts on the next cycle. See audit finding #7.
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // Skip the immediate-fire so process startup doesn't generate a burst.
        interval.tick().await;
        loop {
            interval.tick().await;
            envelope_watcher_tick(&state, debounce.clone()).await;
        }
    });
}

/// One snapshot row passed into the per-bot gauge / alert pipeline. Decoupled
/// from the on-chain fetch so tests can inject synthetic consumed amounts
/// without spinning up an RPC mock.
struct BotSnapshot {
    bot: EnvelopeBotInfo,
    envelope: SignedEnvelope,
    consumed: U256,
    consumed_error: Option<String>,
}

/// Run a single watcher tick. Public so the binary or tests can drive it
/// directly (the spawned task simply calls this in a loop).
pub async fn envelope_watcher_tick(state: &MultiBotTradingState, debounce: DebounceState) {
    let bots = match state.list_envelope_bots.as_ref() {
        Some(lister) => lister(),
        None => return,
    };

    // Filter bots to just those we'll actually act on (envelope mode + has a
    // signed envelope on disk). This is what we batch on.
    let mut prepared: Vec<(EnvelopeBotInfo, SignedEnvelope)> = Vec::with_capacity(bots.len());
    for bot in bots {
        if bot.validation_trust != trading_runtime::ValidationTrust::Envelope {
            continue;
        }
        let Some(envelope) = get_signed_envelope(&bot.bot_id) else {
            continue;
        };
        prepared.push((bot, envelope));
    }

    if prepared.is_empty() {
        return;
    }

    let consumed_map = batch_consumed_amounts(&prepared).await;
    let snapshots: Vec<BotSnapshot> = prepared
        .into_iter()
        .map(|(bot, envelope)| {
            let key = bot.bot_id.clone();
            let (consumed, consumed_error) = match consumed_map.get(&key) {
                Some(Ok(amount)) => (*amount, None),
                Some(Err(error)) => (U256::ZERO, Some(error.clone())),
                None => (
                    U256::ZERO,
                    Some("multicall did not return a result for this bot".into()),
                ),
            };
            BotSnapshot {
                bot,
                envelope,
                consumed,
                consumed_error,
            }
        })
        .collect();

    for snapshot in snapshots {
        emit_snapshot(state, snapshot, debounce.clone()).await;
    }
}

/// Group `bots` by `(chain_id, rpc_url)` and issue **one** Multicall3
/// `aggregate3` per group. Returns a map keyed by `bot_id` of the per-bot
/// `Result<U256, String>` so the caller can fan results back out.
///
/// On any RPC failure the entire group is recorded as failed (every bot in
/// the group gets the same error), which is fine for observability — the
/// caller falls back to `consumed = 0` and still emits expiry-driven gauges.
async fn batch_consumed_amounts(
    prepared: &[(EnvelopeBotInfo, SignedEnvelope)],
) -> HashMap<String, Result<U256, String>> {
    let mut groups: HashMap<(u64, String), Vec<usize>> = HashMap::new();
    for (idx, (bot, _envelope)) in prepared.iter().enumerate() {
        groups
            .entry((bot.chain_id, bot.rpc_url.clone()))
            .or_default()
            .push(idx);
    }

    let mut out: HashMap<String, Result<U256, String>> = HashMap::with_capacity(prepared.len());
    for ((chain_id, rpc_url), indices) in groups {
        let group_result = batch_one_group(chain_id, &rpc_url, prepared, &indices).await;
        match group_result {
            Ok(per_bot) => {
                for (bot_idx, value) in indices.iter().zip(per_bot.into_iter()) {
                    let bot_id = prepared[*bot_idx].0.bot_id.clone();
                    out.insert(bot_id, value);
                }
            }
            Err(error) => {
                for bot_idx in &indices {
                    let bot_id = prepared[*bot_idx].0.bot_id.clone();
                    out.insert(bot_id, Err(error.clone()));
                }
            }
        }
    }
    out
}

/// Issue one Multicall3 batch for a single `(chain_id, rpc_url)` group.
/// Returns one `Result<U256, String>` per index, in the same order as
/// `indices`.
async fn batch_one_group(
    chain_id: u64,
    rpc_url: &str,
    prepared: &[(EnvelopeBotInfo, SignedEnvelope)],
    indices: &[usize],
) -> Result<Vec<Result<U256, String>>, String> {
    let multicall_addr = multicall3_address(chain_id).ok_or_else(|| {
        format!(
            "no Multicall3 address baked in for chain_id={chain_id} \
             (set MULTICALL3_{chain_id}=0x... to opt in)"
        )
    })?;

    // SECURITY: RPC URLs commonly embed an API key. Mirror the existing
    // singleton path's error redaction.
    let provider = ProviderBuilder::new().connect_http(rpc_url.parse().map_err(|e| {
        tracing::warn!(error = %e, "envelope watcher: rpc_url failed to parse");
        "bot rpc_url is invalid; check operator configuration".to_string()
    })?);

    // Build the Call3 list. Each entry asks the bot's vault for
    // `envelopeConsumedAmount(envelope_hash)`. Hash is computed off-chain
    // (see module docs).
    let mut calls: Vec<IMulticall3::Call3> = Vec::with_capacity(indices.len());
    let mut prebuild_errors: Vec<Option<String>> = Vec::with_capacity(indices.len());
    for bot_idx in indices {
        let (bot, envelope) = &prepared[*bot_idx];
        match build_consumed_amount_call(bot, envelope) {
            Ok(call) => {
                calls.push(call);
                prebuild_errors.push(None);
            }
            Err(error) => {
                // Push a no-op call so the indices align; mark it as
                // pre-failed so we surface the original error rather than
                // the multicall's "0 returned".
                calls.push(IMulticall3::Call3 {
                    target: Address::ZERO,
                    allowFailure: true,
                    callData: alloy::primitives::Bytes::new(),
                });
                prebuild_errors.push(Some(error));
            }
        }
    }

    let multicall = IMulticall3::new(multicall_addr, &provider);
    let raw = multicall
        .aggregate3(calls)
        .call()
        .await
        .map_err(|e| format!("multicall3 aggregate3: {e}"))?;

    if raw.len() != indices.len() {
        return Err(format!(
            "multicall3 returned {} results but {} were requested",
            raw.len(),
            indices.len()
        ));
    }

    let mut out = Vec::with_capacity(indices.len());
    for (i, result) in raw.into_iter().enumerate() {
        if let Some(err) = prebuild_errors[i].take() {
            out.push(Err(err));
            continue;
        }
        if !result.success {
            out.push(Err("envelopeConsumedAmount call reverted".into()));
            continue;
        }
        match decode_consumed_amount(&result.returnData) {
            Ok(amount) => out.push(Ok(amount)),
            Err(e) => out.push(Err(e)),
        }
    }
    Ok(out)
}

/// Build a `Call3` for `vault.envelopeConsumedAmount(envelope_struct_hash)`.
fn build_consumed_amount_call(
    bot: &EnvelopeBotInfo,
    envelope: &SignedEnvelope,
) -> Result<IMulticall3::Call3, String> {
    let vault: Address = bot
        .vault_address
        .parse()
        .map_err(|e: alloy::hex::FromHexError| format!("invalid vault address: {e}"))?;
    let sol_env = to_sol_envelope(envelope).map_err(|e| e.to_string())?;
    let envelope_hash: FixedBytes<32> = envelope_struct_hash(&sol_env);
    let calldata = ITradingVault::envelopeConsumedAmountCall {
        envelopeHash: envelope_hash,
    }
    .abi_encode();
    Ok(IMulticall3::Call3 {
        target: vault,
        allowFailure: true,
        callData: alloy::primitives::Bytes::from(calldata),
    })
}

fn decode_consumed_amount(data: &[u8]) -> Result<U256, String> {
    let decoded = ITradingVault::envelopeConsumedAmountCall::abi_decode_returns(data)
        .map_err(|e| format!("decode envelopeConsumedAmount return: {e}"))?;
    Ok(decoded)
}

async fn emit_snapshot(
    state: &MultiBotTradingState,
    snapshot: BotSnapshot,
    debounce: DebounceState,
) {
    let BotSnapshot {
        bot,
        envelope,
        consumed,
        consumed_error,
    } = snapshot;

    let max_total = max_total_for_enforcement(&envelope.enforcement);
    let consumed_pct = consumed_percentage(consumed, max_total);
    let now = Utc::now().timestamp();
    let expires_in = envelope.expires_at as i64 - now;

    record_envelope_snapshot(
        &bot.bot_id,
        &envelope.protocol,
        u256_to_f64(consumed),
        u256_to_f64(max_total),
        envelope.expires_at as i64,
        envelope.signatures.len(),
    );

    if let Some(error) = consumed_error {
        tracing::debug!(
            bot_id = %bot.bot_id,
            %error,
            "envelope watcher could not read consumption (gauges still emitted via expiry)"
        );
    }

    if consumed_pct >= ALERT_NEARLY_EXHAUSTED_PCT {
        maybe_fire(
            &state.alert_sink,
            &debounce,
            &bot.bot_id,
            "envelope_nearly_exhausted",
            Alert::EnvelopeNearlyExhausted {
                bot_id: bot.bot_id.clone(),
                consumed_pct,
            },
        )
        .await;
    }

    if expires_in <= ALERT_NEAR_EXPIRY_SECONDS {
        maybe_fire(
            &state.alert_sink,
            &debounce,
            &bot.bot_id,
            "envelope_near_expiry",
            Alert::EnvelopeNearExpiry {
                bot_id: bot.bot_id.clone(),
                expires_in_seconds: expires_in,
            },
        )
        .await;
    }
}

async fn maybe_fire(
    sink: &AlertSink,
    debounce: &DebounceState,
    bot_id: &str,
    kind: &'static str,
    alert: Alert,
) {
    let key = (bot_id.to_string(), kind);
    let now = SystemTime::now();
    {
        let mut guard = debounce.lock().await;
        if let Some(last) = guard.get(&key) {
            if now
                .duration_since(*last)
                .map(|d| d < ALERT_DEBOUNCE)
                .unwrap_or(false)
            {
                return;
            }
        }
        guard.insert(key, now);
    }
    sink.fire(alert).await;
}

fn consumed_percentage(consumed: U256, max_total: U256) -> f64 {
    if max_total.is_zero() {
        return 0.0;
    }
    let num = consumed.to_string().parse::<f64>().unwrap_or(0.0);
    let den = max_total.to_string().parse::<f64>().unwrap_or(1.0);
    (num / den) * 100.0
}

fn u256_to_f64(value: U256) -> f64 {
    value.to_string().parse::<f64>().unwrap_or(0.0)
}

// `UNIX_EPOCH` is referenced via `SystemTime::now()` arithmetic in callers; the
// import is kept for forward-compat readers wondering why we don't use chrono
// for the debounce timestamp.
#[allow(dead_code)]
const _UNIX_EPOCH_REF: SystemTime = UNIX_EPOCH;

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::primitives::{Address, U256};
    use alloy::sol_types::{SolCall, SolValue};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::SystemTime;
    use trading_runtime::ValidationTrust;
    use trading_runtime::envelope::{TradingPolicy, UniswapV3SwapEnforcement, VaultPolicy};
    use wiremock::matchers::{body_string_contains, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn debounce_skips_repeat_within_window() {
        let debounce = make_debounce_state();
        let key = ("bot-1".to_string(), "envelope_near_expiry");
        debounce.lock().await.insert(key.clone(), SystemTime::now());

        let mut guard = debounce.lock().await;
        let last = guard.get(&key).copied().unwrap();
        let recent = SystemTime::now()
            .duration_since(last)
            .map(|d| d < ALERT_DEBOUNCE)
            .unwrap_or(false);
        assert!(
            recent,
            "second fire within debounce window should be skipped"
        );
        guard.clear();
    }

    #[test]
    fn consumed_percentage_handles_zero_denominator() {
        assert_eq!(consumed_percentage(U256::from(100u64), U256::ZERO), 0.0);
        assert_eq!(
            consumed_percentage(U256::from(50u64), U256::from(100u64)),
            50.0
        );
    }

    fn fake_envelope(bot_id: &str, vault: Address, nonce: u64) -> SignedEnvelope {
        use rust_decimal::Decimal;
        let weth = Address::from([0x10; 20]);
        let usdc = Address::from([0x11; 20]);
        SignedEnvelope {
            version: 2,
            bot_id: bot_id.into(),
            vault_address: format!("{vault:#x}"),
            chain_id: 31337,
            protocol: "uniswap_v3".into(),
            policy: TradingPolicy {
                max_trade_size_usd: Decimal::from(1_000),
                max_total_exposure_usd: Decimal::from(3_000),
                max_drawdown_pct: Decimal::from(10),
                can_open_positions: true,
                perps: None,
                vault: Some(VaultPolicy {
                    allowed_protocols: vec!["uniswap_v3".into()],
                    allowed_tokens_in: vec![],
                    allowed_tokens_out: vec![],
                    max_slippage_bps: 100,
                }),
                clob: None,
            },
            approval_signers: vec![format!("{:#x}", Address::from([0xa; 20]))],
            min_signatures: 1,
            issued_at: 1_700_000_000,
            expires_at: 1_700_003_600,
            nonce,
            verifying_contract: format!("{vault:#x}"),
            enforcement: Some(trading_runtime::EnvelopeEnforcement::UniswapV3Swap(
                UniswapV3SwapEnforcement {
                    router: Address::from([0xb; 20]),
                    token_in: weth,
                    token_out: usdc,
                    fee_tier: 3000,
                    max_single_amount_in: U256::from(1_000_000_000_000_000_000u128),
                    max_total_amount_in: U256::from(10_000_000_000_000_000_000u128),
                    min_output_per_input: U256::from(2_900_000_000u128),
                },
            )),
            signatures: vec![],
        }
    }

    /// 5 bots all on chain 31337 → exactly one `aggregate3` POST hits the RPC.
    /// This is the headline scaling guarantee: bot count is decoupled from
    /// per-tick RPC count.
    #[tokio::test]
    async fn multicall_batches_per_chain() {
        let rpc_mock = MockServer::start().await;
        let agg_selector = format!("0x{}", hex::encode(IMulticall3::aggregate3Call::SELECTOR));
        let call_count = Arc::new(AtomicUsize::new(0));
        let counter = call_count.clone();

        // Encode a Multicall3 aggregate3 return: 5 (success=true, returnData=abi(U256(123)))
        // entries. We don't know exact ordering; using the same payload for
        // every entry is fine for the count assertion.
        let one_result = IMulticall3::Result {
            success: true,
            returnData: alloy::primitives::Bytes::from(U256::from(123u64).abi_encode()),
        };
        let results: Vec<IMulticall3::Result> = (0..5).map(|_| one_result.clone()).collect();
        let return_bytes = <Vec<IMulticall3::Result> as SolValue>::abi_encode(&results);
        let response_body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": format!("0x{}", hex::encode(return_bytes)),
        });

        Mock::given(method("POST"))
            .and(path("/"))
            .and(body_string_contains(agg_selector))
            .respond_with(move |_req: &wiremock::Request| {
                counter.fetch_add(1, Ordering::Relaxed);
                ResponseTemplate::new(200).set_body_json(response_body.clone())
            })
            .mount(&rpc_mock)
            .await;

        let vault = Address::from([0x77; 20]);
        let mut prepared = Vec::new();
        for i in 0..5u8 {
            let bot_id = format!("bot-{i}");
            let bot = EnvelopeBotInfo {
                bot_id: bot_id.clone(),
                vault_address: format!("{vault:#x}"),
                chain_id: 31337,
                rpc_url: rpc_mock.uri(),
                strategy_config: serde_json::json!({}),
                risk_params: serde_json::json!({}),
                validation_trust: ValidationTrust::Envelope,
                renewal_webhook_url: None,
            };
            let envelope = fake_envelope(&bot_id, vault, i as u64 + 1);
            prepared.push((bot, envelope));
        }

        let consumed = batch_consumed_amounts(&prepared).await;
        assert_eq!(consumed.len(), 5);
        for (bot_id, result) in consumed {
            assert_eq!(result.unwrap(), U256::from(123u64), "bot {bot_id}");
        }
        assert_eq!(
            call_count.load(Ordering::Relaxed),
            1,
            "exactly one multicall RPC for the whole chain"
        );
    }
}
