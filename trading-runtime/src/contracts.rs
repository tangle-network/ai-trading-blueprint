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

        function asset() external view returns (address);
        function share() external view returns (address);
        function totalAssets() external view returns (uint256);
        function deposit(uint256 assets, address receiver) external returns (uint256 shares);
        function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);
        function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
        function convertToShares(uint256 assets) external view returns (uint256);
        function convertToAssets(uint256 shares) external view returns (uint256);
        function execute(ExecuteParams calldata params, bytes[] calldata signatures, uint256[] calldata scores) external;
        function emergencyWithdraw(address token, address to) external;
        function getBalance(address token) external view returns (uint256);
        function pause() external;
        function unpause() external;
    }

    #[sol(rpc)]
    interface IVaultFactory {
        function createVault(
            uint64 serviceId, address assetToken, address admin, address operator,
            address[] calldata signers, uint256 requiredSigs,
            string calldata name, string calldata symbol, bytes32 salt
        ) external returns (address vault, address shareToken);

        function addAssetVault(
            uint64 serviceId, address assetToken, address admin, address operator,
            address[] calldata signers, uint256 requiredSigs, bytes32 salt
        ) external returns (address vault);

        function getServiceVaults(uint64 serviceId) external view returns (address[] memory);
        function serviceShares(uint64 serviceId) external view returns (address);
    }

    #[sol(rpc)]
    interface IPolicyEngine {
        function initializeVault(address vault, uint256 leverageCap, uint256 maxTrades, uint256 maxSlippage) external;
        function setWhitelist(address vault, address[] calldata tokens, bool allowed) external;
        function setTargetWhitelist(address vault, address[] calldata targets, bool allowed) external;
        function setPositionLimit(address vault, address token, uint256 maxAmount) external;
        function validateTrade(address vault, address token, uint256 amount, address target, uint256 leverage) external returns (bool);
    }

    #[sol(rpc)]
    interface ITradeValidator {
        function configureVault(address vault, address[] calldata signers, uint256 requiredSigs) external;
        function validateWithSignatures(
            bytes32 intentHash, address vault, bytes[] calldata signatures,
            uint256[] calldata scores, uint256 deadline
        ) external view returns (bool approved, uint256 validCount);
        function computeDigest(bytes32 intentHash, address vault, uint256 score, uint256 deadline) external view returns (bytes32);
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
    interface IStrategyRegistry {
        struct StrategyInfo {
            uint64 serviceId;
            address owner;
            string name;
            string strategyType;
            string ipfsHash;
            uint256 aum;
            int256 totalPnl;
            bool active;
            uint256 createdAt;
        }

        function registerStrategy(uint64 serviceId, string calldata name, string calldata strategyType, string calldata ipfsHash) external returns (uint256 strategyId);
        function updateStrategy(uint256 strategyId, string calldata ipfsHash) external;
        function deactivateStrategy(uint256 strategyId) external;
        function updateMetrics(uint256 strategyId, uint256 aum, int256 pnl) external;
        function getStrategy(uint256 strategyId) external view returns (StrategyInfo memory info);
        function getStrategiesByType(string calldata strategyType) external view returns (uint256[] memory ids);
    }
}
