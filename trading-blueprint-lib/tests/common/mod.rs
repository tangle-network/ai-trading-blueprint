pub mod contract_deployer;
pub mod fixtures;
pub mod validators;

use anyhow::Result;
use blueprint_anvil_testing_utils::{
    BlueprintHarness, MultiHarness, missing_tnt_core_artifacts,
};
use once_cell::sync::Lazy;
use std::sync::Once;
use std::time::Duration;
use tokio::sync::Mutex as AsyncMutex;

pub const ANVIL_TEST_TIMEOUT: Duration = Duration::from_secs(600);
pub const JOB_RESULT_TIMEOUT: Duration = Duration::from_secs(180);

pub static HARNESS_LOCK: Lazy<AsyncMutex<()>> = Lazy::new(|| AsyncMutex::new(()));
static LOG_INIT: Once = Once::new();

/// Shared temp directory for the entire test binary.
///
/// `PersistentStore` uses `OnceCell`, so the state directory must be set
/// before the first store access and must remain valid for the process
/// lifetime.  All tests share this directory and use unique keys to avoid
/// collisions.
static SHARED_STATE_DIR: Lazy<tempfile::TempDir> = Lazy::new(|| {
    let dir = tempfile::tempdir().expect("create temp state dir");
    // SAFETY: called once before any test accesses the stores.
    unsafe {
        std::env::set_var("BLUEPRINT_STATE_DIR", dir.path());
    }
    dir
});

pub fn setup_log() {
    LOG_INIT.call_once(|| {
        let _ = tracing_subscriber::fmt::try_init();
    });
}

/// Ensure the shared state directory is initialised.
///
/// Must be called at the start of every test that uses `PersistentStore`.
/// Returns a reference to the `TempDir` so the caller can see the path,
/// but the directory is **not** dropped when the test ends — it lives for
/// the whole process.
pub fn init_test_env() -> &'static tempfile::TempDir {
    // Accessing the Lazy forces initialisation exactly once.
    &SHARED_STATE_DIR
}

/// Set up environment for the sidecar runtime config.
///
/// Always forces `tangle-sidecar:local` — the local Docker image built for
/// testing. The `.env` file may have the remote image which doesn't exist
/// locally.
pub fn setup_sidecar_env() {
    unsafe {
        std::env::set_var("SIDECAR_IMAGE", "tangle-sidecar:local");
        std::env::set_var("SIDECAR_PULL_IMAGE", "false");
        std::env::set_var("SIDECAR_PUBLIC_HOST", "127.0.0.1");
        std::env::set_var("REQUEST_TIMEOUT_SECS", "60");
    }
}

/// Spawn a `BlueprintHarness` for the trading blueprint router.
///
/// Returns `None` if TNT core artifacts are missing (graceful skip).
pub async fn spawn_harness() -> Result<Option<BlueprintHarness>> {
    match BlueprintHarness::builder(trading_blueprint_lib::router())
        .poll_interval(Duration::from_millis(50))
        .spawn()
        .await
    {
        Ok(harness) => Ok(Some(harness)),
        Err(err) => {
            if missing_tnt_core_artifacts(&err) {
                eprintln!("Skipping test: TNT core artifacts not found: {err}");
                Ok(None)
            } else {
                Err(err)
            }
        }
    }
}

/// Spawn a [`MultiHarness`] with both the trading and validator blueprints.
///
/// - Service 0: trading blueprint (6 jobs: provision, configure, start, stop, status, deprovision)
/// - Service 1: validator blueprint (6 jobs: register, deregister, update_reputation, slash, update_config, liveness)
///
/// Returns `None` if TNT core artifacts are missing (graceful skip).
pub async fn spawn_multi_harness() -> Result<Option<MultiHarness>> {
    match MultiHarness::builder()
        .add_blueprint("trading", trading_blueprint_lib::router(), 0)
        .add_blueprint("validator", trading_validator_lib::router(), 1)
        .spawn()
        .await
    {
        Ok(harness) => Ok(Some(harness)),
        Err(err) => {
            if missing_tnt_core_artifacts(&err) {
                eprintln!("Skipping test: TNT core artifacts not found: {err}");
                Ok(None)
            } else {
                Err(err)
            }
        }
    }
}
