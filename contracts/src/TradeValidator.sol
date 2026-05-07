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
    /// @dev Score is included in signed data to prevent manipulation. `executionHash`
    ///      binds the signature to exact executable payload details. `actionKind`
    ///      discriminates execute (0) vs collateral release (1) to prevent cross-function replay.
    bytes32 public constant VALIDATION_TYPEHASH = keccak256(
        "TradeValidation(bytes32 intentHash,bytes32 executionHash,address vault,uint256 score,uint256 deadline,uint256 actionKind)"
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
    error WouldBreachThreshold();
    error SignerNotInSet(address signer);
    error InvalidScoreThreshold();
    error NotVaultConfigOwnerOrOwner();

    // ═══════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════

    event VaultConfigured(address indexed vault, uint256 requiredSignatures, uint256 totalSigners);
    event SignerAdded(address indexed vault, address indexed signer);
    event SignerRemoved(address indexed vault, address indexed signer);
    event ScoreThresholdUpdated(address indexed vault, uint256 threshold);
    event VaultConfigOwnerUpdated(address indexed vault, address indexed newOwner);

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

    /// @notice Minimum average score threshold per vault (default 50)
    mapping(address vault => uint256) public minScoreThreshold;

    /// @notice Whether score threshold has been initialized for a vault
    mapping(address vault => bool) public thresholdInitialized;

    /// @notice Tracks who configured each vault (for permissioned threshold updates)
    mapping(address vault => address) public vaultConfigOwner;

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
    function configureVault(address vault, address[] calldata signers, uint256 requiredSigs) external onlyOwner {
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

        // Initialize score threshold on first configure only (prevents resetting intentional 0)
        if (!thresholdInitialized[vault]) {
            minScoreThreshold[vault] = 50;
            thresholdInitialized[vault] = true;
        }
        vaultConfigOwner[vault] = msg.sender;

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
    /// @dev Reverts if removal would make signers.length <= requiredSignatures
    ///      or if signer is not in the set.
    function removeSigner(address vault, address signer) external onlyOwner {
        VaultConfig storage config = _vaultConfigs[vault];
        if (config.signers.length() <= config.requiredSignatures) revert WouldBreachThreshold();
        bool removed = config.signers.remove(signer);
        if (!removed) revert SignerNotInSet(signer);
        emit SignerRemoved(vault, signer);
    }

    /// @notice Update the required signature count for a vault (increase only).
    /// @dev M-3: threshold can only go up, never down. Prevents a compromised factory
    ///      owner from silently reducing the quorum to 1-of-n and self-signing trades.
    ///      To lower the threshold, deploy a new vault.
    function setRequiredSignatures(address vault, uint256 requiredSigs) external onlyOwner {
        VaultConfig storage config = _vaultConfigs[vault];
        if (requiredSigs == 0 || requiredSigs > config.signers.length()) {
            revert InvalidRequiredSignatures();
        }
        if (requiredSigs < config.requiredSignatures) {
            revert InvalidRequiredSignatures();
        }
        config.requiredSignatures = requiredSigs;
        emit VaultConfigured(vault, requiredSigs, config.signers.length());
    }

    /// @notice Set the minimum average score threshold for a vault
    /// @param vault The vault address
    /// @param threshold Minimum average score (0-100)
    function setMinScoreThreshold(address vault, uint256 threshold) external {
        if (msg.sender != owner() && msg.sender != vaultConfigOwner[vault]) {
            revert NotVaultConfigOwnerOrOwner();
        }
        if (threshold > 100) revert InvalidScoreThreshold();
        minScoreThreshold[vault] = threshold;
        emit ScoreThresholdUpdated(vault, threshold);
    }

    /// @notice Transfer vault config ownership to a new address
    function setVaultConfigOwner(address vault, address newOwner) external {
        if (msg.sender != owner() && msg.sender != vaultConfigOwner[vault]) {
            revert NotVaultConfigOwnerOrOwner();
        }
        if (newOwner == address(0)) revert ZeroAddress();
        vaultConfigOwner[vault] = newOwner;
        emit VaultConfigOwnerUpdated(vault, newOwner);
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

        // Track which signers we've already counted to prevent double-use
        address[] memory seen = new address[](signatures.length);
        uint256 seenCount = 0;
        uint256 scoreSum = 0;

        for (uint256 i = 0; i < signatures.length; i++) {
            // Build the EIP-712 struct hash with score + actionKind INSIDE the signed data
            bytes32 structHash = keccak256(
                abi.encode(VALIDATION_TYPEHASH, intentHash, executionHash, vault, scores[i], deadline, actionKind)
            );

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
            scoreSum += scores[i];
        }

        approved = validCount >= config.requiredSignatures;

        // Check average score against threshold
        if (approved && validCount > 0) {
            uint256 avgScore = scoreSum / validCount;
            uint256 threshold = minScoreThreshold[vault];
            if (threshold > 0 && avgScore < threshold) {
                approved = false;
            }
        }
    }

    /// @notice Backward-compatible direct verifier for non-execution tests/tools.
    /// @dev Production vault execution uses the overload that includes executionHash.
    function validateWithSignatures(
        bytes32 intentHash,
        address vault,
        bytes[] calldata signatures,
        uint256[] calldata scores,
        uint256 deadline,
        uint256 actionKind
    ) external view returns (bool approved, uint256 validCount) {
        return this.validateWithSignatures(intentHash, bytes32(0), vault, signatures, scores, deadline, actionKind);
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
        bytes32 executionHash,
        address vault,
        uint256 score,
        uint256 deadline,
        uint256 actionKind
    ) external view returns (bytes32) {
        bytes32 structHash =
            keccak256(abi.encode(VALIDATION_TYPEHASH, intentHash, executionHash, vault, score, deadline, actionKind));
        return _hashTypedDataV4(structHash);
    }

    /// @notice Backward-compatible digest helper for non-execution tests/tools.
    /// @dev Production vault execution signs a non-zero executionHash.
    function computeDigest(
        bytes32 intentHash,
        address vault,
        uint256 score,
        uint256 deadline,
        uint256 actionKind
    ) external view returns (bytes32) {
        bytes32 structHash =
            keccak256(abi.encode(VALIDATION_TYPEHASH, intentHash, bytes32(0), vault, score, deadline, actionKind));
        return _hashTypedDataV4(structHash);
    }

    /// @notice Get the EIP-712 domain separator (useful for off-chain tooling)
    function getDomainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ENVELOPE VERIFICATION (TradingEnvelope v2 domain — disjoint from above)
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice EIP-712 typehash for the universal envelope wrapper. The off-chain
    ///         Rust `SignedEnvelope::digest()` produces the same hash. `enforcementHash`
    ///         is the keccak of the matching per-protocol enforcement struct.
    bytes32 public constant ENVELOPE_TYPEHASH = keccak256(
        "Envelope(uint64 version,bytes32 botIdHash,address vault,uint64 chainId,bytes32 protocolHash,bytes32 policyHash,bytes32 enforcementHash,uint64 issuedAt,uint64 expiresAt,uint64 nonce,bytes32 signersHash,uint64 minSignatures)"
    );

    bytes32 public constant UNISWAP_V3_SWAP_TYPEHASH = keccak256(
        "UniswapV3SwapEnforcement(uint256 feeTier,uint256 maxSingleAmountIn,uint256 maxTotalAmountIn,uint256 maxValue,uint256 minOutputPerInput,address router,address tokenIn,address tokenOut,uint160 sqrtPriceLimitX96)"
    );
    bytes32 public constant UNISWAP_V4_SWAP_TYPEHASH = keccak256(
        "UniswapV4SwapEnforcement(address currency0,address currency1,uint256 fee,int256 tickSpacing,address hooks,bool zeroForOne,uint256 maxSingleAmountIn,uint256 maxTotalAmountIn,uint256 maxValue,uint256 minOutputPerInput,address universalRouter,bytes32 hookDataHash)"
    );
    bytes32 public constant AERODROME_SWAP_TYPEHASH = keccak256(
        "AerodromeSwapEnforcement(uint256 maxSingleAmountIn,uint256 maxTotalAmountIn,uint256 maxValue,uint256 minOutputPerInput,address router,int256 tickSpacing,address tokenIn,address tokenOut,uint160 sqrtPriceLimitX96)"
    );
    bytes32 public constant PANCAKESWAP_V3_SWAP_TYPEHASH = keccak256(
        "PancakeswapV3SwapEnforcement(uint256 feeTier,uint256 maxSingleAmountIn,uint256 maxTotalAmountIn,uint256 maxValue,uint256 minOutputPerInput,address router,address tokenIn,address tokenOut,uint160 sqrtPriceLimitX96)"
    );
    bytes32 public constant CURVE_STABLE_SWAP_TYPEHASH = keccak256(
        "CurveStableSwapEnforcement(int128 i,int128 j,uint256 maxSingleAmountIn,uint256 maxTotalAmountIn,uint256 maxValue,uint256 minOutputPerInput,address pool,address tokenIn,address tokenOut)"
    );
    bytes32 public constant AAVE_SUPPLY_TYPEHASH = keccak256(
        "AaveSupplyEnforcement(address asset,uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,address pool)"
    );
    bytes32 public constant AAVE_WITHDRAW_TYPEHASH = keccak256(
        "AaveWithdrawEnforcement(address asset,uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,uint256 minHealthFactor,address pool)"
    );
    bytes32 public constant AAVE_BORROW_TYPEHASH = keccak256(
        "AaveBorrowEnforcement(address asset,uint256 interestRateMode,uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,uint256 minHealthFactor,address pool)"
    );
    bytes32 public constant AAVE_REPAY_TYPEHASH = keccak256(
        "AaveRepayEnforcement(address asset,address debtToken,uint256 interestRateMode,uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,address pool)"
    );
    bytes32 public constant MORPHO_SUPPLY_TYPEHASH = keccak256(
        "MorphoSupplyEnforcement(uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,bytes32 marketId,address morpho)"
    );
    bytes32 public constant MORPHO_WITHDRAW_TYPEHASH = keccak256(
        "MorphoWithdrawEnforcement(uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,bytes32 marketId,uint256 minCollateralRatio,address morpho)"
    );
    bytes32 public constant MORPHO_BORROW_TYPEHASH = keccak256(
        "MorphoBorrowEnforcement(uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,bytes32 marketId,uint256 minCollateralRatio,address morpho)"
    );
    bytes32 public constant MORPHO_REPAY_TYPEHASH = keccak256(
        "MorphoRepayEnforcement(uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,bytes32 marketId,address morpho)"
    );

    error InvalidEnvelope();
    error EnvelopeEnforcementMismatch();

    struct Envelope {
        uint64 version;
        bytes32 botIdHash;
        address vault;
        uint64 chainId;
        bytes32 protocolHash;
        bytes32 policyHash;
        bytes32 enforcementHash;
        uint64 issuedAt;
        uint64 expiresAt;
        uint64 nonce;
        bytes32 signersHash;
        uint64 minSignatures;
    }

    struct UniswapV3SwapEnforcement {
        uint256 feeTier;
        uint256 maxSingleAmountIn;
        uint256 maxTotalAmountIn;
        // Audit M-3: bound params.value (native ETH) — default 0 disables ETH spend.
        uint256 maxValue;
        uint256 minOutputPerInput;
        address router;
        address tokenIn;
        address tokenOut;
        // Audit M-2: pin sqrtPriceLimitX96 so an operator cannot grief by submitting
        // a tight price-limit. 0 disables the price-limit (default) on-chain.
        uint160 sqrtPriceLimitX96;
    }

    struct UniswapV4SwapEnforcement {
        address currency0;
        address currency1;
        uint256 fee;
        int256 tickSpacing;
        address hooks;
        bool zeroForOne;
        uint256 maxSingleAmountIn;
        uint256 maxTotalAmountIn;
        // Audit M-3: bound params.value (native ETH) — default 0 disables ETH spend.
        uint256 maxValue;
        uint256 minOutputPerInput;
        address universalRouter;
        // Audit M-2: pin keccak256(hookData) so an operator cannot push arbitrary
        // hook callback bytes through the V4 swap action.
        bytes32 hookDataHash;
    }

    struct AerodromeSwapEnforcement {
        uint256 maxSingleAmountIn;
        uint256 maxTotalAmountIn;
        // Audit M-3: bound params.value (native ETH) — default 0 disables ETH spend.
        uint256 maxValue;
        uint256 minOutputPerInput;
        address router;
        int256 tickSpacing;
        address tokenIn;
        address tokenOut;
        // Audit M-2: pin sqrtPriceLimitX96 (Aerodrome Slipstream uses the same V3-style limit).
        uint160 sqrtPriceLimitX96;
    }

    struct PancakeswapV3SwapEnforcement {
        uint256 feeTier;
        uint256 maxSingleAmountIn;
        uint256 maxTotalAmountIn;
        // Audit M-3: bound params.value (native ETH) — default 0 disables ETH spend.
        uint256 maxValue;
        uint256 minOutputPerInput;
        address router;
        address tokenIn;
        address tokenOut;
        // Audit M-2: pin sqrtPriceLimitX96 (Pancake reuses the V3 calldata layout).
        uint160 sqrtPriceLimitX96;
    }

    /// @dev Curve StableSwap is index-based: caller passes signed int128 i (token-in)
    ///      and int128 j (token-out) to `exchange(int128,int128,uint256,uint256)`.
    ///      We pin the pool, indices, and resolved asset addresses so the on-chain
    ///      executor can verify all four parameters without an external `coins(i)` call.
    struct CurveStableSwapEnforcement {
        int128 i;
        int128 j;
        uint256 maxSingleAmountIn;
        uint256 maxTotalAmountIn;
        // Audit M-3: bound params.value (native ETH) — default 0 disables ETH spend.
        uint256 maxValue;
        uint256 minOutputPerInput;
        address pool;
        address tokenIn;
        address tokenOut;
    }

    struct AaveSupplyEnforcement {
        address asset;
        uint256 maxSingleAmount;
        uint256 maxTotalAmount;
        // Audit M-3: bound params.value (native ETH) — default 0 disables ETH spend.
        uint256 maxValue;
        address pool;
    }

    struct AaveWithdrawEnforcement {
        address asset;
        uint256 maxSingleAmount;
        uint256 maxTotalAmount;
        // Audit M-3: bound params.value (native ETH) — default 0 disables ETH spend.
        uint256 maxValue;
        uint256 minHealthFactor;
        address pool;
    }

    struct AaveBorrowEnforcement {
        address asset;
        uint256 interestRateMode;
        uint256 maxSingleAmount;
        uint256 maxTotalAmount;
        // Audit M-3: bound params.value (native ETH) — default 0 disables ETH spend.
        uint256 maxValue;
        uint256 minHealthFactor;
        address pool;
    }

    struct AaveRepayEnforcement {
        address asset;
        address debtToken;
        uint256 interestRateMode;
        uint256 maxSingleAmount;
        uint256 maxTotalAmount;
        // Audit M-3: bound params.value (native ETH) — default 0 disables ETH spend.
        uint256 maxValue;
        address pool;
    }

    struct MorphoSupplyEnforcement {
        uint256 maxSingleAmount;
        uint256 maxTotalAmount;
        // Audit M-3: bound params.value (native ETH) — default 0 disables ETH spend.
        uint256 maxValue;
        bytes32 marketId;
        address morpho;
    }

    struct MorphoWithdrawEnforcement {
        uint256 maxSingleAmount;
        uint256 maxTotalAmount;
        // Audit M-3: bound params.value (native ETH) — default 0 disables ETH spend.
        uint256 maxValue;
        bytes32 marketId;
        uint256 minCollateralRatio;
        address morpho;
    }

    struct MorphoBorrowEnforcement {
        uint256 maxSingleAmount;
        uint256 maxTotalAmount;
        // Audit M-3: bound params.value (native ETH) — default 0 disables ETH spend.
        uint256 maxValue;
        bytes32 marketId;
        uint256 minCollateralRatio;
        address morpho;
    }

    struct MorphoRepayEnforcement {
        uint256 maxSingleAmount;
        uint256 maxTotalAmount;
        // Audit M-3: bound params.value (native ETH) — default 0 disables ETH spend.
        uint256 maxValue;
        bytes32 marketId;
        address morpho;
    }

    /// @dev EIP-712 domain separator for envelopes — distinct from this contract's
    ///      EIP712 inheritance ("TradeValidator" v1) used by `_hashTypedDataV4`. The
    ///      envelope domain is ("TradingEnvelope", "2") so off-chain Rust v2
    ///      digests match on-chain digests. We compute it inline rather than caching
    ///      to remain fork-safe.
    function _envelopeDomainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("TradingEnvelope")),
                keccak256(bytes("2")),
                block.chainid,
                address(this)
            )
        );
    }

    function _envelopeDigest(Envelope calldata env) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(bytes2(0x1901), _envelopeDomainSeparator(), _hashEnvelope(env)));
    }

    function _hashEnvelope(Envelope calldata env) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ENVELOPE_TYPEHASH,
                uint256(env.version),
                env.botIdHash,
                env.vault,
                uint256(env.chainId),
                env.protocolHash,
                env.policyHash,
                env.enforcementHash,
                uint256(env.issuedAt),
                uint256(env.expiresAt),
                uint256(env.nonce),
                env.signersHash,
                uint256(env.minSignatures)
            )
        );
    }

    /// @dev Off-chain Rust sorts addresses ascending then concatenates raw bytes;
    ///      this MUST match exactly. Reverts on zero address (defense-in-depth).
    function _hashApprovalSigners(address[] calldata signers) internal pure returns (bytes32) {
        // Validate non-zero. Sorting requirement is validated against caller-supplied
        // sorted order; if signers aren't sorted ascending, hash won't match envelope.signersHash.
        for (uint256 i = 0; i < signers.length; ++i) {
            if (signers[i] == address(0)) revert ZeroAddress();
            if (i > 0 && uint160(signers[i]) <= uint160(signers[i - 1])) revert InvalidEnvelope();
        }
        bytes memory packed;
        for (uint256 i = 0; i < signers.length; ++i) {
            packed = bytes.concat(packed, abi.encodePacked(signers[i]));
        }
        return keccak256(packed);
    }

    function _addressInCalldata(address[] calldata values, address needle) internal pure returns (bool) {
        for (uint256 i = 0; i < values.length; ++i) {
            if (values[i] == needle) return true;
        }
        return false;
    }

    /// @dev Universal sig + score + dedup verifier shared by every per-protocol validate*Envelope.
    function _validateEnvelopeWithEnforcementHash(
        Envelope calldata env,
        bytes32 expectedEnforcementHash,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) internal view returns (bool approved, uint256 validCount) {
        if (env.enforcementHash != expectedEnforcementHash) revert EnvelopeEnforcementMismatch();
        if (
            env.version != 2 || env.vault == address(0) || env.chainId == 0 || env.expiresAt < block.timestamp
                || env.minSignatures == 0 || approvalSigners.length < env.minSignatures
                || signatures.length != scores.length || signatures.length == 0
        ) revert InvalidEnvelope();
        // Audit fix L-1: enforce strict chainId equality with the executing
        // chain. The EIP-712 domain separator already binds the digest, but
        // a `view` call to `validateXxxEnvelope` would silently approve a
        // wrong-chain envelope on a fork — surprising for off-chain
        // simulators. Failing fast here matches the executor's
        // `_checkEnvelopeBasics`.
        if (env.chainId != block.chainid) revert InvalidEnvelope();
        // Audit fix L-2: future-dated envelopes must not validate. The
        // executor's `_checkEnvelopeBasics` already rejects them, but the
        // validator's `view`-only path otherwise returned `(true, ...)`,
        // which a UI/simulator could misinterpret as "ready to execute now".
        if (env.issuedAt > block.timestamp) revert InvalidEnvelope();
        if (_hashApprovalSigners(approvalSigners) != env.signersHash) revert InvalidEnvelope();

        VaultConfig storage config = _vaultConfigs[env.vault];
        if (config.requiredSignatures == 0) revert VaultNotConfigured(env.vault);

        bytes32 digest = _envelopeDigest(env);
        address[] memory seen = new address[](signatures.length);
        uint256 seenCount = 0;
        uint256 scoreSum = 0;

        for (uint256 i = 0; i < signatures.length; i++) {
            address signer = ECDSA.recover(digest, signatures[i]);
            if (!config.signers.contains(signer)) continue;
            if (!_addressInCalldata(approvalSigners, signer)) continue;
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

        uint256 required =
            config.requiredSignatures > env.minSignatures ? config.requiredSignatures : env.minSignatures;
        approved = validCount >= required;
        if (approved && validCount > 0) {
            uint256 avgScore = scoreSum / validCount;
            uint256 threshold = minScoreThreshold[env.vault];
            if (threshold > 0 && avgScore < threshold) approved = false;
        }
    }

    // ── Per-protocol enforcement hashes ──

    function _hashUniswapV3Swap(UniswapV3SwapEnforcement calldata e) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                UNISWAP_V3_SWAP_TYPEHASH,
                e.feeTier,
                e.maxSingleAmountIn,
                e.maxTotalAmountIn,
                e.maxValue,
                e.minOutputPerInput,
                e.router,
                e.tokenIn,
                e.tokenOut,
                uint256(e.sqrtPriceLimitX96)
            )
        );
    }

    function _hashUniswapV4Swap(UniswapV4SwapEnforcement calldata e) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                UNISWAP_V4_SWAP_TYPEHASH,
                e.currency0,
                e.currency1,
                e.fee,
                e.tickSpacing,
                e.hooks,
                e.zeroForOne,
                e.maxSingleAmountIn,
                e.maxTotalAmountIn,
                e.maxValue,
                e.minOutputPerInput,
                e.universalRouter,
                e.hookDataHash
            )
        );
    }

    function _hashAerodromeSwap(AerodromeSwapEnforcement calldata e) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                AERODROME_SWAP_TYPEHASH,
                e.maxSingleAmountIn,
                e.maxTotalAmountIn,
                e.maxValue,
                e.minOutputPerInput,
                e.router,
                e.tickSpacing,
                e.tokenIn,
                e.tokenOut,
                uint256(e.sqrtPriceLimitX96)
            )
        );
    }

    function _hashPancakeswapV3Swap(PancakeswapV3SwapEnforcement calldata e) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                PANCAKESWAP_V3_SWAP_TYPEHASH,
                e.feeTier,
                e.maxSingleAmountIn,
                e.maxTotalAmountIn,
                e.maxValue,
                e.minOutputPerInput,
                e.router,
                e.tokenIn,
                e.tokenOut,
                uint256(e.sqrtPriceLimitX96)
            )
        );
    }

    function _hashCurveStableSwap(CurveStableSwapEnforcement calldata e) internal pure returns (bytes32) {
        // Off-chain Rust ABI-encodes int128 as int256 sign-extended to 32 bytes; Solidity does
        // the same automatically when we abi.encode int128 fields, so the hashes line up.
        return keccak256(
            abi.encode(
                CURVE_STABLE_SWAP_TYPEHASH,
                e.i,
                e.j,
                e.maxSingleAmountIn,
                e.maxTotalAmountIn,
                e.maxValue,
                e.minOutputPerInput,
                e.pool,
                e.tokenIn,
                e.tokenOut
            )
        );
    }

    function _hashAaveSupply(AaveSupplyEnforcement calldata e) internal pure returns (bytes32) {
        return keccak256(abi.encode(AAVE_SUPPLY_TYPEHASH, e.asset, e.maxSingleAmount, e.maxTotalAmount, e.maxValue, e.pool));
    }

    function _hashAaveWithdraw(AaveWithdrawEnforcement calldata e) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(AAVE_WITHDRAW_TYPEHASH, e.asset, e.maxSingleAmount, e.maxTotalAmount, e.maxValue, e.minHealthFactor, e.pool)
        );
    }

    function _hashAaveBorrow(AaveBorrowEnforcement calldata e) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                AAVE_BORROW_TYPEHASH,
                e.asset,
                e.interestRateMode,
                e.maxSingleAmount,
                e.maxTotalAmount,
                e.maxValue,
                e.minHealthFactor,
                e.pool
            )
        );
    }

    function _hashAaveRepay(AaveRepayEnforcement calldata e) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                AAVE_REPAY_TYPEHASH,
                e.asset,
                e.debtToken,
                e.interestRateMode,
                e.maxSingleAmount,
                e.maxTotalAmount,
                e.maxValue,
                e.pool
            )
        );
    }

    function _hashMorphoSupply(MorphoSupplyEnforcement calldata e) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(MORPHO_SUPPLY_TYPEHASH, e.maxSingleAmount, e.maxTotalAmount, e.maxValue, e.marketId, e.morpho)
        );
    }

    function _hashMorphoWithdraw(MorphoWithdrawEnforcement calldata e) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                MORPHO_WITHDRAW_TYPEHASH,
                e.maxSingleAmount,
                e.maxTotalAmount,
                e.maxValue,
                e.marketId,
                e.minCollateralRatio,
                e.morpho
            )
        );
    }

    function _hashMorphoBorrow(MorphoBorrowEnforcement calldata e) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                MORPHO_BORROW_TYPEHASH,
                e.maxSingleAmount,
                e.maxTotalAmount,
                e.maxValue,
                e.marketId,
                e.minCollateralRatio,
                e.morpho
            )
        );
    }

    function _hashMorphoRepay(MorphoRepayEnforcement calldata e) internal pure returns (bytes32) {
        return keccak256(abi.encode(MORPHO_REPAY_TYPEHASH, e.maxSingleAmount, e.maxTotalAmount, e.maxValue, e.marketId, e.morpho));
    }

    // ── Public validate*Envelope (one per protocol-action) ──

    function validateUniswapV3SwapEnvelope(
        Envelope calldata env,
        UniswapV3SwapEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external view returns (bool approved, uint256 validCount) {
        return _validateEnvelopeWithEnforcementHash(
            env, _hashUniswapV3Swap(enf), approvalSigners, signatures, scores
        );
    }

    function validateUniswapV4SwapEnvelope(
        Envelope calldata env,
        UniswapV4SwapEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external view returns (bool, uint256) {
        return _validateEnvelopeWithEnforcementHash(
            env, _hashUniswapV4Swap(enf), approvalSigners, signatures, scores
        );
    }

    function validateAerodromeSwapEnvelope(
        Envelope calldata env,
        AerodromeSwapEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external view returns (bool, uint256) {
        return _validateEnvelopeWithEnforcementHash(
            env, _hashAerodromeSwap(enf), approvalSigners, signatures, scores
        );
    }

    function validatePancakeswapV3SwapEnvelope(
        Envelope calldata env,
        PancakeswapV3SwapEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external view returns (bool, uint256) {
        return _validateEnvelopeWithEnforcementHash(
            env, _hashPancakeswapV3Swap(enf), approvalSigners, signatures, scores
        );
    }

    function validateCurveStableSwapEnvelope(
        Envelope calldata env,
        CurveStableSwapEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external view returns (bool, uint256) {
        return _validateEnvelopeWithEnforcementHash(
            env, _hashCurveStableSwap(enf), approvalSigners, signatures, scores
        );
    }

    function validateAaveSupplyEnvelope(
        Envelope calldata env,
        AaveSupplyEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external view returns (bool, uint256) {
        return _validateEnvelopeWithEnforcementHash(env, _hashAaveSupply(enf), approvalSigners, signatures, scores);
    }

    function validateAaveWithdrawEnvelope(
        Envelope calldata env,
        AaveWithdrawEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external view returns (bool, uint256) {
        return _validateEnvelopeWithEnforcementHash(env, _hashAaveWithdraw(enf), approvalSigners, signatures, scores);
    }

    function validateAaveBorrowEnvelope(
        Envelope calldata env,
        AaveBorrowEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external view returns (bool, uint256) {
        return _validateEnvelopeWithEnforcementHash(env, _hashAaveBorrow(enf), approvalSigners, signatures, scores);
    }

    function validateAaveRepayEnvelope(
        Envelope calldata env,
        AaveRepayEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external view returns (bool, uint256) {
        return _validateEnvelopeWithEnforcementHash(env, _hashAaveRepay(enf), approvalSigners, signatures, scores);
    }

    function validateMorphoSupplyEnvelope(
        Envelope calldata env,
        MorphoSupplyEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external view returns (bool, uint256) {
        return _validateEnvelopeWithEnforcementHash(env, _hashMorphoSupply(enf), approvalSigners, signatures, scores);
    }

    function validateMorphoWithdrawEnvelope(
        Envelope calldata env,
        MorphoWithdrawEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external view returns (bool, uint256) {
        return _validateEnvelopeWithEnforcementHash(
            env, _hashMorphoWithdraw(enf), approvalSigners, signatures, scores
        );
    }

    function validateMorphoBorrowEnvelope(
        Envelope calldata env,
        MorphoBorrowEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external view returns (bool, uint256) {
        return _validateEnvelopeWithEnforcementHash(env, _hashMorphoBorrow(enf), approvalSigners, signatures, scores);
    }

    function validateMorphoRepayEnvelope(
        Envelope calldata env,
        MorphoRepayEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external view returns (bool, uint256) {
        return _validateEnvelopeWithEnforcementHash(env, _hashMorphoRepay(enf), approvalSigners, signatures, scores);
    }

    // ── Public computation helpers (for off-chain tooling and TradingVault) ──

    function envelopeDigest(Envelope calldata env) external view returns (bytes32) {
        return _envelopeDigest(env);
    }

    function hashEnvelope(Envelope calldata env) external pure returns (bytes32) {
        return _hashEnvelope(env);
    }

    function hashUniswapV3Swap(UniswapV3SwapEnforcement calldata e) external pure returns (bytes32) {
        return _hashUniswapV3Swap(e);
    }

    function hashUniswapV4Swap(UniswapV4SwapEnforcement calldata e) external pure returns (bytes32) {
        return _hashUniswapV4Swap(e);
    }

    function hashAerodromeSwap(AerodromeSwapEnforcement calldata e) external pure returns (bytes32) {
        return _hashAerodromeSwap(e);
    }

    function hashPancakeswapV3Swap(PancakeswapV3SwapEnforcement calldata e) external pure returns (bytes32) {
        return _hashPancakeswapV3Swap(e);
    }

    function hashCurveStableSwap(CurveStableSwapEnforcement calldata e) external pure returns (bytes32) {
        return _hashCurveStableSwap(e);
    }

    function hashAaveSupply(AaveSupplyEnforcement calldata e) external pure returns (bytes32) {
        return _hashAaveSupply(e);
    }

    function hashAaveWithdraw(AaveWithdrawEnforcement calldata e) external pure returns (bytes32) {
        return _hashAaveWithdraw(e);
    }

    function hashAaveBorrow(AaveBorrowEnforcement calldata e) external pure returns (bytes32) {
        return _hashAaveBorrow(e);
    }

    function hashAaveRepay(AaveRepayEnforcement calldata e) external pure returns (bytes32) {
        return _hashAaveRepay(e);
    }

    function hashMorphoSupply(MorphoSupplyEnforcement calldata e) external pure returns (bytes32) {
        return _hashMorphoSupply(e);
    }

    function hashMorphoWithdraw(MorphoWithdrawEnforcement calldata e) external pure returns (bytes32) {
        return _hashMorphoWithdraw(e);
    }

    function hashMorphoBorrow(MorphoBorrowEnforcement calldata e) external pure returns (bytes32) {
        return _hashMorphoBorrow(e);
    }

    function hashMorphoRepay(MorphoRepayEnforcement calldata e) external pure returns (bytes32) {
        return _hashMorphoRepay(e);
    }
}
