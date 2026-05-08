// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title Aerodrome Slipstream Fork Tests
/// @notice Verifies real swap execution against Base mainnet state.
/// @dev Requires BASE_RPC_URL env var. Run: forge test --mc AerodromeForkTest --fork-url $BASE_RPC_URL
contract AerodromeForkTest is Test {
    // Real Base addresses
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant SLIPSTREAM_ROUTER = 0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5;

    // Whale address with USDC on Base (Coinbase)
    address constant USDC_WHALE = 0x20FE51A9229EEf2cF8Ad9E89d91CAb9312cF3b7A;

    address vault;

    function setUp() public {
        // Only run on Base fork
        if (block.chainid != 8453) return;

        vault = makeAddr("vault");

        // Fund vault with real USDC from whale
        vm.prank(USDC_WHALE);
        IERC20(USDC).transfer(vault, 10_000 * 1e6); // 10k USDC
    }

    /// @notice Swap USDC → WETH on real Aerodrome Slipstream pool.
    function test_swap_usdc_weth_slipstream() public {
        if (block.chainid != 8453) return;

        uint256 amountIn = 100 * 1e6; // 100 USDC
        uint256 wethBefore = IERC20(WETH).balanceOf(vault);

        vm.startPrank(vault);

        // Approve router
        IERC20(USDC).approve(SLIPSTREAM_ROUTER, amountIn);

        // Build exactInputSingle call with tickSpacing=200 (most common volatile pair)
        bytes memory callData = abi.encodeWithSignature(
            "exactInputSingle((address,address,int24,address,uint256,uint256,uint256,uint160))",
            USDC, // tokenIn
            WETH, // tokenOut
            int24(100), // tickSpacing (100 = ~5bps for USDC/WETH)
            vault, // recipient
            block.timestamp + 1800, // deadline
            amountIn, // amountIn
            0, // amountOutMinimum (0 for test, never in prod)
            uint160(0) // sqrtPriceLimitX96 (0 = no limit)
        );

        (bool success,) = SLIPSTREAM_ROUTER.call(callData);
        vm.stopPrank();

        assertTrue(success, "Swap should succeed");

        uint256 wethAfter = IERC20(WETH).balanceOf(vault);
        assertGt(wethAfter, wethBefore, "Should receive WETH");

        // Sanity: 100 USDC should give us roughly 0.03-0.05 ETH at current prices
        // (very loose bound — this test verifies the call works, not the exact price)
        assertGt(wethAfter - wethBefore, 0.01 ether, "Should receive meaningful WETH amount");
    }

    /// @notice Verify USDC/WETH pool exists and has liquidity.
    function test_pool_has_liquidity() public {
        if (block.chainid != 8453) return;

        // Aerodrome CL Factory
        address factory = 0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A;

        // getPool(tokenA, tokenB, tickSpacing)
        (bool ok, bytes memory data) =
            factory.staticcall(abi.encodeWithSignature("getPool(address,address,int24)", USDC, WETH, int24(100)));
        assertTrue(ok, "Factory call should succeed");

        address pool = abi.decode(data, (address));
        assertTrue(pool != address(0), "USDC/WETH pool should exist");

        // Pool should have non-zero liquidity
        (bool liqOk, bytes memory liqData) = pool.staticcall(abi.encodeWithSignature("liquidity()"));
        assertTrue(liqOk, "Liquidity call should succeed");

        uint128 liquidity = abi.decode(liqData, (uint128));
        assertGt(liquidity, 0, "Pool should have liquidity");
    }
}
