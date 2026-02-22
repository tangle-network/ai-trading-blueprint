// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title FeeDistributor
/// @notice Performance and management fee settlement with real token transfers
/// @dev Collects fees from vaults via safeTransferFrom (vault must approve this contract).
///      Supports validator fee share distribution and protocol treasury withdrawal.
contract FeeDistributor is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════

    error InvalidBps();
    error ZeroAddress();
    error ZeroAmount();

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
    event FeeConfigUpdated(uint256 performanceFeeBps, uint256 managementFeeBps, uint256 validatorShareBps);

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════════

    uint256 public constant BPS_DENOMINATOR = 10000;
    uint256 public constant SECONDS_PER_YEAR = 365 days;

    // ═══════════════════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Performance fee in basis points (e.g., 2000 = 20%)
    uint256 public performanceFeeBps;

    /// @notice Annual management fee in basis points (e.g., 200 = 2%)
    uint256 public managementFeeBps;

    /// @notice Share of performance fee going to validators in basis points (e.g., 3000 = 30%)
    uint256 public validatorFeeShareBps;

    /// @notice Protocol treasury address for fee withdrawal
    address public treasury;

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
        performanceFeeBps = 2000; // 20% default
        managementFeeBps = 200; // 2% annual default
        validatorFeeShareBps = 3000; // 30% of perf fee default
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CONFIGURATION
    // ═══════════════════════════════════════════════════════════════════════════

    function setPerformanceFee(uint256 bps) external onlyOwner {
        if (bps > BPS_DENOMINATOR) revert InvalidBps();
        performanceFeeBps = bps;
        emit FeeConfigUpdated(performanceFeeBps, managementFeeBps, validatorFeeShareBps);
    }

    function setManagementFee(uint256 annualBps) external onlyOwner {
        if (annualBps > BPS_DENOMINATOR) revert InvalidBps();
        managementFeeBps = annualBps;
        emit FeeConfigUpdated(performanceFeeBps, managementFeeBps, validatorFeeShareBps);
    }

    function setValidatorFeeShare(uint256 bps) external onlyOwner {
        if (bps > BPS_DENOMINATOR) revert InvalidBps();
        validatorFeeShareBps = bps;
        emit FeeConfigUpdated(performanceFeeBps, managementFeeBps, validatorFeeShareBps);
    }

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
            fee = (gains * performanceFeeBps) / BPS_DENOMINATOR;
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
        fee = (aum * managementFeeBps * elapsed) / (BPS_DENOMINATOR * SECONDS_PER_YEAR);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SETTLEMENT
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Settle fees for a vault — actually transfers tokens from vault to this contract
    /// @dev Vault must have approved this contract for the fee token
    /// @param vault The vault address
    /// @param feeToken The token to collect fees in
    /// @return perfFee The performance fee collected
    /// @return mgmtFee The management fee collected
    function settleFees(address vault, address feeToken)
        external
        onlyOwner
        nonReentrant
        returns (uint256 perfFee, uint256 mgmtFee)
    {
        if (vault == address(0)) revert ZeroAddress();
        if (feeToken == address(0)) revert ZeroAddress();

        uint256 currentAUM = IERC20(feeToken).balanceOf(vault);
        uint256 lastSettledTime = lastSettled[vault];

        // Initialize lastSettled on first call
        if (lastSettledTime == 0) {
            lastSettledTime = block.timestamp;
        }

        // Calculate fees
        perfFee = calculatePerformanceFee(vault, currentAUM);
        mgmtFee = calculateManagementFee(vault, currentAUM, lastSettledTime);

        uint256 totalFee = perfFee + mgmtFee;

        // Actually transfer fees from vault
        if (totalFee > 0) {
            // Cap fee at vault balance to prevent revert
            uint256 vaultBalance = IERC20(feeToken).balanceOf(vault);
            if (totalFee > vaultBalance) {
                totalFee = vaultBalance;
                // Proportionally reduce
                if (perfFee + mgmtFee > 0) {
                    perfFee = (totalFee * perfFee) / (perfFee + mgmtFee);
                    mgmtFee = totalFee - perfFee;
                }
            }

            IERC20(feeToken).safeTransferFrom(vault, address(this), totalFee);

            // Calculate validator share of performance fee
            uint256 vShare = (perfFee * validatorFeeShareBps) / BPS_DENOMINATOR;
            validatorFees[feeToken] += vShare;
            accumulatedFees[feeToken] += totalFee;
        }

        // Update high water mark
        if (currentAUM > highWaterMark[vault]) {
            highWaterMark[vault] = currentAUM;
            emit HighWaterMarkUpdated(vault, currentAUM);
        }

        // Update last settled timestamp
        lastSettled[vault] = block.timestamp;

        uint256 valShare = (perfFee * validatorFeeShareBps) / BPS_DENOMINATOR;
        uint256 protocolShare = perfFee + mgmtFee - valShare;
        emit FeesSettled(vault, feeToken, perfFee, mgmtFee, valShare, protocolShare);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // WITHDRAWAL
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Withdraw accumulated protocol fees to treasury
    function withdrawFees(address token, uint256 amount) external onlyOwner nonReentrant {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        uint256 available = IERC20(token).balanceOf(address(this));
        if (amount > available) amount = available;

        IERC20(token).safeTransfer(treasury, amount);
        if (accumulatedFees[token] >= amount) {
            accumulatedFees[token] -= amount;
        } else {
            accumulatedFees[token] = 0;
        }

        emit FeesWithdrawn(token, treasury, amount);
    }

    /// @notice Withdraw validator fees to a specific address
    function withdrawValidatorFees(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        if (amount > validatorFees[token]) amount = validatorFees[token];

        validatorFees[token] -= amount;
        if (accumulatedFees[token] >= amount) {
            accumulatedFees[token] -= amount;
        } else {
            accumulatedFees[token] = 0;
        }

        IERC20(token).safeTransfer(to, amount);
        emit FeesWithdrawn(token, to, amount);
    }
}
