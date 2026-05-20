// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
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
contract HyperliquidVault is IERC7575, AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    uint8 public constant HYPERLIQUID_CORE_WRITER_VERSION = 1;
    uint24 public constant HYPERLIQUID_ACTION_SPOT_SEND = 6;
    uint24 public constant HYPERLIQUID_ACTION_USD_CLASS_TRANSFER = 7;
    uint24 public constant HYPERLIQUID_ACTION_ADD_API_WALLET = 9;
    address public constant HYPERLIQUID_CORE_WRITER = 0x3333333333333333333333333333333333333333;
    address public constant HYPERLIQUID_SPOT_BALANCE_PRECOMPILE = 0x0000000000000000000000000000000000000801;
    address public constant HYPERLIQUID_ACCOUNT_MARGIN_SUMMARY_PRECOMPILE = 0x000000000000000000000000000000000000080F;
    uint32 public constant HYPERLIQUID_DEFAULT_PERP_DEX_INDEX = 0;
    uint64 public constant HYPERLIQUID_USDC_SPOT_TOKEN = 0;
    uint8 public constant HYPERLIQUID_CORE_USDC_WEI_DECIMALS = 8;
    uint8 public constant HYPEREVM_USDC_DECIMALS = 6;

    IERC20 private _asset;
    VaultShare public shareToken;
    ITradeValidator public tradeValidator;
    bool private _initialized;
    uint256 private _pendingRedeemShares;
    uint256 public nextWithdrawalRequestId;
    uint256 public nextFulfillableWithdrawalRequestId;

    struct WithdrawalRequest {
        address owner;
        address receiver;
        uint256 shares;
        uint64 createdAt;
        uint64 fulfilledAt;
        uint64 cancelledAt;
    }

    mapping(uint256 => WithdrawalRequest) public withdrawalRequests;

    event HyperliquidApiWalletApprovalSubmitted(address indexed agentWallet, string agentName, bytes action);
    event HyperliquidUsdClassTransferSubmitted(uint64 ntl, bool toPerp, bytes action);
    event HyperliquidSpotSendSubmitted(address indexed destination, uint64 token, uint64 weiAmount, bytes action);
    event WithdrawalQueued(uint256 indexed requestId, address indexed owner, address indexed receiver, uint256 shares);
    event WithdrawalCancelled(uint256 indexed requestId, address indexed owner, uint256 shares);
    event WithdrawalFulfilled(
        uint256 indexed requestId, address indexed owner, address indexed receiver, uint256 shares, uint256 assets
    );

    error AlreadyInitialized();
    error ZeroAddress();
    error ZeroAmount();
    error InsufficientLiquidity(uint256 requested, uint256 available);
    error HyperCoreAccountingUnavailable();
    error InvalidWithdrawalRequest();
    error WithdrawalAlreadyFinalized();
    error WithdrawalQueueOutOfOrder(uint256 expectedRequestId, uint256 actualRequestId);

    constructor() {
        _initialized = true;
    }

    function initialize(
        address assetToken,
        VaultShare _shareToken,
        ITradeValidator _tradeValidator,
        address admin,
        address operator
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

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        if (operator != address(0)) {
            _grantRole(OPERATOR_ROLE, operator);
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

    function accountingShareSupply() public view returns (uint256) {
        return shareToken.totalSupply() + _pendingRedeemShares;
    }

    function idleAssets() public view returns (uint256) {
        return _asset.balanceOf(address(this));
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
        uint256 supply = accountingShareSupply();
        uint256 nav = totalAssets();
        if (supply == 0 || nav == 0) return assets;
        return assets * supply / nav;
    }

    function convertToAssets(uint256 shares) public view override returns (uint256) {
        uint256 supply = accountingShareSupply();
        if (supply == 0) return shares;
        return shares * totalAssets() / supply;
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
        _asset.safeTransferFrom(msg.sender, address(this), assets);
        shareToken.mint(receiver, shares);

        emit Deposit(msg.sender, receiver, assets, shares);
    }

    function maxWithdraw(address owner) external view override returns (uint256) {
        if (!isAccountingFresh()) return 0;
        uint256 assets = convertToAssets(shareToken.balanceOf(owner));
        uint256 liquid = idleAssets();
        return assets < liquid ? assets : liquid;
    }

    function previewWithdraw(uint256 assets) public view override returns (uint256 shares) {
        uint256 supply = accountingShareSupply();
        uint256 nav = totalAssets();
        if (supply == 0 || nav == 0) return assets;
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
        uint256 liquid = idleAssets();
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
        uint256 liquidShares = previewWithdraw(idleAssets());
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
        uint256 liquid = idleAssets();
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

        shareToken.burn(owner, shares);
        _pendingRedeemShares += shares;
        requestId = ++nextWithdrawalRequestId;
        if (nextFulfillableWithdrawalRequestId == 0) {
            nextFulfillableWithdrawalRequestId = requestId;
        }
        withdrawalRequests[requestId] = WithdrawalRequest({
            owner: owner,
            receiver: receiver,
            shares: shares,
            createdAt: uint64(block.timestamp),
            fulfilledAt: 0,
            cancelledAt: 0
        });

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
        request.cancelledAt = uint64(block.timestamp);
        _pendingRedeemShares -= shares;
        shareToken.mint(request.owner, shares);
        _advanceNextFulfillableWithdrawalRequestId();

        emit WithdrawalCancelled(requestId, request.owner, shares);
    }

    function fulfillNextRedeem() external nonReentrant whenNotPaused returns (uint256 requestId, uint256 assets) {
        _requireFreshAccounting();
        _advanceNextFulfillableWithdrawalRequestId();
        requestId = nextFulfillableWithdrawalRequestId;
        if (requestId == 0 || requestId > nextWithdrawalRequestId) revert InvalidWithdrawalRequest();
        assets = _fulfillRedeem(requestId);
    }

    function fulfillRedeem(uint256 requestId) external nonReentrant whenNotPaused returns (uint256 assets) {
        _requireFreshAccounting();
        WithdrawalRequest storage request = withdrawalRequests[requestId];
        if (request.owner == address(0)) revert InvalidWithdrawalRequest();
        if (request.fulfilledAt != 0 || request.cancelledAt != 0) revert WithdrawalAlreadyFinalized();
        _advanceNextFulfillableWithdrawalRequestId();
        if (requestId != nextFulfillableWithdrawalRequestId) {
            revert WithdrawalQueueOutOfOrder(nextFulfillableWithdrawalRequestId, requestId);
        }
        assets = _fulfillRedeem(requestId);
    }

    function _fulfillRedeem(uint256 requestId) internal returns (uint256 assets) {
        WithdrawalRequest storage request = withdrawalRequests[requestId];
        if (request.owner == address(0)) revert InvalidWithdrawalRequest();
        if (request.fulfilledAt != 0 || request.cancelledAt != 0) revert WithdrawalAlreadyFinalized();

        assets = convertToAssets(request.shares);
        uint256 liquid = idleAssets();
        if (assets > liquid) revert InsufficientLiquidity(assets, liquid);

        request.fulfilledAt = uint64(block.timestamp);
        _pendingRedeemShares -= request.shares;
        _asset.safeTransfer(request.receiver, assets);
        _advanceNextFulfillableWithdrawalRequestId();

        emit WithdrawalFulfilled(requestId, request.owner, request.receiver, request.shares, assets);
        emit Withdraw(msg.sender, request.receiver, request.owner, assets, request.shares);
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

        emit HyperliquidApiWalletApprovalSubmitted(agentWallet, agentName, action);
    }

    function returnUsdClassLiquidity(uint64 ntl, bool toPerp) external onlyRole(OPERATOR_ROLE) nonReentrant {
        if (ntl == 0) revert ZeroAmount();

        bytes memory action = abi.encodePacked(
            HYPERLIQUID_CORE_WRITER_VERSION, bytes3(HYPERLIQUID_ACTION_USD_CLASS_TRANSFER), abi.encode(ntl, toPerp)
        );
        IHyperliquidCoreWriterMinimal(HYPERLIQUID_CORE_WRITER).sendRawAction(action);

        emit HyperliquidUsdClassTransferSubmitted(ntl, toPerp, action);
    }

    function returnSpotLiquidity(address destination, uint64 token, uint64 weiAmount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        nonReentrant
    {
        if (destination == address(0)) revert ZeroAddress();
        if (weiAmount == 0) revert ZeroAmount();

        bytes memory action = abi.encodePacked(
            HYPERLIQUID_CORE_WRITER_VERSION,
            bytes3(HYPERLIQUID_ACTION_SPOT_SEND),
            abi.encode(destination, token, weiAmount)
        );
        IHyperliquidCoreWriterMinimal(HYPERLIQUID_CORE_WRITER).sendRawAction(action);

        emit HyperliquidSpotSendSubmitted(destination, token, weiAmount, action);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
}
