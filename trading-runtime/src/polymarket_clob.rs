//! Polymarket CLOB API client for directional prediction-market trading.
//!
//! Wraps the official `polymarket-client-sdk` crate to handle EIP-712 order
//! signing, HMAC L2 authentication, and order submission. The existing
//! `adapters::polymarket` module handles on-chain CTF operations
//! (splitPosition, mergePositions, redeemPositions) through the vault — this
//! module handles off-chain order book trading where the operator's EOA signs
//! and submits limit orders directly.

use alloy::primitives::{Address, U256};
use alloy::signers::Signer as _;
use alloy::signers::local::PrivateKeySigner;
use polymarket_client_sdk::auth::{Credentials, Normal};
use polymarket_client_sdk::clob::Client as SdkClient;
use polymarket_client_sdk::clob::types::Side as SdkSide;
use polymarket_client_sdk::clob::types::request::{
    MidpointRequest, OrderBookSummaryRequest, OrdersRequest,
};
use polymarket_client_sdk::clob::types::response::{
    OpenOrderResponse, OrderBookSummaryResponse, OrderSummary, PostOrderResponse,
};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::error::TradingError;

// ── Constants ────────────────────────────────────────────────────────────────

/// Polygon mainnet chain ID (used for signer config and order signing).
const POLYGON_CHAIN_ID: u64 = 137;

/// Default CLOB API base URL.
const DEFAULT_BASE_URL: &str = "https://clob.polymarket.com";

// ── Public types ─────────────────────────────────────────────────────────────

/// Order side.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum Side {
    Buy,
    Sell,
}

impl From<Side> for SdkSide {
    fn from(s: Side) -> Self {
        match s {
            Side::Buy => SdkSide::Buy,
            Side::Sell => SdkSide::Sell,
        }
    }
}

/// Order time-in-force type.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum OrderType {
    /// Good till cancelled
    #[serde(rename = "GTC")]
    Gtc,
    /// Good till date (requires expiration)
    #[serde(rename = "GTD")]
    Gtd,
    /// Fill or kill
    #[serde(rename = "FOK")]
    Fok,
    /// Fill and kill (partial fill ok, cancel remainder)
    #[serde(rename = "FAK")]
    Fak,
}

impl std::fmt::Display for OrderType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OrderType::Gtc => write!(f, "GTC"),
            OrderType::Gtd => write!(f, "GTD"),
            OrderType::Fok => write!(f, "FOK"),
            OrderType::Fak => write!(f, "FAK"),
        }
    }
}

impl From<OrderType> for polymarket_client_sdk::clob::types::OrderType {
    fn from(ot: OrderType) -> Self {
        match ot {
            OrderType::Gtc => polymarket_client_sdk::clob::types::OrderType::GTC,
            OrderType::Gtd => polymarket_client_sdk::clob::types::OrderType::GTD,
            OrderType::Fok => polymarket_client_sdk::clob::types::OrderType::FOK,
            OrderType::Fak => polymarket_client_sdk::clob::types::OrderType::FAK,
        }
    }
}

/// Parameters for submitting a CLOB order.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClobOrderParams {
    /// CLOB token ID for the outcome (from market.clobTokenIds).
    pub token_id: String,
    /// Buy or Sell.
    pub side: Side,
    /// Limit price (0.0–1.0 for binary markets).
    pub price: Decimal,
    /// Size in outcome tokens.
    pub size: Decimal,
    /// Order type (default GTC).
    #[serde(default = "default_order_type")]
    pub order_type: OrderType,
    /// Expiration timestamp for GTD orders (unix seconds). 0 = no expiry.
    #[serde(default)]
    pub expiration: u64,
}

fn default_order_type() -> OrderType {
    OrderType::Gtc
}

/// Response from the CLOB API after order submission.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClobOrderResponse {
    /// Server-assigned order ID.
    #[serde(default)]
    pub order_id: String,
    /// Order status (e.g., "live", "matched", "delayed").
    #[serde(default)]
    pub status: String,
    /// Whether the order was accepted.
    #[serde(default)]
    pub success: bool,
    /// Error message if the order was rejected.
    #[serde(default)]
    pub error_msg: String,
    /// Size matched immediately (USDC).
    #[serde(default)]
    pub taking_amount: String,
    /// Size matched immediately (shares).
    #[serde(default)]
    pub making_amount: String,
}

impl From<PostOrderResponse> for ClobOrderResponse {
    fn from(r: PostOrderResponse) -> Self {
        Self {
            order_id: r.order_id,
            status: r.status.to_string(),
            success: r.success,
            error_msg: r.error_msg.unwrap_or_default(),
            taking_amount: r.taking_amount.to_string(),
            making_amount: r.making_amount.to_string(),
        }
    }
}

/// A price level in the order book.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PriceLevel {
    pub price: String,
    pub size: String,
}

impl From<&OrderSummary> for PriceLevel {
    fn from(s: &OrderSummary) -> Self {
        Self {
            price: s.price.to_string(),
            size: s.size.to_string(),
        }
    }
}

/// Order book snapshot for a token.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderBook {
    #[serde(default)]
    pub market: String,
    #[serde(default)]
    pub asset_id: String,
    #[serde(default)]
    pub bids: Vec<PriceLevel>,
    #[serde(default)]
    pub asks: Vec<PriceLevel>,
    #[serde(default)]
    pub timestamp: String,
}

impl From<OrderBookSummaryResponse> for OrderBook {
    fn from(r: OrderBookSummaryResponse) -> Self {
        Self {
            market: r.market.to_string(),
            asset_id: r.asset_id.to_string(),
            bids: r.bids.iter().map(PriceLevel::from).collect(),
            asks: r.asks.iter().map(PriceLevel::from).collect(),
            timestamp: r.timestamp.to_string(),
        }
    }
}

/// An open order on the CLOB (returned by order status queries).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenOrder {
    pub id: String,
    pub status: String,
    pub market: String,
    pub asset_id: String,
    pub side: String,
    pub price: String,
    pub original_size: String,
    pub size_matched: String,
    pub outcome: String,
    pub order_type: String,
    pub created_at: String,
    pub expiration: String,
}

impl From<OpenOrderResponse> for OpenOrder {
    fn from(r: OpenOrderResponse) -> Self {
        Self {
            id: r.id,
            status: r.status.to_string(),
            market: format!("{}", r.market),
            asset_id: r.asset_id.to_string(),
            side: format!("{:?}", r.side),
            price: r.price.to_string(),
            original_size: r.original_size.to_string(),
            size_matched: r.size_matched.to_string(),
            outcome: r.outcome,
            order_type: format!("{:?}", r.order_type),
            created_at: r.created_at.to_rfc3339(),
            expiration: r.expiration.to_rfc3339(),
        }
    }
}

/// Result of a collateral approval transaction.
#[derive(Debug, Clone, Serialize)]
pub struct ApprovalResult {
    pub tx_hash: String,
    pub spender: String,
    pub spender_label: String,
}

// ── ClobClient ───────────────────────────────────────────────────────────────

/// Authenticated SDK client type alias.
type AuthenticatedSdkClient = SdkClient<polymarket_client_sdk::auth::state::Authenticated<Normal>>;

/// Polymarket CLOB API client backed by the official `polymarket-client-sdk`.
///
/// Construction is cheap and synchronous. The underlying SDK client is lazily
/// authenticated on the first method call that requires it (order submission,
/// cancellation, etc.).
///
/// Auth tokens are automatically refreshed: on 401 responses, the cached client
/// is cleared and re-authenticated on the next call.
pub struct ClobClient {
    /// Cached authenticated SDK client. `None` = needs (re-)authentication.
    sdk: RwLock<Option<Arc<AuthenticatedSdkClient>>>,
    /// The operator's signer (kept for lazy auth and order signing).
    signer: PrivateKeySigner,
    address: Address,
    base_url: String,
    /// Pre-configured credentials from env vars (skips L1 auth derivation).
    pre_credentials: Option<Credentials>,
}

/// Maximum retry attempts for transient CLOB API errors.
const MAX_CLOB_RETRIES: u32 = 3;

/// Backoff durations between CLOB retries (ms).
const CLOB_RETRY_BACKOFF_MS: [u64; 3] = [100, 500, 2000];

/// Check if an error message indicates an auth failure (401/expired token).
fn is_auth_error(msg: &str) -> bool {
    let lower = msg.to_lowercase();
    lower.contains("401")
        || lower.contains("unauthorized")
        || lower.contains("expired")
        || lower.contains("invalid api key")
        || lower.contains("forbidden")
}

/// Check if an error message indicates a transient failure worth retrying.
fn is_retryable_error(msg: &str) -> bool {
    let lower = msg.to_lowercase();
    lower.contains("429")
        || lower.contains("rate limit")
        || lower.contains("500")
        || lower.contains("502")
        || lower.contains("503")
        || lower.contains("timeout")
        || lower.contains("connection")
        || lower.contains("reset")
}

/// Convert an SDK error into our TradingError.
fn sdk_err(msg: impl std::fmt::Display) -> TradingError {
    TradingError::ClobError {
        protocol: "polymarket_clob".into(),
        message: msg.to_string(),
    }
}

impl ClobClient {
    /// Create a new CLOB client from an operator private key (hex, with or without 0x).
    ///
    /// If `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, and `POLYMARKET_API_PASSPHRASE`
    /// env vars are set, those are used directly (skipping L1 credential derivation).
    ///
    /// The underlying SDK client is lazily authenticated on first use.
    pub fn new(private_key: &str) -> Result<Self, TradingError> {
        let base_url =
            std::env::var("POLYMARKET_CLOB_URL").unwrap_or_else(|_| DEFAULT_BASE_URL.to_string());
        Self::with_config(private_key, base_url, None)
    }

    /// Create a client with explicit configuration (for testing).
    ///
    /// `credentials`: Pre-configured SDK credentials. Use
    /// `ClobClient::test_credentials()` to create them in tests.
    pub fn with_config(
        private_key: &str,
        base_url: String,
        credentials: Option<Credentials>,
    ) -> Result<Self, TradingError> {
        let pk = private_key.strip_prefix("0x").unwrap_or(private_key);
        let signer: PrivateKeySigner = pk.parse().map_err(|e| TradingError::ClobError {
            protocol: "polymarket_clob".into(),
            message: format!("Invalid private key: {e}"),
        })?;

        // Set chain_id for EIP-712 signing (Polygon mainnet).
        let chain_id = std::env::var("POLYMARKET_CHAIN_ID")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(POLYGON_CHAIN_ID);
        let signer = signer.with_chain_id(Some(chain_id));
        let address = signer.address();

        // Check for pre-provided credentials from env vars.
        let pre_credentials = credentials.or_else(|| {
            match (
                std::env::var("POLYMARKET_API_KEY"),
                std::env::var("POLYMARKET_API_SECRET"),
                std::env::var("POLYMARKET_API_PASSPHRASE"),
            ) {
                (Ok(key), Ok(secret), Ok(passphrase)) if !key.is_empty() => {
                    tracing::info!("Using pre-configured Polymarket API credentials");
                    let api_key = uuid::Uuid::parse_str(&key).ok()?;
                    Some(Credentials::new(api_key, secret, passphrase))
                }
                _ => None,
            }
        });

        Ok(Self {
            sdk: RwLock::new(None),
            signer,
            address,
            base_url,
            pre_credentials,
        })
    }

    /// Create test credentials without importing the SDK directly.
    ///
    /// Uses a nil UUID as the API key and a fixed base64-encoded secret.
    pub fn test_credentials() -> Credentials {
        Credentials::new(
            uuid::Uuid::nil(),
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_string(),
            "test-passphrase".to_string(),
        )
    }

    /// Operator's EOA address.
    pub fn address(&self) -> Address {
        self.address
    }

    /// Eagerly initialize the authenticated SDK client.
    ///
    /// This is useful in tests to ensure the client is ready and caches can be
    /// pre-populated before calling `submit_order()`.
    pub async fn ensure_authenticated(&self) -> Result<(), TradingError> {
        self.client().await.map(|_| ())
    }

    /// Pre-populate the SDK caches for a token to avoid HTTP lookups during
    /// `submit_order()`. This is the primary test helper — call it after
    /// creating the client, before submitting orders.
    ///
    /// `tick_size`: one of "0.1", "0.01", "0.001", "0.0001"
    pub async fn configure_token_cache(
        &self,
        token_id_str: &str,
        tick_size: &str,
        neg_risk: bool,
        fee_rate_bps: u32,
    ) -> Result<(), TradingError> {
        let client = self.client().await?;
        let token_id =
            U256::from_str(token_id_str).map_err(|e| sdk_err(format!("Invalid token_id: {e}")))?;

        use polymarket_client_sdk::clob::types::TickSize;
        let tick = match tick_size {
            "0.1" => TickSize::Tenth,
            "0.01" => TickSize::Hundredth,
            "0.001" => TickSize::Thousandth,
            _ => TickSize::TenThousandth,
        };

        client.set_tick_size(token_id, tick);
        client.set_neg_risk(token_id, neg_risk);
        client.set_fee_rate_bps(token_id, fee_rate_bps);
        Ok(())
    }

    /// Lazily initialize and return the authenticated SDK client.
    ///
    /// Fast path: read-lock, check if cached, return Arc clone.
    /// Init path: write-lock, authenticate, store, return Arc clone.
    async fn client(&self) -> Result<Arc<AuthenticatedSdkClient>, TradingError> {
        // Fast path: client already authenticated.
        {
            let guard = self.sdk.read().await;
            if let Some(ref client) = *guard {
                return Ok(Arc::clone(client));
            }
        }

        // Slow path: need to authenticate.
        let mut guard = self.sdk.write().await;

        // Double-check after acquiring write lock (another task may have init'd).
        if let Some(ref client) = *guard {
            return Ok(Arc::clone(client));
        }

        let client = self.authenticate().await?;
        let arc = Arc::new(client);
        *guard = Some(Arc::clone(&arc));
        Ok(arc)
    }

    /// Perform SDK authentication (called under write lock).
    async fn authenticate(&self) -> Result<AuthenticatedSdkClient, TradingError> {
        let unauthenticated = SdkClient::new(
            &self.base_url,
            polymarket_client_sdk::clob::Config::default(),
        )
        .map_err(sdk_err)?;

        let mut builder = unauthenticated.authentication_builder(&self.signer);
        if let Some(ref creds) = self.pre_credentials {
            builder = builder.credentials(creds.clone());
        }
        builder.authenticate().await.map_err(sdk_err)
    }

    /// Invalidate the cached SDK client, forcing re-authentication on next use.
    async fn invalidate_auth(&self) {
        let mut guard = self.sdk.write().await;
        *guard = None;
        tracing::info!("CLOB auth invalidated — will re-authenticate on next call");
    }

    /// Submit a limit order to the CLOB with retry/backoff.
    ///
    /// Retries on transient errors (429, 5xx, timeouts). On 401, invalidates
    /// auth and retries once. Does NOT retry on 400 (bad request) or 409
    /// (duplicate order).
    pub async fn submit_order(
        &self,
        params: &ClobOrderParams,
    ) -> Result<ClobOrderResponse, TradingError> {
        let token_id = U256::from_str(&params.token_id).map_err(|e| TradingError::ClobError {
            protocol: "polymarket_clob".into(),
            message: format!("Invalid token_id: {e}"),
        })?;

        let mut last_err = sdk_err("no attempts made");
        let mut auth_retried = false;

        for attempt in 0..MAX_CLOB_RETRIES {
            let client = self.client().await?;

            let sdk_side: SdkSide = params.side.into();
            let sdk_order_type: polymarket_client_sdk::clob::types::OrderType =
                params.order_type.into();

            let mut order_builder = client
                .limit_order()
                .token_id(token_id)
                .side(sdk_side)
                .price(params.price)
                .size(params.size)
                .order_type(sdk_order_type);

            if params.order_type == OrderType::Gtd && params.expiration > 0 {
                let expiration = chrono::DateTime::from_timestamp(params.expiration as i64, 0)
                    .ok_or_else(|| sdk_err("Invalid GTD expiration timestamp"))?;
                order_builder = order_builder.expiration(expiration);
            }

            let signable = match order_builder.build().await {
                Ok(s) => s,
                Err(e) => {
                    // Build errors are deterministic — don't retry.
                    return Err(sdk_err(e));
                }
            };

            let signed = match client.sign(&self.signer, signable).await {
                Ok(s) => s,
                Err(e) => {
                    return Err(sdk_err(e));
                }
            };

            match client.post_order(signed).await {
                Ok(response) => {
                    tracing::info!(
                        order_id = %response.order_id,
                        status = %response.status,
                        success = %response.success,
                        token_id = %params.token_id,
                        side = ?params.side,
                        price = %params.price,
                        size = %params.size,
                        attempt = attempt + 1,
                        "CLOB order submitted"
                    );
                    return Ok(ClobOrderResponse::from(response));
                }
                Err(e) => {
                    let msg = e.to_string();

                    // Auth error — invalidate and retry once.
                    if is_auth_error(&msg) && !auth_retried {
                        tracing::warn!(
                            attempt = attempt + 1,
                            "CLOB auth error, invalidating and retrying: {msg}"
                        );
                        self.invalidate_auth().await;
                        auth_retried = true;
                        continue;
                    }

                    // Transient error — retry with backoff.
                    if is_retryable_error(&msg) && attempt + 1 < MAX_CLOB_RETRIES {
                        tracing::warn!(
                            attempt = attempt + 1,
                            backoff_ms = CLOB_RETRY_BACKOFF_MS[attempt as usize],
                            "CLOB transient error, retrying: {msg}"
                        );
                        tokio::time::sleep(std::time::Duration::from_millis(
                            CLOB_RETRY_BACKOFF_MS[attempt as usize],
                        ))
                        .await;
                        last_err = sdk_err(msg);
                        continue;
                    }

                    // Non-retryable error (400, 409, etc.) — fail immediately.
                    return Err(sdk_err(msg));
                }
            }
        }

        Err(last_err)
    }

    /// Cancel an open order.
    pub async fn cancel_order(&self, order_id: &str) -> Result<(), TradingError> {
        let client = self.client().await?;
        client.cancel_order(order_id).await.map_err(sdk_err)?;
        tracing::info!(order_id = %order_id, "CLOB order cancelled");
        Ok(())
    }

    /// Cancel all open orders.
    pub async fn cancel_all_orders(&self) -> Result<(), TradingError> {
        let client = self.client().await?;
        client.cancel_all_orders().await.map_err(sdk_err)?;
        tracing::info!("All CLOB orders cancelled");
        Ok(())
    }

    /// Get the order book for a token (public endpoint).
    pub async fn get_book(&self, token_id: &str) -> Result<OrderBook, TradingError> {
        let client = self.client().await?;
        let token_id =
            U256::from_str(token_id).map_err(|e| sdk_err(format!("Invalid token_id: {e}")))?;
        let request = OrderBookSummaryRequest::builder()
            .token_id(token_id)
            .build();
        let response = client.order_book(&request).await.map_err(sdk_err)?;
        Ok(OrderBook::from(response))
    }

    /// Get the midpoint price for a token (public endpoint).
    pub async fn get_midpoint(&self, token_id: &str) -> Result<Decimal, TradingError> {
        let client = self.client().await?;
        let token_id =
            U256::from_str(token_id).map_err(|e| sdk_err(format!("Invalid token_id: {e}")))?;
        let request = MidpointRequest::builder().token_id(token_id).build();
        let response = client.midpoint(&request).await.map_err(sdk_err)?;
        Ok(response.mid)
    }

    // ── Order status queries ─────────────────────────────────────────────

    /// Get details for a single open order by ID.
    pub async fn get_order(&self, order_id: &str) -> Result<OpenOrder, TradingError> {
        let client = self.client().await?;
        let response = client.order(order_id).await.map_err(sdk_err)?;
        Ok(OpenOrder::from(response))
    }

    /// Get all open orders, optionally filtered by market condition ID or asset (token) ID.
    pub async fn get_open_orders(
        &self,
        market: Option<&str>,
        asset_id: Option<&str>,
    ) -> Result<Vec<OpenOrder>, TradingError> {
        let client = self.client().await?;

        let market_b256 = market
            .map(|m| {
                m.parse()
                    .map_err(|e| sdk_err(format!("Invalid market: {e}")))
            })
            .transpose()?;
        let asset_u256 = asset_id
            .map(|a| U256::from_str(a).map_err(|e| sdk_err(format!("Invalid asset_id: {e}"))))
            .transpose()?;

        // Build different request variants based on filter combination.
        // The bon builder uses typestate so we can't conditionally chain.
        let request = match (market_b256, asset_u256) {
            (Some(m), Some(a)) => OrdersRequest::builder().market(m).asset_id(a).build(),
            (Some(m), None) => OrdersRequest::builder().market(m).build(),
            (None, Some(a)) => OrdersRequest::builder().asset_id(a).build(),
            (None, None) => OrdersRequest::builder().build(),
        };

        // Fetch all pages.
        let mut all_orders = Vec::new();
        let mut cursor: Option<String> = None;

        loop {
            let page = client.orders(&request, cursor).await.map_err(sdk_err)?;
            all_orders.extend(page.data.into_iter().map(OpenOrder::from));

            if page.next_cursor == "LTE=" || page.next_cursor.is_empty() {
                break;
            }
            cursor = Some(page.next_cursor);
        }

        Ok(all_orders)
    }

    // ── Collateral approval ──────────────────────────────────────────────

    /// Approve the CTFExchange (and optionally NegRiskCTFExchange + adapter) to
    /// spend the operator's collateral (USDC.e on Polygon).
    ///
    /// This must be called once before CLOB orders can fill. It sends on-chain
    /// `approve(spender, type(uint256).max)` transactions.
    ///
    /// Requires a funded operator EOA on Polygon (or the configured chain).
    pub async fn approve_collateral(
        &self,
        rpc_url: &str,
        approve_neg_risk: bool,
    ) -> Result<Vec<ApprovalResult>, TradingError> {
        use alloy::network::EthereumWallet;
        use alloy::providers::ProviderBuilder;
        use alloy::sol;

        sol! {
            #[sol(rpc)]
            interface IERC20 {
                function approve(address spender, uint256 value) external returns (bool);
                function allowance(address owner, address spender) external view returns (uint256);
            }
        }

        let chain_id = std::env::var("POLYMARKET_CHAIN_ID")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(POLYGON_CHAIN_ID);

        let wallet = EthereumWallet::from(self.signer.clone());
        let provider = ProviderBuilder::new().wallet(wallet).connect_http(
            rpc_url
                .parse()
                .map_err(|e| sdk_err(format!("Invalid RPC URL: {e}")))?,
        );

        let mut results = Vec::new();

        // Standard exchange approval.
        let config = polymarket_client_sdk::contract_config(chain_id, false)
            .ok_or_else(|| sdk_err(format!("No contract config for chain {chain_id}")))?;

        let token = IERC20::new(config.collateral, &provider);

        // Check existing allowance before sending tx.
        let allowance = token
            .allowance(self.address, config.exchange)
            .call()
            .await
            .map_err(|e| sdk_err(format!("allowance check failed: {e}")))?;

        if allowance < U256::from(u128::MAX) {
            let receipt = token
                .approve(config.exchange, U256::MAX)
                .send()
                .await
                .map_err(|e| sdk_err(format!("approve CTFExchange failed: {e}")))?
                .get_receipt()
                .await
                .map_err(|e| sdk_err(format!("approve CTFExchange receipt: {e}")))?;

            results.push(ApprovalResult {
                tx_hash: format!("{}", receipt.transaction_hash),
                spender: format!("{}", config.exchange),
                spender_label: "CTFExchange".into(),
            });
            tracing::info!(
                tx_hash = %receipt.transaction_hash,
                spender = %config.exchange,
                "Approved CTFExchange for collateral"
            );
        } else {
            tracing::info!(spender = %config.exchange, "CTFExchange already approved");
        }

        // NegRisk exchange + adapter approvals.
        if approve_neg_risk {
            let neg_config = polymarket_client_sdk::contract_config(chain_id, true)
                .ok_or_else(|| sdk_err(format!("No neg-risk config for chain {chain_id}")))?;

            // NegRisk exchange.
            let neg_allowance = token
                .allowance(self.address, neg_config.exchange)
                .call()
                .await
                .map_err(|e| sdk_err(format!("neg-risk allowance check failed: {e}")))?;

            if neg_allowance < U256::from(u128::MAX) {
                let receipt = token
                    .approve(neg_config.exchange, U256::MAX)
                    .send()
                    .await
                    .map_err(|e| sdk_err(format!("approve NegRiskCTFExchange failed: {e}")))?
                    .get_receipt()
                    .await
                    .map_err(|e| sdk_err(format!("approve NegRiskCTFExchange receipt: {e}")))?;

                results.push(ApprovalResult {
                    tx_hash: format!("{}", receipt.transaction_hash),
                    spender: format!("{}", neg_config.exchange),
                    spender_label: "NegRiskCTFExchange".into(),
                });
                tracing::info!(
                    tx_hash = %receipt.transaction_hash,
                    spender = %neg_config.exchange,
                    "Approved NegRiskCTFExchange for collateral"
                );
            }

            // NegRisk adapter.
            if let Some(adapter) = neg_config.neg_risk_adapter {
                let adapter_allowance = token
                    .allowance(self.address, adapter)
                    .call()
                    .await
                    .map_err(|e| sdk_err(format!("adapter allowance check failed: {e}")))?;

                if adapter_allowance < U256::from(u128::MAX) {
                    let receipt = token
                        .approve(adapter, U256::MAX)
                        .send()
                        .await
                        .map_err(|e| sdk_err(format!("approve NegRiskAdapter failed: {e}")))?
                        .get_receipt()
                        .await
                        .map_err(|e| sdk_err(format!("approve NegRiskAdapter receipt: {e}")))?;

                    results.push(ApprovalResult {
                        tx_hash: format!("{}", receipt.transaction_hash),
                        spender: format!("{}", adapter),
                        spender_label: "NegRiskAdapter".into(),
                    });
                    tracing::info!(
                        tx_hash = %receipt.transaction_hash,
                        spender = %adapter,
                        "Approved NegRiskAdapter for collateral"
                    );
                }
            }
        }

        Ok(results)
    }

    /// Get the Polymarket contract configuration for the current chain.
    pub fn contract_config(
        &self,
        neg_risk: bool,
    ) -> Result<&'static polymarket_client_sdk::ContractConfig, TradingError> {
        let chain_id = std::env::var("POLYMARKET_CHAIN_ID")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(POLYGON_CHAIN_ID);
        polymarket_client_sdk::contract_config(chain_id, neg_risk)
            .ok_or_else(|| sdk_err(format!("No contract config for chain {chain_id}")))
    }
}

impl std::fmt::Debug for ClobClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClobClient")
            .field("address", &self.address)
            .field("base_url", &self.base_url)
            .finish()
    }
}

// ── Helper: extract ClobOrderParams from execute request metadata ────────────

/// Extract CLOB order parameters from the intent payload's metadata field.
///
/// Expected metadata keys:
/// - `token_id` (string, required) — CLOB token ID
/// - `price` (number or string, required) — limit price 0.0–1.0
/// - `order_type` (string, optional, default "GTC") — GTC/GTD/FOK/FAK
/// - `expiration` (u64, optional) — for GTD orders
///
/// `side` and `size` are derived from the intent's `action` and `amount_in`.
pub fn extract_clob_params(
    action: &str,
    amount_in: &str,
    metadata: &serde_json::Value,
) -> Result<ClobOrderParams, String> {
    let token_id = metadata
        .get("token_id")
        .and_then(|v| v.as_str())
        .ok_or("metadata.token_id is required for polymarket_clob")?
        .to_string();

    // Parse price as Decimal — accept both string "0.65" and number 0.65.
    let price: Decimal = match metadata.get("price") {
        Some(serde_json::Value::String(s)) => s
            .parse()
            .map_err(|e| format!("Invalid metadata.price: {e}"))?,
        Some(serde_json::Value::Number(n)) => {
            // Convert via string representation to avoid f64 binary errors.
            let s = n.to_string();
            s.parse()
                .map_err(|e| format!("Invalid metadata.price: {e}"))?
        }
        _ => return Err("metadata.price is required for polymarket_clob".into()),
    };

    if price < Decimal::ZERO || price > Decimal::ONE {
        return Err(format!("price must be 0.0–1.0, got {price}"));
    }

    let size: Decimal = amount_in
        .parse()
        .map_err(|e| format!("Invalid amount_in for CLOB size: {e}"))?;

    let side = match action.to_lowercase().as_str() {
        "buy" => Side::Buy,
        "sell" => Side::Sell,
        other => {
            return Err(format!(
                "polymarket_clob only supports buy/sell, got '{other}'"
            ));
        }
    };

    let order_type_str = metadata
        .get("order_type")
        .and_then(|v| v.as_str())
        .unwrap_or("GTC");

    let order_type = match order_type_str.to_uppercase().as_str() {
        "GTC" => OrderType::Gtc,
        "GTD" => OrderType::Gtd,
        "FOK" => OrderType::Fok,
        "FAK" => OrderType::Fak,
        other => {
            return Err(format!(
                "Unknown order_type '{other}', expected GTC/GTD/FOK/FAK"
            ));
        }
    };

    let expiration = metadata
        .get("expiration")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    Ok(ClobOrderParams {
        token_id,
        side,
        price,
        size,
        order_type,
        expiration,
    })
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Test private key (Anvil key 0).
    const TEST_PK: &str = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

    #[test]
    fn test_client_creation() {
        let client = ClobClient::with_config(TEST_PK, "http://localhost:8080".into(), None)
            .expect("client creation");
        assert_eq!(
            format!("{}", client.address()),
            "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
        );
    }

    #[test]
    fn test_client_creation_with_0x_prefix() {
        let pk = format!("0x{TEST_PK}");
        let client = ClobClient::with_config(&pk, "http://localhost:8080".into(), None)
            .expect("client creation with 0x prefix");
        assert_eq!(
            format!("{}", client.address()),
            "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
        );
    }

    #[test]
    fn test_extract_clob_params_valid() {
        let metadata = serde_json::json!({
            "token_id": "48328953829",
            "price": 0.65,
            "order_type": "GTC",
        });

        let params = extract_clob_params("buy", "100.0", &metadata).expect("extract params");
        assert_eq!(params.token_id, "48328953829");
        assert_eq!(params.side, Side::Buy);
        assert_eq!(params.price, Decimal::from_str("0.65").unwrap());
        assert_eq!(params.size, Decimal::from_str("100.0").unwrap());
        assert_eq!(params.order_type, OrderType::Gtc);
    }

    #[test]
    fn test_extract_clob_params_string_price() {
        // Price as string — no f64 binary errors.
        let metadata = serde_json::json!({
            "token_id": "48328953829",
            "price": "0.65",
        });

        let params = extract_clob_params("buy", "100", &metadata).expect("extract params");
        assert_eq!(params.price, Decimal::from_str("0.65").unwrap());
    }

    #[test]
    fn test_extract_clob_params_missing_token_id() {
        let metadata = serde_json::json!({"price": 0.5});
        let err = extract_clob_params("buy", "100.0", &metadata).unwrap_err();
        assert!(err.contains("token_id"), "Error: {err}");
    }

    #[test]
    fn test_extract_clob_params_missing_price() {
        let metadata = serde_json::json!({"token_id": "123"});
        let err = extract_clob_params("buy", "100.0", &metadata).unwrap_err();
        assert!(err.contains("price"), "Error: {err}");
    }

    #[test]
    fn test_extract_clob_params_invalid_price() {
        let metadata = serde_json::json!({"token_id": "123", "price": 1.5});
        let err = extract_clob_params("buy", "100.0", &metadata).unwrap_err();
        assert!(err.contains("0.0") || err.contains("1.0"), "Error: {err}");
    }

    #[test]
    fn test_extract_clob_params_unsupported_action() {
        let metadata = serde_json::json!({"token_id": "123", "price": 0.5});
        let err = extract_clob_params("swap", "100.0", &metadata).unwrap_err();
        assert!(err.contains("buy/sell"), "Error: {err}");
    }

    #[test]
    fn test_extract_clob_params_sell() {
        let metadata = serde_json::json!({
            "token_id": "123",
            "price": 0.80,
        });
        let params = extract_clob_params("sell", "50.0", &metadata).expect("extract sell");
        assert_eq!(params.side, Side::Sell);
    }

    #[test]
    fn test_extract_clob_params_gtd_with_expiration() {
        let metadata = serde_json::json!({
            "token_id": "123",
            "price": 0.5,
            "order_type": "GTD",
            "expiration": 1740000000u64,
        });
        let params = extract_clob_params("buy", "100.0", &metadata).expect("extract GTD");
        assert_eq!(params.order_type, OrderType::Gtd);
        assert_eq!(params.expiration, 1740000000);
    }

    #[test]
    fn test_side_serialization() {
        assert_eq!(serde_json::to_string(&Side::Buy).unwrap(), r#""BUY""#);
        assert_eq!(serde_json::to_string(&Side::Sell).unwrap(), r#""SELL""#);
    }

    #[test]
    fn test_order_type_display() {
        assert_eq!(OrderType::Gtc.to_string(), "GTC");
        assert_eq!(OrderType::Gtd.to_string(), "GTD");
        assert_eq!(OrderType::Fok.to_string(), "FOK");
        assert_eq!(OrderType::Fak.to_string(), "FAK");
    }

    #[test]
    fn test_side_to_sdk_conversion() {
        assert!(matches!(SdkSide::from(Side::Buy), SdkSide::Buy));
        assert!(matches!(SdkSide::from(Side::Sell), SdkSide::Sell));
    }

    #[test]
    fn test_order_type_to_sdk_conversion() {
        use polymarket_client_sdk::clob::types::OrderType as SdkOt;
        assert!(matches!(SdkOt::from(OrderType::Gtc), SdkOt::GTC));
        assert!(matches!(SdkOt::from(OrderType::Gtd), SdkOt::GTD));
        assert!(matches!(SdkOt::from(OrderType::Fok), SdkOt::FOK));
        assert!(matches!(SdkOt::from(OrderType::Fak), SdkOt::FAK));
    }

    #[test]
    fn test_contract_config_polygon() {
        let client = ClobClient::with_config(TEST_PK, "http://localhost:8080".into(), None)
            .expect("client creation");
        let config = client.contract_config(false).expect("polygon config");
        assert_eq!(
            format!("{}", config.exchange),
            "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E"
        );
        assert_eq!(
            format!("{}", config.collateral),
            "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
        );
    }

    #[test]
    fn test_contract_config_neg_risk() {
        let client = ClobClient::with_config(TEST_PK, "http://localhost:8080".into(), None)
            .expect("client creation");
        let config = client.contract_config(true).expect("neg-risk config");
        assert_eq!(
            format!("{}", config.exchange),
            "0xC5d563A36AE78145C45a50134d48A1215220f80a"
        );
        assert!(config.neg_risk_adapter.is_some());
    }

    #[test]
    fn test_open_order_serialization() {
        let order = OpenOrder {
            id: "order-123".into(),
            status: "Live".into(),
            market: "0xabc".into(),
            asset_id: "12345".into(),
            side: "Buy".into(),
            price: "0.65".into(),
            original_size: "100".into(),
            size_matched: "50".into(),
            outcome: "Yes".into(),
            order_type: "GTC".into(),
            created_at: "2026-01-01T00:00:00+00:00".into(),
            expiration: "2026-12-31T00:00:00+00:00".into(),
        };
        let json = serde_json::to_value(&order).unwrap();
        assert_eq!(json["id"], "order-123");
        assert_eq!(json["status"], "Live");
        assert_eq!(json["size_matched"], "50");
    }

    #[test]
    fn test_approval_result_serialization() {
        let result = ApprovalResult {
            tx_hash: "0xabc123".into(),
            spender: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E".into(),
            spender_label: "CTFExchange".into(),
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["spender_label"], "CTFExchange");
    }
}
