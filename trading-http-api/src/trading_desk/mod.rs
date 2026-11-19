//! Wallet-approved third-party trading-desk connection (OAuth2 + PKCE).
//!
//! A desk (e.g. Trading) connects to a user's vault bot through a narrow,
//! explicitly approved, independently revocable grant:
//!
//! 1. The wallet owner approves a connection from an operator-authenticated
//!    browser session ([`authorize`]), producing a single-use authorization
//!    code bound to a PKCE `S256` challenge and a redirect URI allowlist.
//! 2. The desk exchanges the code + verifier at [`token_exchange`] for an
//!    opaque bearer credential (`tdsk_…`, stored hashed).
//! 3. The credential unlocks exactly four read/trade routes —
//!    [`account`], [`submit_order`], [`get_order`], [`delete_connection`] —
//!    each re-checking grant expiry/revocation and bot eligibility
//!    (ownership, active service, verified unexpired envelope with a vault
//!    spot-swap policy).
//! 4. Orders are durable per `(grant, clientOrderId)`: claimed before
//!    execution, never re-executed, replayed idempotently.
//!
//! The account/order reply shapes follow the Trading consumer contract
//! (`tangle-vault.ts`): `accountId` is the vault address, `instruments` are
//! canonical symbol strings, times are RFC 3339, and `filled` is reported
//! only from observed on-chain settlement — a paper result or a bare
//! execution acknowledgment is never a fill (`unknown`/`pending` instead).
//! Grants bind to one vault + chain + trading mode, so reassigning a bot
//! cannot inherit a live connection.
//!
//! The router is mounted on the outer multi-bot router (ahead of the
//! per-bot auth middleware) because its credentials are distinct from the
//! per-bot bearer tokens. Wallet-session routes authenticate with the same
//! PASETO session tokens as the operator API (`sandbox_runtime::session_auth`),
//! which works because both servers run in one process sharing
//! `SESSION_AUTH_SECRET`.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use once_cell::sync::Lazy;
use rand::RngCore;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use sandbox_runtime::store::PersistentStore;
use trading_runtime::token_metadata::token_metadata_for_chain;

use crate::routes::execute::{AmountFormat, ExecuteRequest, IntentPayload, ValidationPayload};
use crate::{BotContext, MultiBotTradingState};

mod consent;
mod reconcile;
mod trading;

#[cfg(test)]
mod tests;

use consent::{authorize, authorize_preview, token_exchange};
use trading::{
    account, delete_connection, get_order, list_connections, revoke_connection, submit_order,
};

// ── Configuration ────────────────────────────────────────────────────────────

/// OAuth `client_id` the desk MUST send at the token endpoint.
pub const CLIENT_ID: &str = "tangle-trading";

/// Default redirect URI (the desk's production callback).
const DEFAULT_REDIRECT_URI: &str =
    "https://trading.tangle.tools/api/trading/live/oauth/tangle-vault/callback";

/// Authorization-code lifetime (seconds).
pub const CODE_TTL_SECS: u64 = 600;

/// Default grant lifetime (seconds).
pub const DEFAULT_GRANT_TTL_SECS: u64 = 86_400;

const MIN_GRANT_TTL_SECS: u64 = 60;
const MAX_GRANT_TTL_SECS: u64 = 604_800;

/// Only instrument currently offered; quote leg is always USDC.
pub const QUOTE_CURRENCY: &str = "USDC";
const INSTRUMENT_BASE: &str = "WETH";
const DESK_PROTOCOL: &str = "uniswap_v3";
const DESK_STRATEGY_ID: &str = "trading-desk";
pub(crate) const NETWORK_TEST: &str = "test";
pub(crate) const NETWORK_LIVE: &str = "live";

/// Redirect URIs accepted at authorize time: the production default plus any
/// comma-separated extras from `TRADING_DESK_REDIRECT_URIS` (tests, staging).
fn redirect_allowlist() -> Vec<String> {
    let mut list = vec![DEFAULT_REDIRECT_URI.to_string()];
    if let Ok(extra) = std::env::var("TRADING_DESK_REDIRECT_URIS") {
        list.extend(
            extra
                .split(',')
                .map(str::trim)
                .filter(|uri| !uri.is_empty())
                .map(ToOwned::to_owned),
        );
    }
    list
}

/// Map the public `network` label to a deployment chain id.
///
/// Defaults: `test` → 998 (HyperEVM testnet), `live` → 999 (HyperEVM
/// mainnet). Overridable via `TRADING_DESK_TEST_CHAIN_ID` /
/// `TRADING_DESK_LIVE_CHAIN_ID` so integration tests can target anvil
/// (31337) without new plumbing.
pub fn network_chain_id(network: &str) -> Option<u64> {
    match network {
        NETWORK_TEST => std::env::var("TRADING_DESK_TEST_CHAIN_ID")
            .ok()
            .and_then(|raw| raw.parse().ok())
            .or(Some(998)),
        NETWORK_LIVE => std::env::var("TRADING_DESK_LIVE_CHAIN_ID")
            .ok()
            .and_then(|raw| raw.parse().ok())
            .or(Some(999)),
        _ => None,
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

// ── Vault-family capability (enrollment gate) ────────────────────────────────

/// Directory holding the per-chain deployment manifests. Owned by the
/// operator environment (`TRADING_DESK_DEPLOYMENTS_DIR`), defaulting to
/// `deployments` in the working directory.
fn desk_deployments_dir() -> std::path::PathBuf {
    std::env::var_os("TRADING_DESK_DEPLOYMENTS_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("deployments"))
}

/// Chains with a verified EVM envelope-stack deployment. Enrollment is the
/// `deployments/{chain}/v3.json` manifest written by `DeployEnvelopeV3` and
/// verified by `VerifyEnvelopeV3` (runbook §7) — the vault family that
/// implements `executeUniswapV3SwapEnvelope`. The published 998/999
/// `hyperliquid-vault.json` manifests are a HyperCore-only family without
/// that method, so those chains stay unenrolled and the desk refuses their
/// grants; see docs/runbook.md ("Trading desk activation").
pub fn envelope_stack_chains_in(dir: &std::path::Path) -> Vec<u64> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut chains = Vec::new();
    for entry in entries.flatten() {
        let manifest = entry.path().join("v3.json");
        let Ok(raw) = std::fs::read_to_string(&manifest) else {
            continue;
        };
        match serde_json::from_str::<serde_json::Value>(&raw) {
            Ok(value) => match value.get("chainId").and_then(|chain| chain.as_u64()) {
                Some(chain) => chains.push(chain),
                None => tracing::warn!(
                    manifest = %manifest.display(),
                    "v3 deployment manifest missing chainId"
                ),
            },
            Err(err) => tracing::warn!(
                manifest = %manifest.display(),
                error = %err,
                "unparseable v3 deployment manifest"
            ),
        }
    }
    chains
}

fn chain_has_envelope_stack(chain_id: u64) -> bool {
    envelope_stack_chains_in(&desk_deployments_dir()).contains(&chain_id)
}

// ── Bot projection (injected by the binary) ──────────────────────────────────

/// Operator-owned projection of a bot record the desk flow needs. Injected
/// via `MultiBotTradingState::desk_resolve_bot` so this crate keeps no
/// dependency on `trading-blueprint-lib`.
#[derive(Debug, Clone)]
pub struct DeskBotRecord {
    pub bot_id: String,
    pub name: String,
    /// Wallet that owns the bot (`submitter_address`); must match the
    /// authorizing session.
    pub owner_address: String,
    pub vault_address: String,
    pub chain_id: u64,
    pub rpc_url: String,
    pub paper_trade: bool,
    pub trading_active: bool,
    /// Blueprint service id; 0 = not yet deployed.
    pub service_id: u64,
    pub strategy_config: serde_json::Value,
    pub risk_params: serde_json::Value,
    pub validation_trust: trading_runtime::ValidationTrust,
}

impl DeskBotRecord {
    fn bot_context(&self) -> BotContext {
        BotContext {
            bot_id: self.bot_id.clone(),
            vault_address: self.vault_address.clone(),
            paper_trade: self.paper_trade,
            chain_id: self.chain_id,
            rpc_url: self.rpc_url.clone(),
            strategy_config: self.strategy_config.clone(),
            risk_params: self.risk_params.clone(),
            validator_endpoints: Vec::new(),
            validation_trust: self.validation_trust,
        }
    }
}

// ── Grant + order persistence ────────────────────────────────────────────────

/// A desk connection grant. Secrets (authorization code, access token) are
/// stored only as SHA-256 hex digests.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeskGrant {
    pub grant_id: String,
    pub owner_address: String,
    pub bot_id: String,
    pub network: String,
    pub chain_id: u64,
    /// Vault the grant is bound to. Every desk request re-checks it so
    /// reassigning the bot id to a different vault cannot reuse authority.
    #[serde(default)]
    pub vault_address: String,
    /// Grants predating the execution-mode binding require new consent.
    #[serde(default)]
    pub paper_at_grant: Option<bool>,
    #[serde(default)]
    pub envelope_digest: Option<alloy::primitives::B256>,
    pub redirect_uri: String,
    pub issued_at: u64,
    pub expires_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revoked_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<u64>,
    pub phase: GrantPhase,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GrantPhase {
    /// Authorization code issued; waiting for the token exchange.
    Pending {
        code_hash: String,
        code_challenge: String,
        code_expires_at: u64,
    },
    /// Access token issued; the connection is live until expiry/revocation.
    Active { token_hash: String },
}

impl DeskGrant {
    fn is_active(&self) -> bool {
        matches!(self.phase, GrantPhase::Active { .. })
            && self.revoked_at.is_none()
            && now_secs() < self.expires_at
    }
}

/// Immutable chain inputs used to identify this order after a process restart.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChainOrder {
    pub from_block: u64,
    pub router: alloy::primitives::Address,
    pub token_in: alloy::primitives::Address,
    pub token_out: alloy::primitives::Address,
    pub base_decimals: u8,
    pub quote_decimals: u8,
}

/// Durable desk order. The `(grant_id, client_order_id)` pair is claimed
/// atomically before execution; replays return the stored record.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeskOrder {
    pub grant_id: String,
    pub bot_id: String,
    pub network: String,
    pub chain_id: u64,
    /// Vault the grant was bound to when the order was claimed (`accountId`).
    #[serde(default)]
    pub vault_address: String,
    pub client_order_id: String,
    pub instrument: String,
    /// `buy` (quote → base) or `sell` (base → quote).
    pub side: String,
    pub quantity: String,
    pub limit_price: String,
    /// Executor inputs (human-readable decimals), for audit.
    pub amount_in: String,
    pub min_amount_out: String,
    /// Canonical intent hash staged at claim time, before execution:
    /// reconciliation proves or refutes this exact intent against the vault
    /// (`executedIntents` + `TradeExecuted` logs) when a submit outcome is
    /// uncertain.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chain_order: Option<ChainOrder>,
    /// Unix seconds until which the staged intent can still execute on
    /// chain; expiry with no execution is a definitive rejection.
    #[serde(default)]
    pub deadline: u64,
    pub status: DeskOrderStatus,
    /// On-chain tx hash once one exists (the venue order id on this desk).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub venue_order_id: Option<String>,
    /// Observed settlement, in canonical decimal strings. Set only when the
    /// chain settlement was actually observed — never from a paper result or
    /// a bare execution acknowledgment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filled_quantity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quote_amount: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub average_fill_price: Option<String>,
    pub paper: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeskOrderStatus {
    Pending,
    Filled,
    /// An atomic sell settled with some input left in the vault and no open remainder.
    Cancelled,
    Rejected,
    /// Outcome exists but cannot be confirmed on chain (paper execution, or a
    /// settlement whose observation was lost or undecodable).
    Unknown,
}

impl DeskOrderStatus {
    fn terminal(self) -> bool {
        matches!(self, Self::Filled | Self::Cancelled | Self::Rejected)
    }

    fn as_str(self) -> &'static str {
        match self {
            DeskOrderStatus::Pending => "pending",
            DeskOrderStatus::Filled => "filled",
            DeskOrderStatus::Cancelled => "cancelled",
            DeskOrderStatus::Rejected => "rejected",
            DeskOrderStatus::Unknown => "unknown",
        }
    }
}

static GRANT_WRITE_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
static ORDER_WRITE_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

static GRANTS: Lazy<PersistentStore<DeskGrant>> =
    Lazy::new(|| PersistentStore::open(grants_path()).expect("open trading-desk grants store"));
static ORDERS: Lazy<PersistentStore<DeskOrder>> =
    Lazy::new(|| PersistentStore::open(orders_path()).expect("open trading-desk orders store"));

fn desk_dir() -> PathBuf {
    #[cfg(any(test, feature = "test-utils"))]
    {
        if let Some(path) = TEST_DIR_OVERRIDE
            .lock()
            .expect("desk test dir mutex")
            .as_ref()
        {
            return path.clone();
        }
    }
    sandbox_runtime::store::state_dir()
}

fn grants_path() -> PathBuf {
    desk_dir().join("trading-desk-grants.json")
}

fn orders_path() -> PathBuf {
    desk_dir().join("trading-desk-orders.json")
}

/// Test-only override for the desk store directory (mirrors
/// `learning_store::set_test_dir`).
#[cfg(any(test, feature = "test-utils"))]
static TEST_DIR_OVERRIDE: Lazy<Mutex<Option<PathBuf>>> = Lazy::new(|| Mutex::new(None));

#[cfg(any(test, feature = "test-utils"))]
pub fn set_test_dir(path: PathBuf) {
    *TEST_DIR_OVERRIDE.lock().expect("desk test dir mutex") = Some(path);
}

fn order_key(grant_id: &str, client_order_id: &str) -> String {
    format!("order:{grant_id}:{client_order_id}")
}

// ── Crypto / encoding helpers ────────────────────────────────────────────────

fn random_hex(nbytes: usize) -> String {
    let mut bytes = vec![0u8; nbytes];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn sha256_hex(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    hex::encode(digest)
}

/// Base64url without padding (RFC 7636 encoding).
fn b64url(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(triple >> 18) as usize & 63] as char);
        out.push(ALPHABET[(triple >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[(triple >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[triple as usize & 63] as char);
        }
    }
    out
}

/// RFC 7636 §4.1 unreserved characters.
fn is_unreserved(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~')
}

fn valid_code_verifier(verifier: &str) -> bool {
    (43..=128).contains(&verifier.len()) && verifier.bytes().all(is_unreserved)
}

fn valid_code_challenge(challenge: &str) -> bool {
    challenge.len() == 43
        && challenge
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn pkce_s256(verifier: &str) -> String {
    b64url(&Sha256::digest(verifier.as_bytes()))
}

// ── Request authentication ───────────────────────────────────────────────────

const DESK_TOKEN_PREFIX: &str = "tdsk_";

fn bearer_token(headers: &HeaderMap) -> Option<String> {
    let value = headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?;
    let rest = value
        .strip_prefix("Bearer ")
        .or_else(|| value.strip_prefix("bearer "))?;
    let token = rest.trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

/// Resolve the wallet address of an operator browser session (PASETO token
/// in the `Authorization: Bearer` header, exactly like the operator API).
#[allow(clippy::result_large_err)] // axum handlers return `Response` on error
fn wallet_session_address(headers: &HeaderMap) -> Result<String, Response> {
    let token = bearer_token(headers)
        .ok_or_else(|| desk_error(StatusCode::UNAUTHORIZED, "missing session credentials"))?;
    if token.starts_with(DESK_TOKEN_PREFIX) {
        return Err(desk_error(
            StatusCode::UNAUTHORIZED,
            "desk tokens cannot call wallet-session routes",
        ));
    }
    sandbox_runtime::session_auth::validate_session_token(&token)
        .map(|claims| claims.address)
        .map_err(|err| desk_error(StatusCode::UNAUTHORIZED, &format!("invalid session: {err}")))
}

/// Resolve an active grant + its bot from a desk bearer token.
#[allow(clippy::result_large_err)] // axum handlers return `Response` on error
fn desk_grant(
    state: &MultiBotTradingState,
    headers: &HeaderMap,
) -> Result<(DeskGrant, DeskBotRecord), Response> {
    let token = bearer_token(headers)
        .ok_or_else(|| desk_error(StatusCode::UNAUTHORIZED, "missing desk credential"))?;
    let body = token
        .strip_prefix(DESK_TOKEN_PREFIX)
        .ok_or_else(|| desk_error(StatusCode::UNAUTHORIZED, "not a desk credential"))?;
    if body.len() != 64 || !body.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(desk_error(
            StatusCode::UNAUTHORIZED,
            "malformed desk credential",
        ));
    }
    let token_hash = sha256_hex(token.as_bytes());
    let grant = GRANTS
        .find(|grant| {
            matches!(&grant.phase, GrantPhase::Active { token_hash: hash } if *hash == token_hash)
        })
        .map_err(|err| desk_error(StatusCode::INTERNAL_SERVER_ERROR, &format!("grant store: {err}")))?
        .ok_or_else(|| desk_error(StatusCode::UNAUTHORIZED, "unknown desk credential"))?;

    let bot = bound_grant_bot(state, &grant)?;
    let _ = GRANTS.update(&format!("grant:{}", grant.grant_id), |record| {
        record.last_used_at = Some(now_secs());
    });
    Ok((grant, bot))
}

#[allow(clippy::result_large_err)]
fn bound_grant_bot(
    state: &MultiBotTradingState,
    grant: &DeskGrant,
) -> Result<DeskBotRecord, Response> {
    if grant.revoked_at.is_some() {
        return Err(desk_error(StatusCode::UNAUTHORIZED, "connection revoked"));
    }
    if now_secs() >= grant.expires_at {
        return Err(desk_error(StatusCode::UNAUTHORIZED, "connection expired"));
    }

    let bot = bot_for_grant(state, grant)?;
    if !bot.owner_address.eq_ignore_ascii_case(&grant.owner_address) {
        return Err(desk_error(
            StatusCode::UNAUTHORIZED,
            "the bot owner changed; reconnect",
        ));
    }

    // Binding checks: the connection's authority covers exactly this
    // vault + chain + trading mode. Any drift (bot reassigned to another
    // vault, moved chains, switched to paper) invalidates the credential —
    // reassignment must never inherit a live connection.
    if grant.vault_address.is_empty()
        || !bot.vault_address.eq_ignore_ascii_case(&grant.vault_address)
    {
        return Err(desk_error(
            StatusCode::UNAUTHORIZED,
            "bot no longer uses the vault this connection was approved for; reconnect",
        ));
    }
    if bot.chain_id != grant.chain_id {
        return Err(desk_error(
            StatusCode::CONFLICT,
            "bot moved to a different chain; reconnect",
        ));
    }
    if grant.paper_at_grant != Some(bot.paper_trade) {
        return Err(desk_error(
            StatusCode::CONFLICT,
            "paper or live trading mode changed or was never approved; reconnect",
        ));
    }
    let current_digest = crate::routes::envelope::get_signed_envelope(&grant.bot_id)
        .and_then(|envelope| envelope.digest().ok());
    if current_digest.is_none() || grant.envelope_digest != current_digest {
        return Err(desk_error(
            StatusCode::CONFLICT,
            "signed trading terms changed; reconnect",
        ));
    }

    Ok(bot)
}

#[allow(clippy::result_large_err)] // axum handlers return `Response` on error
fn bot_for_grant(
    state: &MultiBotTradingState,
    grant: &DeskGrant,
) -> Result<DeskBotRecord, Response> {
    let hook = state.desk_resolve_bot.as_ref().ok_or_else(|| {
        desk_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "desk bot lookup not configured",
        )
    })?;
    hook(&grant.bot_id).ok_or_else(|| {
        desk_error(
            StatusCode::UNAUTHORIZED,
            "bot for this connection no longer exists",
        )
    })
}

fn desk_error(status: StatusCode, message: &str) -> Response {
    (
        status,
        Json(json!({ "error": status.as_u16(), "message": message })),
    )
        .into_response()
}

fn oauth_error(error: &str, description: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": error, "error_description": description })),
    )
        .into_response()
}

// ── Eligibility ──────────────────────────────────────────────────────────────

struct Eligibility {
    verified_swap: Option<(trading_runtime::envelope::UniswapV3SwapEnforcement, u64)>,
    envelope_digest: Option<alloy::primitives::B256>,
    bot: Option<DeskBotRecord>,
    envelope_summary: Option<serde_json::Value>,
    problems: Vec<String>,
}

impl Eligibility {
    fn ok(&self) -> bool {
        self.problems.is_empty()
    }
    #[allow(clippy::result_large_err)] // axum handlers return `Response` on error
    fn require(&self) -> Result<&DeskBotRecord, Response> {
        if self.ok() {
            Ok(self.bot.as_ref().expect("eligible bot"))
        } else {
            Err(desk_error(
                StatusCode::FORBIDDEN,
                &format!(
                    "bot not eligible for desk connection: {}",
                    self.problems.join("; ")
                ),
            ))
        }
    }
}

/// All checks gate both authorization and ongoing desk credential use:
/// ownership by the session wallet, active trading, deployed service, and a
/// verified unexpired envelope whose policy explicitly covers vault spot
/// swaps on this chain.
fn check_eligibility(
    state: &MultiBotTradingState,
    bot_id: &str,
    session_address: &str,
) -> Eligibility {
    let mut problems = Vec::new();
    let mut envelope_summary = None;
    let mut verified_swap = None;
    let mut envelope_digest = None;

    let bot = state
        .desk_resolve_bot
        .as_ref()
        .and_then(|resolve| resolve(bot_id));
    let bot = match bot {
        Some(bot) => bot,
        None => {
            problems.push("bot not found".to_string());
            return Eligibility {
                bot: None,
                verified_swap,
                envelope_digest,
                envelope_summary,
                problems,
            };
        }
    };

    if bot.owner_address.trim().is_empty() {
        problems.push("bot has no owning wallet".to_string());
    } else if !bot.owner_address.eq_ignore_ascii_case(session_address) {
        problems.push("wallet does not own this bot".to_string());
    }
    if !bot.trading_active {
        problems.push("bot trading is paused".to_string());
    }
    if bot.service_id == 0 {
        problems.push("bot service is not deployed".to_string());
    }
    if !chain_has_envelope_stack(bot.chain_id) {
        problems.push(format!(
            "network chain {} has no enrolled EVM trading vault",
            bot.chain_id
        ));
    }

    match crate::routes::envelope::get_signed_envelope(bot_id) {
        Some(envelope) => {
            let binding = trading_runtime::envelope::EnvelopeBinding {
                bot_id: &bot.bot_id,
                vault_address: &bot.vault_address,
                chain_id: bot.chain_id,
                protocol: DESK_PROTOCOL,
            };
            let expired = envelope.expires_at <= now_secs();
            let protocol_ok = envelope.protocol.eq_ignore_ascii_case(DESK_PROTOCOL);
            let vault_policy_ok = envelope.policy.vault.is_some();

            let verify = if expired || !protocol_ok || !vault_policy_ok {
                // verify() would fail on binding/constraints anyway; keep the
                // specific problem message.
                None
            } else {
                envelope
                    .verify(&binding, &state.trusted_envelope_signers())
                    .ok()
                    .map(|signers| signers.len())
            };

            match verify {
                Some(signer_count) => {
                    envelope_digest = envelope.digest().ok();
                    let mut swap_terms = None;
                    if let Some(trading_runtime::envelope::EnvelopeEnforcement::UniswapV3Swap(
                        swap,
                    )) = &envelope.enforcement
                    {
                        swap_terms = desk_swap_terms(bot.chain_id, swap);
                        if swap_terms.is_some() {
                            verified_swap = Some((swap.clone(), envelope.expires_at));
                        }
                    }
                    if !bot.paper_trade && verified_swap.is_none() {
                        problems.push(
                            "the signed envelope must authorize the desk's spot pair and a positive spend limit"
                                .to_string(),
                        );
                    }
                    envelope_summary = Some(json!({
                        "digest": envelope_digest,
                        "swap": swap_terms,
                        "vaultAddress": bot.vault_address,
                        "protocol": envelope.protocol,
                        "expiresAt": envelope.expires_at,
                        "maxTradeSizeUsd": envelope.policy.max_trade_size_usd.to_string(),
                        "maxTotalExposureUsd": envelope.policy.max_total_exposure_usd.to_string(),
                        "signatures": signer_count,
                        "deploymentConfirmed": bot.service_id != 0,
                    }));
                }
                None => {
                    if expired {
                        problems.push("trading envelope has expired".to_string());
                    }
                    if !protocol_ok {
                        problems.push(
                            "trading envelope does not cover uniswap_v3 spot swaps".to_string(),
                        );
                    }
                    if !vault_policy_ok {
                        problems.push("trading envelope has no vault policy".to_string());
                    }
                    if !expired && protocol_ok && vault_policy_ok {
                        problems.push("trading envelope signature verification failed".to_string());
                    }
                }
            }
        }
        None => problems.push("no signed trading envelope for bot".to_string()),
    }

    if instruments_for_chain(bot.chain_id).is_empty() {
        problems.push(format!(
            "no desk instruments configured for chain {}",
            bot.chain_id
        ));
    }

    Eligibility {
        bot: Some(bot),
        verified_swap,
        envelope_digest,
        envelope_summary,
        problems,
    }
}

// ── Instruments ──────────────────────────────────────────────────────────────

/// One leg of a desk instrument, resolved from the trusted token registry.
struct InstrumentLeg {
    symbol: String,
    address: String,
    decimals: u8,
}

struct InstrumentSpec {
    name: String,
    base: InstrumentLeg,
    quote: InstrumentLeg,
}

/// Instruments offered for a chain: `{BASE}-{QUOTE}` spot pairs whose legs
/// both resolve in the trusted token registry (`token_metadata_for_chain`).
/// Registry-only by design: chains without a committed base token (e.g.
/// HyperEVM 998, which only commits USDC) report no instruments rather than
/// trading against an unverified address. Anvil chains (31337…) share the
/// canonical Ethereum registry, so local devnets work out of the box.
fn resolve_instrument(chain_id: u64, name: &str) -> Option<InstrumentSpec> {
    let (base_symbol, quote_symbol) = name.split_once('-')?;
    if !base_symbol.eq_ignore_ascii_case(INSTRUMENT_BASE)
        || !quote_symbol.eq_ignore_ascii_case(QUOTE_CURRENCY)
    {
        return None;
    }
    let base = token_metadata_for_chain(Some(chain_id), base_symbol)?;
    let quote = token_metadata_for_chain(Some(chain_id), quote_symbol)?;
    Some(InstrumentSpec {
        name: format!("{}-{}", base.symbol, quote.symbol),
        base: InstrumentLeg {
            symbol: base.symbol.to_string(),
            address: base.address.to_string(),
            decimals: base.decimals,
        },
        quote: InstrumentLeg {
            symbol: quote.symbol.to_string(),
            address: quote.address.to_string(),
            decimals: quote.decimals,
        },
    })
}

fn instruments_for_chain(chain_id: u64) -> Vec<serde_json::Value> {
    instrument_details_for_chain(chain_id)
}

fn desk_swap_terms(
    chain_id: u64,
    swap: &trading_runtime::envelope::UniswapV3SwapEnforcement,
) -> Option<serde_json::Value> {
    let input = token_metadata_for_chain(Some(chain_id), &swap.token_in.to_string())?;
    let output = token_metadata_for_chain(Some(chain_id), &swap.token_out.to_string())?;
    let side = match (input.symbol, output.symbol) {
        (INSTRUMENT_BASE, QUOTE_CURRENCY) => "sell",
        (QUOTE_CURRENCY, INSTRUMENT_BASE) => "buy",
        _ => return None,
    };
    if swap.router.is_zero()
        || swap.max_single_amount_in.is_zero()
        || swap.max_total_amount_in.is_zero()
    {
        return None;
    }
    Some(json!({
        "side": side, "input": input.symbol, "output": output.symbol, "router": swap.router,
        "maxInputPerSwap": raw_units_to_decimal(&swap.max_single_amount_in.to_string(), input.decimals)?,
        "maxInputTotal": raw_units_to_decimal(&swap.max_total_amount_in.to_string(), input.decimals)?,
    }))
}

/// Canonical instrument names (`{BASE}-{QUOTE}`) — the strings clients match
/// orders against.
fn instrument_names_for_chain(chain_id: u64) -> Vec<String> {
    resolve_instrument(chain_id, &format!("{INSTRUMENT_BASE}-{QUOTE_CURRENCY}"))
        .into_iter()
        .map(|spec| spec.name)
        .collect()
}

/// Rich instrument descriptors (legs, addresses, decimals) — extra metadata
/// beyond the name list the wire contract requires.
fn instrument_details_for_chain(chain_id: u64) -> Vec<serde_json::Value> {
    resolve_instrument(chain_id, &format!("{INSTRUMENT_BASE}-{QUOTE_CURRENCY}"))
        .into_iter()
        .map(|spec| instrument_json(&spec))
        .collect()
}

fn instrument_json(spec: &InstrumentSpec) -> serde_json::Value {
    json!({
        "instrument": spec.name,
        "base": spec.base.symbol,
        "quote": spec.quote.symbol,
        "baseAddress": spec.base.address,
        "quoteAddress": spec.quote.address,
        "baseDecimals": spec.base.decimals,
        "quoteDecimals": spec.quote.decimals,
    })
}

/// Unix seconds → RFC 3339 string (the time format the consumer parses).
fn rfc3339(secs: u64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp(secs as i64, 0)
        .unwrap_or_else(|| chrono::DateTime::<chrono::Utc>::from_timestamp(0, 0).expect("epoch"))
        .to_rfc3339()
}

/// EVM transaction hash (`0x` + 64 hex chars) — the only accepted
/// `venueOrderId` shape.
fn valid_tx_hash(hash: &str) -> bool {
    hash.len() == 66 && hash.starts_with("0x") && hash[2..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// Canonical human decimal string from raw base units: inserts the decimal
/// point at `decimals`, trims leading integer zeros and trailing fraction
/// zeros by string arithmetic (rust_decimal caps at 28 significant digits,
/// which 18-decimal token amounts can exceed). Matches the consumer's
/// canonicalization exactly.
fn raw_units_to_decimal(raw: &str, decimals: u8) -> Option<String> {
    if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let digits = raw.trim_start_matches('0');
    let digits = if digits.is_empty() { "0" } else { digits };
    let (int_part, frac_part) = if decimals as usize >= digits.len() {
        let zeros = "0".repeat(decimals as usize - digits.len());
        ("0".to_string(), format!("{zeros}{digits}"))
    } else {
        let split = digits.len() - decimals as usize;
        (digits[..split].to_string(), digits[split..].to_string())
    };
    let frac = frac_part.trim_end_matches('0');
    if frac.is_empty() {
        Some(int_part)
    } else {
        Some(format!("{int_part}.{frac}"))
    }
}

/// Desk router. Mount on the OUTER multi-bot router (ahead of the per-bot
/// auth middleware) — see [`crate::build_multi_bot_router`].
pub fn router() -> Router<Arc<MultiBotTradingState>> {
    Router::new()
        .route(
            "/api/trading-desk/authorize/preview",
            get(authorize_preview),
        )
        .route("/api/trading-desk/authorize", post(authorize))
        .route("/api/trading-desk/token", post(token_exchange))
        .route("/api/trading-desk/account", get(account))
        .route("/api/trading-desk/orders", post(submit_order))
        .route("/api/trading-desk/orders/{clientOrderId}", get(get_order))
        .route("/api/trading-desk/connection", delete(delete_connection))
        .route("/api/trading-desk/connections", get(list_connections))
        .route(
            "/api/trading-desk/connections/{grantId}",
            delete(revoke_connection),
        )
}
