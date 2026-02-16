//! Polymarket CLOB WebSocket producer.
//!
//! Connects to the Polymarket CLOB WebSocket API, subscribes to order book
//! channels for tracked markets, and produces `JobCall`s when significant
//! price moves are detected.
//!
//! This is a custom `Stream<Item = Result<JobCall, BoxError>>` that plugs
//! directly into the Blueprint SDK runner as a producer.

use std::collections::HashMap;
use std::pin::Pin;
use std::task::{Context, Poll};

use blueprint_sdk::JobCall;
use blueprint_sdk::job::call::Parts;
use bytes::Bytes;
use futures_core::Stream;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::JOB_WEBHOOK_EVENT;

/// Polymarket WebSocket producer that monitors CLOB price feeds and
/// produces `JobCall`s for `JOB_WEBHOOK_EVENT` when price moves exceed
/// a configurable threshold.
pub struct PolymarketProducer {
    rx: mpsc::UnboundedReceiver<JobCall>,
    _handle: JoinHandle<()>,
}

impl PolymarketProducer {
    /// Create a new producer that tracks the given market condition IDs.
    ///
    /// - `markets`: list of condition_ids to subscribe to
    /// - `threshold_pct`: minimum price move percentage to trigger (default 5.0)
    /// - `service_id`: the service ID for JobCall metadata
    pub fn new(markets: Vec<String>, threshold_pct: f64, service_id: u64) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();

        let handle = tokio::spawn(async move {
            polymarket_ws_loop(markets, threshold_pct, service_id, tx).await;
        });

        Self {
            rx,
            _handle: handle,
        }
    }
}

impl Stream for PolymarketProducer {
    type Item = Result<JobCall, Box<dyn std::error::Error + Send + Sync>>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.rx.poll_recv(cx).map(|opt| opt.map(Ok))
    }
}

/// Internal message format from the Polymarket CLOB WebSocket.
#[derive(Debug, Deserialize)]
struct ClobWsMessage {
    #[serde(default)]
    #[allow(dead_code)]
    event_type: String,
    #[serde(default)]
    market: String,
    #[serde(default)]
    price: Option<f64>,
    #[serde(default)]
    asset_id: Option<String>,
    #[serde(default)]
    timestamp: Option<String>,
}

/// Price move event produced when threshold is crossed.
#[derive(Debug, Serialize)]
struct PriceMoveEvent {
    target: String,
    event: String,
    data: PriceMoveData,
}

#[derive(Debug, Serialize)]
struct PriceMoveData {
    market: String,
    asset_id: String,
    old_price: f64,
    new_price: f64,
    change_pct: f64,
    timestamp: String,
}

/// Main WebSocket loop. Connects, subscribes, monitors prices, and
/// produces JobCalls when thresholds are crossed. Reconnects on error.
async fn polymarket_ws_loop(
    markets: Vec<String>,
    threshold_pct: f64,
    _service_id: u64,
    tx: mpsc::UnboundedSender<JobCall>,
) {
    let ws_url = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
    let mut last_prices: HashMap<String, f64> = HashMap::new();
    let mut call_id_counter: u64 = 1;

    loop {
        tracing::info!(
            url = ws_url,
            markets = ?markets,
            threshold_pct,
            "connecting to Polymarket CLOB WebSocket"
        );

        match connect_and_subscribe(ws_url, &markets).await {
            Ok(mut ws) => {
                tracing::info!("Polymarket WebSocket connected, processing messages");

                loop {
                    match read_ws_message(&mut ws).await {
                        Ok(Some(msg)) => {
                            if let Some(event) =
                                check_price_move(&msg, &mut last_prices, threshold_pct)
                            {
                                let body = match serde_json::to_vec(&event) {
                                    Ok(b) => b,
                                    Err(e) => {
                                        tracing::error!("Failed to serialize price move: {e}");
                                        continue;
                                    }
                                };

                                let parts = Parts::new(JOB_WEBHOOK_EVENT);
                                let job_call = JobCall::from_parts(parts, Bytes::from(body));
                                call_id_counter += 1;

                                if tx.send(job_call).is_err() {
                                    tracing::info!(
                                        "Producer channel closed, stopping Polymarket WS"
                                    );
                                    return;
                                }

                                tracing::info!(
                                    market = %event.data.market,
                                    change_pct = event.data.change_pct,
                                    call_id = call_id_counter - 1,
                                    "price move detected, JobCall produced"
                                );
                            }
                        }
                        Ok(None) => {
                            tracing::warn!("Polymarket WebSocket stream ended");
                            break;
                        }
                        Err(e) => {
                            tracing::error!("Polymarket WebSocket error: {e}");
                            break;
                        }
                    }
                }
            }
            Err(e) => {
                tracing::error!("Failed to connect to Polymarket WebSocket: {e}");
            }
        }

        // Reconnect after delay
        tracing::info!("Reconnecting to Polymarket WebSocket in 5s...");
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
}

/// Check if a message represents a significant price move.
fn check_price_move(
    msg: &ClobWsMessage,
    last_prices: &mut HashMap<String, f64>,
    threshold_pct: f64,
) -> Option<PriceMoveEvent> {
    let new_price = msg.price?;
    let asset_id = msg.asset_id.as_deref().unwrap_or(&msg.market);

    if asset_id.is_empty() || new_price <= 0.0 {
        return None;
    }

    let key = asset_id.to_string();

    if let Some(&old_price) = last_prices.get(&key) {
        let change_pct = ((new_price - old_price) / old_price).abs() * 100.0;

        if change_pct >= threshold_pct {
            last_prices.insert(key.clone(), new_price);

            return Some(PriceMoveEvent {
                target: "strategy:prediction".to_string(),
                event: "price_move".to_string(),
                data: PriceMoveData {
                    market: msg.market.clone(),
                    asset_id: key,
                    old_price,
                    new_price,
                    change_pct,
                    timestamp: msg
                        .timestamp
                        .clone()
                        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
                },
            });
        }
    }

    // Update tracked price (first observation or sub-threshold move)
    last_prices.insert(key, new_price);
    None
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket transport (tokio-tungstenite)
// ─────────────────────────────────────────────────────────────────────────────

type WsStream = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

async fn connect_and_subscribe(
    url: &str,
    markets: &[String],
) -> Result<WsStream, Box<dyn std::error::Error + Send + Sync>> {
    let (ws, _resp) = tokio_tungstenite::connect_async(url).await?;

    // Subscribe to markets
    let subscribe_msg = json!({
        "type": "subscribe",
        "markets": markets,
        "channels": ["price"]
    });

    use futures_util::SinkExt;
    let mut ws = ws;
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        subscribe_msg.to_string().into(),
    ))
    .await?;

    tracing::info!(markets = ?markets, "subscribed to Polymarket CLOB channels");

    Ok(ws)
}

async fn read_ws_message(
    ws: &mut WsStream,
) -> Result<Option<ClobWsMessage>, Box<dyn std::error::Error + Send + Sync>> {
    use futures_util::StreamExt;

    match ws.next().await {
        Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) => {
            match serde_json::from_str::<ClobWsMessage>(text.as_ref()) {
                Ok(msg) => Ok(Some(msg)),
                Err(_) => {
                    // Non-price messages (heartbeat, subscription confirmations, etc.)
                    Ok(None)
                }
            }
        }
        Some(Ok(tokio_tungstenite::tungstenite::Message::Ping(_))) => Ok(None),
        Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) => Ok(None),
        Some(Ok(_)) => Ok(None),
        Some(Err(e)) => Err(Box::new(e)),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_check_price_move_first_observation() {
        let mut prices = HashMap::new();
        let msg = ClobWsMessage {
            event_type: "price".into(),
            market: "0x1234".into(),
            price: Some(0.65),
            asset_id: Some("asset1".into()),
            timestamp: None,
        };

        // First observation: no event produced, price stored
        assert!(check_price_move(&msg, &mut prices, 5.0).is_none());
        assert_eq!(prices["asset1"], 0.65);
    }

    #[test]
    fn test_check_price_move_below_threshold() {
        let mut prices = HashMap::new();
        prices.insert("asset1".to_string(), 0.65);

        let msg = ClobWsMessage {
            event_type: "price".into(),
            market: "0x1234".into(),
            price: Some(0.66), // ~1.5% move
            asset_id: Some("asset1".into()),
            timestamp: None,
        };

        assert!(check_price_move(&msg, &mut prices, 5.0).is_none());
    }

    #[test]
    fn test_check_price_move_above_threshold() {
        let mut prices = HashMap::new();
        prices.insert("asset1".to_string(), 0.50);

        let msg = ClobWsMessage {
            event_type: "price".into(),
            market: "0x1234".into(),
            price: Some(0.60), // 20% move
            asset_id: Some("asset1".into()),
            timestamp: Some("2025-01-01T00:00:00Z".into()),
        };

        let event = check_price_move(&msg, &mut prices, 5.0).unwrap();
        assert_eq!(event.event, "price_move");
        assert_eq!(event.target, "strategy:prediction");
        assert_eq!(event.data.old_price, 0.50);
        assert_eq!(event.data.new_price, 0.60);
        assert!((event.data.change_pct - 20.0).abs() < 0.01);
    }

    #[test]
    fn test_check_price_move_no_price() {
        let mut prices = HashMap::new();
        let msg = ClobWsMessage {
            event_type: "heartbeat".into(),
            market: "0x1234".into(),
            price: None,
            asset_id: None,
            timestamp: None,
        };

        assert!(check_price_move(&msg, &mut prices, 5.0).is_none());
    }
}
