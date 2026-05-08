//! Typed errors for Solana venues.
//!
//! These map cleanly to HTTP responses in `trading-http-api`; `From` impls
//! are provided for the most common upstream error types.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum SolanaError {
    /// RPC call to a Solana node failed (network unreachable, JSON-RPC error, etc).
    #[error("Solana RPC failed: {0}")]
    RpcFailed(String),

    /// The operator keypair is missing, malformed, or the file/secret is empty.
    #[error("Operator Solana keypair unavailable: {0}")]
    KeypairUnavailable(String),

    /// Realised slippage on a quote/swap exceeded the policy max.
    #[error("Slippage too high: realised {realised_bps}bps exceeds max {max_bps}bps")]
    Slippage { realised_bps: u32, max_bps: u32 },

    /// The signer's token balance is insufficient for the requested swap.
    #[error("Insufficient balance: have {have}, need {need} (mint {mint})")]
    InsufficientBalance { mint: String, have: u64, need: u64 },

    /// The transaction's recent blockhash expired before submission.
    #[error("Recent blockhash expired before submission")]
    BlockhashExpired,

    /// The user has no associated-token-account for the requested mint.
    /// Caller is expected to create the ATA before retrying.
    #[error("Missing associated-token-account for owner {owner} mint {mint}")]
    MissingAtaAccount { owner: String, mint: String },

    /// Generic network-level failure (timeout, connection reset).
    #[error("Network error: {0}")]
    Network(String),
}

impl From<reqwest::Error> for SolanaError {
    fn from(value: reqwest::Error) -> Self {
        if value.is_timeout() || value.is_connect() {
            Self::Network(value.to_string())
        } else {
            Self::RpcFailed(value.to_string())
        }
    }
}

impl From<SolanaError> for (axum::http::StatusCode, String) {
    fn from(value: SolanaError) -> Self {
        use SolanaError::*;
        use axum::http::StatusCode;
        let status = match &value {
            // Operator-side configuration / state issues.
            KeypairUnavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
            // Caller can fix these by adjusting the request.
            Slippage { .. }
            | InsufficientBalance { .. }
            | BlockhashExpired
            | MissingAtaAccount { .. } => StatusCode::BAD_REQUEST,
            // Upstream-side failures.
            RpcFailed(_) | Network(_) => StatusCode::BAD_GATEWAY,
        };
        (status, value.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;

    #[test]
    fn keypair_unavailable_is_503() {
        let (s, _): (StatusCode, String) = SolanaError::KeypairUnavailable("missing".into()).into();
        assert_eq!(s, StatusCode::SERVICE_UNAVAILABLE);
    }

    #[test]
    fn rpc_failed_is_502() {
        let (s, _): (StatusCode, String) = SolanaError::RpcFailed("boom".into()).into();
        assert_eq!(s, StatusCode::BAD_GATEWAY);
    }

    #[test]
    fn insufficient_balance_is_400() {
        let (s, _): (StatusCode, String) = SolanaError::InsufficientBalance {
            mint: "So11111111111111111111111111111111111111112".into(),
            have: 1,
            need: 2,
        }
        .into();
        assert_eq!(s, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn slippage_is_400() {
        let (s, _): (StatusCode, String) = SolanaError::Slippage {
            realised_bps: 100,
            max_bps: 50,
        }
        .into();
        assert_eq!(s, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn missing_ata_is_400() {
        let (s, _): (StatusCode, String) = SolanaError::MissingAtaAccount {
            owner: "owner".into(),
            mint: "mint".into(),
        }
        .into();
        assert_eq!(s, StatusCode::BAD_REQUEST);
    }
}
