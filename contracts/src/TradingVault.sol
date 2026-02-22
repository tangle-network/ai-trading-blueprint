// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IERC7575.sol";
import "./VaultShare.sol";
import "./TradeValidator.sol";
import "./PolicyEngine.sol";
import "./FeeDistributor.sol";

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

        // Approve fee distributor to pull fees from this vault
        IERC20(assetToken).approve(address(_feeDistributor), type(uint256).max);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ERC-7575 / ERC-4626 INTERFACE
    // ═══════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IERC7575
    function share() external view override returns (address) {
        return address(shareToken);
    }

    /// @inheritdoc IERC7575
    function asset() external view override returns (address) {
        return address(_asset);
    }

    /// @inheritdoc IERC7575
    function totalAssets() public view override returns (uint256) {
        return _asset.balanceOf(address(this));
    }

    /// @inheritdoc IERC7575
    function convertToShares(uint256 assets) public view override returns (uint256) {
        uint256 supply = shareToken.totalSupply();
        uint256 nav = shareToken.totalNAV();
        if (supply == 0 || nav == 0) return assets; // 1:1 when empty
        return (assets * supply) / nav;
    }

    /// @inheritdoc IERC7575
    function convertToAssets(uint256 shares) public view override returns (uint256) {
        uint256 supply = shareToken.totalSupply();
        if (supply == 0) return shares; // 1:1 when empty
        uint256 nav = shareToken.totalNAV();
        return (shares * nav) / supply;
    }

    /// @inheritdoc IERC7575
    function maxDeposit(address) external view override returns (uint256) {
        return paused() ? 0 : type(uint256).max;
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

        emit Deposit(msg.sender, receiver, assets, shares);
    }

    /// @inheritdoc IERC7575
    function maxWithdraw(address owner_) external view override returns (uint256) {
        if (paused()) return 0;
        uint256 shares = shareToken.balanceOf(owner_);
        return convertToAssets(shares);
    }

    /// @inheritdoc IERC7575
    function previewWithdraw(uint256 assets) external view override returns (uint256) {
        return convertToShares(assets);
    }

    /// @inheritdoc IERC7575
    function withdraw(uint256 assets, address receiver, address owner_)
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

        _spendShareAllowance(owner_, shares);
        shareToken.burn(owner_, shares);
        _asset.safeTransfer(receiver, assets);

        emit Withdraw(msg.sender, receiver, owner_, assets, shares);
    }

    /// @inheritdoc IERC7575
    function maxRedeem(address owner_) external view override returns (uint256) {
        if (paused()) return 0;
        return shareToken.balanceOf(owner_);
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

        assets = convertToAssets(shares);
        if (assets == 0) revert ZeroAmount();

        _spendShareAllowance(owner_, shares);
        shareToken.burn(owner_, shares);
        _asset.safeTransfer(receiver, assets);

        emit Withdraw(msg.sender, receiver, owner_, assets, shares);
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

    /// @notice Execute a validated trade through an arbitrary target contract
    /// @dev Requires OPERATOR_ROLE + PolicyEngine approval + TradeValidator m-of-n sigs.
    ///      Blocked when wind-down mode is active — use unwind() instead.
    function execute(ExecuteParams calldata params, bytes[] calldata signatures, uint256[] calldata scores)
        external
        onlyRole(OPERATOR_ROLE)
        nonReentrant
        whenNotPaused
    {
        if (windDownActive) revert WindDownBlocksExecute();
        if (params.target == address(0)) revert ZeroAddress();

        // 0. Intent deduplication — prevents multiple operators executing the same trade
        if (executedIntents[params.intentHash]) revert IntentAlreadyExecuted(params.intentHash);
        executedIntents[params.intentHash] = true;

        // 1. Policy engine check
        _checkPolicy(params.outputToken, params.minOutput, params.target);

        // 2. Validator signature check (m-of-n EIP-712)
        _checkValidators(params.intentHash, signatures, scores, params.deadline);

        // 3. Execute the trade with output verification
        _executeTrade(params);
    }

    function _checkPolicy(address outputToken, uint256 minOutput, address target) internal {
        if (!policyEngine.validateTrade(address(this), outputToken, minOutput, target, 0)) {
            revert PolicyCheckFailed();
        }
    }

    function _checkValidators(
        bytes32 intentHash,
        bytes[] calldata signatures,
        uint256[] calldata scores,
        uint256 deadline
    ) internal view {
        (bool ok,) = tradeValidator.validateWithSignatures(intentHash, address(this), signatures, scores, deadline);
        if (!ok) revert ValidatorCheckFailed();
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

        emit TradeExecuted(params.target, params.value, outputGained, params.outputToken, params.intentHash);
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

        (bool success,) = target.call{value: value}(data);
        if (!success) revert ExecutionFailed();

        emit PositionUnwound(msg.sender, target, 0);
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

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

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
    // INTERNALS
    // ═══════════════════════════════════════════════════════════════════════════

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
