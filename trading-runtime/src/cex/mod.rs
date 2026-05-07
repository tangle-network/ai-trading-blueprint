//! Generalized CEX (centralized exchange) integration framework.
//!
//! Defines the `DirectApiVenue` trait — a uniform interface for venues that
//! we trade against by direct REST API (no on-chain envelope contract). The
//! off-chain `apply_envelope_checks` (in `trading-http-api`) gates orders
//! before submission.
//!
//! Implementations live in submodules:
//! - `binance` — Binance Spot via REST + HMAC-SHA256 signing
//! - `coinbase` — Coinbase Advanced Trade via REST + ES256 JWT
//!
//! Hyperliquid pre-dates this framework and remains in `crate::hyperliquid`;
//! it can be wrapped into a `DirectApiVenue` adapter if a uniform call site
//! is needed in future.

use async_trait::async_trait;
use axum::http::StatusCode;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

pub mod binance;
pub mod coinbase;

// ── Public types ────────────────────────────────────────────────────────────

/// Direction of a CEX order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OrderSide {
    Buy,
    Sell,
}

impl OrderSide {
    pub fn as_str_upper(&self) -> &'static str {
        match self {
            Self::Buy => "BUY",
            Self::Sell => "SELL",
        }
    }
}

/// Order type — either a market order or a priced limit order.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CexOrderType {
    Market,
    Limit { price: Decimal },
}

/// Time-in-force for limit orders.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum TimeInForce {
    /// Good-Til-Cancelled.
    Gtc,
    /// Immediate-Or-Cancel.
    Ioc,
    /// Fill-Or-Kill.
    Fok,
}

impl TimeInForce {
    pub fn as_str_upper(&self) -> &'static str {
        match self {
            Self::Gtc => "GTC",
            Self::Ioc => "IOC",
            Self::Fok => "FOK",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CexOrderRequest {
    /// Venue-native symbol — e.g. "BTCUSDT" (Binance) or "BTC-USD" (Coinbase).
    pub symbol: String,
    pub side: OrderSide,
    pub order_type: CexOrderType,
    pub quantity: Decimal,
    #[serde(default)]
    pub time_in_force: Option<TimeInForce>,
    #[serde(default)]
    pub client_order_id: Option<String>,
}

/// Order lifecycle status normalized across venues.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CexOrderStatus {
    New,
    PartiallyFilled,
    Filled,
    Canceled,
    Rejected,
    Expired,
    Pending,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CexFee {
    pub asset: String,
    pub amount: Decimal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CexOrderResponse {
    pub venue: String,
    pub venue_order_id: String,
    pub status: CexOrderStatus,
    pub filled_quantity: Decimal,
    #[serde(default)]
    pub average_fill_price: Option<Decimal>,
    #[serde(default)]
    pub fees: Vec<CexFee>,
    /// Untyped raw venue payload for forensics / debugging.
    pub raw: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CexBalance {
    pub asset: String,
    pub free: Decimal,
    pub locked: Decimal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CexAccountInfo {
    pub venue: String,
    pub balances: Vec<CexBalance>,
    /// Untyped raw account payload.
    pub raw: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CexOpenOrder {
    pub venue: String,
    pub venue_order_id: String,
    pub symbol: String,
    pub side: OrderSide,
    pub price: Option<Decimal>,
    pub quantity: Decimal,
    pub filled_quantity: Decimal,
    pub status: CexOrderStatus,
    pub created_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CexTicker {
    pub venue: String,
    pub symbol: String,
    pub price: Decimal,
    #[serde(default)]
    pub bid: Option<Decimal>,
    #[serde(default)]
    pub ask: Option<Decimal>,
    pub timestamp_ms: i64,
}

// ── Errors ──────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum CexError {
    #[error("authentication failed: {0}")]
    AuthFailed(String),

    #[error("rate limited by venue (retry after {retry_after_ms} ms)")]
    RateLimited { retry_after_ms: u64 },

    #[error("insufficient balance: {0}")]
    InsufficientBalance(String),

    #[error("invalid symbol: {0}")]
    InvalidSymbol(String),

    #[error("order rejected: {reason}")]
    OrderRejected { reason: String },

    #[error("network error: {source}")]
    Network {
        #[source]
        source: Box<dyn std::error::Error + Send + Sync + 'static>,
    },

    #[error("request timed out")]
    Timeout,

    #[error("unknown venue: {0}")]
    UnknownVenue(String),

    #[error("misconfiguration: {0}")]
    Misconfigured(String),

    #[error("unexpected response: {0}")]
    Unexpected(String),
}

impl From<CexError> for (StatusCode, String) {
    fn from(err: CexError) -> Self {
        let status = match &err {
            CexError::AuthFailed(_) => StatusCode::UNAUTHORIZED,
            CexError::RateLimited { .. } => StatusCode::TOO_MANY_REQUESTS,
            CexError::InsufficientBalance(_) => StatusCode::PAYMENT_REQUIRED,
            CexError::InvalidSymbol(_) => StatusCode::BAD_REQUEST,
            CexError::OrderRejected { .. } => StatusCode::UNPROCESSABLE_ENTITY,
            CexError::Network { .. } => StatusCode::BAD_GATEWAY,
            CexError::Timeout => StatusCode::GATEWAY_TIMEOUT,
            CexError::UnknownVenue(_) => StatusCode::NOT_FOUND,
            CexError::Misconfigured(_) => StatusCode::SERVICE_UNAVAILABLE,
            CexError::Unexpected(_) => StatusCode::BAD_GATEWAY,
        };
        (status, err.to_string())
    }
}

impl From<reqwest::Error> for CexError {
    fn from(err: reqwest::Error) -> Self {
        if err.is_timeout() {
            return CexError::Timeout;
        }
        CexError::Network {
            source: Box::new(err),
        }
    }
}

// ── Trait ───────────────────────────────────────────────────────────────────

/// Uniform interface for "direct API" trading venues — no on-chain envelope,
/// orders submitted by REST.
#[async_trait]
pub trait DirectApiVenue: Send + Sync {
    /// Stable lowercase id — `"binance"`, `"coinbase"`, `"hyperliquid"`.
    fn venue_id(&self) -> &'static str;

    async fn place_order(&self, req: &CexOrderRequest) -> Result<CexOrderResponse, CexError>;

    async fn cancel_order(&self, symbol: &str, venue_order_id: &str) -> Result<(), CexError>;

    async fn get_account(&self) -> Result<CexAccountInfo, CexError>;

    async fn get_open_orders(
        &self,
        symbol: Option<&str>,
    ) -> Result<Vec<CexOpenOrder>, CexError>;

    async fn get_ticker(&self, symbol: &str) -> Result<CexTicker, CexError>;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Map a standardized venue id to its constructor key. Used by callers that
/// build clients from operator-supplied env vars.
pub fn known_venues() -> &'static [&'static str] {
    &["binance", "coinbase"]
}

/// Resolve a symbol param against a venue-specific normalizer.
pub fn ensure_nonempty_symbol(symbol: &str) -> Result<&str, CexError> {
    let trimmed = symbol.trim();
    if trimmed.is_empty() {
        return Err(CexError::InvalidSymbol("empty symbol".into()));
    }
    Ok(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn order_side_serde_lowercase() {
        let s = serde_json::to_string(&OrderSide::Buy).unwrap();
        assert_eq!(s, "\"buy\"");
        let parsed: OrderSide = serde_json::from_str("\"sell\"").unwrap();
        assert_eq!(parsed, OrderSide::Sell);
    }

    #[test]
    fn order_type_market_serde() {
        let json = r#"{"type":"market"}"#;
        let parsed: CexOrderType = serde_json::from_str(json).unwrap();
        assert!(matches!(parsed, CexOrderType::Market));
        let out = serde_json::to_string(&parsed).unwrap();
        assert!(out.contains("market"));
    }

    #[test]
    fn order_type_limit_serde() {
        let json = r#"{"type":"limit","price":"42500.50"}"#;
        let parsed: CexOrderType = serde_json::from_str(json).unwrap();
        match parsed {
            CexOrderType::Limit { price } => assert_eq!(price.to_string(), "42500.50"),
            _ => panic!("expected limit"),
        }
    }

    #[test]
    fn time_in_force_serde_uppercase() {
        let s = serde_json::to_string(&TimeInForce::Gtc).unwrap();
        assert_eq!(s, "\"GTC\"");
        let parsed: TimeInForce = serde_json::from_str("\"IOC\"").unwrap();
        assert_eq!(parsed, TimeInForce::Ioc);
    }

    #[test]
    fn cex_error_status_mapping() {
        let cases: Vec<(CexError, StatusCode)> = vec![
            (CexError::AuthFailed("x".into()), StatusCode::UNAUTHORIZED),
            (
                CexError::RateLimited { retry_after_ms: 100 },
                StatusCode::TOO_MANY_REQUESTS,
            ),
            (
                CexError::InsufficientBalance("x".into()),
                StatusCode::PAYMENT_REQUIRED,
            ),
            (CexError::InvalidSymbol("x".into()), StatusCode::BAD_REQUEST),
            (
                CexError::OrderRejected { reason: "x".into() },
                StatusCode::UNPROCESSABLE_ENTITY,
            ),
            (CexError::Timeout, StatusCode::GATEWAY_TIMEOUT),
            (CexError::UnknownVenue("x".into()), StatusCode::NOT_FOUND),
            (
                CexError::Misconfigured("x".into()),
                StatusCode::SERVICE_UNAVAILABLE,
            ),
        ];
        for (err, expected) in cases {
            let (status, _) = <(StatusCode, String)>::from(err);
            assert_eq!(status, expected);
        }
    }

    #[test]
    fn order_request_serde_roundtrip() {
        let req = CexOrderRequest {
            symbol: "BTCUSDT".into(),
            side: OrderSide::Buy,
            order_type: CexOrderType::Limit {
                price: "42000.50".parse().unwrap(),
            },
            quantity: "0.001".parse().unwrap(),
            time_in_force: Some(TimeInForce::Gtc),
            client_order_id: Some("test-1".into()),
        };
        let json = serde_json::to_string(&req).unwrap();
        let parsed: CexOrderRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.symbol, "BTCUSDT");
        assert_eq!(parsed.side, OrderSide::Buy);
        assert_eq!(parsed.quantity.to_string(), "0.001");
    }

    #[test]
    fn ensure_nonempty_symbol_rejects_blank() {
        assert!(ensure_nonempty_symbol("").is_err());
        assert!(ensure_nonempty_symbol("   ").is_err());
        assert_eq!(ensure_nonempty_symbol("BTCUSDT").unwrap(), "BTCUSDT");
    }
}
