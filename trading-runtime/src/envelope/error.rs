use thiserror::Error;

#[derive(Debug, Error, PartialEq)]
pub enum EnvelopeError {
    #[error("Envelope bot_id does not match authenticated bot")]
    BotIdMismatch,
    #[error("Envelope vault_address does not match authenticated bot")]
    VaultMismatch,
    #[error("Envelope chain_id does not match authenticated bot")]
    ChainIdMismatch,
    #[error("Envelope protocol '{envelope}' does not match execution protocol '{execution}'")]
    ProtocolMismatch { envelope: String, execution: String },
    #[error("Envelope is expired (expires_at={expires_at})")]
    Expired { expires_at: u64 },
    #[error("Envelope version must be {expected}, got {got}")]
    VersionMismatch { expected: u64, got: u64 },
    #[error("Envelope min_signatures={min} exceeds approval signer count={count}")]
    MinSignaturesExceedsSigners { min: usize, count: usize },
    #[error("Envelope min_signatures must be ≥ 1")]
    ZeroMinSignatures,
    #[error("Envelope approval_signers must not be empty")]
    EmptySignerSet,
    #[error("No trusted envelope signers configured")]
    NoTrustedSigners,
    #[error("Policy max_drawdown_pct must be in (0, 100], got {got}")]
    InvalidDrawdownPct { got: String },
    #[error("Policy max_trade_size_usd must be > 0")]
    InvalidTradeSize,
    #[error("Policy max_total_exposure_usd must be > 0")]
    InvalidTotalExposure,
    #[error("Policy perps.min_stop_loss_distance must be < max_stop_loss_distance")]
    InvalidStopLossRange,
    #[error("Policy perps.max_leverage must be ≥ 1")]
    InvalidLeverage,
    #[error("Envelope signer {addr} is not in the approval signer set")]
    SignerNotInApprovalSet { addr: String },
    #[error("Envelope signer {addr} is not trusted by this operator")]
    SignerNotTrusted { addr: String },
    #[error("Envelope signature recovered a different signer (claimed {claimed}, got {recovered})")]
    SignerMismatch { claimed: String, recovered: String },
    #[error("Envelope has {got} unique trusted signatures, requires {required}")]
    InsufficientSignatures { got: usize, required: usize },
    #[error("Invalid envelope address '{addr}': {reason}")]
    InvalidAddress { addr: String, reason: String },
    #[error("Invalid envelope signature hex: {reason}")]
    InvalidSignatureHex { reason: String },
    #[error("Envelope signature must be 65 bytes, got {got}")]
    InvalidSignatureLength { got: usize },
    #[error("Envelope signature recovery failed: {reason}")]
    SignatureRecoveryFailed { reason: String },
    #[error("Policy hash encoding failed: {reason}")]
    HashEncodingFailed { reason: String },
    // Trade rejection errors
    #[error("Trade blocked: envelope is in close-only mode")]
    CloseOnlyMode,
    #[error("Trade blocked: asset '{asset}' not in envelope whitelist")]
    AssetNotAllowed { asset: String },
    #[error("Trade blocked: position size ${size} exceeds max ${max}")]
    PositionSizeExceeded { size: String, max: String },
    #[error("Trade blocked: leverage {leverage}x exceeds max {max}x")]
    LeverageExceeded { leverage: u32, max: u32 },
    #[error("Trade blocked: total exposure ${new_total} would exceed max ${max}")]
    TotalExposureExceeded { new_total: String, max: String },
    #[error("Trade blocked: stop-loss distance {distance} is below minimum {min}")]
    StopLossTooTight { distance: String, min: String },
    #[error("Trade blocked: stop-loss distance {distance} exceeds maximum {max}")]
    StopLossTooWide { distance: String, max: String },
    #[error("Trade blocked: stop-loss is required for all new positions")]
    StopLossRequired,
    #[error("Trade blocked: protocol '{protocol}' is not in the vault allowed-protocols list")]
    ProtocolNotAllowed { protocol: String },
    #[error("Trade blocked: token '{token}' is not in the allowed tokens-in list")]
    TokenInNotAllowed { token: String },
    #[error("Trade blocked: token '{token}' is not in the allowed tokens-out list")]
    TokenOutNotAllowed { token: String },
    #[error("Trade blocked: slippage {bps}bps exceeds max {max}bps")]
    SlippageExceeded { bps: u32, max: u32 },
    #[error("Trade blocked: market '{market_id}' is not in the allowed markets list")]
    MarketNotAllowed { market_id: String },
    #[error("Trade blocked: no perps policy configured in envelope")]
    MissingPerpsPolicy,
    #[error("Trade blocked: no vault policy configured in envelope")]
    MissingVaultPolicy,
    #[error("Trade blocked: no CLOB policy configured in envelope")]
    MissingClobPolicy,
}

impl From<EnvelopeError> for (axum::http::StatusCode, String) {
    fn from(e: EnvelopeError) -> Self {
        use EnvelopeError::*;
        use axum::http::StatusCode;
        let status = match &e {
            BotIdMismatch
            | VaultMismatch
            | ChainIdMismatch
            | ProtocolMismatch { .. }
            | Expired { .. }
            | VersionMismatch { .. }
            | MinSignaturesExceedsSigners { .. }
            | ZeroMinSignatures
            | EmptySignerSet
            | NoTrustedSigners
            | SignerNotInApprovalSet { .. }
            | SignerNotTrusted { .. }
            | SignerMismatch { .. }
            | InsufficientSignatures { .. }
            | InvalidDrawdownPct { .. }
            | InvalidTradeSize
            | InvalidTotalExposure
            | InvalidStopLossRange
            | InvalidLeverage
            | CloseOnlyMode
            | AssetNotAllowed { .. }
            | PositionSizeExceeded { .. }
            | LeverageExceeded { .. }
            | TotalExposureExceeded { .. }
            | StopLossTooTight { .. }
            | StopLossTooWide { .. }
            | StopLossRequired
            | ProtocolNotAllowed { .. }
            | TokenInNotAllowed { .. }
            | TokenOutNotAllowed { .. }
            | SlippageExceeded { .. }
            | MarketNotAllowed { .. }
            | MissingPerpsPolicy
            | MissingVaultPolicy
            | MissingClobPolicy => StatusCode::FORBIDDEN,
            InvalidAddress { .. }
            | InvalidSignatureHex { .. }
            | InvalidSignatureLength { .. }
            | SignatureRecoveryFailed { .. }
            | HashEncodingFailed { .. } => StatusCode::BAD_REQUEST,
        };
        (status, e.to_string())
    }
}
