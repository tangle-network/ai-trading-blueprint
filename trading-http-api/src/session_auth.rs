use std::sync::LazyLock;

use axum::{
    Json,
    extract::State,
    http::StatusCode,
};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};

use crate::TradingApiState;

/// Pending challenge awaiting a signature from the wallet owner.
struct PendingChallenge {
    bot_id: String,
    nonce: String,
    created_at: u64,
}

/// Validated session token for an authenticated owner.
pub struct OwnerSessionToken {
    pub token: String,
    pub owner_address: String,
    pub bot_id: String,
    pub created_at: u64,
    pub expires_at: u64,
}

/// nonce → PendingChallenge (auto-expired after 5 minutes)
static CHALLENGES: LazyLock<DashMap<String, PendingChallenge>> = LazyLock::new(DashMap::new);

/// token → OwnerSessionToken
static OWNER_TOKENS: LazyLock<DashMap<String, OwnerSessionToken>> = LazyLock::new(DashMap::new);

/// Tracks which message IDs were sent by the owner (for source enrichment).
/// bot_id → set of message IDs
pub static OWNER_MESSAGES: LazyLock<DashMap<String, std::collections::HashSet<String>>> =
    LazyLock::new(DashMap::new);

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

// ── Challenge endpoint ──────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ChallengeRequest {
    pub bot_id: String,
}

#[derive(Serialize)]
pub struct ChallengeResponse {
    pub challenge: String,
    pub nonce: String,
}

pub async fn challenge(
    Json(body): Json<ChallengeRequest>,
) -> Result<Json<ChallengeResponse>, (StatusCode, String)> {
    // Generate random nonce
    let nonce = hex::encode(rand::random::<[u8; 16]>());

    let challenge_text = format!("Sign to chat with bot {}:\n{}", body.bot_id, nonce);

    // Clean up expired challenges (older than 5 min)
    let cutoff = now_secs().saturating_sub(300);
    CHALLENGES.retain(|_, v| v.created_at > cutoff);

    CHALLENGES.insert(
        nonce.clone(),
        PendingChallenge {
            bot_id: body.bot_id,
            nonce: nonce.clone(),
            created_at: now_secs(),
        },
    );

    Ok(Json(ChallengeResponse {
        challenge: challenge_text,
        nonce,
    }))
}

// ── Verify endpoint ─────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct VerifyRequest {
    pub nonce: String,
    pub signature: String,
}

#[derive(Serialize)]
pub struct VerifyResponse {
    pub token: String,
    pub expires_at: u64,
}

pub async fn verify(
    State(state): State<std::sync::Arc<TradingApiState>>,
    Json(body): Json<VerifyRequest>,
) -> Result<Json<VerifyResponse>, (StatusCode, String)> {
    // Look up the pending challenge
    let pending = CHALLENGES
        .remove(&body.nonce)
        .map(|(_, v)| v)
        .ok_or((StatusCode::BAD_REQUEST, "Unknown or expired nonce".into()))?;

    // Check challenge hasn't expired (5 min)
    if now_secs() - pending.created_at > 300 {
        return Err((StatusCode::BAD_REQUEST, "Challenge expired".into()));
    }

    let challenge_text = format!("Sign to chat with bot {}:\n{}", pending.bot_id, pending.nonce);

    // Parse signature
    let sig_bytes = hex::decode(body.signature.strip_prefix("0x").unwrap_or(&body.signature))
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid signature hex: {e}")))?;

    let signature = alloy::signers::Signature::try_from(sig_bytes.as_slice())
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid signature: {e}")))?;

    // EIP-191 recovery: recover the signer address from the personal_sign message
    let recovered = signature
        .recover_address_from_msg(challenge_text.as_bytes())
        .map_err(|e| {
            (
                StatusCode::UNAUTHORIZED,
                format!("Signature recovery failed: {e}"),
            )
        })?;

    let recovered_str = format!("{recovered:#x}");

    // Verify the recovered address matches the operator address
    if !state.operator_address.is_empty()
        && recovered_str.to_lowercase() != state.operator_address.to_lowercase()
    {
        return Err((
            StatusCode::FORBIDDEN,
            format!(
                "Recovered address {recovered_str} does not match operator {}",
                state.operator_address
            ),
        ));
    }

    // Clean up expired tokens
    let now = now_secs();
    OWNER_TOKENS.retain(|_, v| v.expires_at > now);

    // Issue session token
    let token = format!("sess_{}", hex::encode(rand::random::<[u8; 24]>()));
    let expires_at = now + 3600; // 1 hour

    OWNER_TOKENS.insert(
        token.clone(),
        OwnerSessionToken {
            token: token.clone(),
            owner_address: recovered_str,
            bot_id: pending.bot_id,
            created_at: now,
            expires_at,
        },
    );

    Ok(Json(VerifyResponse { token, expires_at }))
}

/// Validate a session token and return the associated owner address if valid.
pub fn validate_owner_token(token: &str) -> Option<String> {
    let entry = OWNER_TOKENS.get(token)?;
    if entry.expires_at <= now_secs() {
        drop(entry);
        OWNER_TOKENS.remove(token);
        return None;
    }
    Some(entry.owner_address.clone())
}

/// Get the bot_id associated with a session token.
pub fn get_token_bot_id(token: &str) -> Option<String> {
    let entry = OWNER_TOKENS.get(token)?;
    if entry.expires_at <= now_secs() {
        return None;
    }
    Some(entry.bot_id.clone())
}
