// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "../interfaces/IAssetValuator.sol";
import "../PolicyEngine.sol";
import "./VaultStorage.sol";
import "./VaultTypes.sol";

/// @title ValuationLib
/// @notice Per-asset valuation + slippage enforcement, split out of
///         `TradingVault` to drop runtime bytecode below the EIP-170 24,576 B
///         cap. Library functions are `external` so the Solidity compiler
///         emits them at a separate deployed address and routes calls via
///         DELEGATECALL, keeping the bytecode out of the vault itself.
///
///         All state access is via `VaultStorage.load()` — same ERC-7201
///         slot as `TradingVault`. The DELEGATECALL context means writes
///         hit the calling vault's storage.
library ValuationLib {
    /// @dev See `TradingVault._tryValueInDepositAsset` for the soft-priced
    ///      contract. Permanent setup errors revert; transient adapter
    ///      reverts return `(0, false)` so callers can skip enforcement.
    function tryValueInDepositAsset(address token, uint256 amount, address depAsset)
        external
        view
        returns (uint256 value, bool priced)
    {
        return _tryValueInDepositAsset(token, amount, depAsset);
    }

    function _tryValueInDepositAsset(address token, uint256 amount, address depAsset)
        internal
        view
        returns (uint256 value, bool priced)
    {
        if (token == depAsset) return (amount, true);
        VaultStorage.Data storage $ = VaultStorage.load();
        IAssetValuator adapter = $.valuationAdapters[token];
        if (address(adapter) == address(0) || !adapter.isSupported(token, depAsset)) {
            revert VaultTypes.UnsupportedValuationAsset(token, depAsset);
        }
        try adapter.valueInAsset(token, amount, depAsset) returns (uint256 v) {
            return (v, true);
        } catch {
            return (0, false);
        }
    }

    /// @dev Reverts on missing config (permanent setup error). On transient
    ///      adapter failure emits `SlippageCheckSkipped` and returns —
    ///      validator-signed minOutput is the authoritative gate.
    function assertSlippageCap(
        PolicyEngine policyEngine,
        address depositAsset,
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 signedMinOutput
    ) external {
        (,,, uint256 maxSlippageBps,) = policyEngine.policies(address(this));
        if (maxSlippageBps == 0) return;
        if (amountIn == 0 || signedMinOutput == 0) return;

        (uint256 inputValue, bool inPriced) = _tryValueInDepositAsset(tokenIn, amountIn, depositAsset);
        if (!inPriced) {
            emit VaultTypes.SlippageCheckSkipped(tokenIn, "input valuator transient failure");
            return;
        }
        (uint256 outputValue, bool outPriced) = _tryValueInDepositAsset(tokenOut, signedMinOutput, depositAsset);
        if (!outPriced) {
            emit VaultTypes.SlippageCheckSkipped(tokenOut, "output valuator transient failure");
            return;
        }

        if (outputValue * 10000 < inputValue * (10000 - maxSlippageBps)) {
            uint256 actualBps = inputValue > outputValue ? (inputValue - outputValue) * 10000 / inputValue : 0;
            revert VaultTypes.SlippageCapExceeded(actualBps, maxSlippageBps);
        }
    }

    /// @notice Sum of held-token balances priced in `depositAsset` units.
    /// @dev See `TradingVault.positionsValue` — bounded by
    ///      `MAX_HELD_TOKENS`. Transient adapter failures contribute 0,
    ///      producing a conservative (lower-bound) NAV. Missing config
    ///      reverts loudly.
    function positionsValue(address depositAsset) external view returns (uint256 total) {
        VaultStorage.Data storage $ = VaultStorage.load();
        address vault = address(this);
        uint256 len = $.heldTokens.length;
        for (uint256 i = 0; i < len; i++) {
            address token = $.heldTokens[i];
            uint256 bal = IERC20(token).balanceOf(vault);
            if (bal == 0) continue;
            IAssetValuator adapter = $.valuationAdapters[token];
            if (address(adapter) == address(0) || !adapter.isSupported(token, depositAsset)) {
                revert VaultTypes.UnsupportedValuationAsset(token, depositAsset);
            }
            try adapter.valueInAsset(token, bal, depositAsset) returns (uint256 v) {
                total += v;
            } catch {
                // skip — `isNavSafe` returns false for off-chain alerting.
            }
        }
    }

    /// @notice Every nonzero held token can be priced right now.
    function isNavSafe(address depositAsset) external view returns (bool) {
        VaultStorage.Data storage $ = VaultStorage.load();
        address vault = address(this);
        uint256 len = $.heldTokens.length;
        for (uint256 i = 0; i < len; i++) {
            address token = $.heldTokens[i];
            uint256 bal = IERC20(token).balanceOf(vault);
            if (bal == 0) continue;
            IAssetValuator adapter = $.valuationAdapters[token];
            if (address(adapter) == address(0)) return false;
            try adapter.valueInAsset(token, bal, depositAsset) returns (
                uint256
            ) {
            // success — token can be priced.
            }
            catch {
                return false;
            }
        }
        return true;
    }

    /// @notice Held-token bookkeeping helper. Idempotent + bounded.
    function addHeldToken(address token, address depositAsset) external {
        VaultStorage.Data storage $ = VaultStorage.load();
        if (
            token == address(0) || token == depositAsset || $.isHeldToken[token]
                || $.heldTokens.length >= VaultTypes.MAX_HELD_TOKENS
        ) {
            return;
        }
        $.heldTokens.push(token);
        $.isHeldToken[token] = true;

        try IERC20Metadata(token).decimals() returns (uint8 tokenDec) {
            try IERC20Metadata(depositAsset).decimals() returns (uint8 assetDec) {
                if (tokenDec != assetDec) {
                    emit VaultTypes.HeldTokenDecimalMismatch(token, tokenDec, assetDec);
                }
            } catch {}
        } catch {}
    }

    /// @notice Validate that an output token is a deposit asset or has a
    ///         configured, supported valuator. Reverts otherwise.
    function requireValuableOutputToken(address token, address depositAsset) external view {
        if (token == address(0) || token == depositAsset) return;
        VaultStorage.Data storage $ = VaultStorage.load();
        IAssetValuator adapter = $.valuationAdapters[token];
        if (address(adapter) == address(0) || !adapter.isSupported(token, depositAsset)) {
            revert VaultTypes.UnsupportedValuationAsset(token, depositAsset);
        }
    }
}

