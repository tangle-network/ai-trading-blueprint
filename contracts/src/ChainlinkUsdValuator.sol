// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./interfaces/IAssetValuator.sol";

interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title ChainlinkUsdValuator
/// @notice Values ERC-20 balances through Chainlink USD feeds.
contract ChainlinkUsdValuator is IAssetValuator, Ownable {
    error ZeroAddress();
    error FeedNotSet(address token);
    error InvalidPrice(address token);
    error StalePrice(address token, uint256 updatedAt);

    struct FeedConfig {
        IAggregatorV3 feed;
        uint48 maxStaleness;
        bool exists;
    }

    mapping(address => FeedConfig) public feeds;

    event FeedUpdated(address indexed token, address indexed feed, uint48 maxStaleness);

    constructor(address owner_) Ownable(owner_) {
        if (owner_ == address(0)) revert ZeroAddress();
    }

    function setFeed(address token, address feed, uint48 maxStaleness) external onlyOwner {
        if (token == address(0) || feed == address(0)) revert ZeroAddress();
        feeds[token] = FeedConfig({feed: IAggregatorV3(feed), maxStaleness: maxStaleness, exists: true});
        emit FeedUpdated(token, feed, maxStaleness);
    }

    function isSupported(address token, address asset) external view override returns (bool) {
        if (token == asset) return true;
        return feeds[token].exists && feeds[asset].exists;
    }

    function valueInAsset(address token, uint256 amount, address asset) external view override returns (uint256) {
        if (amount == 0) return 0;
        if (token == asset) return amount;

        (uint256 tokenPrice, uint8 tokenPriceDecimals) = _price(token);
        (uint256 assetPrice, uint8 assetPriceDecimals) = _price(asset);
        uint8 tokenDecimals = _decimals(token);
        uint8 assetDecimals = _decimals(asset);

        uint256 value = Math.mulDiv(amount, tokenPrice, 10 ** tokenDecimals);
        // divide-before-multiply: slither pairs the `value *=` and `value /=`
        // below as a div-then-mul sequence, but they are in DIFFERENT branches
        // (if/else if) — exactly one runs per call, never both. At runtime
        // there is no divide-before-multiply.
        if (assetPriceDecimals > tokenPriceDecimals) {
            // slither-disable-next-line divide-before-multiply
            value *= 10 ** (assetPriceDecimals - tokenPriceDecimals);
        } else if (tokenPriceDecimals > assetPriceDecimals) {
            // slither-disable-next-line divide-before-multiply
            value /= 10 ** (tokenPriceDecimals - assetPriceDecimals);
        }

        return Math.mulDiv(value, 10 ** assetDecimals, assetPrice);
    }

    function _price(address token) internal view returns (uint256 price, uint8 priceDecimals) {
        FeedConfig memory cfg = feeds[token];
        if (!cfg.exists) revert FeedNotSet(token);

        // Chainlink returns (roundId, answer, startedAt, updatedAt, answeredInRound);
        // we use 4 of 5. `startedAt` is intentionally discarded — `updatedAt`
        // is the canonical staleness anchor for AggregatorV3Interface.
        // slither-disable-next-line unused-return
        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) = cfg.feed.latestRoundData();
        if (answer <= 0 || updatedAt == 0 || answeredInRound < roundId) revert InvalidPrice(token);
        if (cfg.maxStaleness > 0 && block.timestamp > updatedAt + cfg.maxStaleness) {
            revert StalePrice(token, updatedAt);
        }

        return (uint256(answer), cfg.feed.decimals());
    }

    function _decimals(address token) internal view returns (uint8) {
        try IERC20Metadata(token).decimals() returns (uint8 dec) {
            return dec;
        } catch {
            return 18;
        }
    }
}
