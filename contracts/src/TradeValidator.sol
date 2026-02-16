// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/// @title TradeValidator
/// @notice EIP-712 signature verification with per-vault m-of-n signer configuration
/// @dev Score IS part of the signed data to prevent score manipulation attacks.
///      Validators are modular — configured per vault instance, don't need to know
///      about blueprint operators. Each vault has its own signer set and threshold.
contract TradeValidator is EIP712, Ownable2Step {
    using ECDSA for bytes32;
    using EnumerableSet for EnumerableSet.AddressSet;

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice EIP-712 type hash for trade validation signatures
    /// @dev Score is included in signed data to prevent manipulation
    bytes32 public constant VALIDATION_TYPEHASH = keccak256(
        "TradeValidation(bytes32 intentHash,address vault,uint256 score,uint256 deadline)"
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════

    error InvalidSignatureCount();
    error InsufficientSignatures(uint256 got, uint256 required);
    error DeadlineExpired();
    error VaultNotConfigured(address vault);
    error InvalidRequiredSignatures();
    error ZeroAddress();
    error DuplicateSigner(address signer);

    // ═══════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════

    event VaultConfigured(address indexed vault, uint256 requiredSignatures, uint256 totalSigners);
    event SignerAdded(address indexed vault, address indexed signer);
    event SignerRemoved(address indexed vault, address indexed signer);
    event TradeValidated(bytes32 indexed intentHash, address indexed vault, bool approved, uint256 validSignatures);

    // ═══════════════════════════════════════════════════════════════════════════
    // TYPES
    // ═══════════════════════════════════════════════════════════════════════════

    struct VaultConfig {
        EnumerableSet.AddressSet signers;
        uint256 requiredSignatures;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Per-vault signer configuration
    mapping(address vault => VaultConfig) private _vaultConfigs;

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════

    constructor() EIP712("TradeValidator", "1") Ownable(msg.sender) {}

    // ═══════════════════════════════════════════════════════════════════════════
    // VAULT CONFIGURATION
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Configure the signer set and threshold for a vault
    /// @param vault The vault address to configure
    /// @param signers Array of authorized signer addresses
    /// @param requiredSigs Minimum number of valid signatures required (m in m-of-n)
    function configureVault(
        address vault,
        address[] calldata signers,
        uint256 requiredSigs
    ) external onlyOwner {
        if (vault == address(0)) revert ZeroAddress();
        if (requiredSigs == 0 || requiredSigs > signers.length) revert InvalidRequiredSignatures();

        VaultConfig storage config = _vaultConfigs[vault];

        // Clear existing signers
        uint256 len = config.signers.length();
        for (uint256 i = len; i > 0; i--) {
            address old = config.signers.at(i - 1);
            config.signers.remove(old);
            emit SignerRemoved(vault, old);
        }

        // Add new signers (check for duplicates)
        for (uint256 i = 0; i < signers.length; i++) {
            if (signers[i] == address(0)) revert ZeroAddress();
            bool added = config.signers.add(signers[i]);
            if (!added) revert DuplicateSigner(signers[i]);
            emit SignerAdded(vault, signers[i]);
        }

        config.requiredSignatures = requiredSigs;
        emit VaultConfigured(vault, requiredSigs, signers.length);
    }

    /// @notice Add a single signer to a vault's signer set
    function addSigner(address vault, address signer) external onlyOwner {
        if (signer == address(0)) revert ZeroAddress();
        VaultConfig storage config = _vaultConfigs[vault];
        bool added = config.signers.add(signer);
        if (!added) revert DuplicateSigner(signer);
        emit SignerAdded(vault, signer);
    }

    /// @notice Remove a single signer from a vault's signer set
    function removeSigner(address vault, address signer) external onlyOwner {
        VaultConfig storage config = _vaultConfigs[vault];
        config.signers.remove(signer);
        emit SignerRemoved(vault, signer);
    }

    /// @notice Update the required signature count for a vault
    function setRequiredSignatures(address vault, uint256 requiredSigs) external onlyOwner {
        VaultConfig storage config = _vaultConfigs[vault];
        if (requiredSigs == 0 || requiredSigs > config.signers.length()) {
            revert InvalidRequiredSignatures();
        }
        config.requiredSignatures = requiredSigs;
        emit VaultConfigured(vault, requiredSigs, config.signers.length());
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // VALIDATION
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Validate a trade intent by verifying m-of-n EIP-712 signatures
    /// @param intentHash The keccak256 hash of the trade intent
    /// @param vault The vault this trade is for
    /// @param signatures Array of EIP-712 signatures from validators
    /// @param scores Array of validator scores (each score is signed as part of EIP-712 data)
    /// @param deadline Timestamp after which signatures are invalid
    /// @return approved Whether enough valid signatures were collected
    /// @return validCount Number of valid signatures from authorized signers
    function validateWithSignatures(
        bytes32 intentHash,
        address vault,
        bytes[] calldata signatures,
        uint256[] calldata scores,
        uint256 deadline
    ) external view returns (bool approved, uint256 validCount) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (signatures.length != scores.length) revert InvalidSignatureCount();
        if (signatures.length == 0) revert InvalidSignatureCount();

        VaultConfig storage config = _vaultConfigs[vault];
        if (config.requiredSignatures == 0) revert VaultNotConfigured(vault);

        // Track which signers we've already counted to prevent double-use
        address[] memory seen = new address[](signatures.length);
        uint256 seenCount = 0;

        for (uint256 i = 0; i < signatures.length; i++) {
            // Build the EIP-712 struct hash with the score INSIDE the signed data
            bytes32 structHash = keccak256(abi.encode(
                VALIDATION_TYPEHASH,
                intentHash,
                vault,
                scores[i],
                deadline
            ));

            bytes32 digest = _hashTypedDataV4(structHash);
            address signer = ECDSA.recover(digest, signatures[i]);

            // Check signer is in the vault's authorized set
            if (!config.signers.contains(signer)) continue;

            // Prevent double-counting the same signer
            bool duplicate = false;
            for (uint256 j = 0; j < seenCount; j++) {
                if (seen[j] == signer) {
                    duplicate = true;
                    break;
                }
            }
            if (duplicate) continue;

            seen[seenCount] = signer;
            seenCount++;
            validCount++;
        }

        approved = validCount >= config.requiredSignatures;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // VIEW
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Get all signers for a vault
    function getVaultSigners(address vault) external view returns (address[] memory) {
        return _vaultConfigs[vault].signers.values();
    }

    /// @notice Get the required signature count for a vault
    function getRequiredSignatures(address vault) external view returns (uint256) {
        return _vaultConfigs[vault].requiredSignatures;
    }

    /// @notice Check if an address is an authorized signer for a vault
    function isVaultSigner(address vault, address signer) external view returns (bool) {
        return _vaultConfigs[vault].signers.contains(signer);
    }

    /// @notice Get the total number of signers for a vault
    function getSignerCount(address vault) external view returns (uint256) {
        return _vaultConfigs[vault].signers.length();
    }

    /// @notice Compute the EIP-712 digest for a trade validation (useful for off-chain signing)
    function computeDigest(
        bytes32 intentHash,
        address vault,
        uint256 score,
        uint256 deadline
    ) external view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            VALIDATION_TYPEHASH,
            intentHash,
            vault,
            score,
            deadline
        ));
        return _hashTypedDataV4(structHash);
    }

    /// @notice Get the EIP-712 domain separator (useful for off-chain tooling)
    function getDomainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
