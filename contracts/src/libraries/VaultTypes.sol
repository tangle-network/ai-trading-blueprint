// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title VaultTypes
/// @notice Structs, constants, errors, and events shared between
///         `TradingVault` and every helper library. Declared as a library
///         so static members (`VaultTypes.MAX_HELD_TOKENS`,
///         `VaultTypes.ApprovalCall`, `VaultTypes.ZeroAddress`) resolve from
///         every external-library callsite without needing an instance.
///         The vault re-declares the same public ABI surface via direct
///         struct + event references so off-chain consumers continue to see
///         the canonical names.
library VaultTypes {
    // ═══════════════════════════════════════════════════════════════════════════
    // EIP-712 ACTION KIND DISCRIMINATORS
    // ═══════════════════════════════════════════════════════════════════════════

    uint256 internal constant ACTION_KIND_EXECUTE = 0;
    uint256 internal constant ACTION_KIND_RELEASE_COLLATERAL = 1;

    // ═══════════════════════════════════════════════════════════════════════════
    // EIP-712 TYPEHASHES
    // ═══════════════════════════════════════════════════════════════════════════

    bytes32 internal constant EXECUTION_PAYLOAD_TYPEHASH = keccak256(
        "ExecutionPayload(address target,bytes32 dataHash,uint256 value,uint256 minOutput,address outputToken,bytes32 intentHash,uint256 deadline,uint256 chainId,bytes32 approvalsHash)"
    );

    bytes32 internal constant DEBT_REDUCTION_PAYLOAD_TYPEHASH = keccak256(
        "DebtReductionPayload(address target,bytes32 dataHash,uint256 value,address inputToken,uint256 maxInput,address debtToken,uint256 minDebtDecrease,bytes32 intentHash,uint256 deadline,uint256 chainId,bytes32 approvalsHash)"
    );

    bytes32 internal constant HEALTH_FACTOR_PAYLOAD_TYPEHASH = keccak256(
        "HealthFactorPayload(address target,bytes32 dataHash,uint256 value,uint256 minOutput,address outputToken,address pool,address account,uint256 minHealthFactor,bytes32 intentHash,uint256 deadline,uint256 chainId,bytes32 approvalsHash)"
    );

    bytes32 internal constant APPROVAL_CALL_TYPEHASH =
        keccak256("ApprovalCall(address token,address spender,uint256 amount)");

    bytes32 internal constant COLLATERAL_RELEASE_TYPEHASH = keccak256(
        "CollateralRelease(uint256 amount,address recipient,bytes32 intentHash,uint256 deadline,uint256 chainId)"
    );

    bytes32 internal constant EMPTY_APPROVALS_HASH = keccak256("");

    // ═══════════════════════════════════════════════════════════════════════════
    // EXECUTE STRUCTS
    // ═══════════════════════════════════════════════════════════════════════════

    struct ExecuteParams {
        address target;
        bytes data;
        uint256 value;
        uint256 minOutput;
        address outputToken;
        bytes32 intentHash;
        uint256 deadline;
    }

    struct DebtReductionParams {
        address target;
        bytes data;
        uint256 value;
        address inputToken;
        uint256 maxInput;
        address debtToken;
        uint256 minDebtDecrease;
        bytes32 intentHash;
        uint256 deadline;
    }

    struct HealthFactorParams {
        address target;
        bytes data;
        uint256 value;
        uint256 minOutput;
        address outputToken;
        address pool;
        address account;
        uint256 minHealthFactor;
        bytes32 intentHash;
        uint256 deadline;
    }

    struct ApprovalCall {
        address token;
        address spender;
        uint256 amount;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ENVELOPE CALLDATA STRUCTS
    // ═══════════════════════════════════════════════════════════════════════════

    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    struct V4PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct V4ExactInputSingleParams {
        V4PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        bytes hookData;
    }

    struct AerodromeSwapParams {
        address tokenIn;
        address tokenOut;
        int24 tickSpacing;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    struct MorphoMarketParams {
        address loanToken;
        address collateralToken;
        address oracle;
        address irm;
        uint256 lltv;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PROTOCOL CALLDATA SELECTORS
    // ═══════════════════════════════════════════════════════════════════════════

    bytes4 internal constant SELECTOR_UNI_V3_EXACT_INPUT_SINGLE = 0x414bf389;
    bytes4 internal constant SELECTOR_AERODROME_EXACT_INPUT_SINGLE =
        bytes4(keccak256("exactInputSingle((address,address,int24,address,uint256,uint256,uint256,uint160))"));
    bytes4 internal constant SELECTOR_CURVE_EXCHANGE = bytes4(keccak256("exchange(int128,int128,uint256,uint256)"));
    bytes4 internal constant SELECTOR_UR_EXECUTE = bytes4(keccak256("execute(bytes,bytes[],uint256)"));
    uint8 internal constant UR_COMMAND_V4_SWAP = 0x10;
    uint8 internal constant V4_ACTION_SWAP_EXACT_IN_SINGLE = 0x06;

    bytes4 internal constant SELECTOR_AAVE_SUPPLY = bytes4(keccak256("supply(address,uint256,address,uint16)"));
    bytes4 internal constant SELECTOR_AAVE_WITHDRAW = bytes4(keccak256("withdraw(address,uint256,address)"));
    bytes4 internal constant SELECTOR_AAVE_BORROW = bytes4(keccak256("borrow(address,uint256,uint256,uint16,address)"));
    bytes4 internal constant SELECTOR_AAVE_REPAY = bytes4(keccak256("repay(address,uint256,uint256,address)"));

    bytes4 internal constant SELECTOR_MORPHO_SUPPLY =
        bytes4(keccak256("supply((address,address,address,address,uint256),uint256,uint256,address,bytes)"));
    bytes4 internal constant SELECTOR_MORPHO_WITHDRAW =
        bytes4(keccak256("withdraw((address,address,address,address,uint256),uint256,uint256,address,address)"));
    bytes4 internal constant SELECTOR_MORPHO_BORROW =
        bytes4(keccak256("borrow((address,address,address,address,uint256),uint256,uint256,address,address)"));
    bytes4 internal constant SELECTOR_MORPHO_REPAY =
        bytes4(keccak256("repay((address,address,address,address,uint256),uint256,uint256,address,bytes)"));

    // ═══════════════════════════════════════════════════════════════════════════
    // CAPS / SENTINELS
    // ═══════════════════════════════════════════════════════════════════════════

    uint256 internal constant MAX_HELD_TOKENS = 20;
    uint256 internal constant DEFAULT_ADMIN_UNWIND_MAX_DRAWDOWN_BPS = 500;
    uint256 internal constant VIRTUAL_OFFSET = 1;

    // ═══════════════════════════════════════════════════════════════════════════
    // EVENTS (shared between vault + libraries)
    // ═══════════════════════════════════════════════════════════════════════════

    event TradeExecuted(
        address indexed target, uint256 value, uint256 outputGained, address outputToken, bytes32 indexed intentHash
    );

    event DebtReductionExecuted(
        address indexed target,
        uint256 value,
        address indexed inputToken,
        uint256 debtDecreased,
        address indexed debtToken,
        bytes32 intentHash
    );

    event SpenderApprovalUpdated(address indexed token, address indexed spender, uint256 amount);
    event SlippageCheckSkipped(address indexed token, string reason);
    event HeldTokenDecimalMismatch(address indexed token, uint8 tokenDecimals, uint8 assetDecimals);
    event EnvelopeConsumed(bytes32 indexed envelopeHash, uint256 amount, uint256 totalConsumed);

    event EmergencyWithdraw(address indexed token, address indexed to, uint256 amount);
    event WindDownActivated(uint256 timestamp);
    event WindDownDeactivated(uint256 timestamp);
    event PositionUnwound(address indexed caller, address indexed target, uint256 assetGained);
    event DepositLockupUpdated(uint256 duration);
    event DepositAssetReserveBpsUpdated(uint256 bps);
    event AdminUnwindMaxDrawdownBpsUpdated(uint256 bps);
    event CollateralReleased(
        address indexed operator, uint256 amount, address indexed recipient, bytes32 indexed intentHash
    );
    event CollateralReturned(address indexed operator, uint256 amount, uint256 credited);
    event CollateralWrittenDown(address indexed operator, uint256 amount);
    event MaxCollateralBpsUpdated(uint256 bps);
    event ValuationAdapterUpdated(address indexed token, address indexed adapter);
    event InKindRedeemed(address indexed caller, address indexed receiver, address indexed owner, uint256 shares);

    // ═══════════════════════════════════════════════════════════════════════════
    // ERRORS (shared)
    // ═══════════════════════════════════════════════════════════════════════════

    error ZeroAddress();
    error ZeroAmount();
    error ZeroShares();
    error InsufficientAllowance();
    error InsufficientBalance();
    error MinOutputNotMet(uint256 actual, uint256 required);
    error ExecutionFailed();
    error PolicyCheckFailed();
    error ValidatorCheckFailed();
    error IntentAlreadyExecuted(bytes32 intentHash);
    error WindDownNotActive();
    error WindDownAlreadyActive();
    error WindDownBlocksExecute();
    error AssetBalanceDecreased(uint256 before, uint256 after_);
    error TargetNotWhitelisted(address target);
    error WithdrawalLocked(uint256 unlockTime);
    error DepositAssetBelowReserve();
    error ExcessiveDrawdown();
    error InvalidBps();
    error InsufficientLiquidity(uint256 requested, uint256 available);
    error ExceedsCollateralLimit(uint256 requested, uint256 available);
    error CollateralNotEnabled();
    error ApprovalSpenderMismatch(address spender, address target);
    error HeldTokenNotEmpty(address token, uint256 balance);
    error UnsupportedValuationAsset(address token, address asset);
    error OutstandingCollateralActive(uint256 amount);
    error DebtDecreaseNotMet(uint256 actual, uint256 required);
    error HealthFactorTooLow(uint256 actual, uint256 required);
    error PositionLimitExceeded(address token, uint256 actual, uint256 limit);
    error LeverageCapExceeded(uint256 actualBps, uint256 capBps);
    error SlippageCapExceeded(uint256 actualBps, uint256 capBps);

    error EnvelopeCheckFailed();
    error EnvelopeExpired();
    error EnvelopeNotYetActive();
    error EnvelopeWrongVault();
    error EnvelopeWrongChain();
    error EnvelopeAmountExceeded(uint256 requested, uint256 limit);
    error EnvelopeTotalExceeded(uint256 requested, uint256 remaining);
    error EnvelopeRateTooLow(uint256 actualMinOutput, uint256 requiredMinOutput);
    error EnvelopeWrongSelector();
}
