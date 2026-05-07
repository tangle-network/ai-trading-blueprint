// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../helpers/Setup.sol";

/// @title RedTeamBase
/// @notice Shared scaffolding for red-team attack tests. Each Attack_*.t.sol
///         contract inherits this, gets a fresh vault wired up the standard way,
///         and a small library of helpers for building envelopes / signatures /
///         calldata. Mirrors the in-tree helpers in EnvelopeInvariants.t.sol but
///         lives under contracts/test/red-team/ so the suite is self-contained.
abstract contract RedTeamBase is Setup {
    bytes32 internal constant BOT_ID_HASH = keccak256("red-team-bot");

    address internal vault;
    address internal shareTok;

    function setUp() public virtual override {
        super.setUp();
        vm.warp(1_700_000_000);
        (vault, shareTok) = _createTestVault();
    }

    // ── shared helpers ───────────────────────────────────────────────────────

    function _sortedThreeValidators() internal view returns (address[] memory) {
        address[] memory addrs = new address[](3);
        addrs[0] = validator1;
        addrs[1] = validator2;
        addrs[2] = validator3;
        for (uint256 i = 0; i < addrs.length; ++i) {
            for (uint256 j = i + 1; j < addrs.length; ++j) {
                if (uint160(addrs[j]) < uint160(addrs[i])) {
                    address t = addrs[i];
                    addrs[i] = addrs[j];
                    addrs[j] = t;
                }
            }
        }
        return addrs;
    }

    function _signersHash(address[] memory addrs) internal pure returns (bytes32) {
        bytes memory packed;
        for (uint256 i = 0; i < addrs.length; ++i) {
            packed = bytes.concat(packed, abi.encodePacked(addrs[i]));
        }
        return keccak256(packed);
    }

    function _baseEnv(bytes32 enforcementHash, address vault_)
        internal
        view
        returns (TradeValidator.Envelope memory)
    {
        return TradeValidator.Envelope({
            version: 2,
            botIdHash: BOT_ID_HASH,
            vault: vault_,
            chainId: uint64(block.chainid),
            protocolHash: keccak256("red-team-protocol"),
            policyHash: keccak256("red-team-policy"),
            enforcementHash: enforcementHash,
            issuedAt: uint64(block.timestamp - 100),
            expiresAt: uint64(block.timestamp + 3600),
            nonce: 1,
            signersHash: _signersHash(_sortedThreeValidators()),
            minSignatures: 2
        });
    }

    function _signEnvelope(uint256 pk, TradeValidator.Envelope memory env)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = tradeValidator.envelopeDigest(env);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _twoEnvSigs(TradeValidator.Envelope memory env)
        internal
        view
        returns (bytes[] memory sigs, uint256[] memory scores)
    {
        sigs = new bytes[](2);
        scores = new uint256[](2);
        sigs[0] = _signEnvelope(validator1Key, env);
        sigs[1] = _signEnvelope(validator2Key, env);
        scores[0] = 80;
        scores[1] = 90;
    }

    function _whitelistTokensAndTarget(address target_) internal {
        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(tokenB);
        vm.prank(address(vaultFactory));
        policyEngine.setWhitelist(vault, tokens, true);
        address[] memory targets = new address[](1);
        targets[0] = target_;
        vm.prank(address(vaultFactory));
        policyEngine.setTargetWhitelist(vault, targets, true);
    }
}

/// @dev Mock UniswapV3-style router used by the red-team swap attack tests.
///      Pulls `amountIn` from caller via transferFrom, mints amountOutMinimum
///      to recipient. Used by attacks that don't require reentrancy hooks.
contract MockUniV3Router {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external returns (uint256 amountOut) {
        (bool ok, bytes memory ret) =
            p.tokenIn.call(abi.encodeWithSelector(0x23b872dd, msg.sender, address(this), p.amountIn));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "transferFrom failed");
        amountOut = p.amountOutMinimum;
        MockERC20(p.tokenOut).mint(p.recipient, amountOut);
    }
}
