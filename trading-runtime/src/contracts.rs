//! Shared Solidity contract bindings for all on-chain interactions.
//!
//! Uses alloy's `sol!` macro to generate type-safe ABI encoders/decoders
//! for the trading vault system contracts.

use alloy::sol;

sol! {
    #[sol(rpc)]
    interface ITradingVault {
        struct ExecuteParams {
            address target;
            bytes data;
            uint256 value;
            uint256 minOutput;
            address outputToken;
            bytes32 intentHash;
            uint256 deadline;
        }

        struct ApprovalCall {
            address token;
            address spender;
            uint256 amount;
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

        function asset() external view returns (address);
        function share() external view returns (address);
        function tradeValidator() external view returns (address);
        function totalAssets() external view returns (uint256);
        function isNavSafe() external view returns (bool);
        function getHeldTokens() external view returns (address[] memory);
        function valuationAdapters(address token) external view returns (address);
        function setValuationAdapter(address token, address adapter) external;
        function deposit(uint256 assets, address receiver) external returns (uint256 shares);
        function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);
        function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
        function previewRedeemInKind(uint256 shares) external view returns (address[] memory tokens, uint256[] memory amounts);
        function redeemInKind(uint256 shares, address receiver, address owner) external returns (address[] memory tokens, uint256[] memory amounts);
        function convertToShares(uint256 assets) external view returns (uint256);
        function convertToAssets(uint256 shares) external view returns (uint256);
        function execute(ExecuteParams calldata params, bytes[] calldata signatures, uint256[] calldata scores) external;
        function executeWithApprovals(
            ExecuteParams calldata params,
            ApprovalCall[] calldata approvals,
            bytes[] calldata signatures,
            uint256[] calldata scores
        ) external;
        function executeDebtReductionWithApprovals(
            DebtReductionParams calldata params,
            ApprovalCall[] calldata approvals,
            bytes[] calldata signatures,
            uint256[] calldata scores
        ) external;
        function executeHealthFactorWithApprovals(
            HealthFactorParams calldata params,
            ApprovalCall[] calldata approvals,
            bytes[] calldata signatures,
            uint256[] calldata scores
        ) external;
        // ── Envelope mode (per-protocol on-chain authorization) ──

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
            uint256 minOutputPerInput;
            address router;
            address tokenIn;
            address tokenOut;
        }

        struct AerodromeSwapEnforcement {
            uint256 maxSingleAmountIn;
            uint256 maxTotalAmountIn;
            uint256 minOutputPerInput;
            address router;
            int256 tickSpacing;
            address tokenIn;
            address tokenOut;
        }

        struct AaveSupplyEnforcement {
            address asset;
            uint256 maxSingleAmount;
            uint256 maxTotalAmount;
            address pool;
        }

        struct AaveWithdrawEnforcement {
            address asset;
            uint256 maxSingleAmount;
            uint256 maxTotalAmount;
            uint256 minHealthFactor;
            address pool;
        }

        struct AaveBorrowEnforcement {
            address asset;
            uint256 interestRateMode;
            uint256 maxSingleAmount;
            uint256 maxTotalAmount;
            uint256 minHealthFactor;
            address pool;
        }

        struct AaveRepayEnforcement {
            address asset;
            address debtToken;
            uint256 interestRateMode;
            uint256 maxSingleAmount;
            uint256 maxTotalAmount;
            address pool;
        }

        struct MorphoSupplyEnforcement {
            uint256 maxSingleAmount;
            uint256 maxTotalAmount;
            bytes32 marketId;
            address morpho;
        }

        struct MorphoWithdrawEnforcement {
            uint256 maxSingleAmount;
            uint256 maxTotalAmount;
            bytes32 marketId;
            uint256 minCollateralRatio;
            address morpho;
        }

        struct MorphoBorrowEnforcement {
            uint256 maxSingleAmount;
            uint256 maxTotalAmount;
            bytes32 marketId;
            uint256 minCollateralRatio;
            address morpho;
        }

        struct MorphoRepayEnforcement {
            uint256 maxSingleAmount;
            uint256 maxTotalAmount;
            bytes32 marketId;
            address morpho;
        }

        function executeUniswapV3SwapEnvelope(ExecuteParams calldata params, Envelope calldata env, UniswapV3SwapEnforcement calldata enf, address[] calldata approvalSigners, bytes[] calldata signatures, uint256[] calldata scores) external;
        function executeAerodromeSwapEnvelope(ExecuteParams calldata params, Envelope calldata env, AerodromeSwapEnforcement calldata enf, address[] calldata approvalSigners, bytes[] calldata signatures, uint256[] calldata scores) external;
        function executeAaveSupplyEnvelope(ExecuteParams calldata params, Envelope calldata env, AaveSupplyEnforcement calldata enf, address[] calldata approvalSigners, bytes[] calldata signatures, uint256[] calldata scores) external;
        function executeAaveWithdrawEnvelope(HealthFactorParams calldata params, Envelope calldata env, AaveWithdrawEnforcement calldata enf, address[] calldata approvalSigners, bytes[] calldata signatures, uint256[] calldata scores) external;
        function executeAaveBorrowEnvelope(HealthFactorParams calldata params, Envelope calldata env, AaveBorrowEnforcement calldata enf, address[] calldata approvalSigners, bytes[] calldata signatures, uint256[] calldata scores) external;
        function executeAaveRepayEnvelope(DebtReductionParams calldata params, Envelope calldata env, AaveRepayEnforcement calldata enf, address[] calldata approvalSigners, bytes[] calldata signatures, uint256[] calldata scores) external;
        function executeMorphoSupplyEnvelope(ExecuteParams calldata params, Envelope calldata env, MorphoSupplyEnforcement calldata enf, address[] calldata approvalSigners, bytes[] calldata signatures, uint256[] calldata scores) external;
        function executeMorphoWithdrawEnvelope(HealthFactorParams calldata params, Envelope calldata env, MorphoWithdrawEnforcement calldata enf, address[] calldata approvalSigners, bytes[] calldata signatures, uint256[] calldata scores) external;
        function executeMorphoBorrowEnvelope(HealthFactorParams calldata params, Envelope calldata env, MorphoBorrowEnforcement calldata enf, address[] calldata approvalSigners, bytes[] calldata signatures, uint256[] calldata scores) external;
        function executeMorphoRepayEnvelope(DebtReductionParams calldata params, Envelope calldata env, MorphoRepayEnforcement calldata enf, address[] calldata approvalSigners, bytes[] calldata signatures, uint256[] calldata scores) external;
        function envelopeConsumedAmount(bytes32 envelopeHash) external view returns (uint256);
        function emergencyWithdraw(address token, address to) external;
        function getBalance(address token) external view returns (uint256);
        function pause() external;
        function unpause() external;

        // CLOB collateral management
        function releaseCollateral(uint256 amount, address recipient, bytes32 intentHash, uint256 deadline, bytes[] calldata signatures, uint256[] calldata scores) external;
        function computeExecutionHash(ExecuteParams calldata params, ApprovalCall[] calldata approvals) external view returns (bytes32);
        function computeDebtReductionHash(DebtReductionParams calldata params, ApprovalCall[] calldata approvals) external view returns (bytes32);
        function computeHealthFactorHash(HealthFactorParams calldata params, ApprovalCall[] calldata approvals) external view returns (bytes32);
        function computeCollateralReleaseHash(uint256 amount, address recipient, bytes32 intentHash, uint256 deadline) external view returns (bytes32);
        function returnCollateral(uint256 amount) external;
        function writeDownCollateral(address operator, uint256 amount) external;
        function setMaxCollateralBps(uint256 bps) external;
        function totalOutstandingCollateral() external view returns (uint256);
        function operatorCollateral(address operator) external view returns (uint256);
        function maxCollateralBps() external view returns (uint256);
        function availableCollateral() external view returns (uint256);
    }

    #[sol(rpc)]
    interface IERC20 {
        function approve(address spender, uint256 value) external returns (bool);
        function allowance(address owner, address spender) external view returns (uint256);
    }

    #[sol(rpc)]
    interface IVaultFactory {
        struct PolicyConfig {
            uint256 leverageCap;
            uint256 maxTradesPerHour;
            uint256 maxSlippageBps;
        }

        struct FeeConfig {
            uint256 performanceFeeBps;
            uint256 managementFeeBps;
            uint256 validatorFeeShareBps;
        }

        function createVault(
            uint64 serviceId, address assetToken, address admin, address operator,
            address[] calldata signers, uint256 requiredSigs,
            string calldata name, string calldata symbol, bytes32 salt,
            PolicyConfig calldata policyConfig, FeeConfig calldata feeConfig
        ) external returns (address vault, address shareToken);

        function createBotVault(
            uint64 serviceId, address assetToken, address admin, address operator,
            address[] calldata signers, uint256 requiredSigs,
            string calldata name, string calldata symbol, bytes32 salt,
            PolicyConfig calldata policyConfig, FeeConfig calldata feeConfig
        ) external returns (address vault, address shareToken);

        function getServiceVaults(uint64 serviceId) external view returns (address[] memory);
        function serviceShares(uint64 serviceId) external view returns (address);
    }

    #[sol(rpc)]
    interface ITradingBlueprint {
        function botVaults(uint64 serviceId, uint64 callId) external view returns (address);
        function onJobResult(
            uint64 serviceId,
            uint8 job,
            uint64 jobCallId,
            address operator,
            bytes calldata inputs,
            bytes calldata outputs
        ) external payable;
    }

    #[sol(rpc)]
    interface IPolicyEngine {
        function initializeVault(address vault, uint256 leverageCap, uint256 maxTrades, uint256 maxSlippage) external;
        function setWhitelist(address vault, address[] calldata tokens, bool allowed) external;
        function whitelistToken(address vault, address token, bool allowed) external;
        function setTargetWhitelist(address vault, address[] calldata targets, bool allowed) external;
        function setPositionLimit(address vault, address token, uint256 maxAmount) external;
        function validateTrade(address vault, address token, uint256 amount, address target, uint256 leverage) external returns (bool);
    }

    #[sol(rpc)]
    interface IAssetValuator {
        function isSupported(address token, address asset) external view returns (bool);
    }

    #[sol(rpc)]
    interface ITradeValidator {
        function configureVault(address vault, address[] calldata signers, uint256 requiredSigs) external;
        function validateWithSignatures(
            bytes32 intentHash, bytes32 executionHash, address vault, bytes[] calldata signatures,
            uint256[] calldata scores, uint256 deadline, uint256 actionKind
        ) external view returns (bool approved, uint256 validCount);
        function computeDigest(bytes32 intentHash, bytes32 executionHash, address vault, uint256 score, uint256 deadline, uint256 actionKind) external view returns (bytes32);
        function getVaultSigners(address vault) external view returns (address[] memory);
        function getRequiredSignatures(address vault) external view returns (uint256);
    }

    #[sol(rpc)]
    interface IFeeDistributor {
        function settleFees(address vault, address feeToken) external returns (uint256 perfFee, uint256 mgmtFee);
        function withdrawFees(address token, uint256 amount) external;
        function withdrawValidatorFees(address token, address to, uint256 amount) external;
        function highWaterMark(address vault) external view returns (uint256);
        function accumulatedFees(address token) external view returns (uint256);
        function validatorFees(address token) external view returns (uint256);
        function performanceFeeBps() external view returns (uint256);
        function managementFeeBps() external view returns (uint256);
        function validatorFeeShareBps() external view returns (uint256);
        function calculatePerformanceFee(address vault, uint256 currentAUM) external view returns (uint256 fee);
        function calculateManagementFee(address vault, uint256 aum, uint256 lastSettledTime) external view returns (uint256 fee);
    }

    #[sol(rpc)]
    interface ITangleServices {
        struct ServiceEscrow {
            address token;
            uint256 balance;
            uint256 totalDeposited;
            uint256 totalReleased;
        }

        function billSubscription(uint64 serviceId) external;
        function billSubscriptionBatch(uint64[] calldata serviceIds) external returns (uint256 totalBilled, uint256 billedCount);
        function getBillableServices(uint64[] calldata serviceIds) external view returns (uint64[] memory billable);
        function getServiceEscrow(uint64 serviceId) external view returns (ServiceEscrow memory);
    }

    #[sol(rpc)]
    interface IStrategyRegistry {
        struct StrategyInfo {
            uint64 serviceId;
            address owner;
            address linkedVault;
            string name;
            string strategyType;
            string ipfsHash;
            uint256 aum;
            int256 totalPnl;
            bool active;
            uint256 createdAt;
        }

        function registerStrategy(uint64 serviceId, address linkedVault, string calldata name, string calldata strategyType, string calldata ipfsHash) external returns (uint256 strategyId);
        function updateStrategy(uint256 strategyId, string calldata ipfsHash) external;
        function deactivateStrategy(uint256 strategyId) external;
        function updateMetrics(uint256 strategyId, uint256 aum, int256 pnl) external;
        function getStrategy(uint256 strategyId) external view returns (StrategyInfo memory info);
        function getStrategiesByType(string calldata strategyType) external view returns (uint256[] memory ids);
    }
}
