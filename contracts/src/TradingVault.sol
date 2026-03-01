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
    error WithdrawalLocked(uint256 unlockTime);
    error DepositAssetBelowReserve();
    error ExcessiveDrawdown();
    error InvalidBps();
    error InsufficientLiquidity(uint256 requested, uint256 available);
    error ExceedsCollateralLimit(uint256 requested, uint256 available);
    error CollateralNotEnabled();

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
    event CollateralReleased(address indexed operator, uint256 amount, address indexed recipient, bytes32 indexed intentHash);
    event CollateralReturned(address indexed operator, uint256 amount, uint256 credited);
    event CollateralWrittenDown(address indexed operator, uint256 amount);
    event MaxCollateralBpsUpdated(uint256 bps);

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
        if (params.minOutput == 0) revert ZeroAmount();

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

        _addHeldToken(params.outputToken);

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

        // Validator signature check (same m-of-n as trades)
        _checkValidators(intentHash, signatures, scores, deadline);

        // CEI: update state before transfer
        totalOutstandingCollateral += amount;
        operatorCollateral[msg.sender] += amount;

        _asset.safeTransfer(recipient, amount);

        emit CollateralReleased(msg.sender, amount, recipient, intentHash);
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

        if (adminUnwindMaxDrawdownBps > 0) {
            uint256 totalAfter = totalAssets();
            if (totalBefore > 0 && totalAfter * 10000 < totalBefore * (10000 - adminUnwindMaxDrawdownBps)) {
                revert ExcessiveDrawdown();
            }
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

    /// @notice Sum of held-token balances (raw units, same-decimal assumption).
    /// @dev Only accurate when all held tokens share the deposit asset's decimals.
    ///      Multi-asset vaults with mixed decimals should use VaultShare.totalNAV()
    ///      with an oracle for USD-normalized valuation instead.
    function positionsValue() public view returns (uint256 total) {
        for (uint256 i = 0; i < heldTokens.length; i++) {
            total += IERC20(heldTokens[i]).balanceOf(address(this));
        }
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

    /// @notice Replace the held token list (OPERATOR only). Skips the deposit asset and enforces MAX_HELD_TOKENS.
    function updateHeldTokens(address[] calldata tokens) external onlyRole(OPERATOR_ROLE) {
        // Clear existing
        for (uint256 i = 0; i < heldTokens.length; i++) {
            isHeldToken[heldTokens[i]] = false;
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

    /// @notice Remove a single held token from the tracking list (OPERATOR only)
    function removeHeldToken(address token) external onlyRole(OPERATOR_ROLE) {
        _removeHeldToken(token);
    }

    function _addHeldToken(address token) internal {
        if (token == address(0) || token == asset() || isHeldToken[token] || heldTokens.length >= MAX_HELD_TOKENS) return;
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
