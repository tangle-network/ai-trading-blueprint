//! End-to-end integration test for the NAV WebSocket stream.
//!
//! Spins up an in-process axum server, connects with `tokio_tungstenite`,
//! pushes a synthetic chain event onto a mock event source, and asserts that
//! the client receives the snapshot followed by a delta. No real RPC.

use std::sync::Arc;
use std::time::Duration;

use alloy::primitives::U256;
use async_trait::async_trait;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::protocol::Message;

use trading_http_api::nav_stream::{
    ChainEventSource, MockEventSource, NavEvent, NavHubRegistry, NavReading, NavSource,
    NavStreamConfig, NavTrigger, SourceFactoryFn, VaultKey,
};
use trading_http_api::routes::nav_ws;

const TEST_VAULT: &str = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
const TEST_CHAIN_ID: u64 = 8453;

#[derive(Clone)]
struct StubNavSource {
    state: Arc<tokio::sync::Mutex<NavReading>>,
}

impl StubNavSource {
    fn new(initial: NavReading) -> Self {
        Self {
            state: Arc::new(tokio::sync::Mutex::new(initial)),
        }
    }
}

#[async_trait]
impl NavSource for StubNavSource {
    async fn read(&self) -> Result<NavReading, String> {
        Ok(self.state.lock().await.clone())
    }
}

async fn bind_server(router: Router) -> std::net::SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    addr
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ws_client_receives_snapshot_then_delta() {
    // Arrange: stub NAV source + mock event source, both injected via
    // the registry's source factory.
    let initial = NavReading {
        total_assets: U256::from(1_000_000u64),
        share_price_wad: U256::from(10u64).pow(U256::from(18u8)),
        held_tokens: vec![],
    };
    let nav_source = Arc::new(StubNavSource::new(initial));
    let (event_source, event_handle) = MockEventSource::pair();

    let nav_for_factory = nav_source.clone();
    let event_holder = Arc::new(std::sync::Mutex::new(Some(event_source)));

    let registry = NavHubRegistry::new();
    let factory_event_holder = event_holder.clone();
    let factory: Arc<SourceFactoryFn> = Arc::new(move |_key: &VaultKey| {
        let nav: Arc<dyn NavSource> = nav_for_factory.clone();
        // Take the single-use event source out of the holder. After this
        // first call subsequent factory invocations would fail; the test
        // only exercises one vault so it doesn't matter.
        let event = factory_event_holder
            .lock()
            .map_err(|e| format!("event holder poisoned: {e}"))?
            .take()
            .ok_or_else(|| "event source already consumed".to_string())?;
        Ok((nav, event as Arc<dyn ChainEventSource>))
    });

    let config = NavStreamConfig {
        registry: registry.clone(),
        source_factory: factory,
    };

    let router = nav_ws::router(config);
    let addr = bind_server(router).await;

    // Act: connect a WS client.
    let url = format!(
        "ws://{}/v1/ws/nav?vault={}&chainId={}",
        addr, TEST_VAULT, TEST_CHAIN_ID
    );
    let (mut socket, _resp) = tokio_tungstenite::connect_async(&url)
        .await
        .expect("ws connect");

    // The first frame should be the snapshot.
    let snapshot_frame = timeout(Duration::from_secs(5), socket.next())
        .await
        .expect("snapshot timeout")
        .expect("snapshot exists")
        .expect("snapshot ok");
    let snapshot_text = match snapshot_frame {
        Message::Text(t) => t.to_string(),
        other => panic!("expected text frame, got {other:?}"),
    };
    let snapshot: Value = serde_json::from_str(&snapshot_text).expect("snapshot json");
    assert_eq!(snapshot["type"], "snapshot");
    assert_eq!(snapshot["chainId"], TEST_CHAIN_ID);
    assert_eq!(snapshot["totalAssets"], "1000000");

    // Push an event with a new NAV; expect a delta.
    {
        let mut state = nav_source.state.lock().await;
        state.total_assets = U256::from(1_500_000u64);
    }
    event_handle
        .push(NavEvent {
            trigger: NavTrigger::TradeExecuted,
            tx_hash: Some("0xfeedface".to_string()),
        })
        .await
        .expect("push event");

    // Drain frames until we see a delta. Heartbeats / extra snapshots are
    // tolerated.
    let mut delta_seen = None;
    for _ in 0..6 {
        let frame = timeout(Duration::from_secs(5), socket.next())
            .await
            .expect("frame timeout")
            .expect("frame")
            .expect("frame ok");
        if let Message::Text(text) = frame {
            let value: Value = serde_json::from_str(&text).expect("frame json");
            if value["type"] == "delta" {
                delta_seen = Some(value);
                break;
            }
        }
    }
    let delta = delta_seen.expect("delta after event");
    assert_eq!(delta["trigger"], "TradeExecuted");
    assert_eq!(delta["totalAssets"], "1500000");
    assert_eq!(delta["txHash"], "0xfeedface");
    assert_eq!(delta["chainId"], TEST_CHAIN_ID);

    // Clean shutdown.
    let _ = socket.send(Message::Close(None)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ws_rejects_invalid_vault_address() {
    let registry = NavHubRegistry::new();
    let factory: Arc<SourceFactoryFn> = Arc::new(|_| Err("should not be invoked".to_string()));
    let config = NavStreamConfig {
        registry,
        source_factory: factory,
    };
    let router = nav_ws::router(config);
    let addr = bind_server(router).await;

    let url = format!("ws://{}/v1/ws/nav?vault=0xnotanaddress&chainId=1", addr);
    let result = tokio_tungstenite::connect_async(&url).await;
    assert!(
        result.is_err(),
        "expected handshake failure for invalid vault, got {result:?}"
    );
}

// Compile guard for [`mpsc`] usage so the import isn't reported as dead in
// test-only builds; tokio-tungstenite uses futures-util's split.
#[allow(dead_code)]
fn _imports_used() {
    let _: Option<mpsc::Sender<NavEvent>> = None;
}
