use alloy::primitives::{keccak256, Address, B256, U256};
use alloy::signers::local::PrivateKeySigner;
use alloy::signers::SignerSync;

/// EIP-712 domain constants for TradeValidator contract
const DOMAIN_NAME: &str = "TradeValidator";
const DOMAIN_VERSION: &str = "1";

/// Must match Solidity: keccak256("TradeValidation(bytes32 intentHash,address vault,uint256 score,uint256 deadline)")
fn validation_typehash() -> B256 {
    keccak256("TradeValidation(bytes32 intentHash,address vault,uint256 score,uint256 deadline)")
}

/// EIP-712 signer for the TradeValidator contract.
///
/// Computes EIP-712 typed data hashes manually and signs them using a local private key.
/// The domain separator and struct hash are constructed to match the Solidity contract's
/// `abi.encode` behavior (all values padded to 32 bytes).
#[derive(Debug)]
pub struct ValidatorSigner {
    signer: PrivateKeySigner,
    chain_id: u64,
    verifying_contract: Address,
}

impl ValidatorSigner {
    /// Create a new ValidatorSigner from a hex-encoded private key.
    ///
    /// The `private_key` should be a 64-character hex string, optionally prefixed with "0x".
    pub fn new(
        private_key: &str,
        chain_id: u64,
        verifying_contract: Address,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let signer: PrivateKeySigner = private_key.parse()?;
        Ok(Self {
            signer,
            chain_id,
            verifying_contract,
        })
    }

    /// Returns the Ethereum address of this signer.
    pub fn address(&self) -> Address {
        self.signer.address()
    }

    /// Sign a trade validation using EIP-712 typed data.
    ///
    /// Returns the 65-byte signature (r, s, v) and the signer's address.
    pub fn sign_validation(
        &self,
        intent_hash: B256,
        vault: Address,
        score: u64,
        deadline: u64,
    ) -> Result<([u8; 65], Address), Box<dyn std::error::Error + Send + Sync>> {
        // Build struct hash: keccak256(abi.encode(TYPEHASH, intentHash, vault, score, deadline))
        // Solidity abi.encode pads each value to 32 bytes
        let struct_hash = keccak256(
            [
                validation_typehash().as_slice(),
                intent_hash.as_slice(),
                &B256::left_padding_from(vault.as_slice()).0,
                &U256::from(score).to_be_bytes::<32>(),
                &U256::from(deadline).to_be_bytes::<32>(),
            ]
            .concat(),
        );

        // Build EIP-712 domain separator
        let domain_separator = self.compute_domain_separator();

        // Build final digest: keccak256("\x19\x01" || domainSeparator || structHash)
        let digest = keccak256(
            [
                [0x19u8, 0x01].as_slice(),
                domain_separator.as_slice(),
                struct_hash.as_slice(),
            ]
            .concat(),
        );

        // Sign the digest synchronously (PrivateKeySigner supports SignerSync)
        let signature = self.signer.sign_hash_sync(&digest)?;
        let sig_bytes = signature.as_bytes();

        Ok((sig_bytes, self.signer.address()))
    }

    /// Compute the EIP-712 domain separator matching the Solidity contract.
    ///
    /// domainSeparator = keccak256(abi.encode(
    ///     EIP712_DOMAIN_TYPEHASH,
    ///     keccak256(bytes(name)),
    ///     keccak256(bytes(version)),
    ///     chainId,
    ///     verifyingContract
    /// ))
    fn compute_domain_separator(&self) -> B256 {
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
                &U256::from(self.chain_id).to_be_bytes::<32>(),
                &B256::left_padding_from(self.verifying_contract.as_slice()).0,
            ]
            .concat(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Well-known test private key (do NOT use in production)
    const TEST_PRIVATE_KEY: &str =
        "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

    #[test]
    fn test_signer_creation() {
        let contract_addr: Address = "0x5FbDB2315678afecb367f032d93F642f64180aa3"
            .parse()
            .unwrap();
        let signer = ValidatorSigner::new(TEST_PRIVATE_KEY, 31337, contract_addr).unwrap();

        // Hardhat account 0 address
        let expected_addr: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
            .parse()
            .unwrap();
        assert_eq!(signer.address(), expected_addr);
    }

    #[test]
    fn test_sign_validation_produces_65_bytes() {
        let contract_addr: Address = "0x5FbDB2315678afecb367f032d93F642f64180aa3"
            .parse()
            .unwrap();
        let signer = ValidatorSigner::new(TEST_PRIVATE_KEY, 31337, contract_addr).unwrap();

        let intent_hash = B256::ZERO;
        let vault: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
            .parse()
            .unwrap();

        let (sig_bytes, addr) = signer.sign_validation(intent_hash, vault, 85, 9999999999).unwrap();
        assert_eq!(sig_bytes.len(), 65);
        assert_eq!(addr, signer.address());

        // v should be 27 or 28
        assert!(sig_bytes[64] == 27 || sig_bytes[64] == 28);
    }

    #[test]
    fn test_sign_validation_deterministic() {
        let contract_addr: Address = "0x5FbDB2315678afecb367f032d93F642f64180aa3"
            .parse()
            .unwrap();
        let signer = ValidatorSigner::new(TEST_PRIVATE_KEY, 31337, contract_addr).unwrap();

        let intent_hash = keccak256("test-intent");
        let vault: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
            .parse()
            .unwrap();

        let (sig1, _) = signer.sign_validation(intent_hash, vault, 85, 1000000).unwrap();
        let (sig2, _) = signer.sign_validation(intent_hash, vault, 85, 1000000).unwrap();
        assert_eq!(sig1, sig2, "Signatures should be deterministic for same input");
    }

    #[test]
    fn test_different_inputs_produce_different_signatures() {
        let contract_addr: Address = "0x5FbDB2315678afecb367f032d93F642f64180aa3"
            .parse()
            .unwrap();
        let signer = ValidatorSigner::new(TEST_PRIVATE_KEY, 31337, contract_addr).unwrap();

        let vault: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
            .parse()
            .unwrap();

        let (sig1, _) = signer
            .sign_validation(keccak256("intent-a"), vault, 85, 1000000)
            .unwrap();
        let (sig2, _) = signer
            .sign_validation(keccak256("intent-b"), vault, 85, 1000000)
            .unwrap();
        assert_ne!(sig1, sig2, "Different inputs should produce different signatures");
    }
}
