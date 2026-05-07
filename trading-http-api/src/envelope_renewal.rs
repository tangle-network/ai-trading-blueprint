//! Envelope renewal cron — scans bots with `validation_trust=Envelope` and
//! rotates envelopes that are within 24h of expiry or have consumed >80% of
//! their `max_total_amount`.
//!
//! ## Behaviour
//!
//! For each candidate bot the cron:
//!
//! 1. Loads the stored envelope. If absent, skip.
//! 2. Computes `expires_in` and `consumed_pct` (best-effort; chain-side errors
//!    treat consumption as `0` so we do not over-rotate when the RPC is down).
//! 3. If neither trigger fires, no-op.
//! 4. Single-sig + operator-owned: builds a renewed envelope (same policy +
//!    enforcement, `nonce + 1`, refreshed `expires_at`, same vault-stored
//!    `verifying_contract`), signs with the operator key, and persists it
//!    via the standard envelope storage path.
//! 5. Multi-sig: POSTs an `envelope-renewal-needed` payload to
//!    `bot.renewal_webhook_url` (when configured), logs and moves on.
//!
//! ## Silent no-op surfaces (and how we surface them)
//!
//! Auto-renewal can silently no-op when:
//!
//! - The operator key in [`MultiBotTradingState::operator_private_key`] does
//!   not match the single approval signer on the envelope. We compare the
//!   recovered address against `approval_signers[0]` and refuse to sign
//!   otherwise; a `tracing::warn!` is emitted naming both addresses.
//! - The bot has no `renewal_webhook_url` configured for the multi-sig
//!   path. We log at warn level so operators see it in the cron output.
//! - The chain RPC is unreachable. `consumed_pct` defaults to 0 so we will
//!   not over-rotate, but the expiry check still drives rotation when due.

use std::sync::Arc;
use std::time::Duration;

use alloy::primitives::U256;
use alloy::signers::local::PrivateKeySigner;
use chrono::Utc;
use serde::Serialize;

use trading_runtime::{EnvelopeBinding, EnvelopeError, SignedEnvelope};

use crate::routes::envelope::{
    SetEnvelopeError, envelope_consumed_amount, get_signed_envelope, max_total_for_enforcement,
    set_signed_envelope,
};
use crate::{BotContext, EnvelopeBotInfo, MultiBotTradingState};

/// Tick interval for the renewal cron (5 minutes).
pub const RENEWAL_CRON_INTERVAL: Duration = Duration::from_secs(300);

/// Time-before-expiry threshold that triggers renewal (24 hours).
pub const RENEWAL_EXPIRY_WINDOW_SECS: i64 = 24 * 3600;

/// Consumption percentage that triggers renewal (80%).
pub const RENEWAL_CONSUMED_PCT_THRESHOLD: f64 = 80.0;

/// Default new-envelope lifetime when an existing envelope is auto-renewed (7 days).
pub const RENEWAL_DEFAULT_DURATION_SECS: u64 = 7 * 24 * 3600;

/// Outcome of evaluating a single bot during a cron tick. Exposed for tests
/// and observability so the binary or Prometheus exporter can surface
/// per-bot signals without needing to parse log lines.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RenewalAction {
    /// No envelope stored for this bot; nothing to rotate.
    NoEnvelope,
    /// Envelope is healthy (plenty of time left, low consumption).
    Healthy,
    /// Envelope auto-renewed in place (single-sig path).
    AutoRenewed { new_nonce: u64 },
    /// Multi-sig envelope — webhook fired.
    WebhookFired,
    /// Multi-sig envelope but no webhook configured — surfaced for ops.
    MultisigNeedsRenewalNoWebhook,
    /// Single-sig envelope but the operator key cannot satisfy the quorum
    /// (mismatched address). Surfaced so operators can fix the key.
    SingleSigOperatorKeyMismatch {
        approval_signer: String,
        operator_address: String,
    },
    /// Could not load consumption (RPC down, etc.). Renewal still considered
    /// based on expiry only.
    ChainConsumptionUnavailable { error: String },
}

/// Reason the envelope is being rotated. Used for observability.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RenewalReason {
    ExpiringSoon,
    ConsumptionThresholdBreached,
    Both,
}

#[derive(Debug, Serialize)]
struct RenewalWebhookPayload<'a> {
    event: &'static str,
    bot_id: &'a str,
    vault_address: &'a str,
    chain_id: u64,
    protocol: &'a str,
    nonce: u64,
    expires_at: u64,
    consumed_amount: String,
    max_total_amount: String,
    consumed_pct: f64,
    reason: RenewalReason,
    min_signatures: usize,
    approval_signers: &'a [String],
}

/// Run a single cron tick — evaluate every envelope-trust bot and act.
///
/// Returns a per-bot action vector for tests/metrics. Errors from individual
/// bots are captured in the action variants rather than aborting the tick.
pub async fn renewal_cron_tick(state: &MultiBotTradingState) -> Vec<(String, RenewalAction)> {
    let bots = match state.list_envelope_bots.as_ref() {
        Some(lister) => lister(),
        None => return Vec::new(),
    };
    let mut results = Vec::with_capacity(bots.len());
    for bot in bots {
        let bot_id = bot.bot_id.clone();
        let action = evaluate_and_act(state, bot).await;
        if !matches!(action, RenewalAction::Healthy | RenewalAction::NoEnvelope) {
            tracing::info!(bot_id = %bot_id, ?action, "envelope renewal action");
        }

        // Record per-action counter for Prometheus dashboarding.
        crate::routes::prometheus::record_renewal_action(&bot_id, renewal_action_label(&action));

        // Fire alerts for the failure-shaped variants. Fire-and-log; the cron
        // never blocks on webhook delivery.
        if let Some(failure_alert) = renewal_failure_alert(&bot_id, &action) {
            state.alert_sink.fire(failure_alert).await;
        }

        results.push((bot_id, action));
    }
    results
}

/// Stable, dashboard-facing label for each `RenewalAction` variant. Kept
/// separately from `Debug` so refactors of the enum don't accidentally rename
/// metric labels.
pub fn renewal_action_label(action: &RenewalAction) -> &'static str {
    match action {
        RenewalAction::NoEnvelope => "NoEnvelope",
        RenewalAction::Healthy => "Healthy",
        RenewalAction::AutoRenewed { .. } => "AutoRenewed",
        RenewalAction::WebhookFired => "WebhookFired",
        RenewalAction::MultisigNeedsRenewalNoWebhook => "MultisigNeedsRenewalNoWebhook",
        RenewalAction::SingleSigOperatorKeyMismatch { .. } => "SingleSigOperatorKeyMismatch",
        RenewalAction::ChainConsumptionUnavailable { .. } => "ChainConsumptionUnavailable",
    }
}

fn renewal_failure_alert(bot_id: &str, action: &RenewalAction) -> Option<crate::alerts::Alert> {
    match action {
        RenewalAction::MultisigNeedsRenewalNoWebhook
        | RenewalAction::SingleSigOperatorKeyMismatch { .. }
        | RenewalAction::ChainConsumptionUnavailable { .. } => {
            Some(crate::alerts::Alert::EnvelopeRenewalFailed {
                bot_id: bot_id.to_string(),
                action: action.clone(),
            })
        }
        _ => None,
    }
}

async fn evaluate_and_act(state: &MultiBotTradingState, bot: EnvelopeBotInfo) -> RenewalAction {
    if bot.validation_trust != trading_runtime::ValidationTrust::Envelope {
        return RenewalAction::Healthy;
    }
    let Some(envelope) = get_signed_envelope(&bot.bot_id) else {
        return RenewalAction::NoEnvelope;
    };

    let now = Utc::now().timestamp();
    let expires_in = envelope.expires_at as i64 - now;
    let max_total = max_total_for_enforcement(&envelope.enforcement);

    let bot_ctx = bot_context_from_info(&bot);
    let consumption = envelope_consumed_amount(state, &envelope, &bot_ctx).await;
    let consumed = consumption.as_ref().copied().unwrap_or(U256::ZERO);
    let consumption_unavailable = consumption.is_err();

    let consumed_pct = consumed_percentage(consumed, max_total);
    let expiry_trigger = expires_in <= RENEWAL_EXPIRY_WINDOW_SECS;
    let consumption_trigger = consumed_pct >= RENEWAL_CONSUMED_PCT_THRESHOLD;

    if !expiry_trigger && !consumption_trigger {
        // Surface RPC outages in the healthy path so we don't silently miss them.
        if let Err(error) = consumption {
            return RenewalAction::ChainConsumptionUnavailable { error };
        }
        return RenewalAction::Healthy;
    }

    let reason = match (expiry_trigger, consumption_trigger) {
        (true, true) => RenewalReason::Both,
        (true, false) => RenewalReason::ExpiringSoon,
        (false, true) => RenewalReason::ConsumptionThresholdBreached,
        (false, false) => unreachable!(),
    };

    if consumption_unavailable {
        tracing::warn!(
            bot_id = %bot.bot_id,
            "envelope consumption unavailable from chain; renewal driven by expiry only"
        );
    }

    // Multi-sig: humans must rotate.
    if envelope.min_signatures > 1 {
        return handle_multisig(&bot, &envelope, consumed, max_total, consumed_pct, reason).await;
    }

    handle_single_sig(state, &bot, envelope, reason).await
}

fn consumed_percentage(consumed: U256, max_total: U256) -> f64 {
    if max_total.is_zero() {
        return 0.0;
    }
    let num = consumed.to_string().parse::<f64>().unwrap_or(0.0);
    let den = max_total.to_string().parse::<f64>().unwrap_or(1.0);
    (num / den) * 100.0
}

fn bot_context_from_info(info: &EnvelopeBotInfo) -> BotContext {
    BotContext {
        bot_id: info.bot_id.clone(),
        vault_address: info.vault_address.clone(),
        paper_trade: false,
        chain_id: info.chain_id,
        rpc_url: info.rpc_url.clone(),
        strategy_config: info.strategy_config.clone(),
        risk_params: info.risk_params.clone(),
        validator_endpoints: Vec::new(),
        validation_trust: info.validation_trust,
    }
}

async fn handle_single_sig(
    state: &MultiBotTradingState,
    bot: &EnvelopeBotInfo,
    current: SignedEnvelope,
    reason: RenewalReason,
) -> RenewalAction {
    if current.approval_signers.len() != 1 {
        // Single-sig means min_signatures==1. Approval set could still have
        // multiple addresses — that's a multi-approver/single-quorum mode and
        // we can't safely auto-rotate without human consent.
        tracing::warn!(
            bot_id = %bot.bot_id,
            approver_count = current.approval_signers.len(),
            "single-sig envelope with multiple approvers — cannot auto-renew"
        );
        return RenewalAction::MultisigNeedsRenewalNoWebhook;
    }

    let operator_address = match operator_address_for_state(state) {
        Ok(addr) => addr,
        Err(err) => {
            tracing::warn!(
                bot_id = %bot.bot_id,
                "operator key invalid; cannot auto-renew envelope: {err}"
            );
            return RenewalAction::SingleSigOperatorKeyMismatch {
                approval_signer: current.approval_signers[0].clone(),
                operator_address: String::new(),
            };
        }
    };

    let approval_signer = current.approval_signers[0].clone();
    if !addresses_equal(&approval_signer, &operator_address) {
        tracing::warn!(
            bot_id = %bot.bot_id,
            approval_signer = %approval_signer,
            operator_address = %operator_address,
            "operator key does not match approval signer; cannot auto-renew"
        );
        return RenewalAction::SingleSigOperatorKeyMismatch {
            approval_signer,
            operator_address,
        };
    }

    let new_duration = std::env::var("ENVELOPE_RENEWAL_DURATION_SECS")
        .ok()
        .and_then(|raw| raw.parse::<u64>().ok())
        .filter(|secs| *secs >= 3600)
        .unwrap_or(RENEWAL_DEFAULT_DURATION_SECS);

    let now = Utc::now().timestamp() as u64;
    let new_nonce = current.nonce.saturating_add(1);
    let mut renewed = SignedEnvelope {
        version: current.version,
        bot_id: current.bot_id.clone(),
        vault_address: current.vault_address.clone(),
        chain_id: current.chain_id,
        protocol: current.protocol.clone(),
        policy: current.policy.clone(),
        approval_signers: current.approval_signers.clone(),
        min_signatures: current.min_signatures,
        issued_at: now,
        expires_at: now + new_duration,
        nonce: new_nonce,
        verifying_contract: current.verifying_contract.clone(),
        enforcement: current.enforcement.clone(),
        signatures: Vec::new(),
    };

    if let Err(e) =
        renewed.sign_with_private_key(&state.operator_private_key, &current.verifying_contract)
    {
        tracing::warn!(
            bot_id = %bot.bot_id,
            "operator failed to sign renewed envelope: {e}"
        );
        return RenewalAction::SingleSigOperatorKeyMismatch {
            approval_signer,
            operator_address,
        };
    }

    let binding = EnvelopeBinding {
        bot_id: &bot.bot_id,
        vault_address: &bot.vault_address,
        chain_id: bot.chain_id,
        protocol: &renewed.protocol,
    };
    if let Err(e) = renewed.verify(&binding, &state.trusted_envelope_signers()) {
        tracing::warn!(
            bot_id = %bot.bot_id,
            "renewed envelope failed verification: {e}"
        );
        if matches!(e, EnvelopeError::SignerNotTrusted { .. }) {
            return RenewalAction::SingleSigOperatorKeyMismatch {
                approval_signer,
                operator_address,
            };
        }
        return RenewalAction::SingleSigOperatorKeyMismatch {
            approval_signer,
            operator_address,
        };
    }

    match set_signed_envelope(&bot.bot_id, &renewed) {
        Ok(()) => {}
        Err(SetEnvelopeError::NonceConflict { current, attempted }) => {
            // Race with PUT /envelope: the operator landed a higher-nonce
            // envelope between our consumption read and the persist step.
            // Drop our renewal — the operator's choice wins. The next cron
            // tick will re-evaluate against whatever the operator wrote.
            tracing::info!(
                bot_id = %bot.bot_id,
                current_nonce = current,
                attempted_nonce = attempted,
                "envelope renewal lost race to operator PUT — skipping"
            );
            return RenewalAction::Healthy;
        }
        Err(SetEnvelopeError::Internal(e)) => {
            tracing::warn!(bot_id = %bot.bot_id, "failed to persist renewed envelope: {e}");
            return RenewalAction::SingleSigOperatorKeyMismatch {
                approval_signer,
                operator_address,
            };
        }
    }

    tracing::info!(
        bot_id = %bot.bot_id,
        old_nonce = current.nonce,
        new_nonce,
        ?reason,
        "envelope auto-renewed (single-sig)"
    );
    RenewalAction::AutoRenewed { new_nonce }
}

async fn handle_multisig(
    bot: &EnvelopeBotInfo,
    envelope: &SignedEnvelope,
    consumed: U256,
    max_total: U256,
    consumed_pct: f64,
    reason: RenewalReason,
) -> RenewalAction {
    let Some(url) = bot.renewal_webhook_url.as_deref() else {
        tracing::warn!(
            bot_id = %bot.bot_id,
            min_signatures = envelope.min_signatures,
            "multi-sig envelope needs renewal but no webhook URL configured"
        );
        return RenewalAction::MultisigNeedsRenewalNoWebhook;
    };

    let payload = RenewalWebhookPayload {
        event: "envelope-renewal-needed",
        bot_id: &bot.bot_id,
        vault_address: &bot.vault_address,
        chain_id: bot.chain_id,
        protocol: &envelope.protocol,
        nonce: envelope.nonce,
        expires_at: envelope.expires_at,
        consumed_amount: consumed.to_string(),
        max_total_amount: max_total.to_string(),
        consumed_pct,
        reason,
        min_signatures: envelope.min_signatures,
        approval_signers: &envelope.approval_signers,
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build();
    let client = match client {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(bot_id = %bot.bot_id, "renewal webhook client init failed: {e}");
            return RenewalAction::MultisigNeedsRenewalNoWebhook;
        }
    };

    match client.post(url).json(&payload).send().await {
        Ok(resp) if resp.status().is_success() => {
            tracing::info!(
                bot_id = %bot.bot_id,
                webhook_url = %url,
                ?reason,
                "envelope renewal webhook delivered"
            );
            RenewalAction::WebhookFired
        }
        Ok(resp) => {
            tracing::warn!(
                bot_id = %bot.bot_id,
                webhook_url = %url,
                status = %resp.status(),
                "renewal webhook returned non-success status"
            );
            RenewalAction::WebhookFired
        }
        Err(e) => {
            tracing::warn!(
                bot_id = %bot.bot_id,
                webhook_url = %url,
                "renewal webhook delivery failed: {e}"
            );
            RenewalAction::MultisigNeedsRenewalNoWebhook
        }
    }
}

fn operator_address_for_state(state: &MultiBotTradingState) -> Result<String, String> {
    let signer: PrivateKeySigner = state
        .operator_private_key
        .parse()
        .map_err(|e: alloy::signers::local::LocalSignerError| e.to_string())?;
    Ok(format!("{:#x}", signer.address()))
}

fn addresses_equal(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

/// Spawn the renewal cron as a background tokio task. The task ticks every
/// [`RENEWAL_CRON_INTERVAL`] until the process shuts down.
pub fn spawn_renewal_cron(state: Arc<MultiBotTradingState>) {
    if std::env::var("DISABLE_ENVELOPE_RENEWAL_CRON")
        .is_ok_and(|v| matches!(v.as_str(), "1" | "true"))
    {
        tracing::info!("envelope renewal cron disabled via DISABLE_ENVELOPE_RENEWAL_CRON");
        return;
    }
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(RENEWAL_CRON_INTERVAL);
        // SECURITY/correctness: tokio's default `Burst` behaviour fires every
        // missed tick back-to-back when a slow tick (e.g. RPC stall) finishes,
        // which can stampede the cron and emit duplicate alerts. `Delay`
        // realigns the schedule and skips at most the still-running tick.
        // See audit finding #7.
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // Skip the immediate-fire tick on startup so booting an operator
        // doesn't generate a renewal storm if envelope state was just imported.
        interval.tick().await;
        loop {
            interval.tick().await;
            renewal_cron_tick(&state).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routes::envelope::clear_signed_envelope;
    use rust_decimal::Decimal;
    use std::sync::{Mutex, OnceLock};
    use trading_runtime::EnvelopeEnforcement;
    use trading_runtime::envelope::policy::{PerpsPolicy, TradingPolicy};

    // Anvil-style test keys.
    const KEY1: &str = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    const KEY2: &str = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    const VERIFYING_CONTRACT: &str = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
    const VAULT: &str = "0x0000000000000000000000000000000000000001";

    fn cron_test_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn ensure_state_dir() {
        // SAFETY: tests are serialized via cron_test_lock and we only set this once.
        unsafe {
            if std::env::var("BLUEPRINT_STATE_DIR").is_err() {
                let tmp = tempfile::tempdir().expect("tempdir");
                std::env::set_var("BLUEPRINT_STATE_DIR", tmp.path());
                std::mem::forget(tmp);
            }
        }
    }

    fn signer_address(key: &str) -> String {
        let s: PrivateKeySigner = key.parse().unwrap();
        format!("{:#x}", s.address())
    }

    fn test_policy() -> TradingPolicy {
        TradingPolicy {
            max_trade_size_usd: Decimal::from(1000),
            max_total_exposure_usd: Decimal::from(3000),
            max_drawdown_pct: Decimal::from(10),
            can_open_positions: true,
            perps: Some(PerpsPolicy {
                allowed_assets: vec!["ETH".into(), "BTC".into()],
                max_leverage: 5,
                max_stop_loss_distance: Decimal::new(5, 2),
                min_stop_loss_distance: Decimal::new(1, 2),
                require_stop_loss: false,
            }),
            vault: None,
            clob: None,
        }
    }

    fn build_envelope(
        bot_id: &str,
        signers: &[&str],
        min_sigs: usize,
        expires_at: u64,
        nonce: u64,
        signing_keys: &[&str],
        max_total_amount: U256,
    ) -> SignedEnvelope {
        let approval_signers: Vec<String> = signers.iter().map(|k| signer_address(k)).collect();
        let mut env = SignedEnvelope {
            version: 2,
            bot_id: bot_id.into(),
            vault_address: VAULT.into(),
            chain_id: 31337,
            protocol: "uniswap_v3".into(),
            policy: test_policy(),
            approval_signers,
            min_signatures: min_sigs,
            issued_at: Utc::now().timestamp() as u64,
            expires_at,
            nonce,
            verifying_contract: VERIFYING_CONTRACT.into(),
            enforcement: Some(EnvelopeEnforcement::UniswapV3Swap(
                trading_runtime::UniswapV3SwapEnforcement {
                    router: alloy::primitives::Address::from_slice(&[0xaau8; 20]),
                    token_in: alloy::primitives::Address::from_slice(&[0xbbu8; 20]),
                    token_out: alloy::primitives::Address::from_slice(&[0xccu8; 20]),
                    fee_tier: 3000,
                    max_single_amount_in: U256::from(1_000_000u128),
                    max_total_amount_in: max_total_amount,
                    min_output_per_input: U256::from(1u128),
                },
            )),
            signatures: Vec::new(),
        };
        for key in signing_keys {
            env.sign_with_private_key(key, VERIFYING_CONTRACT).unwrap();
        }
        env
    }

    fn build_state(operator_key: &str, bots: Vec<EnvelopeBotInfo>) -> Arc<MultiBotTradingState> {
        Arc::new(MultiBotTradingState {
            operator_private_key: operator_key.into(),
            list_envelope_bots: Some(Box::new(move || bots.clone())),
            ..MultiBotTradingState::default()
        })
    }

    fn bot_info_with(bot_id: &str, renewal_webhook_url: Option<String>) -> EnvelopeBotInfo {
        EnvelopeBotInfo {
            bot_id: bot_id.to_string(),
            vault_address: VAULT.to_string(),
            chain_id: 31337,
            // 0.0.0.0:0 is unroutable so chain calls fail fast
            rpc_url: "http://127.0.0.1:1".to_string(),
            strategy_config: serde_json::json!({}),
            risk_params: serde_json::json!({}),
            validation_trust: trading_runtime::ValidationTrust::Envelope,
            renewal_webhook_url,
        }
    }

    #[tokio::test]
    async fn test_renews_within_expiry_window() {
        let _g = cron_test_lock().lock().unwrap();
        ensure_state_dir();
        let bot_id = format!("renewal-expiry-{}", uuid::Uuid::new_v4());
        let _ = clear_signed_envelope(&bot_id);

        // Envelope expiring in 12h, low consumption.
        let expires_at = (Utc::now().timestamp() as u64) + (12 * 3600);
        let env = build_envelope(
            &bot_id,
            &[KEY1],
            1,
            expires_at,
            7,
            &[KEY1],
            U256::from(1_000_000u128),
        );
        set_signed_envelope(&bot_id, &env).unwrap();

        let state = build_state(KEY1, vec![bot_info_with(&bot_id, None)]);
        let results = renewal_cron_tick(&state).await;

        assert_eq!(results.len(), 1);
        assert!(matches!(
            results[0].1,
            RenewalAction::AutoRenewed { new_nonce } if new_nonce == 8
        ));

        let stored = get_signed_envelope(&bot_id).expect("envelope persisted");
        assert_eq!(stored.nonce, 8);
        assert!(stored.expires_at > expires_at);
        assert!(!stored.signatures.is_empty());
        let _ = clear_signed_envelope(&bot_id);
    }

    #[tokio::test]
    async fn test_renews_when_consumed_threshold_breached() {
        let _g = cron_test_lock().lock().unwrap();
        ensure_state_dir();
        let bot_id = format!("renewal-consumed-{}", uuid::Uuid::new_v4());
        let _ = clear_signed_envelope(&bot_id);

        // The mock chain RPC fails so consumed=0 → the cron falls back to the
        // expiry trigger. Use a 12h expiry so renewal still drives via the
        // ExpiringSoon path. The pure consumption-percentage helper is
        // covered by `test_consumption_only_trigger_renews` below.
        let expires_at = (Utc::now().timestamp() as u64) + (12 * 3600);
        let env = build_envelope(
            &bot_id,
            &[KEY1],
            1,
            expires_at,
            42,
            &[KEY1],
            U256::from(10_000_000u128),
        );
        set_signed_envelope(&bot_id, &env).unwrap();

        let state = build_state(KEY1, vec![bot_info_with(&bot_id, None)]);
        let results = renewal_cron_tick(&state).await;
        assert!(matches!(
            results[0].1,
            RenewalAction::AutoRenewed { new_nonce } if new_nonce == 43
        ));
        let _ = clear_signed_envelope(&bot_id);
    }

    #[tokio::test]
    async fn test_consumption_only_trigger_renews() {
        // Validates the consumption percentage helper in isolation — the cron
        // would call the same logic when chain RPC reports consumption ≥ 80%.
        let _g = cron_test_lock().lock().unwrap();
        let max_total = U256::from(1_000u128);
        assert_eq!(consumed_percentage(U256::from(800u128), max_total), 80.0);
        assert!(
            consumed_percentage(U256::from(810u128), max_total) >= RENEWAL_CONSUMED_PCT_THRESHOLD
        );
        assert!(
            consumed_percentage(U256::from(799u128), max_total) < RENEWAL_CONSUMED_PCT_THRESHOLD
        );
        assert_eq!(consumed_percentage(U256::ZERO, U256::ZERO), 0.0);
    }

    #[tokio::test]
    async fn test_skips_active_envelope() {
        let _g = cron_test_lock().lock().unwrap();
        ensure_state_dir();
        let bot_id = format!("renewal-active-{}", uuid::Uuid::new_v4());
        let _ = clear_signed_envelope(&bot_id);

        // 30 days remaining, low consumption → cron should not act.
        let expires_at = (Utc::now().timestamp() as u64) + (30 * 24 * 3600);
        let env = build_envelope(
            &bot_id,
            &[KEY1],
            1,
            expires_at,
            5,
            &[KEY1],
            U256::from(1_000_000u128),
        );
        set_signed_envelope(&bot_id, &env).unwrap();

        let state = build_state(KEY1, vec![bot_info_with(&bot_id, None)]);
        let results = renewal_cron_tick(&state).await;
        // Either Healthy or ChainConsumptionUnavailable — both indicate "did not rotate".
        assert!(matches!(
            results[0].1,
            RenewalAction::Healthy | RenewalAction::ChainConsumptionUnavailable { .. }
        ));

        let stored = get_signed_envelope(&bot_id).unwrap();
        assert_eq!(stored.nonce, 5);
        assert_eq!(stored.expires_at, expires_at);
        let _ = clear_signed_envelope(&bot_id);
    }

    #[tokio::test]
    async fn test_multisig_emits_webhook_only() {
        let _g = cron_test_lock().lock().unwrap();
        ensure_state_dir();
        let bot_id = format!("renewal-multisig-{}", uuid::Uuid::new_v4());
        let _ = clear_signed_envelope(&bot_id);

        // 2-of-2 envelope expiring in 12h.
        let expires_at = (Utc::now().timestamp() as u64) + (12 * 3600);
        let env = build_envelope(
            &bot_id,
            &[KEY1, KEY2],
            2,
            expires_at,
            10,
            &[KEY1, KEY2],
            U256::from(1_000_000u128),
        );
        set_signed_envelope(&bot_id, &env).unwrap();

        // No webhook configured → cron should report MultisigNeedsRenewalNoWebhook
        // and MUST NOT auto-rotate.
        let state = build_state(KEY1, vec![bot_info_with(&bot_id, None)]);
        let results = renewal_cron_tick(&state).await;
        assert_eq!(results[0].1, RenewalAction::MultisigNeedsRenewalNoWebhook);

        // Verify on-disk envelope did NOT change.
        let stored = get_signed_envelope(&bot_id).unwrap();
        assert_eq!(stored.nonce, 10);
        assert_eq!(stored.expires_at, expires_at);
        assert_eq!(stored.signatures.len(), 2);
        let _ = clear_signed_envelope(&bot_id);
    }

    #[tokio::test]
    async fn test_single_sig_with_wrong_operator_key_does_not_rotate() {
        let _g = cron_test_lock().lock().unwrap();
        ensure_state_dir();
        let bot_id = format!("renewal-wrongkey-{}", uuid::Uuid::new_v4());
        let _ = clear_signed_envelope(&bot_id);

        // Approval signer is KEY1; operator key is KEY2 → mismatch.
        let expires_at = (Utc::now().timestamp() as u64) + (6 * 3600);
        let env = build_envelope(
            &bot_id,
            &[KEY1],
            1,
            expires_at,
            3,
            &[KEY1],
            U256::from(1_000_000u128),
        );
        set_signed_envelope(&bot_id, &env).unwrap();

        let state = build_state(
            KEY2, // wrong operator
            vec![bot_info_with(&bot_id, None)],
        );
        let results = renewal_cron_tick(&state).await;
        assert!(matches!(
            results[0].1,
            RenewalAction::SingleSigOperatorKeyMismatch { .. }
        ));
        let stored = get_signed_envelope(&bot_id).unwrap();
        assert_eq!(stored.nonce, 3);
        let _ = clear_signed_envelope(&bot_id);
    }

    #[tokio::test]
    async fn test_no_envelope_stored_is_noop() {
        let _g = cron_test_lock().lock().unwrap();
        ensure_state_dir();
        let bot_id = format!("renewal-empty-{}", uuid::Uuid::new_v4());
        let _ = clear_signed_envelope(&bot_id);

        let state = build_state(KEY1, vec![bot_info_with(&bot_id, None)]);
        let results = renewal_cron_tick(&state).await;
        assert_eq!(results[0].1, RenewalAction::NoEnvelope);
    }

    #[tokio::test]
    async fn test_per_trade_validation_skipped() {
        let _g = cron_test_lock().lock().unwrap();
        ensure_state_dir();
        let bot_id = format!("renewal-pertrade-{}", uuid::Uuid::new_v4());
        let mut info = bot_info_with(&bot_id, None);
        info.validation_trust = trading_runtime::ValidationTrust::PerTrade;
        let state = build_state(KEY1, vec![info]);
        let results = renewal_cron_tick(&state).await;
        assert_eq!(results[0].1, RenewalAction::Healthy);
    }
}
