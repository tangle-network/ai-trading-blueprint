// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IERC7575.sol";
import "./VaultShare.sol";
import "./TradeValidator.sol";
import "./PolicyEngine.sol";
import "./FeeDistributor.sol";
import "./interfaces/IAssetValuator.sol";

interface IAavePoolHealth {
    function getUserAccountData(address user)
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        );
}

/// @title TradingVault
/// @notice ERC-7575 multi-asset vault for AI trading agents
/// @dev Each vault handles one deposit asset but shares a VaultShare token with sibling vaults.
///      Single-asset deployment: one vault per share token (behaves like ERC-4626).
///      Multi-asset deployment: multiple vaults share one share token (full ERC-7575).
///
///      Trade execution requires:
///        1. PolicyEngine.validateTrade() — per-vault hard limits
///        2. TradeValidator.validateWithSignatures() — m-of-n EIP-712 sigs
///        3. Only then: target.call(data)
contract TradingVault is IERC7575, AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════════════
    // ROLES
    // ═══════════════════════════════════════════════════════════════════════════

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant CREATOR_ROLE = keccak256("CREATOR_ROLE");

    // ═══════════════════════════════════════════════════════════════════════════
    // EIP-712 ACTION KIND DISCRIMINATORS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Action kind for regular trade executions (execute / executeWithApprovals).
    uint256 public constant ACTION_KIND_EXECUTE = 0;

    /// @notice Action kind for CLOB collateral releases (releaseCollateral).
    uint256 public constant ACTION_KIND_RELEASE_COLLATERAL = 1;

    /// @notice Canonical hash type for exact vault execution payloads.
    bytes32 public constant EXECUTION_PAYLOAD_TYPEHASH = keccak256(
        "ExecutionPayload(address target,bytes32 dataHash,uint256 value,uint256 minOutput,address outputToken,bytes32 intentHash,uint256 deadline,uint256 chainId,bytes32 approvalsHash)"
    );

    /// @notice Canonical hash type for debt-reduction execution payloads.
    bytes32 public constant DEBT_REDUCTION_PAYLOAD_TYPEHASH = keccak256(
        "DebtReductionPayload(address target,bytes32 dataHash,uint256 value,address inputToken,uint256 maxInput,address debtToken,uint256 minDebtDecrease,bytes32 intentHash,uint256 deadline,uint256 chainId,bytes32 approvalsHash)"
    );

    /// @notice Canonical hash type for executions that must preserve Aave-style account health.
    bytes32 public constant HEALTH_FACTOR_PAYLOAD_TYPEHASH = keccak256(
        "HealthFactorPayload(address target,bytes32 dataHash,uint256 value,uint256 minOutput,address outputToken,address pool,address account,uint256 minHealthFactor,bytes32 intentHash,uint256 deadline,uint256 chainId,bytes32 approvalsHash)"
    );

    /// @notice Canonical hash type for atomic approval calls.
    bytes32 public constant APPROVAL_CALL_TYPEHASH =
        keccak256("ApprovalCall(address token,address spender,uint256 amount)");

    /// @notice Canonical hash type for collateral releases.
    bytes32 public constant COLLATERAL_RELEASE_TYPEHASH = keccak256(
        "CollateralRelease(uint256 amount,address recipient,bytes32 intentHash,uint256 deadline,uint256 chainId)"
    );

    bytes32 private constant EMPTY_APPROVALS_HASH = keccak256("");
    bytes32 public constant UNISWAP_ACTION_SWAP = keccak256("swap");
    bytes4 private constant UNISWAP_EXACT_INPUT_SINGLE_SELECTOR = 0x414bf389;

    // ═══════════════════════════════════════════════════════════════════════════
    // ERRORS
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
    error EnvelopeCheckFailed();
    error EnvelopeExpired();
    error EnvelopeAmountExceeded(uint256 requested, uint256 limit);
    error EnvelopeTotalExceeded(uint256 requested, uint256 remaining);
    error EnvelopeRateTooLow(uint256 actualMinOutput, uint256 requiredMinOutput);
    error DeadlineExpired();

    // ═══════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════

    event TradeExecuted(
        address indexed target, uint256 value, uint256 outputGained, address outputToken, bytes32 indexed intentHash
    );
    event EmergencyWithdraw(address indexed token, address indexed to, uint256 amount);
    event WindDownActivated(uint256 timestamp);
    event WindDownDeactivated(uint256 timestamp);
    event PositionUnwound(address indexed caller, address indexed target, uint256 assetGained);
    event DepositLockupUpdated(uint256 duration);
    event HeldTokenDecimalMismatch(address indexed token, uint8 tokenDecimals, uint8 assetDecimals);
    event DepositAssetReserveBpsUpdated(uint256 bps);
    event AdminUnwindMaxDrawdownBpsUpdated(uint256 bps);
    event SpenderApprovalUpdated(address indexed token, address indexed spender, uint256 amount);
    event DebtReductionExecuted(
        address indexed target,
        uint256 value,
        address indexed inputToken,
        uint256 debtDecreased,
        address indexed debtToken,
        bytes32 intentHash
    );
    event CollateralReleased(
        address indexed operator, uint256 amount, address indexed recipient, bytes32 indexed intentHash
    );
    event CollateralReturned(address indexed operator, uint256 amount, uint256 credited);
    event CollateralWrittenDown(address indexed operator, uint256 amount);
    event MaxCollateralBpsUpdated(uint256 bps);
    event ValuationAdapterUpdated(address indexed token, address indexed adapter);
    event InKindRedeemed(address indexed caller, address indexed receiver, address indexed owner, uint256 shares);
    event UniswapEnvelopeConsumed(
        bytes32 indexed envelopeHash, bytes32 indexed envelopeId, uint256 amountIn, uint256 totalConsumed
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // IMMUTABLES
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice The deposit asset for this vault
    IERC20 private immutable _asset;

    /// @notice The shared share token (ERC-7575)
    VaultShare public immutable shareToken;

    /// @notice Policy engine for trade validation
    PolicyEngine public immutable policyEngine;

    /// @notice Trade validator for m-of-n signature verification
    TradeValidator public immutable tradeValidator;

    /// @notice Fee distributor for fee settlement
    FeeDistributor public immutable feeDistributor;

    /// @notice Tracks executed intent hashes to prevent duplicate execution
    ///         across multiple operators submitting the same trade
    mapping(bytes32 => bool) public executedIntents;

    /// @notice Whether wind-down mode is active (permissionless unwinds allowed, execute blocked)
    bool public windDownActive;

    /// @notice Timestamp when wind-down was activated (0 if not active)
    uint256 public windDownStartedAt;

    /// @notice Minimum time (seconds) a depositor must wait after deposit before withdrawing.
    ///         Prevents flash-deposit-withdraw attacks where a late depositor captures another
    ///         depositor's illiquid gains. Default 0 (no lockup). Set by admin.
    uint256 public depositLockupDuration;

    /// @notice Tracks the most recent deposit timestamp per address for lockup enforcement.
    mapping(address => uint256) public lastDepositTime;

    // ═══════════════════════════════════════════════════════════════════════════
    // MULTI-ASSET NAV TRACKING
    // ═══════════════════════════════════════════════════════════════════════════

    uint256 public constant MAX_HELD_TOKENS = 20;
    address[] public heldTokens;
    mapping(address => bool) public isHeldToken;
    uint256 public depositAssetReserveBps;
    uint256 public adminUnwindMaxDrawdownBps;
    mapping(address => IAssetValuator) public valuationAdapters;

    /// @notice Fallback drawdown cap used by adminUnwind when adminUnwindMaxDrawdownBps is 0.
    /// @dev Audit finding H-1: previously `adminUnwindMaxDrawdownBps = 0` meant "no limit",
    ///      so a compromised CREATOR_ROLE key could burn arbitrary vault value in a single
    ///      wind-down call. 0 now falls back to this constant (5%) so the cap always applies.
    ///      Explicit non-zero configurations continue to take precedence.
    uint256 public constant DEFAULT_ADMIN_UNWIND_MAX_DRAWDOWN_BPS = 500;

    // ═══════════════════════════════════════════════════════════════════════════
    // CLOB COLLATERAL MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════════

    uint256 public totalOutstandingCollateral;
    mapping(address => uint256) public operatorCollateral;
    uint256 public maxCollateralBps; // 0 = disabled (default)

    /// @notice Consumed input-token amount for signed Uniswap envelopes, keyed by envelope hash.
    mapping(bytes32 envelopeHash => uint256 amountIn) public envelopeConsumedAmountIn;

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════

    constructor(
        address assetToken,
        VaultShare _shareToken,
        PolicyEngine _policyEngine,
        TradeValidator _tradeValidator,
        FeeDistributor _feeDistributor,
        address admin,
        address operator
    ) {
        if (assetToken == address(0) || admin == address(0)) revert ZeroAddress();
        if (address(_shareToken) == address(0)) revert ZeroAddress();
        if (address(_policyEngine) == address(0)) revert ZeroAddress();
        if (address(_tradeValidator) == address(0)) revert ZeroAddress();
        if (address(_feeDistributor) == address(0)) revert ZeroAddress();

        _asset = IERC20(assetToken);
        shareToken = _shareToken;
        policyEngine = _policyEngine;
        tradeValidator = _tradeValidator;
        feeDistributor = _feeDistributor;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        if (operator != address(0)) {
            _grantRole(OPERATOR_ROLE, operator);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ERC-7575 / ERC-4626 INTERFACE
    // ═══════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IERC7575
    function share() external view override returns (address) {
        return address(shareToken);
    }

    /// @inheritdoc IERC7575
    function asset() public view override returns (address) {
        return address(_asset);
    }

    /// @inheritdoc IERC7575
    function totalAssets() public view override returns (uint256) {
        return IERC20(asset()).balanceOf(address(this)) + positionsValue() + totalOutstandingCollateral;
    }

    /// @dev Virtual offset to mitigate ERC-4626 inflation/donation attacks.
    ///      Adding 1 to supply and 1 to NAV ensures the first depositor cannot
    ///      manipulate share price via direct token transfer to the vault.
    ///      See: OpenZeppelin ERC4626 virtual shares pattern.
    uint256 private constant _VIRTUAL_OFFSET = 1;

    /// @inheritdoc IERC7575
    function convertToShares(uint256 assets) public view override returns (uint256) {
        uint256 supply = shareToken.totalSupply() + _VIRTUAL_OFFSET;
        uint256 nav = shareToken.totalNAV() + _VIRTUAL_OFFSET;
        return (assets * supply) / nav;
    }

    /// @inheritdoc IERC7575
    function convertToAssets(uint256 shares) public view override returns (uint256) {
        uint256 supply = shareToken.totalSupply() + _VIRTUAL_OFFSET;
        uint256 nav = shareToken.totalNAV() + _VIRTUAL_OFFSET;
        return (shares * nav) / supply;
    }

    /// @inheritdoc IERC7575
    /// @return Maximum depositable assets (0 when paused, type(uint256).max otherwise)
    function maxDeposit(address) external view override returns (uint256) {
        return (paused() || !_isNavSafe()) ? 0 : type(uint256).max;
    }

    /// @inheritdoc IERC7575
    function previewDeposit(uint256 assets) external view override returns (uint256) {
        return convertToShares(assets);
    }

    /// @inheritdoc IERC7575
    function deposit(uint256 assets, address receiver)
        external
        override
        nonReentrant
        whenNotPaused
        returns (uint256 shares)
    {
        if (assets == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        shares = convertToShares(assets);
        if (shares == 0) revert ZeroShares();

        _asset.safeTransferFrom(msg.sender, address(this), assets);
        shareToken.mint(receiver, shares);

        // Track deposit time for lockup enforcement.
        // Only set for self-deposits to prevent griefing: an attacker depositing
        // 1 wei to a victim's address must not reset the victim's lockup timer.
        if (msg.sender == receiver) {
            lastDepositTime[receiver] = block.timestamp;
        }

        emit Deposit(msg.sender, receiver, assets, shares);
    }

    /// @inheritdoc IERC7575
    /// @return Maximum withdrawable assets (capped by entitled shares and available liquidity)
    function maxWithdraw(address owner_) public view override returns (uint256) {
        if (paused()) return 0;
        if (_isDepositLocked(owner_)) return 0;
        if (!_isNavSafe()) return 0;
        uint256 entitled = convertToAssets(shareToken.balanceOf(owner_));
        uint256 liquid = liquidAssets();
        return entitled < liquid ? entitled : liquid;
    }

    /// @inheritdoc IERC7575
    /// @dev Rounds UP to ensure the caller burns at least enough shares.
    ///      ERC-4626 requires: previewWithdraw >= actual shares burned.
    function previewWithdraw(uint256 assets) external view override returns (uint256) {
        uint256 supply = shareToken.totalSupply() + _VIRTUAL_OFFSET;
        uint256 nav = shareToken.totalNAV() + _VIRTUAL_OFFSET;
        return (assets * supply + nav - 1) / nav;
    }

    /// @inheritdoc IERC7575
    /// @dev Rounds shares UP (ceiling division) per ERC-4626 spec:
    ///      withdraw must burn at least enough shares to cover the requested assets.
    function withdraw(uint256 assets, address receiver, address owner_)
        external
        override
        nonReentrant
        whenNotPaused
        returns (uint256 shares)
    {
        if (assets == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();
        _enforceDepositLockup(owner_);

        // Round UP: burn more shares to protect the vault from rounding exploits
        uint256 supply = shareToken.totalSupply() + _VIRTUAL_OFFSET;
        uint256 nav = shareToken.totalNAV() + _VIRTUAL_OFFSET;
        shares = (assets * supply + nav - 1) / nav;
        if (shares == 0) revert ZeroShares();

        uint256 liquid = liquidAssets();
        if (assets > liquid) revert InsufficientLiquidity(assets, liquid);

        _spendShareAllowance(owner_, shares);
        shareToken.burn(owner_, shares);
        _asset.safeTransfer(receiver, assets);

        emit Withdraw(msg.sender, receiver, owner_, assets, shares);
    }

    /// @inheritdoc IERC7575
    function maxRedeem(address owner_) public view override returns (uint256) {
        if (paused()) return 0;
        if (_isDepositLocked(owner_)) return 0;
        if (!_isNavSafe()) return 0;
        uint256 ownerShares = shareToken.balanceOf(owner_);
        uint256 liquid = liquidAssets();
        uint256 liquidShares = convertToShares(liquid);
        return ownerShares < liquidShares ? ownerShares : liquidShares;
    }

    /// @inheritdoc IERC7575
    function previewRedeem(uint256 shares) external view override returns (uint256) {
        return convertToAssets(shares);
    }

    /// @inheritdoc IERC7575
    function redeem(uint256 shares, address receiver, address owner_)
        external
        override
        nonReentrant
        whenNotPaused
        returns (uint256 assets)
    {
        if (shares == 0) revert ZeroShares();
        if (receiver == address(0)) revert ZeroAddress();
        _enforceDepositLockup(owner_);

        assets = convertToAssets(shares);
        if (assets == 0) revert ZeroAmount();

        uint256 liquid = liquidAssets();
        if (assets > liquid) revert InsufficientLiquidity(assets, liquid);

        _spendShareAllowance(owner_, shares);
        shareToken.burn(owner_, shares);
        _asset.safeTransfer(receiver, assets);

        emit Withdraw(msg.sender, receiver, owner_, assets, shares);
    }

    /// @notice Preview the exact token basket returned by an in-kind share redemption.
    function previewRedeemInKind(uint256 shares)
        external
        view
        returns (address[] memory tokens, uint256[] memory amounts)
    {
        return _previewRedeemInKind(shares);
    }

    /// @notice Redeem shares for a proportional basket of all vault-held tokens.
    function redeemInKind(uint256 shares, address receiver, address owner_)
        external
        nonReentrant
        whenNotPaused
        returns (address[] memory tokens, uint256[] memory amounts)
    {
        if (shares == 0) revert ZeroShares();
        if (receiver == address(0)) revert ZeroAddress();
        _enforceDepositLockup(owner_);
        if (totalOutstandingCollateral > 0) revert OutstandingCollateralActive(totalOutstandingCollateral);

        (tokens, amounts) = _previewRedeemInKind(shares);

        _spendShareAllowance(owner_, shares);
        shareToken.burn(owner_, shares);

        for (uint256 i = 0; i < tokens.length; i++) {
            if (amounts[i] > 0) {
                IERC20(tokens[i]).safeTransfer(receiver, amounts[i]);
            }
        }

        emit InKindRedeemed(msg.sender, receiver, owner_, shares);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TRADE EXECUTION
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Parameters for execute() — packed into struct to avoid stack-too-deep
    struct ExecuteParams {
        address target;
        bytes data;
        uint256 value;
        uint256 minOutput;
        address outputToken;
        bytes32 intentHash;
        uint256 deadline;
    }

    /// @notice Parameters for executions whose success is measured by debt-token balance decrease.
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

    /// @notice Parameters for executions whose success requires account health to remain above a threshold.
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

    /// @notice Atomic approval updates applied immediately before a trade executes.
    struct ApprovalCall {
        address token;
        address spender;
        uint256 amount;
    }

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

    /// @notice Execute a validated trade through an arbitrary target contract
    /// @dev Requires OPERATOR_ROLE + PolicyEngine approval + TradeValidator m-of-n sigs.
    ///      Blocked when wind-down mode is active — use unwind() instead.
    function execute(ExecuteParams calldata params, bytes[] calldata signatures, uint256[] calldata scores)
        external
        onlyRole(OPERATOR_ROLE)
        nonReentrant
        whenNotPaused
    {
        _prepareExecution(params, signatures, scores, EMPTY_APPROVALS_HASH);
        _executeTrade(params);
    }

    /// @notice Execute a validated trade with vault-held token approvals applied atomically.
    /// @dev Audit finding C-2: the `approvals[]` array is not hashed into the signed
    ///      intentHash, so historically an operator could pair a validator-signed trade
    ///      intent with arbitrary ERC-20 allowances to drain the vault. The fix binds
    ///      every approval's `spender` to `params.target` — the same address validators
    ///      see in the policy + target-whitelist path — which eliminates the rogue-spender
    ///      vector. Protocols that need allowance to a different address than the call
    ///      target should use a separate admin-only approval flow (`approveSpender`).
    function executeWithApprovals(
        ExecuteParams calldata params,
        ApprovalCall[] calldata approvals,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        _prepareExecution(params, signatures, scores, _hashApprovals(approvals));
        _applyApprovals(approvals, params.target);
        _executeTrade(params);
    }

    /// @notice Execute a validated debt-reducing action with vault-held token approvals.
    /// @dev Used for actions like Aave repay where success is debt reduction rather than output-token gain.
    function executeDebtReductionWithApprovals(
        DebtReductionParams calldata params,
        ApprovalCall[] calldata approvals,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        _prepareDebtReduction(params, signatures, scores, _hashApprovals(approvals));
        _applyApprovals(approvals, params.target);
        _executeDebtReduction(params);
    }

    /// @notice Execute a validated action and require Aave-style health factor to remain above the signed threshold.
    function executeHealthFactorWithApprovals(
        HealthFactorParams calldata params,
        ApprovalCall[] calldata approvals,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        _prepareHealthFactor(params, signatures, scores, _hashApprovals(approvals));
        _applyApprovals(approvals, params.target);
        _executeHealthFactor(params);
    }

    /// @notice Execute an exact-input Uniswap V3 swap authorized by a signed envelope.
    /// @dev This path skips per-trade validator signatures only after the TradeValidator
    ///      verifies the envelope proof against the vault signer set and this vault
    ///      enforces pair, router, time, amount, rate, and total-consumption bounds.
    function executeUniswapEnvelope(
        ExecuteParams calldata params,
        TradeValidator.UniswapEnvelope calldata envelope,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        ExactInputSingleParams memory swapParams = _prepareUniswapEnvelope(
            params, envelope, approvalSigners, signatures, scores
        );
        ApprovalCall[] memory approvals = new ApprovalCall[](1);
        approvals[0] = ApprovalCall({token: swapParams.tokenIn, spender: params.target, amount: swapParams.amountIn});
        _applyApprovalsMemory(approvals, params.target);
        _executeTrade(params);
    }

    function _prepareExecution(
        ExecuteParams calldata params,
        bytes[] calldata signatures,
        uint256[] calldata scores,
        bytes32 approvalsHash
    ) internal {
        if (windDownActive) revert WindDownBlocksExecute();
        if (params.target == address(0)) revert ZeroAddress();
        if (params.minOutput == 0) revert ZeroAmount();
        _requireValuableOutputToken(params.outputToken);

        // 0. Intent deduplication — prevents multiple operators executing the same trade
        if (executedIntents[params.intentHash]) revert IntentAlreadyExecuted(params.intentHash);
        executedIntents[params.intentHash] = true;

        // 1. Policy engine check
        _checkPolicy(params.outputToken, params.minOutput, params.target);

        // 2. Validator signature check (m-of-n EIP-712) — bind to execute action kind
        bytes32 executionHash = _computeExecutionHash(params, approvalsHash);
        _checkValidators(params.intentHash, executionHash, signatures, scores, params.deadline, ACTION_KIND_EXECUTE);
    }

    function _applyApprovals(ApprovalCall[] calldata approvals, address target) internal {
        for (uint256 i = 0; i < approvals.length; ++i) {
            ApprovalCall calldata approval = approvals[i];
            if (approval.token == address(0) || approval.spender == address(0)) revert ZeroAddress();
            if (approval.spender != target) revert ApprovalSpenderMismatch(approval.spender, target);
            IERC20(approval.token).forceApprove(approval.spender, approval.amount);
            emit SpenderApprovalUpdated(approval.token, approval.spender, approval.amount);
        }
    }

    function _applyApprovalsMemory(ApprovalCall[] memory approvals, address target) internal {
        for (uint256 i = 0; i < approvals.length; ++i) {
            ApprovalCall memory approval = approvals[i];
            if (approval.token == address(0) || approval.spender == address(0)) revert ZeroAddress();
            if (approval.spender != target) revert ApprovalSpenderMismatch(approval.spender, target);
            IERC20(approval.token).forceApprove(approval.spender, approval.amount);
            emit SpenderApprovalUpdated(approval.token, approval.spender, approval.amount);
        }
    }

    function _prepareUniswapEnvelope(
        ExecuteParams calldata params,
        TradeValidator.UniswapEnvelope calldata envelope,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) internal returns (ExactInputSingleParams memory swapParams) {
        if (windDownActive) revert WindDownBlocksExecute();
        if (params.target == address(0) || params.outputToken == address(0)) revert ZeroAddress();
        if (params.minOutput == 0) revert ZeroAmount();
        if (executedIntents[params.intentHash]) revert IntentAlreadyExecuted(params.intentHash);
        executedIntents[params.intentHash] = true;

        swapParams = _decodeExactInputSingle(params.data);
        if (
            envelope.vault != address(this) || envelope.chainId != block.chainid || envelope.router != params.target
                || envelope.tokenIn != swapParams.tokenIn || envelope.tokenOut != swapParams.tokenOut
                || envelope.action != UNISWAP_ACTION_SWAP || params.outputToken != swapParams.tokenOut
                || params.minOutput != swapParams.amountOutMinimum || swapParams.recipient != address(this)
        ) {
            revert EnvelopeCheckFailed();
        }
        if (block.timestamp < envelope.validFrom || block.timestamp > envelope.validUntil) revert EnvelopeExpired();
        if (swapParams.deadline < block.timestamp || params.deadline < block.timestamp) revert DeadlineExpired();
        if (swapParams.amountIn > envelope.maxSingleAmountIn) {
            revert EnvelopeAmountExceeded(swapParams.amountIn, envelope.maxSingleAmountIn);
        }

        uint256 requiredMinOutput = (swapParams.amountIn * envelope.minOutputPerInput + 1e18 - 1) / 1e18;
        if (swapParams.amountOutMinimum < requiredMinOutput) {
            revert EnvelopeRateTooLow(swapParams.amountOutMinimum, requiredMinOutput);
        }

        bytes32 envelopeHash = tradeValidator.hashUniswapEnvelope(envelope);
        uint256 consumed = envelopeConsumedAmountIn[envelopeHash];
        uint256 remaining = envelope.maxTotalAmountIn > consumed ? envelope.maxTotalAmountIn - consumed : 0;
        if (swapParams.amountIn > remaining) revert EnvelopeTotalExceeded(swapParams.amountIn, remaining);

        (bool ok,) = tradeValidator.validateUniswapEnvelope(envelope, approvalSigners, signatures, scores);
        if (!ok) revert ValidatorCheckFailed();

        _checkPolicy(params.outputToken, params.minOutput, params.target);
        envelopeConsumedAmountIn[envelopeHash] = consumed + swapParams.amountIn;
        emit UniswapEnvelopeConsumed(envelopeHash, envelope.envelopeId, swapParams.amountIn, consumed + swapParams.amountIn);
    }

    function _decodeExactInputSingle(bytes calldata data) internal pure returns (ExactInputSingleParams memory params) {
        if (data.length < 4 || bytes4(data[:4]) != UNISWAP_EXACT_INPUT_SINGLE_SELECTOR) revert EnvelopeCheckFailed();
        params = abi.decode(data[4:], (ExactInputSingleParams));
    }

    function _prepareDebtReduction(
        DebtReductionParams calldata params,
        bytes[] calldata signatures,
        uint256[] calldata scores,
        bytes32 approvalsHash
    ) internal {
        if (windDownActive) revert WindDownBlocksExecute();
        if (params.target == address(0) || params.inputToken == address(0) || params.debtToken == address(0)) {
            revert ZeroAddress();
        }
        if (params.maxInput == 0 || params.minDebtDecrease == 0) revert ZeroAmount();

        if (executedIntents[params.intentHash]) revert IntentAlreadyExecuted(params.intentHash);
        executedIntents[params.intentHash] = true;

        _checkPolicy(params.inputToken, params.maxInput, params.target);

        bytes32 executionHash = _computeDebtReductionHash(params, approvalsHash);
        _checkValidators(params.intentHash, executionHash, signatures, scores, params.deadline, ACTION_KIND_EXECUTE);
    }

    function _prepareHealthFactor(
        HealthFactorParams calldata params,
        bytes[] calldata signatures,
        uint256[] calldata scores,
        bytes32 approvalsHash
    ) internal {
        if (windDownActive) revert WindDownBlocksExecute();
        if (
            params.target == address(0) || params.outputToken == address(0) || params.pool == address(0)
                || params.account == address(0)
        ) {
            revert ZeroAddress();
        }
        if (params.minOutput == 0 || params.minHealthFactor == 0) revert ZeroAmount();
        _requireValuableOutputToken(params.outputToken);

        if (executedIntents[params.intentHash]) revert IntentAlreadyExecuted(params.intentHash);
        executedIntents[params.intentHash] = true;

        _checkPolicy(params.outputToken, params.minOutput, params.target);

        bytes32 executionHash = _computeHealthFactorHash(params, approvalsHash);
        _checkValidators(params.intentHash, executionHash, signatures, scores, params.deadline, ACTION_KIND_EXECUTE);
    }

    function _checkPolicy(address outputToken, uint256 minOutput, address target) internal {
        if (!policyEngine.validateTrade(address(this), outputToken, minOutput, target, 0)) {
            revert PolicyCheckFailed();
        }
    }

    function _checkValidators(
        bytes32 intentHash,
        bytes32 executionHash,
        bytes[] calldata signatures,
        uint256[] calldata scores,
        uint256 deadline,
        uint256 actionKind
    ) internal view {
        (bool ok,) = tradeValidator.validateWithSignatures(
            intentHash, executionHash, address(this), signatures, scores, deadline, actionKind
        );
        if (!ok) revert ValidatorCheckFailed();
    }

    /// @notice Compute the exact execution hash validators must sign for execute paths.
    function computeExecutionHash(ExecuteParams calldata params, ApprovalCall[] calldata approvals)
        external
        view
        returns (bytes32)
    {
        return _computeExecutionHash(params, _hashApprovals(approvals));
    }

    /// @notice Compute the exact execution hash validators must sign for debt-reduction paths.
    function computeDebtReductionHash(DebtReductionParams calldata params, ApprovalCall[] calldata approvals)
        external
        view
        returns (bytes32)
    {
        return _computeDebtReductionHash(params, _hashApprovals(approvals));
    }

    /// @notice Compute the exact execution hash validators must sign for health-factor paths.
    function computeHealthFactorHash(HealthFactorParams calldata params, ApprovalCall[] calldata approvals)
        external
        view
        returns (bytes32)
    {
        return _computeHealthFactorHash(params, _hashApprovals(approvals));
    }

    function _computeExecutionHash(ExecuteParams calldata params, bytes32 approvalsHash)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                EXECUTION_PAYLOAD_TYPEHASH,
                params.target,
                keccak256(params.data),
                params.value,
                params.minOutput,
                params.outputToken,
                params.intentHash,
                params.deadline,
                block.chainid,
                approvalsHash
            )
        );
    }

    function _computeDebtReductionHash(DebtReductionParams calldata params, bytes32 approvalsHash)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                DEBT_REDUCTION_PAYLOAD_TYPEHASH,
                params.target,
                keccak256(params.data),
                params.value,
                params.inputToken,
                params.maxInput,
                params.debtToken,
                params.minDebtDecrease,
                params.intentHash,
                params.deadline,
                block.chainid,
                approvalsHash
            )
        );
    }

    function _computeHealthFactorHash(HealthFactorParams calldata params, bytes32 approvalsHash)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                HEALTH_FACTOR_PAYLOAD_TYPEHASH,
                params.target,
                keccak256(params.data),
                params.value,
                params.minOutput,
                params.outputToken,
                params.pool,
                params.account,
                params.minHealthFactor,
                params.intentHash,
                params.deadline,
                block.chainid,
                approvalsHash
            )
        );
    }

    function _hashApprovals(ApprovalCall[] calldata approvals) internal pure returns (bytes32) {
        bytes memory packed;
        for (uint256 i = 0; i < approvals.length; ++i) {
            ApprovalCall calldata approval = approvals[i];
            packed = bytes.concat(
                packed,
                abi.encodePacked(
                    keccak256(abi.encode(APPROVAL_CALL_TYPEHASH, approval.token, approval.spender, approval.amount))
                )
            );
        }
        return keccak256(packed);
    }

    function _executeTrade(ExecuteParams calldata params) internal {
        uint256 balanceBefore;
        if (params.outputToken == address(0)) {
            balanceBefore = address(this).balance - params.value;
        } else {
            balanceBefore = IERC20(params.outputToken).balanceOf(address(this));
        }

        (bool success,) = params.target.call{value: params.value}(params.data);
        if (!success) revert ExecutionFailed();

        uint256 balanceAfter;
        if (params.outputToken == address(0)) {
            balanceAfter = address(this).balance;
        } else {
            balanceAfter = IERC20(params.outputToken).balanceOf(address(this));
        }

        uint256 outputGained = balanceAfter > balanceBefore ? balanceAfter - balanceBefore : 0;
        if (outputGained < params.minOutput) revert MinOutputNotMet(outputGained, params.minOutput);

        _checkFinalPositionLimit(params.outputToken);
        _addHeldToken(params.outputToken);

        if (depositAssetReserveBps > 0) {
            uint256 total = totalAssets();
            uint256 depositBalance = IERC20(asset()).balanceOf(address(this));
            if (depositBalance * 10000 < total * depositAssetReserveBps) revert DepositAssetBelowReserve();
        }

        emit TradeExecuted(params.target, params.value, outputGained, params.outputToken, params.intentHash);
    }

    function _executeDebtReduction(DebtReductionParams calldata params) internal {
        uint256 debtBefore = IERC20(params.debtToken).balanceOf(address(this));

        (bool success,) = params.target.call{value: params.value}(params.data);
        if (!success) revert ExecutionFailed();

        uint256 debtAfter = IERC20(params.debtToken).balanceOf(address(this));
        uint256 debtDecreased = debtBefore > debtAfter ? debtBefore - debtAfter : 0;
        if (debtDecreased < params.minDebtDecrease) {
            revert DebtDecreaseNotMet(debtDecreased, params.minDebtDecrease);
        }

        if (depositAssetReserveBps > 0) {
            uint256 total = totalAssets();
            uint256 depositBalance = IERC20(asset()).balanceOf(address(this));
            if (depositBalance * 10000 < total * depositAssetReserveBps) revert DepositAssetBelowReserve();
        }

        emit DebtReductionExecuted(
            params.target, params.value, params.inputToken, debtDecreased, params.debtToken, params.intentHash
        );
    }

    function _executeHealthFactor(HealthFactorParams calldata params) internal {
        uint256 balanceBefore = IERC20(params.outputToken).balanceOf(address(this));

        (bool success,) = params.target.call{value: params.value}(params.data);
        if (!success) revert ExecutionFailed();

        uint256 balanceAfter = IERC20(params.outputToken).balanceOf(address(this));
        uint256 outputGained = balanceAfter > balanceBefore ? balanceAfter - balanceBefore : 0;
        if (outputGained < params.minOutput) revert MinOutputNotMet(outputGained, params.minOutput);

        _checkFinalPositionLimit(params.outputToken);
        _addHeldToken(params.outputToken);

        (,,,,, uint256 healthFactor) = IAavePoolHealth(params.pool).getUserAccountData(params.account);
        if (healthFactor < params.minHealthFactor) {
            revert HealthFactorTooLow(healthFactor, params.minHealthFactor);
        }

        if (depositAssetReserveBps > 0) {
            uint256 total = totalAssets();
            uint256 depositBalance = IERC20(asset()).balanceOf(address(this));
            if (depositBalance * 10000 < total * depositAssetReserveBps) revert DepositAssetBelowReserve();
        }

        emit TradeExecuted(params.target, params.value, outputGained, params.outputToken, params.intentHash);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CLOB COLLATERAL MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Release vault collateral to an operator's EOA for off-chain CLOB trading.
    /// @dev Same security model as execute(): OPERATOR_ROLE + m-of-n validator sigs + intent dedup.
    ///      Outstanding collateral is tracked in totalAssets() so share price stays stable.
    /// @param amount Amount of deposit asset to release
    /// @param recipient Address to receive the collateral (typically operator's EOA)
    /// @param intentHash Unique hash for intent deduplication
    /// @param deadline EIP-712 signature deadline
    /// @param signatures Validator signatures
    /// @param scores Validator scores
    function releaseCollateral(
        uint256 amount,
        address recipient,
        bytes32 intentHash,
        uint256 deadline,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        if (windDownActive) revert WindDownBlocksExecute();
        if (amount == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();
        if (maxCollateralBps == 0) revert CollateralNotEnabled();

        // Intent deduplication
        if (executedIntents[intentHash]) revert IntentAlreadyExecuted(intentHash);
        executedIntents[intentHash] = true;

        // BPS cap: totalOutstanding + amount <= totalAssets * maxCollateralBps / 10000
        // Use totalAssets() which already includes current totalOutstandingCollateral
        uint256 maxAllowed = totalAssets() * maxCollateralBps / 10000;
        if (totalOutstandingCollateral + amount > maxAllowed) {
            revert ExceedsCollateralLimit(amount, maxAllowed - totalOutstandingCollateral);
        }

        // Validator signature check — bind to exact release payload and action kind
        bytes32 executionHash = computeCollateralReleaseHash(amount, recipient, intentHash, deadline);
        _checkValidators(intentHash, executionHash, signatures, scores, deadline, ACTION_KIND_RELEASE_COLLATERAL);

        // CEI: update state before transfer
        totalOutstandingCollateral += amount;
        operatorCollateral[msg.sender] += amount;

        _asset.safeTransfer(recipient, amount);

        emit CollateralReleased(msg.sender, amount, recipient, intentHash);
    }

    /// @notice Compute the exact collateral release hash validators must sign.
    function computeCollateralReleaseHash(uint256 amount, address recipient, bytes32 intentHash, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return
            keccak256(abi.encode(COLLATERAL_RELEASE_TYPEHASH, amount, recipient, intentHash, deadline, block.chainid));
    }

    /// @notice Return collateral to the vault. Permissionless — anyone can return funds.
    /// @dev Credits against the sender's outstanding collateral. Any excess above
    ///      outstanding is profit that increases vault NAV (share price goes up).
    /// @param amount Amount of deposit asset to return
    function returnCollateral(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();

        _asset.safeTransferFrom(msg.sender, address(this), amount);

        // Credit against sender's outstanding, capped at their actual outstanding
        uint256 outstanding = operatorCollateral[msg.sender];
        uint256 credited = amount < outstanding ? amount : outstanding;

        if (credited > 0) {
            operatorCollateral[msg.sender] -= credited;
            totalOutstandingCollateral -= credited;
        }

        emit CollateralReturned(msg.sender, amount, credited);
    }

    /// @notice Write down unreturnable collateral (admin acknowledges loss).
    /// @dev Reduces outstanding tracking → totalAssets() drops → share price drops.
    ///      LPs absorb the loss through reduced share value.
    /// @param operator_ The operator whose collateral to write down
    /// @param amount Amount to write down (capped at actual outstanding)
    function writeDownCollateral(address operator_, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 outstanding = operatorCollateral[operator_];
        uint256 actual = amount < outstanding ? amount : outstanding;
        if (actual == 0) return;

        operatorCollateral[operator_] -= actual;
        totalOutstandingCollateral -= actual;

        emit CollateralWrittenDown(operator_, actual);
    }

    /// @notice Enable/configure the collateral BPS cap.
    /// @dev 0 = disabled (default for existing vaults), 5000 = 50% of NAV.
    /// @param bps Max outstanding collateral as basis points of totalAssets
    function setMaxCollateralBps(uint256 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > 10000) revert InvalidBps();
        maxCollateralBps = bps;
        emit MaxCollateralBpsUpdated(bps);
    }

    /// @notice Available collateral: min(BPS cap headroom, liquid deposit asset balance).
    function availableCollateral() external view returns (uint256) {
        if (maxCollateralBps == 0) return 0;
        uint256 maxAllowed = totalAssets() * maxCollateralBps / 10000;
        uint256 headroom = maxAllowed > totalOutstandingCollateral ? maxAllowed - totalOutstandingCollateral : 0;
        uint256 liquid = IERC20(asset()).balanceOf(address(this));
        return headroom < liquid ? headroom : liquid;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // WIND-DOWN — PERMISSIONLESS POSITION UNWINDING
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Activate wind-down mode. Blocks execute(), enables permissionless unwind().
    /// @dev Callable by admin (BSM) or service creator. Typically triggered when the
    ///      trading bot's TTL is approaching expiry.
    function activateWindDown() external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender) && !hasRole(CREATOR_ROLE, msg.sender)) {
            revert AccessControlUnauthorizedAccount(msg.sender, CREATOR_ROLE);
        }
        if (windDownActive) revert WindDownAlreadyActive();
        windDownActive = true;
        windDownStartedAt = block.timestamp;
        emit WindDownActivated(block.timestamp);
    }

    /// @notice Deactivate wind-down mode (e.g. if vault is recovered by a new service).
    function deactivateWindDown() external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender) && !hasRole(CREATOR_ROLE, msg.sender)) {
            revert AccessControlUnauthorizedAccount(msg.sender, CREATOR_ROLE);
        }
        if (!windDownActive) revert WindDownNotActive();
        windDownActive = false;
        windDownStartedAt = 0;
        emit WindDownDeactivated(block.timestamp);
    }

    /// @notice Permissionless position unwind — anyone can close positions back to the vault.
    /// @dev Safety invariant: the vault's deposit asset balance can only increase.
    ///      No signatures or operator role required. Only callable during wind-down.
    ///      Target must be whitelisted in PolicyEngine (reuses existing whitelist).
    /// @param target The protocol contract to call (must be whitelisted)
    /// @param data The calldata to execute (e.g. Aave withdraw, GMX close position)
    /// @param value ETH value to send (for protocols that require it)
    function unwind(address target, bytes calldata data, uint256 value) external nonReentrant {
        if (!windDownActive) revert WindDownNotActive();
        if (target == address(0)) revert ZeroAddress();

        // Target must be in the PolicyEngine whitelist — reuse existing infra
        if (!policyEngine.targetWhitelisted(address(this), target)) {
            revert TargetNotWhitelisted(target);
        }

        // Snapshot deposit asset balance
        uint256 assetBefore = _asset.balanceOf(address(this));

        // Execute the unwind call
        (bool success,) = target.call{value: value}(data);
        if (!success) revert ExecutionFailed();

        // Safety invariant: deposit asset balance can only increase
        uint256 assetAfter = _asset.balanceOf(address(this));
        if (assetAfter < assetBefore) revert AssetBalanceDecreased(assetBefore, assetAfter);

        uint256 gained = assetAfter - assetBefore;
        emit PositionUnwound(msg.sender, target, gained);
    }

    /// @notice Creator-only unwind for multi-step or delayed operations.
    /// @dev No deposit-asset balance invariant — the service creator is trusted to
    ///      use this for legitimate multi-step unwinds (intermediate token swaps,
    ///      withdrawal queue requests, fee-paying close operations).
    ///      Target must still be whitelisted.
    /// @param target The protocol contract to call (must be whitelisted)
    /// @param data The calldata to execute
    /// @param value ETH value to send
    function adminUnwind(address target, bytes calldata data, uint256 value)
        external
        onlyRole(CREATOR_ROLE)
        nonReentrant
    {
        if (!windDownActive) revert WindDownNotActive();
        if (target == address(0)) revert ZeroAddress();

        if (!policyEngine.targetWhitelisted(address(this), target)) {
            revert TargetNotWhitelisted(target);
        }

        uint256 totalBefore = totalAssets();
        uint256 assetBefore = _asset.balanceOf(address(this));

        (bool success,) = target.call{value: value}(data);
        if (!success) revert ExecutionFailed();

        // Audit H-1: always enforce a drawdown cap. 0 falls back to the default (5%) rather
        // than being interpreted as "unlimited". Non-zero values continue to override.
        uint256 drawdownCap =
            adminUnwindMaxDrawdownBps == 0 ? DEFAULT_ADMIN_UNWIND_MAX_DRAWDOWN_BPS : adminUnwindMaxDrawdownBps;
        uint256 totalAfter = totalAssets();
        if (totalBefore > 0 && totalAfter * 10000 < totalBefore * (10000 - drawdownCap)) {
            revert ExcessiveDrawdown();
        }

        uint256 assetAfter = _asset.balanceOf(address(this));
        uint256 gained = assetAfter > assetBefore ? assetAfter - assetBefore : 0;
        emit PositionUnwound(msg.sender, target, gained);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EMERGENCY
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Emergency withdraw all tokens of a given type (ADMIN only)
    function emergencyWithdraw(address token, address to) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (to == address(0)) revert ZeroAddress();

        uint256 amount;
        if (token == address(0)) {
            amount = address(this).balance;
            (bool success,) = to.call{value: amount}("");
            if (!success) revert ExecutionFailed();
        } else {
            amount = IERC20(token).balanceOf(address(this));
            if (amount > 0) {
                IERC20(token).safeTransfer(to, amount);
            }
        }

        emit EmergencyWithdraw(token, to, amount);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CIRCUIT BREAKER
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Pause the vault, blocking deposits, withdrawals, redeems, and executions
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    /// @notice Unpause the vault, re-enabling all operations
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // VIEW
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Get the vault's balance of a given token
    function getBalance(address token) external view returns (uint256) {
        if (token == address(0)) {
            return address(this).balance;
        }
        return IERC20(token).balanceOf(address(this));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DEPOSIT LOCKUP CONFIGURATION
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Set the deposit lockup duration (seconds). Depositors must wait
    ///         this long after their most recent deposit before withdrawing.
    ///         Prevents flash-deposit-withdraw liquidity attacks.
    /// @param duration Lockup duration in seconds (0 = no lockup, 86400 = 1 day)
    function setDepositLockup(uint256 duration) external onlyRole(DEFAULT_ADMIN_ROLE) {
        depositLockupDuration = duration;
        emit DepositLockupUpdated(duration);
    }

    /// @notice Approve a specific fee allowance for the FeeDistributor (admin only)
    /// @dev Uses forceApprove (SafeERC20) to handle tokens with non-standard approve behavior
    function approveFeeAllowance(uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        IERC20(asset()).forceApprove(address(feeDistributor), amount);
    }

    /// @notice Approve a spender to move a vault-held token.
    /// @dev Vault-based protocols require allowances to be granted by the vault,
    ///      not by the off-chain operator wallet. Operators can update allowances
    ///      as a preparatory step before executing the main protocol action.
    function approveSpender(address token, address spender, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        whenNotPaused
    {
        if (token == address(0) || spender == address(0)) revert ZeroAddress();
        IERC20(token).forceApprove(spender, amount);
        emit SpenderApprovalUpdated(token, spender, amount);
    }

    /// @notice Set the minimum deposit asset reserve ratio (in BPS)
    /// @dev When non-zero, execute() reverts if the deposit asset balance falls below
    ///      this percentage of totalAssets after a trade. Prevents over-allocation to positions.
    /// @param bps Reserve ratio in basis points (0 = no reserve, 5000 = 50%)
    function setDepositAssetReserveBps(uint256 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > 10000) revert InvalidBps();
        depositAssetReserveBps = bps;
        emit DepositAssetReserveBpsUpdated(bps);
    }

    /// @notice Set the maximum total-asset drawdown allowed per adminUnwind call (in BPS)
    /// @dev When non-zero, adminUnwind() reverts if totalAssets decreases by more than this
    ///      percentage. Limits the damage a CREATOR_ROLE holder can do in a single unwind.
    ///      Default 0 means no drawdown limit — set a value for defense-in-depth.
    /// @param bps Max drawdown in basis points (0 = unrestricted, 500 = 5%)
    function setAdminUnwindMaxDrawdownBps(uint256 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > 10000) revert InvalidBps();
        adminUnwindMaxDrawdownBps = bps;
        emit AdminUnwindMaxDrawdownBpsUpdated(bps);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // MULTI-ASSET POSITION TRACKING
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Sum of held-token balances, valued in deposit asset units.
    /// @dev Non-deposit held tokens must have a configured valuation adapter.
    function positionsValue() public view returns (uint256 total) {
        address depositAsset = asset();
        for (uint256 i = 0; i < heldTokens.length; i++) {
            address token = heldTokens[i];
            uint256 bal = IERC20(token).balanceOf(address(this));
            if (bal == 0) continue;
            IAssetValuator adapter = valuationAdapters[token];
            if (address(adapter) == address(0) || !adapter.isSupported(token, depositAsset)) {
                revert UnsupportedValuationAsset(token, depositAsset);
            }
            total += adapter.valueInAsset(token, bal, depositAsset);
        }
    }

    /// @notice True when every nonzero held token can be priced right now.
    function isNavSafe() external view returns (bool) {
        return _isNavSafe();
    }

    /// @notice Get the list of non-deposit tokens held by this vault
    function getHeldTokens() external view returns (address[] memory) {
        return heldTokens;
    }

    /// @notice Number of non-deposit tokens currently held by this vault
    function heldTokenCount() external view returns (uint256) {
        return heldTokens.length;
    }

    /// @notice Deposit asset balance available for immediate withdrawal
    function liquidAssets() public view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    /// @notice Set the adapter used to value a held token in this vault's deposit asset.
    function setValuationAdapter(address token, address adapter) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        valuationAdapters[token] = IAssetValuator(adapter);
        emit ValuationAdapterUpdated(token, adapter);
    }

    /// @notice Replace the held token list. Skips the deposit asset and enforces MAX_HELD_TOKENS.
    /// @dev Admin-only (DEFAULT_ADMIN_ROLE). Audit finding C-1: this function was previously
    ///      OPERATOR_ROLE-callable, which let an operator mutate positionsValue() directly and
    ///      manipulate NAV in the share-price window. In provisioned vaults the admin is the
    ///      BSM blueprint contract, so this becomes a migration/recovery tool rather than an
    ///      operator-reachable NAV knob. Under normal operation `_addHeldToken` populates this
    ///      list automatically on every successful trade — this function should only be needed
    ///      for emergency cleanup or post-upgrade migration.
    function updateHeldTokens(address[] calldata tokens) external onlyRole(DEFAULT_ADMIN_ROLE) {
        // Clear existing — only allow tokens currently carrying zero balance. Removing a token
        // with nonzero balance would zero its contribution to positionsValue() and drop NAV.
        for (uint256 i = 0; i < heldTokens.length; i++) {
            address held = heldTokens[i];
            uint256 bal = IERC20(held).balanceOf(address(this));
            if (bal > 0) revert HeldTokenNotEmpty(held, bal);
            isHeldToken[held] = false;
        }
        delete heldTokens;
        // Add new (skip deposit asset, enforce max)
        address depositAsset = asset();
        for (uint256 i = 0; i < tokens.length && i < MAX_HELD_TOKENS; i++) {
            if (tokens[i] != depositAsset && !isHeldToken[tokens[i]]) {
                heldTokens.push(tokens[i]);
                isHeldToken[tokens[i]] = true;
            }
        }
    }

    /// @notice Remove a single held token from the tracking list.
    /// @dev Admin-only (DEFAULT_ADMIN_ROLE) + requires the token's current balance to be zero.
    ///      Audit finding C-1: previously OPERATOR_ROLE with no balance check — operator could
    ///      drop a held token right before a deposit to manipulate share price. Zero-balance
    ///      enforcement means this is now a pure cleanup operation.
    function removeHeldToken(address token) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) revert HeldTokenNotEmpty(token, bal);
        _removeHeldToken(token);
    }

    function _addHeldToken(address token) internal {
        if (token == address(0) || token == asset() || isHeldToken[token] || heldTokens.length >= MAX_HELD_TOKENS) {
            return;
        }
        heldTokens.push(token);
        isHeldToken[token] = true;

        // Warn if decimals don't match — positionsValue() sums raw balances
        try IERC20Metadata(token).decimals() returns (uint8 tokenDec) {
            try IERC20Metadata(asset()).decimals() returns (uint8 assetDec) {
                if (tokenDec != assetDec) {
                    emit HeldTokenDecimalMismatch(token, tokenDec, assetDec);
                }
            } catch {}
        } catch {}
    }

    function _previewRedeemInKind(uint256 shares)
        internal
        view
        returns (address[] memory tokens, uint256[] memory amounts)
    {
        if (shares == 0) revert ZeroShares();
        uint256 supply = shareToken.totalSupply();
        if (supply == 0 || shares > supply) revert InsufficientBalance();

        tokens = new address[](heldTokens.length + 1);
        amounts = new uint256[](heldTokens.length + 1);
        tokens[0] = asset();
        amounts[0] = IERC20(tokens[0]).balanceOf(address(this)) * shares / supply;

        for (uint256 i = 0; i < heldTokens.length; i++) {
            tokens[i + 1] = heldTokens[i];
            amounts[i + 1] = IERC20(heldTokens[i]).balanceOf(address(this)) * shares / supply;
        }
    }

    function _requireValuableOutputToken(address token) internal view {
        address depositAsset = asset();
        if (token == address(0) || token == depositAsset) return;
        IAssetValuator adapter = valuationAdapters[token];
        if (address(adapter) == address(0) || !adapter.isSupported(token, depositAsset)) {
            revert UnsupportedValuationAsset(token, depositAsset);
        }
    }

    function _checkFinalPositionLimit(address token) internal view {
        uint256 limit = policyEngine.positionLimit(address(this), token);
        if (limit == 0) return;

        uint256 exposure = token == address(0) ? address(this).balance : IERC20(token).balanceOf(address(this));
        if (exposure > limit) revert PositionLimitExceeded(token, exposure, limit);
    }

    function _isNavSafe() internal view returns (bool) {
        address depositAsset = asset();
        for (uint256 i = 0; i < heldTokens.length; i++) {
            address token = heldTokens[i];
            uint256 bal = IERC20(token).balanceOf(address(this));
            if (bal == 0) continue;
            IAssetValuator adapter = valuationAdapters[token];
            if (address(adapter) == address(0)) return false;
            try adapter.valueInAsset(token, bal, depositAsset) returns (
                uint256
            ) {
            // A successful valuation is enough; zero value is allowed for dust.
            }
            catch {
                return false;
            }
        }
        return true;
    }

    function _removeHeldToken(address token) internal {
        if (!isHeldToken[token]) return;
        isHeldToken[token] = false;
        for (uint256 i = 0; i < heldTokens.length; i++) {
            if (heldTokens[i] == token) {
                heldTokens[i] = heldTokens[heldTokens.length - 1];
                heldTokens.pop();
                break;
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // INTERNALS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev Check if an address is currently within the deposit lockup period (view).
    function _isDepositLocked(address owner_) internal view returns (bool) {
        if (depositLockupDuration == 0) return false;
        uint256 depositTime = lastDepositTime[owner_];
        if (depositTime == 0) return false;
        return block.timestamp < depositTime + depositLockupDuration;
    }

    /// @dev Enforce deposit lockup: revert if the owner deposited too recently.
    function _enforceDepositLockup(address owner_) internal view {
        if (_isDepositLocked(owner_)) {
            revert WithdrawalLocked(lastDepositTime[owner_] + depositLockupDuration);
        }
    }

    /// @dev Check and spend share token allowance if caller is not the owner.
    ///      Uses VaultShare.spendAllowance() to atomically decrement the ERC-20
    ///      allowance since we burn shares directly (no transferFrom).
    function _spendShareAllowance(address owner_, uint256 shares) internal {
        if (msg.sender != owner_) {
            shareToken.spendAllowance(owner_, msg.sender, shares);
        }
    }

    /// @notice Accept native ETH
    receive() external payable {}
}
