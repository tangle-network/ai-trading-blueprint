// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./VaultShare.sol";
import "./ITradeValidator.sol";
import "./interfaces/IERC7575.sol";

interface IHyperliquidCoreWriterMinimal {
    function sendRawAction(bytes calldata action) external;
}

/// @title HyperliquidVault
/// @notice Minimal ERC-7575-style USDC vault for bot-bound Hyperliquid accounts.
/// @dev This intentionally excludes the universal EVM trade execution surface.
///      The vault's HyperEVM address is the Hyperliquid account/control surface,
///      and CoreWriter actions must be submitted by this vault contract.
contract HyperliquidVault is IERC7575, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    uint8 private constant HYPERLIQUID_CORE_WRITER_VERSION = 1;
    uint24 public constant HYPERLIQUID_ACTION_SPOT_SEND = 6;
    uint24 public constant HYPERLIQUID_ACTION_USD_CLASS_TRANSFER = 7;
    uint24 private constant HYPERLIQUID_ACTION_ADD_API_WALLET = 9;
    uint24 private constant HYPERLIQUID_ACTION_EVM_USDC_TO_CORE = 0x00ffffff;
    address private constant HYPERLIQUID_CORE_WRITER = 0x3333333333333333333333333333333333333333;
    address private constant HYPERLIQUID_SPOT_BALANCE_PRECOMPILE = 0x0000000000000000000000000000000000000801;
    address private constant HYPERLIQUID_ACCOUNT_MARGIN_SUMMARY_PRECOMPILE = 0x000000000000000000000000000000000000080F;
    address private constant HYPERLIQUID_USDC_SYSTEM_ADDRESS = 0x2000000000000000000000000000000000000000;
    uint32 private constant HYPERLIQUID_DEFAULT_PERP_DEX_INDEX = 0;
    uint64 private constant HYPERLIQUID_USDC_SPOT_TOKEN = 0;
    uint8 private constant HYPERLIQUID_CORE_USDC_WEI_DECIMALS = 8;
    uint8 private constant HYPEREVM_USDC_DECIMALS = 6;
    uint256 private constant HYPERLIQUID_VIRTUAL_OFFSET = 10 ** HYPEREVM_USDC_DECIMALS;
    uint64 public constant WITHDRAWAL_EPOCH_SECONDS = 1 days;
    uint64 private constant WITHDRAWAL_CUTOFF_SECONDS = 1 hours;
    uint256 public constant ACTION_KIND_HYPERLIQUID_FUND_MOVEMENT = 4;
    bytes32 public constant HYPERLIQUID_FUND_MOVEMENT_TYPEHASH = keccak256(
        "HyperliquidFundMovement(address vault,uint256 chainId,uint24 actionType,address destination,uint64 token,uint64 amount,bool direction,uint256 nonce,uint256 deadline,uint256 leverageCap,uint256 maxTradesPerHour,uint256 maxSlippageBps)"
    );
    bytes32 public constant HYPERLIQUID_FUND_MOVEMENT_EXECUTION_TYPEHASH =
        keccak256("HyperliquidFundMovementExecution(address vault,uint256 chainId,uint24 actionType,bytes action)");

    IERC20 private _asset;
    VaultShare public shareToken;
    ITradeValidator public tradeValidator;
    uint256 public leverageCap;
    uint256 public maxTradesPerHour;
    uint256 public maxSlippageBps;
    bool private _initialized;
    uint256 private _pendingRedeemShares;
    uint256 private _pendingRedeemAssets;
    uint256 public nextWithdrawalRequestId;
    uint256 public nextFulfillableWithdrawalRequestId;
    mapping(bytes32 role => mapping(address account => bool granted)) private _roles;

    struct WithdrawalRequest {
        address owner;
        address receiver;
        uint256 shares;
        uint64 createdAt;
        uint64 fulfilledAt;
        uint64 cancelledAt;
    }

    struct FundMovementAuthorization {
        uint256 nonce;
        uint256 deadline;
        bytes[] signatures;
        uint256[] scores;
    }

    mapping(uint256 => WithdrawalRequest) public withdrawalRequests;
    mapping(uint256 => uint256) public withdrawalRequestAssets;
    mapping(uint256 => uint64) public withdrawalRequestEligibleAt;
    mapping(uint256 nonce => bool used) public fundMovementNonceUsed;

    event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);
    event WithdrawalQueued(uint256 indexed requestId, address indexed owner, address indexed receiver, uint256 shares);
    event WithdrawalCancelled(uint256 indexed requestId, address indexed owner, uint256 shares);
    event WithdrawalFulfilled(
        uint256 indexed requestId, address indexed owner, address indexed receiver, uint256 shares, uint256 assets
    );

    error AlreadyInitialized();
    error ZeroAddress();
    error ZeroAmount();
    error ZeroShares();
    error InsufficientLiquidity(uint256 requested, uint256 available);
    error HyperCoreAccountingUnavailable();
    error InvalidWithdrawalRequest();
    error WithdrawalAlreadyFinalized();
    error WithdrawalQueueOutOfOrder(uint256 expectedRequestId, uint256 actualRequestId);
    error NoSettleableWithdrawalRequest();
    error WithdrawalRequestNotEligible(uint256 requestId, uint64 eligibleAt, uint64 currentTime);
    error AccessControlUnauthorizedAccount(address account, bytes32 neededRole);
    error AccessControlBadConfirmation();
    error ValidatorApprovalRejected();
    error FundMovementNonceAlreadyUsed(uint256 nonce);

    constructor() {
        _initialized = true;
    }

    modifier onlyRole(bytes32 role) {
        _checkRole(role, msg.sender);
        _;
    }

    function initialize(
        address assetToken,
        VaultShare _shareToken,
        ITradeValidator _tradeValidator,
        address admin,
        address operator,
        uint256 _leverageCap,
        uint256 _maxTradesPerHour,
        uint256 _maxSlippageBps
    ) external {
        if (_initialized) revert AlreadyInitialized();
        if (
            assetToken == address(0) || address(_shareToken) == address(0) || address(_tradeValidator) == address(0)
                || admin == address(0)
        ) {
            revert ZeroAddress();
        }

        _initialized = true;
        _asset = IERC20(assetToken);
        shareToken = _shareToken;
        tradeValidator = _tradeValidator;
        leverageCap = _leverageCap;
        maxTradesPerHour = _maxTradesPerHour;
        maxSlippageBps = _maxSlippageBps;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        if (operator != address(0)) {
            _grantRole(OPERATOR_ROLE, operator);
        }
    }

    function hasRole(bytes32 role, address account) public view returns (bool) {
        return _roles[role][account];
    }

    function getRoleAdmin(bytes32) external pure returns (bytes32) {
        return DEFAULT_ADMIN_ROLE;
    }

    function grantRole(bytes32 role, address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(role, account);
    }

    function revokeRole(bytes32 role, address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(role, account);
    }

    function renounceRole(bytes32 role, address callerConfirmation) external {
        if (callerConfirmation != msg.sender) revert AccessControlBadConfirmation();
        _revokeRole(role, callerConfirmation);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x7965db0b;
    }

    function _checkRole(bytes32 role, address account) internal view {
        if (!hasRole(role, account)) revert AccessControlUnauthorizedAccount(account, role);
    }

    function _grantRole(bytes32 role, address account) internal {
        if (!_roles[role][account]) {
            _roles[role][account] = true;
            emit RoleGranted(role, account, msg.sender);
        }
    }

    function _revokeRole(bytes32 role, address account) internal {
        if (_roles[role][account]) {
            _roles[role][account] = false;
            emit RoleRevoked(role, account, msg.sender);
        }
    }

    function share() external view override returns (address) {
        return address(shareToken);
    }

    function asset() public view override returns (address) {
        return address(_asset);
    }

    function totalAssets() public view override returns (uint256) {
        return idleAssets() + hyperliquidAccountAssets();
    }

    function pendingRedeemShares() external view returns (uint256) {
        return _pendingRedeemShares;
    }

    function pendingRedeemAssets() external view returns (uint256) {
        return _pendingRedeemAssets;
    }

    function accountingShareSupply() public view returns (uint256) {
        return shareToken.totalSupply();
    }

    function accountingAssets() public view returns (uint256) {
        uint256 assets = totalAssets();
        uint256 pendingAssets = _pendingRedeemAssets;
        return assets > pendingAssets ? assets - pendingAssets : 0;
    }

    function idleAssets() public view returns (uint256) {
        return _asset.balanceOf(address(this));
    }

    function availableIdleAssets() public view returns (uint256) {
        uint256 liquid = idleAssets();
        uint256 pendingAssets = _pendingRedeemAssets;
        return liquid > pendingAssets ? liquid - pendingAssets : 0;
    }

    function hyperliquidAccountAssets() public view returns (uint256 assets) {
        (bool ok, uint256 value) = _tryHyperliquidAccountAssets();
        if (!ok) revert HyperCoreAccountingUnavailable();
        return value;
    }

    function isAccountingFresh() public view returns (bool) {
        (bool ok,) = _tryHyperliquidAccountAssets();
        return ok;
    }

    function _requireFreshAccounting() internal view {
        if (!isAccountingFresh()) revert HyperCoreAccountingUnavailable();
    }

    function _tryHyperliquidAccountAssets() internal view returns (bool ok, uint256 assets) {
        (bool spotOk, uint256 spotUsdc) = _tryCoreSpotUsdcBalance();
        (bool perpOk, uint256 perpEquity) = _tryPerpAccountValue();
        if (!spotOk || !perpOk) return (false, 0);
        return (true, spotUsdc + perpEquity);
    }

    function _tryCoreSpotUsdcBalance() internal view returns (bool ok, uint256 balance) {
        (bool success, bytes memory data) =
            HYPERLIQUID_SPOT_BALANCE_PRECOMPILE.staticcall(abi.encode(address(this), HYPERLIQUID_USDC_SPOT_TOKEN));
        if (!success || data.length < 96) return (false, 0);
        (uint64 total,,) = abi.decode(data, (uint64, uint64, uint64));
        uint256 scale = 10 ** (HYPERLIQUID_CORE_USDC_WEI_DECIMALS - HYPEREVM_USDC_DECIMALS);
        return (true, uint256(total) / scale);
    }

    function _tryPerpAccountValue() internal view returns (bool ok, uint256 accountValue) {
        (bool success, bytes memory data) = HYPERLIQUID_ACCOUNT_MARGIN_SUMMARY_PRECOMPILE.staticcall(
            abi.encode(HYPERLIQUID_DEFAULT_PERP_DEX_INDEX, address(this))
        );
        if (!success || data.length < 128) return (false, 0);
        (int64 value,,,) = abi.decode(data, (int64, uint64, uint64, int64));
        if (value < 0) return (false, 0);
        return (true, uint64(value));
    }

    function convertToShares(uint256 assets) public view override returns (uint256) {
        uint256 supply = accountingShareSupply() + HYPERLIQUID_VIRTUAL_OFFSET;
        uint256 nav = accountingAssets() + HYPERLIQUID_VIRTUAL_OFFSET;
        return assets * supply / nav;
    }

    function convertToAssets(uint256 shares) public view override returns (uint256) {
        uint256 supply = accountingShareSupply() + HYPERLIQUID_VIRTUAL_OFFSET;
        uint256 nav = accountingAssets() + HYPERLIQUID_VIRTUAL_OFFSET;
        return shares * nav / supply;
    }

    function maxDeposit(address) external view override returns (uint256) {
        return paused() || !isAccountingFresh() ? 0 : type(uint256).max;
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
        if (assets == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();
        _requireFreshAccounting();

        shares = convertToShares(assets);
        if (shares == 0) revert ZeroShares();
        _asset.safeTransferFrom(msg.sender, address(this), assets);
        shareToken.mint(receiver, shares);

        emit Deposit(msg.sender, receiver, assets, shares);
    }

    function maxWithdraw(address owner) external view override returns (uint256) {
        if (!isAccountingFresh()) return 0;
        uint256 assets = convertToAssets(shareToken.balanceOf(owner));
        uint256 liquid = availableIdleAssets();
        return assets < liquid ? assets : liquid;
    }

    function previewWithdraw(uint256 assets) public view override returns (uint256 shares) {
        uint256 supply = accountingShareSupply() + HYPERLIQUID_VIRTUAL_OFFSET;
        uint256 nav = accountingAssets() + HYPERLIQUID_VIRTUAL_OFFSET;
        return (assets * supply + nav - 1) / nav;
    }

    function withdraw(uint256 assets, address receiver, address owner)
        external
        override
        nonReentrant
        whenNotPaused
        returns (uint256 shares)
    {
        if (assets == 0) revert ZeroAmount();
        if (receiver == address(0) || owner == address(0)) revert ZeroAddress();
        _requireFreshAccounting();
        uint256 liquid = availableIdleAssets();
        if (assets > liquid) revert InsufficientLiquidity(assets, liquid);

        shares = previewWithdraw(assets);
        if (msg.sender != owner) {
            shareToken.spendAllowance(owner, msg.sender, shares);
        }
        shareToken.burn(owner, shares);
        _asset.safeTransfer(receiver, assets);

        emit Withdraw(msg.sender, receiver, owner, assets, shares);
    }

    function maxRedeem(address owner) external view override returns (uint256) {
        if (!isAccountingFresh()) return 0;
        uint256 ownerShares = shareToken.balanceOf(owner);
        uint256 liquidShares = convertToShares(availableIdleAssets());
        return ownerShares < liquidShares ? ownerShares : liquidShares;
    }

    function previewRedeem(uint256 shares) external view override returns (uint256) {
        return convertToAssets(shares);
    }

    function redeem(uint256 shares, address receiver, address owner)
        external
        override
        nonReentrant
        whenNotPaused
        returns (uint256 assets)
    {
        if (shares == 0) revert ZeroAmount();
        if (receiver == address(0) || owner == address(0)) revert ZeroAddress();
        _requireFreshAccounting();

        assets = convertToAssets(shares);
        uint256 liquid = availableIdleAssets();
        if (assets > liquid) revert InsufficientLiquidity(assets, liquid);
        if (msg.sender != owner) {
            shareToken.spendAllowance(owner, msg.sender, shares);
        }
        shareToken.burn(owner, shares);
        _asset.safeTransfer(receiver, assets);

        emit Withdraw(msg.sender, receiver, owner, assets, shares);
    }

    function requestRedeem(uint256 shares, address receiver, address owner)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 requestId)
    {
        if (shares == 0) revert ZeroAmount();
        if (receiver == address(0) || owner == address(0)) revert ZeroAddress();
        _requireFreshAccounting();
        if (msg.sender != owner) {
            shareToken.spendAllowance(owner, msg.sender, shares);
        }

        uint256 assets = convertToAssets(shares);
        if (assets == 0) revert ZeroAmount();
        shareToken.burn(owner, shares);
        _pendingRedeemShares += shares;
        _pendingRedeemAssets += assets;
        requestId = ++nextWithdrawalRequestId;
        if (nextFulfillableWithdrawalRequestId == 0) {
            nextFulfillableWithdrawalRequestId = requestId;
        }
        uint64 eligibleAt = _withdrawalEligibleAt(uint64(block.timestamp));
        withdrawalRequests[requestId] = WithdrawalRequest({
            owner: owner,
            receiver: receiver,
            shares: shares,
            createdAt: uint64(block.timestamp),
            fulfilledAt: 0,
            cancelledAt: 0
        });
        withdrawalRequestAssets[requestId] = assets;
        withdrawalRequestEligibleAt[requestId] = eligibleAt;

        emit WithdrawalQueued(requestId, owner, receiver, shares);
    }

    function cancelRedeem(uint256 requestId) external nonReentrant returns (uint256 shares) {
        WithdrawalRequest storage request = withdrawalRequests[requestId];
        if (request.owner == address(0)) revert InvalidWithdrawalRequest();
        if (request.fulfilledAt != 0 || request.cancelledAt != 0) revert WithdrawalAlreadyFinalized();
        if (msg.sender != request.owner && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert AccessControlUnauthorizedAccount(msg.sender, DEFAULT_ADMIN_ROLE);
        }

        shares = request.shares;
        uint256 assets = withdrawalRequestAssets[requestId];
        uint256 refundShares = convertToShares(assets);
        if (refundShares == 0) revert ZeroShares();
        request.cancelledAt = uint64(block.timestamp);
        _pendingRedeemShares -= shares;
        _pendingRedeemAssets -= assets;
        shareToken.mint(request.owner, refundShares);
        _advanceNextFulfillableWithdrawalRequestId();

        emit WithdrawalCancelled(requestId, request.owner, shares);
        return refundShares;
    }

    function fulfillNextRedeem() external nonReentrant whenNotPaused returns (uint256 requestId, uint256 assets) {
        _requireFreshAccounting();
        _requireSettlementCaller();
        requestId = _nextSettleableWithdrawalRequestId();
        if (requestId == 0) revert NoSettleableWithdrawalRequest();
        assets = _fulfillRedeem(requestId);
    }

    function fulfillRedeem(uint256 requestId) external nonReentrant whenNotPaused returns (uint256 assets) {
        _requireFreshAccounting();
        WithdrawalRequest storage request = withdrawalRequests[requestId];
        if (request.owner == address(0)) revert InvalidWithdrawalRequest();
        if (request.fulfilledAt != 0 || request.cancelledAt != 0) revert WithdrawalAlreadyFinalized();
        _requireSettlementCaller();
        uint256 expectedRequestId = _nextSettleableWithdrawalRequestId();
        if (requestId != expectedRequestId) {
            revert WithdrawalQueueOutOfOrder(expectedRequestId, requestId);
        }
        assets = _fulfillRedeem(requestId);
    }

    function _fulfillRedeem(uint256 requestId) internal returns (uint256 assets) {
        WithdrawalRequest storage request = withdrawalRequests[requestId];
        if (request.owner == address(0)) revert InvalidWithdrawalRequest();
        if (request.fulfilledAt != 0 || request.cancelledAt != 0) revert WithdrawalAlreadyFinalized();

        uint64 eligibleAt = withdrawalRequestEligibleAt[requestId];
        if (block.timestamp < eligibleAt) {
            revert WithdrawalRequestNotEligible(requestId, eligibleAt, uint64(block.timestamp));
        }

        assets = withdrawalRequestAssets[requestId];
        uint256 liquid = idleAssets();
        if (assets > liquid) revert InsufficientLiquidity(assets, liquid);

        request.fulfilledAt = uint64(block.timestamp);
        _pendingRedeemShares -= request.shares;
        _pendingRedeemAssets -= assets;
        _asset.safeTransfer(request.receiver, assets);
        _advanceNextFulfillableWithdrawalRequestId();

        emit WithdrawalFulfilled(requestId, request.owner, request.receiver, request.shares, assets);
        emit Withdraw(msg.sender, request.receiver, request.owner, assets, request.shares);
    }

    function isWithdrawalRequestEligible(uint256 requestId) public view returns (bool) {
        WithdrawalRequest storage request = withdrawalRequests[requestId];
        return request.owner != address(0) && request.fulfilledAt == 0 && request.cancelledAt == 0
            && block.timestamp >= withdrawalRequestEligibleAt[requestId];
    }

    function _nextSettleableWithdrawalRequestId() internal returns (uint256) {
        _advanceNextFulfillableWithdrawalRequestId();
        uint256 liquid = idleAssets();
        uint256 requestId = nextFulfillableWithdrawalRequestId;
        while (requestId != 0 && requestId <= nextWithdrawalRequestId) {
            WithdrawalRequest storage request = withdrawalRequests[requestId];
            if (request.owner != address(0) && request.fulfilledAt == 0 && request.cancelledAt == 0) {
                uint64 eligibleAt = withdrawalRequestEligibleAt[requestId];
                if (block.timestamp < eligibleAt) return 0;
                if (withdrawalRequestAssets[requestId] <= liquid) return requestId;
            }
            unchecked {
                requestId++;
            }
        }
        return 0;
    }

    function _advanceNextFulfillableWithdrawalRequestId() internal {
        uint256 requestId = nextFulfillableWithdrawalRequestId;
        while (requestId != 0 && requestId <= nextWithdrawalRequestId) {
            WithdrawalRequest storage request = withdrawalRequests[requestId];
            if (request.owner != address(0) && request.fulfilledAt == 0 && request.cancelledAt == 0) {
                break;
            }
            unchecked {
                requestId++;
            }
        }
        nextFulfillableWithdrawalRequestId = requestId;
    }

    function _withdrawalEligibleAt(uint64 createdAt) internal pure returns (uint64) {
        uint256 nextEpoch = ((uint256(createdAt) / WITHDRAWAL_EPOCH_SECONDS) + 1) * WITHDRAWAL_EPOCH_SECONDS;
        uint256 cutoff = nextEpoch - WITHDRAWAL_CUTOFF_SECONDS;
        if (createdAt <= cutoff) return uint64(nextEpoch);
        return uint64(nextEpoch + WITHDRAWAL_EPOCH_SECONDS);
    }

    function _requireSettlementCaller() internal view {
        if (!hasRole(OPERATOR_ROLE, msg.sender) && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert AccessControlUnauthorizedAccount(msg.sender, OPERATOR_ROLE);
        }
    }

    function approveHyperliquidApiWallet(address agentWallet, string calldata agentName)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        nonReentrant
    {
        if (agentWallet == address(0)) revert ZeroAddress();

        bytes memory action = abi.encodePacked(
            HYPERLIQUID_CORE_WRITER_VERSION,
            bytes3(HYPERLIQUID_ACTION_ADD_API_WALLET),
            abi.encode(agentWallet, agentName)
        );
        IHyperliquidCoreWriterMinimal(HYPERLIQUID_CORE_WRITER).sendRawAction(action);
    }

    function returnUsdClassLiquidity(uint64 ntl, bool toPerp, FundMovementAuthorization calldata authorization)
        external
        onlyRole(OPERATOR_ROLE)
        nonReentrant
    {
        if (ntl == 0) revert ZeroAmount();

        bytes memory action = abi.encodePacked(
            HYPERLIQUID_CORE_WRITER_VERSION, bytes3(HYPERLIQUID_ACTION_USD_CLASS_TRANSFER), abi.encode(ntl, toPerp)
        );
        _validateFundMovementAuthorization(
            HYPERLIQUID_ACTION_USD_CLASS_TRANSFER,
            address(0),
            HYPERLIQUID_USDC_SPOT_TOKEN,
            ntl,
            toPerp,
            authorization,
            action
        );
        IHyperliquidCoreWriterMinimal(HYPERLIQUID_CORE_WRITER).sendRawAction(action);
    }

    function returnSpotLiquidity(
        address destination,
        uint64 token,
        uint64 weiAmount,
        FundMovementAuthorization calldata authorization
    ) external nonReentrant {
        if (destination == address(0)) revert ZeroAddress();
        if (weiAmount == 0) revert ZeroAmount();

        if (destination == HYPERLIQUID_USDC_SYSTEM_ADDRESS && token == HYPERLIQUID_USDC_SPOT_TOKEN) {
            _checkRole(OPERATOR_ROLE, msg.sender);
            uint256 liquid = availableIdleAssets();
            if (weiAmount > liquid) revert InsufficientLiquidity(weiAmount, liquid);

            bytes memory evmAction = abi.encodeWithSelector(IERC20.transfer.selector, destination, weiAmount);
            _validateFundMovementAuthorization(
                HYPERLIQUID_ACTION_EVM_USDC_TO_CORE, destination, token, weiAmount, true, authorization, evmAction
            );
            _asset.safeTransfer(destination, weiAmount);
            return;
        }

        _checkRole(DEFAULT_ADMIN_ROLE, msg.sender);

        bytes memory action = abi.encodePacked(
            HYPERLIQUID_CORE_WRITER_VERSION,
            bytes3(HYPERLIQUID_ACTION_SPOT_SEND),
            abi.encode(destination, token, weiAmount)
        );
        _validateFundMovementAuthorization(
            HYPERLIQUID_ACTION_SPOT_SEND, destination, token, weiAmount, false, authorization, action
        );
        IHyperliquidCoreWriterMinimal(HYPERLIQUID_CORE_WRITER).sendRawAction(action);
    }

    function computeFundMovementHashes(
        uint24 actionType,
        address destination,
        uint64 token,
        uint64 amount,
        bool direction,
        uint256 nonce,
        uint256 deadline,
        bytes memory action
    ) public view returns (bytes32 intentHash, bytes32 executionHash) {
        intentHash = keccak256(
            abi.encode(
                HYPERLIQUID_FUND_MOVEMENT_TYPEHASH,
                address(this),
                block.chainid,
                actionType,
                destination,
                token,
                amount,
                direction,
                nonce,
                deadline,
                leverageCap,
                maxTradesPerHour,
                maxSlippageBps
            )
        );
        executionHash = keccak256(
            abi.encode(HYPERLIQUID_FUND_MOVEMENT_EXECUTION_TYPEHASH, address(this), block.chainid, actionType, action)
        );
    }

    function _validateFundMovementAuthorization(
        uint24 actionType,
        address destination,
        uint64 token,
        uint64 amount,
        bool direction,
        FundMovementAuthorization calldata authorization,
        bytes memory action
    ) internal {
        if (fundMovementNonceUsed[authorization.nonce]) {
            revert FundMovementNonceAlreadyUsed(authorization.nonce);
        }
        (bytes32 intentHash, bytes32 executionHash) = computeFundMovementHashes(
            actionType, destination, token, amount, direction, authorization.nonce, authorization.deadline, action
        );
        (bool approved,) = tradeValidator.validateWithSignatures(
            intentHash,
            executionHash,
            address(this),
            authorization.signatures,
            authorization.scores,
            authorization.deadline,
            ACTION_KIND_HYPERLIQUID_FUND_MOVEMENT
        );
        if (!approved) revert ValidatorApprovalRejected();
        fundMovementNonceUsed[authorization.nonce] = true;
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
}
