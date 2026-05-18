// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IERC7575.sol";
import "./interfaces/IAssetValuator.sol";
import "./VaultShare.sol";
import "./TradeValidator.sol";
import "./PolicyEngine.sol";
import "./FeeDistributor.sol";
import "./libraries/VaultStorage.sol";
import "./libraries/VaultTypes.sol";
import "./libraries/ValuationLib.sol";
import "./libraries/ExecutionLib.sol";
import "./libraries/EnvelopeExecLib.sol";
import "./libraries/VaultAdminLib.sol";

/// @title TradingVault
/// @notice ERC-7575 multi-asset vault for AI trading agents.
/// @dev    Pooled deposits, capability-scoped execution. The contract used to
///         carry ~44 KB of monolithic logic; per-Hyperliquid EIP-170 the
///         runtime cap is 24,576 B, so trade execution and per-protocol
///         envelope dispatch were extracted to `ExecutionLib`,
///         `EnvelopeExecLib`, and `ValuationLib`. State lives at a single
///         ERC-7201 slot (see `VaultStorage`) so the vault and every library
///         see the same fields without storage-ref threading.
///
///         `VaultTypes` is inherited (not used as a library) so the
///         pre-split public surface — `VaultTypes.ExecuteParams`,
///         `VaultTypes.ApprovalCall`, `VaultTypes.EnvelopeCheckFailed`,
///         every shared event — keeps resolving for callers and tests.
contract TradingVault is IERC7575, AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════════════
    // ROLES + VAULT-LOCAL CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════════

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant CREATOR_ROLE = keccak256("CREATOR_ROLE");

    uint256 public constant MAX_HELD_TOKENS = 20;
    uint256 public constant DEFAULT_ADMIN_UNWIND_MAX_DRAWDOWN_BPS = 500;

    // ═══════════════════════════════════════════════════════════════════════════
    // VAULT-LOCAL EVENTS (the shared ones live in `VaultTypes` and are emitted
    // by helper libraries directly; these are emitted only from this contract)
    // ═══════════════════════════════════════════════════════════════════════════

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
    event HyperliquidApiWalletApprovalSubmitted(address indexed agentWallet, string agentName, bytes action);

    // ═══════════════════════════════════════════════════════════════════════════
    // VAULT-LOCAL ERRORS (shared ones live in `VaultTypes`)
    // ═══════════════════════════════════════════════════════════════════════════

    error ZeroShares();
    error InsufficientBalance();
    error WindDownNotActive();
    error WindDownAlreadyActive();
    error AssetBalanceDecreased(uint256 before, uint256 after_);
    error WithdrawalLocked(uint256 unlockTime);
    error ExcessiveDrawdown();
    error InvalidBps();
    error InsufficientLiquidity(uint256 requested, uint256 available);
    error ExceedsCollateralLimit(uint256 requested, uint256 available);
    error CollateralNotEnabled();
    error HeldTokenNotEmpty(address token, uint256 balance);
    error OutstandingCollateralActive(uint256 amount);

    // ═══════════════════════════════════════════════════════════════════════════
    // CONFIG STORAGE (was immutables — now mutable so the contract can be
    // cloned via EIP-1167 minimal-proxy and per-clone init data populated
    // through `initialize(...)`. Set once and never written again.)
    // ═══════════════════════════════════════════════════════════════════════════

    IERC20 private _asset;
    VaultShare public shareToken;
    PolicyEngine public policyEngine;
    TradeValidator public tradeValidator;
    FeeDistributor public feeDistributor;
    bool private _initialized;

    error AlreadyInitialized();

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR — empty so the same code path works whether the contract is
    // deployed standalone (tests, deploy scripts) or as the implementation
    // behind EIP-1167 clones (the production factory path). A directly-deployed
    // impl that's never initialized has no useful state and reverts on every
    // gated call; if you do not want it callable at all, initialize it with
    // dummy data and grant no roles.
    // ═══════════════════════════════════════════════════════════════════════════

    constructor() {}

    /// @notice One-shot configuration for a freshly-cloned vault. Mirrors the
    ///         pre-clone constructor arguments. Must be called exactly once
    ///         per clone, typically by `VaultDeployer.deployVault` atomically
    ///         in the same transaction as the clone.
    function initialize(
        address assetToken,
        VaultShare _shareToken,
        PolicyEngine _policyEngine,
        TradeValidator _tradeValidator,
        FeeDistributor _feeDistributor,
        address admin,
        address operator
    ) external {
        if (_initialized) revert AlreadyInitialized();
        if (assetToken == address(0) || admin == address(0)) revert VaultTypes.ZeroAddress();
        if (address(_shareToken) == address(0)) revert VaultTypes.ZeroAddress();
        if (address(_policyEngine) == address(0)) revert VaultTypes.ZeroAddress();
        if (address(_tradeValidator) == address(0)) revert VaultTypes.ZeroAddress();
        if (address(_feeDistributor) == address(0)) revert VaultTypes.ZeroAddress();

        _initialized = true;

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

    /// @notice Accept native ETH (some protocols require sending ETH to the vault).
    receive() external payable {}

    // ═══════════════════════════════════════════════════════════════════════════
    // PUBLIC STATE GETTERS (back-compat for previous public state variables —
    // state is now namespaced under VaultStorage)
    // ═══════════════════════════════════════════════════════════════════════════

    function executedIntents(bytes32 intentHash) external view returns (bool) {
        return VaultStorage.load().executedIntents[intentHash];
    }

    function windDownActive() external view returns (bool) {
        return VaultStorage.load().windDownActive;
    }

    function windDownStartedAt() external view returns (uint256) {
        return VaultStorage.load().windDownStartedAt;
    }

    function depositLockupDuration() external view returns (uint256) {
        return VaultStorage.load().depositLockupDuration;
    }

    function lastDepositTime(address user) external view returns (uint256) {
        return VaultStorage.load().lastDepositTime[user];
    }

    function heldTokens(uint256 index) external view returns (address) {
        return VaultStorage.load().heldTokens[index];
    }

    function isHeldToken(address token) external view returns (bool) {
        return VaultStorage.load().isHeldToken[token];
    }

    function depositAssetReserveBps() external view returns (uint256) {
        return VaultStorage.load().depositAssetReserveBps;
    }

    function adminUnwindMaxDrawdownBps() external view returns (uint256) {
        return VaultStorage.load().adminUnwindMaxDrawdownBps;
    }

    function valuationAdapters(address token) external view returns (IAssetValuator) {
        return VaultStorage.load().valuationAdapters[token];
    }

    function totalOutstandingCollateral() public view returns (uint256) {
        return VaultStorage.load().totalOutstandingCollateral;
    }

    function operatorCollateral(address op) external view returns (uint256) {
        return VaultStorage.load().operatorCollateral[op];
    }

    function maxCollateralBps() external view returns (uint256) {
        return VaultStorage.load().maxCollateralBps;
    }

    function envelopeConsumedAmount(bytes32 envelopeHash) external view returns (uint256) {
        return VaultStorage.load().envelopeConsumedAmount[envelopeHash];
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ERC-7575 / ERC-4626 INTERFACE
    // ═══════════════════════════════════════════════════════════════════════════

    function share() external view override returns (address) {
        return address(shareToken);
    }

    function asset() public view override returns (address) {
        return address(_asset);
    }

    function totalAssets() public view override returns (uint256) {
        return
            IERC20(asset()).balanceOf(address(this)) + positionsValue() + VaultStorage.load().totalOutstandingCollateral;
    }

    function convertToShares(uint256 assets) public view override returns (uint256) {
        uint256 supply = shareToken.totalSupply() + VaultTypes.VIRTUAL_OFFSET;
        uint256 nav = shareToken.totalNAV() + VaultTypes.VIRTUAL_OFFSET;
        return (assets * supply) / nav;
    }

    function convertToAssets(uint256 shares) public view override returns (uint256) {
        uint256 supply = shareToken.totalSupply() + VaultTypes.VIRTUAL_OFFSET;
        uint256 nav = shareToken.totalNAV() + VaultTypes.VIRTUAL_OFFSET;
        return (shares * nav) / supply;
    }

    function maxDeposit(address) external view override returns (uint256) {
        return (paused() || !_isNavSafe()) ? 0 : type(uint256).max;
    }

    function previewDeposit(uint256 assets) external view override returns (uint256) {
        return convertToShares(assets);
    }

    function deposit(uint256 assets, address receiver)
        external
        override
        nonReentrant
        whenNotPaused
        returns (uint256 shares)
    {
        if (assets == 0) revert VaultTypes.ZeroAmount();
        if (receiver == address(0)) revert VaultTypes.ZeroAddress();

        shares = convertToShares(assets);
        if (shares == 0) revert ZeroShares();

        if (msg.sender == receiver) {
            VaultStorage.load().lastDepositTime[receiver] = block.timestamp;
        }

        _asset.safeTransferFrom(msg.sender, address(this), assets);
        shareToken.mint(receiver, shares);

        emit Deposit(msg.sender, receiver, assets, shares);
    }

    function maxWithdraw(address owner_) public view override returns (uint256) {
        if (paused()) return 0;
        if (_isDepositLocked(owner_)) return 0;
        if (!_isNavSafe()) return 0;
        uint256 entitled = convertToAssets(shareToken.balanceOf(owner_));
        uint256 liquid = liquidAssets();
        return entitled < liquid ? entitled : liquid;
    }

    function previewWithdraw(uint256 assets) external view override returns (uint256) {
        uint256 supply = shareToken.totalSupply() + VaultTypes.VIRTUAL_OFFSET;
        uint256 nav = shareToken.totalNAV() + VaultTypes.VIRTUAL_OFFSET;
        return (assets * supply + nav - 1) / nav;
    }

    function withdraw(uint256 assets, address receiver, address owner_)
        external
        override
        nonReentrant
        whenNotPaused
        returns (uint256 shares)
    {
        if (assets == 0) revert VaultTypes.ZeroAmount();
        if (receiver == address(0)) revert VaultTypes.ZeroAddress();
        _enforceDepositLockup(owner_);

        uint256 supply = shareToken.totalSupply() + VaultTypes.VIRTUAL_OFFSET;
        uint256 nav = shareToken.totalNAV() + VaultTypes.VIRTUAL_OFFSET;
        shares = (assets * supply + nav - 1) / nav;
        if (shares == 0) revert ZeroShares();

        uint256 liquid = liquidAssets();
        if (assets > liquid) revert InsufficientLiquidity(assets, liquid);

        _spendShareAllowance(owner_, shares);
        shareToken.burn(owner_, shares);
        _asset.safeTransfer(receiver, assets);

        emit Withdraw(msg.sender, receiver, owner_, assets, shares);
    }

    function maxRedeem(address owner_) public view override returns (uint256) {
        if (paused()) return 0;
        if (_isDepositLocked(owner_)) return 0;
        if (!_isNavSafe()) return 0;
        uint256 ownerShares = shareToken.balanceOf(owner_);
        uint256 liquid = liquidAssets();
        uint256 liquidShares = convertToShares(liquid);
        return ownerShares < liquidShares ? ownerShares : liquidShares;
    }

    function previewRedeem(uint256 shares) external view override returns (uint256) {
        return convertToAssets(shares);
    }

    function redeem(uint256 shares, address receiver, address owner_)
        external
        override
        nonReentrant
        whenNotPaused
        returns (uint256 assets)
    {
        if (shares == 0) revert ZeroShares();
        if (receiver == address(0)) revert VaultTypes.ZeroAddress();
        _enforceDepositLockup(owner_);

        assets = convertToAssets(shares);
        if (assets == 0) revert VaultTypes.ZeroAmount();

        uint256 liquid = liquidAssets();
        if (assets > liquid) revert InsufficientLiquidity(assets, liquid);

        _spendShareAllowance(owner_, shares);
        shareToken.burn(owner_, shares);
        _asset.safeTransfer(receiver, assets);

        emit Withdraw(msg.sender, receiver, owner_, assets, shares);
    }

    function previewRedeemInKind(uint256 shares)
        external
        view
        returns (address[] memory tokens, uint256[] memory amounts)
    {
        return _previewRedeemInKind(shares);
    }

    function redeemInKind(uint256 shares, address receiver, address owner_)
        external
        nonReentrant
        whenNotPaused
        returns (address[] memory tokens, uint256[] memory amounts)
    {
        if (shares == 0) revert ZeroShares();
        if (receiver == address(0)) revert VaultTypes.ZeroAddress();
        _enforceDepositLockup(owner_);
        uint256 collat = VaultStorage.load().totalOutstandingCollateral;
        if (collat > 0) revert OutstandingCollateralActive(collat);

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
    // TRADE EXECUTION — non-envelope path
    // ═══════════════════════════════════════════════════════════════════════════

    function execute(VaultTypes.ExecuteParams calldata params, bytes[] calldata signatures, uint256[] calldata scores)
        external
        onlyRole(OPERATOR_ROLE)
        nonReentrant
        whenNotPaused
    {
        ExecutionLib.prepareExecution(
            policyEngine, tradeValidator, asset(), params, signatures, scores, VaultTypes.EMPTY_APPROVALS_HASH
        );
        ExecutionLib.executeTrade(policyEngine, asset(), params);
    }

    function executeWithApprovals(
        VaultTypes.ExecuteParams calldata params,
        VaultTypes.ApprovalCall[] calldata approvals,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        bytes32 approvalsHash = ExecutionLib.hashApprovals(approvals);
        ExecutionLib.prepareExecution(policyEngine, tradeValidator, asset(), params, signatures, scores, approvalsHash);
        ExecutionLib.applyApprovals(approvals, params.target);
        ExecutionLib.executeTrade(policyEngine, asset(), params);
        ExecutionLib.resetApprovals(approvals);
    }

    function executeDebtReductionWithApprovals(
        VaultTypes.DebtReductionParams calldata params,
        VaultTypes.ApprovalCall[] calldata approvals,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        bytes32 approvalsHash = ExecutionLib.hashApprovals(approvals);
        ExecutionLib.prepareDebtReduction(policyEngine, tradeValidator, params, signatures, scores, approvalsHash);
        ExecutionLib.applyApprovals(approvals, params.target);
        ExecutionLib.executeDebtReduction(policyEngine, asset(), params);
        ExecutionLib.resetApprovals(approvals);
    }

    function executeHealthFactorWithApprovals(
        VaultTypes.HealthFactorParams calldata params,
        VaultTypes.ApprovalCall[] calldata approvals,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        bytes32 approvalsHash = ExecutionLib.hashApprovals(approvals);
        ExecutionLib.prepareHealthFactor(
            policyEngine, tradeValidator, asset(), params, signatures, scores, approvalsHash
        );
        ExecutionLib.applyApprovals(approvals, params.target);
        ExecutionLib.executeHealthFactor(policyEngine, asset(), params);
        ExecutionLib.resetApprovals(approvals);
    }

    function computeExecutionHash(
        VaultTypes.ExecuteParams calldata params,
        VaultTypes.ApprovalCall[] calldata approvals
    ) external view returns (bytes32) {
        return ExecutionLib.computeExecutionHash(params, ExecutionLib.hashApprovals(approvals));
    }

    function computeDebtReductionHash(
        VaultTypes.DebtReductionParams calldata params,
        VaultTypes.ApprovalCall[] calldata approvals
    ) external view returns (bytes32) {
        return ExecutionLib.computeDebtReductionHash(params, ExecutionLib.hashApprovals(approvals));
    }

    function computeHealthFactorHash(
        VaultTypes.HealthFactorParams calldata params,
        VaultTypes.ApprovalCall[] calldata approvals
    ) external view returns (bytes32) {
        return ExecutionLib.computeHealthFactorHash(params, ExecutionLib.hashApprovals(approvals));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ENVELOPE EXECUTION — DEX
    // ═══════════════════════════════════════════════════════════════════════════

    function executeUniswapV3SwapEnvelope(
        VaultTypes.ExecuteParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.UniswapV3SwapEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        EnvelopeExecLib.executeUniswapV3Swap(_ctx(), params, env, enf, approvalSigners, signatures, scores);
    }

    function executeUniswapV4SwapEnvelope(
        VaultTypes.ExecuteParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.UniswapV4SwapEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        EnvelopeExecLib.executeUniswapV4Swap(_ctx(), params, env, enf, approvalSigners, signatures, scores);
    }

    function executeAerodromeSwapEnvelope(
        VaultTypes.ExecuteParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.AerodromeSwapEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        EnvelopeExecLib.executeAerodromeSwap(_ctx(), params, env, enf, approvalSigners, signatures, scores);
    }

    function executePancakeswapV3SwapEnvelope(
        VaultTypes.ExecuteParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.PancakeswapV3SwapEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        EnvelopeExecLib.executePancakeswapV3Swap(_ctx(), params, env, enf, approvalSigners, signatures, scores);
    }

    function executeCurveStableSwapEnvelope(
        VaultTypes.ExecuteParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.CurveStableSwapEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        EnvelopeExecLib.executeCurveStableSwap(_ctx(), params, env, enf, approvalSigners, signatures, scores);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ENVELOPE EXECUTION — Aave V3
    // ═══════════════════════════════════════════════════════════════════════════

    function executeAaveSupplyEnvelope(
        VaultTypes.ExecuteParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.AaveSupplyEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        EnvelopeExecLib.executeAaveSupply(_ctx(), params, env, enf, approvalSigners, signatures, scores);
    }

    function executeAaveWithdrawEnvelope(
        VaultTypes.HealthFactorParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.AaveWithdrawEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        EnvelopeExecLib.executeAaveWithdraw(_ctx(), params, env, enf, approvalSigners, signatures, scores);
    }

    function executeAaveBorrowEnvelope(
        VaultTypes.HealthFactorParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.AaveBorrowEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        EnvelopeExecLib.executeAaveBorrow(_ctx(), params, env, enf, approvalSigners, signatures, scores);
    }

    function executeAaveRepayEnvelope(
        VaultTypes.DebtReductionParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.AaveRepayEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        EnvelopeExecLib.executeAaveRepay(_ctx(), params, env, enf, approvalSigners, signatures, scores);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ENVELOPE EXECUTION — Morpho
    // ═══════════════════════════════════════════════════════════════════════════

    function executeMorphoSupplyEnvelope(
        VaultTypes.ExecuteParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.MorphoSupplyEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        EnvelopeExecLib.executeMorphoSupply(_ctx(), params, env, enf, approvalSigners, signatures, scores);
    }

    function executeMorphoWithdrawEnvelope(
        VaultTypes.HealthFactorParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.MorphoWithdrawEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        EnvelopeExecLib.executeMorphoWithdraw(_ctx(), params, env, enf, approvalSigners, signatures, scores);
    }

    function executeMorphoBorrowEnvelope(
        VaultTypes.HealthFactorParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.MorphoBorrowEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        EnvelopeExecLib.executeMorphoBorrow(_ctx(), params, env, enf, approvalSigners, signatures, scores);
    }

    function executeMorphoRepayEnvelope(
        VaultTypes.DebtReductionParams calldata params,
        TradeValidator.Envelope calldata env,
        TradeValidator.MorphoRepayEnforcement calldata enf,
        address[] calldata approvalSigners,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        EnvelopeExecLib.executeMorphoRepay(_ctx(), params, env, enf, approvalSigners, signatures, scores);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CLOB COLLATERAL MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════════

    function releaseCollateral(
        uint256 amount,
        address recipient,
        bytes32 intentHash,
        uint256 deadline,
        bytes[] calldata signatures,
        uint256[] calldata scores
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        VaultAdminLib.releaseCollateral(
            _asset, tradeValidator, amount, recipient, intentHash, deadline, signatures, scores, totalAssets()
        );
    }

    function computeCollateralReleaseHash(uint256 amount, address recipient, bytes32 intentHash, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(VaultTypes.COLLATERAL_RELEASE_TYPEHASH, amount, recipient, intentHash, deadline, block.chainid)
        );
    }

    function returnCollateral(uint256 amount) external nonReentrant {
        VaultAdminLib.returnCollateral(_asset, amount);
    }

    function writeDownCollateral(address operator_, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        VaultAdminLib.writeDownCollateral(operator_, amount);
    }

    function setMaxCollateralBps(uint256 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        VaultAdminLib.setMaxCollateralBps(bps);
    }

    function approveHyperliquidApiWallet(address agentWallet, string calldata agentName)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        nonReentrant
    {
        VaultAdminLib.approveHyperliquidApiWallet(agentWallet, agentName);
    }

    function availableCollateral() external view returns (uint256) {
        return VaultAdminLib.availableCollateral(_asset, totalAssets());
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // WIND-DOWN
    // ═══════════════════════════════════════════════════════════════════════════

    function activateWindDown() external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender) && !hasRole(CREATOR_ROLE, msg.sender)) {
            revert AccessControlUnauthorizedAccount(msg.sender, CREATOR_ROLE);
        }
        VaultAdminLib.activateWindDown();
    }

    function deactivateWindDown() external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender) && !hasRole(CREATOR_ROLE, msg.sender)) {
            revert AccessControlUnauthorizedAccount(msg.sender, CREATOR_ROLE);
        }
        VaultAdminLib.deactivateWindDown();
    }

    function unwind(address target, bytes calldata data, uint256 value) external nonReentrant {
        VaultAdminLib.unwind(_asset, policyEngine, target, data, value);
    }

    /// @dev `nonReentrant` blocks reentry; the pre-call `totalBefore` against
    ///      post-call `totalAfter` IS the drawdown-cap enforcement, so the
    ///      reentrancy-eth "stale variable" finding is by design.
    /// slither-disable-start reentrancy-eth
    function adminUnwind(address target, bytes calldata data, uint256 value)
        external
        onlyRole(CREATOR_ROLE)
        nonReentrant
    {
        uint256 totalBefore = totalAssets();
        // `gained` is emitted via PositionUnwound; vault accounting cares
        // about the totalAssets() delta, not the per-token gain. The
        // reentrancy-eth flag here is by design: nonReentrant blocks reentry,
        // and the post-call totalAssets()-vs-totalBefore comparison IS the
        // drawdown enforcement.
        VaultAdminLib.adminUnwind(_asset, policyEngine, target, data, value);
        uint256 drawdownCap = VaultAdminLib.adminUnwindDrawdownCap(DEFAULT_ADMIN_UNWIND_MAX_DRAWDOWN_BPS);
        uint256 totalAfter = totalAssets();
        // `nonReentrant` blocks reentry; the post-call totalAssets() read against
        // pre-call totalBefore IS the drawdown-cap check by design.
        if (totalBefore > 0 && totalAfter * 10000 < totalBefore * (10000 - drawdownCap)) {
            revert ExcessiveDrawdown();
        }
    }
    /// slither-disable-end reentrancy-eth

    // ═══════════════════════════════════════════════════════════════════════════
    // EMERGENCY / CIRCUIT BREAKER
    // ═══════════════════════════════════════════════════════════════════════════

    function emergencyWithdraw(address token, address to) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        VaultAdminLib.emergencyWithdraw(token, to);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // VIEW + ADMIN CONFIG
    // ═══════════════════════════════════════════════════════════════════════════

    function getBalance(address token) external view returns (uint256) {
        if (token == address(0)) return address(this).balance;
        return IERC20(token).balanceOf(address(this));
    }

    function liquidAssets() public view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    function positionsValue() public view returns (uint256) {
        return ValuationLib.positionsValue(asset());
    }

    function isNavSafe() external view returns (bool) {
        return ValuationLib.isNavSafe(asset());
    }

    function getHeldTokens() external view returns (address[] memory) {
        return VaultStorage.load().heldTokens;
    }

    function heldTokenCount() external view returns (uint256) {
        return VaultStorage.load().heldTokens.length;
    }

    function setDepositLockup(uint256 duration) external onlyRole(DEFAULT_ADMIN_ROLE) {
        VaultAdminLib.setDepositLockup(duration);
    }

    function approveFeeAllowance(uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        IERC20(asset()).forceApprove(address(feeDistributor), amount);
    }

    function approveSpender(address token, address spender, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        whenNotPaused
    {
        if (token == address(0) || spender == address(0)) revert VaultTypes.ZeroAddress();
        IERC20(token).forceApprove(spender, amount);
        emit VaultTypes.SpenderApprovalUpdated(token, spender, amount);
    }

    function setDepositAssetReserveBps(uint256 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        VaultAdminLib.setDepositAssetReserveBps(bps);
    }

    function setAdminUnwindMaxDrawdownBps(uint256 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        VaultAdminLib.setAdminUnwindMaxDrawdownBps(bps);
    }

    function setValuationAdapter(address token, address adapter) external onlyRole(DEFAULT_ADMIN_ROLE) {
        VaultAdminLib.setValuationAdapter(token, adapter);
    }

    function updateHeldTokens(address[] calldata tokens) external onlyRole(DEFAULT_ADMIN_ROLE) {
        VaultAdminLib.updateHeldTokens(tokens, asset());
    }

    function removeHeldToken(address token) external onlyRole(DEFAULT_ADMIN_ROLE) {
        VaultAdminLib.removeHeldToken(token);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════════════

    function _ctx() internal view returns (EnvelopeExecLib.DispatcherCtx memory) {
        return EnvelopeExecLib.DispatcherCtx({
            policyEngine: policyEngine, tradeValidator: tradeValidator, depositAsset: asset()
        });
    }

    function _isNavSafe() internal view returns (bool) {
        return ValuationLib.isNavSafe(asset());
    }

    function _previewRedeemInKind(uint256 shares)
        internal
        view
        returns (address[] memory tokens, uint256[] memory amounts)
    {
        (tokens, amounts) = VaultAdminLib.previewRedeemInKind(shares, shareToken, asset());
    }

    function _isDepositLocked(address owner_) internal view returns (bool) {
        VaultStorage.Data storage $ = VaultStorage.load();
        if ($.depositLockupDuration == 0) return false;
        uint256 depositTime = $.lastDepositTime[owner_];
        if (depositTime == 0) return false;
        return block.timestamp < depositTime + $.depositLockupDuration;
    }

    function _enforceDepositLockup(address owner_) internal view {
        VaultStorage.Data storage $ = VaultStorage.load();
        if (_isDepositLocked(owner_)) {
            revert WithdrawalLocked($.lastDepositTime[owner_] + $.depositLockupDuration);
        }
    }

    function _spendShareAllowance(address owner_, uint256 shares) internal {
        if (msg.sender != owner_) {
            shareToken.spendAllowance(owner_, msg.sender, shares);
        }
    }
}
