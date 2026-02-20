pub mod fixtures;

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
