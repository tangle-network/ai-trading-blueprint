// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./TradeValidator.sol";

/// @title IEnvelopeAdapter
/// @notice Plugin interface for protocol-specific envelope variants.
///
/// @dev BACKGROUND
///      Each of the 13 (and counting) `executeXxxEnvelope` functions in
///      TradingVault.sol shares the same skeleton:
///
///        1. envelope basics check (vault, chainId, issuedAt, expiresAt)
///        2. selector + calldata decode from `params.data`
///        3. cross-check decoded fields against the signed enforcement struct
///        4. validator m-of-n signature check (TradeValidator.validateXxxEnvelope)
///        5. lookup `hashEnvelope(env)` and consume against per-envelope caps
///        6. _prepareEnvelope* (intent dedup + policy)
///        7. ERC-20 approve(target, amount)
///        8. _executeTrade / _executeDebtReduction / _executeHealthFactor
///        9. ERC-20 approve(target, 0)
///
///      Steps 1, 4-9 are protocol-agnostic and live in TradingVault. Steps 2-3
///      vary per (protocol, action). The plugin interface below extracts ONLY
///      steps 2-3 (decode + cross-check) plus the enforcement-hash computation
///      (input to step 4-5) into a stateless external contract.
///
/// @dev HASH STABILITY (CRITICAL INVARIANT)
///      Validators have already signed envelopes whose `enforcementHash` was
///      derived from `keccak256(abi.encode(TYPEHASH, fields...))` for one of the
///      13 existing variant types. The registry/adapter migration MUST NOT
///      change that hash for any existing variant — otherwise off-chain
///      operator signatures collected pre-migration would no longer verify.
///
///      To preserve hash stability, an adapter implementing an EXISTING variant
///      MUST compute `enforcementHash` from the same raw `bytes` enforcement
///      blob using the same TYPEHASH and the same field ordering as the legacy
///      `_hashXxx` functions in TradeValidator.sol.
///
///      The corresponding test (`contracts/test/EnvelopeRegistry.t.sol`) asserts
///      hash equality between the legacy and adapter-computed paths for
///      UniswapV3Swap; the same assertion MUST be repeated for each variant
///      before its inline function is retired.
///
/// @dev TRUST BOUNDARY
///      Adapters are admin-curated. The vault NEVER lets an operator pass an
///      adapter address — variant routing is via the EnvelopeRegistry, keyed
///      by a bytes32 `envelopeKind` that the off-chain signer commits to via
///      the envelope's `protocolHash`. A misbehaving adapter (returning a
///      wrong `enforcementHash`) would cause the validator's
///      `_validateEnvelopeWithEnforcementHash` to revert with
///      `EnvelopeEnforcementMismatch` — i.e., a wrong hash CANNOT bypass the
///      signed gate, it can only cause denial-of-service for that variant.
///      That bounds the impact of an adapter bug to its own variant.
interface IEnvelopeAdapter {
    /// @notice The execution shape this adapter dispatches to in the vault.
    enum ExecShape {
        Trade, // _executeTrade — output-token-gain post-condition
        HealthFactor, // _executeHealthFactor — pool/account healthFactor floor
        DebtReduction // _executeDebtReduction — debtToken balance decrease
    }

    /// @notice Decoded approval call: applied before the target call, reset to 0 after.
    /// @dev Mirrors VaultTypes.ApprovalCall to avoid a cross-library struct dep.
    struct ApprovalSpec {
        address token;
        address spender;
        uint256 amount;
    }

    /// @notice Result of a successful pre-call check.
    /// @dev `enforcementHash` MUST equal the keccak256 the validator signed —
    ///      otherwise `_validateEnvelopeWithEnforcementHash` reverts and the call
    ///      fails. `consumeAmount` is fed into `_consumeEnvelope` and must be the
    ///      input amount for swap/supply/repay variants and the output amount for
    ///      withdraw/borrow variants (matching legacy semantics).
    struct PreCallReport {
        bytes32 enforcementHash;
        uint256 consumeAmount;
        uint256 maxSingleAmount;
        uint256 maxTotalAmount;
        ExecShape shape;
        ApprovalSpec[] approvals;
    }

    /// @notice Stable identifier for this variant — MUST be unique across adapters
    ///         in a given EnvelopeRegistry. Recommended:
    ///             keccak256("UniswapV3Swap"), keccak256("AaveBorrow"), etc.
    /// @dev The registry binds (envelopeKind => adapter); operator routing is by
    ///      envelopeKind only, never by adapter address.
    function envelopeKind() external view returns (bytes32);

    /// @notice Human-readable name; informational only.
    function name() external view returns (string memory);

    /// @notice Compute the enforcement struct hash from a raw enforcement bytes blob.
    /// @dev MUST be byte-identical to the matching legacy `_hashXxx` in
    ///      TradeValidator.sol for migration-stability. The blob is the
    ///      ABI-encoding of the protocol-specific enforcement struct
    ///      (e.g. `abi.encode(UniswapV3SwapEnforcement)`).
    function enforcementHash(bytes calldata enforcementBlob) external pure returns (bytes32);

    /// @notice Decode params.data + cross-check fields against the enforcement
    ///         blob, producing a PreCallReport for the vault.
    /// @param params ABI-encoded vault execution params (ExecuteParams,
    ///        DebtReductionParams, or HealthFactorParams — the adapter knows
    ///        which based on `envelopeKind`).
    /// @param enforcementBlob ABI-encoded protocol-specific enforcement struct.
    /// @param env The signed envelope; the adapter may need fields like
    ///        `expiresAt` to short-circuit decode mismatches with sharper errors.
    /// @return report PreCallReport — see struct comments.
    /// @dev The adapter MUST revert on any decode/check failure. Reverts MUST be
    ///      typed (custom errors) for off-chain debug fidelity. The adapter is
    ///      forbidden from making external calls (mark functions `pure` where
    ///      possible) so an adapter bug cannot exfiltrate vault state.
    function preCallCheck(bytes calldata params, bytes calldata enforcementBlob, TradeValidator.Envelope calldata env)
        external
        pure
        returns (PreCallReport memory report);

    /// @notice Validate envelope signatures via the off-vault TradeValidator.
    /// @dev The vault delegates to this so the adapter binds the right typehash.
    ///      Implementations call
    ///      `tradeValidator._validateEnvelopeWithEnforcementHash(env, expectedHash, ...)`
    ///      — except `_validateEnvelopeWithEnforcementHash` is internal, so
    ///      adapters call the public `validateXxxEnvelope` helper for their
    ///      variant. The adapter passes back the precomputed `expectedHash`
    ///      to the validator's typed wrapper for hash-stability.
    function validateSignatures(
        TradeValidator tradeValidator,
        TradeValidator.Envelope calldata env,
        bytes calldata enforcementBlob,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external view returns (bool ok);
}
