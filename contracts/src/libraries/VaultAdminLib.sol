// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../PolicyEngine.sol";
import "../TradeValidator.sol";
import "../VaultShare.sol";
import "./VaultStorage.sol";
import "./VaultTypes.sol";
import "./ValuationLib.sol";

/// @title VaultAdminLib
/// @notice Vault admin + CLOB-collateral + wind-down primitives. Extracted
///         from `TradingVault` to keep the contract under EIP-170. All
///         caller-permission checks (roles, pause, reentrancy) happen in the
///         vault's entry point — this library is invoked only via
///         DELEGATECALL from those gated entry points.
library VaultAdminLib {
    using SafeERC20 for IERC20;

    // ── errors used by callers via the vault ABI ─────────────────────────────
    error ZeroShares();
    error InsufficientBalance();
    error WindDownNotActive();
    error WindDownAlreadyActive();
    error AssetBalanceDecreased(uint256 before, uint256 after_);
    error ExcessiveDrawdown();
    error InvalidBps();
    error ExceedsCollateralLimit(uint256 requested, uint256 available);
    error CollateralNotEnabled();
    error HeldTokenNotEmpty(address token, uint256 balance);

    event EmergencyWithdraw(address indexed token, address indexed to, uint256 amount);
    event WindDownActivated(uint256 timestamp);
    event WindDownDeactivated(uint256 timestamp);
    event PositionUnwound(address indexed caller, address indexed target, uint256 assetGained);
    event CollateralReleased(
        address indexed operator, uint256 amount, address indexed recipient, bytes32 indexed intentHash
    );
    event CollateralReturned(address indexed operator, uint256 amount, uint256 credited);
    event CollateralWrittenDown(address indexed operator, uint256 amount);
    event MaxCollateralBpsUpdated(uint256 bps);
    event DepositLockupUpdated(uint256 duration);
    event DepositAssetReserveBpsUpdated(uint256 bps);
    event AdminUnwindMaxDrawdownBpsUpdated(uint256 bps);
    event ValuationAdapterUpdated(address indexed token, address indexed adapter);

    // ═══════════════════════════════════════════════════════════════════════════
    // CLOB COLLATERAL
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev Caller must be OPERATOR_ROLE (enforced in vault entry point).
    function releaseCollateral(
        IERC20 asset_,
        TradeValidator tradeValidator,
        uint256 amount,
        address recipient,
        bytes32 intentHash,
        uint256 deadline,
        bytes[] calldata signatures,
        uint256[] calldata scores,
        uint256 totalAssetsCurrent
    ) external {
        VaultStorage.Data storage $ = VaultStorage.load();
        if ($.windDownActive) revert VaultTypes.WindDownBlocksExecute();
        if (amount == 0) revert VaultTypes.ZeroAmount();
        if (recipient == address(0)) revert VaultTypes.ZeroAddress();
        if ($.maxCollateralBps == 0) revert CollateralNotEnabled();
        if ($.executedIntents[intentHash]) revert VaultTypes.IntentAlreadyExecuted(intentHash);

        uint256 maxAllowed = totalAssetsCurrent * $.maxCollateralBps / 10000;
        if ($.totalOutstandingCollateral + amount > maxAllowed) {
            revert ExceedsCollateralLimit(amount, maxAllowed - $.totalOutstandingCollateral);
        }

        bytes32 executionHash = keccak256(
            abi.encode(VaultTypes.COLLATERAL_RELEASE_TYPEHASH, amount, recipient, intentHash, deadline, block.chainid)
        );
        (bool ok,) = tradeValidator.validateWithSignatures(
            intentHash,
            executionHash,
            address(this),
            signatures,
            scores,
            deadline,
            VaultTypes.ACTION_KIND_RELEASE_COLLATERAL
        );
        if (!ok) revert VaultTypes.ValidatorCheckFailed();

        $.totalOutstandingCollateral += amount;
        $.operatorCollateral[msg.sender] += amount;

        asset_.safeTransfer(recipient, amount);

        $.executedIntents[intentHash] = true;
        emit CollateralReleased(msg.sender, amount, recipient, intentHash);
    }

    function returnCollateral(IERC20 asset_, uint256 amount) external {
        if (amount == 0) revert VaultTypes.ZeroAmount();
        VaultStorage.Data storage $ = VaultStorage.load();

        asset_.safeTransferFrom(msg.sender, address(this), amount);

        uint256 outstanding = $.operatorCollateral[msg.sender];
        uint256 credited = amount < outstanding ? amount : outstanding;

        if (credited > 0) {
            $.operatorCollateral[msg.sender] -= credited;
            $.totalOutstandingCollateral -= credited;
        }

        emit CollateralReturned(msg.sender, amount, credited);
    }

    function writeDownCollateral(address operator_, uint256 amount) external {
        VaultStorage.Data storage $ = VaultStorage.load();
        uint256 outstanding = $.operatorCollateral[operator_];
        uint256 actual = amount < outstanding ? amount : outstanding;
        if (actual == 0) return;

        $.operatorCollateral[operator_] -= actual;
        $.totalOutstandingCollateral -= actual;

        emit CollateralWrittenDown(operator_, actual);
    }

    function setMaxCollateralBps(uint256 bps) external {
        if (bps > 10000) revert InvalidBps();
        VaultStorage.load().maxCollateralBps = bps;
        emit MaxCollateralBpsUpdated(bps);
    }

    function availableCollateral(IERC20 asset_, uint256 totalAssetsCurrent) external view returns (uint256) {
        VaultStorage.Data storage $ = VaultStorage.load();
        if ($.maxCollateralBps == 0) return 0;
        uint256 maxAllowed = totalAssetsCurrent * $.maxCollateralBps / 10000;
        uint256 headroom = maxAllowed > $.totalOutstandingCollateral ? maxAllowed - $.totalOutstandingCollateral : 0;
        uint256 liquid = asset_.balanceOf(address(this));
        return headroom < liquid ? headroom : liquid;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // WIND-DOWN
    // ═══════════════════════════════════════════════════════════════════════════

    function activateWindDown() external {
        VaultStorage.Data storage $ = VaultStorage.load();
        if ($.windDownActive) revert WindDownAlreadyActive();
        $.windDownActive = true;
        $.windDownStartedAt = block.timestamp;
        emit WindDownActivated(block.timestamp);
    }

    function deactivateWindDown() external {
        VaultStorage.Data storage $ = VaultStorage.load();
        if (!$.windDownActive) revert WindDownNotActive();
        $.windDownActive = false;
        $.windDownStartedAt = 0;
        emit WindDownDeactivated(block.timestamp);
    }

    function unwind(IERC20 asset_, PolicyEngine policyEngine, address target, bytes calldata data, uint256 value)
        external
    {
        VaultStorage.Data storage $ = VaultStorage.load();
        if (!$.windDownActive) revert WindDownNotActive();
        if (target == address(0)) revert VaultTypes.ZeroAddress();

        if (!policyEngine.targetWhitelisted(address(this), target)) {
            revert VaultTypes.TargetNotWhitelisted(target);
        }

        uint256 assetBefore = asset_.balanceOf(address(this));

        (bool success,) = target.call{value: value}(data);
        if (!success) revert VaultTypes.ExecutionFailed();

        uint256 assetAfter = asset_.balanceOf(address(this));
        if (assetAfter < assetBefore) revert AssetBalanceDecreased(assetBefore, assetAfter);

        uint256 gained = assetAfter - assetBefore;
        emit PositionUnwound(msg.sender, target, gained);
    }

    /// @dev Drawdown enforcement happens in the vault wrapper which can read
    ///      `totalAssets()` natively before + after this call.
    function adminUnwind(IERC20 asset_, PolicyEngine policyEngine, address target, bytes calldata data, uint256 value)
        external
        returns (uint256 gained)
    {
        VaultStorage.Data storage $ = VaultStorage.load();
        if (!$.windDownActive) revert WindDownNotActive();
        if (target == address(0)) revert VaultTypes.ZeroAddress();

        if (!policyEngine.targetWhitelisted(address(this), target)) {
            revert VaultTypes.TargetNotWhitelisted(target);
        }

        uint256 assetBefore = asset_.balanceOf(address(this));

        (bool success,) = target.call{value: value}(data);
        if (!success) revert VaultTypes.ExecutionFailed();

        uint256 assetAfter = asset_.balanceOf(address(this));
        gained = assetAfter > assetBefore ? assetAfter - assetBefore : 0;
        emit PositionUnwound(msg.sender, target, gained);
    }

    function adminUnwindDrawdownCap(uint256 defaultDrawdownBps) external view returns (uint256) {
        uint256 set = VaultStorage.load().adminUnwindMaxDrawdownBps;
        return set == 0 ? defaultDrawdownBps : set;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EMERGENCY / EMERGENCY WITHDRAW
    // ═══════════════════════════════════════════════════════════════════════════

    function emergencyWithdraw(address token, address to) external {
        if (to == address(0)) revert VaultTypes.ZeroAddress();

        uint256 amount;
        if (token == address(0)) {
            amount = address(this).balance;
            (bool success,) = to.call{value: amount}("");
            if (!success) revert VaultTypes.ExecutionFailed();
        } else {
            amount = IERC20(token).balanceOf(address(this));
            if (amount > 0) {
                IERC20(token).safeTransfer(to, amount);
            }
        }

        emit EmergencyWithdraw(token, to, amount);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // HELD-TOKEN ADMIN
    // ═══════════════════════════════════════════════════════════════════════════

    function updateHeldTokens(address[] calldata tokens, address depositAsset) external {
        VaultStorage.Data storage $ = VaultStorage.load();
        uint256 heldLen = $.heldTokens.length;
        for (uint256 i = 0; i < heldLen; i++) {
            address held = $.heldTokens[i];
            uint256 bal = IERC20(held).balanceOf(address(this));
            if (bal > 0) revert HeldTokenNotEmpty(held, bal);
            $.isHeldToken[held] = false;
        }
        delete $.heldTokens;
        uint256 newLen = tokens.length;
        uint256 cap = newLen < VaultTypes.MAX_HELD_TOKENS ? newLen : VaultTypes.MAX_HELD_TOKENS;
        for (uint256 i = 0; i < cap; i++) {
            if (tokens[i] != depositAsset && !$.isHeldToken[tokens[i]]) {
                $.heldTokens.push(tokens[i]);
                $.isHeldToken[tokens[i]] = true;
            }
        }
    }

    function removeHeldToken(address token) external {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) revert HeldTokenNotEmpty(token, bal);
        VaultStorage.Data storage $ = VaultStorage.load();
        if (!$.isHeldToken[token]) return;
        $.isHeldToken[token] = false;
        uint256 len = $.heldTokens.length;
        for (uint256 i = 0; i < len; i++) {
            if ($.heldTokens[i] == token) {
                $.heldTokens[i] = $.heldTokens[len - 1];
                $.heldTokens.pop();
                break;
            }
        }
    }

    function setValuationAdapter(address token, address adapter) external {
        if (token == address(0)) revert VaultTypes.ZeroAddress();
        VaultStorage.load().valuationAdapters[token] = IAssetValuator(adapter);
        emit ValuationAdapterUpdated(token, adapter);
    }

    function setDepositLockup(uint256 duration) external {
        VaultStorage.load().depositLockupDuration = duration;
        emit DepositLockupUpdated(duration);
    }

    function setDepositAssetReserveBps(uint256 bps) external {
        if (bps > 10000) revert InvalidBps();
        VaultStorage.load().depositAssetReserveBps = bps;
        emit DepositAssetReserveBpsUpdated(bps);
    }

    function setAdminUnwindMaxDrawdownBps(uint256 bps) external {
        if (bps > 10000) revert InvalidBps();
        VaultStorage.load().adminUnwindMaxDrawdownBps = bps;
        emit AdminUnwindMaxDrawdownBpsUpdated(bps);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // IN-KIND REDEMPTION
    // ═══════════════════════════════════════════════════════════════════════════

    function previewRedeemInKind(uint256 shares, VaultShare shareToken, address depositAsset)
        external
        view
        returns (address[] memory tokens, uint256[] memory amounts)
    {
        if (shares == 0) revert ZeroShares();
        uint256 supply = shareToken.totalSupply();
        if (supply == 0 || shares > supply) revert InsufficientBalance();

        VaultStorage.Data storage $ = VaultStorage.load();
        uint256 len = $.heldTokens.length;
        tokens = new address[](len + 1);
        amounts = new uint256[](len + 1);
        tokens[0] = depositAsset;
        amounts[0] = IERC20(depositAsset).balanceOf(address(this)) * shares / supply;

        for (uint256 i = 0; i < len; i++) {
            tokens[i + 1] = $.heldTokens[i];
            amounts[i + 1] = IERC20($.heldTokens[i]).balanceOf(address(this)) * shares / supply;
        }
    }
}
