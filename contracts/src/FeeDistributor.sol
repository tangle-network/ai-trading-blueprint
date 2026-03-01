// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./VaultShare.sol"; // also provides IVaultAssets interface

/// @title FeeDistributor
/// @notice Per-vault performance and management fee settlement with real token transfers
/// @dev Collects fees from vaults via safeTransferFrom (vault must approve this contract).
///      Each vault has independent fee rates and an admin who can update them.
///      settleFees is permissionless — access control is the vault's ERC-20 approval.
contract FeeDistributor is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════

    error InvalidBps();
    error ZeroAddress();
    error ZeroAmount();
    error VaultFeeNotInitialized();
    error VaultAlreadyInitialized(address vault);
    error NotVaultFeeAdminOrOwner();
    error InsufficientProtocolFees();

    // ═══════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════

    event FeesSettled(
        address indexed vault,
        address indexed feeToken,
        uint256 performanceFee,
        uint256 managementFee,
        uint256 validatorShare,
        uint256 protocolShare
    );
    event HighWaterMarkUpdated(address indexed vault, uint256 newHighWaterMark);
    event FeesWithdrawn(address indexed token, address indexed to, uint256 amount);
    event TreasuryUpdated(address indexed treasury);
    event VaultFeeConfigUpdated(
        address indexed vault, uint256 performanceFeeBps, uint256 managementFeeBps, uint256 validatorShareBps
    );
    event VaultFeeAdminUpdated(address indexed vault, address indexed newAdmin);

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════════

    uint256 public constant BPS_DENOMINATOR = 10000;
    uint256 public constant SECONDS_PER_YEAR = 365 days;

    // ═══════════════════════════════════════════════════════════════════════════
    // TYPES
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Fee configuration for a vault
    struct FeeConfig {
        uint256 performanceFeeBps;
        uint256 managementFeeBps;
        uint256 validatorFeeShareBps;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Protocol treasury address for fee withdrawal
    address public treasury;

    /// @notice Per-vault fee configuration
    mapping(address vault => FeeConfig) public vaultFeeConfig;

    /// @notice Whether a vault's fees have been initialized
    mapping(address vault => bool) public vaultFeeInitialized;

    /// @notice Per-vault fee admin (can update fee rates)
    mapping(address vault => address) public vaultFeeAdmin;

    /// @notice High water mark per vault (highest AUM that perf fees were charged on)
    mapping(address vault => uint256) public highWaterMark;

    /// @notice Last fee settlement timestamp per vault
    mapping(address vault => uint256) public lastSettled;

    /// @notice Accumulated fees per token held by this contract
    mapping(address token => uint256) public accumulatedFees;

    /// @notice Accumulated validator fees per token (subset of accumulatedFees)
    mapping(address token => uint256) public validatorFees;

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════

    constructor(address _treasury) Ownable(msg.sender) {
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = _treasury;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // INITIALIZATION (called by VaultFactory)
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Initialize fee configuration for a new vault
    /// @param vault The vault address
    /// @param admin The vault's fee admin
    /// @param config The fee configuration
    function initializeVaultFees(address vault, address admin, FeeConfig calldata config) external onlyOwner {
        if (vault == address(0)) revert ZeroAddress();
        if (vaultFeeInitialized[vault]) revert VaultAlreadyInitialized(vault);
        if (config.performanceFeeBps > BPS_DENOMINATOR) revert InvalidBps();
        if (config.managementFeeBps > BPS_DENOMINATOR) revert InvalidBps();
        if (config.validatorFeeShareBps > BPS_DENOMINATOR) revert InvalidBps();

        vaultFeeConfig[vault] = config;
        vaultFeeInitialized[vault] = true;
        vaultFeeAdmin[vault] = admin;

        emit VaultFeeConfigUpdated(vault, config.performanceFeeBps, config.managementFeeBps, config.validatorFeeShareBps);
        emit VaultFeeAdminUpdated(vault, admin);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PER-VAULT ADMIN
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Update fee configuration for a vault
    function setVaultFeeConfig(address vault, FeeConfig calldata config) external {
        if (msg.sender != owner() && msg.sender != vaultFeeAdmin[vault]) revert NotVaultFeeAdminOrOwner();
        if (!vaultFeeInitialized[vault]) revert VaultFeeNotInitialized();
        if (config.performanceFeeBps > BPS_DENOMINATOR) revert InvalidBps();
        if (config.managementFeeBps > BPS_DENOMINATOR) revert InvalidBps();
        if (config.validatorFeeShareBps > BPS_DENOMINATOR) revert InvalidBps();

        vaultFeeConfig[vault] = config;
        emit VaultFeeConfigUpdated(vault, config.performanceFeeBps, config.managementFeeBps, config.validatorFeeShareBps);
    }

    /// @notice Transfer vault fee admin
    function setVaultFeeAdmin(address vault, address newAdmin) external {
        if (msg.sender != owner() && msg.sender != vaultFeeAdmin[vault]) revert NotVaultFeeAdminOrOwner();
        if (newAdmin == address(0)) revert ZeroAddress();
        vaultFeeAdmin[vault] = newAdmin;
        emit VaultFeeAdminUpdated(vault, newAdmin);
    }

    /// @notice Update the protocol treasury address for fee withdrawals
    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = _treasury;
        emit TreasuryUpdated(_treasury);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // FEE CALCULATION
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Calculate performance fee based on gains above high water mark
    function calculatePerformanceFee(address vault, uint256 currentAUM) public view returns (uint256 fee) {
        uint256 hwm = highWaterMark[vault];
        if (currentAUM > hwm) {
            uint256 gains = currentAUM - hwm;
            fee = (gains * vaultFeeConfig[vault].performanceFeeBps) / BPS_DENOMINATOR;
        }
    }

    /// @notice Calculate management fee pro-rata since last settlement
    function calculateManagementFee(address vault, uint256 aum, uint256 lastSettledTime)
        public
        view
        returns (uint256 fee)
    {
        if (lastSettledTime >= block.timestamp) return 0;
        uint256 elapsed = block.timestamp - lastSettledTime;
        fee = (aum * vaultFeeConfig[vault].managementFeeBps * elapsed) / (BPS_DENOMINATOR * SECONDS_PER_YEAR);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SETTLEMENT (permissionless)
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Settle fees for a vault — transfers tokens from vault to this contract
    /// @dev Permissionless: anyone can trigger. Access control is the vault's ERC-20 approval.
    ///      If vault hasn't approved this contract, the transfer will revert (zero fees collected).
    function settleFees(address vault, address feeToken)
        external
        nonReentrant
        returns (uint256 perfFee, uint256 mgmtFee)
    {
        if (vault == address(0)) revert ZeroAddress();
        if (feeToken == address(0)) revert ZeroAddress();
        if (!vaultFeeInitialized[vault]) revert VaultFeeNotInitialized();

        uint256 currentAUM;
        try IVaultAssets(vault).totalAssets() returns (uint256 ta) {
            currentAUM = ta;
        } catch {
            currentAUM = IERC20(feeToken).balanceOf(vault);
        }
        uint256 lastSettledTime = lastSettled[vault];

        // Initialize lastSettled and HWM on first call
        if (lastSettledTime == 0) {
            lastSettledTime = block.timestamp;
            if (highWaterMark[vault] == 0) {
                highWaterMark[vault] = currentAUM;
                emit HighWaterMarkUpdated(vault, currentAUM);
            }
        }

        perfFee = calculatePerformanceFee(vault, currentAUM);
        mgmtFee = calculateManagementFee(vault, currentAUM, lastSettledTime);

        uint256 totalFee = perfFee + mgmtFee;

        uint256 valShare;
        if (totalFee > 0) {
            uint256 vaultBalance = IERC20(feeToken).balanceOf(vault);
            if (totalFee > vaultBalance) {
                totalFee = vaultBalance;
                uint256 originalTotal = perfFee + mgmtFee;
                perfFee = (totalFee * perfFee) / originalTotal;
                mgmtFee = totalFee - perfFee;
            }

            IERC20(feeToken).safeTransferFrom(vault, address(this), totalFee);

            valShare = (perfFee * vaultFeeConfig[vault].validatorFeeShareBps) / BPS_DENOMINATOR;
            validatorFees[feeToken] += valShare;
            accumulatedFees[feeToken] += totalFee;
        }

        // Update HWM to post-fee AUM (not pre-fee) so next settlement
        // computes performance fees correctly against actual vault value
        uint256 postFeeAUM = currentAUM > totalFee ? currentAUM - totalFee : 0;
        if (postFeeAUM > highWaterMark[vault]) {
            highWaterMark[vault] = postFeeAUM;
            emit HighWaterMarkUpdated(vault, postFeeAUM);
        }

        lastSettled[vault] = block.timestamp;

        uint256 protocolShare = totalFee - valShare;
        emit FeesSettled(vault, feeToken, perfFee, mgmtFee, valShare, protocolShare);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // WITHDRAWAL (owner only — treasury management)
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Withdraw accumulated protocol fees to treasury
    /// @dev Caps withdrawal to protocol share (total accumulated minus validator portion)
    /// @param token The ERC-20 token to withdraw
    /// @param amount The requested amount (capped to available protocol fees)
    function withdrawFees(address token, uint256 amount) external onlyOwner nonReentrant {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        uint256 protocolFees = accumulatedFees[token] > validatorFees[token]
            ? accumulatedFees[token] - validatorFees[token]
            : 0;
        if (protocolFees == 0) revert InsufficientProtocolFees();
        if (amount > protocolFees) amount = protocolFees;

        accumulatedFees[token] -= amount;
        IERC20(token).safeTransfer(treasury, amount);

        emit FeesWithdrawn(token, treasury, amount);
    }

    /// @notice Withdraw validator fees to a specific address
    /// @param token The ERC-20 token to withdraw
    /// @param to The recipient address for validator fees
    /// @param amount The requested amount (capped to available validator fees)
    function withdrawValidatorFees(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        if (amount > validatorFees[token]) amount = validatorFees[token];

        validatorFees[token] -= amount;
        // Invariant: validatorFees[token] <= accumulatedFees[token] always holds,
        // so this subtraction is safe. If it ever underflows, a bug exists.
        accumulatedFees[token] -= amount;

        IERC20(token).safeTransfer(to, amount);
        emit FeesWithdrawn(token, to, amount);
    }
}
