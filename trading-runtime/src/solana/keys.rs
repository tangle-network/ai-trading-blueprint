//! Solana operator keypair loading.
//!
//! The operator's secret key reaches the trading runtime in one of three
//! sandbox-injected forms:
//!
//! 1. JSON byte array (the `solana-keygen` default file format) — e.g.
//!    `[12, 0, 255, ...]` of length 64 — this is what users get from
//!    `solana-keygen new -o keypair.json`.
//! 2. Raw base58-encoded 64-byte secret (what most wallets export).
//! 3. Hex-encoded 32-byte ed25519 seed (interoperable with EVM-style
//!    secret stores that prefer 32-byte hex blobs).
//!
//! The encrypted secret-store unwraps the bytes server-side; we only ever
//! see the cleartext as a `&str`. Plaintext keys MUST NOT be persisted to
//! disk by callers.

use solana_sdk::signature::Keypair;

use super::error::SolanaError;

/// Sandbox env var that holds the operator's Solana secret in one of the
/// supported encodings.
pub const SOLANA_OPERATOR_KEY_ENV: &str = "SOLANA_OPERATOR_PRIVATE_KEY";

/// Parse a `Keypair` from one of the three accepted encodings.
///
/// Tried in order: JSON byte-array → base58 → hex (32-byte seed → expanded
/// via solana-sdk's `Keypair::new_from_array`).
pub fn keypair_from_secret(raw: &str) -> Result<Keypair, SolanaError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(SolanaError::KeypairUnavailable("empty secret".into()));
    }

    // 1. JSON byte array.
    if trimmed.starts_with('[') {
        let bytes: Vec<u8> = serde_json::from_str(trimmed)
            .map_err(|e| SolanaError::KeypairUnavailable(format!("invalid JSON keypair: {e}")))?;
        return keypair_from_bytes(&bytes);
    }

    // 2. Base58-encoded 64-byte secret (most wallet exports).
    if let Ok(decoded) = bs58::decode(trimmed).into_vec() {
        if decoded.len() == 64 {
            return keypair_from_bytes(&decoded);
        }
    }

    // 3. Hex-encoded 32-byte ed25519 seed.
    let hex_input = trimmed.strip_prefix("0x").unwrap_or(trimmed);
    if let Ok(seed) = hex::decode(hex_input) {
        if seed.len() == 32 {
            // Derive the full keypair from the 32-byte seed.
            let signing = ed25519_dalek::SigningKey::from_bytes(
                &seed.as_slice().try_into().expect("len 32 enforced above"),
            );
            let mut full = [0u8; 64];
            full[..32].copy_from_slice(signing.to_bytes().as_ref());
            full[32..].copy_from_slice(signing.verifying_key().as_bytes());
            return keypair_from_bytes(&full);
        }
    }

    Err(SolanaError::KeypairUnavailable(
        "secret is not a valid JSON byte-array, base58 64-byte, or hex 32-byte seed".into(),
    ))
}

/// Load the operator keypair from `SOLANA_OPERATOR_KEY_ENV`.
///
/// Errors if the env var is unset, empty, or holds a malformed encoding.
pub fn load_operator_keypair_from_env() -> Result<Keypair, SolanaError> {
    let raw = std::env::var(SOLANA_OPERATOR_KEY_ENV).map_err(|_| {
        SolanaError::KeypairUnavailable(format!("{SOLANA_OPERATOR_KEY_ENV} not set"))
    })?;
    keypair_from_secret(&raw)
}

fn keypair_from_bytes(bytes: &[u8]) -> Result<Keypair, SolanaError> {
    if bytes.len() != 64 {
        return Err(SolanaError::KeypairUnavailable(format!(
            "expected 64 keypair bytes, got {}",
            bytes.len()
        )));
    }
    Keypair::try_from(bytes)
        .map_err(|e| SolanaError::KeypairUnavailable(format!("from_bytes: {e}")))
}

// `bs58` is re-exported through solana-sdk; importing it directly avoids a
// cargo manifest dep.
use solana_sdk::bs58;

#[cfg(test)]
mod tests {
    use super::*;
    use solana_sdk::signer::Signer;

    fn sample_pubkey(kp: &Keypair) -> String {
        kp.pubkey().to_string()
    }

    #[test]
    fn load_from_json_byte_array() {
        let kp = Keypair::new();
        let bytes = kp.to_bytes();
        let json = serde_json::to_string(&bytes.to_vec()).unwrap();
        let parsed = keypair_from_secret(&json).unwrap();
        assert_eq!(sample_pubkey(&kp), sample_pubkey(&parsed));
    }

    #[test]
    fn load_from_base58() {
        let kp = Keypair::new();
        let b58 = bs58::encode(kp.to_bytes()).into_string();
        let parsed = keypair_from_secret(&b58).unwrap();
        assert_eq!(sample_pubkey(&kp), sample_pubkey(&parsed));
    }

    #[test]
    fn load_from_hex_seed_round_trips_pubkey() {
        // For the hex seed path, the pubkey is the verifying key derived
        // from the 32-byte seed. Round-tripping the seed must produce a
        // stable pubkey.
        let kp = Keypair::new();
        let seed: [u8; 32] = kp.to_bytes()[..32].try_into().unwrap();
        let parsed = keypair_from_secret(&hex::encode(seed)).unwrap();
        // Same seed → same verifying key → same pubkey.
        assert_eq!(sample_pubkey(&kp), sample_pubkey(&parsed));

        // 0x prefix accepted.
        let parsed2 = keypair_from_secret(&format!("0x{}", hex::encode(seed))).unwrap();
        assert_eq!(sample_pubkey(&parsed), sample_pubkey(&parsed2));
    }

    #[test]
    fn empty_secret_rejected() {
        let err = keypair_from_secret("").unwrap_err();
        assert!(matches!(err, SolanaError::KeypairUnavailable(_)));
        let err = keypair_from_secret("   ").unwrap_err();
        assert!(matches!(err, SolanaError::KeypairUnavailable(_)));
    }

    #[test]
    fn garbage_secret_rejected() {
        let err = keypair_from_secret("not a real key").unwrap_err();
        assert!(matches!(err, SolanaError::KeypairUnavailable(_)));
    }

    #[test]
    fn wrong_length_byte_array_rejected() {
        let bytes = vec![0u8; 32]; // half the required 64
        let json = serde_json::to_string(&bytes).unwrap();
        let err = keypair_from_secret(&json).unwrap_err();
        assert!(matches!(err, SolanaError::KeypairUnavailable(_)));
    }

    #[test]
    fn env_loader_reports_unset() {
        // SAFETY: tests in this module set/unset SOLANA_OPERATOR_PRIVATE_KEY
        // serially; this is single-threaded by tokio's #[test] default.
        unsafe { std::env::remove_var(SOLANA_OPERATOR_KEY_ENV) };
        let err = load_operator_keypair_from_env().unwrap_err();
        assert!(matches!(err, SolanaError::KeypairUnavailable(_)));
    }
}
