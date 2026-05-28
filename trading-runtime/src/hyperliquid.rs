//! Native Hyperliquid client for direct L1 API trading.
//!
//! Wraps the `hyperliquid` crate to provide a high-level interface for the
//! trading HTTP API. All order signing, serialization, and API communication
//! is handled by the SDK — this module provides ergonomic typed wrappers.

use std::sync::Arc;

use ethers_signers::{LocalWallet, Signer};
use hyperliquid::types::Chain;
use hyperliquid::types::exchange::request::{
    CancelRequest, Limit, OrderRequest, OrderType, Tif, TpSl, Trigger,
};
use hyperliquid::types::exchange::response::Response as HlResponse;
use hyperliquid::{Exchange, Hyperliquid, Info};
use serde::{Deserialize, Serialize};

// ── Public types ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HlOrderType {
    Limit {
        price: String,
    },
    Market,
    StopLoss {
        trigger_price: String,
        is_market: bool,
    },
    TakeProfit {
        trigger_price: String,
        is_market: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaceOrderRequest {
    pub asset: AssetId,
    pub is_buy: bool,
    pub size: String,
    pub order_type: HlOrderType,
    #[serde(default)]
    pub reduce_only: bool,
    #[serde(default)]
    pub cloid: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AssetId {
    Index(u32),
    Symbol(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CancelOrderRequest {
    pub asset: u32,
    pub order_id: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetLeverageRequest {
    pub asset: u32,
    pub leverage: u32,
    #[serde(default = "default_true")]
    pub is_cross: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PositionInfo {
    pub asset: String,
    pub size: String,
    pub entry_price: String,
    pub unrealized_pnl: String,
    pub leverage: u32,
    pub liquidation_price: Option<String>,
    pub margin_used: String,
    pub return_on_equity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HlOpenOrderInfo {
    pub coin: String,
    pub limit_px: String,
    pub oid: u64,
    pub side: String,
    pub sz: String,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountInfo {
    pub account_value: String,
    pub total_margin_used: String,
    pub total_ntl_pos: String,
    pub total_raw_usd: String,
    pub withdrawable: String,
    pub positions: Vec<PositionInfo>,
    pub open_orders: Vec<HlOpenOrderInfo>,
}

// ── Client ──────────────────────────────────────────────────────────────────

pub struct HyperliquidClient {
    exchange: Exchange,
    info: Info,
    wallet: Arc<LocalWallet>,
    info_api_url: &'static str,
    asset_map: tokio::sync::RwLock<Option<Vec<String>>>,
}

const HYPERLIQUID_INFO_URL_MAINNET: &str = "https://api.hyperliquid.xyz/info";
const HYPERLIQUID_INFO_URL_TESTNET: &str = "https://api.hyperliquid-testnet.xyz/info";

#[derive(Debug, Deserialize)]
struct HlMetaResponse {
    universe: Vec<HlAssetMeta>,
}

#[derive(Debug, Deserialize)]
struct HlAssetMeta {
    name: String,
}

impl HyperliquidClient {
    pub fn new(private_key: &str) -> Result<Self, String> {
        let wallet: LocalWallet = private_key
            .parse()
            .map_err(|e| format!("invalid private key: {e}"))?;

        let chain = Chain::Arbitrum;
        let exchange: Exchange = Hyperliquid::new(chain);
        let info: Info = Hyperliquid::new(chain);

        Ok(Self {
            exchange,
            info,
            wallet: Arc::new(wallet),
            info_api_url: HYPERLIQUID_INFO_URL_MAINNET,
            asset_map: tokio::sync::RwLock::new(None),
        })
    }

    pub fn testnet(private_key: &str) -> Result<Self, String> {
        let wallet: LocalWallet = private_key
            .parse()
            .map_err(|e| format!("invalid private key: {e}"))?;

        let chain = Chain::ArbitrumTestnet;
        let exchange: Exchange = Hyperliquid::new(chain);
        let info: Info = Hyperliquid::new(chain);

        Ok(Self {
            exchange,
            info,
            wallet: Arc::new(wallet),
            info_api_url: HYPERLIQUID_INFO_URL_TESTNET,
            asset_map: tokio::sync::RwLock::new(None),
        })
    }

    pub fn wallet_address(&self) -> String {
        format!("{:#x}", self.wallet.address())
    }

    pub async fn resolve_asset(&self, id: &AssetId) -> Result<u32, String> {
        match id {
            AssetId::Index(i) => Ok(*i),
            AssetId::Symbol(sym) => {
                let upper = sym.to_uppercase();
                {
                    let cache = self.asset_map.read().await;
                    if let Some(ref names) = *cache
                        && let Some(idx) = names.iter().position(|n| n.to_uppercase() == upper)
                    {
                        return Ok(idx as u32);
                    }
                }
                let names = self.metadata_asset_names().await?;
                let idx = names
                    .iter()
                    .position(|n| n.to_uppercase() == upper)
                    .ok_or_else(|| format!("unknown HL asset: {sym}"))?
                    as u32;
                *self.asset_map.write().await = Some(names);
                Ok(idx)
            }
        }
    }

    async fn metadata_asset_names(&self) -> Result<Vec<String>, String> {
        let response = reqwest::Client::new()
            .post(self.info_api_url)
            .json(&serde_json::json!({ "type": "meta" }))
            .send()
            .await
            .map_err(|e| format!("HL metadata: {e}"))?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(format!("HL metadata returned {status}: {body}"));
        }
        let meta = response
            .json::<HlMetaResponse>()
            .await
            .map_err(|e| format!("HL metadata: {e}"))?;
        Ok(meta.universe.into_iter().map(|asset| asset.name).collect())
    }

    async fn asset_name(&self, asset: u32) -> Result<String, String> {
        {
            let cache = self.asset_map.read().await;
            if let Some(ref names) = *cache
                && let Some(name) = names.get(asset as usize)
            {
                return Ok(name.clone());
            }
        }
        let names = self.metadata_asset_names().await?;
        let name = names
            .get(asset as usize)
            .cloned()
            .ok_or_else(|| format!("unknown HL asset index: {asset}"))?;
        *self.asset_map.write().await = Some(names);
        Ok(name)
    }

    async fn market_ioc_price(&self, asset: u32, is_buy: bool) -> Result<String, String> {
        let symbol = self.asset_name(asset).await?;
        let mids = self
            .info
            .mids()
            .await
            .map_err(|e| format!("HL mids: {e}"))?;
        let mid = mids
            .get(&symbol)
            .or_else(|| mids.get(&symbol.to_uppercase()))
            .or_else(|| mids.get(&symbol.to_lowercase()))
            .ok_or_else(|| format!("HL mid price missing for {symbol}"))?;
        let mid: f64 = mid
            .parse()
            .map_err(|e| format!("HL mid price for {symbol} is invalid: {e}"))?;
        if !mid.is_finite() || mid <= 0.0 {
            return Err(format!("HL mid price for {symbol} must be positive"));
        }
        let slippage_bps = std::env::var("HYPERLIQUID_MARKET_SLIPPAGE_BPS")
            .ok()
            .and_then(|raw| raw.trim().parse::<f64>().ok())
            .filter(|value| value.is_finite() && *value >= 0.0)
            .unwrap_or(100.0)
            .min(1_000.0);
        let multiplier = if is_buy {
            1.0 + slippage_bps / 10_000.0
        } else {
            1.0 - slippage_bps / 10_000.0
        };
        Ok(format_hyperliquid_price(mid * multiplier.max(0.0001)))
    }

    fn parse_account_address<T>(account_address: Option<&str>) -> Result<Option<T>, String>
    where
        T: std::str::FromStr,
        T::Err: std::fmt::Display,
    {
        account_address
            .filter(|raw| !raw.trim().is_empty())
            .map(|raw| {
                raw.parse()
                    .map_err(|e| format!("invalid HL account address '{raw}': {e}"))
            })
            .transpose()
    }

    pub async fn place_order(&self, req: &PlaceOrderRequest) -> Result<HlResponse, String> {
        self.place_order_for_account(req, None).await
    }

    pub async fn place_order_for_account(
        &self,
        req: &PlaceOrderRequest,
        account_address: Option<&str>,
    ) -> Result<HlResponse, String> {
        let asset = self.resolve_asset(&req.asset).await?;

        let (limit_px, order_type, reduce_only) = match &req.order_type {
            HlOrderType::Limit { price } => (
                price.clone(),
                OrderType::Limit(Limit { tif: Tif::Gtc }),
                req.reduce_only,
            ),
            HlOrderType::Market => {
                let price = self.market_ioc_price(asset, req.is_buy).await?;
                (
                    price,
                    OrderType::Limit(Limit { tif: Tif::Ioc }),
                    req.reduce_only,
                )
            }
            HlOrderType::StopLoss {
                trigger_price,
                is_market,
            } => (
                trigger_price.clone(),
                OrderType::Trigger(Trigger {
                    is_market: *is_market,
                    trigger_px: trigger_price.clone(),
                    tpsl: TpSl::Sl,
                }),
                true,
            ),
            HlOrderType::TakeProfit {
                trigger_price,
                is_market,
            } => (
                trigger_price.clone(),
                OrderType::Trigger(Trigger {
                    is_market: *is_market,
                    trigger_px: trigger_price.clone(),
                    tpsl: TpSl::Tp,
                }),
                true,
            ),
        };

        let cloid = req
            .cloid
            .as_ref()
            .map(|c| c.parse())
            .transpose()
            .map_err(|e| format!("invalid cloid: {e}"))?;

        let order = OrderRequest {
            asset,
            is_buy: req.is_buy,
            limit_px,
            sz: req.size.clone(),
            reduce_only,
            order_type,
            cloid,
        };

        let vault_address = Self::parse_account_address(account_address)?;

        self.exchange
            .place_order(self.wallet.clone(), vec![order], vault_address)
            .await
            .map_err(|e| format!("HL place_order: {e}"))
    }

    /// Place entry + SL/TP as a grouped order.
    pub async fn place_bracket(
        &self,
        entry: &PlaceOrderRequest,
        stop_loss: Option<&PlaceOrderRequest>,
        take_profit: Option<&PlaceOrderRequest>,
    ) -> Result<HlResponse, String> {
        self.place_bracket_for_account(entry, stop_loss, take_profit, None)
            .await
    }

    pub async fn place_bracket_for_account(
        &self,
        entry: &PlaceOrderRequest,
        stop_loss: Option<&PlaceOrderRequest>,
        take_profit: Option<&PlaceOrderRequest>,
        account_address: Option<&str>,
    ) -> Result<HlResponse, String> {
        let asset = self.resolve_asset(&entry.asset).await?;
        let mut orders = Vec::new();

        // Entry
        let (entry_px, entry_ot) = match &entry.order_type {
            HlOrderType::Limit { price } => {
                (price.clone(), OrderType::Limit(Limit { tif: Tif::Gtc }))
            }
            HlOrderType::Market => {
                let px = if entry.is_buy { "999999999" } else { "0.0001" };
                (px.to_string(), OrderType::Limit(Limit { tif: Tif::Ioc }))
            }
            _ => return Err("entry must be Limit or Market".into()),
        };
        orders.push(OrderRequest {
            asset,
            is_buy: entry.is_buy,
            limit_px: entry_px,
            sz: entry.size.clone(),
            reduce_only: false,
            order_type: entry_ot,
            cloid: None,
        });

        // SL
        if let Some(sl) = stop_loss {
            let tp = match &sl.order_type {
                HlOrderType::StopLoss {
                    trigger_price,
                    is_market,
                } => (trigger_price, *is_market),
                _ => return Err("stop_loss must be StopLoss type".into()),
            };
            orders.push(OrderRequest {
                asset,
                is_buy: !entry.is_buy,
                limit_px: tp.0.clone(),
                sz: entry.size.clone(),
                reduce_only: true,
                order_type: OrderType::Trigger(Trigger {
                    is_market: tp.1,
                    trigger_px: tp.0.clone(),
                    tpsl: TpSl::Sl,
                }),
                cloid: None,
            });
        }

        // TP
        if let Some(tp_req) = take_profit {
            let tp = match &tp_req.order_type {
                HlOrderType::TakeProfit {
                    trigger_price,
                    is_market,
                } => (trigger_price, *is_market),
                _ => return Err("take_profit must be TakeProfit type".into()),
            };
            orders.push(OrderRequest {
                asset,
                is_buy: !entry.is_buy,
                limit_px: tp.0.clone(),
                sz: entry.size.clone(),
                reduce_only: true,
                order_type: OrderType::Trigger(Trigger {
                    is_market: tp.1,
                    trigger_px: tp.0.clone(),
                    tpsl: TpSl::Tp,
                }),
                cloid: None,
            });
        }

        let vault_address = Self::parse_account_address(account_address)?;

        if stop_loss.is_some() || take_profit.is_some() {
            self.exchange
                .normal_tpsl(self.wallet.clone(), orders, vault_address)
                .await
                .map_err(|e| format!("HL bracket: {e}"))
        } else {
            self.exchange
                .place_order(self.wallet.clone(), orders, vault_address)
                .await
                .map_err(|e| format!("HL order: {e}"))
        }
    }

    pub async fn cancel_order(&self, asset: u32, order_id: u64) -> Result<HlResponse, String> {
        self.cancel_order_for_account(asset, order_id, None).await
    }

    pub async fn cancel_order_for_account(
        &self,
        asset: u32,
        order_id: u64,
        account_address: Option<&str>,
    ) -> Result<HlResponse, String> {
        let vault_address = Self::parse_account_address(account_address)?;

        self.exchange
            .cancel_order(
                self.wallet.clone(),
                vec![CancelRequest {
                    asset,
                    oid: order_id,
                }],
                vault_address,
            )
            .await
            .map_err(|e| format!("HL cancel: {e}"))
    }

    pub async fn set_leverage(
        &self,
        asset: u32,
        leverage: u32,
        is_cross: bool,
    ) -> Result<HlResponse, String> {
        self.exchange
            .update_leverage(self.wallet.clone(), leverage, asset, is_cross)
            .await
            .map_err(|e| format!("HL leverage: {e}"))
    }

    pub async fn get_account(&self) -> Result<AccountInfo, String> {
        self.get_account_for(None).await
    }

    pub async fn get_account_for(
        &self,
        account_address: Option<&str>,
    ) -> Result<AccountInfo, String> {
        let address = match account_address.filter(|raw| !raw.trim().is_empty()) {
            Some(raw) => raw
                .parse()
                .map_err(|e| format!("invalid HL account address '{raw}': {e}"))?,
            None => self.wallet.address(),
        };

        let state = self
            .info
            .user_state(address)
            .await
            .map_err(|e| format!("HL user_state: {e}"))?;

        let orders = self
            .info
            .open_orders(address)
            .await
            .map_err(|e| format!("HL open_orders: {e}"))?;

        let positions: Vec<PositionInfo> = state
            .asset_positions
            .iter()
            .filter(|ap| ap.position.szi.parse::<f64>().is_ok_and(|s| s.abs() > 0.0))
            .map(|ap| {
                let pos = &ap.position;
                PositionInfo {
                    asset: pos.coin.clone(),
                    size: pos.szi.clone(),
                    entry_price: pos.entry_px.clone().unwrap_or_default(),
                    unrealized_pnl: pos.unrealized_pnl.clone(),
                    leverage: pos.leverage.value,
                    liquidation_price: pos.liquidation_px.clone(),
                    margin_used: pos.margin_used.clone(),
                    return_on_equity: pos.return_on_equity.clone(),
                }
            })
            .collect();

        let open_orders: Vec<HlOpenOrderInfo> = orders
            .into_iter()
            .map(|o| HlOpenOrderInfo {
                coin: o.coin,
                limit_px: o.limit_px,
                oid: o.oid,
                side: format!("{:?}", o.side),
                sz: o.sz,
                timestamp: o.timestamp,
            })
            .collect();

        Ok(AccountInfo {
            account_value: state.margin_summary.account_value,
            total_margin_used: state.margin_summary.total_margin_used,
            total_ntl_pos: state.margin_summary.total_ntl_pos,
            total_raw_usd: state.margin_summary.total_raw_usd,
            withdrawable: state.withdrawable,
            positions,
            open_orders,
        })
    }

    pub async fn get_mids(&self) -> Result<std::collections::HashMap<String, String>, String> {
        self.info.mids().await.map_err(|e| format!("HL mids: {e}"))
    }

    /// Reconcile local position ledger against HL clearinghouse state.
    ///
    /// Called on startup to detect orphaned positions (open on HL but unknown locally).
    /// Returns the list of HL positions found, with reconciliation status.
    pub async fn reconcile_positions(
        &self,
        ledger: &PositionLedger,
    ) -> Result<ReconciliationResult, String> {
        let account = self.get_account().await?;
        let mut orphaned = Vec::new();
        let mut matched = Vec::new();
        let mut stale = Vec::new();

        // Check HL positions against local ledger
        for hl_pos in &account.positions {
            let size: f64 = hl_pos.size.parse().unwrap_or(0.0);
            if size.abs() < 1e-10 {
                continue;
            }
            match ledger.get(&hl_pos.asset) {
                Some(local) => {
                    matched.push(hl_pos.asset.clone());
                    tracing::info!(
                        asset = %hl_pos.asset,
                        hl_size = %hl_pos.size,
                        local_size = %local.size,
                        "Position reconciled"
                    );
                }
                None => {
                    orphaned.push(hl_pos.clone());
                    tracing::error!(
                        asset = %hl_pos.asset,
                        size = %hl_pos.size,
                        entry = %hl_pos.entry_price,
                        "ORPHANED POSITION — open on HL but not in local ledger"
                    );
                    // Add to ledger so we track it going forward
                    ledger.upsert(HlPositionRecord {
                        asset: hl_pos.asset.clone(),
                        size: hl_pos.size.clone(),
                        entry_price: hl_pos.entry_price.clone(),
                        side: if size > 0.0 { "long" } else { "short" }.into(),
                        sl_oid: None,
                        tp_oid: None,
                        opened_at: chrono::Utc::now().timestamp(),
                        reconciled: true,
                    });
                }
            }
        }

        // Check local records against HL (stale entries)
        let hl_assets: std::collections::HashSet<String> =
            account.positions.iter().map(|p| p.asset.clone()).collect();
        for (asset, _) in ledger.all() {
            if !hl_assets.contains(&asset) {
                stale.push(asset.clone());
                tracing::warn!(asset = %asset, "Stale local record — no HL position, removing");
                ledger.remove(&asset);
            }
        }

        Ok(ReconciliationResult {
            orphaned_count: orphaned.len(),
            matched_count: matched.len(),
            stale_removed: stale.len(),
            hl_positions: account.positions,
        })
    }

    /// Emergency close all open HL positions (graceful shutdown).
    ///
    /// Places market-close orders for each position. Best-effort — logs errors
    /// but doesn't propagate them (shutdown must complete).
    pub async fn emergency_close_all(&self) -> Vec<(String, Result<(), String>)> {
        let account = match self.get_account().await {
            Ok(a) => a,
            Err(e) => {
                tracing::error!("Cannot fetch HL account for emergency close: {e}");
                return vec![];
            }
        };

        let mut results = Vec::new();
        for pos in &account.positions {
            let size: f64 = match pos.size.parse::<f64>() {
                Ok(s) if s.abs() > 1e-10 => s,
                _ => continue,
            };

            let close_req = PlaceOrderRequest {
                asset: AssetId::Symbol(pos.asset.clone()),
                is_buy: size < 0.0, // close long = sell, close short = buy
                size: format!("{:.8}", size.abs()),
                order_type: HlOrderType::Market,
                reduce_only: true,
                cloid: None,
            };

            tracing::warn!(
                asset = %pos.asset,
                size = %pos.size,
                "EMERGENCY CLOSE — shutting down with open position"
            );

            let result = self.place_order(&close_req).await.map(|_| ());
            if let Err(ref e) = result {
                tracing::error!(
                    asset = %pos.asset,
                    size = %pos.size,
                    error = %e,
                    "EMERGENCY CLOSE FAILED — position remains open on HL"
                );
            }
            results.push((pos.asset.clone(), result));
        }
        results
    }
}

// ── Retry helper ────────────────────────────────────────────────────────────

/// Retry an async operation with exponential backoff.
/// Returns the result of the first successful attempt, or the last error.
pub async fn with_retry<F, Fut, T>(label: &str, max_attempts: u32, f: F) -> Result<T, String>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let mut last_err = String::new();
    for attempt in 0..max_attempts {
        match f().await {
            Ok(val) => return Ok(val),
            Err(e) => {
                last_err = e;
                if attempt + 1 < max_attempts {
                    let delay_ms = 1000 * 2u64.pow(attempt);
                    tracing::warn!(
                        attempt = attempt + 1,
                        max = max_attempts,
                        delay_ms,
                        error = %last_err,
                        "{label}: retrying after {delay_ms}ms"
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                }
            }
        }
    }
    Err(format!(
        "{label}: all {max_attempts} attempts failed: {last_err}"
    ))
}

// ── Position ledger ─────────────────────────────────────────────────────────

/// A single tracked HL position.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HlPositionRecord {
    pub asset: String,
    pub size: String,
    pub entry_price: String,
    pub side: String,
    pub sl_oid: Option<u64>,
    pub tp_oid: Option<u64>,
    pub opened_at: i64,
    #[serde(default)]
    pub reconciled: bool,
}

/// Persistent position ledger backed by a JSON file in the state directory.
pub struct PositionLedger {
    positions: std::sync::RwLock<std::collections::HashMap<String, HlPositionRecord>>,
    path: std::path::PathBuf,
}

impl PositionLedger {
    /// Load or create the position ledger from the state directory.
    pub fn open(state_dir: &std::path::Path) -> Self {
        let path = state_dir.join("hl-positions.json");
        let positions = if path.exists() {
            match std::fs::read_to_string(&path) {
                Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
                Err(e) => {
                    tracing::error!(path = %path.display(), error = %e, "Failed to read position ledger");
                    std::collections::HashMap::new()
                }
            }
        } else {
            std::collections::HashMap::new()
        };
        let count = positions.len();
        if count > 0 {
            tracing::info!(count, "Loaded HL position ledger from disk");
        }
        Self {
            positions: std::sync::RwLock::new(positions),
            path,
        }
    }

    pub fn get(&self, asset: &str) -> Option<HlPositionRecord> {
        self.positions.read().unwrap().get(asset).cloned()
    }

    pub fn upsert(&self, record: HlPositionRecord) {
        let asset = record.asset.clone();
        self.positions.write().unwrap().insert(asset, record);
        self.flush();
    }

    pub fn remove(&self, asset: &str) {
        self.positions.write().unwrap().remove(asset);
        self.flush();
    }

    pub fn all(&self) -> Vec<(String, HlPositionRecord)> {
        self.positions
            .read()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    fn flush(&self) {
        let data = self.positions.read().unwrap();
        if let Ok(json) = serde_json::to_string_pretty(&*data)
            && let Err(e) = std::fs::write(&self.path, json)
        {
            tracing::error!(
                path = %self.path.display(),
                error = %e,
                "Failed to persist HL position ledger"
            );
        }
    }
}

/// Result of a startup reconciliation.
#[derive(Debug)]
pub struct ReconciliationResult {
    pub orphaned_count: usize,
    pub matched_count: usize,
    pub stale_removed: usize,
    pub hl_positions: Vec<PositionInfo>,
}

fn format_hyperliquid_price(price: f64) -> String {
    if !price.is_finite() || price <= 0.0 {
        return "0.0001".to_string();
    }
    let order = price.abs().log10().floor() as i32;
    let decimals = (4 - order).clamp(0, 8) as usize;
    let formatted = format!("{price:.decimals$}");
    formatted
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn order_type_serde_roundtrip() {
        let cases = vec![
            (r#"{"type":"limit","price":"2500"}"#, "limit"),
            (r#"{"type":"market"}"#, "market"),
            (
                r#"{"type":"stop_loss","trigger_price":"2400","is_market":true}"#,
                "stop_loss",
            ),
            (
                r#"{"type":"take_profit","trigger_price":"2600","is_market":false}"#,
                "take_profit",
            ),
        ];
        for (json, expected_type) in cases {
            let ot: HlOrderType = serde_json::from_str(json).unwrap();
            let out = serde_json::to_string(&ot).unwrap();
            assert!(out.contains(expected_type), "got: {out}");
        }
    }

    #[test]
    fn place_order_request_with_symbol() {
        let json = r#"{
            "asset": "ETH",
            "is_buy": true,
            "size": "0.1",
            "order_type": {"type": "limit", "price": "2500"}
        }"#;
        let req: PlaceOrderRequest = serde_json::from_str(json).unwrap();
        assert!(matches!(req.asset, AssetId::Symbol(ref s) if s == "ETH"));
        assert!(req.is_buy);
        assert_eq!(req.size, "0.1");
    }

    #[test]
    fn place_order_request_with_index() {
        let json = r#"{
            "asset": 1,
            "is_buy": false,
            "size": "100",
            "order_type": {"type": "market"},
            "reduce_only": true
        }"#;
        let req: PlaceOrderRequest = serde_json::from_str(json).unwrap();
        assert!(matches!(req.asset, AssetId::Index(1)));
        assert!(req.reduce_only);
    }

    #[test]
    fn cancel_request_serde() {
        let json = r#"{"asset": 0, "order_id": 12345}"#;
        let req: CancelOrderRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.asset, 0);
        assert_eq!(req.order_id, 12345);
    }

    #[test]
    fn leverage_request_defaults() {
        let json = r#"{"asset": 1, "leverage": 10}"#;
        let req: SetLeverageRequest = serde_json::from_str(json).unwrap();
        assert!(req.is_cross); // default true
    }

    #[test]
    fn market_ioc_price_format_uses_bounded_significant_figures() {
        assert_eq!(format_hyperliquid_price(2084.3 * 1.01), "2105.1");
        assert_eq!(format_hyperliquid_price(75862.5 * 1.01), "76621");
        assert_eq!(format_hyperliquid_price(83.7915 * 0.99), "82.954");
    }

    #[test]
    fn metadata_response_allows_assets_without_only_isolated() {
        let json = r#"{
            "universe": [
                {"szDecimals": 5, "name": "BTC", "maxLeverage": 40, "marginTableId": 56},
                {"szDecimals": 4, "name": "ETH", "maxLeverage": 25, "marginTableId": 55}
            ]
        }"#;

        let meta: HlMetaResponse = serde_json::from_str(json).unwrap();

        assert_eq!(
            meta.universe
                .into_iter()
                .map(|asset| asset.name)
                .collect::<Vec<_>>(),
            vec!["BTC", "ETH"]
        );
    }

    #[test]
    fn position_ledger_crud() {
        let dir = std::env::temp_dir().join(format!("hl-ledger-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        let ledger = PositionLedger::open(&dir);
        assert!(ledger.all().is_empty());

        ledger.upsert(HlPositionRecord {
            asset: "ETH".into(),
            size: "0.1".into(),
            entry_price: "2500".into(),
            side: "long".into(),
            sl_oid: Some(123),
            tp_oid: Some(456),
            opened_at: 1000,
            reconciled: false,
        });
        assert_eq!(ledger.all().len(), 1);
        assert!(ledger.get("ETH").is_some());

        // Persistence — reopen from disk
        let ledger2 = PositionLedger::open(&dir);
        assert_eq!(ledger2.all().len(), 1);
        assert_eq!(ledger2.get("ETH").unwrap().size, "0.1");

        // Remove
        ledger2.remove("ETH");
        assert!(ledger2.get("ETH").is_none());

        // Verify removal persisted
        let ledger3 = PositionLedger::open(&dir);
        assert!(ledger3.all().is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn position_record_serde() {
        let rec = HlPositionRecord {
            asset: "BTC".into(),
            size: "-0.01".into(),
            entry_price: "67000".into(),
            side: "short".into(),
            sl_oid: None,
            tp_oid: Some(789),
            opened_at: 12345,
            reconciled: true,
        };
        let json = serde_json::to_string(&rec).unwrap();
        let parsed: HlPositionRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.asset, "BTC");
        assert_eq!(parsed.side, "short");
        assert!(parsed.reconciled);
    }

    #[tokio::test]
    async fn retry_succeeds_on_second_attempt() {
        use std::sync::atomic::{AtomicU32, Ordering};
        let attempts = AtomicU32::new(0);
        let result = with_retry("test", 3, || {
            let n = attempts.fetch_add(1, Ordering::Relaxed);
            async move {
                if n == 0 {
                    Err("transient".into())
                } else {
                    Ok(42u32)
                }
            }
        })
        .await;
        assert_eq!(result.unwrap(), 42);
    }

    #[tokio::test]
    async fn retry_exhausts_attempts() {
        let result: Result<(), String> =
            with_retry("test", 2, || async { Err("permanent".into()) }).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("2 attempts"));
    }
}
