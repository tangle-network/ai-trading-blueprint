// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./helpers/Setup.sol";
import "../src/ChainlinkUsdValuator.sol";

contract MockFeed {
    uint8 public immutable decimals;
    int256 public answer;
    uint256 public updatedAt;

    constructor(uint8 decimals_, int256 answer_) {
        decimals = decimals_;
        answer = answer_;
        updatedAt = block.timestamp;
    }

    function setAnswer(int256 answer_) external {
        answer = answer_;
        updatedAt = block.timestamp;
    }

    function setUpdatedAt(uint256 updatedAt_) external {
        updatedAt = updatedAt_;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer_, uint256 startedAt, uint256 updatedAt_, uint80 answeredInRound)
    {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

contract AssetValuationTest is Setup {
    ChainlinkUsdValuator public valuator;
    MockFeed public assetFeed;
    MockFeed public tokenFeed;

    function setUp() public override {
        super.setUp();
        valuator = new ChainlinkUsdValuator(address(this));
        assetFeed = new MockFeed(8, 2000e8);
        tokenFeed = new MockFeed(8, 1e8);
        valuator.setFeed(address(tokenA), address(assetFeed), 1 days);
        valuator.setFeed(address(tokenB), address(tokenFeed), 1 days);
    }

    function test_valueInAsset_usesChainlinkPrices() public view {
        uint256 value = valuator.valueInAsset(address(tokenB), 2000 ether, address(tokenA));
        assertEq(value, 1 ether);
    }

    function test_valueInAsset_revertsOnStalePrice() public {
        vm.warp(3 days);
        tokenFeed.setUpdatedAt(block.timestamp - 2 days);
        vm.expectRevert();
        valuator.valueInAsset(address(tokenB), 2000 ether, address(tokenA));
    }

    function test_valueInAsset_revertsOnInvalidPrice() public {
        tokenFeed.setAnswer(0);
        vm.expectRevert(abi.encodeWithSelector(ChainlinkUsdValuator.InvalidPrice.selector, address(tokenB)));
        valuator.valueInAsset(address(tokenB), 2000 ether, address(tokenA));
    }
}
