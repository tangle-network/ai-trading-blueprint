// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "./IEnvelopeAdapter.sol";

/// @title EnvelopeRegistry
/// @notice Admin-curated registry of `bytes32 envelopeKind => IEnvelopeAdapter`.
///         New protocols/actions are onboarded by registering an adapter — no
///         change to TradingVault.sol is required.
///
/// @dev SECURITY MODEL
///      - Admin is gated by REGISTRY_ADMIN_ROLE (typically held by the same
///        multisig that holds DEFAULT_ADMIN_ROLE on TradingVault).
///      - Each kind can be registered exactly once; rebinding requires explicit
///        deregister to prevent silent swaps. Deregistration is itself
///        admin-gated and timelocked off-chain (governance policy, not enforced
///        on-chain — keep simple here, gate via multisig).
///      - The vault calls `getAdapter(kind)`; if the kind is missing or the
///        adapter address is paused/zeroed, the call reverts. Operators cannot
///        steer routing — they pass `kind`, the registry resolves the adapter.
///
/// @dev HASH STABILITY
///      Registration MUST NOT alter the on-chain enforcementHash for any
///      already-deployed (kind). Migration plan: register the new adapter,
///      run the parity test from `EnvelopeRegistry.t.sol` against on-chain
///      legacy `hashXxx`, only then route operator traffic through the
///      registry (off-chain runtime change, no contract change required to
///      flip).
contract EnvelopeRegistry is AccessControl {
    bytes32 public constant REGISTRY_ADMIN_ROLE = keccak256("REGISTRY_ADMIN_ROLE");

    error AdapterAlreadyRegistered(bytes32 kind);
    error AdapterNotRegistered(bytes32 kind);
    error AdapterKindMismatch(bytes32 expected, bytes32 actual);
    error ZeroAdapterAddress();

    event AdapterRegistered(bytes32 indexed kind, address indexed adapter, string name);
    event AdapterDeregistered(bytes32 indexed kind, address indexed adapter);

    /// @notice Map of envelopeKind to adapter contract.
    mapping(bytes32 => IEnvelopeAdapter) private _adapters;

    /// @notice All registered kinds (for introspection / off-chain enumeration).
    bytes32[] private _kinds;

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REGISTRY_ADMIN_ROLE, admin);
    }

    /// @notice Register an adapter for the kind it self-declares.
    /// @dev Reverts if the kind is already registered. The adapter's
    ///      `envelopeKind()` is the source of truth — admin passes nothing.
    function register(IEnvelopeAdapter adapter) external onlyRole(REGISTRY_ADMIN_ROLE) {
        if (address(adapter) == address(0)) revert ZeroAdapterAddress();
        bytes32 kind = adapter.envelopeKind();
        if (address(_adapters[kind]) != address(0)) {
            revert AdapterAlreadyRegistered(kind);
        }
        _adapters[kind] = adapter;
        _kinds.push(kind);
        emit AdapterRegistered(kind, address(adapter), adapter.name());
    }

    /// @notice Replace an existing adapter for a kind (admin-only).
    /// @dev Two-step: deregister + register. Provided as a single call only for
    ///      atomicity in admin scripts. Off-chain governance policy MUST gate
    ///      this behind a timelock + audit cycle — same trust as the legacy
    ///      inline function it replaces.
    function replace(IEnvelopeAdapter adapter) external onlyRole(REGISTRY_ADMIN_ROLE) {
        if (address(adapter) == address(0)) revert ZeroAdapterAddress();
        bytes32 kind = adapter.envelopeKind();
        IEnvelopeAdapter existing = _adapters[kind];
        if (address(existing) == address(0)) revert AdapterNotRegistered(kind);
        emit AdapterDeregistered(kind, address(existing));
        _adapters[kind] = adapter;
        emit AdapterRegistered(kind, address(adapter), adapter.name());
    }

    /// @notice Unregister an adapter. Stops new envelopes of this kind from
    ///         executing. Outstanding signed envelopes for the same kind become
    ///         un-redeemable until a fresh adapter is registered.
    function deregister(bytes32 kind) external onlyRole(REGISTRY_ADMIN_ROLE) {
        IEnvelopeAdapter existing = _adapters[kind];
        if (address(existing) == address(0)) revert AdapterNotRegistered(kind);
        delete _adapters[kind];
        // Remove from _kinds; O(n) is fine, registry is small.
        uint256 n = _kinds.length;
        for (uint256 i = 0; i < n; ++i) {
            if (_kinds[i] == kind) {
                _kinds[i] = _kinds[n - 1];
                _kinds.pop();
                break;
            }
        }
        emit AdapterDeregistered(kind, address(existing));
    }

    /// @notice Resolve an adapter by kind. Reverts if missing.
    function getAdapter(bytes32 kind) external view returns (IEnvelopeAdapter) {
        IEnvelopeAdapter a = _adapters[kind];
        if (address(a) == address(0)) revert AdapterNotRegistered(kind);
        return a;
    }

    /// @notice Lookup with no revert — for off-chain probing.
    function tryGetAdapter(bytes32 kind) external view returns (IEnvelopeAdapter) {
        return _adapters[kind];
    }

    /// @notice Return the set of registered kinds.
    function listKinds() external view returns (bytes32[] memory) {
        return _kinds;
    }

    /// @notice Number of registered adapters.
    function count() external view returns (uint256) {
        return _kinds.length;
    }
}
