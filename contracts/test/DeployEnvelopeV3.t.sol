// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../script/DeployEnvelopeV3.s.sol";
import "../script/VerifyEnvelopeV3.s.sol";
import "../src/TradeValidator.sol";
import "../src/TradingVault.sol";
import "../src/VaultFactory.sol";
import "../test/helpers/Setup.sol"; // MockERC20

/// @title DeployEnvelopeV3Test
/// @notice Verifies that DeployEnvelopeV3 runs cleanly end-to-end against an
///         in-memory chain (no fork required — the v3 envelope additions are
///         pure intra-contract changes that don't depend on any specific chain
///         state). Also exercises the post-deploy VerifyEnvelopeV3 sanity
///         checks against the script's output.
///
///         Forking against Base Sepolia / mainnet is gated behind a `--fork-url`
///         + RPC env var; in-memory runs are deterministic and CI-friendly.
contract DeployEnvelopeV3Test is Test {
    DeployEnvelopeV3 internal deployScript;
    VerifyEnvelopeV3 internal verifyScript;

    address internal constant TEST_DEPLOYER_ADDRESS = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    uint256 internal constant TEST_DEPLOYER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    address internal constant TEST_SIGNER_ONE = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address internal constant TEST_SIGNER_TWO = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;
    address internal constant TEST_SIGNER_THREE = 0x90F79bf6EB2c4f870365E785982E1f101E93b906;

    function setUp() public {
        deployScript = new DeployEnvelopeV3();
        verifyScript = new VerifyEnvelopeV3();
        vm.deal(TEST_DEPLOYER_ADDRESS, 1000 ether);
    }

    /// @dev Build a baseline DeployConfig. Tests then mutate fields they care
    ///      about and pass the struct directly to `runWithConfig`, which is
    ///      env-free and therefore safe under parallel test execution.
    function _baseConfig() internal pure returns (DeployEnvelopeV3.DeployConfig memory cfg) {
        cfg.deployerKey = TEST_DEPLOYER_KEY;
        cfg.admin = TEST_DEPLOYER_ADDRESS;
        address[] memory signers = new address[](3);
        signers[0] = TEST_SIGNER_ONE;
        signers[1] = TEST_SIGNER_TWO;
        signers[2] = TEST_SIGNER_THREE;
        cfg.signers = signers;
        cfg.serviceId = 0;
        cfg.requiredSigs = 2; // 2-of-3 satisfies VaultFactory's 2/3 supermajority floor
        cfg.minScoreThreshold = 50;
        cfg.assetTokenOverride = address(0); // -> mock USDC
        cfg.vaultName = "Envelope V3 Vault Shares";
        cfg.vaultSymbol = "ev3SHARE";
        cfg.writeJson = false;
        // TWAP valuator: skipped by default (no factory). Tests that need it
        // override `uniswapV3Factory` on a per-case basis.
        cfg.uniswapV3Factory = address(0);
        cfg.twapWindowSecs = 1800;
        cfg.twapMinHarmonicLiquidity = 1_000_000;
        cfg.twapMaxSpotDeviationBps = 200;
    }

    /// @notice Happy path: script emits the full v3 envelope stack with
    ///         non-zero addresses, sample vault is reachable and properly
    ///         configured in TradeValidator.
    function test_deploy_envelope_v3_produces_full_stack() public {
        DeployEnvelopeV3.DeploymentResult memory result = deployScript.runWithConfig(_baseConfig());

        assertEq(result.chainId, block.chainid, "chainId mismatch");
        assertEq(result.deployer, TEST_DEPLOYER_ADDRESS, "deployer mismatch");

        assertTrue(result.policyEngine != address(0), "policyEngine missing");
        assertTrue(result.tradeValidator != address(0), "tradeValidator missing");
        assertTrue(result.feeDistributor != address(0), "feeDistributor missing");
        assertTrue(result.vaultFactory != address(0), "vaultFactory missing");
        assertTrue(result.vaultDeployer != address(0), "vaultDeployer missing");
        assertTrue(result.vaultShareDeployer != address(0), "vaultShareDeployer missing");
        assertTrue(result.strategyRegistry != address(0), "strategyRegistry missing");
        assertTrue(result.assetToken != address(0), "assetToken missing");
        assertTrue(result.sampleVault != address(0), "sampleVault missing");
        assertTrue(result.sampleShare != address(0), "sampleShare missing");

        // Distinct addresses for the new components.
        assertTrue(result.tradeValidator != result.policyEngine);
        assertTrue(result.tradeValidator != result.vaultFactory);
        assertTrue(result.sampleVault != result.sampleShare);

        // VaultFactory took ownership of the dependency contracts.
        TradeValidator tv = TradeValidator(result.tradeValidator);
        assertEq(tv.owner(), result.vaultFactory, "factory should own TradeValidator");

        // Sample vault is wired with the configured 2-of-3 signer set.
        assertEq(tv.getRequiredSignatures(result.sampleVault), 2, "sample vault required sigs != 2");
        assertTrue(tv.isVaultSigner(result.sampleVault, TEST_SIGNER_ONE));
        assertTrue(tv.isVaultSigner(result.sampleVault, TEST_SIGNER_TWO));
        assertTrue(tv.isVaultSigner(result.sampleVault, TEST_SIGNER_THREE));

        // sampleSigners array is mirrored in the result.
        assertEq(result.sampleSigners.length, 3, "sampleSigners length");
        assertEq(result.sampleSigners[0], TEST_SIGNER_ONE);
        assertEq(result.sampleSigners[1], TEST_SIGNER_TWO);
        assertEq(result.sampleSigners[2], TEST_SIGNER_THREE);
        assertEq(result.sampleRequiredSignatures, 2);
    }

    /// @notice TradeValidator on the deployed vault exposes the full set of v3
    ///         envelope typehashes with the canonical EIP-712 strings.
    function test_deploy_envelope_v3_typehashes_are_canonical() public {
        DeployEnvelopeV3.DeploymentResult memory result = deployScript.runWithConfig(_baseConfig());
        TradeValidator tv = TradeValidator(result.tradeValidator);

        assertEq(
            tv.UNISWAP_V3_SWAP_TYPEHASH(),
            keccak256(
                "UniswapV3SwapEnforcement(uint256 feeTier,uint256 maxSingleAmountIn,uint256 maxTotalAmountIn,uint256 maxValue,uint256 minOutputPerInput,address router,address tokenIn,address tokenOut,uint160 sqrtPriceLimitX96)"
            ),
            "UNISWAP_V3_SWAP_TYPEHASH"
        );
        assertEq(
            tv.UNISWAP_V4_SWAP_TYPEHASH(),
            keccak256(
                "UniswapV4SwapEnforcement(address currency0,address currency1,uint256 fee,int256 tickSpacing,address hooks,bool zeroForOne,uint256 maxSingleAmountIn,uint256 maxTotalAmountIn,uint256 maxValue,uint256 minOutputPerInput,address universalRouter,bytes32 hookDataHash)"
            ),
            "UNISWAP_V4_SWAP_TYPEHASH"
        );
        assertEq(
            tv.AERODROME_SWAP_TYPEHASH(),
            keccak256(
                "AerodromeSwapEnforcement(uint256 maxSingleAmountIn,uint256 maxTotalAmountIn,uint256 maxValue,uint256 minOutputPerInput,address router,int256 tickSpacing,address tokenIn,address tokenOut,uint160 sqrtPriceLimitX96)"
            ),
            "AERODROME_SWAP_TYPEHASH"
        );
        assertEq(
            tv.AAVE_SUPPLY_TYPEHASH(),
            keccak256(
                "AaveSupplyEnforcement(address asset,uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,address pool)"
            ),
            "AAVE_SUPPLY_TYPEHASH"
        );
        assertEq(
            tv.AAVE_WITHDRAW_TYPEHASH(),
            keccak256(
                "AaveWithdrawEnforcement(address asset,uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,uint256 minHealthFactor,address pool)"
            ),
            "AAVE_WITHDRAW_TYPEHASH"
        );
        assertEq(
            tv.AAVE_BORROW_TYPEHASH(),
            keccak256(
                "AaveBorrowEnforcement(address asset,uint256 interestRateMode,uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,uint256 minHealthFactor,address pool)"
            ),
            "AAVE_BORROW_TYPEHASH"
        );
        assertEq(
            tv.AAVE_REPAY_TYPEHASH(),
            keccak256(
                "AaveRepayEnforcement(address asset,address debtToken,uint256 interestRateMode,uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,address pool)"
            ),
            "AAVE_REPAY_TYPEHASH"
        );
        assertEq(
            tv.MORPHO_SUPPLY_TYPEHASH(),
            keccak256(
                "MorphoSupplyEnforcement(uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,bytes32 marketId,address morpho)"
            ),
            "MORPHO_SUPPLY_TYPEHASH"
        );
        assertEq(
            tv.MORPHO_WITHDRAW_TYPEHASH(),
            keccak256(
                "MorphoWithdrawEnforcement(uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,bytes32 marketId,uint256 minCollateralRatio,address morpho)"
            ),
            "MORPHO_WITHDRAW_TYPEHASH"
        );
        assertEq(
            tv.MORPHO_BORROW_TYPEHASH(),
            keccak256(
                "MorphoBorrowEnforcement(uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,bytes32 marketId,uint256 minCollateralRatio,address morpho)"
            ),
            "MORPHO_BORROW_TYPEHASH"
        );
        assertEq(
            tv.MORPHO_REPAY_TYPEHASH(),
            keccak256(
                "MorphoRepayEnforcement(uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,bytes32 marketId,address morpho)"
            ),
            "MORPHO_REPAY_TYPEHASH"
        );
    }

    /// @notice The sample vault has the universal envelope-consumption mapping
    ///         and reports zero on a fresh deployment for any envelope hash.
    function test_deploy_envelope_v3_sample_vault_envelope_state_clean() public {
        DeployEnvelopeV3.DeploymentResult memory result = deployScript.runWithConfig(_baseConfig());
        TradingVault vault = TradingVault(payable(result.sampleVault));

        assertEq(vault.envelopeConsumedAmount(bytes32(0)), 0, "zero hash should be unconsumed");
        assertEq(vault.envelopeConsumedAmount(keccak256("any-other-envelope")), 0, "no envelope consumed yet");
    }

    /// @notice The script's envelope domain separator is wired correctly:
    ///         envelopeDigest(sample_envelope) is non-zero (depends on chainId
    ///         + verifyingContract being the deployed TradeValidator).
    function test_deploy_envelope_v3_envelope_digest_non_zero() public {
        DeployEnvelopeV3.DeploymentResult memory result = deployScript.runWithConfig(_baseConfig());
        TradeValidator tv = TradeValidator(result.tradeValidator);

        TradeValidator.Envelope memory env = TradeValidator.Envelope({
            version: 2,
            botIdHash: keccak256("test-bot"),
            vault: result.sampleVault,
            chainId: uint64(block.chainid),
            protocolHash: keccak256("uniswap_v3"),
            policyHash: keccak256("policy"),
            enforcementHash: keccak256("enforcement"),
            issuedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp + 3600),
            nonce: 1,
            signersHash: keccak256("signers"),
            minSignatures: 2
        });

        bytes32 digest = tv.envelopeDigest(env);
        assertTrue(digest != bytes32(0), "envelopeDigest must be non-zero");

        // Determinism: same input -> same digest.
        assertEq(digest, tv.envelopeDigest(env), "envelopeDigest must be deterministic");
    }

    /// @notice Drive the full VerifyEnvelopeV3 script against the freshly
    ///         deployed contracts and assert it doesn't revert.
    function test_verify_envelope_v3_succeeds_against_fresh_deploy() public {
        DeployEnvelopeV3.DeploymentResult memory result = deployScript.runWithConfig(_baseConfig());
        verifyScript.runChecks(result.tradeValidator, result.sampleVault);
        assertEq(verifyScript.failed(), 0, "VerifyEnvelopeV3 must report zero failures");
    }

    /// @notice Reverts when REQUIRED_SIGS falls below the 2/3 supermajority floor
    ///         that VaultFactory enforces (H-2/H-4). Locks in the safety floor at
    ///         the deploy boundary.
    function test_deploy_envelope_v3_rejects_sub_supermajority_required_sigs() public {
        DeployEnvelopeV3.DeployConfig memory cfg = _baseConfig();
        cfg.requiredSigs = 1; // 1-of-3 < ceil(2*3/3)=2
        vm.expectRevert(bytes("DeployEnvelopeV3: REQUIRED_SIGS must satisfy 2/3 supermajority"));
        deployScript.runWithConfig(cfg);
    }

    /// @notice Reverts when fewer than 3 signers are supplied — VaultFactory's
    ///         signer floor (H-2/H-4) requires at least 3 distinct signers.
    function test_deploy_envelope_v3_rejects_below_signer_floor() public {
        DeployEnvelopeV3.DeployConfig memory cfg = _baseConfig();
        address[] memory twoSigners = new address[](2);
        twoSigners[0] = TEST_SIGNER_ONE;
        twoSigners[1] = TEST_SIGNER_TWO;
        cfg.signers = twoSigners;
        vm.expectRevert(bytes("DeployEnvelopeV3: SIGNERS must have at least 3 distinct addresses"));
        deployScript.runWithConfig(cfg);
    }

    /// @notice Reverts when any signer slot duplicates another — duplicate signers
    ///         are rejected by TradeValidator anyway, but failing fast in the script
    ///         gives a clearer error.
    function test_deploy_envelope_v3_rejects_duplicate_signers() public {
        DeployEnvelopeV3.DeployConfig memory cfg = _baseConfig();
        cfg.signers[1] = cfg.signers[0]; // collide signer[1] with signer[0]
        vm.expectRevert(bytes("DeployEnvelopeV3: duplicate signer"));
        deployScript.runWithConfig(cfg);
    }

    /// @notice Reverts when MIN_SCORE_THRESHOLD > 100 — TradeValidator enforces
    ///         this same bound, but failing fast gives a deploy-time signal.
    function test_deploy_envelope_v3_rejects_invalid_score_threshold() public {
        DeployEnvelopeV3.DeployConfig memory cfg = _baseConfig();
        cfg.minScoreThreshold = 150;
        vm.expectRevert(bytes("DeployEnvelopeV3: MIN_SCORE_THRESHOLD must be 0..100"));
        deployScript.runWithConfig(cfg);
    }

    /// @notice Honoring a real ASSET_TOKEN override skips MockERC20 deploy and
    ///         wires the supplied address into the sample vault.
    function test_deploy_envelope_v3_honors_asset_token_override() public {
        // Drop a real-looking ERC20 (use a MockERC20) into a known address.
        MockERC20 customAsset = new MockERC20("Custom Asset", "CST", 6);
        DeployEnvelopeV3.DeployConfig memory cfg = _baseConfig();
        cfg.assetTokenOverride = address(customAsset);

        DeployEnvelopeV3.DeploymentResult memory result = deployScript.runWithConfig(cfg);
        assertEq(result.assetToken, address(customAsset), "override should be honored");
    }
}
