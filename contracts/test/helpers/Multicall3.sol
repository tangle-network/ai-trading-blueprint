// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

/// @title Multicall3 — minimal subset used by viem's multicall
contract Multicall3 {
    struct Call3 {
        address target;
        bool allowFailure;
        bytes callData;
    }

    struct Result {
        bool success;
        bytes returnData;
    }

    function aggregate3(Call3[] calldata calls) public payable returns (Result[] memory returnData) {
        uint256 length = calls.length;
        returnData = new Result[](length);
        for (uint256 i = 0; i < length; i++) {
            Call3 calldata calli = calls[i];
            Result memory result = returnData[i];
            (result.success, result.returnData) = calli.target.call(calli.callData);
            require(calli.allowFailure || result.success, "Multicall3: call failed");
        }
    }
}
