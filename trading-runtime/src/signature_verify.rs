//! EIP-712 signature verification for validator trade approvals.
//!
//! Mirrors the signing logic in `trading-validator-lib/src/signer.rs` to
//! recover the signer address from a 65-byte EIP-712 signature and verify
//! it matches the claimed validator address.

use alloy::primitives::{Address, B256, Signature, U256, keccak256};

use crate::error::TradingError;
use crate::types::ValidatorResponse;

/// EIP-712 domain constants — must match `trading-validator-lib/src/signer.rs`
/// and the Solidity TradeValidator contract.
const DOMAIN_NAME: &str = "TradeValidator";
const DOMAIN_VERSION: &str = "1";

/// Must match Solidity:
/// `keccak256("TradeValidation(bytes32 intentHash,address vault,uint256 score,uint256 deadline)")`
fn validation_typehash() -> B256 {
    keccak256("TradeValidation(bytes32 intentHash,address vault,uint256 score,uint256 deadline)")
}

/// Compute the EIP-712 domain separator.
///
/// ```text
/// domainSeparator = keccak256(abi.encode(
///     EIP712_DOMAIN_TYPEHASH,
///     keccak256(bytes(name)),
///     keccak256(bytes(version)),
///     chainId,
///     verifyingContract
/// ))
/// ```
fn compute_domain_separator(chain_id: u64, verifying_contract: Address) -> B256 {
    let type_hash = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
    );
    let name_hash = keccak256(DOMAIN_NAME.as_bytes());
    let version_hash = keccak256(DOMAIN_VERSION.as_bytes());

    keccak256(
        [
            type_hash.as_slice(),
            name_hash.as_slice(),
            version_hash.as_slice(),
            &U256::from(chain_id).to_be_bytes::<32>(),
            &B256::left_padding_from(verifying_contract.as_slice()).0,
        ]
        .concat(),
    )
}

/// Compute the EIP-712 struct hash for a trade validation.
fn compute_struct_hash(intent_hash: B256, vault: Address, score: u64, deadline: u64) -> B256 {
    keccak256(
        [
            validation_typehash().as_slice(),
            intent_hash.as_slice(),
            &B256::left_padding_from(vault.as_slice()).0,
            &U256::from(score).to_be_bytes::<32>(),
            &U256::from(deadline).to_be_bytes::<32>(),
        ]
        .concat(),
    )
}

/// Compute the full EIP-712 digest: `keccak256("\x19\x01" || domainSeparator || structHash)`
fn compute_eip712_digest(domain_separator: B256, struct_hash: B256) -> B256 {
    keccak256(
        [
            [0x19u8, 0x01].as_slice(),
            domain_separator.as_slice(),
            struct_hash.as_slice(),
        ]
        .concat(),
    )
}

/// Verify a single validator's EIP-712 signature.
///
/// Returns the recovered signer address on success.
///
/// Parameters:
/// - `response`: The validator response containing the signature and claimed validator address
/// - `intent_hash_hex`: The hex-encoded (0x-prefixed) intent hash
/// - `vault_address`: The vault address used in the EIP-712 domain
/// - `deadline`: The Unix timestamp deadline signed over
///
/// The `chain_id` and `verifying_contract` are taken from the validator response
/// (set by the validator signer during validation). If not present, verification
/// fails because the domain cannot be reconstructed.
pub fn verify_validator_signature(
    response: &ValidatorResponse,
    intent_hash_hex: &str,
    vault_address: &str,
    deadline: u64,
) -> Result<Address, TradingError> {
    // Check deadline expiry
    {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        if deadline < now {
            return Err(TradingError::ValidatorError(format!(
                "Signature expired: deadline {} < now {}",
                deadline, now
            )));
        }
    }

    // Parse chain_id and verifying_contract from the response
    let chain_id = response.chain_id.ok_or_else(|| {
        TradingError::ValidatorError(format!(
            "Validator {} did not provide chain_id for EIP-712 verification",
            response.validator
        ))
    })?;

    let verifying_contract_str = response.verifying_contract.as_deref().ok_or_else(|| {
        TradingError::ValidatorError(format!(
            "Validator {} did not provide verifying_contract for EIP-712 verification",
            response.validator
        ))
    })?;

    let verifying_contract: Address = verifying_contract_str.parse().map_err(|e| {
        TradingError::ValidatorError(format!(
            "Invalid verifying_contract from {}: {e}",
            response.validator
        ))
    })?;

    // Parse intent hash
    let intent_hash_stripped = intent_hash_hex
        .strip_prefix("0x")
        .unwrap_or(intent_hash_hex);
    let intent_hash_bytes = hex::decode(intent_hash_stripped).map_err(|e| {
        TradingError::ValidatorError(format!("Invalid intent_hash hex: {e}"))
    })?;
    if intent_hash_bytes.len() != 32 {
        return Err(TradingError::ValidatorError(format!(
            "intent_hash must be 32 bytes, got {}",
            intent_hash_bytes.len()
        )));
    }
    let intent_hash = B256::from_slice(&intent_hash_bytes);

    // Parse vault address
    let vault: Address = vault_address.parse().map_err(|e| {
        TradingError::ValidatorError(format!("Invalid vault_address: {e}"))
    })?;

    // Parse signature (65 bytes: r[32] || s[32] || v[1])
    let sig_hex = response
        .signature
        .strip_prefix("0x")
        .unwrap_or(&response.signature);
    let sig_bytes = hex::decode(sig_hex).map_err(|e| {
        TradingError::ValidatorError(format!(
            "Invalid signature hex from {}: {e}",
            response.validator
        ))
    })?;
    if sig_bytes.len() != 65 {
        return Err(TradingError::ValidatorError(format!(
            "Signature from {} must be 65 bytes, got {}",
            response.validator,
            sig_bytes.len()
        )));
    }

    // Compute the EIP-712 digest
    let domain_separator = compute_domain_separator(chain_id, verifying_contract);
    let struct_hash = compute_struct_hash(intent_hash, vault, response.score as u64, deadline);
    let digest = compute_eip712_digest(domain_separator, struct_hash);

    // Recover signer from signature.
    // alloy Signature expects v as bool parity (true = odd/1, false = even/0),
    // but EIP-712 sigs use 27 or 28.
    let v_byte = sig_bytes[64];
    let parity = if v_byte >= 27 {
        (v_byte - 27) == 1
    } else {
        v_byte == 1
    };

    let signature = Signature::from_bytes_and_parity(&sig_bytes[..64], parity);

    let recovered = signature
        .recover_address_from_prehash(&digest)
        .map_err(|e| {
            TradingError::ValidatorError(format!(
                "Signature recovery failed for {}: {e}",
                response.validator
            ))
        })?;

    // Verify recovered address matches the claimed validator address
    let claimed: Address = response.validator.parse().map_err(|e| {
        TradingError::ValidatorError(format!(
            "Invalid validator address {}: {e}",
            response.validator
        ))
    })?;

    if recovered != claimed {
        return Err(TradingError::ValidatorError(format!(
            "Signature mismatch for validator {}: recovered {recovered:#x}, claimed {claimed:#x}",
            response.validator
        )));
    }

    Ok(recovered)
}

/// Verify all validator signatures in a validation payload.
///
/// For real (non-paper) execution, ALL signatures must be valid EIP-712 signatures
/// that recover to the claimed validator address.
///
/// Returns the list of verified signer addresses on success.
pub fn verify_all_signatures(
    responses: &[ValidatorResponse],
    intent_hash: &str,
    vault_address: &str,
    deadline: u64,
) -> Result<Vec<Address>, TradingError> {
    if responses.is_empty() {
        return Err(TradingError::ValidatorError(
            "No validator responses to verify".into(),
        ));
    }

    let mut verified = Vec::with_capacity(responses.len());
    for response in responses {
        let addr = verify_validator_signature(response, intent_hash, vault_address, deadline)?;
        verified.push(addr);
    }

    Ok(verified)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ValidatorResponse;

    /// Validate that domain separator computation matches the validator signer.
    #[test]
    fn test_domain_separator_deterministic() {
        let contract: Address = "0x5FbDB2315678afecb367f032d93F642f64180aa3"
            .parse()
            .unwrap();
        let ds1 = compute_domain_separator(31337, contract);
        let ds2 = compute_domain_separator(31337, contract);
        assert_eq!(ds1, ds2);
    }

    /// Validate struct hash computation is deterministic.
    #[test]
    fn test_struct_hash_deterministic() {
        let vault: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
            .parse()
            .unwrap();
        let intent_hash = B256::ZERO;
        let sh1 = compute_struct_hash(intent_hash, vault, 85, 9999999999);
        let sh2 = compute_struct_hash(intent_hash, vault, 85, 9999999999);
        assert_eq!(sh1, sh2);
    }

    /// End-to-end: sign with validator signer, verify with our verifier.
    /// This test requires `trading-validator-lib` which is a dev-dependency.
    #[test]
    fn test_verify_signature_from_validator_signer() {
        // Use the same test key as trading-validator-lib
        let private_key = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
        let contract_addr: Address = "0x5FbDB2315678afecb367f032d93F642f64180aa3"
            .parse()
            .unwrap();
        let chain_id = 31337u64;

        let signer =
            trading_validator_lib::signer::ValidatorSigner::new(private_key, chain_id, contract_addr)
                .unwrap();

        let intent_hash = keccak256("test-intent-for-verify");
        let vault: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
            .parse()
            .unwrap();
        let score = 85u64;
        let deadline = 9999999999u64;

        let (sig_bytes, addr) = signer
            .sign_validation(intent_hash, vault, score, deadline)
            .unwrap();

        // Build a ValidatorResponse as the execute endpoint would receive it
        let response = ValidatorResponse {
            validator: format!("{addr:#x}"),
            score: score as u32,
            signature: format!("0x{}", hex::encode(sig_bytes)),
            reasoning: "test".into(),
            chain_id: Some(chain_id),
            verifying_contract: Some(format!("{contract_addr:#x}")),
            validated_at: None,
        };

        let intent_hash_hex = format!("0x{}", hex::encode(intent_hash));
        let vault_str = format!("{vault:#x}");

        let recovered =
            verify_validator_signature(&response, &intent_hash_hex, &vault_str, deadline).unwrap();
        assert_eq!(recovered, addr);
    }

    /// Test that a tampered signature is rejected.
    #[test]
    fn test_reject_tampered_signature() {
        let response = ValidatorResponse {
            validator: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266".into(),
            score: 85,
            signature: format!("0x{}", "ab".repeat(65)),
            reasoning: "test".into(),
            chain_id: Some(31337),
            verifying_contract: Some(
                "0x5FbDB2315678afecb367f032d93F642f64180aa3".into(),
            ),
            validated_at: None,
        };

        let intent_hash = format!("0x{}", "cc".repeat(32));
        let vault = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

        let result = verify_validator_signature(&response, &intent_hash, vault, 9999999999);
        assert!(result.is_err(), "Tampered signature should be rejected");
    }

    /// Test that missing chain_id fails verification.
    #[test]
    fn test_reject_missing_chain_id() {
        let response = ValidatorResponse {
            validator: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266".into(),
            score: 85,
            signature: format!("0x{}", "ab".repeat(65)),
            reasoning: "test".into(),
            chain_id: None,
            verifying_contract: Some(
                "0x5FbDB2315678afecb367f032d93F642f64180aa3".into(),
            ),
            validated_at: None,
        };

        let intent_hash = format!("0x{}", "cc".repeat(32));
        let vault = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

        let result = verify_validator_signature(&response, &intent_hash, vault, 9999999999);
        assert!(result.is_err(), "Missing chain_id should fail");
    }

    /// Test verify_all_signatures with empty list.
    #[test]
    fn test_verify_all_empty_fails() {
        let result = verify_all_signatures(
            &[],
            "0x0000000000000000000000000000000000000000000000000000000000000000",
            "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
            9999999999,
        );
        assert!(result.is_err());
    }
}
