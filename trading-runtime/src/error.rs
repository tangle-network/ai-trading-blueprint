use thiserror::Error;

#[derive(Error, Debug)]
pub enum TradingError {
    #[error("Validation failed: {0}")]
    ValidationFailed(String),

    #[error("Insufficient balance: have {have}, need {need}")]
    InsufficientBalance { have: String, need: String },

    #[error("Position limit exceeded: {0}")]
    PositionLimitExceeded(String),

    #[error("Rate limit exceeded: {max_per_hour} trades/hour")]
    RateLimitExceeded { max_per_hour: u32 },

    #[error("Slippage too high: expected {expected}, got {actual}")]
    SlippageExceeded { expected: String, actual: String },

    #[error("Circuit breaker triggered: drawdown {drawdown_pct}%")]
    CircuitBreaker { drawdown_pct: f64 },

    #[error("Adapter error: {protocol} — {message}")]
    AdapterError { protocol: String, message: String },

    #[error("Market data unavailable: {0}")]
    MarketDataUnavailable(String),

    #[error("Vault error: {0}")]
    VaultError(String),

    #[error("Validator error: {0}")]
    ValidatorError(String),

    #[error("Configuration error: {0}")]
    ConfigError(String),

    #[error("Serialization error: {0}")]
    SerializationError(String),

    #[error("HTTP error: {0}")]
    HttpError(String),

    #[error("Timeout: {0}")]
    Timeout(String),
}

impl From<reqwest::Error> for TradingError {
    fn from(e: reqwest::Error) -> Self {
        TradingError::HttpError(e.to_string())
    }
}

impl From<serde_json::Error> for TradingError {
    fn from(e: serde_json::Error) -> Self {
        TradingError::SerializationError(e.to_string())
    }
}
