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
    address internal agentWallet = 0x0000000000000000000000000000000000000a91;
    address internal destination = 0x0000000000000000000000000000000000000a91;

    function setUp() public {
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

        vm.prank(operator);
        vault.returnUsdClassLiquidity(1_000_000, false);

        assertEq(coreWriter.lastSender(), address(vault));
        assertEq(coreWriter.lastAction(), _goldenUsdClassTransferAction());
    }

    function test_spotSendActionMatchesGoldenVector() public {
        GoldenVectorCoreWriter coreWriter = _installCapturingCoreWriter();

        vm.prank(admin);
        vault.returnSpotLiquidity(destination, 1_505, 2_000_000);

        assertEq(coreWriter.lastSender(), address(vault));
        assertEq(coreWriter.lastAction(), _goldenSpotSendAction());
    }

    function test_rawCalldataRejectsOversizedUsdClassTransferAmount() public {
        GoldenVectorCoreWriter coreWriter = _installCapturingCoreWriter();
        bytes memory data =
            abi.encodeWithSelector(vault.returnUsdClassLiquidity.selector, uint256(type(uint64).max) + 1, false);

        vm.prank(operator);
        (bool ok,) = address(vault).call(data);

        assertFalse(ok, "oversized uint64 ntl should fail ABI decoding");
        assertEq(coreWriter.lastAction().length, 0, "CoreWriter must not be called");
    }

    function test_rawCalldataRejectsOversizedSpotSendToken() public {
        GoldenVectorCoreWriter coreWriter = _installCapturingCoreWriter();
        bytes memory data = abi.encodeWithSelector(
            vault.returnSpotLiquidity.selector, destination, uint256(type(uint64).max) + 1, uint64(2_000_000)
        );

        vm.prank(admin);
        (bool ok,) = address(vault).call(data);

        assertFalse(ok, "oversized uint64 token should fail ABI decoding");
        assertEq(coreWriter.lastAction().length, 0, "CoreWriter must not be called");
    }

    function test_rawCalldataRejectsOversizedSpotSendWeiAmount() public {
        GoldenVectorCoreWriter coreWriter = _installCapturingCoreWriter();
        bytes memory data = abi.encodeWithSelector(
            vault.returnSpotLiquidity.selector, destination, uint64(1_505), uint256(type(uint64).max) + 1
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

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(CoreWriterBoom.selector, _goldenUsdClassTransferAction()));
        vault.returnUsdClassLiquidity(1_000_000, false);
    }

    function test_spotSendPropagatesCoreWriterRevert() public {
        _installRevertingCoreWriter();

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(CoreWriterBoom.selector, _goldenSpotSendAction()));
        vault.returnSpotLiquidity(destination, 1_505, 2_000_000);
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
}
