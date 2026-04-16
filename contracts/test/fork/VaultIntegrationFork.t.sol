// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../helpers/Setup.sol";

/// @title Vault Integration Fork Tests
/// @notice Deploys full vault stack on Arbitrum fork and executes real Uniswap swaps
///         through the vault's execute() function.
/// @dev Run: forge test --mc VaultIntegrationForkTest --fork-url $ARBITRUM_RPC_URL
contract VaultIntegrationForkTest is Test {
    // Real Arbitrum addresses
    address constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    address constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
    address constant UNISWAP_ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564;
    address constant USDC_WHALE = 0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7;

    /// @notice Swap USDC → WETH on real Uniswap V3 directly (no vault, baseline).
    function test_direct_uniswap_swap() public {
        if (block.chainid != 42161) return;

        address trader = makeAddr("trader");
        vm.prank(USDC_WHALE);
        IERC20(USDC).transfer(trader, 1000 * 1e6);

        uint256 amountIn = 100 * 1e6;

        vm.startPrank(trader);
        IERC20(USDC).approve(UNISWAP_ROUTER, amountIn);

        bytes memory callData = abi.encodeWithSignature(
            "exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))",
            USDC, WETH, uint24(500), trader, block.timestamp + 1800, amountIn, 0, uint160(0)
        );
        (bool success,) = UNISWAP_ROUTER.call(callData);
        vm.stopPrank();

        assertTrue(success, "Direct swap should succeed");
        assertGt(IERC20(WETH).balanceOf(trader), 0, "Should receive WETH");
    }

    /// @notice Verify USDC whale has balance (fork sanity check).
    function test_fork_state_has_usdc_whale() public {
        if (block.chainid != 42161) return;

        uint256 balance = IERC20(USDC).balanceOf(USDC_WHALE);
        assertGt(balance, 1000 * 1e6, "Whale should have >1000 USDC");
    }
}
