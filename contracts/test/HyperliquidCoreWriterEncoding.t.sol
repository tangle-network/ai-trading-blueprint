// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/HyperliquidTradeValidator.sol";
import "../src/HyperliquidVault.sol";
import "../src/HyperliquidVaultDeployer.sol";
import "../src/HyperliquidVaultFactory.sol";
import "../src/VaultShareDeployer.sol";
import "./helpers/Setup.sol";

error CoreWriterBoom(bytes action);

contract GoldenVectorCoreWriter {
    bytes public lastAction;
    address public lastSender;

    function sendRawAction(bytes calldata action) external {
        lastSender = msg.sender;
        lastAction = action;
    }
}

contract RevertingGoldenVectorCoreWriter {
    function sendRawAction(bytes calldata action) external pure {
        revert CoreWriterBoom(action);
    }
}

contract HyperliquidCoreWriterEncodingTest is Test {
    address internal constant CORE_WRITER = 0x3333333333333333333333333333333333333333;

    MockERC20 internal usdc;
    HyperliquidTradeValidator internal tradeValidator;
    HyperliquidVaultFactory internal factory;
    HyperliquidVault internal vault;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal validator1 = makeAddr("validator1");
    address internal validator2 = makeAddr("validator2");
    address internal validator3 = makeAddr("validator3");
    uint256 internal validator1Key;
    uint256 internal validator2Key;
    uint256 internal validator3Key;
    address internal agentWallet = 0x0000000000000000000000000000000000000a91;
    address internal destination = 0x0000000000000000000000000000000000000a91;

    function setUp() public {
        (validator1, validator1Key) = makeAddrAndKey("validator1");
        (validator2, validator2Key) = makeAddrAndKey("validator2");
        (validator3, validator3Key) = makeAddrAndKey("validator3");
        usdc = new MockERC20("USD Coin", "USDC", 6);

        HyperliquidVault implementation = new HyperliquidVault();
        tradeValidator = new HyperliquidTradeValidator();
        factory = new HyperliquidVaultFactory(tradeValidator);
        HyperliquidVaultDeployer vaultDeployer = new HyperliquidVaultDeployer(address(factory), address(implementation));
        VaultShareDeployer shareDeployer = new VaultShareDeployer(address(factory));

        tradeValidator.transferOwnership(address(factory));
        factory.acceptDependencyOwnership();
        factory.setVaultDeployers(vaultDeployer, shareDeployer);

        (address vaultAddr,) = factory.createBotVault(
            1,
            address(usdc),
            admin,
            operator,
            _signers(),
            2,
            "Hyperliquid Bot Shares",
            "hlSHARE",
            bytes32("corewriter-golden"),
            HyperliquidVaultFactory.PolicyConfig({leverageCap: 50_000, maxTradesPerHour: 100, maxSlippageBps: 500}),
            HyperliquidVaultFactory.FeeConfig({
                performanceFeeBps: 2_000, managementFeeBps: 200, validatorFeeShareBps: 3_000
            })
        );
        vault = HyperliquidVault(payable(vaultAddr));
    }

    function test_addApiWalletActionMatchesGoldenVector() public {
        GoldenVectorCoreWriter coreWriter = _installCapturingCoreWriter();

        vm.prank(admin);
        vault.approveHyperliquidApiWallet(agentWallet, "bot-1");

        assertEq(coreWriter.lastSender(), address(vault));
        assertEq(coreWriter.lastAction(), _goldenAddApiWalletAction());
    }

    function test_usdClassTransferActionMatchesGoldenVector() public {
        GoldenVectorCoreWriter coreWriter = _installCapturingCoreWriter();
        HyperliquidVault.FundMovementAuthorization memory authorization = _usdClassAuthorization(1_000_000, false, 1);

        vm.prank(operator);
        vault.returnUsdClassLiquidity(1_000_000, false, authorization);

        assertEq(coreWriter.lastSender(), address(vault));
        assertEq(coreWriter.lastAction(), _goldenUsdClassTransferAction());
    }

    function test_spotSendActionMatchesGoldenVector() public {
        GoldenVectorCoreWriter coreWriter = _installCapturingCoreWriter();
        HyperliquidVault.FundMovementAuthorization memory authorization =
            _spotAuthorization(destination, 1_505, 2_000_000, 2);

        vm.prank(admin);
        vault.returnSpotLiquidity(destination, 1_505, 2_000_000, authorization);

        assertEq(coreWriter.lastSender(), address(vault));
        assertEq(coreWriter.lastAction(), _goldenSpotSendAction());
    }

    function test_rawCalldataRejectsOversizedUsdClassTransferAmount() public {
        GoldenVectorCoreWriter coreWriter = _installCapturingCoreWriter();
        bytes memory data = abi.encodeWithSelector(
            bytes4(keccak256("returnUsdClassLiquidity(uint64,bool)")), uint256(type(uint64).max) + 1, false
        );

        vm.prank(operator);
        (bool ok,) = address(vault).call(data);

        assertFalse(ok, "oversized uint64 ntl should fail ABI decoding");
        assertEq(coreWriter.lastAction().length, 0, "CoreWriter must not be called");
    }

    function test_rawCalldataRejectsOversizedSpotSendToken() public {
        GoldenVectorCoreWriter coreWriter = _installCapturingCoreWriter();
        bytes memory data = abi.encodeWithSelector(
            bytes4(keccak256("returnSpotLiquidity(address,uint64,uint64)")),
            destination,
            uint256(type(uint64).max) + 1,
            uint64(2_000_000)
        );

        vm.prank(admin);
        (bool ok,) = address(vault).call(data);

        assertFalse(ok, "oversized uint64 token should fail ABI decoding");
        assertEq(coreWriter.lastAction().length, 0, "CoreWriter must not be called");
    }

    function test_rawCalldataRejectsOversizedSpotSendWeiAmount() public {
        GoldenVectorCoreWriter coreWriter = _installCapturingCoreWriter();
        bytes memory data = abi.encodeWithSelector(
            bytes4(keccak256("returnSpotLiquidity(address,uint64,uint64)")),
            destination,
            uint64(1_505),
            uint256(type(uint64).max) + 1
        );

        vm.prank(admin);
        (bool ok,) = address(vault).call(data);

        assertFalse(ok, "oversized uint64 wei amount should fail ABI decoding");
        assertEq(coreWriter.lastAction().length, 0, "CoreWriter must not be called");
    }

    function test_addApiWalletPropagatesCoreWriterRevert() public {
        _installRevertingCoreWriter();

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(CoreWriterBoom.selector, _goldenAddApiWalletAction()));
        vault.approveHyperliquidApiWallet(agentWallet, "bot-1");
    }

    function test_usdClassTransferPropagatesCoreWriterRevert() public {
        _installRevertingCoreWriter();
        HyperliquidVault.FundMovementAuthorization memory authorization = _usdClassAuthorization(1_000_000, false, 3);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(CoreWriterBoom.selector, _goldenUsdClassTransferAction()));
        vault.returnUsdClassLiquidity(1_000_000, false, authorization);
    }

    function test_spotSendPropagatesCoreWriterRevert() public {
        _installRevertingCoreWriter();
        HyperliquidVault.FundMovementAuthorization memory authorization =
            _spotAuthorization(destination, 1_505, 2_000_000, 4);

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(CoreWriterBoom.selector, _goldenSpotSendAction()));
        vault.returnSpotLiquidity(destination, 1_505, 2_000_000, authorization);
    }

    function _installCapturingCoreWriter() internal returns (GoldenVectorCoreWriter coreWriter) {
        coreWriter = new GoldenVectorCoreWriter();
        vm.etch(CORE_WRITER, address(coreWriter).code);
        coreWriter = GoldenVectorCoreWriter(CORE_WRITER);
    }

    function _installRevertingCoreWriter() internal {
        RevertingGoldenVectorCoreWriter coreWriter = new RevertingGoldenVectorCoreWriter();
        vm.etch(CORE_WRITER, address(coreWriter).code);
    }

    function _signers() internal view returns (address[] memory signers) {
        signers = new address[](3);
        signers[0] = validator1;
        signers[1] = validator2;
        signers[2] = validator3;
    }

    function _goldenAddApiWalletAction() internal pure returns (bytes memory) {
        return hex"010000090000000000000000000000000000000000000000000000000000000000000a9100000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000005626f742d31000000000000000000000000000000000000000000000000000000";
    }

    function _goldenUsdClassTransferAction() internal pure returns (bytes memory) {
        return hex"0100000700000000000000000000000000000000000000000000000000000000000f42400000000000000000000000000000000000000000000000000000000000000000";
    }

    function _goldenSpotSendAction() internal pure returns (bytes memory) {
        return hex"010000060000000000000000000000000000000000000000000000000000000000000a9100000000000000000000000000000000000000000000000000000000000005e100000000000000000000000000000000000000000000000000000000001e8480";
    }

    function _usdClassAuthorization(uint64 ntl, bool toPerp, uint256 nonce)
        internal
        view
        returns (HyperliquidVault.FundMovementAuthorization memory authorization)
    {
        bytes memory action = _goldenUsdClassTransferAction();
        return _fundMovementAuthorization(uint24(7), address(0), uint64(0), ntl, toPerp, nonce, action);
    }

    function _spotAuthorization(address to, uint64 token, uint64 weiAmount, uint256 nonce)
        internal
        view
        returns (HyperliquidVault.FundMovementAuthorization memory authorization)
    {
        bytes memory action = _goldenSpotSendAction();
        return _fundMovementAuthorization(uint24(6), to, token, weiAmount, false, nonce, action);
    }

    function _fundMovementAuthorization(
        uint24 actionType,
        address to,
        uint64 token,
        uint64 amount,
        bool direction,
        uint256 nonce,
        bytes memory action
    ) internal view returns (HyperliquidVault.FundMovementAuthorization memory authorization) {
        uint256 deadline = block.timestamp + 1 hours;
        authorization.nonce = nonce;
        authorization.deadline = deadline;
        authorization.signatures = new bytes[](2);
        authorization.scores = new uint256[](2);
        authorization.scores[0] = 80;
        authorization.scores[1] = 75;
        (bytes32 intentHash, bytes32 executionHash) =
            vault.computeFundMovementHashes(actionType, to, token, amount, direction, nonce, deadline, action);
        authorization.signatures[0] =
            _signValidation(validator1Key, intentHash, executionHash, authorization.scores[0], deadline);
        authorization.signatures[1] =
            _signValidation(validator2Key, intentHash, executionHash, authorization.scores[1], deadline);
    }

    function _signValidation(
        uint256 privateKey,
        bytes32 intentHash,
        bytes32 executionHash,
        uint256 score,
        uint256 deadline
    ) internal view returns (bytes memory) {
        bytes32 digest = tradeValidator.computeDigest(
            intentHash, executionHash, address(vault), score, deadline, vault.ACTION_KIND_HYPERLIQUID_FUND_MOVEMENT()
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }
}
