// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IAssetValuator.sol";

/// @title VaultStorage
/// @notice ERC-7201 namespaced storage layout for `TradingVault`.
///
/// Splitting the vault into a small core + several external libraries (one
/// DELEGATECALL hop apart) only works if every actor agrees on the storage
/// layout. Putting all mutable state behind a single struct anchored at a
/// deterministic slot means the vault and every library see the same fields
/// at the same offsets — no per-function storage-ref threading, no
/// silently-shifting slot indices when fields are added or reordered.
///
/// The slot is derived per ERC-7201:
///   keccak256(abi.encode(uint256(keccak256("tangle.trading.vault.main")) - 1))
///   & ~bytes32(uint256(0xff))
///
/// Recompute via `cast index uint256 $(cast keccak "tangle.trading.vault.main") - 1`
/// then bitwise-and with `~0xff` if the constant ever needs to change.
library VaultStorage {
    /// @dev Single source of truth for vault state. Order is locked-in
    /// once the contract ships — append-only.
    struct Data {
        // ── Trade dedup + wind-down ──────────────────────────────────────
        mapping(bytes32 => bool) executedIntents;
        bool windDownActive;
        uint256 windDownStartedAt;
        // ── Deposit lockup ───────────────────────────────────────────────
        uint256 depositLockupDuration;
        mapping(address => uint256) lastDepositTime;
        // ── Multi-asset NAV ──────────────────────────────────────────────
        address[] heldTokens;
        mapping(address => bool) isHeldToken;
        uint256 depositAssetReserveBps;
        uint256 adminUnwindMaxDrawdownBps;
        mapping(address => IAssetValuator) valuationAdapters;
        // ── CLOB collateral ──────────────────────────────────────────────
        uint256 totalOutstandingCollateral;
        mapping(address => uint256) operatorCollateral;
        uint256 maxCollateralBps;
        // ── Envelope-mode trade consumption ──────────────────────────────
        mapping(bytes32 => uint256) envelopeConsumedAmount;
    }

    /// keccak256(abi.encode(uint256(keccak256("tangle.trading.vault.main")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION = 0xa5aa421adead2bef92438818d3f26980d088817179ed36509e6db7cd4c198200;

    function load() internal pure returns (Data storage $) {
        bytes32 slot = STORAGE_LOCATION;
        assembly {
            $.slot := slot
        }
    }
}
