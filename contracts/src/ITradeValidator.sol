// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ITradeValidator {
    function configureVault(address vault, address[] calldata signers, uint256 requiredSigs) external;
    function transferOwnership(address newOwner) external;
    function acceptOwnership() external;
    function owner() external view returns (address);
    function getRequiredSignatures(address vault) external view returns (uint256);
    function isVaultSigner(address vault, address signer) external view returns (bool);
    function getSignerCount(address vault) external view returns (uint256);
    function getVaultSigners(address vault) external view returns (address[] memory);
    function validateWithSignatures(
        bytes32 intentHash,
        bytes32 executionHash,
        address vault,
        bytes[] calldata signatures,
        uint256[] calldata scores,
        uint256 deadline,
        uint256 actionKind
    ) external view returns (bool approved, uint256 validCount);
    function computeDigest(
        bytes32 intentHash,
        bytes32 executionHash,
        address vault,
        uint256 score,
        uint256 deadline,
        uint256 actionKind
    ) external view returns (bytes32);
}
