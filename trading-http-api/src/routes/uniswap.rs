use alloy::primitives::{Address, U256, Uint};
use alloy::sol;
use alloy::sol_types::SolCall;
use axum::extract::{Extension, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use reqwest::Client;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use trading_runtime::uniswap_envelope::{
    SignedUniswapEnvelope, UniswapEnvelope, UniswapEnvelopeBinding, approval_signers_hash,
    bot_id_hash,
};
use trading_runtime::{Action, TradeIntent};

use crate::{BotContext, MultiBotTradingState};

const UNISWAP_V3_ROUTER: &str = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const UNISWAP_V3_QUOTER: &str = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";
const DEFAULT_UNISWAP_FEE_TIER: u32 = 3000;
const WAD: u128 = 1_000_000_000_000_000_000;
const BPS_DENOMINATOR: u128 = 10_000;

type Uint24 = Uint<24, 1>;
type Uint160 = Uint<160, 3>;

sol! {
    interface IQuoter {
        function quoteExactInputSingle(
            address tokenIn,
            address tokenOut,
            uint24 fee,
            uint256 amountIn,
            uint160 sqrtPriceLimitX96
        ) external returns (uint256 amountOut);
    }
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct StoredUniswapEnvelopes {
    envelopes: Vec<SignedUniswapEnvelope>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ValidateEnvelopeRequest {
    envelope: UniswapEnvelope,
    approval_signers: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ValidateEnvelopeResponse {
    approved: bool,
    score: u32,
    reasoning: String,
    validator: String,
    signed_envelope: Option<SignedUniswapEnvelope>,
}

#[derive(Debug, Deserialize)]
pub struct UniswapQuoteRequest {
    pub token_in: String,
    pub token_out: String,
    pub amount_in: String,
    #[serde(default)]
    pub fee_tier: Option<u32>,
    #[serde(default)]
    pub slippage_bps: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct UniswapQuoteResponse {
    pub token_in: String,
    pub token_out: String,
    pub amount_in: String,
    pub amount_out: String,
    pub min_amount_out: String,
    pub fee_tier: u32,
    pub slippage_bps: u64,
}

fn envelope_dir() -> PathBuf {
    sandbox_runtime::store::state_dir().join("uniswap-envelopes")
}

fn envelope_path(bot_id: &str) -> PathBuf {
    let safe_bot_id = bot_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    envelope_dir().join(format!("{safe_bot_id}.json"))
}

fn read_signed_uniswap_envelopes(bot_id: &str) -> Vec<SignedUniswapEnvelope> {
    let Ok(data) = std::fs::read_to_string(envelope_path(bot_id)) else {
        return Vec::new();
    };
    if let Ok(store) = serde_json::from_str::<StoredUniswapEnvelopes>(&data) {
        return store.envelopes;
    }
    serde_json::from_str::<SignedUniswapEnvelope>(&data)
        .map(|envelope| vec![envelope])
        .unwrap_or_default()
}

fn write_signed_uniswap_envelopes(
    bot_id: &str,
    envelopes: Vec<SignedUniswapEnvelope>,
) -> Result<(), (StatusCode, String)> {
    std::fs::create_dir_all(envelope_dir()).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to create envelope directory: {e}"),
        )
    })?;
    let json =
        serde_json::to_string_pretty(&StoredUniswapEnvelopes { envelopes }).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to serialize Uniswap envelope store: {e}"),
            )
        })?;
    std::fs::write(envelope_path(bot_id), json).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to persist Uniswap envelope store: {e}"),
        )
    })?;
    Ok(())
}

pub(crate) fn remove_signed_uniswap_envelope(
    bot_id: &str,
    envelope_id: &str,
) -> Result<bool, (StatusCode, String)> {
    let mut envelopes = read_signed_uniswap_envelopes(bot_id);
    let before = envelopes.len();
    envelopes.retain(|active| {
        !active
            .envelope
            .envelope_id
            .eq_ignore_ascii_case(envelope_id)
    });
    if envelopes.len() == before {
        return Ok(false);
    }
    write_signed_uniswap_envelopes(bot_id, envelopes)?;
    Ok(true)
}

pub(crate) fn get_signed_uniswap_envelope(bot_id: &str) -> Option<SignedUniswapEnvelope> {
    let execution_now = current_execution_timestamp();
    read_signed_uniswap_envelopes(bot_id)
        .into_iter()
        .filter(|signed| signed.envelope.valid_until >= execution_now)
        .max_by_key(|signed| signed.envelope.valid_until)
}

fn same_envelope_scope(left: &UniswapEnvelope, right: &UniswapEnvelope) -> bool {
    left.vault.eq_ignore_ascii_case(&right.vault)
        && left.chain_id == right.chain_id
        && left.router.eq_ignore_ascii_case(&right.router)
        && left.token_in.eq_ignore_ascii_case(&right.token_in)
        && left.token_out.eq_ignore_ascii_case(&right.token_out)
        && left.action.eq_ignore_ascii_case(&right.action)
}

fn same_intent_scope(envelope: &UniswapEnvelope, intent: &TradeIntent) -> bool {
    envelope.router.eq_ignore_ascii_case(UNISWAP_V3_ROUTER)
        && envelope.action.eq_ignore_ascii_case("swap")
        && envelope.token_in.eq_ignore_ascii_case(&intent.token_in)
        && envelope.token_out.eq_ignore_ascii_case(&intent.token_out)
}

fn set_signed_uniswap_envelope_at(
    bot: &BotContext,
    env: &SignedUniswapEnvelope,
    execution_now: u64,
) -> Result<(), (StatusCode, String)> {
    let binding = UniswapEnvelopeBinding {
        bot_id: &bot.bot_id,
        vault_address: &bot.vault_address,
        chain_id: bot.chain_id,
    };
    env.verify_binding(&binding)
        .map_err(|e| (StatusCode::FORBIDDEN, e.to_string()))?;
    env.verify_local_signatures()
        .map_err(|e| (StatusCode::FORBIDDEN, e.to_string()))?;

    let mut envelopes = read_signed_uniswap_envelopes(&bot.bot_id)
        .into_iter()
        .filter(|active| active.envelope.valid_until >= execution_now)
        .collect::<Vec<_>>();

    for active in &envelopes {
        let active_env = &active.envelope;
        let incoming = &env.envelope;
        if same_envelope_scope(active_env, incoming)
            && !active_env
                .envelope_id
                .eq_ignore_ascii_case(&incoming.envelope_id)
        {
            tracing::warn!(
                bot_id = %bot.bot_id,
                active_envelope_id = %active_env.envelope_id,
                incoming_envelope_id = %incoming.envelope_id,
                "replacing active Uniswap envelope for same scope"
            );
        }
    }

    envelopes.retain(|active| {
        !active
            .envelope
            .envelope_id
            .eq_ignore_ascii_case(&env.envelope.envelope_id)
            && !same_envelope_scope(&active.envelope, &env.envelope)
    });
    envelopes.push(env.clone());
    write_signed_uniswap_envelopes(&bot.bot_id, envelopes)
}

pub(crate) async fn set_signed_uniswap_envelope_on_chain_time(
    bot: &BotContext,
    env: &SignedUniswapEnvelope,
) -> Result<(), (StatusCode, String)> {
    latest_chain_timestamp(&bot.rpc_url).await?;
    let execution_now = current_execution_timestamp();
    set_signed_uniswap_envelope_at(bot, env, execution_now)
}

pub(crate) async fn get_signed_uniswap_envelope_for_intent(
    bot: &BotContext,
    intent: &TradeIntent,
) -> Result<Option<SignedUniswapEnvelope>, (StatusCode, String)> {
    let chain_now = latest_chain_timestamp(&bot.rpc_url).await?;
    let execution_now = current_execution_timestamp();
    for active in read_signed_uniswap_envelopes(&bot.bot_id) {
        if envelope_covers_intent_at(&active, intent, chain_now, execution_now)? {
            return Ok(Some(active));
        }
    }
    Ok(None)
}

pub(crate) async fn get_or_request_signed_uniswap_envelope(
    state: &MultiBotTradingState,
    bot: &BotContext,
    intent: &TradeIntent,
    approval_signers: Vec<String>,
    min_signatures: usize,
) -> Result<SignedUniswapEnvelope, (StatusCode, String)> {
    let chain_now = latest_chain_timestamp(&bot.rpc_url).await?;
    let execution_now = current_execution_timestamp();
    for active in read_signed_uniswap_envelopes(&bot.bot_id) {
        if envelope_covers_intent_at(&active, intent, chain_now, execution_now)? {
            return Ok(active);
        }
        if active.envelope.valid_until >= execution_now
            && same_intent_scope(&active.envelope, intent)
        {
            tracing::warn!(
                bot_id = %bot.bot_id,
                envelope_id = %active.envelope.envelope_id,
                "active Uniswap envelope does not cover requested trade; requesting replacement"
            );
        }
    }

    let approval_signers = unique_nonzero_signers(approval_signers)?;
    if approval_signers.is_empty() {
        return Err((
            StatusCode::BAD_GATEWAY,
            "Cannot request Uniswap envelope: no validator approval signers available".into(),
        ));
    }
    let min_signatures = min_signatures.max(1);
    if approval_signers.len() < min_signatures {
        return Err((
            StatusCode::BAD_GATEWAY,
            format!(
                "Cannot request Uniswap envelope: {} approval signers available, {min_signatures} required",
                approval_signers.len()
            ),
        ));
    }
    if bot.validator_endpoints.is_empty() {
        return Err((
            StatusCode::BAD_GATEWAY,
            "Cannot request Uniswap envelope: no validator endpoints configured".into(),
        ));
    }

    let envelope = build_envelope(
        bot,
        intent,
        &approval_signers,
        min_signatures as u64,
        chain_now,
        execution_now,
    )?;
    let request = ValidateEnvelopeRequest {
        envelope: envelope.clone(),
        approval_signers: approval_signers.clone(),
    };

    let client = reqwest::Client::new();
    let mut signatures = Vec::new();
    let mut seen = HashSet::new();
    let approval_signer_set = approval_signers
        .iter()
        .map(|signer| signer.to_ascii_lowercase())
        .collect::<HashSet<_>>();
    let mut errors = Vec::new();

    for endpoint in &bot.validator_endpoints {
        let url = format!("{}/envelopes/validate", endpoint.trim_end_matches('/'));
        let response = client
            .post(&url)
            .json(&request)
            .timeout(std::time::Duration::from_secs(
                std::env::var("VALIDATOR_TIMEOUT_SECS")
                    .ok()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(120),
            ))
            .send()
            .await;

        let response = match response {
            Ok(response) => response,
            Err(error) => {
                errors.push(format!("{endpoint}: {error}"));
                continue;
            }
        };
        let validation = match response.json::<ValidateEnvelopeResponse>().await {
            Ok(validation) => validation,
            Err(error) => {
                errors.push(format!("{endpoint}: invalid envelope response: {error}"));
                continue;
            }
        };
        if !validation.approved || validation.score < state.min_validator_score {
            errors.push(format!(
                "{}: rejected by {} with score {} ({})",
                endpoint, validation.validator, validation.score, validation.reasoning
            ));
            continue;
        }
        let Some(signed) = validation.signed_envelope else {
            errors.push(format!("{endpoint}: approved without signed envelope"));
            continue;
        };
        for signature in signed.signatures {
            let parsed_signer = match signature.signer.parse::<Address>() {
                Ok(address) => address,
                Err(error) => {
                    errors.push(format!(
                        "{endpoint}: ignored invalid Uniswap envelope signer {}: {error}",
                        signature.signer
                    ));
                    continue;
                }
            };
            let key = format!("{parsed_signer:#x}");
            if !approval_signer_set.contains(&key) {
                tracing::warn!(
                    endpoint = %endpoint,
                    signer = %key,
                    "ignored Uniswap envelope signature outside selected approval signer set"
                );
                errors.push(format!(
                    "{endpoint}: ignored Uniswap envelope signature from {key} outside selected approval_signers"
                ));
                continue;
            }
            if seen.insert(key) {
                signatures.push(signature);
            }
        }
    }

    let signed = SignedUniswapEnvelope {
        envelope,
        approval_signers,
        signatures,
    };
    signed
        .verify_binding(&UniswapEnvelopeBinding {
            bot_id: &bot.bot_id,
            vault_address: &bot.vault_address,
            chain_id: bot.chain_id,
        })
        .map_err(|error| (StatusCode::FORBIDDEN, error.to_string()))?;
    signed.verify_local_signatures().map_err(|error| {
        let suffix = if errors.is_empty() {
            String::new()
        } else {
            format!("; validator errors: {}", errors.join("; "))
        };
        (StatusCode::BAD_GATEWAY, format!("{error}{suffix}"))
    })?;
    set_signed_uniswap_envelope_at(bot, &signed, execution_now)?;
    Ok(signed)
}

pub(crate) async fn ensure_uniswap_min_output_executable(
    bot: &BotContext,
    intent: &TradeIntent,
) -> Result<(), (StatusCode, String)> {
    if intent.target_protocol != "uniswap_v3" || intent.action != Action::Swap {
        return Ok(());
    }
    let min_amount_out = decimal_to_u128(intent.min_amount_out, "min_amount_out")?;
    let amount_out = quote_uniswap_exact_input_for_intent(bot, intent).await?;
    if min_amount_out > amount_out {
        return Err((
            StatusCode::BAD_REQUEST,
            format!(
                "Uniswap min_amount_out {min_amount_out} exceeds executable route quote {amount_out}; lower min_amount_out or refresh the quote before validating"
            ),
        ));
    }
    Ok(())
}

fn build_envelope(
    bot: &BotContext,
    intent: &TradeIntent,
    approval_signers: &[String],
    min_signatures: u64,
    chain_now: u64,
    execution_now: u64,
) -> Result<UniswapEnvelope, (StatusCode, String)> {
    if intent.target_protocol != "uniswap_v3" || intent.action != Action::Swap {
        return Err((
            StatusCode::BAD_REQUEST,
            "Uniswap envelope mode only supports swap intents on uniswap_v3".into(),
        ));
    }

    let policy = envelope_policy(&bot.risk_params)?;
    if !json_bool(policy.get("enabled")).unwrap_or(false) {
        return Err((
            StatusCode::FORBIDDEN,
            "Uniswap envelope mode is not enabled for this bot".into(),
        ));
    }

    enforce_allowed_pairs(policy, &intent.token_in, &intent.token_out)?;

    let amount_in = decimal_to_u128(intent.amount_in, "amount_in")?;
    let min_amount_out = decimal_to_u128(intent.min_amount_out, "min_amount_out")?;
    let max_single = envelope_amount_limit(policy, "max_single_amount_in", &intent.token_in)?;
    let max_total = envelope_amount_limit(policy, "max_total_amount_in", &intent.token_in)?;
    if max_single == 0 || max_total == 0 || max_single > max_total {
        return Err((
            StatusCode::BAD_REQUEST,
            "Uniswap envelope amount limits must be positive and max_single <= max_total".into(),
        ));
    }
    if amount_in > max_single {
        return Err((
            StatusCode::FORBIDDEN,
            format!(
                "Trade amount_in {amount_in} exceeds Uniswap envelope max_single_amount_in {max_single}"
            ),
        ));
    }
    if amount_in > max_total {
        return Err((
            StatusCode::FORBIDDEN,
            format!(
                "Trade amount_in {amount_in} exceeds Uniswap envelope max_total_amount_in {max_total}"
            ),
        ));
    }
    if min_amount_out == 0 {
        return Err((
            StatusCode::BAD_REQUEST,
            "Uniswap envelope requires min_amount_out > 0".into(),
        ));
    }

    let duration = json_u64(policy.get("max_duration_secs"))
        .filter(|value| *value > 0)
        .unwrap_or(3600);
    let max_slippage_bps = json_u64(policy.get("max_slippage_bps")).unwrap_or(100);
    let approval_hash = approval_signers_hash(approval_signers)
        .map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
    let expiry_basis = chain_now.max(execution_now);
    let nonce = expiry_basis
        .saturating_mul(1_000_000)
        .saturating_add((rand::random::<u32>() as u64) & 0xfffff);
    let envelope_seed = format!(
        "{}:{}:{}:{}:{}",
        bot.bot_id, bot.vault_address, intent.token_in, intent.token_out, nonce
    );

    Ok(UniswapEnvelope {
        envelope_id: format!(
            "0x{}",
            hex::encode(alloy::primitives::keccak256(envelope_seed.as_bytes()).as_slice())
        ),
        bot_id_hash: bot_id_hash(&bot.bot_id),
        vault: bot.vault_address.clone(),
        chain_id: bot.chain_id,
        router: UNISWAP_V3_ROUTER.into(),
        token_in: intent.token_in.clone(),
        token_out: intent.token_out.clone(),
        action: "swap".into(),
        max_single_amount_in: max_single.to_string(),
        max_total_amount_in: max_total.to_string(),
        max_slippage_bps,
        min_output_per_input: min_output_per_input(amount_in, min_amount_out)?.to_string(),
        valid_from: chain_now.saturating_sub(5),
        valid_until: expiry_basis.saturating_add(duration),
        nonce,
        approval_signers_hash: format!("0x{}", hex::encode(approval_hash.as_slice())),
        min_signatures,
    })
}

fn envelope_covers_intent_at(
    signed: &SignedUniswapEnvelope,
    intent: &TradeIntent,
    chain_now: u64,
    execution_now: u64,
) -> Result<bool, (StatusCode, String)> {
    let envelope = &signed.envelope;
    if envelope.valid_from > chain_now
        || envelope.valid_until < execution_now
        || !same_intent_scope(envelope, intent)
    {
        return Ok(false);
    }
    let amount_in = decimal_to_u128(intent.amount_in, "amount_in")?;
    let min_amount_out = decimal_to_u128(intent.min_amount_out, "min_amount_out")?;
    let max_single = envelope
        .max_single_amount_in
        .parse::<u128>()
        .map_err(|error| {
            (
                StatusCode::BAD_REQUEST,
                format!("Stored Uniswap envelope has invalid max_single_amount_in: {error}"),
            )
        })?;
    let rate = envelope
        .min_output_per_input
        .parse::<u128>()
        .map_err(|error| {
            (
                StatusCode::BAD_REQUEST,
                format!("Stored Uniswap envelope has invalid min_output_per_input: {error}"),
            )
        })?;
    let max_total = envelope
        .max_total_amount_in
        .parse::<u128>()
        .map_err(|error| {
            (
                StatusCode::BAD_REQUEST,
                format!("Stored Uniswap envelope has invalid max_total_amount_in: {error}"),
            )
        })?;
    Ok(amount_in <= max_single
        && amount_in <= max_total
        && min_output_per_input(amount_in, min_amount_out)? >= rate)
}

fn envelope_policy(
    risk_params: &serde_json::Value,
) -> Result<&serde_json::Map<String, serde_json::Value>, (StatusCode, String)> {
    risk_params
        .get("uniswap_envelope")
        .or_else(|| risk_params.get("envelope"))
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "Missing risk_params.uniswap_envelope policy".to_string(),
            )
        })
}

fn enforce_allowed_pairs(
    policy: &serde_json::Map<String, serde_json::Value>,
    token_in: &str,
    token_out: &str,
) -> Result<(), (StatusCode, String)> {
    let Some(pairs) = policy
        .get("allowed_pairs")
        .and_then(serde_json::Value::as_array)
    else {
        return Err((
            StatusCode::BAD_REQUEST,
            "risk_params.uniswap_envelope.allowed_pairs must contain at least one allowed pair"
                .into(),
        ));
    };
    if pairs.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "risk_params.uniswap_envelope.allowed_pairs must contain at least one allowed pair"
                .into(),
        ));
    }
    let allowed = pairs.iter().any(|pair| {
        if let Some(values) = pair.as_array() {
            return values.len() == 2
                && values[0]
                    .as_str()
                    .is_some_and(|value| value.eq_ignore_ascii_case(token_in))
                && values[1]
                    .as_str()
                    .is_some_and(|value| value.eq_ignore_ascii_case(token_out));
        }
        let Some(pair) = pair.as_object() else {
            return false;
        };
        pair.get("token_in")
            .or_else(|| pair.get("tokenIn"))
            .and_then(serde_json::Value::as_str)
            .is_some_and(|value| value.eq_ignore_ascii_case(token_in))
            && pair
                .get("token_out")
                .or_else(|| pair.get("tokenOut"))
                .and_then(serde_json::Value::as_str)
                .is_some_and(|value| value.eq_ignore_ascii_case(token_out))
    });
    if allowed {
        Ok(())
    } else {
        Err((
            StatusCode::FORBIDDEN,
            "Trade pair is outside the configured Uniswap envelope allowed_pairs".into(),
        ))
    }
}

fn envelope_amount_limit(
    policy: &serde_json::Map<String, serde_json::Value>,
    field: &str,
    token_in: &str,
) -> Result<u128, (StatusCode, String)> {
    let by_token_field = format!("{field}_by_token");
    if let Some(by_token) = policy
        .get(&by_token_field)
        .and_then(serde_json::Value::as_object)
    {
        return by_token
            .iter()
            .find_map(|(token, value)| {
                token
                    .eq_ignore_ascii_case(token_in)
                    .then(|| json_u128(Some(value)))
                    .flatten()
            })
            .ok_or_else(|| {
                (
                    StatusCode::FORBIDDEN,
                    format!("Uniswap envelope has no {field} limit for token_in {token_in}"),
                )
            });
    }

    json_u128(policy.get(field)).ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            format!("risk_params.uniswap_envelope.{field} is required"),
        )
    })
}

fn unique_nonzero_signers(signers: Vec<String>) -> Result<Vec<String>, (StatusCode, String)> {
    let mut seen = HashSet::new();
    let mut unique = Vec::new();
    for signer in signers {
        let parsed: alloy::primitives::Address = signer.parse().map_err(|error| {
            (
                StatusCode::BAD_REQUEST,
                format!("Invalid Uniswap envelope approval signer {signer}: {error}"),
            )
        })?;
        if parsed == alloy::primitives::Address::ZERO {
            continue;
        }
        let key = format!("{parsed:#x}");
        if seen.insert(key.clone()) {
            unique.push(key);
        }
    }
    Ok(unique)
}

fn json_bool(value: Option<&serde_json::Value>) -> Option<bool> {
    match value? {
        serde_json::Value::Bool(value) => Some(*value),
        serde_json::Value::String(value) => value.parse().ok(),
        _ => None,
    }
}

fn json_u64(value: Option<&serde_json::Value>) -> Option<u64> {
    match value? {
        serde_json::Value::Number(value) => value.as_u64(),
        serde_json::Value::String(value) => value.parse().ok(),
        _ => None,
    }
}

fn json_u128(value: Option<&serde_json::Value>) -> Option<u128> {
    match value? {
        serde_json::Value::Number(value) => value.as_u64().map(u128::from),
        serde_json::Value::String(value) => value.parse().ok(),
        _ => None,
    }
}

fn decimal_to_u128(value: Decimal, label: &str) -> Result<u128, (StatusCode, String)> {
    if value <= Decimal::ZERO || !value.fract().is_zero() {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("Uniswap envelope {label} must be a positive base-unit integer"),
        ));
    }
    value.to_string().parse::<u128>().map_err(|error| {
        (
            StatusCode::BAD_REQUEST,
            format!("Uniswap envelope {label} is out of range: {error}"),
        )
    })
}

fn min_output_per_input(
    amount_in: u128,
    min_amount_out: u128,
) -> Result<u128, (StatusCode, String)> {
    if amount_in == 0 {
        return Err((StatusCode::BAD_REQUEST, "amount_in must be positive".into()));
    }
    min_amount_out
        .checked_mul(WAD)
        .map(|value| value / amount_in)
        .filter(|value| *value > 0)
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "Uniswap envelope min_output_per_input must be positive".to_string(),
            )
        })
}

fn uniswap_fee_tier(metadata: &serde_json::Value) -> u32 {
    metadata
        .get("fee_tier")
        .or_else(|| metadata.get("pool_fee"))
        .and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok()))
        .map(|value| value as u32)
        .unwrap_or(DEFAULT_UNISWAP_FEE_TIER)
}

fn apply_slippage_bps(amount_out: u128, slippage_bps: u64) -> u128 {
    let slippage_bps = u128::from(slippage_bps).min(BPS_DENOMINATOR);
    amount_out.saturating_mul(BPS_DENOMINATOR - slippage_bps) / BPS_DENOMINATOR
}

async fn quote_uniswap_exact_input(
    rpc_url: &str,
    token_in: &str,
    token_out: &str,
    amount_in: u128,
    fee_tier: u32,
) -> Result<u128, (StatusCode, String)> {
    let token_in: Address = token_in.parse().map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("Invalid Uniswap quote token_in: {e}"),
        )
    })?;
    let token_out: Address = token_out.parse().map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("Invalid Uniswap quote token_out: {e}"),
        )
    })?;
    let quoter: Address = UNISWAP_V3_QUOTER.parse().expect("valid Uniswap V3 quoter");
    let call = IQuoter::quoteExactInputSingleCall {
        tokenIn: token_in,
        tokenOut: token_out,
        fee: Uint24::from(fee_tier),
        amountIn: U256::from(amount_in),
        sqrtPriceLimitX96: Uint160::ZERO,
    };
    let body = Client::new()
        .post(rpc_url)
        .json(&serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "eth_call",
            "params": [
                {
                    "to": format!("{quoter}"),
                    "data": format!("0x{}", hex::encode(call.abi_encode())),
                },
                "latest",
            ],
        }))
        .send()
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!("Failed to quote Uniswap route: {e}"),
            )
        })?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!("Failed to decode Uniswap quote response: {e}"),
            )
        })?;
    if let Some(error) = body.get("error") {
        return Err((
            StatusCode::BAD_GATEWAY,
            format!("Uniswap quote failed: {error}"),
        ));
    }
    let result = body
        .get("result")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            (
                StatusCode::BAD_GATEWAY,
                "Uniswap quote response missing result".to_string(),
            )
        })?;
    U256::from_str_radix(result.trim_start_matches("0x"), 16)
        .map(|value| value.to::<u128>())
        .map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!("Uniswap quote result is invalid: {e}"),
            )
        })
}

async fn quote_uniswap_exact_input_for_intent(
    bot: &BotContext,
    intent: &TradeIntent,
) -> Result<u128, (StatusCode, String)> {
    let amount_in = decimal_to_u128(intent.amount_in, "amount_in")?;
    quote_uniswap_exact_input(
        &bot.rpc_url,
        &intent.token_in,
        &intent.token_out,
        amount_in,
        uniswap_fee_tier(&intent.metadata),
    )
    .await
}

fn current_execution_timestamp() -> u64 {
    chrono::Utc::now().timestamp().max(0) as u64
}

async fn latest_chain_timestamp(rpc_url: &str) -> Result<u64, (StatusCode, String)> {
    let body = Client::new()
        .post(rpc_url)
        .json(&serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "eth_getBlockByNumber",
            "params": ["latest", false],
        }))
        .send()
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!("Failed to read execution-chain timestamp: {e}"),
            )
        })?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!("Failed to decode execution-chain timestamp response: {e}"),
            )
        })?;
    if let Some(error) = body.get("error") {
        return Err((
            StatusCode::BAD_GATEWAY,
            format!("Execution-chain timestamp lookup failed: {error}"),
        ));
    }
    let timestamp = body
        .get("result")
        .and_then(|result| result.get("timestamp"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            (
                StatusCode::BAD_GATEWAY,
                "Execution-chain timestamp response missing latest block timestamp".to_string(),
            )
        })?;
    u64::from_str_radix(timestamp.trim_start_matches("0x"), 16).map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Execution-chain timestamp is invalid: {e}"),
        )
    })
}

async fn get_envelope_handler(
    Extension(bot): Extension<BotContext>,
) -> Json<Option<SignedUniswapEnvelope>> {
    Json(get_signed_uniswap_envelope(&bot.bot_id))
}

async fn update_envelope_handler(
    State(_state): State<Arc<MultiBotTradingState>>,
    Extension(bot): Extension<BotContext>,
    Json(env): Json<SignedUniswapEnvelope>,
) -> Result<Json<SignedUniswapEnvelope>, (StatusCode, String)> {
    set_signed_uniswap_envelope_on_chain_time(&bot, &env).await?;
    Ok(Json(env))
}

async fn quote_handler(
    Extension(bot): Extension<BotContext>,
    Json(req): Json<UniswapQuoteRequest>,
) -> Result<Json<UniswapQuoteResponse>, (StatusCode, String)> {
    let policy = envelope_policy(&bot.risk_params)?;
    enforce_allowed_pairs(policy, &req.token_in, &req.token_out)?;
    let amount_in = decimal_to_u128(
        req.amount_in.parse::<Decimal>().map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                format!("Invalid Uniswap quote amount_in: {e}"),
            )
        })?,
        "amount_in",
    )?;
    let fee_tier = req.fee_tier.unwrap_or(DEFAULT_UNISWAP_FEE_TIER);
    let default_slippage_bps = json_u64(policy.get("max_slippage_bps")).unwrap_or(100);
    let slippage_bps = req.slippage_bps.unwrap_or(default_slippage_bps);
    let amount_out = quote_uniswap_exact_input(
        &bot.rpc_url,
        &req.token_in,
        &req.token_out,
        amount_in,
        fee_tier,
    )
    .await?;
    Ok(Json(UniswapQuoteResponse {
        token_in: req.token_in,
        token_out: req.token_out,
        amount_in: amount_in.to_string(),
        amount_out: amount_out.to_string(),
        min_amount_out: apply_slippage_bps(amount_out, slippage_bps).to_string(),
        fee_tier,
        slippage_bps,
    }))
}

pub fn multi_bot_router() -> Router<Arc<MultiBotTradingState>> {
    Router::new()
        .route(
            "/uniswap/envelope",
            get(get_envelope_handler).put(update_envelope_handler),
        )
        .route("/uniswap/quote", post(quote_handler))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Once;
    use trading_runtime::TradeIntentBuilder;

    const TEST_VALIDATOR_PRIVATE_KEY: &str =
        "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    const TEST_VALIDATOR_ADDRESS: &str = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
    const SECOND_VALIDATOR_PRIVATE_KEY: &str =
        "59c6995e998f97a5a004497e5da8e8e1e82cc5f0105b9569e973e99508d83f0b";
    const SECOND_VALIDATOR_ADDRESS: &str = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
    const TEST_TRADE_VALIDATOR: &str = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

    fn ensure_test_state_dir() {
        static INIT: Once = Once::new();
        INIT.call_once(|| {
            let tmp = tempfile::TempDir::new().unwrap();
            unsafe { std::env::set_var("BLUEPRINT_STATE_DIR", tmp.path()) };
            std::mem::forget(tmp);
        });
    }

    async fn spawn_validator() -> String {
        let contract = TEST_TRADE_VALIDATOR.parse().unwrap();
        let app = trading_validator_lib::server::ValidatorServer::new(0)
            .with_signer(TEST_VALIDATOR_PRIVATE_KEY, 31337, contract)
            .unwrap()
            .router();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{addr}")
    }

    async fn spawn_unselected_signing_validator() -> String {
        async fn handler(Json(request): Json<ValidateEnvelopeRequest>) -> Json<serde_json::Value> {
            let signature = request
                .envelope
                .sign_with_private_key(
                    SECOND_VALIDATOR_PRIVATE_KEY,
                    80,
                    31337,
                    TEST_TRADE_VALIDATOR,
                )
                .unwrap();
            let signed_envelope = SignedUniswapEnvelope {
                envelope: request.envelope,
                approval_signers: request.approval_signers,
                signatures: vec![signature],
            };
            Json(serde_json::json!({
                "approved": true,
                "score": 80,
                "reasoning": "unselected validator signed anyway",
                "validator": SECOND_VALIDATOR_ADDRESS,
                "signed_envelope": signed_envelope
            }))
        }

        let app = Router::new().route("/envelopes/validate", axum::routing::post(handler));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{addr}")
    }

    fn test_state() -> MultiBotTradingState {
        MultiBotTradingState {
            operator_private_key: format!("0x{TEST_VALIDATOR_PRIVATE_KEY}"),
            market_data_base_url: "http://localhost:1234".into(),
            validation_deadline_secs: 300,
            min_validator_score: 50,
            resolve_bot: Box::new(|_| None),
            clob_client: None,
            chain_client: None,
            chain_client_rpc_url: None,
            chain_client_chain_id: None,
        }
    }

    async fn spawn_rpc(timestamp: u64) -> String {
        async fn handler(
            State(timestamp): State<u64>,
            Json(_body): Json<serde_json::Value>,
        ) -> Json<serde_json::Value> {
            Json(serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "timestamp": format!("0x{timestamp:x}")
                }
            }))
        }
        let app = Router::new()
            .route("/", axum::routing::post(handler))
            .with_state(timestamp);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{addr}")
    }

    fn test_bot(validator_endpoint: String, rpc_url: String) -> BotContext {
        BotContext {
            bot_id: format!("bot-uniswap-envelope-{}", uuid::Uuid::new_v4()),
            vault_address: "0x0000000000000000000000000000000000000001".into(),
            paper_trade: false,
            chain_id: 31337,
            rpc_url,
            strategy_config: serde_json::json!({"strategy_type": "dex"}),
            risk_params: serde_json::json!({
                "uniswap_envelope": {
                    "enabled": true,
                    "max_duration_secs": 3600,
                    "max_single_amount_in": "1000000000000000000",
                    "max_total_amount_in": "2000000000000000000",
                    "max_slippage_bps": 100,
                    "allowed_pairs": [{
                        "token_in": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
                        "token_out": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
                    }]
                }
            }),
            validator_endpoints: vec![validator_endpoint],
            validation_trust: trading_runtime::ValidationTrust::Envelope,
        }
    }

    #[tokio::test]
    async fn requests_stores_and_reuses_signed_uniswap_envelope() {
        ensure_test_state_dir();
        let validator = spawn_validator().await;
        let rpc_url = spawn_rpc(chrono::Utc::now().timestamp().max(0) as u64).await;
        let state = test_state();
        let bot = test_bot(validator, rpc_url);
        let intent = TradeIntentBuilder::new()
            .strategy_id("dex-test")
            .action(Action::Swap)
            .token_in("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")
            .token_out("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")
            .amount_in(Decimal::from(500_000_000_000_000_000u128))
            .min_amount_out(Decimal::from(1_000_000_000u64))
            .target_protocol("uniswap_v3")
            .chain_id(31337)
            .build()
            .unwrap();

        let signed = get_or_request_signed_uniswap_envelope(
            &state,
            &bot,
            &intent,
            vec![TEST_VALIDATOR_ADDRESS.into()],
            1,
        )
        .await
        .unwrap();

        assert_eq!(signed.signatures.len(), 1);
        assert_eq!(signed.envelope.max_single_amount_in, "1000000000000000000");
        assert_eq!(signed.envelope.token_in, intent.token_in);
        assert!(get_signed_uniswap_envelope(&bot.bot_id).is_some());

        let reused = get_or_request_signed_uniswap_envelope(
            &state,
            &bot,
            &intent,
            vec![TEST_VALIDATOR_ADDRESS.into()],
            1,
        )
        .await
        .unwrap();
        assert_eq!(reused.envelope.envelope_id, signed.envelope.envelope_id);
    }

    #[tokio::test]
    async fn ignores_uniswap_envelope_signatures_outside_selected_approval_signers() {
        ensure_test_state_dir();
        let selected_validator = spawn_validator().await;
        let unselected_validator = spawn_unselected_signing_validator().await;
        let rpc_url = spawn_rpc(chrono::Utc::now().timestamp().max(0) as u64).await;
        let state = test_state();
        let mut bot = test_bot(selected_validator, rpc_url);
        bot.validator_endpoints.push(unselected_validator);
        let intent = TradeIntentBuilder::new()
            .strategy_id("dex-test")
            .action(Action::Swap)
            .token_in("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")
            .token_out("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")
            .amount_in(Decimal::from(500_000_000_000_000_000u128))
            .min_amount_out(Decimal::from(1_000_000_000u64))
            .target_protocol("uniswap_v3")
            .chain_id(31337)
            .build()
            .unwrap();

        let signed = get_or_request_signed_uniswap_envelope(
            &state,
            &bot,
            &intent,
            vec![TEST_VALIDATOR_ADDRESS.into()],
            1,
        )
        .await
        .unwrap();

        assert_eq!(signed.signatures.len(), 1);
        assert_eq!(
            signed.signatures[0].signer.to_ascii_lowercase(),
            TEST_VALIDATOR_ADDRESS
        );
        assert_ne!(
            signed.signatures[0].signer.to_ascii_lowercase(),
            SECOND_VALIDATOR_ADDRESS
        );

        let stored = read_signed_uniswap_envelopes(&bot.bot_id);
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].signatures.len(), 1);
        assert_eq!(
            stored[0].signatures[0].signer.to_ascii_lowercase(),
            TEST_VALIDATOR_ADDRESS
        );
    }

    #[tokio::test]
    async fn expired_stored_uniswap_envelope_is_refreshed_when_chain_clock_lags() {
        ensure_test_state_dir();
        let validator = spawn_validator().await;
        let wall_now = current_execution_timestamp();
        let chain_now = wall_now.saturating_sub(3_600);
        let rpc_url = spawn_rpc(chain_now).await;
        let state = test_state();
        let bot = test_bot(validator, rpc_url);
        let intent = TradeIntentBuilder::new()
            .strategy_id("dex-test")
            .action(Action::Swap)
            .token_in("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")
            .token_out("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")
            .amount_in(Decimal::from(500_000_000_000_000_000u128))
            .min_amount_out(Decimal::from(1_000_000_000u64))
            .target_protocol("uniswap_v3")
            .chain_id(31337)
            .build()
            .unwrap();
        let mut expired = SignedUniswapEnvelope {
            envelope: build_envelope(
                &bot,
                &intent,
                &[TEST_VALIDATOR_ADDRESS.into()],
                1,
                chain_now,
                wall_now,
            )
            .unwrap(),
            approval_signers: vec![TEST_VALIDATOR_ADDRESS.into()],
            signatures: Vec::new(),
        };
        expired.envelope.valid_from = chain_now.saturating_sub(5);
        expired.envelope.valid_until = wall_now.saturating_sub(10);
        let expired_id = expired.envelope.envelope_id.clone();
        write_signed_uniswap_envelopes(&bot.bot_id, vec![expired]).unwrap();

        let refreshed = get_or_request_signed_uniswap_envelope(
            &state,
            &bot,
            &intent,
            vec![TEST_VALIDATOR_ADDRESS.into()],
            1,
        )
        .await
        .unwrap();

        assert_ne!(refreshed.envelope.envelope_id, expired_id);
        assert!(refreshed.envelope.valid_until >= current_execution_timestamp());
        assert_eq!(refreshed.envelope.valid_from, chain_now.saturating_sub(5));
        assert_eq!(refreshed.signatures.len(), 1);

        let stored = read_signed_uniswap_envelopes(&bot.bot_id);
        assert_eq!(stored.len(), 1);
        assert_eq!(
            stored[0].envelope.envelope_id,
            refreshed.envelope.envelope_id
        );
    }

    #[tokio::test]
    async fn active_non_covering_uniswap_envelope_is_replaced() {
        ensure_test_state_dir();
        let validator = spawn_validator().await;
        let now = current_execution_timestamp();
        let rpc_url = spawn_rpc(now).await;
        let state = test_state();
        let bot = test_bot(validator, rpc_url);
        let strict_intent = TradeIntentBuilder::new()
            .strategy_id("dex-test")
            .action(Action::Swap)
            .token_in("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")
            .token_out("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")
            .amount_in(Decimal::from(500_000_000_000_000_000u128))
            .min_amount_out(Decimal::from(1_100_000_000u64))
            .target_protocol("uniswap_v3")
            .chain_id(31337)
            .build()
            .unwrap();
        let replacement_intent = TradeIntentBuilder::new()
            .strategy_id("dex-test")
            .action(Action::Swap)
            .token_in("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")
            .token_out("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")
            .amount_in(Decimal::from(500_000_000_000_000_000u128))
            .min_amount_out(Decimal::from(900_000_000u64))
            .target_protocol("uniswap_v3")
            .chain_id(31337)
            .build()
            .unwrap();
        let stale = SignedUniswapEnvelope {
            envelope: build_envelope(
                &bot,
                &strict_intent,
                &[TEST_VALIDATOR_ADDRESS.into()],
                1,
                now,
                now,
            )
            .unwrap(),
            approval_signers: vec![TEST_VALIDATOR_ADDRESS.into()],
            signatures: Vec::new(),
        };
        let stale_id = stale.envelope.envelope_id.clone();
        write_signed_uniswap_envelopes(&bot.bot_id, vec![stale]).unwrap();

        let replacement = get_or_request_signed_uniswap_envelope(
            &state,
            &bot,
            &replacement_intent,
            vec![TEST_VALIDATOR_ADDRESS.into()],
            1,
        )
        .await
        .unwrap();

        assert_ne!(replacement.envelope.envelope_id, stale_id);
        assert_eq!(replacement.signatures.len(), 1);
        let stored = read_signed_uniswap_envelopes(&bot.bot_id);
        assert_eq!(stored.len(), 1);
        assert_eq!(
            stored[0].envelope.envelope_id,
            replacement.envelope.envelope_id
        );
    }

    #[test]
    fn empty_allowed_pairs_rejects_envelope_scope() {
        let policy = serde_json::json!({
            "allowed_pairs": []
        });
        let err = enforce_allowed_pairs(
            policy.as_object().unwrap(),
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        )
        .unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert!(err.1.contains("allowed_pairs"));
    }

    #[test]
    fn token_specific_limits_do_not_fall_back_to_wrong_token_units() {
        let policy = serde_json::json!({
            "max_single_amount_in": "1500000000000000000",
            "max_single_amount_in_by_token": {
                "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": "1500000000000000000"
            }
        });
        let policy = policy.as_object().unwrap();
        let weth_limit = envelope_amount_limit(
            policy,
            "max_single_amount_in",
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        )
        .unwrap();
        assert_eq!(weth_limit, 1_500_000_000_000_000_000u128);

        let usdc_err = envelope_amount_limit(
            policy,
            "max_single_amount_in",
            "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        )
        .unwrap_err();
        assert_eq!(usdc_err.0, StatusCode::FORBIDDEN);
        assert!(usdc_err.1.contains("no max_single_amount_in limit"));
    }
}
