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

        // CEI: write deposit-time state BEFORE any external call. Self-deposit
        // grief-guard semantics are unchanged (still gated on
        // `msg.sender == receiver`); a failed transfer/mint reverts the tx
        // and rolls back this write atomically.
        if (msg.sender == receiver) {
            lastDepositTime[receiver] = block.timestamp;
        }

        _asset.safeTransferFrom(msg.sender, address(this), assets);
        shareToken.mint(receiver, shares);

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
        // Audit M-1: clear residual allowance to prevent the router from pulling later.
        _resetApprovals(approvals);
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
        // Audit M-1: clear residual allowance to prevent the router from pulling later.
        _resetApprovals(approvals);
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
        // Audit M-1: clear residual allowance to prevent the router from pulling later.
        _resetApprovals(approvals);
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

    /// @dev Audit M-1: reset every approval to 0 after the trade. Pairs with `_applyApprovals`.
    ///      A misbehaving / upgraded router could otherwise pull the residual allowance after
    ///      the executor returns. Reverts in the executor unwind the whole tx so this only
    ///      runs on success.
    function _resetApprovals(ApprovalCall[] calldata approvals) internal {
        for (uint256 i = 0; i < approvals.length; ++i) {
            ApprovalCall calldata approval = approvals[i];
            IERC20(approval.token).forceApprove(approval.spender, 0);
            emit SpenderApprovalUpdated(approval.token, approval.spender, 0);
        }
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
        // Validator returns (bool ok, uint256 validCount). `validCount` is
        // diagnostic-only — `ok` is the auth gate, and the validator reverts
        // upstream on insufficient-validator conditions.
        // slither-disable-next-line unused-return
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
        // Explicit init silences slither's `uninitialized-local` detector.
        // Solidity already zero-initializes `bytes memory` to length 0, so
        // behavior is identical — this just documents intent at the site.
        bytes memory packed = new bytes(0);
        uint256 n = approvals.length;
        for (uint256 i = 0; i < n; ++i) {
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

        // CEI: register the output token in `heldTokens` BEFORE the external
        // call so no state write trails the call. The bookkeeping is
        // idempotent (`isHeldToken` guard) and a failed/reverting call
        // rolls back the storage write atomically.
        _addHeldToken(params.outputToken);

        // arbitrary-send-eth: validator-signed envelope authorizes
        //   (target, value, data, outputToken, minOutput); slither cannot
        //   model the cryptographic gate.
        // reentrancy-balance: post-call balance read IS the slippage check —
        //   that's the function purpose. nonReentrant blocks re-entry, so
        //   the read is guaranteed fresh-after-call.
        // slither-disable-next-line arbitrary-send-eth,reentrancy-balance
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

        if (depositAssetReserveBps > 0) {
            uint256 total = totalAssets();
            uint256 depositBalance = IERC20(asset()).balanceOf(address(this));
            if (depositBalance * 10000 < total * depositAssetReserveBps) revert DepositAssetBelowReserve();
        }

        emit TradeExecuted(params.target, params.value, outputGained, params.outputToken, params.intentHash);
    }

    function _executeDebtReduction(DebtReductionParams calldata params) internal {
        uint256 debtBefore = IERC20(params.debtToken).balanceOf(address(this));

        // arbitrary-send-eth: validator-signed envelope authorizes target.
        // reentrancy-balance: post-call read IS the debt-decrease check.
        //   nonReentrant blocks re-entry, so the read is fresh-after-call.
        // slither-disable-next-line arbitrary-send-eth,reentrancy-balance
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

        // CEI: register the output token before the external call (see
        // `_executeTrade` rationale). Idempotent + tx-reverts-roll-back.
        _addHeldToken(params.outputToken);

        // arbitrary-send-eth + reentrancy-balance: see `_executeTrade`.
        // slither-disable-next-line arbitrary-send-eth,reentrancy-balance
        (bool success,) = params.target.call{value: params.value}(params.data);
        if (!success) revert ExecutionFailed();

        uint256 balanceAfter = IERC20(params.outputToken).balanceOf(address(this));
        uint256 outputGained = balanceAfter > balanceBefore ? balanceAfter - balanceBefore : 0;
        if (outputGained < params.minOutput) revert MinOutputNotMet(outputGained, params.minOutput);

        _checkFinalPositionLimit(params.outputToken);

        // Aave returns (totalCollateralBase, totalDebtBase, availableBorrowsBase,
        // currentLiquidationThreshold, ltv, healthFactor); only healthFactor
        // gates the post-borrow / post-withdraw safety check.
        // slither-disable-next-line unused-return
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

        // Execute the unwind call. The post-call balance comparison IS the
        // drawdown-cap check (purpose of the function). The target is
        // whitelisted via `whitelistedRouters[target]` upstream and the
        // function is nonReentrant + role-gated, so the read is
        // guaranteed fresh-after-call.
        // slither-disable-next-line arbitrary-send-eth,reentrancy-balance
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

        // adminUnwind path: target is gated by `whitelistedRouters[target]`
        // check above. Post-call balance compare is the drawdown-cap check;
        // nonReentrant + DEFAULT_ADMIN_ROLE keep the read fresh.
        // slither-disable-next-line arbitrary-send-eth,reentrancy-balance
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
            // slither-disable-next-line arbitrary-send-eth
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
        uint256 len = heldTokens.length;
        // calls-loop: heldTokens is admin-curated and capped at MAX_HELD_TOKENS
        // (32). Per-iter calls (balanceOf + valuator) are required to compute
        // NAV; the bounded length prevents the unbounded-growth DOS the
        // detector targets.
        for (uint256 i = 0; i < len; i++) {
            address token = heldTokens[i];
            // slither-disable-next-line calls-loop
            uint256 bal = IERC20(token).balanceOf(address(this));
            if (bal == 0) continue;
            IAssetValuator adapter = valuationAdapters[token];
            // slither-disable-next-line calls-loop
            if (address(adapter) == address(0) || !adapter.isSupported(token, depositAsset)) {
                revert UnsupportedValuationAsset(token, depositAsset);
            }
            // slither-disable-next-line calls-loop
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
        // calls-loop: bounded by MAX_HELD_TOKENS = 32 (cap enforced on writes
        // to `heldTokens`); per-iter balanceOf is required for the
        // zero-balance precondition.
        uint256 heldLen = heldTokens.length;
        for (uint256 i = 0; i < heldLen; i++) {
            address held = heldTokens[i];
            // slither-disable-next-line calls-loop
            uint256 bal = IERC20(held).balanceOf(address(this));
            if (bal > 0) revert HeldTokenNotEmpty(held, bal);
            isHeldToken[held] = false;
        }
        delete heldTokens;
        // Add new (skip deposit asset, enforce max)
        address depositAsset = asset();
        uint256 newLen = tokens.length;
        uint256 cap = newLen < MAX_HELD_TOKENS ? newLen : MAX_HELD_TOKENS;
        for (uint256 i = 0; i < cap; i++) {
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

        uint256 len = heldTokens.length;
        tokens = new address[](len + 1);
        amounts = new uint256[](len + 1);
        tokens[0] = asset();
        amounts[0] = IERC20(tokens[0]).balanceOf(address(this)) * shares / supply;

        // calls-loop: bounded admin-curated heldTokens (cap 32). Per-iter
        // balanceOf is required to compute the in-kind redemption split.
        for (uint256 i = 0; i < len; i++) {
            tokens[i + 1] = heldTokens[i];
            // slither-disable-next-line calls-loop
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
        uint256 len = heldTokens.length;
        // calls-loop: bounded admin-curated heldTokens (cap 32). The probe
        // calls are inherent to the safety check.
        for (uint256 i = 0; i < len; i++) {
            address token = heldTokens[i];
            // slither-disable-next-line calls-loop
            uint256 bal = IERC20(token).balanceOf(address(this));
            if (bal == 0) continue;
            IAssetValuator adapter = valuationAdapters[token];
            if (address(adapter) == address(0)) return false;
            // _isNavSafe is a pricing probe — a successful return means the
            // token can be priced; the value itself is irrelevant here
            // (positionsValue() uses it). Any catch means the token cannot
            // be safely valued. calls-loop is suppressed because the loop
            // is bounded by MAX_HELD_TOKENS = 32 (see loop-level note above).
            // slither-disable-next-line unused-return,calls-loop
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
        uint256 len = heldTokens.length;
        for (uint256 i = 0; i < len; i++) {
            if (heldTokens[i] == token) {
                heldTokens[i] = heldTokens[len - 1];
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

    // ═══════════════════════════════════════════════════════════════════════════
    // ENVELOPE EXECUTION (per-protocol, signed-envelope-authorized)
    //
    // Each executeXxxEnvelope decodes the protocol's calldata, binds it to
    // the enforcement struct, asks TradeValidator to verify the envelope
    // signatures, tracks consumed amount per envelope hash, then dispatches to
    // the existing _executeTrade / _executeDebtReduction / _executeHealthFactor.
    // ═══════════════════════════════════════════════════════════════════════════

    error EnvelopeCheckFailed();
    error EnvelopeExpired();
    error EnvelopeNotYetActive();
    error EnvelopeWrongVault();
    error EnvelopeWrongChain();
    error EnvelopeAmountExceeded(uint256 requested, uint256 limit);
    error EnvelopeTotalExceeded(uint256 requested, uint256 remaining);
    error EnvelopeRateTooLow(uint256 actualMinOutput, uint256 requiredMinOutput);
    error EnvelopeWrongSelector();

    event EnvelopeConsumed(bytes32 indexed envelopeHash, uint256 amount, uint256 totalConsumed);

    /// @notice Consumed input-amount per envelope hash. Universal across all protocols.
    mapping(bytes32 envelopeHash => uint256 consumed) public envelopeConsumedAmount;

    /// @dev Selectors for protocol entry-point calldata decoding.
    bytes4 private constant SELECTOR_UNI_V3_EXACT_INPUT_SINGLE = 0x414bf389; // exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))
    bytes4 private constant SELECTOR_AERODROME_EXACT_INPUT_SINGLE =
        bytes4(keccak256("exactInputSingle((address,address,int24,address,uint256,uint256,uint256,uint160))"));
    /// @dev PancakeSwap V3 router uses the same `exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))`
    ///      ABI as Uniswap V3, so we reuse SELECTOR_UNI_V3_EXACT_INPUT_SINGLE for decoding.
    /// @dev Curve StableSwap pool: `exchange(int128 i, int128 j, uint256 dx, uint256 min_dy)`.
    bytes4 private constant SELECTOR_CURVE_EXCHANGE = bytes4(keccak256("exchange(int128,int128,uint256,uint256)"));
    /// @dev Universal Router 2.0 `execute(bytes,bytes[],uint256)` selector.
    bytes4 private constant SELECTOR_UR_EXECUTE = bytes4(keccak256("execute(bytes,bytes[],uint256)"));
    /// @dev V4_SWAP command id within Universal Router commands buffer.
    uint8 private constant UR_COMMAND_V4_SWAP = 0x10;
    /// @dev V4Router action id for SWAP_EXACT_IN_SINGLE within the V4 actions buffer.
    uint8 private constant V4_ACTION_SWAP_EXACT_IN_SINGLE = 0x06;
    bytes4 private constant SELECTOR_AAVE_SUPPLY = bytes4(keccak256("supply(address,uint256,address,uint16)"));
    bytes4 private constant SELECTOR_AAVE_WITHDRAW = bytes4(keccak256("withdraw(address,uint256,address)"));
    bytes4 private constant SELECTOR_AAVE_BORROW = bytes4(keccak256("borrow(address,uint256,uint256,uint16,address)"));
    bytes4 private constant SELECTOR_AAVE_REPAY = bytes4(keccak256("repay(address,uint256,uint256,address)"));
    bytes4 private constant SELECTOR_MORPHO_SUPPLY =
        bytes4(keccak256("supply((address,address,address,address,uint256),uint256,uint256,address,bytes)"));
    bytes4 private constant SELECTOR_MORPHO_WITHDRAW =
        bytes4(keccak256("withdraw((address,address,address,address,uint256),uint256,uint256,address,address)"));
    bytes4 private constant SELECTOR_MORPHO_BORROW =
        bytes4(keccak256("borrow((address,address,address,address,uint256),uint256,uint256,address,address)"));
    bytes4 private constant SELECTOR_MORPHO_REPAY =
        bytes4(keccak256("repay((address,address,address,address,uint256),uint256,uint256,address,bytes)"));

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

    /// @dev V4 PoolKey decoded inline from V4Router actions buffer.
    struct V4PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    /// @dev V4Router exact-input-single params from the actions buffer.
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

    // ── Shared envelope helpers ──

    function _checkEnvelopeBasics(TradeValidator.Envelope calldata env) internal view {
        if (env.vault != address(this)) revert EnvelopeWrongVault();
        if (env.chainId != block.chainid) revert EnvelopeWrongChain();
        if (block.timestamp < env.issuedAt) revert EnvelopeNotYetActive();
        if (block.timestamp > env.expiresAt) revert EnvelopeExpired();
    }

    function _consumeEnvelope(bytes32 envelopeHash, uint256 amount, uint256 maxSingle, uint256 maxTotal) internal {
        if (amount > maxSingle) revert EnvelopeAmountExceeded(amount, maxSingle);
        uint256 consumed = envelopeConsumedAmount[envelopeHash];
        uint256 remaining = maxTotal > consumed ? maxTotal - consumed : 0;
        if (amount > remaining) revert EnvelopeTotalExceeded(amount, remaining);
        envelopeConsumedAmount[envelopeHash] = consumed + amount;
        emit EnvelopeConsumed(envelopeHash, amount, consumed + amount);
    }

    function _applyApprovalsMemory(ApprovalCall[] memory approvals, address target) internal {
        for (uint256 i = 0; i < approvals.length; ++i) {
            ApprovalCall memory a = approvals[i];
            if (a.token == address(0) || a.spender == address(0)) revert ZeroAddress();
            if (a.spender != target) revert ApprovalSpenderMismatch(a.spender, target);
            IERC20(a.token).forceApprove(a.spender, a.amount);
            emit SpenderApprovalUpdated(a.token, a.spender, a.amount);
        }
    }

    /// @dev Audit M-1: reset every approval to 0 after the envelope-mode trade. Pairs with
    ///      `_applyApprovalsMemory`. A misbehaving / upgraded router could otherwise pull the
    ///      residual allowance after the executor returns.
    function _resetApprovalsMemory(ApprovalCall[] memory approvals) internal {
        for (uint256 i = 0; i < approvals.length; ++i) {
            ApprovalCall memory a = approvals[i];
            IERC20(a.token).forceApprove(a.spender, 0);
            emit SpenderApprovalUpdated(a.token, a.spender, 0);
        }
    }

    /// @dev Envelope-mode prepare for trade-shape executions: skip _checkValidators
    ///      since envelope sigs already verified in validateXxxEnvelope.
    function _prepareEnvelopeTrade(ExecuteParams calldata params) internal {
        if (windDownActive) revert WindDownBlocksExecute();
        if (params.target == address(0)) revert ZeroAddress();
        if (params.minOutput == 0) revert ZeroAmount();
        _requireValuableOutputToken(params.outputToken);
        if (executedIntents[params.intentHash]) revert IntentAlreadyExecuted(params.intentHash);
        executedIntents[params.intentHash] = true;
        _checkPolicy(params.outputToken, params.minOutput, params.target);
    }

    function _prepareEnvelopeDebtReduction(DebtReductionParams calldata params) internal {
        if (windDownActive) revert WindDownBlocksExecute();
        if (params.target == address(0) || params.inputToken == address(0) || params.debtToken == address(0)) {
            revert ZeroAddress();
        }
        if (params.maxInput == 0 || params.minDebtDecrease == 0) revert ZeroAmount();
        if (executedIntents[params.intentHash]) revert IntentAlreadyExecuted(params.intentHash);
        executedIntents[params.intentHash] = true;
        _checkPolicy(params.inputToken, params.maxInput, params.target);
    }

    function _prepareEnvelopeHealthFactor(HealthFactorParams calldata params) internal {
        if (windDownActive) revert WindDownBlocksExecute();
        if (
            params.target == address(0) || params.outputToken == address(0) || params.pool == address(0)
                || params.account == address(0)
        ) revert ZeroAddress();
        if (params.minOutput == 0 || params.minHealthFactor == 0) revert ZeroAmount();
        _requireValuableOutputToken(params.outputToken);
        if (executedIntents[params.intentHash]) revert IntentAlreadyExecuted(params.intentHash);
        executedIntents[params.intentHash] = true;
        _checkPolicy(params.outputToken, params.minOutput, params.target);
    }

    function _expectSelector(bytes calldata data, bytes4 expected) internal pure {
        if (data.length < 4 || bytes4(data[:4]) != expected) revert EnvelopeWrongSelector();
    }

    // ── Calldata decoders ──

    function _decodeExactInputSingle(bytes calldata data) internal pure returns (ExactInputSingleParams memory p) {
        _expectSelector(data, SELECTOR_UNI_V3_EXACT_INPUT_SINGLE);
        p = abi.decode(data[4:], (ExactInputSingleParams));
    }

    /// @dev Decode a Universal Router 2.0 `execute(bytes,bytes[],uint256)` calldata
    ///      whose first command MUST be V4_SWAP, and whose first V4 action MUST
    ///      be SWAP_EXACT_IN_SINGLE. Reverts on any other shape so the envelope
    ///      can't be reused for a multi-step UR command sequence.
    function _decodeUniversalRouterV4SingleSwap(bytes calldata data)
        internal
        pure
        returns (V4ExactInputSingleParams memory p, uint256 deadline)
    {
        _expectSelector(data, SELECTOR_UR_EXECUTE);
        (bytes memory commands, bytes[] memory inputs, uint256 ddl) = abi.decode(data[4:], (bytes, bytes[], uint256));
        deadline = ddl;
        if (commands.length != 1 || inputs.length != 1) revert EnvelopeCheckFailed();
        if (uint8(commands[0]) != UR_COMMAND_V4_SWAP) revert EnvelopeCheckFailed();
        // V4_SWAP input is (bytes actions, bytes[] params)
        (bytes memory actions, bytes[] memory v4Params) = abi.decode(inputs[0], (bytes, bytes[]));
        if (actions.length != 1 || v4Params.length != 1) revert EnvelopeCheckFailed();
        if (uint8(actions[0]) != V4_ACTION_SWAP_EXACT_IN_SINGLE) revert EnvelopeCheckFailed();
        p = abi.decode(v4Params[0], (V4ExactInputSingleParams));
    }

    function _decodeAerodromeSwap(bytes calldata data) internal pure returns (AerodromeSwapParams memory p) {
        _expectSelector(data, SELECTOR_AERODROME_EXACT_INPUT_SINGLE);
        p = abi.decode(data[4:], (AerodromeSwapParams));
    }

    /// @dev Decode `exchange(int128 i, int128 j, uint256 dx, uint256 min_dy)` calldata.
    ///      Plain 2-coin StableSwap entrypoint; we explicitly do NOT support the `_use_eth`
    ///      overload nor multi-pool variants (caller must set the operator's enforcement
    ///      to a matching plain pool). Reverts on any other selector via _expectSelector.
    function _decodeCurveExchange(bytes calldata data)
        internal
        pure
        returns (int128 i, int128 j, uint256 dx, uint256 minDy)
    {
        _expectSelector(data, SELECTOR_CURVE_EXCHANGE);
        (i, j, dx, minDy) = abi.decode(data[4:], (int128, int128, uint256, uint256));
    }

    function _decodeAaveSupply(bytes calldata data)
        internal
        pure
        returns (address aaveAsset, uint256 amount, address onBehalfOf, uint16 referralCode)
    {
        _expectSelector(data, SELECTOR_AAVE_SUPPLY);
        (aaveAsset, amount, onBehalfOf, referralCode) = abi.decode(data[4:], (address, uint256, address, uint16));
    }

    function _decodeAaveWithdraw(bytes calldata data)
        internal
        pure
        returns (address aaveAsset, uint256 amount, address to)
    {
        _expectSelector(data, SELECTOR_AAVE_WITHDRAW);
        (aaveAsset, amount, to) = abi.decode(data[4:], (address, uint256, address));
    }

    function _decodeAaveBorrow(bytes calldata data)
        internal
        pure
        returns (address aaveAsset, uint256 amount, uint256 rateMode, uint16 refCode, address onBehalfOf)
    {
        _expectSelector(data, SELECTOR_AAVE_BORROW);
        (aaveAsset, amount, rateMode, refCode, onBehalfOf) =
            abi.decode(data[4:], (address, uint256, uint256, uint16, address));
    }

    function _decodeAaveRepay(bytes calldata data)
        internal
        pure
        returns (address aaveAsset, uint256 amount, uint256 rateMode, address onBehalfOf)
    {
        _expectSelector(data, SELECTOR_AAVE_REPAY);
        (aaveAsset, amount, rateMode, onBehalfOf) = abi.decode(data[4:], (address, uint256, uint256, address));
    }

    function _decodeMorphoSupply(bytes calldata data)
        internal
        pure
        returns (MorphoMarketParams memory mp, uint256 assets, uint256 shares, address onBehalf, bytes memory extra)
    {
        _expectSelector(data, SELECTOR_MORPHO_SUPPLY);
        (mp, assets, shares, onBehalf, extra) =
            abi.decode(data[4:], (MorphoMarketParams, uint256, uint256, address, bytes));
    }

    function _decodeMorphoWithdraw(bytes calldata data)
        internal
        pure
        returns (MorphoMarketParams memory mp, uint256 assets, uint256 shares, address onBehalf, address receiver)
    {
        _expectSelector(data, SELECTOR_MORPHO_WITHDRAW);
        (mp, assets, shares, onBehalf, receiver) =
            abi.decode(data[4:], (MorphoMarketParams, uint256, uint256, address, address));
    }

    function _decodeMorphoBorrow(bytes calldata data)
        internal
        pure
        returns (MorphoMarketParams memory mp, uint256 assets, uint256 shares, address onBehalf, address receiver)
    {
        _expectSelector(data, SELECTOR_MORPHO_BORROW);
        (mp, assets, shares, onBehalf, receiver) =
            abi.decode(data[4:], (MorphoMarketParams, uint256, uint256, address, address));
    }

    function _decodeMorphoRepay(bytes calldata data)
        internal
        pure
        returns (MorphoMarketParams memory mp, uint256 assets, uint256 shares, address onBehalf, bytes memory extra)
    {
        _expectSelector(data, SELECTOR_MORPHO_REPAY);
        (mp, assets, shares, onBehalf, extra) =
            abi.decode(data[4:], (MorphoMarketParams, uint256, uint256, address, bytes));
    }

    function _morphoMarketIdOf(MorphoMarketParams memory mp) internal pure returns (bytes32) {
        // Morpho uses keccak256(abi.encode(market)) in their marketId derivation.
        return keccak256(abi.encode(mp.loanToken, mp.collateralToken, mp.oracle, mp.irm, mp.lltv));
    }

    // ── DEX swaps (output-token-gain shape) ──

    function executeUniswapV3SwapEnvelope(
        ExecuteParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.UniswapV3SwapEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        _checkEnvelopeBasics(env);
        ExactInputSingleParams memory s = _decodeExactInputSingle(params.data);
        if (
            params.target != enf.router || s.tokenIn != enf.tokenIn || s.tokenOut != enf.tokenOut
                || uint256(s.fee) != enf.feeTier || s.recipient != address(this) || params.outputToken != enf.tokenOut
                || s.deadline < block.timestamp || params.deadline < block.timestamp
                // Audit M-2: pin sqrtPriceLimitX96 to the signed enforcement.
                || s.sqrtPriceLimitX96 != enf.sqrtPriceLimitX96
                // Audit M-3: bound native-ETH spend per envelope.
                || params.value > enf.maxValue
        ) revert EnvelopeCheckFailed();
        uint256 reqMinOut = (s.amountIn * enf.minOutputPerInput + 1e18 - 1) / 1e18;
        if (s.amountOutMinimum < reqMinOut || params.minOutput < reqMinOut) {
            revert EnvelopeRateTooLow(s.amountOutMinimum, reqMinOut);
        }
        // slither-disable-next-line unused-return
        (bool ok,) = tradeValidator.validateUniswapV3SwapEnvelope(env, enf, approvalSigners, signatures, scores);
        if (!ok) revert ValidatorCheckFailed();
        bytes32 envHash = tradeValidator.hashEnvelope(env);
        _consumeEnvelope(envHash, s.amountIn, enf.maxSingleAmountIn, enf.maxTotalAmountIn);
        _prepareEnvelopeTrade(params);
        ApprovalCall[] memory approvals = new ApprovalCall[](1);
        approvals[0] = ApprovalCall({token: s.tokenIn, spender: params.target, amount: s.amountIn});
        _applyApprovalsMemory(approvals, params.target);
        _executeTrade(params);
        // Audit M-1: clear residual allowance to prevent the router from pulling later.
        _resetApprovalsMemory(approvals);
    }

    function executeUniswapV4SwapEnvelope(
        ExecuteParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.UniswapV4SwapEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        _checkEnvelopeBasics(env);
        (V4ExactInputSingleParams memory s, uint256 urDeadline) = _decodeUniversalRouterV4SingleSwap(params.data);
        address tokenIn = s.zeroForOne ? s.poolKey.currency0 : s.poolKey.currency1;
        address tokenOut = s.zeroForOne ? s.poolKey.currency1 : s.poolKey.currency0;
        if (
            params.target != enf.universalRouter || s.poolKey.currency0 != enf.currency0
                || s.poolKey.currency1 != enf.currency1 || uint256(s.poolKey.fee) != enf.fee
                || int256(s.poolKey.tickSpacing) != enf.tickSpacing || s.poolKey.hooks != enf.hooks
                || s.zeroForOne != enf.zeroForOne || params.outputToken != tokenOut || urDeadline < block.timestamp
                || params.deadline < block.timestamp
                // Audit M-2: pin keccak256(hookData) so an operator cannot push arbitrary
                // hook callback bytes through the V4 swap action.
                || keccak256(s.hookData) != enf.hookDataHash
                // Audit M-3: bound native-ETH spend per envelope.
                || params.value > enf.maxValue
        ) revert EnvelopeCheckFailed();
        uint256 reqMinOut = (uint256(s.amountIn) * enf.minOutputPerInput + 1e18 - 1) / 1e18;
        if (uint256(s.amountOutMinimum) < reqMinOut || params.minOutput < reqMinOut) {
            revert EnvelopeRateTooLow(uint256(s.amountOutMinimum), reqMinOut);
        }
        // slither-disable-next-line unused-return
        (bool ok,) = tradeValidator.validateUniswapV4SwapEnvelope(env, enf, approvalSigners, signatures, scores);
        if (!ok) revert ValidatorCheckFailed();
        _consumeEnvelope(
            tradeValidator.hashEnvelope(env), uint256(s.amountIn), enf.maxSingleAmountIn, enf.maxTotalAmountIn
        );
        _prepareEnvelopeTrade(params);
        ApprovalCall[] memory approvals = new ApprovalCall[](1);
        approvals[0] = ApprovalCall({token: tokenIn, spender: params.target, amount: uint256(s.amountIn)});
        _applyApprovalsMemory(approvals, params.target);
        _executeTrade(params);
        // Audit M-1: clear residual allowance to prevent the router from pulling later.
        _resetApprovalsMemory(approvals);
    }

    function executeAerodromeSwapEnvelope(
        ExecuteParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.AerodromeSwapEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        _checkEnvelopeBasics(env);
        AerodromeSwapParams memory s = _decodeAerodromeSwap(params.data);
        if (
            params.target != enf.router || s.tokenIn != enf.tokenIn || s.tokenOut != enf.tokenOut
                || int256(s.tickSpacing) != enf.tickSpacing || s.recipient != address(this)
                || params.outputToken != enf.tokenOut || s.deadline < block.timestamp
                || params.deadline < block.timestamp
                // Audit M-2: pin sqrtPriceLimitX96 to the signed enforcement.
                || s.sqrtPriceLimitX96 != enf.sqrtPriceLimitX96
                // Audit M-3: bound native-ETH spend per envelope.
                || params.value > enf.maxValue
        ) revert EnvelopeCheckFailed();
        uint256 reqMinOut = (s.amountIn * enf.minOutputPerInput + 1e18 - 1) / 1e18;
        if (s.amountOutMinimum < reqMinOut || params.minOutput < reqMinOut) {
            revert EnvelopeRateTooLow(s.amountOutMinimum, reqMinOut);
        }
        // slither-disable-next-line unused-return
        (bool ok,) = tradeValidator.validateAerodromeSwapEnvelope(env, enf, approvalSigners, signatures, scores);
        if (!ok) revert ValidatorCheckFailed();
        bytes32 envHash = tradeValidator.hashEnvelope(env);
        _consumeEnvelope(envHash, s.amountIn, enf.maxSingleAmountIn, enf.maxTotalAmountIn);
        _prepareEnvelopeTrade(params);
        ApprovalCall[] memory approvals = new ApprovalCall[](1);
        approvals[0] = ApprovalCall({token: s.tokenIn, spender: params.target, amount: s.amountIn});
        _applyApprovalsMemory(approvals, params.target);
        _executeTrade(params);
        // Audit M-1: clear residual allowance to prevent the router from pulling later.
        _resetApprovalsMemory(approvals);
    }

    /// @notice PancakeSwap V3 swap. PancakeSwap V3 calldata is byte-identical to
    ///         Uniswap V3 (`exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))`),
    ///         so we reuse `_decodeExactInputSingle`. The router address is what
    ///         distinguishes a PancakeSwap V3 envelope from a Uniswap V3 envelope.
    function executePancakeswapV3SwapEnvelope(
        ExecuteParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.PancakeswapV3SwapEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        _checkEnvelopeBasics(env);
        ExactInputSingleParams memory s = _decodeExactInputSingle(params.data);
        if (
            params.target != enf.router || s.tokenIn != enf.tokenIn || s.tokenOut != enf.tokenOut
                || uint256(s.fee) != enf.feeTier || s.recipient != address(this) || params.outputToken != enf.tokenOut
                || s.deadline < block.timestamp || params.deadline < block.timestamp
                // Audit M-2: pin sqrtPriceLimitX96 to the signed enforcement.
                || s.sqrtPriceLimitX96 != enf.sqrtPriceLimitX96
                // Audit M-3: bound native-ETH spend per envelope.
                || params.value > enf.maxValue
        ) revert EnvelopeCheckFailed();
        uint256 reqMinOut = (s.amountIn * enf.minOutputPerInput + 1e18 - 1) / 1e18;
        if (s.amountOutMinimum < reqMinOut || params.minOutput < reqMinOut) {
            revert EnvelopeRateTooLow(s.amountOutMinimum, reqMinOut);
        }
        // slither-disable-next-line unused-return
        (bool ok,) = tradeValidator.validatePancakeswapV3SwapEnvelope(env, enf, approvalSigners, signatures, scores);
        if (!ok) revert ValidatorCheckFailed();
        bytes32 envHash = tradeValidator.hashEnvelope(env);
        _consumeEnvelope(envHash, s.amountIn, enf.maxSingleAmountIn, enf.maxTotalAmountIn);
        _prepareEnvelopeTrade(params);
        ApprovalCall[] memory approvals = new ApprovalCall[](1);
        approvals[0] = ApprovalCall({token: s.tokenIn, spender: params.target, amount: s.amountIn});
        _applyApprovalsMemory(approvals, params.target);
        _executeTrade(params);
        // Audit M-1: clear residual allowance to prevent the router from pulling later.
        _resetApprovalsMemory(approvals);
    }

    /// @notice Curve StableSwap exchange. Index-based: caller passes signed int128
    ///         (i, j) plus uint256 (dx, min_dy). The on-chain check trusts the
    ///         operator-bound enforcement to specify the correct (i, j, tokenIn,
    ///         tokenOut) for the pool — we deliberately do not call `coins(uint256)`
    ///         on-chain to save gas. Distinct envelopes per (pool, i, j) combo.
    function executeCurveStableSwapEnvelope(
        ExecuteParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.CurveStableSwapEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        _checkEnvelopeBasics(env);
        (int128 ci, int128 cj, uint256 dx, uint256 minDy) = _decodeCurveExchange(params.data);
        if (
            params.target != enf.pool || ci != enf.i || cj != enf.j || params.outputToken != enf.tokenOut
                || params.deadline < block.timestamp
                // Audit M-3: bound native-ETH spend per envelope.
                || params.value > enf.maxValue
        ) revert EnvelopeCheckFailed();
        uint256 reqMinOut = (dx * enf.minOutputPerInput + 1e18 - 1) / 1e18;
        if (minDy < reqMinOut || params.minOutput < reqMinOut) {
            revert EnvelopeRateTooLow(minDy, reqMinOut);
        }
        // slither-disable-next-line unused-return
        (bool ok,) = tradeValidator.validateCurveStableSwapEnvelope(env, enf, approvalSigners, signatures, scores);
        if (!ok) revert ValidatorCheckFailed();
        bytes32 envHash = tradeValidator.hashEnvelope(env);
        _consumeEnvelope(envHash, dx, enf.maxSingleAmountIn, enf.maxTotalAmountIn);
        _prepareEnvelopeTrade(params);
        ApprovalCall[] memory approvals = new ApprovalCall[](1);
        approvals[0] = ApprovalCall({token: enf.tokenIn, spender: params.target, amount: dx});
        _applyApprovalsMemory(approvals, params.target);
        _executeTrade(params);
        // Audit M-1: clear residual allowance to prevent the router from pulling later.
        _resetApprovalsMemory(approvals);
    }

    // ── Aave V3 ──

    function executeAaveSupplyEnvelope(
        ExecuteParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.AaveSupplyEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        _checkEnvelopeBasics(env);
        (address aaveAsset, uint256 amount, address onBehalfOf,) = _decodeAaveSupply(params.data);
        if (params.target != enf.pool || aaveAsset != enf.asset || onBehalfOf != address(this)) {
            revert EnvelopeCheckFailed();
        }
        if (params.deadline < block.timestamp) revert EnvelopeCheckFailed();
        // Audit M-3: bound native-ETH spend per envelope.
        if (params.value > enf.maxValue) revert EnvelopeCheckFailed();
        // Validator returns (bool ok, uint256 validCount); validCount is
        // diagnostic only — `ok` is the auth gate, `nonReentrant` + `OPERATOR_ROLE`
        // are the call gates, and an insufficient-validator condition reverts
        // upstream in `validateWithSignatures`.
        // slither-disable-next-line unused-return
        (bool ok,) = tradeValidator.validateAaveSupplyEnvelope(env, enf, approvalSigners, signatures, scores);
        if (!ok) revert ValidatorCheckFailed();
        _consumeEnvelope(tradeValidator.hashEnvelope(env), amount, enf.maxSingleAmount, enf.maxTotalAmount);
        _prepareEnvelopeTrade(params);
        ApprovalCall[] memory approvals = new ApprovalCall[](1);
        approvals[0] = ApprovalCall({token: aaveAsset, spender: params.target, amount: amount});
        _applyApprovalsMemory(approvals, params.target);
        _executeTrade(params);
        // Audit M-1: clear residual allowance to prevent the router from pulling later.
        _resetApprovalsMemory(approvals);
    }

    function executeAaveWithdrawEnvelope(
        HealthFactorParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.AaveWithdrawEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        _checkEnvelopeBasics(env);
        (address aaveAsset, uint256 amount, address to) = _decodeAaveWithdraw(params.data);
        // Audit H-1: params.account drives the post-call health-factor read in
        // _executeHealthFactor; pin it to the vault so an operator cannot satisfy
        // the check via an unrelated healthy account while the vault itself drifts
        // below enf.minHealthFactor.
        if (
            params.target != enf.pool || params.pool != enf.pool || aaveAsset != enf.asset || to != address(this)
                || params.account != address(this) || params.minHealthFactor < enf.minHealthFactor
                || params.deadline < block.timestamp
                // Audit M-3: bound native-ETH spend per envelope.
                || params.value > enf.maxValue
        ) revert EnvelopeCheckFailed();
        // slither-disable-next-line unused-return
        (bool ok,) = tradeValidator.validateAaveWithdrawEnvelope(env, enf, approvalSigners, signatures, scores);
        if (!ok) revert ValidatorCheckFailed();
        _consumeEnvelope(tradeValidator.hashEnvelope(env), amount, enf.maxSingleAmount, enf.maxTotalAmount);
        _prepareEnvelopeHealthFactor(params);
        _executeHealthFactor(params);
    }

    function executeAaveBorrowEnvelope(
        HealthFactorParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.AaveBorrowEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        _checkEnvelopeBasics(env);
        (address aaveAsset, uint256 amount, uint256 rateMode,, address onBehalfOf) = _decodeAaveBorrow(params.data);
        // Audit H-1: pin params.account to the vault so the post-borrow health-factor
        // check can't be vacuously satisfied via a different healthy account.
        if (
            params.target != enf.pool || params.pool != enf.pool || aaveAsset != enf.asset
                || rateMode != enf.interestRateMode || onBehalfOf != address(this) || params.account != address(this)
                || params.minHealthFactor < enf.minHealthFactor || params.deadline < block.timestamp
                // Audit M-3: bound native-ETH spend per envelope.
                || params.value > enf.maxValue
        ) revert EnvelopeCheckFailed();
        // slither-disable-next-line unused-return
        (bool ok,) = tradeValidator.validateAaveBorrowEnvelope(env, enf, approvalSigners, signatures, scores);
        if (!ok) revert ValidatorCheckFailed();
        _consumeEnvelope(tradeValidator.hashEnvelope(env), amount, enf.maxSingleAmount, enf.maxTotalAmount);
        _prepareEnvelopeHealthFactor(params);
        _executeHealthFactor(params);
    }

    function executeAaveRepayEnvelope(
        DebtReductionParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.AaveRepayEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        _checkEnvelopeBasics(env);
        (address aaveAsset, uint256 amount, uint256 rateMode, address onBehalfOf) = _decodeAaveRepay(params.data);
        if (
            params.target != enf.pool || params.inputToken != enf.asset || params.debtToken != enf.debtToken
                || aaveAsset != enf.asset || rateMode != enf.interestRateMode || onBehalfOf != address(this)
                || params.deadline < block.timestamp
                // Audit M-3: bound native-ETH spend per envelope.
                || params.value > enf.maxValue
        ) revert EnvelopeCheckFailed();
        // slither-disable-next-line unused-return
        (bool ok,) = tradeValidator.validateAaveRepayEnvelope(env, enf, approvalSigners, signatures, scores);
        if (!ok) revert ValidatorCheckFailed();
        _consumeEnvelope(tradeValidator.hashEnvelope(env), amount, enf.maxSingleAmount, enf.maxTotalAmount);
        _prepareEnvelopeDebtReduction(params);
        ApprovalCall[] memory approvals = new ApprovalCall[](1);
        approvals[0] = ApprovalCall({token: aaveAsset, spender: params.target, amount: amount});
        _applyApprovalsMemory(approvals, params.target);
        _executeDebtReduction(params);
        // Audit M-1: clear residual allowance to prevent the router from pulling later.
        _resetApprovalsMemory(approvals);
    }

    // ── Morpho ──

    function executeMorphoSupplyEnvelope(
        ExecuteParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.MorphoSupplyEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        _checkEnvelopeBasics(env);
        (MorphoMarketParams memory mp, uint256 assets,, address onBehalf,) = _decodeMorphoSupply(params.data);
        if (
            params.target != enf.morpho || _morphoMarketIdOf(mp) != enf.marketId || onBehalf != address(this)
                || params.deadline < block.timestamp
                // Audit M-3: bound native-ETH spend per envelope.
                || params.value > enf.maxValue
        ) revert EnvelopeCheckFailed();
        // slither-disable-next-line unused-return
        (bool ok,) = tradeValidator.validateMorphoSupplyEnvelope(env, enf, approvalSigners, signatures, scores);
        if (!ok) revert ValidatorCheckFailed();
        _consumeEnvelope(tradeValidator.hashEnvelope(env), assets, enf.maxSingleAmount, enf.maxTotalAmount);
        _prepareEnvelopeTrade(params);
        ApprovalCall[] memory approvals = new ApprovalCall[](1);
        approvals[0] = ApprovalCall({token: mp.loanToken, spender: params.target, amount: assets});
        _applyApprovalsMemory(approvals, params.target);
        _executeTrade(params);
        // Audit M-1: clear residual allowance to prevent the router from pulling later.
        _resetApprovalsMemory(approvals);
    }

    function executeMorphoWithdrawEnvelope(
        HealthFactorParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.MorphoWithdrawEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        _checkEnvelopeBasics(env);
        (MorphoMarketParams memory mp, uint256 assets,, address onBehalf, address receiver) =
            _decodeMorphoWithdraw(params.data);
        // Audit H-1: params.account is the address whose health is queried after the
        // withdraw — pin to the vault so an operator cannot satisfy the floor via a
        // different healthy account.
        if (
            params.target != enf.morpho || params.pool != enf.morpho || _morphoMarketIdOf(mp) != enf.marketId
                || onBehalf != address(this) || receiver != address(this) || params.account != address(this)
                || params.minHealthFactor < enf.minCollateralRatio || params.deadline < block.timestamp
                // Audit M-3: bound native-ETH spend per envelope.
                || params.value > enf.maxValue
        ) revert EnvelopeCheckFailed();
        // slither-disable-next-line unused-return
        (bool ok,) = tradeValidator.validateMorphoWithdrawEnvelope(env, enf, approvalSigners, signatures, scores);
        if (!ok) revert ValidatorCheckFailed();
        _consumeEnvelope(tradeValidator.hashEnvelope(env), assets, enf.maxSingleAmount, enf.maxTotalAmount);
        _prepareEnvelopeHealthFactor(params);
        _executeHealthFactor(params);
    }

    function executeMorphoBorrowEnvelope(
        HealthFactorParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.MorphoBorrowEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        _checkEnvelopeBasics(env);
        (MorphoMarketParams memory mp, uint256 assets,, address onBehalf, address receiver) =
            _decodeMorphoBorrow(params.data);
        // Audit H-1: pin params.account to the vault so the post-borrow health check
        // is read against the vault's actual position, not a decoy account.
        if (
            params.target != enf.morpho || params.pool != enf.morpho || _morphoMarketIdOf(mp) != enf.marketId
                || onBehalf != address(this) || receiver != address(this) || params.account != address(this)
                || params.minHealthFactor < enf.minCollateralRatio || params.deadline < block.timestamp
                // Audit M-3: bound native-ETH spend per envelope.
                || params.value > enf.maxValue
        ) revert EnvelopeCheckFailed();
        // slither-disable-next-line unused-return
        (bool ok,) = tradeValidator.validateMorphoBorrowEnvelope(env, enf, approvalSigners, signatures, scores);
        if (!ok) revert ValidatorCheckFailed();
        _consumeEnvelope(tradeValidator.hashEnvelope(env), assets, enf.maxSingleAmount, enf.maxTotalAmount);
        _prepareEnvelopeHealthFactor(params);
        _executeHealthFactor(params);
    }

    function executeMorphoRepayEnvelope(
        DebtReductionParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.MorphoRepayEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        _checkEnvelopeBasics(env);
        (MorphoMarketParams memory mp, uint256 assets,, address onBehalf,) = _decodeMorphoRepay(params.data);
        if (
            params.target != enf.morpho || _morphoMarketIdOf(mp) != enf.marketId || params.inputToken != mp.loanToken
                || onBehalf != address(this) || params.deadline < block.timestamp
                // Audit M-3: bound native-ETH spend per envelope.
                || params.value > enf.maxValue
        ) revert EnvelopeCheckFailed();
        // slither-disable-next-line unused-return
        (bool ok,) = tradeValidator.validateMorphoRepayEnvelope(env, enf, approvalSigners, signatures, scores);
        if (!ok) revert ValidatorCheckFailed();
        _consumeEnvelope(tradeValidator.hashEnvelope(env), assets, enf.maxSingleAmount, enf.maxTotalAmount);
        _prepareEnvelopeDebtReduction(params);
        ApprovalCall[] memory approvals = new ApprovalCall[](1);
        approvals[0] = ApprovalCall({token: mp.loanToken, spender: params.target, amount: assets});
        _applyApprovalsMemory(approvals, params.target);
        _executeDebtReduction(params);
        // Audit M-1: clear residual allowance to prevent the router from pulling later.
        _resetApprovalsMemory(approvals);
    }
}
