// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "./ITradeValidator.sol";

/// @title HyperliquidTradeValidator
/// @notice Lightweight EIP-712 m-of-n verifier for Hyperliquid direct approvals.
/// @dev Uses the same "TradeValidator" v1 EIP-712 domain and direct validation ABI
///      as TradeValidator, but deliberately excludes cross-protocol envelope code so
///      the HyperEVM stack can be deployed under tight per-transaction gas limits.
contract HyperliquidTradeValidator is EIP712, ITradeValidator {
    using ECDSA for bytes32;

    bytes32 public constant VALIDATION_TYPEHASH = keccak256(
        "TradeValidation(bytes32 intentHash,bytes32 executionHash,address vault,uint256 score,uint256 deadline,uint256 actionKind)"
    );

    error InvalidSignatureCount();
    error InsufficientSignatures(uint256 got, uint256 required);
    error DeadlineExpired();
    error VaultNotConfigured(address vault);
    error InvalidRequiredSignatures();
    error ZeroAddress();
    error DuplicateSigner(address signer);
    error WouldBreachThreshold();
    error SignerNotInSet(address signer);
    error InvalidScoreThreshold();
    error NotVaultConfigOwnerOrOwner();
    error NotOwner();

    event VaultConfigured(address indexed vault, uint256 requiredSignatures, uint256 totalSigners);
    event SignerAdded(address indexed vault, address indexed signer);
    event SignerRemoved(address indexed vault, address indexed signer);
    event ScoreThresholdUpdated(address indexed vault, uint256 threshold);
    event VaultConfigOwnerUpdated(address indexed vault, address indexed newOwner);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    struct VaultConfig {
        address[] signers;
        mapping(address signer => bool enabled) isSigner;
        uint256 requiredSignatures;
    }

    mapping(address vault => VaultConfig) private _vaultConfigs;
    mapping(address vault => uint256) public minScoreThreshold;
    mapping(address vault => bool) public thresholdInitialized;
    mapping(address vault => address) public vaultConfigOwner;

    address public owner;
    address public pendingOwner;

    constructor() EIP712("TradeValidator", "1") {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        address previousOwner = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(previousOwner, msg.sender);
    }

    function configureVault(address vault, address[] calldata signers, uint256 requiredSigs) external onlyOwner {
        if (vault == address(0)) revert ZeroAddress();
        if (requiredSigs == 0 || requiredSigs > signers.length) revert InvalidRequiredSignatures();

        VaultConfig storage config = _vaultConfigs[vault];
        uint256 len = config.signers.length;
        for (uint256 i = len; i > 0; i--) {
            address old = config.signers[i - 1];
            config.isSigner[old] = false;
            emit SignerRemoved(vault, old);
        }
        delete config.signers;

        for (uint256 i = 0; i < signers.length; i++) {
            address signer = signers[i];
            if (signer == address(0)) revert ZeroAddress();
            if (config.isSigner[signer]) revert DuplicateSigner(signer);
            config.isSigner[signer] = true;
            config.signers.push(signer);
            emit SignerAdded(vault, signer);
        }

        config.requiredSignatures = requiredSigs;
        if (!thresholdInitialized[vault]) {
            minScoreThreshold[vault] = 50;
            thresholdInitialized[vault] = true;
        }
        vaultConfigOwner[vault] = msg.sender;

        emit VaultConfigured(vault, requiredSigs, signers.length);
    }

    function validateWithSignatures(
        bytes32 intentHash,
        bytes32 executionHash,
        address vault,
        bytes[] calldata signatures,
        uint256[] calldata scores,
        uint256 deadline,
        uint256 actionKind
    ) external view returns (bool approved, uint256 validCount) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (signatures.length != scores.length) revert InvalidSignatureCount();
        if (signatures.length == 0) revert InvalidSignatureCount();

        VaultConfig storage config = _vaultConfigs[vault];
        if (config.requiredSignatures == 0) revert VaultNotConfigured(vault);

        address[] memory seen = new address[](signatures.length);
        uint256 seenCount = 0;
        uint256 scoreSum = 0;

        for (uint256 i = 0; i < signatures.length; i++) {
            bytes32 structHash = keccak256(
                abi.encode(VALIDATION_TYPEHASH, intentHash, executionHash, vault, scores[i], deadline, actionKind)
            );
            address signer = ECDSA.recover(_hashTypedDataV4(structHash), signatures[i]);
            if (!config.isSigner[signer]) continue;

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
            scoreSum += scores[i];
        }

        approved = validCount >= config.requiredSignatures;
        if (approved && validCount > 0) {
            uint256 avgScore = scoreSum / validCount;
            uint256 threshold = minScoreThreshold[vault];
            if (threshold > 0 && avgScore < threshold) approved = false;
        }
    }

    function getVaultSigners(address vault) external view returns (address[] memory) {
        return _vaultConfigs[vault].signers;
    }

    function getRequiredSignatures(address vault) external view returns (uint256) {
        return _vaultConfigs[vault].requiredSignatures;
    }

    function isVaultSigner(address vault, address signer) external view returns (bool) {
        return _vaultConfigs[vault].isSigner[signer];
    }

    function getSignerCount(address vault) external view returns (uint256) {
        return _vaultConfigs[vault].signers.length;
    }

    function computeDigest(
        bytes32 intentHash,
        bytes32 executionHash,
        address vault,
        uint256 score,
        uint256 deadline,
        uint256 actionKind
    ) external view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(VALIDATION_TYPEHASH, intentHash, executionHash, vault, score, deadline, actionKind)
        );
        return _hashTypedDataV4(structHash);
    }
}
