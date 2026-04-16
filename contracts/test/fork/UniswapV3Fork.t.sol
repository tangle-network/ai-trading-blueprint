// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title Uniswap V3 Fork Tests
/// @notice Verifies real swap execution against Arbitrum mainnet state.
/// @dev Requires ARBITRUM_RPC_URL env var. Run: forge test --mc UniswapV3ForkTest --fork-url $ARBITRUM_RPC_URL
contract UniswapV3ForkTest is Test {
    // Real Arbitrum addresses
    address constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831; // native USDC on Arb
    address constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
    address constant SWAP_ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564;

    // Whale with USDC on Arbitrum
    address constant USDC_WHALE = 0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7;

    address vault;

    function setUp() public {
        if (block.chainid != 42161) return;

        vault = makeAddr("vault");

        vm.prank(USDC_WHALE);
        IERC20(USDC).transfer(vault, 10_000 * 1e6);
    }

    /// @notice Swap USDC → WETH on real Uniswap V3 pool (Arbitrum).
    function test_swap_usdc_weth() public {
        if (block.chainid != 42161) return;

        uint256 amountIn = 100 * 1e6;
        uint256 wethBefore = IERC20(WETH).balanceOf(vault);

        vm.startPrank(vault);
        IERC20(USDC).approve(SWAP_ROUTER, amountIn);

        // ExactInputSingleParams: tokenIn, tokenOut, fee, recipient, deadline, amountIn, amountOutMinimum, sqrtPriceLimitX96
        bytes memory callData = abi.encodeWithSignature(
            "exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))",
            USDC,
            WETH,
            uint24(500), // 5bps fee tier
            vault,
            block.timestamp + 1800,
            amountIn,
            0,
            uint160(0)
        );

        (bool success,) = SWAP_ROUTER.call(callData);
        vm.stopPrank();

        assertTrue(success, "Swap should succeed");
        uint256 wethAfter = IERC20(WETH).balanceOf(vault);
        assertGt(wethAfter, wethBefore, "Should receive WETH");
    }
}
