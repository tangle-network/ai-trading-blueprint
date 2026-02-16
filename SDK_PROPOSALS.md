# Blueprint SDK Improvement Proposals

Concrete proposals based on building a production multi-vault AI trading system with the Tangle Blueprint SDK.

---

## 1. `ScheduledService` Trait

**Problem:** Every trading loop, oracle poller, or rebalancer re-implements the same pattern inside `BackgroundService::start()`:

```rust
tokio::spawn(async move {
    let mut interval = tokio::time::interval(Duration::from_secs(60));
    loop {
        interval.tick().await;
        // actual work
    }
});
```

**Proposal:** A `ScheduledService` trait with built-in interval or cron scheduling:

```rust
trait ScheduledService: Send + Sync {
    fn schedule(&self) -> Schedule; // Interval(Duration) | Cron(String)
    async fn tick(&self) -> Result<(), RunnerError>;
    async fn on_error(&self, err: RunnerError) -> ErrorAction; // Retry | Skip | Stop
}
```

The runner manages the timer, error backoff, and shutdown. Users only implement the per-tick logic.

---

## 2. Shared State Injection

**Problem:** Every blueprint re-invents instance state management with the same boilerplate:

```rust
static INSTANCE: Lazy<RwLock<Option<TradingInstance>>> = Lazy::new(|| RwLock::new(None));

pub fn get_instance() -> Option<TradingInstance> { ... }
pub fn set_instance(inst: TradingInstance) { ... }
```

This pattern is repeated 5 times across 5 blueprint libs. Background services need a separate `TradingStateReader` trait just to access it.

**Proposal:** An SDK-provided `State<T>` extractor (like axum's) that works across jobs AND background services:

```rust
#[derive(Default)]
struct MyState { trading_active: bool, vault_address: String }

// In job handler — injected automatically
async fn start_trading(state: State<MyState>, args: TangleArg<...>) {
    state.write().trading_active = true;
}

// In background service — same state
struct TradingLoop;
impl ScheduledService for TradingLoop {
    async fn tick(&self, state: State<MyState>) {
        if state.read().trading_active { /* ... */ }
    }
}

// Registration
BlueprintRunner::builder(config, env)
    .state(MyState::default())
    .router(router())
    .background_service(TradingLoop)
```

The `local-store` feature already exists — this would build on top of it with type-safe accessors.

---

## 3. `ChainContext` Extractor

**Problem:** Every `provision` and `configure` job parses RPC URLs and private keys from environment or arguments, then constructs alloy providers manually:

```rust
let rpc_url = std::env::var("RPC_URL")?;
let private_key = std::env::var("OPERATOR_PRIVATE_KEY")?;
let signer: PrivateKeySigner = private_key.parse()?;
let wallet = EthereumWallet::from(signer);
let provider = ProviderBuilder::new().wallet(wallet).connect_http(url);
```

This is repeated in every blueprint and the trading-agent.

**Proposal:** A `ChainContext` extractor that provides a pre-configured provider + signer from `BlueprintEnvironment`:

```rust
async fn provision(
    chain: ChainContext,          // pre-configured provider + signer
    caller: Caller,
    args: TangleArg<ProvisionRequest>,
) -> Result<TangleResult<...>, String> {
    let factory = IVaultFactory::new(factory_addr, &chain.provider);
    let vault = factory.createVault(...).send().await?;
}
```

The `ChainContext` would read from `BlueprintEnvironment` fields that are already available (keystore, RPC settings).

---

## 4. Job-to-BackgroundService Communication

**Problem:** Jobs need to signal background services (e.g., `start_trading` job activates the trading loop). Currently this requires shared static state with `Lazy<RwLock<Option<T>>>` and a separate `TradingStateReader` trait. The pattern is fragile and not discoverable.

**Proposal:** An SDK-provided event bus or typed channel:

```rust
// Define events
#[derive(Event)]
enum TradingEvent {
    Start { config: TradingConfig },
    Stop,
    UpdateStrategy { new_config: Value },
}

// In job handler — send events
async fn start_trading(bus: EventBus<TradingEvent>, ...) {
    bus.send(TradingEvent::Start { config }).await;
}

// In background service — receive events
impl BackgroundService for TradingLoop {
    async fn start(&self, bus: EventBus<TradingEvent>) -> ... {
        while let Some(event) = bus.recv().await {
            match event {
                TradingEvent::Start { config } => self.activate(config),
                TradingEvent::Stop => self.deactivate(),
            }
        }
    }
}
```

This is cleaner than shared mutable statics and makes the communication pattern explicit and testable.

---

## 5. `BackgroundService` Lifecycle Hooks

**Problem:** The current `BackgroundService` trait has a single `start()` method that returns a oneshot channel. There's no way to:
- Log when a service successfully binds/starts
- Clean up resources on shutdown
- Report health status to an external monitoring system
- Distinguish between "service exited normally" vs "service crashed"

**Proposal:** Lifecycle hooks:

```rust
trait BackgroundService: Send + Sync {
    async fn start(&self) -> Result<Receiver<Result<(), RunnerError>>, RunnerError>;

    /// Called after start() succeeds and the service is running.
    async fn on_ready(&self) {}

    /// Called when the runner is shutting down. Implement graceful cleanup here.
    async fn on_shutdown(&self) {}

    /// Called when the service's oneshot reports an error.
    async fn on_error(&self, err: &RunnerError) -> ErrorAction {
        ErrorAction::Propagate
    }

    /// Health check polled by the runner. Return Err to trigger restart.
    async fn health_check(&self) -> Result<(), RunnerError> { Ok(()) }
}
```

This enables observability patterns (metrics on service lifecycle), graceful resource cleanup (close DB connections, flush buffers), and automatic restart policies for critical services.
