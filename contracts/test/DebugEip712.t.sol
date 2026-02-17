// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "forge-std/console.sol";
import {Types} from "tnt-core/libraries/Types.sol";
import {SignatureLib} from "tnt-core/libraries/SignatureLib.sol";

contract DebugEip712Test is Test {
    function test_computeDigest() public view {
        // Domain separator — same as Tangle contract at 0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9
        bytes32 domainSep = SignatureLib.computeDomainSeparator(
            "TangleQuote",
            "1",
            0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9
        );
        console.log("Domain separator:");
        console.logBytes32(domainSep);

        // QUOTE_TYPEHASH
        bytes32 quoteTypeHash = keccak256("QuoteDetails(uint64 blueprintId,uint64 ttlBlocks,uint256 totalCost,uint64 timestamp,uint64 expiry,AssetSecurityCommitment[] securityCommitments)AssetSecurityCommitment(Asset asset,uint16 exposureBps)Asset(uint8 kind,address token)");
        console.log("QUOTE_TYPEHASH:");
        console.logBytes32(quoteTypeHash);

        // Test with zero quote + empty commitments
        Types.QuoteDetails memory zeroQuote;
        bytes32 zeroDigest = SignatureLib.computeQuoteDigest(domainSep, zeroQuote);
        console.log("Zero quote digest:");
        console.logBytes32(zeroDigest);

        // Test with specific values
        Types.QuoteDetails memory quote;
        quote.blueprintId = 0;
        quote.ttlBlocks = 216000;
        quote.totalCost = 22874400000;
        quote.timestamp = 1771296651;
        quote.expiry = 1771296951;

        // Add a security commitment
        quote.securityCommitments = new Types.AssetSecurityCommitment[](1);
        quote.securityCommitments[0] = Types.AssetSecurityCommitment({
            asset: Types.Asset({kind: Types.AssetKind.ERC20, token: address(0)}),
            exposureBps: 1000
        });

        bytes32 quoteDigest = SignatureLib.computeQuoteDigest(domainSep, quote);
        console.log("Quote digest (bp=0, ttl=216000, cost=22874400000, ts=1771296651, exp=1771296951, 1 commitment):");
        console.logBytes32(quoteDigest);

        // Also print the hashQuote separately
        bytes32 quoteHash = SignatureLib.hashQuote(quote);
        console.log("hashQuote:");
        console.logBytes32(quoteHash);

        // Print the zero quote hash
        bytes32 zeroQuoteHash = SignatureLib.hashQuote(zeroQuote);
        console.log("Zero hashQuote:");
        console.logBytes32(zeroQuoteHash);
    }
}
