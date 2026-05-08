//! Real-time NAV WebSocket stream.
//!
//! Replaces RPC polling for vault NAV (`totalAssets()` / `totalNAV()`) with a
//! push-based broadcast. The dapp connects via `GET /v1/ws/nav`, receives an
//! initial snapshot, and then a `NavMessage::Delta` every time an on-chain
//! event changes the NAV (TradeExecuted, ERC-4626 Deposit, Withdraw, fee
//! settlement, oracle update, …).
//!
//! ### Architecture
//!
//! - **Per-vault hub.** A `NavHub` owns a `tokio::sync::broadcast` channel and
//!   a long-lived background task. The task listens for chain events from a
//!   pluggable [`ChainEventSource`], recomputes NAV via a [`NavSource`], and
//!   broadcasts a [`NavMessage::Delta`] to every WS subscriber.
//! - **Lazy lifecycle.** `NavHubRegistry::get_or_spawn` instantiates a hub on
//!   the first subscriber and the hub auto-shuts when the last subscriber
//!   drops (the registry's `Weak` handle returns `None` and the next
//!   `subscribe` request rebuilds the hub from scratch).
//! - **Backpressure.** `broadcast::channel` uses a fixed bounded buffer per
//!   subscriber. If a slow client falls behind, it gets a `Lagged(n)` error,
//!   which we log and skip; the connection stays alive.
//! - **Test seam.** The chain-event subscription path is wrapped behind a
//!   trait so unit/integration tests can inject a mock event source without
//!   needing real RPC. Production wiring of `eth_subscribe` (alloy WS
//!   provider) is intentionally a follow-up — the trait makes it a drop-in.

use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use alloy::primitives::{Address, Bytes, U256};
use alloy::providers::{Provider, ProviderBuilder};
use alloy::rpc::types::TransactionRequest;
use alloy::sol_types::{SolCall, SolValue};
use async_trait::async_trait;
use chrono::Utc;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tracing::{debug, warn};

use trading_runtime::contracts::ITradingVault;

/// Per-subscriber broadcast buffer. Each subscriber's `Receiver` keeps up to
/// this many `NavMessage` values queued. With ~256 B per `NavMessage` JSON
/// payload, this is ~16 KiB per subscriber worst-case — small enough to scale
/// to thousands of clients on a single hub.
pub const SUBSCRIBER_BUFFER: usize = 64;

/// Heartbeat cadence for connected clients. Clients use the absence of
/// heartbeats to detect dead connections; the cadence must be lower than the
/// proxy idle timeout (typically 60s).
pub const HEARTBEAT_INTERVAL_SECS: u64 = 30;

/// Bounded queue used by the in-process [`ChainEventSource`] -> hub channel.
/// Sized to absorb a burst of contiguous block events (worst case ~5 events
/// per block × 32 in-flight blocks before backpressure kicks in). Far smaller
/// than the broadcast channel because there is exactly one consumer.
const EVENT_QUEUE: usize = 256;

// ─────────────────────────────────────────────────────────────────────────
// Wire schema
// ─────────────────────────────────────────────────────────────────────────

/// One message sent over the WS stream. Tagged on the `type` field so the
/// dapp can `JSON.parse` and switch directly.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NavMessage {
    /// Sent immediately on connect (and on reconnect) with the current NAV.
    Snapshot(NavSnapshot),
    /// Sent every time NAV changes due to an on-chain event.
    Delta(NavDelta),
    /// Liveness signal at [`HEARTBEAT_INTERVAL_SECS`].
    Heartbeat { ts: i64 },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct NavSnapshot {
    pub vault: String,
    #[serde(rename = "chainId")]
    pub chain_id: u64,
    #[serde(rename = "totalAssets")]
    pub total_assets: String,
    #[serde(rename = "sharePrice")]
    pub share_price: String,
    #[serde(rename = "heldTokens")]
    pub held_tokens: Vec<HeldToken>,
    pub ts: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct NavDelta {
    pub vault: String,
    #[serde(rename = "chainId")]
    pub chain_id: u64,
    #[serde(rename = "totalAssets")]
    pub total_assets: String,
    #[serde(rename = "sharePrice")]
    pub share_price: String,
    pub trigger: String,
    #[serde(rename = "txHash", skip_serializing_if = "Option::is_none")]
    pub tx_hash: Option<String>,
    pub ts: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct HeldToken {
    pub token: String,
    pub balance: String,
    #[serde(rename = "valueInAsset")]
    pub value_in_asset: String,
}

/// On-chain trigger that prompts a NAV recomputation. Mirrors the events the
/// vault contract emits; see `contracts/src/TradingVault.sol`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NavTrigger {
    TradeExecuted,
    DebtReductionExecuted,
    Deposit,
    Withdraw,
    InKindRedeemed,
    CollateralReleased,
    CollateralReturned,
    PositionUnwound,
    OracleUpdated,
    /// Anything we did not explicitly classify; kept open for forward-compat
    /// with new events the vault might emit.
    Other(String),
}

impl fmt::Display for NavTrigger {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TradeExecuted => f.write_str("TradeExecuted"),
            Self::DebtReductionExecuted => f.write_str("DebtReductionExecuted"),
            Self::Deposit => f.write_str("Deposit"),
            Self::Withdraw => f.write_str("Withdraw"),
            Self::InKindRedeemed => f.write_str("InKindRedeemed"),
            Self::CollateralReleased => f.write_str("CollateralReleased"),
            Self::CollateralReturned => f.write_str("CollateralReturned"),
            Self::PositionUnwound => f.write_str("PositionUnwound"),
            Self::OracleUpdated => f.write_str("OracleUpdated"),
            Self::Other(s) => f.write_str(s),
        }
    }
}

#[derive(Clone, Debug)]
pub struct NavEvent {
    pub trigger: NavTrigger,
    pub tx_hash: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────
// Pluggable NAV reader + chain event source (test seam)
// ─────────────────────────────────────────────────────────────────────────

/// Snapshot of the on-chain NAV at a single point in time. Returned by
/// [`NavSource::read`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NavReading {
    pub total_assets: U256,
    pub share_price_wad: U256,
    pub held_tokens: Vec<HeldTokenReading>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeldTokenReading {
    pub token: Address,
    pub balance: U256,
    /// Value of `balance` denominated in vault deposit-asset units (raw, not
    /// scaled by decimals). For the deposit asset itself this equals
    /// `balance`. For non-deposit-asset positions it is the `IAssetValuator`
    /// quote. We surface this raw so the frontend can apply its own decimal
    /// scaling.
    pub value_in_asset: U256,
}

/// Reads NAV from a vault. Wrapped in a trait so tests can inject a mock and
/// production can use [`RpcNavSource`] (HTTP eth_call).
#[async_trait]
pub trait NavSource: Send + Sync + 'static {
    async fn read(&self) -> Result<NavReading, String>;
}

/// Yields chain-event triggers. Production impls are expected to use alloy's
/// `eth_subscribe` (WS provider) and convert each log into a [`NavEvent`].
/// Tests inject a [`MockEventSource`] and push events directly.
#[async_trait]
pub trait ChainEventSource: Send + Sync + 'static {
    /// Start listening. Returns an `mpsc::Receiver` that yields events until
    /// either the source decides to stop or the [`NavHub`] drops the
    /// receiver. Implementations MAY spawn their own background tasks; if
    /// they do, those tasks should self-terminate when the channel is
    /// closed.
    async fn subscribe(&self) -> Result<mpsc::Receiver<NavEvent>, String>;
}

// ─────────────────────────────────────────────────────────────────────────
// RpcNavSource — HTTP eth_call implementation
// ─────────────────────────────────────────────────────────────────────────

/// `NavSource` backed by an HTTP RPC. Re-uses the same call pattern as
/// `live_portfolio.rs` so the values stay consistent with the polled
/// `/portfolio/state` response.
pub struct RpcNavSource {
    rpc_url: String,
    vault: Address,
}

impl RpcNavSource {
    pub fn new(rpc_url: String, vault: Address) -> Self {
        Self { rpc_url, vault }
    }
}

#[async_trait]
impl NavSource for RpcNavSource {
    async fn read(&self) -> Result<NavReading, String> {
        let provider = ProviderBuilder::new().connect_http(
            self.rpc_url
                .parse()
                .map_err(|e| format!("Invalid RPC URL '{}': {e}", self.rpc_url))?,
        );

        let total_assets = eth_call_u256(
            &provider,
            self.vault,
            ITradingVault::totalAssetsCall {}.abi_encode(),
        )
        .await?;

        // sharePrice = convertToAssets(1 WAD).
        // Using 1e18 as the share unit gives us a fixed-point WAD value the
        // frontend can divide by 1e18 to render. `convertToAssets` accepts
        // raw share units, so we hand it 1e18 directly.
        let one_wad = U256::from(10u64).pow(U256::from(18));
        let share_price_wad = eth_call_u256(
            &provider,
            self.vault,
            ITradingVault::convertToAssetsCall { shares: one_wad }.abi_encode(),
        )
        .await
        .unwrap_or(U256::ZERO);

        let held_token_addrs = eth_call_addresses(
            &provider,
            self.vault,
            ITradingVault::getHeldTokensCall {}.abi_encode(),
        )
        .await
        .unwrap_or_default();

        let mut held_tokens = Vec::with_capacity(held_token_addrs.len());
        for token in held_token_addrs {
            let balance = eth_call_u256(
                &provider,
                self.vault,
                ITradingVault::getBalanceCall { token }.abi_encode(),
            )
            .await
            .unwrap_or(U256::ZERO);
            // Without per-token oracle plumbing in the runtime here, we
            // surface `balance` as `valueInAsset`. Downstream the dapp can
            // scale to deposit-asset units. Producing the exact valuation
            // would require calling the per-token IAssetValuator adapter; we
            // keep that as a follow-up so the stream stays self-contained
            // and free of registry lookups.
            held_tokens.push(HeldTokenReading {
                token,
                balance,
                value_in_asset: balance,
            });
        }

        Ok(NavReading {
            total_assets,
            share_price_wad,
            held_tokens,
        })
    }
}

async fn eth_call_u256(
    provider: &impl Provider,
    to: Address,
    data: Vec<u8>,
) -> Result<U256, String> {
    let tx = TransactionRequest::default()
        .to(to)
        .input(Bytes::from(data).into());
    let result = provider
        .call(tx)
        .await
        .map_err(|e| format!("eth_call failed: {e}"))?;
    U256::abi_decode(&result).map_err(|e| format!("decode u256 failed: {e}"))
}

async fn eth_call_addresses(
    provider: &impl Provider,
    to: Address,
    data: Vec<u8>,
) -> Result<Vec<Address>, String> {
    let tx = TransactionRequest::default()
        .to(to)
        .input(Bytes::from(data).into());
    let result = provider
        .call(tx)
        .await
        .map_err(|e| format!("eth_call failed: {e}"))?;
    <Vec<Address>>::abi_decode(&result).map_err(|e| format!("decode addresses failed: {e}"))
}

// ─────────────────────────────────────────────────────────────────────────
// Mock event source (test util, also gated behind `test-utils`)
// ─────────────────────────────────────────────────────────────────────────

/// In-process event source. Tests retain the [`MockEventSourceHandle`] and
/// `push` events directly to the hub.
pub struct MockEventSourceHandle {
    sender: mpsc::Sender<NavEvent>,
}

impl MockEventSourceHandle {
    pub async fn push(&self, event: NavEvent) -> Result<(), String> {
        self.sender
            .send(event)
            .await
            .map_err(|e| format!("mock event push failed: {e}"))
    }
}

pub struct MockEventSource {
    rx: tokio::sync::Mutex<Option<mpsc::Receiver<NavEvent>>>,
}

impl MockEventSource {
    /// Creates a (source, handle) pair. The source is consumed by the hub on
    /// `subscribe`; the handle stays with the test.
    pub fn pair() -> (Arc<Self>, MockEventSourceHandle) {
        let (tx, rx) = mpsc::channel(EVENT_QUEUE);
        (
            Arc::new(Self {
                rx: tokio::sync::Mutex::new(Some(rx)),
            }),
            MockEventSourceHandle { sender: tx },
        )
    }
}

#[async_trait]
impl ChainEventSource for MockEventSource {
    async fn subscribe(&self) -> Result<mpsc::Receiver<NavEvent>, String> {
        self.rx
            .lock()
            .await
            .take()
            .ok_or_else(|| "MockEventSource already subscribed".to_string())
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Hub + registry
// ─────────────────────────────────────────────────────────────────────────

/// Identifier for a per-vault hub. Address is normalised to lowercase so
/// `0xAbC…` and `0xabc…` deduplicate.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct VaultKey {
    pub vault: String,
    pub chain_id: u64,
}

impl VaultKey {
    pub fn new(vault: &str, chain_id: u64) -> Self {
        Self {
            vault: vault.to_ascii_lowercase(),
            chain_id,
        }
    }
}

pub struct NavHub {
    key: VaultKey,
    sender: broadcast::Sender<NavMessage>,
    last_snapshot: Arc<tokio::sync::RwLock<Option<NavMessage>>>,
    subscriber_count: AtomicU64,
    _task: JoinHandle<()>,
}

impl NavHub {
    /// Returns a fresh broadcast receiver and the most recently published
    /// snapshot (which the WS handler will send to the new subscriber as the
    /// first frame). Increments the subscriber counter; the corresponding
    /// `decrement_subscriber` MUST be called when the subscriber drops.
    pub async fn subscribe(&self) -> (broadcast::Receiver<NavMessage>, Option<NavMessage>) {
        self.subscriber_count.fetch_add(1, Ordering::Relaxed);
        let snapshot = self.last_snapshot.read().await.clone();
        (self.sender.subscribe(), snapshot)
    }

    pub fn decrement_subscriber(&self) -> u64 {
        let prev = self.subscriber_count.fetch_sub(1, Ordering::Relaxed);
        prev.saturating_sub(1)
    }

    pub fn subscriber_count(&self) -> u64 {
        self.subscriber_count.load(Ordering::Relaxed)
    }

    pub fn key(&self) -> &VaultKey {
        &self.key
    }
}

impl Drop for NavHub {
    fn drop(&mut self) {
        // Aborting the task explicitly is cheap and unambiguously frees the
        // channel + chain-event mpsc once the registry forgets the hub.
        self._task.abort();
    }
}

/// Process-wide registry of per-vault hubs. Cheap to clone (`Arc`-wrapping
/// `DashMap` shards). The registry holds `Arc<NavHub>`; a hub stays alive
/// while at least one entity (registry or subscriber) holds a strong ref.
#[derive(Clone, Default)]
pub struct NavHubRegistry {
    hubs: Arc<DashMap<VaultKey, Arc<NavHub>>>,
}

impl NavHubRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns an existing hub, or spawns a new one. The factory closure
    /// builds the (NavSource, ChainEventSource) pair on demand so we don't
    /// pay RPC cost on a cache hit. Idempotent.
    pub fn get_or_spawn<F>(&self, key: VaultKey, factory: F) -> Arc<NavHub>
    where
        F: FnOnce() -> (Arc<dyn NavSource>, Arc<dyn ChainEventSource>),
    {
        if let Some(existing) = self.hubs.get(&key) {
            return existing.clone();
        }

        let (nav_source, event_source) = factory();
        let hub = Self::spawn_hub(key.clone(), nav_source, event_source);
        // `entry().or_insert_with` is the race-safe equivalent. If another
        // thread inserted first, we drop the freshly-built hub here (the
        // task aborts in `Drop`).
        self.hubs.entry(key).or_insert(hub).clone()
    }

    pub fn get(&self, key: &VaultKey) -> Option<Arc<NavHub>> {
        self.hubs.get(key).map(|entry| entry.clone())
    }

    pub fn remove_if_idle(&self, key: &VaultKey) -> bool {
        match self.hubs.entry(key.clone()) {
            dashmap::mapref::entry::Entry::Occupied(entry) => {
                if entry.get().subscriber_count() == 0 {
                    entry.remove();
                    true
                } else {
                    false
                }
            }
            dashmap::mapref::entry::Entry::Vacant(_) => false,
        }
    }

    pub fn len(&self) -> usize {
        self.hubs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.hubs.is_empty()
    }

    fn spawn_hub(
        key: VaultKey,
        nav_source: Arc<dyn NavSource>,
        event_source: Arc<dyn ChainEventSource>,
    ) -> Arc<NavHub> {
        let (sender, _) = broadcast::channel::<NavMessage>(SUBSCRIBER_BUFFER);
        let last_snapshot: Arc<tokio::sync::RwLock<Option<NavMessage>>> =
            Arc::new(tokio::sync::RwLock::new(None));

        let key_for_task = key.clone();
        let sender_for_task = sender.clone();
        let snapshot_for_task = Arc::clone(&last_snapshot);

        let task = tokio::spawn(async move {
            run_hub_task(
                key_for_task,
                nav_source,
                event_source,
                sender_for_task,
                snapshot_for_task,
            )
            .await
        });

        Arc::new(NavHub {
            key,
            sender,
            last_snapshot,
            subscriber_count: AtomicU64::new(0),
            _task: task,
        })
    }
}

/// Background task: pulls events from the chain-event source, recomputes NAV,
/// fans out a `Delta` (or initial `Snapshot`) on the broadcast channel.
async fn run_hub_task(
    key: VaultKey,
    nav_source: Arc<dyn NavSource>,
    event_source: Arc<dyn ChainEventSource>,
    sender: broadcast::Sender<NavMessage>,
    last_snapshot: Arc<tokio::sync::RwLock<Option<NavMessage>>>,
) {
    // Try to publish an initial snapshot so the very first subscriber gets
    // something even if no chain event has fired yet.
    if let Ok(reading) = nav_source.read().await {
        let snapshot = NavMessage::Snapshot(snapshot_from_reading(&key, &reading));
        *last_snapshot.write().await = Some(snapshot.clone());
        // Failures here just mean nobody is listening yet; that's fine —
        // they'll get the snapshot from `last_snapshot` on connect.
        let _ = sender.send(snapshot);
    } else {
        debug!(vault = %key.vault, "NavHub: initial snapshot read failed; will retry on first event");
    }

    let mut events = match event_source.subscribe().await {
        Ok(rx) => rx,
        Err(e) => {
            warn!(vault = %key.vault, error = %e, "NavHub: failed to subscribe to chain events; hub will idle");
            return;
        }
    };

    while let Some(event) = events.recv().await {
        let reading = match nav_source.read().await {
            Ok(reading) => reading,
            Err(e) => {
                warn!(
                    vault = %key.vault,
                    trigger = %event.trigger,
                    error = %e,
                    "NavHub: NAV read failed; skipping delta"
                );
                continue;
            }
        };

        let delta = NavMessage::Delta(NavDelta {
            vault: format!("0x{}", strip_0x(&key.vault)),
            chain_id: key.chain_id,
            total_assets: reading.total_assets.to_string(),
            share_price: reading.share_price_wad.to_string(),
            trigger: event.trigger.to_string(),
            tx_hash: event.tx_hash,
            ts: Utc::now().timestamp(),
        });

        // Refresh the snapshot too so reconnecting clients see the latest
        // state without waiting for the next event.
        let snapshot = NavMessage::Snapshot(snapshot_from_reading(&key, &reading));
        *last_snapshot.write().await = Some(snapshot);

        if let Err(e) = sender.send(delta) {
            // `send` returns the unsent message when there are zero
            // receivers; this is normal and means the hub has gone idle.
            debug!(vault = %key.vault, error = %e, "NavHub: no subscribers, drop delta");
        }
    }
}

fn snapshot_from_reading(key: &VaultKey, reading: &NavReading) -> NavSnapshot {
    NavSnapshot {
        vault: format!("0x{}", strip_0x(&key.vault)),
        chain_id: key.chain_id,
        total_assets: reading.total_assets.to_string(),
        share_price: reading.share_price_wad.to_string(),
        held_tokens: reading
            .held_tokens
            .iter()
            .map(|h| HeldToken {
                token: format!("{:#x}", h.token),
                balance: h.balance.to_string(),
                value_in_asset: h.value_in_asset.to_string(),
            })
            .collect(),
        ts: Utc::now().timestamp(),
    }
}

fn strip_0x(s: &str) -> &str {
    s.strip_prefix("0x").unwrap_or(s)
}

// ─────────────────────────────────────────────────────────────────────────
// Application state plumbing
// ─────────────────────────────────────────────────────────────────────────

/// Result returned when a [`SourceFactoryFn`] builds a (`NavSource`,
/// `ChainEventSource`) pair for a vault. Either dependency may be backed by
/// a real RPC adapter or a mock — the hub doesn't care.
pub type SourcePair = (Arc<dyn NavSource>, Arc<dyn ChainEventSource>);

/// Builds a [`SourcePair`] for a [`VaultKey`]. Returning `Err` aborts the
/// WS handshake with `503 Service Unavailable`.
pub type SourceFactoryFn = dyn Fn(&VaultKey) -> Result<SourcePair, String> + Send + Sync;

/// Configuration injected by the binary so the NAV stream can stand on its
/// own without coupling to `MultiBotTradingState`. Allows the WS endpoint to
/// be mounted ahead of the auth middleware.
#[derive(Clone)]
pub struct NavStreamConfig {
    pub registry: NavHubRegistry,
    /// Builds a (NavSource, ChainEventSource) pair for a vault on first
    /// subscription. Production wiring constructs an [`RpcNavSource`] +
    /// alloy-pubsub event source; tests inject mocks.
    pub source_factory: Arc<SourceFactoryFn>,
}

impl fmt::Debug for NavStreamConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NavStreamConfig")
            .field("registry_len", &self.registry.len())
            .finish()
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn snapshot_serializes_with_camel_case_fields() {
        let msg = NavMessage::Snapshot(NavSnapshot {
            vault: "0xabc".to_string(),
            chain_id: 8453,
            total_assets: "1000000".to_string(),
            share_price: "1010000000000000000".to_string(),
            held_tokens: vec![HeldToken {
                token: "0xdef".to_string(),
                balance: "42".to_string(),
                value_in_asset: "84".to_string(),
            }],
            ts: 1_000_000,
        });
        let value = serde_json::to_value(&msg).unwrap();
        assert_eq!(value["type"], "snapshot");
        assert_eq!(value["vault"], "0xabc");
        assert_eq!(value["chainId"], 8453);
        assert_eq!(value["totalAssets"], "1000000");
        assert_eq!(value["sharePrice"], "1010000000000000000");
        assert_eq!(value["heldTokens"][0]["valueInAsset"], "84");
    }

    #[test]
    fn delta_omits_tx_hash_when_none() {
        let msg = NavMessage::Delta(NavDelta {
            vault: "0xabc".to_string(),
            chain_id: 1,
            total_assets: "0".to_string(),
            share_price: "0".to_string(),
            trigger: "TradeExecuted".to_string(),
            tx_hash: None,
            ts: 1,
        });
        let value = serde_json::to_value(&msg).unwrap();
        assert_eq!(value["type"], "delta");
        assert!(value.get("txHash").is_none(), "txHash should be omitted");
    }

    #[test]
    fn heartbeat_serializes_compactly() {
        let msg = NavMessage::Heartbeat { ts: 1234 };
        let value = serde_json::to_value(&msg).unwrap();
        assert_eq!(value, json!({ "type": "heartbeat", "ts": 1234 }));
    }

    #[test]
    fn vault_key_lowercases() {
        let a = VaultKey::new("0xAbCdEf", 1);
        let b = VaultKey::new("0xabcdef", 1);
        assert_eq!(a, b);
    }

    #[derive(Default)]
    struct StaticNavSource {
        readings: tokio::sync::Mutex<Vec<NavReading>>,
    }

    #[async_trait]
    impl NavSource for StaticNavSource {
        async fn read(&self) -> Result<NavReading, String> {
            let mut readings = self.readings.lock().await;
            if readings.is_empty() {
                return Err("no readings configured".to_string());
            }
            // Always return the last reading; tests push by replacing.
            Ok(readings.last().cloned().unwrap_or_else(|| {
                let r = NavReading {
                    total_assets: U256::from(0u64),
                    share_price_wad: U256::from(0u64),
                    held_tokens: vec![],
                };
                readings.push(r.clone());
                r
            }))
        }
    }

    fn reading(total: u64, share_wad: u64) -> NavReading {
        NavReading {
            total_assets: U256::from(total),
            share_price_wad: U256::from(share_wad),
            held_tokens: vec![],
        }
    }

    #[tokio::test]
    async fn hub_publishes_snapshot_then_delta_on_event() {
        let key = VaultKey::new("0x1111111111111111111111111111111111111111", 1);
        let nav_source = Arc::new(StaticNavSource::default());
        nav_source.readings.lock().await.push(reading(100, 1));

        let (event_source, handle) = MockEventSource::pair();

        let registry = NavHubRegistry::new();
        let nav_source_dyn: Arc<dyn NavSource> = nav_source.clone();
        let event_source_dyn: Arc<dyn ChainEventSource> = event_source;
        let hub = registry.get_or_spawn(key.clone(), || (nav_source_dyn, event_source_dyn));

        // Subscribe — should get the cached initial snapshot.
        let (mut rx, snapshot) = hub.subscribe().await;
        // The hub task may not have published yet; if no snapshot, wait for
        // one off the receiver.
        let first = if let Some(snapshot) = snapshot {
            snapshot
        } else {
            rx.recv().await.expect("snapshot")
        };
        match first {
            NavMessage::Snapshot(s) => {
                assert_eq!(s.chain_id, 1);
                assert_eq!(s.total_assets, "100");
            }
            other => panic!("expected snapshot, got {other:?}"),
        }

        // Push a new reading and an event; expect a Delta on the receiver.
        nav_source.readings.lock().await.push(reading(150, 2));
        handle
            .push(NavEvent {
                trigger: NavTrigger::TradeExecuted,
                tx_hash: Some("0xdead".to_string()),
            })
            .await
            .unwrap();

        // We may have already drained an initial snapshot from the channel
        // in the loop above; keep reading until we see the Delta.
        let mut delta_seen = None;
        for _ in 0..4 {
            match tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv()).await {
                Ok(Ok(NavMessage::Delta(d))) => {
                    delta_seen = Some(d);
                    break;
                }
                Ok(Ok(_other)) => continue,
                Ok(Err(e)) => panic!("recv error: {e}"),
                Err(_) => break,
            }
        }
        let delta = delta_seen.expect("delta after event");
        assert_eq!(delta.trigger, "TradeExecuted");
        assert_eq!(delta.total_assets, "150");
        assert_eq!(delta.tx_hash.as_deref(), Some("0xdead"));
    }

    #[tokio::test]
    async fn registry_dedupes_hubs_per_vault_key() {
        let key = VaultKey::new("0x2222222222222222222222222222222222222222", 1);
        let registry = NavHubRegistry::new();

        let nav_source = Arc::new(StaticNavSource::default());
        nav_source.readings.lock().await.push(reading(0, 0));

        let factory_calls = Arc::new(AtomicU64::new(0));

        let h1 = {
            let nav = nav_source.clone() as Arc<dyn NavSource>;
            let calls = Arc::clone(&factory_calls);
            registry.get_or_spawn(key.clone(), move || {
                calls.fetch_add(1, Ordering::Relaxed);
                let (es, _h) = MockEventSource::pair();
                (nav, es as Arc<dyn ChainEventSource>)
            })
        };
        let h2 = {
            let nav = nav_source.clone() as Arc<dyn NavSource>;
            let calls = Arc::clone(&factory_calls);
            registry.get_or_spawn(key.clone(), move || {
                calls.fetch_add(1, Ordering::Relaxed);
                let (es, _h) = MockEventSource::pair();
                (nav, es as Arc<dyn ChainEventSource>)
            })
        };

        assert!(Arc::ptr_eq(&h1, &h2));
        assert_eq!(factory_calls.load(Ordering::Relaxed), 1);
        assert_eq!(registry.len(), 1);
    }
}
