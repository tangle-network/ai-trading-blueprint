use alloy::primitives::{Address, B256, Signature, U256, keccak256};
use alloy::signers::SignerSync;
use alloy::signers::local::PrivateKeySigner;
use alloy::sol_types::SolValue;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use super::enforcement::EnvelopeEnforcement;
use super::error::EnvelopeError;
use super::policy::TradingPolicy;

const DOMAIN_NAME: &str = "TradingEnvelope";
const DOMAIN_VERSION: &str = "2";
const ENVELOPE_TYPEHASH: &str = concat!(
    "Envelope(",
    "uint64 version,",
    "bytes32 botIdHash,",
    "address vault,",
    "uint64 chainId,",
    "bytes32 protocolHash,",
    "bytes32 policyHash,",
    "bytes32 enforcementHash,",
    "uint64 issuedAt,",
    "uint64 expiresAt,",
    "uint64 nonce,",
    "bytes32 signersHash,",
    "uint64 minSignatures",
    ")"
);

fn default_version() -> u64 {
    2
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EnvelopeSignature {
    pub signer: String,
    pub signature: String,
    /// Validator quality score (0-10000). The on-chain validator weighs scores
    /// per-vault and rejects an envelope when the score-weighted average is
    /// below the configured threshold. Default 0 when validator scoring is unused.
    #[serde(default)]
    pub score: u32,
}

/// A cryptographically signed trading policy authorizing a bot to trade
/// within defined risk bounds without per-trade validator round-trips.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignedEnvelope {
    #[serde(default = "default_version")]
    pub version: u64,
    pub bot_id: String,
    pub vault_address: String,
    pub chain_id: u64,
    /// Protocol family: "hyperliquid", "gmx_v2", "vertex", "uniswap_v3",
    /// "aave_v3", "morpho", "aerodrome", "polymarket_clob", etc.
    pub protocol: String,
    pub policy: TradingPolicy,
    pub approval_signers: Vec<String>,
    pub min_signatures: usize,
    pub issued_at: u64,
    pub expires_at: u64,
    pub nonce: u64,
    /// EVM address of the contract against which signatures are verified.
    /// This is the single canonical verifying_contract for all signatures.
    pub verifying_contract: String,
    /// Optional on-chain enforcement binding. Required for vault-routed protocols
    /// (Uniswap V3, Aave V3, Morpho, Aerodrome). None for direct-API protocols
    /// (Hyperliquid, Polymarket CLOB) where the off-chain check_* path is the
    /// entire enforcement.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enforcement: Option<EnvelopeEnforcement>,
    #[serde(default)]
    pub signatures: Vec<EnvelopeSignature>,
}

#[derive(Debug, Clone)]
pub struct EnvelopeBinding<'a> {
    pub bot_id: &'a str,
    pub vault_address: &'a str,
    pub chain_id: u64,
    pub protocol: &'a str,
}

impl SignedEnvelope {
    /// Verify the envelope against a runtime binding (bot identity + context),
    /// against a set of trusted operator-configured signer addresses.
    ///
    /// Returns the list of recovered verified signer addresses.
    pub fn verify(
        &self,
        binding: &EnvelopeBinding<'_>,
        trusted_signers: &[String],
    ) -> Result<Vec<Address>, EnvelopeError> {
        self.validate_binding(binding)?;
        self.validate_constraints()?;

        let trusted = parse_address_set(trusted_signers)?;
        if trusted.is_empty() {
            return Err(EnvelopeError::NoTrustedSigners);
        }
        let approval = parse_address_set(&self.approval_signers)?;
        let digest = self.digest()?;
        let mut seen: HashSet<Address> = HashSet::new();
        let mut verified: Vec<Address> = Vec::new();

        for sig in &self.signatures {
            let recovered = recover_signer(sig, digest)?;
            let claimed: Address = sig.signer.parse().map_err(|e: alloy::hex::FromHexError| {
                EnvelopeError::InvalidAddress {
                    addr: sig.signer.clone(),
                    reason: e.to_string(),
                }
            })?;
            if recovered != claimed {
                return Err(EnvelopeError::SignerMismatch {
                    claimed: format!("{claimed:#x}"),
                    recovered: format!("{recovered:#x}"),
                });
            }
            if !approval.contains(&recovered) {
                return Err(EnvelopeError::SignerNotInApprovalSet {
                    addr: format!("{recovered:#x}"),
                });
            }
            if !trusted.contains(&recovered) {
                return Err(EnvelopeError::SignerNotTrusted {
                    addr: format!("{recovered:#x}"),
                });
            }
            if seen.insert(recovered) {
                verified.push(recovered);
            }
        }

        if verified.len() < self.min_signatures {
            return Err(EnvelopeError::InsufficientSignatures {
                got: verified.len(),
                required: self.min_signatures,
            });
        }

        Ok(verified)
    }

    /// Compute the EIP-712 digest for this envelope.
    pub fn digest(&self) -> Result<B256, EnvelopeError> {
        let verifying_contract: Address =
            self.verifying_contract
                .parse()
                .map_err(
                    |e: alloy::hex::FromHexError| EnvelopeError::InvalidAddress {
                        addr: self.verifying_contract.clone(),
                        reason: e.to_string(),
                    },
                )?;
        Ok(eip712_digest(
            domain_separator(self.chain_id, verifying_contract),
            self.struct_hash()?,
        ))
    }

    fn struct_hash(&self) -> Result<B256, EnvelopeError> {
        let vault: Address =
            self.vault_address
                .parse()
                .map_err(
                    |e: alloy::hex::FromHexError| EnvelopeError::InvalidAddress {
                        addr: self.vault_address.clone(),
                        reason: e.to_string(),
                    },
                )?;
        let policy_hash = self.policy.struct_hash()?;
        let enforcement_hash = match &self.enforcement {
            Some(e) => e.struct_hash()?,
            None => B256::ZERO,
        };
        Ok(keccak256(SolValue::abi_encode(&(
            keccak256(ENVELOPE_TYPEHASH.as_bytes()),
            U256::from(self.version),
            keccak256(self.bot_id.as_bytes()),
            vault,
            U256::from(self.chain_id),
            keccak256(self.protocol.to_ascii_lowercase().as_bytes()),
            policy_hash,
            enforcement_hash,
            U256::from(self.issued_at),
            U256::from(self.expires_at),
            U256::from(self.nonce),
            hash_sorted_addresses(&self.approval_signers)?,
            U256::from(self.min_signatures),
        ))))
    }

    /// Sign this envelope and append the signature.
    /// Returns the signer address as a string.
    pub fn sign_with_private_key(
        &mut self,
        private_key: &str,
        verifying_contract: &str,
    ) -> Result<String, EnvelopeError> {
        if self.verifying_contract.is_empty() {
            self.verifying_contract = verifying_contract.to_string();
        }
        let signer: PrivateKeySigner =
            private_key
                .parse()
                .map_err(|e: alloy::signers::local::LocalSignerError| {
                    EnvelopeError::InvalidAddress {
                        addr: "private key".into(),
                        reason: e.to_string(),
                    }
                })?;
        let addr = format!("{:#x}", signer.address());
        let digest = self.digest()?;
        let signature =
            signer
                .sign_hash_sync(&digest)
                .map_err(|e| EnvelopeError::SignatureRecoveryFailed {
                    reason: e.to_string(),
                })?;
        self.signatures.push(EnvelopeSignature {
            signer: addr.clone(),
            signature: format!("0x{}", hex::encode(signature.as_bytes())),
            score: 0,
        });
        Ok(addr)
    }

    fn validate_binding(&self, binding: &EnvelopeBinding<'_>) -> Result<(), EnvelopeError> {
        if self.bot_id != binding.bot_id {
            return Err(EnvelopeError::BotIdMismatch);
        }
        if !addresses_equal(&self.vault_address, binding.vault_address)? {
            return Err(EnvelopeError::VaultMismatch);
        }
        if self.chain_id != binding.chain_id {
            return Err(EnvelopeError::ChainIdMismatch);
        }
        if !self
            .protocol
            .trim()
            .eq_ignore_ascii_case(binding.protocol.trim())
        {
            return Err(EnvelopeError::ProtocolMismatch {
                envelope: self.protocol.clone(),
                execution: binding.protocol.to_string(),
            });
        }
        Ok(())
    }

    fn validate_constraints(&self) -> Result<(), EnvelopeError> {
        if self.version != 2 {
            return Err(EnvelopeError::VersionMismatch {
                expected: 2,
                got: self.version,
            });
        }
        if self.min_signatures == 0 {
            return Err(EnvelopeError::ZeroMinSignatures);
        }
        if self.approval_signers.is_empty() {
            return Err(EnvelopeError::EmptySignerSet);
        }
        if self.min_signatures > self.approval_signers.len() {
            return Err(EnvelopeError::MinSignaturesExceedsSigners {
                min: self.min_signatures,
                count: self.approval_signers.len(),
            });
        }
        let now = Utc::now().timestamp() as u64;
        if self.expires_at == 0 || self.expires_at <= now {
            return Err(EnvelopeError::Expired {
                expires_at: self.expires_at,
            });
        }
        self.policy.validate()?;
        if let Some(ref enf) = self.enforcement {
            enf.validate()?;
            // Enforcement protocol must agree with envelope.protocol so off-chain
            // routing and on-chain executor dispatch can't disagree.
            if !self.protocol.trim().eq_ignore_ascii_case(enf.protocol_id()) {
                return Err(EnvelopeError::EnforcementProtocolMismatch {
                    enforcement: enf.protocol_id().into(),
                    envelope: self.protocol.clone(),
                });
            }
        }
        Ok(())
    }

    /// Returns the enforcement binding required for vault-routed protocols.
    /// Returns `MissingEnforcement` if the envelope has no binding — which is
    /// a runtime error for any protocol that submits trades to the vault.
    pub fn require_enforcement(&self) -> Result<&EnvelopeEnforcement, EnvelopeError> {
        self.enforcement
            .as_ref()
            .ok_or(EnvelopeError::MissingEnforcement)
    }
}

fn domain_separator(chain_id: u64, verifying_contract: Address) -> B256 {
    keccak256(SolValue::abi_encode(&(
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                .as_bytes(),
        ),
        keccak256(DOMAIN_NAME.as_bytes()),
        keccak256(DOMAIN_VERSION.as_bytes()),
        U256::from(chain_id),
        verifying_contract,
    )))
}

fn eip712_digest(domain_separator: B256, struct_hash: B256) -> B256 {
    keccak256(
        [
            [0x19u8, 0x01].as_slice(),
            domain_separator.as_slice(),
            struct_hash.as_slice(),
        ]
        .concat(),
    )
}

fn recover_signer(sig: &EnvelopeSignature, digest: B256) -> Result<Address, EnvelopeError> {
    let raw = sig.signature.strip_prefix("0x").unwrap_or(&sig.signature);
    let bytes = hex::decode(raw).map_err(|e| EnvelopeError::InvalidSignatureHex {
        reason: e.to_string(),
    })?;
    if bytes.len() != 65 {
        return Err(EnvelopeError::InvalidSignatureLength { got: bytes.len() });
    }
    let parity = if bytes[64] >= 27 {
        (bytes[64] - 27) == 1
    } else {
        bytes[64] == 1
    };
    Signature::from_bytes_and_parity(&bytes[..64], parity)
        .recover_address_from_prehash(&digest)
        .map_err(|e| EnvelopeError::SignatureRecoveryFailed {
            reason: e.to_string(),
        })
}

fn hash_sorted_addresses(values: &[String]) -> Result<B256, EnvelopeError> {
    let mut addrs: Vec<Address> = values
        .iter()
        .map(|v| {
            v.parse().map_err(
                |e: alloy::hex::FromHexError| EnvelopeError::InvalidAddress {
                    addr: v.clone(),
                    reason: e.to_string(),
                },
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    addrs.sort();
    let encoded: Vec<u8> = addrs.iter().flat_map(|a| a.as_slice().to_vec()).collect();
    Ok(keccak256(encoded))
}

fn parse_address_set(values: &[String]) -> Result<HashSet<Address>, EnvelopeError> {
    values
        .iter()
        .map(|v| {
            v.parse().map_err(
                |e: alloy::hex::FromHexError| EnvelopeError::InvalidAddress {
                    addr: v.clone(),
                    reason: e.to_string(),
                },
            )
        })
        .collect()
}

fn addresses_equal(left: &str, right: &str) -> Result<bool, EnvelopeError> {
    let l: Address =
        left.parse().map_err(
            |e: alloy::hex::FromHexError| EnvelopeError::InvalidAddress {
                addr: left.to_string(),
                reason: e.to_string(),
            },
        )?;
    let r: Address =
        right.parse().map_err(
            |e: alloy::hex::FromHexError| EnvelopeError::InvalidAddress {
                addr: right.to_string(),
                reason: e.to_string(),
            },
        )?;
    Ok(l == r)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::policy::{PerpsPolicy, TradingPolicy};
    use rust_decimal::Decimal;

    const KEY1: &str = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    const KEY2: &str = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    const CONTRACT: &str = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
    const VAULT: &str = "0x0000000000000000000000000000000000000001";

    fn test_policy() -> TradingPolicy {
        TradingPolicy {
            max_trade_size_usd: Decimal::from(1000),
            max_total_exposure_usd: Decimal::from(3000),
            max_drawdown_pct: Decimal::from(10),
            can_open_positions: true,
            perps: Some(PerpsPolicy {
                allowed_assets: vec!["ETH".into(), "BTC".into()],
                max_leverage: 5,
                max_stop_loss_distance: Decimal::new(5, 2),
                min_stop_loss_distance: Decimal::new(1, 2),
                require_stop_loss: false,
            }),
            vault: None,
            clob: None,
        }
    }

    fn signer_address(key: &str) -> String {
        let s: PrivateKeySigner = key.parse().unwrap();
        format!("{:#x}", s.address())
    }

    fn signed_test_envelope() -> SignedEnvelope {
        let mut e = SignedEnvelope {
            version: 2,
            bot_id: "test-bot".into(),
            vault_address: VAULT.into(),
            chain_id: 31337,
            protocol: "hyperliquid".into(),
            policy: test_policy(),
            approval_signers: vec![signer_address(KEY1)],
            min_signatures: 1,
            issued_at: Utc::now().timestamp() as u64,
            expires_at: Utc::now().timestamp() as u64 + 3600,
            nonce: 1,
            verifying_contract: CONTRACT.into(),
            enforcement: None,
            signatures: vec![],
        };
        e.sign_with_private_key(KEY1, CONTRACT).unwrap();
        e
    }

    #[test]
    fn round_trip_verifies() {
        let e = signed_test_envelope();
        let trusted = e.approval_signers.clone();
        let binding = EnvelopeBinding {
            bot_id: "test-bot",
            vault_address: VAULT,
            chain_id: 31337,
            protocol: "hyperliquid",
        };
        let verified = e.verify(&binding, &trusted).unwrap();
        assert_eq!(verified.len(), 1);
    }

    #[test]
    fn digest_is_deterministic() {
        let e = signed_test_envelope();
        assert_eq!(e.digest().unwrap(), e.digest().unwrap());
    }

    #[test]
    fn wrong_bot_rejected() {
        let e = signed_test_envelope();
        let trusted = e.approval_signers.clone();
        let err = e
            .verify(
                &EnvelopeBinding {
                    bot_id: "other-bot",
                    vault_address: VAULT,
                    chain_id: 31337,
                    protocol: "hyperliquid",
                },
                &trusted,
            )
            .unwrap_err();
        assert_eq!(err, EnvelopeError::BotIdMismatch);
    }

    #[test]
    fn wrong_vault_rejected() {
        let e = signed_test_envelope();
        let trusted = e.approval_signers.clone();
        let err = e
            .verify(
                &EnvelopeBinding {
                    bot_id: "test-bot",
                    vault_address: "0x0000000000000000000000000000000000000002",
                    chain_id: 31337,
                    protocol: "hyperliquid",
                },
                &trusted,
            )
            .unwrap_err();
        assert_eq!(err, EnvelopeError::VaultMismatch);
    }

    #[test]
    fn wrong_chain_rejected() {
        let e = signed_test_envelope();
        let trusted = e.approval_signers.clone();
        let err = e
            .verify(
                &EnvelopeBinding {
                    bot_id: "test-bot",
                    vault_address: VAULT,
                    chain_id: 1,
                    protocol: "hyperliquid",
                },
                &trusted,
            )
            .unwrap_err();
        assert_eq!(err, EnvelopeError::ChainIdMismatch);
    }

    #[test]
    fn wrong_protocol_rejected() {
        let e = signed_test_envelope();
        let trusted = e.approval_signers.clone();
        let err = e
            .verify(
                &EnvelopeBinding {
                    bot_id: "test-bot",
                    vault_address: VAULT,
                    chain_id: 31337,
                    protocol: "uniswap_v3",
                },
                &trusted,
            )
            .unwrap_err();
        assert!(matches!(err, EnvelopeError::ProtocolMismatch { .. }));
    }

    #[test]
    fn multisig_two_of_two() {
        let a1 = signer_address(KEY1);
        let a2 = signer_address(KEY2);
        let mut e = SignedEnvelope {
            version: 2,
            bot_id: "bot-ms".into(),
            vault_address: VAULT.into(),
            chain_id: 31337,
            protocol: "hyperliquid".into(),
            policy: test_policy(),
            approval_signers: vec![a1.clone(), a2.clone()],
            min_signatures: 2,
            issued_at: Utc::now().timestamp() as u64,
            expires_at: Utc::now().timestamp() as u64 + 3600,
            nonce: 1,
            verifying_contract: CONTRACT.into(),
            enforcement: None,
            signatures: vec![],
        };
        e.sign_with_private_key(KEY1, CONTRACT).unwrap();
        e.sign_with_private_key(KEY2, CONTRACT).unwrap();
        let trusted = vec![a1, a2];
        let binding = EnvelopeBinding {
            bot_id: "bot-ms",
            vault_address: VAULT,
            chain_id: 31337,
            protocol: "hyperliquid",
        };
        assert_eq!(e.verify(&binding, &trusted).unwrap().len(), 2);
    }

    #[test]
    fn multisig_one_of_two_required_fails() {
        let a1 = signer_address(KEY1);
        let a2 = signer_address(KEY2);
        let mut e = SignedEnvelope {
            version: 2,
            bot_id: "bot-ms2".into(),
            vault_address: VAULT.into(),
            chain_id: 31337,
            protocol: "hyperliquid".into(),
            policy: test_policy(),
            approval_signers: vec![a1.clone(), a2.clone()],
            min_signatures: 2,
            issued_at: Utc::now().timestamp() as u64,
            expires_at: Utc::now().timestamp() as u64 + 3600,
            nonce: 1,
            verifying_contract: CONTRACT.into(),
            enforcement: None,
            signatures: vec![],
        };
        e.sign_with_private_key(KEY1, CONTRACT).unwrap();
        // only one of two signed
        let trusted = vec![a1, a2];
        let binding = EnvelopeBinding {
            bot_id: "bot-ms2",
            vault_address: VAULT,
            chain_id: 31337,
            protocol: "hyperliquid",
        };
        let err = e.verify(&binding, &trusted).unwrap_err();
        assert!(matches!(
            err,
            EnvelopeError::InsufficientSignatures {
                got: 1,
                required: 2
            }
        ));
    }

    #[test]
    fn dedup_prevents_same_key_satisfying_quorum() {
        let a1 = signer_address(KEY1);
        let a2 = signer_address(KEY2);
        let mut e = SignedEnvelope {
            version: 2,
            bot_id: "bot-dup".into(),
            vault_address: VAULT.into(),
            chain_id: 31337,
            protocol: "hyperliquid".into(),
            policy: test_policy(),
            approval_signers: vec![a1.clone(), a2.clone()],
            min_signatures: 2,
            issued_at: Utc::now().timestamp() as u64,
            expires_at: Utc::now().timestamp() as u64 + 3600,
            nonce: 1,
            verifying_contract: CONTRACT.into(),
            enforcement: None,
            signatures: vec![],
        };
        e.sign_with_private_key(KEY1, CONTRACT).unwrap();
        let dup = e.signatures[0].clone();
        e.signatures = vec![dup.clone(), dup]; // key1 twice
        let trusted = vec![a1, a2];
        let binding = EnvelopeBinding {
            bot_id: "bot-dup",
            vault_address: VAULT,
            chain_id: 31337,
            protocol: "hyperliquid",
        };
        let err = e.verify(&binding, &trusted).unwrap_err();
        assert!(matches!(
            err,
            EnvelopeError::InsufficientSignatures {
                got: 1,
                required: 2
            }
        ));
    }

    #[test]
    fn expired_envelope_rejected() {
        let mut e = signed_test_envelope();
        e.expires_at = 1000; // long past
        let trusted = e.approval_signers.clone();
        let binding = EnvelopeBinding {
            bot_id: "test-bot",
            vault_address: VAULT,
            chain_id: 31337,
            protocol: "hyperliquid",
        };
        assert!(matches!(
            e.verify(&binding, &trusted).unwrap_err(),
            EnvelopeError::Expired { .. }
        ));
    }

    #[test]
    fn invalid_signature_hex_rejected() {
        let mut e = signed_test_envelope();
        e.signatures[0].signature = "not-hex".into();
        let trusted = e.approval_signers.clone();
        let binding = EnvelopeBinding {
            bot_id: "test-bot",
            vault_address: VAULT,
            chain_id: 31337,
            protocol: "hyperliquid",
        };
        assert!(matches!(
            e.verify(&binding, &trusted).unwrap_err(),
            EnvelopeError::InvalidSignatureHex { .. }
        ));
    }

    #[test]
    fn truncated_signature_rejected() {
        let mut e = signed_test_envelope();
        e.signatures[0].signature = format!("0x{}", "aa".repeat(32));
        let trusted = e.approval_signers.clone();
        let binding = EnvelopeBinding {
            bot_id: "test-bot",
            vault_address: VAULT,
            chain_id: 31337,
            protocol: "hyperliquid",
        };
        assert!(matches!(
            e.verify(&binding, &trusted).unwrap_err(),
            EnvelopeError::InvalidSignatureLength { got: 32 }
        ));
    }

    #[test]
    fn policy_hash_is_stable() {
        let p = test_policy();
        let h1 = p.struct_hash().unwrap();
        let h2 = p.struct_hash().unwrap();
        assert_eq!(h1, h2);
    }

    #[test]
    fn different_policies_produce_different_hashes() {
        let p1 = test_policy();
        let mut p2 = test_policy();
        p2.max_trade_size_usd = Decimal::from(999);
        assert_ne!(p1.struct_hash().unwrap(), p2.struct_hash().unwrap());
    }

    // ── digest sensitivity & order independence ──────────────────────────────

    #[test]
    fn digest_changes_when_bot_id_changes() {
        let mut a = signed_test_envelope();
        let mut b = signed_test_envelope();
        a.bot_id = "x".into();
        b.bot_id = "y".into();
        assert_ne!(a.digest().unwrap(), b.digest().unwrap());
    }

    #[test]
    fn digest_changes_when_chain_id_changes() {
        let mut a = signed_test_envelope();
        let mut b = signed_test_envelope();
        a.chain_id = 31337;
        b.chain_id = 1;
        assert_ne!(a.digest().unwrap(), b.digest().unwrap());
    }

    #[test]
    fn digest_changes_when_protocol_changes() {
        let mut a = signed_test_envelope();
        let mut b = signed_test_envelope();
        a.protocol = "hyperliquid".into();
        b.protocol = "uniswap_v3".into();
        assert_ne!(a.digest().unwrap(), b.digest().unwrap());
    }

    #[test]
    fn digest_changes_when_nonce_changes() {
        let mut a = signed_test_envelope();
        let mut b = signed_test_envelope();
        a.nonce = 1;
        b.nonce = 2;
        assert_ne!(a.digest().unwrap(), b.digest().unwrap());
    }

    #[test]
    fn digest_changes_when_expires_at_changes() {
        let mut a = signed_test_envelope();
        let mut b = signed_test_envelope();
        a.expires_at = 1_000_000_000;
        b.expires_at = 2_000_000_000;
        assert_ne!(a.digest().unwrap(), b.digest().unwrap());
    }

    #[test]
    fn digest_changes_when_min_signatures_changes() {
        let mut a = signed_test_envelope();
        let mut b = signed_test_envelope();
        a.min_signatures = 1;
        b.min_signatures = 2;
        a.approval_signers = vec![signer_address(KEY1), signer_address(KEY2)];
        b.approval_signers = vec![signer_address(KEY1), signer_address(KEY2)];
        assert_ne!(a.digest().unwrap(), b.digest().unwrap());
    }

    #[test]
    fn digest_changes_when_verifying_contract_changes() {
        let mut a = signed_test_envelope();
        let mut b = signed_test_envelope();
        a.verifying_contract = CONTRACT.into();
        b.verifying_contract = "0x0000000000000000000000000000000000000099".into();
        assert_ne!(a.digest().unwrap(), b.digest().unwrap());
    }

    #[test]
    fn digest_is_invariant_to_signer_order() {
        let a1 = signer_address(KEY1);
        let a2 = signer_address(KEY2);
        let mut a = signed_test_envelope();
        let mut b = signed_test_envelope();
        a.min_signatures = 2;
        b.min_signatures = 2;
        a.approval_signers = vec![a1.clone(), a2.clone()];
        b.approval_signers = vec![a2, a1];
        assert_eq!(a.digest().unwrap(), b.digest().unwrap());
    }

    #[test]
    fn protocol_match_is_case_insensitive() {
        let mut e = signed_test_envelope();
        e.protocol = "HyperLiquid".into();
        let trusted = e.approval_signers.clone();
        let binding = EnvelopeBinding {
            bot_id: "test-bot",
            vault_address: VAULT,
            chain_id: 31337,
            protocol: "hyperliquid",
        };
        // Verify will fail because the digest was signed with the original
        // string; just check the binding step does not reject case differences.
        // We can do that by inspecting the public validate path indirectly:
        // re-sign with the upper-case protocol and re-verify.
        e.signatures.clear();
        e.sign_with_private_key(KEY1, CONTRACT).unwrap();
        e.verify(&binding, &trusted).unwrap();
    }

    // ── version + structural constraint guards ──────────────────────────────

    #[test]
    fn wrong_version_rejected() {
        let mut e = signed_test_envelope();
        e.version = 1;
        let trusted = e.approval_signers.clone();
        let binding = EnvelopeBinding {
            bot_id: "test-bot",
            vault_address: VAULT,
            chain_id: 31337,
            protocol: "hyperliquid",
        };
        assert!(matches!(
            e.verify(&binding, &trusted).unwrap_err(),
            EnvelopeError::VersionMismatch { .. }
        ));
    }

    #[test]
    fn empty_approval_set_rejected() {
        let mut e = signed_test_envelope();
        e.approval_signers.clear();
        let binding = EnvelopeBinding {
            bot_id: "test-bot",
            vault_address: VAULT,
            chain_id: 31337,
            protocol: "hyperliquid",
        };
        assert_eq!(
            e.verify(&binding, &[signer_address(KEY1)]).unwrap_err(),
            EnvelopeError::EmptySignerSet
        );
    }

    #[test]
    fn zero_min_signatures_rejected() {
        let mut e = signed_test_envelope();
        e.min_signatures = 0;
        let trusted = e.approval_signers.clone();
        let binding = EnvelopeBinding {
            bot_id: "test-bot",
            vault_address: VAULT,
            chain_id: 31337,
            protocol: "hyperliquid",
        };
        assert_eq!(
            e.verify(&binding, &trusted).unwrap_err(),
            EnvelopeError::ZeroMinSignatures
        );
    }

    #[test]
    fn min_signatures_above_signer_count_rejected() {
        let mut e = signed_test_envelope();
        e.min_signatures = 5; // only 1 approval_signer in default setup
        let trusted = e.approval_signers.clone();
        let binding = EnvelopeBinding {
            bot_id: "test-bot",
            vault_address: VAULT,
            chain_id: 31337,
            protocol: "hyperliquid",
        };
        assert!(matches!(
            e.verify(&binding, &trusted).unwrap_err(),
            EnvelopeError::MinSignaturesExceedsSigners { min: 5, count: 1 }
        ));
    }

    #[test]
    fn no_trusted_signers_rejected() {
        let e = signed_test_envelope();
        let binding = EnvelopeBinding {
            bot_id: "test-bot",
            vault_address: VAULT,
            chain_id: 31337,
            protocol: "hyperliquid",
        };
        let empty: Vec<String> = vec![];
        assert_eq!(
            e.verify(&binding, &empty).unwrap_err(),
            EnvelopeError::NoTrustedSigners
        );
    }

    // ── adversarial signature handling ──────────────────────────────────────

    #[test]
    fn untrusted_signer_rejected_even_when_in_approval_set() {
        // KEY2 is in approval_signers but not in trusted set
        let a1 = signer_address(KEY1);
        let a2 = signer_address(KEY2);
        let mut e = SignedEnvelope {
            version: 2,
            bot_id: "untrusted-test".into(),
            vault_address: VAULT.into(),
            chain_id: 31337,
            protocol: "hyperliquid".into(),
            policy: test_policy(),
            approval_signers: vec![a1.clone(), a2.clone()],
            min_signatures: 1,
            issued_at: Utc::now().timestamp() as u64,
            expires_at: Utc::now().timestamp() as u64 + 3600,
            nonce: 1,
            verifying_contract: CONTRACT.into(),
            enforcement: None,
            signatures: vec![],
        };
        e.sign_with_private_key(KEY2, CONTRACT).unwrap(); // signed by KEY2

        let binding = EnvelopeBinding {
            bot_id: "untrusted-test",
            vault_address: VAULT,
            chain_id: 31337,
            protocol: "hyperliquid",
        };
        // operator only trusts KEY1
        let err = e.verify(&binding, &[a1]).unwrap_err();
        assert!(matches!(err, EnvelopeError::SignerNotTrusted { .. }));
    }

    #[test]
    fn signer_outside_approval_set_rejected() {
        // Sign with KEY2 but only KEY1 is in approval_signers
        let a1 = signer_address(KEY1);
        let a2 = signer_address(KEY2);
        let mut e = SignedEnvelope {
            version: 2,
            bot_id: "outside-test".into(),
            vault_address: VAULT.into(),
            chain_id: 31337,
            protocol: "hyperliquid".into(),
            policy: test_policy(),
            approval_signers: vec![a1.clone()],
            min_signatures: 1,
            issued_at: Utc::now().timestamp() as u64,
            expires_at: Utc::now().timestamp() as u64 + 3600,
            nonce: 1,
            verifying_contract: CONTRACT.into(),
            enforcement: None,
            signatures: vec![],
        };
        e.sign_with_private_key(KEY2, CONTRACT).unwrap();

        let binding = EnvelopeBinding {
            bot_id: "outside-test",
            vault_address: VAULT,
            chain_id: 31337,
            protocol: "hyperliquid",
        };
        let err = e.verify(&binding, &[a1, a2]).unwrap_err();
        assert!(matches!(err, EnvelopeError::SignerNotInApprovalSet { .. }));
    }

    #[test]
    fn forged_signer_address_rejected() {
        // Signature is real (KEY1) but the `signer` field claims a different address.
        let a1 = signer_address(KEY1);
        let a2 = signer_address(KEY2);
        let mut e = SignedEnvelope {
            version: 2,
            bot_id: "forge-test".into(),
            vault_address: VAULT.into(),
            chain_id: 31337,
            protocol: "hyperliquid".into(),
            policy: test_policy(),
            approval_signers: vec![a1.clone(), a2.clone()],
            min_signatures: 1,
            issued_at: Utc::now().timestamp() as u64,
            expires_at: Utc::now().timestamp() as u64 + 3600,
            nonce: 1,
            verifying_contract: CONTRACT.into(),
            enforcement: None,
            signatures: vec![],
        };
        e.sign_with_private_key(KEY1, CONTRACT).unwrap();
        // tamper with claimed signer
        e.signatures[0].signer = a2.clone();

        let binding = EnvelopeBinding {
            bot_id: "forge-test",
            vault_address: VAULT,
            chain_id: 31337,
            protocol: "hyperliquid",
        };
        let err = e.verify(&binding, &[a1, a2]).unwrap_err();
        assert!(matches!(err, EnvelopeError::SignerMismatch { .. }));
    }

    #[test]
    fn signature_does_not_verify_under_different_verifying_contract() {
        // Sign with one verifying_contract, then mutate it. Recovery
        // will yield a different address than the claimed signer.
        let a1 = signer_address(KEY1);
        let mut e = signed_test_envelope();
        e.verifying_contract = "0x0000000000000000000000000000000000000099".into();
        // signature in `e` was produced under CONTRACT, not the new contract

        let binding = EnvelopeBinding {
            bot_id: "test-bot",
            vault_address: VAULT,
            chain_id: 31337,
            protocol: "hyperliquid",
        };
        let err = e.verify(&binding, &[a1]).unwrap_err();
        assert!(matches!(err, EnvelopeError::SignerMismatch { .. }));
    }

    #[test]
    fn invalid_address_in_approval_signers_returns_400_class_error() {
        let mut e = signed_test_envelope();
        e.approval_signers.push("not-an-address".into());
        let binding = EnvelopeBinding {
            bot_id: "test-bot",
            vault_address: VAULT,
            chain_id: 31337,
            protocol: "hyperliquid",
        };
        // verify() touches policy validation first; the bad address is hit
        // when struct_hash() is called inside digest(). Either path yields
        // an InvalidAddress.
        let err = e.verify(&binding, &[signer_address(KEY1)]).unwrap_err();
        assert!(matches!(err, EnvelopeError::InvalidAddress { .. }));
    }

    #[test]
    fn issued_at_changes_digest() {
        let mut a = signed_test_envelope();
        let mut b = signed_test_envelope();
        a.issued_at = 1;
        b.issued_at = 2;
        assert_ne!(a.digest().unwrap(), b.digest().unwrap());
    }

    #[test]
    fn vault_address_changes_digest() {
        let mut a = signed_test_envelope();
        let mut b = signed_test_envelope();
        a.vault_address = "0x0000000000000000000000000000000000000001".into();
        b.vault_address = "0x0000000000000000000000000000000000000002".into();
        assert_ne!(a.digest().unwrap(), b.digest().unwrap());
    }

    // ── enforcement integration ─────────────────────────────────────────────

    fn sample_enforcement() -> crate::envelope::EnvelopeEnforcement {
        use crate::envelope::{EnvelopeEnforcement, UniswapV3SwapEnforcement};
        use std::str::FromStr;
        EnvelopeEnforcement::UniswapV3Swap(UniswapV3SwapEnforcement {
            router: alloy::primitives::Address::from_str(
                "0xE592427A0AEce92De3Edee1F18E0157C05861564",
            )
            .unwrap(),
            token_in: alloy::primitives::Address::from_str(
                "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            )
            .unwrap(),
            token_out: alloy::primitives::Address::from_str(
                "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            )
            .unwrap(),
            fee_tier: 3000,
            max_single_amount_in: alloy::primitives::U256::from(1_000_000u128),
            max_total_amount_in: alloy::primitives::U256::from(10_000_000u128),
            min_output_per_input: alloy::primitives::U256::from(2_900_000u128),
        })
    }

    #[test]
    fn enforcement_field_changes_digest() {
        let mut a = signed_test_envelope();
        let b = signed_test_envelope();
        a.protocol = "uniswap_v3".into();
        a.enforcement = Some(sample_enforcement());
        // re-sign because mutation changed the digest
        a.signatures.clear();
        a.sign_with_private_key(KEY1, CONTRACT).unwrap();
        assert_ne!(a.digest().unwrap(), b.digest().unwrap());
    }

    #[test]
    fn enforcement_protocol_must_match_envelope_protocol() {
        let mut e = signed_test_envelope();
        // envelope.protocol is "hyperliquid" by default; but enforcement says "uniswap_v3"
        e.enforcement = Some(sample_enforcement());
        e.signatures.clear();
        e.sign_with_private_key(KEY1, CONTRACT).unwrap();
        let trusted = e.approval_signers.clone();
        let binding = EnvelopeBinding {
            bot_id: "test-bot",
            vault_address: VAULT,
            chain_id: 31337,
            protocol: "hyperliquid",
        };
        let err = e.verify(&binding, &trusted).unwrap_err();
        assert!(matches!(
            err,
            EnvelopeError::EnforcementProtocolMismatch { .. }
        ));
    }

    #[test]
    fn enforcement_protocol_aligned_passes() {
        let mut e = signed_test_envelope();
        e.protocol = "uniswap_v3".into();
        e.enforcement = Some(sample_enforcement());
        e.signatures.clear();
        e.sign_with_private_key(KEY1, CONTRACT).unwrap();
        let trusted = e.approval_signers.clone();
        let binding = EnvelopeBinding {
            bot_id: "test-bot",
            vault_address: VAULT,
            chain_id: 31337,
            protocol: "uniswap_v3",
        };
        e.verify(&binding, &trusted).unwrap();
    }

    #[test]
    fn require_enforcement_returns_missing_when_unset() {
        let e = signed_test_envelope();
        assert!(matches!(
            e.require_enforcement().unwrap_err(),
            EnvelopeError::MissingEnforcement
        ));
    }

    #[test]
    fn round_trip_via_serde_preserves_verification() {
        let e = signed_test_envelope();
        let json = serde_json::to_string(&e).unwrap();
        let restored: SignedEnvelope = serde_json::from_str(&json).unwrap();
        let trusted = e.approval_signers.clone();
        let binding = EnvelopeBinding {
            bot_id: "test-bot",
            vault_address: VAULT,
            chain_id: 31337,
            protocol: "hyperliquid",
        };
        restored.verify(&binding, &trusted).unwrap();
    }
}
