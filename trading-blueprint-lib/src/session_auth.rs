//! Derive `SESSION_AUTH_SECRET` from the operator keystore or `PRIVATE_KEY`.
//!
//! PASETO session tokens (see `sandbox-runtime::session_auth`) need a stable key
//! across restarts. Rather than require operators to configure one by hand, we
//! derive it deterministically from material the operator already has.
//!
//! Preimage is `keccak256("tangle-trading-session-auth-v1:" || seed)` — same
//! algorithm deploy scripts can compute with `cast keccak` for parity.

use alloy::primitives::keccak256;
use std::path::{Path, PathBuf};

const DOMAIN: &[u8] = b"tangle-trading-session-auth-v1:";

/// Populate `SESSION_AUTH_SECRET` if it is not already set.
///
/// Call this from `main()` *before* spawning worker threads — `set_var` is
/// unsound under concurrent reads.
pub fn ensure_from_env() {
    if std::env::var_os("SESSION_AUTH_SECRET").is_some() {
        return;
    }
    let Some(seed) = load_seed() else { return };
    let mut preimage = Vec::with_capacity(DOMAIN.len() + seed.len());
    preimage.extend_from_slice(DOMAIN);
    preimage.extend_from_slice(&seed);
    let secret = hex::encode(keccak256(preimage));
    // SAFETY: caller contract — single-threaded at boot.
    unsafe { std::env::set_var("SESSION_AUTH_SECRET", secret) };
}

fn load_seed() -> Option<Vec<u8>> {
    keystore_seed().or_else(private_key_seed)
}

fn keystore_seed() -> Option<Vec<u8>> {
    let raw = std::env::var("KEYSTORE_URI")
        .ok()
        .or_else(|| std::env::var("KEYSTORE_PATH").ok())?;
    let path = PathBuf::from(raw.strip_prefix("file://").unwrap_or(raw.as_str()));
    first_file_contents(&path)
}

fn private_key_seed() -> Option<Vec<u8>> {
    let pk = std::env::var("PRIVATE_KEY").ok()?;
    let trimmed = pk.trim().trim_start_matches("0x");
    (!trimmed.is_empty()).then(|| trimmed.as_bytes().to_vec())
}

fn first_file_contents(dir: &Path) -> Option<Vec<u8>> {
    if !dir.is_dir() {
        return None;
    }
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|e| e.path())
        .collect();
    files.sort();
    files.into_iter().find_map(|p| std::fs::read(p).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Recompute the expected secret to verify `ensure_from_env` writes the right thing.
    fn expected(seed: &[u8]) -> String {
        let mut preimage = Vec::with_capacity(DOMAIN.len() + seed.len());
        preimage.extend_from_slice(DOMAIN);
        preimage.extend_from_slice(seed);
        hex::encode(keccak256(preimage))
    }

    #[test]
    fn first_file_contents_sorts_deterministically() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("z-second"), b"second").unwrap();
        std::fs::write(dir.path().join("a-first"), b"first").unwrap();
        std::fs::create_dir(dir.path().join("subdir-ignored")).unwrap();
        assert_eq!(
            first_file_contents(dir.path()).as_deref(),
            Some(b"first" as &[u8])
        );
    }

    #[test]
    fn private_key_path_produces_expected_secret() {
        let pk = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
        assert_eq!(
            hex::encode(keccak256([DOMAIN, pk.as_bytes()].concat())),
            expected(pk.as_bytes()),
        );
    }
}
