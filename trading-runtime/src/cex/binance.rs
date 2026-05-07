//! Binance Spot REST integration.
//!
//! Implements `DirectApiVenue` against the Binance Spot REST API. We use
//! `reqwest` directly rather than the `binance-spot-connector-rust` crate to
//! avoid pulling tungstenite/websocket dependencies for what is currently a
//! pure REST integration. Promote to the SDK if/when WS streams are needed.
//!
//! Auth: HMAC-SHA256 of the canonical query string with the API secret.
//! Rate limits: we surface `Retry-After` and the `X-MBX-USED-WEIGHT-1m`
//! header to callers via tracing; aggressive client-side throttling lives in
//! the route layer.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use hmac::{Hmac, Mac};
use reqwest::{Client, Method, StatusCode, header};
use rust_decimal::Decimal;
use serde::Deserialize;
use sha2::Sha256;

use super::{
    CexAccountInfo, CexBalance, CexError, CexFee, CexOpenOrder, CexOrderRequest, CexOrderResponse,
    CexOrderStatus, CexOrderType, CexTicker, DirectApiVenue, OrderSide, TimeInForce,
};

const PROD_BASE_URL: &str = "https://api.binance.com";
const TESTNET_BASE_URL: &str = "https://testnet.binance.vision";
const DEFAULT_RECV_WINDOW_MS: u64 = 5_000;
/// Binance documents 60_000ms as the absolute maximum `recvWindow`. Anything
/// past that is rejected by the API. We additionally enforce this cap
/// client-side: a misconfigured operator setting `BINANCE_RECV_WINDOW_MS=60000`
/// widens the request-replay window 12× over the default, which is a
/// non-trivial regression for replay protection.
const MAX_RECV_WINDOW_MS: u64 = 60_000;
/// Spot weight cap is 6000/min; back off as we approach 90% to leave headroom.
const WEIGHT_BACKOFF_THRESHOLD: u64 = 5_400;

type HmacSha256 = Hmac<Sha256>;

/// Configuration for a Binance Spot client.
#[derive(Debug, Clone)]
pub struct BinanceConfig {
    pub api_key: String,
    pub api_secret: String,
    /// Override base URL (e.g. testnet); defaults to production.
    pub base_url: Option<String>,
    pub recv_window_ms: Option<u64>,
}

impl BinanceConfig {
    pub fn from_env() -> Result<Self, CexError> {
        let api_key = std::env::var("BINANCE_API_KEY")
            .map_err(|_| CexError::Misconfigured("BINANCE_API_KEY env var is not set".into()))?;
        let api_secret = std::env::var("BINANCE_API_SECRET")
            .map_err(|_| CexError::Misconfigured("BINANCE_API_SECRET env var is not set".into()))?;
        let base_url = std::env::var("BINANCE_BASE_URL").ok();
        let recv_window_ms = std::env::var("BINANCE_RECV_WINDOW_MS")
            .ok()
            .and_then(|raw| raw.parse().ok());
        Ok(Self {
            api_key,
            api_secret,
            base_url,
            recv_window_ms,
        })
    }
}

pub struct BinanceClient {
    config: BinanceConfig,
    http: Client,
    base_url: String,
    recv_window_ms: u64,
    /// Last observed `X-MBX-USED-WEIGHT-1m`; used for soft throttling.
    last_used_weight: AtomicU64,
}

impl BinanceClient {
    pub fn new(config: BinanceConfig) -> Result<Self, CexError> {
        let base_url = config
            .base_url
            .clone()
            .unwrap_or_else(|| PROD_BASE_URL.to_string());
        let configured = config.recv_window_ms.unwrap_or(DEFAULT_RECV_WINDOW_MS);
        if configured == 0 {
            return Err(CexError::Misconfigured(
                "BINANCE_RECV_WINDOW_MS must be > 0".into(),
            ));
        }
        if configured > MAX_RECV_WINDOW_MS {
            return Err(CexError::Misconfigured(format!(
                "BINANCE_RECV_WINDOW_MS={configured} exceeds Binance maximum {MAX_RECV_WINDOW_MS}"
            )));
        }
        if configured > DEFAULT_RECV_WINDOW_MS {
            tracing::warn!(
                recv_window_ms = configured,
                "Binance recvWindow is wider than the recommended {DEFAULT_RECV_WINDOW_MS}ms; replay-window grows accordingly"
            );
        }
        let recv_window_ms = configured;

        let http = Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| CexError::Misconfigured(format!("reqwest builder: {e}")))?;

        Ok(Self {
            config,
            http,
            base_url,
            recv_window_ms,
            last_used_weight: AtomicU64::new(0),
        })
    }

    pub fn testnet(api_key: String, api_secret: String) -> Result<Self, CexError> {
        Self::new(BinanceConfig {
            api_key,
            api_secret,
            base_url: Some(TESTNET_BASE_URL.to_string()),
            recv_window_ms: None,
        })
    }

    fn timestamp_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    /// HMAC-SHA256 of `query_string` keyed by `api_secret`, hex-encoded lowercase.
    pub(crate) fn sign(api_secret: &str, query_string: &str) -> String {
        let mut mac =
            HmacSha256::new_from_slice(api_secret.as_bytes()).expect("HMAC accepts any key length");
        mac.update(query_string.as_bytes());
        hex::encode(mac.finalize().into_bytes())
    }

    fn observe_headers(&self, headers: &header::HeaderMap) {
        if let Some(weight) = headers
            .get("X-MBX-USED-WEIGHT-1m")
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
        {
            self.last_used_weight.store(weight, Ordering::Relaxed);
            if weight >= WEIGHT_BACKOFF_THRESHOLD {
                tracing::warn!(
                    used_weight = weight,
                    "Binance approaching rate limit — back off recommended"
                );
            }
        }
    }

    /// Append `timestamp` + `recvWindow` and sign — the canonical Binance
    /// signed query format.
    fn build_signed_params(&self, params: &[(&str, String)]) -> String {
        let mut all: Vec<(&str, String)> = params.to_vec();
        all.push(("timestamp", Self::timestamp_ms().to_string()));
        all.push(("recvWindow", self.recv_window_ms.to_string()));
        let qs = encode_form(&all);
        let signature = Self::sign(&self.config.api_secret, &qs);
        format!("{qs}&signature={signature}")
    }

    /// Send a signed request. `body_params` are URL-encoded into the query
    /// string for SIGNED endpoints — Binance accepts either query or body.
    async fn signed_request(
        &self,
        method: Method,
        path: &str,
        params: &[(&str, String)],
    ) -> Result<serde_json::Value, CexError> {
        let signed = self.build_signed_params(params);
        let url = format!("{}{path}?{signed}", self.base_url);

        let resp = self
            .http
            .request(method, &url)
            .header("X-MBX-APIKEY", &self.config.api_key)
            .send()
            .await?;

        self.observe_headers(resp.headers());
        let status = resp.status();
        let headers = resp.headers().clone();
        let body = resp.bytes().await?;

        translate_response(status, &headers, &body)
    }

    async fn public_request(
        &self,
        path: &str,
        params: &[(&str, String)],
    ) -> Result<serde_json::Value, CexError> {
        let qs = encode_form(params);
        let url = if qs.is_empty() {
            format!("{}{path}", self.base_url)
        } else {
            format!("{}{path}?{qs}", self.base_url)
        };

        let resp = self.http.get(&url).send().await?;
        self.observe_headers(resp.headers());
        let status = resp.status();
        let headers = resp.headers().clone();
        let body = resp.bytes().await?;
        translate_response(status, &headers, &body)
    }

    pub fn last_used_weight(&self) -> u64 {
        self.last_used_weight.load(Ordering::Relaxed)
    }
}

#[async_trait]
impl DirectApiVenue for BinanceClient {
    fn venue_id(&self) -> &'static str {
        "binance"
    }

    async fn place_order(&self, req: &CexOrderRequest) -> Result<CexOrderResponse, CexError> {
        super::ensure_nonempty_symbol(&req.symbol)?;
        let mut params: Vec<(&str, String)> = Vec::with_capacity(8);
        params.push(("symbol", req.symbol.to_uppercase()));
        params.push(("side", req.side.as_str_upper().to_string()));
        params.push(("quantity", req.quantity.normalize().to_string()));
        match &req.order_type {
            CexOrderType::Market => {
                params.push(("type", "MARKET".to_string()));
            }
            CexOrderType::Limit { price } => {
                params.push(("type", "LIMIT".to_string()));
                params.push(("price", price.normalize().to_string()));
                let tif = req.time_in_force.unwrap_or(TimeInForce::Gtc);
                params.push(("timeInForce", tif.as_str_upper().to_string()));
            }
        }
        if let Some(coid) = &req.client_order_id {
            params.push(("newClientOrderId", coid.clone()));
        }
        params.push(("newOrderRespType", "FULL".to_string()));

        let raw = self
            .signed_request(Method::POST, "/api/v3/order", &params)
            .await?;
        parse_order_response(raw, &req.symbol).map_err(CexError::Unexpected)
    }

    async fn cancel_order(&self, symbol: &str, venue_order_id: &str) -> Result<(), CexError> {
        super::ensure_nonempty_symbol(symbol)?;
        let params = vec![
            ("symbol", symbol.to_uppercase()),
            ("orderId", venue_order_id.to_string()),
        ];
        self.signed_request(Method::DELETE, "/api/v3/order", &params)
            .await?;
        Ok(())
    }

    async fn get_account(&self) -> Result<CexAccountInfo, CexError> {
        let raw = self
            .signed_request(Method::GET, "/api/v3/account", &[])
            .await?;
        let mut balances = Vec::new();
        if let Some(arr) = raw.get("balances").and_then(|v| v.as_array()) {
            for b in arr {
                let asset = b
                    .get("asset")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let free = parse_decimal(b.get("free")).unwrap_or_default();
                let locked = parse_decimal(b.get("locked")).unwrap_or_default();
                if asset.is_empty() {
                    continue;
                }
                if free.is_zero() && locked.is_zero() {
                    continue;
                }
                balances.push(CexBalance {
                    asset,
                    free,
                    locked,
                });
            }
        }
        Ok(CexAccountInfo {
            venue: "binance".into(),
            balances,
            raw,
        })
    }

    async fn get_open_orders(&self, symbol: Option<&str>) -> Result<Vec<CexOpenOrder>, CexError> {
        let mut params: Vec<(&str, String)> = Vec::new();
        if let Some(s) = symbol {
            super::ensure_nonempty_symbol(s)?;
            params.push(("symbol", s.to_uppercase()));
        }
        let raw = self
            .signed_request(Method::GET, "/api/v3/openOrders", &params)
            .await?;

        let arr = raw
            .as_array()
            .ok_or_else(|| CexError::Unexpected("openOrders: not an array".into()))?;
        let mut out = Vec::with_capacity(arr.len());
        for item in arr {
            let symbol = item
                .get("symbol")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let order_id = item
                .get("orderId")
                .map(|v| v.to_string())
                .unwrap_or_default();
            let side = match item.get("side").and_then(|v| v.as_str()) {
                Some("SELL") => OrderSide::Sell,
                _ => OrderSide::Buy,
            };
            let quantity = parse_decimal(item.get("origQty")).unwrap_or_default();
            let filled_quantity = parse_decimal(item.get("executedQty")).unwrap_or_default();
            let price = parse_decimal(item.get("price"));
            let status = parse_binance_status(item.get("status").and_then(|v| v.as_str()));
            let created_at_ms = item.get("time").and_then(|v| v.as_i64());
            out.push(CexOpenOrder {
                venue: "binance".into(),
                venue_order_id: order_id,
                symbol,
                side,
                price,
                quantity,
                filled_quantity,
                status,
                created_at_ms,
            });
        }
        Ok(out)
    }

    async fn get_ticker(&self, symbol: &str) -> Result<CexTicker, CexError> {
        super::ensure_nonempty_symbol(symbol)?;
        let raw = self
            .public_request(
                "/api/v3/ticker/bookTicker",
                &[("symbol", symbol.to_uppercase())],
            )
            .await?;

        let bid = parse_decimal(raw.get("bidPrice"));
        let ask = parse_decimal(raw.get("askPrice"));
        let price = match (bid, ask) {
            (Some(b), Some(a)) => (b + a) / Decimal::from(2),
            (Some(b), None) => b,
            (None, Some(a)) => a,
            (None, None) => {
                return Err(CexError::Unexpected("ticker missing bid/ask price".into()));
            }
        };
        Ok(CexTicker {
            venue: "binance".into(),
            symbol: symbol.to_uppercase(),
            price,
            bid,
            ask,
            timestamp_ms: chrono::Utc::now().timestamp_millis(),
        })
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/// URL-encode form pairs. We keep our own minimal encoder rather than pulling
/// `serde_urlencoded` to keep the dependency surface tight.
fn encode_form(params: &[(&str, String)]) -> String {
    let mut out = String::new();
    for (i, (k, v)) in params.iter().enumerate() {
        if i > 0 {
            out.push('&');
        }
        out.push_str(&pct_encode(k));
        out.push('=');
        out.push_str(&pct_encode(v));
    }
    out
}

fn pct_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => {
                out.push_str(&format!("%{byte:02X}"));
            }
        }
    }
    out
}

fn parse_decimal(value: Option<&serde_json::Value>) -> Option<Decimal> {
    match value? {
        serde_json::Value::String(s) => s.parse().ok(),
        serde_json::Value::Number(n) => n.to_string().parse().ok(),
        _ => None,
    }
}

fn parse_binance_status(s: Option<&str>) -> CexOrderStatus {
    match s.unwrap_or("") {
        "NEW" => CexOrderStatus::New,
        "PARTIALLY_FILLED" => CexOrderStatus::PartiallyFilled,
        "FILLED" => CexOrderStatus::Filled,
        "CANCELED" => CexOrderStatus::Canceled,
        "REJECTED" => CexOrderStatus::Rejected,
        "EXPIRED" | "EXPIRED_IN_MATCH" => CexOrderStatus::Expired,
        "PENDING_CANCEL" | "PENDING_NEW" => CexOrderStatus::Pending,
        _ => CexOrderStatus::Unknown,
    }
}

/// Parse a Binance Spot order ack/result/full response into our normalized form.
pub(crate) fn parse_order_response(
    raw: serde_json::Value,
    symbol: &str,
) -> Result<CexOrderResponse, String> {
    let venue_order_id = raw
        .get("orderId")
        .map(|v| v.to_string())
        .or_else(|| {
            raw.get("clientOrderId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .ok_or_else(|| "missing orderId".to_string())?;

    let status = parse_binance_status(raw.get("status").and_then(|v| v.as_str()));
    let filled_quantity = parse_decimal(raw.get("executedQty")).unwrap_or_default();
    let cumm_quote = parse_decimal(raw.get("cummulativeQuoteQty"));
    let average_fill_price = match (cumm_quote, filled_quantity) {
        (Some(quote), filled) if !filled.is_zero() => Some(quote / filled),
        _ => None,
    };

    let mut fees: Vec<CexFee> = Vec::new();
    if let Some(fills) = raw.get("fills").and_then(|v| v.as_array()) {
        for fill in fills {
            if let (Some(asset), Some(amount)) = (
                fill.get("commissionAsset").and_then(|v| v.as_str()),
                parse_decimal(fill.get("commission")),
            ) {
                fees.push(CexFee {
                    asset: asset.to_string(),
                    amount,
                });
            }
        }
    }

    Ok(CexOrderResponse {
        venue: "binance".into(),
        venue_order_id: venue_order_id.trim_matches('"').to_string(),
        status,
        filled_quantity,
        average_fill_price,
        fees,
        raw: serde_json::json!({ "symbol": symbol, "response": raw }),
    })
}

#[derive(Deserialize)]
struct BinanceErrorBody {
    code: i64,
    msg: String,
}

fn translate_response(
    status: StatusCode,
    headers: &header::HeaderMap,
    body: &[u8],
) -> Result<serde_json::Value, CexError> {
    if status.is_success() {
        return serde_json::from_slice(body)
            .map_err(|e| CexError::Unexpected(format!("bad JSON: {e}")));
    }

    if status == StatusCode::TOO_MANY_REQUESTS || status == StatusCode::IM_A_TEAPOT {
        // Binance returns 429 (rate-limited) or 418 (banned).
        let retry_after_ms = headers
            .get(header::RETRY_AFTER)
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
            .map(|secs| secs * 1000)
            .unwrap_or(1_000);
        return Err(CexError::RateLimited { retry_after_ms });
    }

    if let Ok(body_obj) = serde_json::from_slice::<BinanceErrorBody>(body) {
        let msg = body_obj.msg;
        return Err(match body_obj.code {
            -2010 | -2018 | -2019 => CexError::InsufficientBalance(msg),
            -1121 | -1100 => CexError::InvalidSymbol(msg),
            -2014 | -2015 | -2008 => CexError::AuthFailed(msg),
            _ if status == StatusCode::UNAUTHORIZED => CexError::AuthFailed(msg),
            _ if status == StatusCode::FORBIDDEN => CexError::AuthFailed(msg),
            _ => CexError::OrderRejected { reason: msg },
        });
    }

    let text = String::from_utf8_lossy(body).into_owned();
    Err(CexError::Unexpected(format!(
        "HTTP {status}: {body}",
        status = status.as_u16(),
        body = text
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Binance documents this exact example for HMAC-SHA256 signature verification:
    /// https://developers.binance.com/docs/binance-spot-api-docs/rest-api/endpoint-security-type
    /// Key: NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j
    /// Query: symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559
    /// Expected signature: c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71
    #[test]
    fn binance_documented_signature_example() {
        let key = "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j";
        let query = "symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559";
        let signature = BinanceClient::sign(key, query);
        assert_eq!(
            signature,
            "c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71"
        );
    }

    #[test]
    fn pct_encode_handles_special_chars() {
        assert_eq!(pct_encode("BTC-USDT"), "BTC-USDT");
        assert_eq!(pct_encode("a b"), "a%20b");
        assert_eq!(pct_encode("a+b"), "a%2Bb");
        assert_eq!(pct_encode("a/b"), "a%2Fb");
    }

    #[test]
    fn build_signed_params_appends_timestamp_and_signature() {
        let client = BinanceClient::new(BinanceConfig {
            api_key: "k".into(),
            api_secret: "s".into(),
            base_url: Some("http://test".into()),
            recv_window_ms: Some(5_000),
        })
        .unwrap();
        let signed = client.build_signed_params(&[("symbol", "BTCUSDT".into())]);
        assert!(signed.contains("symbol=BTCUSDT"));
        assert!(signed.contains("timestamp="));
        assert!(signed.contains("recvWindow=5000"));
        assert!(signed.contains("signature="));
        let sig_part = signed.split("signature=").nth(1).unwrap();
        assert_eq!(sig_part.len(), 64);
        assert!(sig_part.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn parse_order_response_extracts_fields() {
        let raw = serde_json::json!({
            "symbol": "BTCUSDT",
            "orderId": 28,
            "clientOrderId": "6gCrw2kRUAF9CvJDGP16IP",
            "transactTime": 1507725176595_i64,
            "price": "0.00000000",
            "origQty": "10.00000000",
            "executedQty": "10.00000000",
            "cummulativeQuoteQty": "10.00000000",
            "status": "FILLED",
            "timeInForce": "GTC",
            "type": "MARKET",
            "side": "SELL",
            "fills": [
                { "price": "4000.00000000", "qty": "1.00000000",
                  "commission": "4.00000000", "commissionAsset": "USDT" },
                { "price": "3999.00000000", "qty": "5.00000000",
                  "commission": "19.99500000", "commissionAsset": "USDT" }
            ]
        });
        let parsed = parse_order_response(raw, "BTCUSDT").unwrap();
        assert_eq!(parsed.venue, "binance");
        assert_eq!(parsed.venue_order_id, "28");
        assert_eq!(parsed.status, CexOrderStatus::Filled);
        assert_eq!(parsed.filled_quantity.to_string(), "10.00000000");
        assert_eq!(parsed.fees.len(), 2);
        assert!(parsed.average_fill_price.is_some());
    }

    #[test]
    fn translate_response_maps_insufficient_balance() {
        let body =
            br#"{"code":-2010,"msg":"Account has insufficient balance for requested action."}"#;
        let err = translate_response(StatusCode::BAD_REQUEST, &header::HeaderMap::new(), body)
            .expect_err("expected error");
        assert!(matches!(err, CexError::InsufficientBalance(_)), "{err:?}");
    }

    #[test]
    fn translate_response_maps_invalid_symbol() {
        let body = br#"{"code":-1121,"msg":"Invalid symbol."}"#;
        let err = translate_response(StatusCode::BAD_REQUEST, &header::HeaderMap::new(), body)
            .expect_err("expected error");
        assert!(matches!(err, CexError::InvalidSymbol(_)), "{err:?}");
    }

    #[test]
    fn translate_response_handles_429() {
        let mut headers = header::HeaderMap::new();
        headers.insert("retry-after", header::HeaderValue::from_static("3"));
        let err = translate_response(StatusCode::TOO_MANY_REQUESTS, &headers, b"")
            .expect_err("expected error");
        match err {
            CexError::RateLimited { retry_after_ms } => assert_eq!(retry_after_ms, 3000),
            other => panic!("expected RateLimited, got {other:?}"),
        }
    }

    #[test]
    fn parse_binance_status_known_values() {
        assert_eq!(parse_binance_status(Some("NEW")), CexOrderStatus::New);
        assert_eq!(parse_binance_status(Some("FILLED")), CexOrderStatus::Filled);
        assert_eq!(
            parse_binance_status(Some("PARTIALLY_FILLED")),
            CexOrderStatus::PartiallyFilled
        );
        assert_eq!(parse_binance_status(Some("XYZ")), CexOrderStatus::Unknown);
        assert_eq!(parse_binance_status(None), CexOrderStatus::Unknown);
    }

    /// Audit fix (MEDIUM): clamp `recv_window_ms` to Binance's documented
    /// max of 60s. Anything past that widens the replay window beyond what
    /// Binance will accept anyway, and >5s warrants a `tracing::warn`.
    #[test]
    fn recv_window_above_max_is_rejected() {
        let result = BinanceClient::new(BinanceConfig {
            api_key: "k".into(),
            api_secret: "s".into(),
            base_url: Some("http://t".into()),
            recv_window_ms: Some(MAX_RECV_WINDOW_MS + 1),
        });
        match result {
            Ok(_) => panic!("recv_window > max must be rejected"),
            Err(err) => assert!(matches!(err, CexError::Misconfigured(_)), "{err:?}"),
        }
    }

    #[test]
    fn recv_window_zero_is_rejected() {
        let result = BinanceClient::new(BinanceConfig {
            api_key: "k".into(),
            api_secret: "s".into(),
            base_url: Some("http://t".into()),
            recv_window_ms: Some(0),
        });
        match result {
            Ok(_) => panic!("recv_window=0 must be rejected"),
            Err(err) => assert!(matches!(err, CexError::Misconfigured(_)), "{err:?}"),
        }
    }

    #[test]
    fn recv_window_at_default_is_accepted_silently() {
        let client = BinanceClient::new(BinanceConfig {
            api_key: "k".into(),
            api_secret: "s".into(),
            base_url: Some("http://t".into()),
            recv_window_ms: Some(DEFAULT_RECV_WINDOW_MS),
        })
        .expect("default recv_window must be accepted");
        assert_eq!(client.recv_window_ms, DEFAULT_RECV_WINDOW_MS);
    }

    #[test]
    fn recv_window_at_max_is_accepted() {
        let client = BinanceClient::new(BinanceConfig {
            api_key: "k".into(),
            api_secret: "s".into(),
            base_url: Some("http://t".into()),
            recv_window_ms: Some(MAX_RECV_WINDOW_MS),
        })
        .expect("max recv_window must be accepted (warns)");
        assert_eq!(client.recv_window_ms, MAX_RECV_WINDOW_MS);
    }
}
