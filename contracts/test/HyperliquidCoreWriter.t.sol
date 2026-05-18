// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./helpers/Setup.sol";
import "../src/libraries/VaultTypes.sol";

contract MockCoreWriter {
    bytes public lastAction;
    address public lastSender;

    event RawAction(address indexed sender, bytes action);

    function sendRawAction(bytes calldata action) external {
        lastSender = msg.sender;
        lastAction = action;
        emit RawAction(msg.sender, action);
    }
}

contract HyperliquidCoreWriterTest is Setup {
    address internal constant CORE_WRITER = 0x3333333333333333333333333333333333333333;

    TradingVault public vault;
    address public agentWallet;

    function setUp() public override {
        super.setUp();

        (address vaultAddr,) = _createTestVault();
        vault = TradingVault(payable(vaultAddr));
        agentWallet = makeAddr("hl-agent-wallet");

        MockCoreWriter mock = new MockCoreWriter();
        vm.etch(CORE_WRITER, address(mock).code);
    }

    function test_adminCanSubmitHyperliquidApiWalletApproval() public {
        string memory agentName = "bot-1";
        bytes memory expectedAction = abi.encodePacked(uint8(1), bytes3(uint24(9)), abi.encode(agentWallet, agentName));

        vm.expectEmit(true, false, false, true, address(vault));
        emit TradingVault.HyperliquidApiWalletApprovalSubmitted(agentWallet, agentName, expectedAction);

        vm.prank(owner);
        vault.approveHyperliquidApiWallet(agentWallet, agentName);

        MockCoreWriter coreWriter = MockCoreWriter(CORE_WRITER);
        assertEq(coreWriter.lastSender(), address(vault), "CoreWriter sender should be vault");
        assertEq(coreWriter.lastAction(), expectedAction, "CoreWriter action should match add API wallet payload");
    }

    function test_operatorCannotApproveHyperliquidApiWallet() public {
        vm.prank(operator);
        vm.expectRevert();
        vault.approveHyperliquidApiWallet(agentWallet, "bot-1");
    }

    function test_revertsOnZeroAgentWallet() public {
        vm.prank(owner);
        vm.expectRevert(VaultTypes.ZeroAddress.selector);
        vault.approveHyperliquidApiWallet(address(0), "bot-1");
    }
}
