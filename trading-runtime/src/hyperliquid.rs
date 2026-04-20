//! Native Hyperliquid client for direct L1 API trading.
//!
//! Wraps the `hyperliquid` crate to provide a high-level interface for the
//! trading HTTP API. All order signing, serialization, and API communication
//! is handled by the SDK — this module provides ergonomic typed wrappers.

use std::sync::Arc;

use ethers_signers::LocalWallet;
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
    asset_map: tokio::sync::RwLock<Option<Vec<String>>>,
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
            asset_map: tokio::sync::RwLock::new(None),
        })
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
                let meta = self
                    .info
                    .metadata()
                    .await
                    .map_err(|e| format!("HL metadata: {e}"))?;
                let names: Vec<String> = meta.universe.iter().map(|a| a.name.clone()).collect();
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

    pub async fn place_order(&self, req: &PlaceOrderRequest) -> Result<HlResponse, String> {
        let asset = self.resolve_asset(&req.asset).await?;

        let (limit_px, order_type, reduce_only) = match &req.order_type {
            HlOrderType::Limit { price } => (
                price.clone(),
                OrderType::Limit(Limit { tif: Tif::Gtc }),
                req.reduce_only,
            ),
            HlOrderType::Market => {
                let price = if req.is_buy {
                    "999999999".to_string()
                } else {
                    "0.0001".to_string()
                };
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

        self.exchange
            .place_order(self.wallet.clone(), vec![order], None)
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

        if stop_loss.is_some() || take_profit.is_some() {
            self.exchange
                .normal_tpsl(self.wallet.clone(), orders, None)
                .await
                .map_err(|e| format!("HL bracket: {e}"))
        } else {
            self.exchange
                .place_order(self.wallet.clone(), orders, None)
                .await
                .map_err(|e| format!("HL order: {e}"))
        }
    }

    pub async fn cancel_order(&self, asset: u32, order_id: u64) -> Result<HlResponse, String> {
        self.exchange
            .cancel_order(
                self.wallet.clone(),
                vec![CancelRequest {
                    asset,
                    oid: order_id,
                }],
                None,
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
        use ethers_signers::Signer;
        let address = self.wallet.address();

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
}
