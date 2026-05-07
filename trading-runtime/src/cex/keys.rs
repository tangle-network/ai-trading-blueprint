//! Per-bot CEX / Solana key resolution.
//!
//! ## Why this exists
//!
//! Pre-hardening, every bot in a multi-tenant deployment shared the *same*
//! operator key — the global `OPERATOR_KEYPAIR: OnceLock<Keypair>` and
//! `Binance/CoinbaseConfig::from_env()` both read from this process's env
//! block. Compromise of any single bot's sandbox therefore drained every
//! tenant's funds, because all of them signed with the operator's key.
//!
//! [`CexKeyProvider`] routes key lookup through the resolved [`crate`]
//! `BotContext::bot_id`, so each bot can ship its own venue credentials
//! through the encrypted-secrets pipeline.
//!
//! ## Backwards compatibility
//!
//! [`EnvKeyProvider`] is the default and preserves the original
//! single-tenant env-var behaviour: every `binance_key`/`coinbase_key`/
//! `solana_keypair` call returns the same key regardless of `bot_id`.
//! Operators that haven't migrated to per-bot secrets keep working.
//!
//! [`SecretsBackedKeyProvider`] reads from a per-bot secrets directory
//! (one JSON file per bot, owner-readable only). This is the production
//! multi-tenant path. The store layout is intentionally simple — one
//! file per bot keyed by `bot_id` — so an operator can swap in any other
//! KMS-backed provider by implementing the trait.

#[cfg(any(test, feature = "test-utils"))]
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;
use solana_sdk::signature::Keypair;
use zeroize::Zeroizing;

use super::binance::BinanceConfig;
use super::coinbase::CoinbaseConfig;

/// Per-bot key resolution interface.
///
/// Implementations return `None` when the bot has not configured a key for
/// the requested venue — the route layer turns that into a 412 PRECONDITION
/// FAILED rather than a process-wide panic. This makes onboarding state
/// (bot exists but has not yet pushed Binance creds) a first-class case.
pub trait CexKeyProvider: Send + Sync {
    /// Return the Binance credentials configured for `bot_id`, if any.
    fn binance_key(&self, bot_id: &str) -> Option<BinanceConfig>;

    /// Return the Coinbase Advanced Trade credentials for `bot_id`, if any.
    fn coinbase_key(&self, bot_id: &str) -> Option<CoinbaseConfig>;

    /// Return the Solana operator keypair for `bot_id`, if any.
    ///
    /// Implementations MUST return a freshly-allocated [`Keypair`] (not a
    /// shared reference) so callers can hand it to signing primitives that
    /// take ownership.
    fn solana_keypair(&self, bot_id: &str) -> Option<Keypair>;
}

/// Adapter that returns `Arc<dyn CexKeyProvider>` for the default-null impl.
pub fn default_provider() -> Arc<dyn CexKeyProvider> {
    Arc::new(EnvKeyProvider)
}

// ── EnvKeyProvider ──────────────────────────────────────────────────────────

/// Single-tenant fallback that reads the legacy global env vars.
///
/// Returns the same credentials for every `bot_id`. This preserves the
/// original env-driven behaviour for dev/staging that haven't moved to
/// per-bot secrets.
///
/// Returning `Some` is best-effort: when the env vars are unset or
/// malformed the loaders return `None`, which the route layer handles as
/// 412 PRECONDITION FAILED.
#[derive(Default, Debug, Clone, Copy)]
pub struct EnvKeyProvider;

impl CexKeyProvider for EnvKeyProvider {
    fn binance_key(&self, _bot_id: &str) -> Option<BinanceConfig> {
        BinanceConfig::from_env().ok()
    }

    fn coinbase_key(&self, _bot_id: &str) -> Option<CoinbaseConfig> {
        CoinbaseConfig::from_env().ok()
    }

    fn solana_keypair(&self, _bot_id: &str) -> Option<Keypair> {
        crate::solana::keys::load_operator_keypair_from_env().ok()
    }
}

// ── SecretsBackedKeyProvider ────────────────────────────────────────────────

/// Multi-tenant key provider that reads `<root>/<bot_id>.json` for each bot.
///
/// The JSON file shape is the [`BotKeysFile`] struct below. Files are read
/// on every call (intentionally — secrets rotation is a "drop a new file
/// in" workflow). Callers that want hot-reload-aware caching can wrap this
/// in a `Mutex<HashMap<bot_id, BotKeysFile>>` of their own.
///
/// All on-heap intermediates that contain raw secret bytes are wiped via
/// [`Zeroizing`] before this function returns — see `trading-runtime`'s
/// Solana keypair loader for the same pattern.
#[derive(Debug, Clone)]
pub struct SecretsBackedKeyProvider {
    root: PathBuf,
}

impl SecretsBackedKeyProvider {
    /// Construct a provider that reads `<root>/<bot_id>.json`.
    ///
    /// Errors if `root` does not exist (we deliberately do not auto-create
    /// it; deployment tooling should provision the directory with the
    /// correct mode bits).
    pub fn new(root: impl Into<PathBuf>) -> std::io::Result<Self> {
        let root = root.into();
        if !root.exists() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("secrets root '{}' does not exist", root.display()),
            ));
        }
        Ok(Self { root })
    }

    fn read_bot_file(&self, bot_id: &str) -> Option<BotKeysFile> {
        let path = self.path_for(bot_id)?;
        // We deliberately do not log on parse failure: that would risk
        // leaking secret bytes via the error renderer in some setups.
        let raw = Zeroizing::new(std::fs::read(&path).ok()?);
        let parsed: BotKeysFile = serde_json::from_slice(&raw).ok()?;
        Some(parsed)
    }

    /// Resolve the per-bot file path, rejecting any `bot_id` that contains
    /// path separators (defence-in-depth against directory traversal).
    fn path_for(&self, bot_id: &str) -> Option<PathBuf> {
        if bot_id.is_empty() || bot_id.contains('/') || bot_id.contains('\\') || bot_id == ".." {
            return None;
        }
        Some(self.root.join(format!("{bot_id}.json")))
    }

    /// Test/admin helper: write the per-bot file. Marked `pub(crate)` so
    /// downstream code uses the secrets-injection pipeline; tests inside
    /// this crate use it to round-trip.
    #[cfg(any(test, feature = "test-utils"))]
    pub fn write_bot_file(
        root: &Path,
        bot_id: &str,
        contents: &BotKeysFile,
    ) -> std::io::Result<()> {
        let json = serde_json::to_vec_pretty(contents)?;
        let path = root.join(format!("{bot_id}.json"));
        std::fs::write(path, json)
    }
}

impl CexKeyProvider for SecretsBackedKeyProvider {
    fn binance_key(&self, bot_id: &str) -> Option<BinanceConfig> {
        let file = self.read_bot_file(bot_id)?;
        let b = file.binance?;
        Some(BinanceConfig {
            api_key: b.api_key,
            api_secret: b.api_secret,
            base_url: b.base_url,
            recv_window_ms: b.recv_window_ms,
        })
    }

    fn coinbase_key(&self, bot_id: &str) -> Option<CoinbaseConfig> {
        let file = self.read_bot_file(bot_id)?;
        let c = file.coinbase?;
        Some(CoinbaseConfig {
            api_key_name: c.api_key_name,
            api_private_key_pem: c.api_private_key_pem,
            base_url: c.base_url,
        })
    }

    fn solana_keypair(&self, bot_id: &str) -> Option<Keypair> {
        let file = self.read_bot_file(bot_id)?;
        let raw = file.solana?.private_key;
        crate::solana::keys::keypair_from_secret(&raw).ok()
    }
}

// ── On-disk shape ───────────────────────────────────────────────────────────

/// JSON file shape stored at `<root>/<bot_id>.json`.
///
/// All venue blocks are optional — a bot can configure Binance only,
/// Coinbase only, Solana only, or any combination.
#[derive(Debug, Clone, Default, serde::Serialize, Deserialize)]
pub struct BotKeysFile {
    #[serde(default)]
    pub binance: Option<BinanceKeyEntry>,
    #[serde(default)]
    pub coinbase: Option<CoinbaseKeyEntry>,
    #[serde(default)]
    pub solana: Option<SolanaKeyEntry>,
}

#[derive(Debug, Clone, serde::Serialize, Deserialize)]
pub struct BinanceKeyEntry {
    pub api_key: String,
    pub api_secret: String,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub recv_window_ms: Option<u64>,
}

#[derive(Debug, Clone, serde::Serialize, Deserialize)]
pub struct CoinbaseKeyEntry {
    pub api_key_name: String,
    pub api_private_key_pem: String,
    #[serde(default)]
    pub base_url: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, Deserialize)]
pub struct SolanaKeyEntry {
    /// One of: JSON byte-array (`[1,2,...]`), base58 64-byte secret, or
    /// hex 32-byte ed25519 seed. Same encodings the Solana env-loader
    /// accepts.
    pub private_key: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_sdk::signer::Signer;

    /// SAFETY: tests in this module mutate process env vars; the harness
    /// runs them serially per Tokio's default `#[test]`. Run with
    /// `--test-threads=1` if your CI parallelises further.
    fn with_env_vars<F: FnOnce()>(pairs: &[(&str, &str)], f: F) {
        for (k, v) in pairs {
            unsafe { std::env::set_var(k, v) };
        }
        f();
        for (k, _) in pairs {
            unsafe { std::env::remove_var(k) };
        }
    }

    #[test]
    fn env_provider_returns_some_when_binance_env_set() {
        with_env_vars(
            &[("BINANCE_API_KEY", "k"), ("BINANCE_API_SECRET", "s")],
            || {
                let p = EnvKeyProvider;
                let cfg = p.binance_key("bot-a").expect("env-set creds must resolve");
                assert_eq!(cfg.api_key, "k");
                assert_eq!(cfg.api_secret, "s");
            },
        );
    }

    #[test]
    fn env_provider_returns_none_when_binance_env_unset() {
        // Make sure we start clean.
        unsafe {
            std::env::remove_var("BINANCE_API_KEY");
            std::env::remove_var("BINANCE_API_SECRET");
        };
        let p = EnvKeyProvider;
        assert!(p.binance_key("bot-a").is_none());
    }

    #[test]
    fn env_provider_solana_returns_none_when_unset() {
        unsafe { std::env::remove_var(crate::solana::keys::SOLANA_OPERATOR_KEY_ENV) };
        let p = EnvKeyProvider;
        assert!(p.solana_keypair("any-bot").is_none());
    }

    #[test]
    fn secrets_provider_reads_per_bot_binance_block() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bot_id = "tenant-7";
        SecretsBackedKeyProvider::write_bot_file(
            dir.path(),
            bot_id,
            &BotKeysFile {
                binance: Some(BinanceKeyEntry {
                    api_key: "tenant-key".into(),
                    api_secret: "tenant-secret".into(),
                    base_url: Some("https://testnet.binance.vision".into()),
                    recv_window_ms: Some(3_000),
                }),
                ..Default::default()
            },
        )
        .unwrap();

        let provider = SecretsBackedKeyProvider::new(dir.path()).unwrap();
        let cfg = provider
            .binance_key(bot_id)
            .expect("must read tenant block");
        assert_eq!(cfg.api_key, "tenant-key");
        assert_eq!(cfg.api_secret, "tenant-secret");
        assert_eq!(
            cfg.base_url.as_deref(),
            Some("https://testnet.binance.vision")
        );
        assert_eq!(cfg.recv_window_ms, Some(3_000));

        // A different bot id has no file → None (412 path at the route layer).
        assert!(provider.binance_key("ghost-bot").is_none());
    }

    #[test]
    fn secrets_provider_returns_none_for_missing_venue_block() {
        let dir = tempfile::tempdir().unwrap();
        let bot_id = "binance-only";
        SecretsBackedKeyProvider::write_bot_file(
            dir.path(),
            bot_id,
            &BotKeysFile {
                binance: Some(BinanceKeyEntry {
                    api_key: "k".into(),
                    api_secret: "s".into(),
                    base_url: None,
                    recv_window_ms: None,
                }),
                coinbase: None,
                solana: None,
            },
        )
        .unwrap();
        let p = SecretsBackedKeyProvider::new(dir.path()).unwrap();
        assert!(p.binance_key(bot_id).is_some());
        assert!(p.coinbase_key(bot_id).is_none());
        assert!(p.solana_keypair(bot_id).is_none());
    }

    #[test]
    fn secrets_provider_solana_round_trips_keypair_via_base58() {
        let dir = tempfile::tempdir().unwrap();
        let kp = Keypair::new();
        let b58 = solana_sdk::bs58::encode(kp.to_bytes()).into_string();
        let bot_id = "sol-bot";

        SecretsBackedKeyProvider::write_bot_file(
            dir.path(),
            bot_id,
            &BotKeysFile {
                solana: Some(SolanaKeyEntry { private_key: b58 }),
                ..Default::default()
            },
        )
        .unwrap();

        let p = SecretsBackedKeyProvider::new(dir.path()).unwrap();
        let resolved = p.solana_keypair(bot_id).expect("must resolve");
        assert_eq!(kp.pubkey(), resolved.pubkey());
    }

    #[test]
    fn secrets_provider_path_traversal_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let p = SecretsBackedKeyProvider::new(dir.path()).unwrap();
        assert!(p.binance_key("../escape").is_none());
        assert!(p.binance_key("a/b").is_none());
        assert!(p.binance_key("").is_none());
    }

    #[test]
    fn secrets_provider_construction_rejects_missing_root() {
        let err = SecretsBackedKeyProvider::new("/definitely-not-here-xyzzy").unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::NotFound);
    }

    #[test]
    fn env_provider_binance_round_trips_recv_window() {
        with_env_vars(
            &[
                ("BINANCE_API_KEY", "k"),
                ("BINANCE_API_SECRET", "s"),
                ("BINANCE_RECV_WINDOW_MS", "10000"),
            ],
            || {
                let cfg = EnvKeyProvider.binance_key("any").unwrap();
                assert_eq!(cfg.recv_window_ms, Some(10_000));
            },
        );
    }
}
