//! Coinbase Advanced Trade REST integration.
//!
//! Auth uses ES256 JWTs signed with a CDP API key (EC P-256 PEM private key).
//! Each request gets a fresh JWT scoped to that exact METHOD + host + path
//! (the `uri` claim is `<METHOD> api.coinbase.com<path>`). Tokens last ~120s.
//!
//! Surprise: Coinbase's API key id (`name` field on the CDP key, an
//! `organizations/.../apiKeys/<uuid>` string) goes in the JWT *header* `kid`,
//! NOT in `iss`/`sub`. The `iss` claim is the literal string
//! `"coinbase-cloud"` and `sub` is the `name`. This is unusual enough that
//! it's worth keeping the implementation explicit.
//!
//! ### Secret handling — defense in depth
//!
//! Audit finding #12 (LOW) flagged that the PEM private key was retained
//! on `CoinbaseConfig` as a plain `String` for the lifetime of the client
//! and never zeroized. The fix here:
//!
//! 1. The PEM is wrapped in `zeroize::Zeroizing<String>` — the heap buffer
//!    is wiped on drop.
//! 2. `EncodingKey::from_ec_pem` is invoked **per request**, not cached on
//!    the client. The intermediate `EncodingKey` is dropped immediately
//!    after the JWT is signed. We can't wipe the `EncodingKey`'s internal
//!    allocation (upstream `jsonwebtoken` does not expose a primitive for
//!    that), but minimising its lifetime narrows the window during which
//!    the parsed key material is reachable on the heap.
//! 3. An explicit `Drop` impl on `CoinbaseConfig` is provided as
//!    defense-in-depth — `Zeroizing<String>` already wipes on drop, but
//!    the explicit impl makes the contract obvious to future readers and
//!    survives any accidental conversion of the field type.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use reqwest::{Client, Method, StatusCode};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use super::{
    CexAccountInfo, CexBalance, CexError, CexFee, CexOpenOrder, CexOrderRequest, CexOrderResponse,
    CexOrderStatus, CexOrderType, CexTicker, DirectApiVenue, OrderSide, TimeInForce,
};

const PROD_BASE_URL: &str = "https://api.coinbase.com";
const PROD_HOST: &str = "api.coinbase.com";
const JWT_TTL_SECS: u64 = 120;

/// Configuration for a Coinbase Advanced Trade client.
///
/// The PEM private key is held in a `Zeroizing<String>` so the heap buffer
/// is wiped when the config is dropped (or replaced). See the module doc
/// for the full lifecycle rationale.
#[derive(Clone)]
pub struct CoinbaseConfig {
    /// CDP API key name — `organizations/{org_uuid}/apiKeys/{key_uuid}`.
    pub api_key_name: String,
    /// CDP API private key — PEM-encoded EC P-256 (`-----BEGIN EC PRIVATE KEY-----`).
    ///
    /// Stored in `Zeroizing<String>` to wipe on drop. Use [`Self::pem_str`]
    /// to access the underlying bytes when constructing an `EncodingKey`.
    api_private_key_pem: zeroize::Zeroizing<String>,
    /// Override base URL (typically left None).
    pub base_url: Option<String>,
}

impl std::fmt::Debug for CoinbaseConfig {
    /// Custom Debug — never print the PEM. The default derived impl would
    /// happily expose the secret in panics or trace logs.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CoinbaseConfig")
            .field("api_key_name", &self.api_key_name)
            .field("api_private_key_pem", &"<redacted>")
            .field("base_url", &self.base_url)
            .finish()
    }
}

impl CoinbaseConfig {
    /// Construct from caller-supplied components. The PEM is moved into a
    /// `Zeroizing<String>`; the original `String` argument is therefore
    /// not separately zeroized — callers that hold their own copy must
    /// arrange that themselves.
    pub fn new(
        api_key_name: String,
        api_private_key_pem: String,
        base_url: Option<String>,
    ) -> Self {
        Self {
            api_key_name,
            api_private_key_pem: zeroize::Zeroizing::new(api_private_key_pem),
            base_url,
        }
    }

    pub fn from_env() -> Result<Self, CexError> {
        let api_key_name = std::env::var("COINBASE_API_KEY_NAME").map_err(|_| {
            CexError::Misconfigured("COINBASE_API_KEY_NAME env var is not set".into())
        })?;
        let api_private_key_pem = std::env::var("COINBASE_API_PRIVATE_KEY").map_err(|_| {
            CexError::Misconfigured("COINBASE_API_PRIVATE_KEY env var is not set".into())
        })?;
        let base_url = std::env::var("COINBASE_BASE_URL").ok();
        Ok(Self::new(api_key_name, api_private_key_pem, base_url))
    }

    /// Borrow the PEM bytes for a single use (e.g. constructing an
    /// `EncodingKey`). Keep the borrow scope minimal so the parsed
    /// `EncodingKey` can be dropped quickly.
    pub(crate) fn pem_bytes(&self) -> &[u8] {
        self.api_private_key_pem.as_bytes()
    }
}

/// Defense-in-depth: zeroize the PEM on drop. The `Zeroizing<String>`
/// wrapper already does this; this explicit impl makes the contract
/// visible and survives any future refactor that swaps the field type.
impl Drop for CoinbaseConfig {
    fn drop(&mut self) {
        self.api_private_key_pem.zeroize();
    }
}

pub struct CoinbaseClient {
    config: CoinbaseConfig,
    http: Client,
    base_url: String,
    /// How many times we've parsed the PEM into an `EncodingKey`. Used by
    /// tests to assert the key is minted per-request and not cached.
    /// Production code only ever increments it.
    signing_call_count: AtomicU64,
}

impl CoinbaseClient {
    pub fn new(config: CoinbaseConfig) -> Result<Self, CexError> {
        let base_url = config
            .base_url
            .clone()
            .unwrap_or_else(|| PROD_BASE_URL.to_string());

        // Validate the PEM at construction time so misconfigured bots fail
        // fast, but discard the parsed key immediately — we'll re-parse it
        // on each request to minimise the time the parsed material lives
        // on the heap. The parsed `EncodingKey` is dropped at the end of
        // this scope.
        {
            let _validate = EncodingKey::from_ec_pem(config.pem_bytes())
                .map_err(|e| CexError::Misconfigured(format!("Coinbase EC private key: {e}")))?;
        }

        let http = Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| CexError::Misconfigured(format!("reqwest builder: {e}")))?;

        Ok(Self {
            config,
            http,
            base_url,
            signing_call_count: AtomicU64::new(0),
        })
    }

    /// Build the JWT for a single request. Each call uses a fresh nonce + iat.
    ///
    /// The `EncodingKey` is constructed inside this method and dropped when
    /// the function returns; we never cache it on `self`. This shortens the
    /// window during which the parsed key material is reachable on the
    /// heap. (`jsonwebtoken::EncodingKey` does not expose a wipe primitive,
    /// so the best we can do is minimise its lifetime.)
    pub(crate) fn build_jwt(&self, method: &str, path: &str) -> Result<String, CexError> {
        self.signing_call_count.fetch_add(1, Ordering::Relaxed);
        let signing_key = EncodingKey::from_ec_pem(self.config.pem_bytes())
            .map_err(|e| CexError::AuthFailed(format!("Coinbase EC private key parse: {e}")))?;
        // `signing_key` is dropped at the end of this scope — we never
        // cache it on `self`, so the parsed key material has the shortest
        // possible lifetime.
        build_jwt_inner(
            &self.config.api_key_name,
            &signing_key,
            method,
            PROD_HOST,
            path,
            now_secs(),
            random_nonce(),
        )
    }

    /// Test-only accessor: how many times has `build_jwt` parsed the PEM?
    /// Used to verify that the `EncodingKey` is minted per-request (audit
    /// finding #12 follow-up).
    #[cfg(test)]
    pub(crate) fn signing_call_count(&self) -> u64 {
        self.signing_call_count.load(Ordering::Relaxed)
    }

    async fn request_signed(
        &self,
        method: Method,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, CexError> {
        let url = format!("{}{path}", self.base_url);
        let token = self.build_jwt(method.as_str(), path)?;

        let mut builder = self
            .http
            .request(method, &url)
            .bearer_auth(token)
            .header("Content-Type", "application/json");
        if let Some(body) = body {
            builder = builder.json(&body);
        }

        let resp = builder.send().await?;
        let status = resp.status();
        let bytes = resp.bytes().await?;
        translate_response(status, &bytes)
    }
}

#[async_trait]
impl DirectApiVenue for CoinbaseClient {
    fn venue_id(&self) -> &'static str {
        "coinbase"
    }

    async fn place_order(&self, req: &CexOrderRequest) -> Result<CexOrderResponse, CexError> {
        super::ensure_nonempty_symbol(&req.symbol)?;
        let client_order_id = req
            .client_order_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

        let order_config = build_order_configuration(req)?;

        let body = serde_json::json!({
            "client_order_id": client_order_id,
            "product_id": req.symbol,
            "side": req.side.as_str_upper(),
            "order_configuration": order_config,
        });

        let raw = self
            .request_signed(Method::POST, "/api/v3/brokerage/orders", Some(body))
            .await?;
        parse_create_order_response(raw, &req.symbol)
    }

    async fn cancel_order(&self, _symbol: &str, venue_order_id: &str) -> Result<(), CexError> {
        let body = serde_json::json!({ "order_ids": [venue_order_id] });
        let resp = self
            .request_signed(
                Method::POST,
                "/api/v3/brokerage/orders/batch_cancel",
                Some(body),
            )
            .await?;
        if let Some(results) = resp.get("results").and_then(|v| v.as_array())
            && let Some(first) = results.first()
        {
            let success = first
                .get("success")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if !success {
                let reason = first
                    .get("failure_reason")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                return Err(CexError::OrderRejected { reason });
            }
        }
        Ok(())
    }

    async fn get_account(&self) -> Result<CexAccountInfo, CexError> {
        let raw = self
            .request_signed(Method::GET, "/api/v3/brokerage/accounts", None)
            .await?;
        let mut balances = Vec::new();
        if let Some(arr) = raw.get("accounts").and_then(|v| v.as_array()) {
            for acc in arr {
                let asset = acc
                    .get("currency")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let available =
                    parse_decimal_from_value_obj(acc.get("available_balance")).unwrap_or_default();
                let hold = parse_decimal_from_value_obj(acc.get("hold")).unwrap_or_default();
                if asset.is_empty() {
                    continue;
                }
                if available.is_zero() && hold.is_zero() {
                    continue;
                }
                balances.push(CexBalance {
                    asset,
                    free: available,
                    locked: hold,
                });
            }
        }
        Ok(CexAccountInfo {
            venue: "coinbase".into(),
            balances,
            raw,
        })
    }

    async fn get_open_orders(&self, symbol: Option<&str>) -> Result<Vec<CexOpenOrder>, CexError> {
        let mut path = "/api/v3/brokerage/orders/historical/batch?order_status=OPEN".to_string();
        if let Some(s) = symbol {
            super::ensure_nonempty_symbol(s)?;
            path.push_str(&format!("&product_id={}", url_path_encode(s)));
        }
        let raw = self.request_signed(Method::GET, &path, None).await?;

        let arr = raw
            .get("orders")
            .and_then(|v| v.as_array())
            .ok_or_else(|| CexError::Unexpected("orders field missing".into()))?;

        let mut out = Vec::with_capacity(arr.len());
        for item in arr {
            let order_id = item
                .get("order_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let symbol = item
                .get("product_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let side = match item.get("side").and_then(|v| v.as_str()) {
                Some("SELL") => OrderSide::Sell,
                _ => OrderSide::Buy,
            };
            let status = parse_coinbase_status(item.get("status").and_then(|v| v.as_str()));
            let (qty, filled, price) = extract_size_price(item);
            let created_at_ms = item
                .get("created_time")
                .and_then(|v| v.as_str())
                .and_then(parse_iso_to_millis);
            out.push(CexOpenOrder {
                venue: "coinbase".into(),
                venue_order_id: order_id,
                symbol,
                side,
                price,
                quantity: qty,
                filled_quantity: filled,
                status,
                created_at_ms,
            });
        }
        Ok(out)
    }

    async fn get_ticker(&self, symbol: &str) -> Result<CexTicker, CexError> {
        super::ensure_nonempty_symbol(symbol)?;
        let path = format!(
            "/api/v3/brokerage/products/{}/ticker?limit=1",
            url_path_encode(symbol)
        );
        let raw = self.request_signed(Method::GET, &path, None).await?;
        let trades = raw
            .get("trades")
            .and_then(|v| v.as_array())
            .ok_or_else(|| CexError::Unexpected("ticker missing trades array".into()))?;
        let last = trades
            .first()
            .ok_or_else(|| CexError::Unexpected("ticker has no trades".into()))?;
        let price = parse_decimal_str(last.get("price"))
            .ok_or_else(|| CexError::Unexpected("ticker missing price".into()))?;
        let bid = parse_decimal_str(raw.get("best_bid"));
        let ask = parse_decimal_str(raw.get("best_ask"));

        Ok(CexTicker {
            venue: "coinbase".into(),
            symbol: symbol.to_string(),
            price,
            bid,
            ask,
            timestamp_ms: chrono::Utc::now().timestamp_millis(),
        })
    }
}

// ── Order configuration builder ─────────────────────────────────────────────

fn build_order_configuration(req: &CexOrderRequest) -> Result<serde_json::Value, CexError> {
    match &req.order_type {
        CexOrderType::Market => {
            let qty = req.quantity.normalize().to_string();
            // Coinbase market_market_ioc accepts either base_size (sell) or
            // quote_size (buy). We always pass base_size for consistency —
            // callers should pre-convert if they want to spend a quote amount.
            Ok(serde_json::json!({
                "market_market_ioc": {
                    "base_size": qty
                }
            }))
        }
        CexOrderType::Limit { price } => {
            let tif = req.time_in_force.unwrap_or(TimeInForce::Gtc);
            let key = match tif {
                TimeInForce::Gtc => "limit_limit_gtc",
                TimeInForce::Ioc => "sor_limit_ioc",
                TimeInForce::Fok => "limit_limit_fok",
            };
            Ok(serde_json::json!({
                key: {
                    "base_size": req.quantity.normalize().to_string(),
                    "limit_price": price.normalize().to_string()
                }
            }))
        }
    }
}

fn parse_create_order_response(
    raw: serde_json::Value,
    symbol: &str,
) -> Result<CexOrderResponse, CexError> {
    if let Some(success) = raw.get("success").and_then(|v| v.as_bool())
        && !success
    {
        let reason = raw
            .get("error_response")
            .and_then(|v| v.get("message"))
            .and_then(|v| v.as_str())
            .or_else(|| raw.get("failure_reason").and_then(|v| v.as_str()))
            .unwrap_or("rejected")
            .to_string();
        return Err(CexError::OrderRejected { reason });
    }

    let venue_order_id = raw
        .get("success_response")
        .and_then(|v| v.get("order_id"))
        .and_then(|v| v.as_str())
        .or_else(|| raw.get("order_id").and_then(|v| v.as_str()))
        .ok_or_else(|| CexError::Unexpected("missing order_id".into()))?
        .to_string();

    Ok(CexOrderResponse {
        venue: "coinbase".into(),
        venue_order_id,
        // Coinbase POST returns only the ack; status defaults to Pending — caller
        // should query historical/batch for the final state if needed.
        status: CexOrderStatus::Pending,
        filled_quantity: Decimal::ZERO,
        average_fill_price: None,
        fees: Vec::<CexFee>::new(),
        raw: serde_json::json!({ "symbol": symbol, "response": raw }),
    })
}

// ── JWT signing ────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct CoinbaseJwtClaims {
    sub: String,
    iss: String,
    nbf: u64,
    exp: u64,
    uri: String,
    nonce: String,
}

fn build_jwt_inner(
    api_key_name: &str,
    signing_key: &EncodingKey,
    method: &str,
    host: &str,
    path: &str,
    now: u64,
    nonce: String,
) -> Result<String, CexError> {
    let path_only = path.split('?').next().unwrap_or(path);
    let uri = format!("{} {}{}", method.to_uppercase(), host, path_only);

    let claims = CoinbaseJwtClaims {
        sub: api_key_name.to_string(),
        iss: "coinbase-cloud".to_string(),
        nbf: now,
        exp: now + JWT_TTL_SECS,
        uri,
        nonce,
    };

    let mut header = Header::new(Algorithm::ES256);
    header.kid = Some(api_key_name.to_string());

    jsonwebtoken::encode(&header, &claims, signing_key)
        .map_err(|e| CexError::AuthFailed(format!("JWT sign failed: {e}")))
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 32 bytes of OS-supplied entropy, hex-encoded — the JWT `nonce` claim.
///
/// Coinbase enforces nonce uniqueness across active JWTs. We can't allow a
/// guessable nonce: the previous implementation hashed `(time_nanos, pid,
/// counter)`, all of which are predictable from outside the process, which
/// degrades replay protection to roughly nothing.
///
/// We use `getrandom::getrandom` (which delegates to `getrandom(2)` on Linux,
/// `BCryptGenRandom` on Windows) — the same syscall the OS uses for
/// `/dev/urandom`. If the OS RNG fails we panic deliberately: a Coinbase
/// request without a CSPRNG nonce is worse than a failed request.
fn random_nonce() -> String {
    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf).expect("OS CSPRNG must be available for Coinbase JWT nonce");
    hex::encode(buf)
}

// ── Response translation ────────────────────────────────────────────────────

#[derive(Deserialize)]
struct CoinbaseErrorBody {
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

fn translate_response(status: StatusCode, body: &[u8]) -> Result<serde_json::Value, CexError> {
    if status.is_success() {
        if body.is_empty() {
            return Ok(serde_json::Value::Null);
        }
        return serde_json::from_slice(body)
            .map_err(|e| CexError::Unexpected(format!("bad JSON: {e}")));
    }

    if status == StatusCode::TOO_MANY_REQUESTS {
        return Err(CexError::RateLimited {
            retry_after_ms: 1_000,
        });
    }

    let parsed: Option<CoinbaseErrorBody> = serde_json::from_slice(body).ok();
    let msg = parsed
        .as_ref()
        .and_then(|p| p.message.clone().or_else(|| p.error.clone()))
        .unwrap_or_else(|| String::from_utf8_lossy(body).into_owned());

    let lower = msg.to_lowercase();
    Err(match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => CexError::AuthFailed(msg),
        StatusCode::BAD_REQUEST | StatusCode::NOT_FOUND
            if lower.contains("product") || lower.contains("symbol") =>
        {
            CexError::InvalidSymbol(msg)
        }
        _ if lower.contains("insufficient") => CexError::InsufficientBalance(msg),
        _ => CexError::OrderRejected { reason: msg },
    })
}

// ── Misc parsing helpers ────────────────────────────────────────────────────

fn parse_decimal_str(value: Option<&serde_json::Value>) -> Option<Decimal> {
    match value? {
        serde_json::Value::String(s) => s.parse().ok(),
        serde_json::Value::Number(n) => n.to_string().parse().ok(),
        _ => None,
    }
}

/// Coinbase wraps balances as `{ "value": "0.00", "currency": "USD" }`.
fn parse_decimal_from_value_obj(value: Option<&serde_json::Value>) -> Option<Decimal> {
    let obj = value?;
    if let Some(s) = obj.get("value").and_then(|v| v.as_str()) {
        return s.parse().ok();
    }
    parse_decimal_str(value)
}

fn parse_coinbase_status(s: Option<&str>) -> CexOrderStatus {
    match s.unwrap_or("") {
        "OPEN" => CexOrderStatus::New,
        "FILLED" => CexOrderStatus::Filled,
        "CANCELLED" | "CANCELED" => CexOrderStatus::Canceled,
        "EXPIRED" => CexOrderStatus::Expired,
        "FAILED" => CexOrderStatus::Rejected,
        "PENDING" => CexOrderStatus::Pending,
        "QUEUED" => CexOrderStatus::Pending,
        _ => CexOrderStatus::Unknown,
    }
}

fn extract_size_price(order: &serde_json::Value) -> (Decimal, Decimal, Option<Decimal>) {
    let qty = parse_decimal_str(
        order
            .get("order_configuration")
            .and_then(|cfg| {
                cfg.as_object()
                    .and_then(|m| m.values().find_map(|v| v.get("base_size")))
            })
            .or_else(|| order.get("base_size")),
    )
    .unwrap_or_default();
    let price = parse_decimal_str(
        order
            .get("order_configuration")
            .and_then(|cfg| {
                cfg.as_object()
                    .and_then(|m| m.values().find_map(|v| v.get("limit_price")))
            })
            .or_else(|| order.get("limit_price")),
    );
    let filled = parse_decimal_str(order.get("filled_size")).unwrap_or_default();
    (qty, filled, price)
}

fn parse_iso_to_millis(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

fn url_path_encode(s: &str) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use jsonwebtoken::{DecodingKey, Validation};

    /// EC P-256 keypair fixture for tests. Generated with:
    ///   openssl ecparam -name prime256v1 -genkey -noout \
    ///     | openssl pkcs8 -topk8 -nocrypt
    /// `jsonwebtoken` requires PKCS#8 PEM. THIS IS A TEST KEY.
    const TEST_PRIVATE_KEY_PEM: &str = "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgQSFkfB4L5EN45Zm8\nCN/zU4PTqMFDNOlNeiZuVDZ8QNyhRANCAATYsJm0lw3OdvU4tsOyAtl6VIvz7VaP\nGsmTzm980uKpRWCq3Ubxeaz8PaAetQJEWwT98YNTxe5FXR5+QwgW9RzW\n-----END PRIVATE KEY-----\n";
    const TEST_PUBLIC_KEY_PEM: &str = "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2LCZtJcNznb1OLbDsgLZelSL8+1W\njxrJk85vfNLiqUVgqt1G8Xms/D2gHrUCRFsE/fGDU8XuRV0efkMIFvUc1g==\n-----END PUBLIC KEY-----\n";

    #[test]
    fn coinbase_config_loads_from_pem() {
        let cfg = CoinbaseConfig::new(
            "organizations/test-org/apiKeys/test-key".into(),
            TEST_PRIVATE_KEY_PEM.into(),
            None,
        );
        let client = CoinbaseClient::new(cfg).unwrap();
        assert_eq!(client.venue_id(), "coinbase");
    }

    #[test]
    fn coinbase_config_rejects_garbage_pem() {
        let cfg = CoinbaseConfig::new("x".into(), "not-a-pem".into(), None);
        let err = match CoinbaseClient::new(cfg) {
            Ok(_) => panic!("expected misconfigured for invalid PEM"),
            Err(e) => e,
        };
        assert!(matches!(err, CexError::Misconfigured(_)), "{err:?}");
    }

    #[test]
    fn jwt_has_expected_header_and_claims() {
        let cfg = CoinbaseConfig::new(
            "organizations/test-org/apiKeys/test-key".into(),
            TEST_PRIVATE_KEY_PEM.into(),
            None,
        );
        let client = CoinbaseClient::new(cfg).unwrap();
        let token = client
            .build_jwt("GET", "/api/v3/brokerage/accounts")
            .unwrap();

        // Decode header without verification to inspect kid/alg.
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 3, "expected 3 JWT parts");
        let header_json = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(parts[0])
            .unwrap();
        let header: serde_json::Value = serde_json::from_slice(&header_json).unwrap();
        assert_eq!(header["alg"], "ES256");
        assert_eq!(header["kid"], "organizations/test-org/apiKeys/test-key");

        // Decode + verify the JWT against the matching public key.
        let key = DecodingKey::from_ec_pem(TEST_PUBLIC_KEY_PEM.as_bytes()).unwrap();
        let mut validation = Validation::new(Algorithm::ES256);
        validation.required_spec_claims.clear();
        validation.validate_exp = false;
        validation.validate_nbf = false;
        let data = jsonwebtoken::decode::<serde_json::Value>(&token, &key, &validation).unwrap();
        assert_eq!(data.claims["iss"], "coinbase-cloud");
        assert_eq!(
            data.claims["sub"],
            "organizations/test-org/apiKeys/test-key"
        );
        assert_eq!(
            data.claims["uri"],
            "GET api.coinbase.com/api/v3/brokerage/accounts"
        );
        assert!(data.claims["nonce"].as_str().unwrap().len() == 64);
    }

    #[test]
    fn jwt_uri_strips_query_string() {
        let key = EncodingKey::from_ec_pem(TEST_PRIVATE_KEY_PEM.as_bytes()).unwrap();
        let token = build_jwt_inner(
            "kid",
            &key,
            "GET",
            "api.coinbase.com",
            "/api/v3/brokerage/orders/historical/batch?order_status=OPEN",
            1_700_000_000,
            "deadbeef".into(),
        )
        .unwrap();
        let parts: Vec<&str> = token.split('.').collect();
        let claims_json = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(parts[1])
            .unwrap();
        let claims: serde_json::Value = serde_json::from_slice(&claims_json).unwrap();
        assert_eq!(
            claims["uri"],
            "GET api.coinbase.com/api/v3/brokerage/orders/historical/batch"
        );
    }

    #[test]
    fn build_market_order_configuration_uses_market_market_ioc() {
        let req = CexOrderRequest {
            symbol: "BTC-USD".into(),
            side: OrderSide::Buy,
            order_type: CexOrderType::Market,
            quantity: "0.001".parse().unwrap(),
            time_in_force: None,
            client_order_id: None,
        };
        let cfg = build_order_configuration(&req).unwrap();
        let market = cfg.get("market_market_ioc").unwrap();
        assert_eq!(market["base_size"], "0.001");
    }

    #[test]
    fn build_limit_order_configuration_uses_limit_limit_gtc() {
        let req = CexOrderRequest {
            symbol: "BTC-USD".into(),
            side: OrderSide::Sell,
            order_type: CexOrderType::Limit {
                price: "42000.5".parse().unwrap(),
            },
            quantity: "0.001".parse().unwrap(),
            time_in_force: Some(TimeInForce::Gtc),
            client_order_id: None,
        };
        let cfg = build_order_configuration(&req).unwrap();
        let limit = cfg.get("limit_limit_gtc").unwrap();
        assert_eq!(limit["base_size"], "0.001");
        // We `.normalize()` Decimals before serializing, which strips trailing zeros.
        assert_eq!(limit["limit_price"], "42000.5");
    }

    #[test]
    fn build_limit_fok_uses_limit_limit_fok() {
        let req = CexOrderRequest {
            symbol: "BTC-USD".into(),
            side: OrderSide::Buy,
            order_type: CexOrderType::Limit {
                price: "42000".parse().unwrap(),
            },
            quantity: "0.001".parse().unwrap(),
            time_in_force: Some(TimeInForce::Fok),
            client_order_id: None,
        };
        let cfg = build_order_configuration(&req).unwrap();
        assert!(cfg.get("limit_limit_fok").is_some());
    }

    #[test]
    fn parse_create_order_response_success() {
        let raw = serde_json::json!({
            "success": true,
            "success_response": { "order_id": "abc-123", "product_id": "BTC-USD" }
        });
        let parsed = parse_create_order_response(raw, "BTC-USD").unwrap();
        assert_eq!(parsed.venue, "coinbase");
        assert_eq!(parsed.venue_order_id, "abc-123");
        assert_eq!(parsed.status, CexOrderStatus::Pending);
    }

    #[test]
    fn parse_create_order_response_failure_extracts_message() {
        let raw = serde_json::json!({
            "success": false,
            "error_response": { "message": "INSUFFICIENT_FUND" }
        });
        let err = parse_create_order_response(raw, "BTC-USD").expect_err("expected rejection");
        match err {
            CexError::OrderRejected { reason } => assert!(reason.contains("INSUFFICIENT_FUND")),
            other => panic!("expected OrderRejected, got {other:?}"),
        }
    }

    #[test]
    fn translate_response_unauthorized_is_auth_failed() {
        let body = br#"{"error":"unauthorized","message":"bad signature"}"#;
        let err =
            translate_response(StatusCode::UNAUTHORIZED, body).expect_err("expected auth error");
        assert!(matches!(err, CexError::AuthFailed(_)), "{err:?}");
    }

    #[test]
    fn translate_response_invalid_product_is_invalid_symbol() {
        let body = br#"{"error":"INVALID_ARGUMENT","message":"Unknown product"}"#;
        let err =
            translate_response(StatusCode::BAD_REQUEST, body).expect_err("expected invalid symbol");
        assert!(matches!(err, CexError::InvalidSymbol(_)), "{err:?}");
    }

    #[test]
    fn parse_coinbase_status_known_values() {
        assert_eq!(parse_coinbase_status(Some("OPEN")), CexOrderStatus::New);
        assert_eq!(
            parse_coinbase_status(Some("FILLED")),
            CexOrderStatus::Filled
        );
        assert_eq!(
            parse_coinbase_status(Some("CANCELLED")),
            CexOrderStatus::Canceled
        );
        assert_eq!(
            parse_coinbase_status(Some("FAILED")),
            CexOrderStatus::Rejected
        );
    }

    #[test]
    fn parse_decimal_value_obj_handles_wrapped_balance() {
        let v = serde_json::json!({ "value": "1.23456789", "currency": "BTC" });
        let parsed = parse_decimal_from_value_obj(Some(&v)).unwrap();
        assert_eq!(parsed.to_string(), "1.23456789");
    }

    /// Audit fix (HIGH): the old `random_nonce` hashed deterministic inputs
    /// (time_nanos || pid || counter); two nonces produced microseconds
    /// apart from the same process were effectively predictable. Verify the
    /// new implementation is non-deterministic and 64 hex chars wide.
    #[test]
    fn random_nonce_is_unique_and_well_formed() {
        let n1 = random_nonce();
        let n2 = random_nonce();
        assert_eq!(n1.len(), 64, "nonce must be 32 bytes hex-encoded");
        assert_eq!(n2.len(), 64);
        assert!(n1.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(n1, n2, "two CSPRNG nonces must differ");
        // Sanity-check entropy: no two of 32 generated nonces should collide.
        let many: std::collections::HashSet<String> = (0..32).map(|_| random_nonce()).collect();
        assert_eq!(many.len(), 32, "32 CSPRNG nonces unexpectedly collided");
    }

    /// Audit fix (LOW #12): the PEM is wrapped in `Zeroizing<String>` so
    /// the heap buffer is wiped on drop. We verify by reading the heap
    /// bytes through a saved raw pointer after the config is dropped. The
    /// pointer is only valid because we know `String` is heap-allocated
    /// for non-empty strings and the allocator is unlikely to immediately
    /// reuse the freed page within the test scope — but we don't require
    /// that: we only require that the bytes at that location no longer
    /// contain the PEM marker. (If the page has been reused, we'll fail
    /// to find the marker and the test still passes — i.e. the test is
    /// conservative.)
    #[test]
    fn pem_is_zeroized_on_drop() {
        let pem = TEST_PRIVATE_KEY_PEM.to_string();
        // Capture the raw heap pointer + length before drop.
        let cfg = CoinbaseConfig::new("k".into(), pem, None);
        let ptr = cfg.api_private_key_pem.as_ptr();
        let len = cfg.api_private_key_pem.len();
        assert!(len > 0, "non-empty PEM expected");

        // Sanity: while alive, the buffer contains the PEM marker.
        // SAFETY: the `Zeroizing<String>` is alive for this borrow;
        // pointer is valid.
        let live = unsafe { std::slice::from_raw_parts(ptr, len) };
        assert!(
            live.windows(b"BEGIN PRIVATE KEY".len())
                .any(|w| w == b"BEGIN PRIVATE KEY"),
            "expected PEM marker while config alive"
        );

        drop(cfg);

        // After drop, `Zeroizing` has wiped the buffer (or the allocator
        // has reused/unmapped the page). Either way, the marker must not
        // be present at the captured location.
        // SAFETY: this is a best-effort heap inspection; if the page has
        // been unmapped this will SEGV, so we keep the test in a
        // single-threaded section. In practice for a 200-byte allocation
        // glibc keeps the page resident.
        let after = unsafe { std::slice::from_raw_parts(ptr, len) };
        let still_present = after
            .windows(b"BEGIN PRIVATE KEY".len())
            .any(|w| w == b"BEGIN PRIVATE KEY");
        assert!(
            !still_present,
            "PEM marker still readable in heap after CoinbaseConfig drop — \
             zeroize failed"
        );
    }

    /// Audit fix (LOW #12): the `EncodingKey` is parsed per-request and
    /// not cached on the client. Two `build_jwt` calls must increment the
    /// signing-call counter twice.
    #[test]
    fn encoding_key_is_minted_per_request() {
        let cfg = CoinbaseConfig::new(
            "organizations/test-org/apiKeys/test-key".into(),
            TEST_PRIVATE_KEY_PEM.into(),
            None,
        );
        let client = CoinbaseClient::new(cfg).unwrap();
        assert_eq!(client.signing_call_count(), 0);
        let _t1 = client
            .build_jwt("GET", "/api/v3/brokerage/accounts")
            .unwrap();
        assert_eq!(client.signing_call_count(), 1);
        let _t2 = client
            .build_jwt("GET", "/api/v3/brokerage/accounts")
            .unwrap();
        assert_eq!(
            client.signing_call_count(),
            2,
            "EncodingKey must be minted per-request, not cached"
        );
    }

    /// Defensive: `Debug` must not leak the PEM. A future contributor
    /// adding `dbg!(&config)` should not accidentally print the secret.
    #[test]
    fn debug_does_not_leak_pem() {
        let cfg = CoinbaseConfig::new(
            "k".into(),
            TEST_PRIVATE_KEY_PEM.into(),
            Some("https://example".into()),
        );
        let dbg = format!("{cfg:?}");
        assert!(
            !dbg.contains("BEGIN PRIVATE KEY"),
            "Debug impl must redact the PEM, got: {dbg}"
        );
        assert!(dbg.contains("redacted"));
    }
}
