// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./RedTeamBase.sol";

/// @notice A11 — Envelope replay across vaults.
///
/// Sign an envelope for vault A. Try to execute it on vault B.
///
/// Two probes:
///   (a) Executor-side: vault B's `_checkEnvelopeBasics` rejects the envelope
///       because `env.vault != address(this)` → `EnvelopeWrongVault`.
///   (b) Validator-side: even if the executor were skipped, the EIP-712 digest
///       depends on `env.vault` so the recovered signer differs and the sig
///       set has zero matches.
contract Attack_A11_VaultReplay is RedTeamBase {
    address internal vaultB;

    function setUp() public override {
        super.setUp();
        // Spin up a second vault under the same factory. Same signer set.
        (vaultB,) = _createTestVaultWithId(2);
    }

    function test_A11_envelopeReplayOnDifferentVault_revertsEnvelopeWrongVault() public {
        MockUniV3Router router = new MockUniV3Router();

        // Whitelist the router on BOTH vaults so policy doesn't preempt the check.
        _whitelistTokensAndTarget(address(router));
        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(tokenB);
        vm.prank(address(vaultFactory));
        policyEngine.setWhitelist(vaultB, tokens, true);
        address[] memory targets = new address[](1);
        targets[0] = address(router);
        vm.prank(address(vaultFactory));
        policyEngine.setTargetWhitelist(vaultB, targets, true);

        TradeValidator.UniswapV3SwapEnforcement memory enf = TradeValidator.UniswapV3SwapEnforcement({
            feeTier: 3000,
            maxSingleAmountIn: 100 ether,
            maxTotalAmountIn: 1000 ether,
            maxValue: 0,
            minOutputPerInput: 1e18,
            router: address(router),
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            sqrtPriceLimitX96: 0
        });
        // Envelope minted FOR vault A.
        TradeValidator.Envelope memory env = _baseEnv(tradeValidator.hashUniswapV3Swap(enf), vault);

        uint256 amountIn = 5 ether;
        uint256 minOut = (amountIn * enf.minOutputPerInput + 1e18 - 1) / 1e18;
        bytes memory data = abi.encodeWithSelector(
            bytes4(0x414bf389),
            address(tokenA),
            address(tokenB),
            uint24(enf.feeTier),
            vaultB,
            uint256(block.timestamp + 600),
            amountIn,
            minOut,
            uint160(0)
        );
        VaultTypes.ExecuteParams memory params = VaultTypes.ExecuteParams({
            target: address(router),
            data: data,
            value: 0,
            minOutput: minOut,
            outputToken: address(tokenB),
            intentHash: keccak256("a11-replay"),
            deadline: block.timestamp + 600
        });

        tokenA.mint(vaultB, amountIn);
        (bytes[] memory sigs, uint256[] memory scores) = _twoEnvSigs(env);

        // Submit to vault B. Executor's `_checkEnvelopeBasics` MUST trip on
        // `env.vault != address(this)`.
        vm.prank(operator);
        vm.expectRevert(VaultTypes.EnvelopeWrongVault.selector);
        TradingVault(payable(vaultB))
            .executeUniswapV3SwapEnvelope(params, env, enf, _sortedThreeValidators(), sigs, scores);
    }
}
