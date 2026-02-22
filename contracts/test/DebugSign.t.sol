// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "forge-std/console.sol";
import {Types} from "tnt-core/libraries/Types.sol";
import {SignatureLib} from "tnt-core/libraries/SignatureLib.sol";

contract DebugSignTest is Test {
    // Operator1 private key
    uint256 constant OP1_KEY = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;

    function test_signAndRecover() public {
        address op1 = vm.addr(OP1_KEY);
        console.log("Operator1 address:", op1);

        // Build domain separator matching local Anvil deployment
        bytes32 domainSep =
            SignatureLib.computeDomainSeparator("TangleQuote", "1", 0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9);
        console.log("Domain separator:");
        console.logBytes32(domainSep);

        // Build a test quote
        Types.QuoteDetails memory quote;
        quote.blueprintId = 0;
        quote.ttlBlocks = 216000;
        quote.totalCost = 22874400000;
        quote.timestamp = 1771296651;
        quote.expiry = 1771296951;
        quote.securityCommitments = new Types.AssetSecurityCommitment[](1);
        quote.securityCommitments[0] = Types.AssetSecurityCommitment({
            asset: Types.Asset({kind: Types.AssetKind.ERC20, token: address(0)}), exposureBps: 1000
        });

        // Compute digest
        bytes32 digest = SignatureLib.computeQuoteDigest(domainSep, quote);
        console.log("Digest:");
        console.logBytes32(digest);

        // Sign with operator key
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OP1_KEY, digest);
        console.log("v:", v);
        console.log("r:");
        console.logBytes32(r);
        console.log("s:");
        console.logBytes32(s);

        // Full 65-byte signature as hex
        bytes memory sig = abi.encodePacked(r, s, v);
        console.log("Full signature (65 bytes):");
        console.logBytes(sig);

        // Verify recovery
        address recovered = ecrecover(digest, v, r, s);
        console.log("Recovered:", recovered);
        assertEq(recovered, op1, "Recovery mismatch");

        // Also show 64-byte sig (r || s) for comparison
        bytes memory sig64 = abi.encodePacked(r, s);
        console.log("64-byte sig (r || s):");
        console.logBytes(sig64);
    }
}
