use alloy::primitives::{Address, B256, Signature, U256, keccak256};
use alloy::signers::SignerSync;
use alloy::signers::local::PrivateKeySigner;
use alloy::sol_types::SolValue;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use crate::error::TradingError;
use crate::trading_envelope::TradingEnvelope;

const DOMAIN_NAME: &str = "TradingEnvelope";
const DOMAIN_VERSION: &str = "1";
const ENVELOPE_TYPE: &str = "TradingEnvelope(uint256 version,bytes32 botIdHash,address vault,uint256 chainId,bytes32 protocolHash,bytes32 envelopeHash,uint256 issuedAt,uint256 expiresAt,uint256 nonce,bytes32 approvalSignersHash,uint256 minSignatures)";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvelopeSignature {
    pub signer: String,
    pub signature: String,
    pub chain_id: u64,
    pub verifying_contract: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignedTradingEnvelope {
    #[serde(default = "default_version")]
    pub version: u64,
    pub bot_id: String,
    pub vault_address: String,
    pub chain_id: u64,
    pub protocol: String,
    pub envelope: TradingEnvelope,
    pub approval_signers: Vec<String>,
    pub min_signatures: usize,
    pub issued_at: i64,
    pub expires_at: i64,
    pub nonce: u64,
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

impl SignedTradingEnvelope {
    pub fn verify(
        &self,
        binding: &EnvelopeBinding<'_>,
        trusted_signers: &[String],
    ) -> Result<Vec<Address>, TradingError> {
        self.validate_binding(binding)?;
        self.validate_constraints()?;

        let trusted = parse_address_set(trusted_signers, "trusted envelope signer")?;
        if trusted.is_empty() {
            return Err(TradingError::ValidatorError(
                "No trusted envelope signers configured".into(),
            ));
        }
        let approval = parse_address_set(&self.approval_signers, "envelope approval signer")?;
        let digest = self.digest()?;
        let mut seen = HashSet::new();
        let mut verified = Vec::new();

        for sig in &self.signatures {
            let recovered = recover_signer(sig, digest)?;
            let claimed: Address = sig.signer.parse().map_err(|e| {
                TradingError::ValidatorError(format!("Invalid envelope signer {}: {e}", sig.signer))
            })?;
            if recovered != claimed {
                return Err(TradingError::ValidatorError(
                    "Envelope signature recovered a different signer".into(),
                ));
            }
            if !approval.contains(&recovered) {
                return Err(TradingError::ValidatorError(format!(
                    "Envelope signer {recovered:#x} is not in the approval signer set"
                )));
            }
            if !trusted.contains(&recovered) {
                return Err(TradingError::ValidatorError(format!(
                    "Envelope signer {recovered:#x} is not trusted by this operator"
                )));
            }
            if seen.insert(recovered) {
                verified.push(recovered);
            }
        }

        if verified.len() < self.min_signatures {
            return Err(TradingError::ValidatorError(format!(
                "Envelope has {} unique trusted signatures, requires {}",
                verified.len(),
                self.min_signatures
            )));
        }

        Ok(verified)
    }

    pub fn digest(&self) -> Result<B256, TradingError> {
        let sig = self
            .signatures
            .first()
            .ok_or_else(|| TradingError::ValidatorError("Envelope has no signatures".into()))?;
        self.approval_digest(sig.chain_id, &sig.verifying_contract)
    }

    pub fn approval_digest(
        &self,
        chain_id: u64,
        verifying_contract: &str,
    ) -> Result<B256, TradingError> {
        let verifying_contract: Address = verifying_contract.parse().map_err(|e| {
            TradingError::ValidatorError(format!(
                "Invalid envelope verifying_contract {verifying_contract}: {e}"
            ))
        })?;
        Ok(eip712_digest(
            domain_separator(chain_id, verifying_contract),
            self.struct_hash()?,
        ))
    }

    pub fn sign_with_private_key(
        &mut self,
        private_key: &str,
        chain_id: u64,
        verifying_contract: &str,
    ) -> Result<String, TradingError> {
        let signer: PrivateKeySigner = private_key.parse().map_err(|e| {
            TradingError::ValidatorError(format!("Invalid envelope signer key: {e}"))
        })?;
        let signer_address = format!("{:#x}", signer.address());
        let digest = self.approval_digest(chain_id, verifying_contract)?;
        let signature = signer
            .sign_hash_sync(&digest)
            .map_err(|e| TradingError::ValidatorError(format!("Envelope signing failed: {e}")))?;
        self.signatures.push(EnvelopeSignature {
            signer: signer_address.clone(),
            signature: format!("0x{}", hex::encode(signature.as_bytes())),
            chain_id,
            verifying_contract: verifying_contract.to_string(),
        });
        Ok(signer_address)
    }

    fn struct_hash(&self) -> Result<B256, TradingError> {
        let vault: Address = self.vault_address.parse().map_err(|e| {
            TradingError::ValidatorError(format!("Invalid envelope vault_address: {e}"))
        })?;
        Ok(keccak256(SolValue::abi_encode(&(
            keccak256(ENVELOPE_TYPE.as_bytes()),
            U256::from(self.version),
            keccak256(self.bot_id.as_bytes()),
            vault,
            U256::from(self.chain_id),
            keccak256(self.protocol.to_ascii_lowercase().as_bytes()),
            self.envelope_hash()?,
            U256::from(self.issued_at.max(0) as u64),
            U256::from(self.expires_at.max(0) as u64),
            U256::from(self.nonce),
            hash_addresses(&self.approval_signers)?,
            U256::from(self.min_signatures),
        ))))
    }

    fn envelope_hash(&self) -> Result<B256, TradingError> {
        let json = serde_json::to_vec(&self.envelope).map_err(|e| {
            TradingError::ValidatorError(format!("Failed to hash envelope policy: {e}"))
        })?;
        Ok(keccak256(json))
    }

    fn validate_binding(&self, binding: &EnvelopeBinding<'_>) -> Result<(), TradingError> {
        if self.bot_id != binding.bot_id {
            return Err(TradingError::ValidatorError(
                "Envelope bot_id does not match authenticated bot".into(),
            ));
        }
        if !addresses_equal(&self.vault_address, binding.vault_address)? {
            return Err(TradingError::ValidatorError(
                "Envelope vault_address does not match authenticated bot".into(),
            ));
        }
        if self.chain_id != binding.chain_id {
            return Err(TradingError::ValidatorError(
                "Envelope chain_id does not match authenticated bot".into(),
            ));
        }
        if !self
            .protocol
            .trim()
            .eq_ignore_ascii_case(binding.protocol.trim())
        {
            return Err(TradingError::ValidatorError(
                "Envelope protocol does not match execution protocol".into(),
            ));
        }
        Ok(())
    }

    fn validate_constraints(&self) -> Result<(), TradingError> {
        if self.version != 1 || self.min_signatures == 0 || self.approval_signers.is_empty() {
            return Err(TradingError::ValidatorError(
                "Envelope version, signer set, and min_signatures must be valid".into(),
            ));
        }
        if self.min_signatures > self.approval_signers.len() {
            return Err(TradingError::ValidatorError(
                "Envelope min_signatures exceeds approval signer set".into(),
            ));
        }
        if self.expires_at <= 0 || self.expires_at < chrono::Utc::now().timestamp() {
            return Err(TradingError::ValidatorError(
                "Envelope is expired or missing expires_at".into(),
            ));
        }
        if self.envelope.allowed_assets.is_empty()
            || self.envelope.max_position_usd <= 0.0
            || self.envelope.max_total_exposure_usd <= 0.0
            || self.envelope.max_leverage == 0
            || self.envelope.max_drawdown_pct <= 0.0
            || self.envelope.max_drawdown_pct > 1.0
            || self.envelope.min_stop_loss_distance <= 0.0
            || self.envelope.max_stop_loss_distance <= 0.0
            || self.envelope.min_stop_loss_distance > self.envelope.max_stop_loss_distance
        {
            return Err(TradingError::ValidatorError(
                "Envelope policy limits are invalid".into(),
            ));
        }
        Ok(())
    }
}

fn default_version() -> u64 {
    1
}

fn domain_separator(chain_id: u64, verifying_contract: Address) -> B256 {
    keccak256(SolValue::abi_encode(&(
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
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

fn recover_signer(sig: &EnvelopeSignature, digest: B256) -> Result<Address, TradingError> {
    let raw = sig.signature.strip_prefix("0x").unwrap_or(&sig.signature);
    let bytes = hex::decode(raw).map_err(|e| {
        TradingError::ValidatorError(format!("Invalid envelope signature hex: {e}"))
    })?;
    if bytes.len() != 65 {
        return Err(TradingError::ValidatorError(format!(
            "Envelope signature must be 65 bytes, got {}",
            bytes.len()
        )));
    }
    let parity = if bytes[64] >= 27 {
        (bytes[64] - 27) == 1
    } else {
        bytes[64] == 1
    };
    Signature::from_bytes_and_parity(&bytes[..64], parity)
        .recover_address_from_prehash(&digest)
        .map_err(|e| {
            TradingError::ValidatorError(format!("Envelope signature recovery failed: {e}"))
        })
}

fn hash_addresses(values: &[String]) -> Result<B256, TradingError> {
    let mut addresses = values
        .iter()
        .map(|value| {
            value
                .parse::<Address>()
                .map(|address| format!("{address:#x}"))
                .map_err(|e| TradingError::ValidatorError(format!("Invalid signer {value}: {e}")))
        })
        .collect::<Result<Vec<_>, _>>()?;
    addresses.sort();
    Ok(keccak256(addresses.join("\n").as_bytes()))
}

fn parse_address_set(values: &[String], label: &str) -> Result<HashSet<Address>, TradingError> {
    values
        .iter()
        .map(|value| {
            value.parse().map_err(|e| {
                TradingError::ValidatorError(format!("Invalid {label} address {value}: {e}"))
            })
        })
        .collect()
}

fn addresses_equal(left: &str, right: &str) -> Result<bool, TradingError> {
    let left: Address = left.parse().map_err(|e| {
        TradingError::ValidatorError(format!("Invalid envelope address {left}: {e}"))
    })?;
    let right: Address = right.parse().map_err(|e| {
        TradingError::ValidatorError(format!("Invalid expected address {right}: {e}"))
    })?;
    Ok(left == right)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signed_test_envelope() -> SignedTradingEnvelope {
        let mut signed = SignedTradingEnvelope {
            version: 1,
            bot_id: "bot-envelope".into(),
            vault_address: "0x0000000000000000000000000000000000000001".into(),
            chain_id: 31337,
            protocol: "hyperliquid".into(),
            envelope: TradingEnvelope {
                expires_at: chrono::Utc::now().timestamp() + 3600,
                ..Default::default()
            },
            approval_signers: vec![],
            min_signatures: 1,
            issued_at: chrono::Utc::now().timestamp(),
            expires_at: chrono::Utc::now().timestamp() + 3600,
            nonce: 42,
            signatures: vec![],
        };
        let signer = signed
            .sign_with_private_key(
                "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
                31337,
                "0x5FbDB2315678afecb367f032d93F642f64180aa3",
            )
            .unwrap();
        signed.approval_signers = vec![signer];
        signed.signatures.clear();
        let signer = signed
            .sign_with_private_key(
                "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
                31337,
                "0x5FbDB2315678afecb367f032d93F642f64180aa3",
            )
            .unwrap();
        signed.approval_signers = vec![signer];
        signed
    }

    #[test]
    fn signed_envelope_verifies_for_bound_bot() {
        let signed = signed_test_envelope();
        let trusted = signed.approval_signers.clone();
        let binding = EnvelopeBinding {
            bot_id: "bot-envelope",
            vault_address: "0x0000000000000000000000000000000000000001",
            chain_id: 31337,
            protocol: "hyperliquid",
        };
        assert_eq!(signed.verify(&binding, &trusted).unwrap().len(), 1);
    }

    #[test]
    fn signed_envelope_rejects_cross_bot_replay() {
        let signed = signed_test_envelope();
        let trusted = signed.approval_signers.clone();
        let binding = EnvelopeBinding {
            bot_id: "other-bot",
            vault_address: "0x0000000000000000000000000000000000000001",
            chain_id: 31337,
            protocol: "hyperliquid",
        };
        assert!(
            signed
                .verify(&binding, &trusted)
                .unwrap_err()
                .to_string()
                .contains("bot_id")
        );
    }
}
